// AStudio 网页登录的浏览器收割（CDP 管道客户端，移植自 mclaw/browser.mjs，
// 后者整体移植自 gcp-ai 插件，MIT）。
//
// Chrome/Edge 以 --remote-debugging-pipe 启动：CDP 走本进程的 fd 3/4（NUL 分隔
// JSON），不监听任何 TCP 端口，机器上其他进程碰不到这个浏览器会话。每次登录用
// 全新 profile（随机子目录），绝不复用旧登录态——换账号登录、会话被吊销后重登
// 都不会捡到上一次的 Cookie；登录收尾后目录即删（会话已进账号 metadata.session，
// 浏览器目录只是第二份凭据副本）。
import { spawn } from "node:child_process"
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createHash, randomBytes } from "node:crypto"
import { homedir, tmpdir } from "node:os"
import { join, dirname, resolve } from "node:path"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const configRoot = () => process.env.XDG_CONFIG_HOME
  || (process.platform === "win32" && process.env.APPDATA ? process.env.APPDATA : join(homedir(), ".config"))
const cacheRoot = () => process.env.XDG_CACHE_HOME
  || (process.platform === "win32" && process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA : join(homedir(), ".cache"))

// 登录态 profile 的根（ASTUDIO_BROWSER_PROFILE 可覆盖）。
export const profilesRoot = () => process.env.ASTUDIO_BROWSER_PROFILE
  ? resolve(process.env.ASTUDIO_BROWSER_PROFILE.startsWith("~") ? join(homedir(), process.env.ASTUDIO_BROWSER_PROFILE.slice(2)) : process.env.ASTUDIO_BROWSER_PROFILE)
  : join(configRoot(), "magpie", "astudio-browser-profiles")

// 一次新登录的专属 profile：随机子目录，绝不带旧票。
export const freshSigninProfile = () => join(profilesRoot(), `signin-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`)

// 删掉一个登录用过的 profile：成功、失败、取消、超时都不留——会话已进账号
// metadata.session，浏览器目录只是第二份凭据副本。
export async function removeProfile(profilePath) {
  if (profilePath) await rm(profilePath, { recursive: true, force: true }).catch(() => {})
}

// ---------------------------------------------------------------- profile 锁
// 同一 profile 的多个操作串行化：mkdir 原子抢锁，抢不到就排队。锁从抢到那一刻
// 一直持到 release() 被调（浏览器关掉之后）。
const LOCK_TIMEOUT = 180_000

async function claimProfileLock(profilePath) {
  const lockDir = join(cacheRoot(), "magpie", "astudio", "profiles",
    createHash("sha256").update(profilePath).digest("hex").slice(0, 16))
  await mkdir(dirname(lockDir), { recursive: true }).catch(() => {})
  const deadline = Date.now() + LOCK_TIMEOUT
  for (;;) {
    try {
      await mkdir(lockDir)
      await writeFile(join(lockDir, "pid"), String(process.pid)).catch(() => {})
      break
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      // 持锁进程已经死了（上次没来得及清理）就偷走这把锁。
      const holder = await readFile(join(lockDir, "pid"), "utf8").then((t) => Number(t.trim())).catch(() => NaN)
      if (Number.isFinite(holder) && holder !== process.pid) {
        let alive = true
        try { process.kill(holder, 0) } catch (e) { alive = e.code === "EPERM" }
        if (!alive) {
          await rm(lockDir, { recursive: true, force: true }).catch(() => {})
          continue
        }
      }
      if (Date.now() >= deadline) throw new Error("AStudio 浏览器 profile 被其他操作占用，请稍后重试")
      await sleep(500)
    }
  }
  let released = false
  return async () => {
    if (released) return
    released = true
    await rm(lockDir, { recursive: true, force: true }).catch(() => {})
  }
}

// ---------------------------------------------------------------- CDP 管道客户端

const timeoutError = (message) => Object.assign(new Error(message), { name: "TimeoutError" })
// 超时提示按量级选单位：不足 1 分钟说「45 秒」，别渲染成「0 分钟」。
const durationLabel = (ms) => (ms >= 60_000
  ? `${Math.round(ms / 60_000)} 分钟`
  : `${Math.max(1, Math.round(ms / 1000))} 秒`)

// Chrome 每写完一个 JSON 消息跟一个 NUL。
class Pipe {
  constructor(child) {
    this.child = child
    this.toChrome = child.stdio[3]
    this.fromChrome = child.stdio[4]
    this.buffer = ""
    this.nextId = 1
    this.pending = new Map()
    this.events = new Map()
    this.closed = false
    this.closedReason = "Chrome was closed"
    this.fromChrome.setEncoding("utf8")
    this.fromChrome.on("data", (chunk) => this.read(chunk))
    this.fromChrome.on("end", () => this.shut("Chrome closed the debugging connection"))
    this.fromChrome.on("error", () => this.shut("Chrome closed the debugging connection"))
    this.toChrome.on("error", () => this.shut("Chrome closed the debugging connection"))
    child.once("exit", (code) => this.shut(`Chrome exited (${code ?? "signal"})`))
  }

