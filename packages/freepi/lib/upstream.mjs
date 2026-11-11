// api.freepi.ai upstream contract: constants, headers, GitHub device-flow auth,
// ad-impression gate. Reverse-engineered from free-pi-cli; same shape as
// ErfanBagheri404/FreePi2API but pinned ahead of the server's update gate.

export const BASE = "https://api.freepi.ai"
export const SESSION_ID = "magpie-freepi" // server does not bind this to the login session
export const POLL_MIN_MS = 5_000
export const POLL_MAX_MS = 60_000
export const LOGIN_TIMEOUT_MS = 900_000

let clientVersion = "0.6.16" // >= server min (observed 2026-11-10); the 12h watcher calibrates from here

const compareVersions = (a, b) => {
  const pa = String(a).split(".").map(Number)
  const pb = String(b).split(".").map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

export function getClientVersion() {
  return clientVersion
}

// /client-version reports min (forced-update gate) and latest; keep our pin ahead of min.
export function calibrateClientVersion({ min, latest } = {}) {
  if (typeof latest === "string" && compareVersions(latest, clientVersion) > 0) clientVersion = latest
  if (typeof min === "string" && compareVersions(min, clientVersion) > 0) clientVersion = min
  return clientVersion
}

export function authHeaders(token) {
  const h = {
    "user-agent": `free-pi-cli/${clientVersion}`,
    "x-session-id": SESSION_ID,
    "x-client-version": clientVersion,
  }
  if (token) h.authorization = `Bearer ${token}`
  return h
}

async function readJson(res) {
  const text = await res.text()
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

export async function postJson(url, body, { fetchImpl = fetch, signal, headers } = {}) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  })
  return { status: res.status, body: await readJson(res) }
}

export async function getJson(url, headers, { fetchImpl = fetch, signal } = {}) {
  const res = await fetchImpl(url, { headers, signal })
  return { status: res.status, body: await readJson(res) }
}

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(t)
      resolve()
    }, { once: true })
  })

export function clampIntervalMs(retryAfterSec) {
  const sec = Number(retryAfterSec)
  if (!(sec > 0)) return POLL_MIN_MS
  return Math.min(Math.max(sec * 1000, POLL_MIN_MS), POLL_MAX_MS)
}

// Device flow, steps 1+2: request the code and record consent BEFORE polling —
// the server 403s every token poll with consent_required until consent is on file.
export async function startDeviceFlow({ fetchImpl = fetch, signal } = {}) {
  const device = await postJson(`${BASE}/auth/github/device`, {}, { fetchImpl, signal })
  if (device.status !== 200 || !device.body?.session_id)
    throw new Error(`device flow failed: HTTP ${device.status}`)
  const consent = await postJson(
    `${BASE}/auth/consent`,
    { session_id: device.body.session_id, consent_version: clientVersion },
    { fetchImpl, signal },
  )
  return {
    device: device.body,
    consentError: consent.status >= 400 ? (consent.body?.code ?? `HTTP ${consent.status}`) : null,
  }
}

export async function pollForToken(sessionId, {
  fetchImpl = fetch,
  signal,
  sleepImpl = sleep,
  initialIntervalMs = POLL_MIN_MS,
  timeoutMs = LOGIN_TIMEOUT_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs
  let interval = initialIntervalMs
  while (Date.now() < deadline) {
    if (signal?.aborted) return { type: "failed", error: "登录已取消" }
    await sleepImpl(interval, signal)
    if (signal?.aborted) return { type: "failed", error: "登录已取消" }
    const r = await postJson(`${BASE}/auth/token`, { session_id: sessionId }, { fetchImpl, signal })
    if (r.status === 200 && r.body?.token) return { type: "success", token: r.body.token, body: r.body }
    if (r.body?.retry_after != null) interval = clampIntervalMs(r.body.retry_after)
  }
  return { type: "failed", error: "等待 GitHub 授权超时（15 分钟）" }
}

// Ad gate: the server answers 403 {"code":"ads_required"} on completions unless the
// client serves and reports banner impressions (the CLI shows real ads via its Gravity
// SDK; we mirror FreePi2API's headless approach — fetch, log, report, never click).
// Never throws; returns 1 when an impression was reported, else 0.
export async function reportImpression(token, { fetchImpl = fetch } = {}) {
  try {
    const { status, body: ad } = await getJson(`${BASE}/ads/next?slot=banner`, authHeaders(token), { fetchImpl })
    if (status !== 200 || !ad?.ad_id) return 0
    await postJson(
      `${BASE}/ads/impression`,
      { ad_id: ad.ad_id, click_token: ad.click_token, imp_fired: true },
      { fetchImpl, headers: authHeaders(token) },
    )
    if (ad.imp_url) {
      await fetchImpl(ad.imp_url, { headers: authHeaders(token) }).catch(() => {})
    }
    return 1
  } catch {
    return 0
  }
}
