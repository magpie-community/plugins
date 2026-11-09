// TaoToken CodingPlan, as an OpenCode / magpie provider plugin.
//
// Two credentials, one account:
//   • API key (sk-…)      — the coding gateway's models, calls via
//                           https://api.taotoken.net/coding/v1 (OpenAI-compatible).
//   • login token (JWT)   — the console's CodingPlan usage, read from
//                           GET https://taotoken.net/api/v1/plan/overview.
//                           It is the value of the `token` cookie when signed
//                           in at taotoken.net (Browser DevTools → Application
//                           → Cookies → token). Works as `Authorization` JWT.
//
// The login token lasts 30 days (exp = iat + 30d) and taotoken has no refresh
// token or sliding renewal. The plugin therefore:
//   • parses the JWT and warns on the usage card when it is within 7 days;
//   • writes its expiry into the account's `expires`, so magpie renews it
//     through auth.refresh() 7 days early, pulling a fresh token from a local
//     signed-in browser (scripts/capture-token.mjs, any Chromium-family
//     browser with a debugging port); if no browser answers it returns
//     undefined and the old token keeps being used;
//   • notifies through magpie (toast + log) about pending expiry, renewals
//     and renewal failures, at most once per account per day.

import { createHash } from "node:crypto"

const PROVIDER = "taotoken"
const NAME = "TaoToken"
const CODING_BASE = "https://api.taotoken.net/coding/v1" // OpenAI-compatible
const WEB_API = "https://taotoken.net/api" // console API (usage)
const SDK = "@ai-sdk/openai-compatible"
const WARN_DAYS = 7 // warn and renew within this many days before expiry
const DAY_MS = 86_400_000
const REFRESH_LEAD_MS = WARN_DAYS * DAY_MS
const ICON = "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTUyIiBoZWlnaHQ9IjE0NSIgdmlld0JveD0iMCAwIDE1MiAxNDUiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxwYXRoIGQ9Ik04MyA3M0M4MyA3Ni44NjYgNzkuODY2IDgwIDc2IDgwQzcyLjEzNCA4MCA2OSA3Ni44NjYgNjkgNzNDNjkgNjkuMTM0IDcyLjEzNCA2NiA3NiA2NkM3OS44NjYgNjYgODMgNjkuMTM0IDgzIDczWiIgZmlsbD0iIzRGNDZFNSIvPgo8cGF0aCBkPSJNMCA4My42ODEzVjExN0wyMCA5N0g1OC41QzYwLjcwOTEgOTcgNjIuNSA5OC43OTA5IDYyLjUgMTAxVjEyOUwzOC4zMTM1IDE0NUg3NkgxMTMuNjg3TDg5LjUgMTI5VjEwMUM4OS41IDk4Ljc5MDkgOTEuMjkwOSA5NyA5My41IDk3SDEzMkwxNTIgMTE3VjgzLjY4MTNDMTUyIDc4LjgyNzcgMTQ3LjcxMyA3NS4wOTIzIDE0Mi45MDUgNzUuNzU2NUw3NiA4NUw5LjA5NDg2IDc1Ljc1NjVDNC4yODY5NyA3NS4wOTIzIDAgNzguODI3NyAwIDgzLjY4MTNaIiBmaWxsPSIjNEY0NkU1Ii8+CjxwYXRoIGQ9Ik03NiAwSDM4LjMxMzVMNjIuNSAxNlY0NEM2Mi41IDQ2LjIwOTEgNjAuNzA5MSA0OCA1OC41IDQ4SDIwTDAgMjhWNjEuMzE4N0MwIDY2LjE3MjMgNC4yODY5NyA2OS45MDc3IDkuMDk0ODYgNjkuMjQzNUw3NiA2MEwxNDIuOTA1IDY5LjI0MzVDMTQ3LjcxMyA2OS45MDc3IDE1MiA2Ni4xNzIzIDE1MiA2MS4zMTg3VjI4TDEzMiA0OEg5My41QzkxLjI5MDkgNDggODkuNSA0Ni4yMDkxIDg5LjUgNDRWMTZMMTEzLjY4NyAwSDc2WiIgZmlsbD0iIzRGNDZFNSIvPgo8L3N2Zz4K"

