// OpenCode and magpie provider plugins for MiniMax Design desktop subscriptions:
//   - minimax-design:        China site (design.minimax.cn / hub.minimaxi.com)
//   - minimax-design-global: Global site (design.minimax.io / hub.minimax.io)
//
// MiniMax Design (Electron app id `@hilo/desktop`, bundle id `com.minimax.hub`)
// stores its local session in `<userData>/hub-config.json` (China) or
// `<userData>/hub-config-global.json` (Global) with sensitive values encrypted
// using AES-256-GCM and a 32-byte key in `<userData>/.token-key`:
//   v2enc:<iv_base64>:<tag_base64>:<ciphertext_base64>
//
// Upstream APIs (verified against MiniMax Design 4.0.18):
//   - Live OpenCode provider & model config: GET <cloud>/api/v1/config
//   - Live image & video model catalog:      GET <cloud>/api/v1/models/config
//   - Account profile:                       GET <cloud>/api/v1/account/profile
//   - Credit wallet & subscription:          GET <cloud>/api/v1/credit/wallet
//   - Credit balance fallback:               GET <cloud>/api/v1/credit/balance
//   - LLM gateway (Anthropic & OpenAI Resp): POST <llmBase>/messages | /responses
//   - Media tasks (images & videos):         POST/GET <cloud>/api/v[12]/(image|video)/*
//     Required headers: `token: <accessToken>`, `version_code: <semver>`
//     Optional headers: `X-Group-Id: <groupId>`, `device_id: <deviceId>`
//
// Strictly read-only on MiniMax Design's local state directory.

import { createDecipheriv } from "node:crypto"
import { lstatSync, readFileSync, statSync } from "node:fs"
import { homedir as osHomedir } from "node:os"
import { join, posix, win32 } from "node:path"
import {
  _mediaInternal,
  bootstrapMediaSpecs,
  handleMediaFetch,
  mediaBootstrapConfigModels,
  mediaInternalModel,
  mediaPath,
  parseModelsConfig,
} from "./native.mjs"

const ENCRYPTED_V2_PREFIX = "v2enc:"
const LEGACY_ENCRYPTED_PREFIX = "encrypted:"
const PLACEHOLDER_KEY = "sk-hilo-placeholder"
const DEFAULT_VERSION_CODE = "4.0.18"
const DESKTOP_POLL_MS = 2000
const DESKTOP_WAIT_MS = 5 * 60 * 1000
const MODELS_TTL_MS = 5 * 60 * 1000
const OWNER_VERIFY_FAIL_TTL_MS = 30_000
const OWNER_CACHE_MAX = 16
const REQUEST_TIMEOUT_MS = 15_000
const MODALITIES = ["text", "image", "audio", "video", "pdf"]
const SUPPORTED_NPMS = new Set(["@ai-sdk/anthropic", "@ai-sdk/openai", "@ai-sdk/openai-compatible"])
const REDIRECTS = new Set([301, 302, 303, 307, 308])
const CREDIT_EXHAUSTED_CODES = new Set([
  "insufficient_credits",
  "insufficient_credit",
  "insufficient_balance",
  "credit_insufficient",
  "balance_insufficient",
])
const CREDIT_EXHAUSTED_PATTERN =
  /insufficient[_\s-]*(?:credit|credits|balance)|(?:credit|credits|balance)\s+(?:is\s+)?(?:insufficient|exhausted|depleted)|out\s+of\s+credits?|余额不足|积分不足|积分已用完|积分用完/i
const AUTH_ERROR_PATTERN =
  /invalid[\s_-]*(?:access[\s_-]*)?token|token[\s_-]*(?:is[\s_-]*)?(?:expired|invalid|empty|missing)|unauthoriz|not[\s_-]*log(?:ged)?[\s_-]*in|login[\s_-]*expired|未登录|登录已过期|登录态已失效|token\s*为空|无效.*token/i

const SITES = {
  "minimax-design": {
    id: "minimax-design",
    name: "MiniMax Design",
    region: "domestic",
    lang: "zh",
    cloud: "https://design.minimax.cn",
    defaultLlmBase: "https://hub.minimaxi.com/api/v1",
    officialSite: "https://design.minimax.cn/",
    allowedHosts: ["design.minimax.cn", "hub.minimaxi.com", "design.minimaxi.com"],
    configFiles: ["hub-config.json"],
  },
  "minimax-design-global": {
    id: "minimax-design-global",
    name: "MiniMax Design (Global)",
    region: "overseas",
    lang: "en",
    cloud: "https://design.minimax.io",
    defaultLlmBase: "https://hub.minimax.io/api/v1",
    officialSite: "https://design.minimax.io/",
    allowedHosts: ["design.minimax.io", "hub.minimax.io"],
    configFiles: ["hub-config-global.json", "hub-config.json"],
  },
}

// Map MiniMax Design's domestic compliance aliases to canonical model IDs and
// display names while preserving the upstream model ID in `api.id`.
const TEXT_MODEL_ALIASES = {
  "MiniMax-M3.1-Flash": { id: "MiniMax-M3.1-Flash", name: "MiniMax M3.1 Flash" },
  "MiniMax-M3": { id: "MiniMax-M3", name: "MiniMax M3" },
  "MiniMax-M2.7": { id: "MiniMax-M2.7", name: "MiniMax M2.7" },
  alpha: { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  alpha_high: { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
  gamma: { id: "gpt-5.5", name: "GPT-5.5" },
  gamma_high: { id: "gpt-5.5-high", name: "GPT-5.5 High" },
  gamma_mid: { id: "gpt-5.5-mid", name: "GPT-5.5 Mid" },
  "gamma-6-astra": { id: "gpt-6-astra", name: "GPT-6 Astra" },
}

// Snapshot of verified models from GET /api/v1/config (excluding @ai-sdk/google
// omega which returns 404 on /api/v1/models/*). Used before sign-in or when the
// remote catalog cannot be reached; provider.models() replaces it with live data.
const BOOTSTRAP = [
  {
    id: "MiniMax-M3.1-Flash",
    apiId: "MiniMax-M3.1-Flash",
    name: "MiniMax M3.1 Flash",
    npm: "@ai-sdk/anthropic",
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    inputs: ["text", "image", "video"],
    limit: { context: 1000000, input: 872000, output: 128000 },
    options: { thinking: { type: "adaptive" }, effort: "high" },
  },
  {
    id: "MiniMax-M3",
    apiId: "MiniMax-M3",
    name: "MiniMax M3",
    npm: "@ai-sdk/anthropic",
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    inputs: ["text", "image", "video"],
    limit: { context: 196608, input: 180000, output: 128000 },
  },
  {
    id: "MiniMax-M2.7",
    apiId: "MiniMax-M2.7",
    name: "MiniMax M2.7",
    npm: "@ai-sdk/anthropic",
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    inputs: ["text", "image"],
    limit: { context: 196608, input: 180000, output: 128000 },
  },
  {
    id: "claude-opus-5-5",
    apiId: "alpha",
    name: "Claude Opus 5.5",
    npm: "@ai-sdk/anthropic",
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    inputs: ["text", "image", "pdf"],
    limit: { context: 400000, input: 280000, output: 128000 },
    options: { thinking: { type: "adaptive" }, effort: "medium" },
    variants: {
      low: { thinking: { type: "adaptive" }, effort: "low" },
      medium: { thinking: { type: "adaptive" }, effort: "medium" },
      high: { thinking: { type: "adaptive" }, effort: "high" },
    },
  },
  {
    id: "claude-opus-4-6",
    apiId: "alpha_high",
    name: "Claude Opus 4.6",
    npm: "@ai-sdk/anthropic",
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    inputs: ["text", "image", "pdf"],
    limit: { context: 1000000, input: 900000, output: 128000 },
  },
  {
    id: "gpt-5.5-high",
    apiId: "gamma_high",
    name: "GPT-5.5 High",
    npm: "@ai-sdk/openai",
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    inputs: ["text", "image"],
    limit: { context: 270000, input: 270000, output: 128000 },
    options: { store: false, reasoningEffort: "medium", reasoningSummary: "auto", include: ["reasoning.encrypted_content"] },
    variants: {
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" },
    },
  },
  {
    id: "gpt-6-astra",
    apiId: "gamma-6-astra",
    name: "GPT-6 Astra",
    npm: "@ai-sdk/openai",
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: false,
    inputs: ["text", "image"],
    limit: { context: 270000, input: 270000, output: 128000 },
    options: { store: false, reasoningEffort: "medium", reasoningSummary: "auto", include: ["reasoning.encrypted_content"] },
    variants: {
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" },
    },
  },
]

const CREDIT_TYPE_LABELS = {
  zh: {
    0: "充值积分",
    1: "会员积分",
    2: "赠送积分",
    3: "默认积分",
    4: "创作者积分",
    5: "活动积分",
    6: "登录积分",
    7: "转移积分",
  },
  en: {
    0: "Top-up Credits",
    1: "Membership Credits",
    2: "Bonus Credits",
    3: "Default Credits",
    4: "Creator Credits",
    5: "Activity Credits",
    6: "Login Credits",
    7: "Transfer Credits",
  },
}

// ---- small helpers -----------------------------------------------------------

const isRecord = (v) => Boolean(v && typeof v === "object" && !Array.isArray(v))
const trimStr = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined)
const idStr = (v) => {
  if (typeof v === "string") return v.trim() || undefined
  if (typeof v === "number" && Number.isFinite(v)) return String(v)
  return undefined
}
const posInt = (v) => {
  const n = Math.trunc(Number(v))
  return Number.isFinite(n) && n > 0 ? n : 0
}
const num = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v.trim()))) return Number(v.trim())
  return undefined
}

