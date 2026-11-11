// magpie-agy 插件的受控加载夹具（仅供仓内 test-catalog / test-usage-settlement /
// test-repeat-batch 使用）。源自 configs 仓 scripts/continuity/tests/agy_bridge_testkit.mjs。
//
// 用 vm.SourceTextModule 在当前上下文里加载**真实**仓内 index.mjs，相对的 ./usage.mjs、
// ./platform.mjs、./login.mjs 与 ./re2-pattern.mjs 链接到同目录的真实文件；生产文件只读，不落盘任何副本。
// 边界替身：
//   - node:child_process 的 spawn：`agy models` 与 `agy acp` 都换成进程内假子进程，
//     后者讲真实 ACP JSON-RPC（initialize / session/new / set_model / prompt / cancel）。
//     index.mjs 与 platform.mjs（spawnAgy）共用同一个假 spawn。
//   - node:net 的 createServer：控制通道换成进程内假 socket，假 agy 经它走真实
//     handleControlConnection → acceptMcpCall 发起 MCP 工具调用（并行调用可同步投递）。
//   - node:os 的 homedir/tmpdir 与 process.env：全部指向本实例的临时目录。
//   - Date 与 setTimeout 系列：模块顶部插入一行 import 遮蔽全局名，Date 由受控时钟
//     驱动（不真睡 5 分钟），定时器照常真实计时但被登记，便于检查有没有挂住退出。
// 需要观察内部状态时只在内存副本末尾追加测试导出（Turn、allProcs），不改生产导出。
// 运行要求：node --experimental-vm-modules。

import vm from "node:vm"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { EventEmitter } from "node:events"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"

const require = createRequire(import.meta.url)

export const REPO_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
// AGY_BRIDGE_TEST_INDEX 只用于反向验证（让同一套用例跑修复前的旧副本，确认能抓到旧缺陷）。
export const INDEX_FILE = process.env.AGY_BRIDGE_TEST_INDEX || path.join(REPO_DIR, "index.mjs")
export const USAGE_FILE = path.join(REPO_DIR, "usage.mjs")
export const PLATFORM_FILE = path.join(REPO_DIR, "platform.mjs")
export const LOGIN_FILE = path.join(REPO_DIR, "login.mjs")
export const RE2_PATTERN_FILE = path.join(REPO_DIR, "re2-pattern.mjs")
export const MESSAGES_URL = "agy://local/v1/messages"
export const COUNT_TOKENS_URL = "agy://local/v1/messages/count_tokens"
export const CATALOG_TTL_MS = 5 * 60 * 1000

const RUNTIME_SPECIFIER = "agy-testkit:runtime"
const RUNTIME_NAMES = ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "process"]
const RUNTIME_PRELUDE = `import { ${RUNTIME_NAMES.join(", ")} } from ${JSON.stringify(RUNTIME_SPECIFIER)};\n`
const TEST_EXPORTS = "\nexport { Turn as __agyTestTurn, allProcs as __agyTestAllProcs, pool as __agyTestPool, " +
  "execOnce as __agyTestExecOnce, findAgy as __agyTestFindAgy, canonicalBody as __agyTestCanonicalBody, " +
  "conversationKey as __agyTestConversationKey, renderInitialPromptParts as __agyTestRenderInitialPromptParts };\n"
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/

if (typeof vm.SourceTextModule !== "function" || typeof vm.SyntheticModule !== "function") {
  // Keep the documented plain `node test_*.mjs` entry point usable too.
  const child = spawnSync(process.execPath, [...process.execArgv, "--experimental-vm-modules", ...process.argv.slice(1)], { stdio: "inherit" })
  if (child.error) throw child.error
  process.exit(child.status ?? 1)
}
process.setMaxListeners(Math.max(process.getMaxListeners(), 200))

let instanceSerial = 0

export const tick = () => new Promise((resolve) => setImmediate(resolve))
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function modelsOutput(rows) {
  return rows.map(([id, name]) => `${id}  ${name}`).join("\n") + "\n"
}

