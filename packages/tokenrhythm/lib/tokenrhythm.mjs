// TokenRhythm wire protocol for the magpie plugin.
//
// The managed-key sign-in is the OpenSquilla integration:
//   client_id    opensquilla-desktop   (the only registered integration client)
//   scope        profile.read wallet.read managed_key.read managed_key.obtain session.revoke offline_access
//   authorize    GET  /api/oauth/authorize   (PKCE S256, loopback redirect)
//   token        POST /api/oauth/token       (authorization_code / refresh_token)
//   integration  /api/v1/integrations/opensquilla/*  ({code:0,data} envelope)
//   model API    /v1  (OpenAI-compatible; the managed-key secret is the Bearer)
//
// Everything here is transport + normalization only; the plugin decides what
// to store, and tests inject fetchImpl so no test needs the network.
import { createHash, randomBytes, randomUUID } from "node:crypto"

export const DEFAULT_ORIGIN = "https://tokenrhythm.studio"
export const CLIENT_ID = "opensquilla-desktop"
export const SCOPES = "profile.read wallet.read managed_key.read managed_key.obtain session.revoke offline_access"
export const REQUIRED_SCOPES = SCOPES.split(" ")
export const INTEGRATION_PREFIX = "/api/v1/integrations/opensquilla/"
export const DEFAULT_TIMEOUT_MS = 20_000

export class TokenRhythmError extends Error {
  constructor(message, { code = "", status = 0, httpStatus = 0, cancelled = false } = {}) {
    super(message)
    this.name = "TokenRhythmError"
    this.code = code
    this.status = status
    this.httpStatus = httpStatus
    this.cancelled = cancelled
  }
}

export class OAuthError extends TokenRhythmError {
  constructor(message, opts = {}) {
    super(message, opts)
    this.name = "OAuthError"
  }
}

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v)
const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined)
const pos = (v) => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim())
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** Origin for the dashboard/account API. HTTPS except localhost for tests/self-host. */
export function normalizeOrigin(value = DEFAULT_ORIGIN) {
  let s = text(value) ?? DEFAULT_ORIGIN
  const u = new URL(s)
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new TokenRhythmError("TokenRhythm origin must be http(s)")
  if (u.username || u.password) throw new TokenRhythmError("TokenRhythm origin must not carry credentials")
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname)
  if (u.protocol === "http:" && !local) throw new TokenRhythmError("TokenRhythm origin must use https")
  if (u.pathname !== "/" && u.pathname !== "") throw new TokenRhythmError("TokenRhythm origin must not carry a path")
  u.pathname = "/"
  u.search = ""
  u.hash = ""
  return u.origin
}

/** OpenAI-compatible model API base. Defaults to <origin>/v1. */
export function normalizeModelBase(value, origin = DEFAULT_ORIGIN) {
  const s = text(value)
  if (s) {
    const u = new URL(s)
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new TokenRhythmError("model base must be http(s)")
    if (u.username || u.password) throw new TokenRhythmError("model base must not carry credentials")
    u.search = ""
    u.hash = ""
    u.pathname = u.pathname.replace(/\/+$/, "") || "/"
    return u.toString().replace(/\/$/, "")
  }
  return normalizeOrigin(origin) + "/v1"
}

export function endpoints(origin = DEFAULT_ORIGIN) {
  const o = normalizeOrigin(origin)
  return {
    origin: o,
    authorize: o + "/api/oauth/authorize",
    token: o + "/api/oauth/token",
    integration: o + INTEGRATION_PREFIX,
    publicModels: o + "/api/models",
  }
}

const realFetch = () => {
  const f = globalThis.fetch
  if (typeof f !== "function") throw new TokenRhythmError("fetch is unavailable")
  return f.bind(globalThis)
}

const pickFetch = (fetchImpl) => (typeof fetchImpl === "function" ? fetchImpl : realFetch())

async function requestJson(url, { method = "GET", headers = {}, body, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const f = pickFetch(fetchImpl)
  const res = await f(url, {
    method,
    headers: { accept: "application/json", ...headers },
    body,
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  })
  const textBody = await res.text().catch(() => "")
  let json = null
  try { json = textBody ? JSON.parse(textBody) : null } catch { json = null }
  return { ok: res.ok, status: res.status, json, text: textBody }
}

async function postForm(url, fields, { fetchImpl, timeoutMs, errorPrefix = "OAUTH" } = {}) {
  const { ok, status, json } = await requestJson(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
    fetchImpl,
    timeoutMs,
  })
  const err = text(json?.error) ?? text(json?.error_description)
  if (!ok || err) {
    const code = err || ("OAUTH_HTTP_" + status)
    throw new OAuthError(errorPrefix + "_HTTP_" + status + (err ? ":" + err : ""), { code, httpStatus: status })
  }
  if (!isObject(json)) throw new OAuthError("OAUTH_BAD_RESPONSE", { code: "OAUTH_BAD_RESPONSE", httpStatus: status })
  return json
}