const msg = (lang, zh, en) => (lang === "zh" ? zh : en)

function normalizeVersionCode(raw) {
  const s = trimStr(raw)
  if (!s) return DEFAULT_VERSION_CODE
  const m = /^v?(\d+\.\d+\.\d+)(?:[-+].*)?$/.exec(s)
  return m ? m[1] : s
}

function detectInstalledVersion({ env = process.env, platform = process.platform, readFileImpl } = {}) {
  const fromEnv = trimStr(env.MINIMAX_DESIGN_VERSION_CODE)
  if (fromEnv) return normalizeVersionCode(fromEnv)
  const readText = readFileImpl ?? ((p) => readFileSync(p, "utf8"))
  if (platform === "darwin") {
    try {
      const xml = String(readText("/Applications/MiniMax Design.app/Contents/Resources/sq.version"))
      const m = xml.match(/<version>([^<]+)<\/version>/)
      if (m?.[1]) return normalizeVersionCode(m[1])
    } catch {}
  }
  return DEFAULT_VERSION_CODE
}

function decodeJwtClaims(token) {
  if (typeof token !== "string") return null
  const parts = token.split(".")
  if (parts.length < 2 || !parts[1]) return null
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function jwtOwnerId(token) {
  const claims = decodeJwtClaims(token)
  if (!claims) return undefined
  if (isRecord(claims.user)) {
    return idStr(claims.user.id) ?? idStr(claims.user.userID) ?? idStr(claims.user.uid)
  }
  return idStr(claims.sub) ?? idStr(claims.uid) ?? idStr(claims.user_id)
}

function isExpiredJwt(token, nowMs = Date.now()) {
  const claims = decodeJwtClaims(token)
  if (!claims || typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) return false
  return claims.exp * 1000 <= nowMs
}

function parseDateIso(raw) {
  if (raw === null || raw === undefined || raw === "") return undefined
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    const ms = raw < 1e12 ? raw * 1000 : raw
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
  }
  const s = trimStr(raw)
  if (!s || s === "0") return undefined
  if (/^\d{10,16}$/.test(s)) {
    const n = Number(s)
    const ms = n < 1e12 ? n * 1000 : n
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
  }
  // MiniMax Design wallet dates often come as MM/DD/YYYY (e.g. "09/29/2027")
  const mdy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s)
  if (mdy) {
    const [, mm, dd, yyyy] = mdy
    const d = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), 0, 0, 0))
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
  }
  const parsed = Date.parse(s)
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString()
}

function formatCredits(n, lang = "zh") {
  const v = num(n)
  if (v === undefined) return String(n ?? 0)
  const formatted = Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")
  return lang === "zh" ? `${formatted} 积分` : `${formatted} credits`
}

// ---- site-scoped HTTP fetch (cross-region redirect & HTTPS guard) ------------

class OtherSite extends Error {
  constructor(site, what, from, to, status) {
    const hint =
      site.region === "overseas"
        ? `MiniMax redirects mainland-China networks to its China site; configure a proxy outside mainland China for ${site.name} or use minimax-design instead.`
        : `MiniMax redirected ${from.host} to ${to.host}; check your network/proxy or use minimax-design-global if your account is on the Global site.`
    super(`${what}: ${from.host} redirected to ${to.host} (HTTP ${status}), which does not accept ${site.name} credentials. ${hint}`)
    this.from = from.host
    this.to = to.host
    this.status = status
  }
}

async function siteFetch(site, url, init = {}, { fetchImpl = globalThis.fetch, what = site.name } = {}) {
  let at
  try {
    at = new URL(url)
  } catch {
    throw new Error(`${what}: invalid request URL`)
  }
  if (!isAllowedPlatformUrl(at.href, site)) {
    throw new Error(`${what}: refusing to send credentials to untrusted destination ${at.origin}`)
  }
  let method = init.method ?? "GET"
  let body = init.body
  for (let hop = 0; ; hop++) {
    const res = await fetchImpl(at.toString(), { ...init, method, body, redirect: "manual" })
    const loc = REDIRECTS.has(res.status) ? res.headers.get("location") : null
    if (!loc) return res
    let next
    try {
      next = new URL(loc, at)
    } catch {
      return res
    }
    if (next.protocol !== "https:") {
      await res.body?.cancel?.().catch(() => {})
      throw new Error(`${what}: refusing insecure redirect from ${at.origin} to ${next.origin}`)
    }
    if (next.host !== at.host) {
      await res.body?.cancel?.().catch(() => {})
      throw new OtherSite(site, what, at, next, res.status)
    }
    const preserveMethod = res.status === 307 || res.status === 308
    if (hop >= 5 || (preserveMethod && body !== undefined && body !== null && typeof body !== "string")) return res
    await res.body?.cancel?.().catch(() => {})
    if (!preserveMethod && method !== "GET" && method !== "HEAD") {
      method = "GET"
      body = undefined
    }
    at = next
  }
}

// ---- desktop credential decryption (read-only) -------------------------------

function decryptV2Token(value, keyBuf, lang = "zh") {
  if (typeof value !== "string" || !value) return ""
  if (value.startsWith(LEGACY_ENCRYPTED_PREFIX)) {
    throw Object.assign(
      new Error(
        msg(
          lang,
          "检测到旧版 safeStorage 加密格式，请升级或重新登录 MiniMax Design 桌面端，或改用「粘贴 accessToken」",
          "Detected legacy safeStorage encryption format; update or sign in to MiniMax Design again, or use Paste accessToken",
        ),
      ),
      { code: "unreadable" },
    )
  }
  if (!value.startsWith(ENCRYPTED_V2_PREFIX)) return value
  if (!Buffer.isBuffer(keyBuf) || keyBuf.length !== 32) {
    throw Object.assign(
      new Error(msg(lang, ".token-key 长度异常（应为 32 字节）", ".token-key has an invalid length (expected 32 bytes)")),
      { code: "unreadable" },
    )
  }
  const parts = value.slice(ENCRYPTED_V2_PREFIX.length).split(":")
  if (parts.length !== 3) {
    throw Object.assign(new Error(msg(lang, "v2enc 密文格式异常", "Malformed v2enc ciphertext format")), { code: "unreadable" })
  }
  const [ivB64, tagB64, ctB64] = parts
  const iv = Buffer.from(ivB64, "base64")
  const tag = Buffer.from(tagB64, "base64")
  const ct = Buffer.from(ctB64, "base64")
  if (iv.length === 0 || tag.length !== 16) {
    throw Object.assign(
      new Error(msg(lang, "v2enc IV 或 AuthTag 长度异常", "Invalid v2enc IV or 16-byte AuthTag length")),
      { code: "unreadable" },
    )
  }
  const decipher = createDecipheriv("aes-256-gcm", keyBuf, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8")
}

function candidateDataDirs(site, { homedir = osHomedir(), platform = process.platform, env = process.env } = {}) {
  const override = trimStr(env.MINIMAX_DESIGN_DATA_DIR) || trimStr(env.HILO_USER_DATA_DIR)
  if (override) return [override]

  const pathJoin = platform === "win32" ? win32.join : posix.join
  let appBase
  if (platform === "darwin") {
    appBase = pathJoin(homedir, "Library", "Application Support")
  } else if (platform === "win32") {
    appBase = trimStr(env.APPDATA) || pathJoin(homedir, "AppData", "Roaming")
  } else {
    appBase = trimStr(env.XDG_CONFIG_HOME) || pathJoin(homedir, ".config")
  }

  const names =
    site.region === "overseas"
      ? ["MiniMax Hub Global", pathJoin("@hilo", "desktop"), "MiniMax Hub", "MiniMax Design"]
      : [pathJoin("@hilo", "desktop"), "MiniMax Hub", "MiniMax Design"]

  const dirs = []
  for (const name of names) {
    const p = pathJoin(appBase, name)
    if (!dirs.includes(p)) dirs.push(p)
  }
  return dirs
}

function inferRegionFromConfig(cfg, lkgConfig, dataDir, configFile) {
  if (isRecord(lkgConfig?.provider)) {
    for (const p of Object.values(lkgConfig.provider)) {
      const base = trimStr(p?.options?.baseURL) || trimStr(p?.api)
      if (!base) continue
      if (/minimaxi\.com|minimax\.cn/i.test(base)) return "domestic"
      if (/minimax\.io/i.test(base)) return "overseas"
    }
  }
  const adUrl = trimStr(cfg?.tokens?.adAttribution?.url)
  if (adUrl) {
    if (/minimaxi\.com|minimax\.cn/i.test(adUrl)) return "domestic"
    if (/minimax\.io/i.test(adUrl)) return "overseas"
  }
  if (typeof configFile === "string" && /-global\.json$/i.test(configFile)) return "overseas"
  if (typeof dataDir === "string" && /\bGlobal$/i.test(dataDir)) return "overseas"
  return undefined
}

function readTokenKey(dir, { readFileImpl, lstatImpl, lang = "zh" } = {}) {
  const keyPath = join(dir, ".token-key")
  const lstat = lstatImpl ?? ((p) => lstatSync(p))
  const readFile = readFileImpl ?? ((p) => readFileSync(p))
  let st
  try {
    st = lstat(keyPath)
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw Object.assign(
        new Error(msg(lang, "缺少 .token-key 文件，无法解密登录态", "Missing .token-key file; cannot decrypt desktop sign-in")),
        { code: "unreadable" },
      )
    }
    throw Object.assign(new Error(error?.message ?? msg(lang, "无法读取 .token-key", "Could not stat .token-key")), { code: "unreadable" })
  }
  if (!st.isFile()) {
    throw Object.assign(
      new Error(msg(lang, ".token-key 不是常规文件", ".token-key is not a regular file")),
      { code: "unreadable" },
    )
  }
  let buf
  try {
    buf = readFile(keyPath)
  } catch (error) {
    throw Object.assign(new Error(error?.message ?? msg(lang, "无法读取 .token-key", "Could not read .token-key")), { code: "unreadable" })
  }
  const keyBuf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  if (keyBuf.length !== 32) {
    throw Object.assign(
      new Error(msg(lang, ".token-key 长度异常（应为 32 字节）", ".token-key has an invalid length (expected 32 bytes)")),
      { code: "unreadable" },
    )
  }
  return keyBuf
}

