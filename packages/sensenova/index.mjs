/**
 * SenseNova (SenseTime 日日新) Token Plan for OpenCode and magpie.
 *
 * One account has two credentials: a console OAuth token pair that reads the
 * credit pools, and a Token Plan API key that serves the plan's models.
 *
 * The browser method creates the API key on the account (and may reuse one
 * this machine made earlier); the password method keeps the console's own
 * OIDC walk as a headless fallback; the API-key method serves models without
 * a console sign-in. The provider id is the upstream package's id, so an
 * existing account keeps its models and groups.
 */

import { browserCandidates, startLoginCapture } from "./lib/browser.mjs";
import { seal, unseal } from "./lib/dpapi.mjs";
import { ensureKey } from "./lib/keys.mjs";
import { createPkce } from "./lib/pkce.mjs";
import { passwordLogin, walkInternals } from "./lib/password.mjs";
import {
  ENDPOINTS,
  buildAuthorizeUrl,
  cleanDetail,
  exchangeCode,
  fetchPoolUsage,
  identityFromTokens,
  keyFingerprint,
  normalizeApiKey,
  probeApiKey,
  refreshPasswordTokens,
  refreshTokens,
} from "./lib/protocol.mjs";
import { poolsOf, toUsage, usageOf } from "./lib/quota.mjs";
import {
  FALLBACK_MODELS,
  MEASURED_OUTPUT_LIMITS,
  catalogModels,
  chatModels,
  createCatalog,
  fellBack,
  filterByPlan,
  modelOf,
  toConfigModel,
} from "./lib/models.mjs";

const PROVIDER_ID = "sensenova-token-plan";
const EARLY_MS = 10 * 60 * 1000;
const NPM = "@ai-sdk/openai-compatible";
const DEFAULT_QUOTA_TTL_MS = 60_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 8 * 60 * 1000;
const FALLBACK_TOKEN_LIFETIME_MS = 3 * 3600 * 1000;

const PROTOCOLS = {
  chat: { npm: NPM, video: true },
  anthropic: { npm: "@ai-sdk/anthropic", video: false },
  responses: { npm: "@ai-sdk/openai", video: false },
};

const lifetimeOf = (expiresIn) =>
  Number.isFinite(Number(expiresIn)) && Number(expiresIn) > 0
    ? Number(expiresIn) * 1000
    : FALLBACK_TOKEN_LIFETIME_MS;

/**
 * A provider option: the host's value when it has one, else the fallback.
 * magpie fills the option's default before the plugin reads it; outside
 * magpie (OpenCode) there is no host value, so the fallback decides.
 */
export function optionEnabled(magpie, options, key, fallback = false) {
  try {
    const value = magpie?.option?.(PROVIDER_ID, key);
    if (typeof value === "boolean") return value;
  } catch {
    /* older host */
  }
  return typeof options?.[key] === "boolean" ? options[key] : fallback;
}

/** The browser method needs a Chromium and, on Linux, a display. */
function browserAvailable() {
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  try {
    return browserCandidates().length > 0;
  } catch {
    return false;
  }
}

