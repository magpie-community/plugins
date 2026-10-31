// A manual settings-page probe: no dialogue and never a record endpoint.
const MAX_BYTES = 16 * 1024
const reserved = new Set(["v1", "api", "admin", "health", "mcp", "memory-mcp", "memory-admin", "guide-dog"])
class Failure extends Error {
  constructor(code) { super(code); this.code = code }
}
const texts = {
  en: {
    confirm: "Test the saved Aelios connection? This sends empty messages and creates no dialogue records.",
    scope: "Explicit identities are checked once each. Automatic selection only checks the connection; it cannot verify all model mappings.",
    run: "Test connection", back: "Back to settings", testing: "Testing…", failed: "Connection failed",
    connected: "Connection and explicit identity permissions verified", connection_only: "Connection verified; model mappings were not checked",
    unauthorized: "API key rejected or missing", forbidden: "Identity permission denied", endpoint404: "Hook endpoint not found",
    timeout: "Test timed out", invalid: "Invalid settings or response", unavailable: "Service unavailable", checked: "Identities checked", noService: "The local test service did not answer.",
  },
  zh: {
    confirm: "测试已保存的 Aelios 连接？测试只发送空消息，不会创建对话记录。",
    scope: "每个明确指定的身份只检查一次。自动选择身份时只检查连接，无法验证所有模型映射。",
    run: "测试连接", back: "返回设置", testing: "正在测试…", failed: "连接失败",
    connected: "连接和指定身份权限已验证", connection_only: "连接已验证；未检查模型映射",
    unauthorized: "API 密钥缺失或被拒绝", forbidden: "没有身份访问权限", endpoint404: "未找到 Hook 接口",
    timeout: "测试超时", invalid: "设置或响应无效", unavailable: "服务不可用", checked: "已检查身份数", noService: "本地测试服务没有响应。",
  },
}
export function textsFor(lang) { return texts[lang] ?? texts.en }

// Display-only metadata, read through the same local service as the probe.
// An older Worker may not offer this endpoint; it must not break recall.
export async function readIdentities(raw = {}, fetcher = globalThis.fetch, timeoutMs = 5000, env = process.env) {
  const controller = new AbortController()
  let timer
  try {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 9000) throw new Failure('invalid')
    const o = settings(raw, env)
    const work = async () => {
      const response = await fetcher(new URL('v1/hook/identities', o.server), {
        method: 'GET', redirect: 'error', signal: controller.signal,
        headers: { Authorization: /^bearer\s/i.test(o.apiKey) ? o.apiKey : `Bearer ${o.apiKey}` },
      })
      if (response.status !== 200) {
        response.body?.cancel().catch(() => {})
        return { available: false, code: response.status === 404 ? 'unsupported' : 'unavailable' }
      }
      const data = await readJSON(response, controller.signal)
      if (!data || !Array.isArray(data.identities) || data.identities.length > 256) throw new Failure('invalid')
      const identities = data.identities.map(item => {
        if (!item || typeof item.slug !== 'string' || item.slug.length > 128 ||
            typeof item.name !== 'string' || item.name.length > 512 ||
            !Array.isArray(item.mainModels) || item.mainModels.length > 256 ||
            !item.mainModels.every(model => typeof model === 'string' && model.length <= 512)) throw new Failure('invalid')
        return { slug: item.slug, name: item.name, mainModels: item.mainModels }
      })
      return { available: true, identities }
    }
    return await Promise.race([work(), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Failure('timeout')) }, timeoutMs)
    })])
  } catch { return { available: false, code: controller.signal.aborted ? 'timeout' : 'unavailable' } }
  finally { clearTimeout(timer) }
}

