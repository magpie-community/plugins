#!/usr/bin/env bun
/**
 * 浏览器登录与续期的 Chrome DevTools 协议（CDP）客户端。
 *
 * Chrome 以 --remote-debugging-pipe 启动：CDP 走本进程的 fd 3/4（NUL 分隔 JSON），
 * 不监听任何 TCP 端口，机器上其他进程碰不到这个浏览器会话，插件也只会驱动
 * 自己启动的 Chrome。整体移植自 gcp-ai 插件的管道客户端（MIT）。
 *
 * 专属 user-data 目录（profile）保存移动云网页登录态：每个账号/每次登录一个
 * 独立 profile（目录存进账号 metadata），登录一次后 Cookie 长期存在，续期时
 * 用 --headless=new 复开该账号自己的 profile，网页应用自己会刷新会话。
 */
import { spawn } from 'node:child_process'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 用户配置根（XDG_CONFIG_HOME 优先，Windows 用 %APPDATA%，其余 ~/.config）。 */
const configRoot = () => process.env.XDG_CONFIG_HOME
  || (process.platform === 'win32' && process.env.APPDATA ? process.env.APPDATA : join(homedir(), '.config'))
/** 用户缓存根（Windows 用 %LOCALAPPDATA%，其余 ~/.cache）。 */
const cacheRoot = () => process.env.XDG_CACHE_HOME
  || (process.platform === 'win32' && process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA : join(homedir(), '.cache'))

/** 登录态 profile 目录的根（可用 MCLAW_BROWSER_PROFILE 覆盖）。每个账号/每次
 *  登录用根下的一个独立子目录，互不串票；老版本的共享目录 defaultProfile()
 *  只作为老账号（metadata 里没存 profile）续期的兜底。 */
export const profilesRoot = () => process.env.MCLAW_BROWSER_PROFILE
  ? resolve(process.env.MCLAW_BROWSER_PROFILE.startsWith('~') ? join(homedir(), process.env.MCLAW_BROWSER_PROFILE.slice(2)) : process.env.MCLAW_BROWSER_PROFILE)
  : join(configRoot(), 'magpie', 'mclaw-browser-profiles')

/** 老版本的共享 profile 目录（0.5.0 之前所有账号共用这一个）。 */
export const defaultProfile = () => process.env.MCLAW_BROWSER_PROFILE
  ? resolve(process.env.MCLAW_BROWSER_PROFILE.startsWith('~') ? join(homedir(), process.env.MCLAW_BROWSER_PROFILE.slice(2)) : process.env.MCLAW_BROWSER_PROFILE)
  : join(configRoot(), 'magpie', 'mclaw-browser-profile')

/** 一次新登录的专属 profile 目录：随机子目录，绝不复用旧登录态——
 *  换账号登录、票被服务端吊销后重登，都不会捡到上一次的 Cookie。 */
export const freshSigninProfile = () => join(profilesRoot(), `signin-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`)

// ---------------------------------------------------------------- profile 锁
// 同一 profile 的多个操作（登录/续期）串行化：mkdir 原子抢锁，抢不到就排队。
// 锁从抢到那一刻一直持到 release() 被调（浏览器关掉之后），而不是只在启动期。
const LOCK_TIMEOUT = 180_000

async function claimProfileLock(profilePath) {
  const lockDir = join(cacheRoot(), 'magpie', 'mclaw', 'profiles',
    createHash('sha256').update(profilePath).digest('hex').slice(0, 16))
  await mkdir(dirname(lockDir), { recursive: true }).catch(() => {})
  const deadline = Date.now() + LOCK_TIMEOUT
  for (;;) {
    try {
      await mkdir(lockDir)
      await writeFile(join(lockDir, 'pid'), String(process.pid)).catch(() => {})
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      // 持锁进程已经死了（上次没来得及清理）就偷走这把锁。
      const holder = await readFile(join(lockDir, 'pid'), 'utf8').then((t) => Number(t.trim())).catch(() => NaN)
      if (Number.isFinite(holder) && holder !== process.pid) {
        let alive = true
        try { process.kill(holder, 0) } catch (e) { alive = e.code === 'EPERM' }
        if (!alive) {
          await rm(lockDir, { recursive: true, force: true }).catch(() => {})
          continue
        }
      }
      if (Date.now() >= deadline) throw new Error('MClaw 浏览器 profile 被其他操作占用，请稍后重试')
      await sleep(500)
    }
  }
  let released = false
  // 返回的 release 是 awaitable：调用方必须等它跑完再退出进程，否则 rm 会丢。
  return async () => {
    if (released) return
    released = true
    await rm(lockDir, { recursive: true, force: true }).catch(() => {})
  }
}

