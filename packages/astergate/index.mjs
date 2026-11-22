import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROVIDER = "astergate";
const DEFAULT_ORIGIN = "https://beta.astergate.cc";
const SESSION_TTL_MS = 5 * 60_000;
const MAX_SESSIONS = 32;
const SDK = "@ai-sdk/anthropic";
const percent = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 });

const b64url = (value) => Buffer.from(value).toString("base64url");
const positive = (value) => Number.isFinite(value) && value > 0;
const list = (value) => Array.isArray(value) ? value : [];

function gatewayOrigin(directory) {
  if (!directory) return DEFAULT_ORIGIN;
  let source;
  try {
    source = readFileSync(join(directory, "astergate.json"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return DEFAULT_ORIGIN;
    throw new Error("Cannot read astergate.json");
  }
  try {
    const config = JSON.parse(source);
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error();
    if (Object.keys(config).some((key) => key !== "origin")) throw new Error();
    if (!Object.hasOwn(config, "origin")) return DEFAULT_ORIGIN;
    if (typeof config.origin !== "string") throw new Error();
    const url = new URL(config.origin);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" ||
        url.href !== url.origin + "/") throw new Error();
    return url.origin;
  } catch {
    throw new Error("astergate.json must contain only an HTTPS origin, without credentials, path, query or fragment");
  }
}

function timeout(signal) {
  const limit = AbortSignal.timeout(12_000);
  return signal ? AbortSignal.any([signal, limit]) : limit;
}

async function encryptLogin(key, challenge, publicKey, origin) {
  if (typeof challenge !== "string" || !/^[a-f0-9]{64}$/.test(challenge) || typeof publicKey !== "string") {
    throw new Error("Invalid AsterGate login challenge");
  }
  const rsaKey = await crypto.subtle.importKey(
    "spki", Buffer.from(publicKey, "base64url"), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"],
  );
  const contentKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const protectedHeader = b64url(JSON.stringify({ alg: "RSA-OAEP-256", enc: "A256GCM" }));
  const plaintext = Buffer.from(JSON.stringify({ key, challenge, origin }));
  try {
    const aesKey = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);
    const wrappedKey = await crypto.subtle.encrypt("RSA-OAEP", rsaKey, contentKey);
    const encrypted = Buffer.from(await crypto.subtle.encrypt({
      name: "AES-GCM", iv, additionalData: Buffer.from(protectedHeader), tagLength: 128,
    }, aesKey, plaintext));
    return [
      protectedHeader, b64url(wrappedKey), b64url(iv),
      b64url(encrypted.subarray(0, -16)), b64url(encrypted.subarray(-16)),
    ].join(".");
  } finally {
    contentKey.fill(0);
    plaintext.fill(0);
  }
}

async function readUsage(origin, key, sessions, signal) {
  const sessionId = createHash("sha256").update(key).digest("hex");
  const saved = sessions.get(sessionId);
  const reusable = saved && saved.until > Date.now();
  const cookies = new Map(reusable ? saved.cookies : []);
  const deadline = timeout(signal);
  async function session(path, method = "GET", body) {
    const headers = {
      "x-usage-client": "1",
      "x-usage-origin": origin,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
    };
    if (method === "POST") {
      headers.origin = origin;
      headers["content-type"] = "application/json";
    }
    if (cookies.size) headers.cookie = [...cookies.values()].join("; ");
    const response = await fetch(origin + "/usage-session/" + path, {
      method, headers, body, signal: deadline, redirect: "error", cache: "no-store",
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0];
      const equals = pair.indexOf("=");
      if (equals > 0) cookies.set(pair.slice(0, equals), pair);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw Object.assign(new Error(`AsterGate usage ${path.split("?")[0]} returned HTTP ${response.status}`), {
        status: response.status,
        signIn: path === "login" && response.status === 401 ? "expired" : "kept",
      });
    }
    return response;
  }
  async function report() {
    const data = await (await session("report?timezone=UTC")).json();
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid AsterGate usage report");
    return data;
  }

  if (reusable) {
    try {
      const data = await report();
      if (sessions.get(sessionId) === saved) sessions.set(sessionId, { cookies, until: saved.until });
      return data;
    } catch (error) {
      if (error.status !== 401) throw error;
      if (sessions.get(sessionId) === saved) sessions.delete(sessionId);
      cookies.clear();
    }
  }
  const { challenge, public_key: publicKey } = await (await session("challenge", "POST")).json();
  const jwe = await encryptLogin(key, challenge, publicKey, origin);
  await session("login", "POST", JSON.stringify({ challenge, jwe }));
  const data = await report();
  if (cookies.size) {
    sessions.delete(sessionId);
    if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    sessions.set(sessionId, { cookies, until: Date.now() + SESSION_TTL_MS });
  }
  return data;
}

