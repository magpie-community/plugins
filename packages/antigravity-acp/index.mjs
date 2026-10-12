// Google Antigravity through its official ACP server, as an OpenCode (v1)
// provider plugin for magpie.
//
// Antigravity's ACP server (agy_acp_server.par, dl.google.com) is the agent
// runtime the Antigravity IDE speaks. It owns the Google sign-in itself, and
// decides alone where it keeps it (an install with the IDE signed in may
// carry no token file at all), so the plugin stores a marker, never a token,
// and reads the sign-in's health from the server's own answers: a session
// can be made signed-out, but only a real credential gets a prompt through.
// One Google sign-in is shared by every account of this provider.
//
// A request arrives as the model's OpenAI Chat body (the models are on
// @ai-sdk/openai-compatible). The plugin turns it into one ACP session:
// the history rides as an embedded markdown context, the latest user text
// and images ride as prompt blocks. The request's tools are served to the
// agent as an MCP bridge on loopback; a call there becomes the reply's
// tool_calls and ends the turn, the way a chat client expects. Antigravity's
// own tools stay on a short leash: permission requests are answered
// "cancelled", so nothing runs on this machine but what the client's agent
// asked for.
//
// The server is found, first to last: AGY_ACP_BIN, the managed install at
// ~/.local/opt/agy-acp/current, ~/.local/bin/agy_acp_server.par, PATH; when
// none is there, the release pinned in runtime-manifest.json is downloaded,
// checked against its SHA-256 and sizes, and validated over ACP before use.
import { spawn, execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PROVIDER = "antigravity-acp"
// never contacted: every request is answered by the loader's fetch below
const API_BASE = "https://antigravity-acp.invalid/v1"
// the sign-in this plugin keeps: the ACP server holds the real tokens
const MANAGED = "managed-by-the-acp-server"
const PROTOCOL_VERSION = 1
const INIT_TIMEOUT = 30_000
const AUTH_TIMEOUT = 3 * 60_000
const AUTH_RELAY_TIMEOUT = 10 * 60_000
const OP_TIMEOUT = 120_000
// the install lock goes stale after INSTALL_TIMEOUT + 5 min (see withInstallLock); the waiter waits as long
const INSTALL_TIMEOUT = 30 * 60_000
const PROMPT_TIMEOUT = 10 * 60_000
const MAX_FRAME = 32 << 20
const STDERR_MAX = 16 << 10
const RECONSTRUCTION_MAX = 400_000
const MAX_TOOLS = 64
const SCHEMA_MAX = 64 << 10
// chromium writes this on stdout during browser sign-in; it isn't ACP
const BROWSER_NOISE = /opening in existing browser session/i

const MANIFEST = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "runtime-manifest.json"), "utf8"))

// homeDir is where the Antigravity sign-in and the managed runtime live
// (~/.gemini, ~/.local); AGY_ACP_HOME moves them all, for tests and sandboxes.
const homeDir = () => process.env.AGY_ACP_HOME || os.homedir()
const authDir = () => process.env.AGY_ACP_AUTH_DIR || path.join(homeDir(), ".gemini", "antigravity-acp")
const runtimeRoot = () => process.env.AGY_ACP_RUNTIME_ROOT || path.join(homeDir(), ".local", "opt", "agy-acp")

// what the plugin runs with, set when magpie loads it
const ctx = { client: null }

const note = (message) => { try { ctx.client?.app?.log?.({ service: "antigravity-acp", level: "info", message }) } catch {} }
const toast = (message, variant = "info") => { try { ctx.client?.tui?.showToast?.({ title: "Antigravity (ACP)", message, variant }) } catch {} }

const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")) } catch { return null } }

const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
const executable = (p) => {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile() } catch { return false }
}

// ---- the ACP server's command --------------------------------------------------

const binaryName = () => (process.platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par")

// directOrWrapper: a .par that starts with a shebang is a wrapper script and
// takes no arguments; a native one wants the server's empty --uid on Linux.
function launchArgs(command) {
  if (process.platform === "win32") return []
  try {
    const fd = fs.openSync(command, "r")
    const bytes = Buffer.alloc(2)
    const n = fs.readSync(fd, bytes, 0, 2, 0)
    fs.closeSync(fd)
    if (bytes.subarray(0, n).toString("utf8") === "#!") return []
  } catch {}
  return process.platform === "linux" ? ["--uid="] : []
}

// resolveLaunch is where a server already on this machine is, first to last:
// AGY_ACP_BIN, the managed current release, ~/.local/bin, PATH.
function resolveLaunch() {
  const env = process.env.AGY_ACP_BIN?.trim()
  if (env) {
    const tilde = env.match(/^~([\/\\])(.*)$/)
    const p = tilde ? path.join(homeDir(), tilde[2]) : env
    if (executable(p)) return { command: p, args: launchArgs(p), source: "env" }
  }
  const managed = path.join(runtimeRoot(), "current", binaryName())
  if (executable(managed)) return { command: managed, args: launchArgs(managed), source: "managed" }
  const userBin = path.join(homeDir(), ".local", "bin", "agy_acp_server.par")
  if (executable(userBin)) return { command: userBin, args: launchArgs(userBin), source: "user-bin" }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue
    const p = path.join(dir, binaryName())
    if (executable(p)) return { command: p, args: launchArgs(p), source: "path" }
  }
  return null
}

function platformKey() {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch
  if (process.platform === "darwin") return `darwin-${arch}`
  if (process.platform === "linux") return `linux-${arch}`
  if (process.platform === "win32") return `windows-${arch}`
  throw new Error(`Google publishes no Antigravity ACP build for ${process.platform}/${process.arch}`)
}

const runFile = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 10 * 60_000 }, (e, stdout, stderr) =>
      e ? reject(Object.assign(e, { stderr: String(stderr ?? "").slice(0, 400) })) : resolve(String(stdout)))
  })

// children tracks every process the plugin started, so a graceful exit takes
// them along; a killed magpie leaves the pid file for the next start to reap.
const children = new Set()
function track(child) {
  children.add(child)
  child.once("close", () => children.delete(child))
}
process.on("exit", () => {
  for (const c of children) { try { c.kill("SIGKILL") } catch {} }
  // this host's own pid file goes with it; other hosts' stay for their next start
  try { fs.rmSync(pidFile(), { force: true }) } catch {}
})

// ---- installing the managed runtime --------------------------------------------

function isInstalled(dir, asset) {
  return [asset.binaryName, asset.harnessName].every((name) => {
    try { return fs.statSync(path.join(dir, name)).size === asset[`${name === asset.binaryName ? "binaryBytes" : "harnessBytes"}`] } catch { return false }
  })
}

function pointCurrentAt(destination) {
  const current = path.join(runtimeRoot(), "current")
  fs.rmSync(current, { force: true, recursive: true })
  fs.symlinkSync(destination, current, process.platform === "win32" ? "junction" : "dir")
}

let installLock = null
async function withInstallLock(fn) {
  const dir = path.join(runtimeRoot(), ".install-lock")
  // a second installer waits for as long as the first may hold the lock —
  // a slow download isn't a stuck one
  const wait = INSTALL_TIMEOUT + 5 * 60_000
  const end = Date.now() + wait
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 })
  for (;;) {
    try { fs.mkdirSync(dir); break } catch (e) {
      if (e?.code !== "EEXIST") throw e
      let born = 0
      try { born = fs.statSync(dir).mtimeMs } catch {}
      // a lock left by a dead process is taken back, but only after longer
      // than the download it guards can run: a slow first install never has
      // its lock taken while it is still working
      if (Date.now() - born > wait) { try { fs.rmdirSync(dir) } catch {} }
      if (Date.now() > end) throw new Error(`another Antigravity ACP install has been running for over ${Math.round(wait / 60_000)} minutes`)
      await sleep(1000)
    }
  }
  installLock = dir
  try { return await fn() } finally { installLock = null; try { fs.rmdirSync(dir) } catch {} }
}

async function ensureRuntime() {
  const found = resolveLaunch()
  if (found) return found
  toast("The Antigravity ACP server isn't installed; downloading it (a large download)…")
  await withInstallLock(async () => {
    if (resolveLaunch()) return
    await installLatest()
  })
  const made = resolveLaunch()
  if (!made) throw new Error("the Antigravity ACP server didn't install; set AGY_ACP_BIN to an agy_acp_server.par of your own")
  return made
}

