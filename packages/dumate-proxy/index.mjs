import { loadConfig as defaultLoadConfig } from "./src/config.mjs"
import { loadCatalog as defaultLoadCatalog } from "./src/catalog.mjs"

const PROVIDER_ID = "dumate"
const PROVIDER_NAME = "DuMate Proxy"
const KEEPALIVE_TTL_MS = 55 * 60 * 1000
const REFRESH_LEAD_MS = 10 * 60 * 1000
const KEEPALIVE_REFRESH = "dumate-proxy-keepalive"

const ICON = "data:image/svg+xml;base64," + Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1b6ef3"/><path d="M18 42c8-18 20-26 30-28-2 12-10 24-22 30l-8 4z" fill="#fff"/><circle cx="41" cy="25" r="5" fill="#ffd166"/></svg>`,
  "utf8",
).toString("base64")

const ALLOWED_PATHS = [
  "/models",
  "/v1/models",
  "/chat/completions",
  "/v1/chat/completions",
  "/images/generations",
  "/v1/images/generations",
  "/images/edits",
  "/v1/images/edits",
]

function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })
}

function toMagpieModels(catalog) {
  const models = Object.create(null)
  for (const [key, model] of Object.entries(catalog?.models ?? {})) {
    const image = model.kind === "image"
    models[key] = {
      // Magpie uses the map key as the visible model id and this field as the
      // API/upstream id written into request bodies (pluginFetch rewrites it).
      id: model.upstreamId || model.id,
      name: model.name,
      limit: { context: model.context, output: model.maxOutput },
      tool_call: image ? false : model.tool_call,
      reasoning: image ? false : model.reasoning,
      attachment: model.attachment,
      // This is the authoritative chat-vs-image signal for OpenAI-compatible
      // plugins: imagesOnly(output) = output has image and has no text.
      modalities: {
        input: [...model.modalities.input],
        output: [...model.modalities.output],
      },
      ...(key === "deepseek-v41-flash" && !image
        ? { variants: { none: {}, low: {}, high: {}, max: {} } }
        : {}),
    }
  }
  return models
}

export const DuMateProxyPlugin = async (input = {}) => {
  const config = input.config ?? defaultLoadConfig(input.env ?? process.env)
  const catalog = input.catalog ?? defaultLoadCatalog(config)
  const proxyUrl = String(input.proxyUrl ?? config.proxyUrl ?? "http://127.0.0.1:8787/v1").replace(/\/+$/, "")
  const proxyKey = String(input.proxyKey ?? config.apiKey ?? "")
  const fetchImpl = input.fetchImpl ?? fetch
  const models = toMagpieModels(catalog)
  const healthUrl = new URL("/healthz", proxyUrl).toString()
  const keepaliveUrl = new URL("/v1/keepalive", proxyUrl).toString()

  const renewedSeat = (previous = {}) => ({
    type: "oauth",
    access: `api:${proxyKey}`,
    refresh: KEEPALIVE_REFRESH,
    expires: Date.now() + KEEPALIVE_TTL_MS,
    source: previous.source || "proxy",
    accountId: previous.accountId || "dumate-proxy",
    name: previous.name || "DuMate Proxy",
  })

  const isAllowedTarget = (target) => {
    const proxy = new URL(proxyUrl)
    const basePath = proxy.pathname.replace(/\/+$/, "")
    if (target.origin !== proxy.origin) return false
    if (basePath && !target.pathname.startsWith(basePath)) return false
    return ALLOWED_PATHS.some((path) => target.pathname === path || target.pathname.endsWith(path))
  }

  return {
    config(userConfig) {
      userConfig.provider ??= {}
      const previous = userConfig.provider[PROVIDER_ID] ?? {}
      userConfig.provider[PROVIDER_ID] = {
        name: PROVIDER_NAME,
        npm: "@ai-sdk/openai-compatible",
        api: proxyUrl,
        ...previous,
        models: {
          ...models,
          ...(previous.models ?? {}),
        },
      }
      return userConfig
    },

    provider: {
      id: PROVIDER_ID,
      async models(provider) {
        return provider?.models ?? models
      },
    },

    auth: {
      provider: PROVIDER_ID,
      single: true,
      icon: ICON,
      // Magpie renews OAuth sign-ins through auth.refresh before expiry and,
      // unless keepAlive is false, while nothing uses the account.
      refreshLead: REFRESH_LEAD_MS,
      keepAlive: true,
      rotating: false,
      async refresh(previous) {
        try {
          const response = await fetchImpl(keepaliveUrl, {
            method: "POST",
            headers: proxyKey ? { Authorization: `Bearer ${proxyKey}` } : {},
            signal: AbortSignal.timeout(15_000),
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const info = await response.json()
          if (info?.login && info.login !== "ok") {
            const error = new Error("DuMate 代理登录态已失效，请在桌面端重新登录")
            error.signIn = "expired"
            throw error
          }
          return renewedSeat(previous)
        } catch (error) {
          if (error?.signIn === "expired") throw error
          throw new Error(`刷新 DuMate 代理保活失败：${error?.message ?? error}`)
        }
      },
      methods: [
        {
          type: "oauth",
          label: "DuMate 本地反代（模型清单与登录态由反代进程管理）",
          authorize: async () => ({
            url: "",
            instructions:
              `请先启动 dumate-proxy（默认 ${proxyUrl}），确保 /healthz 返回 ok。` +
              "插件只负责把反代暴露的 LLM 与生图模型登记到 Magpie。",
            method: "auto",
            async callback() {
              try {
                const response = await fetchImpl(healthUrl, {
                  headers: proxyKey ? { Authorization: `Bearer ${proxyKey}` } : {},
                  signal: AbortSignal.timeout(5000),
                })
                if (!response.ok) throw new Error(`HTTP ${response.status}`)
                const info = await response.json()
                if (info?.login && info.login !== "ok") {
                  return {
                    type: "failed",
                    error: "DuMate 代理登录态缺失，请先启动反代并配置 DuMate Cookie。",
                  }
                }
                return {
                  ...renewedSeat(),
                  type: "success",
                  name: "DuMate Proxy（已登录）",
                  accountId: "DuMate Proxy",
                }
              } catch (error) {
                return {
                  type: "failed",
                  error: `连接 ${healthUrl} 失败：${error?.message ?? error}`,
                }
              }
            },
          }),
        },
      ],
    },

    async loader() {
      return {
        baseURL: proxyUrl,
        apiKey: proxyKey || "dumate-proxy",
        async fetch(input, init = {}) {
          const request = input instanceof Request ? input : undefined
          let target
          try {
            target = new URL(request ? request.url : String(input))
          } catch {
            return jsonResponse(400, { error: { message: "invalid proxy url", type: "invalid_request_error" } })
          }
          if (!isAllowedTarget(target)) {
            return jsonResponse(400, {
              error: { message: "DuMate proxy loader 仅允许 models/chat/images 路径", type: "invalid_request_error" },
            })
          }

          const headers = new Headers(init.headers ?? request?.headers)
          headers.delete("x-api-key")
          if (proxyKey) headers.set("Authorization", `Bearer ${proxyKey}`)

          let body = init.body
          if (body === undefined && request) body = await request.clone().arrayBuffer()

          return fetchImpl(target, {
            ...init,
            method: init.method ?? request?.method ?? "POST",
            headers,
            body,
            redirect: "manual",
            signal: init.signal ?? AbortSignal.timeout(180_000),
          })
        },
      }
    },
  }
}

export default DuMateProxyPlugin

export const _internal = { toMagpieModels }
