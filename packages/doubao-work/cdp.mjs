// A small Chrome DevTools Protocol driver for desktop apps built on
// Chromium. It knows nothing about any one app: an adapter (doubao.mjs)
// says which binary to start, which page to drive and what to do there.
//
// The app runs from a profile of its own (a user-data-dir under the
// plugin's folder), so it never touches the user's everyday copy of the
// app, and Chromium allows remote debugging only for such a profile. The
// debugging port is one this driver picked and saved beside the profile,
// so a later request finds the same running app instead of starting
// another.
import { execFileSync, spawn as nodeSpawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"

// sleep waits ms, or rejects at once when signal is (or becomes) aborted.
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? Error("aborted"))
    const stop = () => { clearTimeout(t); reject(signal.reason ?? Error("aborted")) }
    const t = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve() }, ms)
    signal?.addEventListener("abort", stop, { once: true })
  })

// freePort asks the system for a port no one holds, then lets it go. The
// app is started on it a moment later.
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.unref()
    s.on("error", reject)
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}

async function getJSON(url, ms = 1500, fetchImpl = fetch) {
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(ms) })
  if (!r.ok) throw Error(`${url}: HTTP ${r.status}`)
  return r.json()
}

// targets lists the pages of the app on port, or null when nothing (or
// something that isn't a DevTools endpoint) answers there.
export async function targets(port, fetchImpl = fetch) {
  try {
    const list = await getJSON(`http://127.0.0.1:${port}/json/list`, 1500, fetchImpl)
    return Array.isArray(list) ? list : null
  } catch {
    return null
  }
}

