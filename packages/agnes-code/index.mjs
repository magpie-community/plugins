// Agnes Code（Agnes 桌面端 / 控制台）for OpenCode and magpie —— 双端版。
//
// 相对原版（0.1.2，仅国际站）新增两件事：
//
//   ① 一域一个 provider id：agnes-code（国际站 .com）/ agnes-code-cn（国内站 .cn）。
//      两站的账号体系与 BFF 都不互通：国内站 token 打国际站一律 401，所以不做
//      「按账号猜域名」，而是让账号天生落在自己那一端。
//
//   ② 浏览器 loopback 登录（协议取自 dsh-connect-agnes-token-plan 的实测，三平台可用，
//      不再依赖 Windows 与桌面端）：
//
//        打开  {loginUrl}?client=agnes-code&redirect_uri=http://127.0.0.1:<port>/auth/callback&state=<uuid>
//        页面  POST {code,state} 回本地（跨域，OPTIONS 预检必须回 CORS 头；GET query 兜底）
//        换票  POST {bffBase}/api/v1/code/auth/exchange-code
//              headers: origin=<登录页 origin>、x-platform: 1、content-type: json
//              body:    {code, redirect_uri, state, client_id:"agnes-code"}
//              成功 = body.code 为 "000000" 或 "0"，token 在 data.access_token
//
// 桌面端会话（Windows DPAPI）保留，但会把会话里的 bffPublicBaseUrl 读出来并钉死域名：
// 原版丢掉了这个字段，于是国内站桌面端的 token 被拿去打 .com，必然失败。
//
// 云端（与桌面端同源同凭据）：
//   模型调用  POST {bffBase}/v1/chat/completions（OpenAI chat 协议，Bearer accessToken）
//   模型目录  GET  {bffBase}/v1/models
//   积分余额  GET  {bffBase}/api/v2/subscription/credits-balance（旧版打的是 api 域，兜底保留）

import { spawn } from "node:child_process"
import { createDecipheriv, randomUUID } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { createServer } from "node:http"
import { homedir as osHomedir } from "node:os"
import { join } from "node:path"

// 两端站点定义。bffBase 是 Agnes Code 自己的后端源站（不是控制台前端 agnes-ai.com），
// 登录页 origin 用于换票时的 origin 头与回调的 CORS 应答。
export const SITES = {
  intl: {
    domain: "intl",
    id: "agnes-code",
    label: "Agnes Code · 国际站",
    short: "国际站",
    bffBase: "https://api-agnes-code.agnes-ai.com",
    apiBase: "https://api.agnes-ai.com",
    loginUrl: "https://app.agnes-ai.com/login",
    origin: "https://app.agnes-ai.com",
    hostSuffix: ".agnes-ai.com",
    // 不要用营销页 agnes-ai.com/agnescode：那个域被 Defender SmartScreen 举报过，会直接红屏拦下。
    officialSite: "https://app.agnes-ai.com",
    loginHint: "国际站只有 Google / Apple 登录，没有微信扫码",
  },
  cn: {
    domain: "cn",
    id: "agnes-code-cn",
    label: "Agnes Code · 国内站",
    short: "国内站",
    bffBase: "https://api-agnes-code.agnes-ai.cn",
    apiBase: "https://api.agnes-ai.cn",
    loginUrl: "https://app.agnes-ai.cn/login",
    origin: "https://app.agnes-ai.cn",
    hostSuffix: ".agnes-ai.cn",
    officialSite: "https://app.agnes-ai.cn",
    loginHint: "国内站支持微信扫码；根路径偶发 403 维护页，看到就稍后再试",
  },
}

const CLIENT_ID = "agnes-code"
const CB_PATH = "/auth/callback"
// 等用户在浏览器里登完的上限。magpie 自己的 signInTimeout 可能更短，超时文案要能重试。
const LOGIN_WAIT_MS = 3 * 60 * 1000
// 换票请求本身的上限：别让一个挂住的请求把整个登录卡死。
const EXCHANGE_TIMEOUT_MS = 30 * 1000
const DESKTOP_POLL_MS = 2000
const DESKTOP_WAIT_MS = 5 * 60 * 1000
const DPAPI_TIMEOUT_MS = 15000
const BALANCE_PATH = "/api/v2/subscription/credits-balance"
// 桌面端会话文件名按端区分：code-auth-session.v1（国际站）/ code-auth-session.cn.v1（国内站，
// 实测 657 字节，2026-10-31 写）。只认这一族，别的文件不碰。
const SESSION_FILE_PATTERN = /^code-auth-session(\.\w+)?\.v1$/

