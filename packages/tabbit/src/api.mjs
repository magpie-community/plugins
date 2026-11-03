// Tabbit's own HTTP API, as the web app (web.tabbit.com) calls it.
//
// Everything here was measured against a live signed-in session:
//
//   GET  /proxy/v1/model_config/models?a=0&scene=chat   the live catalog
//   POST /api/v3/chat/rooms                             a room (conversation)
//   POST /api/v3/chat/rooms/<room>/runs                 one turn
//   POST /api/v3/chat/rooms/<room>/join                 the turn's SSE stream
//   GET  /api/commerce/quota/v1/usage?user_id=<uid>     the cycle's usage
//   GET  /proxy/v0/user/base-info                       the account
//
// The sign-in is the `token` cookie alone: an RS256 JWT issued by
// web.tab-browser.com with a 7-day life (exp - iat = 604800). `user_id` and
// `managed` ride along because the app sends them, not because the server
// needs them to authenticate.

export const BASE = "https://web.tabbit.com"

// A browser User-Agent is what the app sends and what the proxy answers.
// Nothing else is required: the version gate that refuses
// /proxy/v0/chat/completion with code 493 is not applied to these routes.
export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"

// The device id hash the app puts on every join. It is a constant of the
// client, not of the account: the same 64 hex characters came back from two
// different sessions.
export const DEVICE_HASH =
  "3713eb6543ed2726194a44f52cc053818ff123110f55cad8062070649ac9a40c"

// A turn's own length is bounded by STREAM_TIMEOUT, never by this: this bounds
// one request's connect/headers (and, for the calls that read a small JSON
// body, the body). Read lazily so a test can shrink it.
export const TIMEOUT = 30_000
export const timeoutMs = () => Number(process.env.TABBIT_TIMEOUT_MS || TIMEOUT)

// A turn that never answers would otherwise hang the agent forever.
// A turn's whole length. Read lazily so a test can shrink it.
export const STREAM_TIMEOUT = 300_000
export const streamTimeoutMs = () => Number(process.env.TABBIT_STREAM_TIMEOUT_MS || STREAM_TIMEOUT)

const clean = (v) => (typeof v === "string" ? v.trim() : "")

export class TabbitError extends Error {
  constructor(message, { status, code, action } = {}) {
    super(message)
    this.name = "TabbitError"
    this.status = status
    this.code = code
    this.action = action
  }
}

// credsOf turns whatever the account holds into the cookie header. A pasted
// value may be the bare JWT or a whole `k=v; k=v` cookie string; both are
// accepted, and a bare JWT is completed with the two cookies the app sends.
export function credsOf(auth) {
  const raw = clean(auth?.key ?? auth?.token ?? auth?.access)
  if (!raw) return null
  const uid = clean(auth?.userId ?? auth?.metadata?.userId)
  let header = raw
  if (!raw.includes("=")) {
    const parts = [`token=${raw}`]
    if (uid) parts.push(`user_id=${uid}`, `SAPISID=${uid}`)
    header = parts.join("; ")
  }
  if (uid && !header.includes("user_id=")) header += `; user_id=${uid}`
  const token = header.match(/(?:^|;\s*)token=([^;]+)/)?.[1]
  if (!token) return null
  const fromCookie = header.match(/(?:^|;\s*)user_id=([^;]+)/)?.[1] || ""
  return { header, token, uid: uid || fromCookie || uidOfClaims(claimsOf(token)) }
}

// claimsOf reads the JWT payload without verifying it: the fields name the
// account and say when to ask for a sign-in again, while the server is the
// one that decides whether the token is good.
export function claimsOf(token) {
  try {
    const part = String(token).split(".")[1]
    if (!part) return null
    const padded = part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4)
    const json = JSON.parse(Buffer.from(padded, "base64").toString("utf8"))
    return json && typeof json === "object" ? json : null
  } catch {
    return null
  }
}

export function expiresAt(auth) {
  const claims = claimsOf(credsOf(auth)?.token)
  return Number.isFinite(claims?.exp) ? new Date(claims.exp * 1000).toISOString() : undefined
}

// uidOfClaims reads the account id a token names: `sub` and `id` carry the
// same uuid in the token the browser keeps.
export function uidOfClaims(claims) {
  const id = claims?.sub ?? claims?.id ?? ""
  return typeof id === "string" ? id : ""
}

