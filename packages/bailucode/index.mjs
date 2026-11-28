// magpie-bailucode — BAILU AI（白鹿）Open Platform as a magpie / OpenCode provider.
//
// API keys: https://bailucode.com/api_platform/#api-keys
// Gateway:  https://bailucode.com/openapi/v1
//
// One base, one Bearer key, three protocol faces (all verified against the
// live gateway with an invalid key — each answered 401 "invalid_api_key"
// instead of 404, so the route exists):
//
//   POST /openapi/v1/chat/completions   OpenAI Chat Completions
//   POST /openapi/v1/messages           Anthropic Messages
//   POST /openapi/v1/responses          OpenAI Responses
//   POST /openapi/v1/embeddings         OpenAI Embeddings
//   GET  /openapi/v1/models             the key's model list
//
// There is no per-key quota route on the gateway (every /usage, /billing,
// /key path answers 404 — the model faces are the whole surface). The quota
// the dashboard shows is account-scoped and lives behind the 白鹿通行证 session
// at https://bailucode.com/auth/, where the page carries it as `var S = {...}`.
// This plugin reads that page with a session you keep on disk, and reports the
// key's state when it has none.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

const PROVIDER = "bailucode"
const PROVIDER_NAME = "BAILU（白鹿）"
const BASE = "https://bailucode.com/openapi/v1"
const KEY_PAGE = "https://bailucode.com/api_platform/#api-keys"
const PORTAL = "https://bailucode.com/auth/"
// The UA and the package's version are the same number.
const VERSION = (() => {
  try {
    const { version } = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"))
    return typeof version === "string" ? version : "0.0.0"
  } catch {
    return "0.0.0"
  }
})()

// Where a 白鹿通行证 cookie may be kept. First one found wins.
const SESSION_CANDIDATES = [
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "magpie-bailucode", "session.txt") : null,
  path.join(os.homedir(), ".config", "magpie-bailucode", "session"),
  path.join(os.homedir(), ".magpie-bailucode", "session"),
].filter(Boolean)

// The SDK each protocol face is spoken with, as magpie names packages.
const PROTOCOLS = {
  openai: "@ai-sdk/openai-compatible",
  anthropic: "@ai-sdk/anthropic",
}

// Models the platform advertises publicly. They keep the provider usable
// before the key is added; GET /models replaces them once it answers.
const SEED_MODELS = [
  { id: "bailu-2.9-preview", name: "BAILU 2.9 Preview", context: 1048576, output: 131072 },
  { id: "bailu-2.8", name: "BAILU 2.8", context: 262144, output: 65536, vision: true },
  { id: "bailu-2.7", name: "BAILU 2.7", context: 262144, output: 65536 },
  { id: "bailu-apex-2.7", name: "BAILU APEX 2.7", context: 1048576, output: 65536 },
  { id: "yuyu-air", name: "Yuyu Air", context: 262144, output: 65536 },
]

const TIMEOUT = 20_000
const USAGE_TTL = 60_000
// A 403 here is not the key: Cloudflare answers an HTML challenge on exits it
// mistrusts (a foreign proxy, a datacenter IP) before the gateway sees the key.
const CLOUDFLARE_HINT = "BAILU 网关返回了 Cloudflare 验证页（不是 key 的问题）：让 bailucode.com 走直连，或换一个出口 IP"

// ---- helpers -----------------------------------------------------------------

function protocolOf(value) {
  return value === "anthropic" ? "anthropic" : "openai"
}