// Models the Coding gateway is known to serve; login replaces the list.
const MODELS = [
  { id: "glm-5.3-flash", name: "GLM-5.3-Flash", context: 1_000_000 },
  { id: "deepseek-flash", name: "deepseek-flash", context: 1_000_000 },
]

// window names and lengths per the plan's quota buckets
const WINDOWS = {
  "5_hour": { name: "5 小时", span: 5 * 3600 },
  "1_week": { name: "本周", span: 7 * 86400 },
  "1_month": { name: "本月", span: 30 * 86400 },
}

// taotoken dares local wall-clock strings ("2026-11-15 23:24:32", Asia/Shanghai).
// Parse them explicitly as +08:00 so the card is right on any machine.
const toISO = (s) => {
  if (!s) return undefined
  const str = String(s)
  const fixed =
    /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(str) ? str.replace(" ", "T") + "+08:00" : str
  const d = new Date(fixed)
  return Number.isNaN(d.valueOf()) ? undefined : d.toISOString()
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v)

const b64url = (s) => {
  const b64 = String(s).replace(/-/g, "+").replace(/_/g, "/")
  const pad = b64.length % 4
  return Buffer.from(pad === 2 ? b64 + "==" : pad === 3 ? b64 + "=" : b64, "base64").toString("utf8")
}

// decodeJwtPayload decodes the (unverified) claims of a JWT, or null.
const decodeJwtPayload = (jwt) => {
  if (typeof jwt !== "string") return null
  const parts = jwt.split(".")
  if (parts.length !== 3 || !parts[1]) return null
  try {
    const payload = JSON.parse(b64url(parts[1]))
    return payload && typeof payload === "object" ? payload : null
  } catch {
    return null
  }
}

// tokenState returns { expiresAt, daysLeft } for a JWT, or null.
const tokenState = (jwt) => {
  const payload = decodeJwtPayload(jwt)
  const exp = payload?.exp
  if (!isNum(exp)) return null
  const at = exp * 1000
  return { expiresAt: at, daysLeft: Math.ceil((at - Date.now()) / DAY_MS) }
}

// —— notifications through magpie ——
const notifiedToday = new Set()

const notify = (client, message) => {
  try {
    client?.tui?.showToast?.(message)
  } catch {
    /* silence */
  }
  try {
    client?.app?.log?.(message)
  } catch {
    /* silence */
  }
}

const dayKey = () => new Date().toISOString().slice(0, 10)

// warnOnce notifies at most once per account per day about an expiring token.
const warnOnce = (client, jwt, st) => {
  const key = `${dayKey()}:${createHash("sha256").update(String(jwt)).digest("hex").slice(0, 16)}`
  if (notifiedToday.has(key)) return
  notifiedToday.add(key)
  const when = new Date(st.expiresAt).toISOString().slice(0, 10)
  const text =
    st.daysLeft <= 0
      ? `taotoken CodingPlan 用量令牌已过期（${when}）。请在浏览器重新登录 taotoken 后运行续期脚本，或在本插件重新登录填写新令牌。`
      : `taotoken CodingPlan 用量令牌将于 ${st.daysLeft} 天后过期（${when}），到期前会自动续期，请保持本机浏览器登录 taotoken 并开启调试端口。`
  notify(client, text)
}

