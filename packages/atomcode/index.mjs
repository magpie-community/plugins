/**
 * AtomCode (AtomGit CodingPlan) provider plugin for Magpie.
 *
 * Direct-to-upstream, no Atom2Api instance in between:
 *
 *   - **Sign-in** is browser OAuth via the AtomGit broker (`acs.atomgit.com`);
 *     tokens live in Magpie's `plugin-auth.json` and are renewed either by
 *     `auth.refresh` (Magpie ≥ 0.1.684) or, on OpenCode and older Magpie hosts,
 *     by the fallback refresh inside `fetch`.
 *   - **Requests** reach `https://llm-api.atomgit.com/v1` as plain Chat
 *     Completions (`@ai-sdk/openai-compatible`); this plugin's `fetch` adds the
 *     `atomcode-signing-v1` headers plus the required `atomcode/<version>`
 *     User-Agent, then forwards untouched — body, streams and everything.
 *   - **Model & quota** come from CodingPlan REST (`api.gitcode.com`), mapped so
 *     the account row and `magpie quota` show the plan and its 5-hour window.
 *
 * This file exports **exactly one function, and nothing else** — the module
 * must also load under OpenCode, which calls every exported function. Helpers
 * live in `internal.mjs`, `sign.mjs`, `oauth.mjs`, `codingplan.mjs`, `quota.mjs`
 * and `models.mjs`.
 *
 * @module magpie-atomcode
 */

import {
  DEFAULT_CLIENT_VERSION,
  DEFAULT_CODING_PLAN_API_URL,
  DEFAULT_PLATFORM_BASE_URL,
  DEFAULT_GATEWAY_BASE_URL,
  ICON,
  PROVIDER,
  credentialsOf,
  fellBack,
  originOf,
  readAuth,
  readCappedResponseText,
  redactText,
  trustedServiceURL,
  upstreamMessage,
} from "./internal.mjs";
import { MASTER_KEY_HEX, signAtomGitRequest } from "./sign.mjs";
import {
  checkLogin,
  refreshTokens,
  startLogin,
  tokenFor,
  userAgentOf,
} from "./oauth.mjs";
import { claimCodingPlan, fetchStatus, planNeedsClaim } from "./codingplan.mjs";
import { createVersionSource } from "./version.mjs";
import { quotaFromStatus } from "./quota.mjs";
import {
  FALLBACK_MODELS,
  NPM,
  createCatalog,
  normalizeCodingPlanModel,
  toConfigModel,
  toProviderModel,
} from "./models.mjs";
import { fill, resolveLocale, strings as tableFor } from "./i18n.mjs";
import {
  readAuthFile,
  resolveAuthFilePath,
  writeAuthFile,
} from "./auth-file.mjs";
import { includeStreamUsage, normalizeRequestBody } from "./request-body.mjs";
import {
  FAILURE,
  annotateError,
  classifyError,
  isCredentialFailure,
  keptResponseHeaders,
} from "./errors.mjs";
import { createStateStore } from "./state.mjs";
import {
  DEFAULT_DIAGNOSTICS_PORT,
  diagnosticsPort,
  startDiagnosticsService,
} from "./diagnostics.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const AUTH_REFRESH_SKEW_MS = 30_000;
const USAGE_BUDGET_MS = 18_000;

/**
 * Build the plugin.
 *
 * @param {{client?: object, directory?: string, magpie?: object}} input -
 *   the plugin input the Magpie or OpenCode host passes.
 * @param {object} [options] - the `options` field from `plugins.json`:
 *   `locale`, `clientVersion`, `masterKeyHex`, `platformBaseURL`,
 *   `codingPlanAPIURL`, `quotaTtlMs`, `maxOutputTokens`, `diagnosticsPort`.
 * @returns {Promise<object>} the hooks the host calls.
 */
