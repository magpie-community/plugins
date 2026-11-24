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
export const ACCOUNTS_URL = "https://accounts.google.com/"
const GEMINI_URL = "https://gemini.google.com/app"
// the cookies a signed-in session must have
const NEED = ["__Secure-1PSID", "__Secure-1PSIDTS"]

// profileRoot is where THIS plugin keeps its own browser profiles. It is
// the plugin's own directory (like moss's and quick's): a sign-in made
// through this plugin's window lives here, and nothing outside it is read
// or written.
export function profileRoot(env = process.env, platform = process.platform) {
  if (env.GEMINI_RELAY_PROFILE_ROOT) return env.GEMINI_RELAY_PROFILE_ROOT
  if (platform === "win32") return join(env.LOCALAPPDATA || env.APPDATA || tmpdir(), "magpie", "gemini-relay-browser")
  return join(env.XDG_CONFIG_HOME || join(env.HOME || tmpdir(), ".config"), "magpie", "gemini-relay-browser")
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

// googleEmail reads the signed-in account's own email from the profile's
// cookie jar — the __Secure-1PAPISID cookie's value is the account email
// base64url-encoded (a long-standing Google convention). This needs no
// page load at all: no /sorry can hide it, and the jar on disk is the one
// the sign-in just flushed.
export function googleEmailFromCookies(cookies) {
  const v = cookies?.["__Secure-1PAPISID"]
  if (typeof v !== "string" || v.length < 8) return ""
  try {
    const b64 = v.replace(/-/g, "+").replace(/_/g, "/")
    const s = Buffer.from(b64, "base64").toString("utf8")
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : ""
  } catch {
    return ""
  }
}


// pageEmail starts a browser of its own on the signed profile, sitting on
// Google's accounts page (the one page of the ecosystem that is never
// /sorry-ed), and reads the signed-in account's email from its HTML — the
// app page itself is the one risk control replaces. The caller passes a
// browser already started on ACCOUNTS_URL (see RelayBrowser's startUrl):
// nothing is navigated, because the relay's chat lives in its own page and
// a name read must never move it.
//
// The account page is a heavy page that resolves and hydrates at its own
// pace (a cold profile, a slow proxy), so the email is polled for instead
// of assumed after one fixed wait: a fixed 6 s read came back empty on a
// first launch and lost the name for no reason.
export async function pageEmail(browser, { timeout = 30_000, poll = 1000 } = {}) {
  try {
    const page = await browser.ensure()
    if (!page) return ""
    const read = `(() => {
      const html = document.documentElement.innerHTML
      return (html.match(/"oPEP7c":"([^"]+)"/) || [])[1] || ""
    })()`
    const end = Date.now() + timeout
    let last = ""
    while (Date.now() < end) {
      try {
        const t = await page.eval(read)
        if (t) return t
        last = t || last
      } catch {
        // the page may still be navigating; keep polling
      }
      await new Promise((r) => setTimeout(r, poll))
    }
    return last || ""
  } catch {
    return ""
  }
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
export async function openWindow(profile, url, { headless = false, browser = findChrome(), proxy = proxyFor() } = {}) {
  if (!browser) {
    throw Object.assign(new Error("没有找到 Chrome、Edge 或 Chromium。请先安装 Chrome，或用 GEMINI_RELAY_BROWSER 指定浏览器。"), { code: "browser_missing" })
  }
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  const port = await freePort()
  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    ...proxyArgs(proxy),
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
      // Browser.close asks Chrome to shut itself down cleanly, which is
      // what flushes the cookie jar to the profile's disk database. A
      // signal kill (SIGTERM is TerminateProcess on Windows) dies before
      // that flush: the sign-in's session cookies would never land in the
      // profile. Signals stay only as a last resort.
      if (!exited) {
        try {
          await cdpOnce(await ready, "Browser.close", {}, 8000)
          await waitExit(child, 8000)
        } catch {}
      }
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
    // the user may have closed the window right after signing in — a
    // graceful close that flushed the cookies. One last read before
    // giving up decides between "signed in" and "gave up".
    if (b.exited) {
      const c = await b.cookies().catch(() => null)
      if (c && hasSession(c)) return c
    }
    return null
  } finally {
    await b.close()
  }
}

// proxyFor answers the proxy URL Chrome should be launched with. On many
// networks gemini.google.com and accounts.google.com are unreachable
// directly and only answer through a local proxy — and Chrome does NOT pick
// one up from HTTPS_PROXY the way Node does, so a launch without it dies on
// chrome-error://chromewebdata and every sign-in ends after five minutes of
// nothing. An explicit GEMINI_RELAY_PROXY wins; otherwise the standard
// proxy variables are read. "" means "no proxy flag" (a direct connection).
export function proxyFor(env = process.env) {
  const direct = env.GEMINI_RELAY_PROXY
  if (direct === "none" || direct === "direct") return ""
  if (direct) return String(direct).trim()
  const raw =
    env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy || ""
  const v = String(raw).trim()
  if (!v) return ""
  // Chrome wants http(s)://host:port; socks5:// is understood too, but a
  // bare host:port needs its scheme spelled out
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : "http://" + v
}

// proxyArgs is the Chrome flag list for a proxy (none when there is none).
// Chrome bypasses loopback by default, and that is what the DevTools port
// needs — no bypass override is passed, so 127.0.0.1 stays direct.
export function proxyArgs(proxy) {
  if (!proxy) return []
  return [`--proxy-server=${proxy}`]
}

export function findChrome(env = process.env, platform = process.platform) {
  if (env.GEMINI_RELAY_BROWSER && existsSync(env.GEMINI_RELAY_BROWSER)) return env.GEMINI_RELAY_BROWSER
  const candidates =
    platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
      : platform === "win32"
        ? [
            join(env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
            join(env.PROGRAMFILES || "", "Google/Chrome/Application/chrome.exe"),
            join(env["PROGRAMFILES(X86)"] || "", "Google/Chrome/Application/chrome.exe"),
            join(env.PROGRAMFILES || "", "Microsoft/Edge/Application/msedge.exe"),
          ]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"]
  return candidates.find((p) => p && existsSync(p)) ?? ""
}

export class RelayBrowser {
  constructor({ profileDir, headless = true, startUrl = null, proxy = proxyFor() } = {}) {
    this.profileDir = profileDir
    this.headless = headless
    // where the page starts. The relay itself wants the app page (its chat
    // runs inside it); a name read wants accounts.google.com instead, so it
    // asks for that page up front rather than navigating away later.
    this.startUrl = startUrl
    // the app page needs its own script to come up before a chat runs in it;
    // a name read polls the page itself (pageEmail), so it waits less here
    this.startSettle = startUrl ? 2000 : 9000
    // Chrome does not read HTTPS_PROXY by itself; without this the page
    // never loads on a network where Google is only reachable through one
    this.proxy = proxy ?? ""
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
    this.rotator = null
    // the rotator factory is injectable so tests can stub it; production
    // wires the real one in index.mjs via browser.rotatorFactory
    this.rotatorFactory = null
    // page→node push channel: the page function installs a binding and
    // calls it per delta; onDelta handlers run here (the events array is
    // a poll fallback, but a live handler avoids the 350 ms poll lag)
    this.deltaHandlers = new Set()
  }

  // onDelta registers a handler for the page's streaming deltas. It fires
  // from Runtime.bindingCalled events for the given binding name; the
  // handler receives the parsed payload the page passed. Returns an
  // unsubscribe function.
  onDelta(name, fn) {
    const h = (msg) => {
      if (msg.method !== "Runtime.bindingCalled") return
      if (msg.params?.name !== name) return
      let payload = msg.params.payload
      try { payload = JSON.parse(payload) } catch {}
      fn(payload)
    }
    this.deltaHandlers.add(h)
    return () => this.deltaHandlers.delete(h)
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
    // a previous life of this browser must be gone first: a second Chrome
    // on the same profile dies on the singleton lock, and the old one
    // would leak
    await this.stop().catch(() => {})
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
      ...proxyArgs(this.proxy),
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-features=DeviceBoundSessionCredentials",
      "about:blank",
    ]
    this.proc = spawn(chrome, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    // keep the pipes drained: a full stdout/stderr buffer would otherwise
    // stall Chrome's logging (and, observed in testing, its exit)
    this.proc.stdout?.resume()
    this.proc.stderr?.resume()
    this.proc.on("exit", () => {
      this.ws = null
      this._page = null
      this.rotator?.stop?.()
    })
    await this._waitPort()
    const ver = await fetch(`http://127.0.0.1:${this.port}/json/version`).then((r) => r.json())
    await this._connect(ver.webSocketDebuggerUrl)
    const startUrl = this.startUrl || "https://gemini.google.com/app"
    this._page = await this.newPage(startUrl)
    await this._page.send("Page.navigate", { url: startUrl })
    await new Promise((r) => setTimeout(r, this.startSettle))
    // the session cookies rotate on Google's own schedule; keep them fresh
    // best-effort (a failure is logged upstream, never fatal)
    this.rotator = this.rotatorFactory?.(this) ?? null
    this.rotator?.start?.()
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
      // a dropped DevTools socket must fail the requests waiting on it —
      // otherwise every pending send() promise hangs forever
      this.ws.on("close", () => {
        for (const { rej } of this.pending.values()) rej(new Error("DevTools 连接已断开"))
        this.pending.clear()
      })
      this.ws.on("message", (buf) => {
        const msg = JSON.parse(buf.toString())
        if (msg.id && this.pending.has(msg.id)) {
          const { res, rej } = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          msg.error ? rej(new Error(msg.error.message)) : res(msg.result)
        } else if (msg.method) {
          for (const h of this.deltaHandlers) h(msg)
          this.events.push(msg)
          this._waiters = this._waiters.filter((w) => !w(msg))
        }
      })
    })
  }

  send(method, params = {}, sessionId, timeoutMs) {
    const id = ++this.mid
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((res, rej) => {
      if (timeoutMs) {
        const t = setTimeout(() => {
          if (this.pending.delete(id)) rej(new Error(method + " timed out"))
        }, timeoutMs)
        t.unref?.()
      }
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

  // installBinding exposes `window[name](payload)` inside the page; every
  // call arrives here as a Runtime.bindingCalled event. The page function
  // uses it to push reply deltas the moment it reads them, instead of the
  // caller waiting for the whole turn.
  async installBinding(page, name) {
    await page.send("Runtime.addBinding", { name })
  }

  async stop() {
    // Browser.close asks Chrome to shut down cleanly, which releases the
    // files a bare kill leaves "Device or resource busy" on Windows. The
    // exit is waited for explicitly: only a dead Chrome lets the temp
    // profile be removed.
    if (this.ws && this.proc && this.proc.exitCode === null) {
      try { await this.send("Browser.close", {}, undefined, 5000) } catch {}
    }
    try { this.ws?.close() } catch {}
    if (this.proc && this.proc.exitCode === null) {
      try { this.proc.kill() } catch {}
      await new Promise((r) => {
        this.proc.once("exit", r)
        setTimeout(r, 5000)
      })
    }
    if (this.tmpProfile) {
      try { rmSync(this.tmpProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch {}
      this.tmpProfile = null
      this.profileDir = null // a temp profile is gone; a restart makes a fresh one
    }
    this.rotator?.stop?.()
    this.rotator = null
    this.ws = null
    this._page = null
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
