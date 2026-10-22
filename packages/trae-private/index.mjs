// Private TRAE CLI deployments using /api/ide/v2/llm_raw_chat.
// The CLI owns login/renewal; deployment details come from options or its files.
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const ID = "trae-private"
const SESSION = "x-trae-private-session"

function baseURL(value) {
  if (!value) return ""
  let url
  try { url = new URL(value) } catch { throw new Error("TRAE baseURL must be a valid HTTPS URL") }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("TRAE baseURL must be HTTPS, without credentials, query or fragment")
  }
  return url.href.replace(/\/+$/, "")
}

// A cached model is advertised at the window its own CLI catalog declares:
// `max_context_window` when the deployment names a `__max` backend, else
// `context_window`. The window a deployment's endpoint really accepts is the
// deployment's own measurement — one reference deployment took 933342 tokens
// and refused 1048566 — so raising it is the `max-context-window` switch or
// `limits.context`, never an assumption made here for every deployment.
// A deployment that has not measured its endpoint gets the cache's own figure.
const DEFAULT_CONTEXT = 200000
const DEFAULT_OUTPUT = 32000
// The raw-chat endpoint's front proxy rejects large request bodies with 413:
// the reference deployment accepted 9.5MB and refused 10MB, which has nothing
// to do with the model's context. Base64 images inside tool results are resent
// every turn, so one long session reaches that wall even at 18% of its window
// (a 172k-token session held 26.7MB of tool results, 29.8MB of it base64).
const DEFAULT_BODY_BYTES = 9 * 1024 * 1024
const DEFAULT_TOOL_KEEP = 20000
// auth.options 的键，magpie 供应商编辑器里那个 Off/On 开关。
const MAX_WINDOW_KEY = "max-context-window"

// contextOf is the window the CLI catalog declares for this model, or the
// deployment's own default when it declares none.
function contextOf(m, fallback) {
  const declared = declaredOf(m)
  return declared > 0 ? declared : fallback
}

// declaredOf is the window the CLI catalog itself claims, kept so the switch
// can fall back to it: 0 when the cache names none.
function declaredOf(m) {
  const max = Number(m.business_metadata?.variants?.max_context_window)
  if (Number.isSafeInteger(max) && max > 0) return max
  const dev = Number(m.context_window)
  if (Number.isSafeInteger(dev) && dev > 0) return dev
  return 0
}

// A deployment's quota API is its own: the reference one answers POST with a
// session cookie, not the CLI's Cloud-IDE-JWT, so the CLI token cannot read it
// (that API replies "请先登录"). A deployment names its own endpoints and where
// the cookie comes from; without `usage`, the card shows no numbers at all
// rather than made-up ones.
//
//   "usage": {
//     "cookieFile": "/absolute/path/to/cookie",   // one line: the session value
//     "cookieName": "X-Cloudide-Tob-Session",
//     "quotaPath": "/trae/gtm/tob/api/v1/config/get_personal_quota",
//     "usagePath": "/trae/gtm/tob/api/v1/config/get_user_model_usage"
//   }
function usageSourceOf(usage) {
  if (usage === undefined) return null
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) throw new Error("TRAE usage must be an object")
  const need = ["cookieFile", "quotaPath", "usagePath"]
  for (const key of need) {
    if (typeof usage[key] !== "string" || !usage[key].trim()) throw new Error(`TRAE usage.${key} must be a path or name`)
  }
  return {
    cookieFile: usage.cookieFile,
    cookieName: String(usage.cookieName || "X-Cloudide-Tob-Session"),
    quotaPath: usage.quotaPath,
    usagePath: usage.usagePath,
    quotaField: String(usage.quotaField || "user_model_quota"),
    seatLimitKey: String(usage.seatLimitKey || "seat_pool_currency_quota"),
    paygoLimitKey: String(usage.paygoLimitKey || "paygo_currency_quota"),
  }
}

// readCookie reads the session value a quota API expects. A cookie value may
// itself contain "=" (base64 padding does), so a file holding just the value is
// taken whole. A file that names it — "Name=value" where Name is this
// deployment's cookieName — has that one prefix removed.
function readCookie(file, cookieName) {
  try {
    const raw = readFileSync(file, "utf8").trim()
    if (!raw) return ""
    if (cookieName && raw.startsWith(`${cookieName}=`)) return raw.slice(cookieName.length + 1).trim()
    return raw
  } catch {
    return ""
  }
}

