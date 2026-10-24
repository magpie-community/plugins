// 私有化 TRAE CLI 的 Magpie 供应商插件。
// 登录在 Magpie 供应商页完成：填企业地址，点登录，插件拉起 traecli 的浏览器 SSO。
// 令牌落在本机 TRAE_HOME/cli/auth.json（默认用户主目录下的 .trae）；插件不自己换 refresh token。
// 对话走 POST {api_base_url}/api/ide/v2/llm_raw_chat，请求头 X-App-Id 是
// 由 TRAE_PRIVATE_APP_ID 显式提供，必须与目标部署的 CLI 配置一致。
// 公开版插件的 /api/agent/v3/llm_utils_chat 这条私有化 CLI 不会发。
import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path"

const ID = "trae-private"
// 企业地址只来自本机 traecli 写入的 endpoints.api_base_url，这里不放任何部署主机。
// The application ID is deployment-specific and must be configured explicitly.
const SESSION = "x-trae-private-session"
function protocolConfig() {
  const pick = (key, fallback) => {
    const value = process.env[key] ?? fallback
    if (key === "TRAE_PRIVATE_APP_ID" && !value) throw new Error("TRAE_PRIVATE_APP_ID is required; set the application ID confirmed for your deployment")
    if (!value || value.length > 512 || /[^\x20-\x7e]/.test(value)) throw new Error(`${key} 必须是非空可打印 ASCII 字符串`)
    return value
  }
  const safeKeys = { appId: ["TRAE_PRIVATE_APP_ID", undefined], userAgent: ["TRAE_PRIVATE_USER_AGENT", UA], version: ["TRAE_PRIVATE_PROTOCOL_VERSION", "0.201.1-tob-alpha.1"], ideVersionCode: ["TRAE_PRIVATE_IDE_VERSION_CODE", "20260206"], ideVersion: ["TRAE_PRIVATE_IDE_VERSION", "99.99.99"], originator: ["TRAE_PRIVATE_ORIGINATOR", "codex_exec"] }
  return Object.fromEntries(Object.entries(safeKeys).map(([key, [env, fallback]]) => [key, pick(env, fallback)]))
}
const UA = "codex_exec/0.201.1-tob-alpha.1 (Mac OS 14.1.2; arm64) dumb (codex_exec; 0.201.1-tob-alpha.1)"

// CLI 的 expires_at 决定有效期；临近到期时让 CLI 自己续期。
// exec 可能联网和计费，可用 TRAE_PRIVATE_NO_AUTO_REFRESH=1 禁用。
const REFRESH_MARGIN = 2 * 3600 * 1000
const renewing = new Map()

function cliNames() {
  return process.platform === "win32"
    ? ["traecli.exe", "traecli.cmd", "traecli.bat", "traecli"]
    : ["traecli"]
}

function cliSearchDirs() {
  const dirs = []
  const seen = new Set()
  const add = (dir) => {
    const n = String(dir || "").replace(/[/\\]+$/, "")
    if (!n) return
    const key = process.platform === "win32" ? n.toLowerCase() : n
    if (seen.has(key)) return
    seen.add(key)
    dirs.push(n)
  }
  add(join(homedir(), ".local", "bin"))
  for (const dir of String(process.env.PATH || process.env.Path || "").split(delimiter)) add(dir)
  return dirs
}

function cliPath() {
  if (process.env.TRAE_PRIVATE_CLI) return process.env.TRAE_PRIVATE_CLI
  const names = cliNames()
  for (const dir of cliSearchDirs()) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return join(homedir(), ".local", "bin", names[0])
}

function magpieConfigDir() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "magpie")
}

function absoluteDirError(dir, emptyOk) {
  const s = String(dir ?? "").trim()
  if (!s) return emptyOk ? undefined : "填一个绝对路径，或改用上面的默认入口"
  return isAbsolute(s) ? undefined : "填本机绝对路径"
}

// renewViaCli 让 traecli 跑一次最小请求，触发它自己的令牌续期。
// 超时/失败都只是返回 false：调用方继续用现有令牌，不因此判定登出。
function renewViaCli(home, signal) {
  if (process.env.TRAE_PRIVATE_NO_AUTO_REFRESH === "1") return Promise.resolve(false)
  const key = traeHome(home)
  if (renewing.has(key)) return renewing.get(key)
  const job = (async () => {
    const cwd = mkdtempSync(join(tmpdir(), "trae-private-refresh-"))
    try {
      // exec can contact a billable service. Only the CLI owns refresh credentials.
      return await new Promise((resolve) => {
        let child, settled = false, timer
        const finish = (ok) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal?.removeEventListener("abort", abort)
          if (!ok) try { child?.kill?.("SIGKILL") } catch {}
          resolve(ok)
        }
        const abort = () => finish(false)
        if (signal?.aborted) return finish(false)
        signal?.addEventListener("abort", abort, { once: true })
        timer = setTimeout(abort, _internal.refreshTimeout ?? 60000)
        try {
          const exe = cliPath()
          checkCliExecutable(exe)
          child = (_internal.execFile || execFile)(
            exe, ["exec", "--skip-git-repo-check", "--json", "reply with: ok"],
            { env: { ...process.env, TRAE_HOME: key }, cwd, timeout: 60000, killSignal: "SIGKILL", windowsHide: true, signal },
            (err) => finish(!err),
          )
        } catch (e) { finish(false) }
      })
    } finally { rmSync(cwd, { recursive: true, force: true }) }
  })().finally(() => { renewing.delete(key) })
  renewing.set(key, job)
  return job
}

// traecli 的目录. 一个账号一个目录: 登录时填, magpie 按账号分别记住,
// 之后每次请求都从该账号自己的目录读登录与模型目录.
function traeHome(explicit) {
  const dir = String(explicit || "").trim()
  const path = resolve(dir || process.env.TRAE_HOME || join(homedir(), ".trae"))
  try { return realpathSync(path) } catch { return path }
}

function authPath(explicit) {
  return join(traeHome(explicit), "cli", "auth.json")
}

function cachePath(explicit) {
  return join(traeHome(explicit), "cli", "models_cache.json")
}

// traecli 会原地重写 auth.json / models_cache.json，读到半写文件是可能的。
// 文件不存在 = 没登录；文件在但解析失败 = 不确定，绝不能当成登出。
class Unreadable extends Error {}

function readJson(path) {
  let raw
  try {
    raw = readFileSync(path, "utf8")
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null
    throw new Unreadable(`${path} could not be read: ${e?.code || e?.message || e}`)
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw Object.assign(new Unreadable(`${path} is not valid JSON (a CLI write may be in progress)`), { temporary: true, signIn: "kept" })
  }
}

// 只对解析半写做两次异步重试；权限与 schema 错误立即返回。

async function retryRead(read) {
  for (let attempt = 0; ; attempt++) {
    try { return read() } catch (e) {
      if (!e.temporary || attempt >= 2) throw Object.assign(e, { signIn: "kept" })
      await wait(40)
    }
  }
}
const lastCatalog = new Map()

// 企业地址只接受 HTTPS，不要账号、查询或片段；允许部署路径前缀。
function parseBaseURL(value) {
  const raw = String(value ?? "").trim()
  if (!raw) return { error: "填写企业 HTTPS 地址" }
  if (/[\\\\\u0000-\u0020]/.test(raw) || /%(?:2f|5c|2e|00)/i.test(raw)) return { error: "地址不要包含反斜杠、空白或编码路径分隔符" }
  let url
  try { url = new URL(raw) } catch { return { error: "不是合法 URL" } }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    return { error: "必须是 HTTPS，不要带账号、查询或片段" }
  }
  if (!url.hostname) return { error: "缺少主机名" }
  const path = url.pathname.replace(/\/+$/, "")
  return { base: `${url.origin}${path === "/" ? "" : path}` }
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
const LOGIN_WAIT = 5 * 60 * 1000
const LINK_WAIT = 30 * 1000
const opensPage = () => process.platform === "darwin" || process.platform === "win32"

function checkCliExecutable(exe, platform = process.platform) {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(String(exe || ""))) {
    throw new Error("请将 TRAE_PRIVATE_CLI 指向 traecli.exe；不通过 shell 执行 cmd/bat")
  }
}
function defaultSpawnLogin(exe, args, options) {
  checkCliExecutable(exe)
  return spawn(exe, args, { windowsHide: true, ...options, shell: false })
}

function spawnLogin(exe, args, options) {
  return (_internal.spawnLogin || defaultSpawnLogin)(exe, args, options)
}

function sameBase(a, b) {
  return parseBaseURL(a).base && parseBaseURL(a).base === parseBaseURL(b).base
}

