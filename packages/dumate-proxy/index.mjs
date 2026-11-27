import { readFileSync } from "node:fs"
import { loadConfig as defaultLoadConfig } from "./src/config.mjs"
import { loadCatalog as defaultLoadCatalog } from "./src/catalog.mjs"
import { buildCookieHeader, extractCsrfToken, parseCookieString, readDesktopLogin } from "./src/auth.mjs"
import { normalizeReasoningBody } from "./src/gateway.mjs"
import { generateImage, KNOWN_IMAGE_MODELS, selectStrongestImageModel } from "./src/media.mjs"
import {
  buildImageUpstreamBody,
  chatMessagesToPrompt,
  isImageModel,
  resolveImageModel,
  toChatCompletion,
  toChatSSE,
  toOpenAIImages,
} from "./src/image.mjs"

const PROVIDER_ID = "dumate"
const PROVIDER_NAME = "百度搭子 DuMate"
const CONSOLE_BASE = "https://console.bce.baidu.com"
const LOGIN_URL = "https://login.bce.baidu.com/?from=oa_dumate&redirect=https%3A%2F%2Fconsole.bce.baidu.com%2F"
const GATEWAY_BASE = "https://dumate-svc.baidu.com/gateway/apis/v1"
const TOKEN_TTL_MS = 60 * 60 * 1000
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) DuMate/1.0.91 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36"

const ICON = (() => {
  try {
    return `data:image/png;base64,${readFileSync(new URL("./icon.png", import.meta.url)).toString("base64")}`
  } catch {
    return ""
  }
})()

const tokenCache = new Map()

function jsonResponse(status, value, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  })
}

const cardText = (value, max = 200) => {
  const cleaned = String(value ?? "")
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")
    .trim()
  const points = Array.from(cleaned)
  return points.length > max ? points.slice(0, max).join("") : cleaned
}
function cookieHeaderOf(cookies) {
  return (Array.isArray(cookies) ? cookies : []).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
}

function signInError(auth) {
  const error = new Error(auth?.source === "desktop"
    ? "DuMate 桌面端登录态已失效，请打开百度搭子重新登录后在此重新登录"
    : "DuMate 登录态已失效，请重新登录")
  error.signIn = "expired"
  return error
}

function consoleError(payload, fallback) {
  const message = typeof payload?.message === "string" && payload.message
    ? payload.message
    : typeof payload?.error?.message === "string" && payload.error.message
      ? payload.error.message
      : fallback
  return new Error(`DuMate 接口错误: ${message}`)
}

async function consoleGet(path, cookieStr, fetchImpl) {
  const response = await fetchImpl(`${CONSOLE_BASE}${path}`, {
    headers: { Cookie: cookieStr, "User-Agent": UA, Accept: "application/json", Referer: `${CONSOLE_BASE}/` },
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  })
  if (response.status >= 300 && response.status < 400) throw signInError()
  const text = await response.text()
  let payload
  try { payload = JSON.parse(text) } catch {}
  if (!payload || typeof payload !== "object") {
    if (/登录|login|<!DOCTYPE|<html/i.test(text.slice(0, 500))) throw signInError()
    throw new Error(`DuMate console HTTP ${response.status} 非 JSON 响应`)
  }
  if (!response.ok) throw new Error(`DuMate console HTTP ${response.status}`)
  if (payload.code !== 0 || payload.success === false) throw consoleError(payload, `code=${payload.code}`)
  return payload.result
}

