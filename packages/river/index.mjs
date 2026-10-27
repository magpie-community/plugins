// River (river.ai) for OpenCode and magpie.
//
// River serves an OpenAI-compatible inference API at https://api.river.ai/v1:
// an API key signs every request (Authorization: Bearer), chat completions and
// the Responses API serve the same models, and GET /v1/models lists the models
// a key can use (docs.river.ai/guides/inference). River meters a prepaid
// balance per request and publishes no balance endpoint, so the usage hook
// here reports only the sign-in state; spend lives in the River Console.

const ID = "river"
const BASE = "https://api.river.ai/v1"
const PRICING = "https://console.river.ai/api/public/pricing"
const PRICING_TTL = 6 * 60 * 60 * 1000

// Documented per-model limits, from docs.river.ai/guides/inference-models.
// Models River serves beyond this table keep unknown limits (0) until the
// docs list them; costs still come from River's public pricing endpoint.
// GLM-5.3 (text only) has no id here yet: docs list it, no key we saw does.
const LIMITS = {
  "moonshotai/Kimi-K3": { context: 1048576, output: 32768 },
  "deepseek-ai/DeepSeek-V4.1-Flash": { context: 1048576, output: 384000 },
  "deepseek-ai/DeepSeek-V4.1-Flash-1017": { context: 1048576, output: 384000 },
  "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4": { context: 1048576, output: 131072 },
  "zai-org/GLM-5.3-Flash": { context: 1048576, output: 131072 },
  "Qwen/Qwen3.8-27B-FP8": { context: 262144, output: 262143 },
}

// Models River documents as taking image input (docs.river.ai/guides/
// inference-models). Everything else is text-only — GLM-5.3 (text only) is
// documented as such — and an id the docs don't list yet defaults to
// text-only too, so a new model is never sent what it can't read.
const IMAGES = new Set([
  "moonshotai/Kimi-K3",
  "deepseek-ai/DeepSeek-V4.1-Flash",
  "deepseek-ai/DeepSeek-V4.1-Flash-1017",
  "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4",
  "zai-org/GLM-5.3-Flash",
  "Qwen/Qwen3.8-27B-FP8",
])

// Reasoning effort levels per model, from docs.river.ai/guides/inference-controls.
// The keys are the levels agents pick; each variant's object is the options
// OpenCode merges into the request ({ reasoningEffort: e }), which magpie's
// gateway sends as `reasoning_effort`. Only levels the standard field takes
// are listed: Kimi-K3's low/high/max tiers and Nemotron's medium_effort go
// through chat_template_kwargs instead. GLM requires reasoning (no "none");
// Qwen3.8's top level is "xhigh". The 1017 release is the same model
// re-served, so it takes the same efforts.
const efforts = (...names) => Object.fromEntries(names.map((e) => [e, { reasoningEffort: e }]))
const VARIANTS = {
  "moonshotai/Kimi-K3": efforts("none", "max"),
  "deepseek-ai/DeepSeek-V4.1-Flash": efforts("none", "low", "high", "max"),
  "deepseek-ai/DeepSeek-V4.1-Flash-1017": efforts("none", "low", "high", "max"),
  "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4": efforts("none", "high"),
  "zai-org/GLM-5.3-Flash": efforts("low", "high", "max"),
  "Qwen/Qwen3.8-27B-FP8": efforts("none", "low", "medium", "xhigh"),
}

// Costs at the time of writing, per million tokens in USD, from River's
// public pricing endpoint (the same rates billing uses). The models hook
// replaces them with whatever the endpoint lists then.
const BOOT_PRICES = {
  "Qwen/Qwen3.8-27B-FP8": { input: 0.1, cached_input: 0.02, output: 2.0 },
  "deepseek-ai/DeepSeek-V4.1-Flash": { input: 0.12, cached_input: 0.0024, output: 0.48 },
  "deepseek-ai/DeepSeek-V4.1-Flash-1017": { input: 0.12, cached_input: 0.0024, output: 0.48 },
  "moonshotai/Kimi-K3": { input: 3.0, cached_input: 0.3, output: 15.0 },
  "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4": { input: 0.07, cached_input: 0.024, output: 0.37 },
  "zai-org/GLM-5.3-Flash": { input: 0.12, cached_input: 0.024, output: 0.4 },
}

// Every model in River's inference list streams, reasons and calls tools;
// image input is the IMAGES set's, everything else is text-only (docs.river.ai/
// guides/inference-models). The row carries the fields both readers use: the
// config hook reads the top-level ones, the models hook reads the
// `capabilities` object.
function row(id, name, cost, limit, variants) {
  const image = IMAGES.has(id)
  return {
    id,
    name,
    limit: limit ?? { context: 0, output: 0 },
    reasoning: true,
    tool_call: true,
    modalities: { input: image ? ["text", "image"] : ["text"], output: ["text"] },
    capabilities: {
      reasoning: true,
      toolcall: true,
      attachment: image,
      input: { text: true, image },
      output: { text: true },
    },
    ...(variants ? { variants } : {}),
    ...(cost ? { cost } : {}),
  }
}