function quotaWindows(report, showModelWindows) {
  const accounts = report.account_quota_shared === false ? [] : [
    ...list(report.accounts),
    ...list(report.upstream).filter((group) => group?.via === "upstream_astergate")
      .flatMap((group) => list(group.accounts)),
  ].filter((account) => typeof account?.provider === "string" && account.provider.toLowerCase() === "claude" && list(account.windows).length);
  const windows = accounts.flatMap((account, index) => list(account.windows).flatMap((window) => {
    const kind = /^(five_hour|weekly)(?:_|$)/.exec(window?.kind)?.[1];
    if (!kind) return [];
    const model = (typeof window.scoped_model === "string" && window.scoped_model) ||
      list(window.applies_to_models).filter((id) => typeof id === "string").join(", ");
    if (!showModelWindows && (model || window.scope === "model" || window.kind !== kind)) return [];
    const label = kind === "five_hour" ? "5 小时" : "每周";
    const span = (kind === "five_hour" ? 5 : 7 * 24) * 3600;
    const name = [label, accounts.length > 1 ? `Claude ${index + 1}` : "", model].filter(Boolean).join(" · ");
    let used = window.used_ratio;
    if (!Number.isFinite(used) && positive(window.limit) && Number.isFinite(window.remaining)) {
      used = 1 - window.remaining / window.limit;
    }
    if (!Number.isFinite(used) || used < 0) return [];
    // Each window describes one upstream account inside AsterGate's pool.
    return [{
      name, used: used * 100, display: `剩余 ${percent.format(Math.max(0, 1 - used))}`,
      resetsAt: window.resets_at, span, aside: true,
    }];
  }));
  const budget = report.budget?.weekly;
  if (positive(budget?.limit_usd) && Number.isFinite(budget.spent_usd) && budget.spent_usd >= 0) {
    windows.push({
      name: "Key 每周预算",
      used: budget.spent_usd / budget.limit_usd * 100,
      amount: budget.spent_usd,
      limit: budget.limit_usd,
      unit: "USD",
      resetsAt: budget.resets_at,
      span: 7 * 24 * 3600,
      aside: true,
    });
  }
  return windows;
}

export default async function asterMagpie({ directory, magpie } = {}) {
  const origin = gatewayOrigin(magpie ? directory : undefined);
  const base = origin + "/v1";
  const sessions = new Map();
  const modelWindows = "model-quota-windows";

  return {
    async config(config) {
      config.provider ??= {};
      config.provider[PROVIDER] ??= { name: "AsterGate", npm: SDK, api: base, models: {} };
    },
    auth: {
      provider: PROVIDER,
      methods: [{ type: "api", label: "AsterGate API Key" }],
      options: [{
        key: modelWindows,
        label: "Model-specific quota windows",
        labels: { zh: "显示模型专属额度" },
        default: true,
      }],
      async loader(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== "api" || !auth.key) return {};
        return {
          baseURL: base,
          async fetch(input, init) {
            const url = new URL(input instanceof Request ? input.url : input);
            if (url.origin !== origin || !["/v1/messages", "/v1/messages/count_tokens"].includes(url.pathname)) {
              throw new Error("Unexpected AsterGate Messages destination");
            }
            const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
            headers.delete("authorization");
            headers.set("x-api-key", auth.key);
            if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
            return fetch(input, { ...init, headers, redirect: "error" });
          },
        };
      },
      async usage(getAuth, _provider, { signal } = {}) {
        const auth = await getAuth();
        if (auth?.type !== "api" || !auth.key) return { error: "缺少 AsterGate API Key" };
        try {
          const report = await readUsage(origin, auth.key, sessions, signal);
          const windows = quotaWindows(report, magpie?.option?.(PROVIDER, modelWindows) !== false);
          if (!windows.length) return {
            error: report.account_quota_shared === false ? "AsterGate 未共享账号额度" : "AsterGate 暂无可读的 Claude 额度",
            signIn: "kept",
          };
          return { plan: "AsterGate", windows };
        } catch (error) {
          return {
            error: error.signIn ? error.message : "AsterGate 额度查询失败",
            signIn: error.signIn ?? "kept",
          };
        }
      },
    },
    provider: {
      id: PROVIDER,
      async models(provider, { auth, signal } = {}) {
        if (auth?.type !== "api" || !auth.key) return provider.models;
        const response = await fetch(base + "/models", {
          headers: { "x-api-key": auth.key, "anthropic-version": "2023-06-01" },
          redirect: "error",
          signal: timeout(signal),
        });
        if (!response.ok) {
          throw Object.assign(new Error(`AsterGate model list returned HTTP ${response.status}`), {
            signIn: response.status === 401 ? "expired" : "kept",
          });
        }
        const { data } = await response.json();
        if (!Array.isArray(data)) throw new Error("Invalid AsterGate model list");
        return Object.fromEntries(data.filter((model) => (
          typeof model?.id === "string" && model.id.startsWith("claude-")
        )).map((model) => [model.id, {
          id: model.id,
          name: model.display_name || model.id,
          api: { id: model.id, url: base, npm: SDK },
          capabilities: { toolcall: true, input: { text: true, image: true }, output: { text: true } },
          limit: {
            ...(positive(model.context_window) ? { context: model.context_window } : {}),
            ...(positive(model.max_output_tokens) ? { output: model.max_output_tokens } : {}),
          },
        }]));
      },
    },
  };
}
