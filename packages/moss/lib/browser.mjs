// 受控浏览器登录：插件自己的专用浏览器 profile。
//
// 三条硬边界（都在这台机器上验证过）：
//   1. Edge/Chrome 136+ 拒绝在**默认用户数据目录**上开远程调试端口——所以
//      "直接调试你日常浏览器"这条路在浏览器层面就被堵死了；
//   2. 把日常浏览器的数据从别的路径打开（拷贝/联接），Edge 会把解不开的
//      cookie（应用绑定加密）直接清掉——等于毁掉你的登录态；
//   3. 唯一可行的路：插件自己的专用 profile（非默认目录，调试端口正常），
//      登录一次后 cookie 留在里面，之后的续期/重登都在这个 profile 里静默完成。
//
// **绝不碰日常浏览器**：杀进程只按命令行里的 `--user-data-dir=<本插件
// profile>` 精确匹配（.Contains，不是 -like 通配）；登录窗口按 PID 找窗口
// 标题、按 PID 关窗。日常浏览器的进程一个都不动。
//
// 登录窗口**不带**调试端口（MOSS 前面是阿里云 WAF，验证码校验特别严格，
// 带调试端口的窗口过不了验证码——书生专业同款教训）；只有 headless 读取
// 会话时才开 CDP，且全程只用 Network 域（Network.getAllCookies），不碰
// Runtime.evaluate，不在页面里注入任何东西。
// Windows 上插件用窗口标题判断登录完成并自己关窗；macOS / Linux 读不了窗口
// 标题，靠轮询 profile 的 Cookies sqlite 找本次登录新增的会话行。
//
// Bun 1.3.1 在 Windows 上"关掉 CDP WebSocket + 立刻杀进程/删目录"会偶发
// 原生崩溃：收尾时不调用 ws.close()，profile 目录交给系统 rmdir 删。

import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cookieBaseline, profileHasNewCookie } from "./cookieProbe.mjs"
import { COOKIE_DOMAINS, SESSION_COOKIE_NAMES } from "./protocol.mjs"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const LOGIN_URL = "https://platform.mosi.cn/"

/** 控制台的 cookie 根域：取 LOGIN_URL 主机的最后两段。 */
export function consoleCookieDomain() {
  try {
    const host = new URL(LOGIN_URL).hostname.toLowerCase()
    const parts = host.split(".")
    return parts.length > 2 ? parts.slice(-2).join(".") : host
  } catch {
    return ""
  }
}

// 同一时刻只允许一个浏览器实例使用插件专用 profile：登录窗口、静默续期、
// headless 读 cookie 都在这个 profile 上，两个实例同时开会把命令互相委托，
// 后启动的那个"立刻退出"。续期遇到登录进行中就跳过（下一次额度刷新再来）。
let profileBusy = 0
const exclusive = async (fn, cancelled = () => false) => {
  while (profileBusy > 0) {
    if (cancelled()) throw new Error("another sign-in is still using the browser profile")
    await sleep(200)
  }
  profileBusy += 1
  try {
    return await fn()
  } finally {
    profileBusy -= 1
  }
}

/** 本机可用的 Chromium 系浏览器；`MAGPIE_MOSS_BROWSER` 可覆盖。 */
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
  // 环境变量和插件选项同样严格：指到的浏览器不存在就直接报错，而不是悄悄
  // 退回默认浏览器——拼错的路径不该变成"怎么换了个浏览器"。
  if (env.MAGPIE_MOSS_BROWSER && !existsSync(env.MAGPIE_MOSS_BROWSER)) {
    throw new Error(`MAGPIE_MOSS_BROWSER 指定的浏览器不存在: ${env.MAGPIE_MOSS_BROWSER}`)
  }
  if (env.MAGPIE_MOSS_BROWSER) push(env.MAGPIE_MOSS_BROWSER)
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

/**
 * 浏览器登录要用的那个浏览器；一个都没有就抛错。
 * `candidates` 只给测试用。
 */