function settingsOf(options) {
  const client = options.client ?? {}
  const settings = {
    traeHome: options.traeHome || process.env.TRAE_HOME || join(homedir(), ".trae"),
    baseURL: baseURL(options.baseURL),
    appId: String(options.appId || "").trim(),
    limits: limitsOf(options.limits),
    usage: usageSourceOf(options.usage),
    client: {
      "x-ide-version-code": client.ideVersionCode ?? "20260206",
      "x-ide-version": client.ideVersion ?? "99.99.99",
      version: client.version ?? "0.201.1-tob-alpha.1",
      "User-Agent": client.userAgent ?? `codex_exec/0.201.1-tob-alpha.1 (magpie; ${process.platform}; ${process.arch})`,
    },
  }
  if (options.models !== undefined) {
    if (!Array.isArray(options.models)) throw new Error("TRAE models must be an array")
    settings.models = options.models.map((m) => {
      if (!m || typeof m.id !== "string" || !m.id.trim()) throw new Error("Each TRAE model needs an id")
      for (const key of ["context", "output"]) {
        if (m[key] !== undefined && (!Number.isSafeInteger(m[key]) || m[key] <= 0)) {
          throw new Error(`TRAE model ${key} must be a positive integer`)
        }
      }
      return { id: m.id, name: m.name || m.id, wire: m.wire || m.id, context: m.context ?? settings.limits.context,
        declared: m.context ?? settings.limits.context,
        declaredMax: 0,
        output: m.output ?? settings.limits.output, image: m.image === true, reasoning: m.reasoning === true, raw: true }
    })
  }
  return settings
}

// limitsOf is what a cache model is told it takes: the deployment's own
// numbers, since only it knows how much its raw-chat endpoint accepts.
function limitsOf(limits) {
  const out = { context: DEFAULT_CONTEXT, output: DEFAULT_OUTPUT, bodyBytes: DEFAULT_BODY_BYTES, toolResultKeep: DEFAULT_TOOL_KEEP }
  if (limits === undefined) return out
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) throw new Error("TRAE limits must be an object")
  for (const key of ["context", "output", "bodyBytes", "toolResultKeep"]) {
    if (limits[key] === undefined) continue
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) throw new Error(`TRAE limits.${key} must be a positive integer`)
    out[key] = limits[key]
  }
  return out
}

// A CLI renewal writes auth.json in place, so a read can land on a half-written
// file. A missing file is "no login"; a file that will not parse is "unknown",
// which must not be reported as a logout — that would mark the account expired
// and drop the provider. `unknown` is set only when the bytes are there and the
// parse fails.
class Unreadable extends Error {}

function readJsonOnce(path) {
  let raw
  try {
    raw = readFileSync(path, "utf8")
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null
    throw new Unreadable(`${path} could not be read: ${e?.code || e?.message || e}`)
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new Unreadable(`${path} is not valid JSON (a CLI write may be in progress)`)
  }
}

// readJson retries once after a short pause before giving up, so a single
// unlucky read during a renewal is not treated as a broken file.
function readJson(path, wait = true) {
  try {
    return readJsonOnce(path)
  } catch (e) {
    if (!(e instanceof Unreadable) || !wait) throw e
    const until = Date.now() + 120
    while (Date.now() < until) { /* a CLI write in flight resolves in a few ms */ }
    return readJsonOnce(path)
  }
}

// The last catalog that parsed: a reread that lands on a half-written cache
// serves this instead of losing every model.
let lastCatalog = null

// 本机 traecli 的登录。不把令牌写进错误信息。
function readLocal(settings) {
  const file = readJson(join(settings.traeHome, "cli", "auth.json"))
  const trae = file?.trae
  const token = typeof trae?.access_token === "string" ? trae.access_token : ""
  if (!token) return null
  const expiresAt = Date.parse(trae.expires_at || "")
  return {
    token,
    expires: Number.isFinite(expiresAt) ? expiresAt : 0,
    base: settings.baseURL || baseURL(trae.endpoints?.api_base_url),
    // What the CLI itself logged in to: a token is only meant for this one, so
    // an option naming another origin is refused rather than obeyed.
    loginOrigin: originOf(trae.endpoints?.api_base_url),
    // 账号名优先用邮箱，magpie 拿它区分多个账号。
    name: String(trae.user_email || trae.user_name || trae.user_id || "traecli"),
    uid: String(trae.user_id || trae.user_email || trae.user_name || ""),
  }
}

function originOf(value) {
  try {
    return new URL(value).origin
  } catch {
    return ""
  }
}

// A CLI login names the deployment its token was issued for. Sending that token
// to another origin would hand it to whoever the option points at, so the
// option only applies when the CLI file names no endpoint at all.
function checkOrigin(settings, local) {
  if (!local?.loginOrigin || !settings.baseURL) return
  if (originOf(settings.baseURL) !== local.loginOrigin) {
    throw Object.assign(
      new Error(`baseURL ${settings.baseURL} is not what the CLI logged in to (${local.loginOrigin}); ` +
        "remove the option or log the CLI in to that deployment"),
      { signIn: "kept" },
    )
  }
}

