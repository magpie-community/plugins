// OpenCode / Magpie provider plugin for SenseTime Raccoon (商汤小浣熊, xiaohuanxiong.com).
// Ported from aimod-cc/agent2api's raccoon provider implementation:
//   - Auth: JWT access_token + refresh_token, proactive refresh 5m before expiry
//           via POST https://xiaohuanxiong.com/api/web/auth/v1/refresh
//   - Sign-in methods:
//       1) Browser authorization callback URL (office-raccoon://auth/callback?code=...&state=...) or raw token
//       2) Raccoon desktop live sign-in (~/.box-agent/config/auth.json)
//   - Models: live catalog from GET /api/web/llm/v2/model_catalog with credit rates & free flags
//   - Chat: POST /api/web/llm/v2/chat/completions with SSE model name rewrite
//   - Usage: GET /api/web/points/v1/balance + /api/web/auth/v1/entitlement_info + /api/web/points/v1/bills
//   - Daily check-in & onboarding grants: GET /api/web/office/v3/setting_info + desktop/mobile 3000pt grants

import { randomUUID } from "node:crypto"
import { readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const PROVIDER_ID = "raccoon"
const PROVIDER_NAME = "商汤小浣熊"
const NPM = "@ai-sdk/openai-compatible"

const MAIN_ORIGIN = (process.env.RACCOON_MAIN_SITE_URL || "https://xiaohuanxiong.com").replace(/\/+$/, "")
const AUTH_BASE = (process.env.RACCOON_AUTH_API_BASE || `${MAIN_ORIGIN}/api/web/auth/v1`).replace(/\/+$/, "")
const LLM_BASE = (process.env.RACCOON_LLM_BASE_URL || `${MAIN_ORIGIN}/api/web/llm/v2`).replace(/\/+$/, "")

const EARLY_MS = 60 * 1000
const LEAD_MS = 5 * 60 * 1000
const KEEP_RENEWED_MS = 60 * 1000
const CATALOG_TTL_MS = 10 * 60 * 1000

const DESKTOP_HEADERS = {
  "X-Client-Platform": "desktop-windows",
  "X-Client-Version": "v1.0.0",
}
const MOBILE_HEADERS = {
  "X-Client-Platform": "app-android",
  "X-Client-Version": "v1.0.3",
}

// Fallback model list (matches agent2api's fallback_models + live catalog)
const FALLBACK_MODELS = [
  { id: "raccoon-8c4485", name: "Raccoon-Work", context: 1_000_000, output: 100_000, images: true, reasoning: true, rate: 1, free: false },
  { id: "raccoon-19b265", name: "Raccoon-Work-260817-A", context: 1_000_000, output: 100_000, images: false, reasoning: true, rate: 1, free: false },
  { id: "raccoon-405a1c", name: "Raccoon-Work-260817-B", context: 1_000_000, output: 100_000, images: false, reasoning: false, rate: 1, free: false },
  { id: "sn-sensenova-6-8-flash", name: "SenseNova-6.8-Flash", context: 256_000, output: 63_999, images: true, reasoning: true, rate: 0, rateWas: 0.5, free: true },
  { id: "sn-sensenova-6-8-flash-lite", name: "SenseNova-6.8-Flash-Lite", context: 256_000, output: 63_999, images: true, reasoning: true, rate: 0, rateWas: 0.5, free: true },
  { id: "sn-glm-5-3", name: "GLM-5-3", context: 1_000_000, output: 100_000, images: true, reasoning: true, rate: 0.75, free: false },
  { id: "sn-kimi-k3", name: "Kimi-K3", context: 1_000_000, output: 100_000, images: true, reasoning: true, rate: 1, free: false },
  { id: "sn-glm-5-3-flash", name: "GLM-5-3-Flash", context: 1_000_000, output: 100_000, images: false, reasoning: true, rate: 0.2, free: false },
  { id: "sn-deepseek-v4-1-flash", name: "DeepSeek-V4.1-Flash", context: 1_000_000, output: 100_000, images: false, reasoning: true, rate: 0.25, free: false },
  { id: "raccoon-chat-ml-5-5", name: "Raccoon Chat (默认)", context: 180_000, output: 80_000, images: false, reasoning: true, rate: 1, free: false },
]

// ---- JWT helpers ------------------------------------------------------------

function stripBearer(value) {
  return String(value ?? "").trim().replace(/^Bearer\s+/i, "").trim()
}

function decodeJwtClaims(token) {
  const raw = stripBearer(token)
  const parts = raw.split(".")
  if (parts.length < 2 || !parts[1]) return null
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8")
    const obj = JSON.parse(json)
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null
  } catch {
    return null
  }
}

