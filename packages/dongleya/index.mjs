import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import net from "node:net"

const PROVIDER = "dongleya"
const ORIGIN = "https://dongleya.qq.com"
const CHAT_URL = `${ORIGIN}/api/v3/chat`
const MODELS_URL = `${ORIGIN}/api/models`
const CREDITS_URL = `${ORIGIN}/api/credits`
const NPM = "@ai-sdk/openai-compatible"
const SESSION_HEADER = "x-magpie-dongleya-session"
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"

const FALLBACK_MODELS = [
  ["auto", "自动选择", [], "low"],
  ["deepseek-v4.1-flash-1017", "DeepSeek V4.1 Flash", ["low", "medium", "high", "max"], "low"],
  ["deepseek-v4-pro-0813", "DeepSeek V4 Pro", ["low", "medium", "high", "max"], "low"],
  ["deepseek-v4-flash", "DeepSeek V4 Flash", ["low", "medium", "high", "max"], "low"],
  ["hy3", "混元 3", ["low", "medium", "high", "max"], "low"],
  ["hy4-preview", "混元 4 Preview", ["low", "medium", "high"], "high"],
  ["minimax-m3", "MiniMax M3", ["low", "medium", "high", "max"], "low"],
  ["kimi-k3", "Kimi K3", ["low", "medium", "high", "max"], "medium"],
  ["glm-5.3", "GLM-5.3", ["low", "high", "max"], "low"],
]

const sessions = new Map()
const modelCache = new Map()

const BROWSER_CANDIDATES =
  process.platform === "win32"
    ? [
        join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
        join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
        join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
        join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Microsoft\\Edge\\Application\\msedge.exe"),
        join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Microsoft\\Edge\\Application\\msedge.exe"),
        join(process.env.LOCALAPPDATA ?? "", "Microsoft\\Edge\\Application\\msedge.exe"),
        join(process.env.PROGRAMFILES ?? "C:\\Program Files", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
        join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
        join(process.env.LOCALAPPDATA ?? "", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
        join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Vivaldi\\Application\\vivaldi.exe"),
        join(process.env.LOCALAPPDATA ?? "", "Vivaldi\\Application\\vivaldi.exe"),
        join(process.env.LOCALAPPDATA ?? "", "Programs\\Opera\\opera.exe"),
        "chrome.exe",
        "msedge.exe",
        "brave.exe",
        "vivaldi.exe",
        "opera.exe",
      ]
    : process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
          "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Opera.app/Contents/MacOS/Opera",
        ]
      : [
          "google-chrome",
          "google-chrome-stable",
          "chromium",
          "chromium-browser",
          "microsoft-edge",
          "microsoft-edge-stable",
          "brave-browser",
          "vivaldi",
          "opera",
        ]

function cleanToken(value) {
  if (typeof value !== "string") return ""
  const token = value
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/^Bearer\s+/i, "")
    .trim()
  if (!token || /\s/.test(token)) return ""
  return token
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Origin: ORIGIN,
    Referer: `${ORIGIN}/create`,
    "User-Agent": USER_AGENT,
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function browserPath() {
  for (const candidate of BROWSER_CANDIDATES) {
    if (candidate.includes("\\") || candidate.includes("/")) {
      if (existsSync(candidate)) return candidate
    } else {
      const finder = process.platform === "win32" ? "where.exe" : "which"
      const result = spawnSync(finder, [candidate], { encoding: "utf8", windowsHide: true })
      const found = result.status === 0 ? result.stdout.split(/\r?\n/).find(Boolean)?.trim() : ""
      if (found) return found
    }
  }
  return ""
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error("找不到可用端口"))))
    })
  })
}

function tokenIsUsable(token) {
  if (typeof token !== "string" || token.length < 40) return false
  const parts = token.split(".")
  if (parts.length !== 3) return false
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
    return typeof payload.exp !== "number" || payload.exp * 1000 > Date.now() + 30_000
  } catch {
    return true
  }
}

function cdpCommand(ws, id, method, params = {}) {
  ws.send(JSON.stringify({ id, method, params }))
}

