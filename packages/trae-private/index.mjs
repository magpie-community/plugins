// TRAE 企业私有化供应商：浏览器登录、轮换续期、目录和 SSE 对话。
import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

const ID = "trae-private"

// 协议常量来自 traecli ToB。
const APP_ID = "7b3f9dc2-8a4e-5c6d-2f1b-9e4a3c5b7df0"
const EXCHANGE_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const OAUTH_CLIENT_ID = "ono9krqynydwx5"
const SESSION = "x-trae-private-session"
const UA = "codex_exec/0.201.1-tob-alpha.1 (Mac OS 14.1.2; arm64) dumb (codex_exec; 0.201.1-tob-alpha.1)"
// 协议版本族（traecli 0.201.1-tob-alpha.1）。
const PROTOCOL_VERSION = "0.201.1-tob-alpha.1"
const IDE_VERSION_CODE = "20260206"
// Cloud-IDE-JWT 默认 14 天；到期前 2 小时续期。
const REFRESH_MARGIN = 2 * 3600 * 1000
const LOGIN_WAIT = 5 * 60 * 1000

function protocolConfig() {
  const pick = (key, fallback) => {
    const value = process.env[key] ?? fallback
    if (!value || value.length > 512 || /[^\x20-\x7e]/.test(value)) throw new Error(`${key} 必须是非空可打印 ASCII 字符串`)
    return value
  }
  return {
    appId: pick("TRAE_PRIVATE_APP_ID", APP_ID),
    userAgent: pick("TRAE_PRIVATE_USER_AGENT", UA),
    version: pick("TRAE_PRIVATE_PROTOCOL_VERSION", PROTOCOL_VERSION),
    ideVersionCode: pick("TRAE_PRIVATE_IDE_VERSION_CODE", IDE_VERSION_CODE),
    ideVersion: pick("TRAE_PRIVATE_IDE_VERSION", "99.99.99"),
    originator: pick("TRAE_PRIVATE_ORIGINATOR", "codex_exec"),
  }
}

