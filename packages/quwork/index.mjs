import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const PROVIDER = "quwork"
const LLM_BASE = "https://llm.quwork.cn/v1"
const ACCOUNT_BASE = "https://llm.rrzu.com"
const TOKEN_ENV = "QUWORK_LLM_TOKEN"
const FALLBACK_VERSION = "1.7.5"
const CAPTCHA_SDK = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"
const CAPTCHA_REGION = "cn"
const CAPTCHA_PREFIX = "1hms8d"
const CAPTCHA_SCENE_ID = "10vzkucv"
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const BALANCE_FILE = join(PLUGIN_DIR, "page", "balance.js")
const DEVICE_FILE = join(tmpdir(), "magpie-quwork-device.json")
const BALANCE_TTL_MS = 60_000

const balanceCache = new Map()

const MODELS = [
  {
    id: "deepseek-flash",
    name: "DeepSeek-V4.1-Flash",
    limit: { context: 1000000, output: 384000 },
    reasoning: true,
    tool_call: true,
    modalities: { input: ["text", "image"] },
    variants: { off: {}, low: {}, high: {}, max: {} },
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek-V4-Pro",
    limit: { context: 1000000, output: 384000 },
    reasoning: true,
    tool_call: true,
    variants: { off: {}, low: {}, high: {}, max: {} },
  },
  { id: "qwen3.8-max", name: "Qwen3.8-Max", limit: { context: 1000000, output: 128000 }, tool_call: true },
  { id: "qwen3.8-flash", name: "Qwen3.8-Flash", limit: { context: 1000000, output: 128000 }, tool_call: true, modalities: { input: ["text", "image"] } },
  { id: "qwen3.7-plus", name: "Qwen3.7-Plus", limit: { context: 1000000, output: 128000 }, tool_call: true, modalities: { input: ["text", "image"] } },
  { id: "glm-5.3-flash", name: "GLM-5.3 Flash", limit: { context: 1000000, output: 128000 }, tool_call: true, modalities: { input: ["text", "image"] } },
  { id: "glm-5.2", name: "GLM-5.2", limit: { context: 1000000, output: 128000 }, tool_call: true },
  { id: "kimi-k2.7-code", name: "Kimi-K2.7-Code", limit: { context: 1000000, output: 128000 }, tool_call: true },
  { id: "kimi-k2.6", name: "Kimi-K2.6", limit: { context: 1000000, output: 262144 }, tool_call: true, modalities: { input: ["text", "image"] } },
  { id: "MiniMax-M2.5", name: "MiniMax-M2.5", limit: { context: 1000000, output: 32768 }, tool_call: true },
]