// home 是这个账号的 traecli 目录；不给就用 TRAE_HOME 或 ~/.trae。
function readLocal(home) {
  const file = readJson(authPath(home))
  const trae = file?.trae
  const token = typeof trae?.access_token === "string" ? trae.access_token : ""
  if (!token) return null
  const expiresAt = Date.parse(trae.expires_at || "")
  return {
    token,
    expires: Number.isFinite(expiresAt) ? expiresAt : 0,
    base: checkedBase(trae.endpoints?.api_base_url),
    // 账号名优先用邮箱，magpie 拿它区分多个账号。
    name: String(trae.user_email || trae.user_name || trae.user_id || "traecli"),
    email: String(trae.user_email || ""),
    uid: String(trae.user_id || ""),
  }
}

function checkedBase(value) {
  const result = parseBaseURL(value)
  if (result.error) throw new Error(`企业部署地址无效：${result.error}`)
  return result.base
}

function bindingOf(local, home) {
  if (!local.uid) throw Object.assign(new Error("CLI 缺少稳定 uid，请重新登录连接"), { signIn: "expired" })
  return { traeHome: traeHome(home), uid: local.uid, baseURL: checkedBase(local.base) }
}

async function connectedLocal(auth, { expiredOK = false } = {}) {
  const fail = (message, signIn = "expired") => { throw Object.assign(new Error(message), { signIn }) }
  if (!auth?.traeHome || !isAbsolute(auth.traeHome) || !auth.uid || !auth.baseURL) fail("旧账号缺少明确身份绑定，请重新连接")
  const home = traeHome(auth.traeHome)
  if (home !== auth.traeHome) fail("账号目录目标已改变，请重新连接")
  const local = await retryRead(() => readLocal(home))
  if (!local) fail("本机已注销，请重新登录连接")
  if (local.uid !== auth.uid) fail("本机账号已改变，请为此账号重新连接")
  if (!sameBase(local.base, auth.baseURL)) fail("本机部署已改变，请重新连接")
  // 旧记录只有完整绑定且 access 仍匹配才可迁移，不能采信目录中的任意新身份。
  if (auth.bindingVersion !== 1 && auth.access !== local.token) fail("旧账号无法确认原身份，请重新连接")
  if (!expiredOK && local.expires && local.expires <= Date.now()) fail("本机 traecli 登录已过期，请重新登录", "kept")
  return local
}

function positiveEnv(key, fallback) {
  const value = process.env[key]
  if (value === undefined || value === "") return fallback
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${key} 必须是正整数`)
  return n
}
const outputLimit = () => positiveEnv("TRAE_PRIVATE_OUTPUT", 32000)
const contextLimit = () => positiveEnv("TRAE_PRIVATE_CONTEXT", 1000000)
function contextOf(m) {
  const max = Number(m.business_metadata?.variants?.max_context_window)
  const dev = Number(m.context_window)
  return Math.max(Number.isFinite(max) && max > 0 ? max : 0, Number.isFinite(dev) && dev > 0 ? dev : 0) || contextLimit()
}
const MAX_WINDOW_KEY = "max-context-window"
function maxWindowOn(input) {
  try { return input?.magpie?.option?.(ID, MAX_WINDOW_KEY) === true } catch { return false }
}
function reported(items, input) {
  return items.map((m) => ({ ...m, context: maxWindowOn(input) ? Math.max(m.context, contextLimit()) : m.declared }))
}


// magpie 的用量卡片要的是 { windows: [{name, used(百分比), span}], balance? }。
// 这些数字只有网页会话能读：用量接口要 HttpOnly cookie X-Cloudide-Tob-Session，
// CLI 的 Cloud-IDE-JWT 换不到（上游 code=30011 请先登录）。
// 登录时用带调试端口的本机 Chrome/Edge 打开授权页，SSO 完成后把 cookie 写进
// Magpie 账号（以及 sidecar 文件作回落）。traecli 自己只收下 JWT。
function webCookiePath(account) {
  // 分层无歧义编码，既不碰撞也不把整段 home 塞进一个超长文件名。
  if (!account || typeof account !== "object" || !account.uid || !account.traeHome || !account.baseURL) {
    return join(magpieConfigDir(), "trae-private-web-cookie") // 仅供诊断旧文件，不自动读取
  }
  const origin = new URL(checkedBase(account.baseURL)).origin
  const encode = (s) => Buffer.from(s).toString("base64url")
  const homeParts = traeHome(account.traeHome).split(/[/\\]+/).filter(Boolean).map(encode)
  return join(magpieConfigDir(), "trae-private-sessions", encode(origin), encode(account.uid), ...homeParts, "session.json")
}

const COOKIE_NAME = "X-Cloudide-Tob-Session"

function parseCookieValue(raw) {
  let s = String(raw ?? "").trim()
  if (!s) return ""
  if (s.startsWith(`${COOKIE_NAME}=`)) s = s.slice(COOKIE_NAME.length + 1).trim()
  const semi = s.indexOf(";")
  if (semi >= 0) s = s.slice(0, semi).trim()
  return s
}

function webCookie(account) {
  if (!account?.uid || !account?.traeHome || !account?.baseURL) return ""
  try {
    const record = readJson(webCookiePath(account))
    return cookieForHost(record ? [record] : [], sameOriginPath(account.baseURL, "/trae/gtm/tob/api/v1/config/get_personal_quota"))
  } catch { return "" }
}
function usageCookie(auth) { return webCookie(auth) }
function saveWebSession(account, cookie) {
  if (!cookie?.value) return ""
  const dest = webCookiePath(account)
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 })
  const temp = `${dest}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(cookie), { mode: 0o600, flag: "wx" })
    renameSync(temp, dest)
  } finally { rmSync(temp, { force: true }) }
  return cookie.value
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      const port = addr && typeof addr === "object" ? addr.port : 0
      server.close((err) => (err ? reject(err) : resolve(port)))
    })
    server.on("error", reject)
  })
}

function browserBins() {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || ""
    const pf = process.env.PROGRAMFILES || ""
    const pf86 = process.env["PROGRAMFILES(X86)"] || ""
    return [
      join(local, "Google/Chrome/Application/chrome.exe"),
      join(pf, "Google/Chrome/Application/chrome.exe"),
      join(pf86, "Google/Chrome/Application/chrome.exe"),
      join(local, "Microsoft/Edge/Application/msedge.exe"),
      join(pf, "Microsoft/Edge/Application/msedge.exe"),
      join(pf86, "Microsoft/Edge/Application/msedge.exe"),
    ]
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]
  }
  return ["google-chrome", "google-chrome-stable", "microsoft-edge", "chromium", "chromium-browser"]
}

function browserPath() {
  if (process.env.TRAE_PRIVATE_BROWSER) return process.env.TRAE_PRIVATE_BROWSER
  for (const bin of browserBins()) {
    if (bin.includes("/") || bin.includes("\\")) {
      if (existsSync(bin)) return bin
    }
  }
  if (process.platform === "win32" || process.platform === "darwin") return ""
  for (const name of browserBins()) {
    for (const dir of String(process.env.PATH || "").split(delimiter)) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return ""
}

async function openDebugPage(port, url) {
  const target = new URL(url)
  if (target.protocol !== "https:" || target.username || target.password) throw new Error("无效授权 URL")
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT", signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error("CDP 创建页失败 HTTP " + res.status)
  const page = await res.json()
  if (!page?.id || page.type !== "page") throw new Error("CDP 页面响应无效")
  return page
}
async function cdpCookies(port) {
  const response = await fetch("http://127.0.0.1:" + port + "/json/list", { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error("CDP 列表失败")
  const pages = await response.json()
  const page = Array.isArray(pages) && pages.find((p) => p?.type === "page" && p.webSocketDebuggerUrl)
  if (!page || typeof WebSocket === "undefined") throw new Error("CDP 无页面")
  const url = new URL(page.webSocketDebuggerUrl)
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || url.port !== String(port)) throw new Error("CDP WebSocket 地址不匹配")
  const ws = new WebSocket(url.href)
  try {
    await bounded(new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true })
      ws.addEventListener("error", () => reject(new Error("CDP 连接失败")), { once: true })
      ws.addEventListener("close", () => reject(new Error("CDP 提前关闭")), { once: true })
    }), _internal.cdpTimeout ?? 5000, "CDP 连接超时")
    return await bounded(new Promise((resolve, reject) => {
      ws.addEventListener("close", () => reject(new Error("CDP 提前关闭")), { once: true })
      ws.addEventListener("error", () => reject(new Error("CDP 读取失败")), { once: true })
      ws.addEventListener("message", (ev) => {
        try {
          const msg = JSON.parse(String(ev.data))
          if (msg.id === 1) {
            if (msg.error || !Array.isArray(msg.result?.cookies)) reject(new Error("CDP cookie 响应无效"))
            else resolve(msg.result.cookies)
          }
        } catch (e) { reject(e) }
      })
      ws.send(JSON.stringify({ id: 1, method: "Network.getAllCookies" }))
    }), _internal.cdpTimeout ?? 5000, "CDP cookie 超时")
  } finally { try { ws.close() } catch {} }
}