// 模型目录读不到时的启动表（沿用原版 2026-11-01 的实测快照；models 钩子会用实时目录覆盖）。
const BOOTSTRAP = [
  { id: "agnes-3.0-flash", context: 512000, output: 65536, thinking: true },
  { id: "agnes-2.5-flash", context: 512000, output: 65536, thinking: true },
  { id: "agnes-2.5-pro", context: 512000, output: 65536, thinking: true },
  { id: "gpt-6.1-sol", context: 1000000, output: 131072, thinking: false },
  { id: "gpt-6-astra", context: 1000000, output: 131072, thinking: false },
  { id: "grok-4.7", context: 500000, output: 128000, thinking: false },
  { id: "claude-opus-5-5", context: 1000000, output: 128000, thinking: false },
  { id: "deepseek-v4.1-flash", context: 1000000, output: 393216, thinking: true },
  { id: "deepseek-v4-pro", context: 1000000, output: 393216, thinking: true },
  { id: "glm-5.3", context: 1000000, output: 131072, thinking: false },
  { id: "kimi-k3", context: 1048576, output: 131072, thinking: false },
]

function chatBase(site) {
  return `${site.bffBase}/v1`
}

function modelsUrl(site) {
  return `${site.bffBase}/v1/models`
}

// 余额端点候选：{bffBase} 是逆向实测的那条；api 域是原版用的那条，留作兜底。
function balanceUrls(site) {
  return [`${site.bffBase}${BALANCE_PATH}`, `${site.apiBase}${BALANCE_PATH}`]
}

// trustBase 把会话里的 bffPublicBaseUrl 钉死到该站的 https 源站：任意 https + 该站域名后缀
// + 不带端口。返回规范化 origin，不合法返回 null（宁可不认，也不把 token 送去别处）。
function trustBase(value, site) {
  if (typeof value !== "string" || !value.trim()) return null
  let url
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.protocol !== "https:") return null
  if (url.port) return null
  if (url.username || url.password) return null
  if (!url.hostname.endsWith(site.hostSuffix) || url.hostname.length <= site.hostSuffix.length) return null
  return url.origin
}

// siteOfBase 用同一套钉死规则判断一份 base 属于哪一端；两端都不认就返回 null。
function siteOfBase(value, sites = SITES) {
  for (const site of Object.values(sites)) {
    if (trustBase(value, site) !== null) return site
  }
  return null
}

function rowFromCatalogEntry(m) {
  const thinking = !!m?.thinking_toggle
  return {
    id: m.id,
    name: m.id,
    limit: {
      context: typeof m?.max_input_tokens === "number" && m.max_input_tokens > 0 ? m.max_input_tokens : 0,
      output: typeof m?.max_output_tokens === "number" && m.max_output_tokens > 0 ? m.max_output_tokens : 0,
    },
    reasoning: thinking,
    tool_call: true,
    modalities: { input: ["text"], output: ["text"] },
    capabilities: {
      reasoning: thinking,
      toolcall: true,
      attachment: false,
      input: { text: true, image: false },
      output: { text: true },
    },
  }
}

function bootstrapRows() {
  return Object.fromEntries(
    BOOTSTRAP.map((m) => [
      m.id,
      {
        id: m.id,
        name: m.id,
        limit: { context: m.context, output: m.output },
        reasoning: m.thinking,
        tool_call: true,
        modalities: { input: ["text"], output: ["text"] },
        capabilities: {
          reasoning: m.thinking,
          toolcall: true,
          attachment: false,
          input: { text: true, image: false },
          output: { text: true },
        },
      },
    ]),
  )
}

// --- 桌面端会话（Windows DPAPI） -------------------------------------------------