export function requireBrowser(explicit, { candidates = browserCandidates, platform = process.platform } = {}) {
  const list = candidates(explicit)
  if (list.length) return list[0]
  let msg =
    "The browser sign-in needs Microsoft Edge, Google Chrome or Chromium, and none is installed. " +
    'Sign in with "API key only", or with "API key + console token" to also get the credit card. ' +
    "Or install one of those browsers, or set MAGPIE_MOSS_BROWSER to its path."
  if (platform === "darwin") msg += " Safari can't be used: the sign-in runs in its own browser profile, which Safari doesn't support."
  throw new Error(msg)
}

/** 插件专用（可续期）profile 的目录；不同平台放各自的应用数据目录。 */
export function profileDir(env = process.env, platform = process.platform) {
  if (env.MAGPIE_MOSS_PROFILE) return env.MAGPIE_MOSS_PROFILE
  if (platform === "win32") return join(env.LOCALAPPDATA || env.APPDATA || tmpdir(), "magpie", "moss-browser")
  return join(env.XDG_CONFIG_HOME || join(env.HOME || tmpdir(), ".config"), "magpie", "moss-browser")
}

/** 一次性 profile：登录完就删，不把登录态留在磁盘上。 */
export function oneOffProfileDir() {
  return mkdtempSync(join(tmpdir(), "magpie-moss-login-"))
}

function browserEnv() {
  const env = { ...process.env }
  for (const key of ["__COMPAT_LAYER", "COMPAT_LAYER", "CHROME_HEADLESS", "ELECTRON_RUN_AS_NODE"]) delete env[key]
  return env
}