function selectedCookie(cookies, target) {
  let url
  try { url = new URL(target.includes("://") ? target : `https://${target}/`) } catch { return null }
  const matches = (cookies || []).filter((c) => {
    if (c?.name !== COOKIE_NAME || !parseCookieValue(c.value) || /[\r\n]/.test(c.value)) return false
    const domain = String(c.domain || "").toLowerCase()
    const bare = domain.replace(/^\./, "")
    const hostOnly = c.hostOnly ?? !domain.startsWith(".")
    if (!(url.hostname === bare || (!hostOnly && url.hostname.endsWith(`.${bare}`)))) return false
    if (c.secure && url.protocol !== "https:") return false
    if (Number(c.expires) > 0 && Number(c.expires) * 1000 <= Date.now()) return false
    const path = c.path || "/"
    return url.pathname === path || (url.pathname.startsWith(path) && (path.endsWith("/") || url.pathname[path.length] === "/"))
  })
  matches.sort((a, b) => (b.path || "/").length - (a.path || "/").length || Number(!String(b.domain).startsWith(".")) - Number(!String(a.domain).startsWith(".")))
  return matches[0] || null
}
function cookieForHost(cookies, target) { return parseCookieValue(selectedCookie(cookies, target)?.value) }

async function defaultLaunchDebugBrowser() {
  if (process.env.TRAE_PRIVATE_NO_LOGIN_BROWSER === "1") return null
  const bin = browserPath()
  if (!bin) return null
  const port = await freePort()
  const dir = mkdtempSync(join(tmpdir(), "trae-private-browser-"))
  let child
  try { child = spawn(bin, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-features=Translate",
    "about:blank",
  ], { env: { ...process.env, HOME: dir, USERPROFILE: dir },
    stdio: "ignore", windowsHide: false }) } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    throw e
  }
  let failed = false
  let stopped = false
  const exited = new Promise((resolve) => {
    child.once("close", resolve)
    child.once("error", resolve)
  })
  const stop = async () => {
    if (stopped) return
    stopped = true
    try { child.kill?.() } catch {}
    try { await bounded(exited, 1000, "浏览器退出超时") } catch {
      try { child.kill?.("SIGKILL") } catch {}
      await bounded(exited, 1000, "浏览器终止超时").catch(() => {})
    }
    rmSync(dir, { recursive: true, force: true })
  }
  child.on?.("error", () => { failed = true })
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) {
        return {
          port,
          async open(url) {
            await openDebugPage(port, url)
          },
          async cookies() {
            return cdpCookies(port)
          },
          stop,
        }
      }
    } catch {}
    if (failed || child.exitCode != null) break
    await wait(100)
  }
  await stop()
  return null
}

function launchDebugBrowser() {
  return (_internal.launchDebugBrowser || defaultLaunchDebugBrowser)()
}

function writeOpenShim(port) {
  const dir = mkdtempSync(join(tmpdir(), "trae-private-open-"))
  const script = `#!/bin/sh
url=""
for a in "$@"; do
  case "$a" in
    http://*|https://*) url="$a" ;;
  esac
done
if [ -n "$url" ]; then
  python3 -c 'import json,urllib.request,urllib.parse,sys; u=urllib.parse.urlsplit(sys.argv[1]); assert u.scheme=="https" and not u.username and not u.password and not u.fragment; r=urllib.request.Request("http://127.0.0.1:${port}/json/new?"+urllib.parse.quote(sys.argv[1],safe=""),method="PUT"); page=json.load(urllib.request.urlopen(r,timeout=5)); assert page.get("id") and page.get("type")=="page"' "$url" >/dev/null 2>&1
fi
`
  writeFileSync(join(dir, "open"), script, { mode: 0o755 })
  writeFileSync(join(dir, "xdg-open"), script, { mode: 0o755 })
  return dir
}

// cookie 绝不能离开它所属的部署：路径必须是落在同一 origin 上的单 "/" 路径，
// 且不跟随跳转（跟随就可能把 cookie 送到别的 host）。
function sameOriginPath(base, path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    throw new Error(`TRAE usage path must be a single "/"-prefixed path: ${path}`)
  }
  const root = new URL(checkedBase(base))
  if (/[\\\\?#]/.test(path) || /%(?:2f|5c|2e|00)/i.test(path) || path.split("/").includes("..")) throw new Error("TRAE path contains unsupported characters")
  const url = new URL(`${root.href.replace(/\/+$/, "")}${path}`)
  if (url.origin !== root.origin) throw new Error(`TRAE usage path leaves the deployment origin: ${path}`)
  return url.href
}

// url 是 sameOriginPath 校验过的完整地址，这里不再拼 base。
async function traeGet(url, cookie) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json", Accept: "application/json", Cookie: `X-Cloudide-Tob-Session=${cookie}` },
    body: "{}",
  })
  if (!res.ok) throw new Error(`TRAE ${url} -> HTTP ${res.status}`)
  const data = await res.json()
  if (data?.code !== 0) throw new Error(`TRAE ${url} -> ${data?.code} ${data?.message || ""}`.trim())
  return data
}

// 用量以两档金额为准；百分比保留真实超额，不截成 100%。
function sumCost(list) {
  let total = 0
  for (const x of list || []) total += Number(x?.total_cost_currency) || 0
  return total
}

function monthResetAt() {
  // 月度配额的兼容重置时间按下个自然月 1 日零点计算。
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0).toISOString()
}