async function installLatest() {
  const key = platformKey()
  const release = MANIFEST.releases[MANIFEST.releases.length - 1]
  const asset = release.platforms[key]
  if (!asset) throw new Error(`the pinned Antigravity ACP ${release.version} has no build for ${key}`)
  const root = runtimeRoot()
  const versions = path.join(root, "versions")
  fs.mkdirSync(versions, { recursive: true, mode: 0o700 })
  const destination = path.join(versions, asset.archiveSha256.slice(0, 16))
  if (isInstalled(destination, asset)) return pointCurrentAt(destination)

  const staging = fs.mkdtempSync(path.join(versions, ".install-"))
  const runtime = path.join(staging, "runtime")
  fs.mkdirSync(runtime, { mode: 0o700 })
  try {
    const archive = path.join(staging, "download.zip")
    note(`downloading Antigravity ACP ${release.version} for ${key}`)
    await download(asset, archive)
    note("extracting the Antigravity ACP server")
    await extract(archive, runtime, asset)
    fs.rmSync(archive, { force: true })
    if (process.platform !== "win32") {
      for (const name of [asset.binaryName, asset.harnessName]) fs.chmodSync(path.join(runtime, name), 0o755)
    }
    if (process.platform === "darwin") {
      for (const name of [asset.binaryName, asset.harnessName]) await runFile("xattr", ["-d", "com.apple.quarantine", path.join(runtime, name)]).catch(() => "")
    }
    note("checking the downloaded server over ACP")
    await validateInstall(runtime, asset, release.version)
    fs.writeFileSync(path.join(runtime, "install-integrity.json"), JSON.stringify({
      version: release.version, platform: key, archive: asset.archive, archiveSha256: asset.archiveSha256,
      installedAt: new Date().toISOString(), by: "@magpie-community/opencode-antigravity-acp-auth",
    }, null, 2) + "\n", { mode: 0o600 })
    try {
      fs.renameSync(runtime, destination)
    } catch (e) {
      if (!isInstalled(destination, asset)) throw e
    }
    pointCurrentAt(destination)
    toast(`Antigravity ACP ${release.version} is ready.`)
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

async function download(asset, destination) {
  const res = await fetch(asset.archive, { signal: AbortSignal.timeout(INSTALL_TIMEOUT) })
  if (!res.ok || !res.body) throw new Error(`the Antigravity ACP download said HTTP ${res.status}`)
  const hash = createHash("sha256")
  const out = fs.createWriteStream(destination, { mode: 0o600 })
  let received = 0
  let said = 0
  for await (const chunk of res.body) {
    received += chunk.byteLength
    if (received > asset.archiveBytes) throw new Error("the Antigravity ACP download is bigger than its manifest says")
    hash.update(chunk)
    const percent = Math.floor((received / asset.archiveBytes) * 100)
    if (percent >= said + 25) { said = percent; note(`downloading Antigravity ACP: ${percent}%`) }
    if (!out.write(chunk)) await new Promise((r) => out.once("drain", r))
  }
  out.end()
  await new Promise((r, j) => { out.on("finish", r); out.on("error", j) })
  if (received !== asset.archiveBytes) throw new Error(`the Antigravity ACP download is ${received} bytes; the manifest says ${asset.archiveBytes}`)
  const sha = hash.digest("hex")
  if (sha !== asset.archiveSha256) throw new Error(`the Antigravity ACP download's SHA-256 is ${sha}; the manifest says ${asset.archiveSha256}`)
}

async function extract(archive, runtime, asset) {
  const keep = new Set([asset.binaryName, asset.harnessName])
  if (process.platform === "win32") {
    const quote = (s) => s.replace(/'/g, "''")
    await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Expand-Archive -LiteralPath '${quote(archive)}' -DestinationPath '${quote(runtime)}' -Force`])
    for (const entry of fs.readdirSync(runtime)) if (!keep.has(entry)) fs.rmSync(path.join(runtime, entry), { recursive: true, force: true })
    return
  }
  try {
    await runFile("unzip", ["-o", "-q", archive, asset.binaryName, asset.harnessName, "-d", runtime])
  } catch (e) {
    if (e?.code === "ENOENT") throw new Error("unzip isn't on this machine; install it, or set AGY_ACP_BIN to an Antigravity ACP server you already have")
    throw new Error(`unzipping the Antigravity ACP server failed: ${e?.stderr || e?.message || e}`)
  }
  const names = new Set(fs.readdirSync(runtime))
  for (const name of keep) if (!names.has(name)) throw new Error(`the Antigravity ACP archive has no ${name}`)
}

// validateInstall starts the downloaded server once and takes its word for
// what it is, the way the reference provider does: protocol 1, the
// antigravity-acp agent, the version the manifest pinned.
async function validateInstall(runtime, asset, version) {
  const command = path.join(runtime, asset.binaryName)
  const conn = new AcpConnection({ command, args: launchArgs(command), cwd: runtime })
  conn.start()
  try {
    const init = await conn.initialize(2 * 60_000)
    const said = init?.agentInfo?.version
    if (init?.protocolVersion !== PROTOCOL_VERSION || init?.agentInfo?.name !== "antigravity-acp" ||
      (said !== version && said !== `agy_acp_server_${version}`)) {
      throw new Error(`the downloaded server called itself ${init?.agentInfo?.name ?? "unknown"} ${said ?? "of an unknown version"}; ${version} was expected`)
    }
  } finally {
    conn.kill()
  }
}

// ---- stale servers ---------------------------------------------------------

// A magpie killed hard leaves its ACP server running; the pid file lets the
// next start take it back. Only a process whose command line names the
// server is killed, so a recycled pid costs nothing.
// Each host process keeps its own pid file, named for it: a server belongs
// to the process that spawned it, and only a host that has died has its
// servers reaped. One shared file would have every magpie process killing
// every other's live server (a CLI command would take down the app's).
// the pid files live in the plugin's own runtime root, not the server's
// sign-in folder (~/.gemini), which is the server's to keep
const runDir = () => path.join(runtimeRoot(), "run")
const pidFile = (owner = process.pid) => path.join(runDir(), `magpie-acp-pids-${owner}.json`)
let reaped = false
async function reapStale() {
  if (reaped) return
  reaped = true
  try {
    fs.mkdirSync(runDir(), { recursive: true, mode: 0o700 })
    for (const f of fs.readdirSync(runDir())) {
      const owner = f.match(/^magpie-acp-pids-(\d+)\.json$/)?.[1]
      if (owner !== undefined && Number(owner) !== process.pid && !alive(Number(owner))) {
        await reapFile(path.join(runDir(), f))
      }
    }
  } catch {}
}

async function reapFile(file) {
  const all = readJSON(file)
  if (Array.isArray(all)) {
    for (const e of all.slice(-8)) {
      if (!e || typeof e.pid !== "number" || e.pid === process.pid) continue
      if (await isAgyServer(e.pid)) killTree(e.pid)
    }
  }
  try { fs.rmSync(file, { force: true }) } catch {}
}

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

async function isAgyServer(pid) {
  try {
    if (process.platform === "linux") return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("agy_acp_server")
    if (process.platform === "darwin") return (await runFile("ps", ["-p", String(pid), "-o", "args="])).includes("agy_acp_server")
    if (process.platform === "win32") {
      const out = await runFile("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"])
      return out.toLowerCase().includes("agy_acp_server")
    }
  } catch {}
  return false
}

function killTree(pid) {
  try {
    if (process.platform === "win32") execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => {})
    else process.kill(pid, "SIGKILL")
  } catch {}
}

function notePid(command, pid) {
  try {
    const all = (readJSON(pidFile()) ?? []).filter((e) => e && e.pid !== pid)
    all.push({ pid, at: Date.now(), command })
    fs.mkdirSync(path.dirname(pidFile()), { recursive: true, mode: 0o700 })
    fs.writeFileSync(pidFile(), JSON.stringify(all.slice(-8)))
  } catch {}
}
// ---- the ACP wire ----------------------------------------------------------

// AcpConnection is one server process, newline-delimited JSON-RPC over its
// stdio. Requests carry a deadline; a deadline, a protocol error or the
// process's death fails every request still waiting.
class AcpConnection {
  constructor({ command, args = [], cwd, env }) {
    this.command = command
    this.args = args
    this.cwd = cwd
    this.env = env
    this.noise = 0
    this.dead = null
    this.nextId = 1
    this.pending = new Map()
    this.updaters = new Set()
    this.server = null
    this.init = null
    this.initResult = null
    this.stderrTail = ""
    this.#child = null
  }

  #child

  start() {
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    this.#child = child
    track(child)
    notePid(this.command, child.pid)
    // a server that can't start (ENOENT, EACCES) raises "error", and a write
    // to one that just died raises EPIPE on stdin; either left alone would
    // take the whole host down
    child.on("error", (e) => this.#fail(new Error(`the Antigravity ACP server could not be started: ${e?.message ?? e}`)))
    child.stdin?.on?.("error", () => {})
    let buffer = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      buffer += chunk
      if (buffer.length > MAX_FRAME) return this.#fail(new Error("the Antigravity ACP server said more than one frame can hold"))
      let at
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        this.#line(line)
      }
    })
    child.stderr.on("data", (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_MAX)
    })
    this.dead = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        resolve({ code, signal })
        this.#fail(new Error(`the Antigravity ACP server exited (${signal ? `signal ${signal}` : `code ${code}`})${this.stderrTail.trim() ? `: ${this.stderrTail.trim().split("\n").at(-1)}` : ""}`))
      })
    })
    this.dead.catch(() => {})
  }

  #line(line) {
    const text = line.trim()
    if (!text) return
    if (!text.startsWith("{")) {
      if (BROWSER_NOISE.test(text)) { this.noise++; return }
      return this.#fail(new Error(`the Antigravity ACP server wrote a line that isn't ACP: ${text.slice(0, 200)}`))
    }
    let msg
    try { msg = JSON.parse(text) } catch {
      return this.#fail(new Error("the Antigravity ACP server wrote JSON that doesn't read"))
    }
    if (msg.method === undefined && msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)
      clearTimeout(p.timer)
      this.pending.delete(msg.id)
      if (msg.error) p.reject(acpError(msg.error))
      else p.resolve(msg.result)
      return
    }
    if (msg.method === undefined && msg.id === null && msg.error) {
      // an error with no request behind it (a body the server couldn't read)
      // is a broken transport, not one failed call
      return this.#fail(acpError(msg.error))
    }
    if (typeof msg.method !== "string") return
    if (msg.id !== undefined) {
      // a request of the server's: permission requests are turned down, so
      // Antigravity's own tools never run; anything else isn't offered
      Promise.resolve(this.#serve(msg))
        .then(
          (r) => (r === UNHANDLED ? this.respondError(msg.id, -32601, `${msg.method} is not supported`) : this.respond(msg.id, r)),
          (e) => this.respondError(msg.id, -32603, String(e?.message ?? e)),
        )
      return
    }
    if (msg.method === "session/update") {
      for (const up of this.updaters) { try { up(msg.params ?? {}) } catch {} }
    }
  }

  async #serve(msg) {
    if (msg.method === "session/request_permission") return { outcome: { outcome: "cancelled" } }
    return UNHANDLED
  }

  #write(obj) {
    if (!this.#child?.stdin?.writable) throw new Error("the Antigravity ACP server isn't running")
    this.#child.stdin.write(JSON.stringify(obj) + "\n")
  }

  respond(id, result) { try { this.#write({ jsonrpc: "2.0", id, result }) } catch {} }
  respondError(id, code, message) { try { this.#write({ jsonrpc: "2.0", id, error: { code, message } }) } catch {} }

  request(method, params, timeoutMs = OP_TIMEOUT) {
    return this.call(method, params, timeoutMs).promise
  }

  // call is request with a handle to give the wait up: a prompt cancelled
  // early leaves the pending table, so its timeout can't fire later. A
  // timed-out call takes the server down only when killOnTimeout says so
  // (the default): one stuck prompt is cancelled on the server instead, so
  // it can't take down every other request riding the same process
  call(method, params, timeoutMs = OP_TIMEOUT, killOnTimeout = true) {
    if (!this.#child) throw new Error("the Antigravity ACP server was never started")
    const id = this.nextId++
    let timer
    const promise = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        this.pending.delete(id)
        if (killOnTimeout) this.kill()
        reject(new Error(`the Antigravity ACP server didn't answer ${method} within ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
    })
    try { this.#write({ jsonrpc: "2.0", id, method, params }) } catch (e) {
      const p = this.pending.get(id)
      if (p) { clearTimeout(p.timer); this.pending.delete(id) }
      throw e
    }
    return {
      promise,
      abandon: () => {
        const p = this.pending.get(id)
        if (p) { clearTimeout(p.timer); this.pending.delete(id); p.resolve(null) }
      },
    }
  }

  notify(method, params) { try { this.#write({ jsonrpc: "2.0", method, params }) } catch {} }

  initialize(timeoutMs = INIT_TIMEOUT) {
    this.init ??= this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "opencode-antigravity-acp-auth", title: "Antigravity (ACP) for magpie", version: "0.1.2" },
    }, timeoutMs).then(
      (r) => { this.initResult = r; return r },
      (e) => { this.init = null; this.initResult = null; throw e },
    )
    return this.init
  }

  // live is whether the server process is still with us
  get live() {
    const child = this.#child
    return !!child && child.exitCode === null && !child.killed
  }

  authenticate(params, timeoutMs = AUTH_TIMEOUT) {
    return this.request("authenticate", params, timeoutMs)
  }

  async newSession(cwd, mcpServers = [], timeoutMs = OP_TIMEOUT) {
    const out = await this.request("session/new", { cwd, mcpServers }, timeoutMs)
    if (typeof out?.sessionId !== "string" || !out.sessionId) throw new Error("the Antigravity ACP server made no session")
    return out
  }

  onSessionUpdate(fn) {
    this.updaters.add(fn)
    return () => this.updaters.delete(fn)
  }

  #fail(error) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(error)
    }
    this.pending.clear()
    // a server that spoke nonsense or died is no good to the pool: stop it,
    // so a live-looking process isn't handed out again
    this.kill()
  }

  cancel(sessionId) { this.notify("session/cancel", { sessionId }) }

  // canClose is whether the server advertised the session/close capability:
  // ACP's session/close is a request, and still unstable — an agent offers it
  // with agentCapabilities.sessionCapabilities.close, an object ({} means
  // supported; omitted or null means not), and a server without it would
  // never answer a request for it
  get canClose() {
    const close = this.initResult?.agentCapabilities?.sessionCapabilities?.close
    return close != null && typeof close === "object"
  }

  // closeSession asks the server to close a session once its request is over,
  // as a request (it is one in ACP), with a short wait and no failure anyone
  // waits on: a server that doesn't take the method or answer in time just
  // leaves the session to its own accounting
  closeSession(sessionId) {
    if (!this.canClose) return
    this.call("session/close", { sessionId }, 5_000, false).promise.catch(() => {})
  }

  kill() {
    this.init = null
    this.initResult = null
    const child = this.#child
    if (!child) return
    try { child.stdin?.end() } catch {}
    try { child.kill() } catch {}
    const flee = setTimeout(() => { try { child.kill("SIGKILL") } catch {} }, 1500)
    flee.unref?.()
  }
}

const UNHANDLED = Symbol("unhandled")

function acpError(e) {
  const error = new Error(String(e?.message ?? "the Antigravity ACP server refused"))
  if (typeof e?.code === "number") error.code = e.code
  const detail = typeof e?.data?.details === "string" ? e.data.details : ""
  if (detail) error.message = `${error.message}: ${detail.slice(0, 300)}`
  return error
}

const isAuthError = (e) => e?.code === -32000 || /authentication required/i.test(String(e?.message ?? ""))

// ---- the Google sign-in the server keeps -----------------------------------

// localAuth is what can be read of the server's sign-in without asking it:
// the settings' auth kind, and an email when a token file names one. It is
// never a verdict — the server decides where its tokens live — only a hint.
function localAuth() {
  const dir = authDir()
  const settings = readJSON(path.join(dir, "settings.json"))
  const token = readJSON(path.join(dir, "acp_token.json"))
  const kind = typeof settings?.auth?.type === "string" ? settings.auth.type : undefined
  const email = typeof token?.email === "string" ? token.email : ""
  return { kind, email }
}

// configureDefaultAuth writes the settings the server reads before its first
// sign-in, as the reference provider does; a token already there wins.
function configureDefaultAuth() {
  const dir = authDir()
  if (isFile(path.join(dir, "acp_token.json"))) return
  const settingsPath = path.join(dir, "settings.json")
  const settings = readJSON(settingsPath)
  if (settings?.auth && typeof settings.auth === "object") return
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(settingsPath, JSON.stringify({ ...settings, auth: { type: process.env.GEMINI_API_KEY ? "gemini-api-key" : "oauth-personal" } }, null, 2) + "\n", { mode: 0o600 })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- the managed runtime's pooled connections ------------------------------

const pools = new Map() // auth kind → {conn, key}

// workDir is the folder the server process runs in and every session is
// given as its cwd — a folder of the plugin's own under the managed runtime,
// never magpie's config folder (the one that holds auth.json with every
// plugin account's tokens): an agent's read tools list and read their cwd
// without asking, and the server writes its workspace files here too.
const workDir = () => {
  const dir = path.join(runtimeRoot(), "workspace")
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }) } catch {}
  return dir
}

const expired = (message) => Object.assign(new Error(message), { signIn: "expired" })

// connectionFor is the account's kind of sign-in on one server process: the
// oauth one is the Google sign-in the server keeps; an api-key one
// authenticates with the stored key each time it is made.
async function connectionFor(auth) {
  const kind = auth?.type === "api" ? "api" : "oauth"
  const key = kind === "api" ? auth.key : ""
  const have = pools.get(kind)
  if (have && have.key === key && have.conn.live) return have.conn
  have?.conn.kill()
  await reapStale()
  const launch = await ensureRuntime()
  const conn = new AcpConnection({ command: launch.command, args: launch.args, cwd: workDir() })
  conn.start()
  try {
    const init = await conn.initialize()
    if (kind === "api") {
      const method = (init?.authMethods ?? []).find((m) => {
        const meta = m?._meta ?? null
        return (meta && "api-key" in meta) || /api key/i.test(String(m?.name ?? ""))
      })
      if (!method) throw new Error("this Antigravity ACP server offers no Gemini API-key sign-in")
      await conn.authenticate({ methodId: method.id, _meta: { "api-key": key } }, 60_000)
    }
  } catch (e) {
    conn.kill()
    throw e
  }
  pools.set(kind, { conn, key })
  return conn
}

// ---- OAuth relay for hosts without a browser -------------------------------

// The server opens the OAuth page in a browser itself and never says the URL.
// Where no browser can open (SSH, a headless Linux), the browser command is
// replaced with a capture helper: the URL comes here, magpie shows it, and
// the final localhost URL the user pastes is relayed to the server's own
// loopback listener.
const shouldUseRelay = () => {
  const mode = process.env.AGY_ACP_OAUTH_MODE?.trim().toLowerCase()
  if (mode === "manual") return true
  if (mode === "browser") return false
  if (process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY) return true
  return process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
}

class OAuthRelay {
  constructor() {
    if (process.platform === "win32") throw new Error("the manual OAuth relay isn't on Windows yet; sign in where a browser can open")
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-acp-oauth-"))
    fs.chmodSync(this.dir, 0o700)
    this.capture = path.join(this.dir, "authorization-url")
    const helper = (name) => {
      const p = path.join(this.dir, name)
      // the capture file's path reaches the script through the environment,
      // never through a quoted string: a TMPDIR with a quote in it must not
      // break the script, let alone run its contents
      fs.writeFileSync(p, `#!/bin/sh\numask 077\nprintf '%s\\n' "$1" > "$AGY_ACP_CAPTURE"\n`, { mode: 0o700 })
      return p
    }
    const browser = helper("capture-browser")
    this.env = {
      ...process.env,
      BROWSER: browser,
      AGY_ACP_CAPTURE: this.capture,
      PATH: `${this.dir}${path.delimiter}${process.env.PATH ?? ""}`,
    }
  }

  async waitUrl(signal, timeoutMs = 30_000) {
    const end = Date.now() + timeoutMs
    for (;;) {
      if (signal?.aborted) throw new Error("the sign-in was cancelled")
      const text = (() => { try { return fs.readFileSync(this.capture, "utf8").trim() } catch { return "" } })()
      if (text) return this.#parse(text)
      if (Date.now() > end) throw new Error("Antigravity offered no OAuth URL within 30 seconds")
      await sleep(200)
    }
  }

  #parse(text) {
    let url
    try { url = new URL(text) } catch { throw new Error("Antigravity gave an OAuth URL that doesn't read") }
    if (url.protocol !== "https:" || url.hostname !== "accounts.google.com") throw new Error(`Antigravity gave an unexpected OAuth URL (${url.hostname})`)
    const redirect = url.searchParams.get("redirect_uri")
    const state = url.searchParams.get("state")
    if (!redirect || !state) throw new Error("Antigravity's OAuth URL is missing its redirect or state")
    return { url: url.toString(), redirect: new URL(redirect), state }
  }

  // forward hands the pasted callback URL (or bare code) to the server's own
  // loopback listener, which finishes the exchange.
  async forward(input, authorization) {
    let callback
    const value = String(input ?? "").trim()
    if (!value) throw new Error("paste the final localhost URL, or the code in it")
    if (/^https?:\/\//i.test(value)) {
      callback = new URL(value)
    } else {
      callback = new URL(authorization.redirect)
      const params = value.includes("=") ? new URLSearchParams(value.replace(/^\?/, "")) : undefined
      callback.searchParams.set("code", params?.get("code") ?? value)
      callback.searchParams.set("state", params?.get("state") ?? authorization.state)
    }
    if (callback.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(callback.hostname) || !callback.port) {
      throw new Error("the pasted URL isn't the localhost callback the sign-in expects")
    }
    if (callback.origin !== authorization.redirect.origin || callback.pathname !== authorization.redirect.pathname) {
      throw new Error("the pasted URL doesn't match this sign-in's callback")
    }
    if (callback.searchParams.get("state") !== authorization.state) throw new Error("the pasted URL is for another sign-in")
    if (!callback.searchParams.get("code") && !callback.searchParams.get("error")) throw new Error("the pasted URL carries no code")
    const res = await fetch(callback, { redirect: "manual", signal: AbortSignal.timeout(30_000) })
    await res.body?.cancel().catch(() => {})
    if (res.status >= 400) throw new Error(`the Antigravity OAuth callback said HTTP ${res.status}`)
  }

  dispose() { try { fs.rmSync(this.dir, { recursive: true, force: true }) } catch {} }
}

// ---- signing in ------------------------------------------------------------

// googleSignIn runs the server's own Google sign-in: in a browser where one
// can open, else through the relay (show the URL, paste the callback back).
async function googleSignIn() {
  const launch = await ensureRuntime()
  configureDefaultAuth()
  const relay = shouldUseRelay() ? new OAuthRelay() : null
  const conn = new AcpConnection({ command: launch.command, args: launch.args, cwd: workDir(), env: relay ? relay.env : process.env })
  conn.start()
  const cleanup = () => { try { conn.kill() } catch {}; relay?.dispose() }
  setTimeout(cleanup, AUTH_RELAY_TIMEOUT + 5 * 60_000).unref?.()
  try {
    const init = await conn.initialize()
    const method = (init?.authMethods ?? []).find((m) => /log\s*in\s+with\s+google|google\s+account|oauth-personal/i.test(`${m?.id ?? ""} ${m?.name ?? ""}`))
    if (!method) throw new Error("this Antigravity ACP server offers no Google sign-in")
    const authentication = conn.authenticate({ methodId: method.id }, relay ? AUTH_RELAY_TIMEOUT : AUTH_TIMEOUT)
    authentication.catch(() => {})
    if (relay) {
      let authorization
      try {
        authorization = await Promise.race([
          relay.waitUrl(null, AUTH_RELAY_TIMEOUT),
          authentication.then(() => ({ reused: true }), () => Promise.reject(new Error("the Google sign-in failed before its page opened"))),
        ])
      } catch (e) { cleanup(); if (e?.reused) return saved(); throw e }
      if (authorization.reused) { cleanup(); return saved() }
      return {
        url: authorization.url,
        instructions: "Open this URL in a browser (anywhere you like) and finish the Google sign-in. Google then lands on a localhost page that may fail to load — that is fine. Paste the complete final URL from the address bar here.",
        method: "code",
        callback: async (code) => {
          try {
            await relay.forward(code, authorization)
            await authentication
            return await done(conn)
          } finally { cleanup() }
        },
      }
    }
    return {
      url: "",
      instructions: "Complete the Google sign-in in the browser window that Antigravity opened.",
      method: "auto",
      callback: async () => {
        try {
          await authentication
          return await done(conn)
        } finally { cleanup() }
      },
    }
  } catch (e) {
    // a failure is the host's to show: authorize throws, the sign-in RPC
    // errors, and magpie says why (a made-up return value would only break
    // the contract)
    cleanup()
    throw e
  }
}

// saved is the marker stored for this provider: the server keeps the tokens.
const saved = () => ({
  type: "success",
  refresh: MANAGED,
  access: MANAGED,
  expires: Date.now() + 10 * 365 * 24 * 3600 * 1000,
  ...(localAuth().email ? { accountId: localAuth().email } : {}),
})

// signedIn proves the server really has a credential by asking it for one
// word: a session is made signed-out too, but only a credential gets a
// prompt through. The server answers an existing sign-in at once; without
// one it drives the browser itself.
async function signedIn(conn) {
  const session = await conn.newSession(workDir(), [], 60_000)
  try {
    const r = await conn.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "Reply with exactly: OK" }] }, 90_000)
    if (r?.stopReason !== "end_turn" && r?.stopReason !== "cancelled") throw new Error("the server did not answer the probe")
  } finally {
    conn.cancel(session.sessionId)
    conn.closeSession(session.sessionId)
  }
}

// done checks the sign-in took and saves the marker.
async function done(conn) {
  try {
    await signedIn(conn)
  } catch (e) {
    return { type: "failed", error: isAuthError(e) ? "the sign-in didn't take: Antigravity still asks for authentication" : String(e?.message ?? e) }
  }
  return saved()
}

// currentSignIn takes the Google sign-in the server already has (an install
// with the Antigravity IDE signed in usually has one): the probe settles it.
async function currentSignIn() {
  const launch = await ensureRuntime()
  const conn = new AcpConnection({ command: launch.command, args: launch.args, cwd: workDir() })
  conn.start()
  try {
    await conn.initialize()
    try {
      await signedIn(conn)
    } catch {
      throw new Error("Antigravity has no Google sign-in on this machine yet; sign in with the browser one first")
    } finally { conn.kill() }
  } catch (e) {
    if (e?.message?.includes("no Google sign-in")) throw e
    throw new Error("the Antigravity ACP server could not be started: " + String(e?.message ?? e))
  }
  return {
    url: "",
    instructions: localAuth().email ? `Using Antigravity's Google sign-in as ${localAuth().email}.` : "Using Antigravity's Google sign-in.",
    method: "auto",
    callback: async () => saved(),
  }
}

// ---- models ----------------------------------------------------------------

const FALLBACK_MODELS = {
  "gemini-3.8-flash": family("Gemini 3.8 Flash", ["low", "medium", "high"]),
  "gemini-3.7-flash": family("Gemini 3.7 Flash", ["low", "medium", "high"]),
  "gemini-3.6-flash": family("Gemini 3.6 Flash", ["low", "medium", "high"]),
  "gemini-3.1-pro": family("Gemini 3.1 Pro", ["low", "high"]),
}

function family(name, efforts) {
  return {
    name,
    reasoning: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context: 1_000_000, output: 65_536 },
    variants: Object.fromEntries(efforts.map((e) => [e, { reasoningEffort: e }])),
  }
}

// sessionModels reads a session's model list, from the config option named
// "model" or the older models field.
function sessionModels(state) {
  const selector = (state?.configOptions ?? []).find((o) => o?.type === "select" && (o.category === "model" || o.id === "model"))
  if (selector) {
    const values = (selector.options ?? []).flatMap((entry) => (Array.isArray(entry?.options) ? entry.options : [entry]))
    return values.filter((v) => typeof v?.value === "string").map((v) => ({ modelId: v.value, name: typeof v.name === "string" ? v.name : v.value }))
  }
  return (state?.models?.availableModels ?? []).filter((m) => typeof m?.modelId === "string")
}

// projectModels folds Antigravity's effort-qualified ids into one entry per
// family (gemini-3.8-flash-low/-medium/-high is "gemini-3.8-flash", with the
// levels it has as variants). An id whose name or id says no level, and a
// family of one, stay a model of their own.
function projectModels(raw) {
  const effortOf = (id, name) => {
    let m = String(name ?? "").match(/^(.+?)\s*\((low|medium|high)\)$/i)
    if (m) return { base: m[1].trim(), effort: m[2].toLowerCase() }
    m = String(id).match(/^(.+)-(low|medium|high)$/)
    if (m) return { base: m[1], effort: m[2] }
    return null
  }
  const groups = new Map()
  for (const m of raw) {
    const parsed = effortOf(m.modelId.trim(), m.name)
    if (!parsed || !m.modelId.trim().startsWith("gemini-")) continue
    const key = parsed.base.toLowerCase()
    const group = groups.get(key) ?? { name: parsed.base, members: [] }
    group.members.push({ ...m, effort: parsed.effort, base: parsed.base })
    groups.set(key, group)
  }
  const seen = new Set()
  const out = []
  for (const m of raw) {
    const id = m.modelId.trim()
    if (seen.has(id)) continue
    const parsed = effortOf(id, m.name)
    const group = parsed ? groups.get(parsed.base.toLowerCase()) : undefined
    if (group && group.members.length >= 2) {
      if (seen.has(group.name.toLowerCase())) continue
      seen.add(group.name.toLowerCase())
      for (const member of group.members) seen.add(member.modelId.trim())
      const byEffort = {}
      for (const member of group.members) byEffort[member.effort] ??= member.modelId.trim()
      const bases = group.members.map((x) => x.modelId.trim().replace(/-(low|medium|high)$/, ""))
      const id2 = bases.length && bases.every((b) => b === bases[0]) ? bases[0] : group.name.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "")
      // the plain id only when the family really has an unqualified member:
      // a family of qualified ids alone (the usual rollout) has none, and a
      // request without an effort takes the highest tier instead
      const plainMember = group.members.find((x) => !/-(low|medium|high)$/.test(x.modelId.trim()))
      out.push({
        id: id2,
        name: group.name,
        efforts: Object.keys(byEffort),
        byEffort,
        plain: plainMember ? plainMember.modelId.trim() : "",
      })
      continue
    }
    seen.add(id)
    out.push({ id, name: String(m.name ?? "").trim() || id, efforts: [], byEffort: {}, plain: id })
  }
  return out
}

