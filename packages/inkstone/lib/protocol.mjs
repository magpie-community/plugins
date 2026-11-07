// The platform's endpoints, its console APIs, and the OpenAI-compatible
// catalogue. ENDPOINTS is a mutable object on purpose: the tests point it
// at a local fake (the same shape fake.mjs uses), so no test can reach the
// real platform. Production code reads the values at call time.
import { createHash } from "node:crypto"

export const ENDPOINTS = {
  console: "https://discovery.intern-ai.org.cn",
  api: "https://discovery-api.intern-ai.org.cn/v1",
}

export const PUBLIC_MODELS_PATH = "/api/tokenplan/v1/public/models"
export const CONSOLE_API = "/api/tokenplan/v1"

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"
const TIMEOUT_MS = 20_000

export const KEY_LIMIT = 10
export const KEY_NAME_LIMIT = 20

// Vendor text goes into logs and the account card, so it must not carry a
// credential. Only token-shaped runs are masked; the diagnostic words stay.
const SECRETISH =
  /(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}[A-Za-z0-9._-]*|Bearer\s+[A-Za-z0-9._~+/-]{12,}|(?:uaa[-_]?token|refresh[-_]?token|access[-_]?token|id[-_]?token)\s*[=:]\s*[A-Za-z0-9._~+/-]{12,}|sk-[A-Za-z0-9-]{8,})/gi

export function cleanDetail(value) {
  return String(value ?? "").replace(SECRETISH, "***")
}

export class ProtocolError extends Error {
  constructor(message, { status = 0, code = 0 } = {}) {
    super(message)
    this.name = "ProtocolError"
    this.status = status
    this.code = code
  }
}

/** Trim a pasted key: spaces, a stray `Bearer `, and wrapping quotes. */
export function normalizeApiKey(value) {
  let s = String(value ?? "").trim()
  if (/^bearer\s+/i.test(s)) s = s.replace(/^bearer\s+/i, "")
  return s.replace(/^["'`]|["'`]$/g, "").trim()
}

function clientHints() {
  return {
    "user-agent": UA,
    "sec-ch-ua": '"Chromium";v="152", "Not;A=Brand";v="24", "Google Chrome";v="152"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
  }
}

/** The console APIs' browser-shaped headers (the platform's WAF expects them). */
export function consoleHeaders(token, extra = {}) {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/json",
    "accept-language": "zh-CN",
    origin: ENDPOINTS.console,
    referer: `${ENDPOINTS.console}/token-plan/home`,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    ...clientHints(),
    ...extra,
  }
}

/**
 * Key 管理接口（/keys 的 GET/POST/DELETE）只认会话 cookie，不认 Bearer——
 * 2026-11-07 真机实测：Bearer 打 /keys 返回 -10002 "request is not
 * authenticated"，同一枚 token 作 cookie 就 200。额度接口恰好相反（只认
 * Bearer，见上）。所以 console* 系列带 auth 选项，keys.mjs 传 "cookie"。
 */
export function cookieHeaders(token, extra = {}) {
  return {
    accept: "application/json",
    "accept-language": "zh-CN",
    origin: ENDPOINTS.console,
    referer: `${ENDPOINTS.console}/token-plan/home`,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    ...clientHints(),
    cookie: `uaa-token=${token}`,
    ...extra,
  }
}

async function readJson(res, what) {
  const text = await res.text().catch(() => "")
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* a non-JSON body is handled by its status */
  }
  if (!res.ok) {
    const detail = cleanDetail(
      json?.msg || json?.message || json?.error?.message || text.slice(0, 200).trim() || `HTTP ${res.status}`,
    )
    throw new ProtocolError(`${what}: ${detail}`, { status: res.status, code: json?.code })
  }
  if (!json || typeof json !== "object") {
    throw new ProtocolError(`${what}: non-JSON reply`, { status: res.status })
  }
  // The console answers {code:0,...} on success and a non-zero code with
  // HTTP 200 when the account or the request is the problem: surface that
  // as an error the caller can tell from a network failure.
  if (typeof json.code === "number" && json.code !== 0) {
    throw new ProtocolError(`${what}: ${cleanDetail(json.msg || `code ${json.code}`)}`, {
      status: res.status,
      code: json.code,
    })
  }
  return json
}