function cdpEvaluate(wsUrl, expression, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {}
      reject(new Error("读取浏览器登录状态超时"))
    }, timeoutMs)
    const finish = (error, value) => {
      clearTimeout(timer)
      try {
        ws.close()
      } catch {}
      if (error) reject(error)
      else resolve(value)
    }
    ws.addEventListener("open", () => {
      const next = ++id
      pending.set(next, true)
      cdpCommand(ws, next, "Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })
    })
    ws.addEventListener("message", (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (!pending.has(message.id)) return
      pending.delete(message.id)
      if (message.error) {
        finish(new Error(message.error.message ?? "浏览器读取失败"))
        return
      }
      finish(undefined, message.result?.result?.value)
    })
    ws.addEventListener("error", () => finish(new Error("无法连接浏览器调试端口")))
    ws.addEventListener("close", () => {
      if (pending.size) finish(new Error("浏览器调试连接已关闭"))
    })
  })
}

async function jsonAt(url, timeoutMs = 1500) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

async function closeBrowser(port) {
  try {
    const version = await jsonAt(`http://127.0.0.1:${port}/json/version`, 800)
    const ws = new WebSocket(version.webSocketDebuggerUrl)
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 800)
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ id: 1, method: "Browser.close", params: {} }))
        clearTimeout(timer)
        setTimeout(resolve, 100)
      })
      ws.addEventListener("error", () => {
        clearTimeout(timer)
        resolve()
      })
    })
    try {
      ws.close()
    } catch {}
  } catch {}
}

async function browserToken(directory, timeoutMs = 5 * 60 * 1000) {
  const executable = browserPath()
  if (!executable) {
    throw new Error(
      "没有找到 Chromium 系浏览器（Chrome、Edge、Brave、Vivaldi、Opera 或 Chromium）。请安装其中一个，或改用手动粘贴令牌。",
    )
  }
  const port = await freePort()
  const profile = join(directory || join(homedir(), ".config", "magpie"), "dongleya-browser")
  mkdirSync(profile, { recursive: true })
  const child = spawn(
    executable,
    [
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "https://dongleya.qq.com/login",
    ],
    { stdio: "ignore", windowsHide: false },
  )
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break
      try {
        const targets = await jsonAt(`http://127.0.0.1:${port}/json/list`)
        const target = targets.find(
          (item) =>
            item.type === "page" &&
            typeof item.url === "string" &&
            item.url.startsWith(`${ORIGIN}/`) &&
            typeof item.webSocketDebuggerUrl === "string",
        )
        if (target) {
          const token = await cdpEvaluate(
            target.webSocketDebuggerUrl,
            "localStorage.getItem('eureka_token')",
          )
          if (tokenIsUsable(token)) return cleanToken(token)
        }
      } catch {}
      await sleep(1000)
    }
    throw new Error("浏览器登录等待超时，请重新点击登录再试。")
  } finally {
    await closeBrowser(port)
    try {
      child.kill()
    } catch {}
  }
}

function modelOf(id, name, efforts = [], defaultEffort = "low") {
  const variants = Object.fromEntries(efforts.map((effort) => [effort, {}]))
  return {
    id,
    name,
    limit: { context: 256000, output: 32768 },
    reasoning: efforts.length > 0,
    tool_call: false,
    modalities: { input: ["text", "image"], output: ["text"] },
    variants,
    options: { defaultReasoningEffort: defaultEffort },
  }
}

function safeName(value, fallback = "dongleya-artifact") {
  return (
    String(value ?? "")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || fallback
  )
}

function collectArtifactIds(value, out = new Set(), depth = 0) {
  if (depth > 6 || value == null) return out
  if (Array.isArray(value)) {
    for (const item of value) collectArtifactIds(item, out, depth + 1)
    return out
  }
  if (typeof value !== "object") return out
  for (const [key, item] of Object.entries(value)) {
    if (key === "artifactId" && typeof item === "string" && item) out.add(item)
    else collectArtifactIds(item, out, depth + 1)
  }
  return out
}

function artifactFiles(artifact) {
  const data = artifact?.data ?? {}
  const title = safeName(artifact?.title ?? data.title, safeName(artifact?.id))
  const entry = basename(String(data.workspace?.entry ?? data.entry ?? ""))
  const html = typeof data.html === "string" ? data.html : ""
  if (html) {
    return {
      title,
      files: [
        {
          name: entry && /\.(?:html?|htm)$/i.test(entry) ? entry : `${title}.html`,
          bytes: Buffer.from(html, "utf8"),
          contentType: "text/html; charset=utf-8",
        },
      ],
    }
  }
  if (typeof data.markdown === "string") {
    return { title, files: [{ name: `${title}.md`, bytes: Buffer.from(data.markdown, "utf8") }] }
  }
  if (typeof data.source === "string") {
    const name = entry || `${title}.txt`
    return { title, files: [{ name, bytes: Buffer.from(data.source, "utf8") }] }
  }
  if (typeof data.content === "string") {
    const name = entry || `${title}.txt`
    return { title, files: [{ name, bytes: Buffer.from(data.content, "utf8") }] }
  }
  return { title, files: [] }
}