// stale is a token past its own exp. It is only a hint: the server is asked
// anyway, and its refusal is what marks the account.
export function stale(auth, skewMs = 60_000) {
  const claims = claimsOf(credsOf(auth)?.token)
  if (!Number.isFinite(claims?.exp)) return false
  return claims.exp * 1000 - skewMs <= Date.now()
}

function headersFor(creds, extra) {
  return {
    cookie: creds.header,
    accept: "application/json",
    "user-agent": UA,
    origin: BASE,
    referer: `${BASE}/newtab`,
    ...extra,
  }
}

function safeJSON(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function call(creds, path, init = {}, signal, { totalTimeout = true } = {}) {
  // A streamed turn may run for minutes; Bun's fetch applies this signal to
  // reading the body too, so a total timeout would cut a slow answer in half.
  // `join` therefore passes its own signal only and lets STREAM_TIMEOUT bound
  // the turn; every other call keeps the total timeout.
  const bound = totalTimeout
    ? signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs())])
      : AbortSignal.timeout(timeoutMs())
    : signal
  const res = await fetch(BASE + path, {
    ...init,
    headers: headersFor(creds, init.headers),
    ...(bound ? { signal: bound } : {}),
    redirect: "error",
  })
  if (res.status === 401 || res.status === 403) {
    let body = ""
    try {
      body = await res.text()
    } catch {
      /* the status is enough */
    }
    const parsed = safeJSON(body)
    // The refusal nests the code two ways: {"detail":{"message","details":{"code"}}}
    // on /api/v3, {"code"...} at the top on some routes.
    const detail = parsed?.detail ?? parsed?.details ?? parsed
    const code = Number(detail?.details?.code ?? detail?.code ?? parsed?.details?.code ?? parsed?.code)
    const action = detail?.details?.action ?? detail?.action ?? parsed?.action
    // 403 with code 492 is a paywall, not a lost sign-in: the account is
    // still signed in, the model just isn't on its plan. Measured with
    // Kimi-K3.1-Pro on a free account.
    const paywalled = res.status === 403 && code === 492
    const error = new TabbitError(
      paywalled
        ? detail?.details?.message || detail?.message || parsed?.message || "This model needs a paid Tabbit plan."
        : `Tabbit refused the sign-in (HTTP ${res.status})${body ? `: ${body.slice(0, 200)}` : ""}`,
      { status: res.status, code: Number.isFinite(code) ? code : undefined, action },
    )
    if (!paywalled) error.signIn = "expired"
    const retryAfter = res.headers.get("retry-after")
    if (retryAfter) error.retryAfter = retryAfter
    throw error
  }
  if (!res.ok) {
    let body = ""
    try {
      body = await res.text()
    } catch {
      /* nothing to add */
    }
    const error = new TabbitError(`Tabbit answered HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`, { status: res.status })
    const retryAfter = res.headers.get("retry-after")
    if (retryAfter) error.retryAfter = retryAfter
    throw error
  }
  return res
}

// listModels is the live catalog. It answers without a valid token too —
// the same 22 models came back with a deliberately broken cookie — so a
// failure here means the network or the service, never the sign-in.
export async function listModels(creds, { scene = "chat", signal } = {}) {
  const res = await call(creds, `/proxy/v1/model_config/models?a=0&scene=${encodeURIComponent(scene)}`, {}, signal)
  const body = await res.json()
  const models = Array.isArray(body?.models) ? body.models : []
  return models.filter((m) => clean(m?.display_name))
}

// usage reads the cycle's allowance. `usage_percentage` is a string like
// "12.18%", and the cycle is named by two dates ("2026.11.03" → "2026.11.10").
export async function usage(creds, signal) {
  const uid = creds.uid || ""
  const res = await call(creds, `/api/commerce/quota/v1/usage${uid ? `?user_id=${encodeURIComponent(uid)}` : ""}`, {}, signal)
  return await res.json()
}

