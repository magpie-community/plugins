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
      id: model.upstreamId || model.id,
      name: model.name,
      limit: { context: model.context, output: model.maxOutput },
      tool_call: image ? false : model.tool_call,
      reasoning: image ? false : model.reasoning,
      attachment: model.attachment,
      modalities: {
        input: [...model.modalities.input],
        output: [...model.modalities.output],
      },
      ...(key === "deepseek-v41-flash" && !image ? { variants: { none: {}, low: {}, high: {}, max: {} } } : {}),
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

function normalizeProxyBase(value, fallback) {
  const raw = String(value ?? "").trim().replace(/\/+$/, "")
  if (!raw) return String(fallback ?? "").replace(/\/+$/, "")
  try {
    const url = new URL(raw)
    if (!/^https?:$/.test(url.protocol)) return String(fallback ?? "").replace(/\/+$/, "")
    return url.toString().replace(/\/+$/, "")
  } catch {
    return String(fallback ?? "").replace(/\/+$/, "")
  }
}

function proxyPrompt(defaultUrl) {
  return {
    type: "text",
    key: "proxyUrl",
    message: "DuMate 反代地址（Docker 请填宿主机可达地址，不要填容器内的 127.0.0.1）",
    placeholder: defaultUrl || "http://host.docker.internal:8787/v1",
    required: false,
    validate: (value) => {
      if (!String(value ?? "").trim()) return undefined
      return /^https?:\/\//i.test(String(value).trim()) ? undefined : "需要 http:// 或 https:// 开头的地址"
    },
  }
}

