// 受控浏览器登录：插件自己的专用浏览器 profile。
//
// 设计的三条硬边界（都是在这台机器上验证过的事实）：
//   1. Edge/Chrome 136+ 拒绝在**默认用户数据目录**上开远程调试端口——所以
//      "直接调试你日常浏览器"这条路在浏览器层面就被堵死了；
//   2. 把你日常浏览器的数据从别的路径打开（拷贝/联接），Edge 会把解不开的
//      cookie（v20 应用绑定加密）直接清掉——等于毁掉你的登录态；
//   3. 所以唯一可行的路：插件自己的专用 profile（非默认目录，调试端口
//      正常），登录一次后 cookie 留在里面，之后的续期/重登都在这个
//      profile 里静默完成。
//
// 登录窗口**不带**调试端口（阿里的风控看到的是普通浏览器，验证码才能过）；
// 只有 headless 读取会话时才开 CDP，且全程只用 Network 域
// （Network.getAllCookies 读浏览器级 cookie），不碰 Runtime.evaluate，
// 不在页面里注入任何东西。
// Windows 上插件用窗口标题判断登录完成并自己关窗；macOS / Linux 读不了窗口
// 标题，登录完成后用户自己关窗，插件收残局。
//
// Bun 1.3.1 在 Windows 上"关掉 CDP WebSocket + 立刻杀进程/删目录"会偶发
// 原生崩溃：收尾时不调用 ws.close()，profile 目录交给系统 rmdir 删。

import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const LOGIN_URL = "https://discovery.intern-ai.org.cn/token-plan/home"

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

/** 本机可用的 Chromium 系浏览器；`MAGPIE_INKSTONE_BROWSER` 可覆盖。 */
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
  if (env.MAGPIE_INKSTONE_BROWSER) push(env.MAGPIE_INKSTONE_BROWSER)
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
 * 浏览器登录要用的那个浏览器；本机一个 Chromium 系浏览器都没有就抛错。
 * authorize() 和真正启动浏览器的地方都走这里，提示语只有一份。
 * `candidates` 只给测试用。
 */
export function requireBrowser(explicit, { candidates = browserCandidates, platform = process.platform } = {}) {
  const list = candidates(explicit)
  if (list.length) return list[0]
  let msg =
    "The browser sign-in needs Microsoft Edge, Google Chrome or Chromium, and none is installed. " +
    'Sign in with "API key only", or with "API key + console token" to also get the ink-credit card. ' +
    "Or install one of those browsers, or set MAGPIE_INKSTONE_BROWSER to its path."
  if (platform === "darwin") msg += " Safari can't be used: the sign-in runs in its own browser profile, which Safari doesn't support."
  throw new Error(msg)
}

/** 插件专用（可续期）profile 的目录；不同平台放各自的应用数据目录。 */
export function profileDir(env = process.env, platform = process.platform) {
  if (env.MAGPIE_INKSTONE_PROFILE) return env.MAGPIE_INKSTONE_PROFILE
  if (platform === "win32") return join(env.LOCALAPPDATA || env.APPDATA || tmpdir(), "magpie", "inkstone-browser")
  return join(env.XDG_CONFIG_HOME || join(env.HOME || tmpdir(), ".config"), "magpie", "inkstone-browser")
}

/** 一次性 profile：登录完就删，不把登录态留在磁盘上。 */
export function oneOffProfileDir() {
  return mkdtempSync(join(tmpdir(), "magpie-inkstone-login-"))
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

/** `uaa-token` 的值：js-cookie 写的是 URL 编码，读的时候解一次。 */
export function readUaaToken(cookieString) {
  const m = /(?:^|;\s*)uaa-token=([^;]*)/.exec(String(cookieString ?? ""))
  if (!m || !m[1]) return ""
  try {
    return decodeURIComponent(m[1])
  } catch {
    return m[1]
  }
}

/** JWT 的 exp（毫秒），不是 JWT 或读不出 → 0。 */
export function jwtExp(token) {
  const parts = String(token ?? "").split(".")
  if (parts.length !== 3) return 0
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
    const exp = Number(payload?.exp)
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0
  } catch {
    return 0
  }
}