// pretty turns an API id into a display name: the part after the org slash,
// with separators spaced ("deepseek-ai/DeepSeek-V4.1-Flash" → "DeepSeek V4.1 Flash").
function pretty(id) {
  return id.split("/").pop().replace(/[-_]+/g, " ").trim()
}

// costOf reads one entry of River's pricing list. Entries carry the rates
// per million tokens as numbers; anything else leaves the cost off.
function costOf(price) {
  if (!price || typeof price !== "object") return undefined
  const [input, output, cache_read] = [price.input, price.output, price.cached_input].map((v) => (typeof v === "number" ? v : undefined))
  if (input === undefined && output === undefined) return undefined
  return { ...(input !== undefined && { input }), ...(output !== undefined && { output }), ...(cache_read !== undefined && { cache_read }) }
}

// accountModels lists the model ids a key can use. River answers
// {"object":"list","data":[{"id":…}]} like every OpenAI-compatible server.
async function accountModels(fetchImpl, key) {
  return await fetchImpl(`${BASE}/models`, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  })
}

// livePricing reads River's public pricing list, which needs no key. The
// answer is cached for PRICING_TTL; a failure just keeps the previous one.
let pricingCache = { at: 0, byId: null }
async function livePricing(fetchImpl) {
  if (pricingCache.byId && Date.now() - pricingCache.at < PRICING_TTL) return pricingCache.byId
  try {
    const res = await fetchImpl(PRICING, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = await res.json()
    const byId = {}
    for (const entry of body?.inference ?? []) {
      if (typeof entry?.model === "string" && entry.model) byId[entry.model] = entry
    }
    if (Object.keys(byId).length) pricingCache = { at: Date.now(), byId }
  } catch {
    // keep whatever the cache holds, else the caller falls back to BOOT_PRICES
  }
  return pricingCache.byId
}

// merged rows for the model ids an account may use: limits from the docs
// table, costs from River's live pricing (BOOT_PRICES as the fallback)
function rowsFor(ids, prices) {
  return Object.fromEntries(
    ids.map((id) => {
      const price = prices?.[id]
      const cost = costOf(price) ?? costOf(BOOT_PRICES[id])
      return [id, row(id, pretty(id), cost, LIMITS[id], VARIANTS[id])]
    }),
  )
}

function createPlugin({ fetchImpl = globalThis.fetch } = {}) {
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      // `??=` keeps a provider the user configured in plugins.json.
      cfg.provider[ID] ??= {
        name: "River",
        npm: "@ai-sdk/openai-compatible", // chat completions
        api: BASE,
        models: rowsFor(Object.keys(BOOT_PRICES), BOOT_PRICES),
      }
    },

    auth: {
      provider: ID,
      methods: [{ type: "api", label: "River API key", placeholder: "rv_…" }],
      // magpie sends `Authorization: Bearer <apiKey>` for
      // @ai-sdk/openai-compatible; no custom fetch is needed, and the host
      // applies the account's proxy to every request.
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        return { baseURL: BASE, apiKey: auth.key }
      },
      // River meters a prepaid balance per request and publishes no endpoint
      // that reads it, so this only checks the sign-in and says where spend
      // is visible. A key River refuses marks the account (signIn: "expired").
      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        let res
        try {
          res = await accountModels(fetchImpl, auth.key)
        } catch (error) {
          return { error: `River unreachable: ${error?.cause?.code || error?.message || "network error"}`, windows: [] }
        }
        if (res.status === 401 || res.status === 403) {
          return { error: `River refused this key (HTTP ${res.status}); sign in again`, signIn: "expired", windows: [] }
        }
        if (!res.ok) return { error: `River answered HTTP ${res.status}`, windows: [] }
        return { plan: "Pay as you go", windows: [] }
      },
    },

    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        if (auth?.type !== "api" || !auth.key) return provider.models
        let res, prices
        try {
          ;[res, prices] = await Promise.all([accountModels(fetchImpl, auth.key), livePricing(fetchImpl)])
        } catch {
          // A network failure keeps the previous list, like a non-2xx answer.
          return provider.models
        }
        if (res.status === 401 || res.status === 403) {
          throw Object.assign(new Error(`River refused this key (HTTP ${res.status}); sign in again`), { signIn: "expired" })
        }
        if (!res.ok) return provider.models
        let body
        try {
          body = await res.json()
        } catch {
          throw new Error("River sent no model list")
        }
        // A malformed answer keeps the previous list (the host marks it a
        // fallback); an empty one is the account's list, as its key has no
        // models, and replaces the bootstrap rows the way a live catalog does.
        if (!Array.isArray(body?.data) || body.data.some((m) => typeof m?.id !== "string" || !m.id)) {
          throw new Error("River sent no model list")
        }
        return rowsFor(body.data.map((m) => m.id), prices)
      },
    },
  }
}

// The plugin is the only exported function; magpie calls every exported
// function as a plugin, so tests reach the internals through this object.
export const RiverPlugin = async () => createPlugin()
export const _internal = { createPlugin, row, pretty, costOf, rowsFor, LIMITS, VARIANTS, BOOT_PRICES, BASE }