// ---------------------------------------------------------------- CDP 管道客户端

const timeoutError = (message) => Object.assign(new Error(message), { name: 'TimeoutError' })

// Chrome 每写完一个 JSON 消息跟一个 NUL。
class Pipe {
  constructor(child) {
    this.child = child
    this.toChrome = child.stdio[3]
    this.fromChrome = child.stdio[4]
    this.buffer = ''
    this.nextId = 1
    this.pending = new Map()
    this.events = new Map()
    this.closed = false
    this.closedReason = 'Chrome was closed'
    this.fromChrome.setEncoding('utf8')
    this.fromChrome.on('data', (chunk) => this.read(chunk))
    this.fromChrome.on('end', () => this.shut('Chrome closed the debugging connection'))
    this.fromChrome.on('error', () => this.shut('Chrome closed the debugging connection'))
    this.toChrome.on('error', () => this.shut('Chrome closed the debugging connection'))
    child.once('exit', (code) => this.shut(`Chrome exited (${code ?? 'signal'})`))
  }

  read(chunk) {
    this.buffer += chunk
    for (let end = this.buffer.indexOf('\0'); end >= 0; end = this.buffer.indexOf('\0')) {
      const raw = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 1)
      let message
      try { message = JSON.parse(raw) } catch { continue }
      if (message.id === undefined) {
        for (const listener of this.events.get(`${message.sessionId ?? ''}:${message.method}`) ?? []) listener(message.params ?? {})
        continue
      }
      const pending = this.pending.get(message.id)
      if (!pending) continue
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message ?? 'Chrome refused the command'))
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
      this.toChrome.write(JSON.stringify(message) + '\0')
    })
  }
}

// 一个标签页：导航、执行表达式、等表达式为真。
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

  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    })
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description?.split('\n')[0] ?? exceptionDetails.text ?? '页面执行出错')
    }
    return result?.value
  }

  async goto(url, { timeout = 60000 } = {}) {
    if (this.closed) throw new Error('页面已关闭，无法导航')
    const { errorText } = await this.send('Page.navigate', { url })
    if (errorText) throw new Error(`无法打开 ${url}：${errorText}`)
    const deadline = Date.now() + Math.min(timeout, 30000)
    while (Date.now() < deadline) {
      try {
        const state = await this.evaluate('document.readyState')
        if (state && state !== 'loading') return
      } catch (error) {
        if (this.isClosed()) return
        if (!/context|navigated|not available|Target closed/i.test(error.message)) throw error
      }
      await sleep(100)
    }
  }

  async close() {
    if (this.closed) return
    this.closed = true
    if (this.connection.closed) return
    await this.connection.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {})
  }
}

export class Browser {
  constructor(child, connection) {
    this.child = child
    this.connection = connection
    this.pages = new Set()
  }

  async newPage(url = 'about:blank') {
    const { targetId } = await this.connection.send('Target.createTarget', { url })
    const { sessionId } = await this.connection.send('Target.attachToTarget', { targetId, flatten: true })
    const page = new Page(this.connection, sessionId, targetId)
    this.pages.add(page)
    page.send('Page.enable').catch(() => {})
    return page
  }

