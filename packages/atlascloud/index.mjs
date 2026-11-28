// Atlas Cloud (atlascloud.ai) for OpenCode and magpie.
//
// Atlas Cloud serves an OpenAI-compatible inference API at
// https://api.atlascloud.ai/v1: an API key signs every request
// (Authorization: Bearer), and GET /v1/models lists the models a key can use,
// each with its context window, output limit, input modalities and prices per
// token (docs: atlascloud.ai/docs). Atlas Cloud meters a prepaid balance and
// this plugin knows no balance endpoint, so the usage hook reports only the
// sign-in state; spend lives in the Atlas Cloud Console.

const ID = "atlascloud"
const BASE = "https://api.atlascloud.ai/v1"

// Reasoning efforts the gateway takes on every reasoning model: it accepts
// high and xhigh across the board, and rejects some lower levels per model.
const efforts = (...names) => Object.fromEntries(names.map((e) => [e, { reasoningEffort: e }]))
const VARIANTS = efforts("high", "xhigh")

// One model of the bootstrap list, used until the account's list arrives.
const BOOT = [
  { id: "deepseek-ai/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
  { id: "moonshotai/kimi-k3", name: "Kimi K3" },
  { id: "zai-org/glm-5.2", name: "GLM 5.2" },
]

// row builds a model row with the fields both readers use: the config hook
// reads the top-level ones, the models hook reads the `capabilities` object.
function row({ id, name, cost, limit, image, reasoning, tools }) {
  return {
    id,
    name,
    limit: limit ?? { context: 0, output: 0 },
    reasoning: !!reasoning,
    tool_call: tools !== false,
    modalities: { input: image ? ["text", "image"] : ["text"], output: ["text"] },
    capabilities: {
      reasoning: !!reasoning,
      toolcall: tools !== false,
      attachment: !!image,
      input: { text: true, image: !!image },
      output: { text: true },
    },
    ...(reasoning ? { variants: VARIANTS } : {}),
    ...(cost ? { cost } : {}),
  }
}

// pretty turns an API id into a display name, for a model that sends none
// ("deepseek-ai/deepseek-v4-flash" → "deepseek v4 flash").
function pretty(id) {
  return id.split("/").pop().replace(/[-_]+/g, " ").trim()
}

const num = (v) => {
  const n = typeof v === "string" ? Number(v) : v
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined
}

// per-million USD cost from the per-token prices of a model's input and
// output modalities; anything missing leaves that field off
function costOf(m) {
  const price = (list, type) => num(list?.find?.((p) => p?.type === type)?.cost_usd)
  const text = m.input_modalities?.find?.((x) => x?.type === "text")
  const perM = (v) => (v === undefined ? undefined : Math.round(v * 1e6 * 1e6) / 1e6)
  const input = perM(price(text?.pricing, "prompt"))
  const cache_read = perM(price(text?.pricing, "cached_prompt"))
  const output = perM(price(m.output_modalities?.find?.((x) => x?.type === "text")?.pricing, "completion"))
  if (input === undefined && output === undefined) return undefined
  return { ...(input !== undefined && { input }), ...(output !== undefined && { output }), ...(cache_read !== undefined && { cache_read }) }
}

// fromApi turns one /v1/models entry into a row. Only what the entry states
// is used: limits and prices as listed, image input when "image" is an input
// modality, reasoning when the entry lists a `reasoning` parameter. An entry
// that doesn't say about tools is taken to accept them.
function fromApi(m) {
  const text = m.input_modalities?.find?.((x) => x?.type === "text")
  const out = m.output_modalities?.find?.((x) => x?.type === "text")
  const params = out?.supported_parameters
  const context = num(text?.supported_inputs?.max_context_length?.value) ?? 0
  const output = num(out?.max_length?.value) ?? num(params?.max_tokens?.max) ?? 0
  return row({
    id: m.id,
    name: typeof m.name === "string" && m.name ? m.name : pretty(m.id),
    cost: costOf(m),
    limit: { context, output },
    image: !!m.input_modalities?.some?.((x) => x?.type === "image"),
    reasoning: !!params && "reasoning" in params,
    tools: params && "tools" in params ? params.tools?.type !== "unknown" : undefined,
  })
}

// accountModels lists the models a key can use. Atlas Cloud answers
// {"data":[{"id":…}]} like every OpenAI-compatible server, with extra fields.
async function accountModels(fetchImpl, key) {
  return await fetchImpl(`${BASE}/models`, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  })
}

function createPlugin({ fetchImpl = globalThis.fetch } = {}) {
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      // `??=` keeps a provider the user configured in plugins.json.
      cfg.provider[ID] ??= {
        name: "Atlas Cloud",
        npm: "@ai-sdk/openai-compatible", // chat completions
        api: BASE,
        models: Object.fromEntries(BOOT.map((m) => [m.id, row(m)])),
      }
    },

    auth: {
      provider: ID,
      methods: [{ type: "api", label: "Atlas Cloud API key", placeholder: "apikey-…" }],
      // magpie sends `Authorization: Bearer <apiKey>` for
      // @ai-sdk/openai-compatible; no custom fetch is needed, and the host
      // applies the account's proxy to every request.
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        return { baseURL: BASE, apiKey: auth.key }
      },
      // No balance endpoint is read, so this only checks the sign-in. A key
      // Atlas Cloud refuses marks the account (signIn: "expired").
      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        let res
        try {
          res = await accountModels(fetchImpl, auth.key)
        } catch (error) {
          return { error: `Atlas Cloud unreachable: ${error?.cause?.code || error?.message || "network error"}`, windows: [] }
        }
        if (res.status === 401 || res.status === 403) {
          return { error: `Atlas Cloud refused this key (HTTP ${res.status}); sign in again`, signIn: "expired", windows: [] }
        }
        if (!res.ok) return { error: `Atlas Cloud answered HTTP ${res.status}`, windows: [] }
        return { plan: "Pay as you go", windows: [] }
      },
    },

    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        if (auth?.type !== "api" || !auth.key) return provider.models
        let res
        try {
          res = await accountModels(fetchImpl, auth.key)
        } catch {
          // A network failure keeps the previous list, like a non-2xx answer.
          return provider.models
        }
        if (res.status === 401 || res.status === 403) {
          throw Object.assign(new Error(`Atlas Cloud refused this key (HTTP ${res.status}); sign in again`), { signIn: "expired" })
        }
        if (!res.ok) return provider.models
        let body
        try {
          body = await res.json()
        } catch {
          throw new Error("Atlas Cloud sent no model list")
        }
        // A malformed answer keeps the previous list (the host marks it a
        // fallback); an empty one is the account's list and replaces the
        // bootstrap rows the way a live catalog does.
        if (!Array.isArray(body?.data) || body.data.some((m) => typeof m?.id !== "string" || !m.id)) {
          throw new Error("Atlas Cloud sent no model list")
        }
        return Object.fromEntries(body.data.map((m) => [m.id, fromApi(m)]))
      },
    },
  }
}

// The plugin is the only exported function; magpie calls every exported
// function as a plugin, so tests reach the internals through this object.
export const AtlasCloudPlugin = async () => createPlugin()
export const _internal = { createPlugin, row, pretty, costOf, fromApi, VARIANTS, BOOT, BASE }