/** token 是否还够用（不知道 exp 就当够用，交给 401 去判断）。 */
export function tokenFresh(token, leadMs) {
  const exp = jwtExp(token)
  return !exp || exp - Date.now() > leadMs
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

function killProfileProcessesWindows(profile, log = () => {}) {
  try {
    const filter = String(profile).replace(/'/g, "''")
    // .Contains() 而不是 -like：-like 会把路径里的 [ ] 当通配符。
    spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "name like '%msedge%' or name like '%chrome%'" | ` +
          `Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${filter}') } | ` +
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
    // 做正则，裸路径里的 . 会匹配任意字符、短路径会误杀无关进程。
    const pattern = `--user-data-dir=${String(profile).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
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

async function removeProfile(dir) {
  if (!dir || !existsSync(dir)) return true
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
 * `token()` 通过 CDP 的 Network 域读浏览器级 cookie——不管当前标签页是
 * Edge 的同步确认页还是别的，都能读到 `uaa-token`。
 */
export async function openSession({ browserPath, profile, headless = false, plainBrowser = false, url = LOGIN_URL, log = () => {} } = {}) {
  const exe = requireBrowser(browserPath)
  if (!existsSync(profile)) mkdirSync(profile, { recursive: true, mode: 0o700 })
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
  try {
    const port = await waitForDebugPort(portFile, child)
    log(`browser debug port ${port}`)
    cdp = await Cdp.connect(port, { preferHost: new URL(url).host })
    await cdp.send("Network.enable")
    return {
      async token() {
        const res = await cdp.send("Network.getAllCookies")
        const match = (res?.cookies ?? []).find(
          (c) =>
            c?.name === "uaa-token" &&
            typeof c?.domain === "string" &&
            // 精确匹配：includes 会放过 evilintern-ai.org.cn 这类域。
            (c.domain === "intern-ai.org.cn" || c.domain.endsWith(".intern-ai.org.cn")),
        )
        if (match?.value) {
          const value = String(match.value)
          try {
            return value.includes("%") ? decodeURIComponent(value) : value
          } catch {
            return value
          }
        }
        return ""
      },
      async close() {
        if (closed) return
        closed = true
        // 优先通过 CDP 优雅退出（Browser.close 让 Chromium 把 cookie flush 到磁盘）；
        // 失败或超时才强制杀进程树。
        try {
          await Promise.race([
            cdp?.send("Browser.close"),
            sleep(1500),
          ])
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
      const token = await Promise.race([
        session.token(),
        sleep(Math.min(left, 15_000)).then(() => ""),
      ])
      if (token) return token
    } catch (e) {
      log(`browser read retry: ${e?.message ?? e}`)
    }
    await sleep(pollMs)
  }
  throw new Error("登录超时：没有在浏览器里完成登录")
}

/** 我们自己的那个浏览器进程的窗口标题（只按 PID，避免误看你日常 Edge 的窗口）。 */
export function windowTitleOf(pid, platform = process.platform) {
  if (platform !== "win32" || !pid) return ""
  try {
    const r = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", `(Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue).MainWindowTitle`],
      { encoding: "utf8", windowsHide: true, timeout: 5000 },
    )
    return String(r.stdout ?? "").trim()
  } catch {
    return ""
  }
}

/**
 * 优雅关闭：Windows 发 WM_CLOSE 让 Edge 走正常退出流程（会把 cookie 刷到磁盘）；
 * Unix 先 SIGTERM（Chromium 收到后同样把 cookie flush 出去再退出）。
 * 等它自己退出；超时才 SIGKILL——强杀会丢掉刚登录写下的 cookie。
 */
export async function closeWindowGracefully(child, { timeoutMs = 15_000, log = () => {} } = {}) {
  if (!child) return
  try {
    if (process.platform === "win32") {
      spawnSync(
        "powershell",
        ["-NoProfile", "-Command", `(Get-Process -Id ${Number(child.pid)} -ErrorAction SilentlyContinue).CloseMainWindow()`],
        { stdio: "ignore", windowsHide: true, timeout: 10_000 },
      )
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
 * 等登录窗口从 SSO 页跳到控制台。
 *
 * 登录窗口没有 CDP（否则阿里的验证码过不了），所以用窗口标题做完成信号：
 * SSO 页是「上海人工智能实验室-用户认证体系」，控制台是「书生·端砚 Intern
 * InkStone」。窗口被用户关掉也算结束（之后直接尝试读 cookie）。
 */
/**
 * 登录窗口的完成等待。可测试：`platform` 参数让非 Windows 的"只认进程退出"
 * 行为在任何宿主上都能被验证。
 */
export async function waitForConsoleWindow(
  child,
  { timeoutMs = 8 * 60_000, pollMs = 1000, signal, log = () => {}, platform = process.platform, titleOf = windowTitleOf, settleMs = 5000 } = {},
) {
  const deadline = Date.now() + timeoutMs
  const started = Date.now()
  // 窗口标题只能靠 Windows 的 Get-Process 读；别的平台就以“用户关掉窗口”
  // 作为完成信号（提示语里会说明），否则只能干等满整个超时。
  const canReadTitle = platform === "win32"
  let hits = 0
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return "closed"
    if (signal?.aborted) return "aborted"
    if (!canReadTitle) {
      await sleep(pollMs)
      continue
    }
    // 只看我们自己的窗口；并且给它至少 5 秒，控制台标题在跳转 SSO 前会闪一下。
    const title = Date.now() - started >= settleMs ? titleOf(child.pid) : ""
    if (title && /Intern InkStone|端砚/i.test(title) && !/用户认证|登录/i.test(title)) {
      hits += 1
      if (hits >= 2) return "console"
    } else {
      hits = 0
    }
    await sleep(pollMs)
  }
  return "timeout"
}

/**
 * 浏览器登录：两段式。
 *
 * 1. 可见窗口，**不带 CDP**——阿里的风控看到的是普通浏览器，验证码能过；
 * 2. 用窗口标题判断登录完成（SSO → 控制台），插件自己关窗；
 * 3. 同一个专用 profile 里 headless + CDP 读 `uaa-token`（此时登录已完成，
 *    不再影响验证码）。
 *
 * 登录态留在专用 profile 里（keepSignIn），续期和下次登录都直接用它。
 */
export async function signInWithBrowser({ browserPath, keepSignIn = true, timeoutMs = 8 * 60_000, waitForLogin, signal, log = () => {} } = {}) {
  // before the one-off profile is made, so a missing browser leaves no folder
  const exe = requireBrowser(browserPath)
  const dir = keepSignIn ? profileDir() : oneOffProfileDir()
  const cancelled = () => Boolean(signal?.aborted)
  return await exclusive(async () => {
    log("opening the sign-in window")
    killProfileProcesses(dir, log)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
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
          : await waitForConsoleWindow(child, { timeoutMs, signal, log })
        log(`login window finished (${how})`)
        if (how === "aborted") throw Object.assign(new Error("the sign-in was cancelled"), { cancelled: true })
        // 登录完成：让页面稳定一下，然后**优雅关闭**（WM_CLOSE），让 Edge
        // 把刚写下的 cookie 刷到磁盘；直接强杀会丢掉 uaa-token。
        await sleep(2000)
      } finally {
        await closeWindowGracefully(child, { log })
        killProfileProcesses(dir, log)
        await sleep(1500)
      }
      // 用 profile 里刚写下的会话读 token；遇到残留进程造成的"立刻退出"重试一次。
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (cancelled()) throw Object.assign(new Error("the sign-in was cancelled"), { cancelled: true })
        let s
        try {
          s = await openSession({ browserPath: exe, profile: dir, headless: true, log })
          const token = await waitForToken(s, { timeoutMs: 20_000, signal, log })
          if (!token) throw new Error("could not read the console session after the sign-in")
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
 * 下 `uaa-token`。读不到就返回空串（交给调用方提示重新登录），不抛错。
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