function jwtExpiryMs(token) {
  const claims = decodeJwtClaims(token)
  const exp = Number(claims?.exp)
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0
}

function hexIdToDecimal(val) {
  const raw = String(val ?? "").trim().replace(/^0x/i, "")
  if (!raw || !/^[0-9a-fA-F]+$/.test(raw)) return ""
  try {
    return BigInt("0x" + raw).toString(10)
  } catch {
    return ""
  }
}

function extractUserId(claims) {
  if (!claims) return ""
  for (const k of ["sid", "iss"]) {
    const dec = hexIdToDecimal(claims[k])
    if (dec) return dec
  }
  for (const k of ["sub", "id", "user_id"]) {
    const s = String(claims[k] ?? "").trim()
    if (s) return s
  }
  return ""
}

function extractDisplayName(claims) {
  return String(claims?.name ?? "").trim()
}

// ---- Desktop auth.json (~/.box-agent/config/auth.json) ----------------------

function desktopAuthPath() {
  for (const envKey of ["RACCOON_BOX_AGENT_CONFIG_DIR", "BOX_AGENT_CONFIG_DIR"]) {
    const v = String(process.env[envKey] ?? "").trim()
    if (v) return join(v, "auth.json")
  }
  return join(homedir(), ".box-agent", "config", "auth.json")
}

function readDesktopAuth() {
  const p = desktopAuthPath()
  try {
    const st = statSync(p)
    if (!st.isFile() || st.size <= 0 || st.size > 256 * 1024) return null
    const raw = JSON.parse(readFileSync(p, "utf8"))
    const access = stripBearer(raw?.access_token)
    const refresh = stripBearer(raw?.refresh_token)
    if (!access) return null
    const claims = decodeJwtClaims(access)
    const uid = extractUserId(claims)
    const name = extractDisplayName(claims)
    const expires = jwtExpiryMs(access)
    return {
      access,
      refresh,
      expires,
      uid,
      name: name || (uid ? `Raccoon-${uid}` : PROVIDER_NAME),
      raw,
      path: p,
    }
  } catch {
    return null
  }
}

