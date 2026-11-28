// Sign-in through a browser window of the plugin's own: Chrome (or Edge,
// Chromium, Brave) with a private profile, opened at ChatSEU's CAS sign-in.
// The user signs in there themselves; the plugin never sees a password.
// It reads the profile's chatseu.seu.edu.cn cookies through the browser's
// own DevTools endpoint (Storage.getCookies on the browser target: nothing
// is attached to the page the user types into) and closes the window. The
// profile is kept: when the cookies stop working, the same profile is
// opened again without a window and the browser renews them itself.
// 改自 magpie-community/plugins 的 gemini-web（MIT）。
import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CHAT_URL, LOGIN_URL } from "./seu.mjs"

export { LOGIN_URL, CHAT_URL }

// 登录完成的标志由 verify 说了算（/api/cas/userInfo 能读回用户），
// 这里只负责开窗、读 cookie、关窗。
export function profileRoot(env = process.env, platform = process.platform) {
  if (env.SEU_CHAT_PROFILE) return env.SEU_CHAT_PROFILE
  if (platform === "win32") return join(env.LOCALAPPDATA || env.APPDATA || tmpdir(), "magpie", "seu-chat-browser")
  return join(env.XDG_CONFIG_HOME || join(env.HOME || tmpdir(), ".config"), "magpie", "seu-chat-browser")
}

export function findBrowser(platform = process.platform, env = process.env) {
  if (env.SEU_CHAT_BROWSER && existsSync(env.SEU_CHAT_BROWSER)) return env.SEU_CHAT_BROWSER
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

// seuCookies keeps the cookies a request to chatseu.seu.edu.cn carries:
// that domain only (a leading dot taken off), any path.
export function seuCookies(list) {
  const out = {}
  for (const c of list ?? []) {
    const d = String(c?.domain ?? "").replace(/^\./, "")
    if (d !== "chatseu.seu.edu.cn") continue
    if (typeof c.name === "string" && typeof c.value === "string") out[c.name] = c.value
  }
  return out
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// open starts the browser on profile and answers a handle that reads its
// cookies and closes it
export async function open(profile, url, { headless = false, browser = findBrowser() } = {}) {
  if (!browser) throw Object.assign(new Error("没有找到 Chrome、Edge、Chromium 或 Brave。请先安装 Chrome，或用 SEU_CHAT_BROWSER 指定浏览器。"), { code: "browser_missing" })
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
      return seuCookies(r?.cookies)
    },
    async urls() {
      const v = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json())
      return (Array.isArray(v) ? v : []).filter((t) => t?.type === "page" && typeof t.url === "string").map((t) => t.url)
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
// in — verify(cookies) 是判断（读回 userInfo）——then answers the cookies.
// It answers null when the window was closed or the time ran out.
export async function signIn(profile, { verify, timeout = 5 * 60_000, poll = 1000, settle = 2500, opener = open, stuckMs = 20_000, sleep: nap = sleep, now = Date.now, onProgress } = {}) {
  const b = await opener(profile, LOGIN_URL)
  try {
    const ok = async (c) => {
      if (!c || !Object.keys(c).length) return false
      try {
        return !!(await verify(c))
      } catch {
        return false
      }
    }
    const t0 = now()
    const end = t0 + timeout
    const outsideSince = new Map()
    while (now() < end && !b.exited) {
      // 窗口停在站外（不是 seu.edu.cn）超过 stuckMs：多半是网络/代理把
      // 登录页劫走了，早点报错，别让用户白等 5 分钟。
      const urls = typeof b.urls === "function" ? await b.urls().catch(() => []) : []
      const hosts = urls.map((u) => {
        try { return new URL(u).hostname } catch { return "" }
      }).filter(Boolean)
      const outside = hosts.length && hosts.every((h) => h !== "chatseu.seu.edu.cn" && !h.endsWith(".seu.edu.cn"))
      for (const h of hosts) {
        const isSeu = h === "chatseu.seu.edu.cn" || h.endsWith(".seu.edu.cn")
        if (!isSeu) {
          if (!outsideSince.has(h)) outsideSince.set(h, now())
        } else outsideSince.delete(h)
      }
      if (outside) {
        const stuck = [...outsideSince.entries()].sort((a, z) => a[1] - z[1])[0]
        if (stuck && now() - stuck[1] >= stuckMs) {
          onProgress?.(`浏览器停在站外（${stuck[0]}），没有到达 ChatSEU`)
          return null
        }
      } else outsideSince.clear()
      const c = await b.cookies().catch(() => null)
      if (await ok(c)) {
        // let the redirect back to chatseu.seu.edu.cn finish, so the
        // cookies it sets are in the jar too
        await nap(settle)
        const again = (await b.cookies().catch(() => null)) ?? c
        return (await ok(again)) ? again : c
      }
      await nap(poll)
    }
    return null
  } finally {
    await b.close()
  }
}

// renew opens the profile without a window at chatseu.seu.edu.cn/chat,
// where the page's own scripts renew the session, and answers the cookies
// once verify passes (or null). The profile that isn't there answers null.
export async function renew(profile, { verify, timeout = 20_000, poll = 700, settle = 2000, opener = open } = {}) {
  if (!profile || !existsSync(profile)) return null
  const b = await opener(profile, CHAT_URL, { headless: true })
  try {
    const ok = async (c) => {
      if (!c || !Object.keys(c).length) return false
      try {
        return !!(await verify(c))
      } catch {
        return false
      }
    }
    const end = Date.now() + timeout
    while (Date.now() < end && !b.exited) {
      const c = await b.cookies().catch(() => null)
      if (await ok(c)) {
        await sleep(settle)
        // settle 后重读；重读不到会话（可能还在跳转）就用刚才那份
        const again = await b.cookies().catch(() => null)
        return (await ok(again)) ? again : c
      }
      await sleep(poll)
    }
    return null
  } finally {
    await b.close()
  }
}
