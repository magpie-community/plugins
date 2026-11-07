import { createHash, randomUUID } from "node:crypto"

export const ORIGIN = "https://ccx.autobits.cc"
export const API_BASE = `${ORIGIN}/v1`

export class ApiError extends Error {
  constructor(status, body) {
    const text = typeof body === "string" ? body : [body?.title, body?.detail, body?.message].filter(Boolean).join(" · ")
    super(text || `请求失败 (${status})`)
    this.status = status
    this.body = body
    this.code = Number(body?.code)
  }
}

export function cookieValue(cookie, name) {
  for (const part of String(cookie ?? "").split(";")) {
    const eq = part.indexOf("=")
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return ""
}

export async function apiRequest({ path, method = "GET", token, cookie, csrf, organization, body, fetcher = fetch, origin = ORIGIN }) {
  const headers = { Accept: "application/json" }
  if (cookie) headers.Cookie = cookie
  if (csrf) headers["X-CSRF-Token"] = csrf
  if (organization) headers["X-CCH-Organization"] = organization
  if (body !== undefined) headers["Content-Type"] = "application/json"
  const response = await fetcher(origin + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let data
  try { data = JSON.parse(text) } catch { data = { detail: text.slice(0, 300) } }
  if (!response.ok) throw new ApiError(response.status, data)
  return { data, headers: response.headers }
}

export async function csrf(cookie, fetcher = fetch) {
  const { data } = await apiRequest({ path: "/api/auth/csrf", cookie, fetcher })
  return { csrf: data.csrf_token, expiresAt: data.expires_at }
}

export async function loginByApiKey(key, { fetcher = fetch } = {}) {
  const { data, headers } = await apiRequest({
    path: "/api/auth/llm-key-session", method: "POST",
    body: { token: key }, headers: undefined, fetcher,
  })
  // rawRequest's anonymous branch supplies the CSRF token before this POST.
  // Kept here in one function so an alternate client follows the same order.
  return { session: data, setCookie: headers.get("set-cookie") ?? "" }
}

export async function sessionCookie(key, { fetcher = fetch } = {}) {
  const first = await csrf("", fetcher)
  const { session, setCookie } = await apiRequest({
    path: "/api/auth/llm-key-session", method: "POST", csrf: first.csrf,
    body: { token: key }, fetcher,
  })
  // HttpOnly cookies are not available to page JavaScript. Node's fetch exposes
  // the vendor's Set-Cookie to this local plugin, not to any remote caller.
  return { session, setCookie }
}

export async function anonymous(path, { fetcher = fetch, ...rest } = {}) {
  const token = await csrf("", fetcher)
  return apiRequest({ path, ...rest, csrf: token.csrf, fetcher })
}

export async function models(key, { fetcher = fetch } = {}) {
  const response = await fetcher(`${API_BASE}/models`, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } })
  const data = await response.json()
  if (!response.ok) throw new ApiError(response.status, data)
  return data.data ?? data.models ?? []
}

export function publicKey(auth) {
  if (auth?.type === "api") return auth.key ?? ""
  return auth?.apiKey ?? auth?.access ?? auth?.metadata?.apiKey ?? auth?.metadata?.access ?? ""
}
export function browserSession(auth) {
  return auth?.browserCookie ?? auth?.metadata?.browserCookie ?? ""
}
export function sessionCSRF(auth) {
  return auth?.browserCSRF ?? auth?.metadata?.browserCSRF ?? ""
}
export function accountName(auth) {
  return auth?.username ?? auth?.metadata?.username ?? auth?.accountId ?? auth?.metadata?.accountId ?? ""
}
export function identity(auth) {
  return createHash("sha256").update(publicKey(auth) || auth?.profileId || accountName(auth) || JSON.stringify(auth)).digest("hex").slice(0, 16)
}