// 与 index.mjs 里 FALLBACK_MODELS 同形状的 agy models 输出，外加只在动态目录里出现的型号。
export const BASE_MODEL_ROWS = [
  ["gemini-4-argon-high", "Gemini 4 Argon (High)"],
  ["gemini-4-argon-medium", "Gemini 4 Argon (Medium)"],
  ["gemini-4-argon-low", "Gemini 4 Argon (Low)"],
  ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
  ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
  ["claude-opus-5-5-high", "Claude Opus 5.5 (High)"],
  ["claude-opus-5-5-low", "Claude Opus 5.5 (Low)"],
  ["claude-sonnet-5-5-high", "Claude Sonnet 5.5 (High)"],
  ["claude-sonnet-5-5-low", "Claude Sonnet 5.5 (Low)"],
  ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
]

// ---------------------------------------------------------------- 受控时钟与定时器

function createClock(start) {
  const RealDate = Date
  const state = { now: start }
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length) super(...args)
      else super(state.now)
    }
    static now() { return state.now }
  }
  return {
    Date: FakeDate,
    now: () => state.now,
    advance(ms) { state.now += ms },
  }
}

function createTimers() {
  const live = new Set()
  return {
    setTimeout(fn, ms, ...args) {
      const handle = globalThis.setTimeout((...inner) => { live.delete(handle); fn(...inner) }, ms, ...args)
      live.add(handle)
      return handle
    },
    clearTimeout(handle) {
      live.delete(handle)
      globalThis.clearTimeout(handle)
    },
    setInterval(fn, ms, ...args) {
      const handle = globalThis.setInterval(fn, ms, ...args)
      live.add(handle)
      return handle
    },
    clearInterval(handle) {
      live.delete(handle)
      globalThis.clearInterval(handle)
    },
    // 仍然持有事件循环引用、会挂住进程退出的模块定时器。
    refed() { return [...live].filter((handle) => typeof handle.hasRef !== "function" || handle.hasRef()) },
  }
}

// ---------------------------------------------------------------- 假子进程

class FakeStream extends EventEmitter {
  setEncoding() { return this }
}

class FakeChild extends EventEmitter {
  constructor(kit, file, args) {
    super()
    this.kit = kit
    this.file = file
    this.args = args
    this.pid = undefined
    this.exitCode = null
    this.signalCode = null
    this.closed = false
    this.stdout = new FakeStream()
    this.stderr = new FakeStream()
    this.stdin = {
      writable: true,
      write: (chunk) => { this.onStdin?.(String(chunk)); return true },
      end: () => { this.stdin.writable = false },
      on: () => this.stdin,
      once: () => this.stdin,
    }
    kit.children.add(this)
  }

  finish(code, signal = null) {
    if (this.closed) return
    this.closed = true
    this.exitCode = code
    this.signalCode = signal
    this.stdin.writable = false
    this.kit.children.delete(this)
    setImmediate(() => this.emit("close", code, signal))
  }

  kill(signal = "SIGTERM") {
    this.onKill?.(signal)
    this.finish(null, signal)
    return true
  }
}

function spawnModels(kit, file, args) {
  kit.modelsSpawns.push({ file, at: kit.clock.now() })
  const raw = typeof kit.modelsBehavior === "function"
    ? kit.modelsBehavior({ file, count: kit.modelsSpawns.length })
    : kit.modelsBehavior
  const behavior = raw || { hang: true }
  if (behavior.throwSync) throw Object.assign(new Error("spawn EACCES (test)"), { code: "EACCES" })
  if (behavior.brokenChild) return { stdout: null, stderr: null, on() {}, kill() {} }
  const child = new FakeChild(kit, file, args)
  const deliver = () => {
    if (child.closed) return
    if (behavior.error) {
      child.closed = true
      kit.children.delete(child)
      child.emit("error", Object.assign(new Error("spawn agy ENOENT (test)"), { code: "ENOENT" }))
      return
    }
    if (behavior.killed) {
      child.finish(null, "SIGKILL")
      return
    }
    if (behavior.stdout) child.stdout.emit("data", behavior.stdout)
    child.finish(behavior.code ?? 0)
  }
  if (!behavior.hang) {
    if (behavior.delayMs) setTimeout(deliver, behavior.delayMs)
    else setImmediate(deliver)
  }
  return child
}