async function downloadArtifact(id, token, root, signal) {
  const response = await fetch(`${ORIGIN}/api/v3/artifacts/${encodeURIComponent(id)}?includeBody=1`, {
    headers: { ...authHeaders(token), Accept: "application/json" },
    signal: signal ?? AbortSignal.timeout(30000),
  })
  if (!response.ok) throw new Error(`下载产物失败（HTTP ${response.status}）`)
  const body = await response.json()
  const artifact = body?.artifact
  if (!artifact) throw new Error("懂了鸭没有返回产物内容")
  const { title, files } = artifactFiles(artifact)
  if (!files.length) return { id, title, files: [] }
  const dir = join(root || process.cwd(), "dongleya", title)
  await mkdir(dir, { recursive: true })
  const written = []
  for (const file of files) {
    const path = join(dir, safeName(file.name, "artifact.txt"))
    await writeFile(path, file.bytes)
    written.push({ name: file.name, path })
  }
  return { id, title, files: written }
}

async function downloadArtifacts(ids, token, root, signal) {
  const out = []
  for (const id of ids) {
    try {
      out.push(await downloadArtifact(id, token, root, signal))
    } catch (error) {
      out.push({ id, error: errorText(error), files: [] })
    }
  }
  return out
}

function artifactNote(results) {
  const lines = []
  for (const result of results) {
    if (result.error) lines.push(`- ${result.id}: 下载失败：${result.error}`)
    else if (result.files?.length) {
      for (const file of result.files) lines.push(`- [${result.title}](${file.path})`)
    }
  }
  return lines.length ? `\n\n云端产物已下载到本地：\n${lines.join("\n")}` : ""
}

function fallbackModels() {
  return Object.fromEntries(
    FALLBACK_MODELS.map(([id, name, efforts, defaultEffort]) => [
      id,
      modelOf(id, name, efforts, defaultEffort),
    ]),
  )
}

async function liveModels(token, signal) {
  if (!token) return fallbackModels()
  const cached = modelCache.get(token)
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.models
  try {
    const response = await fetch(MODELS_URL, {
      headers: { ...authHeaders(token), Accept: "application/json" },
      signal: signal ?? AbortSignal.timeout(15000),
    })
    if (!response.ok) return fallbackModels()
    const body = await response.json()
    if (!Array.isArray(body?.models)) return fallbackModels()
    const models = {}
    for (const item of body.models) {
      if (typeof item?.id !== "string" || !item.id) continue
      const efforts = Array.isArray(item.reasoningEfforts)
        ? item.reasoningEfforts.filter((effort) => typeof effort === "string")
        : []
      const label =
        item.id === "auto"
          ? "自动选择"
          : item.provider && item.provider !== "Auto"
            ? `${item.provider} · ${item.id}`
            : item.id
      models[item.id] = modelOf(
        item.id,
        label,
        efforts,
        typeof item.defaultReasoningEffort === "string"
          ? item.defaultReasoningEffort
          : efforts[0] ?? "low",
      )
    }
    if (!Object.keys(models).length) return fallbackModels()
    modelCache.set(token, { at: Date.now(), models })
    return models
  } catch {
    return fallbackModels()
  }
}

function textOf(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (typeof part === "string") return part
      if (part?.type === "text" || part?.type === "input_text") return part.text ?? ""
      if (part?.type === "tool_result") return textOf(part.content)
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

function imagesOf(messages) {
  const images = []
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue
    for (const part of message.content) {
      if (part?.type !== "image_url" && part?.type !== "input_image") continue
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url
      if (typeof url !== "string") continue
      const match = url.match(/^data:([^;,]+);base64,(.+)$/s)
      if (!match) continue
      images.push({ base64: match[2], mimeType: match[1] })
    }
  }
  return images
}

