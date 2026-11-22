// The one-click browser sign-in: the plugin's own dedicated browser profile
// opens quick.aws.com, the user signs in there (or is already signed in),
// and the session cookies are read back over the DevTools protocol — no
// pasting, the same shape as the moss/agnes sign-ins.
//
// Hard edges, the moss module's rules restated for Quick:
//   - never the everyday browser: only a dedicated profile directory under
//     the plugin's own name, and leftover processes are killed strictly by
//     their `--user-data-dir=<this profile>` command-line match;
//   - the login window carries no debug port (a debuggable window is not a
//     normal browser surface); the headless read afterwards opens CDP and
//     only touches the Network domain (Network.getAllCookies) — nothing is
//     evaluated or injected in the page;
//   - the sign-in result is the full Cookie header string the session rides
//     on, which importAccount then verifies and stores (named credentials
//     only, masked in logs).

import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ORIGIN } from "./session.mjs"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const LOGIN_URL = `${ORIGIN}/`

// the session rides on browser-level httpOnly cookies on quick.aws.com
// (recon: qs_lang, EXP_*, cwr_u, cwr_s, AMP_* — the names change, so the
// read is by domain, not by name). mbtc is NOT a cookie: it is the CSRF
// token the signed-in page's config carries. All of these cookies are
// httpOnly, so CDP's Network.getAllCookies is the only way to read them
// (document.cookie cannot see them).

// the same exclusive lock the moss module keeps: the login window, the
// headless read and a silent renewal all use this profile, and two browser
// instances on one profile delegate commands to each other (the later one
// exits at once)
let profileBusy = 0
const exclusive = async (fn, cancelled = () => false) => {
  while (profileBusy > 0) {
    if (cancelled()) throw new Error("another Quick sign-in is still using the browser profile")
    await sleep(200)
  }
  profileBusy += 1
  try {
    return await fn()
  } finally {
    profileBusy -= 1
  }
}