function yuan(n) {
  return Number(n || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// magpie 允许 used 超过 100 表示超支，报真实比例而不是封顶。
function pct(used, limit) {
  if (!(limit > 0)) return 0
  return Math.max(0, (used / limit) * 100)
}

// 管理员修改额度后每次重新计算；0 额度不显示窗口。
function quotaOf(quota, usage) {
  const q = quota?.user_model_quota || {}
  const lists = Array.isArray(usage?.user_usage_list) ? usage.user_usage_list : []
  const seatLimit = Number(q.seat_pool_currency_quota) || 0
  const paygoLimit = Number(q.paygo_currency_quota) || 0

  const seatModels = lists[0]?.in_seat_detail?.chat_usage_details || []
  const overModels = lists[1]?.model_usage_detail_list || lists[1]?.in_seat_detail?.chat_usage_details || []
  const seatUsed = sumCost(seatModels)
  const overUsed = sumCost(overModels)

  const out = { windows: [], plan: "企业专享版", resets: { until: monthResetAt() } }

  // over 是超出该档额度的钱。额度被管理员调小时它会出现，卡片据此提示透支。
  const push = (name, used, limit) => {
    const w = {
      name,
      used: pct(used, limit),
      // magpie 把 span 读成秒数。
      span: 2592000,
      amount: Math.round(used * 1000) / 1000,
      limit,
      unit: "元",
      display: `￥${yuan(used)} / ￥${yuan(limit)}`,
      resetsAt: monthResetAt(),
    }
    // 先判断是否超过一分钱，再为展示舍入，避免 200.011 被当作误差。
    const excess = used - limit
    const over = Math.round(excess * 100) / 100
    if (excess > 0.01 + Number.EPSILON * Math.max(used, limit) * 4) {
      w.over = over
      w.display = `￥${yuan(used)} / ￥${yuan(limit)}（超出 ￥${yuan(over)}）`
    }
    out.windows.push(w)
  }
  if (seatLimit > 0) push("基础用量", seatUsed, seatLimit)
  if (paygoLimit > 0) push("超额用量", overUsed, paygoLimit)

  // 还能继续花的钱。席位和超额是两段额度，席位先扣：席位还有余额时超额尚未动用，
  // 所以只在席位用完时才把超额剩余算进来。两档相加会把超额已满时的数字说大。
  const seatLeft = Math.max(0, seatLimit - seatUsed)
  const overLeft = Math.max(0, paygoLimit - overUsed)
  if (seatLimit > 0 || paygoLimit > 0) {
    // magpie 只在 balance 是字符串时保留它。
    out.balance = yuan(seatLeft > 0 ? seatLeft : overLeft)
  } else {
    // 额度被清零：没有窗口可画，明确说一句，别让空卡片看起来像读失败。
    out.error = "管理员已把两档额度都设为 0"
  }

  const models = []
  for (const x of seatModels) {
    const cost = Number(x?.total_cost_currency) || 0
    if (!cost) continue
    models.push({ name: x.display_name || x.config_name, cost: Math.round(cost * 1000) / 1000,
      tokens: Number(x.total_token_usage) || 0 })
  }
  models.sort((a, b) => b.cost - a.cost)
  if (models.length) {
    out.metadata = {
      models,
      currency: "CNY",
      seatUsed: Math.round(seatUsed * 1000) / 1000,
      paygoUsed: Math.round(overUsed * 1000) / 1000,
      // 让读卡片的人知道这些数是这一秒的服务器事实，管理员改额度会立刻反映。
      asOf: new Date().toISOString(),
    }
  }
  return out
}

// 每个账号的模型目录可能不同（不同部署开通的模型不一样），所以分开读。
function catalog(home, { fallback = true } = {}) {
  const dir = traeHome(home)
  const local = readLocal(dir)
  const key = JSON.stringify([dir, local?.uid, local?.base])
  let file
  try {
    file = readJson(cachePath(dir))
  } catch (e) {
    const previous = lastCatalog.get(dir)
    if (fallback && e.temporary && previous?.key === key && Date.now() - previous.at < 1000 && previous.items.length) return previous.items
    throw e
  }
  if (file === null) {
    lastCatalog.delete(dir)
    throw new Unreadable("本机缺少模型目录，请由 CLI 重新生成 models_cache.json")
  }
  if (!Array.isArray(file?.models)) throw new Unreadable("模型目录结构无效，需由 CLI 重新生成")
  const models = file.models
  const out = []
  for (const m of models) {
    if (!m || typeof m !== "object" || Array.isArray(m)) throw new Unreadable("模型目录条目结构无效，需由 CLI 重新生成")
    const id = String(m.config_name || "")
    if (!id) continue
    if (m.visibility === "hidden" || m.supported_in_api === false) continue
    const surface = m.business_metadata?.uses_tob_raw_chat_surface !== false
    const ctx = contextOf(m)
    const wire = String(m.business_metadata?.variants?.standard_key || id)
    const modalities = Array.isArray(m.input_modalities) ? m.input_modalities : ["text"]
    const levels = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : []
    out.push({
      id,
      name: String(m.slug || id),
      context: ctx,
      declared: ctx,
      raw: surface,
      wire,
      image: modalities.includes("image"),
      reasoning: Boolean(m.default_reasoning_level) || levels.length > 0,
      efforts: levels.map(String),
    })
  }
  lastCatalog.set(dir, { key, at: Date.now(), items: out })
  return out
}
async function catalogAsync(home) {
  try { return await retryRead(() => catalog(home, { fallback: false })) } catch (e) {
    if (e.temporary) return catalog(home)
    throw e
  }
}

function modelEntry(m) {
  return {
    id: m.id,
    name: m.name,
    providerID: ID,
    limit: { context: m.context, output: outputLimit() },
    api: { id: m.id, npm: "@ai-sdk/openai-compatible" },
    capabilities: {
      reasoning: m.reasoning,
      temperature: true,
      toolcall: true,
      attachment: m.image,
      input: { text: true, image: m.image, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
    variants: Object.fromEntries((m.efforts || []).map((e) => [e, { reasoningEffort: e }])),
  }
}

// 部署的请求体字节限制与模型上下文限制不同，阈值须由部署确认。
// 发送前按最终序列化字节检查预算；优先裁剪旧轮图片和过长工具结果，
// 保留当前轮内容及工具配对，仍超限则返回 413。
const bodyBudget = () => positiveEnv("TRAE_PRIVATE_BODY_BUDGET", 9 * 1024 * 1024)
const toolResultKeep = () => positiveEnv("TRAE_PRIVATE_TOOL_RESULT_KEEP", 20000)

function isImage(part) {
  return part?.type === "image_url" || Boolean(part?.image_url)
}

function imageCount(messages) {
  let n = 0
  for (const m of messages) for (const p of m.content || []) if (isImage(p)) n++
  return n
}

// dropImages 去掉历史里除最后 keep 张以外的图片，返回被丢掉的张数。
function dropImages(messages, keep) {
  let seen = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!Array.isArray(m.content)) continue
    const kept = []
    for (let j = m.content.length - 1; j >= 0; j--) {
      const p = m.content[j]
      if (!isImage(p)) {
        kept.unshift(p)
        continue
      }
      seen++
      if (seen <= keep) kept.unshift(p)
      // 留一句占位：模型知道这里原本有图，也避免出现 content: []。
      else kept.unshift({ type: "text", text: "[image omitted: request-body limit]" })
    }
    m.content = kept
  }
  return seen > keep ? seen - keep : 0
}

// truncateTools 把超长的工具结果压成开头一段加说明，保留可读的上下文。
function truncateTools(messages, keep) {
  let n = 0
  for (const m of messages) {
    if (m.role !== "tool" || !Array.isArray(m.content)) continue
    for (const p of m.content) {
      if (p?.type !== "text" || typeof p.text !== "string" || p.text.length <= keep) continue
      const dropped = p.text.length - keep
      p.text = `${p.text.slice(0, keep)}\n\n[trae-private: 这条工具结果原有 ${p.text.length} 字符，为避开上游请求体上限截掉了后 ${dropped} 字符]`
      n++
    }
  }
  return n
}

// fitBody 把模型列表塞进请求体预算，返回裁剪统计。
function fitBody(body) {
  const notes = { droppedImages: 0, truncatedTools: 0, bytes: 0 }
  const budget = bodyBudget()
  const bytes = () => Buffer.byteLength(sendable(body), "utf8")
  notes.bytes = bytes()
  if (notes.bytes <= budget) return notes
  // 当前轮从最后一个 user 开始；只裁旧轮，保留工具配对、当前图片及工具结果。
  let current = body.messages.findLastIndex((m) => m.role === "user")
  if (current < 0) current = body.messages.length
  const history = body.messages.slice(0, current)
  if (imageCount(history)) {
    notes.droppedImages = dropImages(history, 0)
    notes.bytes = bytes()
  }
  if (notes.bytes > budget) {
    notes.truncatedTools = truncateTools(history, toolResultKeep())
    notes.bytes = bytes()
  }
  if (notes.bytes > budget) throw Object.assign(new Error(`请求体 ${notes.bytes} UTF-8 字节超过预算 ${budget}；请缩短历史、工具定义或当前输入`), { status: 413 })
  return notes
}

function partsOf(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : []
  if (!Array.isArray(content)) return []
  const out = []
  for (const part of content) {
    if (typeof part === "string" && part) out.push({ type: "text", text: part })
    else if (part?.type === "image_url" || part?.image_url) {
      const image = part.image_url
      const url = typeof image === "string" ? image : image?.url
      if (url) out.push({ type: "image_url", image_url: { url: String(url) } })
    } else if (typeof part?.text === "string" && part.text) out.push({ type: "text", text: part.text })
  }
  return out
}

function messagesOf(req) {
  const source = Array.isArray(req.messages)
    ? req.messages
    : typeof req.input === "string"
      ? [{ role: "user", content: req.input }]
      : Array.isArray(req.input)
        ? req.input
        : []
  const out = []
  for (const m of source) {
    const role = m?.role || "user"
    const content = partsOf(m?.content ?? m?.text ?? "")
    // 助手发起的工具调用，按 LLMRawToolCall 原样回填，否则下一轮上游看不到
    // 自己调用过什么，会重复调用或报工具结果没有对应调用。
    const calls = Array.isArray(m?.tool_calls) ? m.tool_calls : []
    if (calls.length) {
      const tool_calls = []
      for (const [i, c] of calls.entries()) {
        const fn = c?.function || c?.function_call
        if (!fn?.name) continue
        tool_calls.push({
          index: Number.isFinite(c?.index) ? c.index : i,
          id: String(c?.id || `call_${i}`),
          type: "function",
          function_call: {
            name: String(fn.name),
            arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
          },
        })
      }
      if (tool_calls.length) {
        out.push({ role, content, tool_calls })
        continue
      }
    }
    // 工具执行结果要带上 tool_call_id，上游靠它和调用配对。
    if (role === "tool" || m?.tool_call_id) {
      out.push({ role: "tool", content, tool_call_id: String(m?.tool_call_id || "") })
      continue
    }
    if (!content.length) continue
    out.push({ role, content })
  }
  return out
}

function toolsOf(req) {
  if (!Array.isArray(req.tools)) return undefined
  const only = typeof req.tool_choice === "object" ? req.tool_choice?.function?.name : ""
  const out = []
  for (const tool of req.tools) {
    const fn = tool?.function || tool
    if (!fn?.name || (only && fn.name !== only)) continue
    const params = fn.parameters ?? { type: "object", properties: {} }
    out.push({
      type: "function",
      function: {
        name: String(fn.name),
        description: typeof fn.description === "string" ? fn.description : "",
        parameters: typeof params === "string" ? params : JSON.stringify(params),
      },
    })
  }
  return out.length ? out : undefined
}

function sessionOf(headers) {
  const given = String(headers?.get?.(SESSION) || "").trim()
  return (given || randomUUID()).slice(0, 128)
}

// 上游只接受 auto/none/required 字符串，实测 OpenAI 的对象形式（指定函数）会让它
// HTTP 500。对象形式只保留指定工具，再配 required。
function toolChoiceOf(value) {
  if (value === "auto" || value === "none" || value === "required") return value
  if (value && typeof value === "object") return "required"
  return undefined
}

// sendable 去掉只给插件自己看的裁剪统计，再把请求体序列化。
function sendable(body) {
  const { fitted, ...wire } = body
  return JSON.stringify(wire)
}

function chatBody(req, session, items = catalog()) {
  const id = String(req.model || "")
  const known = items.find((m) => m.id === id || m.wire === id)
  if (!known) throw Object.assign(new Error(`模型不在所选账号目录中：${id}`), { status: 400 })
  const body = {
    config_name: known.id,
    model_name: known.wire,
    user_input: "",
    messages: messagesOf(req),
    conversation_id: session,
    session_id: session,
  }
  const tools = toolsOf(req)
  if (tools) {
    body.tools = tools
    const choice = toolChoiceOf(req.tool_choice)
    if (choice) body.tool_choice = choice
    if (req.parallel_tool_calls !== undefined) body.parallel_tool_calls = req.parallel_tool_calls
  }
  for (const key of ["temperature", "top_p", "stop", "seed", "frequency_penalty", "presence_penalty"]) {
    if (req[key] !== undefined) body[key] = req[key]
  }
  if (req.reasoning_effort !== undefined) {
    if (!known.efforts.includes(req.reasoning_effort)) throw Object.assign(new Error("模型目录未声明此 reasoning_effort"), { status: 400 })
    body.reasoning_effort = req.reasoning_effort
  }
  const max = req.max_completion_tokens ?? req.max_tokens
  if (Number.isFinite(max) && max > 0) body.max_tokens = Math.floor(max)
  // 上游按请求体字节数拒绝，不是按 token：超预算就先裁历史图片和工具结果，
  // 而不是把 413 原样丢给 agent 让它自己 compaction。
  body.fitted = fitBody(body)
  return body
}

function shortError(text) {
  const raw = String(text || "").trim()
  const i = raw.indexOf("origin err")
  const line = (i >= 0 ? raw.slice(i + "origin err".length).replace(/^\s*=\s*/, "") : raw).split("\n")[0]
  return line.trim().slice(0, 300) || "私有化 TRAE 没有返回可读错误"
}

function errorResponse(status, message, signIn) {
  const headers = { "content-type": "application/json" }
  // magpie 靠 X-Magpie-Sign-In 判断要不要把账号标成失效；本机没登录就是失效，
  // 请求体或模型不对这种 400 不该连累账号。
  if (signIn) headers["X-Magpie-Sign-In"] = signIn
  return new Response(JSON.stringify({ error: { message, type: status === 401 ? "authentication_error" : "server_error" } }), {
    status,
    headers,
  })
}

async function* sse(stream, signal) {
  const reader = stream.getReader()
  const cancel = () => { reader.cancel().catch(() => {}) }
  signal?.addEventListener("abort", cancel, { once: true })
  const dec = new TextDecoder()
  let buf = ""
  let event = ""
  let data = []
  const flush = function* () {
    if (!data.length) return
    const raw = data.join("\n")
    data = []
    let value = raw
    try {
      value = JSON.parse(raw)
    } catch {}
    yield { event, data: value }
    event = ""
  }
  try {
    for (;;) {
      signal?.throwIfAborted()
      const { value, done } = await reader.read()
      signal?.throwIfAborted()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "")
        buf = buf.slice(i + 1)
        if (!line) {
          yield* flush()
          continue
        }
        if (line.startsWith(":")) continue
        if (line.startsWith("event:")) {
          yield* flush()
          event = line.slice(6).trim()
        } else if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
      }
    }
    if (buf.startsWith("data:")) data.push(buf.slice(5).trimStart())
    yield* flush()
  } finally {
    signal?.removeEventListener("abort", cancel)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

// 上游的工具调用在 event: output 的 tool_calls 里，function_call 包着 name/arguments；
// 转成 chat completions 的 function，不然 agent 收不到工具调用。
// 上游只在一次调用的首帧带 id。首帧缺 id 就补 call_<index>：空 id 会让
// ai-sdk 配不上工具结果。续帧不带 id 与 name。
function callsOf(data, seen) {
  if (!Array.isArray(data?.tool_calls)) return []
  const out = []
  for (const [i, c] of data.tool_calls.entries()) {
    const fn = c?.function_call || c?.function
    if (!fn) continue
    const index = Number.isFinite(c?.index) ? c.index : i
    const first = !seen || !seen.has(index)
    const args = fn.arguments ?? fn.partial_arguments
    const call = {
      index,
      type: "function",
      function: { arguments: args == null ? "" : typeof args === "string" ? args : JSON.stringify(args) },
    }
    const id = c?.id != null ? String(c.id) : ""
    if (id) call.id = id
    else if (first) call.id = `call_${index}`
    const name = typeof fn.name === "string" ? fn.name : ""
    if (name) call.function.name = name
    if (seen) seen.add(index)
    out.push(call)
  }
  return out
}

function usageOf(data) {
  data = data?.usage ?? data?.token_usage ?? data
  const prompt = Number(data?.prompt_tokens)
  const completion = Number(data?.completion_tokens)
  if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return null
  const input = Number.isFinite(prompt) ? prompt : 0
  const output = Number.isFinite(completion) ? completion : 0
  const total = Number(data?.total_tokens)
  const cached = Number(data?.cache_read_input_tokens)
  const reasoning = Number(data?.reasoning_tokens)
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: Number.isFinite(total) && total > 0 ? total : input + output,
    prompt_tokens_details: { cached_tokens: Number.isFinite(cached) ? cached : 0 },
    completion_tokens_details: { reasoning_tokens: Number.isFinite(reasoning) ? reasoning : 0 },
  }
}

// 排队事件只是等待信号，不是回答内容。它们的 data 可能是字符串，不拦的话会
// 被当成正文混进回答。
const QUEUE_EVENTS = new Set(["queue_begin", "request_wait_in_queue", "queue_end", "queue_position"])

// 上游认为不正常的结束原因（内容安全拦截等），正常的只有 stop/tool_calls/length。
const BAD_FINISH = /risk|filter|security|intercept|safety|block|moderation/i

function piece(ev, seenCalls) {
  const data = ev?.data
  const event = ev?.event || ""
  // progress_notice 是占位心跳（";Processing_…"），不是回答内容。
  if (event === "progress_notice" || QUEUE_EVENTS.has(event)) return {}
  const obj = data && typeof data === "object" ? data : null
  // event: error 的 data 是 {code, error}；少数情况下也可能直接是个字符串。
  if (event === "error" || obj?.error) return { error: shortError(obj ? obj.error || obj.message : data) }
  // 内容安全拦截：traecli 的 ContentSecurityEvent 带 hit_rule_name/action_type/execute_point，
  // 必须变成错误，不能静默丢弃让 agent 以为模型无话可说。
  const security = obj && (obj.hit_rule_name || obj.action_type || obj.execute_point)
  if (event === "content_security" || (security && event !== "output" && event !== "done")) {
    const rule = typeof obj?.hit_rule_name === "string" && obj.hit_rule_name ? `（命中规则 ${obj.hit_rule_name}）` : ""
    return { error: `内容被上游安全策略拦截${rule}` }
  }
  if (event === "token_usage") return { usage: usageOf(data) }
  // 其余事件（metadata/timing_cost/extra_info 以及没见过的）都不携带回答内容；
  // 只有 output/done 的 response、reasoning_content、tool_calls 算内容。
  if (event !== "output" && event !== "done") return {}
  if (!obj) return { text: typeof data === "string" ? data : "", done: event === "done" }
  const finish = typeof obj.finish_reason === "string" ? obj.finish_reason : ""
  if (finish && BAD_FINISH.test(finish)) return { error: `上游中止了回答（finish_reason: ${finish}）`, finish }
  return {
    text: typeof obj.response === "string" ? obj.response : "",
    reasoning: typeof obj.reasoning_content === "string" ? obj.reasoning_content : "",
    calls: callsOf(obj, seenCalls),
    finish,
    // output 帧上的 finish_reason 不是流的终点：上游随后还会发 token_usage，
    // done 事件里也可能带 usage，在那里结束会丢掉它们。
    done: event === "done",
    usage: usageOf(obj),
  }
}

function chunk(id, model, created, delta, finish, usage) {
  const out = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
  if (usage) out.usage = usage
  return out
}

const INCOMPLETE = "私有化 TRAE 的响应在结束事件前中断"

function streamResponse(model, first, rest, close = async () => {}) {
  const id = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const enc = new TextEncoder()
  const frames = (async function* () {
    try {
      yield chunk(id, model, created, { role: "assistant" }, null)
      let finish = ""
      let usage = null
      const calls = new Map()
      const seenCalls = new Set()
      let done = false
      let ev = first
      for (;;) {
        const p = piece(ev, seenCalls)
        if (p.usage) usage = p.usage
        if (p.error) {
          yield { error: { message: p.error, type: "server_error" } }
          return
        }
        if (p.finish) finish = p.finish
        const delta = {}
        if (p.reasoning) delta.reasoning_content = p.reasoning
        if (p.text) delta.content = p.text
        if (p.calls?.length) {
          delta.tool_calls = p.calls
          for (const c of p.calls) calls.set(c.index, calls.get(c.index) || Boolean(c.function.arguments))
        }
        if (Object.keys(delta).length) yield chunk(id, model, created, delta, null)
        if (p.done) {
          done = true
          break
        }
        const n = await rest.next()
        if (n.done) break
        ev = n.value
      }
      // finish_reason 之后 EOF 就是完整回答：上游可能不发 done 就关流。
      if (!done && !finish) yield { error: { message: INCOMPLETE, type: "server_error" } }
      else {
        const empty = [...calls].filter(([, hasArgs]) => !hasArgs).map(([index]) => ({ index, function: { arguments: "{}" } }))
        if (empty.length) yield chunk(id, model, created, { tool_calls: empty }, null)
        yield chunk(id, model, created, {}, finish || (calls.size ? "tool_calls" : "stop"), usage)
      }
    } catch {
      yield { error: { message: "读取私有化 TRAE 响应失败", type: "server_error" } }
    } finally {
      await close()
      await rest.return?.()
    }
  })()
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const n = await frames.next()
        if (n.done) {
          controller.enqueue(enc.encode("data: [DONE]\n\n"))
          controller.close()
        } else controller.enqueue(enc.encode(`data: ${JSON.stringify(n.value)}\n\n`))
      } catch (e) {
        controller.error(e)
      }
    },
    async cancel() {
      await close()
      await frames.return()
      await rest.return?.()
    },
  })
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
}