// copies lists the command lines of the processes running binary itself
// (not its helpers), or none where they can't be read. On Windows they come
// from WMI (#1117): there Chromium keeps one copy per profile, so a copy
// the user opened doesn't keep this one from starting, but the plugin's
// own copy, still up on its profile, must be found rather than started
// again.
export function copies(binary, platform = process.platform, run = execFileSync) {
  if (platform === "win32") {
    const exe = path.win32.basename(binary).replace(/'/g, "''")
    let out = ""
    try {
      out = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter "Name='${exe}'" -ErrorAction SilentlyContinue | ForEach-Object { $_.CommandLine }`], { encoding: "utf8", timeout: 15000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })
    } catch {
      return []
    }
    return String(out).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.includes("--type="))
  }
  let out = ""
  try {
    out = run("ps", ["-axww", "-o", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  } catch {
    return []
  }
  return String(out).split("\n").map((l) => l.trim()).filter((l) => l === binary || l.startsWith(binary + " "))
}

// portIn is the --remote-debugging-port a command line names, else 0
export function portIn(line) {
  const m = /--remote-debugging-port=(\d+)/.exec(line)
  const n = m ? Number(m[1]) : 0
  return n > 0 && n < 65536 ? n : 0
}

// App starts and finds one Chromium-based desktop app run from its own
// profile.
//   binary   the executable
//   dataDir  the plugin's folder for this app: profile/ and port live here
//   owns     (targets) => true when the pages on a port are this app's,
//            so a port another program took since is never driven
//   args     more command-line switches
//   others   () => the command lines of the app's running copies; one
//            that isn't on this profile keeps a single-instance app (as
//            Doubao is) from starting a second copy at all
export class App {
  constructor({ binary, dataDir, owns, args = [], spawn = nodeSpawn, fetchImpl = fetch, others, platform = process.platform }) {
    Object.assign(this, { binary, dataDir, owns, args, spawn, fetchImpl, platform })
    this.others = others ?? (() => copies(binary, platform))
    this.profile = path.join(dataDir, "profile")
    this.portFile = path.join(dataDir, "port")
  }

  savedPort() {
    try {
      const n = Number(fs.readFileSync(this.portFile, "utf8").trim())
      return Number.isInteger(n) && n > 0 && n < 65536 ? n : 0
    } catch {
      return 0
    }
  }

  // running gives the port of this app when it is up, else 0.
  async running() {
    const port = this.savedPort()
    if (!port) return 0
    const list = await targets(port, this.fetchImpl)
    return list && this.owns(list) ? port : 0
  }

  // waitOn waits until the pages on port are this app's, then saves port
  async waitOn(port, until, signal) {
    while (Date.now() < until) {
      await sleep(400, signal)
      const list = await targets(port, this.fetchImpl)
      if (list && this.owns(list)) {
        fs.writeFileSync(this.portFile, String(port))
        return port
      }
    }
    throw Object.assign(Error(`${path.basename(this.binary)} did not open its debugging port in ${Math.round((until - this.startedAt) / 1000)}s`), { code: "app_start_timeout" })
  }

  // start runs the app when it isn't running yet and waits until its pages
  // answer. It never stops or kills anything: a port someone else holds is
  // left to them and the app is started on another. A copy already up on
  // this profile is waited for on its own port, never started again: a
  // single-instance app hands a second launch to it and keeps the old port
  // (#1117), and the port file is written only once a port is seen to be
  // this app's.
  async start({ timeout = 45000, signal } = {}) {
    const up = await this.running()
    if (up) return up
    if (!fs.existsSync(this.binary)) throw Object.assign(Error(`${this.binary} is not installed`), { code: "app_missing" })
    this.startedAt = Date.now()
    const until = this.startedAt + timeout
    const mine = `--user-data-dir=${this.profile}`
    const others = this.others()
    const own = others.map(portIn).find((n, i) => n && others[i].includes(mine))
    if (own) return this.waitOn(own, until, signal)
    // A copy the user opened themselves takes the new one's launch and
    // the new one quits: there would be nothing to wait for. Its profile
    // can't be driven either (Chromium allows debugging only off the
    // default profile), so the user has to quit it. Windows keeps a copy
    // per profile, so there it is no hindrance.
    if (this.platform !== "win32" && others.some((c) => !c.includes(mine)))
      throw Object.assign(Error(`${path.basename(this.binary)} is already running from another profile`), { code: "app_busy" })
    fs.mkdirSync(this.profile, { recursive: true })
    const port = await freePort()
    const child = this.spawn(this.binary, [`--remote-debugging-port=${port}`, `--user-data-dir=${this.profile}`, ...this.args], {
      detached: true,
      stdio: "ignore",
    })
    child.unref?.()
    return this.waitOn(port, until, signal)
  }
}

// Page is one CDP session on a page target.
export class Page {
  static async open(port, pick, { fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket } = {}) {
    const list = (await targets(port, fetchImpl)) ?? []
    const t = list.find((x) => x.type === "page" && pick(x))
    if (!t?.webSocketDebuggerUrl) return null
    const page = new Page(t, WebSocketImpl)
    await page.ready
    return page
  }

  constructor(target, WebSocketImpl) {
    this.target = target
    this.id = 0
    this.pending = new Map()
    this.closed = false
    this.ws = new WebSocketImpl(target.webSocketDebuggerUrl)
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve()
      this.ws.onerror = (e) => reject(Error("DevTools connection failed: " + (e?.message ?? "error")))
    })
    this.ws.onmessage = (m) => {
      let d
      try { d = JSON.parse(typeof m.data === "string" ? m.data : String(m.data)) } catch { return }
      const p = this.pending.get(d.id)
      if (!p) return
      this.pending.delete(d.id)
      if (d.error) p.reject(Error(`${p.method}: ${d.error.message}`))
      else p.resolve(d.result)
    }
    this.ws.onclose = () => {
      this.closed = true
      for (const p of this.pending.values()) p.reject(Error("DevTools connection closed"))
      this.pending.clear()
    }
  }

  call(method, params = {}) {
    if (this.closed) return Promise.reject(Error("DevTools connection closed"))
    return new Promise((resolve, reject) => {
      const id = ++this.id
      this.pending.set(id, { resolve, reject, method })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  // eval runs an expression in the page and gives back its value (awaited
  // when it is a promise). A page-side exception becomes an Error here.
  async eval(expression) {
    const r = await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
    if (r?.exceptionDetails) {
      const d = r.exceptionDetails
      throw Error("page: " + (d.exception?.description ?? d.text ?? "exception").split("\n")[0])
    }
    return r?.result?.value
  }

  // key presses one key the way a user's keyboard does.
  async key(key, { code = key, keyCode = 0, text, modifiers = 0 } = {}) {
    await this.call("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, text, modifiers })
    await this.call("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, modifiers })
  }

  close() {
    this.closed = true
    try { this.ws.close() } catch {}
  }
}

export { sleep }