function writeDesktopAuthIfCurrent(prevAccess, nextAccess, nextRefresh) {
  const p = desktopAuthPath()
  try {
    const cur = JSON.parse(readFileSync(p, "utf8"))
    if (stripBearer(cur?.access_token) !== stripBearer(prevAccess)) return false
    cur.access_token = nextAccess
    if (nextRefresh) cur.refresh_token = nextRefresh
    writeFileSync(p, JSON.stringify(cur, null, 2) + "\n", { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

// ---- Token refresh (single-flight) ------------------------------------------

const renewing = new Map()
const renewed = new Map()

async function callRefreshApi(refreshToken) {
  const res = await fetch(`${AUTH_BASE}/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  let payload = {}
  try {
    payload = JSON.parse(text) ?? {}
  } catch {}
  if (!res.ok) {
    const msg = payload?.message || payload?.msg || payload?.error?.message || `HTTP ${res.status}`
    const err = new Error(`商汤小浣熊刷新 Token 失败: ${msg}`)
    if (res.status === 401) err.signIn = "expired"
    throw err
  }
  const data = payload?.data ?? {}
  const access = stripBearer(data?.access_token)
  if (!access) {
    const err = new Error(`商汤小浣熊刷新 Token 失败: ${payload?.message || payload?.msg || "未返回新 Token"}`)
    err.signIn = "expired"
    throw err
  }
  const refresh = stripBearer(data?.refresh_token) || refreshToken
  const expires = jwtExpiryMs(access)
  const claims = decodeJwtClaims(access)
  const uid = extractUserId(claims)
  const name = extractDisplayName(claims)
  return { access, refresh, expires, ...(uid ? { uid } : {}), ...(name ? { name } : {}) }
}

function renewToken(a, save) {
  const key = a.refresh
  const done = renewed.get(key)
  if (done && Date.now() - done.at < KEEP_RENEWED_MS) return Promise.resolve({ ...a, ...done.next })
  let r = renewing.get(key)
  if (!r) {
    r = (async () => {
      const next = await callRefreshApi(a.refresh)
      renewed.set(key, { next, at: Date.now() })
      await save?.({ ...a, ...next })
      return next
    })().finally(() => renewing.delete(key))
    renewing.set(key, r)
  }
  return r.then((next) => ({ ...a, ...next }))
}

function isStale(a, marginMs = EARLY_MS) {
  const exp = Number(a?.expires) || jwtExpiryMs(a?.access)
  return exp > 0 && Date.now() >= exp - marginMs
}

const desktopHeld = new Map()

async function currentAuth(client, auth, force = false) {
  if (auth?.source === "desktop") {
    const d = readDesktopAuth()
    if (!d) throw new Error("商汤小浣熊桌面端未登录（未找到 ~/.box-agent/config/auth.json）")
    const k = d.uid || "desktop"
    const held = desktopHeld.get(k)
    const base = held && held.expires >= d.expires ? held : d
    if (!force && !isStale(base, LEAD_MS)) return { a: base, didRenew: false }
    if (!base.refresh) return { a: base, didRenew: false }
    const next = await renewToken(base, async (updated) => {
      writeDesktopAuthIfCurrent(base.access, updated.access, updated.refresh)
    })
    desktopHeld.set(k, next)
    return { a: next, didRenew: true }
  }

  let a = { ...auth }
  for (let i = 0; i < 8 && a.refresh; i++) {
    const d = renewed.get(a.refresh)
    if (!d || Date.now() - d.at >= KEEP_RENEWED_MS) break
    a = { ...a, ...d.next }
  }
  if (!a.expires && a.access) a.expires = jwtExpiryMs(a.access)
  const alreadyRenewed = a.access !== auth.access
  if (!force && !isStale(a, EARLY_MS)) return { a, didRenew: alreadyRenewed }
  if (!a.refresh) {
    if (a.access && (!a.expires || Date.now() < a.expires)) return { a, didRenew: alreadyRenewed }
    const err = new Error("商汤小浣熊登录态已过期且无 refresh_token，请重新登录")
    err.signIn = "expired"
    throw err
  }
  const next = await renewToken(a, async (updated) => {
    try {
      await client?.auth?.set?.({ path: { id: PROVIDER_ID }, body: updated })
    } catch {}
  })
  return { a: next, didRenew: true }
}

// ---- Models catalog ---------------------------------------------------------

let catalogCache = { models: null, at: 0 }

function numOf(v) {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.trim()) : NaN
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

function parseCatalog(payload) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : payload
  const categories = Array.isArray(data?.categories) ? data.categories : []
  const seen = new Set()
  const out = []
  for (const cat of categories) {
    for (const entry of Array.isArray(cat?.models) ? cat.models : []) {
      const id = String(entry?.name || entry?.model_name || "").trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      const codename = String(entry?.description ?? "").trim()
      const displayName = String(entry?.display_name ?? "").trim() || (codename && codename.length <= 64 ? codename : id)
      const tags = (Array.isArray(entry?.tags) ? entry.tags : []).map((t) => String(t ?? "").trim().toLowerCase()).filter(Boolean)
      const images = tags.some((t) => t === "vision" || t === "image" || t === "image-understanding")
      const context = Math.floor(numOf(entry?.context_window ?? entry?.contextWindow ?? entry?.params?.context_window ?? entry?.params?.contextWindow) || 200_000)
      const output = Math.floor(numOf(entry?.max_tokens ?? entry?.maxTokens ?? entry?.params?.max_tokens ?? entry?.params?.maxTokens) || 64_000)
      const baseRate = numOf(entry?.billing_multiplier)
      const effRate = numOf(entry?.billing_effective_multiplier)
      const rate = effRate ?? baseRate
      const free = rate === 0
      const rateWas = baseRate !== undefined && effRate !== undefined && effRate < baseRate ? baseRate : undefined
      out.push({
        id,
        name: displayName,
        context,
        output,
        images,
        reasoning: true,
        free,
        ...(rate !== undefined ? { rate } : {}),
        ...(rateWas !== undefined ? { rateWas } : {}),
      })
    }
  }
  if (!seen.has("raccoon-chat-ml-5-5")) {
    out.push({ id: "raccoon-chat-ml-5-5", name: "Raccoon Chat (默认)", context: 180_000, output: 80_000, images: false, reasoning: true, rate: 1, free: false })
  }
  return out
}

async function fetchLiveModels(token) {
  if (catalogCache.models && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.models
  }
  const headers = { Accept: "application/json" }
  if (token) headers.Authorization = "Bearer " + stripBearer(token)
  const res = await fetch(`${LLM_BASE}/model_catalog`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const payload = await res.json()
  const models = parseCatalog(payload)
  if (!models.length) throw new Error("empty catalog")
  catalogCache = { models, at: Date.now() }
  return models
}

function configModels() {
  return Object.fromEntries(
    FALLBACK_MODELS.map((m) => [
      m.id,
      {
        name: m.name,
        limit: { context: m.context, output: m.output },
        tool_call: true,
        reasoning: !!m.reasoning,
        attachment: !!m.images,
        modalities: { input: m.images ? ["text", "image"] : ["text"], output: ["text"] },
        free: !!m.free,
        ...(m.rate !== undefined ? { rate: m.rate } : {}),
        ...(m.rateWas !== undefined ? { rateWas: m.rateWas } : {}),
      },
    ]),
  )
}

function runtimeModel(provider, m) {
  return {
    id: m.id,
    providerID: provider.id,
    name: m.name,
    api: { id: m.id, url: LLM_BASE, npm: NPM },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.context ?? 0, output: m.output ?? 0 },
    capabilities: {
      temperature: true,
      reasoning: !!m.reasoning,
      attachment: !!m.images,
      toolcall: true,
      input: { text: true, image: !!m.images, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
    free: !!m.free,
    ...(m.rate !== undefined ? { rate: m.rate } : {}),
    ...(m.rateWas !== undefined ? { rateWas: m.rateWas } : {}),
  }
}

// ---- SSE model rewrite ------------------------------------------------------

function rewriteSseModel(res, requestedModel, signInHeader) {
  const headers = new Headers(res.headers)
  headers.set("X-Magpie-Sign-In", signInHeader)
  if (!requestedModel || !res.body) {
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  }
  const ct = (headers.get("content-type") || "").toLowerCase()
  if (ct.includes("application/json")) {
    return (async () => {
      const text = await res.text()
      try {
        const obj = JSON.parse(text)
        if (obj && typeof obj === "object" && "model" in obj) {
          obj.model = requestedModel
          headers.delete("content-length")
          return new Response(JSON.stringify(obj), { status: res.status, statusText: res.statusText, headers })
        }
      } catch {}
      return new Response(text, { status: res.status, statusText: res.statusText, headers })
    })()
  }
  if (!ct.includes("text/event-stream")) {
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  }
  const dec = new TextDecoder()
  const enc = new TextEncoder()
  let buf = ""
  const rewriteLine = (line) => {
    if (!line.startsWith("data:")) return line
    const dataStr = line.slice(5).trim()
    if (!dataStr || dataStr === "[DONE]") return line
    try {
      const obj = JSON.parse(dataStr)
      if (obj && typeof obj === "object" && "model" in obj && obj.model !== requestedModel) {
        obj.model = requestedModel
        return "data: " + JSON.stringify(obj)
      }
    } catch {}
    return line
  }
  const stream = res.body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        buf += dec.decode(chunk, { stream: true })
        const lines = buf.split("\n")
        buf = lines.pop() ?? ""
        if (lines.length) {
          controller.enqueue(enc.encode(lines.map(rewriteLine).join("\n") + "\n"))
        }
      },
      flush(controller) {
        buf += dec.decode()
        if (buf) controller.enqueue(enc.encode(rewriteLine(buf)))
      },
    }),
  )
  headers.delete("content-length")
  return new Response(stream, { status: res.status, statusText: res.statusText, headers })
}

// ---- Usage, Check-in & Onboarding -------------------------------------------

async function apiGetJson(path, token, extraHeaders = {}, method = "GET") {
  const res = await fetch(`${MAIN_ORIGIN}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: "Bearer " + stripBearer(token),
      ...extraHeaders,
    },
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  let payload = {}
  try {
    payload = JSON.parse(text) ?? {}
  } catch {}
  if (res.status === 401) {
    const err = new Error("登录态已过期")
    err.status = 401
    throw err
  }
  if (!res.ok) throw new Error(payload?.message || payload?.msg || `HTTP ${res.status}`)
  if (typeof payload?.code === "number" && payload.code !== 0) {
    throw new Error(payload?.message || payload?.msg || `code=${payload.code}`)
  }
  return payload?.data ?? payload
}

function beijingTodayKey(nowMs = Date.now()) {
  return new Date(nowMs + 8 * 3600_000).toISOString().slice(0, 10)
}

async function claimOnboardingGrants(token) {
  let claimedPoints = 0
  for (const [path, headers] of [
    ["/api/web/desktop/v1/login/points/grant", DESKTOP_HEADERS],
    ["/api/web/mobile/v1/login/points/grant", MOBILE_HEADERS],
  ]) {
    try {
      const d = await apiGetJson(path, token, headers, "POST")
      if (d?.granted === true) {
        const pts = Number(d?.popup?.points)
        claimedPoints += Number.isFinite(pts) && pts > 0 ? pts : 3000
      }
    } catch {}
  }
  return claimedPoints
}

async function queryUsage(token) {
  const [points, entitlement, bills] = await Promise.all([
    apiGetJson("/api/web/points/v1/balance", token),
    apiGetJson("/api/web/auth/v1/entitlement_info", token).catch(() => null),
    apiGetJson("/api/web/points/v1/bills?paging.limit=25&paging.offset=0", token).catch(() => null),
  ])
  const avail = Math.floor(Number(points?.available_points) || 0)
  const daily = Math.floor(Number(points?.daily_points) || 0)
  const reward = Math.floor(Number(points?.reward_points) || 0)
  const monthly = Math.floor(Number(points?.monthly_points) || 0)
  const topup = Math.floor(Number(points?.topup_points) || 0)

  const office = entitlement?.office ?? entitlement?.code ?? {}
  const proEnable = office?.pro_enable === true || entitlement?.code?.pro_enable === true
  const planType = office?.active_plan?.type || office?.plan_type || ""
  const plan = proEnable ? (planType && planType !== "none" ? planType : "Pro") : "Free"
  const expireAt = office?.pro_expired_time || office?.active_plan?.subscription_expired_at || null

  // Calculate exact granted pool from bills so used / total is accurate
  let dailyGranted = 0
  let rewardGranted = 0
  let runsOutAt = null
  let runsOut = 0
  const now = Date.now()
  for (const item of Array.isArray(bills?.items) ? bills.items : []) {
    const pts = Math.floor(Number(item?.points) || 0)
    if (pts <= 0) continue
    const expStr = typeof item?.expire_at === "string" ? item.expire_at : ""
    const expMs = expStr ? Date.parse(expStr) : 0
    if (expMs > 0 && expMs <= now) continue
    if (item?.biz_type === "daily_grant" || expMs > 0) {
      dailyGranted += pts
      if (expMs > now && (!runsOutAt || expMs < Date.parse(runsOutAt))) {
        runsOutAt = new Date(expMs).toISOString()
        runsOut = daily > 0 ? daily : avail
      }
    } else {
      rewardGranted += pts
    }
  }
  const effectiveDailyTotal = daily > 0 ? Math.max(daily, dailyGranted, 300) : 0
  const effectiveRewardTotal = reward > 0 ? Math.max(reward, rewardGranted, 9000) : 0
  let totalGranted = Math.max(avail, effectiveDailyTotal + effectiveRewardTotal + monthly + topup)
  if (totalGranted <= 0) totalGranted = 300
  const used = Math.max(0, totalGranted - avail)
  const windows = [
    {
      name: "Credits",
      used: (100 * used) / totalGranted,
      display: `${used} / ${totalGranted}`,
      amount: used,
      limit: totalGranted,
      unit: "credits",
      ...(runsOutAt ? { runsOutAt, runsOut } : {}),
    },
  ]

  return {
    plan,
    ...(proEnable && expireAt ? { until: new Date(expireAt).toISOString() } : {}),
    balance: `${avail} credits`,
    windows,
  }
}

async function performCheckIn(token, auth, save) {
  // 1. Trigger daily desktop login points grant
  await apiGetJson("/api/web/office/v3/setting_info", token, {
    ...DESKTOP_HEADERS,
    "X-Raccoon-Language": "zh",
  }).catch(() => null)

  // 2. One-time onboarding grants (desktop +3000, mobile +3000) if not yet settled
  let onboardingPts = 0
  if (!auth?.onboardingSettled) {
    onboardingPts = await claimOnboardingGrants(token)
    if (save) {
      await save({ ...auth, onboardingSettled: true }).catch(() => {})
    }
  }

  // 3. Verify today's grants via bills (Beijing time UTC+8)
  const today = beijingTodayKey()
  const bills = await apiGetJson("/api/web/points/v1/bills?paging.limit=20&paging.offset=0", token)
  let grantedToday = 0
  const names = []
  for (const item of Array.isArray(bills?.items) ? bills.items : []) {
    const pts = Math.floor(Number(item?.points) || 0)
    const createdAt = String(item?.created_at ?? "")
    if (pts > 0 && createdAt.slice(0, 10) === today) {
      grantedToday += pts
      const ev = String(item?.event_name || "积分发放")
      if (!names.includes(ev)) names.push(ev)
    }
  }
  const totalCredit = grantedToday || onboardingPts
  if (totalCredit > 0) {
    return {
      outcome: "claimed",
      credit: totalCredit,
      message: `${names.join(" + ") || "今日积分"} +${totalCredit}`,
    }
  }
  return {
    outcome: "done",
    message: "今日已签到",
  }
}

// ---- Sign-in flows ----------------------------------------------------------

function buildAuthorizeUrl(state) {
  const u = new URL("/code/authorize", MAIN_ORIGIN)
  u.searchParams.set("login_source", "desktop")
  u.searchParams.set("appname", "办公小浣熊客户端")
  u.searchParams.set("state", state)
  return u.toString()
}

function parseCallbackInput(raw, expectedState) {
  const text = String(raw ?? "").trim()
  if (!text) throw new Error("请输入回调链接或 Token")
  // Support pasting JSON {"access_token":"...","refresh_token":"..."}
  if (text.startsWith("{")) {
    const obj = JSON.parse(text)
    const access = stripBearer(obj?.access_token ?? obj?.accessToken)
    const refresh = stripBearer(obj?.refresh_token ?? obj?.refreshToken)
    if (!access) throw new Error("JSON 中缺少 access_token")
    return { direct: { access, refresh } }
  }
  // Support pasting raw JWT access_token directly
  if (text.split(".").length === 3 && !text.includes("://")) {
    return { direct: { access: stripBearer(text), refresh: "" } }
  }
  // Parse office-raccoon://auth/callback?code=...&state=...
  let u
  try {
    u = new URL(text)
  } catch {
    throw new Error("无效的回调链接或 Token 格式")
  }
  const code = (u.searchParams.get("code") || "").trim()
  const state = (u.searchParams.get("state") || "").trim()
  if (!code) throw new Error("回调链接中缺少授权码 code")
  if (expectedState && state && state !== expectedState) {
    throw new Error("回调链接 state 不匹配，请使用本次打开页面产生的回调链接")
  }
  return { code }
}

async function exchangeAuthCode(code) {
  const res = await fetch(`${AUTH_BASE}/login_with_authorization_code`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ authorization_code: code }),
    signal: AbortSignal.timeout(30_000),
  })
  const payload = await res.json().catch(() => ({}))
  if (payload?.code === 200035) {
    throw new Error("授权码已失效，请重新发起网页登录")
  }
  const data = payload?.data ?? {}
  const access = stripBearer(data?.access_token)
  const refresh = stripBearer(data?.refresh_token)
  if (!res.ok || !access || !refresh) {
    throw new Error(payload?.message || payload?.msg || `换取凭证失败 (HTTP ${res.status})`)
  }
  return { access, refresh }
}

function toSuccessAuth(access, refresh, extra = {}) {
  const claims = decodeJwtClaims(access)
  const uid = extractUserId(claims)
  const name = extractDisplayName(claims)
  const expires = jwtExpiryMs(access)
  return {
    type: "success",
    access,
    refresh: refresh || "",
    expires,
    accountId: name || (uid ? `Raccoon-${uid}` : PROVIDER_NAME),
    uid: uid || "",
    ...(name ? { name } : {}),
    ...extra,
  }
}

function browserSignIn() {
  const state = randomUUID()
  const url = buildAuthorizeUrl(state)
  return {
    url,
    instructions:
      "在浏览器完成商汤小浣熊登录后，复制地址栏或弹窗跳转的 office-raccoon://auth/callback?code=... 链接粘贴到下方（也支持直接粘贴 JWT access_token）：",
    method: "code",
    async callback(input) {
      try {
        const parsed = parseCallbackInput(input, state)
        const tokens = parsed.direct ? parsed.direct : await exchangeAuthCode(parsed.code)
        // Auto-claim daily + onboarding grants on new sign-in
        await performCheckIn(tokens.access, {}, null).catch(() => {})
        return toSuccessAuth(tokens.access, tokens.refresh)
      } catch (e) {
        return { type: "failed", error: e?.message ?? String(e) }
      }
    },
  }
}

function desktopSignIn() {
  return {
    url: "",
    instructions: "直接复用本机商汤小浣熊客户端的实时登录态 (~/.box-agent/config/auth.json)。",
    method: "auto",
    async callback() {
      const d = readDesktopAuth()
      if (!d) return { type: "failed", error: "未检测到本机商汤小浣熊登录态 (~/.box-agent/config/auth.json)" }
      await performCheckIn(d.access, {}, null).catch(() => {})
      return {
        type: "success",
        access: d.access,
        refresh: d.refresh,
        expires: d.expires,
        source: "desktop",
        accountId: d.name || PROVIDER_NAME,
        uid: d.uid || "",
      }
    },
  }
}

// ---- Plugin export ----------------------------------------------------------

export const RaccoonAuthPlugin = async ({ client }) => {
  const saveAuth = async (next) => {
    try {
      await client?.auth?.set?.({ path: { id: PROVIDER_ID }, body: next })
    } catch {}
  }

  return {
    config: async (config) => {
      config.provider ??= {}
      const was = config.provider[PROVIDER_ID] ?? {}
      config.provider[PROVIDER_ID] = {
        name: PROVIDER_NAME,
        npm: NPM,
        api: LLM_BASE,
        ...was,
        models: { ...configModels(), ...(was.models ?? {}) },
      }
    },
    provider: {
      id: PROVIDER_ID,
      async models(provider, { auth } = {}) {
        try {
          let token = ""
          if (auth?.type === "oauth" && (auth.access || auth.source === "desktop")) {
            const { a } = await currentAuth(client, auth)
            token = a.access
          }
          const ms = await fetchLiveModels(token)
          if (!ms.length) return provider.models
          return Object.fromEntries(ms.map((m) => [m.id, runtimeModel(provider, m)]))
        } catch {
          return provider.models
        }
      },
    },
    auth: {
      provider: PROVIDER_ID,
      refreshLead: LEAD_MS,
      async refresh(auth) {
        if (auth?.type !== "oauth" || auth.source === "desktop" || !auth.access || !auth.refresh) return undefined
        const { a, didRenew } = await currentAuth(client, auth, true)
        if (!didRenew) return undefined
        return {
          access: a.access,
          refresh: a.refresh,
          expires: a.expires,
          ...(a.uid ? { uid: a.uid } : {}),
          ...(a.name ? { name: a.name } : {}),
        }
      },
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "oauth") return {}
        return {
          baseURL: LLM_BASE,
          apiKey: "raccoon",
          async fetch(input, init = {}) {
            const req = input instanceof Request ? input : null
            let bodyText = init?.body
            if (bodyText === undefined && req) bodyText = await req.clone().text()
            let requestedModel = ""
            try {
              const parsed = typeof bodyText === "string" ? JSON.parse(bodyText) : null
              if (typeof parsed?.model === "string") requestedModel = parsed.model
            } catch {}

            let { a, didRenew } = await currentAuth(client, await getAuth())
            const sendOnce = (cred) => {
              const headers = new Headers(init?.headers ?? req?.headers)
              headers.delete("x-api-key")
              headers.delete("content-length")
              headers.set("Authorization", "Bearer " + cred.access)
              headers.set("Content-Type", "application/json")
              headers.set("Accept", "*/*")
              return fetch(req ? req.url : input, {
                ...init,
                method: init?.method ?? req?.method ?? "POST",
                headers,
                body: bodyText,
              })
            }

            let res = await sendOnce(a)
            if (res.status === 401 && a.refresh) {
              try {
                const retryAuth = await currentAuth(client, a, true)
                a = retryAuth.a
                didRenew = true
                res = await sendOnce(a)
              } catch {}
            }
            const signInState = res.status === 401 ? "expired" : didRenew && res.ok ? "renewed" : "kept"
            return rewriteSseModel(res, requestedModel, signInState)
          },
        }
      },
      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "oauth" || !(auth.access || auth.source === "desktop")) {
          return { error: "not signed in", signIn: "kept" }
        }
        try {
          let { a, didRenew } = await currentAuth(client, auth)
          let result
          try {
            result = await queryUsage(a.access)
          } catch (e) {
            if (e?.status === 401 && a.refresh) {
              const retryAuth = await currentAuth(client, a, true)
              a = retryAuth.a
              didRenew = true
              result = await queryUsage(a.access)
            } else {
              throw e
            }
          }
          return {
            ...result,
            user: a.name || auth.accountId || a.uid,
            signIn: didRenew ? "renewed" : "kept",
          }
        } catch (e) {
          return {
            error: e?.message ?? String(e),
            signIn: e?.signIn === "expired" ? "expired" : "kept",
          }
        }
      },
      async checkin(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "oauth" || !(auth.access || auth.source === "desktop")) {
          return { outcome: "failed", message: "not signed in" }
        }
        const { a } = await currentAuth(client, auth)
        return performCheckIn(a.access, auth, saveAuth)
      },
      methods: [
        {
          type: "oauth",
          label: "商汤小浣熊账号 (浏览器登录 / 粘贴回调或 Token)",
          authorize: async () => browserSignIn(),
        },
        {
          type: "oauth",
          label: "商汤小浣熊桌面端登录态 (~/.box-agent/config/auth.json)",
          authorize: async () => desktopSignIn(),
        },
      ],
    },
  }
}

export const _internal = {
  stripBearer,
  decodeJwtClaims,
  jwtExpiryMs,
  hexIdToDecimal,
  extractUserId,
  extractDisplayName,
  parseCatalog,
  parseCallbackInput,
  rewriteSseModel,
  beijingTodayKey,
}