async function collect(first, rest) {
  let text = ""
  let reasoning = ""
  let error = ""
  let finish = ""
  let usage = null
  let done = false
  const calls = []
  const seenCalls = new Set()
  const take = (ev) => {
    const p = piece(ev, seenCalls)
    if (p.done) done = true
    if (p.usage) usage = p.usage
    if (p.error) error = p.error
    else {
      text += p.text || ""
      reasoning += p.reasoning || ""
      if (p.finish) finish = p.finish
      // 同一个 index 的分片参数要拼起来，上游可能分多帧发。
      for (const c of p.calls || []) {
        const was = calls.find((x) => x.index === c.index)
        if (!was) calls.push({ ...c })
        else {
          if (c.function.name) was.function.name = c.function.name
          if (c.id) was.id = c.id
          was.function.arguments += c.function.arguments
        }
      }
    }
  }
  take(first)
  if (!done && !error) {
    for await (const ev of rest) {
      take(ev)
      if (done || error) break
    }
  }
  // 同上：只有既没有 done 也没有 finish 才算半截。
  if (!done && !error && !finish) error = INCOMPLETE
  // 上游始终会带 id；万一没带，按 index 造一个，agent 配对工具结果时要用。
  for (const c of calls) {
    if (!c.id) c.id = `call_${c.index}`
    if (!c.function.arguments && (done || finish) && !error) c.function.arguments = "{}"
  }
  return { text, reasoning, error, finish, usage, calls }
}

