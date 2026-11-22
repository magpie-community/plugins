// One long-lived Chrome (the plugin's own profile, already signed in)
// attached over CDP. Every chat request runs INSIDE the page as a fetch
// to StreamGenerate, so Google sees the browser's own TLS and cookies —
// a bare Node client gets /sorry on this network, the page does not.
//
// signIn opens a window of the plugin's own at Google's sign-in page (the
// old gemini-web plugin's way): the user signs in there themselves, the
// plugin reads the profile's cookies through DevTools and closes the
// window. The profile is kept, so the same sign-in also serves the
// long-lived relay browser.
import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import createWebSocket from "ws"

export const SIGN_IN_URL = "https://accounts.google.com/ServiceLogin?continue=" + encodeURIComponent("https://gemini.google.com/app")
const GEMINI_URL = "https://gemini.google.com/app"
// the cookies a signed-in session must have
const NEED = ["__Secure-1PSID", "__Secure-1PSIDTS"]

// profileRoot is where THIS plugin keeps its own browser profiles. It is
// the plugin's own directory (like moss's and quick's): a sign-in made
// through this plugin's window lives here, and nothing outside it is read
// or written.
export function profileRoot(env = process.env, platform = process.platform) {
  if (env.GEMINI_WEB_RELAY_PROFILE_ROOT) return env.GEMINI_WEB_RELAY_PROFILE_ROOT
  if (platform === "win32") return join(env.LOCALAPPDATA || env.APPDATA || tmpdir(), "magpie", "gemini-web-relay-browser")
  return join(env.XDG_CONFIG_HOME || join(env.HOME || tmpdir(), ".config"), "magpie", "gemini-web-relay-browser")
}

// googleCookies keeps the cookies a request to gemini.google.com carries.
export function googleCookies(list) {
  const out = {}
  for (const c of list ?? []) {
    const d = String(c?.domain ?? "").replace(/^\./, "")
    if (d !== "google.com" && d !== "gemini.google.com") continue
    if ((c.path ?? "/") !== "/") continue
    if (typeof c.name === "string" && typeof c.value === "string") out[c.name] = c.value
  }
  return out
}

const hasSession = (cookies) => NEED.every((n) => cookies[n])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  // a port Chromium can bind: the OS picks a free one, and the fixed
  // --remote-debugging-port is reachable at once (a port of 0 plus the
  // DevToolsActivePort file was racy: the file said a port the socket
  // hadn't opened yet)
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.on("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

function waitExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((r) => {
    const t = setTimeout(r, ms)
    child.once("exit", () => {
      clearTimeout(t)
      r()
    })
  })
}

// cdpOnce sends one command to the browser target and answers its result.
async function cdpOnce(port, method, params = {}, timeout = 5000) {
  const v = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json())
  const url = v?.webSocketDebuggerUrl
  if (!url) throw new Error("no DevTools endpoint")
  return await new Promise((resolve, reject) => {
    const ws = new createWebSocket(url, { perMessageDeflate: false })
    const timer = setTimeout(() => {
      try { ws.close() } catch {}
      reject(new Error("DevTools timed out"))
    }, timeout)
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, method, params })))
    ws.on("error", () => {
      clearTimeout(timer)
      reject(new Error("DevTools connection failed"))
    })
    ws.on("message", (buf) => {
      let m
      try { m = JSON.parse(buf.toString()) } catch { return }
      if (m.id !== 1) return
      clearTimeout(timer)
      try { ws.close() } catch {}
      if (m.error) reject(new Error(m.error.message || method + " failed"))
      else resolve(m.result)
    })
  })
}

// openWindow starts Chrome on profile at url and answers a handle that
// reads its cookies and closes it.
export async function openWindow(profile, url, { headless = false, browser = findChrome() } = {}) {
  if (!browser) {
    throw Object.assign(new Error("没有找到 Chrome、Edge 或 Chromium。请先安装 Chrome，或用 GEMINI_WEB_RELAY_BROWSER 指定浏览器。"), { code: "browser_missing" })
  }
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  const port = await freePort()
  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-background-mode",
    "--disable-features=DeviceBoundSessionCredentials",
    ...(headless ? ["--headless=new"] : ["--new-window"]),
    url,
  ]
  const child = spawn(browser, args, { stdio: "ignore", detached: false, windowsHide: false })
  let exited = false
  child.once("error", () => (exited = true))
  child.once("exit", () => (exited = true))
  // the DevTools port is the one asked for; wait until it answers
  const ready = (async () => {
    const end = Date.now() + 15000
    while (Date.now() < end) {
      try {
        await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })
        return port
      } catch {}
      if (exited) throw new Error("浏览器没有起来就退出了")
      await sleep(250)
    }
    throw new Error("浏览器没有开放 DevTools 端口")
  })()
  return {
    get exited() {
      return exited
    },
    async cookies() {
      const r = await cdpOnce(await ready, "Storage.getCookies")
      return googleCookies(r?.cookies)
    },
    async close() {
      if (!exited) {
        try { child.kill("SIGTERM") } catch {}
        await waitExit(child, 2000)
      }
      if (!exited) {
        try { child.kill("SIGKILL") } catch {}
        await waitExit(child, 1000)
      }
    },
  }
}

