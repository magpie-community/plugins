// The platform's endpoints, its console (portal) APIs, and the
// OpenAI-compatible catalogue. ENDPOINTS is a mutable object on purpose:
// the tests point it at a local fake (the same shape fake.mjs uses), so no
// test can reach the real platform. Production code reads the values at
// call time, never at import time.
import { createHash } from "node:crypto"

export const ENDPOINTS = {
  console: "https://platform.mosi.cn",
  api: "https://api.mosi.cn/v1",
}

/** The console SPA serves its APIs same-origin under /portal-api. */
export const PORTAL_API = "/portal-api"

// The console's session cookie (measured live, 2026-11-21): the SPA sends it
// same-origin with `credentials: include`, and a mutating request without the
// Origin header is refused (`origin_rejected`). Its lifetime is 14 days; the
// SSO session behind it (kept in the plugin's browser profile) re-issues it.
export const SESSION_COOKIE = "moss_studio_prod_access_token"
// An alternate deployment may name it without the environment segment; both
// are accepted so a rename never strands the reader.
export const SESSION_COOKIE_NAMES = [SESSION_COOKIE, "moss_studio_access_token"]
// The console's cookies sit on the platform's registrable domain. Both
// spellings are matched so a domain move does not break the cookie read.
export const COOKIE_DOMAINS = ["mosi.cn", "moss.cn"]

// The console refuses the 51st key (a create failure whose message is
// "maas tenant already exists" is the limit surfacing); the create dialog's
// name field caps at 50 characters.
export const KEY_LIMIT = 50
export const KEY_NAME_LIMIT = 50

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"
const TIMEOUT_MS = 20_000

// Vendor text goes into logs and the account card, so it must not carry a
// credential. Only token-shaped runs are masked; the diagnostic words stay.
const SECRETISH =
  /(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}[A-Za-z0-9._-]*|Bearer\s+[A-Za-z0-9._~+/-]{12,}|(?:access[-_]?token|refresh[-_]?token|session[_-]?token|moss[-_]?studio[a-z_]*token)[=:]\s*[^\s;]{8,}|sk-[A-Za-z0-9-]{8,}|[A-Za-z0-9+/]{40,}={0,2})/gi

export function cleanDetail(value) {
  return String(value ?? "").replace(SECRETISH, "***")
}

export class ProtocolError extends Error {
  constructor(message, { status = 0, code = "" } = {}) {
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

/** A stable short fingerprint for names and cache buckets. */
export function fingerprint(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 12)
}

function clientHints() {
  return {
    "user-agent": UA,
    "sec-ch-ua": '"Chromium";v="152", "Not;A=Brand";v="24", "Google Chrome";v="152"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
  }
}

/**
 * The portal APIs' browser-shaped headers. The session travels as the
 * console's cookie (the SPA uses `credentials: include`), and the WAF
 * refuses mutating requests whose Origin is not the console's own.
 */
export function consoleHeaders(token, extra = {}) {
  return {
    accept: "application/json",
    "accept-language": "zh-CN",
    origin: ENDPOINTS.console,
    referer: `${ENDPOINTS.console}/`,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    ...clientHints(),
    cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    ...extra,
  }
}

/** Is a Cookies-sqlite host_key one of the console's domains? */
export function cookieDomainMatches(hostKey, domains = COOKIE_DOMAINS) {
  const h = String(hostKey ?? "").replace(/^\./, "").toLowerCase()
  return domains.some((d) => h === d || h.endsWith(`.${d}`))
}

/**
 * Pull the console token out of a pasted string: either the bare token value
 * or a full cookie string carrying `moss_studio_prod_access_token=…`. A bare
 * token must not contain `=` or `;` (that would be a cookie-ish string whose
 * known name is missing) — refusing beats storing the wrong credential.
 */
export function readConsoleToken(raw) {
  const s = String(raw ?? "").trim()
  if (!s) return ""
  if (!/[=;]/.test(s)) return s
  for (const name of SESSION_COOKIE_NAMES) {
    const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(s)
    if (m?.[1]) {
      try {
        return decodeURIComponent(m[1])
      } catch {
        return m[1]
      }
    }
  }
  return ""
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
      json?.message || json?.error?.message || text.slice(0, 200).trim() || `HTTP ${res.status}`,
    )
    throw new ProtocolError(`${what}: ${detail}`, { status: res.status, code: json?.code })
  }
  if (!json || typeof json !== "object") {
    throw new ProtocolError(`${what}: non-JSON reply`, { status: res.status })
  }
  return json
}

