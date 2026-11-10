// Built-in native auto-check-in for the Doubao desktop client.
//
// Doubao's daily-credit campaign (pc_incentive_task_mvp_v3) is locked to the
// desktop client's own webview: the web page renders only "该活动仅支持在豆包
// 电脑版参与" and the raw check-in POST answers 710010702 to every caller that
// is not the client. So the only way to claim it is to drive the real client,
// exactly as a person would: open the activity page in its webview and click
// "立即领取". This module does that over Chrome DevTools Protocol.
//
// It is deliberately dependency-free: Node 22 ships a global WebSocket, and CDP
// over that socket needs only JSON frames. (The gcp-ai package does the same
// with a pipe transport; here we attach to the already-running client on its
// debugging port, which is how the proven doubao_checkin.py works.)
//
// The plugin never spawns the GUI client itself — that is the daily automation's
// job (or the user's, since they run Doubao anyway). This module only attaches
// to a client that is ALREADY running with remote debugging enabled on the
// port. If none is reachable it reports clientFound:false and the caller falls
// back to the install/run guidance, which keeps unit tests fast and never pops
// a window where there is no client.

import { spawn, execSync } from "node:child_process"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const DEFAULT_PORT = Number(process.env.DOUBAO_CDP_PORT ?? 9333)
const DEFAULT_BINARY = "/Applications/Doubao.app/Contents/MacOS/Doubao"
const DEFAULT_UDD = `${homedir()}/Library/Application Support/Doubao`
const DEFAULT_ACTIVITY = "https://www.doubao.com/pc/agent-explore"

// ---------------------------------------------------------------------------
// A minimal CDP session over a WebSocket.
// ---------------------------------------------------------------------------

export class CdpSession {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.events = new Map()
    this.closed = false
    this.queue = []
    this.opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP websocket open timed out")), 15000)
      this.ws.onopen = () => { clearTimeout(timer); this._flush(); resolve() }
      this.ws.onerror = (e) => {
        clearTimeout(timer)
        this.closed = true
        const err = new Error("CDP websocket error" + (e?.message ? `: ${e.message}` : ""))
        for (const p of this.pending.values()) p.reject(err)
        this.pending.clear()
        reject(err)
      }
      this.ws.onclose = () => { this.closed = true }
      this.ws.onmessage = (ev) => this._onMessage(String(ev.data))
    })
  }

  _flush() {
    const q = this.queue.splice(0)
    for (const m of q) this._sendRaw(m)
  }

  _sendRaw(payload) {
    try { this.ws.send(payload) } catch { /* socket gone */ }
  }

  _onMessage(data) {
    let msg
    try { msg = JSON.parse(data) } catch { return }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message ?? "CDP error"))
      else p.resolve(msg.result ?? {})
    } else {
      const cbs = this.events.get(msg.method) ?? []
      for (const cb of cbs) { try { cb(msg.params ?? {}) } catch {} }
    }
  }

  on(method, cb) {
    if (!this.events.has(method)) this.events.set(method, new Set())
    this.events.get(method).add(cb)
    return () => this.events.get(method)?.delete(cb)
  }

  send(method, params = {}) {
    const id = ++this.id
    const payload = JSON.stringify({ id, method, params })
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      if (this.closed) { this.pending.delete(id); reject(new Error("CDP session closed")) }
      else if (this.ws.readyState === 1) this._sendRaw(payload)
      else this.queue.push(payload)
    })
  }

  async evaluate(fn, arg = undefined, { awaitPromise = true, timeout = 20000 } = {}) {
    // JSON.stringify(arg) already carries the comma-free literal; a leading ","
    // here used to produce `fn(,"x")` — a SyntaxError that callers' .catch()
    // silently turned into "no result". Keep the arg literal bare.
    const argStr = arg === undefined ? "" : JSON.stringify(arg)
    const expression = typeof fn === "string" ? fn : `(${fn.toString()})(${argStr})`
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise, timeout,
    })
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description?.split("\n")[0] ?? exceptionDetails.text ?? "page threw")
    }
    return result?.value
  }

  // CDP reads the full cookie jar — including HttpOnly session cookies that
  // document.cookie (the JS sandbox) is forbidden from seeing. This is what
  // makes the "harvest credentials from the local client" account-add path
  // work without a manual paste.
  async getCookies(urls = []) {
    const { cookies } = await this.send("Network.getCookies", urls.length ? { urls } : {})
    return Array.isArray(cookies) ? cookies : []
  }

  async waitForFunction(fn, arg = undefined, { timeout = 30000, interval = 200 } = {}) {
    const deadline = Date.now() + timeout
    for (;;) {
      try {
        const v = await this.evaluate(fn, arg, { awaitPromise: true, timeout })
        if (v) return v
      } catch (e) {
        if (!/Execution context|context was destroyed|Inspected target navigated|Target closed|frame was detached|Cannot find context|No execution context/i.test(e.message)) throw e
      }
      if (Date.now() >= deadline) throw new Error(`timed out after ${timeout}ms waiting for page condition`)
      await sleep(interval)
    }
  }

  navigate(url) { return this.send("Page.navigate", { url }) }

  async close() {
    this.closed = true
    try { this.ws.close() } catch {}
  }
}