// resolveServerId is the server's id for the family and effort a request
// names; a model no family has goes as it is (or, when it looks like a bare
// family and an effort was asked, with the effort guessed on).
function resolveServerId(model, effort) {
  const fam = familyIndex.get(model)
  const pick = (...levels) => { for (const l of levels) if (fam?.byEffort[l]) return fam.byEffort[l]; return "" }
  if (fam) {
    if (!effort || effort === "none") return fam.plain || pick("high", "medium", "low") || model
    if (effort === "minimal") return fam.plain || pick("low", "medium", "high") || model
    if (effort === "xhigh" || effort === "max") return pick("high", "medium", "low") || model
    if (effort === "low") return pick("low", "medium", "high") || model
    if (effort === "medium") return pick("medium", "high", "low") || model
    return pick("high", "medium", "low") || model
  }
  const guess = effort === "minimal" || effort === "none" ? "low" : effort === "xhigh" || effort === "max" ? "high" : effort
  return guess && ["low", "medium", "high"].includes(guess) ? `${model}-${guess}` : model
}

let familyIndex = new Map()

// the fallbacks are indexed the way a discovery would: a request naming one
// resolves to the server's effort-qualified id even before (or without) a
// models listing, and without an effort asked, at the highest tier there is
for (const [id, m] of Object.entries(FALLBACK_MODELS)) {
  familyIndex.set(id, {
    byEffort: Object.fromEntries(Object.keys(m.variants).map((e) => [e, `${id}-${e}`])),
    plain: "",
  })
}