async function consolePost(path, body, cookies, fetchImpl) {
  const hostname = new URL(CONSOLE_BASE).hostname
  const response = await fetchImpl(`${CONSOLE_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      Origin: CONSOLE_BASE,
      Referer: `${CONSOLE_BASE}/`,
      Cookie: buildCookieHeader(cookies, hostname),
      csrftoken: extractCsrfToken(cookies, hostname),
      "User-Agent": UA,
      Accept: "application/json",
    },
    body: JSON.stringify(body ?? {}),
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  })
  if (response.status >= 300 && response.status < 400) throw signInError()
  const text = await response.text()
  let payload
  try { payload = JSON.parse(text) } catch {}
  if (!payload || typeof payload !== "object") {
    if (/登录|login|<!DOCTYPE|<html/i.test(text.slice(0, 500))) throw signInError()
    throw new Error(`DuMate console HTTP ${response.status} 非 JSON 响应`)
  }
  if (!response.ok) throw new Error(`DuMate console HTTP ${response.status}`)
  if (payload.code !== 0 || payload.success === false) throw consoleError(payload, `code=${payload.code}`)
  return payload.result
}
async function gatewayToken(cookieStr, fetchImpl) {
  const cached = tokenCache.get(cookieStr)
  if (cached && Date.now() < cached.expiresAt - 5 * 60_000) return cached.token
  let pending = tokenCache.get(`${cookieStr}\u0000pending`)
  if (!pending) {
    pending = (async () => {
      const result = await consoleGet("/api/dumate/app/token/get", cookieStr, fetchImpl)
      const token = String(result?.token ?? "")
      if (!token) throw new Error("DuMate 未返回 gateway token")
      const parsed = result?.expired_at ? Date.parse(result.expired_at) : Number.NaN
      const expiresAt = Number.isFinite(parsed) && parsed > Date.now() ? parsed : Date.now() + TOKEN_TTL_MS
      return { token, expiresAt }
    })().finally(() => tokenCache.delete(`${cookieStr}\u0000pending`))
    tokenCache.set(`${cookieStr}\u0000pending`, pending)
  }
  const next = await pending
  tokenCache.set(cookieStr, next)
  return next.token
}

async function gatewayFetch(body, cookies, fetchImpl, signal) {
  const header = cookieHeaderOf(cookies)
  const token = await gatewayToken(header, fetchImpl)
  const response = await fetchImpl(`${GATEWAY_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": UA,
    },
    body,
    redirect: "manual",
    signal: signal ?? AbortSignal.timeout(180_000),
  })
  if ((response.status >= 300 && response.status < 400) || response.status === 401) {
    tokenCache.delete(header)
    throw signInError()
  }
  if (!response.ok) {
    const text = await response.text()
    let payload
    try { payload = JSON.parse(text) } catch { payload = { error: { message: text.slice(0, 500) } } }
    throw new Error(payload?.error?.message ?? payload?.message ?? `DuMate gateway HTTP ${response.status}`)
  }
  return response
}

