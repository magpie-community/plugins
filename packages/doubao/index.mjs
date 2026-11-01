// Doubao (doubao.com) daily web check-in for experience credits.
//
// Ported from CreditDaddy's doubaoClient.js. The web campaign endpoints give
// a daily +200 experience-credit grant when the account's session cookie is
// valid; the server is idempotent (re-claiming returns idempotent:true).
//
// NOTE (verify before publishing): sign-in here captures the doubao.com
// session cookie through an `api`-type method whose text prompt stores the
// cookie in `auth.key`. Magpie's exact storage of a custom prompted value
// should be confirmed against the running host; the loader/checkin below
// read `auth.key` as the cookie. Doubao's web credits are NOT an agent API —
// the `provider.models` list is informational; point an agent at Volcengine
// Ark separately for real Doubao/Seed model access.
//
// Check-in contract: Magpie only understands claimed / done / ineligible /
// inactive / captcha / failed, and re-asks every 30 minutes on failed (and on
// any provisional answer before Beijing noon). So every settled answer carries
// `until` (the next Beijing midnight, plus a per-account jitter) and a dead
// session is remembered for the rest of the day instead of being re-asked
// ~48 times.
//
// Usage contract (auth.usage): Magpie draws a provider's card on its 观测 /
// 用量 page only when the plugin has this hook. It reads /alice/ug/campaign/
// v3/detail/ — the call check-in already makes, through fetchWithCooldown, so
// a cooldown sends nothing — and answers { plan, windows, signIn } with one
// 体验额度 window. Failures are answered, never thrown: { error, signIn }.

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname } from "node:path"

const DETAIL_URL = "https://www.doubao.com/alice/ug/campaign/v3/detail/"
const CHECKIN_URL = "https://www.doubao.com/alice/ug/campaign/landing/checkin"
const CAMPAIGN_GROUP = "pc_incentive_task_mvp_v3"
const LOGIN_INVALID = 710012001

const CLIENT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) DoubaoDesktop/2.32.6 Chrome/147.0.7727.149 Safari/537.36"
const COMMON_PARAMS = {
  version_code: "20800",
  language: "zh",
  device_platform: "web",
  doubao_device_platform: "web",
  aid: "497858",
  real_aid: "497858",
  pkg_type: "release_version",
  pc_version: "2.32.6",
  doubao_pc_version: "5.72.66",
  samantha_web: "1",
  web_platform: "desktop",
  "use-olympus-account": "1",
  web_tab_id: "0",
}

// ---------------------------------------------------------------------------
// Local ledger. Only timestamps and enums, never a cookie or a token.
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

