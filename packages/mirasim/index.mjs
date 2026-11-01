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

const AUTH_ME_URL = "https://auth.mirasim.ai/auth/me"
const RELAY_LIMITS_URL = "https://relay.mirasim.ai/v1/limits"
const AUTH_REFRESH_URL = "https://auth.mirasim.ai/auth/refresh"

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
  return { Authorization: `Bearer ${token}`, Accept: "application/json" }
}

export async function refreshMirasimToken(refreshToken) {
  if (!refreshToken) throw new Error("没有 refreshToken，无法刷新，请重新登录后重新导入")
  const res = await jget(AUTH_REFRESH_URL, { "Content-Type": "application/json", Accept: "application/json" }, 20000)
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      const e = new Error("refreshToken 已失效，请重新登录后重新导入")
      e.authInvalid = true
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

export function normalizeMirasimLimits(limits, profile = null) {
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
  const parts = windows.map((w) => {
    const budget = Number(w.budget) || 0
    const used = Number(w.used) || 0
    const remaining = Math.max(0, budget - used)
    const usedPct = budget > 0 ? Math.min(100, Math.round((used / budget) * 1000) / 10) : 0
    return {
      name: WINDOW_LABELS[w.name] || w.name,
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
    async loader(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api" || !auth.key) return {}
      return {
        baseURL: "https://relay.mirasim.ai/v1",
        apiKey: String(auth.key),
        headers: authHeaders(auth.key),
      }
    },
    async checkin() {
      return { outcome: "ineligible", message: "MiraSim 无每日签到；额度来自套餐滚动窗口" }
    },
    async getInfo(auth) {
      const token = auth?.key
      if (!token) return { error: "not signed in", signIn: "kept" }
      try {
        const pres = await jget(AUTH_ME_URL, authHeaders(token))
        if (pres.status === 401) return { error: "令牌已过期", signIn: "expired" }
        const profile = pres.ok ? await pres.json().catch(() => null) : null
        const lres = await jget(RELAY_LIMITS_URL, { ...authHeaders(token), "x-mirasim-probe": "usage" })
        if (lres.status === 401) return { error: "令牌已过期", signIn: "expired" }
        if (lres.status === 429) {
          return { plan: profile?.plan || "Plus", windows: [], warning: "云端限流或直连网络受限（配置代理后可查实时窗口）", signIn: "kept" }
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
    async refresh(auth) {
      const rt = auth?.refresh
      if (!rt) return auth
      try {
        const creds = await refreshMirasimToken(rt)
        return { ...auth, key: creds.token, refresh: creds.refreshToken, expiresAt: creds.expiresAt }
      } catch {
        return auth
      }
    },
  },
})
