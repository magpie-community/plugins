const PROVIDER = "astergate";
const ORIGIN = "https://beta.astergate.cc";
const BASE = ORIGIN + "/v1";
const SDK = "@ai-sdk/anthropic";
const percent = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 });

const b64url = (value) => Buffer.from(value).toString("base64url");
const positive = (value) => Number.isFinite(value) && value > 0;
const list = (value) => Array.isArray(value) ? value : [];

function timeout(signal) {
  const limit = AbortSignal.timeout(12_000);
  return signal ? AbortSignal.any([signal, limit]) : limit;
}

async function encryptLogin(key, challenge, publicKey) {
  if (typeof challenge !== "string" || !/^[a-f0-9]{64}$/.test(challenge) || typeof publicKey !== "string") {
    throw new Error("Invalid AsterGate login challenge");
  }
  const rsaKey = await crypto.subtle.importKey(
    "spki", Buffer.from(publicKey, "base64url"), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"],
  );
  const contentKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const protectedHeader = b64url(JSON.stringify({ alg: "RSA-OAEP-256", enc: "A256GCM" }));
  const plaintext = Buffer.from(JSON.stringify({ key, challenge, origin: ORIGIN }));
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

async function readUsage(key, signal) {
  const cookies = new Map();
  const deadline = timeout(signal);
  async function session(path, method = "GET", body) {
    const headers = {
      "x-usage-client": "1",
      "x-usage-origin": ORIGIN,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
    };
    if (method === "POST") {
      headers.origin = ORIGIN;
      headers["content-type"] = "application/json";
    }
    if (cookies.size) headers.cookie = [...cookies.values()].join("; ");
    const response = await fetch(ORIGIN + "/usage-session/" + path, {
      method, headers, body, signal: deadline, redirect: "error", cache: "no-store",
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0];
      const equals = pair.indexOf("=");
      if (equals > 0) cookies.set(pair.slice(0, equals), pair);
    }
    if (!response.ok) {
      throw Object.assign(new Error(`AsterGate usage ${path.split("?")[0]} returned HTTP ${response.status}`), {
        signIn: path === "login" && response.status === 401 ? "expired" : "kept",
      });
    }
    return response;
  }
  const { challenge, public_key: publicKey } = await (await session("challenge", "POST")).json();
  const jwe = await encryptLogin(key, challenge, publicKey);
  await session("login", "POST", JSON.stringify({ challenge, jwe }));
  return await (await session("report?timezone=UTC")).json();
}

function quotaWindows(report) {
  const accounts = report.account_quota_shared === false ? [] : [
    ...list(report.accounts),
    ...list(report.upstream).filter((group) => group?.via === "upstream_astergate")
      .flatMap((group) => list(group.accounts)),
  ].filter((account) => account?.provider?.toLowerCase() === "claude" && list(account.windows).length);
  const windows = accounts.flatMap((account, index) => list(account.windows).flatMap((window) => {
    const kind = /^(five_hour|weekly)(?:_|$)/.exec(window?.kind)?.[1];
    if (!kind) return [];
    const model = window.scoped_model || list(window.applies_to_models).join(", ");
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

export default async function asterMagpie() {
  return {
    async config(config) {
      config.provider ??= {};
      config.provider[PROVIDER] ??= { name: "AsterGate", npm: SDK, api: BASE, models: {} };
    },
    auth: {
      provider: PROVIDER,
      methods: [{ type: "api", label: "AsterGate API Key" }],
      async loader(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== "api" || !auth.key) return {};
        return {
          baseURL: BASE,
          async fetch(input, init) {
            const url = new URL(input instanceof Request ? input.url : input);
            if (url.origin !== ORIGIN || !["/v1/messages", "/v1/messages/count_tokens"].includes(url.pathname)) {
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
          const report = await readUsage(auth.key, signal);
          const windows = quotaWindows(report);
          if (!windows.length) return { error: "AsterGate 暂无可读的 Claude 额度" };
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
        const response = await fetch(BASE + "/models", {
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
          api: { id: model.id, url: BASE, npm: SDK },
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