// createRoom makes a conversation. Its id is also the chat_session_id, and
// a room with no turn in it never shows up in the user's session list — the
// list showed only rooms that had been used.
export async function createRoom(creds, signal) {
  const res = await call(creds, "/api/v3/chat/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, signal)
  const body = await res.json()
  if (!clean(body?.room_id)) throw new TabbitError("Tabbit created no room")
  return body.room_id
}

function escapeHTML(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// runTurn queues one turn. `selected_model` takes the catalog's
// display_name, and `content` is the whole prompt: Tabbit keeps the room's
// own history, so a follow-up may carry only the new message.
export async function runTurn(creds, room, { content, model, parentMessageId = null, signal }) {
  const rid = `tab_${crypto.randomUUID()}`
  const body = {
    client_run_id: rid,
    client_message_id: rid,
    // What the web app sends for a plain chat turn too — captured from it:
    // `agent_plan_mode_enabled: true` with `agent_mode: false`. Setting either
    // differently would turn on Tabbit's own planning step or server tools.
    agent_plan_mode_enabled: true,
    input_payload: {
      task_name: "chat",
      content,
      parent_message_id: parentMessageId,
      selected_model: [model],
      references: [],
      metadatas: { html_content: `<p>${escapeHTML(content)}</p>` },
      page_info_list: [],
      is_mobile: false,
      agent_mode: false,
    },
  }
  const res = await call(
    creds,
    `/api/v3/chat/rooms/${encodeURIComponent(room)}/runs`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    signal,
  )
  return await res.json()
}

// join opens the room's event stream. The server first replays a snapshot
// of the room, so a rejoin mid-turn recovers the part of the answer that
// was missed — the reason `last_event_id` is carried.
export async function join(creds, room, { lastEventId = null, signal } = {}) {
  const res = await call(
    creds,
    `/api/v3/chat/rooms/${encodeURIComponent(room)}/join`,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        page_instance_id: crypto.randomUUID(),
        device_id_hash: DEVICE_HASH,
        surface: "session",
        last_event_id: lastEventId,
      }),
    },
    signal,
    { totalTimeout: false },
  )
  return res
}

// ---- the daily sign-in (签到) -------------------------------------------
//
// The activity the desktop pet signs in to. Measured on a live account:
//
//   GET  /api/commerce/activity/v1/sign-in/status?scene_codes=desktop_pet
//        {"sign_in_date":"2026-11-03","results":[{"scene_code":"desktop_pet",
//         "activity_open":true,"signed_today":true,"signed_days":1,
//         "total_signed_days":1,"required_days":3,"can_adopt":false,
//         "usage_reward_result":null,"pet_entitlement_result":"not_eligible",
//         "pet_entitlement_id":null}]}
//
//   POST /api/commerce/activity/v1/sign-in  {"request_no":"<uuid>","scene_codes":["desktop_pet"]}
//        {"sign_in_date":"2026-11-03","results":[{"scene_code":"desktop_pet",
//         "activity_open":true,"sign_in_result":"already_signed", ...}]}
//
// `desktop_pet` is the only scene the service takes: every other name comes
// back SIGN_IN_SCENE_UNSUPPORTED. `request_no` is a client-made idempotency
// key — any fresh uuid is accepted, and repeating one is not a second claim.

export const SIGN_IN_SCENES = ["desktop_pet"]

export async function signInStatus(creds, { scenes = SIGN_IN_SCENES, signal } = {}) {
  const query = scenes.map((scene) => `scene_codes=${encodeURIComponent(scene)}`).join("&")
  const res = await call(creds, `/api/commerce/activity/v1/sign-in/status?${query}`, {}, signal)
  return await res.json()
}

export async function signIn(creds, { scenes = SIGN_IN_SCENES, requestNo = crypto.randomUUID(), signal } = {}) {
  const res = await call(
    creds,
    "/api/commerce/activity/v1/sign-in",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request_no: requestNo, scene_codes: scenes }) },
    signal,
  )
  return await res.json()
}

// stop asks Tabbit to end a run, which is what a cancelled request gets.
export async function stop(creds, room) {
  try {
    // Its own short timeout, never the caller's signal: the usual caller is a
    // request that was just aborted, and combining that signal would fail the
    // stop at once and leave the turn spending the account's allowance.
    await call(creds, "/proxy/v0/chat/stop/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ room_id: room }) }, AbortSignal.timeout(5000))
  } catch {
    /* stopping is best effort */
  }
}