// the browsers this machine has, in try order; MAGPIE_QUICK_BROWSER overrides
export function browserCandidates(explicit) {
  if (explicit && typeof explicit === "string") {
    if (!existsSync(explicit)) throw new Error(`指定的浏览器不存在: ${explicit}`)
    return [explicit]
  }
  const env = process.env
  const out = []
  const push = (p) => {
    if (p && existsSync(p) && !out.includes(p)) out.push(p)
  }
  // a wrong path should say so, not quietly become another browser
  if (env.MAGPIE_QUICK_BROWSER && !existsSync(env.MAGPIE_QUICK_BROWSER)) {
    throw new Error(`MAGPIE_QUICK_BROWSER 指定的浏览器不存在: ${env.MAGPIE_QUICK_BROWSER}`)
  }
  if (env.MAGPIE_QUICK_BROWSER) push(env.MAGPIE_QUICK_BROWSER)
  const pf = env.ProgramFiles
  const pf86 = env["ProgramFiles(x86)"]
  const local = env.LOCALAPPDATA
  const home = env.HOME
  if (process.platform === "win32") {
    push(pf86 && join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"))
    push(pf && join(pf, "Microsoft", "Edge", "Application", "msedge.exe"))
    push(pf86 && join(pf86, "Google", "Chrome", "Application", "chrome.exe"))
    push(pf && join(pf, "Google", "Chrome", "Application", "chrome.exe"))
    push(local && join(local, "Google", "Chrome", "Application", "chrome.exe"))
    push(local && join(local, "Microsoft", "Edge", "Application", "msedge.exe"))
  } else if (process.platform === "darwin") {
    push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")
    push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    push("/Applications/Chromium.app/Contents/MacOS/Chromium")
    push(home && join(home, "Applications", "Chromium.app", "Contents", "MacOS", "Chromium"))
  } else {
    push("/usr/bin/microsoft-edge")
    push("/usr/bin/google-chrome")
    push("/usr/bin/google-chrome-stable")
    push("/usr/bin/chromium")
    push("/usr/bin/chromium-browser")
  }
  return out
}

// the browser to use; throws when none is installed
export function requireBrowser(explicit, { candidates = browserCandidates, platform = process.platform } = {}) {
  const list = candidates(explicit)
  if (list.length) return list[0]
  let msg =
    "The browser sign-in needs Microsoft Edge, Google Chrome or Chromium, and none is installed. " +
    "Sign in by pasting the Cookie header instead, or install one of those browsers, " +
    "or set MAGPIE_QUICK_BROWSER to its path."
  if (platform === "darwin") msg += " Safari can't be used: the sign-in runs in its own browser profile, which Safari doesn't support."
  throw new Error(msg)
}

// the plugin's own profile: a signed-in session stays here so the next
// sign-in (and a silent renewal) starts already signed in
export function profileDir(env = process.env, platform = process.platform) {
  if (env.MAGPIE_QUICK_PROFILE) return env.MAGPIE_QUICK_PROFILE
  if (platform === "win32") return join(env.LOCALAPPDATA || env.APPDATA || tmpdir(), "magpie", "quick-browser")
  return join(env.XDG_CONFIG_HOME || join(env.HOME || tmpdir(), ".config"), "magpie", "quick-browser")
}

// a one-off profile for a sign-in that is not kept
export function oneOffProfileDir() {
  return mkdtempSync(join(tmpdir(), "magpie-quick-login-"))
}

function browserArgs(profile, port, url, { headless = false, cdp = true } = {}) {
  const args = [`--user-data-dir=${profile}`]
  if (cdp) args.push(`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1")
  args.push("--no-first-run", "--no-default-browser-check", "--disable-background-mode")
  args.push("--window-size=1100,800", url)
  if (headless) args.unshift("--headless=new")
  return args
}

function browserEnv() {
  const env = { ...process.env }
  for (const key of ["__COMPAT_LAYER", "COMPAT_LAYER", "CHROME_HEADLESS", "ELECTRON_RUN_AS_NODE"]) delete env[key]
  return env
}

// kill only the processes whose command line carries this exact profile:
// never a name-based kill, never the everyday browser
function killProfileProcessesWindows(profile, log = () => {}) {
  try {
    const filter = String(profile).replace(/'/g, "''")
    spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "name like '%msedge%' or name like '%chrome%'" | ` +
          `Where-Object { $_.CommandLine -and ($_.CommandLine -match ('--user-data-dir=' + [regex]::Escape('${filter}') + '(\\s|$)') -or $_.CommandLine -match ('--user-data-dir="' + [regex]::Escape('${filter}') + '"')) } | ` +
          `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ],
      { stdio: "ignore", windowsHide: true, timeout: 30_000 },
    )
  } catch (e) {
    log(`cleaning leftover browsers failed: ${e?.message ?? e}`)
  }
}

function killProfileProcessesUnix(profile, log = () => {}) {
  try {
    const esc = String(profile).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const pattern = `--user-data-dir=${esc}([ "'/]|$)`
    spawnSync("pkill", ["-f", "--", pattern], { stdio: "ignore" })
  } catch (e) {
    log(`cleaning leftover browsers failed: ${e?.message ?? e}`)
  }
}

export function killProfileProcesses(profile, log = () => {}) {
  if (process.platform === "win32") killProfileProcessesWindows(profile, log)
  else killProfileProcessesUnix(profile, log)
}

// the profile is the plugin's to delete only when it is one of ours: the
// mkdtemp pattern, the default location, or a directory carrying the
// ownership marker. An env var pointing at the everyday browser's data is
// refused — never delete what the plugin did not create.
const PROFILE_MARKER = ".quick-profile"

function ownedProfile(dir, env = process.env, platform = process.platform) {
  const d = String(dir ?? "")
  if (!d) return false
  if (/(^|[\\/])magpie-quick-login-[^\\/]*$/.test(d)) return true
  if (d === profileDir(env, platform)) return true
  return existsSync(join(d, PROFILE_MARKER))
}

async function removeProfile(dir) {
  if (!dir || !existsSync(dir) || !ownedProfile(dir)) return !dir || !existsSync(dir)
  try {
    rmSync(join(dir, PROFILE_MARKER), { force: true })
  } catch {}
  for (let i = 0; i < 12; i++) {
    if (process.platform === "win32") {
      if (/[&^|<>"]/.test(dir)) {
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 500 })
          return true
        } catch {
          /* file lock: retry */
        }
      } else {
        const r = spawnSync("cmd", ["/c", "rmdir", "/s", "/q", dir], { stdio: "ignore", windowsHide: true })
        if (r.status === 0) return true
      }
    } else {
      const r = spawnSync("rm", ["-rf", dir], { stdio: "ignore" })
      if (r.status === 0) return true
    }
    await sleep(500)
  }
  return !existsSync(dir)
}

// our own window's title, by PID only — the everyday browser's windows are
// never looked at
export function windowTitleOf(pid, platform = process.platform) {
  if (platform !== "win32" || !pid) return ""
  try {
    const r = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue).MainWindowTitle`], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    })
    return String(r.stdout ?? "").trim()
  } catch {
    return ""
  }
}

// close gracefully so the browser flushes its cookies to disk; kill only
// when the graceful close times out
export async function closeWindowGracefully(child, { timeoutMs = 15_000, log = () => {} } = {}) {
  if (!child) return
  try {
    if (process.platform === "win32") {
      spawnSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${Number(child.pid)} -ErrorAction SilentlyContinue).CloseMainWindow()`], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 10_000,
      })
    } else {
      child.kill("SIGTERM")
    }
  } catch (e) {
    log(`graceful close failed: ${e?.message ?? e}`)
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return true
    await sleep(300)
  }
  log("graceful close timed out; forcing")
  killTree(child)
  return false
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return
  try {
    child.kill("SIGKILL")
  } catch {}
}

