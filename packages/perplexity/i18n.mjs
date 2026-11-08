/**
 * UI strings, zh and en.
 *
 * These land in magpie's sign-in flow, the account card, `magpie quota` and
 * the gateway's error bodies, so they are user-visible, not decoration. The
 * language is the plugin's `locale` option, defaulting to the machine's.
 *
 * @module magpie-perplexity/i18n
 */

/** The languages with a string table here. */
export const LOCALES = ["zh", "en"]

const ZH = {
  locale: "zh",

  methodCookieLabel: "粘贴 Session Cookie",
  cookieMessage: "Perplexity session cookie",
  cookiePlaceholder: "F12 → Application → Cookies → www.perplexity.ai",
  cookieTooShort: "太短了，请贴完整的 session-token 值",
  methodBrowserLabel: "浏览器登录 Perplexity",
  browserInstructions: "请在自动打开的独立 Chrome 窗口里登录 Perplexity；登录后本页会自动完成。",
  browserPageTitle: "登录 Perplexity",
  browserPageWaiting: "等待登录…（在独立 Chrome 窗口里登录）",
  browserPageDone: "✓ 完成，可以关掉这个页面了",
  browserPageStarting: "正在启动浏览器…",
  browserPageCookieNote: "Cookie 只通过本机 DevTools 协议读取，不会离开这台机器。",
  browserPageFallback: "备选：F12 → Application → Cookies → 复制",

  sessionExpired: "Perplexity 会话已失效，请重新登录",
  cookieInvalid: "Cookie 无效或已过期",
  cookieRejected: "Perplexity 拒绝了该 Cookie（HTTP {status}）：{detail}",
  rateLimited: "额度已用尽或触发限流（HTTP {status}）：{detail}",
  upstreamHttp: "Perplexity 返回 HTTP {status}：{detail}",
  upstreamEmpty: "Perplexity 返回了空回答",
  upstreamNetwork: "连不上 Perplexity：{detail}",
  upstreamMidStream: "回答中断：{detail}",
  notSignedIn: "未登录",
  toolsUnsupported:
    "该供应商没有 function calling（Perplexity 网页接口不支持工具调用）。去掉请求里的 tools 再试，或把插件选项 tools 设为 ignore，让它改为直接返回文字回答。",
  badRequest: "请求无效：{detail}",
  toolsIgnoredNotice: "⚠️ 本次请求里的 tools 已被忽略：该供应商没有 function calling，下面是纯文字回答。",

  loginChromeMissing: "找不到 Chrome/Chromium。请在插件选项里设置 chromePath。",
  loginDebugPort: "Chrome 调试端口没有起来",
  loginDevtools: "连不上 Chrome DevTools",
  loginCancelled: "登录已取消",
  loginTimeout: "登录超时（5 分钟）。也可以改用「粘贴 Session Cookie」。",
  loginProfileCleanup: "登录用的临时 Chrome 配置目录没能删除：{detail}",

  planPro: "Pro",
  planMax: "Max",
  quotaUnknown: "额度未知（rate-limit 接口未返回）",
  usageUnavailable: "读取额度失败：{detail}",
  proSearches: "剩余 {n} 次 Pro Search",
  proSearchesName: "Pro Search",
  research: "剩余 {n} 次 Deep Research",
  researchName: "Deep Research",
  labs: "剩余 {n} 次 Labs",
  labsName: "Labs",
  agenticResearch: "剩余 {n} 次 Agentic Research",
  agenticResearchName: "Agentic Research",
  freeQueries: "免费快速搜索可用",
  freeQueriesName: "Free quick search",
  usageEstimatedNote: "token 数为按字符数估算（Perplexity 不回传用量）",
}