export function browserArgs(profile, port, url, { headless = false, cdp = true, login = false } = {}) {
  const args = [`--user-data-dir=${profile}`]
  if (cdp) args.push(`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1")
  args.push("--no-first-run", "--no-default-browser-check", "--disable-background-mode")
  if (!login) {
    // 隐私开关只用于 headless 续期；登录窗口保持普通浏览器的样子，
    // 控制台的风控读这些开关。
    args.push(
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-default-apps",
      "--no-service-autorun",
      "--disable-breakpad",
      "--no-pings",
    )
  }
  args.push("--window-size=1100,800", url)
  if (headless) args.unshift("--headless=new")
  return args
}

/**
 * 从 document.cookie 字符串里取控制台会话 token：js-cookie 写的是 URL 编码，
 * 读的时候解一次。
 */
export function readConsoleCookie(cookieString) {
  const s = String(cookieString ?? "")
  for (const name of SESSION_COOKIE_NAMES) {
    const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(s)
    if (m?.[1]) {
      try {
        return decodeURIComponent(m[1])
      } catch {
        return m[1]
      }
    }
  }
  return ""
}

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
        /* 端口刚起来时可能还没有页面目标 */
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
      // CDP 不回答不能无限等：挂死的 send 会让静默续期永不返回，
      // 上层的单飞锁也会被永久占住。
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

  /** 丢掉引用但不调用 ws.close()：见文件头对 Bun 段错误的说明。 */
  detach() {
    for (const { reject } of this.pending.values()) reject(new Error("browser debug connection closed"))
    this.pending.clear()
    this.ws = null
  }
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true })
    } else {
      child.kill("SIGKILL")
    }
  } catch {
    /* 进程可能已经退出 */
  }
}

/**
 * Windows 收尾：只杀**命令行里带着本插件 --user-data-dir 路径**的浏览器进程。
 * 铁律（2026-11-21 的事故）：绝不按进程名批量杀——那是把用户正在用的日常
 * 浏览器一起杀掉。.Contains() 而不是 -like：-like 会把路径里的 [ ] 当通配符。
 * 前缀陷阱：Contains 是子串匹配，"…\moss-browser2" 也含 "…\moss-browser"，
 * 所以用带边界的正则：`--user-data-dir=` 后直接跟路径（无引号）时，路径之后
 * 必须是空白或串尾；带引号时引号在路径里出现，再吃掉收引号（"…profile"）。
 */
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
    // 只匹配 "--user-data-dir=<本插件 profile>"：pkill -f 是对全体进程命令行
    // 做正则，裸路径里的 . 会匹配任意字符、短路径会误杀无关进程。结尾的
    // (?=\\s|$)（ERE 前瞻在 pkill 的 ERE 里不可用，用等价写法）保证目录名是
    // 完整参数：`moss-browser2` 不会被 `moss-browser` 的模式误杀。
    const esc = String(profile).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const pattern = `--user-data-dir=${esc}([ "'/]|$)`
    spawnSync("pkill", ["-f", "--", pattern], { stdio: "ignore" })
  } catch (e) {
    log(`cleaning leftover browsers failed: ${e?.message ?? e}`)
  }
}

/** 杀掉仍占着这个专用 profile 的残留浏览器进程（只清插件自己的 profile）。 */
export function killProfileProcesses(profile, log = () => {}) {
  if (process.platform === "win32") killProfileProcessesWindows(profile, log)
  else killProfileProcessesUnix(profile, log)
}

/**
 * 这个目录是否是本插件拥有的、可以整体删除的 profile：
 *   - 一次性登录目录（mkdtemp 的 `magpie-moss-login-` 前缀）；
 *   - 插件默认 profile（profileDir() 的默认位置）；
 *   - 用户用 MAGPIE_MOSS_PROFILE 指过来的目录——只有当里面放着本插件写入的
 *     所有权标记（.moss-profile，openSession 首次创建 profile 时落笔）才认。
 * 环境变量把路径指到日常浏览器的 User Data 时，标记不存在，删除被拒绝：
 * removeProfile 的铁律是宁可不删，绝不删掉不属于插件的目录。
 */
const PROFILE_MARKER = ".moss-profile"

function ownedProfile(dir, env = process.env, platform = process.platform) {
  const d = String(dir ?? "")
  if (!d) return false
  if (/(^|[\\/])magpie-moss-login-[^\\/]*$/.test(d)) return true // our mkdtemp pattern
  if (d === profileDir(env, platform)) return true
  return existsSync(join(d, PROFILE_MARKER))
}

async function removeProfile(dir) {
  // 12 次重试是等文件锁；所有权不符一次都不试。
  if (!dir || !existsSync(dir) || !ownedProfile(dir)) return !dir || !existsSync(dir)
  try {
    rmSync(join(dir, PROFILE_MARKER), { force: true })
  } catch {}
  for (let i = 0; i < 12; i++) {
    if (process.platform === "win32") {
      // cmd 会把 & ^ | < > 等元字符拆开；路径含元字符时改走 rmSync（只发生在
      // CDP 从未建立的启动失败场景，无 Bun 崩溃风险）。
      if (/[&^|<>"]/.test(dir)) {
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 500 })
          return true
        } catch {
          /* 文件锁：稍后重试 */
        }
      } else {
        const r = spawnSync("cmd", ["/c", "rmdir", "/s", "/q", dir], { stdio: "ignore", windowsHide: true })
        if (r.status === 0) return true
      }
    } else {
      try {
        rmSync(dir, { recursive: true, force: true })
        return true
      } catch {
        /* 文件锁：稍后重试 */
      }
    }
    await sleep(500)
  }
  return !existsSync(dir)
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
        // 文件可能是上一轮留下的旧端口：只有 CDP 端点真的应答才算数。
        const live = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
          .then((r) => r.ok)
          .catch(() => false)
        if (live) return port
      }
    } catch (e) {
      if (e?.name === "AbortError") {
        // 端口在但端点不应答：浏览器正在启动或已僵死，按旧端口处理继续等。
      }
      /* 文件还没写出来 */
    }
    if (exited) throw new Error("浏览器启动后立刻退出了（被策略拦截？）")
    await sleep(120)
  }
  throw new Error("浏览器没有写出调试端口，启动失败。请重试，或改用「仅 API Key」登录。")
}