function requestParts(chat) {
  const messages = Array.isArray(chat?.messages) ? chat.messages : []
  const system = messages
    .filter((message) => message?.role === "system" || message?.role === "developer")
    .map((message) => textOf(message.content))
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 16000)
  let latest = ""
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") {
      latest = textOf(messages[index].content)
      break
    }
  }
  if (!latest) {
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index]?.role === "assistant") {
        latest = textOf(messages[index].content)
        break
      }
    }
  }
  const content = system ? `[System instructions]\n${system}\n\n[User]\n${latest}` : latest
  return { content, images: imagesOf(messages) }
}

function reasoningEffortOf(chat) {
  const effort = chat?.reasoning_effort ?? chat?.reasoningEffort
  return ["low", "medium", "high", "max", "xhigh", "none"].includes(effort) ? effort : undefined
}

function buildDongleyaRequest(chat, sessionId) {
  const { content, images } = requestParts(chat)
  const extra = { model: typeof chat?.model === "string" ? chat.model : "auto" }
  const effort = reasoningEffortOf(chat)
  if (effort) extra.reasoningEffort = effort
  const body = {
    messages: [{ role: "user", content }],
    lang: "zh",
    extra,
  }
  if (sessionId) body.sessionId = sessionId
  if (images.length) body.images = images
  return body
}

function parseSseBlock(block) {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim()
  if (!data || data === "[DONE]") return null
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

async function* sseEvents(response, signal) {
  if (!response.body) throw new Error("懂了鸭没有返回响应体")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      for (;;) {
        const match = buffer.match(/\r?\n\r?\n/)
        if (!match || match.index === undefined) break
        const block = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        const event = parseSseBlock(block)
        if (event) yield event
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) {
      const event = parseSseBlock(buffer)
      if (event) yield event
    }
  } finally {
    reader.releaseLock()
  }
}

async function* chatEvents(response, { token, sessionKey, signal }) {
  let current = response
  let sessionId = sessionFor(sessionKey)
  let resumes = 0
  for (;;) {
    let finished = false
    for await (const event of sseEvents(current, signal)) {
      if (event.type === "session-created" && event.sessionId) {
        sessionId = event.sessionId
        rememberSession(sessionKey, sessionId)
      }
      if (event.type === "finish") finished = true
      yield event
    }
    if (finished || signal?.aborted || !sessionId || resumes >= 3) return
    resumes++
    await sleep(1000)
    try {
      current = await fetch(`${CHAT_URL}/${encodeURIComponent(sessionId)}/subscribe`, {
        headers: { ...authHeaders(token), Accept: "text/event-stream" },
        signal,
      })
    } catch {
      return
    }
    if (!current.ok) return
  }
}

function mapFinish(reason) {
  if (reason === "content_filter") return "content_filter"
  return "stop"
}

function chunkBase(id, created, model) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
  }
}

function completionChunk(id, created, model, delta, finishReason = null, usage) {
  return {
    ...chunkBase(id, created, model),
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  }
}

