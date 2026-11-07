// Browser sign-in: launch an isolated Chrome with a debugging port, let the
// user log in, then read the Secure+HttpOnly session cookie over CDP.
//
// Page JavaScript can never read this cookie; the DevTools protocol can.

import { rm } from "node:fs/promises"
import { createServer } from "node:net"

const COOKIE_NAME = "__Secure-next-auth.session-token"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  throw new Error("找不到 Chrome/Chromium。请在插件选项里设置 chromePath。")
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
    if (signal?.aborted) throw new Error("登录已取消")
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal })
      const j = await r.json()
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl
    } catch { /* not up yet */ }
    await sleep(250)
  }
  throw new Error("Chrome 调试端口没有起来")
}

async function readCookie(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true })
    ws.addEventListener("error", () => reject(new Error("连不上 Chrome DevTools")), { once: true })
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

export async function browserSignIn({ chromePath, signal } = {}) {
  const bin = await findChrome(chromePath)
  const debugPort = await freePort()
  const pagePort = await freePort()
  const tmp = (process.env.TMPDIR || "/tmp").replace(/\/+$/, "")
  const profile = `${tmp}/magpie-pplx-login-${process.pid}-${Date.now()}`

  let state = "正在启动浏览器…"
  let done = false
  let current = null

  const page = Bun.serve({
    hostname: "127.0.0.1",
    port: pagePort,
    fetch(req) {
      if (new URL(req.url).pathname === "/state") {
        return new Response(done ? "✓ 完成，可以关掉这个页面了" : state, {
          headers: { "content-type": "text/plain; charset=utf-8" },
        })
      }
      return new Response(
        `<!doctype html><meta charset="utf-8"><title>登录 Perplexity</title>
<style>body{font:15px/1.6 -apple-system,system-ui,sans-serif;max-width:680px;margin:8vh auto;padding:0 24px}
.box{background:#f7f7f9;border:1px solid #e5e5e9;border-radius:10px;padding:16px 20px;margin:18px 0}
code{background:#f2f2f4;padding:2px 6px;border-radius:4px}a{color:#0a66c2}</style>
<h1>用浏览器登录 Perplexity</h1>
<p>已打开一个<strong>独立的 Chrome 窗口</strong>。请在那个窗口里登录（不影响你日常浏览器）。</p>
<div class="box"><strong>状态：</strong><span id="s">${state}</span></div>
<p>登录成功后本页会自动结束。Cookie 只通过本机 DevTools 协议读取，不会离开这台机器。</p>
<p>备选：F12 → Application → Cookies → 复制 <code>${COOKIE_NAME}</code>，在 magpie 里选「粘贴 Session Cookie」。</p>
<script>setInterval(()=>fetch('/state').then(r=>r.text()).then(t=>{document.getElementById('s').textContent=t}),1500)</script>`,
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

  return {
    url: `http://127.0.0.1:${pagePort}/`,
    instructions: "请在自动打开的独立 Chrome 窗口里登录 Perplexity；登录后本页会自动完成。",

    async wait(waitSignal) {
      const deadline = Date.now() + 5 * 60 * 1000
      const wsUrl = await browserWs(debugPort, waitSignal || signal, deadline)
      while (Date.now() < deadline) {
        if ((waitSignal || signal)?.aborted) throw new Error("登录已取消")
        state = "等待登录…（在独立 Chrome 窗口里登录）"
        const cookie = await readCookie(wsUrl).catch(() => null)
        if (cookie && cookie !== current) {
          current = cookie
          state = "✓ 完成，可以关掉这个页面了"
          done = true
          return { cookie }
        }
        await sleep(1500)
      }
      throw new Error("登录超时（5 分钟）。也可以改用「粘贴 Session Cookie」。")
    },

    async close() {
      done = true
      try { proc.kill() } catch { /* gone */ }
      try { page.stop(true) } catch { /* stopped */ }
      try {
        if (profile.startsWith(tmp + "/magpie-pplx-login-")) {
          await rm(profile, { recursive: true, force: true })
        }
      } catch { /* ignore */ }
    },
  }
}