// captureBrowserToken asks scripts/capture-token.mjs for the freshest login
// token from any local signed-in browser (debugging port). Returns null when
// none answers or anything goes wrong — never throws to the caller.
const captureBrowserToken = async () => {
  const { $ } = await import("bun").catch(() => ({ $: null }))
  if (!$) return null
  try {
    const script = new URL("scripts/capture-token.mjs", import.meta.url).href
    const out = await $`bun run ${script} --json`.quiet()
    const parsed = JSON.parse(out.stdout)
    return typeof parsed?.token === "string" && parsed.token ? parsed.token : null
  } catch (e) {
    console.warn(`[taotoken] capture-token failed: ${e?.message ?? e}`)
    return null
  }
}

// magpie's account row renders the first two windows only, so the short
// 5-hour window must come first: 5 hour → week → month (unknown kinds last).
const WINDOW_ORDER = { "5_hour": 0, "1_week": 1, "1_month": 2 }

// buckets → magpie windows
const windowsOf = (buckets) =>
  (buckets ?? [])
    .filter((b) => b && isNum(b.used) && isNum(b.quotaLimit) && b.quotaLimit > 0)
    .sort((a, b) => (WINDOW_ORDER[a.quotaCode] ?? 9) - (WINDOW_ORDER[b.quotaCode] ?? 9))
    .map((b) => {
      const meta = WINDOWS[b.quotaCode] ?? {}
      const percent = isNum(b.usagePercent) ? b.usagePercent : (b.used / b.quotaLimit) * 100
      return {
        name: meta.name ?? b.quotaCode ?? "usage",
        used: percent,
        amount: b.used,
        limit: b.quotaLimit,
        unit: "次",
        display: `${b.used} / ${b.quotaLimit} 次`,
        resetsAt: toISO(b.endTime),
        span: meta.span,
      }
    })

const errorOf = (status) =>
  status === 401
    ? "用量令牌已过期或无效，请重新登录 taotoken 并复制新的 Cookie token 值。"
    : status === 429 || status >= 500
      ? `taotoken 用量服务暂时不可用（HTTP ${status}），请稍后再试。`
      : `taotoken 用量接口 HTTP ${status}。`

// the read itself; usage() is a thin wrapper with error mapping and renewal sync
async function readUsage(getAuth) {
  const auth = await getAuth()
  const jwt = auth?.metadata?.loginToken
  if (!jwt) {
    return {
      error:
        "未填 CodingPlan 用量令牌。登录 taotoken.net 后，在开发者工具 → 应用 → Cookie → taotoken.net 复制 token 的值，重登时粘到“用量令牌”。",
      windows: [],
    }
  }

  let res
  try {
    res = await fetch(`${WEB_API}/v1/plan/overview`, {
      headers: { Authorization: jwt, "x-auth-type": "taotoken", "Content-Type": "application/json" },
    })
  } catch (e) {
    return { error: `网络错误，无法读取 taotoken 用量：${e?.message ?? e}`, windows: [] }
  }
  if (!res.ok) {
    return { error: errorOf(res.status), windows: [] }
  }
  let body
  try {
    body = await res.json()
  } catch {
    return { error: "taotoken 用量接口返回了无法解析的内容", windows: [] }
  }
  const cp = body?.data?.codingPlan
  const subs = cp?.subscriptions?.[0]
  const buckets = cp?.buckets
  if (!Array.isArray(buckets) || !buckets.some((b) => isNum(b.used))) {
    return { error: "当前账号没有生效的 CodingPlan 用量", windows: [] }
  }
  // warn about the login token's own expiry on the plan line (not an error)
  const plan = subs?.showPlanTier ?? cp?.planLabel ?? "CodingPlan"
  const st = tokenState(jwt)
  const planLine = st && st.daysLeft <= WARN_DAYS
    ? `${plan} · 登录令牌${st.daysLeft <= 0 ? "已过期" : ` ${st.daysLeft} 天后到期（${new Date(st.expiresAt).toISOString().slice(0, 10)}）`}`
    : plan
  return {
    plan: planLine,
    until: toISO(subs?.periodEnd),
    windows: windowsOf(buckets),
  }
}

// —— the plugin ——