// Doubao's web session is a cookie, not a bearer token. A full cookie string
// (`name=value; name=value; …`, what `document.cookie` gives) is sent as it
// is. A bare JWT — what the sign-in prompt used to ask for — is sent as
// `sessionid=`, the cookie Doubao's web session actually lives in: a bare
// value in a Cookie header has no name, so Doubao reads it as anonymous and
// answers 710012001 "login expired" whatever the token's own `exp` says.
function cookieOf(auth) {
  const full = String(auth?.metadata?.cookie ?? auth?.cookie ?? "").trim()
  if (full.includes("=")) return full
  const key = String(auth?.key ?? full ?? "").trim()
  if (!key) return ""
  return key.includes("=") ? key : `sessionid=${key}`
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
// Day boundary and per-account jitter
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000
const JITTER_MAX_MS = 15 * 60_000

// Doubao's day rolls over at Beijing midnight (the campaign is per natural
// day). `until` is the host's supported scheduling knob: "done for today, ask
// again after this instant".
function nextBeijingMidnight(now = Date.now()) {
  const dayStart = Math.floor((now + 8 * 3600_000) / DAY_MS) * DAY_MS
  return dayStart + DAY_MS - 8 * 3600_000
}

// Per-account fixed offset: the same account always lands on the same minute,
// so a restart does not reshuffle it. 15 minutes of spread keeps multiple
// accounts from waking in the same second.
function jitterOf(accountKey) {
  return createHash("sha256").update(`doubao-jitter:${accountKey}`).digest().readUInt32BE(0) % JITTER_MAX_MS
}

// Only for claimed / done / ineligible / inactive. Never for failed: that
// would swallow the "retry in 30 minutes" the host does for real errors.
function settled(accountKey) {
  return { until: new Date(nextBeijingMidnight() + jitterOf(accountKey)).toISOString() }
}

function beijingDay(now = Date.now()) {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

// Login pages, verification challenges and risk-control walls come back as
// HTML (or a JSON error) rather than the campaign payload.
const AUTH_FAIL_TEXT =
  /(请(重新)?登录|登录(已)?失效|登录状态|未登录|请完成验证|安全验证|人机验证|验证码|captcha|unusual activity|account restricted|风控|账号异常|会话已失效)/i

function deviceIdsFor(deviceSeed) {
  const seed = createHash("sha256").update(`doubao-dev:${deviceSeed || "anonymous"}`).digest()
  const webId = "76" + [...seed.subarray(0, 8)].map((b) => b % 10).join("")
  const teaUuid = [...seed.subarray(8, 16)].map((b) => b % 10).join("").padEnd(16, "7")
  return { web_id: webId, tea_uuid: teaUuid }
}

function apiUrl(base, deviceSeed) {
  const params = new URLSearchParams({ ...COMMON_PARAMS, ...deviceIdsFor(deviceSeed), device_id: "", region: "", sys_region: "" })
  return base + "?" + params.toString()
}

async function postJson(url, cookie, body, timeoutMs = 20000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Cookie: String(cookie || ""),
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        Referer: "https://www.doubao.com/pc/agent-explore",
        Origin: "https://www.doubao.com",
        "User-Agent": CLIENT_UA,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    return res
  } finally {
    clearTimeout(t)
  }
}

// Never throw on a non-JSON body: a 429 or a login page is HTML.
async function readJson(res) {
  const text = await res.text()
  try {
    const v = JSON.parse(text)
    return { text, body: v && typeof v === "object" ? v : null }
  } catch {
    return { text, body: null }
  }
}

// A dead session, not a transient error: 401/403, the login business code, or
// the login/verification wording. Anything else (502 HTML, empty body) stays
// retryable after 30 minutes.
function blockedSignal(http, body, text) {
  if (http === 401 || http === 403) return true
  if (body && Number(body.code) === LOGIN_INVALID) return true
  if (body && Number(body.code) === 0) return false
  const hay = body ? `${body.msg ?? ""} ${body.message ?? ""}` : String(text ?? "").slice(0, 4000)
  return AUTH_FAIL_TEXT.test(hay)
}

function fuseAuthExpired(accountKey) {
  stateUpdate("doubao", (accts) => {
    accts[accountKey] = { ...(accts[accountKey] ?? {}), authExpiredOn: beijingDay(), seenAt: new Date().toISOString() }
  })
}

function findCheckinTask(body) {
  const tasks = body?.data?.tasks
  if (!Array.isArray(tasks)) return null
  return tasks.find((t) => t && t.task_kind === "daily_signin") || null
}

// compact is a count as the card's display says one: whole, else to two places.
const compact = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""))

async function fetchDoubaoStatus(cookie, accountKey, deviceSeed) {
  const r = await fetchWithCooldown("doubao", accountKey, () => postJson(apiUrl(DETAIL_URL, deviceSeed), cookie, { campaign_group_code: CAMPAIGN_GROUP }))
  if (r.skipped) return { cooling: true, retryAt: r.retryAt, checkin: null, totalAmount: 0 }
  const res = r.res
  const http = res.status
  const { text, body } = await readJson(res)
  if (blockedSignal(http, body, text)) return { http, loginInvalid: true, checkin: null, totalAmount: 0 }
  // Rate limited or upstream broken: say so. An empty/odd body must never be
  // read as "this account has no check-in task".
  if (http === 429) return { http, cooling: true, checkin: null, totalAmount: 0 }
  if (http >= 500) return { http, unexpected: true, code: `HTTP ${http}`, checkin: null, totalAmount: 0 }
  if (!body) return { http, unexpected: true, code: `HTTP ${http}`, checkin: null, totalAmount: 0 }
  if (Number(body.code) !== 0) return { http, unexpected: true, code: `code ${body.code}`, checkin: null, totalAmount: 0 }
  const task = findCheckinTask(body)
  const c = task?.daily_checkin || {}
  return {
    http,
    auth: true,
    code: Number(body.code),
    checkin: task
      ? {
          checkedIn: c.checked_in_today === true,
          continuousDays: Number(c.continuous_days) || 0,
          lastDate: typeof c.last_checkin_date === "string" ? c.last_checkin_date : null,
          rewardAmount: Number(c.reward?.reward_amount) || 0,
        }
      : null,
    totalAmount: Number(body.data?.progress?.total_amount) || 0,
  }
}