async function portalFetch(path, token, init, what, { query, timeoutMs } = {}) {
  const q = query ? `?${new URLSearchParams(query)}` : ""
  let res
  try {
    res = await fetch(`${ENDPOINTS.console}${PORTAL_API}${path}${q}`, {
      ...init,
      headers: consoleHeaders(token, init?.headers),
      signal: AbortSignal.timeout(timeoutMs ?? TIMEOUT_MS),
    })
  } catch (e) {
    throw new ProtocolError(`${what}: ${cleanDetail(e?.message ?? e)}`)
  }
  return readJson(res, what)
}

/** GET /portal-api/me — {ID|source_user_id, Username, email, phone_number, …}. */
export const me = (token, o) => portalFetch("/me", token, { method: "GET" }, "me", o)

/** GET /portal-api/api_keys — {items:[{id,name,api_key(masked),status,created_at,…}]}. */
export const listKeys = (token, o) => portalFetch("/api_keys", token, { method: "GET" }, "api keys", o)

/** POST /portal-api/api_keys — the plaintext `api_key` is returned once. */
export const createKey = (token, name, o) =>
  portalFetch(
    "/api_keys",
    token,
    {
      method: "POST",
      body: JSON.stringify({ name }),
      headers: { "content-type": "application/json" },
    },
    "create api key",
    o,
  )

/** DELETE /portal-api/api_keys/:id */
export const deleteKey = (token, id, o) =>
  portalFetch(`/api_keys/${encodeURIComponent(id)}`, token, { method: "DELETE" }, "delete api key", o)

/**
 * GET /portal-api/maas/credits/usage-summary — credit balance as display
 * strings (display_total_remaining_points, display_available_points,
 * display_frozen_points) plus frozen_points and estimated_available_days.
 */
export const usageSummary = (token, o) =>
  portalFetch("/maas/credits/usage-summary", token, { method: "GET" }, "usage summary", o)

/** GET /portal-api/maas/credits/transactions — {items, total}, offset/limit paged. */
export const transactions = (token, { direction = "credit", limit = 200, offset = 0, ...o } = {}) =>
  portalFetch("/maas/credits/transactions", token, { method: "GET" }, "transactions", {
    query: { direction, limit, offset },
    ...o,
  })

/* ---------------------------------------------- OpenAI-compatible API side */

/** The catalogue the key is served: free, read-only, and it costs no credits. */
export async function apiModels(apiKey, { timeoutMs } = {}) {
  let res
  try {
    res = await fetch(`${ENDPOINTS.api}/models`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs ?? TIMEOUT_MS),
      redirect: "error",
    })
  } catch (e) {
    throw new ProtocolError(`model catalogue: ${cleanDetail(e?.message ?? e)}`)
  }
  if (res.status === 401 || res.status === 403) {
    // Measured live: a key MOSS does not take is refused with 403
    // permission_error (code 102111001), not 401.
    throw Object.assign(
      new ProtocolError(`MOSS refused the API key (HTTP ${res.status})`, { status: res.status }),
      { refused: true },
    )
  }
  // The raw envelope: the caller normalizes.
  return readJson(res, "model catalogue")
}

/** A best-effort key check: only 401/403 says the key is invalid. */
export async function probeApiKey(apiKey, { timeoutMs = 10_000 } = {}) {
  let res
  try {
    res = await fetch(`${ENDPOINTS.api}/models`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    })
  } catch (e) {
    throw new ProtocolError(`API key probe: ${cleanDetail(e?.message ?? e)}`)
  }
  if (res.status === 401 || res.status === 403) {
    throw new ProtocolError(`API key refused (HTTP ${res.status})`, { status: res.status })
  }
  return res.ok
}