const proxyKeyPrompt = {
  type: "text",
  key: "proxyKey",
  message: "反代 API Key（可选；设置了 DUMATE_PROXY_API_KEY 时填写）",
  placeholder: "",
  required: false,
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
  const proxyUrl = normalizeProxyBase(input.proxyUrl ?? config.proxyUrl ?? "http://127.0.0.1:8787/v1", "http://127.0.0.1:8787/v1")
  const proxyKey = String(input.proxyKey ?? config.apiKey ?? "")
  const fetchImpl = input.fetchImpl ?? fetch
  const models = toMagpieModels(catalog)
  const keepaliveUrl = new URL("/v1/keepalive", proxyUrl).toString()

  const authFromInputs = (inputs) => ({
    base: normalizeProxyBase(inputs?.proxyUrl, proxyUrl),
    key: String(inputs?.proxyKey ?? proxyKey ?? ""),
  })

  const isAllowedTarget = (target, base) => {
    const proxy = new URL(base)
    const basePath = proxy.pathname.replace(/\/+$/, "")
    if (target.origin !== proxy.origin) return false
    if (basePath && !target.pathname.startsWith(basePath)) return false
    return ALLOWED_PATHS.some((path) => target.pathname === path || target.pathname.endsWith(path))
  }

  const renewedSeat = (previous = {}, key = proxyKey) => ({
    type: "oauth",
    access: `api:${key}`,
    refresh: KEEPALIVE_REFRESH,
    expires: Date.now() + KEEPALIVE_TTL_MS,
    source: previous.source || "proxy",
    accountId: previous.accountId || "dumate-proxy",
    name: previous.name || "DuMate Proxy",
  })

  const seatFromInfo = (info = {}, fallbackSource, base, key) => {
    const source = String(info.source || fallbackSource || "proxy").slice(0, 32)
    const accountId = String(info.accountId || "DuMate Proxy").slice(0, 160)
    const name = String(info.name || "DuMate Proxy").slice(0, 160)
    return {
      ...renewedSeat(info, key),
      type: "success",
      source,
      accountId,
      name,
      proxyUrl: base,
      proxyKey: key,
      metadata: { source, accountId, name, cookieTail: String(info.cookieTail || "").slice(-8), proxyUrl: base },
    }
  }

  const loginWithCookie = async (base, key, raw, source) => {
    const cookie = normalizeCookie(raw)
    if (!cookie) return { type: "failed", error: "请粘贴完整 Cookie 请求头" }
    if (!hasRequiredCookie(cookie)) return { type: "failed", error: "Cookie 缺少关键字段 bce-sessionid" }
    const result = await postAuth(new URL("/v1/auth/login", base).toString(), { cookie, source }, fetchImpl, key)
    if (result.failed) return { type: "failed", error: `Cookie 验证失败：${result.failed}；请检查反代地址、代理设置和 DUMATE_PROXY_API_KEY。` }
    return seatFromInfo(result.info, source, base, key)
  }

  const checkHealth = async (base, key) => {
    try {
      const response = await fetchImpl(new URL("/healthz", base).toString(), {
        headers: key ? { Authorization: "Bearer " + key } : {},
        signal: AbortSignal.timeout(5000),
      })
      const info = await response.json().catch(() => ({}))
      if (!response.ok || (info?.login && info.login !== "ok")) {
        return { type: "failed", error: "反代未报告可用登录态，请先配置 DuMate Cookie" }
      }
      return seatFromInfo(info, "proxy", base, key)
    } catch (error) {
      return { type: "failed", error: "连接 " + base + " 失败：" + String(error?.message ?? error) + "；Docker 请填宿主机可达地址，并把本页代理改为直连。" }
    }
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
        models: { ...models, ...(previous.models ?? {}) },
      }
      return userConfig
    },

    provider: {
      id: PROVIDER_ID,
      async models(provider) { return provider?.models ?? models },
    },

    auth: {
      provider: PROVIDER_ID,
      single: true,
      icon: ICON,
      refreshLead: REFRESH_LEAD_MS,
      keepAlive: true,
      rotating: false,
      async refresh(previous) {
        const base = normalizeProxyBase(previous?.proxyUrl, proxyUrl)
        const key = String(previous?.proxyKey ?? proxyKey ?? "")
        try {
          const response = await fetchImpl(new URL("/v1/keepalive", base).toString(), {
            method: "POST",
            headers: key ? { Authorization: `Bearer ${key}` } : {},
            signal: AbortSignal.timeout(15_000),
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const info = await response.json()
          if (info?.login && info.login !== "ok") {
            const error = new Error("DuMate 代理登录态已失效，请重新登录")
            error.signIn = "expired"
            throw error
          }
          return renewedSeat(previous, key)
        } catch (error) {
          if (error?.signIn === "expired") throw error
          throw new Error(`刷新 DuMate 代理保活失败：${error?.message ?? error}`)
        }
      },
      methods: [
        {
          type: "oauth",
          label: "反代已配置登录态（环境变量 / Cookie 文件）",
          prompts: [proxyPrompt(proxyUrl), proxyKeyPrompt],
          authorize: async (inputs) => {
            const { base, key } = authFromInputs(inputs)
            return {
              url: "",
              instructions: `检查 ${base} 的 /healthz；登录态由反代进程持有。Docker 请填宿主机可达地址，本页代理建议选直连。`,
              method: "auto",
              opened: true,
              async callback() { return checkHealth(base, key) },
            }
          },
        },
        {
          type: "oauth",
          label: "服务器本机 DuMate 桌面端登录态（auth.json，只读复用）",
          prompts: [proxyPrompt(proxyUrl), proxyKeyPrompt],
          authorize: async (inputs) => {
            const { base, key } = authFromInputs(inputs)
            return {
              url: "",
              instructions: "从反代所在主机读取 qianfan-desktop-app/auth.json 与 .cookie-key，只读，不修改客户端文件。",
              method: "auto",
              opened: true,
              async callback() {
                const result = await postAuth(new URL("/v1/auth/desktop", base).toString(), {}, fetchImpl, key)
                if (result.failed) return { type: "failed", error: "读取桌面端登录态失败：" + result.failed }
                return seatFromInfo(result.info, "desktop", base, key)
              },
            }
          },
        },
        {
          type: "oauth",
          label: "浏览器登录：粘贴 Network 请求头 Cookie",
          prompts: [proxyPrompt(proxyUrl), proxyKeyPrompt],
          authorize: async (inputs) => {
            const { base, key } = authFromInputs(inputs)
            return {
              url: LOGIN_URL,
              instructions:
                "1. 打开上方链接登录百度账号。\n" +
                "2. 登录成功后进入 console.bce.baidu.com，按 F12 打开 DevTools → Network。\n" +
                "3. 刷新页面，点第一个请求，在 Request Headers 找到 Cookie，复制完整 value。\n" +
                "4. 把 Cookie 粘贴到下方输入框。\n" +
                "5. 第一个输入框填写反代地址：Docker 用 http://host.docker.internal:8787/v1 或宿主机 IP；本页代理选直连。",
              method: "code",
              async callback(input) { return loginWithCookie(base, key, input, "browser") },
            }
          },
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
            proxyPrompt(proxyUrl),
            proxyKeyPrompt,
          ],
          authorize: async (inputs) => {
            const { base, key } = authFromInputs(inputs)
            const raw = normalizeCookie(inputs?.cookie ?? inputs?.key)
            if (!hasRequiredCookie(raw)) return { type: "failed", error: "请粘贴包含 bce-sessionid 的完整 Cookie" }
            return {
              url: "",
              instructions: "正在验证 Cookie 并写入反代运行时登录态…",
              method: "auto",
              opened: true,
              async callback() { return loginWithCookie(base, key, raw, "manual") },
            }
          },
        },
      ],
    },

    async loader(getAuth) {
      let saved = {}
      try { saved = (await getAuth?.()) || {} } catch {}
      const base = normalizeProxyBase(saved.proxyUrl, proxyUrl)
      const key = String(saved.proxyKey ?? proxyKey ?? "")
      return {
        baseURL: base,
        apiKey: key || "dumate-proxy",
        async fetch(input, init = {}) {
          const request = input instanceof Request ? input : undefined
          let target
          try { target = new URL(request ? request.url : String(input)) }
          catch { return jsonResponse(400, { error: { message: "invalid proxy url", type: "invalid_request_error" } }) }
          if (!isAllowedTarget(target, base)) {
            return jsonResponse(400, {
              error: { message: "DuMate proxy loader 仅允许 models/chat/images 路径", type: "invalid_request_error" },
            })
          }
          const headers = new Headers(init.headers ?? request?.headers)
          headers.delete("x-api-key")
          if (key) headers.set("Authorization", `Bearer ${key}`)
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

export const _internal = { toMagpieModels, normalizeProxyBase, hasRequiredCookie }