  async firstPage(timeout = 15000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const { targetInfos = [] } = await this.connection.send('Target.getTargets').catch(() => ({}))
      const found = targetInfos.find((target) => target.type === 'page')
      if (found) {
        const { sessionId } = await this.connection.send('Target.attachToTarget', { targetId: found.targetId, flatten: true })
        const page = new Page(this.connection, sessionId, found.targetId)
        this.pages.add(page)
        page.send('Page.enable').catch(() => {})
        return page
      }
      if (this.connection.closed) throw new Error(this.connection.closedReason)
      await sleep(100)
    }
    throw new Error('Chrome 没有打开页面')
  }

  // 关进程 = 收掉 profile 会话：Cookie 留在磁盘上，也不会留下无主 Chrome。
  // Promise 在进程退出后才 settle，持锁方因此能确定下一个 Chrome 不会叠上来。
  async close() {
    for (const page of this.pages) page.closed = true
    const exited = new Promise((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) resolve()
      else this.child.once('exit', resolve)
    })
    await this.connection.send('Browser.close').catch(() => {})
    this.connection.shut('Chrome was closed')
    const gone = await Promise.race([
      exited.then(() => true),
      sleep(5000).then(() => false),
    ])
    if (!gone) {
      this.child.kill('SIGTERM')
      const stopped = await Promise.race([exited.then(() => true), sleep(3000).then(() => false)])
      if (!stopped) {
        this.child.kill('SIGKILL')
        await Promise.race([exited, sleep(2000)])
      }
    }
  }
}

function launch(executable, args, { timeout = 30000 } = {}) {
  const child = spawn(executable, [...args, '--remote-debugging-pipe'], {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    detached: false,
  })
  const connection = new Pipe(child)
  const failed = new Promise((_, reject) => {
    child.once('error', (error) => {
      connection.shut('Chrome could not be started')
      reject(error.code === 'ENOENT'
        ? new Error('找不到 Chrome；请安装 Google Chrome 或用 MCLAW_CHROME_PATH 指到可执行文件')
        : new Error(`Chrome 无法启动：${error.message}`))
    })
    child.once('exit', (code) => {
      connection.shut(`Chrome exited (${code ?? 'signal'})`)
    })
  })
  failed.catch(() => {})
  const browser = new Browser(child, connection)
  // profile 已被别的 Chrome 占用时，第二次启动会立刻退出（表现为管道关闭）。
  return Promise.race([browser.firstPage(timeout).then((page) => ({ browser, page })), failed])
}

// ---------------------------------------------------------------- Chrome 定位

export async function chromeExecutable() {
  const override = process.env.MCLAW_CHROME_PATH
  if (override) return resolve(override.startsWith('~') ? join(homedir(), override.slice(2)) : override)
  const candidates = process.platform === 'win32'
    ? [
      process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Chromium', 'Application', 'chrome.exe'),
    ].filter(Boolean)
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', join(homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome')]
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium']
  for (const path of candidates) {
    try { await access(path); return path } catch {}
  }
  throw new Error('找不到 Chrome；请安装 Google Chrome 或用 MCLAW_CHROME_PATH 指到可执行文件')
}

// ---------------------------------------------------------------- 打开/收割

/** 用专属 profile 开 Chrome。登录用 headless: false（用户手动操作窗口），
 *  续期用 headless: true（后台跑完就关）。profilePath 缺省用老共享目录
 *  （只服务于 metadata 里没存 profile 的老账号续期）。返回 { browser, page,
 *  profilePath, release }：release() 在浏览器 close() 之后调用才放锁。 */