export default async function TraePrivateAuthPlugin(input) {
  return {
    config: async (config) => {
      try {
        const snapshot = await catalogAsync(traeHome())
        const items = reported(snapshot.filter((m) => m.raw), input)
        const local = await retryRead(() => readLocal(traeHome()))
        const was = config.provider?.[ID] ?? {}
        const models = {}
        for (const m of items) {
          models[m.id] = {
            ...was.models?.[m.id], name: was.models?.[m.id]?.name || m.name,
            limit: { context: m.context, output: outputLimit() },
            tool_call: true, reasoning: m.reasoning,
            modalities: { input: m.image ? ["text", "image"] : ["text"], output: ["text"] },
            variants: Object.fromEntries(m.efforts.map((e) => [e, { reasoningEffort: e }])),
          }
        }
        config.provider ??= {}
        config.provider[ID] = { ...was, name: was.name || "TRAE 私有化", npm: "@ai-sdk/openai-compatible", api: local ? local.base + "/v1" : "", models }
      } catch { /* 请求入口返回错误，不使宿主加载失败。 */ }
    },
    "chat.headers": async (input, output) => {
      const id = input?.model?.providerID ?? input?.provider?.info?.id
      if (id !== ID || !input?.sessionID) return
      output.headers[SESSION] = String(input.sessionID).slice(0, 128)
    },
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        try {
          const home = auth ? (await connectedLocal(auth), auth.traeHome) : traeHome()
          const models = {}
          for (const m of reported((await catalogAsync(home)).filter((m) => m.raw), input)) {
            const was = provider.models?.[m.id] ?? {}
            models[m.id] = { ...was, ...modelEntry(m), name: was.name || m.name }
          }
          return models
        } catch (e) {
          if (auth) throw Object.assign(e, { signIn: e.signIn || "kept" })
          return {}
        }
      },
    },
    auth: {
      provider: ID,
      // 与 REFRESH_MARGIN 对齐：到期前 2 小时开始尝试续期。
      refreshLead: 2 * 3600 * 1000,
      // magpie 供应商卡上的用量（OpenCode 忽略这个钩子）。它读的是网页那套身份：
      // cookie 没配或过期就读不到，卡片说清楚原因，不编数字，也不因此判定账号失效。
      usage: async (getAuth) => {
        try {
          const auth = await getAuth()
          const local = await connectedLocal(auth)
          const cookie = usageCookie(auth)
          if (!cookie) return { windows: [], error: "未拿到有效网页会话：使用「重新 SSO / 补采集用量会话」", signIn: "kept" }
          const [quota, usage] = await Promise.all([
            traeGet(sameOriginPath(local.base, "/trae/gtm/tob/api/v1/config/get_personal_quota"), cookie),
            traeGet(sameOriginPath(local.base, "/trae/gtm/tob/api/v1/config/get_user_model_usage"), cookie),
          ])
          return quotaOf(quota, usage)
        } catch (e) { return { windows: [], error: String(e?.message || e), signIn: e.signIn || "kept" } }
      },
      options: [
        {
          key: MAX_WINDOW_KEY,
          label: "按上游完整上下文窗口上报",
          description:
            "默认尊重模型目录声明；开启后仅提高到 TRAE_PRIVATE_CONTEXT（默认 1000000），不会降低更大窗口。仅在部署确认支持时开启。",
          default: false,
        },
      ],
      async refresh(auth) {
        let local = await connectedLocal(auth, { expiredOK: true })
        if (local.expires && local.expires - Date.now() < REFRESH_MARGIN) {
          await renewViaCli(auth.traeHome).catch(() => false)
          local = await connectedLocal(auth, { expiredOK: true })
        }
        if (local.expires && local.expires <= Date.now()) throw Object.assign(new Error("本机 traecli 登录已过期，请重新登录"), { signIn: "kept" })
        if (auth.access === local.token && auth.expires === local.expires && auth.bindingVersion === 1 && !auth.refresh) return
        const { refresh, webSession, ...safe } = auth
        return { ...safe, ...bindingOf(local, auth.traeHome), bindingVersion: 1, access: local.token, expires: local.expires, refresh: null, webSession: null }
      },
      // 每个账号的登录记着自己的 traecli 目录（登录时填的），请求按账号分别读。
      loader: async (getAuth) => {
        const saved = await getAuth()
        return {
          baseURL: saved?.baseURL ? `${checkedBase(saved.baseURL)}/v1` : "https://unconnected.invalid/v1",
          apiKey: "trae-private",
          async fetch(input, init = {}) {
            let local, account, snapshot
            try {
              account = await getAuth()
              local = await connectedLocal(account)
              snapshot = await catalogAsync(account.traeHome)
              // 目录读取期间发生身份切换也不能沿用先前快照。
              local = await connectedLocal(account)
            } catch (e) {
              if (e instanceof Unreadable) return errorResponse(503, e.message, "kept")
              return errorResponse(e.signIn ? 401 : 502, String(e?.message || e), e.signIn || "kept")
            }
            const token = local?.token || ""
            const base = local.base
            if (!token) return errorResponse(401, "本机没有 traecli 登录，在 Magpie 打开该供应商并登录", "expired")
            if (local.expires && local.expires <= Date.now()) {
              return errorResponse(401, "本机 traecli 登录已过期，在 Magpie 打开该供应商重新登录", "kept")
            }
            const request = input instanceof Request ? input : null
            let raw = init.body ?? (request ? await request.text() : "")
            if (raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw)
            else if (ArrayBuffer.isView(raw)) raw = new TextDecoder().decode(raw)
            let req
            try {
              req = JSON.parse(raw || "{}")
            } catch {
              return errorResponse(400, "请求体不是 JSON")
            }
            if (!req || typeof req !== "object" || Array.isArray(req)) return errorResponse(400, "请求体必须是 JSON 对象")
            if (!messagesOf(req).length) return errorResponse(400, "没有可发送的对话内容")
            const known = snapshot.find((m) => m.id === req.model || m.wire === req.model)
            if (!known) return errorResponse(400, "模型不在所选账号目录中")
            if (known && !known.raw) return errorResponse(400, `${req.model} 不走 llm_raw_chat，当前插件只转发 uses_tob_raw_chat_surface 的模型`)
            const only = typeof req.tool_choice === "object" ? req.tool_choice?.function?.name : ""
            if (only && !toolsOf(req)?.length) return errorResponse(400, "tool_choice 指定的函数不在 tools 中")
            const headers = new Headers(init.headers ?? request?.headers ?? {})
            const session = sessionOf(headers)
            const ac = new AbortController()
            const outer = init.signal ?? request?.signal ?? null
            const onAbort = () => ac.abort(outer.reason)
            if (outer) {
              if (outer.aborted) onAbort()
              else outer.addEventListener("abort", onAbort, { once: true })
            }
            let res
            let it
            let handedOff = false
            let closed = false
            const close = async () => {
              if (closed) return
              closed = true
              outer?.removeEventListener("abort", onAbort)
              ac.abort()
              if (it) await it.return?.().catch(() => {})
              else await res?.body?.cancel().catch(() => {})
            }
            try {
              ac.signal.throwIfAborted()
              const wireBody = sendable(chatBody(req, session, snapshot))
              const protocol = protocolConfig()
              res = await fetch(sameOriginPath(base, "/api/ide/v2/llm_raw_chat"), {
                method: "POST",
                redirect: "error",
                headers: {
                  Authorization: `Cloud-IDE-JWT ${token}`,
                  "Content-Type": "application/json",
                  Accept: "text/event-stream",
                  "x-app-id": protocol.appId,
                  "x-ide-function": "chat",
                  "x-ide-version-code": protocol.ideVersionCode,
                  "x-ide-version": protocol.ideVersion,
                  version: protocol.version,
                  originator: protocol.originator,
                  "User-Agent": protocol.userAgent,
                },
                body: wireBody,
                signal: ac.signal,
              })
              if (!res.ok) {
                const text = await res.text()
                return errorResponse(res.status, shortError(text))
              }
              const type = res.headers.get("content-type") || ""
              if (!type.includes("event-stream")) {
                const text = await res.text()
                try {
                  const o = JSON.parse(text)
                  if (o.error || o.message) return errorResponse(502, shortError(o.error || o.message))
                } catch {}
                return errorResponse(502, shortError(text))
              }
              it = sse(res.body, ac.signal)[Symbol.asyncIterator]()
              // 首帧可能只有排队或心跳；等到内容或错误再确定 HTTP 状态。
              const seenCalls = new Set()
              let first = null
              for (;;) {
                const n = await it.next()
                if (n.done) return errorResponse(502, "私有化 TRAE 没有返回内容")
                const p = piece(n.value, seenCalls)
                if (p.error) return errorResponse(502, p.error)
                if (p.text || p.reasoning || p.calls?.length || p.usage || p.finish || p.done) {
                  first = n.value
                  break
                }
              }
              // OpenAI 里缺省 stream 就是 false，openai-compatible 的 doGenerate 不传它。
              if (req.stream !== true) {
                const all = await collect(first, it)
                if (all.error) return errorResponse(502, all.error)
                const message = { role: "assistant", content: all.text || (all.calls.length ? "" : all.reasoning) }
                if (all.reasoning) message.reasoning_content = all.reasoning
                if (all.calls.length) message.tool_calls = all.calls.map(({ index, ...c }) => c)
                const payload = {
                  id: `chatcmpl-${randomUUID()}`,
                  object: "chat.completion",
                  created: Math.floor(Date.now() / 1000),
                  model: req.model,
                  choices: [
                    { index: 0, message, finish_reason: all.finish || (all.calls.length ? "tool_calls" : "stop") },
                  ],
                }
                if (all.usage) payload.usage = all.usage
                return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } })
              }
              const response = streamResponse(req.model, first, it, close)
              handedOff = true
              return response
            } catch (e) {
              if (e.status) return errorResponse(e.status, e.message)
              return errorResponse(502, ac.signal.aborted ? "请求已取消" : `读取私有化 TRAE 响应失败：${e.message}`)
            } finally {
              if (!handedOff) await close()
            }
          },
        }
      },
      methods: [
        {
          type: "oauth",
          label: "重新 SSO / 补采集用量会话",
          prompts: [
            { type: "text", key: "baseURL", message: "企业 HTTPS 地址", validate: (v) => parseBaseURL(v).error },
            { type: "text", key: "traeHome", message: "原账号 CLI 绝对目录（留空使用默认）", validate: (v) => absoluteDirError(v, true) },
          ],
          authorize: (inputs) => authorizeLogin({ ...inputs, forceSso: true }, inputs?.traeHome),
        },
        {
          type: "oauth",
          label: "登录企业 TRAE",
          prompts: [
            {
              type: "text",
              key: "baseURL",
              message: "企业地址",
              placeholder: "https://…",
              validate: (v) => parseBaseURL(v).error,
            },
          ],
          authorize: (inputs) => authorizeLogin(inputs, ""),
        },
        {
          type: "oauth",
          label: "用另一个 traecli 目录登录",
          prompts: [
            {
              type: "text",
              key: "baseURL",
              message: "企业地址",
              placeholder: "https://…",
              validate: (v) => parseBaseURL(v).error,
            },
            {
              type: "text",
              key: "traeHome",
              message: "traecli 目录（多账号时每个账号一个目录）",
              placeholder: join(homedir(), ".trae-work"),
              validate: (v) => absoluteDirError(v, false),
            },
          ],
          authorize: (inputs) => authorizeLogin(inputs, inputs?.traeHome),
        },
      ],
    },
  }
}

