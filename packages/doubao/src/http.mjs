// 共享 HTTP 常量、请求头构造与出网安全防护。零依赖：全局 fetch / node 内置模块。
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/148.0.0.0 Safari/537.36";

export const BASE_URL = "https://www.doubao.com";

/** 把一个账号的凭证合成为 Cookie 头。sessionid 必需；msToken 留空最安全（假值触发 710022002）。 */
export function cookieHeader(account) {
  const parts = [`sessionid=${account.sessionid}`];
  if (account.ttwid) parts.push(`ttwid=${account.ttwid}`);
  if (account.passport_csrf_token) parts.push(`passport_csrf_token=${account.passport_csrf_token}`);
  return parts.join("; ");
}

/** 基础请求头。extra 里的同名键会覆盖默认值。 */
export function baseHeaders(account, extra = {}) {
  return {
    "User-Agent": USER_AGENT,
    Cookie: cookieHeader(account),
    "x-tt-passport-csrf-token": account.passport_csrf_token || "",
    Origin: BASE_URL,
    Referer: `${BASE_URL}/chat`,
    ...extra,
  };
}

export const SSE_HEADERS = {
  Accept: "text/event-stream",
  "Content-Type": "application/json",
  "Agw-Js-Conv": "str",
};

/** 错误类型：带给 Agent 的可读提示。 */
export class DoubaoError extends Error {
  constructor(message, hint = "") {
    super(message);
    this.name = "DoubaoError";
    this.hint = hint;
  }
}

/** 登录态失效 —— 调用方应当换下一个账号重试。 */
export class DoubaoAuthError extends DoubaoError {}
/** IP/账号风控 —— 换账号没用，直接报给用户。 */
export class DoubaoRiskError extends DoubaoError {}

export const RISK_CODES = new Set([710022002, 710022004]);
export const AUTH_CODES = new Set([710012001, 710012002, 710012003]);

export function riskHint() {
  return "触发了豆包风控。请稍后再试，或在浏览器里打开 doubao.com 自行完成一次人机验证后再用。";
}

// ————————————————— 出网防护：仅公网 http(s)，拒绝回环/内网地址 —————————————————

function isPrivateIp(ip) {
  if (isIP(ip) === 4) {
    const o = ip.split(".").map(Number);
    if (o[0] === 0 || o[0] === 10 || o[0] === 127) return true; // 本网络/私网/回环
    if (o[0] === 169 && o[1] === 254) return true; // 链路本地
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // 私网
    if (o[0] === 192 && o[1] === 168) return true; // 私网
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // CGNAT
    return false;
  }
  const low = String(ip).toLowerCase();
  if (low === "::" || low === "::1") return true;
  if (low.startsWith("fe80:") || low.startsWith("fc") || low.startsWith("fd")) return true; // 链路本地/ULA
  const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4 映射地址
  if (mapped) return isPrivateIp(mapped[1]);
  return false;
}

/**
 * 校验一个 URL 允许出网：仅 http(s)、不带凭据、（可选）域名后缀白名单、
 * 解析出的所有 IP 都不是回环/内网地址。返回解析后的 URL 对象。
 */
export async function assertPublicHttpUrl(raw, { allowHosts } = {}) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new DoubaoError(`URL 无效: ${String(raw).slice(0, 100)}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new DoubaoError(`仅允许 http(s) URL: ${u.protocol}//…`);
  }
  if (u.username || u.password) throw new DoubaoError("不允许携带用户名/密码的 URL");
  if (allowHosts?.length) {
    const host = u.hostname.toLowerCase();
    const ok = allowHosts.some((h) => host === h || host.endsWith(`.${h}`));
    if (!ok) throw new DoubaoError(`域名不在允许列表: ${u.hostname}`);
  }
  let addrs;
  if (isIP(u.hostname)) {
    addrs = [u.hostname]; // 字面量 IP，无需解析
  } else {
    try {
      addrs = (await lookup(u.hostname, { all: true, verbatim: true })).map((r) => r.address);
    } catch {
      throw new DoubaoError(`域名解析失败: ${u.hostname}`);
    }
  }
  if (!addrs.length) throw new DoubaoError(`域名没有可用地址: ${u.hostname}`);
  for (const ip of addrs) {
    if (isPrivateIp(ip)) throw new DoubaoError(`拒绝访问内网/回环地址: ${u.hostname} → ${ip}`);
  }
  return u;
}

/** 带 SSRF 防护的 fetch：每一跳重定向都重新校验。其余 init 原样传给 fetch。 */
export async function fetchPublic(url, init = {}, { allowHosts, maxRedirects = 5 } = {}) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicHttpUrl(current, { allowHosts });
    const resp = await fetch(current, { ...init, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const location = resp.headers.get("location");
      if (location) {
        current = new URL(location, current).href;
        continue;
      }
    }
    return resp;
  }
  throw new DoubaoError("重定向次数过多");
}
