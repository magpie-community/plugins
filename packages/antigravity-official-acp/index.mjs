import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { spawn } from "node:child_process"

const ID = "antigravity-official-acp"
const DEFAULT_MODEL = process.env.MAGPIE_ANTIGRAVITY_MODEL || "gemini-4-argon"
const ACP_VERSION = "0.1.0"

function fail(message, cause) {
  const e = new Error(message)
  if (cause) e.cause = cause
  return e
}

function file(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) throw fail(`${label} does not exist: ${path}`)
  return path
}

function findRuntime() {
  if (process.env.MAGPIE_ANTIGRAVITY_ACP_BIN) {
    const bin = file(resolve(process.env.MAGPIE_ANTIGRAVITY_ACP_BIN), "Antigravity ACP executable")
    return { bin, args: bin.endsWith("/agy") || bin.endsWith("/agy.exe") ? ["acp"] : [], home: process.env.MAGPIE_ANTIGRAVITY_HOME || process.env.GEMINI_HOME || join(homedir(), ".gemini") }
  }
  const native = join(homedir(), ".local", "bin", "agy")
  if (existsSync(native)) return { bin: file(native, "official Antigravity CLI"), args: ["acp"], home: join(homedir(), ".gemini") }
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    const candidate = join(dir, process.platform === "win32" ? "agy.exe" : "agy")
    if (existsSync(candidate)) return { bin: file(candidate, "official Antigravity CLI"), args: ["acp"], home: process.env.GEMINI_HOME || join(homedir(), ".gemini") }
  }
  throw fail("official Antigravity CLI `agy` was not found; install it or set MAGPIE_ANTIGRAVITY_ACP_BIN")
}

function findBinary() { return findRuntime().bin }

const MODEL_SUFFIXES = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "none"])

function model(id = DEFAULT_MODEL, name = id, efforts = []) {
  return {
    id,
    name,
    npm: "@ai-sdk/openai-compatible",
    url: "http://antigravity-acp.invalid/v1",
    apiId: id,
    context: 1048576,
    input: 1048576,
    output: 65535,
    reasoning: true,
    image: true,
    variants: Object.fromEntries(efforts.map((effort) => [effort, { reasoningEffort: effort }])),
    inputs: ["text", "image"],
    outputs: ["text"],
  }
}

function groupedModels(entries) {
  const groups = new Map()
  for (const entry of entries) {
    const match = /^(.*)-(minimal|low|medium|high|xhigh|max|none)$/.exec(entry.modelId)
    const key = match && MODEL_SUFFIXES.has(match[2]) ? match[1] : entry.modelId
    const group = groups.get(key) ?? []
    group.push({ ...entry, effort: match?.[2] ?? "" })
    groups.set(key, group)
  }
  const out = []
  for (const [id, group] of groups) {
    const efforts = [...new Set(group.map((entry) => entry.effort).filter(Boolean))]
    if (efforts.length >= 2) {
      const name = group.find((entry) => entry.name && !/\((?:minimal|low|medium|high|xhigh|max|none)\)$/i.test(entry.name))?.name
        ?? group[0].name.replace(/\s*\((?:minimal|low|medium|high|xhigh|max|none)\)$/i, "")
      out.push(model(id, name, efforts))
    } else {
      const entry = group[0]
      out.push(model(entry.modelId, entry.name || entry.modelId))
    }
  }
  return out
}

function effortOf(request) {
  const value = request.reasoning_effort ?? request.reasoningEffort ?? request.variant
  return typeof value === "string" && MODEL_SUFFIXES.has(value) ? value : ""
}

function wireModel(requestModel, effort, availableModels) {
  const asked = String(requestModel || DEFAULT_MODEL).split("/").slice(-1)[0]
  if (availableModels.includes(asked)) return asked
  const candidates = availableModels.filter((id) => id.startsWith(`${asked}-`))
  if (!candidates.length) throw fail(`official Antigravity ACP does not advertise model ${asked}`)
  const selected = effort ? candidates.find((id) => id.endsWith(`-${effort}`)) : candidates.find((id) => id.endsWith("-medium"))
  return selected || candidates[0]
}

async function discoverModels() {
  const acp = rpcClient({ cwd: process.cwd() })
  try {
    await acp.call("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "magpie-antigravity-acp-model-list", version: ACP_VERSION } })
    acp.notify("initialized", {})
    const session = await acp.call("session/new", { cwd: process.cwd(), mcpServers: [] })
    const models = groupedModels(session?.models?.availableModels ?? [])
    if (!models.length) throw fail("official Antigravity ACP session returned no available models")
    return models
  } finally {
    acp.stop()
  }
}

function bodyOf(input, init = {}) {
  const body = init.body ?? (input instanceof Request ? undefined : null)
  if (body == null) throw fail("Antigravity ACP request has no JSON body")
  return JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body))
}

function textOf(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) throw fail("Antigravity ACP supports text messages only in this adapter")
  return content.map((part) => {
    if (part?.type === "text" && typeof part.text === "string") return part.text
    throw fail(`unsupported message content part: ${JSON.stringify(part?.type)}`)
  }).join("")
}

function promptOf(messages) {
  if (!Array.isArray(messages) || messages.length === 0) throw fail("Antigravity ACP request requires messages")
  return messages.map((m) => {
    if (!m || typeof m.role !== "string") throw fail("message has no role")
    const text = textOf(m.content)
    return `${m.role}: ${text}`
  }).join("\n\n")
}