/**
 * 打开一个受控浏览器（插件专用 profile）并返回会话。
 * `token()` 通过 CDP 的 Network 域读浏览器级 cookie——不管当前标签页是 SSO
 * 的确认页还是别的，都能读到控制台会话。
 */
export async function openSession({ browserPath, profile, headless = false, plainBrowser = false, url = LOGIN_URL, log = () => {} } = {}) {
  const exe = requireBrowser(browserPath)
  if (!existsSync(profile)) mkdirSync(profile, { recursive: true, mode: 0o700 })
  // 所有权标记：removeProfile 只删带这个标记（或名字/位置可验为插件所有）的
  // 目录。MAGPIE_MOSS_PROFILE 把路径指到别处时，标记跟着本目录走，删除的
  // 边界仍然只在插件真正开过的 profile 上。
  try {
    writeFileSync(join(profile, ".moss-profile"), String(Date.now()))
  } catch {}
  const portFile = join(profile, "DevToolsActivePort")
  // 上一轮被强制关闭时可能留下端口/单例锁文件；没有浏览器运行时清掉是安全的。
  for (const name of ["DevToolsActivePort", "SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try {
      rmSync(join(profile, name), { force: true })
    } catch {}
  }
  const args = plainBrowser
    ? browserArgs(profile, 0, url, { headless, login: true })
    : browserArgs(profile, 0, url, { headless })
  const child = spawn(exe, args, { stdio: "ignore", env: browserEnv() })
  let cdp = null
  let closed = false
  const isConsoleCookie = (c) =>
    c?.name &&
    SESSION_COOKIE_NAMES.includes(String(c.name)) &&
    typeof c?.domain === "string" &&
    // 精确匹配域（含点前缀/子域）：includes 会放过 evil-mosi.cn 这类域。
    COOKIE_DOMAINS.some((d) => {
      const dom = c.domain.replace(/^\./, "").toLowerCase()
      return dom === d || dom.endsWith(`.${d}`)
    })
  try {
    const port = await waitForDebugPort(portFile, child)
    log(`browser debug port ${port}`)
    cdp = await Cdp.connect(port, { preferHost: new URL(url).host })
    await cdp.send("Network.enable")
    return {
      async token() {
        const res = await cdp.send("Network.getAllCookies")
        const match = (res?.cookies ?? []).find((c) => isConsoleCookie(c) && c.value)
        if (!match?.value) return ""
        const value = String(match.value)
        try {
          return value.includes("%") ? decodeURIComponent(value) : value
        } catch {
          return value
        }
      },
      async close() {
        if (closed) return
        closed = true
        // 优先通过 CDP 优雅退出（Browser.close 让 Chromium 把 cookie flush 到磁盘）；
        // 失败或超时才强制杀进程树。
        try {
          await Promise.race([cdp?.send("Browser.close"), sleep(1500)])
        } catch {
          /* 浏览器可能已退出 */
        }
        cdp?.detach()
        killTree(child)
        // Edge 在 Windows 上会"换父"：启动 PID 可能已退出而浏览器还活着，
        // 按 user-data-dir 兜底清一遍。
        killProfileProcesses(profile, log)
        await sleep(600)
      },
    }
  } catch (e) {
    cdp?.detach()
    killTree(child)
    killProfileProcesses(profile, log)
    await sleep(300)
    // Never delete the profile here: it holds the signed-in session, and a
    // transient launch failure must not force a fresh sign-in.
    throw e
  }
}

/** 轮询直到读到 token / 超时。 */
export async function waitForToken(session, { timeoutMs = 8 * 60_000, pollMs = 750, signal, log = () => {} } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) throw Object.assign(new Error("the sign-in was cancelled"), { cancelled: true })
    try {
      // 单次读也限死在剩余时间里：CDP 挂死时靠外层超时兜底退出。
      const left = deadline - Date.now()
      const token = await Promise.race([session.token(), sleep(Math.min(left, 15_000)).then(() => "")])
      if (token) return token
    } catch (e) {
      log(`browser read retry: ${e?.message ?? e}`)
    }
    await sleep(pollMs)
  }
  throw new Error("登录超时：没有在浏览器里完成登录")
}