function catalog(settings) {
  if (settings.models) return settings.models
  const file = readJson(join(settings.traeHome, "cli", "models_cache.json"))
  const models = Array.isArray(file?.models) ? file.models : []
  const out = []
  for (const m of models) {
    if (!m || typeof m !== "object") continue
    const id = String(m.config_name || "")
    if (!id) continue
    if (m.visibility === "hidden" || m.supported_in_api === false) continue
    const surface = m.business_metadata?.uses_tob_raw_chat_surface !== false
    const wire = String(m.business_metadata?.variants?.standard_key || id)
    const modalities = Array.isArray(m.input_modalities) ? m.input_modalities : ["text"]
    const levels = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : []
    out.push({
      id,
      name: String(m.slug || id),
      context: contextOf(m, settings.limits.context),
      declared: declaredOf(m),
      // 部署自己声明的 __max 窗口（没有就是 0）：开关不覆盖它。
      declaredMax: Number(m.business_metadata?.variants?.max_context_window) || 0,
      output: Number(m.max_output_tokens) || settings.limits.output,
      raw: surface,
      wire,
      image: modalities.includes("image"),
      reasoning: Boolean(m.default_reasoning_level) || levels.length > 0,
    })
  }
  if (out.length) lastCatalog = out
  return out
}

function connectedLocal(settings, auth) {
  if (!settings.appId) throw new Error("Set the private deployment's appId in plugin options")
  const local = readLocal(settings)
  if (!local) {
    throw Object.assign(new Error("本机没有 traecli 登录，先在终端执行 traecli login"), { signIn: "expired" })
  }
  if (!local.base) throw new Error("Set baseURL in plugin options or log in with a CLI that saves endpoints.api_base_url")
  checkOrigin(settings, local)
  if (!local.uid) throw new Error("The CLI login has no user identity; sign in again with traecli")
  if (auth && (auth.source !== "trae-private-cli" || auth.uid !== local.uid ||
    auth.baseURL !== local.base || auth.appId !== settings.appId)) {
    throw Object.assign(new Error("CLI 账号或私有化部署已更改，请在 Magpie 重新连接此供应商"), { signIn: "expired" })
  }
  if (local.expires && local.expires <= Date.now()) {
    throw new Error("本机 traecli 登录已过期，请先在 traecli 中刷新登录")
  }
  return local
}

function sumCost(list) {
  let total = 0
  for (const x of list || []) total += Number(x?.total_cost_currency) || 0
  return total
}

function monthResetAt() {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0).toISOString()
}

