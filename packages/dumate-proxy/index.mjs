import { readFileSync } from "node:fs"
import { loadConfig as defaultLoadConfig } from "./src/config.mjs"
import { loadCatalog as defaultLoadCatalog } from "./src/catalog.mjs"

const LOGIN_URL = "https://login.bce.baidu.com/?from=oa_dumate&redirect=https%3A%2F%2Fconsole.bce.baidu.com%2F"
const PROVIDER_ID = "dumate"
const PROVIDER_NAME = "DuMate Proxy"
const KEEPALIVE_TTL_MS = 55 * 60 * 1000
const REFRESH_LEAD_MS = 10 * 60 * 1000
const KEEPALIVE_REFRESH = "dumate-proxy-keepalive"

const ICON = (() => {
  try {
    return `data:image/png;base64,${readFileSync(new URL("./icon.png", import.meta.url)).toString("base64")}`
  } catch {
    return ""
  }
})()

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

function normalizeCookie(value) {
  return String(value ?? "").trim().replace(/^["']+|["']+$/g, "")
}

function hasRequiredCookie(raw) {
  return String(raw ?? "").split(/;\s*/).some((part) => part.trim().toLowerCase().startsWith("bce-sessionid="))
}

async function postAuth(url, body, fetchImpl, proxyKey) {
  try {
    const headers = { "Content-Type": "application/json" }
    if (proxyKey) headers.Authorization = "Bearer " + proxyKey
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    const info = await response.json().catch(() => ({}))
    if (!response.ok) return { failed: String(info?.error?.message || "HTTP " + response.status) }
    return { info }
  } catch (error) {
    return { failed: String(error?.message ?? error) }
  }
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
  const loginUrl = new URL("/v1/auth/login", proxyUrl).toString()
  const desktopUrl = new URL("/v1/auth/desktop", proxyUrl).toString()

  const renewedSeat = (previous = {}) => ({
    type: "oauth",
    access: `api:${proxyKey}`,
    refresh: KEEPALIVE_REFRESH,
    expires: Date.now() + KEEPALIVE_TTL_MS,
    source: previous.source || "proxy",
    accountId: previous.accountId || "dumate-proxy",
    name: previous.name || "DuMate Proxy",
  })

  const seatFromInfo = (info = {}, fallbackSource = "proxy") => {
    const source = String(info.source || fallbackSource || "proxy").slice(0, 32)
    const accountId = String(info.accountId || "DuMate Proxy").slice(0, 160)
    const name = String(info.name || "DuMate Proxy").slice(0, 160)
    return {
      ...renewedSeat({ source, accountId, name }),
      type: "success",
      source,
      accountId,
      name,
      metadata: { source, accountId, name, cookieTail: String(info.cookieTail || "").slice(-8) },
    }
  }

  const loginWithCookie = async (raw, source) => {
    const cookie = normalizeCookie(raw)
    if (!cookie) return { type: "failed", error: "请粘贴完整 Cookie 请求头" }
    if (!hasRequiredCookie(cookie)) return { type: "failed", error: "Cookie 缺少关键字段 bce-sessionid" }
    const result = await postAuth(loginUrl, { cookie, source }, fetchImpl, proxyKey)
    if (result.failed) return { type: "failed", error: `Cookie 验证失败：${result.failed}` }
    return seatFromInfo(result.info, source)
  }
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
          label: "反代已配置登录态（环境变量 / Cookie 文件）",
          authorize: async () => ({
            url: "",
            instructions: `检查 ${proxyUrl} 的 /healthz；登录态由反代进程持有。`,
            method: "auto",
            opened: true,
            async callback() {
              try {
                const response = await fetchImpl(healthUrl, {
                  headers: proxyKey ? { Authorization: "Bearer " + proxyKey } : {},
                  signal: AbortSignal.timeout(5000),
                })
                const info = await response.json().catch(() => ({}))
                if (!response.ok || (info?.login && info.login !== "ok")) {
                  return { type: "failed", error: "反代未报告可用登录态，请先配置 DuMate Cookie" }
                }
                return seatFromInfo(info, "proxy")
              } catch (error) {
                return { type: "failed", error: "连接 " + healthUrl + " 失败：" + String(error?.message ?? error) }
              }
            },
          }),
        },
        {
          type: "oauth",
          label: "服务器本机 DuMate 桌面端登录态（auth.json，只读复用）",
          authorize: async () => ({
            url: "",
            instructions: "从反代所在主机读取 qianfan-desktop-app/auth.json 与 .cookie-key，只读，不修改客户端文件。",
            method: "auto",
            opened: true,
            async callback() {
              const result = await postAuth(desktopUrl, {}, fetchImpl, proxyKey)
              if (result.failed) return { type: "failed", error: "读取桌面端登录态失败：" + result.failed }
              return seatFromInfo(result.info, "desktop")
            },
          }),
        },
        {
          type: "oauth",
          label: "浏览器登录：粘贴 Network 请求头 Cookie",
          authorize: async () => ({
            url: LOGIN_URL,
            instructions:
              "1. 打开上方链接登录百度账号。\n" +
              "2. 登录成功后进入 console.bce.baidu.com，按 F12 打开 DevTools → Network。\n" +
              "3. 刷新页面，点第一个请求，在 Request Headers 找到 Cookie，复制完整 value。\n" +
              "4. 把 Cookie 粘贴到下方输入框。不要用 document.cookie，关键字段是 httpOnly。",
            method: "code",
            async callback(input) {
              return loginWithCookie(input, "browser")
            },
          }),
        },
        {
          type: "oauth",
          label: "手动粘贴 Cookie 字符串",
          prompts: [
            {
              type: "text",
              key: "cookie",
              message: "完整 Cookie 请求头（name=value; name2=value2）",
              placeholder: "bce-sessionid=...; BDUSS=...",
              validate: (value) => hasRequiredCookie(normalizeCookie(value)) ? undefined : "需要包含 bce-sessionid",
            },
          ],
          authorize: async (inputs) => {
            const raw = normalizeCookie(inputs?.cookie ?? inputs?.key)
            if (!hasRequiredCookie(raw)) return { type: "failed", error: "请粘贴包含 bce-sessionid 的完整 Cookie" }
            return {
              url: "",
              instructions: "正在验证 Cookie 并写入反代运行时登录态…",
              method: "auto",
              opened: true,
              async callback() {
                return loginWithCookie(raw, "manual")
              },
            }
          },
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
