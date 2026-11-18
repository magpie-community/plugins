import { createServer } from "node:http"
import { createHash, randomUUID } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const PROVIDER = "quwork"
const LLM_BASE = "https://llm.quwork.cn/v1"
const ACCOUNT_BASE = "https://llm.rrzu.com"
const FALLBACK_VERSION = "1.7.5"
const CAPTCHA_SDK = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"
const CAPTCHA_REGION = "cn"
const CAPTCHA_PREFIX = "1hms8d"
const CAPTCHA_SCENE_ID = "10vzkucv"
const DEVICE_FILE = join(tmpdir(), "magpie-quwork-device.json")
const BALANCE_TTL_MS = 60_000
const LOGIN_TTL_MS = 10 * 60_000
const UPSTREAM_TIMEOUT_MS = 15_000
const RESEND_COOLDOWN_MS = 60_000
const MAX_LOGIN_ATTEMPTS = 5

const CLIENT_HEADERS = { "x-qurwork-env": "prod", "x-qurwork-version": FALLBACK_VERSION }

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
  <p class="sub">在此本机页面用手机号和短信验证码接入 Magpie。请只登录本人获授权使用的账号。</p>
  <p class="tip">实验性社区接入，使用非公开接口。QuWork 可能限制或暂停账号服务。重要账号建议使用官方入口。<a href="https://llm.rrzu.com/claw-agreement" target="_blank" rel="noopener noreferrer">查看服务协议</a></p>
  <label for="phone">手机号</label>
  <input id="phone" inputmode="numeric" autocomplete="tel-national" maxlength="11" placeholder="11 位手机号，例如 13800000000" />
  <div id="captcha-box"></div>
  <button id="captcha-button" style="display:none" tabindex="-1" aria-hidden="true"></button>
  <button id="send" class="ghost">发送验证码</button>
  <label for="code">短信验证码</label>
  <input id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="输入收到的验证码" maxlength="6" />
  <button id="login">登录并接入 magpie</button>
  <div id="msg" role="status" aria-live="polite"></div>
  <div class="tip">请在浏览器中手动完成阿里云人机验证。有 QuWork 明确授权用于第三方接入的模型密钥时，可在 Magpie 中单独填写。</div>
</main>
<script>
  window.AliyunCaptchaConfig = { region: "${CAPTCHA_REGION}", prefix: "${CAPTCHA_PREFIX}" }
</script>
<script src="${CAPTCHA_SDK}"></script>
<script>
  const $ = (id) => document.getElementById(id)
  const msg = (text, cls) => { $("msg").textContent = text || ""; $("msg").className = cls || "" }
  let captcha = ""
  let cooldown = 0
  let timer = null
  let busy = false
  let accepted = false

  function setBusy(next) {
    busy = next
    $("send").disabled = accepted || busy || cooldown > 0
    $("login").disabled = accepted || busy
  }

  function tick() {
    const seconds = Math.max(0, Math.ceil((cooldown - Date.now()) / 1000))
    $("send").textContent = seconds ? seconds + " 秒后可重发" : "发送验证码"
    if (!seconds) {
      clearInterval(timer)
      timer = null
      cooldown = 0
    }
    setBusy(busy)
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
      cooldown = Date.now() + 60000
      timer = setInterval(tick, 1000)
      tick()
    } catch {
      msg("本机登录页面连接中断。请回到 Magpie 检查登录状态。", "err")
    } finally {
      captcha = ""
      try { window.__captchaInstance?.refresh?.() } catch {}
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
      msg("短信验证已通过。请回到 Magpie 确认供应商登录状态。", "ok")
      accepted = true
      $("phone").disabled = true
      $("code").disabled = true
      $("phone").value = ""
      $("code").value = ""
    } catch {
      msg("本机登录页面连接中断。请回到 Magpie 检查登录状态。", "err")
    } finally {
      setBusy(false)
    }
  }

  $("send").addEventListener("click", () => {
    const phone = $("phone").value.trim()
    if (!/^1[3-9]\\d{9}$/.test(phone)) { msg("请输入正确的 11 位手机号", "err"); return }
    if (captcha) { sendCode(); return }
    if (typeof window.initAliyunCaptcha !== "function") { msg("验证码组件加载失败，请关闭本页并使用 QuWork 官方入口", "err"); return }
    if (typeof window.__captchaInstance?.show === "function") { window.__captchaInstance.show(); return }
    msg("验证码组件还在加载，请稍候再点一次", "err")
  })
  $("login").addEventListener("click", login)

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

