/**
 * 国际版网页 OAuth —— 完整本地实现，不依赖 workbuddy2api / opencodex 面板。
 *
 * 宿主协议形态：authorize(inputs) 启动本地临时 HTTP 服务器（127.0.0.1 上
 * 官方 TokenServer 端口池之一），立即返回 { url: 本地引导页, method: "auto", callback }；
 * 浏览器全流程在本地页完成：
 *
 *   引导页(内嵌) ──拉 /captcha-config──▶ 未启用滑块 ──▶ 直接「继续授权」
 *                     │启用
 *                     ▼
 *              加载 AliyunCaptcha SDK(CDN) → 用户拖滑块 → 回执 POST /captcha
 *                     ▼
 *   「继续授权」──POST /open-auth──▶ 插件带回执调上游 {vendor}-oauth-url
 *                     ▼
 *        页面自动跳授权页（Google/z.ai）→ 302 回 /callback?code=…&state=…
 *                     ▼
 *        callback() 里用 code 调 {vendor}-oauth-login 换 token → {type:"success"}
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import * as http from "node:http";
import { spawn } from "node:child_process";

const APP_ID = "100003";
const APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5";
const PRODUCT = "autoclaw";
const CHANNEL = "AutoClaw4";
const CLIENT_VERSION = "1.18.1";
const PLATFORM_TM = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux";
const USER_AGENT = `AutoClaw/${CLIENT_VERSION} (${PLATFORM_TM}-arm64)`;

const GLOBAL_HOST = "https://autoglm-api.autoglm.ai";
const CN_HOST = "https://autoglm-api.zhipuai.cn";

const CHAT_PATH = "/autoclaw-proxy/proxy/autoclaw/v1/chat/completions";
const WALLETS_PATH = `/agent-assetmgr/api/v2/wallets?biz_app_id=${PRODUCT}`;

const OAUTH_EXPIRY_SKEW_MS = 10 * 60 * 1000;
const FALLBACK_EXPIRES_IN_S = 5 * 3600;

/** 模型清单：键 = magpie 里显示的 id；值里的 id = 上游接受的 routeModelId。 */
function autoclawModels() {
  return {
    "zai_auto": { name: "GLM Auto (路由)", id: "zai_auto", limit: { context: 200000, output: 32000 }, reasoning: true, tool_call: true },
    "zai_auto-fast": { name: "GLM Auto Fast", id: "zai_auto-fast", limit: { context: 200000, output: 32000 }, reasoning: true, tool_call: true },
    "zai_glm-5.3-flash": { name: "GLM-5.3 Flash", id: "zai_glm-5.3-flash", limit: { context: 1000000, output: 32000 }, reasoning: true, tool_call: true },
    "zai_glm-5-turbo": { name: "GLM-5 Turbo", id: "zai_glm-5-turbo", limit: { context: 200000, output: 32000 }, reasoning: true, tool_call: true },
    "zaicoding_glm-5.3": { name: "GLM-5.3 Coding", id: "zaicoding_glm-5.3", limit: { context: 1000000, output: 131072 }, reasoning: true, tool_call: true },
    "tdpsk_deepseek-v4-flash-202605": { name: "DeepSeek V4 Flash", id: "tdpsk_deepseek-v4-flash-202605", limit: { context: 1000000, output: 384000 }, reasoning: true, tool_call: true },
    "tdpsk_deepseek-v4-pro-202606": { name: "DeepSeek V4 Pro", id: "tdpsk_deepseek-v4-pro-202606", limit: { context: 1000000, output: 384000 }, reasoning: true, tool_call: true },
  };
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function md5Hex(input) {
  return createHash("md5").update(input).digest("hex");
}

function randomHex(n) {
  return randomBytes(n).toString("hex");
}

/** 64 位十六进制 device_id（官方客户端形态）。 */
function newDeviceId() {
  return randomHex(32);
}

/** 业务签名头（task/wallet/登录/refresh），WAF 要求带客户端 UA。 */
function bizHeaders(accessToken) {
  const ts = String(Math.floor(Date.now() / 1000));
  const h = {
    "Content-Type": "application/json",
    "Accept": "*/*",
    "User-Agent": USER_AGENT,
    "X-Version": CLIENT_VERSION,
    "X-Tm": PLATFORM_TM,
    "X-Product": PRODUCT,
    "X-Auth-Appid": APP_ID,
    "X-Auth-TimeStamp": ts,
    "X-Auth-Sign": md5Hex(`${APP_ID}&${ts}&${APP_KEY}`),
    "X-Trace-Id": randomHex(16),
    "X-Lang": "zh-CN",
    "X-Channel": CHANNEL,
    "Origin": "http://localhost:18432",
    "Referer": "http://localhost:18432/",
  };
  if (accessToken) h["Authorization"] = `Bearer ${accessToken}`;
  return h;
}

function nonEmptyString(v) {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** 剥掉 token 上误带的 "Bearer " 前缀（老凭据/代理回包可能带；7863 侧同样的容错）。 */
function bareToken(v) {
  let t = String(v ?? "").trim();
  while (t.toLowerCase().startsWith("bearer ")) t = t.slice(7).trim();
  return t;
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}

/** 读 JWT payload 字段（不校验签名——只取自己账号的 device_id / exp）。 */
function jwtClaim(token, key) {
  const raw = bareToken(token);
  const part = raw.split(".")[1];
  if (!part) return undefined;
  try {
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json)[key];
  } catch {
    return undefined;
  }
}

/** access token 真实过期时间（epoch ms）。 */
function jwtExpiresAtMs(token) {
  const exp = jwtClaim(token, "exp");
  return typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined;
}

async function callEnvelope(path, { method = "GET", body, base }) {
  let response, text;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: bizHeaders(),
      ...(body !== undefined ? { body } : {}),
    });
    text = await response.text();
  } catch (cause) {
    throw Object.assign(new Error(`AutoClaw request failed: ${cause?.message ?? cause}`), { cause });
  }
  let parsed;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
  if (!parsed || (parsed.code === undefined && response.status >= 400)) {
    throw new Error(`AutoClaw ${path.split("?")[0]} non-envelope response (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
  return { status: response.status, code: parsed.code, msg: parsed.msg, data: parsed.data };
}

/** 验证码必须按数字发送（服务端按类型校验，字符串 → 400001）。 */
function codeValue(code) {
  const s = (code ?? "").trim();
  return /^\d+$/.test(s) ? Number(s) : s;
}

/** token 响应 → magpie 凭据字段（不含 type——由 magpie 按 oauth 方式包装）。 */
function tokenFields(data, fallbackRefresh) {
  const access = bareToken(nonEmptyString(data.access_token));
  if (!access) throw new Error("AutoClaw token response contained no access_token");
  const refresh = bareToken(nonEmptyString(data.refresh_token) ?? fallbackRefresh);
  if (!refresh) throw new Error("AutoClaw token response contained no refresh_token");
  // expires_in 常缺省；JWT exp 才是事实来源（约 24h）。按 5h 记会白跑 refresh（轮换有吊销风险）。
  const jwtExpires = jwtExpiresAtMs(access);
  const expiresInS = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : undefined;
  const expires = jwtExpires !== undefined
    ? jwtExpires - OAUTH_EXPIRY_SKEW_MS
    : Date.now() + (expiresInS ?? FALLBACK_EXPIRES_IN_S) * 1000 - OAUTH_EXPIRY_SKEW_MS;
  return { access, refresh, expires };
}

// ---------------------------------------------------------------------------
// 签到与积分
// ---------------------------------------------------------------------------

async function fetchWallets(accessToken, hosts) {
  for (const host of dedupe(hosts)) {
    let payload;
    try {
      const res = await fetch(host + WALLETS_PATH, {
        method: "GET",
        headers: bizHeaders(accessToken),
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) continue;
      payload = await res.json();
    } catch { continue; }
    if (!payload || payload.code !== 0 || !payload.data) continue;
    return payload.data;
  }
  return null;
}

/** 每日签到（幂等）。返回解析后的结果（可能为 null）。 */
async function dailySignin(accessToken, host) {
  try {
    const res = await fetch(`${host}/autoclaw-proxy/proxy/autoclaw-task-complete`, {
      method: "POST",
      headers: bizHeaders(accessToken),
      body: JSON.stringify({ task_id: "daily_signin", source_id: PRODUCT }),
      signal: AbortSignal.timeout(15_000),
    });
    const env = await res.json().catch(() => null);
    return env?.data ?? null; // { success, already_completed, reward_points, continuous_days }
  } catch {
    return null;
  }
}

/** 查任务列表；401/403 throw（登录失效），HTTP 其他失败/非 envelope 返回 null，网络错误 throw。 */
async function taskList(accessToken, host) {
  const res = await fetch(`${host}/autoclaw-proxy/proxy/autoclaw-task-list`, {
    method: "GET",
    headers: bizHeaders(accessToken),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`登录已失效（HTTP ${res.status}）`);
  }
  if (!res.ok) return null;
  const env = await res.json().catch(() => null);
  return Array.isArray(env?.data) ? env.data : null;
}

/** 查询 daily_signin 任务状态（容错版：任何失败返回 null）。 */
async function signinStatus(accessToken, host) {
  try {
    const tasks = await taskList(accessToken, host);
    if (!tasks) return null;
    const t = tasks.find((x) => x?.task_id === "daily_signin");
    return t ? { status: String(t.status ?? ""), desc: String(t.status_description ?? ""), reward: Number(t.reward_points ?? 0) } : null;
  } catch {
    return null;
  }
}

/** 可选数字：>0 才返回，否则 undefined（checkin 的 credit/streak 允许缺省）。 */
function optNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** dailySignin 结果 → magpie 原生 checkin outcome（{outcome, credit?, streak?, message?}）。 */
function checkinOutcome(r) {
  if (!r) return { outcome: "failed", message: "签到接口无响应" };
  if (r.success) {
    return {
      outcome: "claimed",
      credit: optNumber(r.reward_points),
      streak: optNumber(r.continuous_days),
      message: `已签到${r.reward_points ? ` +${r.reward_points}` : ""}${r.continuous_days ? ` · 连续 ${r.continuous_days} 天` : ""}`,
    };
  }
  if (r.already_completed) return { outcome: "done", credit: optNumber(r.reward_points) };
  return { outcome: "failed", message: String(r.message ?? r.msg ?? "签到失败") };
}

/** 本地去重键（成功才记；按小时允许重试）。 */
const signinTriedLocal = new Map(); // key → hour-stamp of last SUCCESSFUL signin

/**
 * 签到配置合并：插件 options（plugins.json 的 options 字段）优先，
 * 其次配置文件 ~/.config/magpie/autoclaw.json（热读取，GUI 没有选项入口时的保底通道）：
 *   { "signin": true, "signinHour": null, "signinOnUsage": false }
 * 两处都没有 → signin=true、signinOnUsage=false（自动补签默认关：
 * 签到交给 magpie 原生 checkin 开关；旧版宿主/需要旧行为时显式开 signinOnUsage）。
 */
function signinConfig(options) {
  let fileCfg = {};
  try {
    // magpie 配置目录固定（文档：~/.config/magpie 或 $XDG_CONFIG_HOME/magpie）
    const cfgDir = process.env.XDG_CONFIG_HOME
      ? `${process.env.XDG_CONFIG_HOME}/magpie`
      : `${process.env.HOME ?? ""}/.config/magpie`;
    fileCfg = JSON.parse(readFileSync(`${cfgDir}/autoclaw.json`, "utf8"));
  } catch { /* 无文件/解析失败 → 用默认 */ }
  const merged = { ...fileCfg, ...(options ?? {}) };
  return {
    signin: merged.signin !== false,               // 自动补签总开关（默认开）
    signinOnUsage: merged.signinOnUsage === true,  // usage/refresh 链路自动补签（默认关，见上）
    signinHour: typeof merged.signinHour === "number" ? merged.signinHour : null,
  };
}

/** 依据合并配置决定是否补签（usage/refresh 旧链路；原生 checkin 不经过这里）。 */
async function maybeSignin(accessToken, host, options, reason, accountKey) {
  void reason;
  const cfg = signinConfig(options);
  if (!cfg.signin || !cfg.signinOnUsage) return;
  if (cfg.signinHour !== null && new Date().getHours() !== cfg.signinHour) return;
  const hourStamp = `${new Date().toISOString().slice(0, 13)}`; // YYYY-MM-DDTHH（每小时可重试一次）
  const dayKey = `${accountKey ?? "x"}`;
  const lastOk = signinTriedLocal.get(dayKey);
  if (typeof lastOk === "string" && lastOk.slice(0, 10) === hourStamp.slice(0, 10)) return; // 今天已成功
  const r = await dailySignin(accessToken, host);
  if (r && (r.success || r.already_completed)) {
    signinTriedLocal.set(dayKey, hourStamp);
  }
}

// ---------------------------------------------------------------------------
// 用户资料（GUI 账户命名：昵称/手机号，替代无意义的 uid 哈希 → 「已登录」）
// ---------------------------------------------------------------------------

/** POST /userapi/v1/user-profile → { user_name, user_phone, user_id, … }；失败返回 null。 */
async function fetchUserProfile(accessToken, base) {
  try {
    const res = await fetch(`${base}/userapi/v1/user-profile`, {
      method: "POST",
      headers: bizHeaders(accessToken),
      body: JSON.stringify({ source_id: PRODUCT, device_id: "magpie-plugin" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const env = await res.json().catch(() => null);
    const d = env?.data;
    if (!d || typeof d !== "object") return null;
    return {
      userId: nonEmptyString(d.user_id),
      name: nonEmptyString(d.user_name),
      phone: nonEmptyString(d.user_phone),
    };
  } catch {
    return null;
  }
}

/** GUI 显示名：昵称 > 手机号 > uid（workbuddy 社区插件同款优先级 nickname/phone/uid）。 */
function accountDisplayName(profile, fallback) {
  if (!profile) return fallback;
  return profile.name ?? profile.phone ?? profile.userId ?? fallback;
}

// ---------------------------------------------------------------------------
// 刷新（refresh token 轮换；host 必须与账号来源匹配）
// ---------------------------------------------------------------------------

async function refreshTokens(refreshToken, preferredHosts) {
  const deviceId = nonEmptyString(jwtClaim(refreshToken, "device_id")) ?? "";
  const body = JSON.stringify({ source_id: PRODUCT, device_id: deviceId, refresh_token: refreshToken });
  const isSmsAccount = /^agent/i.test(String(jwtClaim(refreshToken, "source_id") ?? ""));
  const ordered = isSmsAccount
    ? [CN_HOST, GLOBAL_HOST, ...preferredHosts]
    : [GLOBAL_HOST, CN_HOST, ...preferredHosts];

  let result = null;
  for (const base of dedupe(ordered)) {
    result = await callEnvelope("/userapi/v1/refresh", { method: "POST", body, base });
    if (result.code !== 0 && result.code === 400002) {
      result = await callEnvelope("/userapi/v1/agent-refresh", { method: "POST", body, base });
    }
    if (result.code !== 400000) break;
  }
  if (!result) throw new Error("AutoClaw refresh: no host attempted");
  if (result.code !== 0 || !result.data) {
    const dead = result.status === 401 || result.status === 403
      || /invalid[_ ]?grant|revoked|expired|登录已失效|token 失效/i.test(String(result.msg ?? ""));
    const err = new Error(`AutoClaw token refresh failed (HTTP ${result.status}): ${result.msg ?? `code ${result.code}`}`);
    if (dead) err.signIn = "expired";
    throw err;
  }
  return tokenFields(result.data, refreshToken);
}

// ---------------------------------------------------------------------------
// 插件工厂
// ---------------------------------------------------------------------------

function makeAutoclawPlugin({ providerId, providerName, homeHost, loginMethod }) {
  return async ({ client }, options) => ({
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider[providerId] ??= {
        name: providerName,
        npm: "@ai-sdk/openai-compatible",
        api: homeHost,
        models: autoclawModels(),
      };
    },

    auth: {
      provider: providerId,
      methods: [loginMethod],

      async refresh(auth) {
        const t = await refreshTokens(bareToken(auth.refresh), [homeHost]);
        await maybeSignin(t.access, homeHost, options, "refresh", providerId);
        // 存量账号就地正名：登录响应缺昵称的旧账号（GUI 显示「已登录」），
        // 刷新时补拉 user-profile。magpie 的 refresh 返回字段会合并进账号。
        const old = String(auth.accountId ?? auth.email ?? "");
        if (!old || /^(已登录|[0-9a-f]{24,})$/.test(old)) {
          const profile = await fetchUserProfile(t.access, homeHost);
          const name = accountDisplayName(profile, "");
          if (name) {
            t.accountId = name;
            t.email = name;
          }
        }
        return t;
      },

      async loader(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== "oauth" || !auth.access) return {};
        const accessToken = bareToken(auth.access);
        const hosts = providerId === "autoclaw-cn" ? [CN_HOST, GLOBAL_HOST] : [GLOBAL_HOST, CN_HOST];

        return {
          baseURL: homeHost,
          async fetch(input, init) {
            const headers = new Headers(init?.headers);
            headers.set("X-Authorization", `Bearer ${accessToken}`);
            headers.set("X-Client-Type", "pc");
            headers.set("X-Product", PRODUCT);
            headers.set("X-Harness-Type", "zcode");
            headers.set("X-Tm", PLATFORM_TM);
            headers.set("X-Version", CLIENT_VERSION);
            headers.set("X-Lang", "zh-CN");
            headers.set("X-Channel", CHANNEL);
            headers.set("x_trace_id", "autoclaw-desktop");
            headers.delete("Authorization");

            let routeModel = "";
            try {
              const body = JSON.parse(String(init?.body ?? "{}"));
              routeModel = String(body.model ?? "");
            } catch { /* 保持空 */ }
            if (routeModel) headers.set("X-Request-Model", routeModel);
            headers.set("X-Request-Id", randomHex(16));

            const tryFetch = (host) =>
              fetch(`${host}${CHAT_PATH}`, { ...init, headers, signal: init?.signal });

            const res1 = await tryFetch(hosts[0]);
            if (res1.status !== 401 && res1.status !== 403) return res1;
            const res2 = await tryFetch(hosts[1]);
            if (res2.status === 401 || res2.status === 403) {
              try { res2.body?.cancel?.(); } catch {}
              return new Response(JSON.stringify({ error: { message: "AutoClaw 登录已失效（两个 host 均拒绝该 token）", type: "invalid_request_error" } }), {
                status: 401,
                headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": "expired" },
              });
            }
            return res2;
          },
        };
      },

      async usage(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== "oauth" || !auth.access) return { error: "未登录", windows: [] };
        const hosts = providerId === "autoclaw-cn" ? [CN_HOST, GLOBAL_HOST] : [GLOBAL_HOST, CN_HOST];
        const token = bareToken(auth.access);
        const cfg = signinConfig(options);
        try {
          const [data, signin] = await Promise.all([
            fetchWallets(token, hosts),
            signinStatus(token, hosts[0]).then((s) => s ?? signinStatus(token, hosts[1] ?? hosts[0])),
          ]);
          // 旧链路自动补签（默认关，需 signinOnUsage=true）：查额度即触发。
          // 放在状态查询之后：未签才补，补完重查一次状态展示。
          if (signin && signin.status !== "completed" && (cfg.signin && cfg.signinOnUsage)) {
            await maybeSignin(token, hosts[0], options, "usage", providerId);
          }
          const signinFinal = signin?.status === "completed"
            ? signin
            : (await signinStatus(token, hosts[0]).then((s) => s ?? signinStatus(token, hosts[1] ?? hosts[0])) ?? signin);
          if (!data) return { error: "积分接口无数据（token 可能不属于该 host）", windows: [] };
          const total = Number(data.total_balance);
          if (!Number.isFinite(total)) return { error: "积分响应异常", windows: [] };

          const rows = Array.isArray(data.wallets) ? data.wallets : [];
          const named = rows
            .filter((r) => r.display !== false && Number(r.balance) > 0)
            .map((r) => ({ name: String(r.display_name ?? r.public_wallet_type ?? "积分"), balance: Number(r.balance) }))
            .filter((w) => Math.round(w.balance) !== Math.round(total))
            .slice(0, 3);

          // 签到窗口行 = 状态展示（开关指示交给 magpie 原生 checkin 的 Settings 开关）
          const signinWindow = signinFinal
            ? [{
                name: "每日签到",
                used: signinFinal.status === "completed" ? 0 : 1,
                display: signinFinal.status === "completed"
                  ? `今日已签 ✓${signinFinal.reward ? ` +${signinFinal.reward}` : ""}`
                  : `今日未签（+${signinFinal.reward || 400}）`,
                aside: true,
              }]
            : [];

          return {
            balance: `${Math.round(total)} 积分`,
            windows: [
              { name: "积分余额", used: 0, display: `${Math.round(total)} 积分`, aside: true },
              ...signinWindow,
              ...named.map((w) => ({ name: w.name, used: 0, display: `${Math.round(w.balance)}`, aside: true })),
            ],
          };
        } catch (e) {
          return { error: `积分查询失败: ${e?.message ?? e}`, windows: [] };
        }
      },

      /**
       * 原生每日签到钩子（magpie ≥ v0.1.1083）。由宿主调度：Settings → Usage → Plugins
       * 的 Daily check-in 开关（默认关）控制；每天每账号一次，结果上 Usage 卡片。
       * 契约：返回 {outcome, credit?, streak?, message?}；throw → failed（30 分钟后重试）。
       */
      async checkin(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== "oauth" || !auth.access) throw new Error("未登录");
        const token = bareToken(auth.access);
        const hosts = providerId === "autoclaw-cn" ? [CN_HOST, GLOBAL_HOST] : [GLOBAL_HOST, CN_HOST];

        // 先查任务状态：区分「无签到活动」（inactive）与「查询失败」（throw → failed 重试）
        let task = null;
        let lastErr = null;
        for (const h of hosts) {
          try {
            const tasks = await taskList(token, h);
            if (tasks) {
              task = tasks.find((x) => x?.task_id === "daily_signin") ?? null;
              break;
            }
          } catch (e) { lastErr = e; }
        }
        if (!task && lastErr) throw lastErr;
        if (!task) return { outcome: "inactive", message: "当前没有签到活动" };
        if (String(task.status ?? "") === "completed") {
          return { outcome: "done", credit: optNumber(task.reward_points) };
        }

        // 补签：主 host 优先，无响应再试备用 host（服务端幂等）
        const r = await dailySignin(token, hosts[0]).catch(() => null)
          ?? await dailySignin(token, hosts[1] ?? hosts[0]).catch(() => null);
        return checkinOutcome(r);
      },
    },

    provider: {
      id: providerId,
      async models(provider) {
        return provider.models;
      },
    },
  });
}

// ---------------------------------------------------------------------------
// 登录方式：国内手机验证码
// ---------------------------------------------------------------------------

const phoneSmsMethod = {
  type: "oauth",
  label: "AutoClaw 手机验证码登录（国内）",
  async authorize(inputs) {
    const phone = String(inputs?.phone ?? "").trim();
    // authorize 失败必须 throw（返回 {type:"failed"} 会被宿主当 "auto" 分支无参调 callback()）。
    if (!/^1\d{10}$/.test(phone)) {
      throw new Error("请输入 11 位手机号（不带 +86）");
    }
    const deviceId = newDeviceId();
    const send = await callEnvelope("/userapi/v1/agent-send-code", {
      method: "POST",
      body: JSON.stringify({ source_id: PRODUCT, device_id: deviceId, phone }),
      base: CN_HOST,
    });
    if (send.code !== 0) {
      throw new Error(`发送验证码失败: ${send.msg ?? `code ${send.code}`}`);
    }
    return {
      url: "",
      instructions: `验证码已发送到 ${phone.slice(0, 3)}****${phone.slice(-4)} 的短信，请输入收到的验证码。`,
      method: "code",
      async callback(code) {
        const res = await callEnvelope("/userapi/v1/agent-login/", {
          method: "POST",
          body: JSON.stringify({ source_id: PRODUCT, device_id: deviceId, phone, code: codeValue(code) }),
          base: CN_HOST,
        });
        if (res.code !== 0 || !res.data?.access_token) {
          return { type: "failed", error: `登录失败: ${res.msg ?? `code ${res.code}`}` };
        }
        const t = tokenFields(res.data);
        // GUI 显示名：拉 user-profile 取昵称/手机号（登录响应的 user_name 常为空 → 显示「已登录」）
        const profile = await fetchUserProfile(t.access, CN_HOST);
        const displayName = accountDisplayName(profile, phone);
        return {
          type: "success",
          ...t,
          accountId: displayName,
          email: displayName,
          uid: nonEmptyString(res.data.user_id) ?? undefined,
        };
      },
    };
  },
  prompts: [
    { type: "text", key: "phone", message: "手机号（11 位，不带 +86）", placeholder: "13800138000",
      validate: (v) => (/^1\d{10}$/.test(String(v ?? "").trim()) ? undefined : "11 位手机号") },
  ],
};

// ---------------------------------------------------------------------------
// 登录方式：国际网页 OAuth（本地完整实现：滑块 + 授权 + 回调捕获）
// ---------------------------------------------------------------------------

const overseaOAuthMethod = {
  type: "oauth",
  label: "AutoClaw 网页登录（Google / z.ai）",
  async authorize(inputs) {
    const vendor = inputs?.vendor === "zai" ? "zai" : "google";
    return await startLocalOAuth(vendor);
  },
  prompts: [
    { type: "select", key: "vendor", message: "登录方式",
      options: [
        { label: "Google 账号", value: "google" },
        { label: "z.ai 账号", value: "zai" },
      ] },
  ],
};

/**
 * 启动本地 OAuth：立即返回 {url, method:"auto", callback}。
 * url = 本地引导页（滑块在内完成，之后自动跳授权页）；callback 挂起等 code，
 * 拿到后直连上游换 token。
 */
async function startLocalOAuth(vendor) {
  const deviceId = newDeviceId();
  const state = {
    captchaReceipt: null,
    oauthCode: null,
    oauthState: "",
    error: null,
  };
  const waiters = [];
  const notify = () => { while (waiters.length) waiters.shift()(); };
  const waitFor = (timeoutMs, what) => new Promise((resolve, reject) => {
    const check = () => {
      if (state.error) { cleanup(); reject(new Error(state.error)); return true; }
      if (state.oauthCode) { cleanup(); resolve(state.oauthCode); return true; }
      return false;
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`${what} 等待超时（${Math.round(timeoutMs / 60000)} 分钟）— 请重试登录`)); }, timeoutMs);
    const w = () => { check(); };
    const cleanup = () => { clearTimeout(timer); const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); };
    waiters.push(w);
    check();
  });

  // 官方 TokenServer 端口池（OAuth client 注册的回调白名单端口）。
  // 18432 被占（如官方客户端在跑）时依次尝试其余。
  const FIXED_PORTS = [18432, 19654, 19723, 53699];

  // 先行探测可用端口（listen → 记下 → 关闭，真正 listen 在 callback 里）
  let fixedPort = 0;
  const probe = http.createServer();
  for (const p of FIXED_PORTS) {
    const ok = await new Promise((resolve) => {
      probe.once("error", () => resolve(false));
      probe.listen(p, "127.0.0.1", () => { probe.close(() => resolve(true)); });
    });
    if (ok) { fixedPort = p; break; }
  }
  if (!fixedPort) {
    throw new Error(`本地端口 ${FIXED_PORTS.join("/")} 均被占用——OAuth 回调需要其中之一（官方 client 白名单端口）。请关闭占用进程（可能是 AutoClaw 桌面端或其 TokenServer）后重试。`);
  }

  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address()?.port ?? 0}`;
    let url;
    try { url = new URL(req.url, base); } catch { res.writeHead(400); res.end(); return; }
    const send = (status, type, body, extra = {}) => {
      res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...extra });
      res.end(body);
    };
    // 写接口仅接受本机来源：浏览器同源 fetch 一定带 Origin（127.0.0.1/localhost）；
    // curl 等非浏览器客户端无 Origin，放行。防其他网页跨源 POST /abort 干扰登录。
    const localOrigin = (req) => {
      const o = req.headers.origin;
      return !o || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(o));
    };
    if (["/captcha", "/open-auth", "/abort"].includes(url.pathname) && !localOrigin(req)) {
      send(403, "application/json", JSON.stringify({ error: "forbidden origin" }));
      return;
    }

    if (req.method === "OPTIONS") {
      send(204, "text/plain", "", { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" });
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      send(200, "text/html; charset=utf-8", guidePageHtml(vendor));
      return;
    }

    if (url.pathname === "/captcha-config") {
      callEnvelope("/userapi/overseasv1/oauth-captcha-config", { method: "POST", body: "{}", base: GLOBAL_HOST })
        .then((r) => send(200, "application/json", JSON.stringify(r.data ?? { enabled: false })))
        .catch(() => send(502, "application/json", JSON.stringify({ enabled: false, error: "config fetch failed" })));
      return;
    }

    const readBody = () => new Promise((resolve) => {
      let b = "";
      req.on("data", (c) => { b += c; });
      req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
    });

    if (url.pathname === "/captcha" && req.method === "POST") {
      readBody().then((j) => {
        // 阿里 SDK 把回执作为 captchaVerifyCallback 首参本身（JSON 字符串），
        // 兜底 captchaVerifyParam 字段两种形态。
        const receipt = typeof j.receipt === "string" ? j.receipt
          : typeof j.captchaVerifyParam === "string" ? j.captchaVerifyParam : "";
        state.captchaReceipt = receipt.trim();
        send(200, "application/json", JSON.stringify({ ok: !!state.captchaReceipt }), { "Access-Control-Allow-Origin": "*" });
      });
      return;
    }

    if (url.pathname === "/open-auth" && req.method === "POST") {
      (async () => {
        // ⚠️ redirect_uri 必须是官方 client 注册过的白名单形态：
        // http://localhost:<port>/auth/callback-<vendor>（host=localhost、固定路径、
        // 端口为官方 TokenServer 端口池之一），随机端口/自定路径会被
        // {"detail":"Redirect URI not registered for this client"} 拒绝。
        const redirectUri = `http://localhost:${fixedPort}/auth/callback-${vendor}`;
        const bodyObj = { source_id: PRODUCT, device_id: deviceId, navigate_uri: redirectUri };
        if (state.captchaReceipt) bodyObj.ali_captcha_verify_param = state.captchaReceipt;
        const r = await callEnvelope(`/userapi/overseasv1/${vendor}-oauth-url`, {
          method: "POST", body: JSON.stringify(bodyObj), base: GLOBAL_HOST,
        });
        if (r.code !== 0 || !r.data) {
          send(200, "application/json", JSON.stringify({ error: `获取授权页失败: ${r.msg ?? `code ${r.code}`}` }));
          return;
        }
        const authorizeUrl = String(r.data.oauth_url ?? r.data.url ?? r.data.login_url ?? r.data.auth_url ?? r.data.verify_url ?? "");
        if (!authorizeUrl) {
          send(200, "application/json", JSON.stringify({ error: "上游未返回授权页地址" }));
          return;
        }
        send(200, "application/json", JSON.stringify({ url: authorizeUrl }));
      })().catch((e) => send(200, "application/json", JSON.stringify({ error: `获取授权页失败: ${e?.message ?? e}` })));
      return;
    }

    // 官方注册的回调路径：/auth/callback-<vendor>（另有旧 /callback 兜底）
    if (url.pathname === `/auth/callback-${vendor}` || url.pathname === "/callback") {
      state.oauthCode = url.searchParams.get("code");
      state.oauthState = url.searchParams.get("state") ?? "";
      if (!state.oauthCode) state.error = "回调缺少 code 参数";
      notify();
      send(200, "text/html; charset=utf-8", callbackPageHtml(!!state.oauthCode));
      return;
    }

    if (url.pathname === "/abort" && req.method === "POST") {
      readBody().then((j) => {
        state.error = String(j.reason ?? "用户取消");
        notify();
        send(200, "application/json", JSON.stringify({ ok: true }));
      });
      return;
    }

    send(404, "text/plain", "not found");
  });

  const serverReady = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(fixedPort, "127.0.0.1", () => resolve(fixedPort));
  });

  return {
    url: "", // 由 callback 里自行开浏览器（本地引导页），宿主不重复打开
    instructions: `已打开本地引导页（未自动打开时手动访问 http://127.0.0.1:${fixedPort}/ ）：请完成滑块验证并登录授权，完成后自动返回 magpie。`,
    method: "auto",
    async callback() {
      const port = await serverReady;
      const guide = `http://127.0.0.1:${port}/`;
      const redirectUri = `http://localhost:${port}/auth/callback-${vendor}`;
      try {
        openBrowser(guide);
        const code = await waitFor(5 * 60 * 1000, "浏览器登录");
        const res = await callEnvelope(`/userapi/overseasv1/${vendor}-oauth-login`, {
          method: "POST",
          body: JSON.stringify({ source_id: PRODUCT, device_id: deviceId, code, state: state.oauthState, navigate_uri: redirectUri }),
          base: GLOBAL_HOST,
        });
        if (res.code !== 0 || !res.data?.access_token) {
          return { type: "failed", error: `登录失败: ${res.msg ?? `code ${res.code}`}` };
        }
        const t = tokenFields(res.data);
        // GUI 显示名：拉 user-profile 取昵称（Google/z.ai 账号通常有昵称或邮箱）
        const profile = await fetchUserProfile(t.access, GLOBAL_HOST);
        const displayName = accountDisplayName(profile, `${vendor} 账号`);
        return {
          type: "success",
          ...t,
          accountId: displayName,
          email: displayName,
          uid: nonEmptyString(res.data.user_id) ?? undefined,
        };
      } finally {
        server.close();
      }
    },
  };
}

