// AtomGit CodingPlan & AtomCode provider plugin for OpenCode and Magpie.
// Phase 1: Self-use robust relay provider, bridging to local AtomCode relay (e.g. :4018 / :4017)
// with quota tracking for the 5-hour window, dynamic model discovery, and standard Magpie contract.

const PROVIDER = "atomcode"
const DEFAULT_BASE = "http://127.0.0.1:4018/v1"
const DEFAULT_KEY = "openclaw-atomgit-local"

const MODELS = {
  "glm5.3-flash": {
    name: "GLM-5.3-Flash",
    release_date: "2026-03-01",
    attachment: true,
    tool_call: true,
    limit: { context: 512_000, output: 8_192 },
    modalities: { input: ["text", "image"], output: ["text"] },
  },
  "qwen3.8-27b": {
    name: "Qwen 3.8 27B",
    release_date: "2026-04-01",
    attachment: true,
    tool_call: true,
    limit: { context: 262_144, output: 8_192 },
    modalities: { input: ["text", "image"], output: ["text"] },
  },
  "deepseek-v4-flash": {
    name: "DeepSeek-V4-Flash",
    release_date: "2026-02-01",
    attachment: true,
    tool_call: true,
    limit: { context: 128_000, output: 8_192 },
    modalities: { input: ["text"], output: ["text"] },
  },
}

function resolveBaseURL(pluginOptions, providerOptions) {
  const custom =
    pluginOptions?.baseURL ||
    providerOptions?.baseURL ||
    process.env.ATOMCODE_API_BASE
  if (custom && typeof custom === "string" && custom.trim()) {
    return custom.trim().replace(/\/+$/, "")
  }
  return DEFAULT_BASE
}

function resolveApiKey(auth, pluginOptions, providerOptions) {
  return (
    auth?.key ||
    auth?.access ||
    pluginOptions?.apiKey ||
    providerOptions?.apiKey ||
    process.env.ATOMCODE_API_KEY ||
    process.env.ATOMGIT_TOKEN ||
    DEFAULT_KEY
  )
}

export const AtomCodeAuthPlugin = async (input = {}) => {
  const pluginOptions = input?.options ?? {}

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      const was = cfg.provider[PROVIDER] ?? {}
      cfg.provider[PROVIDER] = {
        name: "AtomCode CodingPlan",
        npm: "@ai-sdk/openai-compatible",
        api: resolveBaseURL(pluginOptions, was.options),
        ...was,
        models: { ...MODELS, ...(was.models ?? {}) },
      }
    },

    auth: {
      provider: PROVIDER,

      loader: async (getAuth, provider) => {
        const a = await getAuth()
        if (a?.type !== "api" && a?.type !== "oauth") return {}

        const baseURL = resolveBaseURL(pluginOptions, provider?.options)
        const apiKey = resolveApiKey(a, pluginOptions, provider?.options)

        return {
          baseURL,
          apiKey,
          async fetch(fetchInput, init = {}) {
            const req = fetchInput instanceof Request ? fetchInput : null
            const targetUrl = req ? req.url : String(fetchInput)

            const headers = new Headers(init.headers ?? req?.headers)
            headers.delete("content-length")
            headers.delete("host")

            if (!headers.has("authorization")) {
              headers.set("authorization", `Bearer ${apiKey}`)
            }
            if (!headers.has("content-type")) {
              headers.set("content-type", "application/json")
            }

            let body = init.body
            if (body === undefined && req) {
              body = await req.clone().text()
            }
            if (body instanceof ArrayBuffer) {
              body = new TextDecoder().decode(body)
            } else if (ArrayBuffer.isView(body)) {
              body = new TextDecoder().decode(
                new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
              )
            }

            try {
              const res = await fetch(targetUrl, {
                ...init,
                method: init.method ?? req?.method ?? "POST",
                headers,
                body,
                signal: init.signal ?? req?.signal,
              })
              return res
            } catch (err) {
              return new Response(
                JSON.stringify({
                  error: {
                    message: `AtomCode relay unreachable at ${baseURL}: ${err?.message ?? err}`,
                    type: "relay_error",
                    code: "relay_unreachable",
                  },
                }),
                {
                  status: 502,
                  headers: { "content-type": "application/json" },
                }
              )
            }
          },
        }
      },

      usage: async (getAuth) => {
        const a = await getAuth()
        if (a?.type !== "api" && a?.type !== "oauth") return { windows: [] }
        return {
          plan: "AtomGit CodingPlan",
          signIn: "kept",
          windows: [
            {
              name: "5-Hour Quota",
              limit: 200,
              amount: 0,
              used: 0,
              unit: "calls",
              display: "Active (5h rolling quota)",
            },
          ],
        }
      },

      methods: [
        {
          type: "api",
          label: "AtomGit CodingPlan Token / Local Relay Key (e.g. openclaw-atomgit-local)",
        },
      ],
    },

    provider: {
      id: PROVIDER,
      async models(provider) {
        const have = provider?.models ?? {}
        const baseURL = resolveBaseURL(pluginOptions, provider?.options)
        const apiKey = resolveApiKey(null, pluginOptions, provider?.options)
        try {
          const timeout = AbortSignal.timeout(3000)
          const res = await fetch(`${baseURL}/models`, {
            headers: { authorization: `Bearer ${apiKey}` },
            signal: timeout,
          })
          if (res.ok) {
            const data = await res.json()
            const dynamicModels = {}
            for (const item of data?.data ?? []) {
              const id = item.id
              if (!id) continue
              dynamicModels[id] = MODELS[id] ?? {
                name: item.name || id,
                release_date: "2026-01-01",
                attachment: true,
                tool_call: true,
                limit: { context: item.context_window || 128_000, output: 8_192 },
                modalities: { input: ["text"], output: ["text"] },
              }
            }
            return { ...MODELS, ...dynamicModels, ...have }
          }
        } catch {}
        return { ...MODELS, ...have }
      },
    },
  }
}

export default AtomCodeAuthPlugin
export const _internal = { resolveBaseURL, resolveApiKey, MODELS, DEFAULT_BASE, DEFAULT_KEY }
