// Browser sign-in: launch an isolated Chrome with a debugging port, let the
// user log in, then read the Secure+HttpOnly session cookie over CDP.
//
// Page JavaScript can never read this cookie; the DevTools protocol can.
//
// Failures carry a `code` (and no localized text): the provider turns them into
// a message in the user's language.

import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { createServer } from "node:net"
import { strings, resolveLocale } from "./i18n.mjs"

const COOKIE_NAME = "__Secure-next-auth.session-token"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function fail(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra })
}

function candidates(explicit) {
  const out = []
  if (explicit) out.push(explicit)
  if (process.platform === "darwin") {
    out.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    )
  } else if (process.platform === "win32") {
    for (const p of [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]) {
      if (!p) continue
      out.push(
        `${p}\\Google\\Chrome\\Application\\chrome.exe`,
        `${p}\\Microsoft\\Edge\\Application\\msedge.exe`,
      )
    }
  } else {
    out.push("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser")
  }
  return out
}

async function findChrome(explicit) {
  for (const c of candidates(explicit)) {
    try {
      if (c.includes("/") || c.includes("\\")) {
        if (await Bun.file(c).exists()) return c
      } else {
        const p = Bun.which(c)
        if (p) return p
      }
    } catch { /* next */ }
  }
  throw fail("chrome_missing", "Chrome/Chromium not found; set the chromePath option")
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const s = createServer()
    s.once("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
}

async function cdp(ws, method, params = {}, timeoutMs = 8000) {
  const id = Math.floor(Math.random() * 1e9)
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMsg)
      reject(new Error(`${method} timeout`))
    }, timeoutMs)
    const onMsg = (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.id !== id) return
      clearTimeout(timer)
      ws.removeEventListener("message", onMsg)
      if (msg.error) reject(new Error(msg.error.message || "CDP error"))
      else resolve(msg.result || {})
    }
    ws.addEventListener("message", onMsg)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function browserWs(port, signal, deadline) {
  while (Date.now() < deadline) {
    if (signal?.aborted) throw fail("cancelled", "sign-in cancelled")
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal })
      const j = await r.json()
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl
    } catch { /* not up yet */ }
    await sleep(250)
  }
  throw fail("debug_port", "Chrome's debugging port never came up")
}

/** The browser's own user agent, so the account keeps the one it signed in with. */
async function browserUserAgent(wsUrl) {
  const ws = new WebSocket(wsUrl)
  try {
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true })
      ws.addEventListener("error", () => reject(fail("devtools", "cannot connect to Chrome DevTools")), { once: true })
    })
    const v = await cdp(ws, "Browser.getVersion")
    return String(v?.userAgent || "")
  } catch {
    return ""
  } finally {
    try { ws.close() } catch { /* ignore */ }
  }
}

async function readCookie(wsUrl) {
  let ws
  try {
    ws = new WebSocket(wsUrl)
  } catch {
    throw fail("devtools", "cannot connect to Chrome DevTools")
  }
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true })
    ws.addEventListener("error", () => reject(fail("devtools", "cannot connect to Chrome DevTools")), { once: true })
  })
  try {
    const all = []
    for (const method of ["Storage.getCookies", "Network.getAllCookies"]) {
      try {
        const r = await cdp(ws, method)
        all.push(...(r.cookies || []))
      } catch { /* not on this target */ }
    }
    const hit =
      all.find((c) => c.name === COOKIE_NAME && String(c.domain || "").includes("perplexity.ai")) ||
      all.find((c) => c.name === COOKIE_NAME)
    return hit?.value || null
  } finally {
    try { ws.close() } catch { /* ignore */ }
  }
}

/**
 * Wait for Chrome to actually go away. Killing returns before the process has
 * released its profile — on Windows the directory stays locked until it does.
 */
export async function stopChrome(proc, graceMs = 5000) {
  if (!proc) return
  try { proc.kill() } catch { /* gone */ }
  const exited = await Promise.race([
    proc.exited.then(() => true).catch(() => true),
    sleep(graceMs).then(() => false),
  ])
  if (exited) return
  try { proc.kill("SIGKILL") } catch { /* gone */ }
  await Promise.race([proc.exited.catch(() => {}), sleep(2000)])
}