function parseEncryptedKey(b64) {
  const blob = Buffer.from(b64, "base64")
  if (blob.subarray(0, 5).toString("latin1") !== "DPAPI") {
    throw new Error("Local State 的 encrypted_key 不是 DPAPI 形态")
  }
  return blob.subarray(5)
}

function decryptSessionWithKey(keyBuf, rawBuf) {
  if (rawBuf.subarray(0, 3).toString("latin1") !== "v10") {
    throw new Error("会话文件不是 v10 safeStorage 形态")
  }
  const nonce = rawBuf.subarray(3, 15)
  const tagged = rawBuf.subarray(15)
  if (tagged.length < 28) throw new Error("会话文件内容太短")
  const decipher = createDecipheriv("aes-256-gcm", keyBuf, nonce)
  decipher.setAuthTag(tagged.subarray(tagged.length - 16))
  const plain = Buffer.concat([decipher.update(tagged.subarray(0, tagged.length - 16)), decipher.final()])
  return JSON.parse(plain.toString("utf8"))
}

async function dpapiUnprotect(blob, spawnImpl = spawn, { timeoutMs = DPAPI_TIMEOUT_MS, platform = process.platform } = {}) {
  if (platform !== "win32") {
    throw new Error("桌面端会话解密目前仅支持 Windows；请改用「浏览器登录」或「粘贴 accessToken」")
  }
  const b64 = blob.toString("base64")
  const result = await new Promise((resolve, reject) => {
    const child = spawnImpl(
      "powershell",
      ["-NoProfile", "-Command", `Add-Type -AssemblyName System.Security; $k=[Convert]::FromBase64String('${b64}'); [Console]::Out.Write([Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect($k, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)))`],
      { windowsHide: true },
    )
    let out = ""
    let settled = false
    const finish = (settle, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      settle(value)
    }
    const timer = setTimeout(() => {
      finish(reject, new Error(`DPAPI 解密超时（PowerShell 超过 ${Math.round(timeoutMs / 1000)}s 没有响应）`))
      try {
        child.kill()
      } catch {}
    }, timeoutMs)
    child.stdout.on("data", (chunk) => (out += chunk))
    child.on("error", (error) => finish(reject, error))
    child.on("close", (code) => finish(code === 0 ? resolve : reject, code === 0 ? out.trim() : new Error(`DPAPI 解密失败（exit ${code}）`)))
  })
  const key = Buffer.from(result, "base64")
  if (key.length !== 32) throw new Error("DPAPI 解出的主密钥长度异常")
  return key
}

function decodeJwtPayload(token) {
  if (typeof token !== "string") return null
  const payload = token.split(".")[1]
  if (!payload) return null
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  } catch {
    return null
  }
}

function isExpiredJwt(token, nowMs = Date.now()) {
  const claims = decodeJwtPayload(token)
  return !!claims && typeof claims.exp === "number" && claims.exp * 1000 < nowMs
}