// 进程内的假 agy：讲 ACP JSON-RPC，工具调用经真实控制通道处理函数进入补丁。
class FakeAgy {
  constructor(kit, child, opts) {
    this.kit = kit
    this.child = child
    this.env = opts?.env || {}
    this.token = this.env.AGY_BRIDGE_TOKEN
    this.sessionId = null
    this.buffer = ""
    this.cancelWaiters = []
    this.cancelPending = false
    child.onStdin = (chunk) => this.onStdin(chunk)
    child.onKill = () => {
      for (const waiter of this.cancelWaiters.splice(0)) waiter()
    }
  }

  onStdin(chunk) {
    this.buffer += chunk
    for (;;) {
      const newline = this.buffer.indexOf("\n")
      if (newline < 0) return
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line)
      if (typeof message.method === "string") this.onMessage(message)
    }
  }

  send(message) {
    if (this.child.closed) return
    this.child.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n")
  }

  respond(id, result) { this.send({ id, result }) }

  onMessage(message) {
    const { id, method, params } = message
    this.kit.acpLog.push({ method, params, sessionId: this.sessionId })
    if (method === "initialize") {
      this.respond(id, { protocolVersion: 1, agentInfo: { name: "fake-agy", version: this.kit.agentVersion }, agentCapabilities: {} })
    } else if (method === "session/new" && this.kit.sessionNewError) {
      // Real agy 1.5.3 not signed in: {"code":-32000,"message":"Authentication required"}.
      this.send({ id, error: this.kit.sessionNewError })
    } else if (method === "session/new") {
      this.sessionId = `fake-session-${++this.kit.sessionSerial}`
      // Only the bridge's own processes carry a control token; the catalog's
      // model probe runs agy without one, as real agy does without --ide-mcp-port.
      if (this.token) this.control({ kind: "list" })
      const models = { currentModelId: this.kit.initialAgyModel }
      // What agy offers this client in the session; unset, the session names none.
      if (this.kit.offeredModels) models.availableModels = this.kit.offeredModels.map(([modelId, name]) => ({ modelId, name }))
      this.respond(id, { sessionId: this.sessionId, models })
    } else if (method === "session/set_model") {
      this.kit.setModels.push(params.modelId)
      this.respond(id, {})
    } else if (method === "session/prompt") {
      this.runPrompt(id, params)
    } else if (method === "session/cancel") {
      // 取消可能先于脚本进入等待到达，记下来，避免丢失。
      this.cancelPending = true
      for (const waiter of this.cancelWaiters.splice(0)) waiter()
    } else if (id !== undefined) {
      this.send({ id, error: { code: -32601, message: `fake agy does not serve ${method}` } })
    }
  }

  async runPrompt(id, params) {
    const index = this.kit.promptSerial++
    this.cancelPending = false
    const handler = this.kit.prompts[index] ?? this.kit.defaultPrompt
    if (typeof handler !== "function") {
      this.send({ id, error: { code: -32603, message: `fake agy has no script for prompt #${index + 1}` } })
      return
    }
    const agent = this.agentApi(params, index)
    try {
      const result = await handler(agent)
      await tick()
      this.respond(id, result ?? { stopReason: "end_turn" })
    } catch (error) {
      this.send({ id, error: { code: -32603, message: String(error?.message ?? error) } })
    }
  }

  update(update) {
    this.send({ method: "session/update", params: { sessionId: this.sessionId, update } })
  }

  control(message) {
    const socket = new FakeSocket()
    this.kit.controlHandler(socket)
    socket.emit("data", JSON.stringify({ token: this.token, ...message }) + "\n")
    return socket.reply
  }

  agentApi(params, index) {
    const self = this
    return {
      index,
      prompt: params.prompt,
      sessionId: this.sessionId,
      async text(text) { self.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }); await tick() },
      async thought(text) { self.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } }); await tick() },
      // 同一批调用在同一个同步块里投递，等价于 agy 并行发起；返回各自的 MCP 回包。
      tools(calls) {
        const replies = calls.map(([name, args]) => self.control({ kind: "call", name, arguments: args }))
        return Promise.all(replies)
      },
      async toolsAcrossTicks(calls) {
        const replies = []
        for (const [name, args] of calls) {
          await tick()
          replies.push(self.control({ kind: "call", name, arguments: args }))
        }
        return Promise.all(replies)
      },
      async tool(name, args) { return (await this.tools([[name, args]]))[0] },
      waitCancel() {
        if (self.cancelPending) return Promise.resolve()
        return new Promise((resolve) => self.cancelWaiters.push(resolve))
      },
    }
  }
}

