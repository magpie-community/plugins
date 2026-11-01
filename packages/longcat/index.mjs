// LongCat (longcat.chat, Meituan) token resource-pack balance reader.
//
// Ported from CreditDaddy's longcatClient.js. LongCat grants are purchased
// or gifted (no daily check-in endpoint); this plugin reads the active
// token packs' remaining/total/expiry and reports them as Magpie usage
// windows. Auth is the longcat.chat session cookie (Meituan SSO).
//
// NOTE (verify before publishing): the `api`-type method stores the session
// cookie in `auth.key`; the loader/getInfo below read it there. Magpie's
// exact storage of a custom prompted value should be confirmed against the
// running host.
//
// Usage contract (auth.usage): Magpie draws a provider's card on its 观测 /
// 用量 page only when the plugin has this hook. It reads the token-packs
// summary (/api/pay/quota/metering/token-packs/summary) — the call getInfo
// already makes, through fetchWithCooldown, so a cooldown sends nothing — and
// answers { plan, windows, signIn } with the packs' remaining as one 资源包
// window. Failures are answered, never thrown: { error, signIn }.

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname } from "node:path"

const LC_BASE = "https://longcat.chat"
const LC_PACKS_SUMMARY_URL = `${LC_BASE}/api/pay/quota/metering/token-packs/summary`
const LC_IDENTITY_URL = `${LC_BASE}/api/v1/user-current`

const LC_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"

// ---------------------------------------------------------------------------
// Local ledger. Only timestamps and enums, never a cookie.
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

function lcHeaders(cookie) {
  return {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    Cookie: String(cookie || "").trim(),
    Referer: `${LC_BASE}/platform/usage`,
    Origin: LC_BASE,
    "x-requested-with": "XMLHttpRequest",
    "m-appkey": "fe_com.sankuai.friday.longcat.platform",
    "X-Client-Language": "zh",
    "User-Agent": LC_UA,
  }
}

function lcTimeToIso(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s || ""))
  if (!m) return null
  const ts = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +m[6])
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null
}

function parsePacksSummary(body) {
  const d = body?.data && typeof body.data === "object" ? body.data : null
  if (!d) return { ok: false, error: "summary 响应无 data" }
  const lots = []
  if (d.currentLot && typeof d.currentLot === "object") lots.push(d.currentLot)
  if (Array.isArray(d.otherLots)) lots.push(...d.otherLots.filter((x) => x && typeof x === "object"))
  const packs = []
  for (const it of lots) {
    if (String(it.status || "ACTIVE") !== "ACTIVE") continue
    const remaining = Number(it.remainingToken)
    const total = Number(it.totalToken)
    if (!Number.isFinite(remaining) || !Number.isFinite(total)) continue
    packs.push({
      total,
      remaining: Math.max(0, remaining),
      consumed: Number(it.consumedToken) || 0,
      expireAt: lcTimeToIso(it.expireTime),
      grantCategory: String(it.grantCategory || ""),
      source: String(it.source || ""),
      consumeOrder: Number(it.consumeOrder) || 99,
    })
  }
  packs.sort((a, b) => a.consumeOrder - b.consumeOrder || String(a.expireAt).localeCompare(String(b.expireAt)))
  return { ok: true, packs }
}