/** 跨平台打开浏览器（node:child_process，Bun / Node 宿主均可；失败时用户可手动打开 instructions 里的地址）。 */
function openBrowser(urlStr) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    // Windows 的 start 是 cmd 内建命令，必须走 shell。
    const child = process.platform === "win32"
      ? spawn(cmd, [urlStr], { shell: true, stdio: "ignore", detached: true })
      : spawn(cmd, [urlStr], { stdio: "ignore", detached: true });
    child.on("error", () => { /* 打开失败静默：instructions 已给出可手动访问的地址 */ });
    child.unref();
  } catch { /* 同上 */ }
}

/** 引导页：滑块（如启用）→ 继续授权 → 自动跳授权页。 */
function guidePageHtml(vendor) {
  const vendorName = vendor === "zai" ? "z.ai" : "Google";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>AutoClaw ${vendorName} 登录</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:#f5f6fa;display:flex;justify-content:center;padding:40px 16px;margin:0}
 .card{background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);max-width:460px;width:100%;padding:32px}
 h1{font-size:20px;margin:0 0 8px}
 p.sub{color:#666;font-size:14px;margin:0 0 20px}
 .step{font-size:14px;color:#333;margin:10px 0;display:flex;gap:8px;align-items:flex-start}
 .step .n{background:#4f6ef7;color:#fff;border-radius:50%;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;flex:none}
 #captchaBox{margin:16px 0;padding:16px;border:1px dashed #ccc;border-radius:10px;display:none}
 #captchaEle{min-height:44px}
 button.primary{background:#4f6ef7;color:#fff;border:none;border-radius:10px;padding:12px 22px;font-size:15px;cursor:pointer;width:100%;margin-top:16px}
 button.primary:disabled{background:#b9c0f4;cursor:not-allowed}
 .msg{font-size:13px;margin-top:10px;min-height:18px}
 .msg.ok{color:#1a9c5b}.msg.err{color:#d43c3c}.msg.warn{color:#c98a00}
 #done{display:none;text-align:center;padding:20px 0}
 .spin{display:inline-block;width:28px;height:28px;border:3px solid #e3e6f7;border-top-color:#4f6ef7;border-radius:50%;animation:r 0.8s linear infinite;margin-bottom:10px}
 @keyframes r{to{transform:rotate(360deg)}}
</style></head><body>
<div class="card">
 <h1>AutoClaw · ${vendorName} 登录</h1>
 <p class="sub">本页面由 magpie 插件本地生成，关闭本页即取消登录。</p>
 <div id="steps">
  <div class="step"><span class="n">1</span><span id="stepCaptcha">检查安全验证…</span></div>
  <div id="captchaBox"><div id="captchaEle"></div></div>
  <div class="step"><span class="n">2</span><span>跳转 ${vendorName} 授权页完成登录</span></div>
 </div>
 <button class="primary" id="goBtn" disabled>继续授权</button>
 <div class="msg" id="msg"></div>
 <div id="done"><div class="spin"></div><div>已完成授权，正在返回 magpie…</div></div>
</div>
<script>
const HIDDEN_TRIGGER_ID="__acHiddenTrigger";
(function ensureHiddenTrigger(){
  let b=document.getElementById(HIDDEN_TRIGGER_ID);
  if(!b){b=document.createElement("button");b.id=HIDDEN_TRIGGER_ID;b.type="button";b.tabIndex=-1;
    b.setAttribute("aria-hidden","true");b.style.cssText="position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden";
    document.body.appendChild(b);}
})();
function msg(m,cls){const e=document.getElementById("msg");e.textContent=m;e.className="msg "+(cls||"");}
async function boot(){
  let cfg={enabled:false};
  try{
    const r=await fetch("/captcha-config");cfg=await r.json();
  }catch(e){}
  if(cfg&&cfg.enabled){
    document.getElementById("stepCaptcha").textContent="请点击下方按钮完成安全验证";
    const box=document.getElementById("captchaBox");box.style.display="block";
    window.__acRegion=cfg.region||"ga";window.__acPrefix=cfg.prefix||"sq51tr";
    window.AliyunCaptchaConfig=window.AliyunCaptchaConfig||{region:window.__acRegion,prefix:window.__acPrefix};
    msg("正在加载安全验证组件…","warn");
    await loadCaptchaLib();
    if(!window.initAliyunCaptcha){
      msg("验证组件加载失败（网络/广告拦截），请刷新重试","err");return;
    }
    // ⚠️ 官方流程：init → warmup ≥2.1s → 程序化 click 隐藏按钮 → 组件弹出验证窗。
    // click 太快组件未就绪 → 弹出空白框（实测踩坑）。等待 2.3s。
    window.initAliyunCaptcha({
      SceneId:cfg.scene_id,mode:"popup",element:"#captchaEle",button:"#"+HIDDEN_TRIGGER_ID,
        captchaVerifyCallback:(params)=>{
          const receipt=typeof params==="string"?params:(params&&typeof params.captchaVerifyParam==="string"?params.captchaVerifyParam:JSON.stringify(params||{}));
          fetch("/captcha",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({receipt})})
            .then(()=>{window.__acReceiptSent=true;}).catch(()=>{window.__acReceiptSent=true;});
          return {captchaResult:true};
        },
      onBizResultCallback:()=>{},getInstance:()=>{},
      slideStyle:{width:320,height:40},language:"cn",
      onError:(err)=>{msg("安全验证出错: "+((err&&err.message)||"")+"，请点击重试","err");}
    });
    msg("验证组件已就绪，正在弹出验证窗…","warn");
    setTimeout(()=>{document.getElementById("__acHiddenTrigger").click();},2300);
    // 轮询等回执上报完成（回执 POST /captcha 在 captchaVerifyCallback 里异步发）
    const t0=Date.now();
    await (function pollReceipt(){
      if(window.__acReceiptSent||Date.now()-t0>180000)return;
      return new Promise(r=>setTimeout(r,500)).then(pollReceipt);
    })();
    window.__acReceiptSent=false;
    msg("滑块验证通过 ✓","ok");
  }else{
    document.getElementById("stepCaptcha").textContent="无需安全验证 ✓";
  }
  const btn=document.getElementById("goBtn");btn.disabled=false;btn.textContent="继续授权";
}
function loadCaptchaLib(){
  return new Promise((resolve)=>{
    if(window.initAliyunCaptcha){resolve();return;}
    const s=document.createElement("script");
    s.src="https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
    s.async=true;s.onload=()=>resolve();s.onerror=()=>resolve();
    document.head.appendChild(s);
    setTimeout(()=>resolve(),10000);
  });
}
document.getElementById("goBtn").addEventListener("click",async()=>{
  const btn=document.getElementById("goBtn");btn.disabled=true;btn.textContent="正在获取授权页…";
  try{
    const r=await fetch("/open-auth",{method:"POST"});
    const j=await r.json();
    if(j.error){msg(j.error,"err");btn.disabled=false;btn.textContent="继续授权";return;}
    document.getElementById("steps").style.display="none";btn.style.display="none";
    document.getElementById("done").style.display="block";
    setTimeout(()=>{location.href=j.url;},600);
  }catch(e){msg("网络错误："+e.message,"err");btn.disabled=false;btn.textContent="继续授权";}
});
window.addEventListener("beforeunload",()=>{
  try{navigator.sendBeacon("/abort",new Blob([JSON.stringify({reason:"页面关闭"})],{type:"application/json"}));}catch(_){}
});
boot().catch((e)=>msg("初始化失败："+e.message,"err"));
</script></body></html>`;
}

/** 授权回调落地页。 */
function callbackPageHtml(ok) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>AutoClaw 登录</title>
<style>body{font-family:-apple-system,"PingFang SC",sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f5f6fa}
.c{background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);padding:40px 48px;text-align:center}
h1{font-size:18px;margin:0 0 8px;color:${ok ? "#1a9c5b" : "#d43c3c"}}</style></head>
<body><div class="c"><h1>${ok ? "✓ 授权成功" : "✗ 授权失败"}</h1>
<p style="color:#666;font-size:14px">${ok ? "正在返回 magpie 完成登录，本页可以关闭。" : "回调缺少 code，请回 magpie 重试。"}</p></div></body></html>`;
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

/** provider "autoclaw"：国际版（z.ai / Google 网页 OAuth，本地完整实现）。 */
export const AutoclawAuthPlugin = makeAutoclawPlugin({
  providerId: "autoclaw",
  providerName: "AutoClaw (Zhipu)",
  homeHost: GLOBAL_HOST,
  loginMethod: overseaOAuthMethod,
});

/** provider "autoclaw-cn"：国内版（手机验证码）。 */
export const AutoclawCnAuthPlugin = makeAutoclawPlugin({
  providerId: "autoclaw-cn",
  providerName: "AutoClaw 国内 (Zhipu)",
  homeHost: CN_HOST,
  loginMethod: phoneSmsMethod,
});

/** 测试辅助（magpie/OpenCode 不会把它当插件调用）。 */
export const _internal = {
  md5Hex, jwtClaim, tokenFields, codeValue, bizHeaders, bareToken, newDeviceId,
  dailySignin, signinStatus, maybeSignin, signinConfig, checkinOutcome, refreshTokens,
  fetchUserProfile, accountDisplayName,
  guidePageHtml, callbackPageHtml,
};
