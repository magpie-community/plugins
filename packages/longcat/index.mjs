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

const LC_BASE = "https://longcat.chat"
const LC_PACKS_SUMMARY_URL = `${LC_BASE}/api/pay/quota/metering/token-packs/summary`
const LC_IDENTITY_URL = `${LC_BASE}/api/v1/user-current`

const LC_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"

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

async function fetchLongcatPacks(cookie, timeoutMs = 20000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  let res
  try {
    res = await fetch(LC_PACKS_SUMMARY_URL, { method: "POST", headers: lcHeaders(cookie), body: "{}", signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
  if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, authExpired: true }
  if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` }
  const body = await res.json().catch(() => null)
  if (!body || typeof body !== "object") return { ok: false, error: "非 JSON 响应" }
  if (Number(body.code) === 401) return { ok: false, status: 401, authExpired: true, error: String(body.msg || "会话失效") }
  if (Number(body.code) !== 0) return { ok: false, status: res.status, error: `业务错误 code ${body.code}：${body.msg || ""}`.trim() }
  const parsed = parsePacksSummary(body)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  return { ok: true, packs: parsed.packs }
}

function pct1(rem, tot) {
  return tot > 0 ? Math.max(0, Math.min(100, Math.round((rem / tot) * 1000) / 10)) : 0
}

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
    methods: [
      {
        type: "api",
        label: "会话 Cookie",
        prompts: [{ type: "text", key: "cookie", message: "粘贴 longcat.chat 会话 Cookie（美团 SSO）" }],
      },
    ],
    async loader(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api" || !auth.key) return {}
      return { baseURL: "", apiKey: "", headers: lcHeaders(auth.key) }
    },
    // LongCat grants are purchased/gifted: no daily check-in endpoint.
    async checkin() {
      return { outcome: "ineligible", message: "LongCat 资源包为购买/赠送发放，无每日签到" }
    },
    async getInfo(auth) {
      const cookie = auth?.key
      if (!cookie) return { error: "not signed in", signIn: "kept" }
      const r = await fetchLongcatPacks(cookie)
      if (!r.ok) return r.authExpired ? { error: "会话已失效", signIn: "expired" } : { error: r.error || `HTTP ${r.status}`, signIn: "kept" }
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
  },
})
