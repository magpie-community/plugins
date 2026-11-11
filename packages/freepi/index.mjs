// magpie-freepi — free-pi (api.freepi.ai) provider plugin for magpie.
// Direct upstream relay: GitHub device-flow login, ad-impression gate, live catalog.
// The only exports are the plugin and _internal (for tests); magpie calls every
// exported function as a plugin, so helpers must stay in lib/.

import {
  BASE,
  authHeaders,
  postJson,
  getJson,
  reportImpression,
  startDeviceFlow,
  pollForToken,
  calibrateClientVersion,
} from "./lib/upstream.mjs"
import { FALLBACK_MODEL_IDS, MODEL_LIMITS, parseCatalog } from "./lib/catalog.mjs"

const PROVIDER = "freepi"

// Catalog entries carry no limits; models.dev (via stats_id) fills most, the rest
// stay conservative until measured — the upstream may still cap per request.
const DEFAULT_LIMIT = { context: 128000, output: 16384 }
const limitFor = (id) => MODEL_LIMITS[id] ?? DEFAULT_LIMIT

function modelMeta(id, name, { rate, free } = {}) {
  const meta = { name: name || id, limit: limitFor(id), tool_call: true }
  if (rate != null) meta.rate = Number(rate)
  if (free) meta.free = true
  return meta
}

function staticModels() {
  return Object.fromEntries(FALLBACK_MODEL_IDS.map((id) => [id, modelMeta(id, id)]))
}

// GET /me carries the daily meter (Phase-0 credits first, USD fallback); both reset
// at UTC midnight (refill_at). Returns a magpie usage window, or null when absent.
function dailyWindow(me) {
  let amount, limit, unit
  if (typeof me?.allowance_credits === "number" && typeof me?.remaining_credits_today === "number") {
    limit = me.allowance_credits
    amount = limit - me.remaining_credits_today
    unit = "credits"
  } else if (
    typeof me?.cap_usd_today === "number" &&
    typeof me?.remaining_usd_today === "number" &&
    me.cap_usd_today > 0
  ) {
    limit = me.cap_usd_today
    amount = limit - me.remaining_usd_today
    unit = "USD"
  } else {
    return null
  }
  if (!(limit > 0)) return null
  const r = (v) => Math.round(v * 100) / 100
  return {
    name: "每日额度",
    used: Math.max(0, Math.round((amount / limit) * 100)),
    resetsAt: me.refill_at,
    display: `${r(amount)} / ${r(limit)} ${unit}`,
    amount: r(amount),
    limit: r(limit),
    unit,
  }
}