export async function SenseNovaAuthPlugin({ client, magpie } = {}, options = {}) {
  const baseURL =
    typeof options.baseURL === "string" && options.baseURL.trim()
      ? options.baseURL.trim().replace(/\/+$/, "")
      : ENDPOINTS.api;
  const browserPath = typeof options.browser === "string" && options.browser.trim() ? options.browser.trim() : undefined;
  const quotaTtlMs =
    Number.isFinite(Number(options.quotaTtlMs)) && Number(options.quotaTtlMs) > 0
      ? Number(options.quotaTtlMs)
      : DEFAULT_QUOTA_TTL_MS;
  const loginTimeoutMs =
    Number.isFinite(Number(options.loginTimeoutMs)) && Number(options.loginTimeoutMs) > 0
      ? Number(options.loginTimeoutMs)
      : DEFAULT_LOGIN_TIMEOUT_MS;
  const protocol = Object.hasOwn(PROTOCOLS, options.protocol) ? options.protocol : "chat";
  const wire = { ...PROTOCOLS[protocol], protocol };
  // Image-only models are for magpie's Drawers; OpenCode's provider catalogue
  // stays a chat provider (the upstream convention).
  const hostIsMagpie = Boolean(magpie);

  const catalog = createCatalog({ baseURL });
  const quotaCache = new Map(); // sealed access -> { at, value }
  const planCache = new Map(); // sealed access -> { at, ids }

  const log = (level, message) => {
    try {
      client?.app?.log?.({ body: { service: PROVIDER_ID, level, message: cleanDetail(message) } });
    } catch {
      /* logging is best effort */
    }
  };

  const pruneOn = () => optionEnabled(magpie, options, "prune_old_keys", false);
  const createKeyOn = () => optionEnabled(magpie, options, "create_key", true);

  const apiKeyOf = async (auth) => {
    if (!auth) return "";
    const raw = auth.type === "api" ? (auth.key ?? "") : (auth.apiKey ?? "");
    if (!raw) return "";
    if (String(raw).startsWith("dpapi:")) return unseal(raw);
    return normalizeApiKey(raw);
  };

  const refreshTokensFor = (auth, refreshToken) =>
    auth?.tokenHost === "browser" ? refreshTokens(refreshToken) : refreshPasswordTokens(refreshToken);

  const save = async (body) => {
    if (typeof client?.auth?.set !== "function") return false;
    try {
      await client.auth.set({ path: { id: PROVIDER_ID }, body });
      return true;
    } catch {
      return false;
    }
  };

  const bootModels = () =>
    Object.fromEntries(chatModels(FALLBACK_MODELS).map((m) => [m.id, toConfigModel(m, wire)]));

  const declareModels = () =>
    Object.fromEntries(
      catalogModels(catalog.peek() ?? FALLBACK_MODELS, { images: hostIsMagpie }).map((m) => [
        m.id,
        toConfigModel(m, wire),
      ]),
    );

  /** The ids the account's plan covers, or null when the read says nothing. */
  const planIds = async (auth) => {
    const sealed = auth?.access ?? "";
    if (!sealed) return null;
    const cached = planCache.get(sealed);
    if (cached && Date.now() - cached.at < quotaTtlMs) return cached.ids;
    let access;
    try {
      access = await unseal(sealed);
    } catch {
      return null;
    }
    try {
      const raw = await fetchPoolUsage(access);
      if (!Array.isArray(raw?.data?.pools) && !Array.isArray(raw?.pools)) {
        // not the console's shape: the read failed, the plan says nothing
        return null;
      }
      const ids = new Set(
        poolsOf(raw)
          .flatMap((p) => (Array.isArray(p?.model_ids) ? p.model_ids : []))
          .filter((x) => typeof x === "string" && x),
      );
      planCache.set(sealed, { at: Date.now(), ids });
      if (planCache.size > 8) planCache.clear();
      return ids;
    } catch {
      return null;
    }
  };

  /** The usage card, with a 401 recovery that only spends a refresh token once. */
  const readUsage = async (getAuth, auth) => {
    const sealed = auth?.access ?? "";
    const hit = quotaCache.get(sealed);
    if (hit && Date.now() - hit.at < quotaTtlMs) return hit.value;
    let access = "";
    try {
      access = await unseal(sealed);
    } catch (e) {
      return { error: cleanDetail(e?.message ?? e), signIn: "expired" };
    }
    try {
      const value = toUsage(await fetchPoolUsage(access), { username: auth.username || auth.accountId || "" });
      quotaCache.set(sealed, { at: Date.now(), value });
      if (quotaCache.size > 8) quotaCache.clear();
      return value;
    } catch (e) {
      if (e?.status !== 401) return { error: cleanDetail(e?.message ?? e), signIn: "kept" };
      // A 401 may be a token the host already renewed; look before spending one.
      const now = await getAuth();
      if (now?.access && now.access !== auth.access) {
        try {
          const value = toUsage(await fetchPoolUsage(await unseal(now.access)), {
            username: now.username || now.accountId || "",
          });
          quotaCache.set(now.access, { at: Date.now(), value });
          return { ...value, signIn: "renewed" };
        } catch (e2) {
          return { error: cleanDetail(e2?.message ?? e2), signIn: "kept" };
        }
      }
      if (!now?.refresh) return { error: "no refresh token; sign in again", signIn: "expired" };
      try {
        const t = await refreshTokensFor(now, await unseal(now.refresh));
        if (!t?.access_token) throw new Error("refresh returned no access token");
        const next = {
          ...now,
          access: await seal(t.access_token, { log }),
          refresh: await seal(t.refresh_token || (await unseal(now.refresh)), { log }),
          expires: Date.now() + lifetimeOf(t.expires_in),
        };
        if (!(await save(next))) {
          return { error: "renewed, but the new tokens could not be saved; sign in again", signIn: "kept" };
        }
        const value = toUsage(await fetchPoolUsage(t.access_token), {
          username: next.username || next.accountId || "",
        });
        quotaCache.set(next.access, { at: Date.now(), value });
        return { ...value, signIn: "renewed" };
      } catch (e2) {
        if (e2?.invalidGrant) return { error: `${cleanDetail(e2?.message ?? e2)}; sign in again`, signIn: "expired" };
        return { error: cleanDetail(e2?.message ?? e2), signIn: "kept" };
      }
    }
  };

  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      const p = (cfg.provider[PROVIDER_ID] ??= {});
      p.name ??= "SenseNova Token Plan";
      p.npm ??= wire.npm;
      p.api ??= baseURL;
      p.models = { ...bootModels(), ...(p.models ?? {}) };
    },

    provider: {
      id: PROVIDER_ID,

      async models(provider, { auth } = {}) {
        const declared =
          provider?.models && Object.keys(provider.models).length > 0 ? provider.models : declareModels();
        if (!auth) return declared;

        let apiKey = "";
        try {
          apiKey = await apiKeyOf(auth);
        } catch (e) {
          log("warn", `sensenova: ${e?.message ?? e}`);
          return fellBack(declared);
        }
        // Signed in for quota only: this account serves no models.
        if (!apiKey) return {};

        // User-pinned models are honoured as they are: a plan read that fails
        // (or a read we cannot trust) must keep them, not replace them.
        const coveredOrThrow = async () => {
          const covered = await planIds(auth);
          if (covered === null) throw Object.assign(new Error("plan read failed"), { planFailed: true });
          return covered;
        };
        try {
          // The plan is asked before the catalogue: coverage that names no
          // models ends here, and /models is never called.
          const covered = await coveredOrThrow();
          if (!covered.size) return {};
          // the listing reads the catalogue raw: the live row is the authority
          // for what a model takes (curated knowledge stays in the bootstrap
          // config, where nothing live has answered yet)
          const rawRows = await catalog.raw(apiKey);
          const live = catalogModels(
            rawRows.map((r) => ({
              id: r.id,
              name: r.name,
              contextLength: r.context_length,
              maxCompletionTokens: r.max_output_length,
              inputModalities: r.input_modalities,
              outputModalities: r.output_modalities,
              reasoning: (r.supported_features ?? []).includes("reasoning"),
              supportsTools: (r.supported_features ?? []).includes("tools"),
              efforts: [],
            })),
            { images: hostIsMagpie },
          );
          if (!live.length) return fellBack(declared);
          const filtered = filterByPlan(live, covered);
          if (!filtered.length) return {};
          return Object.fromEntries(
            filtered.map((m) => [
              m.id,
              modelOf({
                id: m.id,
                name: m.name,
                context: m.contextLength,
                output: MEASURED_OUTPUT_LIMITS[m.id]?.value ?? m.maxCompletionTokens,
                input_modalities: m.inputModalities,
                supported_features: m.supportsTools ? ["tools"] : [],
                reasoning: m.reasoning,
              }),
            ]),
          );
        } catch (e) {
          // The user's own pins survive a failed listing untouched.
          if (e?.planFailed && provider?.models && Object.keys(provider.models).length) return provider.models;
          // A 401/403 says this key is refused: advertising models would be a lie.
          if (e?.status === 401 || e?.status === 403) return {};
          log("warn", `sensenova: keeping the declared models (${e?.message ?? e})`);
          return fellBack(declared);
        }
      },
    },

    auth: {
      provider: PROVIDER_ID,
      refreshLead: EARLY_MS,
      maxConcurrency: 1,

      options: [
        {
          key: "create_key",
          label: "Create an API key on browser sign-in",
          labels: {
            zh: "浏览器登录时自动创建 API Key",
            "zh-TW": "瀏覽器登入時自動建立 API Key",
            ja: "ブラウザーサインイン時に API Key を自動作成",
            de: "Bei Browser-Anmeldung automatisch einen API Key erstellen",
          },
          description:
            "After a browser sign-in, create a Token Plan API key on the account if this machine has none to reuse.",
          descriptions: {
            zh: "浏览器登录后，如果这台机器上没有可复用的 Key，就在账号里创建一个。",
            "zh-TW": "瀏覽器登入後，如果這台機器上沒有可重用的 Key，就在帳號裡建立一個。",
            ja: "ブラウザーでサインインした後、このマシンに再利用できる Key がなければ、アカウントに 1 つ作成します。",
            de: "Wenn dieser Rechner nach der Browser-Anmeldung keinen wiederverwendbaren Key hat, wird einer auf dem Konto erstellt.",
          },
          default: true,
        },
        {
          key: "prune_old_keys",
          label: "Prune old magpie API keys",
          labels: {
            zh: "清理旧的 magpie API Key",
            "zh-TW": "清理舊的 magpie API Key",
            ja: "古い magpie API Key を削除",
            de: "Alte magpie API Keys löschen",
          },
          description:
            "Keep the newest two keys this sign-in's account created and delete older ones. Manual keys and keys named for another SenseNova account are never touched; a key whose creation time cannot be read is never deleted; two saved sign-ins of the same account share the prefix.",
          descriptions: {
            zh: "只保留本账号最新的两个 Key，删除更旧的。手动创建的 Key、以及名字属于别的 SenseNova 账号的 Key 永不删除；创建时间读不出的 Key 也永不删除；同一账号的两条登录记录共用前缀。",
            "zh-TW": "只保留本帳號最新的兩個 Key，刪除更舊的。手動建立的 Key、以及名字屬於別的 SenseNova 帳號的 Key 永不刪除；建立時間讀不出的 Key 也永不刪除；同一帳號的兩條登入記錄共用前綴。",
            ja: "このアカウントで最新の 2 本だけを残し、それより古いものを削除します。手動で作った Key、および別の SenseNova アカウント名の Key は絶対に削除しません。作成日時を読めない Key も絶対に削除しません。同じアカウントの 2 つのサインイン記録は同じプレフィックスを共有します。",
            de: "Behält die zwei neuesten Keys dieses Kontos und löscht ältere. Manuelle Keys und Keys eines anderen SenseNova-Kontos bleiben unberührt; ein Key ohne lesbare Erstellungszeit wird nie gelöscht; zwei gespeicherte Anmeldungen desselben Kontos teilen das Präfix.",
          },
          confirm: "Old magpie-* keys of this account will be deleted; manual keys and other accounts' keys are kept.",
          confirms: {
            zh: "本账号较旧的 magpie-* Key 会被删除；手动创建的和别的账号的 Key 会保留。",
            "zh-TW": "本帳號較舊的 magpie-* Key 會被刪除；手動建立的和別的帳號的 Key 會保留。",
            ja: "このアカウントの古い magpie-* Key は削除されます。手動で作った Key と、別のアカウントの Key は保持されます。",
            de: "Ältere magpie-* Keys dieses Kontos werden gelöscht; manuell erstellte Keys und Keys anderer Konten bleiben erhalten.",
          },
        },
      ],

      methods: [
        {
          type: "oauth",
          label: "Browser sign-in (creates an API key)",
          /**
           * The plugin opens a one-off Chromium itself, captures the OAuth
           * redirect before the console SPA consumes the code, and returns
           * opened:true with url:"" so magpie does not open a second page.
           */
          async authorize() {
            if (!browserAvailable()) {
              throw new Error(
                "No Chromium browser was found (or no display is available). Use the account password method or an API key instead.",
              );
            }
            const pkce = createPkce();
            const authorizeUrl = buildAuthorizeUrl(pkce);
            const session = await startLoginCapture({
              authorizeUrl,
              expectedState: pkce.state,
              timeoutMs: loginTimeoutMs,
              browserPath,
              log: (message) => log("info", `sensenova: ${message}`),
            });
            return {
              url: "",
              opened: true,
              instructions:
                "A one-off browser window is open. Sign in to the SenseNova console there (password, SMS code or QR code); " +
                "the plugin captures the redirect and creates an API key named magpie-* on this account (it may reuse or delete older keys it created).",
              method: "auto",
              async callback() {
                try {
                  const { code } = await session.result;
                  const tokens = await exchangeCode({ code, verifier: pkce.verifier });
                  if (!tokens?.access_token) throw new Error("the token response has no access_token");
                  if (!tokens?.refresh_token) throw new Error("the token response has no refresh_token (offline scope missing)");
                  const { username, uid } = identityFromTokens(tokens);
                  // the same id the account is saved under, so two records of
                  // one account share their key prefix even without a username
                  const accountId = username || uid || `sensenova-${keyFingerprint(tokens.refresh_token)}`;
                  let apiKey = "";
                  if (createKeyOn()) {
                    apiKey = await ensureKey(tokens.access_token, accountId, {
                      baseURL,
                      prune: pruneOn(),
                      log,
                    });
                  }
                  return {
                    type: "success",
                    accountId,
                    uid,
                    username,
                    refresh: await seal(tokens.refresh_token, { log }),
                    access: await seal(tokens.access_token, { log }),
                    expires: Date.now() + lifetimeOf(tokens.expires_in),
                    ...(apiKey ? { apiKey: await seal(apiKey, { log }) } : {}),
                    tokenHost: "browser",
                  };
                } catch (e) {
                  return { type: "failed", error: cleanDetail(e?.message ?? e) };
                } finally {
                  await session.close();
                }
              },
            };
          },
        },
        {
          type: "oauth",
          label: "Account password (headless fallback)",
          prompts: [
            {
              type: "input",
              key: "username",
              message: "Your SenseNova console account",
              validate: (v) => (String(v ?? "").trim() ? undefined : "account is required"),
            },
            {
              type: "password",
              key: "password",
              message: "Your SenseNova console password (sealed to a JWE before it leaves this machine)",
              validate: (v) => (String(v ?? "").trim() ? undefined : "password is required"),
            },
            {
              type: "password",
              key: "apiKey",
              message: "A Token Plan API key (optional; the browser method creates one for you)",
              placeholder: "sk-...",
              validate: (v) => {
                const s = String(v ?? "").trim();
                return s === "" || s.startsWith("sk-") ? undefined : "the key starts with sk-";
              },
            },
          ],
          authorize(inputs) {
            const username = String(inputs?.username ?? "").trim();
            const password = String(inputs?.password ?? "");
            if (!username || !password) throw new Error("enter the console account and password");
            const apiKeyInput = normalizeApiKey(inputs?.apiKey);
            return {
              url: "",
              instructions: "Signs in to the SenseNova console; the password is sealed and never stored.",
              method: "auto",
              async callback() {
                try {
                  const t = await passwordLogin(username, password);
                  if (apiKeyInput) {
                    try {
                      await probeApiKey(apiKeyInput, baseURL);
                    } catch (e) {
                      if (e?.status === 401 || e?.status === 403) {
                        return { type: "failed", error: "the API key was refused; check it and try again" };
                      }
                    }
                  }
                  return {
                    type: "success",
                    accountId: username,
                    uid: username,
                    username,
                    access: await seal(t.access, { log }),
                    refresh: await seal(t.refresh, { log }),
                    expires: t.expires,
                    ...(apiKeyInput ? { apiKey: await seal(apiKeyInput, { log }) } : {}),
                    tokenHost: "password",
                  };
                } catch (e) {
                  return { type: "failed", error: cleanDetail(e?.message ?? e) };
                }
              },
            };
          },
        },
        {
          type: "api",
          label: "API key only (models, no credit pools)",
          keyless: true,
          prompts: [
            {
              type: "password",
              key: "apiKey",
              message: "Token Plan API key (console → API Keys)",
              placeholder: "sk-...",
              validate: (v) => (normalizeApiKey(v) ? undefined : "API key is required"),
            },
          ],
          async authorize(inputs) {
            const apiKey = normalizeApiKey(inputs?.apiKey);
            if (!apiKey) return { type: "failed", error: "API key is required" };
            try {
              await probeApiKey(apiKey, baseURL);
            } catch (e) {
              if (e?.status === 401 || e?.status === 403) return { type: "failed", error: cleanDetail(e?.message ?? e) };
              log("warn", `sensenova: API key probe did not finish (${e?.message ?? e})`);
            }
            return {
              type: "success",
              key: await seal(apiKey, { log }),
              metadata: { apiKey: undefined, email: `key:${keyFingerprint(apiKey)}` },
            };
          },
        },
      ],

      async loader(getAuth) {
        const auth = await getAuth();
        const apiKey = await apiKeyOf(auth);
        if (!apiKey) return {};
        return { baseURL, apiKey };
      },

      async usage(getAuth) {
        const auth = await getAuth();
        if (!auth) return { error: "not signed in" };
        if (auth.type === "api") {
          return {
            error: "This account signed in with an API key only: models work, credit pools are not visible.",
            signIn: "kept",
          };
        }
        if (!auth.access) return { error: "not signed in", signIn: "expired" };
        const value = await readUsage(getAuth, auth);
        if (value?.error) return value;
        return { ...value, user: auth.username || auth.accountId || value.user || "sensenova" };
      },

      async refresh(auth) {
        if (auth?.type !== "oauth" || !auth.access || !auth.refresh) return undefined;
        let refreshToken = "";
        try {
          refreshToken = await unseal(auth.refresh);
        } catch (e) {
          throw Object.assign(new Error(cleanDetail(e?.message ?? e)), { signIn: "expired" });
        }
        if (!refreshToken) throw Object.assign(new Error("no refresh token; sign in again"), { signIn: "expired" });
        try {
          const t = await refreshTokensFor(auth, refreshToken);
          if (!t?.access_token) throw new Error("refresh returned no access_token");
          return {
            access: await seal(t.access_token, { log }),
            refresh: await seal(t.refresh_token || refreshToken, { log }),
            expires: Date.now() + lifetimeOf(t.expires_in),
          };
        } catch (e) {
          const error = new Error(`refresh failed: ${cleanDetail(e?.message ?? e)}`);
          error.dead = Boolean(e?.invalidGrant);
          if (e?.invalidGrant) error.signIn = "expired";
          throw error;
        }
      },
    },
  };
}

/** Tests point ENDPOINTS at a local fake and replace the crypto/launcher. */
export const _internal = {
  ENDPOINTS,
  startLoginCapture,
  passwordLogin,
  refreshToken: refreshPasswordTokens,
  ensureKey,
  browserAvailable,
  seal,
  unseal,
  ...walkInternals,
  EARLY_MS,
  modelOf,
  usageOf,
  toUsage,
  poolsOf,
};

export default SenseNovaAuthPlugin;
