// u1s1 x magpie 供应商插件
// 接入方式完全对照 u1s1-cli 1.14.5 源码（dist/api.js、device-auth.js、login.js、site.js）：
//   - 聊天走 OpenAI chat/completions（不是 Anthropic /messages）
//   - 中国站 https://api.u1s1app.com/v1，国际站 https://api.u1s1.dev/v1
//   - 设备码登录：start 上传 public_jwk，poll 返回 api_key(u1s1-) + device_token(u1s1d-)
//   - 每个请求：DPoP 签名（本地 P-256 私钥）+ x-u1s1-version/client/platform 头
//   - x-u1s1-attestation 从 /models 响应取，带缓存，缺失时自动补拉（自愈）
// 凭证只存本机 magpie 的 plugin-auth.json，每个用户登录自己的账号，不共享。

const PROVIDER = "u1s1";
const VERSION = "1.14.5"; // 与 u1s1-cli package.json 一致
const SITES = {
  cn: { origin: "https://api.u1s1app.com", api: "https://api.u1s1app.com/v1" },
  intl: { origin: "https://api.u1s1.dev", api: "https://api.u1s1.dev/v1" },
};

// 未登录时的兜底模型列表（登录后由 GET /v1/models 实时替换）
// 值来自网关 GET /v1/models 实测（2026-11-03，美元/百万 Token）
const FALLBACK_MODELS = {
  "deepseek-flash": {
    name: "DeepSeek Flash",
    limit: { context: 1048576, output: 384000 },
    reasoning: true,
    tool_call: true,
    modalities: { input: ["text", "image"] },
    cost: { input: 0.30026052015719523, output: 1.201042080628781, cache_read: 0.020606114128434966 },
  },
  "qwen3.8-flash": {
    name: "Qwen3.8 Flash",
    limit: { context: 1000000, output: 131072 },
    reasoning: true,
    tool_call: true,
    modalities: { input: ["text", "image"] },
    cost: { input: 0.16, output: 0.47, cache_read: 0.016 },
  },
  "glm-5.3-flash": {
    name: "GLM-5.3 Flash",
    limit: { context: 1048576, output: 131072 },
    reasoning: true,
    tool_call: true,
    modalities: { input: ["text", "image"] },
    cost: { input: 0.15, output: 0.5, cache_read: 0.03 },
  },
};

// —— 小工具 ——

function b64url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Buffer.from(bytes).toString("base64url");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function siteOf(auth) {
  return SITES[auth?.site] ?? SITES.cn;
}

// 从网关错误响应体里取出 message 原文（{error:{message}} 或 {message}）
function messageOf(text, fallback) {
  try {
    const j = JSON.parse(text);
    const m = j?.error?.message ?? j?.message;
    if (typeof m === "string" && m) return m.slice(0, 2000);
  } catch {
    /* 非 JSON，用兜底文案 */
  }
  return fallback;
}

// 从保存的登录信息里取出 device_token / api_key（兼容 api 与 oauth 两种存法）
function credsOf(auth) {
  if (!auth) return { deviceToken: undefined, apiKey: undefined };
  return {
    deviceToken: auth.device_token ?? (auth.type === "oauth" ? auth.access : undefined),
    apiKey: auth.api_key ?? auth.key ?? (auth.type === "oauth" ? auth.refresh : undefined),
  };
}

// —— DPoP 签名（对照 device-auth.js dpopHeaders）——