function readDesktopCredentialFromDir(dir, site, { readFileImpl, lstatImpl, nowMs = Date.now(), configFile } = {}) {
  const readFile = readFileImpl ?? ((p) => readFileSync(p))
  const lang = site.lang
  const candidates = configFile ? [configFile] : site.configFiles ?? ["hub-config.json"]

  let chosenFile = null
  let rawBuf = null
  let lastNotFound = null
  for (const filename of candidates) {
    try {
      rawBuf = readFile(join(dir, filename))
      chosenFile = filename
      break
    } catch (error) {
      if (error?.code === "ENOENT") {
        lastNotFound = error
        continue
      }
      throw error
    }
  }
  if (!chosenFile) {
    throw lastNotFound ?? Object.assign(new Error("ENOENT"), { code: "ENOENT" })
  }

  const configPath = join(dir, chosenFile)
  const rawText = Buffer.isBuffer(rawBuf) ? rawBuf.toString("utf8") : String(rawBuf)
  let cfg
  try {
    cfg = JSON.parse(rawText)
  } catch {
    throw Object.assign(
      new Error(msg(lang, `${chosenFile} 不是有效 JSON`, `${chosenFile} is not valid JSON`)),
      { code: "unreadable" },
    )
  }
  if (!isRecord(cfg)) {
    throw Object.assign(
      new Error(msg(lang, `${chosenFile} 格式异常`, `${chosenFile} has an unexpected format`)),
      { code: "unreadable" },
    )
  }

  const rawAccess = cfg?.tokens?.accessToken
  if (typeof rawAccess !== "string" || !rawAccess.trim()) {
    throw Object.assign(
      new Error(
        msg(
          lang,
          `${chosenFile} 中没有 accessToken（尚未登录 MiniMax Design）`,
          `${chosenFile} has no accessToken (not signed in to MiniMax Design)`,
        ),
      ),
      { code: "missing" },
    )
  }

  let keyBuf = null
  const needsKey =
    rawAccess.startsWith(ENCRYPTED_V2_PREFIX) ||
    (typeof cfg.lkgProviderConfig === "string" && cfg.lkgProviderConfig.startsWith(ENCRYPTED_V2_PREFIX))
  if (needsKey) {
    keyBuf = readTokenKey(dir, { readFileImpl, lstatImpl, lang })
  }

  const token = decryptV2Token(rawAccess, keyBuf, lang).trim()
  if (!token) {
    throw Object.assign(
      new Error(msg(lang, "解密后的 accessToken 为空", "Decrypted accessToken is empty")),
      { code: "unreadable" },
    )
  }
  if (isExpiredJwt(token, nowMs)) {
    throw Object.assign(
      new Error(
        msg(
          lang,
          "MiniMax Design 登录已过期，请打开 MiniMax Design 重新登录后重试",
          "MiniMax Design desktop sign-in has expired; reopen MiniMax Design and sign in again",
        ),
      ),
      { code: "expired" },
    )
  }

  let lkgConfig = null
  if (typeof cfg.lkgProviderConfig === "string" && cfg.lkgProviderConfig.trim()) {
    try {
      const lkgText = decryptV2Token(cfg.lkgProviderConfig, keyBuf, lang)
      const parsedLkg = JSON.parse(lkgText)
      if (isRecord(parsedLkg)) lkgConfig = parsedLkg
    } catch {
      // LKG is optional fallback metadata; ignore corrupt LKG
    }
  }

  const detectedRegion = inferRegionFromConfig(cfg, lkgConfig, dir, chosenFile)
  if (detectedRegion && detectedRegion !== site.region) {
    const otherId = detectedRegion === "overseas" ? "minimax-design-global" : "minimax-design"
    throw Object.assign(
      new Error(
        msg(
          lang,
          `本机 MiniMax Design 登录的是${detectedRegion === "overseas" ? "国际版" : "中国区"}账号，请改用 ${otherId}`,
          `Local MiniMax Design is signed into the ${detectedRegion === "overseas" ? "Global" : "China"} region; use ${otherId} instead`,
        ),
      ),
      { code: "region_mismatch", detectedRegion },
    )
  }

  const userId = idStr(cfg?.user?.userID)
  const userName = trimStr(cfg?.user?.userName)
  const groupId = userId && isRecord(cfg?.selectedGroupIds) ? idStr(cfg.selectedGroupIds[userId]) : undefined
  const deviceId = trimStr(cfg?.deviceId)
  const tokenOwnerId = jwtOwnerId(token)

  return {
    key: token,
    userId,
    tokenOwnerId,
    userName,
    groupId,
    deviceId,
    lkgConfig,
    region: detectedRegion ?? site.region,
    regionConfirmed: Boolean(detectedRegion),
    source: configPath,
    configFile: chosenFile,
    dataDir: dir,
  }
}

function readDesktopCredential(
  site,
  { homedir = osHomedir(), platform = process.platform, env = process.env, readFileImpl, lstatImpl, nowMs = Date.now() } = {},
) {
  const dirs = candidateDataDirs(site, { homedir, platform, env })
  const problems = []
  let regionMismatch = null
  let expiredError = null

  for (const dir of dirs) {
    try {
      return readDesktopCredentialFromDir(dir, site, { readFileImpl, lstatImpl, nowMs })
    } catch (error) {
      if (error?.code === "ENOENT") continue
      if (error?.code === "expired") {
        expiredError = error
        continue
      }
      if (error?.code === "region_mismatch") {
        regionMismatch = error
        continue
      }
      if (error?.code === "missing") continue
      problems.push(`${dir} (${error?.message ?? msg(site.lang, "读取失败", "read failed")})`)
    }
  }

  if (expiredError) throw expiredError
  if (regionMismatch && !problems.length) throw regionMismatch

  const detail = problems.length ? (site.lang === "zh" ? `：${problems.join("；")}` : `: ${problems.join("; ")}`) : ""
  const message =
    site.lang === "zh"
      ? problems.length
        ? `MiniMax Design 桌面端登录态读不出来${detail}。请先启动 MiniMax Design 并登录，或改用「粘贴 accessToken」方式。`
        : "未找到 MiniMax Design 桌面端登录态。请先启动 MiniMax Design 并登录，或改用「粘贴 accessToken」方式。"
      : problems.length
        ? `Could not read MiniMax Design desktop sign-in${detail}. Open MiniMax Design and sign in, or use Paste accessToken.`
        : "MiniMax Design desktop sign-in not found. Install/open MiniMax Design and sign in, or use Paste accessToken."

  throw Object.assign(new Error(message), { code: problems.length ? "unreadable" : "missing" })
}

function probeDesktopCredential(site, deps) {
  try {
    return { cred: readDesktopCredential(site, deps) }
  } catch (error) {
    return { error }
  }
}