async function checkinDoubao(cookie, accountKey, deviceSeed) {
  const seen = stateRead("doubao").accts[accountKey] ?? {}

  // Already known dead today: do not touch the endpoint again. The host would
  // otherwise re-ask with the same dead cookie every 30 minutes (~48/day).
  // A re-captured cookie changes accountKey, so this self-heals.
  if (seen.authExpiredOn === beijingDay()) {
    return { outcome: "failed", message: "豆包会话已失效（今日不再重试），请重新登录后重新捕获 Cookie" }
  }
  const coolingUntil = Date.parse(seen.cooldownUntil ?? "")
  if (Number.isFinite(coolingUntil) && Date.now() < coolingUntil) {
    return { outcome: "failed", message: "豆包暂时限流（本地冷却中），稍后自动重试" }
  }

  const st = await fetchDoubaoStatus(cookie, accountKey, deviceSeed)
  if (st.loginInvalid) {
    fuseAuthExpired(accountKey)
    return { outcome: "failed", message: "豆包会话已失效，请重新登录后重新捕获 Cookie" }
  }
  if (st.cooling) return { outcome: "failed", message: "豆包暂时限流（本地冷却中），稍后自动重试" }
  if (st.unexpected) return { outcome: "failed", message: `豆包接口异常（${st.code}）` }
  if (!st.checkin) return { outcome: "ineligible", message: "当前账号无签到任务（活动未开放或企业账号不支持）", ...settled(accountKey) }
  if (st.checkin.checkedIn) return { outcome: "done", streak: st.checkin.continuousDays, message: "今天已签到", ...settled(accountKey) }

  const r = await fetchWithCooldown("doubao", accountKey, () => postJson(apiUrl(CHECKIN_URL, deviceSeed), cookie, { scene: CAMPAIGN_GROUP }))
  if (r.skipped) return { outcome: "failed", message: "豆包暂时限流（本地冷却中），稍后自动重试" }
  const { text, body } = await readJson(r.res)
  if (!body) {
    if (blockedSignal(r.res.status, null, text)) {
      fuseAuthExpired(accountKey)
      return { outcome: "failed", message: "豆包会话已失效，请重新登录后重新捕获 Cookie" }
    }
    return { outcome: "failed", message: `签到接口未按预期答复（HTTP ${r.res.status}）` }
  }
  const code = Number(body.code)
  if (blockedSignal(r.res.status, body, text)) {
    fuseAuthExpired(accountKey)
    return { outcome: "failed", message: "豆包会话已失效，请重新登录后重新捕获 Cookie" }
  }
  if (r.res.status === 429) return { outcome: "failed", message: "豆包暂时限流（本地冷却中），稍后自动重试" }
  if (r.res.status >= 500) return { outcome: "failed", message: `签到接口异常（HTTP ${r.res.status}）` }
  if (!Number.isFinite(code)) return { outcome: "failed", message: `签到接口未按预期答复（HTTP ${r.res.status}）` }
  if (code !== 0) return { outcome: "failed", message: `${body.msg || body.message || "签到失败"}（code ${code}）` }
  const d = body.data || {}
  if (d.idempotent === true) return { outcome: "done", message: "今天已签到（服务端幂等去重）", ...settled(accountKey) }
  const amount = Number(d.reward_amount) || st.checkin.rewardAmount || 200
  const days = Number(d.continuous_days) || st.checkin.continuousDays + 1
  return { outcome: "claimed", credit: amount, streak: days, message: `签到成功，+${amount} 额度（连续 ${days} 天）`, ...settled(accountKey) }
}

const DOUBAO_MODELS = {
  "doubao-seed-1.6": { name: "Doubao Seed 1.6", context: 256000 },
  "doubao-1.5-pro": { name: "Doubao 1.5 Pro", context: 256000 },
  "doubao-1.5-lite": { name: "Doubao 1.5 Lite", context: 256000 },
  "doubao-pro-32k": { name: "Doubao Pro 32k", context: 32000 },
}