async function dpopHeaders(deviceToken, publicJwk, privateJwk, method, rawUrl) {
  const url = new URL(rawUrl);
  url.search = "";
  url.hash = "";
  const header = b64url(JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk }));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(deviceToken));
  const payload = b64url(
    JSON.stringify({
      jti: crypto.randomUUID().replace(/-/g, ""),
      htm: String(method).toUpperCase(),
      htu: url.toString(),
      iat: Math.floor(Date.now() / 1000),
      ath: b64url(new Uint8Array(digest)),
    }),
  );
  const key = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${header}.${payload}`)),
  );
  return {
    authorization: `DPoP ${deviceToken}`,
    dpop: `${header}.${payload}.${b64url(signature)}`,
  };
}

// —— attestation 缓存（按 device_token 分键，多账号互不串）——

const attestationCache = new Map(); // deviceToken -> { token, expiresAtMs }

async function fetchAttestation(site, deviceToken, publicJwk, privateJwk) {
  try {
    const headers = await baseHeaders(deviceToken, publicJwk, privateJwk, "GET", `${site.api}/models`);
    const res = await fetch(`${site.api}/models`, { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return;
    const body = await res.json();
    const att = body?.client_attestation;
    if (typeof att?.token === "string" && att.token && att.token.length <= 1024) {
      const expiresAtMs =
        typeof att.expires_in === "number" && att.expires_in > 0 ? Date.now() + att.expires_in * 1000 : undefined;
      attestationCache.set(deviceToken, { token: att.token, expiresAtMs });
    }
  } catch {
    /* 拉不到就不带，请求照发（与 CLI 自愈逻辑一致） */
  }
}

async function getAttestation(site, deviceToken, publicJwk, privateJwk) {
  const hit = attestationCache.get(deviceToken);
  const now = Date.now();
  if (hit?.token && (!hit.expiresAtMs || now < hit.expiresAtMs - 24 * 3600 * 1000)) return hit.token;
  await fetchAttestation(site, deviceToken, publicJwk, privateJwk);
  return attestationCache.get(deviceToken)?.token;
}

// —— 统一请求头（对照签名代理 outboundHeaders）——

async function baseHeaders(deviceToken, publicJwk, privateJwk, method, url) {
  const headers = new Headers();
  // 服务端按 User-Agent 识别官方客户端（client integrity 判定依据，必须为 u1s1-cli）
  headers.set("user-agent", "u1s1-cli");
  headers.set("x-u1s1-version", VERSION);
  headers.set("x-u1s1-client", "terminal");
  headers.set("x-u1s1-platform", `${process.platform}-${process.arch}`);
  if (deviceToken && privateJwk && publicJwk) {
    const proof = await dpopHeaders(deviceToken, publicJwk, privateJwk, method, url);
    headers.set("authorization", proof.authorization);
    headers.set("dpop", proof.dpop);
  } else if (deviceToken) {
    // 只有 token 没有密钥对时退化为 Bearer（CLI 的只读兼容路径）
    headers.set("authorization", `Bearer ${deviceToken}`);
  }
  return headers;
}

// 组装一次完整请求头（含 attestation）
async function authedHeaders(auth, method, url) {
  const site = siteOf(auth);
  const { deviceToken, apiKey } = credsOf(auth);
  const headers = await baseHeaders(deviceToken, auth?.public_jwk, auth?.private_jwk, method, url);
  if (!headers.has("authorization") && apiKey) headers.set("authorization", `Bearer ${apiKey}`);
  if (deviceToken && auth?.private_jwk) {
    const att = await getAttestation(site, deviceToken, auth.public_jwk, auth.private_jwk);
    if (att) headers.set("x-u1s1-attestation", att);
  }
  return headers;
}
// —— 设备码登录（对照 login.js startDeviceLogin / pollDeviceLogin）——

async function startDeviceLogin(origin) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  let hostname = "magpie";
  try {
    const os = await import("node:os");
    hostname = os.hostname?.() || hostname;
  } catch {
    /* 拿不到就用默认名 */
  }
  const resp = await fetch(`${origin}/auth/device/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      public_jwk: publicJwk,
      device_name: `${hostname} (magpie)`,
      client_version: VERSION,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (typeof data.verify_url !== "string" || typeof data.poll_secret !== "string" || !data.poll_secret) return null;
  const verifyUrl = new URL(data.verify_url);
  if (!["http:", "https:"].includes(verifyUrl.protocol)) return null;
  const interval = Number.isInteger(data.interval) && data.interval >= 1 && data.interval <= 30 ? data.interval : 2;
  const expiresIn = Number.isInteger(data.expires_in) && data.expires_in >= 1 && data.expires_in <= 1800 ? data.expires_in : 900;
  return { verify_url: verifyUrl.toString(), poll_secret: data.poll_secret, interval, expiresIn, privateJwk, publicJwk };
}