// signIn opens the window and waits (up to timeout) for the user to sign
// in, then answers the cookies. It answers null when the window was
// closed or the time ran out.
export async function signIn(profile, { timeout = 5 * 60_000, poll = 1000, settle = 2500, opener = openWindow } = {}) {
  const b = await opener(profile, SIGN_IN_URL)
  try {
    const end = Date.now() + timeout
    while (Date.now() < end && !b.exited) {
      const c = await b.cookies().catch(() => null)
      if (c && hasSession(c)) {
        // let the redirect to gemini.google.com finish, so the cookies it
        // sets are in the jar too
        await sleep(settle)
        return (await b.cookies().catch(() => null)) ?? c
      }
      await sleep(poll)
    }
    return null
  } finally {
    await b.close()
  }
}

export function findChrome(env = process.env) {
  if (env.GEMINI_WEB_RELAY_BROWSER && existsSync(env.GEMINI_WEB_RELAY_BROWSER)) return env.GEMINI_WEB_RELAY_BROWSER
  const candidates = [
    join(env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
    join(env.PROGRAMFILES || "", "Google/Chrome/Application/chrome.exe"),
    join(env["PROGRAMFILES(X86)"] || "", "Google/Chrome/Application/chrome.exe"),
    join(env.PROGRAMFILES || "", "Microsoft/Edge/Application/msedge.exe"),
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
  ]
  return candidates.find((p) => p && existsSync(p)) ?? ""
}

export class RelayBrowser {
  constructor({ profileDir, headless = true } = {}) {
    this.profileDir = profileDir
    this.headless = headless
    this.proc = null
    this.ws = null
    this.port = null
    this.mid = 0
    this.pending = new Map()
    this.events = []
    this._waiters = []
    this._page = null
    this._starting = null
    this.tmpProfile = null
  }

  started() {
    return !!this.ws && this.ws.readyState === 1 && !!this._page
  }

  async ensure() {
    if (this.started()) return this._page
    if (!this._starting)
      this._starting = this._start().finally(() => {
        this._starting = null
      })
    return this._starting
  }

  async _start() {
    if (!this.profileDir) {
      this.tmpProfile = mkdtempSync(join(tmpdir(), "gwr-"))
      this.profileDir = this.tmpProfile
    }
    const chrome = findChrome()
    if (!chrome) throw new Error("没有找到 Chrome/Edge，无法启动浏览器中继。")
    this.port = await freePort()
    const args = [
      `--user-data-dir=${this.profileDir}`,
      this.headless ? "--headless=new" : "--window-size=1280,900",
      `--remote-debugging-port=${this.port}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-features=DeviceBoundSessionCredentials",
      "about:blank",
    ]
    this.proc = spawn(chrome, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    this.proc.on("exit", () => {
      this.ws = null
      this._page = null
    })
    await this._waitPort()
    const ver = await fetch(`http://127.0.0.1:${this.port}/json/version`).then((r) => r.json())
    await this._connect(ver.webSocketDebuggerUrl)
    this._page = await this.newPage("https://gemini.google.com/app")
    await this._page.send("Page.navigate", { url: "https://gemini.google.com/app" })
    await new Promise((r) => setTimeout(r, 9000))
    return this._page
  }

  _waitPort() {
    // the port was fixed before the spawn; wait until DevTools answers
    const end = Date.now() + 20000
    return new Promise((res, rej) => {
      const tryOnce = async () => {
        try {
          await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(1000) })
          res()
        } catch {
          if (Date.now() < end) setTimeout(tryOnce, 250)
          else rej(new Error("Chrome 没有在 20s 内开放 DevTools 端口"))
        }
      }
      tryOnce()
    })
  }

  _connect(url) {
    return new Promise((res, rej) => {
      this.ws = new createWebSocket(url, { perMessageDeflate: false })
      this.ws.once("open", res)
      this.ws.once("error", rej)
      this.ws.on("message", (buf) => {
        const msg = JSON.parse(buf.toString())
        if (msg.id && this.pending.has(msg.id)) {
          const { res, rej } = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          msg.error ? rej(new Error(msg.error.message)) : res(msg.result)
        } else if (msg.method) {
          this.events.push(msg)
          this._waiters = this._waiters.filter((w) => !w(msg))
        }
      })
    })
  }

  send(method, params = {}, sessionId) {
    const id = ++this.mid
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej })
      this.ws.send(JSON.stringify(payload))
    })
  }

  async newPage(url) {
    const { targetId } = await this.send("Target.createTarget", { url, newWindow: false })
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true })
    const page = new RelayPage(this, targetId, sessionId)
    await page.send("Page.enable")
    await page.send("Runtime.enable")
    return page
  }

  async stop() {
    try { this.ws?.close() } catch {}
    try { this.proc?.kill() } catch {}
    if (this.tmpProfile) {
      try { rmSync(this.tmpProfile, { recursive: true, force: true }) } catch {}
    }
    await new Promise((r) => {
      this.proc?.once("exit", r)
      setTimeout(r, 3000)
    })
  }
}

export class RelayPage {
  constructor(browser, targetId, sessionId) {
    this.b = browser
    this.targetId = targetId
    this.sessionId = sessionId
  }
  send(method, params = {}) {
    return this.b.send(method, params, this.sessionId)
  }
  async eval(expression, awaitPromise = true) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, userGesture: true })
    if (r.exceptionDetails) throw new Error("page eval failed: " + JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result?.value
  }
  async close() {
    try { await this.b.send("Target.closeTarget", { targetId: this.targetId }) } catch {}
  }
}
