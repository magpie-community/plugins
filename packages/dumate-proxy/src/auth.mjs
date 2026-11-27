import { createDecipheriv, createHash } from "node:crypto"
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { desktopUserDataDir } from "./paths.mjs"

const SKEW_MS = 5 * 60 * 1000
const FALLBACK_TOKEN_TTL_MS = 60 * 60 * 1000
const RUNTIME_COOKIE_FILE = "runtime-cookie.json"

export function parseCookieString(raw) {
  const out = []
  for (const part of String(raw ?? "").split(/;\s*/)) {
    const idx = part.indexOf("=")
    if (idx <= 0) continue
    const name = part.slice(0, idx).trim()
    let value = part.slice(idx + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    if (name) out.push({ name, value, domain: ".baidu.com" })
  }
  return out
}

function matchesHost(cookie, hostname) {
  if (!cookie?.domain) return true
  const domain = String(cookie.domain).replace(/^\./, "").toLowerCase()
  const host = String(hostname || "").toLowerCase()
  return host === domain || host.endsWith(`.${domain}`)
}

export function buildCookieHeader(cookies, hostname) {
  return (Array.isArray(cookies) ? cookies : [])
    .filter((cookie) => matchesHost(cookie, hostname))
    .map((cookie) => {
      let value = String(cookie.value ?? "").replace(/^["']+|["']+$/g, "")
      if (/[:|;=\s]/.test(value)) value = `"${value}"`
      return `${cookie.name}=${value}`
    })
    .join("; ")
}

export function extractCsrfToken(cookies, hostname) {
  const hit = (Array.isArray(cookies) ? cookies : []).find(
    (cookie) => cookie?.name === "bce-user-info" && matchesHost(cookie, hostname),
  )
  return hit ? String(hit.value ?? "").replace(/^["']+|["']+$/g, "") : ""
}

export function parseCookieKey(raw) {
  if (Buffer.isBuffer(raw)) return raw.length === 32 ? raw : undefined
  if (raw instanceof Uint8Array) return raw.length === 32 ? Buffer.from(raw) : undefined

  let text = String(raw ?? "").trim()
  if (!text) return undefined
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed) && parsed.length === 32 && parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
        return Buffer.from(parsed)
      }
      const nested = parsed?.cookieKey ?? parsed?.key ?? parsed?.cookie_key
      if (nested != null) return parseCookieKey(nested)
    } catch {
      return undefined
    }
  }

  const clean = text.replace(/-----(BEGIN|END)[^-]*-----/g, "").replace(/\s+/g, "")
  if (/^[0-9a-fA-F]{64}$/.test(clean)) return Buffer.from(clean, "hex")
  if (/^[A-Za-z0-9+/=]+$/.test(clean)) {
    const decoded = Buffer.from(clean, "base64")
    if (decoded.length === 32) return decoded
  }
  return undefined
}

export function decryptDesktopAuth(authInput, keyInput, source = "desktop") {
  try {
    const auth = typeof authInput === "string" ? JSON.parse(authInput) : authInput
    const encrypted = auth?.cookies
    if (typeof encrypted !== "string" || !encrypted) return undefined
    const key = parseCookieKey(keyInput)
    if (!key) return undefined

    const envelope = Buffer.from(encrypted, "base64")
    const decipher = createDecipheriv("aes-256-gcm", key, envelope.subarray(0, 12))
    decipher.setAuthTag(envelope.subarray(12, 28))
    const cookies = JSON.parse(Buffer.concat([decipher.update(envelope.subarray(28)), decipher.final()]).toString("utf8"))
    if (!Array.isArray(cookies) || cookies.length === 0) return undefined

    const profile = Array.isArray(auth.accountProfiles) && auth.activeProfileId
      ? auth.accountProfiles.find((item) => item?.profileId === auth.activeProfileId)
      : undefined
    return {
      cookies,
      source,
      accountId: String(profile?.bceAccountId ?? auth.accountProfiles?.[0]?.bceAccountId ?? ""),
      name: String(profile?.displayName ?? auth.accountProfiles?.[0]?.displayName ?? ""),
    }
  } catch {
    return undefined
  }
}

export function readDesktopLogin({ userDataDir = desktopUserDataDir() } = {}) {
  try {
    const authPath = join(userDataDir, "auth.json")
    const keyPath = join(userDataDir, ".cookie-key")
    const stat = statSync(authPath)
    if (!stat.isFile() || stat.size <= 0 || stat.size > 1024 * 1024) return undefined
    const auth = JSON.parse(readFileSync(authPath, "utf8"))
    const key = readFileSync(keyPath)
    return decryptDesktopAuth(auth, key, "desktop")
  } catch {
    return undefined
  }
}

function signInError() {
  const error = new Error("DuMate 登录态已失效，请重新打开百度搭子桌面端登录或设置 DUMATE_COOKIE")
  error.type = "authentication_error"
  error.status = 401
  return error
}

function consoleError(payload, fallback) {
  const message = typeof payload?.message === "string" && payload.message
    ? payload.message
    : typeof payload?.error?.message === "string" && payload.error.message
      ? payload.error.message
      : fallback
  const error = new Error(`DuMate 接口错误: ${message}`)
  error.type = "api_error"
  error.status = 502
  return error
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex")
}

export class DuMateAuth {
  constructor(config, { fetchImpl = fetch } = {}) {
    this.config = config
    this.fetchImpl = fetchImpl
    this.cookieCache = null
    this.tokens = new Map()
    this.stateDir = config.stateDir || "."
    this.runtimeCookiePath = join(this.stateDir, RUNTIME_COOKIE_FILE)
  }

  readRuntimeCookie() {
    try {
      const text = readFileSync(this.runtimeCookiePath, "utf8")
      if (text.length > 1024 * 1024) return undefined
      const data = JSON.parse(text)
      const cookies = parseCookieString(String(data?.cookie ?? ""))
      if (!cookies.length) return undefined
      return { cookies, source: String(data?.source || "runtime") }
    } catch {
      return undefined
    }
  }

  async setCookies(cookies, source = "plugin", persist = true) {
    const list = Array.isArray(cookies) ? cookies : []
    if (!list.length) throw signInError()
    const header = buildCookieHeader(list, new URL(this.config.consoleBase).hostname)
    if (!header) throw signInError()
    if (persist) {
      mkdirSync(this.stateDir, { recursive: true })
      writeFileSync(this.runtimeCookiePath, JSON.stringify({ cookie: header, source, updatedAt: Date.now() }, null, 2) + "\n", { mode: 0o600 })
    }
    this.cookieCache = { cookies: list, source }
    this.tokens.clear()
    return { cookies: list, source, cookieHeader: header }
  }

  async setCookie(raw, source = "plugin") {
    return this.setCookies(parseCookieString(raw), source, true)
  }

  async useDesktopLogin() {
    const login = readDesktopLogin({ userDataDir: this.config.userDataDir || desktopUserDataDir() })
    if (!login) throw signInError()
    return this.setCookies(login.cookies, "desktop", false)
  }

  async userInfo() {
    const info = await this.consoleJson("/api/dumate/user/info")
    return {
      accountId: String(info?.bceAccountId ?? info?.userId ?? "DuMate Proxy"),
      name: String(info?.displayName ?? info?.realName ?? ""),
    }
  }
  async resolveCookies() {
    if (this.cookieCache) return this.cookieCache

    const runtime = this.readRuntimeCookie()
    if (runtime) return runtime

    if (this.config.cookie) {
      const cookies = parseCookieString(this.config.cookie)
      if (!cookies.length) throw signInError()
      this.cookieCache = { cookies, source: "env" }
      return this.cookieCache
    }

    if (this.config.cookieFile) {
      const raw = readFileSync(this.config.cookieFile, "utf8")
      const cookies = parseCookieString(raw)
      if (!cookies.length) throw signInError()
      this.cookieCache = { cookies, source: "file" }
      return this.cookieCache
    }

    const login = readDesktopLogin({ userDataDir: this.config.userDataDir || desktopUserDataDir() })
    if (!login) throw signInError()
    this.cookieCache = login
    return this.cookieCache
  }

  async cookieHeader() {
    const { cookies } = await this.resolveCookies()
    const header = buildCookieHeader(cookies, new URL(this.config.consoleBase).hostname)
    if (!header) throw signInError()
    return header
  }

  async consoleJson(path) {
    const { cookies } = await this.resolveCookies()
    const hostname = new URL(this.config.consoleBase).hostname
    const response = await this.fetchImpl(`${this.config.consoleBase}${path}`, {
      method: "GET",
      headers: {
        Cookie: buildCookieHeader(cookies, hostname),
        csrftoken: extractCsrfToken(cookies, hostname),
        "X-Requested-With": "XMLHttpRequest",
        Origin: this.config.consoleBase,
        Referer: `${this.config.consoleBase}/`,
        "User-Agent": this.config.userAgent,
        Accept: "application/json",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    })

    const text = await response.text()
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      if (/<html|<!doctype|登录|login/i.test(text.slice(0, 500))) throw signInError()
      throw consoleError(null, `HTTP ${response.status} 非 JSON 响应`)
    }
    if ((response.status >= 300 && response.status < 400) || response.status === 401) throw signInError()
    if (!response.ok) throw consoleError(payload, `HTTP ${response.status}`)
    if (payload?.code !== undefined && payload.code !== 0) throw consoleError(payload, `code=${payload.code}`)
    if (payload?.success === false) throw consoleError(payload, "success=false")
    return payload?.result ?? payload
  }

  async gatewayToken(cookieHeader) {
    const key = digest(cookieHeader)
    const cached = this.tokens.get(key)
    if (cached && Date.now() < cached.expiresAt - SKEW_MS) return cached.token
    if (cached?.pending) return cached.pending

    const pending = (async () => {
      const result = await this.consoleJson("/api/dumate/app/token/get")
      const token = String(result?.token ?? "")
      if (!token) throw consoleError(null, "未返回 gateway token")
      const parsed = result?.expired_at ? Date.parse(result.expired_at) : Number.NaN
      const expiresAt = Number.isFinite(parsed) && parsed > Date.now()
        ? parsed
        : Date.now() + FALLBACK_TOKEN_TTL_MS
      this.tokens.set(key, { token, expiresAt })
      return token
    })().catch((error) => {
      const current = this.tokens.get(key)
      if (current?.pending === pending) this.tokens.delete(key)
      throw error
    })

    this.tokens.set(key, { pending })
    return pending
  }

  async refreshGatewayToken(cookieHeader) {
    const header = cookieHeader ?? await this.cookieHeader()
    const key = digest(header)
    const current = this.tokens.get(key)
    if (current?.pending) {
      try { await current.pending } catch { /* a failed pending refresh is retried below */ }
    }
    this.tokens.delete(key)
    return this.gatewayToken(header)
  }

  invalidate() {
    this.tokens.clear()
  }
}