function positiveEnv(key, fallback) {
  const value = process.env[key]
  if (value === undefined || value === "") return fallback
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${key} 必须是正整数`)
  return n
}
const outputLimit = () => positiveEnv("TRAE_PRIVATE_OUTPUT", 32000)
const contextLimit = () => positiveEnv("TRAE_PRIVATE_CONTEXT", 1000000)

// 企业地址只接受 HTTPS，不要账号、查询或片段；允许部署路径前缀。
function parseBaseURL(value) {
  const raw = String(value ?? "").trim()
  if (!raw) return { error: "填写企业 HTTPS 地址" }
  if (/[\\\u0000-\u0020]/.test(raw) || /%(?:2f|5c|2e|00)/i.test(raw)) return { error: "地址不要包含反斜杠、空白或编码路径分隔符" }
  let url
  try { url = new URL(raw) } catch { return { error: "不是合法 URL" } }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    return { error: "必须是 HTTPS，不要带账号、查询或片段" }
  }
  if (!url.hostname) return { error: "缺少主机名" }
  const path = url.pathname.replace(/\/+$/, "")
  return { base: `${url.origin}${path === "/" ? "" : path}` }
}

function checkedBase(value) {
  const result = parseBaseURL(value)
  if (result.error) throw new Error(`企业部署地址无效：${result.error}`)
  return result.base
}

// 路径必须落在同一 origin 上，且不跟随跳转。
function sameOriginPath(base, path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    throw new Error(`TRAE path must be a single "/"-prefixed path: ${path}`)
  }
  const root = new URL(checkedBase(base))
  if (/[\\?#]/.test(path) || /%(?:2f|5c|2e|00)/i.test(path) || path.split("/").includes("..")) throw new Error("TRAE path contains unsupported characters")
  const url = new URL(`${root.href.replace(/\/+$/, "")}${path}`)
  if (url.origin !== root.origin) throw new Error(`TRAE path leaves the deployment origin: ${path}`)
  return url.href
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function bounded(promise, ms, message) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })])
  } finally { clearTimeout(timer) }
}

// ---------------------------------------------------------------------------
// 协议客户端。所有调用都走 HTTPS 部署地址，redirect: "error" 不跟跳。
// ---------------------------------------------------------------------------

class ProtocolError extends Error {
  constructor(message, { status = 502, code, signIn } = {}) {
    super(message)
    this.status = status
    this.code = code
    if (signIn) this.signIn = signIn
  }
}

async function apiPost(url, { body = {}, headers = {}, timeout = 20000, signal } = {}) {
  const res = await fetch(url, {
    method: "POST",
    redirect: "error",
    signal: signal ?? AbortSignal.timeout(timeout),
    headers: { "Content-Type": "application/json", Accept: "*/*", "User-Agent": UA, Originator: "codex_cli_rs", ...headers },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch { /* nginx 错误页等非 JSON */ }
  if (!res.ok || (data && typeof data === "object" && data.code !== undefined && data.code !== 0)) {
    const code = data?.code
    const message = String(data?.message || text || `HTTP ${res.status}`).slice(0, 300)
    // 30011 请先登录 / 1001 无法认证 / 4216 会话过期：token 失效；其余按上游错误处理。
    const signIn = code === 30011 || code === 1001 || code === 4216 || res.status === 401 ? "expired" : undefined
    throw new ProtocolError(`TRAE ${new URL(url).pathname} -> ${code ?? res.status} ${message}`, { status: res.status === 401 ? 401 : 502, code, signIn })
  }
  return data ?? {}
}

// GetUserInfo：头 x-cloudide-token（IDE 的 aiserver 同款）。返回身份/租户/席位/权益。
async function getUserInfo(base, token, options = {}) {
  return apiPost(sameOriginPath(base, "/cloudide/api/v3/trae/GetUserInfo"), {
    ...options, body: {}, headers: { "x-cloudide-token": token },
  })
}

// CheckLogin：头 X-Cloudide-Token。token 有效性 / Region / UserID。
async function checkLogin(base, token, options = {}) {
  return apiPost(sameOriginPath(base, "/cloudide/api/v3/trae/CheckLogin"), {
    ...options, body: {}, headers: { "X-Cloudide-Token": token },
  })
}

// 续期会轮换 RefreshToken，返回值必须由宿主保存。
async function exchangeRefreshToken(base, refreshToken, options = {}) {
  const data = await apiPost(sameOriginPath(base, "/cloudide/api/v3/trae/oauth/ExchangeToken"), {
    ...options,
    body: { RefreshToken: refreshToken, ClientID: EXCHANGE_CLIENT_ID },
  })
  const out = data?.Data || {}
  if (!out.Token || !out.RefreshToken) throw new ProtocolError("ExchangeToken 未返回 Token/RefreshToken", { status: 502, code: data?.code })
  const expires = Number(out.TokenExpireAt)
  return {
    access: String(out.Token),
    refresh: String(out.RefreshToken),
    expires: Number.isFinite(expires) && expires > 0 ? expires : Date.now() + (Number(out.TokenExpireDuration) || 1209600000),
    refreshExpires: Number(out.RefreshExpireAt) || 0,
  }
}

// get_config_list：模型目录（Authorization: Cloud-IDE-JWT + X-App-Id + X-Ide-Version-Code）。
async function fetchConfigList(base, token, options = {}) {
  const protocol = protocolConfig()
  return apiPost(sameOriginPath(base, "/api/ide/v1/cli/get_config_list"), {
    ...options,
    body: { function: "chat" },
    headers: {
      Authorization: `Cloud-IDE-JWT ${token}`,
      "X-App-Id": protocol.appId,
      "X-Ide-Version-Code": protocol.ideVersionCode,
      "User-Agent": protocol.userAgent,
      Originator: protocol.originator,
    },
  })
}

// ---------------------------------------------------------------------------
// 模型目录映射：config_info_list → magpie 模型条目。
// ---------------------------------------------------------------------------

const catalogCache = new Map()

function catalogOf(data) {
  const list = Array.isArray(data?.config_info_list) ? data.config_info_list : []
  const out = []
  for (const c of list) {
    if (!c || typeof c !== "object") continue
    const id = String(c.config_name || "")
    if (!id) continue
    const detail = Array.isArray(c.model_detail_list) ? c.model_detail_list.find((d) => d?.model_name) : null
    if (!detail) continue
    const display = c.display_config || {}
    const prompt = Number(detail.prompt_max_tokens)
    const context = Number.isSafeInteger(prompt) && prompt > 0 ? prompt : 128000
    const wire = String(detail.model_name)
    const image = Boolean(display.multimodal)
    const reasoning = String(display.model_capability || "").includes("reasoning")
    out.push({
      id,
      name: String(display.display_name || id),
      context,
      declared: context,
      wire,
      image,
      reasoning,
      efforts: reasoning ? ["low", "medium", "high"] : [],
      custom: Boolean(display.is_custom_model),
    })
  }
  return out
}

// 成功目录复用 60 秒；同一完整身份的 last-good 在上游暂时故障时不限时回落。
// 不持久化 token 或目录中的部署密钥；宿主重启后需重新取得一次有效目录。
async function catalogFor(base, token, { fallback = true } = {}) {
  const key = JSON.stringify([checkedBase(base), token])
  const cached = catalogCache.get(key)
  if (fallback && cached && Date.now() - cached.at < 60000) return cached.items
  try {
    const data = await fetchConfigList(base, token)
    if (!Array.isArray(data?.config_info_list)) throw new ProtocolError("模型目录缺少 config_info_list 数组", { status: 503 })
    const all = catalogOf(data)
    // 空数组是有效撤回；非空但完全不可解析的响应不能覆盖 last-good。
    if (data.config_info_list.length && !all.length) throw new ProtocolError("模型目录没有可解析的配置", { status: 503 })
    const items = all.filter((m) => !m.custom)
    catalogCache.set(key, { at: Date.now(), items })
    return items
  } catch (e) {
    if (e.signIn) {
      catalogCache.delete(key)
      throw e
    }
    if (fallback && cached) return cached.items
    throw e
  }
}

const MAX_WINDOW_KEY = "max-context-window"
function maxWindowOn(input) {
  try { return input?.magpie?.option?.(ID, MAX_WINDOW_KEY) === true } catch { return false }
}
function reported(items, input) {
  return items.map((m) => ({ ...m, context: maxWindowOn(input) ? Math.max(m.context, contextLimit()) : m.declared }))
}

function modelEntry(m) {
  return {
    id: m.id,
    name: m.name,
    providerID: ID,
    limit: { context: m.context, output: outputLimit() },
    api: { id: m.id, npm: "@ai-sdk/openai-compatible" },
    capabilities: {
      reasoning: m.reasoning,
      temperature: true,
      toolcall: true,
      attachment: m.image,
      input: { text: true, image: m.image, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
    variants: Object.fromEntries((m.efforts || []).map((e) => [e, { reasoningEffort: e }])),
  }
}

// ---------------------------------------------------------------------------
// 用量卡片：GetUserInfo（JWT）提供席位权益，网页会话可选增强明细。
// ---------------------------------------------------------------------------

function iso(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined
}

// ---------------------------------------------------------------------------
// 网页会话仅增强用量明细，缺失时保留 JWT 席位信息。
// ---------------------------------------------------------------------------

const COOKIE_NAME = "X-Cloudide-Tob-Session"

function magpieConfigDir() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "magpie")
}

function parseCookieValue(raw) {
  let s = String(raw ?? "").trim()
  if (!s) return ""
  if (s.startsWith(`${COOKIE_NAME}=`)) s = s.slice(COOKIE_NAME.length + 1).trim()
  const semi = s.indexOf(";")
  if (semi >= 0) s = s.slice(0, semi).trim()
  return /[\r\n]/.test(s) ? "" : s
}

function webSessionFile(account) {
  const encode = (s) => Buffer.from(s).toString("base64url")
  const origin = new URL(account.base).origin
  return join(magpieConfigDir(), "trae-private-sessions", encode(origin), encode(account.uid), "web-session.txt")
}

function readWebSession(account) {
  try { return parseCookieValue(readFileSync(webSessionFile(account), "utf8")) } catch { return "" }
}

function writeWebSession(account, cookie) {
  const dest = webSessionFile(account)
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 })
  writeFileSync(dest, cookie, { mode: 0o600 })
}

function webSessionHint(account) {
  return `网页会话缺失或失效：基础/超额/企业内置模型明细不可用（席位/权益仍正常显示）。在浏览器登录 ${account.base} 后，把请求里 ${COOKIE_NAME} 的值写入 ${webSessionFile(account)} 可恢复明细`
}

// 旧版插件的会话文件（分层编码，home 段不定长）与最早的平面文件，都试一遍。
function legacySessionCandidates(account) {
  const dir = magpieConfigDir()
  const encode = (s) => Buffer.from(s).toString("base64url")
  const origin = new URL(account.base).origin
  const out = []
  const base = join(dir, "trae-private-sessions", encode(origin), encode(account.uid))
  try {
    const stack = [base]
    while (stack.length) {
      const cur = stack.pop()
      for (const name of readdirSync(cur, { withFileTypes: true })) {
        const path = join(cur, name.name)
        if (name.isDirectory()) stack.push(path)
        else if (name.name === "session.json") out.push(path)
      }
    }
  } catch {}
  try {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (name.isFile() && name.name.startsWith("trae-private-web-cookie")) out.push(join(dir, name.name))
    }
  } catch {}
  return out
}

// 读旧会话：session.json 是完整 cookie 对象（取匹配部署域的值），平面文件就是裸值。
function legacyCookieOf(path, account) {
  const origin = new URL(account.base).origin
  try {
    const raw = readFileSync(path, "utf8")
    if (path.endsWith("session.json")) {
      const c = JSON.parse(raw)
      const domain = String(c.domain || "").toLowerCase().replace(/^\./, "")
      const host = new URL(origin).hostname
      if (c.name !== COOKIE_NAME || !parseCookieValue(c.value)) return ""
      if (!(host === domain || host.endsWith(`.${domain}`))) return ""
      return parseCookieValue(c.value)
    }
    return parseCookieValue(raw)
  } catch { return "" }
}

async function quotaWithSession(base, cookie, options = {}) {
  const headers = { Cookie: `${COOKIE_NAME}=${cookie}`, Accept: "application/json", "User-Agent": "Mozilla/5.0" }
  const one = (path) => apiPost(sameOriginPath(base, path), { ...options, body: {}, headers })
  const [quota, usage] = await Promise.all([
    one("/trae/gtm/tob/api/v1/config/get_personal_quota"),
    one("/trae/gtm/tob/api/v1/config/get_user_model_usage"),
  ])
  return { quota, usage }
}

// 把会话明细合进 JWT 用量卡：基础/超额（元）+ 企业内置模型（token 配额）。
function mergeSessionUsage(card, { quota, usage }) {
  const q = quota?.user_model_quota || {}
  const lists = Array.isArray(usage?.user_usage_list) ? usage.user_usage_list : []
  const seatLimit = Number(q.seat_pool_currency_quota) || 0
  const paygoLimit = Number(q.paygo_currency_quota) || 0
  const sumCost = (list) => (list || []).reduce((n, x) => n + (Number(x?.total_cost_currency) || 0), 0)
  const seatModels = lists[0]?.in_seat_detail?.chat_usage_details || []
  const overModels = lists[1]?.model_usage_detail_list || lists[1]?.in_seat_detail?.chat_usage_details || []
  const seatUsed = sumCost(seatModels)
  const overUsed = sumCost(overModels)
  const seatLeft = Math.max(0, seatLimit - seatUsed)
  const overLeft = Math.max(0, paygoLimit - overUsed)
  const push = (name, used, limit, unit, span = 2592000) => {
    if (!(limit > 0)) return
    const over = used - limit
    card.windows.push({
      name,
      used: limit > 0 ? (used / limit) * 100 : 0,
      span,
      limit,
      unit,
      amount: Math.round(used * 1000) / 1000,
      display: unit === "元" ? `￥${yuan(used)} / ￥${yuan(limit)}` : `${Math.round(used)} / ${limit}`,
      resetsAt: monthResetAt(),
      ...(over > 0.01 ? { over: Math.round(over * 100) / 100 } : {}),
    })
  }
  push("基础用量", seatUsed, seatLimit, "元")
  push("超额用量", overUsed, paygoLimit, "元")
  if (seatLimit > 0 || paygoLimit > 0) card.balance = yuan(seatLeft > 0 ? seatLeft : overLeft)

  // 企业内置模型：token 配额独立于货币额度。有限配额画窗口；
  // 不限量的只有真实用量 > 0 时才画（0/x 的窗口没有信息量）。
  const customUsed = new Map()
  for (const x of lists[0]?.model_usage_detail_list || []) {
    customUsed.set(x.config_name, Number(x.total_token_usage) || 0)
  }
  const builtIn = []
  for (const c of Array.isArray(q.custom_model_quota_list) ? q.custom_model_quota_list : []) {
    const limit = Number(c.token_quota) || 0
    const used = customUsed.get(c.config_name) || 0
    const unlimited = !(limit > 0) || limit > 1e9
    builtIn.push({ name: c.display_name || c.config_name, tokens: used, quota: unlimited ? "不限" : limit })
    if (unlimited && used <= 0) continue
    card.windows.push({
      name: `内置模型 ${c.display_name || c.config_name}`,
      used: unlimited ? 0 : (used / limit) * 100,
      amount: used,
      span: 0,
      limit: unlimited ? 0 : limit,
      unit: "token",
      display: unlimited
        ? `${used.toLocaleString("zh-CN")} token（配额不限）`
        : `${used.toLocaleString("zh-CN")} / ${limit.toLocaleString("zh-CN")} token`,
    })
  }
  if (builtIn.length) card.metadata.builtInModels = builtIn
  const models = []
  for (const x of [...seatModels, ...(lists[0]?.model_usage_detail_list || [])]) {
    const cost = Number(x?.total_cost_currency) || 0
    const tokens = Number(x?.total_token_usage) || 0
    if (!cost && !tokens) continue
    models.push({ name: x.display_name || x.config_name, cost: Math.round(cost * 1000) / 1000, tokens })
  }
  models.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens)
  card.metadata = {
    ...card.metadata,
    models: models.slice(0, 12),
    currency: "CNY",
    seatUsed: Math.round(seatUsed * 1000) / 1000,
    paygoUsed: Math.round(overUsed * 1000) / 1000,
  }
  return card
}

function monthResetAt() {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0).toISOString()
}

function yuan(n) {
  return Number(n || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function usageCardOf(info) {
  // 部署存在两种返回布局：席位/额度字段在 Data.UserInfo 内，或平铺在 Data 顶层。两处都读。
  const data = info?.Data || {}
  const user = { ...data, ...(data.UserInfo || {}) }
  const tenant = user.TenantInfoBase || {}
  const role = user.RoleInfo || {}
  if (user.IsAllowLogin === false) throw Object.assign(new Error("部署已禁止该账号登录"), { signIn: "expired" })
  const productType = Number(user.ProductType ?? tenant.ProductType) || 0
  const out = {
    plan: productType === 320 ? "企业专享版" : `TRAE 企业版（产品 ${productType || "?"}）`,
    user: String(user.Account || user.Email || ""),
    windows: [],
    metadata: {
      tenant: String(tenant.TenantName || user.TenantID || ""),
      scope: String(user.Scope || ""),
      region: String(user.Region || ""),
      role: String(role.RoleName || ""),
      seats: Number(user.CurSeats) || 0,
      seatsTotal: Number(user.TotalSeats) || 0,
      chatCount: Number(user.AllChatCnt) || 0,
      asOf: new Date().toISOString(),
    },
  }
  const seats = Number(user.CurSeats) || 0
  const seatsTotal = Number(user.TotalSeats) || 0
  if (seatsTotal > 0) {
    out.windows.push({
      name: "企业席位",
      used: (seats / seatsTotal) * 100,
      // magpie 用 amount/limit 拼展示与剩余，amount 是绝对用量。
      amount: seats,
      span: 0,
      limit: seatsTotal,
      unit: "席",
      display: `${seats}/${seatsTotal} 席`,
    })
  }
  const priceLimit = Number(user.UsagePriceLimit) || 0
  const price = Number(user.UsagePrice) || 0
  if (priceLimit > 0) {
    out.windows.push({
      name: "个人额度",
      used: priceLimit > 0 ? (price / priceLimit) * 100 : 0,
      span: 2592000,
      limit: priceLimit,
      unit: "元",
      amount: Math.round(price * 1000) / 1000,
      display: `￥${yuan(price)} / ￥${yuan(priceLimit)}`,
    })
    out.balance = yuan(Math.max(0, priceLimit - price))
  }
  const until = iso(tenant.CurrentEntitlementExpireTime)
  if (until) {
    out.until = until
    out.renew = iso(tenant.CurrentEntitlementExpireTime)
  }
  if (!out.windows.length) out.error = "部署未开放席位/个人额度字段"
  return out
}

// ---------------------------------------------------------------------------
// 请求体预算与消息构造（上游 nginx 约 10MB 处 413，实测 9.5MB 通过）。
// ---------------------------------------------------------------------------

const bodyBudget = () => positiveEnv("TRAE_PRIVATE_BODY_BUDGET", 9 * 1024 * 1024)
const toolResultKeep = () => positiveEnv("TRAE_PRIVATE_TOOL_RESULT_KEEP", 20000)

function isImage(part) {
  return part?.type === "image_url" || Boolean(part?.image_url)
}

function imageCount(messages) {
  let n = 0
  for (const m of messages) for (const p of m.content || []) if (isImage(p)) n++
  return n
}

function dropImages(messages, keep) {
  let seen = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!Array.isArray(m.content)) continue
    const kept = []
    for (let j = m.content.length - 1; j >= 0; j--) {
      const p = m.content[j]
      if (!isImage(p)) { kept.unshift(p); continue }
      seen++
      if (seen <= keep) kept.unshift(p)
      else kept.unshift({ type: "text", text: "[image omitted: request-body limit]" })
    }
    m.content = kept
  }
  return seen > keep ? seen - keep : 0
}

function truncateTools(messages, keep) {
  let n = 0
  for (const m of messages) {
    if (m.role !== "tool" || !Array.isArray(m.content)) continue
    for (const p of m.content) {
      if (p?.type !== "text" || typeof p.text !== "string" || p.text.length <= keep) continue
      const dropped = p.text.length - keep
      p.text = `${p.text.slice(0, keep)}\n\n[trae-private: 这条工具结果原有 ${p.text.length} 字符，为避开上游请求体上限截掉了后 ${dropped} 字符]`
      n++
    }
  }
  return n
}

function fitBody(body) {
  const notes = { droppedImages: 0, truncatedTools: 0, bytes: 0 }
  const budget = bodyBudget()
  const bytes = () => Buffer.byteLength(sendable(body), "utf8")
  notes.bytes = bytes()
  if (notes.bytes <= budget) return notes
  let current = body.messages.findLastIndex((m) => m.role === "user")
  if (current < 0) current = body.messages.length
  const history = body.messages.slice(0, current)
  if (imageCount(history)) {
    notes.droppedImages = dropImages(history, 0)
    notes.bytes = bytes()
  }
  if (notes.bytes > budget) {
    notes.truncatedTools = truncateTools(history, toolResultKeep())
    notes.bytes = bytes()
  }
  if (notes.bytes > budget) throw Object.assign(new Error(`请求体 ${notes.bytes} UTF-8 字节超过预算 ${budget}；请缩短历史、工具定义或当前输入`), { status: 413 })
  return notes
}

function partsOf(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : []
  if (!Array.isArray(content)) return []
  const out = []
  for (const part of content) {
    if (typeof part === "string" && part) out.push({ type: "text", text: part })
    else if (part?.type === "image_url" || part?.image_url) {
      const image = part.image_url
      const url = typeof image === "string" ? image : image?.url
      if (url) out.push({ type: "image_url", image_url: { url: String(url) } })
    } else if (typeof part?.text === "string" && part.text) out.push({ type: "text", text: part.text })
  }
  return out
}

function messagesOf(req) {
  const source = Array.isArray(req.messages)
    ? req.messages
    : typeof req.input === "string"
      ? [{ role: "user", content: req.input }]
      : Array.isArray(req.input)
        ? req.input
        : []
  const out = []
  for (const m of source) {
    const role = m?.role || "user"
    const content = partsOf(m?.content ?? m?.text ?? "")
    const calls = Array.isArray(m?.tool_calls) ? m.tool_calls : []
    if (calls.length) {
      const tool_calls = []
      for (const [i, c] of calls.entries()) {
        const fn = c?.function || c?.function_call
        if (!fn?.name) continue
        tool_calls.push({
          index: Number.isFinite(c?.index) ? c.index : i,
          id: String(c?.id || `call_${i}`),
          type: "function",
          function_call: {
            name: String(fn.name),
            arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
          },
        })
      }
      if (tool_calls.length) { out.push({ role, content, tool_calls }); continue }
    }
    if (role === "tool" || m?.tool_call_id) {
      out.push({ role: "tool", content, tool_call_id: String(m?.tool_call_id || "") })
      continue
    }
    if (!content.length) continue
    out.push({ role, content })
  }
  return out
}

function toolsOf(req) {
  if (!Array.isArray(req.tools)) return undefined
  const only = typeof req.tool_choice === "object" ? req.tool_choice?.function?.name : ""
  const out = []
  for (const tool of req.tools) {
    const fn = tool?.function || tool
    if (!fn?.name || (only && fn.name !== only)) continue
    const params = fn.parameters ?? { type: "object", properties: {} }
    out.push({
      type: "function",
      function: {
        name: String(fn.name),
        description: typeof fn.description === "string" ? fn.description : "",
        parameters: typeof params === "string" ? params : JSON.stringify(params),
      },
    })
  }
  return out.length ? out : undefined
}

function sessionOf(headers) {
  const given = String(headers?.get?.(SESSION) || "").trim()
  return (given || randomUUID()).slice(0, 128)
}

// 上游只接受 auto/none/required 字符串；对象形式只保留指定工具，再配 required。
function toolChoiceOf(value) {
  if (value === "auto" || value === "none" || value === "required") return value
  if (value && typeof value === "object") return "required"
  return undefined
}

function sendable(body) {
  const { fitted, ...wire } = body
  return JSON.stringify(wire)
}

function chatBody(req, session, items) {
  const id = String(req.model || "")
  const known = items.find((m) => m.id === id || m.wire === id)
  if (!known) throw Object.assign(new Error(`模型不在所选账号目录中：${id}`), { status: 400 })
  const body = {
    config_name: known.id,
    model_name: known.wire,
    user_input: "",
    messages: messagesOf(req),
    conversation_id: session,
    session_id: session,
  }
  const tools = toolsOf(req)
  if (tools) {
    body.tools = tools
    const choice = toolChoiceOf(req.tool_choice)
    if (choice) body.tool_choice = choice
    if (req.parallel_tool_calls !== undefined) body.parallel_tool_calls = req.parallel_tool_calls
  }
  for (const key of ["temperature", "top_p", "stop", "seed", "frequency_penalty", "presence_penalty"]) {
    if (req[key] !== undefined) body[key] = req[key]
  }
  if (req.reasoning_effort !== undefined) {
    if (!known.efforts.includes(req.reasoning_effort)) throw Object.assign(new Error("该模型不支持此 reasoning_effort"), { status: 400 })
    body.reasoning_effort = req.reasoning_effort
  }
  const max = req.max_completion_tokens ?? req.max_tokens
  if (Number.isFinite(max) && max > 0) body.max_tokens = Math.floor(max)
  body.fitted = fitBody(body)
  return body
}

// ---------------------------------------------------------------------------
// SSE 事件流解析（llm_raw_chat v2 的事件协议）。
// ---------------------------------------------------------------------------

function shortError(text) {
  const raw = String(text || "").trim()
  const i = raw.indexOf("origin err")
  const line = (i >= 0 ? raw.slice(i + "origin err".length).replace(/^\s*=\s*/, "") : raw).split("\n")[0]
  return line.trim().slice(0, 300) || "私有化 TRAE 没有返回可读错误"
}

function errorResponse(status, message, signIn, code) {
  const headers = { "content-type": "application/json" }
  if (signIn) headers["X-Magpie-Sign-In"] = signIn
  const type = status === 401 ? "authentication_error" : status === 429 ? "insufficient_quota" : "server_error"
  return new Response(JSON.stringify({ error: { message, type, ...(code ? { code } : {}) } }), { status, headers })
}

async function* sse(stream, signal) {
  const reader = stream.getReader()
  const cancel = () => { reader.cancel().catch(() => {}) }
  signal?.addEventListener("abort", cancel, { once: true })
  const dec = new TextDecoder()
  let buf = ""
  let event = ""
  let data = []
  const flush = function* () {
    if (!data.length) return
    const raw = data.join("\n")
    data = []
    let value = raw
    try { value = JSON.parse(raw) } catch {}
    yield { event, data: value }
    event = ""
  }
  try {
    for (;;) {
      signal?.throwIfAborted()
      const { value, done } = await reader.read()
      signal?.throwIfAborted()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "")
        buf = buf.slice(i + 1)
        if (!line) { yield* flush(); continue }
        if (line.startsWith(":")) continue
        if (line.startsWith("event:")) { yield* flush(); event = line.slice(6).trim() }
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
      }
    }
    if (buf.startsWith("data:")) data.push(buf.slice(5).trimStart())
    yield* flush()
  } finally {
    signal?.removeEventListener("abort", cancel)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function callsOf(data, seen) {
  if (!Array.isArray(data?.tool_calls)) return []
  const out = []
  for (const [i, c] of data.tool_calls.entries()) {
    const fn = c?.function_call || c?.function
    if (!fn) continue
    const index = Number.isFinite(c?.index) ? c.index : i
    const first = !seen || !seen.has(index)
    const args = fn.arguments ?? fn.partial_arguments
    const call = {
      index,
      type: "function",
      function: { arguments: args == null ? "" : typeof args === "string" ? args : JSON.stringify(args) },
    }
    const id = c?.id != null ? String(c.id) : ""
    if (id) call.id = id
    else if (first) call.id = `call_${index}`
    const name = typeof fn.name === "string" ? fn.name : ""
    if (name) call.function.name = name
    if (seen) seen.add(index)
    out.push(call)
  }
  return out
}

function tokenUsageOf(data) {
  data = data?.usage ?? data?.token_usage ?? data
  const prompt = Number(data?.prompt_tokens)
  const completion = Number(data?.completion_tokens)
  if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return null
  const input = Number.isFinite(prompt) ? prompt : 0
  const output = Number.isFinite(completion) ? completion : 0
  const total = Number(data?.total_tokens)
  const cached = Number(data?.cache_read_input_tokens)
  const reasoning = Number(data?.reasoning_tokens)
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: Number.isFinite(total) && total > 0 ? total : input + output,
    prompt_tokens_details: { cached_tokens: Number.isFinite(cached) ? cached : 0 },
    completion_tokens_details: { reasoning_tokens: Number.isFinite(reasoning) ? reasoning : 0 },
  }
}

const QUEUE_EVENTS = new Set(["queue_begin", "request_wait_in_queue", "queue_end", "queue_position"])
const BAD_FINISH = /risk|filter|security|intercept|safety|block|moderation/i

function piece(ev, seenCalls) {
  const data = ev?.data
  const event = ev?.event || ""
  if (event === "progress_notice" || QUEUE_EVENTS.has(event)) return {}
  const obj = data && typeof data === "object" ? data : null
  if (event === "error" || obj?.error) {
    if (obj?.code === 4222 && String(obj.error).includes("ErrAllModelUserQuotaExceeded")) {
      return { error: "TRAE 模型额度已用尽", status: 429, code: "ErrAllModelUserQuotaExceeded", signIn: "kept" }
    }
    return { error: shortError(obj ? obj.error || obj.message : data) }
  }
  const security = obj && (obj.hit_rule_name || obj.action_type || obj.execute_point)
  if (event === "content_security" || (security && event !== "output" && event !== "done")) {
    const rule = typeof obj?.hit_rule_name === "string" && obj.hit_rule_name ? `（命中规则 ${obj.hit_rule_name}）` : ""
    return { error: `内容被上游安全策略拦截${rule}` }
  }
  if (event === "token_usage") return { usage: tokenUsageOf(data) }
  if (event !== "output" && event !== "done") return {}
  if (!obj) return { text: typeof data === "string" ? data : "", done: event === "done" }
  const finish = typeof obj.finish_reason === "string" ? obj.finish_reason : ""
  if (finish && BAD_FINISH.test(finish)) return { error: `上游中止了回答（finish_reason: ${finish}）`, finish }
  return {
    text: typeof obj.response === "string" ? obj.response : "",
    reasoning: typeof obj.reasoning_content === "string" ? obj.reasoning_content : "",
    calls: callsOf(obj, seenCalls),
    finish,
    done: event === "done",
    usage: tokenUsageOf(obj),
  }
}

function chunk(id, model, created, delta, finish, usage) {
  const out = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
  if (usage) out.usage = usage
  return out
}

const INCOMPLETE = "私有化 TRAE 的响应在结束事件前中断"

function streamResponse(model, first, rest, close = async () => {}) {
  const id = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const enc = new TextEncoder()
  const frames = (async function* () {
    try {
      yield chunk(id, model, created, { role: "assistant" }, null)
      let finish = ""
      let usage = null
      const calls = new Map()
      const seenCalls = new Set()
      let done = false
      let ev = first
      for (;;) {
        const p = piece(ev, seenCalls)
        if (p.usage) usage = p.usage
        if (p.error) {
          yield { error: { message: p.error, type: p.status === 429 ? "insufficient_quota" : "server_error", ...(p.code ? { code: p.code } : {}) } }
          return
        }
        if (p.finish) finish = p.finish
        const delta = {}
        if (p.reasoning) delta.reasoning_content = p.reasoning
        if (p.text) delta.content = p.text
        if (p.calls?.length) {
          delta.tool_calls = p.calls
          for (const c of p.calls) calls.set(c.index, calls.get(c.index) || Boolean(c.function.arguments))
        }
        if (Object.keys(delta).length) yield chunk(id, model, created, delta, null)
        if (p.done) { done = true; break }
        const n = await rest.next()
        if (n.done) break
        ev = n.value
      }
      if (!done && !finish) yield { error: { message: INCOMPLETE, type: "server_error" } }
      else {
        const empty = [...calls].filter(([, hasArgs]) => !hasArgs).map(([index]) => ({ index, function: { arguments: "{}" } }))
        if (empty.length) yield chunk(id, model, created, { tool_calls: empty }, null)
        yield chunk(id, model, created, {}, finish || (calls.size ? "tool_calls" : "stop"), usage)
      }
    } catch {
      yield { error: { message: "读取私有化 TRAE 响应失败", type: "server_error" } }
    } finally {
      await close()
      await rest.return?.()
    }
  })()
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const n = await frames.next()
        if (n.done) {
          controller.enqueue(enc.encode("data: [DONE]\n\n"))
          controller.close()
        } else controller.enqueue(enc.encode(`data: ${JSON.stringify(n.value)}\n\n`))
      } catch (e) {
        controller.error(e)
      }
    },
    async cancel() {
      await close()
      await frames.return()
      await rest.return?.()
    },
  })
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
}

async function collect(first, rest) {
  let text = ""
  let reasoning = ""
  let error = ""
  let errorStatus, errorCode, errorSignIn
  let finish = ""
  let usage = null
  let done = false
  const calls = []
  const seenCalls = new Set()
  const take = (ev) => {
    const p = piece(ev, seenCalls)
    if (p.done) done = true
    if (p.usage) usage = p.usage
    if (p.error) { error = p.error; errorStatus = p.status; errorCode = p.code; errorSignIn = p.signIn }
    else {
      text += p.text || ""
      reasoning += p.reasoning || ""
      if (p.finish) finish = p.finish
      for (const c of p.calls || []) {
        const was = calls.find((x) => x.index === c.index)
        if (!was) calls.push({ ...c })
        else {
          if (c.function.name) was.function.name = c.function.name
          if (c.id) was.id = c.id
          was.function.arguments += c.function.arguments
        }
      }
    }
  }
  take(first)
  if (!done && !error) {
    for await (const ev of rest) {
      take(ev)
      if (done || error) break
    }
  }
  if (!done && !error && !finish) error = INCOMPLETE
  for (const c of calls) {
    if (!c.id) c.id = `call_${c.index}`
    if (!c.function.arguments && (done || finish) && !error) c.function.arguments = "{}"
  }
  return { text, reasoning, error, errorStatus, errorCode, errorSignIn, finish, usage, calls }
}

// ---------------------------------------------------------------------------
// 登录：本地回调 + 浏览器 SSO（traecli 同款配方），以及从本机 traecli 导入。
// ---------------------------------------------------------------------------

async function loginBaseFor(base, options = {}) {
  const override = process.env.TRAE_PRIVATE_AUTH_HOST
  const data = override ? null : await apiPost(sameOriginPath(base, "/cloudide/api/v3/trae/GetLoginGuidance"), options)
  const host = override ?? data?.Result?.LoginHost
  if (typeof host !== "string" || !host.trim()) throw new Error("企业登录引导缺少 LoginHost")
  const raw = host.includes("://") ? host : `https://${host}`
  const parsed = parseBaseURL(raw)
  if (parsed.error) throw new Error(`企业登录地址无效：${parsed.error}`)
  return parsed.base
}