async function consoleFetch(url, token, init, what, timeoutMs = TIMEOUT_MS, auth = "bearer") {
  let res
  try {
    const headers = auth === "cookie" ? cookieHeaders(token, init?.headers) : consoleHeaders(token, init?.headers)
    if (process.env.MAGPIE_INKSTONE_DEBUG_HEADERS) {
      console.error("[consoleFetch]", what, "auth=", auth, "keys=", Object.keys(headers).join(","))
    }
    res = await fetch(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    throw new ProtocolError(`${what}: ${cleanDetail(e?.message ?? e)}`)
  }
  return readJson(res, what)
}

/** GET a console API. `query` is an object of search params. */
export function consoleGet(path, token, { query, timeoutMs, auth } = {}) {
  const q = query ? `?${new URLSearchParams(query)}` : ""
  return consoleFetch(`${ENDPOINTS.console}${path}${q}`, token, { method: "GET" }, path, timeoutMs, auth)
}

/** POST/PUT/DELETE a console API. */
export function consoleSend(path, token, { method = "POST", body, headers, timeoutMs, auth } = {}) {
  return consoleFetch(
    `${ENDPOINTS.console}${path}`,
    token,
    {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    },
    path,
    timeoutMs,
    auth,
  )
}

/** The public model metadata: no credential, the page loads it signed out. */
export async function publicModels({ timeoutMs } = {}) {
  let res
  try {
    res = await fetch(`${ENDPOINTS.console}${PUBLIC_MODELS_PATH}?page=1&page_size=50`, {
      headers: { accept: "application/json", "accept-language": "zh-CN", "user-agent": UA },
      signal: AbortSignal.timeout(timeoutMs ?? TIMEOUT_MS),
    })
  } catch (e) {
    throw new ProtocolError(`public models: ${cleanDetail(e?.message ?? e)}`)
  }
  return readJson(res, "public models")
}

/** The catalogue the key is served: free, read-only, and it costs no credits. */
export async function apiModels(apiKey, { timeoutMs } = {}) {
  let res
  try {
    res = await fetch(`${ENDPOINTS.api}/models`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs ?? TIMEOUT_MS),
    })
  } catch (e) {
    throw new ProtocolError(`model catalogue: ${cleanDetail(e?.message ?? e)}`)
  }
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new ProtocolError(`TokenPlan refused the API key (HTTP ${res.status})`, { status: res.status }), {
      refused: true,
    })
  }
  // The raw envelope: the caller normalizes (live rows carry more than the
  // doc example shows, and the caller wants the whole body).
  return readJson(res, "model catalogue")
}

/** A best-effort key check: only 401/403 says the key is invalid. */
export async function probeApiKey(apiKey, { timeoutMs = 10_000 } = {}) {
  let res
  try {
    res = await fetch(`${ENDPOINTS.api}/models`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    throw new ProtocolError(`API key probe: ${cleanDetail(e?.message ?? e)}`)
  }
  if (res.status === 401 || res.status === 403) {
    throw new ProtocolError(`API key refused (HTTP ${res.status})`, { status: res.status })
  }
  return res.ok
}

/* ------------------------------------------------------- console endpoints */

export const creditsBalance = (token, o) => consoleGet(`${CONSOLE_API}/credits/balance`, token, o)
export const creditPackages = (token, o) => consoleGet(`${CONSOLE_API}/credits/packages`, token, o)
export const usersValidate = (token, o) => consoleGet(`${CONSOLE_API}/users/validate`, token, o)
/** Claims the month's free ink points. Idempotent: has_received says so. */
export const freeGrant = (token, o) => consoleSend(`${CONSOLE_API}/users/free-grant`, token, { ...o })

export function listKeys(token, o) {
  return consoleGet(`${CONSOLE_API}/keys`, token, { ...o, auth: "cookie" })
}

export function createKey(token, name, idempotencyKey, o) {
  return consoleSend(`${CONSOLE_API}/keys`, token, {
    body: { name },
    headers: { "Idempotency-Key": idempotencyKey },
    ...o,
    auth: "cookie",
  })
}

export function deleteKey(token, id, o) {
  return consoleSend(`${CONSOLE_API}/keys/${encodeURIComponent(id)}`, token, { method: "DELETE", ...o, auth: "cookie" })
}

/** A stable short fingerprint for names and cache buckets. */
export function fingerprint(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 12)
}