  read(chunk) {
    this.buffer += chunk
    for (let end = this.buffer.indexOf("\0"); end >= 0; end = this.buffer.indexOf("\0")) {
      const raw = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 1)
      let message
      try { message = JSON.parse(raw) } catch { continue }
      if (message.id === undefined) {
        for (const listener of this.events.get(`${message.sessionId ?? ""}:${message.method}`) ?? []) listener(message.params ?? {})
        continue
      }
      const pending = this.pending.get(message.id)
      if (!pending) continue
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message ?? "Chrome refused the command"))
      else pending.resolve(message.result ?? {})
    }
  }

  shut(reason) {
    if (this.closed) return
    this.closed = true
    this.closedReason = reason
    for (const { reject } of this.pending.values()) reject(new Error(reason))
    this.pending.clear()
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error(this.closedReason))
    const id = this.nextId++
    const message = { id, method, params, ...(sessionId ? { sessionId } : {}) }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.toChrome.write(JSON.stringify(message) + "\0")
    })
  }
}

class Page {
  constructor(connection, sessionId, targetId) {
    this.connection = connection
    this.sessionId = sessionId
    this.targetId = targetId
    this.closed = false
  }

  send(method, params) {
    return this.connection.send(method, params, this.sessionId)
  }

  isClosed() {
    return this.closed || this.connection.closed
  }

  async close() {
    if (this.closed) return
    this.closed = true
    if (this.connection.closed) return
    await this.connection.send("Target.closeTarget", { targetId: this.targetId }).catch(() => {})
  }
}

export class Browser {
  constructor(child, connection) {
    this.child = child
    this.connection = connection
    this.pages = new Set()
  }

  async firstPage(timeout = 15000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const { targetInfos = [] } = await this.connection.send("Target.getTargets").catch(() => ({}))
      const found = targetInfos.find((target) => target.type === "page")
      if (found) {
        const { sessionId } = await this.connection.send("Target.attachToTarget", { targetId: found.targetId, flatten: true })
        const page = new Page(this.connection, sessionId, found.targetId)
        this.pages.add(page)
        page.send("Page.enable").catch(() => {})
        return page
      }
      if (this.connection.closed) throw new Error(this.connection.closedReason)
      await sleep(100)
    }
    throw new Error("浏览器没有打开页面")
  }

  // 关进程 = 收掉 profile 会话：Cookie 留在磁盘上，也不会留下无主浏览器。
  async close() {
    for (const page of this.pages) page.closed = true
    const exited = new Promise((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) resolve()
      else this.child.once("exit", resolve)
    })
    await this.connection.send("Browser.close").catch(() => {})
    this.connection.shut("Browser was closed")
    const gone = await Promise.race([
      exited.then(() => true),
      sleep(5000).then(() => false),
    ])
    if (!gone) {
      this.child.kill("SIGTERM")
      const stopped = await Promise.race([exited.then(() => true), sleep(3000).then(() => false)])
      if (!stopped) {
        this.child.kill("SIGKILL")
        await Promise.race([exited, sleep(2000)])
      }
    }
  }
}

function launch(executable, args, { timeout = 30000 } = {}) {
  const child = spawn(executable, [...args, "--remote-debugging-pipe"], {
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    detached: false,
  })
  const connection = new Pipe(child)
  const failed = new Promise((_, reject) => {
    child.once("error", (error) => {
      connection.shut("Browser could not be started")
      reject(error.code === "ENOENT"
        ? new Error("找不到浏览器；请安装 Chrome/Edge，或用 ASTUDIO_CHROME_PATH 指到可执行文件")
        : new Error(`浏览器无法启动：${error.message}`))
    })
    child.once("exit", (code) => {
      connection.shut(`Browser exited (${code ?? "signal"})`)
    })
  })
  failed.catch(() => {})
  const browser = new Browser(child, connection)
  return Promise.race([browser.firstPage(timeout).then((page) => ({ browser, page })), failed])
}

// ---------------------------------------------------------------- 浏览器定位