async function fetchLongcatPacks(cookie, accountKey, timeoutMs = 20000) {
  const r = await fetchWithCooldown("longcat", accountKey, () => {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    return fetch(LC_PACKS_SUMMARY_URL, { method: "POST", headers: lcHeaders(cookie), body: "{}", signal: ctrl.signal }).finally(() => clearTimeout(t))
  })
  if (r.skipped) return { ok: false, cooling: true, retryAt: r.retryAt }
  const res = r.res
  if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, authExpired: true }
  if (res.status === 429 || res.status >= 500) return { ok: false, status: res.status, error: `HTTP ${res.status}`, cooling: r.cooled === true }
  if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` }
  const body = await res.json().catch(() => null)
  if (!body || typeof body !== "object") return { ok: false, error: "非 JSON 响应" }
  if (Number(body.code) === 401) return { ok: false, status: 401, authExpired: true, error: String(body.msg || "会话失效") }
  if (Number(body.code) !== 0) return { ok: false, status: res.status, error: `业务错误 code ${body.code}：${body.msg || ""}`.trim() }
  const parsed = parsePacksSummary(body)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  return { ok: true, packs: parsed.packs }
}

// The fetch result, translated into what a usage card can show: a cooldown
// must read as "wait a bit", never as "HTTP undefined".
function longcatAfterPacks(r) {
  if (r.cooling) return { plan: "Token 资源包", windows: [], warning: "longcat 暂时限流（已进入本地冷却），稍后再查", signIn: "kept" }
  if (!r.ok) return r.authExpired ? { error: "会话已失效", signIn: "expired" } : { error: r.error || `HTTP ${r.status}`, signIn: "kept" }
  return null
}

function pct1(rem, tot) {
  return tot > 0 ? Math.max(0, Math.min(100, Math.round((rem / tot) * 1000) / 10)) : 0
}

// compact is a count as the card's display says one: whole, else to two places.
const compact = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""))

const LONGCAT_MODELS = {
  "longcat-default": { name: "LongCat (token pack)", context: 128000 },
}

export const LongCatAuthPlugin = async () => ({
  config: async (config) => {
    config.provider ??= {}
    config.provider.longcat ??= {}
    const p = config.provider.longcat
    p.name ??= "LongCat"
    p.npm ??= "@magpie-community/opencode-longcat-auth"
    p.api ??= "https://longcat.chat"
    p.models = { ...(p.models ?? {}), ...LONGCAT_MODELS }
  },
  provider: {
    id: "longcat",
    models: LONGCAT_MODELS,
  },
  auth: {
    provider: "longcat",
    // LongCat grants are purchased/gifted: no daily check-in endpoint.
    async checkin() {
      return { outcome: "ineligible", message: "LongCat 资源包为购买/赠送发放，无每日签到" }
    },
    // The packs' remaining tokens, as the usage page reads them: one window
    // for what is left over all packages, and — with more than one pack —
    // each pack's own share, beside the account, since spending one up only
    // moves on to the next.
    async usage(getAuth) {
      const auth = await getAuth()
      const cookie = auth?.key
      if (!cookie) return { error: "not signed in", signIn: "kept" }
      try {
        const r = await fetchLongcatPacks(String(cookie), accountKeyOf("longcat", auth))
        if (r.cooling) return { plan: "Token 资源包", windows: [], error: "longcat 暂时限流（本地冷却中），稍后再查", signIn: "kept" }
        if (!r.ok) {
          return {
            plan: "Token 资源包",
            windows: [],
            error: r.authExpired ? "会话已失效，请重新登录后重新捕获 Cookie" : r.error || `HTTP ${r.status}`,
            signIn: r.authExpired ? "expired" : "kept",
          }
        }
        const active = r.packs.filter((p) => Number.isFinite(Number(p.remaining)))
        const balance = active.reduce((s, p) => s + Math.max(0, Number(p.remaining)), 0)
        const windows = [{ name: "Token 资源包", balance, display: `${compact(balance)} tokens`, unit: "tokens" }]
        if (active.length > 1) {
          for (const [i, p] of active.entries()) {
            const total = Math.max(0, Number(p.total) || 0)
            const remain = Math.max(0, Number(p.remaining) || 0)
            const used = Math.max(0, Number(p.consumed) || 0)
            const gift = p.grantCategory === "GIFT" || p.source === "FREE_PACK"
            windows.push({
              name: `${gift ? "获赠资源包" : "资源包"} ${i + 1}`,
              ...(total > 0 ? { used: (100 * used) / total, amount: used, limit: total } : {}),
              display: `${compact(remain)} / ${compact(total)}`,
              unit: "tokens",
              // what is left in the pack is lost when it expires
              ...(p.expireAt ? { runsOutAt: p.expireAt, runsOut: remain } : {}),
              aside: true,
            })
          }
        }
        return { plan: "Token 资源包", windows, signIn: "kept" }
      } catch (e) {
        return { plan: "Token 资源包", windows: [], error: e?.message ?? String(e), signIn: "kept" }
      }
    },
    async getInfo(auth) {
      const cookie = auth?.key
      if (!cookie) return { error: "not signed in", signIn: "kept" }
      const r = await fetchLongcatPacks(String(cookie), accountKeyOf("longcat", auth))
      const done = longcatAfterPacks(r)
      if (done) return done
      const active = r.packs.filter((p) => Number.isFinite(Number(p.remaining)))
      const balance = active.reduce((s, p) => s + Math.max(0, Number(p.remaining)), 0)
      const totalAll = active.reduce((s, p) => s + Math.max(0, Number(p.total) || 0), 0)
      const usedAll = active.reduce((s, p) => s + Math.max(0, Number(p.consumed) || 0), 0)
      return {
        plan: "Token 资源包",
        windows: [
          {
            name: `剩余 ${balance} Token`,
            total: totalAll,
            used: usedAll,
            remaining: balance,
            remainingPercentage: pct1(balance, totalAll),
            unit: "",
            recurring: false,
          },
        ],
        signIn: "kept",
      }
    },
    async loader(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api" || !auth.key) return {}
      return { baseURL: "", apiKey: "", headers: lcHeaders(auth.key) }
    },
    methods: [
      {
        type: "api",
        label: "会话 Cookie",
        prompts: [{ type: "text", key: "cookie", message: "粘贴 longcat.chat 会话 Cookie（美团 SSO）" }],
      },
    ],
  },
})
