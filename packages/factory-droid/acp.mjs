import { spawn } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { createHash, randomUUID } from "node:crypto"
import { receiveToolCalls } from "./mailbox.mjs"

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url)))
const clientInfo = { name: pkg.name, version: pkg.version }
const mcpScript = fileURLToPath(new URL("./mcp-server.mjs", import.meta.url))
const closing = new Map()

export function workspaceReleased(dir) {
  return closing.get(join(tmpdir(), dir)) ?? Promise.resolve()
}

export function failure(status, message) {
  return Object.assign(new Error(message), { status })
}

// ACP select options may group their values under display headings.
export function configOption(options, category) {
  const selectable = (options ?? []).filter(o => o?.id && (!o.type || o.type === "select"))
  return selectable.find(o => o.category === category) ?? selectable.find(o => o.id === category)
}

export function optionValues(option) {
  return (option?.options ?? []).flatMap(item => {
    if (!item || item.disabled) return []
    if (Array.isArray(item.options)) return optionValues(item)
    return typeof item.value === "string" && item.value ? [item] : []
  })
}

// Hash the key or a local credential generation. Never read credential files.
export function accountScope(key) {
  const home = process.env.FACTORY_HOME_OVERRIDE || homedir()
  const apiKey = key || process.env.FACTORY_API_KEY
  let identity = apiKey
  if (!apiKey) {
    const stamps = []
    for (const name of ["auth.v2.loginkeychain", "auth.v2.keyring", "auth.v2.file"]) {
      try {
        const st = statSync(join(home, ".factory", name))
        if (st.isFile()) stamps.push([name, st.ino, st.size, st.ctimeMs, st.mtimeMs])
      } catch {}
    }
    if (!stamps.length) return undefined
    identity = stamps
  }
  return createHash("sha256").update(JSON.stringify([home, identity])).digest("hex")
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== "ESRCH" }
}

function restoreDirectory(cwd, server) {
  try { mkdirSync(cwd, { mode: 0o700 }); return } catch (error) {
    if (error.code !== "EEXIST") throw error
  }
  const owner = JSON.parse(readFileSync(join(cwd, "owner.json"), "utf8"))
  if (owner.server !== server || alive(owner.host) || alive(owner.child)) throw failure(409, "Droid workspace is still in use.")
  // A crashed host left a private mailbox behind. Start the resumed server
  // with an empty directory so it cannot deliver an old tool invocation.
  const orphan = cwd + "." + randomUUID()
  renameSync(cwd, orphan)
  try { mkdirSync(cwd, { mode: 0o700 }) } finally { rmSync(orphan, { recursive: true, force: true }) }
}