function yuan(n) {
  return Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// magpie lets `used` pass 100 when a window is overspent, so the real share is
// reported rather than capped.
function pct(used, limit) {
  if (!(limit > 0)) return 0
  return Math.max(0, (used / limit) * 100)
}

// An administrator may raise or lower either allowance at any moment, so every
// figure is recomputed from the reply rather than assumed to grow:
//   - a limit lowered under what is already spent caps at 100% and says how
//     much is over, instead of hiding an overdraft behind a bare 100%;
//   - an allowance set to 0 or removed drops its window, rather than showing 0%;
//   - both removed says so, instead of drawing an empty card that reads as a
//     failed read.
// Amounts are currency: the reference deployment bills in yuan, and the usage
// list carries total_cost_currency per model.
function quotaOf(source, quota, usage) {
  const q = quota?.[source.quotaField] || {}
  const lists = Array.isArray(usage?.user_usage_list) ? usage.user_usage_list : []
  const seatLimit = Number(q[source.seatLimitKey]) || 0
  const paygoLimit = Number(q[source.paygoLimitKey]) || 0
  const seatModels = lists[0]?.in_seat_detail?.chat_usage_details || []
  const overModels = lists[1]?.model_usage_detail_list || lists[1]?.in_seat_detail?.chat_usage_details || []
  const seatUsed = sumCost(seatModels)
  const overUsed = sumCost(overModels)

  const out = { windows: [], resets: { until: monthResetAt() } }
  const push = (name, used, limit) => {
    const w = {
      name,
      used: Math.round(pct(used, limit) * 100) / 100,
      // magpie reads span as a number of seconds; "month" reads as 0.
      span: 2592000,
      amount: Math.round(used * 1000) / 1000,
      limit,
      unit: "元",
      display: `￥${yuan(used)} / ￥${yuan(limit)}`,
      resetsAt: monthResetAt(),
    }
    // Under a cent is billing rounding (200.212 against 200), not an overdraft.
    // Compare the raw gap: rounding to cents first would turn 0.011 into 0.01
    // and hide a real overdraft.
    const gap = used - limit
    if (gap > 0.01) {
      w.over = Math.round(gap * 1000) / 1000
      w.display = `￥${yuan(used)} / ￥${yuan(limit)} (￥${yuan(gap)} over)`
    }
    out.windows.push(w)
  }
  if (seatLimit > 0) push("Seat usage", seatUsed, seatLimit)
  if (paygoLimit > 0) push("Pay-as-you-go", overUsed, paygoLimit)

  // What can still be spent: the seat allowance is drawn first, so the paygo
  // remainder only counts once the seat one is gone. Adding both would overstate
  // what is left the moment the paygo allowance is full.
  const seatLeft = Math.max(0, seatLimit - seatUsed)
  const overLeft = Math.max(0, paygoLimit - overUsed)
  // magpie keeps balance only when it is a string.
  if (seatLimit > 0 || paygoLimit > 0) {
    out.balance = yuan(seatLeft > 0 ? seatLeft : overLeft)
  }
  else out.error = "Both allowances are set to 0"

  const models = []
  for (const x of seatModels) {
    const cost = Number(x?.total_cost_currency) || 0
    if (!cost) continue
    models.push({ name: x.display_name || x.config_name, cost: Math.round(cost * 1000) / 1000,
      tokens: Number(x.total_token_usage) || 0 })
  }
  models.sort((a, b) => b.cost - a.cost)
  if (models.length) {
    out.metadata = { models, currency: "CNY", seatUsed: Math.round(seatUsed * 1000) / 1000,
      paygoUsed: Math.round(overUsed * 1000) / 1000, asOf: new Date().toISOString() }
  }
  return out
}

// A cookie must never leave the deployment it belongs to: the path has to be a
// plain absolute path on the same origin, and a redirect is refused rather than
// followed to another host.
function sameOriginPath(base, path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    throw new Error(`TRAE usage path must be a single "/"-prefixed path: ${path}`)
  }
  const root = new URL(base)
  const url = new URL(path, `${root.origin}/`)
  if (url.origin !== root.origin) throw new Error(`TRAE usage path leaves the deployment origin: ${path}`)
  return url.href
}

async function sessionPost(url, cookieName, cookie) {
  const res = await fetch(url, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json", Accept: "application/json", Cookie: `${cookieName}=${cookie}` },
    body: "{}",
  })
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  const data = await res.json()
  if (data?.code !== undefined && data.code !== 0) throw new Error(`${url} -> ${data.code} ${data.message || ""}`.trim())
  return data
}

function modelEntry(m) {
  return {
    id: m.id,
    name: m.name,
    providerID: ID,
    limit: { context: m.context, output: m.output },
    api: { id: m.id, npm: "@ai-sdk/openai-compatible" },
    capabilities: {
      reasoning: m.reasoning,
      temperature: true,
      toolcall: true,
      attachment: m.image,
      input: { text: true, image: m.image, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
  }
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
    // 助手发起的工具调用，按 LLMRawToolCall 原样回填，否则下一轮上游看不到
    // 自己调用过什么，会重复调用或报工具结果没有对应调用。
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
      if (tool_calls.length) {
        out.push({ role, content, tool_calls })
        continue
      }
    }
    // 工具执行结果要带上 tool_call_id，上游靠它和调用配对。
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

// 上游只接受 auto/none/required 字符串，实测 OpenAI 的对象形式（指定函数）会让它
// HTTP 500。对象形式只保留指定工具，再配 required。
function toolChoiceOf(value) {
  if (value === "auto" || value === "none" || value === "required") return value
  if (value && typeof value === "object") return "required"
  return undefined
}

function roughBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8")
  } catch {
    return 0
  }
}

function isImage(part) {
  return part?.type === "image_url" || Boolean(part?.image_url)
}

function imageCount(messages) {
  let n = 0
  for (const m of messages) for (const p of m.content || []) if (isImage(p)) n++
  return n
}

// dropImages keeps the newest `keep` images and drops older ones: the last
// image is usually the one this turn is about.
// dropImages keeps the newest `keep` images and drops older ones: the last
// image is usually the one this turn is about. A dropped image leaves a text
// placeholder, so the model is told an image was there and a turn never ends up
// with an empty content array.
function dropImages(messages, keep) {
  let seen = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!Array.isArray(m.content)) continue
    const kept = []
    for (let j = m.content.length - 1; j >= 0; j--) {
      const p = m.content[j]
      if (!isImage(p)) {
        kept.unshift(p)
        continue
      }
      seen++
      if (seen <= keep) kept.unshift(p)
      else kept.unshift({ type: "text", text: "[image omitted: request-body limit]" })
    }
    m.content = kept
  }
  return seen > keep ? seen - keep : 0
}