function authorizationURL(port, loginBase) {
  const params = new URLSearchParams({
    redirect: "0",
    login_trace_id: `traeprov-${port}`,
    auth_callback_url: `http://127.0.0.1:${port}/authorize`,
    auth_from: "traecli",
    device_id: "traecli-tob-browser-login",
    login_version: "1",
    login_channel: "native_ide",
    plugin_version: "local",
    auth_type: "local",
    client_id: OAUTH_CLIENT_ID,
    x_device_id: "traecli-tob-browser-login",
  })
  return `${checkedBase(loginBase)}/authorization?${params.toString()}`
}

const CALLBACK_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>TRAE 登录</title></head>
<body style="font-family:system-ui;padding:48px;text-align:center">
<h2>已返回 Magpie</h2><p>可以关闭此页。</p></body></html>`

// 本地浏览器直达与远程宿主回填地址共用此服务；先保存结果再由 callback 消费。
function startCallbackServer(signal, loginBase) {
  const checkedLoginBase = checkedBase(loginBase)
  return new Promise((resolveServer, rejectServer) => {
    let settled = false
    let resolveHit, rejectHit
    const pending = new Promise((resolve, reject) => { resolveHit = resolve; rejectHit = reject })
    // 浏览器或取消可能早于宿主调用 callback；始终观察 rejection。
    pending.catch(() => {})
    const detach = () => signal?.removeEventListener("abort", onAbort)
    const stop = (reason = new Error("登录已取消")) => {
      const wasPending = !settled
      if (wasPending) { settled = true; rejectHit(reason) }
      detach()
      server.close()
      if (wasPending) server.closeAllConnections?.()
      else server.closeIdleConnections?.()
    }
    const onAbort = () => { stop(new Error("登录已取消")); rejectServer(new Error("登录已取消")) }
    const server = createServer((req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1")
      if (url.pathname !== "/authorize") {
        res.writeHead(404).end()
        return
      }
      const params = Object.fromEntries(url.searchParams.entries())
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(CALLBACK_PAGE)
      if (!settled) {
        settled = true
        detach()
        resolveHit(params)
        server.close()
        server.closeIdleConnections?.()
      }
    })
    server.on("error", (e) => { stop(e); rejectServer(e) })
    if (signal?.aborted) { onAbort(); return }
    signal?.addEventListener("abort", onAbort, { once: true })
    server.listen(0, "127.0.0.1", () => {
      const port = server.address()?.port
      resolveServer({ port, url: authorizationURL(port, checkedLoginBase), wait: () => pending, stop })
    })
  })
}

// 授权回调的 userJwt 包含完整凭据，不另做授权码兑换。
function grantOf(params) {
  let out
  try { out = JSON.parse(params.userJwt) } catch { throw new ProtocolError("登录回调缺少有效的 userJwt", { status: 502 }) }
  const expires = Number(out?.TokenExpireAt)
  if (typeof out?.Token !== "string" || !out.Token || typeof out.RefreshToken !== "string" || !out.RefreshToken || !Number.isFinite(expires) || expires <= 0) {
    throw new ProtocolError("登录回调凭据不完整", { status: 502 })
  }
  return { access: out.Token, refresh: out.RefreshToken, expires, refreshExpires: Number(out.RefreshExpireAt) || 0, via: "sso" }
}

function identityOf(base, tokens, extra = {}) {
  return {
    type: "success",
    access: tokens.access,
    refresh: tokens.refresh,
    expires: tokens.expires,
    refreshExpires: tokens.refreshExpires || 0,
    protocol: 2,
    clientID: EXCHANGE_CLIENT_ID,
    baseURL: checkedBase(base),
    via: tokens.via,
    ...extra,
  }
}

async function identityFromUserInfo(base, tokens, options = {}) {
  const info = await getUserInfo(base, tokens.access, options)
  const user = info?.Data?.UserInfo || {}
  if (!user.UserID) throw new ProtocolError("GetUserInfo 未返回 UserID", { status: 502 })
  return identityOf(base, tokens, {
    accountId: String(user.Account || user.Email || user.UserID),
    uid: String(user.UserID),
    email: String(user.Email || user.Account || ""),
    region: String(user.Region || ""),
    scope: String(user.Scope || ""),
    tenant: String(user.TenantInfoBase?.TenantName || user.TenantID || ""),
  })
}

function validateSettings() {
  protocolConfig()
  outputLimit()
  contextLimit()
  bodyBudget()
  toolResultKeep()
}

async function authorizeSso(inputs) {
  const parsed = parseBaseURL(inputs?.baseURL)
  if (parsed.error) return { url: "", instructions: parsed.error, method: "auto", callback: async () => ({ type: "failed", error: parsed.error }) }
  try { validateSettings() } catch (e) {
    const error = String(e.message)
    return { url: "", instructions: error, method: "auto", callback: async () => ({ type: "failed", error }) }
  }
  const base = parsed.base
  let server
  try {
    inputs?.signal?.throwIfAborted()
    const loginBase = await loginBaseFor(base, { signal: inputs?.signal })
    server = await startCallbackServer(inputs?.signal, loginBase)
  } catch (e) {
    const error = `无法开始企业登录：${e.message}`
    return { url: "", instructions: error, method: "auto", callback: async () => ({ type: "failed", error }) }
  }
  let timer
  const cleanup = (reason) => {
    clearTimeout(timer)
    inputs?.signal?.removeEventListener("abort", onAbort)
    server.stop(reason)
  }
  const onAbort = () => cleanup(new Error("登录已取消"))
  inputs?.signal?.addEventListener("abort", onAbort, { once: true })
  timer = setTimeout(() => cleanup(new Error("登录超时，请重新开始")), _internal.loginTimeout ?? LOGIN_WAIT)
  timer.unref?.()
  const callback = () => (async () => {
    try {
      inputs?.signal?.throwIfAborted()
      const params = await server.wait()
      cleanup()
      const tokens = grantOf(params)
      return await identityFromUserInfo(base, tokens, { signal: inputs?.signal })
    } catch (e) {
      cleanup()
      return { type: "failed", error: String(e?.message || e) }
    }
  })()
  return {
    url: server.url,
    method: "auto",
    callback,
    cancel: cleanup,
    instructions: "完成浏览器登录；远程运行时，将最终的完整回调地址粘贴回 Magpie。",
  }
}

// CLI 导入后独立续期，原 CLI 的 refresh token 可能因此失效。
function traeHome(explicit) {
  const dir = String(explicit || "").trim()
  const path = resolve(dir || process.env.TRAE_HOME || join(homedir(), ".trae"))
  return path
}

async function importFromCli(inputs) {
  // 登录结果统一从 callback 返回。
  const run = async () => {
    const parsed = parseBaseURL(inputs?.baseURL)
    if (parsed.error) return { type: "failed", error: parsed.error }
    try { validateSettings() } catch (e) { return { type: "failed", error: String(e.message) } }
    const base = parsed.base
    const path = join(traeHome(inputs?.traeHome), "cli", "auth.json")
    let file
    try {
      file = JSON.parse(readFileSync(path, "utf8"))
    } catch (e) {
      return { type: "failed", error: `读取 ${path} 失败：${e.code || e.message}` }
    }
    const trae = file?.trae
    const access = typeof trae?.access_token === "string" ? trae.access_token : ""
    const refresh = typeof trae?.refresh_token === "string" ? trae.refresh_token : ""
    if (!access || !refresh) return { type: "failed", error: "CLI auth.json 缺少 access/refresh token（未登录或版本不符）" }
    const fileBase = trae?.endpoints?.api_base_url ? parseBaseURL(trae.endpoints.api_base_url).base : ""
    if (fileBase && fileBase !== base) return { type: "failed", error: `CLI 登录的部署（${fileBase}）与输入不一致` }
    const expiresAt = Date.parse(trae.expires_at || "")
    try {
      const tokens = {
        access,
        refresh,
        expires: Number.isFinite(expiresAt) ? expiresAt : 0,
        via: "cli-import",
      }
      return await identityFromUserInfo(base, tokens, { signal: inputs?.signal })
    } catch (e) {
      return { type: "failed", error: `导入的凭据无效：${e?.message || e}` }
    }
  }
  return {
    url: "",
    instructions: "正在读取并校验本机 traecli 登录…",
    method: "auto",
    callback: run,
  }
}

// ---------------------------------------------------------------------------
// 插件装配。
// ---------------------------------------------------------------------------

function authAccount(auth) {
  const base = auth?.baseURL ? checkedBase(auth.baseURL) : ""
  const access = typeof auth?.access === "string" ? auth.access : ""
  if (!base || !access || !auth?.refresh) {
    throw Object.assign(
      new Error(auth?.traeHome
        ? "检测到旧版（traecli 绑定）账号：请用「从本机 traecli 导入登录」或浏览器 SSO 重新登录一次"
        : "尚未登录：在 Magpie 打开该供应商并登录"),
      { signIn: "expired" },
    )
  }
  return { base, access: auth.access, refresh: String(auth.refresh), expires: Number(auth.expires) || 0, uid: String(auth.uid || "") }
}

export default async function TraePrivateAuthPlugin(input) {
  return {
    config: async (config) => {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      // 模型按账号实时列出（provider.models）；这里保留宿主已有的展示配置。
      config.provider[ID] = { ...was, name: was.name || "TRAE 私有化", npm: "@ai-sdk/openai-compatible", models: was.models ?? {} }
    },
    "chat.headers": async (input, output) => {
      const id = input?.model?.providerID ?? input?.provider?.info?.id
      if (id !== ID || !input?.sessionID) return
      output.headers[SESSION] = String(input.sessionID).slice(0, 128)
    },
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        if (!auth) return {}
        const account = authAccount(auth)
        const models = {}
        for (const m of reported(await catalogFor(account.base, account.access), input)) {
          const was = provider.models?.[m.id] ?? {}
          models[m.id] = { ...was, ...modelEntry(m), name: was.name || m.name }
        }
        return models
      },
    },
    auth: {
      provider: ID,
      refreshLead: REFRESH_MARGIN,
      options: [
        {
          key: MAX_WINDOW_KEY,
          label: "按上游完整上下文窗口上报",
          description:
            "默认尊重目录声明；未声明时按 128000 上报。开启后至少上报 1000000（可由 TRAE_PRIVATE_CONTEXT 覆盖），不会降低更大窗口。仅在部署确认支持时开启。",
          default: false,
        },
      ],
      // 用量卡片：JWT GetUserInfo 为主（席位/权益/个人额度），网页会话可用时
      // 追加基础/超额/企业内置模型明细（只读，会话失效自动回落并提示补录）。
      usage: async (getAuth) => {
        try {
          const account = authAccount(await getAuth())
          const card = usageCardOf(await getUserInfo(account.base, account.access))
          let cookie = readWebSession(account)
          if (!cookie) {
            // 自愈迁移：旧版插件的会话文件仍有效就采纳并落位。
            for (const path of legacySessionCandidates(account)) {
              const value = legacyCookieOf(path, account)
              if (!value) continue
              try {
                await quotaWithSession(account.base, value)
                writeWebSession(account, value)
                cookie = value
                break
              } catch {}
            }
          }
          if (!cookie) {
            card.hint = webSessionHint(account)
            return card
          }
          try {
            return mergeSessionUsage(card, await quotaWithSession(account.base, cookie))
          } catch {
            card.hint = webSessionHint(account)
            return card
          }
        } catch (e) {
          return { windows: [], error: String(e?.message || e), signIn: e.signIn || "kept" }
        }
      },
      // 协议原生续期：ExchangeToken 轮换，无计费副作用。必须把轮换后的
      // refresh token 写回返回值，否则旧 token 已作废、账号会被锁死。
      async refresh(auth) {
        const account = authAccount(auth)
        const tokens = await exchangeRefreshToken(account.base, account.refresh)
        const { traeHome, webSession, ...safe } = auth
        return { ...safe, ...tokens, protocol: 2, clientID: EXCHANGE_CLIENT_ID, lastRefresh: Date.now() }
      },
      loader: async (getAuth) => {
        return {
          baseURL: "https://unconnected.invalid/v1",
          apiKey: "trae-private",
          async fetch(input, init = {}) {
            let account, items
            try {
              account = authAccount(await getAuth())
              if (account.expires && account.expires <= Date.now()) {
                return errorResponse(401, "令牌已过期且未能续期；请重新登录", "expired")
              }
              items = await catalogFor(account.base, account.access)
            } catch (e) {
              return errorResponse(e.signIn ? 401 : (e.status || 502), String(e?.message || e), e.signIn || "kept")
            }
            const request = input instanceof Request ? input : null
            let raw = init.body ?? (request ? await request.text() : "")
            if (raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw)
            else if (ArrayBuffer.isView(raw)) raw = new TextDecoder().decode(raw)
            let req
            try { req = JSON.parse(raw || "{}") } catch { return errorResponse(400, "请求体不是 JSON") }
            if (!req || typeof req !== "object" || Array.isArray(req)) return errorResponse(400, "请求体必须是 JSON 对象")
            if (!messagesOf(req).length) return errorResponse(400, "没有可发送的对话内容")
            const known = items.find((m) => m.id === req.model || m.wire === req.model)
            if (!known) return errorResponse(400, `模型不在所选账号目录中：${req.model}`)
            const only = typeof req.tool_choice === "object" ? req.tool_choice?.function?.name : ""
            if (only && !toolsOf(req)?.length) return errorResponse(400, "tool_choice 指定的函数不在 tools 中")
            const headers = new Headers(init.headers ?? request?.headers ?? {})
            const session = sessionOf(headers)
            const ac = new AbortController()
            const outer = init.signal ?? request?.signal ?? null
            const onAbort = () => ac.abort(outer.reason)
            if (outer) {
              if (outer.aborted) onAbort()
              else outer.addEventListener("abort", onAbort, { once: true })
            }
            let res
            let it
            let handedOff = false
            let closed = false
            const close = async () => {
              if (closed) return
              closed = true
              outer?.removeEventListener("abort", onAbort)
              ac.abort()
              if (it) await it.return?.().catch(() => {})
              else await res?.body?.cancel().catch(() => {})
            }
            try {
              ac.signal.throwIfAborted()
              const wireBody = sendable(chatBody(req, session, items))
              const protocol = protocolConfig()
              res = await fetch(sameOriginPath(account.base, "/api/ide/v2/llm_raw_chat"), {
                method: "POST",
                redirect: "error",
                headers: {
                  Authorization: `Cloud-IDE-JWT ${account.access}`,
                  "Content-Type": "application/json",
                  Accept: "text/event-stream",
                  "x-app-id": protocol.appId,
                  "x-ide-function": "chat",
                  "x-ide-version-code": protocol.ideVersionCode,
                  "x-ide-version": protocol.ideVersion,
                  version: protocol.version,
                  originator: protocol.originator,
                  "User-Agent": protocol.userAgent,
                },
                body: wireBody,
                signal: ac.signal,
              })
              if (!res.ok) {
                const text = await res.text()
                return errorResponse(res.status === 401 ? 401 : res.status, shortError(text), res.status === 401 ? "expired" : undefined)
              }
              const type = res.headers.get("content-type") || ""
              if (!type.includes("event-stream")) {
                const text = await res.text()
                try {
                  const o = JSON.parse(text)
                  if (o.error || o.message) return errorResponse(502, shortError(o.error || o.message))
                } catch {}
                return errorResponse(502, shortError(text))
              }
              it = sse(res.body, ac.signal)[Symbol.asyncIterator]()
              const seenCalls = new Set()
              let first = null
              for (;;) {
                const n = await it.next()
                if (n.done) return errorResponse(502, "私有化 TRAE 没有返回内容")
                const p = piece(n.value, seenCalls)
                if (p.error) return errorResponse(p.status || 502, p.error, p.signIn, p.code)
                if (p.text || p.reasoning || p.calls?.length || p.usage || p.finish || p.done) {
                  first = n.value
                  break
                }
              }
              if (req.stream !== true) {
                const all = await collect(first, it)
                if (all.error) return errorResponse(all.errorStatus || 502, all.error, all.errorSignIn, all.errorCode)
                const message = { role: "assistant", content: all.text || (all.calls.length ? "" : all.reasoning) }
                if (all.reasoning) message.reasoning_content = all.reasoning
                if (all.calls.length) message.tool_calls = all.calls.map(({ index, ...c }) => c)
                const payload = {
                  id: `chatcmpl-${randomUUID()}`,
                  object: "chat.completion",
                  created: Math.floor(Date.now() / 1000),
                  model: req.model,
                  choices: [
                    { index: 0, message, finish_reason: all.finish || (all.calls.length ? "tool_calls" : "stop") },
                  ],
                }
                if (all.usage) payload.usage = all.usage
                return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } })
              }
              const response = streamResponse(req.model, first, it, close)
              handedOff = true
              return response
            } catch (e) {
              if (e.status) return errorResponse(e.status, e.message, e.signIn)
              return errorResponse(502, ac.signal.aborted ? "请求已取消" : `读取私有化 TRAE 响应失败：${e.message}`)
            } finally {
              if (!handedOff) await close()
            }
          },
        }
      },
      methods: [
        {
          type: "oauth",
          label: "登录企业 TRAE（浏览器 SSO）",
          prompts: [
            {
              type: "text",
              key: "baseURL",
              message: "企业地址",
              placeholder: "https://…",
              validate: (v) => parseBaseURL(v).error,
            },
          ],
          authorize: (inputs) => authorizeSso(inputs),
        },
        {
          type: "oauth",
          label: "从本机 traecli 导入登录",
          prompts: [
            { type: "text", key: "baseURL", message: "企业地址", placeholder: "https://…", validate: (v) => parseBaseURL(v).error },
            { type: "text", key: "traeHome", message: "traecli 目录（默认 ~/.trae）", placeholder: join(homedir(), ".trae"),
              validate: (v) => (v && !isAbsolute(v) ? "填本机绝对路径" : undefined) },
          ],
          authorize: (inputs) => importFromCli(inputs),
        },
      ],
    },
  }
}

// 测试辅助挂在一个对象上；入口导出的其他函数都会被宿主当成插件调用。
export const _internal = {
  ID,
  APP_ID,
  EXCHANGE_CLIENT_ID,
  OAUTH_CLIENT_ID,
  protocolConfig,
  parseBaseURL,
  checkedBase,
  sameOriginPath,
  apiPost,
  getUserInfo,
  checkLogin,
  exchangeRefreshToken,
  grantOf,
  fetchConfigList,
  catalogOf,
  catalogFor,
  usageCardOf,
  mergeSessionUsage,
  quotaWithSession,
  webSessionFile,
  readWebSession,
  writeWebSession,
  parseCookieValue,
  legacySessionCandidates,
  legacyCookieOf,
  webSessionHint,
  monthResetAt,
  identityOf,
  identityFromUserInfo,
  authorizeSso,
  importFromCli,
  authorizationURL,
  startCallbackServer,
  loginBaseFor,
  authAccount,
  modelEntry,
  reported,
  chatBody,
  messagesOf,
  partsOf,
  toolsOf,
  toolChoiceOf,
  fitBody,
  dropImages,
  truncateTools,
  sendable,
  sse,
  piece,
  callsOf,
  tokenUsageOf,
  collect,
  streamResponse,
  shortError,
  errorResponse,
  traeHome,
  loginTimeout: LOGIN_WAIT,
}