async function waitForDesktopCredential({ read, sleep, now, signal, waitMs = DESKTOP_WAIT_MS, stepMs = DESKTOP_POLL_MS }) {
  const deadline = now() + waitMs
  for (;;) {
    if (signal?.aborted) return { status: "aborted" }
    const trial = await read()
    if (trial.cred) return { status: "ready", cred: trial.cred }
    if (trial.error?.code === "region_mismatch") return { status: "failed", error: trial.error }
    if (now() >= deadline) return { status: "timeout", error: trial.error }
    await sleep(stepMs)
  }
}

function reasonOf(site, error) {
  if (["unreadable", "expired", "region_mismatch"].includes(error?.code) && error?.message) return error.message
  return msg(site.lang, "本机没有读到 MiniMax Design 桌面端登录态", "No local MiniMax Design desktop sign-in found")
}

// ---- model catalog -----------------------------------------------------------

function isAllowedPlatformUrl(rawUrl, site) {
  try {
    const u = new URL(rawUrl)
    if (u.protocol !== "https:") return false
    return site.allowedHosts.includes(u.hostname)
  } catch {
    return false
  }
}

function normalizeLimit(raw) {
  const input = posInt(raw?.input)
  const rawContext = posInt(raw?.context)
  const context = Math.max(rawContext, input)
  const output = posInt(raw?.output)
  return {
    context,
    ...(input ? { input } : {}),
    output,
  }
}

function normalizeInputs(raw) {
  const list = Array.isArray(raw) ? raw.filter((k) => typeof k === "string" && MODALITIES.includes(k)) : []
  if (!list.includes("text")) list.unshift("text")
  return MODALITIES.filter((k) => list.includes(k))
}

function configEntryFromModel(site, m) {
  const inputs = normalizeInputs(m.inputs)
  const base = m.url || site.defaultLlmBase
  const npm = m.npm || "@ai-sdk/anthropic"
  const attachment = typeof m.attachment === "boolean" ? m.attachment : inputs.length > 1
  return {
    id: m.apiId || m.id,
    name: m.name || m.id,
    provider: { npm, api: base },
    reasoning: Boolean(m.reasoning),
    attachment,
    tool_call: m.tool_call !== false,
    temperature: m.temperature !== false,
    modalities: { input: inputs, output: ["text"] },
    limit: normalizeLimit(m.limit),
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    ...(isRecord(m.options) && Object.keys(m.options).length ? { options: m.options } : {}),
    ...(isRecord(m.variants) && Object.keys(m.variants).length ? { variants: m.variants } : {}),
  }
}