// truncateTools keeps the head of an oversized tool result and says how much
// went, so a model still sees what the tool said before the cut.
function truncateTools(messages, keep) {
  let n = 0
  for (const m of messages) {
    if (m.role !== "tool" || !Array.isArray(m.content)) continue
    for (const p of m.content) {
      if (p?.type !== "text" || typeof p.text !== "string" || p.text.length <= keep) continue
      const total = p.text.length
      p.text = `${p.text.slice(0, keep)}\n\n[trae-private: this tool result was ${total} characters; the last ${total - keep} were cut to stay under the endpoint's request-body limit]`
      n++
    }
  }
  return n
}

// fitBody trims a body to the endpoint's byte budget before it is sent.
function fitBody(body, limits) {
  const budget = limits?.bodyBytes ?? DEFAULT_BODY_BYTES
  const keep = limits?.toolResultKeep ?? DEFAULT_TOOL_KEEP
  const notes = { droppedImages: 0, truncatedTools: 0, bytes: roughBytes(body) }
  if (notes.bytes <= budget) return notes
  if (imageCount(body.messages) > 1) {
    notes.droppedImages += dropImages(body.messages, 1)
    notes.bytes = roughBytes(body)
  }
  if (notes.bytes > budget) {
    notes.droppedImages += dropImages(body.messages, 0)
    notes.bytes = roughBytes(body)
  }
  if (notes.bytes > budget) {
    notes.truncatedTools += truncateTools(body.messages, keep)
    notes.bytes = roughBytes(body)
  }
  return notes
}

// sendable drops the plugin's own bookkeeping before the body goes out.
function sendable(body) {
  const { fitted, ...wire } = body
  return JSON.stringify(wire)
}