// the sign-in window carries NO debug port: it should look and behave like
// a normal browser. Completion is the window settling on a page that is not
// the sign-in page — Quick's start/chat is the signed-in surface, its title
// stabilises there. The window is closed by the plugin, not the user.
export async function waitForConsoleWindow(
  child,
  { timeoutMs = 8 * 60_000, pollMs = 1000, signal, log = () => {}, platform = process.platform, titleOf = windowTitleOf, settleMs = 5000 } = {},
) {
  const deadline = Date.now() + timeoutMs
  const started = Date.now()
  const canReadTitle = platform === "win32"
  const SIGNIN_PAGE = /sign.?in|login|auth|sso|register|captcha|验证|登录|登入/i
  let lastTitle = ""
  let hits = 0
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return "closed"
    if (signal?.aborted) return "aborted"
    if (!canReadTitle) {
      await sleep(pollMs)
      continue
    }
    const title = Date.now() - started >= settleMs ? titleOf(child.pid) : ""
    if (title && !SIGNIN_PAGE.test(title)) {
      if (title === lastTitle) {
        hits += 1
        if (hits >= 1) {
          log(`login window settled on "${title.slice(0, 60)}"; closing the window`)
          return "console"
        }
      } else {
        hits = 0
      }
      lastTitle = title
    } else {
      hits = 0
      if (title) lastTitle = ""
    }
    await sleep(pollMs)
  }
  return "timeout"
}

async function waitForDebugPort(portFile, child, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs
  let exited = false
  child.once("exit", () => {
    exited = true
  })
  while (Date.now() < deadline) {
    try {
      const port = Number(readFileSync(portFile, "utf8").split("\n")[0])
      if (Number.isInteger(port) && port > 0) {
        // a stale port file from a previous round only counts when the CDP
        // endpoint really answers
        const live = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
          .then((r) => r.ok)
          .catch(() => false)
        if (live) return port
      }
    } catch (e) {
      if (e?.name === "AbortError") {
        // the port is there but not answering: the browser is starting or
        // wedged; keep waiting on the same file
      }
      /* the file is not written yet */
    }
    if (exited) throw new Error("浏览器启动后立刻退出了（被策略拦截？）")
    await sleep(120)
  }
  throw new Error("浏览器没有写出调试端口，启动失败。请重试，或改用粘贴 Cookie 的登录方式。")
}

