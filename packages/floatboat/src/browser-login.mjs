// src/browser-login.mjs —— 打开一个受控 Chromium 窗口，把登录回调里的 code 抓回来
//
// 为什么不能用「localhost 回调」：Floatboat 桌面端的登录回调走自定义协议
// `aoe://…?code=&state=`（安装包注册的 deep link），不是 127.0.0.1。
// 所以这里换一种抓法：
//   · 启动一次性 profile 的 Chromium，带 --remote-debugging-port；
//   · 用 CDP 在页面里注入钩子，把 Location.href / assign / replace / window.open /
//     <a>.click 里出现的 aoe:// 地址截下来，并且不放行（免得把用户真正的客户端拉起来）；
//   · 同时监听 Network.requestWillBeSent，双保险；
//   · 从截到的地址里取 code / state。
//
// 浏览器候选顺序沿用 tianxi 的实测结论（Chrome → 国产 Chromium → Edge 最后）。

import { spawn, execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"

const WIN_EXES = [
  "chrome.exe",
  "360ChromeX.exe",
  "360chrome.exe",
  "360se.exe",
  "QQBrowser.exe",
  "Brave.exe",
  "vivaldi.exe",
  "opera.exe",
  "SogouExplorer.exe",
  "2345Explorer.exe",
  "liebao.exe",
  "Maxthon.exe",
  "UCBrowser.exe",
  "Quark.exe",
  "msedge.exe",
]

/** 注册表查询结果缓存：一次登录里 findBrowser 只查一遍，不在每次点击时重跑 reg.exe */
const registryCache = new Map()

/** Windows 注册表 App Paths 查浏览器；查不到返回空串 */
function registryAppPath(exe) {
  if (process.platform !== "win32") return ""
  if (registryCache.has(exe)) return registryCache.get(exe)

  let found = ""
  for (const root of ["HKCU", "HKLM"]) {
    for (const tail of [
      `SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\${exe}`,
      `SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\${exe}`,
    ]) {
      try {
        const out = execFileSync("reg", ["query", `${root}\${tail}`, "/ve"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })
        const line = out.split("\n").find((l) => /REG_SZ/i.test(l))
        const path = line?.split("REG_SZ")[1]?.trim()
        if (path && existsSync(path)) {
          found = path
          break
        }
      } catch {}
    }
    if (found) break
  }
  registryCache.set(exe, found)
  return found
}

/** 候选浏览器（按优先级） */
function browserCandidates({ platform = process.platform, env = process.env, lookup = registryAppPath } = {}) {
  const local = env.LOCALAPPDATA || ""
  const roaming = env.APPDATA || ""
  const pf = env.PROGRAMFILES || ""
  const pf86 = env["PROGRAMFILES(X86)"] || env["ProgramFiles(x86)"] || ""
  const list = []
  const add = (name, path) => {
    if (path) list.push({ name, path })
  }

  if (platform === "win32") {
    for (const exe of WIN_EXES) {
      const fromRegistry = lookup(exe)
      if (fromRegistry) add(exe.replace(/\.exe$/i, ""), fromRegistry)
    }
    add("Chrome", join(pf, "Google", "Chrome", "Application", "chrome.exe"))
    add("Chrome", join(pf86, "Google", "Chrome", "Application", "chrome.exe"))
    add("Chrome", join(local, "Google", "Chrome", "Application", "chrome.exe"))
    add("Chromium", join(local, "Chromium", "Application", "chrome.exe"))
    add("360极速浏览器X", join(local, "360ChromeX", "Chrome", "Application", "360ChromeX.exe"))
    add("360浏览器", join(local, "360Chrome", "Chrome", "Application", "360chrome.exe"))
    add("360安全浏览器", join(roaming, "secoresdk", "360se6", "Application", "360se.exe"))
    add("QQ浏览器", join(local, "Tencent", "QQBrowser", "Application", "QQBrowser.exe"))
    add("Brave", join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"))
    add("Brave", join(local, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"))
    add("Vivaldi", join(local, "Vivaldi", "Application", "vivaldi.exe"))
    add("Opera", join(local, "Programs", "Opera", "opera.exe"))
    add("Opera", join(roaming, "Opera Software", "Opera Stable", "opera.exe"))
    add("搜狗浏览器", join(local, "SogouExplorer", "SogouExplorer.exe"))
    add("2345浏览器", join(local, "2345Explorer", "2345Explorer.exe"))
    add("猎豹浏览器", join(local, "liebao", "liebao.exe"))
    add("Maxthon", join(roaming, "Maxthon3", "Bin", "Maxthon.exe"))
    add("UC浏览器", join(local, "UCBrowser", "Application", "UCBrowser.exe"))
    add("夸克浏览器", join(local, "Quark", "Quark.exe"))
    add("Edge", join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"))
    add("Edge", join(pf, "Microsoft", "Edge", "Application", "msedge.exe"))
    return dedupe(list)
  }

  if (platform === "darwin") {
    return [
      ["Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
      ["Chromium", "/Applications/Chromium.app/Contents/MacOS/Chromium"],
      ["Brave", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"],
      ["Vivaldi", "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi"],
      ["Edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    ].map(([name, path]) => ({ name, path }))
  }

  return [
    ["Chrome", "/usr/bin/google-chrome"],
    ["Chromium", "/usr/bin/chromium"],
    ["Chromium", "/usr/bin/chromium-browser"],
    ["Brave", "/usr/bin/brave-browser"],
    ["Edge", "/usr/bin/microsoft-edge"],
  ].map(([name, path]) => ({ name, path }))
}

function dedupe(list) {
  const seen = new Set()
  return list.filter((x) => {
    const key = x.path.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 第一个真实存在的候选；没有返回 null */
export function findBrowser({ platform = process.platform, env = process.env, exists = existsSync, lookup = registryAppPath } = {}) {
  // 快路径：常见安装路径，纯 existsSync，不 spawn reg.exe。
  const known = browserCandidates({ platform, env, lookup: () => "" }).find((b) => exists(b.path))
  if (known || platform !== "win32") return known ?? null

  // 慢路径：固定路径都没有才查注册表（覆盖非标准安装目录）。
  // 代价是偶发情况下注册表里的 Chrome 会输给路径里的 Edge —— 任何一个都能登录，可接受。
  return browserCandidates({ platform, env, lookup }).find((b) => exists(b.path)) ?? null
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

async function getJson(url, timeoutMs = 5000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/** 结束整个浏览器进程树；Windows 上 child.kill() 只杀主进程 */
function killTree(child) {
  try {
    child.kill()
  } catch {}
  if (process.platform === "win32" && child.pid) {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 5000 })
    } catch {}
  }
}

/** 极简 CDP 会话：一个页面一条 WebSocket，请求/响应按 id 配对，事件走 on() */
class CdpSession {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    this.handlers = new Map()
    ws.addEventListener("message", (ev) => {
      let msg
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (msg.id) {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(msg.error.message || "CDP error"))
        else p.resolve(msg.result)
        return
      }
      const list = this.handlers.get(msg.method)
      if (!list) return
      for (const fn of list) {
        try {
          fn(msg.params)
        } catch {}
      }
    })
  }

  static async open(wsUrl, timeoutMs = 8000) {
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP WebSocket 连接超时")), timeoutMs)
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer)
          reject(new Error("CDP WebSocket 连不上"))
        },
        { once: true },
      )
    })
    return new CdpSession(ws)
  }

  send(method, params = {}, timeoutMs = 10_000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} 超时`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e)
      }
    })
  }

  on(method, fn) {
    const list = this.handlers.get(method) ?? []
    list.push(fn)
    this.handlers.set(method, list)
  }

  close() {
    try {
      this.ws.close()
    } catch {}
  }
}

/**
 * 注入到页面里的钩子：截 deep link，但不放行。
 * 用 Location.prototype 上的访问器拦截，覆盖 location.href / assign / replace / window.open / <a>.click。
 */
const HOOK_SOURCE = `(() => {
  if (window.__magpieFloatboatHook) return 'installed'
  window.__magpieFloatboatHook = true
  window.__magpieFloatboatCaptured = []
  var DEEP = /^(aoe|dsagent):\/\//i
  function push(u) {
    try {
      var s = String(u == null ? '' : u)
      if (!s) return
      if (DEEP.test(s) || (/[?&]code=/.test(s) && /[?&]state=/.test(s))) {
        if (window.__magpieFloatboatCaptured.indexOf(s) < 0) window.__magpieFloatboatCaptured.push(s)
      }
    } catch (e) {}
  }
  try {
    var d = Object.getOwnPropertyDescriptor(Location.prototype, 'href')
    if (d && d.set) {
      Object.defineProperty(Location.prototype, 'href', {
        configurable: true,
        enumerable: d.enumerable,
        get: function () { return d.get.call(this) },
        set: function (v) { push(v); if (DEEP.test(String(v))) return; return d.set.call(this, v) }
      })
    }
  } catch (e) {}
  try {
    ['assign', 'replace'].forEach(function (m) {
      var orig = Location.prototype[m]
      if (typeof orig !== 'function') return
      Location.prototype[m] = function (v) {
        push(v)
        if (DEEP.test(String(v))) return undefined
        return orig.call(this, v)
      }
    })
  } catch (e) {}
  try {
    var ow = window.open
    window.open = function (u) {
      push(u)
      if (DEEP.test(String(u))) return null
      return ow.apply(window, arguments)
    }
  } catch (e) {}
  try {
    var ac = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () {
      try {
        var href = this.href || ''
        push(href)
        if (DEEP.test(href)) return undefined
      } catch (e) {}
      return ac.call(this)
    }
  } catch (e) {}
  return 'ok'
})()`

/**
 * 从任意「像是回调」的字符串里取 code / state。
 * 认这些形状：aoe://auth/callback?code=…&state=…、https://floatboat.ai/…?code=…&state=…、裸 code。
 */
export function parseCallback(raw) {
  const text = String(raw ?? "").trim()
  if (!text) return null
  // 纯 code（手动粘贴的裸授权码）：不能含 ? & : 空白，且要有基本长度。
  // ⚠ 关键：about:blank / chrome://… / 普通 https 链接都含 ":"，绝不能被当成裸 code，
  // 否则受控浏览器初始页 about:blank 会被误判成授权码，登录流程立刻拿假 code 去换 token。
  if (!/[?&:\s]/.test(text) && text.length >= 8) {
    return { code: text, state: "", url: "" }
  }
  let url
  try {
    url = new URL(text)
  } catch {
    // 有些实现会把整条链接塞进某个参数里，做一次宽松匹配
    const m = /[?&]code=([^&#]+)/.exec(text)
    const s = /[?&]state=([^&#]+)/.exec(text)
    if (!m) return null
    return { code: decodeURIComponent(m[1]), state: s ? decodeURIComponent(s[1]) : "", url: text }
  }
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  if (!code) return null
  return { code, state: state ?? "", url: text }
}

/**
 * 打开受控浏览器，等 deep link 回调，返回 code/state。
 *
 * @param {object} o
 * @param {{name:string,path:string}} o.browser findBrowser() 的返回值
 * @param {string} o.url 登录页（带 state）
 * @param {number} [o.timeoutMs] 默认 5 分钟
 * @param {AbortSignal} [o.signal]
 * @param {(msg:string)=>void} [o.onProgress] 给用户看的一句话进展
 * @returns {Promise<{code:string,state:string,url:string,browser:string}>}
 */
export async function chromiumDeepLinkLogin({ browser, url, timeoutMs = 5 * 60_000, signal, onProgress }) {
  if (!browser?.path) throw new Error("没有可用的 Chromium 浏览器")

  const profile = mkdtempSync(join(tmpdir(), "magpie-floatboat-"))
  const port = await freePort()
  const child = spawn(
    browser.path,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-features=Translate,MediaRouter",
      url,
    ],
    { stdio: "ignore", windowsHide: false },
  )

  const sessions = new Map()
  const captured = []
  const seenUrl = new Set()

  const push = (u) => {
    if (!u || typeof u !== "string") return
    if (seenUrl.has(u)) return
    seenUrl.add(u)
    captured.push(u)
  }

  const attachAll = async () => {
    const pages = await getJson(`http://127.0.0.1:${port}/json/list`, 1500).catch(() => [])
    for (const t of pages) {
      if (t.type !== "page" || !t.webSocketDebuggerUrl) continue
      if (sessions.has(t.id)) continue
      const s = await CdpSession.open(t.webSocketDebuggerUrl).catch(() => null)
      if (!s) continue
      sessions.set(t.id, s)
      s.send("Page.enable").catch(() => {})
      s.send("Network.enable").catch(() => {})
      s.send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK_SOURCE }).catch(() => {})
      s.send("Runtime.evaluate", { expression: HOOK_SOURCE, returnByValue: true }).catch(() => {})
      s.on("Network.requestWillBeSent", (p) => push(p?.request?.url))
      s.on("Page.frameRequestedNavigation", (p) => push(p?.url))
      s.on("Page.frameNavigated", (p) => push(p?.frame?.url))
    }
  }

  const readCaptured = async (s) => {
    // 一次 CDP 往返同时取注入钩子截到的地址和当前 location
    const r = await s
      .send("Runtime.evaluate", {
        expression:
          "JSON.stringify({ c: (window.__magpieFloatboatCaptured || []).slice(-10), h: String(location.href || '') })",
        returnByValue: true,
      })
      .catch(() => null)
    const raw = r?.result?.value
    if (typeof raw !== "string") return
    try {
      const { c, h } = JSON.parse(raw)
      if (Array.isArray(c)) for (const u of c) push(u)
      if (h) push(String(h))
    } catch {}
  }

  const deadline = Date.now() + timeoutMs
  let lastProgress = 0
  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("登录已取消")
      await attachAll()

      for (const s of sessions.values()) await readCaptured(s)

      for (const u of captured) {
        const parsed = parseCallback(u)
        if (parsed?.code) {
          return { ...parsed, browser: browser.name }
        }
      }

      if (onProgress && Date.now() - lastProgress > 15_000) {
        lastProgress = Date.now()
        onProgress("等待浏览器里的登录完成…（登录成功会自动回到这里）")
      }
      await new Promise((r) => setTimeout(r, 700))
    }
    throw new Error(
      `登录超时：${Math.round(timeoutMs / 60_000)} 分钟内没等到回调。` +
        "可以改用「粘贴回调链接 / 授权码」把浏览器地址栏里 aoe://… 那条链接贴进来。",
    )
  } finally {
    for (const s of sessions.values()) s.close()
    killTree(child)
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {}
  }
}