// readDesktopCredential 解出桌面端登录态，并读出会话自己的 bffPublicBaseUrl。
// site 传入时，会话属于另一端会明确报错，而不是拿着 token 去打错的域名。
async function readDesktopCredential({ site, homedir = osHomedir(), platform = process.platform, env = process.env, readFileImpl, readDirImpl, dpapiImpl, nowMs, keyCache } = {}) {
  if (platform !== "win32") {
    throw new Error("桌面端会话解密目前仅支持 Windows；请改用「浏览器登录」或「粘贴 accessToken」")
  }
  const readFile = readFileImpl ?? ((path) => readFileSync(path))
  const readDir = readDirImpl ?? ((path) => readdirSync(path))
  const dataDirs = [join(env.APPDATA ?? join(homedir, "AppData", "Roaming"), "AgnesCode")]

  const problems = []
  let sawOtherSite = null
  for (const dir of dataDirs) {
    const statePath = join(dir, "Local State")
    let keyBlob
    try {
      const state = JSON.parse(readFile(statePath).toString("utf8"))
      keyBlob = parseEncryptedKey(state?.os_crypt?.encrypted_key ?? "")
    } catch (error) {
      if (error?.code !== "ENOENT") problems.push(`${dir}（${error?.message ?? "读取失败"}）`)
      continue
    }

    let sessionNames
    try {
      sessionNames = readDir(dir).filter((name) => SESSION_FILE_PATTERN.test(name))
    } catch (error) {
      problems.push(`${dir}（列目录失败：${error?.message ?? "未知"}）`)
      continue
    }
    if (!sessionNames.length) continue
    // 站点专属文件优先，其次无后缀的（国际站），最后是别的端的。
    const rank = (name) => (site && name === `code-auth-session.${site.domain}.v1` ? 0 : name === "code-auth-session.v1" ? 1 : 2)
    sessionNames.sort((left, right) => rank(left) - rank(right) || left.localeCompare(right))

    let key = keyCache?.get(statePath)
    if (!key) {
      try {
        const dpapi = dpapiImpl ?? ((blob) => dpapiUnprotect(blob))
        key = await dpapi(keyBlob)
        keyCache?.set(statePath, key)
      } catch (error) {
        problems.push(`${dir}（解密失败：${error?.message ?? "未知"}）`)
        continue
      }
    }

    for (const name of sessionNames) {
      const sessionPath = join(dir, name)
      let raw
      try {
        raw = readFile(sessionPath)
      } catch (error) {
        if (error?.code !== "ENOENT") problems.push(`${dir}\\${name}（${error?.message ?? "读取失败"}）`)
        continue
      }
      let session
      try {
        session = decryptSessionWithKey(key, raw)
      } catch (error) {
        keyCache?.delete(statePath)
        problems.push(`${dir}\\${name}（解密失败：${error?.message ?? "未知"}）`)
        key = null
        break
      }
      if (typeof session?.accessToken !== "string" || !session.accessToken.trim()) {
        problems.push(`${dir}\\${name}（会话里没有 accessToken）`)
        continue
      }
      if (isExpiredJwt(session.accessToken, nowMs)) {
        throw Object.assign(new Error("Agnes Code 登录已过期，请打开 Agnes Code 重新登录后重试"), { code: "expired" })
      }

      // 会话自带 BFF 源站：判断账号属于哪一端最可靠的信号；老会话没写这个字段时，
      // 退回文件名里的端标记（code-auth-session.cn.v1 是桌面端自己写的，同等可信）。
      const rawBase = typeof session.bffPublicBaseUrl === "string" ? session.bffPublicBaseUrl : ""
      const sessionSite = rawBase ? siteOfBase(rawBase) : name === "code-auth-session.cn.v1" ? SITES.cn : null
      if (rawBase && !sessionSite) {
        throw Object.assign(new Error(`桌面端会话里的 bffPublicBaseUrl 不在信任范围（${rawBase}），已拒绝使用这份凭据`), { code: "untrusted" })
      }
      if (site && sessionSite && sessionSite.domain !== site.domain) {
        sawOtherSite = sessionSite
        continue
      }

      const bffBase = sessionSite ? sessionSite.bffBase : site ? site.bffBase : SITES.intl.bffBase

      const username = typeof session.userInfo?.username === "string" && session.userInfo.username.trim()
        ? session.userInfo.username.trim()
        : undefined
      return { key: session.accessToken.trim(), accountId: username, username, source: sessionPath, bffBase, domain: sessionSite?.domain }
    }
  }

  if (sawOtherSite) {
    throw Object.assign(
      new Error(`本机 Agnes Code 登录的是${sawOtherSite.label}，请改用「${sawOtherSite.label}」的登录入口（两站账号不互通）`),
      { code: "domain_mismatch" },
    )
  }

  const detail = problems.length ? `：${problems.join("；")}` : ""
  const message = problems.length
    ? `Agnes Code 桌面端登录态读不出来${detail}。请先启动 Agnes Code 并登录，或改用「浏览器登录」。`
    : "未找到 Agnes Code 桌面端登录态。请先启动 Agnes Code 并登录，或改用「浏览器登录」。"
  throw Object.assign(new Error(message), { code: problems.length ? "unreadable" : "missing" })
}

// --- 浏览器 loopback 登录 -----------------------------------------------------