/** Delete the throwaway profile, retrying while a released handle lingers. */
export async function removeProfile(dir, root, attempts = 5, remove = rm) {
  const inside = dir === root || dir.startsWith(root + sep) || dir.startsWith(root + "/")
  if (!inside) return
  let last
  for (let i = 0; i < attempts; i++) {
    try {
      await remove(dir, { recursive: true, force: true })
      return
    } catch (e) {
      last = e
      await sleep(120 * (i + 1))
    }
  }
  throw fail("profile_cleanup", `could not remove ${dir}`, { detail: last?.message || String(last) })
}

/**
 * Stop Chrome, wait for it to exit, then delete its profile.
 *
 * The order matters: on Windows the directory stays locked until the process is
 * gone, and a profile that survives still holds the session cookie.
 */
export async function retireBrowser(proc, profile, root, remove = rm) {
  await stopChrome(proc)
  await removeProfile(profile, root, 5, remove)
}

/**
 * The `close()` a sign-in handle hands back: stop the page, stop Chrome, wait
 * for it to exit, then delete the profile. Exported so the ordering can be
 * tested without a browser.
 */
export function makeCloser({ page, proc, profile, root, remove }) {
  let closed = false
  return async function close() {
    if (closed) return
    closed = true
    try { page?.stop?.(true) } catch { /* stopped */ }
    await retireBrowser(proc, profile, root, remove)
  }
}

/**
 * Start the sign-in browser.
 *
 * @param {object} [o]
 * @param {string} [o.chromePath] - explicit browser executable.
 * @param {AbortSignal} [o.signal]
 * @param {"zh"|"en"|"auto"} [o.locale] - language of the helper page.
 */
export async function browserSignIn({ chromePath, signal, locale } = {}) {
  const t = strings(resolveLocale(locale))
  const bin = await findChrome(chromePath)
  const debugPort = await freePort()
  const pagePort = await freePort()
  const root = tmpdir()
  const profile = join(root, `magpie-pplx-login-${process.pid}-${Date.now()}`)

  let state = t.browserPageStarting
  let done = false
  let current = null

  const page = Bun.serve({
    hostname: "127.0.0.1",
    port: pagePort,
    fetch(req) {
      if (new URL(req.url).pathname === "/state") {
        return new Response(done ? t.browserPageDone : state, {
          headers: { "content-type": "text/plain; charset=utf-8" },
        })
      }
      return new Response(
        `<!doctype html><meta charset="utf-8"><title>${t.browserPageTitle}</title>
<style>body{font:15px/1.6 -apple-system,system-ui,sans-serif;max-width:680px;margin:8vh auto;padding:0 24px}
.box{background:#f7f7f9;border:1px solid #e5e5e9;border-radius:10px;padding:16px 20px;margin:18px 0}
code{background:#f2f2f4;padding:2px 6px;border-radius:4px}a{color:#0a66c2}</style>
<h1>${t.browserPageTitle}</h1>
<p>${t.browserInstructions}</p>
<div class="box"><strong>Status / 状态：</strong><span id="s">${state}</span></div>
<p>${t.browserPageCookieNote}</p>
<p>${t.browserPageFallback} <code>${COOKIE_NAME}</code></p>
<script>setInterval(()=>fetch('/state').then(r=>r.text()).then(x=>{document.getElementById('s').textContent=x}),1500)</script>`,
        { headers: { "content-type": "text/html; charset=utf-8" } }
      )
    },
  })

  const proc = Bun.spawn(
    [
      bin,
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "https://www.perplexity.ai",
    ],
    { stdout: "ignore", stderr: "ignore" }
  )

  const closer = makeCloser({ page, proc, profile, root })

  return {
    url: `http://127.0.0.1:${pagePort}/`,
    instructions: t.browserInstructions,

    async wait(waitSignal) {
      const deadline = Date.now() + 5 * 60 * 1000
      const wsUrl = await browserWs(debugPort, waitSignal || signal, deadline)
      let ua = ""
      while (Date.now() < deadline) {
        if ((waitSignal || signal)?.aborted) throw fail("cancelled", "sign-in cancelled")
        state = t.browserPageWaiting
        const cookie = await readCookie(wsUrl).catch(() => null)
        if (cookie && cookie !== current) {
          current = cookie
          ua = await browserUserAgent(wsUrl)
          state = t.browserPageDone
          done = true
          return { cookie, ua }
        }
        await sleep(1500)
      }
      throw fail("timeout", "sign-in timed out")
    },

    async close() {
      done = true
      await closer()
    },
  }
}