function settings(raw, env) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Failure("invalid")
  const text = (value) => {
    if (value === undefined || value === null || value === "") return undefined
    if (typeof value !== "string" || !value.trim()) throw new Failure("invalid")
    return value.trim()
  }
  let server
  try { server = new URL(text(raw.serverUrl)) } catch { throw new Failure("invalid") }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(server.hostname)
  if (server.username || server.password || server.search || server.hash ||
      !(server.protocol === "https:" || (server.protocol === "http:" && local))) throw new Failure("invalid")
  server.pathname = server.pathname.replace(/\/+$/, "") + "/"
  const apiKeyEnv = text(raw.apiKeyEnv) ?? "AELIOS_API_KEY"
  const apiKey = text(raw.apiKey) ?? text(env[apiKeyEnv])
  if (!apiKey) throw new Failure("unauthorized")
  if (/[\r\n]/.test(apiKey)) throw new Failure("invalid")
  const identity = text(raw.identity)
  if (identity && identity.length > 128) throw new Failure("invalid")
  const identities = new Set()
  if (raw.routes !== undefined) {
    if (!Array.isArray(raw.routes) || raw.routes.length > 64) throw new Failure("invalid")
    for (const route of raw.routes) {
      if (!route || typeof route !== "object" || Array.isArray(route) ||
          typeof route.identity !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(route.identity) ||
          reserved.has(route.identity.toLowerCase())) throw new Failure("invalid")
      let selectors = false
      for (const name of ["models", "agents"]) {
        if (route[name] === undefined) continue
        if (!Array.isArray(route[name]) || !route[name].length || !route[name].every(value =>
          typeof value === "string" && value.trim() && (name !== "models" || value.length <= 200))) throw new Failure("invalid")
        selectors = true
      }
      if (!selectors) throw new Failure("invalid")
      identities.add(route.identity)
    }
  }
  if (identity) identities.add(identity)
  return { server, apiKey, identities: [...identities] }
}

async function readJSON(response, signal) {
  const reader = response.body?.getReader()
  if (!reader) throw new Failure("invalid")
  const chunks = []
  let size = 0
  const cancel = () => { reader.cancel().catch(() => {}) }
  signal.addEventListener("abort", cancel, { once: true })
  try {
    if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new Failure("invalid")
    for (;;) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) throw new Failure("invalid")
      chunks.push(value)
    }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) }
    catch { throw new Failure("invalid") }
  } finally {
    signal.removeEventListener("abort", cancel)
    cancel()
    reader.releaseLock()
  }
}

// One deadline bounds the entire test, including streaming the response and all
// identities. The race also bounds fetch mocks/transports that ignore abort.
export async function testConnection(raw = {}, fetcher = globalThis.fetch, timeoutMs = 5000, env = process.env) {
  const started = Date.now()
  let checkedIdentities = 0
  let timer
  const controller = new AbortController()
  const result = (ok, code) => ({ ok, code, checkedIdentities, ms: Date.now() - started })
  try {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 9000) throw new Failure("invalid")
    const o = settings(raw, env)
    const work = async () => {
      for (const identity of o.identities.length ? o.identities : [undefined]) {
        controller.signal.throwIfAborted()
        const body = { protocol: "chat", model: "magpie-aelios-connection-probe", body: { messages: [] }, record: false }
        if (identity) body.identity = identity
        const response = await fetcher(new URL("v1/hook/recall", o.server), {
          method: "POST", redirect: "error", signal: controller.signal,
          headers: { "content-type": "application/json", Authorization: /^bearer\s/i.test(o.apiKey) ? o.apiKey : `Bearer ${o.apiKey}` },
          body: JSON.stringify(body),
        })
        if (controller.signal.aborted) { response.body?.cancel().catch(() => {}); throw new Failure("timeout") }
        if (response.status !== 200) {
          response.body?.cancel().catch(() => {})
          throw new Failure(({ 401: "unauthorized", 403: "forbidden", 404: "endpoint404" })[response.status] ?? (response.status >= 500 || response.status === 429 ? "unavailable" : "invalid"))
        }
        const data = await readJSON(response, controller.signal)
        if (!data || !["off", "skipped"].includes(data.memory) || data.patch !== "" || data.recall_id !== null || data.remember !== "none") throw new Failure("invalid")
        checkedIdentities++
      }
      return result(true, o.identities.length ? "connected" : "connection_only")
    }
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Failure("timeout")) }, timeoutMs)
    })
    return await Promise.race([work(), deadline])
  } catch (error) {
    return result(false, controller.signal.aborted ? "timeout" : error instanceof Failure ? error.code : "unavailable")
  } finally { clearTimeout(timer) }
}