function listenLoopback(createServerImpl = createServer) {
  return new Promise((resolve, reject) => {
    const server = createServerImpl()
    const onError = (error) => reject(error)
    server.once("error", onError)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError)
      resolve(server)
    })
  })
}

function corsHeaders(origin) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "false",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type",
    "cache-control": "no-store",
  }
}

// waitForCallback 等登录页 POST {code,state} 回来。三件事不能少：
//   · OPTIONS 预检必须应答（否则浏览器的跨域 POST 在预检就被拒，界面表现为「扫码成功但一直转圈」）
//   · state 必须校验（否则任何页面都能往这个端口塞一个 code）
//   · 超时/取消都要关掉监听，别把随机端口留到进程结束
function waitForCallback(server, { state, origin, timeoutMs = LOGIN_WAIT_MS, signal } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (settle, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener?.("abort", onAbort)
      try {
        server.close()
      } catch {}
      settle(value)
    }
    const send = (res, status, body) => {
      res.writeHead(status, { "content-type": "application/json", ...corsHeaders(origin) })
      res.end(JSON.stringify(body))
    }
    const onAbort = () => finish(reject, new Error("登录已取消"))
    if (signal) {
      if (signal.aborted) return onAbort()
      signal.addEventListener?.("abort", onAbort, { once: true })
    }
    const timer = setTimeout(() => finish(reject, new Error(`等待浏览器登录超过 ${Math.round(timeoutMs / 1000)} 秒`)), timeoutMs)

    server.on("request", (req, res) => {
      if (req.method === "OPTIONS") return send(res, 204, { ok: true })
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      if (url.pathname !== CB_PATH) return send(res, 200, { ok: true })
      const accept = (code, gotState) => {
        if (gotState !== state) return send(res, 400, { ok: false, error: "bad state" })
        if (!code) return send(res, 400, { ok: false, error: "missing code" })
        send(res, 200, { ok: true })
        finish(resolve, code)
      }
      if (req.method === "POST") {
        let buf = ""
        req.on("data", (chunk) => (buf += String(chunk)))
        req.on("end", () => {
          let code = ""
          let gotState = ""
          try {
            const body = JSON.parse(buf || "{}")
            code = String(body?.code ?? "")
            gotState = String(body?.state ?? "")
          } catch {
            code = url.searchParams.get("code") ?? ""
            gotState = url.searchParams.get("state") ?? ""
          }
          accept(code, gotState)
        })
        return
      }
      accept(url.searchParams.get("code") ?? "", url.searchParams.get("state") ?? "")
    })
    server.on("error", (error) => finish(reject, error))
  })
}

async function exchangeCode(code, { redirectUri, state, site, fetchImpl = globalThis.fetch, timeoutMs = EXCHANGE_TIMEOUT_MS } = {}) {
  const url = `${site.bffBase}/api/v1/code/auth/exchange-code`
  const res = await fetchImpl(url, {
    method: "POST",
    // origin 头由 BFF 校验：不带它、或带成别站的 origin，换票都会被拒。
    headers: {
      "content-type": "application/json",
      origin: site.origin,
      "x-platform": "1",
    },
    body: JSON.stringify({ code, redirect_uri: redirectUri, state, client_id: CLIENT_ID }),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  })
  let body = {}
  try {
    body = await res.json()
  } catch {}
  const codeStr = String(body?.code ?? "")
  if (!res.ok || (codeStr !== "000000" && codeStr !== "0")) {
    const message = String(body?.message ?? "").trim()
    throw new Error(`授权码兑换失败：${message || `HTTP ${res.status} / code ${codeStr || "无"}`}`)
  }
  const token = String(body?.data?.access_token ?? "").trim()
  if (!token) throw new Error("授权码兑换没有返回 access_token")
  return token
}

// authResultFromToken 把换来的 token 变成 magpie 的登录结果（metadata 留给 loader / usage）。
function authResultFromToken(token, site, method = "browser") {
  const claims = decodeJwtPayload(token) ?? {}
  const username = typeof claims.name === "string" && claims.name.trim() ? claims.name.trim() : undefined
  const accountId = username || (typeof claims.sub === "string" && claims.sub.trim() ? claims.sub.trim() : undefined)
  return {
    type: "success",
    key: token,
    accountId,
    metadata: { username, source: method, method, bffBase: site.bffBase, domain: site.domain },
  }
}