function rpcClient({ cwd, signal, onNotification }) {
  const runtime = findRuntime()
  const env = { ...process.env, GEMINI_HOME: runtime.home, MAGPIE_ANTIGRAVITY_ACP: "1", ALL_PROXY: "", all_proxy: "" }
  const child = spawn(runtime.bin, runtime.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] })
  let nextId = 1
  let buffer = ""
  const pending = new Map()
  let ended = false
  const stop = () => { if (!ended) { ended = true; child.kill("SIGTERM") } }
  signal?.addEventListener("abort", stop, { once: true })
  child.on("error", (e) => { for (const p of pending.values()) p.reject(fail("failed to start Antigravity ACP", e)); pending.clear() })
  child.on("exit", (code, sig) => { ended = true; const e = fail(`Antigravity ACP exited before completing the request (code=${code}, signal=${sig})`); for (const p of pending.values()) p.reject(e); pending.clear() })
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk) => {
    buffer += chunk
    while (buffer.includes("\n")) {
      const i = buffer.indexOf("\n"); const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch (e) { for (const p of pending.values()) p.reject(fail(`Antigravity ACP emitted invalid JSON: ${line.slice(0, 200)}`, e)); pending.clear(); stop(); return }
      if (message.id != null && pending.has(message.id)) { const p = pending.get(message.id); pending.delete(message.id); message.error ? p.reject(fail(`Antigravity ACP ${p.method} failed: ${message.error.message || JSON.stringify(message.error)}`)) : p.resolve(message.result) }
      else if (message.method) onNotification?.(message)
    }
  })
  const call = (method, params) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject, method }); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); })
  const notify = (method, params) => { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`) }
  return { call, notify, stop }
}

async function generate(request, signal) {
  const cwd = request.cwd || process.cwd()
  let answer = ""
  const acp = rpcClient({ cwd, signal, onNotification(message) {
    if (message.method !== "session/update") return
    const update = message.params?.update ?? message.params
    const content = update?.content
    if (update?.sessionUpdate === "agent_message_chunk" && content?.type === "text") answer += content.text || ""
  } })
  try {
    await acp.call("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "magpie-antigravity-acp", version: ACP_VERSION } })
    acp.notify("initialized", {})
    const session = await acp.call("session/new", { cwd, mcpServers: [] })
    const availableModels = (session?.models?.availableModels ?? []).map((entry) => entry.modelId).filter(Boolean)
    const effort = effortOf(request)
    const modelId = wireModel(request.model, effort, availableModels)
    if (process.env.MAGPIE_ANTIGRAVITY_DEBUG === "1") console.error(`[antigravity-acp] ${request.model || DEFAULT_MODEL} effort=${effort || "default"} -> ${modelId}`)
    const option = session?.configOptions?.find?.((x) => x.configId === "model" || x.id === "model" || x.category === "model")
    if (option) await acp.call("session/set_config_option", { sessionId: session.sessionId, configId: option.configId || option.id, value: modelId })
    await acp.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: promptOf(request.messages) }] })
    const text = answer
    if (!text) throw fail("Antigravity ACP returned no text")
    return { id: `chatcmpl-${crypto.randomUUID()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: request.model || `${ID}/${DEFAULT_MODEL}`, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }
  } finally { acp.stop() }
}

function streamOf(completion) {
  const choice = completion.choices[0]
  const chunks = [
    { id: completion.id, object: "chat.completion.chunk", created: completion.created, model: completion.model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    { id: completion.id, object: "chat.completion.chunk", created: completion.created, model: completion.model, choices: [{ index: 0, delta: { content: choice.message.content }, finish_reason: null }] },
    { id: completion.id, object: "chat.completion.chunk", created: completion.created, model: completion.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"
}

export async function AntigravityAcpPlugin() {
  return {
    auth: {
      provider: ID,
      methods: [{ type: "api", keyless: true, label: "Official Antigravity CLI ACP runtime (Google sign-in is managed by agy)", placeholder: "official-acp", async authorize() { return { type: "success", key: "official-acp" } } }],
      async loader(getAuth) {
        const auth = await getAuth()
        if (!(auth?.type === "api" && auth.key) && auth?.type !== "oauth") return {}
        return { baseURL: "http://antigravity-acp.invalid/v1", apiKey: "official-acp", async fetch(input, init = {}) { const request = bodyOf(input, init); const completion = await generate(request, init.signal); return new Response(streamOf(completion), { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } }) } }
      }
    },
    async config(config) {
      config.provider ??= {}
      const old = config.provider[ID] ?? {}
      config.provider[ID] = { name: "Antigravity Official ACP", npm: "@ai-sdk/openai-compatible", api: "http://antigravity-acp.invalid/v1", ...old, models: { ...(old.models ?? {}), [DEFAULT_MODEL]: model(DEFAULT_MODEL, "Gemini 4 Argon", ["low", "medium", "high"]) } }
    },
    provider: {
      id: ID,
      async models(provider) {
        const listed = await discoverModels()
        return Object.fromEntries(listed.map((entry) => [entry.id, entry]))
      },
    }
  }
}

export const _internal = { findBinary, findRuntime, discoverModels, promptOf, model, generate, wireModel }