/** 我们自己的那个浏览器进程的窗口标题（只按 PID，避免误看日常浏览器的窗口）。 */
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

/**
 * 优雅关闭：Windows 发 WM_CLOSE 让浏览器走正常退出流程（把 cookie 刷到磁盘）；
 * Unix 先 SIGTERM（Chromium 收到后同样把 cookie flush 出去再退出）。
 * 等它自己退出；超时才 SIGKILL——强杀会丢掉刚登录写下的 cookie。
 */
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
      // macOS/Linux 没有 powershell，也不要等它失败：直接 SIGTERM。
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

/**
 * 等登录窗口从 SSO/登录页跳到控制台。登录窗口没有 CDP（否则阿里的验证码
 * 过不了），完成信号有两个：
 *   - profile 的 Cookies sqlite 出现本次启动之后新增的会话行（最可靠，但
 *     Edge/Chrome 运行时对 cookie 库持独占锁，Windows 上常常读不到，只能
 *     作为「碰巧能读」的快路径）；
 *   - Windows 上轮询**我们自己的窗口**（按 PID，绝不碰日常浏览器）的标题：
 *     登录完成落在控制台某个页面，标题会稳定在业务页（如「API Key - 用户
 *     配置 1」）；登录前是 SSO/账号页（标题含「登录/用户认证/SSO」）。标题
 *     稳定（连续两次一致）且不是登录页，即认为登录完成。
 * 窗口被用户关掉也算结束（之后直接尝试读 cookie）。
 * `platform`/`titleOf`/`cookieProbe` 是测试注入口。
 */