// browserLogin 起本地监听 → 返回要打开的登录页 → waitCode 拿 code → exchange 换票。
async function browserLogin(site, { fetchImpl = globalThis.fetch, waitMs = LOGIN_WAIT_MS, signal, listenImpl } = {}) {
  const state = randomUUID()
  const server = await (listenImpl ?? listenLoopback)()
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("本地回调端口没有绑定成功")
  const redirectUri = `http://127.0.0.1:${address.port}${CB_PATH}`
  const url = `${site.loginUrl}?client=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`
  // 监听器必须在返回 url 之前就挂上：用户可能比宿主先完成登录，晚挂的 request 监听会收不到
  // 已经到达的那一发 POST（Node 只在有监听者时才派发 request 事件）。
  const codePromise = waitForCallback(server, { state, origin: site.origin, timeoutMs: waitMs, signal })
  return {
    url,
    redirectUri,
    state,
    server,
    exchange: (code) => exchangeCode(code, { redirectUri, state, site, fetchImpl }),
    waitCode: () => codePromise,
  }
}

function authResult(cred, site) {
  return {
    type: "success",
    key: cred.key,
    accountId: cred.accountId,
    metadata: { username: cred.username, source: cred.source, method: "desktop", bffBase: cred.bffBase, domain: cred.domain ?? site.domain },
  }
}

async function probeDesktopCredential(site, deps) {
  try {
    return { cred: await readDesktopCredential({ site, ...deps }) }
  } catch (error) {
    return { error }
  }
}

async function waitForDesktopCredential({ site, read, sleep, now, signal, waitMs = DESKTOP_WAIT_MS, stepMs = DESKTOP_POLL_MS }) {
  const deadline = now() + waitMs
  for (;;) {
    if (signal?.aborted) return { status: "aborted" }
    const trial = await read()
    if (trial.cred) return { status: "ready", result: authResult(trial.cred, site) }
    if (now() >= deadline) return { status: "timeout", error: trial.error }
    await sleep(stepMs)
  }
}

function reasonOf(error) {
  if (["unreadable", "expired", "untrusted", "domain_mismatch", "unsupported"].includes(error?.code)) return error.message
  return "本机没有读到 Agnes Code 桌面端登录态"
}

// --- 插件工厂 -----------------------------------------------------------------