class FakeSocket extends EventEmitter {
  constructor() {
    super()
    this.writable = true
    this.closed = false
    this.written = ""
    this.reply = new Promise((resolve) => { this.resolveReply = resolve })
  }

  setEncoding() { return this }
  write(data) { this.written += data; return true }

  end(data) {
    if (data) this.written += data
    this.writable = false
    const line = this.written.split("\n").find((item) => item.trim())
    this.resolveReply(line ? JSON.parse(line) : null)
    this.close()
  }

  destroy() {
    this.writable = false
    this.resolveReply(null)
    this.close()
  }

  close() {
    if (this.closed) return
    this.closed = true
    setImmediate(() => this.emit("close"))
  }
}

// ---------------------------------------------------------------- 模块装载

function builtinModule(name, overrides) {
  const real = require(name)
  const exported = overrides ? { ...real, ...overrides } : real
  const names = [...new Set([...Object.keys(exported).filter((key) => IDENTIFIER_RE.test(key)), "default"])]
  return new vm.SyntheticModule(names, function init() {
    for (const key of names) this.setExport(key, key === "default" ? exported : exported[key])
  }, { identifier: `${name}?agy-testkit` })
}

function sourceModule(file, extraSource, url, transform) {
  const original = fs.readFileSync(file, "utf8")
  const source = RUNTIME_PRELUDE + (transform ? transform(original) : original) + (extraSource || "")
  return new vm.SourceTextModule(source, {
    identifier: `${pathToFileURL(file).href}?agy-testkit=${++instanceSerial}`,
    initializeImportMeta(meta) { meta.url = url },
  })
}

/**
 * 新建一个隔离的补丁模块实例。每个实例有自己的模块级状态（目录缓存、进程池）、
 * 自己的临时目录、受控时钟与假 agy。用完必须 await kit.dispose()。
 */