export async function openMclawBrowser({ headless = true, startUrl = 'about:blank', profilePath } = {}) {
  profilePath ||= defaultProfile()
  const release = await claimProfileLock(profilePath)
  try {
    await mkdir(profilePath, { recursive: true, mode: 0o700 })
    const args = [
      `--user-data-dir=${profilePath}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--disable-sync', '--disable-default-apps',
      '--disable-component-update', '--disable-client-side-phishing-detection',
      '--disable-domain-reliability',
      '--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider',
      '--metrics-recording-only', '--no-service-autorun',
      // Cookie 存储用 mock keychain，不碰 macOS 钥匙串 / Linux keyring。
      ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : process.platform === 'linux' ? ['--password-store=basic'] : []),
      '--window-size=1280,900',
      ...(headless ? ['--headless=new', '--disable-gpu'] : []),
      '--crash-dumps-dir=' + tmpdir(),
      startUrl,
    ]
    const started = await launch(await chromeExecutable(), args)
    return { ...started, profilePath, release }
  } catch (error) {
    release()
    throw error
  }
}

/** 读移动云登录 Cookie（含 httpOnly；CDP 直读浏览器 Cookie 库）。
 *  返回 { name, value, expiresMs }（expiresMs 为 0 表示会话 Cookie）。 */
export async function harvestYunAuth(browser) {
  const { cookies = [] } = await browser.connection.send('Storage.getCookies').catch(() => ({}))
  const hits = cookies.filter((c) => c?.name === 'authorization' && /(^|\.)yun\.139\.com$/i.test(String(c?.domain ?? '')))
  const pick = hits.find((c) => c?.value) ?? hits[0]
  if (!pick?.value) return undefined
  return {
    name: pick.name,
    value: pick.value,
    expiresMs: Number.isFinite(pick.expires) && pick.expires > 0 ? pick.expires * 1000 : 0,
  }
}

/** 浏览器登录全流程：有头 Chrome（新登录用全新 profile，绝不带旧票）→ 用户
 *  在窗口里完成移动云登录 → 收割 authorization Cookie。
 *  返回 { promise, abort }：promise resolve { cookie, profilePath, release,
 *  close }。abort() 随时可调（宿主取消）：Chrome 还没开起来时先记标记，开出来
 *  立即收尾；已开出则关浏览器、放锁。失败/取消/超时的路径还会删掉 profile 目录
 *  ——没人认领的登录态不该留在盘上（成功则归账号所有，绝不删）。 */
export function startBrowserHarvest({ deadlineMs = 600_000, profilePath = freshSigninProfile() } = {}) {
  const session = { promise: undefined, abort: async () => {} }
  session.promise = (async () => {
    let aborted = false
    let opened // { browser, release }：Chrome 开出后持有，成功时移交 callback
    let resolved = false
    session.abort = async () => {
      if (aborted) return
      aborted = true
      if (opened) {
        await opened.browser.close().catch(() => {})
        await opened.release()
      }
    }
    try {
      const { browser, page, profilePath: used, release } = await openMclawBrowser({
        headless: false, startUrl: 'https://yun.139.com/', profilePath,
      })
      opened = { browser, release }
      if (aborted) throw new Error('登录已取消')
      const deadline = Date.now() + deadlineMs
      for (;;) {
        if (aborted) throw new Error('登录已取消')
        if (browser.connection.closed) throw new Error('浏览器被关闭，登录中断')
        const cookie = await harvestYunAuth(browser).catch(() => undefined)
        if (cookie?.value) {
          resolved = true // 目录归账号所有（metadata.profile），abort 不许删
          return { cookie, profilePath: used, release, close: () => browser.close() }
        }
        if (Date.now() >= deadline) throw timeoutError(`登录超时（${Math.round(deadlineMs / 60000)} 分钟内没有检测到移动云登录）`)
        await sleep(1500)
      }
    } catch (error) {
      if (opened) {
        await opened.browser.close().catch(() => {})
        await opened.release()
      }
      if (!resolved) await rm(profilePath, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  })()
  return session
}

/** 续期：headless 复开账号自己的 profile（metadata.profile）首页，等网页应用
 *  刷新会话后收割 Cookie。页面加载后多等 settleMs，给 tokenRefresh 留时间。 */
export async function browserRefreshHarvest({ profilePath, settleMs = 12_000, timeoutMs = 60_000 } = {}) {
  const { browser, page, profilePath: used, release } = await openMclawBrowser({
    headless: true, startUrl: 'https://yun.139.com/', profilePath,
  })
  try {
    const deadline = Date.now() + timeoutMs
    let cookie = await harvestYunAuth(browser).catch(() => undefined)
    if (!cookie) {
      await page.goto('https://yun.139.com/', { timeout: 30000 }).catch(() => {})
    }
    // 等 settle 窗口（页面应用启动 + 可能的 tokenRefresh），Cookie 有变化就用新的。
    const first = cookie?.value
    const settleDeadline = Math.min(Date.now() + settleMs, deadline)
    while (Date.now() < settleDeadline) {
      await sleep(2000)
      const next = await harvestYunAuth(browser).catch(() => undefined)
      if (next?.value && next.value !== first) { cookie = next; break }
      cookie = next ?? cookie
      if (browser.connection.closed) break
    }
    if (!cookie?.value) throw new Error('profile 里没有移动云登录态（请先完成浏览器登录）')
    return { cookie, profilePath: used }
  } finally {
    await browser.close().catch(() => {})
    await release()
  }
}