async function discoverModels(auth) {
  const conn = await connectionFor(auth)
  const session = await conn.newSession(workDir(), [])
  try { return sessionModels(session) } finally { conn.closeSession(session.sessionId) }
}

function magpieModel(provider, m) {
  return {
    id: m.id,
    providerID: provider.id,
    name: m.name,
    api: { id: m.id, url: API_BASE, npm: "@ai-sdk/openai-compatible" },
    limit: { context: 1_000_000, output: 65_536 },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, image: true, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
    variants: Object.fromEntries(m.efforts.map((e) => [e, { reasoningEffort: e }])),
  }
}

// ---- the MCP bridge --------------------------------------------------------

// Bridge serves the request's tools to the agent as one MCP server on
// loopback. A call there is the model asking for a client tool: the call is
// handed to the turn (it becomes tool_calls), and the bridge answers that it
// was delivered, since the client's result comes with the user's next message.
class Bridge {
  constructor(tools) {
    this.token = randomUUID().replaceAll("-", "")
    this.tools = tools.slice(0, MAX_TOOLS).map((t, i) => {
      const fn = t?.type === "function" ? t.function ?? {} : t ?? {}
      const raw = typeof fn.name === "string" ? fn.name : `tool-${i}`
      const name = raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || `tool-${i}`
      let schema = fn.parameters
      if (schema === undefined || schema === null || typeof schema !== "object" || Array.isArray(schema)) schema = { type: "object", properties: {} }
      return { mcp: name, name: raw, description: typeof fn.description === "string" ? fn.description.slice(0, 4000) : "", schema }
    })
    this.onCall = null
    this.server = null
    this.url = ""
  }