function scopeSet(scope) {
  return new Set(String(scope ?? "").split(/\s+/).filter(Boolean))
}

export function normalizeTokens(body, { now = Date.now() } = {}) {
  const accessToken = text(body?.access_token)
  const refreshToken = text(body?.refresh_token)
  const expiresIn = pos(body?.expires_in)
  if (!accessToken || !refreshToken || !expiresIn) throw new OAuthError("OAUTH_BAD_TOKEN_RESPONSE", { code: "OAUTH_BAD_TOKEN_RESPONSE" })
  if (expiresIn > 86_400) throw new OAuthError("OAUTH_BAD_TOKEN_RESPONSE", { code: "OAUTH_BAD_TOKEN_RESPONSE" })
  const accountId = text(body?.account_id)
  const sessionId = text(body?.session_id)
  if (!accountId || !sessionId) throw new OAuthError("OAUTH_BAD_TOKEN_RESPONSE", { code: "OAUTH_BAD_TOKEN_RESPONSE" })
  const have = scopeSet(body?.scope)
  const missing = REQUIRED_SCOPES.filter((s) => !have.has(s))
  if (missing.length) throw new OAuthError("OAUTH_SCOPE_MISSING", { code: "OAUTH_SCOPE_MISSING" })
  return {
    accessToken,
    refreshToken,
    expiresAt: now + expiresIn * 1000,
    expiresIn,
    accountId,
    sessionId,
    scope: String(body?.scope ?? SCOPES),
    clientId: text(body?.client_id) ?? CLIENT_ID,
  }
}

export function pkce() {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url")
  const state = randomBytes(32).toString("base64url")
  return { state, verifier, challenge }
}

export function buildAuthorizeUrl({ origin = DEFAULT_ORIGIN, redirectUri, state, challenge, installationId = randomUUID() } = {}) {
  const ep = endpoints(origin)
  const u = new URL(ep.authorize)
  u.searchParams.set("response_type", "code")
  u.searchParams.set("client_id", CLIENT_ID)
  u.searchParams.set("redirect_uri", redirectUri)
  u.searchParams.set("scope", SCOPES)
  u.searchParams.set("state", state)
  u.searchParams.set("code_challenge", challenge)
  u.searchParams.set("code_challenge_method", "S256")
  u.searchParams.set("installation_id", installationId)
  return u.toString()
}

export async function exchangeCode({ origin = DEFAULT_ORIGIN, code, redirectUri, verifier, fetchImpl, timeoutMs, now } = {}) {
  const ep = endpoints(origin)
  const body = await postForm(ep.token, {
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    code,
    code_verifier: verifier,
  }, { fetchImpl, timeoutMs })
  return normalizeTokens(body, { now })
}

export async function refreshTokens({ origin = DEFAULT_ORIGIN, refreshToken, accountId, sessionId, fetchImpl, timeoutMs, now } = {}) {
  const ep = endpoints(origin)
  const body = await postForm(ep.token, {
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  }, { fetchImpl, timeoutMs })
  const tokens = normalizeTokens(body, { now })
  if (accountId && tokens.accountId !== accountId) throw new TokenRhythmError("ACCOUNT_IDENTITY_MISMATCH", { code: "ACCOUNT_IDENTITY_MISMATCH" })
  if (sessionId && tokens.sessionId !== sessionId) throw new TokenRhythmError("ACCOUNT_IDENTITY_MISMATCH", { code: "ACCOUNT_IDENTITY_MISMATCH" })
  return tokens
}

function integrationUrl(origin, path) {
  const ep = endpoints(origin)
  return ep.integration + String(path).replace(/^\/+/, "")
}

async function apiRequest({ origin = DEFAULT_ORIGIN, accessToken, path, method = "GET", body, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!accessToken) throw new TokenRhythmError("missing access token", { code: "NO_ACCESS_TOKEN" })
  const headers = { authorization: "Bearer " + accessToken }
  let payload
  if (body !== undefined) {
    headers["content-type"] = "application/json"
    payload = JSON.stringify(body)
  }
  const { ok, status, json } = await requestJson(integrationUrl(origin, path), {
    method,
    headers,
    body: payload,
    fetchImpl,
    timeoutMs,
  })
  if (status === 204) return { data: null, status }
  if (!isObject(json)) throw new TokenRhythmError("ACCOUNT_HTTP_" + status, { code: "ACCOUNT_HTTP_" + status, httpStatus: status })
  if ("code" in json && json.code !== 0) {
    const code = text(json.error) ?? text(json.code)
    const safe = typeof code === "string" && /^[A-Za-z][A-Za-z0-9_]{0,95}$/.test(code) ? code : ("ACCOUNT_HTTP_" + status)
    throw new TokenRhythmError(safe, { code: safe, httpStatus: status })
  }
  if (!ok) throw new TokenRhythmError("ACCOUNT_HTTP_" + status, { code: "ACCOUNT_HTTP_" + status, httpStatus: status })
  if (!("data" in json)) throw new TokenRhythmError("ACCOUNT_BAD_RESPONSE", { code: "ACCOUNT_BAD_RESPONSE", httpStatus: status })
  return { data: json.data, status }
}