export const TaoTokenAuthPlugin = async ({ client }) => ({
  // the provider and its models before anyone signs in
  config: async (cfg) => {
    cfg.provider ??= {}
    cfg.provider[PROVIDER] ??= {
      name: NAME,
      npm: SDK,
      api: CODING_BASE,
      models: Object.fromEntries(
        MODELS.map((m) => [
          m.id,
          { name: m.name, id: m.id, limit: { context: m.context }, tool_call: true },
        ]),
      ),
    }
  },

  auth: {
    provider: PROVIDER,
    icon: ICON,
    // renew 7 days before the login token expires
    refreshLead: REFRESH_LEAD_MS,
    methods: [
      {
        type: "api",
        label: "TaoToken CodingPlan API key",
        placeholder: "sk-…",
        prompts: [
          {
            type: "password",
            key: "loginToken",
            message:
              "CodingPlan 用量令牌（选填）— taotoken.net 登录后复制 Cookie 里 token 的值；令牌约 30 天有效，到期前需保持本机浏览器登录态以自动续期；不填则用量卡片不可用",
          },
        ],
      },
    ],

    // model requests: Bearer API key to the coding gateway
    async loader(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api" || !auth.key) return {}
      return { baseURL: CODING_BASE, apiKey: auth.key, headers: {} }
    },

    // the usage card: CodingPlan 5h / week / month, taotoken's fresh answer each ask
    async usage(getAuth) {
      try {
        const out = await readUsage(getAuth)
        try {
          const auth = await getAuth()
          const jwt = auth?.metadata?.loginToken
          const st = jwt && tokenState(jwt)
          if (st) {
            // let magpie renew us 7 days early: keep the account's expiry in sync
            await client.auth.set({ path: { id: PROVIDER }, body: { ...auth, expires: st.expiresAt } })
            if (st.daysLeft <= WARN_DAYS) warnOnce(client, jwt, st)
          }
        } catch {
          /* sync/notify never breaks the usage card */
        }
        return out
      } catch (e) {
        return { error: e?.message ?? String(e), windows: [] }
      }
    },

    // renewal: pull a fresh login token from a local signed-in browser
    async refresh(auth) {
      const jwt = await captureBrowserToken()
      if (!jwt) {
        notify(
          client,
          "taotoken CodingPlan 用量令牌自动续期未完成：本机浏览器未开启调试端口或未登录 taotoken。可运行 scripts/start-browser-debug.ps1（或手动续期脚本）后重试，用量会继续使用原令牌直到过期。",
        )
        return undefined // keep the old token; do not mark the account
      }
      const st = tokenState(jwt)
      const when = st ? new Date(st.expiresAt).toISOString().slice(0, 10) : "未知日期"
      notify(client, `taotoken CodingPlan 用量令牌已自动续期，新令牌有效期至 ${when}。`)
      return {
        ...(auth?.metadata ?? {}),
        loginToken: jwt,
        expires: st?.expiresAt,
      }
    },
  },

  // the account's own model list, when signed in
  provider: {
    id: PROVIDER,
    async models(provider, { auth } = {}) {
      if (auth?.type !== "api" || !auth.key) return provider.models
      let data
      try {
        const res = await fetch(`${CODING_BASE}/models`, {
          headers: { authorization: `Bearer ${auth.key}` },
        })
        if (!res.ok) return provider.models
        const json = await res.json()
        if (!Array.isArray(json?.data) || !json.data.length) return provider.models
        data = json.data
      } catch {
        return provider.models
      }
      const base = provider.models ?? {}
      return Object.fromEntries(
        data.map((m) => {
          const b = base[m.id] ?? {}
          const context = isNum(m.context_length) ? m.context_length : b.limit?.context
          return [
            m.id,
            {
              ...b,
              id: m.id,
              name: m.name ?? m.id,
              limit: { ...(b.limit ?? {}), context },
              tool_call: true,
            },
          ]
        }),
      )
    },
  },
})

