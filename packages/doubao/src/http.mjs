// 共享 HTTP 常量与请求头构造。零依赖：只用全局 fetch / node 内置模块。

// 与 doubao2api 抓包真值对齐的桌面客户端指纹常量（公开逆向项目的通用值）。
export const DEVICE_ID = "714003710229497";
export const WEB_ID = "7604137868021548590";
export const FP = "verify_mlcfw5f7_TPq0YmFD_NrsC_4RuQ_BJPg_M5W7i58I7wV0";
export const CHROMIUM_VERSION = "148.0.7816.0";

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

/** 登录态失效 —— 调用方应当轮换下一个账号重试。 */
export class DoubaoAuthError extends DoubaoError {}
/** IP/账号风控 —— 换账号没用，直接报给用户。 */
export class DoubaoRiskError extends DoubaoError {}

export const RISK_CODES = new Set([710022002, 710022004]);
export const AUTH_CODES = new Set([710012001, 710012002, 710012003]);

export function riskHint() {
  return "触发了豆包风控。可等待约 30 分钟冷却、切换网络（手机热点最快）、或在浏览器里打开 doubao.com 手动过一次人机验证。";
}