export const getAccount = (opts) => apiRequest({ ...opts, path: "account" }).then((r) => r.data)
export const getWallet = (opts) => apiRequest({ ...opts, path: "wallet" }).then((r) => r.data)
export const getManagedKey = (opts) => apiRequest({ ...opts, path: "managed-key" }).then((r) => r.data)
export const createManagedKeyCredential = (opts) => apiRequest({ ...opts, path: "managed-key/credential", method: "POST", body: {} }).then((r) => r.data)
export const deleteSession = (opts) => apiRequest({ ...opts, path: "session", method: "DELETE" }).then((r) => r.data)

/** Return the active managed-key secret, rotating through credential when needed. */
export async function ensureModelKey({ origin = DEFAULT_ORIGIN, accessToken, current = {}, fetchImpl, timeoutMs } = {}) {
  const meta = await getManagedKey({ origin, accessToken, fetchImpl, timeoutMs }).catch((e) => {
    if (e?.code === "MANAGED_KEY_NOT_FOUND" || e?.status === 404 || e?.httpStatus === 404) return null
    throw e
  })
  const currentKeyId = text(current.keyId)
  const currentGen = pos(current.generation)
  const secret = text(current.secret ?? current.modelKey ?? current.apiKey)
  if (
    secret &&
    meta &&
    meta.status === "active" &&
    currentKeyId &&
    text(meta.key_id) === currentKeyId &&
    pos(meta.generation) === currentGen
  ) {
    return {
      secret,
      keyId: currentKeyId,
      generation: currentGen,
      accountId: text(meta.account_id) ?? text(current.accountId),
      status: "active",
      rotated: false,
    }
  }
  const cred = await createManagedKeyCredential({ origin, accessToken, fetchImpl, timeoutMs })
  const credSecret = text(cred?.secret)
  if (!credSecret) throw new TokenRhythmError("MANAGED_KEY_BAD_RESPONSE", { code: "MANAGED_KEY_BAD_RESPONSE" })
  return {
    secret: credSecret,
    keyId: text(cred?.key_id) ?? text(meta?.key_id),
    generation: pos(cred?.generation) ?? pos(meta?.generation),
    accountId: text(cred?.account_id) ?? text(meta?.account_id),
    status: text(cred?.status) ?? text(meta?.status) ?? "active",
    rotated: true,
  }
}

const amount = (v) => {
  if (v === null || v === undefined || v === "") return undefined
  const s = String(v).trim()
  if (!s) return undefined
  return s
}
const compact = (v) => {
  const s = amount(v)
  if (s === undefined) return ""
  const n = Number(s)
  if (!Number.isFinite(n)) return s
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** wallet -> magpie usage card. Balances are decimal strings; never Number() them for display. */
export function walletCard({ wallet, account } = {}) {
  const w = wallet && typeof wallet === "object" ? wallet : {}
  const currency = text(w.currency) ?? "CNY"
  const bal = isObject(w.balances) ? w.balances : w
  const pick = (key) => bal[key] ?? w[key + "_balance"] ?? w[key]
  const row = (name, value, primary = false) => {
    const v = amount(value)
    if (v === undefined) return undefined
    const numeric = Number(v)
    return {
      name,
      display: compact(v) + " " + currency,
      amount: Number.isFinite(numeric) ? numeric : v,
      unit: currency,
      aside: !primary,
    }
  }
  // One pure pipeline: map each balance slot to its row, then drop the empty ones.
  const windows = [
    row("Available", pick("available"), true),
    row("Recharge", pick("recharge")),
    row("Bonus", pick("bonus")),
    row("Debt", pick("debt")),
    row("Frozen", pick("frozen")),
  ].filter(Boolean)
  const available = amount(pick("available"))
  const accountName = text(account?.display_name) ?? text(account?.masked_phone) ?? text(account?.account_id)
  return {
    plan: "Pay as you go",
    ...(accountName ? { user: accountName } : {}),
    balance: available !== undefined ? compact(available) + " " + currency : "",
    windows,
    signIn: "kept",
  }
}