export function connect({ key, signal, tools = [], restore, builtin, onUpdate = () => {}, onCall }) {
  signal?.throwIfAborted()
  if (builtin && !["WebSearch", "GenerateImage"].includes(builtin)) throw failure(400, "Unknown native Droid tool.")
  const cwd = restore ? join(tmpdir(), restore.dir) : mkdtempSync(join(tmpdir(), "magpie-factory-droid-"))
  // A running owner can still be using this workspace. Never overwrite it.
  if (restore) restoreDirectory(cwd, restore.server)
  const settings = join(cwd, ".factory", "settings.json")
  const serverName = restore?.server ?? "mp" + randomUUID().slice(0, 8)
  const bridgeNames = new Set(tools.flatMap(t => [serverName + "___" + t.name, "mcp__" + serverName + "__" + t.name]))
  let child
  try {
    mkdirSync(join(cwd, ".factory"))
    const matcher = builtin ? `^(?!${builtin}$|ToolSearch$).*` :
      tools.length ? `^(?!ToolSearch$|${serverName}___|mcp__${serverName}__).*` : "*"
    const guards = [{ matcher, hooks: [{ type: "command", command: "exit 2", onFailure: "block" }] }]
    if (builtin === "GenerateImage") {
      const script = fileURLToPath(new URL("./image-guard.mjs", import.meta.url))
      guards.push({ matcher: "GenerateImage", hooks: [{ type: "command", command: process.execPath,
        args: [script, join(cwd, "references.json")], onFailure: "block" }] })
    }
    writeFileSync(settings, JSON.stringify({
      blockOnMcpLoad: true,
      sessionDefaultSettings: { interactionMode: "auto", autonomyLevel: "off" },
      // Only discovery and this session's relay can run inside Droid.
      hooks: { hooksDisabled: false, PreToolUse: guards },
    }))
    if (tools.length) writeFileSync(join(cwd, "tools.json"), JSON.stringify(tools))
    child = spawn(process.env.FACTORY_DROID_BIN || "droid", ["exec", "--output-format", "acp", "--settings", settings, ...(builtin ? ["--only-tools", builtin] : [])], {
      cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: key ? { ...process.env, FACTORY_API_KEY: key } : process.env,
    })
    if (child.pid) writeFileSync(join(cwd, "owner.json"), JSON.stringify({ server: serverName, host: process.pid, child: child.pid }), { mode: 0o600 })
  } catch (error) {
    child?.kill()
    rmSync(cwd, { recursive: true, force: true })
    throw error
  }
  const pending = new Map()
  let ended, sessionId, supportsClose, released, waitingForTools = false, nextId = 0
  let mailbox
  const write = (message) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n")
  const settle = (id, err, result) => {
    const { resolve, reject, timer } = pending.get(id)
    pending.delete(id)
    clearTimeout(timer)
    if (err) reject(err)
    else resolve(result)
  }
  const abort = () => close(signal.reason)
  function close(reason = new Error("Droid connection closed")) {
    if (ended) return
    ended = reason
    closing.set(cwd, new Promise(resolve => { released = resolve }))
    mailbox?.close()
    signal?.removeEventListener("abort", abort)
    const interrupt = [...pending.values()].some(p => p.method === "session/prompt")
    for (const id of pending.keys()) settle(id, reason)
    if (!child.stdin.destroyed && child.stdin.writable) {
      if (sessionId && interrupt) write({ method: "session/cancel", params: { sessionId } })
      if (sessionId && supportsClose) write({ method: "session/close", id: ++nextId, params: { sessionId } })
      child.stdin.end()
    }
    if (child.exitCode === null && child.signalCode === null) {
      const kill = setTimeout(() => child.kill("SIGKILL"), 1000)
      kill.unref()
      child.once("close", () => clearTimeout(kill))
    }
  }
  signal?.addEventListener("abort", abort, { once: true })
  // Drain diagnostics. They may contain local paths, prompts or credentials.
  child.stderr.resume()
  child.on("error", (err) => close(failure(503, err.code === "ENOENT" ? "Droid CLI not found. Install droid or set FACTORY_DROID_BIN." : err.message)))
  child.stdin.on("error", (err) => close(err))
  child.once("close", (code) => {
    close(failure(502, `Droid exited before completing the ACP request (exit ${code}).`))
    try { rmSync(cwd, { recursive: true, force: true, maxRetries: 3 }) }
    finally { closing.delete(cwd); released() }
  })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  lines.on("line", (line) => {
    if (ended || !line.trim()) return
    try {
      const msg = JSON.parse(line)
      if (msg.method && msg.id != null) {
        if (msg.method === "session/request_permission") {
          const params = msg.params
          const allow = params?.sessionId === sessionId && (bridgeNames.has(params.toolCall?.name) || builtin && params.toolCall?.name === builtin)
            && params.options?.find(option => option.kind === "allow_once")
          write({ id: msg.id, result: { outcome: allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" } } })
        }
        else write({ id: msg.id, error: { code: -32601, message: "Unsupported client method" } })
      } else if (msg.method === "session/update" && sessionId && msg.params?.sessionId === sessionId) {
        onUpdate(msg.params.update)
      } else if (pending.has(msg.id)) {
        const err = msg.error
        settle(msg.id, err && Object.assign(failure(err.code === -32000 ? 401 : err.code === -32602 ? 400 : 502,
          err.data?.details || err.message || "Droid ACP request failed"), { rpcCode: err.code }), msg.result)
      }
    } catch (error) { close(error) }
  })
  function request(method, params, timeout = 30_000) {
    if (ended) return Promise.reject(ended)
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const start = () => setTimeout(() => close(failure(504, `Droid timed out during ${method}.`)), timeout)
      pending.set(id, { method, resolve, reject, start, timer: method === "session/prompt" && waitingForTools ? undefined : start() })
      write({ id, method, params })
    })
  }
  return {
    close, request, serverName, cwd,
    waitForTools(wait) {
      if (waitingForTools === wait) return
      waitingForTools = wait
      for (const p of pending.values()) {
        if (p.method !== "session/prompt") continue
        clearTimeout(p.timer)
        p.timer = wait ? undefined : p.start()
      }
    },
    get ended() { return !!ended },
    async initialize() {
      const result = await request("initialize", { protocolVersion: 1, clientInfo, clientCapabilities: {} })
      if (result?.protocolVersion !== 1) throw failure(502, "Droid does not support ACP version 1.")
      supportsClose = !!result.agentCapabilities?.sessionCapabilities?.close
      return result.agentCapabilities || {}
    },
    async newSession() {
      if (tools.length) mailbox = receiveToolCalls(cwd, onCall, close)
      const mcpServers = tools.length ? [{ name: serverName, command: process.execPath, args: [mcpScript, join(cwd, "tools.json")], env: [] }] : []
      const session = restore
        ? await request("session/resume", { cwd, mcpServers, sessionId: restore.id })
        : await request("session/new", { cwd, mcpServers })
      sessionId = restore?.id ?? session?.sessionId
      if (!sessionId) throw failure(502, "Droid returned no ACP session ID.")
      return { ...session, sessionId }
    },
  }
}