// A pasted address may be the bare host, /openapi, or the full /openapi/v1.
function normalizeBase(raw) {
  let value = typeof raw === "string" ? raw.trim() : ""
  if (!value) return BASE
  if (!/^https?:\/\//i.test(value)) value = "https://" + value
  value = value.replace(/\/+$/, "")
  if (/\/openapi\/v1$/i.test(value) || /\/v1$/i.test(value)) return value
  if (/\/openapi$/i.test(value)) return value + "/v1"
  try {
    const url = new URL(value)
    if (url.pathname === "" || url.pathname === "/") return url.origin + "/openapi/v1"
  } catch {
    return BASE
  }
  return value
}

function modelEntry(model, base, npm) {
  const id = typeof model === "string" ? model : String(model?.id ?? model?.name ?? "")
  const name = (typeof model === "object" && (model.name || model.display_name)) || id
  const context =
    Number(typeof model === "object" && (model.context_length || model.context_window || model.context || model.max_context_tokens)) || 262144
  const output =
    Number(typeof model === "object" && (model.max_output_tokens || model.max_completion_tokens || model.max_tokens)) || 65536
  const vision =
    (typeof model === "object" &&
      (model.vision === true || (Array.isArray(model.modalities?.input) && model.modalities.input.includes("image")))) ||
    // BAILU 2.8 / 2.9 are natively multimodal; older families are text-only unless told.
    /vision|vl\b|omni|2\.(?:8|9)/i.test(id)
  return [
    id,
    {
      id,
      name,
      provider: { npm, api: base },
      limit: { context, output },
      reasoning: true,
      tool_call: true,
      attachment: vision,
      modalities: { input: vision ? ["text", "image"] : ["text"], output: ["text"] },
    },
  ]
}

function seedEntries(base, npm) {
  return SEED_MODELS.map((model) => modelEntry(model, base, npm))
}

function modelIds(body) {
  const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : []
  return list.filter((item) => item && (typeof item === "string" || typeof item.id === "string" || typeof item.name === "string"))
}

function authError(status, body) {
  const said = typeof body?.error?.message === "string" ? body.error.message : typeof body?.message === "string" ? body.message : ""
  const error = new Error(said || (status === 403 ? CLOUDFLARE_HINT : `HTTP ${status}`))
  error.status = status
  return error
}

// ---- 白鹿通行证 quota (portal) --------------------------------------------------

// The portal embeds its wallet in the dashboard as `var S = {...}`. Find the
// object that follows the marker and take it whole: it is plain JSON, so a
// balanced-brace scan that respects strings is enough.
function extractJson(text, marker) {
  const at = typeof text === "string" ? text.indexOf(marker) : -1
  if (at < 0) return null
  const start = text.indexOf("{", at + marker.length - 1)
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

const fmtNum = (value) => (Number(value) || 0).toLocaleString("en-US")
const fmtCN = (value) => {
  const n = Number(value) || 0
  // the portal truncates: 318,500,000 reads "3.18 亿", not "3.19"
  if (n >= 1e8) return `${(Math.floor(n / 1e6) / 100).toFixed(2).replace(/\.?0+$/, "")} 亿`
  if (n >= 1e4) return `${(Math.floor(n / 1e3) / 10).toFixed(1).replace(/\.0$/, "")} 万`
  return fmtNum(n)
}

// "12月3日" on the dashboard is the API quota's reset day.
function resetsAtFrom(html, now = new Date()) {
  const match = typeof html === "string" ? html.match(/用量重置<\/dt>\s*<dd[^>]*>\s*(\d{1,2})月(\d{1,2})日/) : null
  if (!match) return undefined
  // the portal's day is Asia/Shanghai whatever this machine's clock is set to
  const shifted = new Date(now.getTime() + 8 * 3600_000)
  const month = Number(match[1])
  const day = Number(match[2])
  const build = (year) => Date.UTC(year, month - 1, day) - 8 * 3600_000
  let at = build(shifted.getUTCFullYear())
  if (at < now.getTime() - 24 * 3600_000) at = build(shifted.getUTCFullYear() + 1)
  return new Date(at).toISOString()
}

const PACK_LABELS = { anthropic: "Anthropic 协议 定向" }

// A number the page actually said, or nothing. `Number(x) || 0` turned a
// field that had been renamed into a confident "0 Credits, used 100%".
const numberOr = (value) => {
  if (value === null || value === undefined || value === "") return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

// windows, as magpie draws them: used is a percentage, display is the line.
// A row whose source fields are absent is left out: an unknown balance must
// not read as an empty one.
function quotaWindows(S, html, now = new Date()) {
  const windows = []
  const code = S?.code ?? {}
  const api = S?.api ?? {}

  const planRemain = numberOr(code.planRemain)
  const planQuota = numberOr(code.planQuota)
  const addonTokens = numberOr(code.addonTokens)
  if (planRemain !== undefined && planQuota !== undefined) {
    const addonCredits = (addonTokens ?? 0) / 1000 // 1,000 tokens = 1 credit
    const creditsLeft = planRemain + addonCredits
    windows.push({
      name: "白鹿编码",
      used: planQuota > 0 ? Math.max(0, Math.min(100, ((planQuota - planRemain) / planQuota) * 100)) : 0,
      amount: creditsLeft,
      limit: planQuota + addonCredits,
      display: `${fmtNum(creditsLeft)} Credits`,
      unit: "credits",
    })
  }

  const usedEff = numberOr(api.usedEff ?? api.used)
  const quotaEff = numberOr(api.quotaEff ?? api.quota)
  if (usedEff !== undefined && quotaEff !== undefined && quotaEff > 0) {
    const reset = resetsAtFrom(html, now)
    windows.push({
      name: "API 平台",
      used: Math.max(0, Math.min(100, (usedEff / quotaEff) * 100)),
      amount: usedEff,
      limit: quotaEff,
      display: `${fmtNum(usedEff)} / ${fmtCN(quotaEff)} Tokens`,
      unit: "tokens",
      ...(reset ? { resetsAt: reset } : {}),
    })
  }

  for (const pack of Array.isArray(S?.packs) ? S.packs : []) {
    const total = numberOr(pack?.q)
    const used = numberOr(pack?.u)
    if (total === undefined || used === undefined || total <= 0) continue
    windows.push({
      name: PACK_LABELS[pack?.id] ?? `${pack?.id} 定向`,
      used: Math.max(0, Math.min(100, (used / total) * 100)),
      amount: used,
      limit: total,
      display: `剩 ${fmtCN(Math.max(0, total - used))} / 共 ${fmtCN(total)} Tokens`,
      unit: "tokens",
      aside: true,
    })
  }
  return windows
}
// ---- signing in through a browser ----------------------------------------------

// Only bailucode.com's own cookies; the string is what the portal expects.
const cookieHeader = (cookies) =>
  (Array.isArray(cookies) ? cookies : [])
    .filter((c) => c && c.name && c.value && String(c.domain || "").replace(/^\./, "").endsWith("bailucode.com"))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ")

function browserExecutables() {
  const roots = [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean)
  const found = []
  for (const root of roots) {
    found.push(path.join(root, "Google", "Chrome", "Application", "chrome.exe"))
    found.push(path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"))
  }
  found.push(path.join("/usr/bin", "google-chrome"), path.join("/usr/bin", "chromium"), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
  return found.filter((file) => {
    try {
      return fs.existsSync(file)
    } catch {
      return false
    }
  })
}

// Chrome writes "<port>\n<websocket path>" into the profile once it listens.
const parseDevToolsPort = (text) => {
  const port = Number(String(text || "").split(/\r?\n/)[0])
  return Number.isInteger(port) && port > 0 ? port : null
}

async function cdpSession(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let target = null
  while (Date.now() < deadline) {
    try {
      const list = await (await fetchImplGlobal(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl)
      if (target) break
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!target) throw new Error("浏览器没有就绪（找不到调试目标）")

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  })
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve)
    ws.addEventListener("error", () => reject(new Error("连不上浏览器的调试端口")))
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const myId = ++id
      pending.set(myId, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)))
      ws.send(JSON.stringify({ id: myId, method, params }))
    })
  return {
    send,
    close: () => {
      try {
        ws.close()
      } catch {}
    },
  }
}

