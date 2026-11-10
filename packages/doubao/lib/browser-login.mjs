// Automatic web-login for Doubao — no manual cookie paste.
//
// The user picks this account-add method; we launch a real browser (Chrome or
// Edge) with remote debugging, open doubao.com, and let the user sign in
// through Doubao's own login UI (phone / QR / whatever it offers). Once a
// session cookie appears we harvest the full jar over CDP — same technique the
// desktop-client harvest uses — and return it. The user never copies a string.
//
// This is the "自动打开豆包授权页 → 用户登录 → 自动爬取" path. It needs a
// browser binary on the machine (which is the common case on desktop OSes); if
// none is found we report a clear error and the caller falls back to the
// manual-paste method.

import { spawn } from "node:child_process"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CdpSession, listTargets } from "./client-checkin.mjs"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Ordered by preference. Chrome first (most common), then Edge.
const CANDIDATE_BINARIES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
]

/** Return the first available browser binary, or null. */
export function findBrowserBinary() {
  for (const b of CANDIDATE_BINARIES) {
    try { if (existsSync(b)) return b } catch { /* keep looking */ }
  }
  return null
}

const SESSION_COOKIE_NAMES = ["sessionid", "sessionid_ss", "sid_tt", "sid_guard"]

function isLoggedIn(cookies) {
  return Array.isArray(cookies) && cookies.some((c) => SESSION_COOKIE_NAMES.includes(c.name))
}

/**
 * Launch a browser, navigate to doubao.com, and wait for the user to log in.
 * Once a session cookie is present, harvest the full cookie jar.
 *
 * @param {{binary?:string, timeoutMs?:number, pollIntervalMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, cookie?:string, uid?:string, count?:number, error?:string, binary?:string}>}
 */
export async function launchBrowserLogin({ binary, timeoutMs = 300000, pollIntervalMs = 1000 } = {}) {
  const bin = binary || findBrowserBinary()
  if (!bin) {
    return { ok: false, error: "未找到可用的浏览器（Chrome / Edge），无法自动打开网页登录。请改用「本机豆包客户端」或手动粘贴 Cookie。" }
  }
  const udd = mkdtempSync(join(tmpdir(), "doubao-login-"))
  // --remote-debugging-port=0 lets Chrome pick a free port; we read the actual
  // endpoint from its stderr ("DevTools listening on ws://..."). A temp profile
  // keeps this launch isolated from the user's real browser.
  const args = [
    bin,
    `--user-data-dir=${udd}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ]

  let child
  let browserWs = null
  try {
    child = spawn(bin, args.slice(1), { stdio: ["ignore", "ignore", "pipe"] })
  } catch (e) {
    return { ok: false, error: `启动浏览器失败：${String(e?.message ?? e)}` }
  }

  child.stderr.on("data", (d) => {
    const s = d.toString()
    const m = s.match(/ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\/\S+/)
    if (m) browserWs = m[0]
  })
  child.on("exit", () => { /* tracked via exitCode below */ })

  // Wait for the DevTools endpoint to surface on stderr.
  const startDeadline = Date.now() + 20000
  while (!browserWs && Date.now() < startDeadline) {
    if (child.exitCode !== null) {
      return { ok: false, error: "浏览器启动后立即退出（可能已有实例锁住用户目录，或二进制不可用）" }
    }
    await sleep(200)
  }
  if (!browserWs) {
    try { child.kill() } catch { /* already gone */ }
    return { ok: false, error: "未能获取浏览器调试端点（20s 内未输出 DevTools 监听地址）" }
  }
  const port = Number(browserWs.match(/ws:\/\/127\.0\.0\.1:(\d+)\//)[1])

  let browser = null
  let session = null
  try {
    browser = new CdpSession(browserWs)
    await browser.opened
    // Open the login page as its own target.
    const { targetId } = await browser.send("Target.createTarget", { url: "https://www.doubao.com/" })

    // Resolve the page target's WebSocket URL via the HTTP /json endpoint.
    let pageWs = null
    for (let i = 0; i < 40; i++) {
      const list = await listTargets(port).catch(() => [])
      const t = (Array.isArray(list) ? list : []).find(
        (x) => x.type === "page" && x.id === targetId && x.webSocketDebuggerUrl,
      )
      if (t) { pageWs = t.webSocketDebuggerUrl; break }
      await sleep(300)
    }
    if (!pageWs) {
      return { ok: false, error: "无法附着到浏览器登录页（目标未出现在 /json）" }
    }

    session = new CdpSession(pageWs)
    await session.opened
    await session.send("Page.enable").catch(() => {})
    await session.send("Runtime.enable").catch(() => {})
    await session.send("Network.enable").catch(() => {})

    // Poll for the session cookie — the user is logging in inside the window.
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const cookies = await session.getCookies([
        "https://www.doubao.com", "https://doubao.com",
      ]).catch(() => [])
      if (isLoggedIn(cookies)) {
        const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ")
        const uid = cookies.find((c) => c.name === "uid_tt")?.value
          || cookies.find((c) => /sessionid/.test(c.name))?.value
          || ""
        return { ok: true, cookie, uid: String(uid), count: cookies.length, binary: bin }
      }
      if (child.exitCode !== null) {
        return { ok: false, error: "浏览器在登录完成前被关闭" }
      }
      if (Date.now() >= deadline) {
        const mins = Math.round(timeoutMs / 60000)
        return { ok: false, error: `等待登录超时（${mins} 分钟内未在浏览器中完成豆包登录）` }
      }
      await sleep(pollIntervalMs)
    }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  } finally {
    try { await session?.close() } catch { /* ignore */ }
    try { await browser?.close() } catch { /* ignore */ }
    // Close the browser we spawned — the user doesn't need the temp-profile
    // window after the session is captured (or on any failure).
    try { if (child && child.exitCode === null) child.kill() } catch { /* ignore */ }
  }
}