const EN = {
  locale: "en",

  methodCookieLabel: "Paste a session cookie",
  cookieMessage: "Perplexity session cookie",
  cookiePlaceholder: "F12 → Application → Cookies → www.perplexity.ai",
  cookieTooShort: "Too short — paste the whole session-token value",
  methodBrowserLabel: "Sign in with the browser",
  browserInstructions: "Log in to Perplexity in the separate Chrome window that just opened; this page finishes on its own.",
  browserPageTitle: "Sign in to Perplexity",
  browserPageWaiting: "Waiting for sign-in… (use the separate Chrome window)",
  browserPageDone: "✓ Done — you can close this page",
  browserPageStarting: "Starting the browser…",
  browserPageCookieNote: "The cookie is read over the local DevTools protocol only; it never leaves this machine.",
  browserPageFallback: "Alternative: F12 → Application → Cookies → copy",

  sessionExpired: "The Perplexity session has expired — sign in again",
  cookieInvalid: "The cookie is invalid or has expired",
  cookieRejected: "Perplexity rejected the cookie (HTTP {status}): {detail}",
  rateLimited: "Quota exhausted or rate limited (HTTP {status}): {detail}",
  upstreamHttp: "Perplexity returned HTTP {status}: {detail}",
  upstreamEmpty: "Perplexity returned an empty answer",
  upstreamNetwork: "Cannot reach Perplexity: {detail}",
  upstreamMidStream: "The answer was cut off: {detail}",
  notSignedIn: "Not signed in",
  toolsUnsupported:
    "This provider has no function calling (Perplexity's web endpoint does not take tools). Drop the request's tools and retry, or set the plugin's tools option to ignore to get a plain text answer instead.",
  badRequest: "Bad request: {detail}",
  toolsIgnoredNotice: "⚠️ Tools were ignored for this request: this provider has no function calling, so this is a plain text answer.",

  loginChromeMissing: "Chrome/Chromium not found. Set the chromePath option to its executable.",
  loginDebugPort: "Chrome's debugging port never came up",
  loginDevtools: "Cannot connect to Chrome DevTools",
  loginCancelled: "Sign-in cancelled",
  loginTimeout: "Sign-in timed out after 5 minutes. You can also paste the session cookie instead.",
  loginProfileCleanup: "The temporary Chrome profile could not be deleted: {detail}",

  planPro: "Pro",
  planMax: "Max",
  quotaUnknown: "Quota unknown (the rate-limit endpoint returned nothing)",
  usageUnavailable: "Could not read the quota: {detail}",
  proSearches: "{n} Pro Searches left",
  proSearchesName: "Pro Search",
  research: "{n} Deep Research left",
  researchName: "Deep Research",
  labs: "{n} Labs runs left",
  labsName: "Labs",
  agenticResearch: "{n} Agentic Research runs left",
  agenticResearchName: "Agentic Research",
  freeQueries: "Free quick searches available",
  freeQueriesName: "Free quick search",
  usageEstimatedNote: "Token counts are estimated from characters (Perplexity reports no usage)",
}

const TABLES = { zh: ZH, en: EN }

/** Fill `{name}` placeholders; unknown names stay visible instead of "undefined". */
export function fill(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
    key in values ? String(values[key]) : whole
  )
}

/** The table for a resolved locale. */
export function strings(locale = "zh") {
  return TABLES[locale] ?? ZH
}

/** The OS locale as the runtime reports it, or "" when there is nothing to report. */
function osLocale() {
  try {
    return typeof Intl !== "undefined" && typeof Intl.DateTimeFormat === "function"
      ? Intl.DateTimeFormat().resolvedOptions().locale
      : ""
  } catch {
    return ""
  }
}

/**
 * Decide the locale: the option first, then `Intl` (reflects OS settings,
 * including Windows where LANG is usually unset), then the environment.
 *
 * @param {string|undefined} value - the `locale` option: "auto", "zh" or "en".
 * @param {object} [env] - environment to read; injected for tests.
 * @param {string} [intl] - the OS locale; injected for tests.
 * @returns {"zh"|"en"}
 */
export function resolveLocale(value, env = process.env, intl = osLocale()) {
  if (value === "zh" || value === "en") return value
  if (value && value !== "auto") {
    const explicit = String(value).toLowerCase()
    if (explicit.startsWith("zh")) return "zh"
    if (explicit.startsWith("en")) return "en"
  }

  if (/^zh/i.test(intl)) return "zh"
  if (/^en/i.test(intl)) return "en"

  for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
    const raw = env?.[key]
    if (typeof raw !== "string") continue
    const tag = raw.trim().split(".")[0].split("_")[0].toLowerCase()
    if (!tag || tag === "c" || tag === "posix") continue
    if (tag.startsWith("zh")) return "zh"
    if (tag.startsWith("en")) return "en"
  }
  return "en"
}