export const FreePiPlugin = async (input) => {
  const opts = () => input?.magpie?.options ?? input?.magpie?.option ?? {}
  let adCount = 0 // banner impressions reported by this host process

  // The upstream forces clients whose x-client-version is below /client-version.min
  // to update. Re-check on startup and every 12h so the pinned version never goes
  // stale; authHeaders read the module-level pin on every request, so a bump takes
  // effect immediately. Anonymous call, failures swallowed, timer never holds the host.
  const watchVersion = async () => {
    try {
      const r = await getJson(`${BASE}/client-version`)
      if (r.status === 200 && r.body) calibrateClientVersion(r.body)
    } catch {}
  }
  watchVersion()
  const versionTimer = setInterval(watchVersion, 12 * 3600 * 1000)
  versionTimer.unref?.()

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: "FreePi",
        npm: "@ai-sdk/openai-compatible", // chat completions, passed through verbatim
        api: `${BASE}/v1`,
        models: staticModels(),
      }
    },

    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: "oauth",
          label: "GitHub 设备码登录",
          async authorize(_inputs, { signal } = {}) {
            let flow
            try {
              flow = await startDeviceFlow({ signal })
            } catch (e) {
              return { type: "failed", error: `无法连接 free-pi：${e.message}` }
            }
            if (flow.consentError)
              return { type: "failed", error: `free-pi 未记录 consent（${flow.consentError}），请重试登录` }
            // GitHub accepts ?user_code= on its device page, so the code is filled in
            // when the browser opens — no copy/paste needed; the instructions keep it
            // as a fallback for when the prefill does not survive the redirect.
            const join = flow.device.verification_uri.includes("?") ? "&" : "?"
            return {
              url: `${flow.device.verification_uri}${join}user_code=${encodeURIComponent(flow.device.user_code)}`,
              instructions: `浏览器已打开 GitHub 授权页（代码已预填 ${flow.device.user_code}）；若页面为空请手动输入该代码`,
              method: "auto",
              async callback(_code, { signal } = {}) {
                const r = await pollForToken(flow.device.session_id, {
                  signal,
                  initialIntervalMs: (flow.device.interval || 5) * 1000,
                })
                if (r.type !== "success") return r
                let accountId
                try {
                  const me = await getJson(`${BASE}/me`, authHeaders(r.token))
                  if (me.status === 200) accountId = me.body?.handle ?? me.body?.user_id
                } catch {}
                // magpie persists an oauth result only when it carries refresh
                // (same shape the community copilot plugin uses); the free-pi JWT
                // is a long-lived credential with no separate refresh token, so
                // it fills both slots and expires: 0 disables renewal attempts.
                return { type: "success", refresh: r.token, access: r.token, expires: 0, accountId }
              },
            }
          },
        },
      ],

      async loader(getAuth) {
        const auth = await getAuth()
        const token = auth?.type === "oauth" ? auth.access : null
        // options.direct: bypass magpie's proxy chain (default is to ride it).
        const doFetch = opts().direct ? (url, init) => fetch(url, { ...init, proxy: false }) : fetch
        return {
          baseURL: `${BASE}/v1`,
          async fetch(req, init) {
            const headers = new Headers(init?.headers)
            for (const [k, v] of Object.entries(authHeaders(token))) headers.set(k, v)
            // Ad gate: upstream 403s logged-in completions (ads_required) unless banner
            // impressions are reported. Fire-and-forget so an ads hiccup never delays
            // or breaks a request; anonymous (trial) requests skip it entirely.
            if (token) {
              reportImpression(token, { fetchImpl: doFetch })
                .then((n) => {
                  adCount += n
                })
                .catch(() => {})
            }
            return doFetch(req, { ...init, headers })
          },
        }
      },

      async usage(getAuth) {
        const auth = await getAuth()
        const windows = []
        if (opts().adCount !== false && adCount > 0)
          windows.push({ name: "广告展示", display: `本次运行已上报 ${adCount} 条`, aside: true })
        try {
          const me = await getJson(`${BASE}/me`, authHeaders(auth?.access))
          if (me.status === 200) {
            const b = me.body ?? {}
            const w = dailyWindow(b)
            if (w) windows.push(w)
            if (b.lane && b.lane !== "standard")
              windows.push({ name: "车道", display: b.lane === "wait" ? "排队等待中" : "慢车道", aside: true })
            return { plan: "Free", user: b.handle ?? b.user_id, windows }
          }
          if (me.status === 401) return { plan: "Free", error: "登录已失效，请重新登录", windows }
        } catch {}
        return { plan: "Free", windows }
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        const token = auth?.type === "oauth" ? auth.access : null
        let r
        try {
          r = await getJson(`${BASE}/client-version`, authHeaders(token))
        } catch {
          return provider.models
        }
        if (r.status !== 200 || !r.body) return provider.models
        calibrateClientVersion(r.body) // stay ahead of the forced-update gate
        const list = parseCatalog(r.body)
        if (!list.length) return provider.models
        const base = provider.models?.[FALLBACK_MODEL_IDS[0]] ?? Object.values(provider.models ?? {})[0]
        const out = {}
        for (const m of list) {
          out[m.id] = base
            ? {
                ...base,
                id: m.id,
                name: m.name,
                limit: limitFor(m.id),
                // magpie-built models carry api.id from the entry we spread; re-point it
                ...(base.api ? { api: { ...base.api, id: m.id } } : {}),
                ...(m.rate != null ? { rate: Number(m.rate) } : {}),
                ...(m.free ? { free: true } : {}),
              }
            : modelMeta(m.id, m.name, m)
        }
        return out
      },
    },
  }
}

export const _internal = { staticModels, modelMeta, dailyWindow }