function authKey(auth) {
  const key = auth?.type === "api" ? auth.key : auth?.access
  return typeof key === "string" && /^sk-[A-Za-z0-9_-]{1,512}$/.test(key.trim()) ? key.trim() : ""
}

function deviceIdentifier() {
  try {
    const data = JSON.parse(readFileSync(DEVICE_FILE, "utf8"))
    if (typeof data?.deviceId === "string" && data.deviceId) return data.deviceId
  } catch {}
  const deviceId = randomUUID()
  try {
    writeFileSync(DEVICE_FILE, JSON.stringify({ deviceId }), { encoding: "utf8", mode: 0o600 })
  } catch {
    // A read-only temp folder is fine; the id is then only stable for this process.
  }
  return deviceId
}

function pointsNumber(value) {
  if (typeof value !== "number" && !(typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim()))) return null
  const amount = Number(value)
  return Number.isFinite(amount) && amount >= 0 ? amount : null
}

function usageError(error, signIn = "kept") {
  return { error, signIn, windows: [] }
}

async function fetchUsage(accessToken, fetchImpl) {
  try {
    const response = await fetchImpl(`${ACCOUNT_BASE}/api/user/self`, {
      headers: { ...CLIENT_HEADERS, authorization: `Bearer ${accessToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      if (response.status === 401) return usageError("QuWork 余额凭据已失效，请重新登录后查看积分。", "expired")
      if (response.status === 403) return usageError("QuWork 拒绝查询积分，请在官方入口核对账号状态。")
      if (response.status === 429) return usageError("QuWork 限制了积分查询，请稍后查看。")
      return usageError(`暂时无法查询 QuWork 积分（HTTP ${response.status}）。`)
    }
    const payload = await response.json()
    const entitlement = payload?.data?.points_entitlement
    const total = pointsNumber(entitlement?.total_points)
    if (payload?.success !== true || total === null) return usageError("QuWork 未返回有效的积分余额。")
    const limited = pointsNumber(entitlement.limited_points)
    const permanent = pointsNumber(entitlement.permanent_points)
    const plan = entitlement.active_subscription?.plan_name
    const parts = []
    if (limited !== null) parts.push(`限时 ${limited}`)
    if (permanent !== null) parts.push(`永久 ${permanent}`)
    const detail = parts.length ? `（${parts.join(" · ")}）` : ""
    return { plan: typeof plan === "string" && plan.trim() ? plan.trim() : "积分", balance: `${total} 积分${detail}`, windows: [] }
  } catch {
    return usageError("暂时无法读取 QuWork 积分，请稍后查看。")
  }
}

async function checkKey(key, fetchImpl, signal) {
  try {
    const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    const response = await fetchImpl(`${LLM_BASE}/models`, {
      headers: { ...CLIENT_HEADERS, authorization: `Bearer ${key}` },
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    await response.body?.cancel().catch(() => {})
    return response.ok ? null : `QuWork 未接受模型密钥（HTTP ${response.status}）。`
  } catch {
    return signal?.aborted ? "QuWork 登录已取消。" : "连接 QuWork 模型服务失败，请稍后查看。"
  }
}

async function readJsonBody(request) {
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > 16 * 1024) throw new Error("请求体过大")
    chunks.push(chunk)
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("请求格式无效")
  return body
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  })
  res.end(JSON.stringify(body))
}

async function startBrowserLogin(fetchImpl, getDeviceIdentifier, signal) {
  signal?.throwIfAborted()
  const controller = new AbortController()
  const prefix = `/${randomUUID()}/`
  const sendPath = `${prefix}api/send-code`
  const loginPath = `${prefix}api/login`
  let port = 0
  let busy = false
  let accepted = false
  let sentTo = ""
  let nextSendAt = 0
  let loginAttempts = 0
  let finish
  const result = new Promise((resolve) => { finish = resolve })
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, async (req, res) => {
    const host = `127.0.0.1:${port}`
    const fail = (status, message) => sendJson(res, status, { success: false, message })
    if (req.headers.host !== host) return fail(403, "请求来源无效")
    if (req.method === "GET" && req.url === prefix) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "content-security-policy": "frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
      })
      res.end(LOGIN_PAGE)
      return
    }
    if (req.method !== "POST" || (req.url !== sendPath && req.url !== loginPath)) return fail(404, "登录页面不存在")
    const contentType = req.headers["content-type"]?.split(";")[0].trim().toLowerCase()
    if (req.headers.origin !== `http://${host}` || contentType !== "application/json") return fail(403, "请求来源无效")
    if (accepted || controller.signal.aborted) return fail(410, "登录页面已关闭")
    if (busy) return fail(409, "上一请求仍在处理")

    busy = true
    try {
      const body = await readJsonBody(req).catch(() => null)
      if (!body) return fail(400, "请求格式无效")
      const phone = typeof body.phone === "string" ? body.phone.trim() : ""
      if (!/^1[3-9]\d{9}$/.test(phone)) return fail(400, "手机号格式不正确")
      const upstreamSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)])
      if (req.url === sendPath) {
        if (Date.now() < nextSendAt) return fail(429, `请 ${Math.ceil((nextSendAt - Date.now()) / 1000)} 秒后再发送`)
        const captcha = typeof body.captcha === "string" ? body.captcha.trim() : ""
        if (!captcha) return fail(400, "请先完成人机验证")
        const query = new URLSearchParams({ aliyun_captcha: captcha })
        nextSendAt = Date.now() + RESEND_COOLDOWN_MS
        const response = await fetchImpl(`${ACCOUNT_BASE}/api/sendVerifyCode?${query}`, {
          method: "POST",
          headers: { ...CLIENT_HEADERS, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ phone, type: "login" }),
          redirect: "error",
          signal: upstreamSignal,
        })
        const payload = await response.json().catch(() => null)
        if (response.ok && payload?.success === true) {
          sentTo = phone
          return sendJson(res, 200, { success: true })
        }
        return fail(response.status === 429 ? 429 : 400, "QuWork 未发送验证码。请稍后再试或到官方入口核对账号状态。")
      }
      const code = typeof body.code === "string" ? body.code.trim() : ""
      if (phone !== sentTo || !/^\d{4,6}$/.test(code)) return fail(400, "请先为该手机号获取并填写短信验证码")
      if (loginAttempts >= MAX_LOGIN_ATTEMPTS) return fail(429, "本次登录尝试次数已用完。请到 QuWork 官方入口核对账号状态。")
      loginAttempts += 1
      const response = await fetchImpl(`${ACCOUNT_BASE}/api/user/client/login`, {
        method: "POST",
        headers: { ...CLIENT_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({
          phone,
          verification_code: code,
          platform: "qurvis",
          device_identifier: getDeviceIdentifier(),
          device_uuid: "",
        }),
        redirect: "error",
        signal: upstreamSignal,
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.success !== true) {
        if (response.status === 403 || response.status === 429) loginAttempts = MAX_LOGIN_ATTEMPTS
        return fail(response.status === 429 ? 429 : 400, "QuWork 未接受登录。请检查验证码或到官方入口核对账号状态。")
      }
      const key = authKey({ type: "api", key: payload.data?.llm_token })
      const accessToken = payload.data?.token
      if (!key || typeof accessToken !== "string" || !accessToken.trim()) return fail(502, "QuWork 未返回完整的登录凭据")
      if (controller.signal.aborted) return fail(410, "登录页面已关闭")
      accepted = true
      sendJson(res, 200, { success: true })
      finish({ key, accessToken: accessToken.trim() })
    } catch {
      if (!res.destroyed) fail(502, "连接 QuWork 失败，请稍后查看。")
    } finally {
      busy = false
    }
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  port = server.address().port
  const timer = setTimeout(close, LOGIN_TTL_MS)
  function close() {
    if (controller.signal.aborted) return
    clearTimeout(timer)
    signal?.removeEventListener("abort", close)
    controller.abort()
    server.close()
    finish(null)
  }
  if (signal?.aborted) close()
  else signal?.addEventListener("abort", close, { once: true })
  return { url: `http://127.0.0.1:${port}${prefix}`, result, close }
}

function createPlugin({ fetchImpl = globalThis.fetch, getDeviceIdentifier = deviceIdentifier } = {}) {
  const balanceCache = new Map()
  return {
    async config(config) {
      config.provider ??= {}
      config.provider[PROVIDER] ??= {
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
          label: "浏览器登录 QuWork（实验性）",
          async authorize(_inputs, { signal } = {}) {
            const session = await startBrowserLogin(fetchImpl, getDeviceIdentifier, signal)
            return {
              url: session.url,
              instructions: "在本机浏览器阅读风险提示，手动完成人机验证和短信验证。",
              method: "auto",
              close: session.close,
              async callback(_code, { signal: callbackSignal } = {}) {
                const callbackAbort = callbackSignal ?? signal
                if (callbackAbort?.aborted) session.close()
                else callbackAbort?.addEventListener("abort", session.close, { once: true })
                try {
                  const credentials = await session.result
                  if (!credentials || callbackAbort?.aborted) return { type: "failed", error: "QuWork 登录已取消或超时。" }
                  const error = await checkKey(credentials.key, fetchImpl, callbackAbort)
                  if (error) return { type: "failed", error }
                  return {
                    type: "success",
                    key: credentials.key,
                    metadata: { source: "browser", accessToken: credentials.accessToken },
                  }
                } finally {
                  callbackAbort?.removeEventListener("abort", session.close)
                  session.close()
                }
              },
            }
          },
        },
        {
          type: "api",
          label: "填写已获授权的 QuWork 模型密钥",
          placeholder: "sk-…",
          async authorize(inputs, { signal } = {}) {
            const key = authKey({ type: "api", key: inputs?.key ?? inputs?.apiKey ?? inputs?.api_key ?? inputs?.value })
            if (!key) return { type: "failed", error: "请填写 QuWork 授权用于第三方接入的模型密钥。" }
            const error = await checkKey(key, fetchImpl, signal)
            if (error) return { type: "failed", error }
            return { type: "success", key, metadata: { source: "pasted" } }
          },
        },
      ],
      async loader(getAuth) {
        if (!authKey(await getAuth())) return {}
        return {
          baseURL: LLM_BASE,
          apiKey: PROVIDER,
          async fetch(input, init) {
            const isRequest = input instanceof Request
            const target = new URL(isRequest ? input.url : String(input))
            if (!target.href.startsWith(`${LLM_BASE}/`)) {
              throw new Error("QuWork 模型密钥仅用于 QuWork 模型网关。")
            }
            const key = authKey(await getAuth())
            if (!key) throw new Error("请在 Magpie 中登录 QuWork。")
            const headers = new Headers(init?.headers ?? (isRequest ? input.headers : undefined))
            headers.set("authorization", `Bearer ${key}`)
            for (const [name, value] of Object.entries(CLIENT_HEADERS)) headers.set(name, value)
            return fetchImpl(isRequest ? input : target.href, { ...init, headers, redirect: "error" })
          },
        }
      },
      async usage(getAuth) {
        const auth = await getAuth()
        if (!authKey(auth)) return usageError("请先在 Magpie 中登录 QuWork。")
        const accessToken = auth.metadata?.source === "browser" ? auth.metadata.accessToken : null
        if (typeof accessToken !== "string" || !accessToken.trim()) {
          return usageError("当前仅有模型密钥。积分查询需要浏览器登录获得的账号凭据。")
        }
        const now = Date.now()
        for (const [cacheKey, entry] of balanceCache) {
          if (entry.until <= now) balanceCache.delete(cacheKey)
        }
        const cacheKey = createHash("sha256").update(accessToken).digest("hex")
        const cached = balanceCache.get(cacheKey)
        if (cached) return cached.result
        const entry = { until: Infinity, result: null }
        entry.result = fetchUsage(accessToken, fetchImpl).finally(() => {
          entry.until = Date.now() + BALANCE_TTL_MS
        })
        balanceCache.set(cacheKey, entry)
        return entry.result
      },
    },
  }
}

export const QuWorkProvider = async () => createPlugin()
export const _internal = { createPlugin }