export async function createBridgeKit(options = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-bridge-test-"))
  const home = path.join(tmp, "home")
  const bin = path.join(tmp, "empty-bin")
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(bin, { recursive: true })
  const clock = createClock(options.clockStart ?? Date.UTC(2026, 10, 4, 12, 0, 0))
  const timers = createTimers()
  const kit = {
    tmp,
    home,
    clock,
    timers,
    children: new Set(),
    modelsSpawns: [],
    acpSpawns: [],
    modelsBehavior: options.modelsBehavior ?? { stdout: modelsOutput(BASE_MODEL_ROWS) },
    prompts: [],
    promptSerial: 0,
    defaultPrompt: null,
    sessionSerial: 0,
    initialAgyModel: options.initialAgyModel ?? "gemini-3.8-flash-low",
    offeredModels: options.offeredModels ?? null,
    sessionNewError: options.sessionNewError ?? null,
    agentVersion: options.agentVersion ?? "1.5.0",
    setModels: [],
    acpLog: [],
    controlHandler: null,
    turns: [],
    env: null,
    module: null,
  }
  kit.agyPath = makeFakeAgy(tmp, "agy-a")
  kit.makeFakeAgy = (name) => makeFakeAgy(tmp, name)
  kit.env = {
    PATH: bin,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: path.join(tmp, "localappdata"),
    XDG_STATE_HOME: path.join(tmp, "state"),
    AGY_PATH: options.agyPath === undefined ? kit.agyPath : options.agyPath,
    ...(options.env || {}),
  }
  for (const [key, value] of Object.entries(kit.env)) {
    if (value === undefined || value === null) delete kit.env[key]
  }
  const fakeProcess = new Proxy(process, {
    get(target, property) {
      if (property === "env") return kit.env
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  const spawn = (file, args = [], opts = {}) => {
    if (args[0] === "models") return spawnModels(kit, file, args)
    if (args[0] === "acp") {
      const child = new FakeChild(kit, file, args)
      kit.acpSpawns.push({ file, args, env: opts.env })
      new FakeAgy(kit, child, opts)
      return child
    }
    const child = new FakeChild(kit, file, args)
    child.finish(0)
    return child
  }
  const fakeServer = {
    once() { return fakeServer },
    on() { return fakeServer },
    listen(_port, _host, callback) { setImmediate(callback); return fakeServer },
    unref() { return fakeServer },
    close() {},
    address() { return { address: "127.0.0.1", family: "IPv4", port: 45999 } },
  }
  const overrides = {
    "node:child_process": { spawn },
    "node:net": {
      createServer(handler) {
        kit.controlHandler = handler
        return fakeServer
      },
    },
    "node:os": { homedir: () => home, tmpdir: () => tmp },
  }
  const runtime = new vm.SyntheticModule(RUNTIME_NAMES, function init() {
    this.setExport("Date", clock.Date)
    this.setExport("setTimeout", timers.setTimeout)
    this.setExport("clearTimeout", timers.clearTimeout)
    this.setExport("setInterval", timers.setInterval)
    this.setExport("clearInterval", timers.clearInterval)
    this.setExport("process", fakeProcess)
  }, { identifier: RUNTIME_SPECIFIER })
  const cache = new Map([[RUNTIME_SPECIFIER, runtime]])
  const indexUrl = pathToFileURL(path.join(REPO_DIR, "index.mjs")).href
  const usageUrl = pathToFileURL(USAGE_FILE).href
  const platformUrl = pathToFileURL(PLATFORM_FILE).href
  const loginUrl = pathToFileURL(LOGIN_FILE).href
  const re2Url = pathToFileURL(RE2_PATTERN_FILE).href
  const linker = (specifier) => {
    const key = specifier.startsWith("node:") || specifier.startsWith("./") || specifier === RUNTIME_SPECIFIER
      ? specifier
      : `node:${specifier}`
    if (cache.has(key)) return cache.get(key)
    let module
    if (key === "./usage.mjs") module = sourceModule(USAGE_FILE, "", usageUrl)
    else if (key === "./platform.mjs") module = sourceModule(PLATFORM_FILE, "", platformUrl)
    else if (key === "./login.mjs") module = sourceModule(LOGIN_FILE, "", loginUrl)
    else if (key === "./re2-pattern.mjs") module = sourceModule(RE2_PATTERN_FILE, "", re2Url)
    else if (key.startsWith("node:")) module = builtinModule(key, overrides[key])
    else throw new Error(`testkit: 未登记的依赖 ${specifier}`)
    cache.set(key, module)
    return module
  }
  const root = sourceModule(options.indexPath || INDEX_FILE, TEST_EXPORTS, indexUrl, options.indexTransform)
  await root.link(linker)
  await root.evaluate()
  const ns = root.namespace
  kit.module = ns
  // 只做观察：记下每个真实 Turn 实例，便于核对原始 ACP 累计对象，不改其行为。
  const Turn = ns.__agyTestTurn
  const originalRegister = Turn.prototype.registerResponse
  Turn.prototype.registerResponse = function registerResponseSpy(...args) {
    if (!kit.turns.includes(this)) kit.turns.push(this)
    return originalRegister.apply(this, args)
  }
  kit.plugin = await ns.AntigravityBridgePlugin()
  kit.loaded = await kit.plugin.auth.loader()

  kit.models = () => kit.plugin.provider.models()
  kit.fetch = (url, init) => kit.loaded.fetch(url, init)
  kit.request = (body, init = {}) => kit.fetch(MESSAGES_URL, { method: "POST", body: JSON.stringify(body), ...init })
  kit.countTokens = async (body) => {
    const response = await kit.fetch(COUNT_TOKENS_URL, { method: "POST", body: JSON.stringify(body) })
    if (response.status !== 200) throw new Error(`count_tokens ${response.status}: ${await response.text()}`)
    return (await response.json()).input_tokens
  }
  kit.finishChildren = async () => {
    for (const child of [...kit.children]) child.kill("SIGKILL")
    await tick()
    await tick()
  }
  kit.dispose = async () => {
    Turn.prototype.registerResponse = originalRegister
    for (const proc of [...(ns.__agyTestAllProcs || [])]) {
      await proc.stop().catch(() => {})
    }
    await kit.finishChildren()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  return kit
}

function makeFakeAgy(tmp, name) {
  const dir = path.join(tmp, "agy-bin", name)
  fs.mkdirSync(dir, { recursive: true })
  // Windows discovery (platform.mjs agyCandidates) only considers agy.exe/.cmd/.bat;
  // the fake spawn never executes the file, so its content does not matter.
  const file = path.join(dir, process.platform === "win32" ? "agy.exe" : "agy")
  fs.writeFileSync(file, "#!/bin/sh\nexit 99\n", { mode: 0o755 })
  return file
}

// ---------------------------------------------------------------- 客户端侧

/** 解析一次 SSE 响应：内容块、最终 usage、stop_reason 与原始事件。 */
export async function readSse(response) {
  if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  const text = await response.text()
  const events = []
  for (const frame of text.split("\n\n")) {
    if (!frame.trim()) continue
    let event = ""
    let data = ""
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim()
      else if (line.startsWith("data:")) data += line.slice(5).trim()
    }
    if (data) events.push({ event, data: JSON.parse(data) })
  }
  const blocks = new Map()
  const content = []
  let usage = null
  let stopReason = null
  let model = null
  let error = null
  for (const { event, data } of events) {
    if (event === "message_start") model = data.message?.model ?? null
    else if (event === "content_block_start") blocks.set(data.index, { ...data.content_block, json: "" })
    else if (event === "content_block_delta") {
      const block = blocks.get(data.index)
      if (data.delta.type === "text_delta") block.text += data.delta.text
      else if (data.delta.type === "thinking_delta") block.thinking += data.delta.thinking
      else if (data.delta.type === "signature_delta") block.signature = data.delta.signature
      else if (data.delta.type === "input_json_delta") block.json += data.delta.partial_json
    } else if (event === "content_block_stop") {
      const block = blocks.get(data.index)
      blocks.delete(data.index)
      if (block.type === "tool_use") block.input = block.json ? JSON.parse(block.json) : {}
      delete block.json
      content.push(block)
    } else if (event === "message_delta") {
      usage = data.usage ?? null
      stopReason = data.delta?.stop_reason ?? null
    } else if (event === "error") {
      error = data.error
    }
  }
  return { events, content, usage, stopReason, model, error }
}

/** stream:false 的 JSON 响应，整理成与 readSse 相同的形状。 */
export async function readJson(response) {
  if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  const message = await response.json()
  return { content: message.content, usage: message.usage, stopReason: message.stop_reason, model: message.model, error: null }
}

export function usageTotal(usage) {
  return usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
}

/** 把一次响应接成下一轮请求：追加 assistant 原样内容与对应的 tool_result。 */
export function continueWithToolResults(body, parsed, resultFor = (block, index) => `result ${index} for ${block.name}`) {
  const toolUses = parsed.content.filter((block) => block.type === "tool_use")
  const assistant = parsed.content.map((block) => block.type === "tool_use"
    ? { type: "tool_use", id: block.id, name: block.name, input: block.input }
    : block.type === "thinking"
      ? { type: "thinking", thinking: block.thinking, signature: block.signature }
      : { type: "text", text: block.text })
  return {
    ...body,
    messages: [
      ...body.messages,
      { role: "assistant", content: assistant },
      {
        role: "user",
        content: toolUses.map((block, index) => ({
          type: "tool_result",
          tool_use_id: block.id,
          content: resultFor(block, index),
        })),
      },
    ],
  }
}

export const READ_TOOL = {
  name: "Read",
  description: "Read a file from the local filesystem.",
  input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
}

export function baseBody(overrides = {}) {
  return {
    model: "agy-cli/gemini-4-argon[1m]",
    max_tokens: 4096,
    stream: true,
    system: "You are a test agent.",
    messages: [{ role: "user", content: "start the task" }],
    tools: [READ_TOOL],
    ...overrides,
  }
}

/** 调整 system 长度，使真实 estimateInputTokens(body)（经 count_tokens 入口）等于目标值。 */
export async function padBodyToTokens(kit, body, target) {
  const base = await kit.countTokens({ ...body, system: "" })
  if (base >= target) throw new Error(`夹具基础体积 ${base} 已超过目标 ${target}`)
  const unit = "context padding line for the agy bridge usage fixture. "
  const needed = (target - base) * 4
  const system = unit.repeat(Math.ceil(needed / unit.length)).slice(0, needed)
  const padded = { ...body, system }
  const actual = await kit.countTokens(padded)
  if (actual !== target) throw new Error(`夹具估算 ${actual} 未命中目标 ${target}`)
  return padded
}