const fetchImplGlobal = (...args) => globalThis.fetch(...args)

// The signed-in dashboard page, read-only. `var S = {...}` is its wallet.
async function portalWallet(cookie, fetchImpl = fetchImplGlobal) {
  const res = await fetchImpl(PORTAL, {
    method: "GET",
    headers: {
      cookie,
      "user-agent": `magpie-bailucode/${VERSION}`,
      accept: "text/html,application/xhtml+xml",
      "accept-language": "zh-CN,zh;q=0.9",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (res.status >= 300 && res.status < 400) {
    const error = new Error("白鹿通行证会话已过期")
    error.expired = true
    throw error
  }
  if (!res.ok) {
    const error = new Error(res.status === 403 ? CLOUDFLARE_HINT : `门户返回 HTTP ${res.status}`)
    if (res.status === 403) error.cloudflare = true
    throw error
  }
  const html = await res.text()
  const wallet = extractJson(html, "var S = ")
  if (!wallet) {
    const error = new Error("门户页面里没有额度数据（页面可能改版，或会话只读到了登录页）")
    error.expired = /id="email"|发送验证码/.test(html)
    throw error
  }
  const email = typeof wallet.seed === "string" && wallet.seed.includes("@") ? wallet.seed : wallet?.pw?.email
  return { wallet, html, email }
}

// Opens the portal in a throwaway Chrome profile, waits for the person to
// finish the email sign-in there, and hands back the session cookie the
// browser then holds. Nothing is typed by the plugin.
async function browserSignIn({ log, timeoutMs = 5 * 60_000, profileDir, url = `${PORTAL}login?return_url=%2Fauth%2F` }) {
  const executables = browserExecutables()
  if (!executables.length) throw new Error("找不到 Chrome 或 Edge")
  // One throwaway profile per sign-in: reusing a fixed directory would keep
// the previous account's cookies and sign the next person straight into it.
const owned = !profileDir
const dir = profileDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "magpie-bailucode-browser-"))
fs.mkdirSync(dir, { recursive: true })
  for (const file of ["DevToolsActivePort", "SingletonLock"]) {
    try {
      fs.rmSync(path.join(dir, file), { force: true })
    } catch {}
  }

  let child = null
  let cdp = null
  const closeBrowser = async () => {
    try {
      cdp?.close()
    } catch {}
    try {
      child?.kill()
    } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }

  try {
    child = spawn(executables[0], [`--user-data-dir=${dir}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--disable-features=Translate", "--start-maximized", "--new-window", url], {
      stdio: "ignore",
      detached: false,
    })
    child.on("error", (error) => log(`浏览器启动失败：${error.message}`))

    const portFile = path.join(dir, "DevToolsActivePort")
    const deadline = Date.now() + 30_000
    let port = null
    while (Date.now() < deadline && !port) {
      try {
        port = parseDevToolsPort(fs.readFileSync(portFile, "utf8"))
      } catch {}
      if (!port) await new Promise((r) => setTimeout(r, 300))
    }
    if (!port) throw new Error("浏览器没有给出调试端口")

    cdp = await cdpSession(port)
    await cdp.send("Network.enable")

    const until = Date.now() + timeoutMs
    let lastNote = ""
    while (Date.now() < until) {
      const { cookies } = await cdp.send("Network.getAllCookies")
      const header = cookieHeader(cookies)
      if (header) {
        const reachable = await portalWallet(header).catch((error) => ({ error }))
        if (reachable && !reachable.error) {
          log("浏览器登录完成，已拿到通行证会话")
          return { cookie: header, wallet: reachable.wallet, html: reachable.html }
        }
        const note = reachable?.error?.cloudflare ? "浏览器还在过 Cloudflare 验证" : reachable?.error?.message || ""
        if (note && note !== lastNote) {
          lastNote = note
          log(`还在等登录完成：${note}`)
        }
      }
      const waited = Math.round((timeoutMs - (until - Date.now())) / 1000)
      if (waited > 0 && waited % 20 < 2) {
        const here = await cdp.send("Runtime.evaluate", { expression: "location.href", returnByValue: true }).catch(() => null)
        log(`等了 ${waited}s，浏览器停在 ${here?.result?.value || "?"}`)
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
    throw new Error("等待登录超时（5 分钟）")
  } finally {
    await closeBrowser()
    if (owned) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
      } catch {}
    }
  }
}

// The portal's own key API: full keys for the signed-in account, and creating
// one when the account has none.
async function portalKeys(cookie, fetchImpl = fetchImplGlobal) {
  const res = await fetchImpl("https://bailucode.com/api/api_keys", {
    method: "POST",
    headers: { cookie, "user-agent": `magpie-bailucode/${VERSION}`, accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ action: "get_keys" }),
    signal: AbortSignal.timeout(TIMEOUT),
  })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!res.ok || !body?.success) {
    const error = new Error(body?.message || `读取密钥失败（HTTP ${res.status}）`)
    error.status = res.status
    return { error }
  }
  return { keys: Array.isArray(body.keys) ? body.keys : [] }
}

// A disabled key is not a key: the account has none, and one gets created.
const keyUsable = (k) =>
  !!k && typeof k.api_key_full === "string" && k.api_key_full.startsWith("sk-") && (k.is_active === 1 || k.is_active === true)
const workingKey = (keys) => (Array.isArray(keys) ? keys : []).find(keyUsable) ?? null

async function portalCreateKey(cookie, name = "magpie", fetchImpl = fetchImplGlobal) {
  const res = await fetchImpl("https://bailucode.com/api/api_keys", {
    method: "POST",
    headers: { cookie, "user-agent": `magpie-bailucode/${VERSION}`, accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ action: "create_key", key_name: name }),
    signal: AbortSignal.timeout(TIMEOUT),
  })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!res.ok || !body?.success) throw new Error(body?.message || `创建密钥失败（HTTP ${res.status}）`)
  const full = body?.key?.api_key_full ?? body?.api_key_full ?? body?.keys?.[0]?.api_key_full
  if (!full) throw new Error("创建成功但没有拿到密钥原文")
  return String(full)
}

// 门户的「今日可领」：签到 + 两项定向额度。每一项都要 Cap 人机验证的 ticket，
// 没有 ticket 服务端直接回「请先完成人机验证」，所以这里只在有 ticket（或已经领过）时才动手。
const CLAIMS = {
  checkin: { url: "https://bailucode.com/api/auth", action: "claim_daily_checkin", label: "白鹿编码签到" },
  anthropic: { url: "https://bailucode.com/api/api_keys", action: "claim_anthropic_promo", label: "Anthropic 协议定向" },
  openclaw: { url: "https://bailucode.com/api/api_keys", action: "claim_openclaw_promo", label: "白鹿 API 总额度补充" },
}

// 门户按北京时间的自然日发这份额度。
function nextPortalMidnight(now = new Date()) {
  const shifted = new Date(now.getTime() + 8 * 3600_000)
  const day = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + 1))
  return new Date(day.getTime() - 8 * 3600_000).toISOString()
}

async function claimOne(cookie, target, ticket, fetchImpl = fetchImplGlobal) {
  const body = { action: target.action, ...(ticket ? { captcha_ticket: ticket } : {}) }
  const res = await fetchImpl(target.url, {
    method: "POST",
    headers: { cookie, "user-agent": `magpie-bailucode/${VERSION}`, accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  return { status: res.status, data }
}
// ---- the plugin --------------------------------------------------------------

export async function BailucodeAuthPlugin({ client, magpie } = {}, options = {}) {
  const log = (message) => {
    try {
      client?.app?.log?.({ body: { service: "bailucode", level: "info", message } })
    } catch {}
  }
  const fetchImpl = typeof options.fetch === "function" ? options.fetch : (...args) => globalThis.fetch(...args)
  const signInWithBrowser = typeof options.browserSignIn === "function" ? options.browserSignIn : browserSignIn
  const usageCache = new Map()

  const metaOf = (auth) => auth?.metadata ?? {}
  const baseOf = (auth) => normalizeBase(metaOf(auth).baseURL || options.baseURL || auth?.baseURL || BASE)
  const protocolOfAuth = (auth) => protocolOf(metaOf(auth).protocol || options.protocol)
  const npmOf = (auth) => PROTOCOLS[protocolOfAuth(auth)]
  const headersOf = (auth) => ({
    accept: "application/json",
    "user-agent": `magpie-bailucode/${VERSION}`,
    ...(options.headers ?? {}),
    ...(metaOf(auth).headers ?? {}),
  })

  async function listModels(base, key, headers) {
    const res = await fetchImpl(`${base}/models`, {
      method: "GET",
      headers: { ...headers, authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TIMEOUT),
    })
    const text = await res.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    if (!res.ok) {
      const error = authError(res.status, body)
      if (typeof body === "string" && body.trimStart().startsWith("<") && res.status === 403) error.cloudflare = true
      throw error
    }
    return modelIds(body)
  }

  // The 白鹿通行证 session belongs to the account it was signed in on: the
  // browser route stores it in that account's own metadata. A file or an env
  // var is read only when the user names it, so two accounts never trade one
  // machine's session (and a pasted key never shows someone else's wallet).
  function readSession(auth) {
    if (options.session === false) return null
    const kept = auth?.metadata?.session
    if (typeof kept === "string" && kept.trim()) return kept.trim()
    if (typeof options.session === "string" && options.session.trim()) return options.session.trim()
    if (typeof process.env.BAILUCODE_SESSION === "string" && process.env.BAILUCODE_SESSION.trim()) {
      return process.env.BAILUCODE_SESSION.trim()
    }
    if (typeof options.sessionFile === "string" && options.sessionFile.trim()) {
      try {
        const text = fs.readFileSync(options.sessionFile, "utf8").trim()
        if (text) return text
      } catch {}
    }
    return null
  }

  // Only when the user asked for a file. The browser route keeps its session
  // in the account's metadata; the files it used to write are what let two
  // accounts read one wallet.
  function saveSession(cookie) {
    if (typeof options.sessionFile !== "string" || !options.sessionFile.trim()) return
    const file = options.sessionFile
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      fs.writeFileSync(file, cookie + "\n", { mode: 0o600 })
      fs.chmodSync(file, 0o600)
      log(`通行证会话已写入 ${file}（0600）`)
    } catch (error) {
      log(`会话没能落盘：${error?.message || error}`)
    }
  }
  const authHook = {
    provider: PROVIDER,
    async loader(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api" || !auth.key) return {}
      return { baseURL: baseOf(auth), apiKey: auth.key, headers: headersOf(auth) }
    },
    methods: [
      {
        type: "api",
        label: "BAILU API key（bailucode.com/openapi）",
        placeholder: "sk-…",
        // 只要 key：地址默认就是官网网关，不再多问一次。
        // 要换网关（镜像/自建）用插件选项：magpie plugin options magpie-bailucode '{"baseURL":"…"}'
        prompts: [],
      },
      {
        type: "oauth",
        label: "浏览器登录白鹿通行证（自动取 key + 显示额度）",
        // magpie 的 oauth 约定：authorize 先交回一个会话（url/instructions/callback），
        // 真正的等待与取 key 都在 callback 里完成，最后答 { type: "success", key }。
        authorize: async () => ({
          url: `${PORTAL}login?return_url=%2Fauth%2F`,
          instructions: "在打开的浏览器里用邮箱验证码登录，插件会自己接住并取回你的 API key",
          method: "auto",
          opened: true,
          callback: async (result) => {
            // 这个账号自己的会话（magpie 把上一次登录的 metadata 交回来）；
            // 没有的话才开浏览器，绝不去读全局文件里的别人的会话。
            const mine = result?.metadata?.session
            let jar = typeof mine === "string" && mine.trim() ? mine.trim() : null
            if (jar) {
              const live = await portalWallet(jar, fetchImpl).catch(() => null)
              if (live) {
                log("复用已存的通行证会话，跳过浏览器")
              } else {
                log("已存的通行证会话失效，改为打开浏览器登录")
                jar = null
              }
            }
            if (!jar) {
              const opened = await signInWithBrowser({ log, timeoutMs: Number(options.loginTimeoutMs) || 5 * 60_000 })
              jar = opened.cookie
            }
            const found = await portalKeys(jar, fetchImpl)
            if (found.error) throw found.error
            let key = workingKey(found.keys)?.api_key_full
            if (key) {
              log("门户里已有可用 key，直接复用")
            } else {
              key = await portalCreateKey(jar, "magpie", fetchImpl)
              log("门户里没有可用 key，已新建一枚 magpie key")
            }
            saveSession(jar)
            return { type: "success", key, metadata: { browser: "chrome", session: jar } }
          },
        }),
      },
    ],
    // magpie 的卡片：有通行证会话就报额度，没有就只报 key 是否被网关接受。
    async usage(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api" || !auth.key) return null
      const base = baseOf(auth)
      const key = String(auth.key)
      const session = readSession(auth)
      const scope = `${base}|${key.slice(-8)}|${session ? "session" : "key"}`
      const hit = usageCache.get(scope)
      if (hit && Date.now() - hit.at < USAGE_TTL) return hit.value

      let value
      if (session) {
        try {
          const { wallet, html, email } = await portalWallet(session, fetchImpl)
          const windows = quotaWindows(wallet, html)
          value = {
            plan: "白鹿通行证",
            windows,
            ...(email ? { user: String(email) } : {}),
            ...(wallet?.api?.ok === false ? { error: "API 额度当前不可用（门户显示未开通或已停用）" } : {}),
            // 一行都算不出来 = 读到的字段不认识，不是「余额为 0」
            ...(windows.length ? {} : { error: "门户的额度字段读不到（页面可能改版），不敢当成 0 显示" }),
          }
          log(`BAILU: quota read — ${windows.length} window(s)`)
        } catch (error) {
          value = error?.expired
            ? {
                plan: "白鹿通行证",
                error: `通行证会话已过期：重新跑一次「浏览器登录白鹿通行证」即可（会话按账号保存，不写全局文件）`,
              }
            : error?.cloudflare
              ? { plan: "白鹿通行证", error: CLOUDFLARE_HINT }
              : { plan: "白鹿通行证", error: error?.message || "读不到门户额度" }
          log(`BAILU: quota failed — ${error?.message || error}`)
        }
      } else {
        try {
          const ids = await listModels(base, auth.key, headersOf(auth))
          value = { plan: "BAILU Open Platform", windows: [], ...(ids.length ? {} : { error: "key 看不到任何模型" }) }
          log(`BAILU: key accepted, ${ids.length} model(s) visible`)
        } catch (error) {
          value =
            error?.cloudflare
              ? { plan: "BAILU Open Platform", error: CLOUDFLARE_HINT }
              : error?.status === 401 || error?.status === 403
                ? { plan: "BAILU Open Platform", error: `API key 无效或已过期，去 ${KEY_PAGE} 重新生成` }
                : { plan: "BAILU Open Platform", error: error?.message || "无法访问 BAILU 网关" }
        }
      }
      usageCache.set(scope, { at: Date.now(), value })
      return value
    },
    // magpie 的签到钩子（契约抄自 host 源码）：
    // outcome: claimed | done | ineligible | inactive | captcha | failed,
    // 另有 credit / streak / message / until（厂商自己的一天什么时候翻）。
    async checkin(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api" || !auth.key) return { outcome: "ineligible", message: "还没有登录" }
      const jar = readSession(auth)
      if (!jar) return { outcome: "ineligible", message: "没有通行证会话：先走一次「浏览器登录」" }
      const midnight = nextPortalMidnight()
      let wallet
      try {
        wallet = (await portalWallet(jar, fetchImpl)).wallet
      } catch (error) {
        return { outcome: "failed", message: error?.message || "读不到门户", until: midnight }
      }
      const claims = Array.isArray(wallet?.claims) ? wallet.claims : []
      if (!claims.length) return { outcome: "failed", message: "门户没有给出今日可领项", until: midnight }
      const pending = claims.filter((c) => !c.claimed && CLAIMS[c.id])
      if (!pending.length) return { outcome: "done", message: "今天三项都已领取", until: midnight }
      const ticket = String(options.captchaTicket || process.env.BAILUCODE_CAPTCHA || "").trim()
      const done = []
      let credit = 0
      for (const claim of pending) {
        const target = CLAIMS[claim.id]
        let data
        try {
          ;({ data } = await claimOne(jar, target, ticket, fetchImpl))
        } catch (error) {
          return { outcome: "failed", message: `${target.label}：${error?.message || error}`, until: midnight }
        }
        if (data?.success || data?.already_claimed) {
          done.push(`${target.label}${data?.already_claimed ? "已领" : `+${claim.reward || 0}`}`)
          credit += Number(claim.reward) || 0
          continue
        }
        if (/人机验证|安全验证|滑块/.test(String(data?.message || ""))) {
          usageCache.clear()
          return {
            outcome: done.length ? "claimed" : "captcha",
            message: `${done.length ? done.join(" · ") + "；" : ""}门户要人机验证：去 ${PORTAL} 点一次「${target.label}」的领取`,
            ...(credit ? { credit } : {}),
            until: midnight,
          }
        }
        return { outcome: "failed", message: data?.message || "领取失败", until: midnight }
      }
      usageCache.clear()
      return { outcome: "claimed", message: done.join(" · ") || "已领取", credit, until: midnight }
    },
  }

  return {
    async config(cfg) {
      cfg.provider ??= {}
      const was = cfg.provider[PROVIDER] ?? {}
      const npm = PROTOCOLS[protocolOf(options.protocol)]
      const base = normalizeBase(options.baseURL || was.api || BASE)
      cfg.provider[PROVIDER] = {
        name: PROVIDER_NAME,
        npm,
        api: base,
        ...was,
        models: {
          ...Object.fromEntries(seedEntries(base, npm)),
          ...(was.models ?? {}),
        },
      }
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        const base = baseOf(auth) || provider?.api || BASE
        const npm = npmOf(auth)
        if (auth?.type === "api" && auth.key) {
          try {
            const found = await listModels(base, auth.key, headersOf(auth))
            if (found.length) return Object.fromEntries(found.map((model) => modelEntry(model, base, npm)))
            log("BAILU: the key's model list came back empty; keeping the known list")
          } catch (error) {
            log(`BAILU: model list failed — ${error?.message || error}`)
          }
        }
        const known = Array.isArray(metaOf(auth).models) ? metaOf(auth).models : []
        if (known.length) return Object.fromEntries(known.map((model) => modelEntry(model, base, npm)))
        return provider?.models ?? Object.fromEntries(seedEntries(base, npm))
      },
    },

    auth: authHook,

    // Cloudflare challenges clients that lie about being a browser: a
    // "Chrome/131" UA over a non-browser TLS stack gets an HTML 403, while an
    // honest client UA reaches the gateway (verified against the live site).
    // Keep every request carrying this UA, whatever the SDK would send.
    "chat.headers": async (input, output) => {
      // magpie calls every plugin's chat.headers for every provider's request:
      // without this guard, Cursor/Kiro/Qoder requests would go out with this
      // plugin's user agent and accept header.
      const owner = input?.model?.providerID ?? input?.provider?.info?.id ?? input?.provider?.id
      if (owner !== PROVIDER) return
      try {
        output.headers ??= {}
        output.headers["user-agent"] = `magpie-bailucode/${VERSION}`
        output.headers.accept ??= "application/json"
        Object.assign(output.headers, options.headers ?? {})
      } catch {}
    },
  }
}

// for tests
export const _internal = {
  PROVIDER,
  PROVIDER_NAME,
  BASE,
  KEY_PAGE,
  PROTOCOLS,
  SEED_MODELS,
  normalizeBase,
  modelEntry,
  seedEntries,
  modelIds,
  protocolOf,
  extractJson,
  quotaWindows,
  resetsAtFrom,
  fmtCN,
  cookieHeader,
  workingKey,
  parseDevToolsPort,
  SESSION_CANDIDATES,
}