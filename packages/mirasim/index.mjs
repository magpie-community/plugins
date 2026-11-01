// MiraSim (mirasim.ai) provider: token auth, profile, and 5h/7d rolling
// window quota, with refresh-token renewal.
//
// Ported from CreditDaddy's mirasimClient.js. The relay host serves the
// agent API; this plugin wires token auth + quota reporting and exposes the
// rolling windows as Magpie usage. Auth is an access token (plus optional
// refresh token).
//
// NOTE (verify before publishing): the `api`-type method stores the access
// token in `auth.key`; an optional second prompt captures the refresh token
// (read as `auth.refresh` here, but Magpie's multi-prompt storage should be
// confirmed against the running host). The chat endpoint baseURL is set to
// the relay host; confirm the exact path (e.g. /v1/messages vs
// /v1/chat/completions) before publishing.
//
// Renewal: the host already coalesces refresh requests inside one process, but
// the GUI and the CLI are two processes and a single-use refresh token spent
// twice signs the account out. So this file adds an in-process single flight
// plus a cross-process lock file, and stops swallowing the "refresh token is
// dead" error (it used to be silent, leaving the account looking alive until
// every request 401'd).
//
// Usage contract (auth.usage): Magpie draws a provider's card on its 观测 /
// 用量 page only when the plugin has this hook. It reads /v1/limits, with
// /auth/me for the plan — the calls getInfo already makes, limits through
// fetchWithCooldown, so a cooldown sends nothing — and answers { plan, until,
// windows, signIn } with the 5h / 7d rolling windows. Failures are answered,
// never thrown: { error, signIn } ("expired" when the token is dead).

import { createHash } from "node:crypto"
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname } from "node:path"

const AUTH_ME_URL = "https://auth.mirasim.ai/auth/me"
const RELAY_LIMITS_URL = "https://relay.mirasim.ai/v1/limits"
const AUTH_REFRESH_URL = "https://auth.mirasim.ai/auth/refresh"

// A 429 from the relay is one of two things: "too many requests" (wait and it
// passes) or "this network region is not served at all"
// (type shared_quota_unavailable). The second never passes by waiting on the
// same network, so cooling down for it hides the real reason and makes the
// card look like a rate limit the user could sit out.
const REGION_BLOCKED_TEXT = "MiraSim 云端中转在当前网络区域不提供服务（shared_quota_unavailable），与账号无关：换地区/换网络才能用"

function regionBlocked(body) {
  const type = String(body?.type ?? body?.error?.type ?? "")
  const msg = String(body?.error?.message ?? body?.message ?? "")
  return type === "shared_quota_unavailable" || /network region|not served/i.test(msg)
}

// A stable client UA. Bun's fetch sends `user-agent: Bun/<version>` by default,
// which is a free fingerprint for a Bearer-token caller. Same status with
// either UA (measured), so this is hygiene rather than a risk-control measure.
const RELAY_UA = "mirasim-cli/1.0"

// ---------------------------------------------------------------------------
// Local ledger. Only timestamps and enums, never a token.
// ~/.config/magpie/<provider>-state.json, deliberately NOT the host's
// plugin-auth.json (credentials) nor plugin-checkin.json.
// ---------------------------------------------------------------------------

const STATE_VERSION = 1
const STATE_TTL_MS = 30 * 86_400_000

function statePath(provider) {
  const override = process.env[`MAGPIE_${provider.toUpperCase()}_STATE`]
  if (override) return override
  const dir = process.env.XDG_CONFIG_HOME ? `${process.env.XDG_CONFIG_HOME}/magpie` : `${homedir()}/.config/magpie`
  return `${dir}/${provider}-state.json`
}

// Reads on every call: the GUI and the CLI may be two processes, an in-memory
// cache would overwrite the other side's writes.
function stateRead(provider) {
  try {
    const v = JSON.parse(readFileSync(statePath(provider), "utf8"))
    if (v && typeof v === "object" && typeof v.accts === "object") return v
  } catch {}
  return { v: STATE_VERSION, accts: {} }
}