export async function browserExecutable() {
  const override = process.env.ASTUDIO_CHROME_PATH
  if (override) return resolve(override.startsWith("~") ? join(homedir(), override.slice(2)) : override)
  const candidates = process.platform === "win32"
    ? [
      process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
      process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
      process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
      process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Chromium", "Application", "chrome.exe"),
    ].filter(Boolean)
    : process.platform === "darwin"
      ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        join(homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"]
  for (const path of candidates) {
    try { await access(path); return path } catch {}
  }
  throw new Error("找不到 Chrome/Edge；请安装其中一个，或用 ASTUDIO_CHROME_PATH 指到可执行文件")
}

// ---------------------------------------------------------------- 打开/收割

/** 用专属 profile 开浏览器（登录用 headless: false，用户手动操作窗口）。
 *  返回 { browser, page, profilePath, release }：release() 在 close() 之后调用才放锁。 */
export async function openBrowser({ headless = false, startUrl = "about:blank", profilePath = freshSigninProfile() } = {}) {
  const release = await claimProfileLock(profilePath)
  try {
    await mkdir(profilePath, { recursive: true, mode: 0o700 })
    const args = [
      `--user-data-dir=${profilePath}`,
      "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking", "--disable-sync", "--disable-default-apps",
      "--disable-component-update", "--disable-client-side-phishing-detection",
      "--disable-domain-reliability",
      "--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider",
      "--metrics-recording-only", "--no-service-autorun",
      // Cookie 存储用 mock keychain，不碰 macOS 钥匙串 / Linux keyring。
      ...(process.platform === "darwin" ? ["--use-mock-keychain"] : process.platform === "linux" ? ["--password-store=basic"] : []),
      "--window-size=1280,900",
      ...(headless ? ["--headless=new", "--disable-gpu"] : []),
      "--crash-dumps-dir=" + tmpdir(),
      startUrl,
    ]
    const started = await launch(await browserExecutable(), args)
    return { ...started, profilePath, release }
  } catch (error) {
    await release()
    await removeProfile(profilePath)
    throw error
  }
}

// 网页登录成功后写进 Cookie 的三件套（web bundle 从 URL 参数落到 document.cookie）。
const COOKIE_DOMAIN = /(^|\.)xfyun\.cn$/i
// 同名 Cookie 可能在 .xfyun.cn 和 agent.xfyun.cn 各有一份：登录页写的是
// host-only 的 agent.xfyun.cn，优先它，其次根域，最后其他子域（如 passport）。
const domainRank = (cookie) => {
  const domain = String(cookie?.domain ?? "").replace(/^\./, "").toLowerCase()
  if (domain === "agent.xfyun.cn") return 3
  if (domain === "xfyun.cn") return 2
  return 1
}
const pickCookie = (cookies, names) =>
  cookies
    .filter((c) => names.includes(c?.name) && COOKIE_DOMAIN.test(String(c?.domain ?? "")) && c?.value)
    .sort((a, b) => domainRank(b) - domainRank(a))[0]

/** 读 AStudio 网页会话 Cookie（含 httpOnly；CDP 直读浏览器 Cookie 库）。
 *  返回 { session: {token, accountId, ssoSessionId?} } 或 undefined。 */
export async function harvestAstronSession(browser) {
  const { cookies = [] } = await browser.connection.send("Storage.getCookies").catch(() => ({}))
  const token = pickCookie(cookies, ["token"])
  const account = pickCookie(cookies, ["account_id", "accountId"])
  const sso = pickCookie(cookies, ["ssoSessionId", "sso_sessionid"])
  // 网页登录写的是 ssoSessionId + account_id（token 只是 SSO 顺带给的，可能没有；
  // 2026-11-06 实测账号面与换发接口只用前两个也能通过）。
  if (!account?.value || !sso?.value) return undefined
  return {
    session: {
      ...(token?.value ? { token: token.value } : {}),
      accountId: account.value,
      ssoSessionId: sso.value,
    },
  }
}

/** 浏览器登录全流程：有头浏览器（全新 profile）→ 用户在窗口里完成讯飞登录 →
 *  收割 Cookie。返回 { promise, abort }：promise resolve { session, profilePath,
 *  release, close }。abort() 随时可调（宿主取消）；成功/失败/取消/超时都删掉
 *  profile 目录——会话已进账号 metadata，浏览器目录不留第二份凭据。
 *  removeProfileImpl 只为测试能观测清理动作，生产不传。 */
export function startBrowserHarvest({ deadlineMs = 600_000, startUrl, profilePath = freshSigninProfile(), open = openBrowser, removeProfileImpl = removeProfile } = {}) {
  const harvest = { promise: undefined, abort: async () => {} }
  harvest.promise = (async () => {
    let aborted = false
    let opened // { browser, release }：浏览器开出后持有，成功时移交 callback
    let usedPath = profilePath
    harvest.abort = async () => {
      if (aborted) return
      aborted = true
      if (opened) {
        await opened.browser.close().catch(() => {})
        await opened.release()
      }
      // 宿主取消时 callback 不会再被调，profile 没人认领；成功路径下 callback
      // 自己也会删（rm 幂等），所以这里一律删。
      await removeProfileImpl(usedPath)
    }
    try {
      const { browser, profilePath: used, release } = await open({ headless: false, startUrl, profilePath })
      opened = { browser, release }
      usedPath = used
      if (aborted) throw new Error("登录已取消")
      const deadline = Date.now() + deadlineMs
      for (;;) {
        if (aborted) throw new Error("登录已取消")
        if (browser.connection.closed) throw new Error("浏览器被关闭，登录中断")
        const found = await harvestAstronSession(browser).catch(() => undefined)
        if (found) return { ...found, profilePath: used, release, close: () => browser.close() }
        if (Date.now() >= deadline) throw timeoutError(`登录超时（${durationLabel(deadlineMs)}内没有检测到 AStudio 登录）`)
        await sleep(1500)
      }
    } catch (error) {
      if (opened) {
        await opened.browser.close().catch(() => {})
        await opened.release()
      }
      await removeProfileImpl(usedPath)
      throw error
    }
  })()
  return harvest
}
