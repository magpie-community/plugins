export const ID = "loomy"
export const ACCOUNT_BASE = (process.env.LOOMY_XFYUN_BASE_URL || "https://account.xfinfr.com").replace(/\/+$/, "")
export const GATEWAY_BASE = (process.env.LOOMY_POINTS_BASE_URL || "https://loomyad.xunfei.cn").replace(/\/+$/, "")
export const APP_ID = process.env.LOOMY_XFYUN_APP_ID || "GM3LOOMY"
const ACCESS_KEY_ID = process.env.LOOMY_XFYUN_ACCESS_KEY_ID || "2thryby66wxi53sk"
const ACCESS_KEY_SECRET = process.env.LOOMY_XFYUN_ACCESS_KEY_SECRET || "zsak6eadrbawz683wf5r3m2snrwj868r"
export const SUCCESS = "000000"
const AUTH_ERRORS = new Set(["020002", "100002"])
const SESSION_TTL_MS = 14 * 24 * 3600 * 1000
const REQUEST_TIMEOUT_MS = 20_000

export const text = (value) => (typeof value === "string" ? value.trim() : "")
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {})
const number = (value) => {
  const n = typeof value === "number" ? value : Number.parseFloat(text(value))
  return Number.isFinite(n) ? Math.max(0, n) : 0
}
export const upstreamMessage = (payload) => text(payload?.desc) || text(payload?.message)
const isAuthError = (payload) => AUTH_ERRORS.has(text(payload?.code)) || text(payload?.message).toLowerCase().includes("登录态已失效")
export const sessionOf = (auth) => text(auth?.access) || text(auth?.key)

let nodeCrypto
async function crypto() {
  if (!nodeCrypto) nodeCrypto = await import("node:crypto")
  return nodeCrypto
}

function escapedPath(path) {
  const clean = path.startsWith("/") ? path : "/" + path
  const noTrailing = clean.length > 1 ? clean.replace(/\/+$/, "") : clean
  return noTrailing
    .split("/")
    .map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase()))
    .join("/")
}

async function signedHeaders(path, method, body) {
  const c = await crypto()
  const bodyText = body === undefined ? "" : JSON.stringify(body)
  const contentMD5 = bodyText ? c.createHash("md5").update(bodyText).digest("base64") : ""
  const date = new Date().toUTCString()
  const nonce = c.randomUUID()
  const contentType = "application/json"
  const lines = [method.toUpperCase(), escapedPath(path), "", contentMD5, contentType, date, nonce, "", ""]
  const signature = c.createHmac("sha1", ACCESS_KEY_SECRET).update(lines.join("\n")).digest("base64")
  return {
    Authorization: `account ${ACCESS_KEY_ID}:${signature}`,
    Date: date,
    Nonce: nonce,
    "Content-Type": contentType,
    ...(contentMD5 ? { "Content-MD5": contentMD5 } : {}),
  }
}

