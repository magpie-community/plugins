// TokenCake (tokencake) for OpenCode and magpie.
//
// TokenCake serves an OpenAI-compatible API at https://api.test.tokenca.ke/v1:
// an API key (sk-…) signs every request with Authorization: Bearer, GET
// /v1/models lists the models an account gets, and GET /v1/codeplan/usage
// reads its plan windows. This plugin declares the provider, the account's
// live catalog, the quota card and the request signing. The only capability
// it adds is the reasoning levels its vendor metadata states: the GLM-5.3 ids
// (models.dev's zai/zhipuai entries) and the DeepSeek v4 family
// (models.dev's deepseek-v4-flash/v4-pro entries). No limits, prices, image or
// tool capabilities are assumed.
//
// The /v1/models and /v1/codeplan/usage answers were not read live here; the
// shapes below are the OpenAI-compatible catalog TokenCake's own clients use
// and the plan body its public quick-connect page reads.

const ID = "tokencake"
const BASE = "https://api.test.tokenca.ke"
const API = `${BASE}/v1`

// The key shape TokenCake's quick-connect page checks. A hint, never echoed.
const KEY = /^sk-[\w-]{16,256}$/

const FALLBACK = ["z-ai/glm-5.3", "z-ai/glm-5.3-flash", "deepseek/deepseek-v4.1-flash-1017"]

// models.dev states reasoning on with efforts low/high/max and no "none" for
// both GLM-5.3 ids (zai/zhipuai) and the DeepSeek v4 family
// (deepseek-v4-flash, deepseek-v4-pro). The DeepSeek family's levels are
// applied here to deepseek/deepseek-v4.1-flash-1017 as asked; models.dev has
// no entry for that exact id, so this is the family's shape, not its own
// record. Each variant's object is the options OpenCode merges into the
// request ({ reasoningEffort: e }), which magpie's gateway sends as
// `reasoning_effort` (packages/river). Any other id says nothing of it.
const REASONED = new Set(["z-ai/glm-5.3", "z-ai/glm-5.3-flash", "deepseek/deepseek-v4.1-flash-1017"])
const EFFORTS = ["low", "high", "max"]
const variantsOf = () => Object.fromEntries(EFFORTS.map((e) => [e, { reasoningEffort: e }]))

// The config hook reads a model's reasoning at the top level; magpie's
// provider.models hook reads it under `capabilities`. The levels are the same
// either way.
const fallbackModels = () =>
  Object.fromEntries(
    FALLBACK.map((id) => [id, REASONED.has(id) ? { name: id, reasoning: true, variants: variantsOf() } : { name: id }]),
  )

// The quota windows TokenCake states, and the length each covers. "monthly"
// has no length the endpoint states, so none is assumed.
const SPANS = { "5h": 5 * 3600, "7d": 7 * 86400, "14d": 14 * 86400 }
const MONTHLY = "monthly"

const INVALID_KEY = "TokenCake keys start with sk- and are at least 19 characters long."

const keyOf = (auth) => (auth?.type === "api" && typeof auth.key === "string" && auth.key.trim() ? auth.key.trim() : undefined)

// apiGet is one authenticated read. No redirect: one would take the
// account's key to another origin.
async function apiGet(path, key) {
  return await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  })
}

// modelsOf maps an OpenAI-compatible catalog ({"data": [{"id": …}]}).
// Every id is kept exactly as sent — catalog ids carry "/" — and a name
// only when it is a non-empty string. A known reasoning id keeps the levels
// above, under the hook's own `capabilities`; any other id stays name-only.
// Entries without a usable id are left out; no usable entry means null, and
// the caller keeps its own list.
function modelsOf(body) {
  if (!Array.isArray(body?.data)) return null
  const rows = {}
  for (const m of body.data) {
    if (!m || typeof m !== "object" || typeof m.id !== "string" || !m.id) continue
    const name = typeof m.name === "string" && m.name.trim() ? m.name : m.id
    rows[m.id] = REASONED.has(m.id) ? { name, capabilities: { reasoning: true }, variants: variantsOf() } : { name }
  }
  return Object.keys(rows).length ? rows : null
}

// resetAt keeps the endpoint's ISO reset time, and nothing when it is null
// or not a date.
function resetAt(value) {
  if (typeof value !== "string" || !value) return undefined
  const at = Date.parse(value)
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined
}