// the minimal CDP client the read needs: connect to the page target on our
// origin, Network.enable, Network.getAllCookies. Nothing is evaluated in the
// page, nothing is injected.
class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    ws.onmessage = (e) => this.dispatch(e)
    ws.onclose = () => {
      for (const { reject } of this.pending.values()) reject(new Error("browser debug connection closed"))
      this.pending.clear()
    }
  }

  static async connect(port, { timeoutMs = 20_000, preferHost = "" } = {}) {
    const deadline = Date.now() + timeoutMs
    let page = null
    while (Date.now() < deadline && !page) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })
        const list = await res.json()
        page =
          list.find(
            (t) =>
              t?.type === "page" &&
              t.webSocketDebuggerUrl &&
              (!preferHost || (typeof t.url === "string" && t.url.includes(preferHost))),
          ) ?? null
      } catch {
        /* the port may be up before any page target exists */
      }
      if (!page) await sleep(100)
    }
    if (!page) throw new Error("浏览器的调试端口没有可用的页面目标")
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("连接浏览器调试 WebSocket 超时")), 10_000)
      ws.onopen = () => {
        clearTimeout(timer)
        resolve()
      }
      ws.onerror = () => {
        clearTimeout(timer)
        reject(new Error("浏览器调试 WebSocket 连接失败"))
      }
    })
    return new Cdp(ws)
  }

  dispatch(e) {
    let msg
    try {
      msg = JSON.parse(typeof e.data === "string" ? e.data : "")
    } catch {
      return
    }
    if (msg?.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out`))
      }, 15_000)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e)
      }
    })
  }

  // dropping the reference without ws.close(): Bun on Windows can crash
  // natively when the CDP socket is closed and the process killed at once
  detach() {
    for (const { reject } of this.pending.values()) reject(new Error("browser debug connection closed"))
    this.pending.clear()
    this.ws = null
  }
}

// open a controlled browser on the plugin's profile; `cookies()` reads the
// browser-level cookie jar over CDP's Network domain
export async function openSession({ browserPath, profile, headless = false, url = LOGIN_URL, log = () => {} } = {}) {
  const exe = requireBrowser(browserPath)
  if (!existsSync(profile)) mkdirSync(profile, { recursive: true, mode: 0o700 })
  // the ownership marker bounds what removeProfile may ever delete
  try {
    writeFileSync(join(profile, PROFILE_MARKER), String(Date.now()))
  } catch {}
  const portFile = join(profile, "DevToolsActivePort")
  // a forced close can leave the port/singleton files behind; with no
  // browser running they are safe to clear
  for (const name of ["DevToolsActivePort", "SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try {
      rmSync(join(profile, name), { force: true })
    } catch {}
  }
  const child = spawn(exe, browserArgs(profile, 0, url, { headless }), { stdio: "ignore", env: browserEnv() })
  let cdp = null
  let closed = false
  // every cookie the quick.aws.com domain set — exact domain match (with a
  // dot-prefix or subdomain), never a substring match that would read a
  // lookalike domain's cookies
  const isSessionCookie = (c) => {
    if (!c?.value) return false
    const dom = String(c?.domain ?? "").replace(/^\./, "").toLowerCase()
    return dom === "quick.aws.com" || dom.endsWith(".quick.aws.com")
  }
  try {
    const port = await waitForDebugPort(portFile, child)
    log(`browser debug port ${port}`)
    cdp = await Cdp.connect(port, { preferHost: new URL(url).host })
    await cdp.send("Network.enable")
    return {
      async cookies() {
        const res = await cdp.send("Network.getAllCookies")
        return (res?.cookies ?? []).filter((c) => isSessionCookie(c) && c.value)
      },
      async close() {
        if (closed) return
        closed = true
        try {
          await Promise.race([cdp?.send("Browser.close"), sleep(1500)])
        } catch {
          /* the browser may already be gone */
        }
        cdp?.detach()
        killTree(child)
        killProfileProcesses(profile, log)
        await sleep(600)
      },
    }
  } catch (e) {
    cdp?.detach()
    killTree(child)
    killProfileProcesses(profile, log)
    await sleep(300)
    // never delete the profile here: it holds the signed-in session, and a
    // transient launch failure must not force a fresh sign-in
    throw e
  }
}

// poll the headless session until the session cookies are there
export async function waitForCookies(session, { timeoutMs = 30_000, pollMs = 750, signal, log = () => {} } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) throw Object.assign(new Error("the sign-in was cancelled"), { cancelled: true })
    try {
      const left = deadline - Date.now()
      const cookies = await Promise.race([session.cookies(), sleep(Math.min(left, 15_000)).then(() => [])])
      if (cookies.length) return cookies
    } catch (e) {
      log(`browser read retry: ${e?.message ?? e}`)
    }
    await sleep(pollMs)
  }
  throw new Error("登录超时：没有在浏览器里读到 Quick 的会话 cookie")
}

// the cookie jar → the one-line Cookie header string the plugin's session
// code expects, longest-name-first is irrelevant; order is the jar's
export function cookieHeaderOf(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ")
}

/**
 * The one-click sign-in: open the dedicated profile on quick.aws.com, wait
 * for the user's sign-in to land (or reuse the profile's existing session),
 * read the session cookies headlessly, and hand the Cookie header to the
 * caller — which verifies it exactly like a pasted one.
 */
export async function signInWithBrowser({ browserPath, keepSignIn = true, timeoutMs = 8 * 60_000, signal, log = () => {} } = {}) {
  // before the one-off profile is made, so a missing browser leaves no folder
  const exe = requireBrowser(browserPath)
  const dir = keepSignIn ? profileDir() : oneOffProfileDir()
  const cancelled = () => Boolean(signal?.aborted)
  return await exclusive(async () => {
    log("opening the sign-in window")
    killProfileProcesses(dir, log)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    try {
      const child = spawn(exe, browserArgs(dir, 0, LOGIN_URL, { cdp: false }), { stdio: "ignore", env: browserEnv() })
      try {
        const how = await waitForConsoleWindow(child, { timeoutMs, signal, log })
        log(`login window finished (${how})`)
        if (how === "aborted") throw Object.assign(new Error("the sign-in was cancelled"), { cancelled: true })
        // the sign-in landed (or the window was closed): let the page
        // settle, then close gracefully so the cookies flush to disk
        await sleep(2000)
      } finally {
        await closeWindowGracefully(child, { log })
        killProfileProcesses(dir, log)
        await sleep(1500)
      }
      // read the session from the profile, headlessly; one retry covers a
      // leftover process making the browser exit at once
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (cancelled()) throw Object.assign(new Error("the sign-in was cancelled"), { cancelled: true })
        log(`reading the session from the profile (attempt ${attempt}/2)`)
        let s
        try {
          s = await openSession({ browserPath: exe, profile: dir, headless: true, log })
          log("profile session open; waiting for the session cookies")
          const cookies = await waitForCookies(s, { timeoutMs: 30_000, signal, log })
          const header = cookieHeaderOf(cookies)
          if (!header) throw new Error("could not read the Quick session after the sign-in")
          log("session read")
          return header
        } catch (e) {
          if (cancelled()) throw Object.assign(new Error("the sign-in was cancelled"), { cancelled: true })
          if (attempt === 2) throw e
          log(`headless read failed (${e?.message ?? e}); cleaning the profile and retrying`)
          killProfileProcesses(dir, log)
          await sleep(1200)
        } finally {
          await s?.close().catch(() => {})
        }
      }
    } finally {
      if (!keepSignIn) await removeProfile(dir)
    }
  })
}