export async function waitForConsoleWindow(
  child,
  {
    timeoutMs = 8 * 60_000,
    pollMs = 1000,
    signal,
    log = () => {},
    platform = process.platform,
    titleOf = windowTitleOf,
    settleMs = 5000,
    profile = "",
    cookieProbe = null,
  } = {},
) {
  const deadline = Date.now() + timeoutMs
  const started = Date.now()
  const canReadTitle = platform === "win32"
  const canProbeCookies = Boolean(profile) && typeof cookieProbe === "function"
  if (canProbeCookies && !canReadTitle) {
    log("watching the profile's cookie store for the console session (the window can be left open)")
  }
  // SSO/账号登录页的标题特征；这些页面出现说明还没登录完成。
  const LOGIN_PAGE = /用户认证|统一登录|账号登录|sign.?in|login|SSO/i
  // 业务页标题：控制台任意页面都算（favicon 的 MOSS 域标题、页面名等）。
  // 空标题（窗口最小化/标题被改写）不参与判断。
  let lastTitle = ""
  let hits = 0
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return "closed"
    if (signal?.aborted) return "aborted"
    // The profile's cookie store is the truth when it is readable at all
    // (Chromium holds the Cookies sqlite exclusively while running, so on
    // Windows this usually stays silent; off Windows it is the signal).
    if (canProbeCookies && cookieProbe(profile)) {
      log("the console session is in the profile; closing the window")
      return "console"
    }
    if (!canReadTitle) {
      await sleep(pollMs)
      continue
    }
    // 只看我们自己的窗口；给它至少 settleMs 秒，标题在跳转过程中会闪。
    const title = Date.now() - started >= settleMs ? titleOf(child.pid) : ""
    if (title && !LOGIN_PAGE.test(title)) {
      // 标题连续两次一致才算稳定（页面加载中标题会抖）。
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

/**
 * 浏览器登录：两段式。
 *
 * 1. 可见窗口，**不带 CDP**——阿里云的风控看到的是普通浏览器，验证码能过；
 * 2. 用窗口标题判断登录完成（Windows）或轮询 profile 的会话 cookie（其他
 *    平台），插件自己关窗；
 * 3. 同一个专用 profile 里 headless + CDP 读会话 cookie（此时登录已完成，
 *    不再影响验证码）。
 *
 * 登录态留在专用 profile 里（keepSignIn），续期和下次登录都直接用它。
 */
export async function signInWithBrowser({ browserPath, keepSignIn = true, timeoutMs = 8 * 60_000, waitForLogin, loginWait, signal, log = () => {} } = {}) {
  // before the one-off profile is made, so a missing browser leaves no folder
  const exe = requireBrowser(browserPath)
  const dir = keepSignIn ? profileDir() : oneOffProfileDir()
  const cancelled = () => Boolean(signal?.aborted)
  return await exclusive(async () => {
    log("opening the sign-in window")
    killProfileProcesses(dir, log)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    // keep_sign_in keeps the previous sign-in's session row, so "a row
    // exists" is not "this sign-in finished" — remember the rows there now,
    // and accept only one newer than this launch (or an overwritten one,
    // whose last_update_utc moved).
    const baseline = cookieBaseline(dir)
    try {
      const child = spawn(exe, browserArgs(dir, 0, LOGIN_URL, { cdp: false, login: true }), {
        stdio: "ignore",
        env: browserEnv(),
      })
      try {
        // waitForLogin is an injection point for tests: given it, the window
        // wait is replaced entirely and nothing in this module reads the env.
        const how = waitForLogin
          ? await waitForLogin({ child, signal })
          : await waitForConsoleWindow(child, {
              ...(loginWait ?? {}),
              timeoutMs,
              signal,
              log,
              // off Windows the profile's cookie store is the completion
              // signal — a row newer than this launch, unexpired, on the
              // console's domain. The window closes itself, no Cmd+Q needed
              // (Chrome writes cookies to disk on its own ~30s timer).
              // loginWait.cookieProbe is the test injection point; production
              // always uses the real sqlite probe with the launch baseline.
              profile: dir,
              cookieProbe:
                loginWait?.cookieProbe ?? ((probeProfile) => profileHasNewCookie(probeProfile, baseline)),
            })
        log(`login window finished (${how})`)
        if (how === "aborted") throw Object.assign(new Error("the sign-in was cancelled"), { cancelled: true })
        // 登录完成：让页面稳定一下，然后**优雅关闭**（WM_CLOSE），让浏览器
        // 把刚写下的 cookie 刷到磁盘；直接强杀会丢掉会话。
        await sleep(2000)
      } finally {
        await closeWindowGracefully(child, { log })
        killProfileProcesses(dir, log)
        await sleep(1500)
      }
      // 用 profile 里刚写下的会话读 token；遇到残留进程造成的"立刻退出"重试一次。
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (cancelled()) throw Object.assign(new Error("the sign-in was cancelled"), { cancelled: true })
        log(`reading the session from the profile (attempt ${attempt}/2)`)
        let s
        try {
          s = await openSession({ browserPath: exe, profile: dir, headless: true, log })
          log("profile session open; waiting for the console session cookie")
          const token = await waitForToken(s, { timeoutMs: 20_000, signal, log })
          if (!token) throw new Error("could not read the console session after the sign-in")
          log("session read; validating the account and creating the key")
          return token
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

/**
 * 静默续期：专用 profile 里 headless 打开控制台页，SSO 会话还在就会重新
 * 下会话 cookie。读不到就返回空串（交给调用方提示重新登录），不抛错。
 */
export async function renewSilently({ browserPath, timeoutMs = 20_000, log = () => {} } = {}) {
  const dir = profileDir()
  if (!existsSync(dir)) return ""
  // 登录正在进行时不要抢 profile：下一次额度刷新再续。
  if (profileBusy > 0) return ""
  return await exclusive(async () => {
    killProfileProcesses(dir, log)
    let session
    try {
      session = await openSession({ browserPath, profile: dir, headless: true, log })
      return await waitForToken(session, { timeoutMs, log })
    } catch (e) {
      log(`silent renewal failed: ${e?.message ?? e}`)
      return ""
    } finally {
      await session?.close().catch(() => {})
    }
  })
}

export { removeProfile, killTree, LOGIN_URL }