// Temp file + rename so a concurrent write never leaves half a file; 0600 to
// match the other magpie files. Entries unseen for 30 days are dropped.
function stateWrite(provider, st) {
  try {
    const now = Date.now()
    for (const [k, v] of Object.entries(st.accts)) {
      const t = Date.parse(v?.seenAt ?? "")
      if (Number.isFinite(t) && now - t > STATE_TTL_MS) delete st.accts[k]
    }
    const p = statePath(provider)
    mkdirSync(dirname(p), { recursive: true })
    const tmp = `${p}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ v: STATE_VERSION, accts: st.accts }), { mode: 0o600 })
    renameSync(tmp, p)
  } catch {}
  return st
}

function stateUpdate(provider, fn) {
  const st = stateRead(provider)
  try {
    fn(st.accts)
  } catch {
    return st
  }
  return stateWrite(provider, st)
}

// Sign-in results are keyed by sign-in key, never by display name (magpie
// plugins#254: with duplicate names only the first account gets signed in).
function accountKeyOf(provider, auth) {
  const uid = String(auth?.uid ?? "").trim()
  if (uid) return `uid:${uid}`
  const secret = String(auth?.key ?? auth?.refresh ?? "")
  return `${provider}:${createHash("sha256").update(secret).digest("hex").slice(0, 16)}`
}

// ---------------------------------------------------------------------------
// Cross-process lock (O_EXCL is atomic on a local disk, which is where the
// magpie config directory lives)
// ---------------------------------------------------------------------------

function lockAcquire(path, staleMs = 30_000) {
  const take = () => {
    try {
      mkdirSync(dirname(path), { recursive: true })
      closeSync(openSync(path, "wx", 0o600))
      return true
    } catch {
      return false
    }
  }
  if (take()) return true
  // The last holder died mid-renewal: clear the stale lock and try once more.
  try {
    if (Date.now() - statSync(path).mtimeMs < staleMs) return false
    unlinkSync(path)
  } catch {
    return false
  }
  return take()
}

function lockRelease(path) {
  try {
    unlinkSync(path)
  } catch {}
}

// ---------------------------------------------------------------------------
// 429 / Retry-After / full-jitter backoff
// ---------------------------------------------------------------------------

const RETRY_AFTER_CAP_MS = 10 * 60_000

// Upstream Retry-After is not passed through to the agent (magpie writes that
// header itself), so the plugin has to read and honour it.
function retryAfterMs(res) {
  const h = res.headers.get("retry-after")
  if (!h) return 0
  const n = Number(h)
  if (Number.isFinite(n) && n >= 0) return Math.min(n * 1000, RETRY_AFTER_CAP_MS)
  const t = Date.parse(h)
  return Number.isFinite(t) ? Math.min(Math.max(0, t - Date.now()), RETRY_AFTER_CAP_MS) : 0
}

// Full jitter: 0..min(cap, base*2^attempt). Un-jittered backoff only turns
// "everyone retries at once" into "everyone retries at once, later".
function backoffMs(attempt, base = 800, cap = 8000) {
  return Math.round(Math.random() * Math.min(cap, base * 2 ** attempt))
}

// 3 tries, at most 2s of sleeping: when the vendor says "come back in 2
// minutes" we record a cooldown instead of hanging the hook for 2 minutes.
async function fetchWithCooldown(provider, accountKey, doFetch, { tries = 3, maxWaitMs = 2000 } = {}) {
  const until = Date.parse(stateRead(provider).accts[accountKey]?.cooldownUntil ?? "")
  if (Number.isFinite(until) && Date.now() < until) return { skipped: true, retryAt: new Date(until).toISOString() }
  let res
  for (let attempt = 0; attempt < tries; attempt++) {
    res = await doFetch()
    if (res.status !== 429 && res.status < 500) return { res }
    const wait = retryAfterMs(res) || backoffMs(attempt)
    if (attempt === tries - 1 || wait > maxWaitMs) {
      stateUpdate(provider, (accts) => {
        accts[accountKey] = { ...(accts[accountKey] ?? {}), cooldownUntil: new Date(Date.now() + wait).toISOString(), seenAt: new Date().toISOString() }
      })
      return { res, cooled: true }
    }
    await new Promise((r) => setTimeout(r, wait))
  }
  return { res }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function jget(url, headers, timeoutMs = 20000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { headers, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": RELAY_UA }
}

// Internal only — exporting this made Magpie's plugin host treat it as a hook.
async function refreshMirasimToken(refreshToken) {
  if (!refreshToken) throw new Error("没有 refreshToken，无法刷新，请重新登录后重新导入")
  const res = await fetch(AUTH_REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": RELAY_UA },
    body: JSON.stringify({ refresh_token: refreshToken }),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    // 401/403, or the OAuth "this grant is gone" wording: the credential is
    // dead, retrying it will never bring it back.
    if (res.status === 401 || res.status === 403 || /invalid_grant|invalid_token|token_revoked|refresh_token_reused/i.test(text)) {
      const e = new Error("refreshToken 已失效，请重新登录后重新导入")
      e.authInvalid = true
      e.signIn = "expired"
      throw e
    }
    throw new Error(`mirasim 凭据刷新失败: HTTP ${res.status}`)
  }
  const d = await res.json()
  const token = d.access_token || d.accessToken
  if (!token) throw new Error("mirasim 刷新响应缺少 access_token")
  let expiresAt = null
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"))
    if (Number.isFinite(p.exp)) expiresAt = new Date(p.exp * 1000).toISOString()
  } catch {}
  return { token, refreshToken: d.refresh_token || d.refreshToken || refreshToken, expiresAt }
}

// ---------------------------------------------------------------------------
// Renewal: in-process single flight + cross-process lock
// ---------------------------------------------------------------------------

// One renewal at a time per process. The host does this too, but a second
// plugin instance forked from it is out of its reach.
let refreshing = null

const LOCK_STALE_MS = 30_000
// Another process just renewed: do not spend the refresh token again inside
// this window.
const JUST_REFRESHED_MS = 120_000

async function refreshOnce(auth, accountKey) {
  const lock = `${statePath("mirasim")}.${accountKey.replace(/[^A-Za-z0-9._-]/g, "_")}.lock`
  // Another process is renewing right now: skip, do not spend the RT twice.
  if (!lockAcquire(lock, LOCK_STALE_MS)) return auth
  try {
    const since = Date.parse(stateRead("mirasim").accts[accountKey]?.refreshedAt ?? "")
    if (Number.isFinite(since) && Date.now() - since < JUST_REFRESHED_MS) return auth
    const creds = await refreshMirasimToken(auth.refresh)
    stateUpdate("mirasim", (accts) => {
      accts[accountKey] = { refreshedAt: new Date().toISOString(), seenAt: new Date().toISOString() }
    })
    return { ...auth, key: creds.token, refresh: creds.refreshToken, expiresAt: creds.expiresAt }
  } catch (e) {
    // Host contract: throwing with signIn:"expired" marks the account and
    // stops retrying. Swallowing this (the old behaviour) kept a dead refresh
    // token invisible while every request kept 401'ing.
    if (e?.authInvalid || e?.signIn === "expired") throw Object.assign(new Error(e.message), { signIn: "expired" })
    return auth // transient (network / 5xx): keep the old state, retry later
  } finally {
    lockRelease(lock)
  }
}

// Internal only — keep module exports limited to the plugin factory.
async function mirasimRefreshHook(auth) {
  if (!auth?.refresh) return auth
  const accountKey = accountKeyOf("mirasim", auth)
  if (refreshing) return refreshing
  refreshing = refreshOnce(auth, accountKey)
  try {
    return await refreshing
  } finally {
    refreshing = null
  }
}

// Internal only — keep module exports limited to the plugin factory.
function normalizeMirasimLimits(limits, profile = null) {
  const windows = Array.isArray(limits?.windows) ? limits.windows : []
  const epochToIso = (sec) => (Number.isFinite(sec) && sec > 0 ? new Date(sec * 1000).toISOString() : null)
  const WINDOW_LABELS = {
    "5h": "5小时窗口",
    "7d": "7天全局窗口",
    "7d_claude": "7天 Claude 上限",
    "7d_sonnet": "7天 Sonnet 上限",
    "7d_opus": "7天 Opus 上限",
    "7d_fable": "7天 Fable 上限",
  }
  // How long each rolling window runs, in seconds, as magpie's window says
  // it (a 7-day cap is seven days, whatever it caps).
  const WINDOW_SPANS = { "5h": 18_000, "7d": 604_800, "7d_claude": 604_800, "7d_sonnet": 604_800, "7d_opus": 604_800, "7d_fable": 604_800 }
  const parts = windows.map((w) => {
    const budget = Number(w.budget) || 0
    const used = Number(w.used) || 0
    const remaining = Math.max(0, budget - used)
    const usedPct = budget > 0 ? Math.min(100, Math.round((used / budget) * 1000) / 10) : 0
    return {
      name: WINDOW_LABELS[w.name] || w.name,
      span: WINDOW_SPANS[w.name] || 0,
      total: budget,
      used,
      remaining,
      percent: usedPct,
      remainingPercentage: Math.max(0, Math.round((100 - usedPct) * 10) / 10),
      unit: "",
      resetAt: epochToIso(w.reset_at),
      recurring: true,
    }
  })
  const w5h = parts.find((p) => p.name.includes("5小时"))
  const w7d = parts.find((p) => p.name.includes("7天全局"))
  const bottleneck = w7d && w7d.remainingPercentage <= 0 ? w7d : w5h && w5h.remainingPercentage <= 0 ? w5h : w7d && w5h ? (w7d.remainingPercentage < w5h.remainingPercentage ? w7d : w5h) : parts[0] || null
  const rem = bottleneck ? bottleneck.remainingPercentage : 0
  return {
    total: 100,
    used: 100 - rem,
    remaining: rem,
    unit: "%",
    plan: profile?.plan ? String(profile.plan).toUpperCase() : limits?.paid ? "PRO" : "FREE",
    planExpiresAt: epochToIso(profile?.plan_exp),
    bottleneckLabel: bottleneck && bottleneck.remainingPercentage <= 0 ? bottleneck.name + "已用尽" : null,
    parts,
    empty: parts.length === 0,
    exceeded: limits?.suspended === true || (bottleneck ? bottleneck.remainingPercentage <= 0 : false),
  }
}

const MIRASIM_MODELS = {
  "mirasim-default": { name: "MiraSim", context: 200000 },
}

// compact is a count as the card's display says one: whole, else to two places.
const compact = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""))

// usageWindow is one normalized part as magpie's window: the share used of
// its budget, the window's own length, and when it starts again. A part the
// relay gives no budget for has no share to tell, so it says only its name.
function usageWindow(p) {
  const w = { name: p.name, span: p.span || 0 }
  if (p.resetAt) w.resetsAt = p.resetAt
  if (p.total > 0) {
    w.used = p.percent
    w.amount = p.used
    w.limit = p.total
    w.display = `${compact(p.used)} / ${compact(p.total)}`
  }
  return w
}

// renewForUsage answers a read the relay refused with the account's own
// renewal, once: { auth, renewed } when another token came back, { expired }
// when the refresh token itself is dead (or there is none to spend), {} when
// another process is renewing right now or the network was out — a sign-in is
// not marked dead for those.
async function renewForUsage(auth) {
  if (!auth?.refresh) return { expired: true }
  try {
    const next = await mirasimRefreshHook(auth)
    return next?.key && next.key !== auth.key ? { auth: next, renewed: true } : {}
  } catch (e) {
    return e?.signIn === "expired" || e?.authInvalid ? { expired: true } : {}
  }
}

export const MiraSimAuthPlugin = async () => ({
  config: async (config) => {
    config.provider ??= {}
    config.provider.mirasim ??= {}
    const p = config.provider.mirasim
    p.name ??= "MiraSim"
    p.npm ??= "@magpie-community/opencode-mirasim-auth"
    p.api ??= "https://relay.mirasim.ai/v1"
    p.models = { ...(p.models ?? {}), ...MIRASIM_MODELS }
  },
  provider: {
    id: "mirasim",
    models: MIRASIM_MODELS,
  },
  auth: {
    provider: "mirasim",
    refresh: mirasimRefreshHook,
    async checkin() {
      return { outcome: "ineligible", message: "MiraSim 无每日签到；额度来自套餐滚动窗口" }
    },
    // The plan's rolling windows, as /v1/limits tells them: each part's share
    // used, its own length (5 hours, 7 days) and when it starts again. A 401
    // is answered once by the account's own renewal, as a chat's is.
    async usage(getAuth) {
      let auth = await getAuth()
      if (!auth?.key) return { error: "not signed in", signIn: "kept" }
      const accountKey = accountKeyOf("mirasim", auth)
      const cooling = Date.parse(stateRead("mirasim").accts[accountKey]?.cooldownUntil ?? "")
      if (Number.isFinite(cooling) && Date.now() < cooling) {
        return { windows: [], error: "云端限流（本地冷却中），稍后再查", signIn: "kept" }
      }
      try {
        let said = "kept"
        // the same call getInfo makes, through the ledger's cooldown
        const limits = () => fetchWithCooldown("mirasim", accountKey, () => jget(RELAY_LIMITS_URL, { ...authHeaders(auth.key), "x-mirasim-probe": "usage" }))
        let r = await limits()
        if (!r.skipped && r.res.status === 401) {
          const next = await renewForUsage(auth)
          if (!next.renewed) {
            return { windows: [], error: "令牌已过期，请重新登录后重新导入", signIn: next.expired ? "expired" : "kept" }
          }
          auth = next.auth
          said = "renewed"
          r = await limits()
        }
        if (r.skipped) return { windows: [], error: "云端限流（本地冷却中），稍后再查", signIn: said }
        const lres = r.res
        if (lres.status === 401) return { windows: [], error: "令牌已过期（续期一次后仍被拒绝）", signIn: "expired" }
        if (lres.status === 429) {
          const why = await lres.json().catch(() => null)
          if (regionBlocked(why)) return { windows: [], error: REGION_BLOCKED_TEXT, signIn: said }
          return { windows: [], error: "云端限流（已进入本地冷却），稍后再查", signIn: said }
        }
        if (!lres.ok) return { windows: [], error: `查询额度失败: HTTP ${lres.status}`, signIn: said }
        const limitsBody = await lres.json()
        // the plan's name and end belong to the profile, which a card can do
        // without: a failed read leaves the plan as the limits said it
        let profile = null
        try {
          const pres = await jget(AUTH_ME_URL, authHeaders(auth.key))
          if (pres.ok) profile = await pres.json().catch(() => null)
        } catch {}
        const norm = normalizeMirasimLimits(limitsBody, profile)
        return { plan: norm.plan, until: norm.planExpiresAt ?? "", windows: norm.parts.map(usageWindow), signIn: said }
      } catch (e) {
        return { windows: [], error: e?.message ?? String(e), signIn: e?.signIn === "expired" ? "expired" : "kept" }
      }
    },
    async getInfo(auth) {
      const token = auth?.key
      if (!token) return { error: "not signed in", signIn: "kept" }
      const accountKey = accountKeyOf("mirasim", auth)
      const until = Date.parse(stateRead("mirasim").accts[accountKey]?.cooldownUntil ?? "")
      if (Number.isFinite(until) && Date.now() < until) {
        return { plan: "MiraSim", windows: [], warning: "云端限流（本地冷却中），稍后再查", signIn: "kept" }
      }
      try {
        const pres = await jget(AUTH_ME_URL, authHeaders(token))
        if (pres.status === 401) return { error: "令牌已过期", signIn: "expired" }
        const profile = pres.ok ? await pres.json().catch(() => null) : null
        const r = await fetchWithCooldown("mirasim", accountKey, () => jget(RELAY_LIMITS_URL, { ...authHeaders(token), "x-mirasim-probe": "usage" }))
        if (r.skipped) return { plan: profile?.plan || "Plus", windows: [], warning: "云端限流（本地冷却中），稍后再查", signIn: "kept" }
        const lres = r.res
        if (lres.status === 401) return { error: "令牌已过期", signIn: "expired" }
        if (lres.status === 429) {
          // The wrapper already recorded the cooldown, so the next refresh of
          // the panel will not hit the endpoint again. A region block is said
          // as what it is instead of as a rate limit.
          const why = await lres.json().catch(() => null)
          if (regionBlocked(why)) return { plan: profile?.plan || "Plus", windows: [], error: REGION_BLOCKED_TEXT, signIn: "kept" }
          return { plan: profile?.plan || "Plus", windows: [], warning: "云端限流（已进入本地冷却），稍后再查", signIn: "kept" }
        }
        if (!lres.ok) return { error: `查询额度失败: HTTP ${lres.status}`, signIn: "kept" }
        const limits = await lres.json()
        const norm = normalizeMirasimLimits(limits, profile)
        return {
          plan: norm.plan,
          planExpiresAt: norm.planExpiresAt,
          windows: norm.parts,
          signIn: "kept",
        }
      } catch (e) {
        if (e.authInvalid) return { error: e.message, signIn: "expired" }
        return { error: e?.message ?? String(e), signIn: "kept" }
      }
    },
    async loader(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api" || !auth.key) return {}
      return {
        baseURL: "https://relay.mirasim.ai/v1",
        apiKey: String(auth.key),
        headers: authHeaders(auth.key),
      }
    },
    methods: [
      {
        type: "api",
        label: "访问令牌",
        prompts: [
          { type: "text", key: "token", message: "粘贴 mirasim.ai 访问令牌（Bearer）" },
          { type: "text", key: "refresh", message: "（可选）粘贴 refresh token 以自动续期" },
        ],
      },
    ],
  },
})