async function pollDeviceLogin(origin, start) {
  const deadline = Date.now() + start.expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(start.interval * 1000);
    try {
      const resp = await fetch(`${origin}/auth/device/poll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ poll_secret: start.poll_secret }),
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) continue;
      const data = await resp.json();
      const apiKey = typeof data.api_key === "string" && data.api_key.startsWith("u1s1-") ? data.api_key : undefined;
      const deviceToken =
        typeof data.device_token === "string" && data.device_token.startsWith("u1s1d-") ? data.device_token : undefined;
      if (data.status === "ok" && apiKey && deviceToken) {
        return {
          apiKey,
          deviceToken,
          deviceId: Number.isSafeInteger(data.device_id) && data.device_id > 0 ? data.device_id : undefined,
        };
      }
      if (data.status === "expired") return null;
    } catch {
      /* 网络抖动，继续轮询 */
    }
  }
  return null;
}

// 登录成功后取账号标识（/me），失败退回 device_id
async function fetchAccountId(site, authLike) {
  try {
    const headers = await authedHeaders(authLike, "GET", `${site.api}/me`);
    const res = await fetch(`${site.api}/me`, { headers, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return undefined;
    const body = await res.json();
    const email = body?.email ?? body?.user?.email ?? body?.account?.email;
    if (typeof email === "string" && email) return email;
  } catch {
    /* 忽略 */
  }
  return authLike.device_id ? `u1s1-${authLike.device_id}` : undefined;
}

// —— 插件主体 ——

export const U1S1Plugin = async () => ({
  // 声明供应商（OpenAI 兼容 → 请求打到 /chat/completions）
  config: async (cfg) => {
    cfg.provider ??= {};
    cfg.provider[PROVIDER] ??= {
      name: "u1s1",
      npm: "@ai-sdk/openai-compatible",
      api: SITES.cn.api,
      models: FALLBACK_MODELS,
    };
  },

  auth: {
    provider: PROVIDER,

    methods: [
      {
        type: "oauth",
        label: "通过浏览器登录 u1s1",
        async authorize() {
          // 中国站优先，连不上自动切国际站（两站账号不通，各自独立登录）
          let siteKey = "cn";
          let start = await startDeviceLogin(SITES.cn.origin).catch(() => null);
          if (!start) {
            siteKey = "intl";
            start = await startDeviceLogin(SITES.intl.origin).catch(() => null);
          }
          if (!start) return { type: "failed", error: "连不上 u1s1 服务器，请检查网络后重试" };
          const site = SITES[siteKey];
          return {
            url: start.verify_url,
            instructions: "在打开的页面登录并点「批准」",
            method: "auto",
            async callback() {
              const got = await pollDeviceLogin(site.origin, start);
              if (!got) return { type: "failed", error: "登录链接已过期，请重试" };
              const probe = {
                site: siteKey,
                device_token: got.deviceToken,
                api_key: got.apiKey,
                device_id: got.deviceId,
                private_jwk: start.privateJwk,
                public_jwk: start.publicJwk,
              };
              const accountId = await fetchAccountId(site, probe);
              return {
                type: "success",
                access: got.deviceToken,
                refresh: got.apiKey,
                accountId,
                ...probe,
              };
            },
          };
        },
      },
    ],

    // 每个请求：DPoP 签名 + u1s1 三件套头 + attestation
    async loader(getAuth) {
      const auth = await getAuth();
      if (!auth) return {};
      const { deviceToken, apiKey } = credsOf(auth);
      if (!deviceToken && !apiKey) return {};
      const site = siteOf(auth);
      return {
        baseURL: site.api,
        async fetch(input, init) {
          const url = input instanceof Request ? input.url : String(input);
          const method = init?.method ?? (input instanceof Request ? input.method : "GET");
          const headers = await authedHeaders(auth, method, url);
          // 保留调用方已有的业务头（content-type 等）
          const incoming = new Headers(init?.headers);
          incoming.forEach((v, k) => {
            if (!headers.has(k)) headers.set(k, v);
          });
          const res = await fetch(input, { ...init, headers });
          // 401 = 凭证失效：带上 Magpie 的重登信号；403 透传服务端原文（重登无用）
          if (res.status === 401) {
            const text = await res.text().catch(() => "");
            const out = new Headers(res.headers);
            out.set("X-Magpie-Sign-In", "expired");
            out.set("content-type", "application/json");
            return new Response(text, { status: res.status, statusText: res.statusText, headers: out });
          }
          return res;
        },
      };
    },
  },

  // 登录后向 u1s1 拉取该账号的真实模型列表
  provider: {
    id: PROVIDER,
    async models(provider, { auth } = {}) {
      if (!auth) return provider.models;
      const { deviceToken, apiKey } = credsOf(auth);
      if (!deviceToken && !apiKey) return provider.models;
      const site = siteOf(auth);
      let res;
      try {
        const headers = await authedHeaders(auth, "GET", `${site.api}/models`);
        res = await fetch(`${site.api}/models`, { headers, signal: AbortSignal.timeout(15000) });
      } catch {
        return provider.models;
      }
      // 401 = 凭证失效（对照 CLI AuthError，引导重登）；
      // 403 = 登录有效但被服务端拒绝（对照 CLI AccessDeniedError，重登无用，透传原文）
      if (res.status === 401) {
        throw Object.assign(new Error("u1s1 登录已失效，请重新登录"), { signIn: "expired" });
      }
      if (res.status === 403) {
        const detail = await res.text().catch(() => "");
        throw new Error(messageOf(detail, "u1s1 账号当前无法使用（服务端拒绝了该客户端）"));
      }
      if (!res.ok) return provider.models;
      let body;
      try {
        body = await res.json();
      } catch {
        return provider.models;
      }
      if (!Array.isArray(body?.data)) return provider.models;
      const base = provider.models;
      const out = {};
      for (const m of body.data) {
        const id = typeof m === "string" ? m : m?.id;
        if (!id) continue;
        const prev = base[id] ?? {};
        // 网关字段：context_length / max_tokens / price{input,output,cache_read} / vision / reasoning
        const ctx = typeof m === "object" ? m.context_length : undefined;
        const maxOut = typeof m === "object" ? m.max_tokens : undefined;
        const price = typeof m === "object" && m.price && typeof m.price === "object" ? m.price : undefined;
        const vision = typeof m === "object" && m.vision === true;
        out[id] = {
          ...prev,
          id,
          name: (typeof m === "object" && (m.name ?? m.display_name)) || prev.name || id,
          limit: prev.limit ?? (ctx
            ? { context: ctx, output: maxOut ?? 64000 }
            : { context: 1048576, output: 64000 }),
          reasoning: prev.reasoning ?? (typeof m === "object" ? m.reasoning ?? true : true),
          tool_call: prev.tool_call ?? true,
          modalities: vision
            ? { input: ["text", "image"] }
            : (prev.modalities ?? { input: ["text"] }),
          cost: price
            ? {
                input: price.input ?? prev.cost?.input,
                output: price.output ?? prev.cost?.output,
                cache_read: price.cache_read ?? prev.cost?.cache_read,
              }
            : prev.cost,
        };
      }
      return Object.keys(out).length ? out : provider.models;
    },
  },
});

// OpenCode 2.x 加载 default 导出；1.x 用 U1S1Plugin 命名导出
export default U1S1Plugin;