function internalModelFromSpec(site, providerID, m) {
  const inputs = normalizeInputs(m.inputs)
  const base = m.url || site.defaultLlmBase
  const npm = m.npm || "@ai-sdk/anthropic"
  const attachment = typeof m.attachment === "boolean" ? m.attachment : inputs.length > 1
  return {
    id: m.id,
    providerID,
    name: m.name || m.id,
    api: { id: m.apiId || m.id, url: base, npm },
    status: "active",
    headers: {},
    options: isRecord(m.options) ? m.options : {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: normalizeLimit(m.limit),
    capabilities: {
      temperature: m.temperature !== false,
      reasoning: Boolean(m.reasoning),
      attachment,
      toolcall: m.tool_call !== false,
      input: Object.fromEntries(MODALITIES.map((k) => [k, inputs.includes(k)])),
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: isRecord(m.variants) ? m.variants : {},
  }
}

function bootstrapConfigModels(site) {
  return {
    ...Object.fromEntries(BOOTSTRAP.map((m) => [m.id, configEntryFromModel(site, m)])),
    ...mediaBootstrapConfigModels(site),
  }
}

function parseRemoteConfig(site, body) {
  if (!isRecord(body) || !isRecord(body.provider)) return null
  const enabled = Array.isArray(body.enabled_providers) ? new Set(body.enabled_providers.map(String)) : null
  const specs = []
  const seen = new Set()

  for (const [upstreamId, prov] of Object.entries(body.provider)) {
    if (enabled && !enabled.has(upstreamId)) continue
    if (!isRecord(prov) || !isRecord(prov.models)) continue
    const npm = trimStr(prov.npm) || "@ai-sdk/anthropic"
    if (!SUPPORTED_NPMS.has(npm)) continue
    const rawBase = trimStr(prov.options?.baseURL) || trimStr(prov.api) || site.defaultLlmBase
    const url = isAllowedPlatformUrl(rawBase, site) ? rawBase.replace(/\/+$/, "") : site.defaultLlmBase

    for (const [modelKey, raw] of Object.entries(prov.models)) {
      if (!isRecord(raw)) continue
      const upstreamKey = trimStr(modelKey)
      if (!upstreamKey) continue
      const explicitApiId = trimStr(raw.id)
      const apiId = explicitApiId || upstreamKey
      const alias = TEXT_MODEL_ALIASES[upstreamKey] ?? (!explicitApiId ? TEXT_MODEL_ALIASES[apiId] : undefined)
      const id = alias?.id ?? upstreamKey
      if (seen.has(id)) continue
      seen.add(id)
      const name = alias?.name ?? (trimStr(raw.display_name) || trimStr(raw.name) || id)
      const inputs = normalizeInputs(raw.modalities?.input)
      specs.push({
        id,
        apiId,
        name,
        npm,
        url,
        attachment: typeof raw.attachment === "boolean" ? raw.attachment : inputs.length > 1,
        reasoning: Boolean(raw.reasoning),
        tool_call: raw.tool_call !== false,
        temperature: raw.temperature !== false,
        inputs,
        limit: normalizeLimit(raw.limit),
        options: isRecord(raw.options) ? raw.options : {},
        variants: isRecord(raw.variants) ? raw.variants : {},
      })
    }
  }

  return specs
}

// ---- cloud API calls & usage parsing -----------------------------------------

function buildApiHeaders(cred, versionCode) {
  const headers = {
    accept: "application/json",
    token: cred.token,
    version_code: versionCode,
  }
  if (cred.groupId) headers["X-Group-Id"] = cred.groupId
  if (cred.deviceId) headers.device_id = cred.deviceId
  return headers
}

async function fetchAccountProfile(site, cred, versionCode, fetchImpl) {
  const res = await siteFetch(
    site,
    `${site.cloud}/api/v1/account/profile`,
    { headers: buildApiHeaders(cred, versionCode), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    { fetchImpl, what: `${site.name} profile` },
  )
  if (res.status === 401) {
    throw Object.assign(
      new Error(
        msg(
          site.lang,
          `${site.name} 拒绝了该凭据（HTTP 401），请重新登录`,
          `${site.name} rejected the credential (HTTP 401); please sign in again`,
        ),
      ),
      { signIn: "expired", status: 401 },
    )
  }
  if (res.status === 403) {
    const text = await res.text().catch(() => "")
    if (isAuthError403(403, text)) {
      throw Object.assign(
        new Error(
          msg(
            site.lang,
            `${site.name} 拒绝了该凭据（HTTP 403），请重新登录`,
            `${site.name} rejected the credential (HTTP 403); please sign in again`,
          ),
        ),
        { signIn: "expired", status: 403 },
      )
    }
    const { errCode, errMsg } = parseErrorBody(text)
    if (errCode === "client_upgrade_required") {
      throw Object.assign(
        new Error(`${site.name} profile: ${errMsg} (set MINIMAX_DESIGN_VERSION_CODE to override)`),
        { status: 403, code: errCode },
      )
    }
    throw Object.assign(new Error(`${site.name} profile: HTTP 403${errMsg ? ` (${errMsg})` : ""}`), { status: 403 })
  }
  if (!res.ok) throw new Error(`${site.name} profile: HTTP ${res.status}`)
  const body = await res.json().catch(() => null)
  if (!isRecord(body)) throw new Error(`${site.name} profile: invalid JSON`)
  return {
    uid: idStr(body.uid),
    userName: trimStr(body.user_name),
    account: trimStr(body.account),
  }
}

async function fetchRemoteConfig(site, cred, versionCode, fetchImpl) {
  const res = await siteFetch(
    site,
    `${site.cloud}/api/v1/config`,
    { headers: buildApiHeaders(cred, versionCode), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    { fetchImpl, what: `${site.name} config` },
  )
  if (res.status === 401) {
    throw Object.assign(
      new Error(
        msg(
          site.lang,
          `${site.name} 登录态已失效（HTTP 401），请重新登录`,
          `${site.name} sign-in expired (HTTP 401); please sign in again`,
        ),
      ),
      { signIn: "expired", status: 401 },
    )
  }
  if (res.status === 403) {
    const text = await res.text().catch(() => "")
    if (isAuthError403(403, text)) {
      throw Object.assign(
        new Error(
          msg(
            site.lang,
            `${site.name} 登录态已失效（HTTP 403），请重新登录`,
            `${site.name} sign-in expired (HTTP 403); please sign in again`,
          ),
        ),
        { signIn: "expired", status: 403 },
      )
    }
    const { errCode, errMsg } = parseErrorBody(text)
    throw Object.assign(
      new Error(`${site.name} config: HTTP 403${errMsg ? ` (${errMsg})` : ""}`),
      { status: 403, ...(errCode ? { code: errCode } : {}) },
    )
  }
  if (!res.ok) throw new Error(`${site.name} config: HTTP ${res.status}`)
  const body = await res.json().catch(() => null)
  const specs = parseRemoteConfig(site, body)
  if (specs === null) throw new Error(`${site.name} config: invalid provider payload`)
  return specs
}

async function fetchRemoteModelsConfig(site, cred, versionCode, fetchImpl) {
  const res = await siteFetch(
    site,
    `${site.cloud}/api/v1/models/config`,
    { headers: buildApiHeaders(cred, versionCode), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    { fetchImpl, what: `${site.name} media models` },
  )
  if (res.status === 401) {
    throw Object.assign(
      new Error(
        msg(
          site.lang,
          `${site.name} 登录态已失效（HTTP 401），请重新登录`,
          `${site.name} sign-in expired (HTTP 401); please sign in again`,
        ),
      ),
      { signIn: "expired", status: 401 },
    )
  }
  if (res.status === 403) {
    const text = await res.text().catch(() => "")
    if (isAuthError403(403, text)) {
      throw Object.assign(
        new Error(
          msg(
            site.lang,
            `${site.name} 登录态已失效（HTTP 403），请重新登录`,
            `${site.name} sign-in expired (HTTP 403); please sign in again`,
          ),
        ),
        { signIn: "expired", status: 403 },
      )
    }
    return null
  }
  if (!res.ok) return null
  const body = await res.json().catch(() => null)
  return parseModelsConfig(body)
}

// Prepaid credit wallets report a numeric remaining balance (without `used`,
// `limit`, or `aside`) so magpie can route away from 0-credit accounts and rank
// higher-balance accounts ahead on ties, while sub-credit expiry batches stay
// in `aside` windows.
function usageFromWallet(site, walletBody, nowMs = Date.now(), { renewed = false } = {}) {
  const wallets = Array.isArray(walletBody?.wallets) ? walletBody.wallets.filter(isRecord) : []
  if (!wallets.length) return null
  const primary = wallets.find((w) => w.source === 1) ?? wallets[0]
  const total = num(primary.total_credit)
  if (total === undefined) return null
  const plan = trimStr(primary.plan_name)
  const until = parseDateIso(primary.end_time)
  const labels = CREDIT_TYPE_LABELS[site.lang] ?? CREDIT_TYPE_LABELS.en
  const unit = site.lang === "zh" ? "积分" : "credits"

  const windows = [
    {
      name: site.lang === "zh" ? "积分" : "Credits",
      balance: total,
      unit,
    },
  ]
  const subs = Array.isArray(primary.sub_credits) ? primary.sub_credits.filter(isRecord) : []
  for (const sub of subs) {
    const amount = num(sub.credit)
    if (amount === undefined || amount <= 0) continue
    const typeId = Number(sub.credit_type)
    const name = labels[typeId] ?? (site.lang === "zh" ? `积分类型 ${typeId}` : `Credits #${typeId}`)
    const batches = new Map()
    const records = Array.isArray(sub.records) ? sub.records.filter(isRecord) : []
    for (const r of records) {
      const rCredit = num(r.credit)
      const rEnd = num(r.end_time)
      if (rCredit && rCredit > 0 && rEnd && rEnd > nowMs) {
        batches.set(rEnd, (batches.get(rEnd) ?? 0) + rCredit)
      }
    }
    let soonest = null
    for (const [endMs, batchAmount] of batches.entries()) {
      if (!soonest || endMs < soonest.endMs) soonest = { endMs, amount: batchAmount }
    }
    if (!soonest) {
      const subEnd = num(sub.end_time)
      if (subEnd && subEnd > nowMs) soonest = { endMs: subEnd, amount }
    }
    windows.push({
      name,
      display: formatCredits(amount, site.lang),
      aside: true,
      ...(soonest ? { runsOutAt: new Date(soonest.endMs).toISOString(), runsOut: soonest.amount } : {}),
    })
  }

  return {
    ...(plan ? { plan } : {}),
    ...(until ? { until } : {}),
    windows,
    ...(renewed ? { signIn: "renewed" } : {}),
  }
}

function usageFromBalance(site, balanceBody, { hasGroupId = false, renewed = false } = {}) {
  if (!isRecord(balanceBody)) return null
  const total = num(balanceBody.total_credit)
  const team = num(balanceBody.team_credit)
  const primary = hasGroupId && team !== undefined ? team : total
  if (primary === undefined) return null
  const unit = site.lang === "zh" ? "积分" : "credits"

  const windows = [
    {
      name: hasGroupId && team !== undefined ? (site.lang === "zh" ? "团队积分" : "Team Credits") : site.lang === "zh" ? "积分" : "Credits",
      balance: primary,
      unit,
    },
  ]
  if (hasGroupId && team !== undefined && total !== undefined && total !== team) {
    windows.push({
      name: site.lang === "zh" ? "总积分" : "Total Credits",
      display: formatCredits(total, site.lang),
      aside: true,
    })
  } else if (!hasGroupId && team !== undefined && team > 0 && team !== primary) {
    windows.push({
      name: site.lang === "zh" ? "团队积分" : "Team Credits",
      display: formatCredits(team, site.lang),
      aside: true,
    })
  }
  return {
    windows,
    ...(renewed ? { signIn: "renewed" } : {}),
  }
}

// ---- response error normalization --------------------------------------------

function jsonErrorResponse(status, message, fields = {}, extraHeaders = {}) {
  return new Response(JSON.stringify({ error: { message, ...fields } }), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  })
}

function parseErrorBody(text) {
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {}
  const errCode = (trimStr(parsed?.error?.code) || trimStr(parsed?.code) || "").toLowerCase()
  const errMsg = trimStr(parsed?.error?.message) || trimStr(parsed?.message) || text.slice(0, 400)
  return { errCode, errMsg }
}

function isAuthError403(status, text) {
  if (status !== 403) return false
  const { errCode, errMsg } = parseErrorBody(text)
  if (errCode === "client_upgrade_required") return false
  return AUTH_ERROR_PATTERN.test(errMsg) || AUTH_ERROR_PATTERN.test(errCode)
}

function isCreditExhausted(status, errCode, errMsg) {
  if (status === 402) return true
  if (status !== 403) return false
  if (CREDIT_EXHAUSTED_CODES.has(errCode)) return true
  return CREDIT_EXHAUSTED_PATTERN.test(errMsg)
}

async function normalizeUpstreamResponse(site, res, renewed, preReadText = null) {
  const headers = new Headers(res.headers)
  if (res.ok) {
    headers.set("X-Magpie-Sign-In", renewed ? "renewed" : "kept")
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  }
  if (res.status === 401) {
    headers.set("X-Magpie-Sign-In", "expired")
    return new Response(preReadText !== null ? preReadText : res.body, { status: 401, statusText: res.statusText, headers })
  }
  // Pass through rate limits (429) and non-402/403 statuses untouched so
  // upstream Retry-After and rate-limit error types are preserved intact.
  if (res.status !== 402 && res.status !== 403) {
    headers.set("X-Magpie-Sign-In", "kept")
    return new Response(preReadText !== null ? preReadText : res.body, { status: res.status, statusText: res.statusText, headers })
  }

  const text = preReadText !== null ? preReadText : await res.text()
  const { errCode, errMsg } = parseErrorBody(text)

  if (errCode === "client_upgrade_required") {
    return jsonErrorResponse(
      403,
      `${site.name}: ${errMsg} (set MINIMAX_DESIGN_VERSION_CODE to override the client version header)`,
      { type: "permission_error", code: errCode },
      { "X-Magpie-Sign-In": "kept" },
    )
  }

  if (isAuthError403(res.status, text)) {
    headers.set("X-Magpie-Sign-In", "expired")
    return new Response(text, { status: 401, statusText: "Unauthorized", headers })
  }

  if (isCreditExhausted(res.status, errCode, errMsg)) {
    return jsonErrorResponse(
      429,
      errMsg || `${site.name}: insufficient credits`,
      { type: "rate_limit_error", code: "insufficient_credits" },
      { "X-Magpie-Sign-In": "kept" },
    )
  }

  headers.set("X-Magpie-Sign-In", "kept")
  return new Response(text, { status: res.status, statusText: res.statusText, headers })
}

// ---- plugin factory ----------------------------------------------------------

function authResult(cred, profile) {
  // Prefer authoritative profile uid when available; callers already reject
  // contradictory cred.userId vs profile.uid before building authResult.
  const userId = profile?.uid || cred.userId
  const name = profile?.userName || cred.userName || profile?.account || userId
  return {
    type: "success",
    key: cred.key,
    accountId: userId || name,
    metadata: {
      name,
      userId,
      tokenOwnerId: cred.tokenOwnerId ?? jwtOwnerId(cred.key),
      groupId: cred.groupId,
      deviceId: cred.deviceId,
      region: cred.region,
      source: cred.source,
      configFile: cred.configFile,
      dataDir: cred.dataDir,
      method: cred.method ?? "desktop",
    },
  }
}

function createPlugin(
  site,
  {
    fetchImpl = globalThis.fetch,
    env = process.env,
    readFileImpl,
    lstatImpl,
    statImpl,
    homedir = osHomedir(),
    platform = process.platform,
    sleepImpl,
    nowMsImpl = () => Date.now(),
    versionCode,
    pollIntervalMs,
    maxWaitMs,
  } = {},
) {
  const sleep = sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const resolvedVersion = normalizeVersionCode(versionCode ?? detectInstalledVersion({ env, platform, readFileImpl }))
  const modelCache = new Map() // cacheKey -> { at, specs, mediaSpecs }
  const diskCache = new Map() // cacheKey -> { mtimeMs, cred }
  const verifiedTokenOwners = new Map() // token -> { uid, expiresAt }
  // In-memory only: keeps verified rotated tokens alive across desktop account
  // switches during this host process; a host restart falls back to the stored auth.
  const retainedDesktopCreds = new Map() // expectedUserId -> { token, groupId, deviceId, lkgConfig }
  const canonicalToApiId = new Map(
    site.region === "domestic"
      ? BOOTSTRAP.filter((m) => m.apiId && m.apiId !== m.id).map((m) => [m.id, m.apiId])
      : [],
  )
  let latestMediaSpecs = null

  function recordTextAliases(specs) {
    for (const m of specs) {
      if (m.id && m.apiId) canonicalToApiId.set(m.id, m.apiId)
    }
  }

  function mergeMediaLookupSpecs(liveSpecs) {
    const out = []
    const seen = new Set()
    for (const s of liveSpecs ?? []) {
      if (seen.has(s.id)) continue
      seen.add(s.id)
      out.push(s)
    }
    for (const s of _mediaInternal.BOOTSTRAP_MEDIA) {
      if (seen.has(s.id)) continue
      seen.add(s.id)
      const { regions: _r, ...rest } = s
      out.push(rest)
    }
    return out
  }

  function setBounded(map, key, value, maxSize = OWNER_CACHE_MAX) {
    if (map.has(key)) map.delete(key)
    map.set(key, value)
    while (map.size > maxSize) {
      const oldest = map.keys().next().value
      map.delete(oldest)
    }
  }

  function setOwnerCache(token, uid, expiresAt) {
    setBounded(verifiedTokenOwners, token, { uid, expiresAt })
  }

  function readLiveDesktopForAuth(auth, { force = false } = {}) {
    const meta = isRecord(auth?.metadata) ? auth.metadata : {}
    if (meta.method !== "desktop") return null
    const expectedUserId = idStr(meta.userId)
    // Require a verified saved userId before reusing a live desktop session;
    // otherwise keep the saved credential so accounts can never cross-charge.
    if (!expectedUserId) return null
    const dataDir = trimStr(meta.dataDir)
    const stat = statImpl ?? ((p) => statSync(p))
    if (!dataDir) return null

    const configFile = trimStr(meta.configFile) || (site.configFiles?.[0] ?? "hub-config.json")
    const configPath = join(dataDir, configFile)
    const cacheKey = `${dataDir}\0${configFile}`
    let mtimeMs = 0
    try {
      mtimeMs = stat(configPath).mtimeMs
    } catch {
      diskCache.delete(cacheKey)
      return null
    }
    const cached = !force ? diskCache.get(cacheKey) : null
    if (cached && cached.mtimeMs === mtimeMs && !isExpiredJwt(cached.cred.key, nowMsImpl())) {
      return cached.cred.userId === expectedUserId ? cached.cred : null
    }
    try {
      const fresh = readDesktopCredentialFromDir(dataDir, site, {
        readFileImpl,
        lstatImpl,
        nowMs: nowMsImpl(),
        configFile,
      })
      diskCache.set(cacheKey, { mtimeMs, cred: fresh })
      return fresh.userId === expectedUserId ? fresh : null
    } catch {
      return null
    }
  }

  // Verify newly rotated desktop tokens against both JWT owner claims and
  // /api/v1/account/profile to prevent the persistAuthTokens account-switch
  // race where tokens are written to disk before user.userID is updated.
  async function verifyRotatedDesktopToken(live, meta, expectedUserId) {
    const savedOwner = trimStr(meta.tokenOwnerId)
    const liveOwner = live.tokenOwnerId ?? jwtOwnerId(live.key)
    if (savedOwner && liveOwner && savedOwner !== liveOwner) {
      return false
    }
    const now = nowMsImpl()
    const cached = verifiedTokenOwners.get(live.key)
    if (cached && cached.expiresAt > now) {
      return cached.uid === expectedUserId
    }
    try {
      const profile = await fetchAccountProfile(
        site,
        { token: live.key, groupId: live.groupId, deviceId: live.deviceId },
        resolvedVersion,
        fetchImpl,
      )
      if (!profile.uid) {
        setOwnerCache(live.key, null, now + OWNER_VERIFY_FAIL_TTL_MS)
        return false
      }
      setOwnerCache(live.key, profile.uid, Number.POSITIVE_INFINITY)
      return profile.uid === expectedUserId
    } catch {
      // Short negative cache prevents repeated 15s profile timeouts while offline
      // or during a transient upstream outage, then retries after 30s.
      setOwnerCache(live.key, null, now + OWNER_VERIFY_FAIL_TTL_MS)
      return false
    }
  }

  async function resolveCredential(auth, { forceRefresh = false } = {}) {
    if (!auth || auth.type !== "api" || !trimStr(auth.key)) return null
    const meta = isRecord(auth.metadata) ? auth.metadata : {}
    const expectedUserId = idStr(meta.userId)
    const live = readLiveDesktopForAuth(auth, { force: forceRefresh })
    if (live) {
      const rotated = live.key !== auth.key.trim()
      let accepted = true
      if (rotated) {
        accepted = await verifyRotatedDesktopToken(live, meta, expectedUserId)
      }
      if (accepted) {
        const resolved = {
          token: live.key,
          userId: live.userId,
          // Authoritative live workspace selection: if deselected on disk, send no X-Group-Id.
          groupId: live.groupId,
          deviceId: live.deviceId ?? trimStr(meta.deviceId),
          lkgConfig: live.lkgConfig,
          renewedFromSaved: rotated,
        }
        if (rotated && expectedUserId) {
          setBounded(retainedDesktopCreds, expectedUserId, {
            token: resolved.token,
            groupId: resolved.groupId,
            deviceId: resolved.deviceId,
            lkgConfig: resolved.lkgConfig,
          })
        }
        return resolved
      }
    }
    if (meta.method === "desktop" && expectedUserId) {
      const retained = retainedDesktopCreds.get(expectedUserId)
      if (retained && !isExpiredJwt(retained.token, nowMsImpl())) {
        return {
          token: retained.token,
          userId: expectedUserId,
          groupId: retained.groupId,
          deviceId: retained.deviceId,
          lkgConfig: retained.lkgConfig,
          renewedFromSaved: retained.token !== auth.key.trim(),
        }
      }
    }
    return {
      token: auth.key.trim(),
      userId: expectedUserId,
      groupId: idStr(meta.groupId) ?? trimStr(env.MINIMAX_DESIGN_GROUP_ID),
      deviceId: trimStr(meta.deviceId),
      lkgConfig: null,
      renewedFromSaved: false,
    }
  }

  async function finalizeDesktopCred(cred) {
    let profile = null
    try {
      profile = await fetchAccountProfile(
        site,
        { token: cred.key, groupId: cred.groupId, deviceId: cred.deviceId },
        resolvedVersion,
        fetchImpl,
      )
    } catch (error) {
      if (error?.signIn === "expired" || error instanceof OtherSite) throw error
      // If region could not be inferred from local metadata (no LKG / adAttribution /
      // Global store name), require profile verification so cross-region tokens
      // cannot silently sign into the wrong site.
      if (!cred.regionConfirmed) {
        throw new Error(
          msg(
            site.lang,
            `无法确认本机登录态所属区域（${error?.message ?? "网络异常"}），请稍后重试或确认站点`,
            `Could not verify the desktop sign-in region (${error?.message ?? "network error"}); retry or check the selected site`,
          ),
        )
      }
    }
    if (profile?.uid && cred.userId && profile.uid !== cred.userId) {
      throw new Error(
        msg(
          site.lang,
          "检测到 MiniMax Design 正在切换账号（token 与本地用户信息不一致），请稍后重试",
          "MiniMax Design appears to be switching accounts (token owner disagrees with stored user); please retry",
        ),
      )
    }
    if (profile?.uid) setOwnerCache(cred.key, profile.uid, Number.POSITIVE_INFINITY)
    return authResult({ ...cred, method: "desktop" }, profile)
  }

  async function sendCloudRequest(getAuth, reqMethod, path, payload, { signal, timeoutMs = REQUEST_TIMEOUT_MS, label } = {}) {
    const auth = await getAuth()
    let cred = await resolveCredential(auth)
    if (!cred) {
      return {
        res: jsonErrorResponse(401, `${site.name}: not signed in`, { type: "authentication_error" }, { "X-Magpie-Sign-In": "expired" }),
        renewed: false,
      }
    }

    const url = `${site.cloud}${path}`
    const encodedBody = payload !== undefined ? JSON.stringify(payload) : undefined
    const sendOnce = async (c) => {
      const headers = buildApiHeaders(c, resolvedVersion)
      if (encodedBody !== undefined) headers["content-type"] = "application/json"
      const combinedSignal = signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs)
      return siteFetch(
        site,
        url,
        { method: reqMethod, headers, ...(encodedBody !== undefined ? { body: encodedBody } : {}), signal: combinedSignal },
        { fetchImpl, what: `${site.name} ${label ?? path}` },
      )
    }

    let res
    let preReadText = null
    let renewed = cred.renewedFromSaved
    try {
      res = await sendOnce(cred)
      let shouldRetryAuth = res.status === 401
      if (!shouldRetryAuth && res.status === 403) {
        preReadText = await res.text()
        shouldRetryAuth = isAuthError403(403, preReadText)
      }
      if (shouldRetryAuth && auth?.metadata?.method === "desktop") {
        const fresh = await resolveCredential(auth, { forceRefresh: true })
        if (fresh && fresh.token !== cred.token) {
          if (preReadText === null) await res.body?.cancel?.().catch(() => {})
          preReadText = null
          cred = fresh
          renewed = true
          res = await sendOnce(cred)
        }
      }
    } catch (error) {
      if (error instanceof OtherSite) {
        return {
          res: jsonErrorResponse(502, error.message, { type: "region_mismatch" }, { "X-Magpie-Sign-In": "kept" }),
          renewed,
        }
      }
      throw error
    }

    return { res: await normalizeUpstreamResponse(site, res, renewed, preReadText), renewed }
  }

  async function sendLlmRequest(getAuth, input, init = {}) {
    const req = input instanceof Request ? input : null
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : req?.url ?? String(input)
    const method = init.method ?? req?.method ?? "POST"

    if (mediaPath(url)) {
      let mediaBody = init.body
      if (req && mediaBody === undefined && method !== "GET" && method !== "HEAD") {
        mediaBody = await req.arrayBuffer()
      }
      return handleMediaFetch(
        url,
        { method, body: mediaBody, headers: init.headers ?? req?.headers, signal: init.signal ?? req?.signal },
        {
          site,
          cloudRequest: (m, p, payload, opts) => sendCloudRequest(getAuth, m, p, payload, opts),
          externalFetch: fetchImpl,
          getMediaSpecs: async () => mergeMediaLookupSpecs(latestMediaSpecs),
          sleep,
          nowMs: nowMsImpl,
          ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
          ...(maxWaitMs !== undefined ? { maxWaitMs } : {}),
        },
      )
    }

    const auth = await getAuth()
    let cred = await resolveCredential(auth)
    if (!cred) {
      return jsonErrorResponse(401, `${site.name}: not signed in`, { type: "authentication_error" }, { "X-Magpie-Sign-In": "expired" })
    }

    let body = init.body
    if (req && body === undefined && method !== "GET" && method !== "HEAD") {
      body = await req.text()
    }

    if (typeof body === "string") {
      const isResponses = /\/responses(?:\?|$)/.test(url)
      try {
        const parsed = JSON.parse(body)
        if (isRecord(parsed)) {
          let mutated = false
          // MiniMax Design's OpenAI Responses proxy requires `store: false`.
          if (isResponses && parsed.store !== false) {
            parsed.store = false
            mutated = true
          }
          // If a caller sent a canonical model ID directly, map it back to the
          // upstream ID expected by this site's gateway.
          if (typeof parsed.model === "string") {
            const mapped = canonicalToApiId.get(parsed.model)
            if (mapped && mapped !== parsed.model) {
              parsed.model = mapped
              mutated = true
            }
          }
          if (mutated) body = JSON.stringify(parsed)
        }
      } catch {}
    }

    const sendOnce = async (c) => {
      const headers = new Headers(init.headers ?? req?.headers ?? undefined)
      headers.set("token", c.token)
      headers.set("version_code", resolvedVersion)
      if (c.groupId) headers.set("X-Group-Id", c.groupId)
      if (c.deviceId) headers.set("device_id", c.deviceId)
      return siteFetch(site, url, { ...init, method, headers, body, signal: init.signal ?? req?.signal }, { fetchImpl, what: site.name })
    }

    let res
    let preReadText = null
    let renewed = cred.renewedFromSaved
    try {
      res = await sendOnce(cred)
      let shouldRetryAuth = res.status === 401
      if (!shouldRetryAuth && res.status === 403) {
        preReadText = await res.text()
        shouldRetryAuth = isAuthError403(403, preReadText)
      }
      // If upstream rejected the token (401 or auth-related 403) and this is a
      // desktop sign-in, force one fresh disk read + ownership check in case
      // MiniMax Design rotated the token on disk.
      if (shouldRetryAuth && auth?.metadata?.method === "desktop") {
        const fresh = await resolveCredential(auth, { forceRefresh: true })
        if (fresh && fresh.token !== cred.token) {
          if (preReadText === null) await res.body?.cancel?.().catch(() => {})
          preReadText = null
          cred = fresh
          renewed = true
          res = await sendOnce(cred)
        }
      }
    } catch (error) {
      if (error instanceof OtherSite) {
        return jsonErrorResponse(502, error.message, { type: "region_mismatch" }, { "X-Magpie-Sign-In": "kept" })
      }
      throw error
    }

    return normalizeUpstreamResponse(site, res, renewed, preReadText)
  }

  const isZh = site.lang === "zh"

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[site.id] ??= {
        name: site.name,
        npm: "@ai-sdk/anthropic",
        api: site.defaultLlmBase,
        models: bootstrapConfigModels(site),
      }
    },

    auth: {
      provider: site.id,
      methods: [
        {
          type: "oauth",
          label: isZh ? "读取 MiniMax Design 桌面端登录态" : "Read MiniMax Design desktop sign-in",
          async authorize(_inputs, { signal } = {}) {
            const read = () => probeDesktopCredential(site, { readFileImpl, lstatImpl, homedir, platform, env, nowMs: nowMsImpl() })
            const probe = read()
            if (probe.cred) {
              const display = probe.cred.userName || probe.cred.userId || site.name
              return {
                url: "",
                instructions: isZh
                  ? `已读取本机 MiniMax Design 登录态（${display}），正在完成登录…`
                  : `Found local MiniMax Design sign-in (${display}), completing…`,
                method: "auto",
                callback: async () => finalizeDesktopCred(probe.cred),
              }
            }
            if (probe.error?.code === "region_mismatch") {
              throw probe.error
            }
            const instructions = isZh
              ? probe.error?.code === "unreadable" || probe.error?.code === "expired"
                ? `${probe.error.message}（打开 MiniMax Design 登录或修好后，这一步会自动完成。）`
                : "本机未读到 MiniMax Design 桌面端登录态。请安装或打开 MiniMax Design 并登录（上方链接为官网），登录后会自动完成；也可以改用「粘贴 accessToken」。"
              : probe.error?.code === "unreadable" || probe.error?.code === "expired"
                ? `${probe.error.message} (Open MiniMax Design and sign in; this step completes automatically.)`
                : "Local MiniMax Design desktop sign-in not found. Install/open MiniMax Design and sign in (link above), or use Paste accessToken."

            return {
              url: site.officialSite,
              instructions,
              method: "auto",
              callback: async (_code, { signal: callbackSignal } = {}) => {
                const waited = await waitForDesktopCredential({
                  read,
                  sleep,
                  now: nowMsImpl,
                  signal: callbackSignal ?? signal,
                })
                if (waited.status === "ready") {
                  try {
                    return await finalizeDesktopCred(waited.cred)
                  } catch (error) {
                    return { type: "failed", error: error?.message ?? String(error) }
                  }
                }
                if (waited.status === "aborted") return { type: "failed", error: isZh ? "登录已取消" : "Sign-in cancelled" }
                if (waited.status === "failed") return { type: "failed", error: waited.error?.message ?? "Sign-in failed" }
                return {
                  type: "failed",
                  error: isZh
                    ? `仍未读到 MiniMax Design 桌面端登录态（${reasonOf(site, waited.error)}）。登录 MiniMax Design 后重新发起即可。`
                    : `Still waiting for MiniMax Design desktop sign-in (${reasonOf(site, waited.error)}). Sign in and try again.`,
                }
              },
            }
          },
        },
        {
          // Native masked key entry supported by OpenCode 1.x, OpenCode 2.x, and magpie.
          type: "api",
          label: isZh ? "粘贴 accessToken" : "Paste accessToken",
        },
      ],

      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth || auth.type !== "api" || !trimStr(auth.key)) return {}
        // Omit baseURL so per-model gateway URLs from /api/v1/config are preserved;
        // bootstrap models already declare site.defaultLlmBase via provider.api.
        return {
          apiKey: PLACEHOLDER_KEY,
          fetch: (input, init) => sendLlmRequest(getAuth, input, init),
        }
      },

      async usage(getAuth) {
        const auth = await getAuth()
        let cred = await resolveCredential(auth)
        if (!cred) return {}
        let renewed = cred.renewedFromSaved

        const fetchWallet = (c) =>
          siteFetch(
            site,
            `${site.cloud}/api/v1/credit/wallet`,
            { headers: buildApiHeaders(c, resolvedVersion), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
            { fetchImpl, what: `${site.name} wallet` },
          )

        try {
          let res = await fetchWallet(cred)
          let errText = null
          let isAuthFailure = res.status === 401
          if (!isAuthFailure && res.status === 403) {
            errText = await res.text().catch(() => "")
            isAuthFailure = isAuthError403(403, errText)
          }
          if (isAuthFailure && auth?.metadata?.method === "desktop") {
            const fresh = await resolveCredential(auth, { forceRefresh: true })
            if (fresh && fresh.token !== cred.token) {
              if (errText === null) await res.body?.cancel?.().catch(() => {})
              errText = null
              cred = fresh
              renewed = true
              res = await fetchWallet(cred)
              isAuthFailure = res.status === 401
              if (!isAuthFailure && res.status === 403) {
                errText = await res.text().catch(() => "")
                isAuthFailure = isAuthError403(403, errText)
              }
            }
          }
          if (isAuthFailure) {
            return {
              error: msg(
                site.lang,
                `${site.name} 拒绝了该凭据（HTTP ${res.status}），请重新登录`,
                `${site.name} rejected the credential (HTTP ${res.status}); please sign in again`,
              ),
              signIn: "expired",
              windows: [],
            }
          }
          if (res.status === 403) {
            const { errCode, errMsg } = parseErrorBody(errText ?? "")
            if (errCode === "client_upgrade_required") {
              return {
                error: `${site.name}: ${errMsg} (set MINIMAX_DESIGN_VERSION_CODE to override)`,
                signIn: "kept",
                windows: [],
              }
            }
            // Non-auth 403 on wallet (e.g. team scope restriction): fall through to /credit/balance
          } else if (res.ok) {
            const body = await res.json().catch(() => null)
            const parsed = usageFromWallet(site, body, nowMsImpl(), { renewed })
            if (parsed) return parsed
          }
        } catch (error) {
          if (error instanceof OtherSite) return { error: error.message, signIn: "kept", windows: [] }
          // Fall through to /api/v1/credit/balance fallback
        }

        try {
          const res = await siteFetch(
            site,
            `${site.cloud}/api/v1/credit/balance`,
            { headers: buildApiHeaders(cred, resolvedVersion), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
            { fetchImpl, what: `${site.name} balance` },
          )
          if (res.status === 401) {
            return {
              error: msg(
                site.lang,
                `${site.name} 拒绝了该凭据（HTTP 401），请重新登录`,
                `${site.name} rejected the credential (HTTP 401); please sign in again`,
              ),
              signIn: "expired",
              windows: [],
            }
          }
          if (res.status === 403) {
            const text = await res.text().catch(() => "")
            if (isAuthError403(403, text)) {
              return {
                error: msg(
                  site.lang,
                  `${site.name} 拒绝了该凭据（HTTP 403），请重新登录`,
                  `${site.name} rejected the credential (HTTP 403); please sign in again`,
                ),
                signIn: "expired",
                windows: [],
              }
            }
            const { errCode, errMsg } = parseErrorBody(text)
            const suffix = errCode === "client_upgrade_required" ? " (set MINIMAX_DESIGN_VERSION_CODE to override)" : ""
            return {
              error: `${site.name} balance: HTTP 403${errMsg ? ` (${errMsg})` : ""}${suffix}`,
              signIn: "kept",
              windows: [],
            }
          }
          if (!res.ok) {
            return { error: `${site.name} balance: HTTP ${res.status}`, signIn: "kept", windows: [] }
          }
          const body = await res.json().catch(() => null)
          // Derive workspace scope from the final credential after any desktop refresh.
          const parsed = usageFromBalance(site, body, { hasGroupId: Boolean(cred.groupId), renewed })
          if (parsed) return parsed
          return {
            error: msg(site.lang, "积分余额格式异常", "Unexpected credit balance payload"),
            signIn: "kept",
            windows: [],
          }
        } catch (error) {
          return { error: error?.message ?? String(error), signIn: "kept", windows: [] }
        }
      },
    },

    provider: {
      id: site.id,
      async models(provider, { auth } = {}) {
        let cred = await resolveCredential(auth)
        if (!cred) return provider.models

        const cacheKey = `${cred.userId ?? ""}:${cred.groupId ?? ""}:${cred.token.slice(-16)}`
        const now = nowMsImpl()
        const cached = modelCache.get(cacheKey)
        const buildCombined = (chatSpecs, mediaSpecs) => {
          recordTextAliases(chatSpecs)
          if (mediaSpecs) latestMediaSpecs = mediaSpecs
          const effectiveMedia = mediaSpecs ?? bootstrapMediaSpecs(site)
          return {
            ...Object.fromEntries(chatSpecs.map((m) => [m.id, internalModelFromSpec(site, provider.id, m)])),
            ...Object.fromEntries(effectiveMedia.map((m) => [m.id, mediaInternalModel(site, provider.id, m)])),
          }
        }

        if (cached && now - cached.at < MODELS_TTL_MS) {
          return buildCombined(cached.specs, cached.mediaSpecs)
        }

        let specs = null
        let mediaSpecs = null
        try {
          const [chatRes, mediaRes] = await Promise.allSettled([
            fetchRemoteConfig(site, cred, resolvedVersion, fetchImpl),
            fetchRemoteModelsConfig(site, cred, resolvedVersion, fetchImpl),
          ])
          if (chatRes.status === "fulfilled") {
            specs = chatRes.value
          } else {
            throw chatRes.reason
          }
          if (mediaRes.status === "fulfilled") {
            mediaSpecs = mediaRes.value
          } else if (mediaRes.reason?.signIn === "expired") {
            throw mediaRes.reason
          }
        } catch (error) {
          if (error?.signIn === "expired" && auth?.metadata?.method === "desktop") {
            const fresh = await resolveCredential(auth, { forceRefresh: true })
            if (fresh && fresh.token !== cred.token) {
              cred = fresh
              const [chatRes, mediaRes] = await Promise.allSettled([
                fetchRemoteConfig(site, cred, resolvedVersion, fetchImpl),
                fetchRemoteModelsConfig(site, cred, resolvedVersion, fetchImpl),
              ])
              if (chatRes.status === "fulfilled") {
                specs = chatRes.value
              } else {
                throw chatRes.reason
              }
              mediaSpecs = mediaRes.status === "fulfilled" ? mediaRes.value : null
            } else {
              throw error
            }
          } else if (error?.signIn === "expired") {
            throw error
          } else {
            // Network/transient outage: fall back to LKG config on disk, then cached/bootstrap models
            if (cred.lkgConfig) {
              const lkgSpecs = parseRemoteConfig(site, cred.lkgConfig)
              if (lkgSpecs && lkgSpecs.length) specs = lkgSpecs
            }
            if (specs === null && cached) specs = cached.specs
            if (specs === null) return provider.models
            mediaSpecs = cached?.mediaSpecs ?? null
          }
        }

        const effectiveMedia = mediaSpecs ?? cached?.mediaSpecs ?? null
        modelCache.set(cacheKey, { at: nowMsImpl(), specs, mediaSpecs: effectiveMedia })
        return buildCombined(specs, effectiveMedia)
      },
    },
  }
}

export const MiniMaxDesignAuthPlugin = async () => createPlugin(SITES["minimax-design"])
export const MiniMaxDesignGlobalAuthPlugin = async () => createPlugin(SITES["minimax-design-global"])

export const _internal = {
  SITES,
  BOOTSTRAP,
  TEXT_MODEL_ALIASES,
  CREDIT_TYPE_LABELS,
  PLACEHOLDER_KEY,
  DEFAULT_VERSION_CODE,
  MODELS_TTL_MS,
  OWNER_VERIFY_FAIL_TTL_MS,
  OWNER_CACHE_MAX,
  OtherSite,
  createPlugin,
  decryptV2Token,
  candidateDataDirs,
  inferRegionFromConfig,
  readDesktopCredentialFromDir,
  readDesktopCredential,
  probeDesktopCredential,
  waitForDesktopCredential,
  parseRemoteConfig,
  parseModelsConfig,
  bootstrapConfigModels,
  configEntryFromModel,
  internalModelFromSpec,
  usageFromWallet,
  usageFromBalance,
  normalizeUpstreamResponse,
  normalizeVersionCode,
  parseDateIso,
  formatCredits,
  isExpiredJwt,
  jwtOwnerId,
  isAuthError403,
  siteFetch,
  _mediaInternal,
}