// signInAt 读某个 traecli 目录的登录。返回里带 traeHome，magpie 把它和这个
// 账号一起存住，之后请求、刷新、模型目录都按它读。
async function signInAt(inputs, home) {
  const dir = traeHome(home)
  let local
  try {
    local = await retryRead(() => readLocal(dir))
  } catch (e) {
    return { type: "failed", error: e instanceof Unreadable ? `CLI 文件暂不可读，稍后重试：${e.message}` : "CLI 身份或部署配置无效，请重新登录" }
  }
  if (!local) {
    return {
      type: "failed",
      error: dir
        ? `没有读到 ${join(traeHome(dir), "cli", "auth.json")}：在 Magpie 用该目录登录`
        : "没有读到 ~/.trae/cli/auth.json：在 Magpie 打开该供应商并登录",
    }
  }
  if (local.expires && local.expires <= Date.now()) {
    return { type: "failed", error: "traecli 登录已过期，在 Magpie 打开该供应商重新登录" }
  }
  if (!local.uid) return { type: "failed", error: "CLI 缺少稳定 uid，请重新登录连接" }
  // magpie 依次用 accountId、metadata.email、email 给账号命名。
  // 只有目录不是默认那个时才在名字里带上它：同一个目录从两个入口连进来
  // 必须是同一个账号，否则 magpie 会存出两条重复记录。
  const isDefault = traeHome(dir) === traeHome("")
  const name = isDefault ? local.name : `${local.name} (${dir})`
  const parsed = parseBaseURL(inputs?.baseURL || local.base)
  if (parsed.error || !sameBase(parsed.base, local.base)) return { type: "failed", error: "CLI 登录部署与输入不匹配，请重新连接正确部署" }
  return {
    type: "success",
    access: local.token,
    ...bindingOf(local, dir),
    bindingVersion: 1,
    refresh: null,
    webSession: null,
    expires: local.expires,
    accountId: name,
    uid: local.uid,
    email: String(local.email || ""),
    traeHome: dir,
    baseURL: checkedBase(local.base),
    quotaStatus: webCookie(bindingOf(local, dir)) ? "available" : "missing",
    quotaError: webCookie(bindingOf(local, dir)) ? undefined : "聊天登录成功；尚未采集有效用量 cookie，可使用补采集入口",
  }
}