export async function AtomCodePlugin(input = {}, options = {}) {
  input = input && typeof input === "object" ? input : {};
  const { client, magpie } = input;
  const directory = typeof input.directory === "string" ? input.directory : undefined;
  options = options && typeof options === "object" ? options : {};
  const t = tableFor(resolveLocale(options.locale));

  /** Options that were rejected while reading; reported once `log` exists. */
  const optionWarnings = [];
  const warnInvalid = (name) => optionWarnings.push({ key: "optionInvalid", name });
  const positiveInteger = (name, value, fallback, max = Number.MAX_SAFE_INTEGER) => {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= max) return parsed;
    if (value !== undefined) warnInvalid(name, value);
    return fallback;
  };

  const configuredVersion = options.clientVersion;
  const clientVersion =
    typeof configuredVersion === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(configuredVersion.trim())
      ? configuredVersion.trim()
      : DEFAULT_CLIENT_VERSION;
  if (configuredVersion !== undefined && clientVersion === DEFAULT_CLIENT_VERSION) {
    const accepted =
      typeof configuredVersion === "string" &&
      configuredVersion.trim() === DEFAULT_CLIENT_VERSION;
    if (!accepted) warnInvalid("clientVersion", configuredVersion);
  }

  const configuredMasterKey = String(options.masterKeyHex ?? "");
  const masterKeyHex = /^[0-9a-fA-F]{64}$/.test(configuredMasterKey)
    ? configuredMasterKey
    : MASTER_KEY_HEX;
  if (options.masterKeyHex !== undefined && masterKeyHex === MASTER_KEY_HEX && configuredMasterKey !== MASTER_KEY_HEX) {
    warnInvalid("masterKeyHex", configuredMasterKey);
  }

  if (options.autoVersion !== undefined && typeof options.autoVersion !== "boolean") {
    warnInvalid("autoVersion", options.autoVersion);
  }
  if (options.autoClaim !== undefined && typeof options.autoClaim !== "boolean") {
    warnInvalid("autoClaim", options.autoClaim);
  }

  const nativeBoolean = (key) => {
    try {
      const value = magpie?.option?.(PROVIDER, key);
      return typeof value === "boolean" ? value : undefined;
    } catch {
      return undefined;
    }
  };
  const automationValue = (explicit, nativeKey) =>
    typeof explicit === "boolean" ? explicit : nativeBoolean(nativeKey) ?? true;
  const autoClaimEnabled = () => automationValue(options.autoClaim, "auto_claim");
  const autoVersionEnabled = () => automationValue(options.autoVersion, "auto_version");

  const configuredDiagnosticsPort = options.diagnosticsPort;
  const selectedDiagnosticsPort = diagnosticsPort(
    configuredDiagnosticsPort,
    DEFAULT_DIAGNOSTICS_PORT,
  );
  if (
    configuredDiagnosticsPort !== undefined &&
    selectedDiagnosticsPort === DEFAULT_DIAGNOSTICS_PORT &&
    Number(configuredDiagnosticsPort) !== DEFAULT_DIAGNOSTICS_PORT
  ) {
    warnInvalid("diagnosticsPort", configuredDiagnosticsPort);
  }

  const opts = {
    clientVersion,
    // 逃生口：上游换 master key 时不发版热修（对齐 Atom2Api 的 signer_url 思路）。
    masterKeyHex,
    // 端点选项可覆盖，但必须是 https 且落在上游自家域名族：token 会发往这里，
    // 一份被塞改的 plugins.json 不该能把它引到别处。
    platformBaseURL: trustedServiceURL(options.platformBaseURL, {
      fallback: DEFAULT_PLATFORM_BASE_URL,
      domains: ["acs.atomgit.com"],
      exact: true,
      onReject: () =>
        optionWarnings.push({ key: "endpointDenied", name: "platformBaseURL" }),
    }),
    codingPlanAPIURL: trustedServiceURL(options.codingPlanAPIURL, {
      fallback: DEFAULT_CODING_PLAN_API_URL,
      domains: ["api.gitcode.com"],
      exact: true,
      onReject: () =>
        optionWarnings.push({ key: "endpointDenied", name: "codingPlanAPIURL" }),
    }),
    gatewayURL: DEFAULT_GATEWAY_BASE_URL,
    quotaTtlMs: positiveInteger("quotaTtlMs", options.quotaTtlMs, 60_000, 24 * 3600_000),
    maxOutputTokens: positiveInteger(
      "maxOutputTokens",
      options.maxOutputTokens,
      32_768,
      1_000_000,
    ),
    diagnosticsPort: selectedDiagnosticsPort,
  };

  /**
   * The only origin requests may leave for.
   *
   * `origin` covers scheme + host + port, so an `http://` downgrade of the same
   * host cannot pass this comparison either.
   */
  const gatewayOrigin = originOf(opts.gatewayURL);

  const log = (level, message) => {
    try {
      client?.app?.log?.({ body: { service: PROVIDER, level, message } });
    } catch {
      /* the host's logger is best-effort */
    }
  };

  for (const warning of optionWarnings) {
    log(
      "warn",
      `${PROVIDER}: ${fill(t[warning.key], { name: warning.name })}`,
    );
  }

  const stateStore = createStateStore({
    directory,
    onError: (error) =>
      log(
        "warn",
        `${PROVIDER}: ${fill(t.stateWriteFailed, {
          detail: redactText(error.message),
        })}`,
      ),
  });

  const rememberFailure = (uid, error, context = {}) => {
    const failure = classifyError(error, context);
    void stateStore.recordError(uid, {
      category: failure.category,
      message: failure.message,
      status: failure.status,
      at: Date.now(),
    });
    return failure;
  };

  const catalog = createCatalog({
    apiBase: opts.codingPlanAPIURL,
    clientVersion: opts.clientVersion,
    output: opts.maxOutputTokens,
    onReject: () => log("warn", `${PROVIDER}: ${t.modelBaseUrlDenied}`),
  });

  const versionSource = createVersionSource({
    fallback: opts.clientVersion,
    onError: (error) => log("warn", `${PROVIDER}: version check: ${error.message}`),
    onChange: (status) =>
      void stateStore.recordVersion({
        ...status,
        checkedAt: status.checkedAt,
      }),
  });
  // 宿主一启动就后台探一次；首个真实请求到达前多半已就位。
  if (autoVersionEnabled()) versionSource.poke();
  void stateStore.recordVersion(versionSource.status());

  /** 本次请求用的版本号：UA、X-AtomCode-Ver、签名盐取同一值（绝不抛错）。 */
  const clientVersionNow = () =>
    autoVersionEnabled()
      ? versionSource.ensure()
      : Promise.resolve(opts.clientVersion);

  const seedModels = () =>
    Object.fromEntries(
      FALLBACK_MODELS.map((raw) => {
        const m = normalizeCodingPlanModel(raw, { output: opts.maxOutputTokens });
        return [m.key, toConfigModel(m)];
      }),
    );

  const providerModels = (list) => {
    const result = Object.create(null);
    for (const model of list) {
      let key = model.key;
      let suffix = 2;
      while (Object.hasOwn(result, key)) {
        key = `${model.key}_${suffix++}`;
      }
      if (key !== model.key) {
        log(
          "warn",
          `${PROVIDER}: ${fill(t.modelKeyCollision, { detail: model.key, key })}`,
        );
      }
      result[key] = toProviderModel({ ...model, key }, PROVIDER, {
        baseURL: opts.gatewayURL,
        npm: NPM,
      });
    }
    return result;
  };

  /** How the provider row names this account. */
  const userLabel = (auth) => {
    if (!auth || typeof auth !== "object") return undefined;
    return auth.name ?? auth.email ?? auth.accountId;
  };

  const markExpired = (message = t.reloginRequired) =>
    Object.assign(new Error(message), { signIn: "expired" });

  const remainingMs = (deadline) =>
    deadline === undefined ? undefined : Math.max(0, deadline - Date.now());

  const timed = (promise, deadline) => {
    const remaining = remainingMs(deadline);
    if (remaining === undefined) return promise;
    if (remaining <= 0) return Promise.resolve(undefined);
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(undefined), remaining);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  };

  async function classifyGatewayResponse(response) {
    const base = { status: response?.status, message: "" };
    if (response?.status !== 403) return classifyError(base);
    try {
      const text = await readCappedResponseText(response.clone(), {
        maxBytes: 16 << 10,
        label: "gateway error",
      });
      base.message = upstreamMessage(text);
    } catch {
      /* A non-JSON or oversized error body stays a plain 403. */
    }
    return classifyError(base);
  }

  /**
   * Renew one account's token.
   *
   * Keyed singleflight on the refresh token, plus a short-lived result cache.
   * The cache matters after the singleflight settles: persistence and the next
   * request are not atomic, and a rotate-once upstream would reject a second
   * refresh with the old token. Results are addressable by both the old and the
   * new refresh token.
   */
  const refreshInflight = new Map();
  const refreshResults = new Map();
  const REFRESH_CACHE_TTL_MS = 24 * 3600_000;

  function rememberRefresh(oldToken, next) {
    const at = Date.now();
    refreshResults.set(oldToken, { at, next });
    if (next.refresh && next.refresh !== oldToken) {
      refreshResults.set(next.refresh, { at, next });
    }
    for (const [token, entry] of refreshResults) {
      if (at - entry.at > REFRESH_CACHE_TTL_MS) refreshResults.delete(token);
    }
  }

  async function refreshAccount(credentials, { deadline } = {}) {
    if (!credentials?.refresh) {
      throw markExpired();
    }
    const cached = refreshResults.get(credentials.refresh);
    if (cached && Date.now() - cached.at < REFRESH_CACHE_TTL_MS) return cached.next;
    const pending = refreshInflight.get(credentials.refresh);
    if (pending) return pending;
    const p = (async () => {
      // expires 已过时兜底值取旧剩余；上游不给 expires_in 时沿用旧宽度
      // （Atom2Api 同款：缺省找回旧值）。
      const oldSpanSec =
        credentials.expires && credentials.expires > Date.now()
          ? Math.max(1, Math.round((credentials.expires - Date.now()) / 1000))
          : 0;
      const next = await refreshTokens(
        opts.platformBaseURL,
        credentials.refresh,
        {
          clientVersion: opts.clientVersion,
          fallbackExpiresIn: oldSpanSec > 0 ? oldSpanSec : undefined,
          timeoutMs: Math.max(250, Math.min(15_000, remainingMs(deadline) ?? 15_000)),
        },
      );
      const expiresInSec =
        next.expiresIn > 0 ? next.expiresIn : oldSpanSec > 0 ? oldSpanSec : 7 * 24 * 3600;
      const renewed = {
        access: next.accessToken,
        refresh: next.refreshToken ?? credentials.refresh,
        expires: Date.now() + expiresInSec * 1000,
      };
      rememberRefresh(credentials.refresh, renewed);
      return renewed;
    })().finally(() => refreshInflight.delete(credentials.refresh));
    refreshInflight.set(credentials.refresh, p);
    return p;
  }

  function credentialsWith(raw, credentials, next) {
    return {
      ...(raw ?? {}),
      type: "oauth",
      access: next.access,
      refresh: next.refresh,
      expires: next.expires,
      uid: credentials.uid,
      ...(credentials.accountId ? { accountId: credentials.accountId } : {}),
      ...(credentials.email ? { email: credentials.email } : {}),
      ...(credentials.name ? { name: credentials.name } : {}),
    };
  }

  async function persistRenewed(raw, credentials, next) {
    const updated = credentialsWith(raw, credentials, next);
    let saved = false;
    if (raw?.source === "atomcode-cli") {
      try {
        const path = resolveAuthFilePath(raw.authFile);
        const latest = await readAuthFile(path);
        if (latest.uid !== credentials.uid) {
          throw markExpired(t.cliAccountChanged);
        }
        await writeAuthFile(path, {
          access: next.access,
          refresh: next.refresh,
          createdAt: Math.floor(Date.now() / 1000),
          expiresIn: Math.max(1, Math.floor((next.expires - Date.now()) / 1000)),
          user: {
            id: credentials.uid,
            ...(credentials.name ? { name: credentials.name } : {}),
            ...(credentials.email ? { email: credentials.email } : {}),
          },
        });
        saved = true;
      } catch (error) {
        if (error.signIn === "expired") throw error;
        log(
          "warn",
          `${PROVIDER}: ${fill(t.authFileWriteFailed, { detail: redactText(error.message) })}`,
        );
      }
    }
    if (typeof client?.auth?.set === "function") {
      try {
        await client.auth.set({ path: { id: PROVIDER }, body: updated });
        saved = true;
      } catch (error) {
        log(
          "warn",
          `${PROVIDER}: ${fill(t.authPersistFailed, { detail: redactText(error.message) })}`,
        );
      }
    }
    return { updated, saved };
  }

  async function rereadCliAuth(raw, credentials) {
    if (raw?.source !== "atomcode-cli") return { raw, credentials, changed: false };
    try {
      const latest = await readAuthFile(resolveAuthFilePath(raw.authFile));
      if (credentials?.uid && latest.uid !== credentials.uid) {
        throw markExpired(t.cliAccountChanged);
      }
      return {
        raw: { ...raw, ...latest, source: "atomcode-cli", authFile: latest.path },
        credentials: credentialsOf(latest),
        changed:
          latest.access !== credentials?.access ||
          latest.refresh !== credentials?.refresh ||
          latest.expires !== credentials?.expires,
      };
    } catch (error) {
      if (error.signIn === "expired") throw error;
      log(
        "warn",
        `${PROVIDER}: ${fill(t.authFileReadFailed, { detail: redactText(error.message) })}`,
      );
      return { raw, credentials, changed: false };
    }
  }

  /**
   * Resolve the freshest stored credentials and renew once when needed.
   *
   * `input` may be an auth record or `getAuth`. CLI-backed accounts re-read
   * auth.toml every time, so the official client remains the source of truth.
   */
  async function currentCredentials(input, { forceRefresh = false, deadline } = {}) {
    let raw = typeof input === "function" ? await readAuth(input) : input;
    let credentials = credentialsOf(raw);
    if (!credentials) return { raw, credentials: undefined, renewed: false };

    const latest = await rereadCliAuth(raw, credentials);
    raw = latest.raw;
    credentials = latest.credentials;
    let renewed = latest.changed;
    if (!credentials) return { raw, credentials: undefined, renewed };

    const expiring =
      credentials.expires !== undefined &&
      credentials.expires <= Date.now() + AUTH_REFRESH_SKEW_MS;
    if (!forceRefresh && !expiring) return { raw, credentials, renewed };
    if (latest.changed && credentials.expires && credentials.expires > Date.now()) {
      return { raw, credentials, renewed: true };
    }
    if (!credentials.refresh) throw markExpired();

    let next;
    try {
      next = await refreshAccount(credentials, { deadline });
    } catch (error) {
      if (error.signIn === "expired") throw markExpired();
      log(
        "warn",
        `${PROVIDER}: ${fill(t.refreshFailed, { detail: redactText(error.message) })}`,
      );
      return { raw, credentials, renewed, refreshFailed: true };
    }
    const persisted = await persistRenewed(raw, credentials, next);
    raw = persisted.updated;
    credentials = credentialsOf(raw);
    return { raw, credentials, renewed: true };
  }

  /** Cache quota per account so a polled hook costs one request a minute. */
  const quotaCache = new Map();

  /**
   * 签到（重领）：套餐缺失或到期时按档位级联补领一次。
   *
   * 只在 status 判定确实需要时才动手（planNeedsClaim，保守判定），30 分钟
   * 冷却防止在"日限额已满"的放量节奏上空转；结果只进日志，绝不影响
   * usage / models 的正常返回。
   */
  const RECLAIM_COOLDOWN_MS = 30 * 60_000;
  const claimCooldown = new Map();
  const claimInflight = new Map();
  const claimResults = new Map();
  const CLAIM_RESULT_TTL_MS = 5_000;

  async function claimOnce(credentials, { deadline } = {}) {
    const key = credentials.uid ?? credentials.access;
    const pending = claimInflight.get(key);
    if (pending) return (await timed(pending, deadline)) ?? null;
    const cached = claimResults.get(key);
    if (cached && Date.now() - cached.at < CLAIM_RESULT_TTL_MS) return cached.result;
    if (Date.now() < (claimCooldown.get(key) ?? 0)) return null;
    const remaining = remainingMs(deadline);
    if (remaining !== undefined && remaining <= 0) return null;
    claimCooldown.set(key, Date.now() + RECLAIM_COOLDOWN_MS);
    const p = clientVersionNow()
      .then((clientVersion) =>
        claimCodingPlan(opts.codingPlanAPIURL, credentials.access, {
          clientVersion,
          timeoutMs: Math.max(250, Math.min(8_000, remaining ?? 8_000)),
          totalTimeoutMs: Math.max(250, Math.min(12_000, remaining ?? 12_000)),
        }),
      )
      .then((result) => {
        claimResults.set(key, { at: Date.now(), result });
        return result;
      })
      .finally(() => claimInflight.delete(key));
    claimInflight.set(key, p);
    return (await timed(p, deadline)) ?? null;
  }

  async function ensurePlan(credentials, { status, deadline } = {}) {
    if (!autoClaimEnabled()) return false;
    try {
      if (!status) {
        const remaining = remainingMs(deadline);
        if (remaining !== undefined && remaining <= 0) return false;
        status = await fetchStatus(opts.codingPlanAPIURL, credentials.access, {
          clientVersion: await clientVersionNow(),
          timeoutMs: Math.max(250, Math.min(7_000, remaining ?? 7_000)),
        });
      }
      if (!planNeedsClaim(status)) return false;
    } catch (error) {
      log(
        "warn",
        `${PROVIDER}: ${fill(t.readFailed, { detail: redactText(error.message) })}`,
      );
      return false;
    }
    try {
      const claim = await claimOnce(credentials, { deadline });
      if (!claim) return false;
      if (claim.claimed) log("info", `${PROVIDER}: ${fill(t.reclaimed, { plan: claim.planName || claim.tier })}`);
      else {
        log(
          "warn",
          `${PROVIDER}: ${fill(t.reclaimFailed, { detail: redactText(claim.message) })}`,
        );
      }
      return claim.claimed;
    } catch (error) {
      log(
        "warn",
        `${PROVIDER}: ${fill(t.reclaimFailed, { detail: redactText(error.message) })}`,
      );
      return false;
    }
  }

  const hooks = {
    /** Declare the provider and its snapshot models. */
    config: async (cfg) => {
      cfg.provider ??= {};
      const was = cfg.provider[PROVIDER] ?? {};
      cfg.provider[PROVIDER] = {
        // 显示名固定全大写（设置页卡片/标签用）；provider id 仍是小写 atomcode
        name: "ATOMCODE",
        npm: NPM,
        api: opts.gatewayURL,
        ...was,
        models: { ...seedModels(), ...(was.models ?? {}) },
      };
    },

    provider: {
      id: PROVIDER,
      /**
       * The models this account can actually use.
       *
       * Failing (or an empty catalog) falls back to the declared list marked
       * `fellBack`, so the provider never vanishes; an expired sign-in throws,
       * which marks the account for re-login.
       */
      async models(provider, { auth } = {}) {
        const declared = provider?.models ?? seedModels();
        let raw;
        let credentials;
        try {
          ({ raw, credentials } = await currentCredentials(auth));
        } catch (error) {
          if (error.signIn === "expired") throw error;
          log(
            "warn",
            `${PROVIDER}: ${fill(t.refreshFailed, { detail: redactText(error.message) })}`,
          );
          return fellBack(declared);
        }
        if (!credentials?.access) return fellBack(declared);
        try {
          const loadCatalog = async (current) =>
            catalog.load(current, { clientVersion: await clientVersionNow() });
          let list;
          try {
            list = await loadCatalog(credentials);
          } catch (error) {
            if (error.signIn !== "expired" || !credentials.refresh) throw error;
            const retry = await currentCredentials(auth, { forceRefresh: true });
            if (!retry.credentials?.access || retry.credentials.access === credentials.access) {
              throw error;
            }
            credentials = retry.credentials;
            list = await loadCatalog(credentials);
          }
          // 目录为空的合法场景之一是"权益还没发放"（官方注释同款）——先签到重领一次再取。
          if (
            !list.length &&
            (await ensurePlan(credentials, { deadline: Date.now() + USAGE_BUDGET_MS }))
          ) {
            list = await loadCatalog(credentials);
          }
          if (!list.length) {
            log("warn", `${PROVIDER}: ${t.modelListEmpty}`);
            const cached = await stateStore.cachedModels(credentials.uid);
            if (cached.length) return fellBack(providerModels(cached));
            return fellBack(declared);
          }
          await stateStore.recordModels(credentials.uid, list, { source: "live" });
          await stateStore.recordLogin(credentials.uid, raw?.source ?? "browser");
          return providerModels(list);
        } catch (error) {
          if (error.signIn === "expired") throw error;
          rememberFailure(credentials.uid, error, { stage: "models" });
          const cached = await stateStore.cachedModels(credentials.uid);
          if (cached.length) {
            log(
              "warn",
              `${PROVIDER}: ${t.modelsUnavailable}: ${redactText(error.message)}`,
            );
            return fellBack(providerModels(cached));
          }
          log(
            "warn",
            `${PROVIDER}: ${t.modelsUnavailable}: ${redactText(error.message)}`,
          );
          return fellBack(declared);
        }
      },
    },

    auth: {
      provider: PROVIDER,
      ...(ICON === undefined ? {} : { icon: ICON }),

      /** Browser OAuth, plus reuse of the official CLI's local sign-in. */
      methods: [
        {
          type: "oauth",
          label: t.methodLabel,
          async authorize() {
            let started;
            try {
              started = await startLogin(opts.platformBaseURL, { clientVersion: await clientVersionNow() });
            } catch (error) {
              throw new Error(fill(t.loginFailed, { detail: error.message }));
            }
            return {
              url: started.loginUrl,
              instructions: t.instructions,
              method: "auto",
              /**
               * Poll until the browser side finishes: check → token, ~2.5 s
               * cadence, ~9 min budget (the broker's own session is 10 min).
               */
              async callback() {
                const deadline = Date.now() + 9 * 60_000;
                while (Date.now() < deadline) {
                  await sleep(2_500);
                  let valid = false;
                  try {
                    valid = await checkLogin(opts.platformBaseURL, started.state, {
                      clientVersion: await clientVersionNow(),
                    });
                  } catch (error) {
                    log("warn", `${PROVIDER}: login check: ${redactText(error.message)}`);
                    continue;
                  }
                  if (!valid) continue;
                  try {
                    const token = await tokenFor(opts.platformBaseURL, started.state, {
                      clientVersion: await clientVersionNow(),
                    });
                    // 签到闭环的最后一步（Atom2Api 登录后同款）：把计划领上。
                    // 幂等（重复领取返回 duplicate），失败只记日志、绝不拦登录。
                    if (autoClaimEnabled()) {
                      // Claiming is useful but must never delay a completed
                      // sign-in. A later models/usage call retries idempotently.
                      void (async () => {
                        try {
                          const claim = await claimOnce({
                            access: token.accessToken,
                            uid: String(token.user.id),
                          });
                          if (!claim) return;
                          if (claim.claimed) log("info", `${PROVIDER}: coding plan: ${claim.planName || claim.tier}`);
                          else log("warn", `${PROVIDER}: coding plan: ${redactText(claim.message)}`);
                        } catch (error) {
                          log(
                            "warn",
                            `${PROVIDER}: coding plan claim failed: ${redactText(error.message)}`,
                          );
                        }
                      })();
                    }
                    void stateStore.recordLogin(
                      String(token.user.id),
                      "atomcode-browser",
                    );
                    return {
                      type: "success",
                      source: "atomcode-browser",
                      refresh: token.refreshToken,
                      access: token.accessToken,
                      expires: Date.now() + (token.expiresIn > 0 ? token.expiresIn * 1000 : 7 * 24 * 3600_000),
                      // Magpie names the account from accountId, then metadata.email,
                      // then email — email first, per its own guidance.
                      accountId: token.user.email || token.user.username || String(token.user.id),
                      email: token.user.email || undefined,
                      name: token.user.name || token.user.username || undefined,
                      uid: String(token.user.id),
                    };
                  } catch (error) {
                    log("warn", `${PROVIDER}: login finish: ${redactText(error.message)}`);
                    return {
                      type: "failed",
                      error: fill(t.loginFailed, { detail: redactText(error.message, 120) }),
                    };
                  }
                }
                return { type: "failed", error: t.loginTimeout };
              },
            };
          },
        },
        {
          type: "oauth",
          label: t.cliMethodLabel,
          prompts: [
            {
              type: "text",
              key: "authFile",
              message: t.cliAuthFilePrompt,
              placeholder: "~/.atomcode/auth.toml",
              validate: (value) => {
                try {
                  resolveAuthFilePath(value);
                  return undefined;
                } catch {
                  return t.cliAuthFileInvalid;
                }
              },
            },
          ],
          async authorize(inputs = {}) {
            let authFile;
            try {
              authFile = resolveAuthFilePath(inputs.authFile);
            } catch {
              throw new Error(t.cliAuthFileInvalid);
            }
            return {
              instructions: t.cliInstructions,
              method: "auto",
              async callback() {
                try {
                  const auth = await readAuthFile(authFile);
                  void stateStore.recordLogin(auth.uid, "atomcode-cli");
                  return {
                    type: "success",
                    source: "atomcode-cli",
                    authFile: auth.path,
                    access: auth.access,
                    refresh: auth.refresh,
                    expires: auth.expires,
                    accountId: auth.accountId,
                    email: auth.email,
                    name: auth.name,
                    uid: auth.uid,
                  };
                } catch (error) {
                  return {
                    type: "failed",
                    error: fill(t.cliLoginFailed, { detail: redactText(error.message, 120) }),
                  };
                }
              },
            };
          },
        },
      ],

      /**
       * Magpie's native provider switches. Explicit legacy `options`
       * (`autoClaim`/`autoVersion`) win for compatibility; otherwise these
       * values are read live from `input.magpie.option`.
       */
      options: [
        {
          key: "auto_claim",
          label: t.autoClaimLabel,
          description: t.autoClaimDescription,
          default: true,
          labels: { zh: "自动领取套餐", en: "Claim plans automatically" },
          descriptions: {
            zh: "登录后幂等领取 CodingPlan，并在套餐到期时自动重领。",
            en: "Idempotently claim CodingPlan after sign-in and re-claim it when the plan expires.",
          },
        },
        {
          key: "auto_version",
          label: t.autoVersionLabel,
          description: t.autoVersionDescription,
          default: true,
          labels: { zh: "自动跟随客户端版本", en: "Follow the client version" },
          descriptions: {
            zh: "从 AtomCode 官方仓库后台刷新版本号，用于签名与 User-Agent。",
            en: "Refresh the version from AtomCode's official repository in the background for signing and User-Agent.",
          },
        },
      ],

      /**
       * The account, resolved into request routing.
       *
       * The returned `fetch` is the only place bodies get touched. A streaming
       * Chat Completions body may gain `stream_options.include_usage`, then the
       * exact bytes sent are signed; responses stream back untouched. A request
       * aimed anywhere but the gateway is refused outright, before any
       * credential is attached to it.
       */
      async loader(getAuth) {
        return {
          baseURL: opts.gatewayURL,
          async fetch(input, init) {
            const isRequest = input instanceof Request;
            // Freeze the destination before any await. A caller-owned URL
            // object may otherwise change while credentials are being read,
            // separating the validated origin from the actual destination.
            const target = new URL(isRequest ? input.url : String(input));
            const targetString = target.href;
            const pathname = target.pathname;
            // Nothing leaves for anywhere but the gateway: the credential and
            // the signature headers are only ever meant for that one origin.
            if (target.origin !== gatewayOrigin) {
              const blocked = fill(t.foreignTargetBlocked, { origin: target.origin });
              log("warn", `${PROVIDER}: ${blocked}`);
              throw new Error(blocked);
            }

            // Re-read per request so a sign-in that changes mid-session is
            // picked up without waiting for the loader to re-run. This also
            // renews on older hosts that never call auth.refresh.
            const state = await currentCredentials(getAuth);
            let credentials = state.credentials;
            if (!credentials) {
              // No signed-in account: ship the request without credentials and
              // let the upstream's own answer tell the agent what happened.
              const headers = new Headers(init?.headers ?? (isRequest ? input.headers : undefined));
              headers.delete("authorization");
              const forwarded = {
                ...(isRequest
                  ? {
                      cache: input.cache,
                      credentials: input.credentials,
                      integrity: input.integrity,
                      keepalive: input.keepalive,
                      mode: input.mode,
                      referrer: input.referrer,
                      referrerPolicy: input.referrerPolicy,
                      signal: input.signal,
                    }
                  : {}),
                ...init,
                headers,
                redirect: "error",
              };
              if (forwarded.body === undefined && isRequest && input.body) {
                forwarded.body = input.body;
                forwarded.duplex = "half";
              }
              return fetch(targetString, forwarded);
            }

            if (!credentials.uid) throw markExpired();

            // UA、X-AtomCode-Ver、签名盐同源自这一个值
            const clientVersion = await clientVersionNow();

            const headers = new Headers(init?.headers ?? (isRequest ? input.headers : undefined));
            let normalized;
            try {
              normalized = await normalizeRequestBody(init?.body, {
                request: isRequest ? input : undefined,
                fromRequest: isRequest && init?.body === undefined,
              });
            } catch (error) {
              throw new Error(`unsupported request body: ${redactText(error.message)}`);
            }
            if (normalized.contentType && !headers.has("content-type")) {
              headers.set("content-type", normalized.contentType);
            }
            const streamed = includeStreamUsage(normalized.signBody, {
              pathname,
              contentType: headers.get("content-type") ?? "",
            });
            if (streamed.changed) {
              normalized = { ...normalized, body: streamed.body, signBody: streamed.body };
              headers.delete("content-length");
            }

            const dispatch = async (current, bodyInfo) => {
              const requestHeaders = new Headers(headers);
              const method = init?.method ?? (isRequest ? input.method : "GET");
              const signed = signAtomGitRequest({
                method,
                path: pathname,
                body: bodyInfo.signBody,
                oauthToken: current.access,
                userId: current.uid,
                clientVersion,
                masterKeyHex: opts.masterKeyHex,
              });
              for (const [key, value] of Object.entries(signed)) {
                requestHeaders.set(key, value);
              }
              requestHeaders.set("authorization", `Bearer ${current.access}`);
              requestHeaders.set("user-agent", userAgentOf(clientVersion));

              const forwarded = {
                ...(isRequest
                  ? {
                      cache: input.cache,
                      credentials: input.credentials,
                      integrity: input.integrity,
                      keepalive: input.keepalive,
                      mode: input.mode,
                      referrer: input.referrer,
                      referrerPolicy: input.referrerPolicy,
                      signal: input.signal,
                    }
                  : {}),
                ...init,
                method,
                headers: requestHeaders,
                redirect: "error",
              };
              if (bodyInfo.body !== undefined) forwarded.body = bodyInfo.body;
              else delete forwarded.body;
              delete forwarded.duplex;
              return fetch(targetString, forwarded);
            };

            let response;
            try {
              response = await dispatch(credentials, normalized);
            } catch (error) {
              rememberFailure(credentials.uid, error, { stage: "gateway" });
              throw annotateError(error, { stage: "gateway" });
            }
            let failure = await classifyGatewayResponse(response);
            if (
              (response.status === 401 || failure.refresh) &&
              !state.renewed &&
              credentials.refresh
            ) {
              try {
                const retry = await currentCredentials(getAuth, { forceRefresh: true });
                if (retry.credentials?.access && retry.credentials.access !== credentials.access) {
                  await response.body?.cancel().catch(() => {});
                  credentials = retry.credentials;
                  response = await dispatch(credentials, normalized);
                  failure = await classifyGatewayResponse(response);
                }
              } catch (error) {
                if (error.signIn === "expired") throw markExpired();
                log(
                  "warn",
                  `${PROVIDER}: ${fill(t.refreshFailed, { detail: redactText(error.message) })}`,
                );
              }
            }
            if (
              [401, 403, 429].includes(response.status) ||
              response.status >= 500
            ) {
              rememberFailure(
                credentials.uid,
                Object.assign(new Error(failure.message || `HTTP ${response.status}`), {
                  status: response.status,
                  category: failure.category,
                }),
                { stage: "gateway" },
              );
            }
            return keptResponseHeaders(response, failure);
          },
        };
      },

      /**
       * The CodingPlan quota, as the provider row and `magpie quota` show it.
       */
      async usage(getAuth) {
        const deadline = Date.now() + USAGE_BUDGET_MS;
        let raw = await readAuth(getAuth);
        let user = userLabel(raw);
        let credentials = credentialsOf(raw);
        let cacheKey = credentials?.uid ?? credentials?.access ?? "no-account";
        try {
          const hit = quotaCache.get(cacheKey);
          if (hit && Date.now() - hit.at < opts.quotaTtlMs) return hit.value;

          ({ raw, credentials } = await currentCredentials(raw, { deadline }));
          user = userLabel(raw);
          cacheKey = credentials?.uid ?? credentials?.access ?? "no-account";
          const refreshedHit = quotaCache.get(cacheKey);
          if (refreshedHit && Date.now() - refreshedHit.at < opts.quotaTtlMs) {
            return refreshedHit.value;
          }
          if (!credentials) {
            const value = { plan: t.planFallback, error: t.noAccount, windows: [] };
            // 失败态只留 15 秒：下一次轮询正是重登之后该重试的时刻。
            quotaCache.set(cacheKey, { at: Date.now() - opts.quotaTtlMs + 15_000, value });
            return value;
          }

          const readStatus = async (current, wantedMs) =>
            fetchStatus(opts.codingPlanAPIURL, current.access, {
              clientVersion: await clientVersionNow(),
              timeoutMs: Math.max(
                250,
                Math.min(wantedMs, remainingMs(deadline) ?? wantedMs),
              ),
            });
          let status;
          try {
            status = await readStatus(credentials, 7_000);
          } catch (error) {
            if (!isCredentialFailure(error) || !credentials.refresh) {
              throw error;
            }
            const retry = await currentCredentials(raw, { forceRefresh: true, deadline });
            if (!retry.credentials?.access || retry.credentials.access === credentials.access) {
              throw error;
            }
            ({ raw, credentials } = retry);
            user = userLabel(raw);
            cacheKey = credentials.uid ?? credentials.access;
            status = await readStatus(credentials, 7_000);
          }
          // 签到语义：套餐缺失/到期 → 自动重领一次，成功后重取状态再映射。
          if (await ensurePlan(credentials, { status, deadline })) {
            const remaining = remainingMs(deadline);
            if (remaining !== undefined && remaining <= 0) throw new Error(t.usageTimeout);
            status = await readStatus(credentials, 4_000);
          }
          const value = quotaFromStatus(status, t, { user });
          quotaCache.set(cacheKey, { at: Date.now(), value });
          await stateStore.recordQuota(credentials.uid, value);
          await stateStore.recordLogin(credentials.uid, raw?.source ?? "browser");
          return value;
        } catch (error) {
          const failure = classifyError(error, { stage: "usage" });
          const expired = error.signIn === "expired" || failure.signInExpired;
          const uid = credentials?.uid ?? raw?.uid;
          rememberFailure(uid, error, { stage: "usage" });
          const stale = expired ? undefined : await stateStore.cachedQuota(uid);
          const detail = redactText(error.message);
          const value = {
            ...(stale ?? {}),
            plan: stale?.plan ?? t.planFallback,
            ...(user ? { user } : {}),
            error: expired
              ? t.reloginRequired
              : stale
                ? fill(t.usageStale, { detail })
              : error.status
                ? fill(t.usageHttp, { status: error.status })
                : fill(t.readFailed, { detail }),
            signIn: expired ? "expired" : "kept",
            ...(stale ? { stale: true } : {}),
            windows: stale?.windows ?? [],
          };
          quotaCache.set(cacheKey, { at: Date.now() - opts.quotaTtlMs + 15_000, value });
          log("warn", `${PROVIDER}: usage: ${redactText(error.message)}`);
          return value;
        }
      },

      /**
       * 签到 —— magpie 原生 checkin 设置开关调度的钩子（社区 raccoon/
       * autoclaw 插件同款）：AtomCode 的对应端点就是 claim-v2 领取。
       *
       *   - 这次真的领到了（fresh claim）→ claimed（带套餐名与档位）；
       *   - 本来就持有对应/更高档（duplicate）→ done（仍有效，无新领取）；
       *   - 上游拒绝（日限额已满等）→ failed，把上游 message 带回去。
       */
      async checkin(getAuth) {
        const deadline = Date.now() + USAGE_BUDGET_MS;
        let state;
        let credentials;
        try {
          state = await currentCredentials(getAuth, { deadline });
          ({ credentials } = state);
        } catch (error) {
          return {
            outcome: "failed",
            message:
              error.signIn === "expired"
                ? t.reloginRequired
                : fill(t.readFailed, { detail: redactText(error.message) }),
          };
        }
        if (!credentials?.access) {
          return { outcome: "failed", message: t.noAccount };
        }
        // 状态先看一眼：套餐仍在有效期内就不打扰领取接口（claim-v2 幂等，
        // 但一次元数据请求换一个确定的 done 比一次网络往返更稳）。
        try {
          const statusTimeout = () => {
            const remaining = remainingMs(deadline);
            if (remaining !== undefined && remaining <= 0) return 0;
            return Math.max(250, Math.min(6_000, remaining ?? 6_000));
          };
          const timeoutMs = statusTimeout();
          if (timeoutMs === 0) {
            return { outcome: "failed", message: t.usageTimeout };
          }
          const readStatus = async () =>
            fetchStatus(opts.codingPlanAPIURL, credentials.access, {
              clientVersion: await clientVersionNow(),
              timeoutMs: statusTimeout() || 250,
            });
          let status;
          try {
            status = await readStatus();
          } catch (error) {
            if (!isCredentialFailure(error) || !credentials.refresh) {
              throw error;
            }
            const retry = await currentCredentials(state.raw, {
              forceRefresh: true,
              deadline,
            });
            if (!retry.credentials?.access || retry.credentials.access === credentials.access) {
              throw error;
            }
            state = retry;
            credentials = retry.credentials;
            status = await readStatus();
          }
          if (!planNeedsClaim(status)) {
            const plan = status?.codingplan_free ?? status?.plan ?? {};
            return {
              outcome: "done",
              message: plan.plan_name
                ? fill(t.checkinDoneWithPlan, { plan: plan.plan_name })
                : t.checkinDone,
            };
          }
        } catch (error) {
          if (error.signIn === "expired") return { outcome: "failed", message: t.reloginRequired };
          // 状态读不到（网络抖动）不放弃：直接尝试领取，由领取结果说话。
        }
        try {
          const claim = await claimOnce(credentials, { deadline });
          if (!claim) return { outcome: "failed", message: t.usageTimeout };
          if (!claim.claimed) {
            const category =
              claim.category ??
              classifyError({ message: claim.message }).category;
            if (
              category === FAILURE.INELIGIBLE ||
              category === FAILURE.ENTITLEMENT_FORBIDDEN
            ) {
              return {
                outcome: "ineligible",
                message: redactText(claim.message) || t.checkinIneligible,
              };
            }
            return {
              outcome: "failed",
              message:
                redactText(claim.message) ||
                fill(t.reclaimFailed, { detail: "no tier" }),
            };
          }
          if (claim.duplicate) {
            return {
              outcome: "done",
              message: claim.planName
                ? fill(t.checkinDoneWithPlan, { plan: claim.planName })
                : t.checkinDone,
            };
          }
          return {
            outcome: "claimed",
            message: claim.planName || claim.tier || undefined,
          };
        } catch (error) {
          return {
            outcome: "failed",
            message: fill(t.reclaimFailed, { detail: redactText(error.message) }),
          };
        }
      },

      /**
       * Token renewal before expiry — Magpie's own hook (OpenCode ignores it).
       */
      refreshLead: 5 * 60 * 1000,
      async refresh(auth) {
        const { credentials } = await currentCredentials(auth, { forceRefresh: true });
        if (!credentials?.access) throw markExpired();
        return {
          access: credentials.access,
          refresh: credentials.refresh,
          expires: credentials.expires,
        };
      },
    },
  };

  if (magpie) {
    try {
      const diagnostics = startDiagnosticsService({
        port: opts.diagnosticsPort,
        stateStore,
        versionSource,
        locale: t.locale,
        config: {
          locale: t.locale,
          autoClaim: autoClaimEnabled,
          autoVersion: autoVersionEnabled,
          diagnosticsPort: opts.diagnosticsPort,
        },
        selfCheckConfig: {
          clientVersion: opts.clientVersion,
          masterKeyHex: opts.masterKeyHex,
        },
      });
      diagnostics.ready.then(
        () =>
          log(
            "info",
            `${PROVIDER}: ${fill(t.diagnosticsStarted, {
              port: opts.diagnosticsPort,
            })}`,
          ),
        (error) =>
          log(
            "warn",
            `${PROVIDER}: ${fill(t.diagnosticsFailed, {
              detail: redactText(error.message),
            })}`,
          ),
      );
    } catch (error) {
      log(
        "warn",
        `${PROVIDER}: ${fill(t.diagnosticsFailed, {
          detail: redactText(error.message),
        })}`,
      );
    }
  }

  return hooks;
}