  get empty() { return this.tools.length === 0 }

  start() {
    if (this.empty) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        // #handle is async: a rejection left alone would be unhandled
        Promise.resolve(this.#handle(req, res)).catch(() => {
          try {
            if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" })
            res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "bridge error" } }))
          } catch {}
        })
      })
      server.on("error", reject)
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address()
        this.url = `http://127.0.0.1:${port}/mcp`
        resolve()
      })
      this.server = server
    })
  }

  descriptor() {
    if (this.empty) return null
    return { type: "http", name: "magpie", url: this.url, headers: [{ name: "Authorization", value: `Bearer ${this.token}` }] }
  }

  async #handle(req, res) {
    if (req.method !== "POST" || req.url !== "/mcp") return res.writeHead(405).end()
    if ((req.headers.authorization ?? "") !== `Bearer ${this.token}`) return res.writeHead(401).end()
    let body = ""
    for await (const chunk of req) {
      body += chunk
      if (body.length > (1 << 20)) return res.writeHead(413).end()
    }
    let messages
    try { messages = JSON.parse(body) } catch { return res.writeHead(400).end() }
    const batch = Array.isArray(messages)
    const replies = []
    for (const msg of batch ? messages : [messages]) {
      const reply = await this.#message(msg)
      if (reply !== undefined) replies.push(reply)
    }
    if (!replies.length) return res.writeHead(202).end()
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": this.token })
    res.end(JSON.stringify(batch ? replies : replies[0]))
  }

  async #message(msg) {
    if (!msg || typeof msg !== "object") return undefined
    const { id, method, params } = msg
    const reply = (result) => (id === undefined || id === null ? undefined : { jsonrpc: "2.0", id, result })
    switch (method) {
      case "initialize":
        return reply({ protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "magpie", version: "0.1.0" } })
      case "ping":
        return reply({})
      case "tools/list":
        return reply({
          tools: this.tools.map((t) => ({
            name: t.mcp,
            description: t.description || `The client's ${t.name} tool.`,
            inputSchema: JSON.stringify(t.schema).length <= SCHEMA_MAX ? t.schema : { type: "object", properties: {} },
          })),
        })
      case "tools/call": {
        const tool = this.tools.find((t) => t.mcp === params?.name) ?? { name: String(params?.name ?? "") }
        const call = { name: tool.name, args: params?.arguments ?? {} }
        if (!this.onCall || !this.onCall(call)) {
          return reply({ content: [{ type: "text", text: "The client is not taking tool calls right now." }], isError: true })
        }
        return reply({ content: [{ type: "text", text: "Delivered to the client. Its result arrives with the user's next message." }] })
      }
      default:
        return id === undefined || id === null ? undefined : { jsonrpc: "2.0", id, error: { code: -32601, message: `bridge has no ${method}` } }
    }
  }

  close() { try { this.server?.close() } catch {}; this.server = null }
}