function readyLocal(home, base) {
  try {
    const local = readLocal(home)
    if (!local) return null
    if (local.expires && local.expires <= Date.now()) return null
    if (base && local.base && !sameBase(local.base, base)) return null
    return local
  } catch { return null }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function loginURL(line) {
  if (/\berror\b/i.test(line)) return ""
  for (const raw of line.match(/https:\/\/[^\s"'<>]+/g) || []) {
    try {
      const u = new URL(raw)
      if (u.username || u.password || u.hash) continue
      const route = /(?:^|\/)(?:sso|oauth2?|authorize|login|auth)(?:\/|$)/i.test(u.pathname)
      const oauth = u.searchParams.has("state") && (u.searchParams.has("redirect_uri") || u.searchParams.has("client_id"))
      if (route || oauth) return u.href
    } catch {}
  }
  return ""
}

function startCliLogin(exe, base, home, browser) {
  const env = { ...process.env }
  const dir = String(home || "").trim()
  if (dir) env.TRAE_HOME = traeHome(dir)
  let shim = ""
  if (browser?.port && process.platform !== "win32") {
    shim = writeOpenShim(browser.port)
    env.PATH = `${shim}${delimiter}${env.PATH || ""}`
    env.BROWSER = join(shim, "open")
  }
  const cwd = mkdtempSync(join(tmpdir(), "trae-private-login-"))
  let child
  try { child = spawnLogin(exe, ["login", "-c", `trae_login_base_url="${base}"`], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  }) } catch (e) {
    rmSync(cwd, { recursive: true, force: true })
    if (shim) rmSync(shim, { recursive: true, force: true })
    throw e
  }
  let buf = ""
  let found
  const link = new Promise((resolve) => { found = resolve })
  const onData = (chunk) => {
    buf = (buf + chunk.toString()).slice(-65536)
    let i
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "").replace(ANSI, "").trim()
      buf = buf.slice(i + 1)
      const u = loginURL(line, base)
      if (u) found(u)
    }
  }
  child.stdout?.on?.("data", onData)
  child.stderr?.on?.("data", onData)
  const done = new Promise((resolve) => {
    child.on("error", () => {
      found("")
      resolve({ ok: false })
    })
    child.on("close", (code) => {
      const rest = buf.replace(ANSI, "").trim()
      if (rest) {
        const u = loginURL(rest, base)
        if (u) found(u)
      }
      found("")
      resolve({ ok: code === 0 })
    })
  })
  return { child, link, done, shim, cwd }
}

async function finishLogin(inputs, dir, browser, base) {
  const signed = await signInAt(inputs, dir)
  if (signed.type !== "success") return signed
  let selected
  let reason = "未启动可采集会话的浏览器"
  if (browser?.cookies) {
    try {
      const target = sameOriginPath(base, "/trae/gtm/tob/api/v1/config/get_personal_quota")
      for (let i = 0; i < 8 && !selected; i++) {
        selected = selectedCookie(await bounded(browser.cookies(), 5000, "cookie 采集超时"), target)
        if (!selected) await wait(50)
      }
      reason = "授权浏览器没有有效的部署用量 cookie"
    } catch { reason = "用量 cookie 采集失败，可重新补采集" }
  }
  await connectedLocal(signed)
  if (selected) saveWebSession(signed, { ...selected, expires: selected.expires > 0 ? selected.expires : Date.now() / 1000 + 12 * 3600 })
  const cookie = webCookie(signed)
  return { ...signed, quotaStatus: cookie ? "available" : "missing", quotaError: cookie ? undefined : reason }
}

async function bounded(promise, ms, message) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })]) }
  finally { clearTimeout(timer) }
}

async function authorizeLogin(inputs, home) {
  const parsed = parseBaseURL(inputs?.baseURL)
  if (parsed.error) return { type: "failed", error: parsed.error }
  const base = parsed.base
  const dir = traeHome(home)
  const initial = readyLocal(dir, base)
  if (initial && !inputs?.forceSso) return {
    url: "", instructions: "复用 CLI 聊天登录；用量缺失时请使用单独的补采集入口。", method: "auto",
    callback: async () => {
      try { return await finishLogin(inputs, dir, null, base) }
      catch { return { type: "failed", error: "CLI 身份或部署已改变，请重新连接" } }
    },
  }
  const exe = cliPath()
  if (!existsSync(exe)) return { type: "failed", error: "未找到 traecli，请安装 CLI 或设置 TRAE_PRIVATE_CLI" }
  let browser, session, lease, disposed = false, callbackPromise
  const cleanup = async () => {
    if (disposed) return
    disposed = true
    clearTimeout(lease)
    inputs?.signal?.removeEventListener("abort", onAbort)
    try { session?.child.kill?.() } catch {}
    await browser?.stop?.().catch(() => {})
    for (const d of [session?.shim, session?.cwd]) if (d) rmSync(d, { recursive: true, force: true })
  }
  const onAbort = () => { void cleanup() }
  try {
    inputs?.signal?.throwIfAborted()
    browser = await launchDebugBrowser()
    inputs?.signal?.throwIfAborted()
    session = startCliLogin(exe, base, dir, browser)
    lease = setTimeout(() => { void cleanup() }, _internal.loginTimeout ?? LOGIN_WAIT)
    lease.unref?.()
    inputs?.signal?.addEventListener("abort", onAbort, { once: true })
    const url = await bounded(session.link, _internal.linkTimeout ?? LINK_WAIT, "CLI 未输出有效授权 URL")
    if (!url) { await cleanup(); return { type: "failed", error: "CLI 提前退出，未产生有效授权 URL" } }
    if (browser) await bounded(browser.open(url), 5000, "CDP 打开授权页失败")
    const callback = () => callbackPromise ||= (async () => {
      try {
        while (!disposed) {
          inputs?.signal?.throwIfAborted()
          const local = readyLocal(dir, base)
          if (local && (!inputs?.forceSso || local.token !== initial?.token)) {
            return await finishLogin(inputs, dir, browser, base)
          }
          const finished = await bounded(Promise.race([session.done, wait(50).then(() => null)]), 1000, "等待 CLI 超时")
          if (finished) {
            if (finished.ok && readyLocal(dir, base)) return await finishLogin(inputs, dir, browser, base)
            return { type: "failed", error: "CLI 登录未完成；请重试 SSO" }
          }
        }
        return { type: "failed", error: "登录已取消或超时，请重试" }
      } catch { return { type: "failed", error: "登录或会话采集失败，请重试" } }
      finally { await cleanup() }
    })()
    return {
      url, opened: Boolean(browser) && opensPage(), method: "auto", callback, cancel: cleanup,
      instructions: "完成企业 SSO。聊天身份与用量会话分别验收；未采集 cookie 时可重试补采集。",
    }
  } catch { await cleanup(); return { type: "failed", error: "启动登录失败、取消或超时；请检查 CLI 和浏览器后重试" } }
}

// 测试用。magpie 会把入口导出的每个函数当成插件调用，所以辅助函数必须挂在
// 一个对象上（社区插件的惯例是 _internal），不能逐个导出。
export const _internal = {
  catalog,
  catalogAsync,
  connectedLocal,
  renewViaCli,
  execFile,
  protocolConfig,
  checkCliExecutable,
  sameOriginPath,
  loginURL,
  saveWebSession,
  cdpCookies,
  openDebugPage,
  signInAt,
  authorizeLogin,
  parseBaseURL,
  parseCookieValue,
  cookieForHost,
  spawnLogin: defaultSpawnLogin,
  launchDebugBrowser: defaultLaunchDebugBrowser,
  cliPath,
  magpieConfigDir,
  absoluteDirError,
  traeHome,
  authPath,
  cachePath,
  webCookiePath,
  webCookie,
  usageCookie,
  contextOf,
  quotaOf,
  fitBody,
  dropImages,
  truncateTools,
  sendable,
  messagesOf,
  partsOf,
  toolsOf,
  toolChoiceOf,
  chatBody,
  callsOf,
  usageOf,
  piece,
  collect,
  shortError,
  sse,
  streamResponse,
}