function chatBody(req, session, models = [], limits = undefined) {
  const id = String(req.model || "")
  const known = models.find((m) => m.id === id)
  const body = {
    config_name: id,
    model_name: known?.wire || id,
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
  const max = req.max_completion_tokens ?? req.max_tokens
  if (Number.isFinite(max) && max > 0) body.max_tokens = Math.floor(max)
  // The model entries advertise temperature: true, so a client-set temperature
  // is forwarded rather than silently dropped.
  for (const key of ["temperature", "top_p", "stop"]) {
    if (req[key] !== undefined) body[key] = req[key]
  }
  // The endpoint refuses by request-body bytes, not by tokens: trim oversized
  // history here instead of passing a 413 on for the agent to compact.
  body.fitted = fitBody(body, limits)
  return body
}

function shortError(text) {
  const raw = String(text || "").trim()
  const i = raw.indexOf("origin err")
  const line = (i >= 0 ? raw.slice(i + "origin err".length).replace(/^\s*=\s*/, "") : raw).split("\n")[0]
  return line.trim().slice(0, 300) || "私有化 TRAE 没有返回可读错误"
}

function errorResponse(status, message, signIn) {
  const headers = { "content-type": "application/json" }
  // magpie 靠 X-Magpie-Sign-In 判断要不要把账号标成失效；本机没登录就是失效，
  // 请求体或模型不对这种 400 不该连累账号。
  if (signIn) headers["X-Magpie-Sign-In"] = signIn
  return new Response(JSON.stringify({ error: { message, type: status === 401 ? "authentication_error" : "server_error" } }), {
    status,
    headers,
  })
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
    try {
      value = JSON.parse(raw)
    } catch {}
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
        if (!line) {
          yield* flush()
          continue
        }
        if (line.startsWith(":")) continue
        if (line.startsWith("event:")) {
          yield* flush()
          event = line.slice(6).trim()
        } else if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
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

// 上游的工具调用在 event: output 的 tool_calls 里，function_call 包着 name/arguments；
// 转成 chat completions 的 function，不然 agent 收不到工具调用。
// callsOf turns upstream tool calls into chat-completion deltas. Upstream sends
// the id only on a call's first frame, so that frame gets `call_<index>` when
// the id is missing (collect() already did this) — an empty id would leave
// ai-sdk unable to pair the tool result. Later frames leave id and name off.
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

function usageOf(data) {
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

// 排队事件只是等待信号，不是回答内容。它们的 data 可能是字符串，不拦的话会
// 被当成正文混进回答。
const QUEUE_EVENTS = new Set(["queue_begin", "request_wait_in_queue", "queue_end", "queue_position"])

// 上游认为不正常的结束原因（内容安全拦截等），正常的只有 stop/tool_calls/length。
const BAD_FINISH = /risk|filter|security|intercept|safety|block|moderation/i

function piece(ev, seenCalls) {
  const data = ev?.data
  const event = ev?.event || ""
  // progress_notice 是占位心跳（";Processing_…"），不是回答内容。
  if (event === "progress_notice" || QUEUE_EVENTS.has(event)) return {}
  const obj = data && typeof data === "object" ? data : null
  // event: error 的 data 是 {code, error}；少数情况下也可能直接是个字符串。
  if (event === "error" || obj?.error) return { error: shortError(obj ? obj.error || obj.message : data) }
  // 内容安全拦截：traecli 的 ContentSecurityEvent 带 hit_rule_name/action_type/execute_point，
  // 必须变成错误，不能静默丢弃让 agent 以为模型无话可说。
  const security = obj && (obj.hit_rule_name || obj.action_type || obj.execute_point)
  if (event === "content_security" || (security && event !== "output" && event !== "done")) {
    const rule = typeof obj?.hit_rule_name === "string" && obj.hit_rule_name ? `（命中规则 ${obj.hit_rule_name}）` : ""
    return { error: `内容被上游安全策略拦截${rule}` }
  }
  if (event === "token_usage") return { usage: usageOf(data) }
  // 其余事件（metadata/timing_cost/extra_info 以及没见过的）都不携带回答内容；
  // 只有 output/done 的 response、reasoning_content、tool_calls 算内容。
  if (event !== "output" && event !== "done") return {}
  if (!obj) return { text: typeof data === "string" ? data : "", done: event === "done" }
  const finish = typeof obj.finish_reason === "string" ? obj.finish_reason : ""
  if (finish && BAD_FINISH.test(finish)) return { error: `上游中止了回答（finish_reason: ${finish}）`, finish }
  return {
    text: typeof obj.response === "string" ? obj.response : "",
    reasoning: typeof obj.reasoning_content === "string" ? obj.reasoning_content : "",
    calls: callsOf(obj, seenCalls),
    finish,
    // A finish_reason on an output frame is not the end of the stream: upstream
    // sends token_usage, and a usage inside the done event, after it. Ending
    // there loses them, so only the done event ends the stream and the caller
    // treats EOF after a finish as complete.
    done: event === "done",
    // The done event can carry usage as well as a separate token_usage frame.
    usage: event === "done" ? usageOf(obj) : undefined,
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
          yield { error: { message: p.error, type: "server_error" } }
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
        if (p.done) {
          done = true
          break
        }
        const n = await rest.next()
        if (n.done) break
        ev = n.value
      }
      // Same rule as collect(): a finish_reason then EOF is a complete reply.
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
  let finish = ""
  let usage = null
  let done = false
  const calls = []
  const seenCalls = new Set()
  const take = (ev) => {
    const p = piece(ev, seenCalls)
    if (p.done) done = true
    if (p.usage) usage = p.usage
    if (p.error) error = p.error
    else {
      text += p.text || ""
      reasoning += p.reasoning || ""
      if (p.finish) finish = p.finish
      // 同一个 index 的分片参数要拼起来，上游可能分多帧发。
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
  // EOF after a finish_reason is a complete reply: upstream may close without a
  // done event. Only a stream that ends with neither is incomplete.
  if (!done && !error && !finish) error = INCOMPLETE
  // 上游始终会带 id；万一没带，按 index 造一个，agent 配对工具结果时要用。
  for (const c of calls) {
    if (!c.id) c.id = `call_${c.index}`
    if (!c.function.arguments && done && !error) c.function.arguments = "{}"
  }
  return { text, reasoning, error, finish, usage, calls }
}

export default async function TraePrivateAuthPlugin(input, options = {}) {
  return createPlugin(options, undefined, input)
}

// maxWindowOn is the "advertise the deployment's full window" switch as the
// user set it in magpie's provider editor. magpie hands it over through
// input.magpie.option and rereads it whenever it is changed, so a plugin that
// reads it per call follows the switch without a restart. Off, and the cache's
// own context_window is reported as it stands.
// The switch is off by default: the window a deployment's endpoint really takes
// is that deployment's own measurement, never assumed here.
function maxWindowOn(input) {
  try {
    const value = input?.magpie?.option?.(ID, MAX_WINDOW_KEY)
    return typeof value === "boolean" ? value : false
  } catch {
    return false
  }
}

function createPlugin(options = {}, upstreamFetch, input = undefined) {
  const fetchUpstream = upstreamFetch ?? ((...args) => globalThis.fetch(...args))
  const settings = settingsOf(options)
  // 开关关掉时只保留部署自己声明的窗口；打开时按 limits 抬到完整窗口。
  // 开关打开：按 limits.context 上报（部署自己量过）。关闭：用 CLI 缓存声明的窗口。
  // 部署若在缓存里声明了 __max 档，那是它自己的权威值，开关不覆盖。
  // 缓存没有声明窗口时（declared 为 0）回落到 limits.context，绝不报 0。
  // 注意 0 不是 undefined，?? 不会跳过它，必须显式判断。
  const pick = (...values) => {
    for (const v of values) {
      const n = Number(v)
      if (Number.isSafeInteger(n) && n > 0) return n
    }
    return DEFAULT_CONTEXT
  }
  const effective = (m) => maxWindowOn(input)
    // 开关打开：部署量过的 limits.context，但部署自己声明的 __max 档优先。
    ? { ...m, context: pick(m.declaredMax, settings.limits.context) }
    // 关闭：CLI 缓存声明的窗口，缓存没说才用 limits.context。
    : { ...m, context: pick(m.declared, settings.limits.context) }
  return {
    config: async (config) => {
      if (!settings.appId) return
      // A config hook that throws takes the whole plugin load down, so a bad
      // CLI file or an http:// endpoint skips the provider instead. Requests
      // then explain it; nothing else in magpie is affected.
      let base
      let available
      try {
        base = settings.baseURL || readLocal(settings)?.base
        available = catalog(settings).filter((m) => m.raw).map(effective)
      } catch {
        return
      }
      if (!base || !available.length) return
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      const models = {}
      // 这里的字段用 models.dev 的写法（tool_call / modalities），和 provider.models
      // 钩子的 capabilities 不同。漏掉 tool_call 时模型会被当成不会调工具。
      for (const m of available) {
        models[m.id] = {
          name: m.name,
          limit: { context: m.context, output: m.output },
          tool_call: true,
          reasoning: m.reasoning,
          modalities: { input: m.image ? ["text", "image"] : ["text"], output: ["text"] },
        }
        models[m.id] = { ...models[m.id], ...was.models?.[m.id] }
      }
      config.provider[ID] = {
        name: "TRAE Private CLI",
        npm: "@ai-sdk/openai-compatible",
        api: `${base}/v1`,
        ...was,
        models,
      }
    },
    "chat.headers": async (input, output) => {
      const id = input?.model?.providerID ?? input?.provider?.info?.id
      if (id !== ID || !input?.sessionID) return
      output.headers[SESSION] = String(input.sessionID).slice(0, 128)
    },
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        if (auth) connectedLocal(settings, auth)
        const models = {}
        for (const m of catalog(settings).filter((m) => m.raw).map(effective)) {
          const was = provider.models?.[m.id] ?? {}
          models[m.id] = { ...modelEntry(m), ...was, id: m.id, name: was.name || m.name }
        }
        return models
      },
    },
    auth: {
      provider: ID,
      refreshLead: 5 * 60 * 1000,
      options: [
        {
          key: MAX_WINDOW_KEY,
          label: "Advertise the deployment's full context window",
          description:
            "The CLI's models_cache.json reports only its default __dev backend (200000 in the reference deployment), which makes agents compact far too early; the raw-chat endpoint accepts about one million. On, models are reported with the limits option's window (1000000 by default). Off, the cache's own value is kept.",
          default: false,
        },
      ],
      // magpie's provider card reads this; OpenCode ignores it. The deployment
      // names where the numbers come from, and an unreadable source says why
      // rather than filling the card with invented figures.
      usage: async () => {
        if (!settings.usage) {
          return { windows: [], error: "Set the usage option to show this deployment's quota", signIn: "kept" }
        }
        const cookie = readCookie(settings.usage.cookieFile, settings.usage.cookieName)
        if (!cookie) {
          return { windows: [], error: `No session cookie in ${settings.usage.cookieFile}`, signIn: "kept" }
        }
        const base = settings.baseURL || readLocal(settings)?.base
        if (!base) return { windows: [], error: "Set baseURL or sign in with a CLI that saves it", signIn: "kept" }
        try {
          const [quota, usage] = await Promise.all([
            sessionPost(sameOriginPath(base, settings.usage.quotaPath), settings.usage.cookieName, cookie),
            sessionPost(sameOriginPath(base, settings.usage.usagePath), settings.usage.cookieName, cookie),
          ])
          return quotaOf(settings.usage, quota, usage)
        } catch (e) {
          return { windows: [], error: String(e?.message || e), signIn: "kept" }
        }
      },
      async refresh(auth) {
        let local
        try {
          local = connectedLocal(settings, auth)
        } catch (e) {
          // A half-written auth.json is not a logout: keep the account.
          if (e instanceof Unreadable) throw Object.assign(e, { signIn: "kept" })
          throw e
        }
        if (auth?.access === local.token && auth?.expires === local.expires) return
        return { access: local.token, refresh: "", expires: local.expires }
      },
      loader: async (getAuth) => {
        const saved = await getAuth()
        if (!saved) return {}
        return {
          baseURL: `${baseURL(saved.baseURL)}/v1`,
          apiKey: ID,
          async fetch(input, init = {}) {
            let local
            try {
              const auth = await getAuth()
              if (!auth) return errorResponse(401, "Connect the private TRAE CLI account first", "expired")
              local = connectedLocal(settings, auth)
            } catch (e) {
              // A file that is mid-write is a temporary condition: answer 503
              // with signIn "kept" so magpie keeps the account and retries,
              // instead of marking it signed out over a CLI write.
              if (e instanceof Unreadable) return errorResponse(503, e.message, "kept")
              return errorResponse(401, e.message, e.signIn || "kept")
            }
            const { token, base } = local
            const request = input instanceof Request ? input : null
            let raw = init.body ?? (request ? await request.text() : "")
            if (raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw)
            else if (ArrayBuffer.isView(raw)) raw = new TextDecoder().decode(raw)
            let req
            try {
              req = JSON.parse(raw || "{}")
            } catch {
              return errorResponse(400, "请求体不是 JSON")
            }
            if (!req || typeof req !== "object" || Array.isArray(req)) return errorResponse(400, "请求体必须是 JSON 对象")
            if (!messagesOf(req).length) return errorResponse(400, "没有可发送的对话内容")
            const models = catalog(settings)
            const known = models.find((m) => m.id === req.model)
            if (!known) return errorResponse(400, "Model is not in the CLI cache or plugin options")
            if (!known.raw) return errorResponse(400, `${req.model} 不走 llm_raw_chat，当前插件只转发 uses_tob_raw_chat_surface 的模型`)
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
              res = await fetchUpstream(`${base}/api/ide/v2/llm_raw_chat`, {
                method: "POST",
                redirect: "error",
                headers: {
                  Authorization: `Cloud-IDE-JWT ${token}`,
                  "Content-Type": "application/json",
                  Accept: "text/event-stream",
                  "x-app-id": settings.appId,
                  "x-ide-function": "chat",
                  originator: "codex_exec",
                  ...settings.client,
                },
                body: sendable(chatBody(req, session, models, settings.limits)),
                signal: ac.signal,
              })
              if (!res.ok) {
                const text = await res.text()
                return errorResponse(res.status, shortError(text))
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
              // 首帧可能只有排队或心跳；等到内容或错误再确定 HTTP 状态。
              const seenCalls = new Set()
              let first = null
              for (;;) {
                const n = await it.next()
                if (n.done) return errorResponse(502, "私有化 TRAE 没有返回内容")
                const p = piece(n.value, seenCalls)
                if (p.error) return errorResponse(502, p.error)
                if (p.text || p.reasoning || p.calls?.length || p.usage || p.finish || p.done) {
                  first = n.value
                  break
                }
              }
              // OpenAI treats a missing `stream` as false, and the
              // openai-compatible provider's doGenerate leaves it out.
              if (req.stream !== true) {
                const all = await collect(first, it)
                if (all.error) return errorResponse(502, all.error)
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
            } catch {
              return errorResponse(502, ac.signal.aborted ? "请求已取消" : "读取私有化 TRAE 响应失败")
            } finally {
              if (!handedOff) await close()
            }
          },
        }
      },
      methods: [
        {
          type: "api",
          label: "使用本机 traecli 登录",
          authorize: async () => {
            let local
            try {
              // connectedLocal 已含 origin 校验，这里不必重复。
              local = connectedLocal(settings)
              if (!catalog(settings).some((m) => m.raw)) {
                throw new Error("No raw-chat models: populate cli/models_cache.json with your CLI or set models in plugin options")
              }
            } catch (e) {
              return { type: "failed", error: e.message }
            }
            // magpie 依次用 accountId、metadata.email、email 给账号命名；name 不在其中。
            return {
              type: "success",
              access: local.token,
              refresh: "",
              expires: local.expires,
              accountId: `${local.name} (${local.base})`,
              uid: local.uid,
              source: "trae-private-cli",
              baseURL: local.base,
              appId: settings.appId,
            }
          },
        },
      ],
    },
  }
}

// 测试用。magpie 会把入口导出的每个函数当成插件调用，所以辅助函数必须挂在
// 一个对象上（社区插件的惯例是 _internal），不能逐个导出。
export const _internal = {
  createPlugin,
  catalog,
  quotaOf,
  usageSourceOf,
  readCookie,
  sessionPost,
  sameOriginPath,
  fitBody,
  dropImages,
  truncateTools,
  sendable,
  messagesOf,
  partsOf,
  toolsOf,
  toolChoiceOf,
  chatBody,
  callsOf,
  usageOf,
  piece,
  collect,
  shortError,
  sse,
  streamResponse,
}
