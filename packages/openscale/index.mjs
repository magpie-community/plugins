// OpenScale (openscale.so) for OpenCode and magpie.
//
// OpenScale serves an OpenAI-compatible inference API at https://api.openscale.so/v1:
// an API key signs every request (Authorization: Bearer), chat completions serve
// the models, and GET /v1/models lists the models a key can use. That answer is
// a rich catalog — context and output limits, input modalities, per-token
// prices, tool and reasoning support, reasoning_effort levels — so this plugin
// builds its model table straight from the live answer and only falls back to
// the BOOTSTRAP table below until the first successful call. OpenScale meters a
// prepaid balance per request and publishes no endpoint that reads it, so the
// usage hook only reports the sign-in state; spend lives in the OpenScale
// dashboard at app.openscale.so.

const ID = "openscale"
const BASE = "https://api.openscale.so/v1"
const MILLION = 1_000_000

// Models at the time of writing, read from GET /v1/models with a real key —
// the same answer the models hook reads live, frozen here so the provider
// keeps a usable list before the first catalog call and whenever OpenScale
// cannot be reached. A pay-as-you-go key may see more models than this; the
// live catalog always wins once it answers.
const BOOTSTRAP = {
  "deepseek/deepseek-v4.1-flash": {
    id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash",
    limit: { context: 1048568, output: 384000 },
    reasoning: true, tool_call: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    capabilities: { reasoning: true, toolcall: true, attachment: true, input: { text: true, image: true }, output: { text: true } },
    variants: { none: { reasoningEffort: "none" }, low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" } },
    cost: { input: 0.06, cache_read: 0.003, output: 0.24 },
  },
  "deepseek/deepseek-v4.1-flash-1017": {
    id: "deepseek/deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash 1017",
    limit: { context: 1048568, output: 384000 },
    reasoning: true, tool_call: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    capabilities: { reasoning: true, toolcall: true, attachment: true, input: { text: true, image: true }, output: { text: true } },
    variants: { none: { reasoningEffort: "none" }, low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" } },
    cost: { input: 0.06, cache_read: 0.003, output: 0.24 },
  },
  "deepseek/deepseek-v4.1-flash-0910": {
    id: "deepseek/deepseek-v4.1-flash-0910", name: "DeepSeek V4.1 Flash 0910",
    limit: { context: 1048568, output: 384000 },
    reasoning: true, tool_call: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    capabilities: { reasoning: true, toolcall: true, attachment: true, input: { text: true, image: true }, output: { text: true } },
    variants: { none: { reasoningEffort: "none" }, low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" } },
    cost: { input: 0.06, cache_read: 0.003, output: 0.24 },
  },
  "z-ai/glm-5.3-flash": {
    id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash",
    limit: { context: 1048576, output: 131072 },
    reasoning: true, tool_call: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    capabilities: { reasoning: true, toolcall: true, attachment: true, input: { text: true, image: true }, output: { text: true } },
    variants: { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" } },
    cost: { input: 0.12, cache_read: 0.024, output: 0.4 },
  },
  "z-ai/glm-5.3-flash-0828": {
    id: "z-ai/glm-5.3-flash-0828", name: "GLM 5.3 Flash 0828",
    limit: { context: 1048576, output: 131072 },
    reasoning: true, tool_call: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    capabilities: { reasoning: true, toolcall: true, attachment: true, input: { text: true, image: true }, output: { text: true } },
    variants: { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" } },
    cost: { input: 0.12, cache_read: 0.024, output: 0.4 },
  },
  "deepseek/deepseek-v4.1-flash:fast": {
    id: "deepseek/deepseek-v4.1-flash:fast", name: "DeepSeek V4.1 Flash (fast)",
    limit: { context: 1048568, output: 384000 },
    reasoning: true, tool_call: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    capabilities: { reasoning: true, toolcall: true, attachment: true, input: { text: true, image: true }, output: { text: true } },
    variants: { none: { reasoningEffort: "none" }, low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" } },
    cost: { input: 0.28, cache_read: 0.028, output: 1.1 },
  },
  "deepseek/deepseek-v4.1-flash-1017:fast": {
    id: "deepseek/deepseek-v4.1-flash-1017:fast", name: "DeepSeek V4.1 Flash 1017 (fast)",
    limit: { context: 1048568, output: 384000 },
    reasoning: true, tool_call: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    capabilities: { reasoning: true, toolcall: true, attachment: true, input: { text: true, image: true }, output: { text: true } },
    variants: { none: { reasoningEffort: "none" }, low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" } },
    cost: { input: 0.28, cache_read: 0.028, output: 1.1 },
  },
  "deepseek/deepseek-v4.1-flash-0910:fast": {
    id: "deepseek/deepseek-v4.1-flash-0910:fast", name: "DeepSeek V4.1 Flash 0910 (fast)",
    limit: { context: 1048568, output: 384000 },
    reasoning: true, tool_call: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    capabilities: { reasoning: true, toolcall: true, attachment: true, input: { text: true, image: true }, output: { text: true } },
    variants: { none: { reasoningEffort: "none" }, low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" } },
    cost: { input: 0.28, cache_read: 0.028, output: 1.1 },
  },
}

// perMillion converts OpenScale's per-token price ("0.00000006") into the
// per-million-tokens number model cost fields use (0.06). Anything that is
// not a positive finite number leaves the cost off.
function perMillion(value) {
  const n = typeof value === "string" ? Number(value) : value
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return undefined
  return Math.round(n * MILLION * MILLION) / MILLION
}

// display turns a catalog row's name ("DeepSeek: DeepSeek V4.1 Flash") into
// the display name ("DeepSeek V4.1 Flash"), falling back to the id.
function display(m) {
  const name = typeof m?.name === "string" && m.name.trim() ? m.name : String(m?.id ?? "")
  const at = name.indexOf(":")
  if (at > 0 && name.slice(at + 1).trim()) return name.slice(at + 1).trim()
  return name.trim()
}

// row builds the model entry both readers use: the config hook reads the
// top-level fields, the models hook the `capabilities` object.
function row(id, name, { limit, cost, reasoning, toolCall, image, variants } = {}) {
  return {
    id,
    name,
    limit: limit ?? { context: 0, output: 0 },
    reasoning: !!reasoning,
    tool_call: !!toolCall,
    modalities: { input: image ? ["text", "image"] : ["text"], output: ["text"] },
    capabilities: {
      reasoning: !!reasoning,
      toolcall: !!toolCall,
      attachment: !!image,
      input: { text: true, image: !!image },
      output: { text: true },
    },
    ...(variants && Object.keys(variants).length ? { variants } : {}),
    ...(cost && Object.keys(cost).length ? { cost } : {}),
  }
}

// rowFromCatalog reads one entry of OpenScale's model catalog: context and
// output limits from the text modalities, image input from any image
// modality, per-token prices (prompt / cached_prompt / completion), tool and
// reasoning support from the documented parameters, and each reasoning_effort
// level as a variant agents can pick.
function rowFromCatalog(m) {
  const inputs = Array.isArray(m?.input_modalities) ? m.input_modalities : []
  const outputs = Array.isArray(m?.output_modalities) ? m.output_modalities : []
  const textIn = inputs.find((x) => x?.type === "text")
  const textOut = outputs.find((x) => x?.type === "text")
  const priceOf = (mod, type) => perMillion((mod?.pricing ?? []).find((x) => x?.type === type)?.cost_usd)
  const inputCost = priceOf(textIn, "prompt")
  const cacheCost = priceOf(textIn, "cached_prompt")
  const outputCost = priceOf(textOut, "completion")
  const params = textOut?.supported_parameters ?? {}
  const efforts = Array.isArray(params.reasoning_effort?.values)
    ? params.reasoning_effort.values.filter((e) => typeof e === "string" && e)
    : []
  const reasoning = params.reasoning !== undefined || params.include_reasoning !== undefined || efforts.length > 0
  const cost = {
    ...(inputCost !== undefined && { input: inputCost }),
    ...(cacheCost !== undefined && { cache_read: cacheCost }),
    ...(outputCost !== undefined && { output: outputCost }),
  }
  const context = textIn?.supported_inputs?.max_context_length?.value
  const output = textOut?.max_length?.value
  return row(m?.id, display(m), {
    limit: {
      context: typeof context === "number" && context > 0 ? context : 0,
      output: typeof output === "number" && output > 0 ? output : 0,
    },
    cost,
    reasoning,
    toolCall: params.tools !== undefined,
    image: inputs.some((x) => x?.type === "image"),
    variants: Object.fromEntries(efforts.map((e) => [e, { reasoningEffort: e }])),
  })
}

// catalog lists the models a key can use, with the rich catalog each row is
// built from. OpenScale answers {"object":"list","data":[…]} like every
// OpenAI-compatible server.
async function catalog(fetchImpl, key) {
  return await fetchImpl(`${BASE}/models`, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  })
}

// rowsFromCatalog turns a catalog answer into model rows, dropping entries
// OpenScale does not mark ready. A malformed answer throws (the host keeps
// the previous list); an empty ready list is the account's truth — the key
// really has no models.
function rowsFromCatalog(body) {
  if (!Array.isArray(body?.data) || body.data.some((m) => typeof m?.id !== "string" || !m.id)) {
    throw new Error("OpenScale sent no model catalog")
  }
  const rows = body.data.filter((m) => m.is_ready !== false).map(rowFromCatalog)
  if (!rows.length) throw new Error("OpenScale has no ready models for this key")
  return Object.fromEntries(rows.map((r) => [r.id, r]))
}

function createPlugin({ fetchImpl = globalThis.fetch } = {}) {
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      // `??=` keeps a provider the user configured in plugins.json.
      cfg.provider[ID] ??= {
        name: "OpenScale",
        npm: "@ai-sdk/openai-compatible", // chat completions
        api: BASE,
        models: structuredClone(BOOTSTRAP),
      }
    },

    auth: {
      provider: ID,
      methods: [{ type: "api", label: "OpenScale API key", placeholder: "sk-openscale-…" }],
      // magpie sends `Authorization: Bearer <apiKey>` for
      // @ai-sdk/openai-compatible; no custom fetch is needed, and the host
      // applies the account's proxy to every request.
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        return { baseURL: BASE, apiKey: auth.key }
      },
      // OpenScale meters a prepaid balance per request and publishes no
      // endpoint that reads it, so this only checks the sign-in and says
      // where spend is visible. A key OpenScale refuses marks the account
      // (signIn: "expired").
      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        let res
        try {
          res = await catalog(fetchImpl, auth.key)
        } catch (error) {
          return { error: `OpenScale unreachable: ${error?.cause?.code || error?.message || "network error"}`, windows: [] }
        }
        if (res.status === 401 || res.status === 403) {
          return { error: `OpenScale refused this key (HTTP ${res.status}); sign in again`, signIn: "expired", windows: [] }
        }
        if (!res.ok) return { error: `OpenScale answered HTTP ${res.status}`, windows: [] }
        return { plan: "OpenScale", windows: [] }
      },
    },

    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        if (auth?.type !== "api" || !auth.key) return provider.models
        let res
        try {
          res = await catalog(fetchImpl, auth.key)
        } catch {
          // A network failure keeps the previous list, like a non-2xx answer.
          return provider.models
        }
        if (res.status === 401 || res.status === 403) {
          throw Object.assign(new Error(`OpenScale refused this key (HTTP ${res.status}); sign in again`), { signIn: "expired" })
        }
        if (!res.ok) return provider.models
        let body
        try {
          body = await res.json()
        } catch {
          throw new Error("OpenScale sent no model catalog")
        }
        return rowsFromCatalog(body)
      },
    },
  }
}

// The plugin is the only exported function; magpie calls every exported
// function as a plugin, so tests reach the internals through this object.
export const OpenscalePlugin = async () => createPlugin()
export const _internal = { createPlugin, row, rowFromCatalog, rowsFromCatalog, catalog, perMillion, display, BOOTSTRAP, BASE }