const LOGIN_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>QuWork 登录 · magpie</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background:#f5f6f8; color:#1c1f23; }
  @media (prefers-color-scheme: dark) { body { background:#15171a; color:#eceff3; } .card { background:#1e2126; } input { background:#14171a; color:#eceff3; border-color:#3a3f46; } }
  .card { width:min(420px, calc(100vw - 40px)); background:#fff; border-radius:16px; padding:28px; box-shadow:0 16px 48px rgba(0,0,0,.12); }
  h1 { font-size:20px; margin:0 0 6px; }
  p.sub { margin:0 0 20px; color:#6b7280; font-size:13px; line-height:1.6; }
  label { display:block; font-size:13px; margin:14px 0 6px; }
  input { width:100%; box-sizing:border-box; height:42px; padding:0 12px; border:1px solid #d6d9de; border-radius:10px; font-size:15px; }
  button { height:42px; padding:0 16px; border:0; border-radius:10px; background:#2f6fed; color:#fff; font-size:14px; cursor:pointer; }
  button:disabled { opacity:.5; cursor:not-allowed; }
  button.ghost { background:#eef1f6; color:#1c1f23; }
  @media (prefers-color-scheme: dark) { button.ghost { background:#2a2e34; color:#eceff3; } }
  #send { margin-top:10px; width:100%; }
  #login { margin-top:18px; width:100%; }
  #msg { margin-top:14px; font-size:13px; line-height:1.6; min-height:20px; }
  .ok { color:#16a34a; } .err { color:#dc2626; }
  #captcha-box { margin-top:10px; }
  .tip { margin-top:16px; font-size:12px; color:#8a919b; line-height:1.6; }
</style>
</head>
<body>
<main class="card">
  <h1>QuWork 登录</h1>
  <p class="sub">用手机号 + 短信验证码登录 QuWork。登录成功后这个页面会提示完成，magpie 会自动接管，不需要安装 QuWork 客户端。</p>
  <label for="phone">手机号</label>
  <input id="phone" inputmode="numeric" autocomplete="tel" placeholder="11 位手机号，例如 13800000000" />
  <div id="captcha-box"></div>
  <button id="captcha-button" style="display:none" tabindex="-1" aria-hidden="true"></button>
  <button id="send" class="ghost">发送验证码</button>
  <label for="code">短信验证码</label>
  <input id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="输入收到的验证码" maxlength="6" />
  <button id="login">登录并接入 magpie</button>
  <div id="msg"></div>
  <div class="tip">验证码由 QuWork 发送，登录态只保存在本机 magpie。若验证码加载失败，可改用 magpie 里的「读取 QuWork 本机登录态」或「粘贴令牌」。</div>
</main>
<script src="${CAPTCHA_SDK}"></script>
<script>
  const $ = (id) => document.getElementById(id)
  const msg = (text, cls) => { $("msg").textContent = text || ""; $("msg").className = cls || "" }
  let captcha = ""
  let cooldown = 0
  let timer = null

  function setBusy(busy) {
    $("send").disabled = busy || cooldown > 0
    $("login").disabled = busy
  }

  function tick() {
    if (cooldown <= 0) { clearInterval(timer); timer = null; $("send").textContent = "发送验证码"; $("send").disabled = false; return }
    $("send").textContent = cooldown + " 秒后可重发"
    $("send").disabled = true
    cooldown -= 1
  }

  async function sendCode() {
    const phone = $("phone").value.trim()
    if (!/^1[3-9]\\d{9}$/.test(phone)) { msg("请输入正确的 11 位手机号", "err"); return }
    if (!captcha) { msg("请先完成验证码", "err"); return }
    setBusy(true)
    try {
      const res = await fetch("api/send-code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone, captcha }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) { msg(data.message || "发送失败，请重试", "err"); return }
      msg("验证码已发送，请查收短信", "ok")
      cooldown = 60
      timer = setInterval(tick, 1000)
      tick()
    } catch (error) {
      msg("发送失败：" + error.message, "err")
    } finally {
      setBusy(false)
    }
  }

  async function login() {
    const phone = $("phone").value.trim()
    const code = $("code").value.trim()
    if (!/^1[3-9]\\d{9}$/.test(phone)) { msg("请输入正确的 11 位手机号", "err"); return }
    if (!/^\\d{4,6}$/.test(code)) { msg("请输入短信里的验证码", "err"); return }
    setBusy(true)
    try {
      const res = await fetch("api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone, code }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) { msg(data.message || "登录失败，请重试", "err"); return }
      msg("登录成功，正在接入 magpie，可以关闭本页了。", "ok")
    } catch (error) {
      msg("登录失败：" + error.message, "err")
    } finally {
      setBusy(false)
    }
  }

  $("send").addEventListener("click", () => {
    if (captcha) { sendCode(); return }
    if (typeof window.initAliyunCaptcha !== "function") { msg("验证码组件加载失败，请改用「读取本机登录态」或「粘贴令牌」", "err"); return }
    if (window.__captchaInstance) { window.__captchaInstance.verify(); return }
    msg("验证码组件还在加载，请稍候再点一次", "err")
  })
  $("login").addEventListener("click", login)

  window.AliyunCaptchaConfig = { region: "${CAPTCHA_REGION}", prefix: "${CAPTCHA_PREFIX}" }
  if (typeof window.initAliyunCaptcha === "function") {
    window.initAliyunCaptcha({
      SceneId: "${CAPTCHA_SCENE_ID}",
      mode: "popup",
      element: "#captcha-box",
      button: "#captcha-button",
      language: "cn",
      success: (param) => { captcha = param; sendCode() },
      fail: () => { msg("验证未通过，请重试", "err") },
      getInstance: (instance) => { window.__captchaInstance = instance },
    })
  }
</script>
</body>
</html>`

function appDataDirs() {
  const dirs = []
  if (process.env.APPDATA) dirs.push(process.env.APPDATA)
  if (process.platform === "darwin") dirs.push(join(homedir(), "Library", "Application Support"))
  else dirs.push(join(homedir(), ".config"))
  return dirs
}

function harnessRoots() {
  const roots = []
  if (process.env.QURWORK_DSH_HOME) roots.push(process.env.QURWORK_DSH_HOME)
  roots.push(join(homedir(), ".qurwork-desktop-dsh", ".dsh"))
  roots.push(join(homedir(), ".quwork-desktop-dsh", ".dsh"))
  return roots
}

function tokenFromCredentials(file) {
  try {
    if (!existsSync(file)) return ""
    const raw = readFileSync(file, "utf8")
    const match = raw.match(/QURIVS_LLM_API_KEY\s*:\s*([^\s,}]+)/)
    return match ? match[1].replace(/^["']|["']$/g, "").trim() : ""
  } catch {
    return ""
  }
}

function tokensFromWal(walFile) {
  try {
    if (!existsSync(walFile)) return {}
    const text = readFileSync(walFile).toString("latin1")
    const start = text.indexOf('"accessToken"')
    if (start < 0) return {}
    const chunk = text.slice(start, start + 1600)
    return {
      llmToken: chunk.match(/"llmToken":"([^"]+)"/)?.[1] ?? "",
      accessToken: chunk.match(/"accessToken":"([^"]+)"/)?.[1] ?? "",
    }
  } catch {
    return {}
  }
}

async function readDesktopSession(file) {
  const walFile = `${file}-wal`
  const shmFile = `${file}-shm`
  try {
    const { Database } = await import("bun:sqlite")
    const db = new Database(file, { readonly: true })
    try {
      const row = db.query("select session_json from auth_session where id = 1").get()
      if (row?.session_json) return JSON.parse(row.session_json)
    } finally {
      db.close()
    }
  } catch {
    // The desktop app may hold the database open; use a copy below.
  }

  try {
    const dir = mkdtempSync(join(tmpdir(), "quwork-session-"))
    try {
      const copy = join(dir, "db.sqlite")
      copyFileSync(file, copy)
      if (existsSync(walFile)) copyFileSync(walFile, `${copy}-wal`)
      if (existsSync(shmFile)) copyFileSync(shmFile, `${copy}-shm`)
      const { Database } = await import("bun:sqlite")
      const db = new Database(copy, { readonly: true })
      try {
        const row = db.query("select session_json from auth_session where id = 1").get()
        if (row?.session_json) return JSON.parse(row.session_json)
      } finally {
        db.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  } catch {
    // Fall through to the WAL scan.
  }
  return null
}

async function tokenFromDesktopDb() {
  for (const base of appDataDirs()) {
    const file = join(base, "qurwork-desktop", "qurwork-desktop.sqlite")
    const walFile = `${file}-wal`
    if (!existsSync(file) && !existsSync(walFile)) continue
    const session = existsSync(file) ? await readDesktopSession(file) : null
    if (session?.llmToken) return String(session.llmToken).trim()
    const tokens = tokensFromWal(walFile)
    if (tokens.llmToken) return tokens.llmToken
  }
  return ""
}

async function findLocalToken() {
  const fromEnv = (process.env[TOKEN_ENV] ?? "").trim()
  if (fromEnv) return { key: fromEnv, source: "env" }
  for (const root of harnessRoots()) {
    const key = tokenFromCredentials(join(root, ".credentials.yaml"))
    if (key) return { key, source: "credentials" }
  }
  const key = await tokenFromDesktopDb()
  if (key) return { key, source: "desktop-db" }
  return { key: "", source: "" }
}

async function findAccessToken() {
  for (const base of appDataDirs()) {
    const file = join(base, "qurwork-desktop", "qurwork-desktop.sqlite")
    const walFile = `${file}-wal`
    if (!existsSync(file) && !existsSync(walFile)) continue
    const session = existsSync(file) ? await readDesktopSession(file) : null
    if (session?.accessToken) return String(session.accessToken).trim()
    const tokens = tokensFromWal(walFile)
    if (tokens.accessToken) return tokens.accessToken
  }
  return ""
}

function quworkVersion() {
  for (const root of harnessRoots()) {
    try {
      const file = join(root, "profiles", "web", "cordis.patch.yml")
      if (!existsSync(file)) continue
      const match = readFileSync(file, "utf8").match(/X-QurWork-Version\s*:\s*([0-9][^\s,}]*)/)
      if (match) return match[1].trim()
    } catch {
      continue
    }
  }
  return FALLBACK_VERSION
}

function deviceIdentifier() {
  try {
    if (existsSync(DEVICE_FILE)) {
      const data = JSON.parse(readFileSync(DEVICE_FILE, "utf8"))
      if (typeof data?.deviceId === "string" && data.deviceId) return data.deviceId
    }
  } catch {
    // Generate a new id below.
  }
  const deviceId = randomUUID()
  try {
    writeFileSync(DEVICE_FILE, JSON.stringify({ deviceId }), "utf8")
  } catch {
    // A read-only temp folder is fine; the id is then only stable for this process.
  }
  return deviceId
}

function numberOrZero(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

async function readPoints(accessToken, { force = false } = {}) {
  if (!accessToken) return null
  const cached = balanceCache.get(accessToken)
  if (!force && cached && Date.now() - cached.at < BALANCE_TTL_MS) return cached.points
  const res = await fetch(`${ACCOUNT_BASE}/api/user/self`, {
    headers: { authorization: `Bearer ${accessToken}`, "x-qurwork-env": "prod", "x-qurwork-version": quworkVersion() },
  })
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error(`QuWork 拒绝了这份凭据（HTTP ${res.status}），请重新登录 QuWork`), { status: res.status, signIn: "expired" })
  }
  if (!res.ok) throw new Error(`QuWork 返回 ${res.status}`)
  const payload = await res.json()
  const entitlement = payload?.data?.points_entitlement
  if (!payload?.success || !entitlement) {
    throw new Error(payload?.message || "QuWork 积分接口没有返回可用数据")
  }
  const points = {
    total: numberOrZero(entitlement.total_points),
    limited: numberOrZero(entitlement.limited_points),
    permanent: numberOrZero(entitlement.permanent_points),
    plan: entitlement.active_subscription?.plan_name ?? "积分",
  }
  balanceCache.set(accessToken, { points, at: Date.now() })
  return points
}

function pointsText(points) {
  if (!points) return ""
  return `${points.total} 积分`
}

function writeBalanceCache(points) {
  try {
    const value = points ? pointsText(points) : ""
    const detail = points
      ? {
          total: points.total,
          limited: points.limited,
          permanent: points.permanent,
          plan: points.plan,
          updatedAt: new Date().toISOString(),
        }
      : null
    writeFileSync(
      BALANCE_FILE,
      `window.__QUWORK_BALANCE__ = ${JSON.stringify(value)};\nwindow.__QUWORK_BALANCE_DETAIL__ = ${JSON.stringify(detail)};\n`,
      "utf8",
    )
  } catch {
    // The page is a convenience; a read-only folder must not break the provider.
  }
}

async function checkKey(key) {
  try {
    const res = await fetch(`${LLM_BASE}/models`, {
      headers: { authorization: `Bearer ${key}`, "x-qurwork-env": "prod", "x-qurwork-version": quworkVersion() },
    })
    if (res.ok) return { ok: true }
    const detail = (await res.text()).slice(0, 200)
    return { ok: false, error: `QuWork 返回 ${res.status}${detail ? `：${detail}` : ""}` }
  } catch (error) {
    return { ok: false, error: `连不上 QuWork：${error instanceof Error ? error.message : String(error)}` }
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > 1_000_000) {
        reject(new Error("请求体过大"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {})
      } catch {
        reject(new Error("请求格式无效"))
      }
    })
    req.on("error", reject)
  })
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(JSON.stringify(body))
}

async function startBrowserLogin() {
  const state = { result: null, closed: false }
  const secret = randomUUID()
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const prefix = `/${secret}`
    const host = req.headers.host ?? ""
    const origin = req.headers.origin
    if (req.method === "POST" && origin && origin !== `http://${host}`) {
      return sendJson(res, 403, { success: false, message: "forbidden" })
    }
    if (req.method === "GET" && url.pathname === `${prefix}/`) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      })
      res.end(LOGIN_PAGE)
      return
    }
    if (req.method === "POST" && url.pathname === `${prefix}/api/send-code`) {
      try {
        const body = await readJsonBody(req)
        const phone = String(body.phone ?? "").trim()
        const captcha = String(body.captcha ?? "").trim()
        if (!/^1[3-9]\d{9}$/.test(phone)) return sendJson(res, 400, { success: false, message: "手机号格式不正确" })
        if (!captcha) return sendJson(res, 400, { success: false, message: "缺少验证码参数" })
        const query = `?${new URLSearchParams({ aliyun_captcha: captcha }).toString()}`
        const upstream = await fetch(`${ACCOUNT_BASE}/api/sendVerifyCode${query}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", "x-qurwork-env": "prod", "x-qurwork-version": quworkVersion() },
          body: new URLSearchParams({ phone, type: "login" }).toString(),
        })
        const payload = await upstream.json().catch(() => ({ success: false, message: `QuWork 返回 ${upstream.status}` }))
        return sendJson(res, upstream.ok ? 200 : upstream.status, payload)
      } catch (error) {
        return sendJson(res, 500, { success: false, message: error instanceof Error ? error.message : String(error) })
      }
    }
    if (req.method === "POST" && url.pathname === `${prefix}/api/login`) {
      try {
        const body = await readJsonBody(req)
        const phone = String(body.phone ?? "").trim()
        const code = String(body.code ?? "").trim()
        if (!/^1[3-9]\d{9}$/.test(phone)) return sendJson(res, 400, { success: false, message: "手机号格式不正确" })
        if (!/^\d{4,6}$/.test(code)) return sendJson(res, 400, { success: false, message: "验证码格式不正确" })
        const upstream = await fetch(`${ACCOUNT_BASE}/api/user/client/login`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-qurwork-env": "prod", "x-qurwork-version": quworkVersion() },
          body: JSON.stringify({
            phone,
            verification_code: code,
            platform: "qurvis",
            device_identifier: deviceIdentifier(),
            device_uuid: "",
          }),
        })
        const payload = await upstream.json().catch(() => ({ success: false, message: `QuWork 返回 ${upstream.status}` }))
        if (upstream.ok && payload?.success && payload?.data?.token) {
          state.result = {
            key: String(payload.data.llm_token ?? "").trim() || String(payload.data.token ?? "").trim(),
            accessToken: String(payload.data.token ?? "").trim(),
            user: payload.data.user ?? null,
          }
          return sendJson(res, 200, { success: true })
        }
        return sendJson(res, upstream.ok ? 200 : upstream.status, payload)
      } catch (error) {
        return sendJson(res, 500, { success: false, message: error instanceof Error ? error.message : String(error) })
      }
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
    res.end("not found")
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })

  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}/${secret}/`,
    state,
    close() {
      state.closed = true
      try {
        server.close()
      } catch {
        // already closed
      }
    },
  }
}

async function waitForBrowserLogin(session, timeoutMs = 10 * 60_000) {
  const startedAt = Date.now()
  try {
    while (!session.state.closed && Date.now() - startedAt < timeoutMs) {
      if (session.state.result) return session.state.result
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    return null
  } finally {
    session.close()
  }
}

export const QuWorkProvider = async () => ({
  config: async (cfg) => {
    cfg.provider ??= {}
    cfg.provider[PROVIDER] ??= {
      name: "QuWork",
      npm: "@ai-sdk/openai-compatible",
      api: LLM_BASE,
      models: Object.fromEntries(MODELS.map((model) => [model.id, model])),
    }
  },

  auth: {
    provider: PROVIDER,
    methods: [
      {
        type: "oauth",
        label: "浏览器登录 QuWork（手机验证码，无需客户端）",
        async authorize(_inputs, options = {}) {
          const session = await startBrowserLogin()
          if (options.signal) options.signal.addEventListener("abort", () => session.close(), { once: true })
          return {
            url: session.url,
            instructions: "在打开的页面里输入手机号，完成阿里云验证码后获取短信验证码，再点「登录并接入 magpie」。",
            method: "auto",
            close: () => session.close(),
            async callback() {
              const result = await waitForBrowserLogin(session)
              if (!result?.key) return { type: "failed", error: "登录超时或未完成，请重试。" }
              const checked = await checkKey(result.key)
              if (!checked.ok) return { type: "failed", error: checked.error }
              return {
                type: "success",
                key: result.key,
                metadata: { source: "browser", accessToken: result.accessToken, user: result.user },
              }
            },
          }
        },
      },
      {
        type: "api",
        label: "读取 QuWork 本机登录态",
        async authorize() {
          const found = await findLocalToken()
          if (!found.key) {
            return { type: "failed", error: "没有找到 QuWork 登录态：先用上面的「浏览器登录」，或在下一个方法里粘贴 sk- 令牌。" }
          }
          const checked = await checkKey(found.key)
          if (!checked.ok) return { type: "failed", error: checked.error }
          return { type: "success", key: found.key, metadata: { source: found.source } }
        },
      },
      {
        type: "api",
        label: "粘贴 QuWork 令牌",
        placeholder: "sk-…",
        async authorize(inputs) {
          const key = String(inputs?.key ?? inputs?.apiKey ?? inputs?.api_key ?? inputs?.value ?? "").trim()
          if (!key) return { type: "failed", error: "没有收到令牌。请在输入框里粘贴 sk-…；或使用「浏览器登录 QuWork」。" }
          const checked = await checkKey(key)
          if (!checked.ok) return { type: "failed", error: checked.error }
          return { type: "success", key, metadata: { source: "pasted" } }
        },
      },
    ],
    async loader(getAuth) {
      const auth = await getAuth()
      if (!auth) return {}
      const key = auth.type === "api" ? auth.key : auth.access
      if (!key) return {}
      return {
        baseURL: LLM_BASE,
        async fetch(input, init) {
          const headers = new Headers(init?.headers)
          headers.set("authorization", `Bearer ${key}`)
          headers.set("x-qurwork-env", "prod")
          headers.set("x-qurwork-version", quworkVersion())
          return fetch(input, { ...init, headers })
        },
      }
    },
    async usage(getAuth) {
      const auth = await getAuth()
      if (!auth) return { error: "QuWork 未登录", windows: [] }
      try {
        const accessToken = auth?.metadata?.accessToken || (await findAccessToken())
        if (!accessToken) return { error: "没有 QuWork 账号令牌；用「浏览器登录 QuWork」重新登录后就能显示积分。", windows: [] }
        const points = await readPoints(accessToken)
        if (!points) return { error: "QuWork 积分接口没有返回可用数据。", windows: [] }
        writeBalanceCache(points)
        const suffix = points.limited > 0 ? `（限时 ${points.limited} + 永久 ${points.permanent}）` : ""
        return {
          plan: points.plan,
          balance: `${pointsText(points)}${suffix}`,
          windows: [],
        }
      } catch (error) {
        if (error?.signIn === "expired") {
          return { error: error.message, signIn: "expired", windows: [] }
        }
        return { error: `读 QuWork 余额失败：${error instanceof Error ? error.message : String(error)}`, windows: [] }
      }
    },
  },

  provider: {
    id: PROVIDER,
    async models(provider, { auth } = {}) {
      try {
        const accessToken = auth?.metadata?.accessToken || (await findAccessToken())
        const points = await readPoints(accessToken)
        if (points) writeBalanceCache(points)
      } catch (error) {
        if (error?.signIn === "expired") throw error
        // Balance display is best-effort.
      }
      return provider.models
    },
  },
})

export const _internal = {
  MODELS,
  PLUGIN_DIR,
  startBrowserLogin,
  readPoints,
  writeBalanceCache,
  deviceIdentifier,
  quworkVersion,
}