async function describeReferenceImages(images, userPrompt, cookies, fetchImpl) {
  const usable = (Array.isArray(images) ? images : []).filter((url) => typeof url === "string" && (url.startsWith("data:") || /^https?:\/\//i.test(url))).slice(0, 4)
  if (!usable.length) return { prompt: String(userPrompt ?? ""), imageUrls: [] }
  const parts = [
    { type: "text", text: "请详细描述这些参考图的主体、构图、服装、环境、光线和画风，输出可直接用于文生图的中文提示词。" },
    ...usable.map((url) => ({ type: "image_url", image_url: { url } })),
  ]
  try {
    const response = await gatewayFetch(JSON.stringify({ model: "glm-53-flash", messages: [{ role: "user", content: parts }] }), cookies, fetchImpl)
    const payload = await response.json()
    const description = String(payload?.choices?.[0]?.message?.content ?? "").trim().slice(0, 3000)
    return {
      prompt: description ? `${String(userPrompt ?? "").trim()}\n\n参考图描述：${description}`.trim().slice(0, 8000) : String(userPrompt ?? ""),
      imageUrls: usable.filter((url) => /^https?:\/\//i.test(url) && url.length < 8192),
    }
  } catch {
    return { prompt: String(userPrompt ?? ""), imageUrls: usable.filter((url) => /^https?:\/\//i.test(url) && url.length < 8192) }
  }
}
async function gatewayJson(body, cookies, fetchImpl, signal) {
  const response = await gatewayFetch(body, cookies, fetchImpl, signal)
  const text = await response.text()
  try { return JSON.parse(text) } catch { throw new Error("DuMate gateway 返回非 JSON 响应") }
}

function toMagpieModels(catalog) {
  const models = Object.create(null)
  const source = { ...(catalog?.models ?? {}) }
  const imageIds = Object.entries(source)
    .filter(([key, model]) => model?.kind === "image" || /^dumate-image/i.test(key))
    .map(([key]) => key)
  const strongest = selectStrongestImageModel(imageIds)
  if (!source[strongest]) {
    source[strongest] = {
      id: strongest,
      name: "DuMate Image",
      kind: "image",
      context: 200000,
      maxOutput: 32000,
      tool_call: false,
      reasoning: false,
      attachment: true,
      modalities: { input: ["text"], output: ["image"] },
    }
  }
  for (const [key, model] of Object.entries(source)) {
    const image = model.kind === "image" || /^dumate-image/i.test(key)
    if (image && key !== strongest) continue
    models[key] = {
      name: image ? "DuMate Image" : model.name,
      limit: { context: model.context, output: model.maxOutput },
      tool_call: image ? false : model.tool_call,
      reasoning: image ? false : model.reasoning,
      attachment: model.attachment,
      modalities: { input: [...model.modalities.input], output: [...model.modalities.output] },
      ...(key === "deepseek-v41-flash" && !image ? { variants: { none: {}, low: {}, high: {}, max: {} } } : {}),
    }
  }
  return models
}
function resolveCatalogModel(catalog, requested) {
  if (!requested) return undefined
  if (catalog?.models?.[requested]) return catalog.models[requested]
  if (requested === "group/image") {
    return Object.values(catalog?.models ?? {}).find((model) => model.kind === "image")
  }
  return Object.values(catalog?.models ?? {}).find((model) => model.upstreamId === requested || model.id === requested)
}

function normalizeCookie(raw) {
  return String(raw ?? "").trim().replace(/^["']+|["']+$/g, "")
}

function validatePastedCookie(raw) {
  const cookies = parseCookieString(raw)
  if (!cookies.some((cookie) => cookie.name === "bce-sessionid")) {
    throw new Error("Cookie 缺少 bce-sessionid，请复制 DevTools Network 请求头里的完整 Cookie")
  }
  return cookies
}

export const DuMateProxyPlugin = async (input = {}) => {
  const config = input.config ?? defaultLoadConfig(input.env ?? process.env)
  const catalog = input.catalog ?? defaultLoadCatalog(config)
  const fetchImpl = input.fetchImpl ?? fetch
  const models = toMagpieModels(catalog)
  const imageModelIds = Object.keys(catalog?.models ?? {}).filter((id) => catalog.models[id]?.kind === "image" || /^dumate-image/i.test(id))

  const seat = (cookies, source, info = {}) => {
    const label = String(info.displayName || info.name || info.bceAccountId || PROVIDER_NAME)
    return {
      type: "success",
      access: `cookie:${cookieHeaderOf(cookies)}`,
      refresh: "",
      expires: 0,
      source,
      accountId: label,
      uid: String(info.bceAccountId || info.accountId || ""),
      name: label,
      cookies,
    }
  }

  const validateCookie = async (raw, source) => {
    let cookies
    try {
      cookies = validatePastedCookie(normalizeCookie(raw))
    } catch (error) {
      return { type: "failed", error: error.message }
    }
    let info
    try {
      info = await consoleGet("/api/dumate/user/info", cookieHeaderOf(cookies), fetchImpl)
    } catch (error) {
      return { type: "failed", error: `Cookie 验证失败：${error?.message ?? error}` }
    }
    return seat(cookies, source, info)
  }

  return {
    config(userConfig) {
      userConfig.provider ??= {}
      const previous = userConfig.provider[PROVIDER_ID] ?? {}
      userConfig.provider[PROVIDER_ID] = {
        name: PROVIDER_NAME,
        npm: "@ai-sdk/openai-compatible",
        api: GATEWAY_BASE,
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
      single: false,
      icon: ICON,
      async refresh(auth) {
        if (auth?.source !== "desktop") return undefined
        const current = readDesktopLogin({ userDataDir: config.userDataDir })
        if (!current) return undefined
        if (cookieHeaderOf(current.cookies) === cookieHeaderOf(auth.cookies)) return undefined
        return seat(current.cookies, "desktop", current)
      },
      async usage(getAuth) {
        let auth
        try { auth = await getAuth() } catch (error) {
          return { error: cardText(error?.message) || "登录态读取失败", signIn: error?.signIn === "expired" ? "expired" : "kept" }
        }
        if (auth?.type !== "oauth" || !Array.isArray(auth.cookies) || !auth.cookies.length) {
          return { error: "没有登录信息，请先在 Magpie 登录", signIn: "kept" }
        }
        try {
          const header = cookieHeaderOf(auth.cookies)
          let overviewError = null
          const [overview, info] = await Promise.all([
            consoleGet("/api/dumate/points/quota_overview?timezone=Asia%2FShanghai&clientType=desktop&ignoreLoginBonus=true", header, fetchImpl).catch((error) => {
              overviewError = error
              return null
            }),
            consoleGet("/api/dumate/points/loginBonusInfo", header, fetchImpl).catch(() => null),
          ])
          if (!overview) throw overviewError ?? new Error("quota_overview 不可用")
          const total = parseFloat(overview.totalPoints) || 0
          const used = parseFloat(overview.usedPoints) || 0
          const packs = [...(overview.subscription ?? []), ...(overview.incremental ?? [])]
          let soonest = null
          for (const pack of packs) {
            if (pack?.status !== "active") continue
            const expMs = pack.expireDate == null ? NaN : Number(pack.expireDate) * 1000
            if (!Number.isFinite(expMs) || expMs <= 0) continue
            if (!soonest || expMs < soonest.ms) soonest = { ms: expMs, points: parseFloat(pack.totalPoints) || 0 }
          }
          return {
            plan: info && info.totalTimes ? `已签到 ${info.totalTimes} 天` : "Free",
            balance: `${(total - used).toFixed(2)} 积分`,
            windows: [
              {
                name: "Points",
                used: total > 0 ? (100 * used) / total : 0,
                display: `${used.toFixed(2)} / ${total.toFixed(2)}`,
                amount: used,
                limit: total,
                unit: "points",
                ...(soonest
                  ? { runsOutAt: new Date(soonest.ms).toISOString(), runsOut: Math.min(total - used, soonest.points) }
                  : {}),
              },
            ],
            user: auth.name || auth.accountId || "DuMate",
            signIn: "kept",
          }
        } catch (error) {
          return { error: cardText(error?.message) || "用量查询失败", signIn: error?.signIn === "expired" ? "expired" : "kept" }
        }
      },

      async checkin(getAuth) {
        let auth
        try { auth = await getAuth() } catch (error) {
          return {
            outcome: "failed",
            message: cardText(error?.message) || "登录态读取失败",
            ...(error?.signIn === "expired" ? { signIn: "expired" } : {}),
          }
        }
        if (auth?.type !== "oauth" || !Array.isArray(auth.cookies) || !auth.cookies.length) {
          return { outcome: "failed", message: "没有登录信息，请先在 Magpie 登录" }
        }
        try {
          const header = cookieHeaderOf(auth.cookies)
          let before = null
          try { before = await consoleGet("/api/dumate/points/loginBonusInfo", header, fetchImpl) }
          catch (error) { if (error?.signIn === "expired") throw error }
          if (before?.hasIssued === true) {
            return { outcome: "done", message: `今日已签到（累计 ${cardText(before.totalTimes) || "?"} 天）` }
          }
          const beforePoints = parseFloat(before?.totalPoints ?? "0") || 0
          await consolePost("/api/dumate/points/loginBonus", {}, auth.cookies, fetchImpl)
          let after = null
          try { after = await consoleGet("/api/dumate/points/loginBonusInfo", header, fetchImpl) } catch {}
          if (after?.hasIssued === true) {
            const delta = Math.max(0, Math.round((parseFloat(after.totalPoints ?? "0") || 0) - beforePoints))
            return {
              outcome: "claimed",
              ...(delta ? { credit: delta } : {}),
              message: `签到成功${delta ? ` +${delta} 积分` : ""}（累计 ${cardText(after.totalTimes) || "?"} 天）`,
            }
          }
          return { outcome: "inactive", message: "签到请求已提交，但今日积分尚未到账（稍后自动重试）" }
        } catch (error) {
          return {
            outcome: "failed",
            message: cardText(error?.message) || "签到失败",
            ...(error?.signIn === "expired" ? { signIn: "expired" } : {}),
          }
        }
      },
      methods: [
        {
          type: "oauth",
          label: "百度搭子桌面端登录态（本机 auth.json，只读复用）",
          authorize: async () => ({
            url: "",
            instructions: "直接复用本机百度搭子客户端的登录态（读取 auth.json + .cookie-key，只读，不写任何文件）。",
            method: "auto",
            async callback() {
              const login = readDesktopLogin({ userDataDir: config.userDataDir })
              if (!login) return { type: "failed", error: "未检测到本机百度搭子登录态，请改用浏览器登录或手动粘贴 Cookie。" }
              return seat(login.cookies, "desktop", login)
            },
          }),
        },
        {
          type: "oauth",
          label: "百度账号浏览器登录（无需安装百度搭子）",
          authorize: async () => ({
            url: LOGIN_URL,
            instructions:
              "1. 在浏览器打开上方链接登录百度账号。\n" +
              "2. 成功后进入 console.bce.baidu.com，按 F12 → Network，刷新页面。\n" +
              "3. 点第一个请求，在 Request Headers 找到 Cookie，复制完整 value。\n" +
              "4. 粘贴到下方输入框。不要用 document.cookie，关键字段是 httpOnly。",
            method: "code",
            async callback(input) { return validateCookie(input, "browser") },
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
              validate: (value) => {
                try { validatePastedCookie(normalizeCookie(value)); return undefined }
                catch (error) { return error.message }
              },
            },
          ],
          authorize: async (inputs) => {
            const raw = normalizeCookie(inputs?.cookie ?? inputs?.key)
            try { validatePastedCookie(raw) }
            catch (error) { return { type: "failed", error: error.message } }
            return {
              url: "",
              instructions: "正在验证 Cookie…",
              method: "auto",
              opened: true,
              async callback() { return validateCookie(raw, "manual") },
            }
          },
        },
      ],
    },

    async loader(getAuth) {
      let auth
      try { auth = await getAuth?.() } catch (error) { auth = undefined }
      if (auth?.type !== "oauth" || !Array.isArray(auth.cookies) || !auth.cookies.length) {
        return {
          baseURL: GATEWAY_BASE,
          apiKey: "dumate",
          async fetch() {
            return jsonResponse(401, { error: { message: "DuMate 未登录，请先在 Magpie 登录", type: "authentication_error" } }, { "X-Magpie-Sign-In": "expired" })
          },
        }
      }
      const cookies = auth.cookies
      const consoleHostname = new URL(CONSOLE_BASE).hostname
      const json = (status, value) => jsonResponse(status, value)

      return {
        baseURL: GATEWAY_BASE,
        apiKey: "dumate",
        async fetch(input, init = {}) {
          const request = input instanceof Request ? input : undefined
          let target
          try { target = new URL(request ? request.url : String(input)) } catch { return json(400, { error: { message: "invalid gateway url", type: "invalid_request_error" } }) }
          const path = target.pathname
          const gatewayPath = new URL(GATEWAY_BASE).pathname.replace(/\/+$/, "")

          try {
            if (path === `${gatewayPath}/chat/completions` || path.endsWith("/chat/completions")) {
              let text = init.body
              if (text === undefined && request) text = await request.clone().text()
              let body
              try { body = typeof text === "string" ? JSON.parse(text) : {} } catch { return json(400, { error: { message: "body must be JSON", type: "invalid_request_error" } }) }
              const requested = body.model || catalog.defaultChatModel
              const model = resolveCatalogModel(catalog, requested)
              if (model?.kind === "image" || isImageModel(catalog, requested)) {
                const token = await gatewayToken(cookieHeaderOf(cookies), fetchImpl)
                const generated = await generateImage({
                  prompt: body.prompt ?? chatMessagesToPrompt(body.messages),
                  model: requested,
                  n: body.n,
                  size: body.size,
                  responseFormat: "url",
                  availableModels: imageModelIds,
                }, token, fetchImpl)
                const completion = toChatCompletion({ data: generated.data }, requested, { ...body, model: requested })
                if (body.stream) return new Response(toChatSSE(completion, requested), { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } })
                return json(200, completion)
              }
              const upstreamBody = { ...body, model: model?.upstreamId || model?.id || requested }
              return await gatewayFetch(normalizeReasoningBody(JSON.stringify(upstreamBody)), cookies, fetchImpl)
            }

            if (path === `${gatewayPath}/images/generations` || path.endsWith("/images/generations")) {
              let text = init.body
              if (text === undefined && request) text = await request.clone().text()
              const body = typeof text === "string" ? JSON.parse(text) : {}
              const refs = [body.image, ...(Array.isArray(body.images) ? body.images : [])]
              const described = await describeReferenceImages(refs, body.prompt, cookies, fetchImpl)
              const token = await gatewayToken(cookieHeaderOf(cookies), fetchImpl)
              const generated = await generateImage({
                prompt: described.prompt,
                model: body.model,
                n: body.n,
                size: body.size,
                quality: body.quality,
                responseFormat: body.response_format || "url",
                imageUrls: described.imageUrls,
                availableModels: imageModelIds,
              }, token, fetchImpl)
              return json(200, { created: generated.created, data: generated.data, model: generated.model })
            }

            if (path === `${gatewayPath}/images/edits` || path.endsWith("/images/edits")) {
              let text = init.body
              if (text === undefined && request) text = await request.clone().text()
              let prompt = ""
              let images = []
              let requestedModel
              let n, size, responseFormat
              if (typeof text === "string" && text.trim().startsWith("{")) {
                const body = JSON.parse(text)
                prompt = String(body.prompt ?? "").trim()
                requestedModel = body.model
                n = body.n
                size = body.size
                responseFormat = body.response_format || "url"
                if (typeof body.image === "string") images.push(body.image)
                if (Array.isArray(body.images)) images.push(...body.images.filter((value) => typeof value === "string"))
                if (typeof body.image_url === "string") images.push(body.image_url)
              } else {
                const form = request ? await request.clone().formData() : (typeof FormData !== "undefined" && init.body instanceof FormData ? init.body : undefined)
                if (!form) return json(400, { error: { message: "缺少 multipart 表单或 JSON body", type: "invalid_request_error" } })
                prompt = String(form.get("prompt") ?? "").trim()
                requestedModel = form.get("model") || undefined
                n = form.get("n")
                size = form.get("size")
                responseFormat = form.get("response_format") || "url"
                for (const key of ["image", "image[]", "images", "image_url"]) {
                  for (const value of form.getAll(key)) {
                    if (typeof value === "string") images.push(value)
                    else if (typeof value?.arrayBuffer === "function") {
                      const buffer = Buffer.from(await value.arrayBuffer())
                      images.push(`data:${value.type || "application/octet-stream"};base64,${buffer.toString("base64")}`)
                    }
                  }
                }
              }
              if (!prompt) return json(400, { error: { message: "缺少 prompt", type: "invalid_request_error" } })
              const described = await describeReferenceImages(images, prompt, cookies, fetchImpl)
              const token = await gatewayToken(cookieHeaderOf(cookies), fetchImpl)
              const generated = await generateImage({
                prompt: described.prompt,
                model: requestedModel,
                n,
                size,
                responseFormat,
                imageUrls: described.imageUrls,
                availableModels: imageModelIds,
              }, token, fetchImpl)
              return json(200, { created: generated.created, data: generated.data, model: generated.model })
            }

            return json(404, { error: { message: `unknown endpoint ${path}`, type: "invalid_request_error" } })
          } catch (error) {
            if (error?.signIn === "expired") {
              return json(401, { error: { message: error.message, type: "authentication_error" } }, { "X-Magpie-Sign-In": "expired" })
            }
            return json(502, { error: { message: error?.message ?? String(error), type: "api_error" } }, { "X-Magpie-Sign-In": "kept" })
          }
        },
      }
    },
  }
}

export default DuMateProxyPlugin

export const _internal = { toMagpieModels, validatePastedCookie, cookieHeaderOf }