// usageOf maps the plan body {plan: {name}, unit: "credits", windows:
// [{window, used, limit, remaining, reset_at}]}. The percentage comes from
// remaining, the number its own dashboard shows. A window whose quotas
// aren't whole and sane is left out, as is a window name this build doesn't
// know: no window is invented. Nothing readable means null.
function usageOf(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null
  if (body.unit !== "credits" || !Array.isArray(body.windows)) return null
  const windows = []
  const seen = new Set()
  for (const w of body.windows) {
    const name = typeof w?.window === "string" ? w.window : ""
    if (name !== MONTHLY && !Object.hasOwn(SPANS, name)) continue
    if (seen.has(name)) continue
    const { limit, remaining } = w
    if (!Number.isSafeInteger(limit) || limit <= 0) continue
    if (!Number.isSafeInteger(remaining) || remaining < 0 || remaining > limit) continue
    seen.add(name)
    const amount = limit - remaining
    const resetsAt = resetAt(w.reset_at)
    windows.push({
      name,
      used: (100 * amount) / limit,
      amount,
      limit,
      unit: "credits",
      display: `${amount} / ${limit} credits`,
      ...(Object.hasOwn(SPANS, name) ? { span: SPANS[name] } : {}),
      ...(resetsAt ? { resetsAt } : {}),
    })
  }
  if (!windows.length) return null
  const plan = typeof body.plan?.name === "string" && body.plan.name.trim() ? body.plan.name : undefined
  return { ...(plan ? { plan } : {}), windows, signIn: "kept" }
}

// The plugin is the only export: OpenCode 1.x and magpie call every exported
// function as a plugin, and tests drive it through these hooks.
export const TokenCakeAuthPlugin = async () => ({
  config: async (cfg) => {
    cfg.provider ??= {}
    // ??= keeps a tokencake provider the user configured in plugins.json.
    cfg.provider[ID] ??= {
      name: "TokenCake",
      npm: "@ai-sdk/openai-compatible", // chat completions: POST /v1/chat/completions
      api: API,
      models: fallbackModels(),
    }
  },

  provider: {
    id: ID,
    // GET /v1/models with the account's key. Anything unreadable keeps the
    // host's list; a readable catalog replaces it whole, never mixing the
    // two.
    async models(provider, { auth } = {}) {
      const key = keyOf(auth)
      if (!key) return provider.models
      let res
      try {
        res = await apiGet("/models", key)
      } catch {
        return provider.models
      }
      if (!res.ok) return provider.models
      let body
      try {
        body = await res.json()
      } catch {
        return provider.models
      }
      return modelsOf(body) ?? provider.models
    },
  },

  auth: {
    provider: ID,
    methods: [
      {
        type: "api",
        label: "TokenCake API key",
        placeholder: "sk-…",
        prompts: [
          {
            type: "password",
            key: "apiKey",
            message: "TokenCake API key (sk-…)",
            placeholder: "sk-…",
            validate: (value) => (KEY.test(String(value ?? "").trim()) ? undefined : INVALID_KEY),
          },
        ],
        async authorize(inputs) {
          const key = String(inputs?.apiKey ?? "").trim()
          if (!KEY.test(key)) return { type: "failed", error: INVALID_KEY }
          return { type: "success", key }
        },
      },
    ],

    // Every request goes to TokenCake's gateway signed with the account's
    // key. The SDK's and the caller's headers are kept, the reply is passed
    // through untouched (a non-2xx answer and a stream included), and a
    // redirect is refused so the key can't leave the gateway's origin.
    async loader(getAuth) {
      const auth = await getAuth()
      const key = keyOf(auth)
      if (!key) return {}
      return {
        baseURL: API,
        apiKey: key,
        async fetch(input, init = {}) {
          const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
          headers.set("authorization", `Bearer ${key}`)
          return await fetch(input, { ...init, headers, redirect: "error" })
        },
      }
    },

    // The plan card. Failures name the state or the status, never a remote
    // body that could carry the account's own data.
    async usage(getAuth) {
      const auth = await getAuth()
      const key = keyOf(auth)
      if (!key) return { windows: [], error: "TokenCake plan usage needs an API key sign-in.", signIn: "kept" }
      let res
      try {
        res = await apiGet("/codeplan/usage", key)
      } catch (error) {
        return {
          windows: [],
          error:
            error?.name === "TimeoutError"
              ? "TokenCake usage couldn't be read: the request timed out."
              : "TokenCake usage couldn't be read: the request failed.",
          signIn: "kept",
        }
      }
      if (res.status === 401) return { windows: [], error: "TokenCake refused this API key (HTTP 401): sign in again.", signIn: "expired" }
      if (!res.ok) return { windows: [], error: `TokenCake usage answered HTTP ${res.status}.`, signIn: "kept" }
      let body
      try {
        body = await res.json()
      } catch {
        return { windows: [], error: "TokenCake usage answered with something that isn't JSON.", signIn: "kept" }
      }
      return usageOf(body) ?? { windows: [], error: "TokenCake usage didn't list a readable quota window.", signIn: "kept" }
    },
  },
})