async function signedJSON(path, body, what) {
  const headers = await signedHeaders(path, "POST", body)
  const response = await fetch(ACCOUNT_BASE + path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch((e) => {
    throw new Error(`${what} failed: ${e?.message || e}`)
  })
  if (!response.ok) throw new Error(`${what} answered HTTP ${response.status}`)
  return response.json()
}

function tokenHeaders(session, extra = {}) {
  return { token: session, Authorization: `Bearer ${session}`, ...extra }
}

export async function tokenJSON(path, session, init = {}, what = "Loomy", timeoutMs = REQUEST_TIMEOUT_MS) {
  if (!session) throw Object.assign(new Error("Loomy sign-in is missing: sign in again"), { signIn: "expired" })
  const response = await fetch(GATEWAY_BASE + path, {
    ...init,
    headers: tokenHeaders(session, init.headers),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((e) => {
    throw new Error(`${what} failed: ${e?.message || e}`)
  })
  const payload = await response.json().catch(() => null)
  if (response.status === 401 || response.status === 403 || isAuthError(payload)) {
    throw Object.assign(new Error("Loomy sign-in expired: sign in again"), { signIn: "expired" })
  }
  if (!response.ok) throw new Error(`${what} answered HTTP ${response.status}${upstreamMessage(payload) ? `: ${upstreamMessage(payload)}` : ""}`)
  return payload
}

function makeBase(traceid) {
  return {
    appid: APP_ID,
    modelid: "Web",
    version: "1.0.0",
    devid: "web",
    ua: "Loomy|Desktop|Electron|macOS",
    traceid,
  }
}

function modelEntry(row) {
  const id = text(row?.id)
  if (!id) return null
  const rawName = text(row?.name) || id
  const match = rawName.match(/^(.*?)\s*(?:[(（]\s*[xX]\s*(\d+(?:\.\d+)?)\s*[)）])\s*$/)
  const name = match && text(match[1]) ? text(match[1]) : rawName
  const capability = object(row?.capabilities)
  const modalities = Array.isArray(capability.input_modalities)
    ? capability.input_modalities.map((x) => text(x).toLowerCase()).filter(Boolean)
    : []
  const context = ["context_length", "context_window", "input_token_limit", "max_input_tokens", "maxInputTokens"]
    .map((k) => number(row?.[k])).find((n) => n > 0) || 0
  const output = ["max_output_tokens", "max_completion_tokens", "max_tokens", "maxOutputTokens"]
    .map((k) => number(row?.[k])).find((n) => n > 0) || 0
  const model = {
    id,
    name,
    limit: { context, output },
    reasoning: capability.reasoning === true || id.toLowerCase().includes("spark-x"),
    tool_call: capability.function_calling === true || row?.capabilities == null,
    modalities: {
      input: modalities.length ? modalities : capability.vision === true ? ["text", "image"] : ["text"],
      output: ["text"],
    },
  }
  if (match?.[2]) model.rate = `x${match[2]}`
  return model
}

export async function getModels(session) {
  const payload = await tokenJSON("/api/v1/models", session, {}, "Loomy's model list")
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
  const models = {}
  for (const row of rows) {
    const model = modelEntry(row)
    if (model) models[model.id] = model
  }
  if (!Object.keys(models).length) throw new Error("Loomy returned no models")
  return models
}

let cachedModels = {}
export function rememberModels(models) {
  cachedModels = { ...models }
  return models
}

export async function modelsFor(auth) {
  const session = sessionOf(auth)
  if (!session) return { ...cachedModels }
  return rememberModels(await getModels(session))
}

export async function points(session) {
  const payload = await tokenJSON("/api/v2/points/records?pageNo=1&pageSize=1&direction=debit&granularity=chat", session, {}, "Loomy's points")
  const first = object(payload?.data)
  const data = object(first.data).balance != null ? object(first.data) : first
  const permanent = number(data.balance)
  const daily = number(data.dailyBalance)
  const windows = []
  if (data.dailyLimitPoints != null) {
    const used = number(data.dailyConsumedPoints)
    const limit = number(data.dailyLimitPoints)
    windows.push({
      name: "Daily gift points",
      used: limit > 0 ? Math.min(100, (used / limit) * 100) : 0,
      amount: used,
      limit,
      unit: "points",
      resetsAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    })
  }
  return { plan: `Loomy points · ${permanent} permanent + ${daily} daily`, balance: `${permanent + daily} points`, windows }
}

export function visionTag(part) {
  const type = text(part?.type).toLowerCase()
  if (type !== "image_url" && type !== "input_image") return null
  const raw = part?.image_url
  const url = text(object(raw).url) || text(raw)
  const match = url.match(/^data:([^,]*);base64,(.+)$/s)
  if (!match || !match[1].toLowerCase().includes("image/")) return null
  return `<image_base64>${match[2].trim()}</image_base64>`
}

export function rewriteDeepseekImages(body) {
  if (!text(body?.model).toLowerCase().includes("deepseek") || !Array.isArray(body?.messages)) return body
  let images = 0
  for (const message of body.messages) {
    if (!Array.isArray(message?.content)) continue
    for (const part of message.content) if (visionTag(part)) images++
  }
  if (!images) return body
  const messages = body.messages.map((message) => {
    if (!Array.isArray(message?.content)) return message
    const content = []
    for (const part of message.content) {
      const tag = visionTag(part)
      if (!tag) {
        content.push(part)
        continue
      }
      const last = content[content.length - 1]
      if (text(last?.type) === "text" && typeof last.text === "string") last.text += `\n${tag}`
      else content.push({ type: "text", text: tag })
    }
    return { ...message, content }
  })
  return { ...body, messages }
}

export function sessionFromPaste(value) {
  const session = text(value)
  if (session.length < 16) throw new Error("Paste the Loomy session from the desktop app")
  return { type: "oauth", access: session, refresh: "", expires: Date.now() + SESSION_TTL_MS, accountId: "loomy-session" }
}

export function parseSessionInput(value) {
  const raw = text(value)
  if (!raw) throw new Error("Paste the Loomy session from the desktop app, or its exported JSON")
  if (raw.startsWith("{")) {
    const saved = JSON.parse(raw)
    const auth = saved.auth ?? saved
    const session = text(auth.session) || text(auth.accessToken) || text(auth.access) || text(auth.token)
    if (!session) throw new Error("That JSON has no Loomy session")
    return {
      type: "oauth",
      access: session,
      refresh: "",
      expires: Date.now() + SESSION_TTL_MS,
      accountId: text(auth.userid) || text(auth.userId) || text(auth.uid) || text(auth.name) || "loomy-session",
      phone: text(auth.phone),
      uid: text(auth.userid) || text(auth.userId) || text(auth.uid),
    }
  }
  return sessionFromPaste(raw)
}