// ---------------------------------------------------------------------------
// Reaching the client's debugging endpoint.
// ---------------------------------------------------------------------------

// `Connection: close` is not cosmetic. Bun's fetch keeps the socket alive, and
// the DevTools HTTP endpoint answers 404 to any request that arrives on a
// reused connection (verified 2026-11-02: first call 200, every later call 404
// with a `null` body). That single fact used to surface as "client not
// reachable" / "no debuggable page target" on a perfectly healthy client.
const CDP_FETCH = { headers: { connection: "close" } }

export async function isCdpUp(port, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      ...CDP_FETCH,
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json`, {
    ...CDP_FETCH,
    signal: AbortSignal.timeout(3000),
  })
  return await res.json()
}

export function isDoubaoRunning() {
  try {
    const out = execSync("pgrep -f 'Doubao.app/Contents/MacOS/Doubao'", { stdio: ["ignore", "pipe", "ignore"] })
    return out.toString().trim().length > 0
  } catch {
    return false
  }
}

// Only used when the caller opts in; the plugin never calls this so unit
// tests stay window-free. Kept here so a host that wants to start the client
// (e.g. the daily automation) can reuse the same flags. With `detached:true`
// the spawned client outlives the spawning process (used by the ensure-doubao
// helper, which exits after confirming the port is up).
export async function launchClient({ binary = DEFAULT_BINARY, udd = DEFAULT_UDD, port = DEFAULT_PORT, timeoutMs = 45000, detached = false } = {}) {
  const args = [binary, `--remote-debugging-port=${port}`, `--user-data-dir=${udd}`,
    "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-proxy-server"]
  let child
  try {
    child = spawn(args[0], args.slice(1), { stdio: "ignore", detached })
    if (detached) child.unref()
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isCdpUp(port, 1000)) return { ok: true, child }
    if (!detached && child.exitCode !== null) return { ok: false, error: `client exited (${child.exitCode})` }
    await sleep(500)
  }
  return { ok: false, error: "client started but debugging port never opened" }
}

// ---------------------------------------------------------------------------
// Bringing the client in when it is not installed yet.
//
// We deliberately do NOT hardcode a third-party CDN URL (those drift and are a
// supply-chain risk). Instead we open Doubao's official download page (which
// auto-detects the architecture and serves the correct installer) and, once
// the user has fetched the .dmg, mount it and copy the app into /Applications.
// The user still performs the actual "click download" in their browser — that
// step cannot be automated without a verified binary URL — but everything
// after that (mount, copy, relaunch with the debug port) is hands-off.
// ---------------------------------------------------------------------------

const DOWNLOAD_PAGE = "https://www.doubao.com/download/desktop"
const DOWNLOAD_DIR = join(homedir(), "Downloads")

/** Open the official macOS download page in the user's default browser. */
export function openDownloadPage() {
  if (process.platform !== "darwin") return { ok: false, error: "non-mac" }
  try {
    execSync(`open "${DOWNLOAD_PAGE}"`, { stdio: "ignore" })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/** Most recently modified Doubao*.dmg in ~/Downloads, or null. */
export function findDownloadedDmg() {
  try {
    return readdirSync(DOWNLOAD_DIR)
      .filter((f) => /^Doubao.*\.dmg$/i.test(f))
      .map((f) => ({ f, t: statSync(join(DOWNLOAD_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .map((x) => join(DOWNLOAD_DIR, x.f))[0] ?? null
  } catch {
    return null
  }
}

async function installDmg(dmgPath) {
  // Mount without opening a Finder window; parse the mount point from output.
  const out = execSync(`hdiutil attach -nobrowse -noautoopen "${dmgPath}"`, { encoding: "utf8" })
  const vol = /\/Volumes\/[^ ]+/.exec(out)?.[0]
  if (!vol) return { ok: false, error: "无法挂载 dmg（未找到挂载点）" }
  try {
    execSync(`cp -R "${vol}/Doubao.app" /Applications/Doubao.app`, { stdio: "ignore" })
    return { ok: true, volume: vol }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  } finally {
    execSync(`hdiutil detach "${vol}" -force`, { stdio: "ignore" })
  }
}

/**
 * Orchestrate a first-time install: if the client is already present (running
 * or debuggable) this is a no-op success; otherwise open the download page and,
 * when a Doubao*.dmg has landed in ~/Downloads, install it and relaunch with the
 * debug port so the claim engine can attach.
 *
 * Returns `{ ok, stage, ... }`. `needDownload:true` means "open the page, click
 * download, then retry" — the only step the plugin cannot do for the user.
 */
export async function attemptClientInstall({ port = DEFAULT_PORT, openPage = true } = {}) {
  if (process.platform !== "darwin") {
    return { ok: false, error: "仅 macOS 支持自动安装；其他平台请手动从 https://www.doubao.com/download/desktop 安装。" }
  }
  if (isDoubaoRunning() || (await isCdpUp(port, 1000))) {
    const d = await diagnoseClient({ port })
    if (d.stage === "ready") return { ok: true, stage: "ready", alreadyInstalled: true }
  }
  if (openPage) openDownloadPage()
  const dmg = findDownloadedDmg()
  if (!dmg) {
    return {
      ok: false,
      needDownload: true,
      error: "未检测到 ~/Downloads 下的 Doubao*.dmg。请在已打开的官方下载页点击「下载 macOS 版」，下载完成后再点此重试。",
    }
  }
  const installed = await installDmg(dmg).catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
  if (!installed.ok) return { ok: false, error: installed.error, dmg }
  const launched = await launchClient({ port, detached: true, timeoutMs: 45000 })
  if (!launched.ok) {
    return { ok: false, error: `已安装到 /Applications/Doubao.app，但启动调试端口失败：${launched.error}`, dmg }
  }
  return { ok: true, stage: "ready", dmg, installed: true }
}

// Open a fresh web tab inside the client's browser context via CDP
// Target.createTarget, then return its debugging WebSocket URL. Used only
// when no suitable web page is already open.
async function createTargetSession({ port, activity }) {
  const targets = await listTargets(port)
  const any = (Array.isArray(targets) ? targets : []).find((t) => t.webSocketDebuggerUrl) ?? null
  if (!any) throw new Error("no target to issue Target.createTarget")
  const bootstrap = new CdpSession(any.webSocketDebuggerUrl)
  await bootstrap.opened
  try {
    const { targetId } = await bootstrap.send("Target.createTarget", { url: activity })
    // The new page appears in /json with its own debugging URL.
    for (let i = 0; i < 20; i++) {
      const list = await listTargets(port)
      const created = (Array.isArray(list) ? list : []).find((t) => t.type === "page" && t.id === targetId && t.webSocketDebuggerUrl)
      if (created) return created.webSocketDebuggerUrl
      await sleep(250)
    }
    throw new Error("created target never appeared in /json")
  } finally {
    await bootstrap.close().catch(() => {})
  }
}

export async function connectSession({ port, activity, checkinTimeoutMs }) {
  const targets = await listTargets(port)
  // Prefer a real web page (https, the one holding the signed-in session) over
  // the app-shell targets (doubao:// schemes). The activity page, when open,
  // is exactly such a target.
  const pages = Array.isArray(targets) ? targets.filter((t) => t.type === "page") : []
  let target = pages.find((t) => /agent-explore/.test(t.url ?? ""))
    ?? pages.find((t) => /^https?:/i.test(t.url ?? "") && /doubao/i.test(t.url ?? ""))
    ?? pages.find((t) => /^https?:/i.test(t.url ?? ""))
    ?? null
  // No suitable web page (e.g. only the app shell is open): create one in the
  // client's browser context, the same thing Playwright's new_page does.
  if (!target) {
    const wsUrl = await createTargetSession({ port, activity }).catch(() => null)
    if (wsUrl) target = { webSocketDebuggerUrl: wsUrl }
  }
  if (!target || !target.webSocketDebuggerUrl) {
    throw new Error("no debuggable page target in the Doubao client")
  }
  const session = new CdpSession(target.webSocketDebuggerUrl)
  await session.opened
  // Domains that may be unavailable on the embedded client: enabling them is
  // best-effort and must not abort the session.
  await session.send("Page.enable").catch(() => {})
  await session.send("Runtime.enable").catch(() => {})
  await session.send("Network.enable").catch(() => {})
  const cur = await session.evaluate("location.href").catch(() => "")
  if (!cur || !cur.includes("agent-explore")) await session.navigate(activity)
  return session
}

// ---------------------------------------------------------------------------
// The check-in itself.
// ---------------------------------------------------------------------------

/**
 * Drive the already-running Doubao desktop client to click "立即领取".
 *
 * Returns whether the desktop client was reachable and whether a check-in
 * request actually fired. It does NOT try to confirm success by reading the
 * campaign inside the page: the embedded webview's JS cannot see its own
 * HttpOnly session cookies (verified 2026-11-02 — document.cookie in the
 * agent-explore page carries no sessionid/sid_tt), so any in-page fetch reads
 * as anonymous and always reports checked_in_today:false. Confirmation must be
 * done server-side by the caller (checkinDoubao) with the real auth cookie.
 *
 * @returns {Promise<{clientFound:boolean, fired:boolean, alreadyClaimed?:boolean, error:string|null}>}
 */
export async function nativeCheckin(opts = {}) {
  // The daily sign-in is just the narrowest case of the reward-claim engine in
  // ./rewards.mjs, so it delegates rather than duplicating the click logic.
  // Loaded lazily: rewards.mjs imports this module's primitives, and a dynamic
  // import keeps that one-directional at module-evaluation time.
  const { claimRewards, DAILY_SIGNIN_LABELS } = await import("./rewards.mjs")
  const r = await claimRewards({
    port: opts.port,
    activity: opts.activity,
    autoLaunch: opts.autoLaunch,
    timeoutMs: opts.checkinTimeoutMs ?? 30000,
    maxClicks: 1,
    labels: DAILY_SIGNIN_LABELS,
    // The page's sign-in card carries exactly this campaign code, which is the
    // same string the detail API returns for task_kind "daily_signin".
    codes: ["daily_signin"],
  })
  return {
    clientFound: r.clientFound,
    launched: r.launched,
    // "fired" keeps its old meaning: a real /landing/checkin write reached the
    // network. claimRewards also reports milestone claims, hence the filter.
    fired: r.requests.some((u) => /landing\/checkin/.test(u)),
    alreadyClaimed: r.alreadyClaimed,
    clicked: r.clicked,
    skipped: r.skipped,
    requests: r.requests,
    error: r.error,
  }
}

// Whether a debuggable client is reachable right now (used for guidance).
export async function isClientDebuggable(opts = {}) {
  return isCdpUp(Number(opts.port ?? DEFAULT_PORT), 1500)
}

// ---------------------------------------------------------------------------
// Harvest the signed-in session cookie straight from the running client.
// ---------------------------------------------------------------------------

/**
 * Read the live session cookie from the already-running, debug-enabled Doubao
 * desktop client over CDP. This is the seamless account-add path: no manual
 * cookie paste, no browser round-trip. CDP's Network.getCookies sees the full
 * jar (HttpOnly session cookies included) whereas the in-page document.cookie
 * cannot.
 *
 * @returns {Promise<{ok:boolean, cookie?:string, uid?:string, count?:number, error?:string}>}
 */
export async function harvestClientCookies(opts = {}) {
  const port = Number(opts.port ?? DEFAULT_PORT)
  if (!(await isCdpUp(port, 2000))) {
    return { ok: false, error: "豆包客户端未运行或未开启远程调试（端口 9333 不可达）" }
  }
  let session = null
  try {
    session = await connectSession({ port, activity: DEFAULT_ACTIVITY })
    const cookies = await session.getCookies(["https://www.doubao.com", "https://doubao.com"]).catch(() => [])
    if (!cookies.length) return { ok: false, error: "客户端中无可读取的会话 Cookie（请先在客户端登录）" }
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ")
    const uid = cookies.find((c) => c.name === "uid_tt")?.value
      || cookies.find((c) => /sessionid/.test(c.name))?.value
      || ""
    return { ok: true, cookie, uid: String(uid), count: cookies.length }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  } finally {
    try { await session?.close() } catch {}
  }
}