function errorText(error) {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function openaiError(message, status = 502, code = "UPSTREAM_ERROR", type = "api_error") {
  return new Response(JSON.stringify({ error: { message, type, code } }), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function upstreamError(body, status) {
  const code = body?.codeName ?? body?.error?.code ?? body?.code ?? "UPSTREAM_ERROR"
  const message = body?.message ?? body?.error?.message ?? `懂了鸭返回 HTTP ${status}`
  return openaiError(message, status >= 400 ? status : 502, String(code), "upstream_error")
}

async function readJson(response) {
  const text = await response.text()
  try {
    return { body: JSON.parse(text), text }
  } catch {
    return { body: null, text }
  }
}

function rememberSession(key, sessionId) {
  if (!key || !sessionId) return
  sessions.set(key, { sessionId, at: Date.now() })
  if (sessions.size > 1000) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) sessions.delete(oldest[0])
  }
}

function sessionFor(key) {
  if (!key) return ""
  const entry = sessions.get(key)
  if (!entry) return ""
  if (Date.now() - entry.at > 6 * 60 * 60 * 1000) {
    sessions.delete(key)
    return ""
  }
  entry.at = Date.now()
  return entry.sessionId
}

async function dongleyaFetch(input, init, getAuth, { root, signal } = {}) {
  const auth = await getAuth()
  const token = cleanToken(auth?.key)
  if (!token) return openaiError("懂了鸭登录令牌缺失，请重新登录。", 401, "UNAUTHORIZED", "authentication_error")

  const request = input instanceof Request ? input : null
  let raw = init?.body
  if (raw === undefined && request) raw = await request.clone().text()
  if (typeof raw !== "string") return openaiError("请求体不是 JSON。", 400, "INVALID_REQUEST", "invalid_request_error")

  let chat
  try {
    chat = JSON.parse(raw)
  } catch {
    return openaiError("请求体不是合法 JSON。", 400, "INVALID_REQUEST", "invalid_request_error")
  }

  const headers = new Headers(init?.headers ?? request?.headers)
  const sessionKey = String(headers.get(SESSION_HEADER) ?? "").slice(0, 160)
  headers.delete(SESSION_HEADER)
  const serverSession = sessionFor(sessionKey)
  const body = buildDongleyaRequest(chat, serverSession)
  const upstreamSignal = init?.signal ?? request?.signal ?? signal

  let response
  try {
    response = await fetch(CHAT_URL, {
      method: "POST",
      headers: {
        ...authHeaders(token),
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal: upstreamSignal,
    })
  } catch (error) {
    if (error?.name === "AbortError") throw error
    return openaiError(`无法连接懂了鸭：${errorText(error)}`, 502, "UPSTREAM_UNAVAILABLE")
  }

  const contentType = response.headers.get("content-type") ?? ""
  if (!response.ok || contentType.includes("application/json")) {
    const { body: json, text } = await readJson(response)
    if (json) return upstreamError(json, response.status)
    return openaiError(text.slice(0, 500) || `懂了鸭返回 HTTP ${response.status}`, response.status)
  }

  const model = body.extra.model
  const id = `chatcmpl-dongleya-${crypto.randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const wantStream = chat?.stream !== false
  const artifactIds = new Set()

  if (!wantStream) {
    let content = ""
    let reasoning = ""
    let finishReason = "stop"
    let usage
    try {
      for await (const event of chatEvents(response, {
        token,
        sessionKey,
        signal: upstreamSignal,
      })) {
        collectArtifactIds(event, artifactIds)
        if (event.type === "text-delta") content += event.delta ?? ""
        else if (event.type === "reasoning-delta") reasoning += event.delta ?? ""
        else if (event.type === "finish") {
          finishReason = mapFinish(event.stopReason)
          if (event.usage) {
            usage = {
              prompt_tokens: event.usage.inputTokens ?? 0,
              completion_tokens: event.usage.outputTokens ?? 0,
              total_tokens:
                (event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0),
            }
          }
        } else if (event.type === "error") {
          return openaiError(event.message ?? "懂了鸭生成失败", 502, event.code ?? "UPSTREAM_ERROR")
        }
      }
    } catch (error) {
      if (error?.name === "AbortError") throw error
      return openaiError(errorText(error), 502, "UPSTREAM_ERROR")
    }
    const downloaded = await downloadArtifacts(artifactIds, token, root, upstreamSignal)
    content += artifactNote(downloaded)
    return new Response(
      JSON.stringify({
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content,
              ...(reasoning ? { reasoning_content: reasoning } : {}),
            },
            finish_reason: finishReason,
          },
        ],
        ...(usage ? { usage } : {}),
      }),
      { headers: { "Content-Type": "application/json" } },
    )
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (value) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
      let finishReason = "stop"
      let usage
      let finished = false
      send(completionChunk(id, created, model, { role: "assistant", content: "" }))
      try {
        for await (const event of chatEvents(response, {
          token,
          sessionKey,
          signal: upstreamSignal,
        })) {
          collectArtifactIds(event, artifactIds)
          if (event.type === "text-delta" && event.delta) {
            send(completionChunk(id, created, model, { content: event.delta }))
          } else if (event.type === "reasoning-delta" && event.delta) {
            send(
              completionChunk(id, created, model, {
                reasoning_content: event.delta,
                reasoning: event.delta,
              }),
            )
          } else if (event.type === "finish") {
            finishReason = mapFinish(event.stopReason)
            if (event.usage) {
              usage = {
                prompt_tokens: event.usage.inputTokens ?? 0,
                completion_tokens: event.usage.outputTokens ?? 0,
                total_tokens:
                  (event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0),
              }
            }
          } else if (event.type === "error") {
            send({ error: { message: event.message ?? "懂了鸭生成失败", code: event.code ?? "UPSTREAM_ERROR" } })
            finished = true
            break
          }
        }
        const downloaded = await downloadArtifacts(artifactIds, token, root, upstreamSignal)
        const note = artifactNote(downloaded)
        if (note) send(completionChunk(id, created, model, { content: note }))
      } catch (error) {
        if (error?.name !== "AbortError") {
          send({ error: { message: errorText(error), code: "UPSTREAM_ERROR" } })
        }
      } finally {
        if (!finished) send(completionChunk(id, created, model, {}, finishReason, usage))
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  })
}

function makePlugin() {
  return async ({ client, directory, worktree }) => ({
    config: async (config) => {
      config.provider ??= {}
      config.provider[PROVIDER] ??= {}
      const provider = config.provider[PROVIDER]
      provider.name ??= "懂了鸭"
      provider.npm ??= NPM
      provider.api ??= `${ORIGIN}/api`
      provider.models = { ...fallbackModels(), ...(provider.models ?? {}) }
    },

    "chat.headers": async (input, output) => {
      const provider = input?.model?.providerID ?? input?.provider?.info?.id
      if (provider !== PROVIDER || !input?.sessionID) return
      output.headers[SESSION_HEADER] = String(input.sessionID).slice(0, 160)
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        const token = cleanToken(auth?.key)
        if (!token) return provider.models
        const models = await liveModels(token)
        return Object.keys(models).length ? models : provider.models
      },
    },

    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: "api",
          label: "懂了鸭登录令牌（eureka_token）",
          placeholder: "eyJhbGci…",
        },
        {
          type: "oauth",
          label: "懂了鸭账号（浏览器自动登录）",
          authorize() {
            const capture = browserToken(directory)
            return {
              url: "",
              opened: true,
              method: "auto",
              instructions: "在弹出的独立浏览器窗口里登录懂了鸭；登录成功后会自动保存凭证并关闭窗口。",
              async callback() {
                try {
                  return { type: "success", key: await capture }
                } catch (error) {
                  return { type: "failed", error: errorText(error) }
                }
              },
            }
          },
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api") return {}
        const token = cleanToken(auth.key)
        return {
          baseURL: `${ORIGIN}/api`,
          apiKey: token,
          async fetch(input, init) {
            return dongleyaFetch(input, init, getAuth, {
              root: worktree || directory || process.cwd(),
              signal: init?.signal,
            })
          },
        }
      },
      async usage(getAuth) {
        const auth = await getAuth()
        const token = cleanToken(auth?.key)
        if (!token) return { error: "未登录", windows: [], signIn: "kept" }
        try {
          const response = await fetch(CREDITS_URL, {
            headers: { ...authHeaders(token), Accept: "application/json" },
            signal: AbortSignal.timeout(15000),
          })
          if (!response.ok) return { error: `懂了鸭返回 HTTP ${response.status}`, windows: [], signIn: "kept" }
          const body = await response.json()
          const data = body?.data ?? {}
          const balance = Number(data.balance)
          const used = Number(data.totalUsed)
          const gifted = Number(data.totalGifted)
          const limit = gifted > 0 ? gifted : balance + used
          return {
            plan: "懂了鸭",
            balance: Number.isFinite(balance) ? `${balance.toFixed(2)} credits` : undefined,
            windows:
              Number.isFinite(limit) && limit > 0
                ? [
                    {
                      name: "Creation credits",
                      amount: Number.isFinite(used) ? used : undefined,
                      limit,
                      unit: "credits",
                      used: Number.isFinite(used) ? (used / limit) * 100 : undefined,
                      display: Number.isFinite(balance)
                        ? `${balance.toFixed(2)} / ${limit.toFixed(2)} credits`
                        : undefined,
                    },
                  ]
                : [],
            user: "懂了鸭账号",
            signIn: "kept",
          }
        } catch (error) {
          return { error: errorText(error), windows: [], signIn: "kept" }
        }
      },
    },
  })
}

export const DongleyaAuthPlugin = makePlugin()

export const _internal = {
  PROVIDER,
  CHAT_URL,
  SESSION_HEADER,
  cleanToken,
  buildDongleyaRequest,
  requestParts,
  parseSseBlock,
  mapFinish,
  completionChunk,
  fallbackModels,
  sessions,
  sessionFor,
  rememberSession,
  browserPath,
  tokenIsUsable,
  browserToken,
  collectArtifactIds,
  artifactFiles,
  downloadArtifact,
  artifactNote,
}
