// Sign-in through a browser window of the plugin's own: Chrome (or Edge,
// Chromium, Brave) with a private profile, opened at Google's sign-in page.
// The user signs in there themselves; the plugin never sees a password.
// It reads the profile's google.com cookies through the browser's own
// DevTools endpoint (Storage.getCookies on the browser target: nothing is
// attached to the page the user types into) and closes the window. The
// profile is kept: when the cookies stop working, the same profile is
// opened again without a window and the browser renews them itself.
import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const SIGN_IN = "https://accounts.google.com/ServiceLogin?continue=" + encodeURIComponent("https://gemini.google.com/app")
const GEMINI = "https://gemini.google.com/app"
const NEED = ["__Secure-1PSID", "__Secure-1PSIDTS"]

export function profileRoot(env = process.env, platform = process.platform) {
  if (env.GEMINI_WEB_PROFILE) return env.GEMINI_WEB_PROFILE
  if (platform === "win32") return join(env.LOCALAPPDATA || env.APPDATA || tmpdir(), "magpie", "gemini-web-browser")
  return join(env.XDG_CONFIG_HOME || join(env.HOME || tmpdir(), ".config"), "magpie", "gemini-web-browser")
}

export function findBrowser(platform = process.platform, env = process.env) {
  if (env.GEMINI_WEB_BROWSER && existsSync(env.GEMINI_WEB_BROWSER)) return env.GEMINI_WEB_BROWSER
  const home = env.HOME || ""
  const candidates =
    platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        ]
      : platform === "win32"
        ? [
            join(env.PROGRAMFILES || "", "Google/Chrome/Application/chrome.exe"),
            join(env["PROGRAMFILES(X86)"] || "", "Google/Chrome/Application/chrome.exe"),
            join(env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
            join(env.PROGRAMFILES || "", "Microsoft/Edge/Application/msedge.exe"),
            join(env["PROGRAMFILES(X86)"] || "", "Microsoft/Edge/Application/msedge.exe"),
          ]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium", "/usr/bin/microsoft-edge"]
  return candidates.find((p) => p && existsSync(p)) ?? ""
}

/** 本机真实存在的候选浏览器（Chrome 优先，与 findBrowser 同序）；供 select prompt 用。 */
export function browserCandidates(platform = process.platform, env = process.env) {
  if (env.GEMINI_WEB_BROWSER && existsSync(env.GEMINI_WEB_BROWSER)) return [env.GEMINI_WEB_BROWSER]
  const home = env.HOME || ""
  const candidates =
    platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        ]
      : platform === "win32"
        ? [
            join(env.PROGRAMFILES || "", "Google/Chrome/Application/chrome.exe"),
            join(env["PROGRAMFILES(X86)"] || "", "Google/Chrome/Application/chrome.exe"),
            join(env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
            join(env.PROGRAMFILES || "", "Microsoft/Edge/Application/msedge.exe"),
            join(env["PROGRAMFILES(X86)"] || "", "Microsoft/Edge/Application/msedge.exe"),
          ]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium", "/usr/bin/microsoft-edge"]
  const seen = new Set()
  return candidates.filter((p) => p && existsSync(p) && !seen.has(p) && seen.add(p))
}

export function browserArgs(profile, port, url, { headless = false } = {}) {
  return [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-background-mode",
    ...(headless ? ["--headless=new"] : ["--new-window"]),
    url,
  ]
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.on("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

// cdp sends one command to the browser target and answers its result
async function cdp(port, method, params = {}, timeout = 3000) {
  const v = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json())
  const url = v?.webSocketDebuggerUrl
  if (!url) throw new Error("no DevTools endpoint")
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      try { ws.close() } catch {}
      reject(new Error("DevTools timed out"))
    }, timeout)
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }))
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error("DevTools connection failed"))
    }
    ws.onmessage = (ev) => {
      let m
      try { m = JSON.parse(String(ev.data)) } catch { return }
      if (m.id !== 1) return
      clearTimeout(timer)
      try { ws.close() } catch {}
      if (m.error) reject(new Error(m.error.message || method + " failed"))
      else resolve(m.result)
    }
  })
}

// googleCookies keeps the cookies a request to gemini.google.com carries
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// open starts the browser on profile and answers a handle that reads its
// cookies and closes it
export async function open(profile, url, { headless = false, browser = findBrowser() } = {}) {
  if (!browser) throw Object.assign(new Error("没有找到 Chrome、Edge、Chromium 或 Brave。请先安装 Chrome，或用 GEMINI_WEB_BROWSER 指定浏览器。"), { code: "browser_missing" })
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  try { chmodSync(profile, 0o700) } catch {}
  const port = await freePort()
  const child = spawn(browser, browserArgs(profile, port, url, { headless }), { stdio: "ignore", detached: false })
  let exited = false
  child.once("error", () => (exited = true))
  child.once("exit", () => (exited = true))
  return {
    get exited() {
      return exited
    },
    async cookies() {
      const r = await cdp(port, "Storage.getCookies")
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
export async function signIn(profile, { timeout = 5 * 60_000, poll = 1000, settle = 2500, opener = open, browser } = {}) {
  const b = await opener(profile, SIGN_IN, { browser })
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

// renew opens the profile without a window at gemini.google.com, where
// the page's own scripts renew __Secure-1PSIDTS, and answers the cookies
// once it has changed (or what the profile holds after the wait).
export async function renew(profile, { before = {}, timeout = 20_000, poll = 700, opener = open } = {}) {
  if (!profile || !existsSync(profile)) return null
  const b = await opener(profile, GEMINI, { headless: true })
  try {
    const end = Date.now() + timeout
    let last = null
    while (Date.now() < end && !b.exited) {
      const c = await b.cookies().catch(() => null)
      if (c && hasSession(c)) {
        last = c
        if (c["__Secure-1PSIDTS"] !== before["__Secure-1PSIDTS"]) return c
      }
      await sleep(poll)
    }
    return last
  } finally {
    await b.close()
  }
}