export const DoubaoAuthPlugin = async () => ({
  config: async (config) => {
    config.provider ??= {}
    config.provider.doubao ??= {}
    const p = config.provider.doubao
    p.name ??= "Doubao"
    p.npm ??= "@magpie-community/opencode-doubao-auth"
    p.api ??= "https://www.doubao.com"
    p.models = { ...(p.models ?? {}), ...DOUBAO_MODELS }
  },
  provider: {
    id: "doubao",
    // Doubao's web experience credits are not an agent API; this list is
    // informational. Use Volcengine Ark (api.volcengine.com) for real access.
    models: DOUBAO_MODELS,
  },
  auth: {
    provider: "doubao",
    async checkin(getAuth) {
      const auth = await getAuth()
      const cookie = cookieOf(auth)
      if (!cookie) return { outcome: "failed", message: "未提供豆包会话 Cookie" }
      const accountKey = accountKeyOf("doubao", auth)
      // The device seed is NOT the ledger key: it must stay stable across a
      // cookie recapture, otherwise every re-capture looks like a new device.
      const deviceSeed = String(auth.uid ?? "")
      try {
        return await checkinDoubao(String(cookie), accountKey, deviceSeed)
      } catch (e) {
        // Network error / timeout: keep `failed` (a 30-minute retry is right
        // here) but say it was not the credential.
        return { outcome: "failed", message: `签到请求失败：${e?.message ?? e}` }
      }
    },
    // The account's experience credits, as the campaign panel reads them.
    // detail's progress.total_amount is the only count Doubao tells: a
    // running credit total with no denominator, so it is sent as magpie's
    // wallet-shaped window (balance, no share) rather than a made-up limit.
    async usage(getAuth) {
      const auth = await getAuth()
      const cookie = cookieOf(auth)
      if (!cookie) return { error: "not signed in", signIn: "kept" }
      const accountKey = accountKeyOf("doubao", auth)
      const seen = stateRead("doubao").accts[accountKey] ?? {}
      // A fused day is answered from the ledger: a card is no reason to
      // spend a request on a session already known dead (0 requests today).
      if (seen.authExpiredOn === beijingDay()) {
        return { plan: "Web 体验额度", windows: [], error: "会话已失效，请重新登录后重新捕获 Cookie", signIn: "expired" }
      }
      const cooling = Date.parse(seen.cooldownUntil ?? "")
      if (Number.isFinite(cooling) && Date.now() < cooling) {
        return { plan: "Web 体验额度", windows: [], error: "豆包暂时限流（本地冷却中），稍后再查", signIn: "kept" }
      }
      try {
        const st = await fetchDoubaoStatus(String(cookie), accountKey, String(auth?.uid ?? ""))
        if (st.loginInvalid) {
          fuseAuthExpired(accountKey)
          return { plan: "Web 体验额度", windows: [], error: "会话已失效，请重新登录后重新捕获 Cookie", signIn: "expired" }
        }
        if (st.cooling) return { plan: "Web 体验额度", windows: [], error: "豆包暂时限流（已进入本地冷却），稍后再查", signIn: "kept" }
        if (st.unexpected) return { plan: "Web 体验额度", windows: [], error: `豆包接口异常（${st.code}）`, signIn: "kept" }
        const credits = Number(st.totalAmount) || 0
        return {
          plan: "Web 体验额度",
          windows: [{ name: "体验额度", balance: credits, display: `${compact(credits)} credits`, unit: "credits" }],
          signIn: "kept",
        }
      } catch (e) {
        return { plan: "Web 体验额度", windows: [], error: e?.message ?? String(e), signIn: "kept" }
      }
    },
    async getInfo(auth) {
      const cookie = cookieOf(auth)
      if (!cookie) return { error: "not signed in", signIn: "kept" }
      const accountKey = accountKeyOf("doubao", auth)
      const seen = stateRead("doubao").accts[accountKey] ?? {}
      if (seen.authExpiredOn === beijingDay()) return { error: "会话已失效，请重新登录后重新捕获 Cookie", signIn: "expired" }
      try {
        const st = await fetchDoubaoStatus(String(cookie), accountKey, String(auth?.uid ?? ""))
        if (st.loginInvalid) {
          fuseAuthExpired(accountKey)
          return { error: "会话已失效，请重新登录后重新捕获 Cookie", signIn: "expired" }
        }
        if (st.cooling) {
          return { plan: "Web 体验额度", windows: [], warning: "豆包暂时限流（已进入本地冷却），稍后再查", signIn: "kept" }
        }
        if (st.unexpected) return { error: `豆包接口异常（${st.code}）`, signIn: "kept" }
        return {
          plan: "Web 体验额度",
          windows: st.checkin
            ? [
                {
                  name: "今日签到",
                  total: 100,
                  used: st.checkin.checkedIn ? 100 : 0,
                  remaining: st.checkin.checkedIn ? 0 : 100,
                  unit: "%",
                  recurring: true,
                },
              ]
            : [],
          signIn: "kept",
        }
      } catch (e) {
        return { error: e?.message ?? String(e), signIn: "kept" }
      }
    },
    async loader(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api" || !auth.key) return {}
      return {
        baseURL: "",
        apiKey: "",
        headers: { Cookie: cookieOf(auth), "User-Agent": CLIENT_UA },
      }
    },
    methods: [
      {
        type: "api",
        label: "网页 Cookie（完整 document.cookie）",
        prompts: [
          {
            type: "text",
            key: "cookie",
            message:
              "粘贴 doubao.com 的完整 Cookie（浏览器 F12 → Network → 任一请求 → Request Headers 里的 Cookie 整行，形如 `sessionid=…; sessionid_ss=…; sid_tt=…`）。只贴一串 JWT 会被豆包当成未登录（710012001）。",
          },
        ],
      },
    ],
  },
})