export function createPlugin(site, { fetchImpl = globalThis.fetch, env = process.env, readFileImpl, dpapiImpl, homedir = osHomedir(), platform = process.platform, sleepImpl, nowMsImpl = () => Date.now(), listenImpl } = {}) {
  const sleep = sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const ID = site.id

  // 两端余额端点不同（bff 域实测、api 域兜底），逐个试，记住对的那个，下次直接用。
  let balanceUrlCache

  async function fetchModels(key) {
    return await fetchImpl(modelsUrl(site), {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    })
  }

  async function readBalance(key) {
    const candidates = balanceUrlCache ? [balanceUrlCache] : balanceUrls(site)
    let last = null
    for (const url of candidates) {
      const res = await fetchImpl(url, {
        headers: { authorization: `Bearer ${key}`, accept: "application/json" },
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      })
      if (res.status === 401 || res.status === 403) {
        throw Object.assign(new Error(`Agnes 拒绝了这份凭据（HTTP ${res.status}），请重新登录`), { signIn: "expired" })
      }
      if (res.status === 404) {
        last = new Error(`积分余额端点不存在（HTTP 404）：${url}`)
        continue
      }
      if (!res.ok) throw new Error(`积分余额读取失败（HTTP ${res.status}）`)
      const body = await res.json()
      const data = body?.data
      if (!data || typeof data.total_balance !== "number") throw new Error("积分余额格式异常")
      balanceUrlCache = url
      return data
    }
    throw last ?? new Error("积分余额读取失败")
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      // ??= 保留用户在 plugins.json 里自己配置的同名供应商。
      cfg.provider[ID] ??= {
        name: site.label,
        npm: "@ai-sdk/openai-compatible",
        api: chatBase(site),
        models: bootstrapRows(),
      }
    },

    auth: {
      provider: ID,
      methods: [
        {
          // 浏览器 loopback 登录：三平台可用、不需要桌面端、也不需要密码（因此没有锁号风险）。
          type: "oauth",
          label: `浏览器登录 · ${site.short}`,
          async authorize(_inputs, { signal } = {}) {
            const login = await browserLogin(site, { fetchImpl, listenImpl, signal })
            return {
              url: login.url,
              instructions: `在打开的登录页完成登录（${site.loginHint}）。完成后这里会自动结束；窗口没弹出就手动打开上面的链接。若打开后直接进了网页版首页（没出现扫码/登录页），说明这个浏览器已经登录着该站，不会回传授权码——把链接粘到无痕窗口再打开一次。`,
              method: "auto",
              callback: async () => {
                try {
                  const code = await login.waitCode()
                  const token = await login.exchange(code)
                  return authResultFromToken(token, site)
                } catch (error) {
                  return { type: "failed", error: error?.message ?? "浏览器登录失败" }
                } finally {
                  try {
                    login.server.close()
                  } catch {}
                }
              },
            }
          },
        },
        {
          // 桌面端会话：解得出就立刻完成（url 留空）；解不出给官网链接，边等边让用户去装。
          type: "oauth",
          label: `读取桌面端登录态 · ${site.short}`,
          async authorize(_inputs, { signal } = {}) {
            if (platform !== "win32") {
              throw new Error("桌面端会话解密仅支持 Windows；本机请改用「浏览器登录」或「粘贴 accessToken」")
            }
            const keyCache = new Map()
            const read = () => probeDesktopCredential(site, { readFileImpl, dpapiImpl, homedir, platform, env, nowMs: nowMsImpl(), keyCache })
            const probe = await read()
            if (probe.cred) {
              return {
                url: "",
                instructions: `已读取本机 Agnes Code 登录态（${probe.cred.username ?? probe.cred.accountId}），正在完成登录…`,
                method: "auto",
                callback: async () => authResult(probe.cred, site),
              }
            }
            const desktopHint = ["domain_mismatch", "untrusted", "unreadable", "expired"].includes(probe.error?.code)
              ? probe.error.message
              : `本机没有读到 Agnes Code 桌面端登录态。装上或打开 Agnes Code 桌面端并登录就好；也可以改用「浏览器登录 · ${site.short}」。`
            // 营销页 agnes-ai.com/agnescode 被 Defender SmartScreen 举报过会红屏拦下，所以这里给的是应用页；
            // 万一还是被拦，文案里说明怎么过（不改用户的浏览器安全策略）。
            const smartScreenHint = `若浏览器弹出「此网站已被人举报不安全」（SmartScreen 误报），点「详细信息 → 仍要继续」，或换一个浏览器，或直接用「浏览器登录 · ${site.short}」。`
            return {
              url: site.officialSite,
              instructions: `${desktopHint}。${smartScreenHint}`,
              method: "auto",
              callback: async (_code, { signal: callbackSignal } = {}) => {
                const waited = await waitForDesktopCredential({ site, read, sleep, now: nowMsImpl, signal: callbackSignal ?? signal })
                if (waited.status === "ready") return waited.result
                if (waited.status === "aborted") return { type: "failed", error: "登录已取消" }
                return {
                  type: "failed",
                  error: `仍未读到桌面端登录态（最后一次：${reasonOf(waited.error)}）。登录 Agnes Code 后重试，或改用「浏览器登录」。`,
                }
              },
            }
          },
        },
        {
          type: "api",
          label: `粘贴 accessToken · ${site.short}`,
          prompts: [
            { type: "password", key: "accessToken", message: "会话里的 JWT accessToken（eyJ…）", validate: (v) => (v && v.trim() ? undefined : "必填") },
            { type: "text", key: "username", message: "用户名（可选，用于显示）" },
          ],
          async authorize(inputs) {
            const key = String(inputs?.accessToken ?? "").trim()
            if (!key) return { type: "failed", error: "accessToken 必填" }
            const username = String(inputs?.username ?? "").trim() || undefined
            return {
              type: "success",
              key,
              accountId: username,
              metadata: { username, source: "paste", method: "paste", bffBase: site.bffBase, domain: site.domain },
            }
          },
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        return { baseURL: chatBase(site), apiKey: auth.key }
      },
      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        let balance
        try {
          balance = await readBalance(auth.key)
        } catch (error) {
          if (error?.signIn === "expired") return { error: error.message, signIn: "expired", windows: [] }
          return { error: error?.message ?? "Agnes 积分读取失败", windows: [] }
        }
        const windows = [{ name: "积分", balance: balance.total_balance, aside: false }]
        if (balance.time_sensitive_balance > 0) windows.push({ name: "限时积分", balance: balance.time_sensitive_balance, aside: true })
        if (balance.permanent_balance > 0) windows.push({ name: "永久积分", balance: balance.permanent_balance, aside: true })
        return { plan: balance.level_name || (balance.level ? `Level ${balance.level}` : "Free"), windows }
      },
      // 每日登录送积分由服务端随当日会话发放、无领取接口；这里观测发放前后的余额差。
      async checkin(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        let before
        try {
          before = await readBalance(auth.key)
        } catch (error) {
          if (error?.signIn === "expired") throw error
          return { outcome: "failed", message: error?.message ?? "积分余额读取失败" }
        }
        await fetchModels(auth.key).catch(() => null)
        await sleep(2500)
        let after
        try {
          after = await readBalance(auth.key)
        } catch (error) {
          if (error?.signIn === "expired") throw error
          return { outcome: "failed", message: error?.message ?? "积分余额读取失败" }
        }
        const delta = after.total_balance - before.total_balance
        if (delta > 0) return { outcome: "claimed", credit: delta, message: `每日登录积分 +${delta}` }
        return { outcome: "inactive", message: "未观测到新发放：余额无变化（发放可能挂靠桌面端登录）" }
      },
    },

    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        if (auth?.type !== "api" || !auth.key) return provider.models
        let res
        try {
          res = await fetchModels(auth.key)
        } catch {
          return provider.models
        }
        if (res.status === 401 || res.status === 403) {
          throw Object.assign(new Error(`Agnes 拒绝了这份凭据（HTTP ${res.status}），请重新登录`), { signIn: "expired" })
        }
        if (!res.ok) return provider.models
        let body
        try {
          body = await res.json()
        } catch {
          throw new Error("Agnes 模型目录不是有效 JSON")
        }
        const list = body?.data
        if (!Array.isArray(list) || list.some((m) => typeof m?.id !== "string" || !m.id)) {
          throw new Error("Agnes 模型目录格式异常")
        }
        const rows = Object.fromEntries(list.map((m) => [m.id, rowFromCatalogEntry(m)]))
        if (!Object.keys(rows).length) throw new Error("Agnes 模型目录为空")
        return rows
      },
    },
  }
}

// 插件是唯一的导出函数；测试需要的内部函数按社区约定挂在 _internal 上。
export const AgnesPlugin = async () => createPlugin(SITES.intl)
export const AgnesCNPlugin = async () => createPlugin(SITES.cn)

export const _internal = {
  SITES,
  CLIENT_ID,
  CB_PATH,
  createPlugin,
  chatBase,
  modelsUrl,
  balanceUrls,
  trustBase,
  siteOfBase,
  decodeJwtPayload,
  isExpiredJwt,
  rowFromCatalogEntry,
  bootstrapRows,
  parseEncryptedKey,
  decryptSessionWithKey,
  dpapiUnprotect,
  readDesktopCredential,
  probeDesktopCredential,
  waitForDesktopCredential,
  listenLoopback,
  waitForCallback,
  exchangeCode,
  browserLogin,
  authResultFromToken,
  reasonOf,
  BOOTSTRAP,
  LOGIN_WAIT_MS,
  EXCHANGE_TIMEOUT_MS,
  DESKTOP_WAIT_MS,
  DPAPI_TIMEOUT_MS,
  BALANCE_PATH,
}
