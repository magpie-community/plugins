// OpenCode & Magpie provider plugin for Doubao (豆包) free models.
// Supports connecting to a local/remote doubao-free-api gateway, or direct web session tokens.

const PROVIDER = "doubao-free"
const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8000/v1"
const PLACEHOLDER_KEY = "sk-doubao-free"

// Doubao's free / default model catalog
const MODELS = [
  { id: "doubao-pro-32k", name: "Doubao Pro 32k", context: 32768, output: 4096 },
  { id: "doubao-pro-128k", name: "Doubao Pro 128k", context: 128000, output: 4096 },
  { id: "doubao-lite-32k", name: "Doubao Lite 32k", context: 32768, output: 4096 },
  { id: "doubao-lite-128k", name: "Doubao Lite 128k", context: 128000, output: 4096 },
  { id: "doubao-vision-pro-32k", name: "Doubao Vision Pro 32k", context: 32768, output: 4096 },
]

function formatModels() {
  return Object.fromEntries(
    MODELS.map((m) => [
      m.id,
      {
        id: m.id,
        name: m.name,
        limit: { context: m.context, output: m.output },
      },
    ]),
  )
}

function cleanBaseURL(raw) {
  let url = (raw || DEFAULT_GATEWAY_URL).trim()
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `http://${url}`
  }
  return url.replace(/\/+$/, "")
}

function friendlyErrorMessage(err, baseURL) {
  const msg = err?.message || String(err)
  const cause = err?.cause?.message || String(err?.cause || "")
  const fullText = `${msg} ${cause}`
  if (fullText.includes("ECONNREFUSED") || fullText.includes("fetch failed") || fullText.includes("Failed to fetch")) {
    return `无法连接到豆包免费网关 (${baseURL})。请确认已在本地或服务器启动 doubao-free-api 服务。\n启动示例：docker run -d --name doubao-free-api -p 8000:8000 ghcr.io/llm-red-team/doubao-free-api:latest`
  }
  if (fullText.includes("401") || fullText.includes("Unauthorized")) {
    return "豆包凭证验证失败 (401 Unauthorized)。请检查设置的 API Key 或网页 SessionID 是否正确。"
  }
  if (fullText.includes("429") || fullText.includes("Too Many Requests")) {
    return "触发豆包请求频率限制 (429 Too Many Requests)，请稍后再试。"
  }
  return msg
}

function makePlugin() {
  return async ({ client }) => {
    return {
      config: async (config) => {
        config.provider ??= {}
        config.provider[PROVIDER] ??= {}
        const p = config.provider[PROVIDER]
        p.name ??= "Doubao Free (豆包)"
        p.npm ??= "@ai-sdk/openai-compatible"
        p.api ??= DEFAULT_GATEWAY_URL
        p.models = {
          ...formatModels(),
          ...(p.models ?? {}),
        }
      },

      provider: {
        id: PROVIDER,
        async models(provider, { auth }) {
          // If custom models or dynamic discovery is needed, add here
          return provider?.models || formatModels()
        },
      },

      auth: {
        provider: PROVIDER,
        single: true,
        icon: "https://lf-flow-web-cdn.doubao.com/obj/flow-doubao/doubao/web/logo-icon.png",
        maxConcurrency: 2,
        methods: [
          {
            type: "api",
            label: "Doubao Free 网关 (推荐，配合 Docker 镜像)",
            description: "连接本地或远程运行的 doubao-free-api 逆向服务 (如 http://127.0.0.1:8000/v1)",
            prompts: [
              {
                type: "text",
                key: "baseURL",
                message: "服务地址 (Base URL)",
                placeholder: "http://127.0.0.1:8000/v1",
                initial: "http://127.0.0.1:8000/v1",
              },
              {
                type: "password",
                key: "apiKey",
                message: "API Key (如未设密码可留空或填任意值)",
                placeholder: "sk-doubao-free",
              },
            ],
            async authorize(inputs) {
              const baseURL = cleanBaseURL(inputs?.baseURL)
              const key = inputs?.apiKey?.trim() || PLACEHOLDER_KEY
              return {
                type: "success",
                key,
                baseURL,
                mode: "gateway",
              }
            },
          },
          {
            type: "api",
            label: "网页版 SessionID 凭证接入",
            description: "填入在 doubao.com 登录后的 Cookie sessionid",
            prompts: [
              {
                type: "password",
                key: "sessionid",
                message: "豆包 sessionid",
                placeholder: "从 doubao.com 控制台 Application -> Cookies 中复制 sessionid",
              },
              {
                type: "text",
                key: "baseURL",
                message: "网关或反代地址 (可选)",
                placeholder: "http://127.0.0.1:8000/v1",
                initial: "http://127.0.0.1:8000/v1",
              },
            ],
            async authorize(inputs) {
              const sessionid = inputs?.sessionid?.trim()
              if (!sessionid) {
                return { type: "failed", error: "SessionID 不能为空" }
              }
              const baseURL = cleanBaseURL(inputs?.baseURL)
              return {
                type: "success",
                key: sessionid,
                sessionid,
                baseURL,
                mode: "session",
              }
            },
          },
        ],

        async loader(getAuth) {
          const auth = await getAuth()
          if (!auth) return {}

          const baseURL = cleanBaseURL(auth.baseURL)
          const apiKey = auth.key || auth.sessionid || PLACEHOLDER_KEY

          return {
            baseURL,
            apiKey,
            async fetch(input, init) {
              const req = input instanceof Request ? input : null
              const rawURL = req ? req.url : String(input)

              // Ensure correct URL resolution against baseURL
              let targetURL = rawURL
              if (!targetURL.startsWith("http://") && !targetURL.startsWith("https://")) {
                targetURL = `${baseURL.replace(/\/+$/, "")}/${targetURL.replace(/^\/+/, "")}`
              }

              // Clone headers and inject necessary auth
              const headers = new Headers(init?.headers ?? req?.headers)
              headers.delete("content-length")
              if (!headers.has("Authorization")) {
                headers.set("Authorization", `Bearer ${apiKey}`)
              }
              if (auth.sessionid && !headers.has("X-Doubao-Session-Id")) {
                headers.set("X-Doubao-Session-Id", auth.sessionid)
              }

              const fetchOptions = {
                ...init,
                method: init?.method ?? req?.method ?? "POST",
                headers,
                body: init?.body ?? (req ? await req.clone().text() : undefined),
              }

              try {
                const response = await fetch(targetURL, fetchOptions)

                // If upstream returned error, wrap with helpful human diagnostics
                if (!response.ok) {
                  const errorText = await response.text()
                  let errJson = null
                  try {
                    errJson = JSON.parse(errorText)
                  } catch {}

                  const detail = errJson?.error?.message || errJson?.message || errorText || response.statusText
                  const friendlyMsg = friendlyErrorMessage(new Error(detail), baseURL)

                  return new Response(
                    JSON.stringify({
                      error: {
                        message: friendlyMsg,
                        type: "doubao_provider_error",
                        code: response.status,
                      },
                    }),
                    {
                      status: response.status,
                      statusText: response.statusText,
                      headers: { "Content-Type": "application/json" },
                    },
                  )
                }

                return response
              } catch (err) {
                const friendly = friendlyErrorMessage(err, baseURL)
                return new Response(
                  JSON.stringify({
                    error: {
                      message: friendly,
                      type: "doubao_network_error",
                    },
                  }),
                  {
                    status: 502,
                    headers: { "Content-Type": "application/json" },
                  },
                )
              }
            },
          }
        },
      },
    }
  }
}

export const DoubaoFreeAuthPlugin = makePlugin()
export default DoubaoFreeAuthPlugin