// ---- a chat request as one ACP prompt --------------------------------------

function parseChat(body) {
  const text = typeof body === "string" ? body : body instanceof Uint8Array ? new TextDecoder().decode(body) : ""
  let req
  try { req = JSON.parse(text) } catch { throw new Error("the request body isn't JSON") }
  if (!req || !Array.isArray(req.messages) || req.messages.length === 0) throw new Error("the request has no messages")
  return req
}

const contentText = (content) => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((b) => (typeof b?.text === "string" ? b.text : "")).join("")
}

function imageBlock(url) {
  const m = typeof url === "string" ? url.match(/^data:([^;,]+);base64,(.*)$/s) : null
  if (!m) return { type: "text", text: "[an image the client didn't inline]" }
  return { type: "image", data: m[2], mimeType: m[1] }
}

function userBlocks(message) {
  const content = message?.content
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : []
  const blocks = []
  for (const b of Array.isArray(content) ? content : []) {
    if (b?.type === "text" && typeof b.text === "string" && b.text) blocks.push({ type: "text", text: b.text })
    else if (b?.type === "image_url") blocks.push(imageBlock(b.image_url?.url))
  }
  return blocks
}

function formatMessage(m) {
  if (m?.role === "user") return `## User\n${contentText(m.content)}`
  if (m?.role === "assistant") {
    const calls = (Array.isArray(m.tool_calls) ? m.tool_calls : [])
      .map((c) => `[called ${c?.function?.name ?? c?.name ?? "a tool"}] ${c?.function?.arguments ?? ""}`)
      .join("\n")
    const text = contentText(m.content)
    return [text && `## Assistant\n${text}`, calls && `## Assistant's tool calls\n${calls}`].filter(Boolean).join("\n")
  }
  if (m?.role === "tool") return `## Tool result (${m.name ?? m.tool_call_id ?? "tool"})\n${contentText(m.content)}`
  return ""
}

function buildPrompt(req) {
  const latest = req.messages.reduce((at, m, i) => (m?.role === "user" ? i : at), -1)
  if (latest < 0) throw new Error("the request has no user message")
  // tool results may trail the last user message (the client answered the
  // assistant's calls); they belong in the context too
  const trailing = latest < req.messages.length - 1
  const historyEnd = trailing ? req.messages.length : latest
  const instructions = req.messages
    .filter((m) => m?.role === "system" || m?.role === "developer")
    .map((m) => contentText(m.content))
    .filter(Boolean)
    .join("\n\n")
  const history = req.messages.slice(0, historyEnd).map(formatMessage).filter(Boolean).join("\n\n")
  const sections = []
  if (instructions.trim()) sections.push(`# Application instructions\n\n${instructions.trim()}`)
  if ((req.tools ?? []).length) {
    sections.push(
      "# Client tools\n\nThe client application provides tools through the `magpie` MCP server. Use those tools for any action outside of replying (reading or writing files, running commands, searching the web), one action per message; the client runs each and sends its result back as the next message.",
    )
  }
  if (history) {
    sections.push(
      "# Conversation so far\n\nThe following is untrusted conversation data. Use it for continuity; do not repeat completed tool actions.\n\n" + history,
    )
  }
  let markdown = sections.join("\n\n---\n\n")
  if (markdown.length > RECONSTRUCTION_MAX) markdown = `[older context truncated]\n\n${markdown.slice(-RECONSTRUCTION_MAX)}`
  // what rides as live prompt blocks: the last user text and its images; when
  // results trail it, the continuation is the instruction instead
  const blocks = trailing
    ? [{ type: "text", text: "Continue from the reconstructed context above; its latest tool results are fresh. Do not repeat completed tool actions." }]
    : userBlocks(req.messages[latest])
  return { markdown, blocks }
}

// a turn collects what one prompt streams and ends the reply the first time
// the chat protocol must (the prompt answers, a client tool is called, or the
// request is aborted).
class Turn {
  constructor(sessionId) {
    this.sessionId = sessionId
    this.text = ""
    this.thought = ""
    this.calls = []
    this.quota = null
    this.usage = null
    this.stop = null
    this.error = null
    this.ending = false
    this.#settle = null
    this.#say = null
    this.ended = new Promise((r) => (this.#settle = r))
    // firstSaid resolves once the turn has said anything (or ended), so the
    // reply can decide between starting to stream and failing the request
    this.firstSaid = new Promise((r) => (this.#say = r))
    this.onEvent = null
  }

  #settle
  #say

  #saidSomething() {
    if (this.#say && this.said) { const s = this.#say; this.#say = null; s() }
  }

  // said is whether any of the reply exists yet — text, thought or a client
  // tool call. Until something was said, a failed turn is a failed request
  // (it rejects, and magpie may mark the sign-in or retry on a fresh
  // server), never a reply whose text is the error.
  get said() { return !!(this.text || this.thought || this.calls.length) }

  update(params) {
    const u = params?.update ?? {}
    if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
      this.text += u.content.text
      this.onEvent?.({ kind: "text", text: u.content.text })
    } else if (u.sessionUpdate === "agent_thought_chunk" && u.content?.type === "text") {
      this.thought += u.content.text
      this.onEvent?.({ kind: "thought", text: u.content.text })
    }
    // a tool_call note of the agent's own tools is left out: they are turned
    // down, and a chat reply has no good place for them
    this.#saidSomething()
  }

  addCall(name, args) {
    if (this.stop || this.calls.length >= 16) return false
    this.calls.push({ id: `call_${randomUUID().replaceAll("-", "").slice(0, 16)}`, name, args: JSON.stringify(args ?? {}) })
    this.#saidSomething()
    if (!this.ending) {
      this.ending = true
      // a moment for parallel calls of the same turn to arrive too
      setTimeout(() => this.finish("tool_calls"), 300).unref?.()
    }
    return true
  }

  finish(reason) {
    if (this.stop) return
    this.stop = reason
    this.#settle?.()
    this.#say?.()
    this.#settle = null
    this.#say = null
  }

  fail(error) {
    if (this.stop) return
    this.error = error
    this.stop = "error"
    this.#settle?.()
    this.#say?.()
    this.#settle = null
    this.#say = null
  }
}

// the last quota any prompt said, for the Usage card (all accounts of this
// provider share the machine's one Google sign-in, so one note serves all);
// each turn also keeps its own, so a reply's usage is its own.
let lastQuota = null

function noteQuota(response) {
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
  const usage = response?.usage ?? {}
  const quota = response?._meta?.quota ?? {}
  const remaining = num(quota.remainingRequests) ?? num(quota.remainingQueries) ?? num(quota.remaining)
  const limit = num(quota.requestLimit) ?? num(quota.queryLimit) ?? num(quota.limit)
  const reset = quota.resetTimestamp ?? quota.resetAt ?? quota.reset_time
  const said = {
    at: Date.now(),
    tier: typeof (quota.tier ?? quota.plan) === "string" ? (quota.tier ?? quota.plan) : "",
    used: remaining !== undefined && limit ? Math.round(Math.max(0, Math.min(100, (1 - remaining / limit) * 100)) * 10) / 10 : undefined,
    resetsAt: (typeof reset === "number" && reset > 1e12 ? new Date(reset) : typeof reset === "number" ? new Date(reset * 1000) : Date.parse(reset) ? new Date(reset) : null)?.toISOString?.() ?? "",
    input: num(usage.inputTokens ?? usage.input_tokens) ?? num(quota.token_count?.input_tokens) ?? 0,
    output: num(usage.outputTokens ?? usage.output_tokens) ?? num(quota.token_count?.output_tokens) ?? 0,
    thought: num(usage.thoughtTokens) ?? 0,
  }
  lastQuota = said
  return said
}

const usageOf = (q) => (q && (q.input || q.output) ? { prompt_tokens: q.input, completion_tokens: q.output, total_tokens: q.input + q.output } : undefined)

async function setSessionModel(conn, session, modelId) {
  const selector = (session?.configOptions ?? []).find((o) => o?.type === "select" && (o.category === "model" || o.id === "model"))
  if (selector) {
    const out = await conn.request("session/set_config_option", { sessionId: session.sessionId, configId: selector.id, value: modelId })
    if (Array.isArray(out?.configOptions)) session.configOptions = out.configOptions
    return
  }
  await conn.request("session/set_model", { sessionId: session.sessionId, modelId })
}

const SSE_HEAD = { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }

function streamReply(req, run, onCancel, quota) {
  const id = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const encoder = new TextEncoder()
  let controller = null
  const stream = new ReadableStream({
    start(c) { controller = c },
    // a reader that went away (the client hung up) ends the turn too, so the
    // prompt doesn't run on unheard
    cancel() {
      controller = null
      try { onCancel?.() } catch {}
    },
  })
  const push = (delta, finish = null) => {
    try {
      controller?.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model: req.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`))
    } catch {}
  }
  const sink = {
    open: () => push({ role: "assistant", content: "" }),
    text: (t) => push({ content: t }),
    thought: (t) => push({ reasoning_content: t }),
    toolCalls: (calls) => {
      for (const [i, c] of calls.entries()) push({ tool_calls: [{ index: i, id: c.id, type: "function", function: { name: c.name, arguments: c.args } }] })
    },
    note: (t) => push({ content: t }),
    done: (finish) => {
      try { controller?.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model: req.model,
        choices: [{ index: 0, delta: {}, finish_reason: finish }],
        ...(usageOf(quota?.()) ? { usage: usageOf(quota()) } : {}),
      })}\n\n`)) } catch {}
      try { controller?.enqueue(encoder.encode("data: [DONE]\n\n")) } catch {}
      try { controller?.close() } catch {}
      controller = null
    },
  }
  ;(async () => {
    try {
      await run(sink)
    } catch (e) {
      sink.note(`\n[Antigravity: ${String(e?.message ?? e)}]`)
      sink.done("stop")
    }
  })()
  return new Response(stream, { status: 200, headers: SSE_HEAD })
}

function wholeReply(req, turn, finish, signal) {
  let content = turn.text
  if (turn.error && !signal?.aborted) content += `${content ? "\n" : ""}[Antigravity: ${String(turn.error.message ?? turn.error)}]`
  const message = { role: "assistant", content }
  if (turn.thought) message.reasoning_content = turn.thought
  if (turn.calls.length) message.tool_calls = turn.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } }))
  return Response.json({
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: req.model,
    choices: [{ index: 0, message, finish_reason: finish }],
    ...(usageOf(turn.quota) ? { usage: usageOf(turn.quota) } : {}),
  })
}

// handleChat is the loader's fetch: the whole upstream. A prompt that fails
// before anything of the reply exists rejects: a lost sign-in marks the
// account expired, and a server that died under the request (or spoke a line
// that wasn't ACP) is retried once on a fresh one. Once the reply has
// started, an error rides as its tail — a reply is never doubled.
async function handleChat(getAuth, input, init, retried = false) {
  const auth = await getAuth()
  if (!auth || (auth.type !== "oauth" && auth.type !== "api")) throw expired("Antigravity is not signed in; sign in from the provider's page")
  // no local gate: the server decides where its sign-in lives, and a lost
  // one surfaces as the server refusing a prompt (-32000), which is marked
  // below, as it should be

  const req = parseChat(init?.body)
  const wantStream = req.stream === true
  const signal = init?.signal
  const { markdown, blocks } = buildPrompt(req)
  const prompt = []
  if (markdown) {
    // embeddedContext keeps the context one block; a server without it takes
    // the same text plainly
    prompt.push({ type: "resource", resource: { uri: `urn:magpie:antigravity-acp:context/${randomUUID()}`, mimeType: "text/markdown", text: markdown } })
  }
  prompt.push(...blocks)
  if (!prompt.length) throw new Error("the request's last user message is empty")

  const bridge = new Bridge(req.tools ?? [])
  if (!bridge.empty) await bridge.start()
  let conn
  let turn
  let stopUpdates = () => {}
  let onAbort = () => {}
  let cleanup = () => bridge.close()
  try {
    conn = await connectionFor(auth)
    const capabilities = await conn.initialize().then((i) => i?.agentCapabilities, () => null)
    turn = new Turn("")
    const session = await conn.newSession(workDir(), bridge.descriptor() ? [bridge.descriptor()] : [])
    turn.sessionId = session.sessionId
    await setSessionModel(conn, session, resolveServerId(String(req.model ?? ""), String(req.reasoning_effort ?? "")))
    // the history rides as one embedded context; a server without that
    // capability takes the same text plainly, and one without image input
    // takes a note instead of the picture
    const promptCaps = capabilities?.promptCapabilities ?? {}
    if (markdown && promptCaps.embeddedContext !== true) {
      const at = prompt.findIndex((b) => b.type === "resource")
      if (at >= 0) prompt.splice(at, 1, { type: "text", text: markdown })
    }
    if (promptCaps.image !== true) {
      for (let i = 0; i < prompt.length; i++) {
        if (prompt[i].type === "image") prompt.splice(i, 1, { type: "text", text: "[an image was omitted: this Antigravity server does not take image input]" })
      }
    }
    stopUpdates = conn.onSessionUpdate((params) => {
      if (params?.sessionId === session.sessionId) turn.update(params)
    })
    // from here the teardown has more to undo; the reply can also outlive
    // this function when it streams, so cleanup waits for the turn
    cleanup = () => { stopUpdates(); bridge.close() }
    if (!bridge.empty) bridge.onCall = (call) => turn.addCall(call.name, call.args)
    onAbort = () => { conn.cancel(session.sessionId); turn.finish(turn.calls.length ? "tool_calls" : "stop") }
    signal?.addEventListener("abort", onAbort, { once: true })
    if (signal?.aborted) onAbort()
    cleanup = () => {
      signal?.removeEventListener("abort", onAbort)
      stopUpdates()
      // the session is this request's own; the server is asked to close it
      // (whether a closed session lingers in the IDE's history is its call)
      try { conn.closeSession(session.sessionId) } catch {}
      bridge.close()
    }

    // a prompt whose wait runs out is cancelled on the server, not killed
    // with it: one long turn must not take down every other request the
    // pooled server is carrying
    const promptDone = conn
      .call("session/prompt", { sessionId: session.sessionId, prompt }, PROMPT_TIMEOUT, false)
    const promptReply = promptDone.promise.then((r) => {
      if (!r) return r
      turn.quota = noteQuota(r)
      return r
    })
    promptReply.catch((e) => {
      if (/didn't answer session\/prompt/.test(String(e?.message ?? ""))) { try { conn.cancel(session.sessionId) } catch {} }
    })

    // settleTurn ends the turn the first time the chat protocol must: the
    // prompt answered, a client tool was called, or the request was aborted.
    const settleTurn = async () => {
      const outcome = await Promise.race([
        turn.ended.then(() => "turn"),
        promptReply.then(() => "prompt", (e) => e),
      ])
      if (outcome === "turn") {
        // ended early (tool calls or an abort): the prompt is cancelled and
        // its wait given up, so the timeout can't later kill a server other
        // requests are still using
        conn.cancel(session.sessionId)
        promptDone.abandon()
      } else if (outcome instanceof Error) {
        turn.fail(outcome)
      } else {
        turn.finish(turn.calls.length ? "tool_calls" : stopOf(outcome))
      }
    }

    const finishOf = () => (turn.calls.length ? "tool_calls" : turn.stop === "length" ? "length" : "stop")

    if (wantStream) {
      // nothing goes out until the turn settles or the agent says something:
      // a prompt that fails before anything was said rejects below, so the
      // catch can mark the sign-in or retry on a fresh server — a reply is
      // never a 200 whose text is the error. Once the stream has started, an
      // error is only the reply's tail, so a half answer is never doubled.
      const settled = settleTurn()
      await Promise.race([settled, turn.firstSaid])
      if (turn.error && !turn.said && !signal?.aborted) throw turn.error
      return streamReply(req, async (sink) => {
        try {
          sink.open()
          // what the turn said while the reply was being decided goes first,
          // then the rest live as it arrives
          let pushedText = ""
          let pushedThought = ""
          const pump = () => {
            if (turn.thought.length > pushedThought.length) { sink.thought(turn.thought.slice(pushedThought.length)); pushedThought = turn.thought }
            if (turn.text.length > pushedText.length) { sink.text(turn.text.slice(pushedText.length)); pushedText = turn.text }
          }
          pump()
          turn.onEvent = pump
          await settled
          pump()
          if (turn.calls.length) sink.toolCalls(turn.calls)
          if (turn.error && !signal?.aborted) sink.note(`\n[Antigravity: ${String(turn.error.message ?? turn.error)}]`)
          sink.done(finishOf())
        } finally {
          cleanup()
        }
      }, () => onAbort(), () => turn.quota)
    }
    try {
      await settleTurn()
    } finally {
      cleanup()
    }
    // a turn that failed before it said anything is a failed request
    if (turn.error && !turn.said && !signal?.aborted) throw turn.error
    return wholeReply(req, turn, finishOf(), signal)
  } catch (e) {
    cleanup()
    // a server that died, spoke a line that wasn't ACP, or never started is
    // a broken transport: the request is tried once on a fresh one, but only
    // while nothing of the reply exists, so a reply is never doubled
    const transport = /isn't running|exited \(|could not be started|isn't ACP|doesn't read|one frame can hold/i.test(String(e?.message ?? e))
    if (transport && !retried && (!turn || !turn.said)) {
      pools.delete(auth.type === "api" ? "api" : "oauth")
      return handleChat(getAuth, input, init, true)
    }
    // a prompt the server refused as unauthenticated marks the account, so
    // magpie's routing can fail over: a lost sign-in arrives as the prompt's
    // answer error, not as a throw before it
    if (isAuthError(e)) throw expired("Antigravity asks to be signed in again")
    throw e
  }
}

const stopOf = (response) => {
  const r = String(response?.stopReason ?? "end_turn")
  if (r === "max_tokens") return "length"
  return "stop"
}

// ---- the plugin ------------------------------------------------------------

export const AntigravityAcpPlugin = async (input = {}) => {
  ctx.client = input.client ?? null
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: "Antigravity (ACP)",
        npm: "@ai-sdk/openai-compatible",
        api: API_BASE,
        models: FALLBACK_MODELS,
      }
    },

    auth: {
      provider: PROVIDER,
      async refresh() {
        // the marker never expires and the server's tokens are its own; a
        // really lost sign-in says so when a request is made (-32000)
        return undefined
      },
      async loader(getAuth) {
        return {
          baseURL: API_BASE,
          apiKey: "antigravity",
          async fetch(input2, init2) {
            return handleChat(getAuth, input2, init2)
          },
        }
      },
      methods: [
        { type: "oauth", label: "Sign in with Google (opens a browser)", authorize: googleSignIn },
        { type: "oauth", label: "Use Antigravity's current Google sign-in", authorize: currentSignIn },
        { type: "api", label: "Gemini API key", placeholder: "AIza…" },
      ],
      async usage() {
        // how the shared sign-in is doing, as the last prompt's answer said;
        // a really lost sign-in is marked by the request that finds it
        const windows = []
        if (lastQuota && typeof lastQuota.used === "number") {
          windows.push({
            name: "Antigravity quota",
            used: lastQuota.used,
            ...(lastQuota.resetsAt ? { resetsAt: lastQuota.resetsAt } : {}),
          })
        }
        return { plan: lastQuota?.tier || "Antigravity", windows }
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        const have = provider?.models ?? {}
        if (!auth) return have
        try {
          const list = await discoverModels(auth)
          const projected = projectModels(list)
          if (!projected.length) throw new Error("Antigravity listed no models")
          familyIndex = new Map(projected.map((m) => [m.id, { byEffort: m.byEffort, plain: m.plain }]))
          return Object.fromEntries(projected.map((m) => [m.id, magpieModel(provider, m)]))
        } catch (e) {
          if (isAuthError(e)) throw expired("Antigravity asks to be signed in again")
          throw e
        }
      },
    },
  }
}

// for tests
// shutdown is for tests: a suite lets its pooled servers go before it takes
// its temporary home away
const shutdown = () => {
  for (const [, p] of pools) { try { p.conn.kill() } catch {} }
  pools.clear()
}

export const _internal = {
  projectModels, resolveServerId, buildPrompt, parseChat, localAuth, configureDefaultAuth,
  Bridge, Turn, noteQuota, sessionModels, resolveLaunch, platformKey, setIndex: (m) => (familyIndex = m),
  AcpConnection, authDir, runtimeRoot, workDir, shutdown,
}
