// OpenCode provider plugins for WorkBuddy's plans, Tencent's two builds of
// WorkBuddy (CodeBuddy's desktop agent):
//   - workbuddy:    the China build, copilot.tencent.com
//   - workbuddy-ai: the international build, www.workbuddy.ai
// A WorkBuddy account signs in in the browser (Tencent's page, polled for
// the token as WorkBuddy's desktop app does) or is taken from WorkBuddy
// desktop's own sign-in. Its chats are chat completions at <endpoint>/v2,
// streamed only, with WorkBuddy's headers: a request whose User-Agent isn't
// WorkBuddy/<version> is refused (error 10085).

import { createDecipheriv, createHash, randomBytes } from "node:crypto"
import { execFile } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"

const APP_VERSION = "2.0.0" // the version WorkBuddy's sign-in page is opened with
const UA_VERSION = "5.5.6" // WorkBuddy/<this> is the User-Agent the API takes
const POLL_MS = 1000
const SIGN_IN_MS = 5 * 60 * 1000
const EARLY_MS = 60 * 1000 // a token this close to its end is refreshed before a request
const LEAD_MS = 5 * 60 * 1000 // and this close, magpie renews it ahead of time (auth.refresh)
const KEEP_RENEWED_MS = 60 * 1000 // how long a refresh's result answers for the old refresh token

// [id, name, context, efforts]
const CN_MODELS = [
  ["auto", "Auto", 168000],
  ["hy4-preview-f", "Hy4 preview", 1000000, ["high"]],
  ["hy3", "Hy3", 192000, ["low", "high"]],
  ["hy3-x", "Hy3-X", 192000, ["low", "high"]],
  ["deepseek-v4.1-flash", "Deepseek-V4.1-Flash", 1000000],
  ["glm-5.3", "GLM-5.3", 1000000, ["low", "high", "max"]],
  ["glm-5.3-flash", "GLM-5.3-Flash", 1000000, ["low", "high", "max"]],
  ["glm-5.2", "GLM-5.2", 1000000, ["high", "xhigh"]],
  ["glm-5.1", "GLM-5.1", 200000],
  ["glm-5v-turbo", "GLM-5v-Turbo", 200000],
  ["minimax-m3", "MiniMax-M3", 512000],
  ["kimi-k3-1", "Kimi-K3", 1000000, ["low", "high", "xhigh"]],
  ["kimi-k2.7", "Kimi-K2.7-Code", 256000],
  ["kimi-k2.6", "Kimi-K2.6", 256000],
  ["deepseek-v4-pro", "Deepseek-V4-Pro", 1000000, ["none", "high", "xhigh"]],
]

const AI_MODELS = [
  ["default-model", "Default", 176000],
  ["fast-model", "Fast", 200000],
  ["balanced-model", "Balanced", 256000],
  ["primary-model", "Primary", 272000],
  ["deep-model", "Deep", 176000],
  ["gpt-5.5", "GPT-5.5", 1000000],
  ["gpt-5.4", "GPT-5.4", 272000],
  ["gpt-5.3-codex", "GPT-5.3-Codex", 272000],
  ["gemini-3.1-pro", "Gemini-3.1-Pro", 400000],
  ["gemini-3.5-flash", "Gemini-3.5-Flash", 1000000],
  ["glm-5.3", "GLM-5.3", 1000000, ["low", "high", "max"]],
  ["glm-5.2", "GLM-5.2", 1000000, ["high", "xhigh"]],
  ["hy3", "Hy3", 192000, ["low", "high"]],
  ["kimi-k3", "Kimi-K3", 1000000],
  ["kimi-k2.6", "Kimi-K2.6", 256000],
  ["minimax-m3", "MiniMax-M3", 512000],
]

const SITES = {
  workbuddy: {
    id: "workbuddy",
    name: "WorkBuddy",
    endpoint: "https://copilot.tencent.com",
    authID: "workbuddy-desktop",
    platform: "workbuddy",
    ai: false,
    // where its desktop app installs the runtime that opens a sealed sign-in
    installDir: "WorkBuddy",
    exeName: "WorkBuddy.exe",
    models: CN_MODELS,
  },
  "workbuddy-ai": {
    id: "workbuddy-ai",
    name: "WorkBuddy AI",
    endpoint: "https://www.workbuddy.ai",
    authID: "workbuddy-desktop-ai",
    platform: "workbuddy-ai",
    ai: true,
    installDir: "WorkBuddyAI",
    exeName: "WorkBuddyAI.exe",
    models: AI_MODELS,
  },
}

const NPM = "@ai-sdk/openai-compatible"
const hex = () => randomBytes(16).toString("hex")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const api = (site) => site.endpoint + "/v2"

// ---- WorkBuddy's API ------------------------------------------------------

class WBError extends Error {
  constructor(message, code, status, said) {
    super(message)
    this.code = code
    this.status = status
    this.said = said // as magpie's built-in (wbCall) worded it
  }
}

// call makes a request of WorkBuddy's plugin API, which answers
// {code, msg, data}; a code but 0 is an error.
async function call(site, method, path, headers = {}, body) {
  const res = await fetch(site.endpoint + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "WorkBuddy/" + UA_VERSION,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let env = {}
  try {
    env = JSON.parse(text)
  } catch {}
  const code = Number.parseInt(env.code, 10) || 0
  if (!res.ok) {
    const why = env.msg || env.message || env.error?.message || text.slice(0, 200) || res.statusText
    const said = code ? env.msg || `error ${code}` : env.msg || statusText(res.status)
    throw new WBError(`${site.name}: ${why} (HTTP ${res.status}${env.code ? ", code " + env.code : ""})`, env.code, res.status, said)
  }
  if (env.code) throw new WBError(`${site.name}: ${env.msg || "error"} (${env.code})`, env.code, res.status, env.msg || `error ${code}`)
  return env.data
}

function domainOf(site, a) {
  return a.domain || new URL(api(site)).host
}

// merge takes a token WorkBuddy gave (sign-in or refresh) into the
// stored sign-in, times given as at-ms or in-seconds.
function merge(a, got) {
  const now = Date.now()
  const out = { ...a, access: got.accessToken }
  if (got.refreshToken) out.refresh = got.refreshToken
  if (got.domain) out.domain = got.domain
  if (got.tokenType) out.tokenType = got.tokenType
  if (got.expiresAt > 0) out.expires = got.expiresAt
  else if (got.expiresIn > 0) out.expires = now + got.expiresIn * 1000
  if (got.refreshExpiresAt > 0) out.refreshExpiresAt = got.refreshExpiresAt
  else if (got.refreshExpiresIn > 0) out.refreshExpiresAt = now + got.refreshExpiresIn * 1000
  return out
}

function stale(a) {
  return !!a.expires && Date.now() >= a.expires - EARLY_MS
}

// renewing is each refresh under way, by site and the refresh token it
// spends; renewed is what each gave, kept a minute so one that read the
// old refresh token after it was spent (magpie's auth.refresh, a request)
// takes that rather than spending it again.
const renewing = new Map()
const renewed = new Map()

function refreshable(a) {
  return !!a.refresh && !(a.refreshExpiresAt && Date.now() >= a.refreshExpiresAt)
}

// renew spends a's refresh token, once: those who come while it runs, or
// within KEEP_RENEWED_MS of it, get what it gave. save keeps the result.
function renew(site, a, save) {
  const key = site.id + "\n" + a.refresh
  const done = renewed.get(key)
  if (done && Date.now() - done.at < KEEP_RENEWED_MS) return Promise.resolve(merged(a, done.next))
  let r = renewing.get(key)
  if (!r) {
    r = (async () => {
      const got = await call(site, "POST", "/v2/plugin/auth/token/refresh", {
        "X-Refresh-Token": a.refresh,
        "X-Auth-Refresh-Source": "plugin",
        "X-Domain": domainOf(site, a),
      }, {})
      if (!got?.accessToken) throw Object.assign(new Error("WorkBuddy gave no refreshed token"), { bare: true })
      const next = merge(a, got)
      renewed.set(key, { next, at: Date.now() })
      await save?.(next)
      return next
    })().finally(() => renewing.delete(key))
    renewing.set(key, r)
  }
  return r.then((next) => merged(a, next))
}

// merged is a with the tokens another's refresh gave over it.
function merged(a, next) {
  const out = { ...a }
  for (const k of TOKEN_FIELDS) if (k in next) out[k] = next[k]
  return out
}
const TOKEN_FIELDS = ["access", "refresh", "expires", "refreshExpiresAt", "domain", "tokenType"]

// fresh is the sign-in with an access token that isn't about to end:
// refreshed (and saved) when it is. A refresh that fails, or a refresh
// token that has ended, leaves the access token there is. Its failures
// are worded as the built-in's (wbFresh), "WorkBuddy" on both sites.
async function fresh(site, client, a) {
  if (!stale(a)) return a
  if (!refreshable(a)) {
    if (a.access) return a
    throw new Error("this WorkBuddy account is signed out; sign in again")
  }
  try {
    return await renew(site, a, async (next) => {
      try {
        await client?.auth?.set?.({ path: { id: site.id }, body: next })
      } catch {}
    })
  } catch (e) {
    if (a.access) return a
    if (e?.bare) throw e
    throw new Error(`WorkBuddy token refresh: ${e?.said ?? e?.message ?? e}`)
  }
}

// refreshed is what magpie's auth.refresh gives for a browser sign-in:
// the fields a refresh changed, nothing when there's nothing to renew.
// magpie saves them itself.
async function refreshed(site, auth) {
  if (auth?.type !== "oauth" || auth.source === "desktop" || !auth.access || !auth.refresh) return undefined
  // a refresh token that has ended is said plainly, never as signIn
  // "expired": the built-in never marked a WorkBuddy account
  if (!refreshable(auth)) throw new Error("this WorkBuddy account is signed out; sign in again")
  let next
  try {
    next = await renew(site, auth)
  } catch (e) {
    if (e?.bare) throw e
    throw new Error(`WorkBuddy token refresh: ${e?.said ?? e?.message ?? e}`)
  }
  const out = {}
  for (const k of TOKEN_FIELDS) if (k in next && next[k] !== auth[k]) out[k] = next[k]
  return Object.keys(out).length ? out : undefined
}

// sign sets on headers what WorkBuddy's desktop app sends with a chat.
function sign(site, a, headers) {
  headers.set("Authorization", "Bearer " + a.access)
  headers.set("X-User-Id", a.uid ?? "")
  headers.set("X-Domain", domainOf(site, a))
  headers.set("X-Product", "SaaS")
  headers.set("X-IDE-Type", "WorkBuddy")
  headers.set("User-Agent", "WorkBuddy/" + UA_VERSION)
  if (!site.ai) return
  headers.set("X-Requested-With", "XMLHttpRequest")
  headers.set("X-Agent-Intent", "craft")
  headers.set("X-Agent-Type", "main")
  headers.set("X-IDE-Name", "WorkBuddy")
  headers.set("X-IDE-Version", UA_VERSION)
  const conv = hex()
  if (!headers.has("X-Conversation-ID")) headers.set("X-Conversation-ID", conv)
  if (!headers.has("X-Conversation-Request-ID")) headers.set("X-Conversation-Request-ID", conv)
  const msg = hex()
  headers.set("X-Conversation-Message-ID", msg)
  headers.set("X-Request-ID", msg)
}

// withSystem gives a chat that doesn't open with a system message
// WorkBuddy's default one, as its app does.
function withSystem(body) {
  // a body magpie or OpenCode hands over as bytes is read as the text it is
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) body = new TextDecoder().decode(body)
  if (typeof body !== "string") return body
  try {
    const b = JSON.parse(body)
    if (!Array.isArray(b?.messages) || !b.messages.length || b.messages[0]?.role === "system") return body
    b.messages.unshift({ role: "system", content: "You are a helpful assistant." })
    return JSON.stringify(b)
  } catch {
    return body
  }
}

// ---- signing in -------------------------------------------------------------

// poll asks path until WorkBuddy answers with data, retrying the codes
// that mean "not yet".
async function poll(site, path, headers, retry, deadline) {
  for (;;) {
    if (Date.now() > deadline) throw new Error(`${site.name} sign-in timed out`)
    try {
      const data = await call(site, "GET", path, headers)
      if (data && Object.keys(data).length) return data
    } catch (e) {
      if (!(retry.includes(e.code) || e.status === 408 || e.status === 429)) throw e
    }
    await sleep(POLL_MS)
  }
}

async function browserSignIn(site) {
  const state = await call(site, "POST", `/v2/plugin/auth/state?platform=${encodeURIComponent(site.platform)}`, {
    "X-No-Authorization": "true",
    "X-No-User-Id": "true",
    "X-No-Enterprise-Id": "true",
    "X-No-Department-Info": "true",
  }, {})
  if (!state?.state || !state?.authUrl) throw new Error(`${site.name} gave no sign-in page`)
  const url = new URL(state.authUrl)
  if (url.protocol !== "https:") throw new Error(`${site.name}'s sign-in page isn't https`)
  url.searchParams.set("version", APP_VERSION)
  url.searchParams.set("loginSessionId", hex())
  return {
    url: url.toString(),
    instructions: `Sign in to ${site.name} in the browser; this finishes by itself.`,
    method: "auto",
    async callback() {
      try {
        const deadline = Date.now() + SIGN_IN_MS
        const q = encodeURIComponent(state.state)
        const token = await poll(site, `/v2/plugin/auth/token?state=${q}`, {}, [11217], deadline)
        if (!token.accessToken) return { type: "failed", error: `${site.name} sent back no token` }
        let a = merge({}, token)
        const who = await poll(site, `/v2/plugin/login/account?state=${q}`, {
          Authorization: "Bearer " + a.access,
          "X-Domain": domainOf(site, a),
          "X-No-User-Id": "true",
          "X-No-Enterprise-Id": "true",
        }, [12151], deadline)
        a.uid = who.uid ?? ""
        return success(site, a, who.nickname || who.phoneNumber || who.uid)
      } catch (e) {
        return { type: "failed", error: e.message }
      }
    },
  }
}

function success(site, a, name) {
  return {
    type: "success",
    refresh: a.refresh ?? "",
    access: a.access,
    expires: a.expires ?? 0,
    accountId: name || site.name,
    uid: a.uid ?? "",
    domain: a.domain ?? "",
    ...(a.refreshExpiresAt ? { refreshExpiresAt: a.refreshExpiresAt } : {}),
    ...(a.tokenType ? { tokenType: a.tokenType } : {}),
  }
}

// desktopFile is where WorkBuddy's desktop app keeps its sign-in.
function desktopFile(site) {
  const home = homedir()
  const base =
    process.platform === "darwin" ? join(home, "Library", "Application Support", "CodeBuddyExtension")
    : process.platform === "win32" ? join(home, "AppData", "Local", "CodeBuddyExtension")
    : join(home, ".local", "share", "CodeBuddyExtension")
  return join(base, "Data", "Public", "auth", site.authID + ".info")
}

// ---- a sign-in the app seals at rest (WorkBuddy 5.6 and later) --------------
//
// From 5.6 the desktop app writes auth.accessToken and auth.refreshToken as
// {$wbEncrypted: 1, envelope} wrappers (`buildPolicy: "fields"`), each sealed
// with AES-256-GCM under a per-install at-rest key. Nothing in this process
// can open them: the key is handed out by the app's modified Electron runtime
// through its own private binding, which stock Node and Bun don't have. So the
// app's own binary is run once as Node (ELECTRON_RUN_AS_NODE, never its GUI)
// to read that key, and the envelopes are opened here, in memory. The app's
// files are only ever read; the key and the tokens are never written anywhere.

// isEncryptedWorkBuddyValue tells a sealed value from a plain one: an ordinary
// object must never be mistaken for a token, and a sealed value is never
// mistaken for a string.
function isEncryptedWorkBuddyValue(v) {
  return !!v && typeof v === "object" && !Array.isArray(v) && v.$wbEncrypted === 1 && typeof v.envelope === "string" && v.envelope !== ""
}

// base64Of decodes a base64 field and checks its exact byte length, so a
// tampered envelope is refused before any key material is involved.
function base64Of(value, length) {
  if (typeof value !== "string" || value === "") return undefined
  let decoded
  try {
    decoded = Buffer.from(value, "base64")
  } catch {
    return undefined
  }
  if (decoded.length === 0) return undefined
  if (decoded.toString("base64").replace(/=+$/u, "") !== value.replace(/=+$/u, "")) return undefined
  return length === undefined || decoded.length === length ? decoded : undefined
}

// parseWrappedField: the decoded parts of one sealed value, undefined for
// anything that isn't exactly what 5.6 writes (suite 1 under the field framing).
function parseWrappedField(value) {
  if (!isEncryptedWorkBuddyValue(value)) return undefined
  let inner
  try {
    inner = JSON.parse(Buffer.from(value.envelope, "base64").toString("utf8"))
  } catch {
    return undefined
  }
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return undefined
  const nonce = base64Of(inner.nonce, 12)
  const authTag = base64Of(inner.authTag, 16)
  const ciphertext = base64Of(inner.ciphertext)
  if (nonce === undefined || authTag === undefined || ciphertext === undefined) return undefined
  if (!Number.isInteger(inner.suite) || typeof inner.keyId !== "string" || !/^[0-9a-f]{16}$/u.test(inner.keyId)) return undefined
  return { suite: inner.suite, keyId: inner.keyId, nonce, authTag, ciphertext }
}

// buildAuthenticatedContextAad is the app's own buildAuthenticatedContextAad,
// as this format's readers transcribe it. Credential fields are always suite 1
// under the field framing (WBEV1); the neighbouring framings belong to other
// document kinds and are deliberately not guessed at.
function buildAuthenticatedContextAad(keyId, suite) {
  const prefix = Buffer.from("WB-AAD\0", "ascii")
  const lengthPrefixed = (value) => {
    const bytes = Buffer.from(value, "utf8")
    const header = Buffer.allocUnsafe(4)
    header.writeUInt32BE(bytes.length)
    return Buffer.concat([header, bytes])
  }
  const suiteBytes = Buffer.allocUnsafe(4)
  suiteBytes.writeUInt32BE(suite)
  return Buffer.concat([
    prefix, Buffer.from([1]),
    lengthPrefixed("WBEV1"),
    lengthPrefixed("sym-v1"),
    suiteBytes,
    lengthPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ])
}

// openAuthField opens one envelope with the protector key; undefined when it
// will not open (not this format, or a key from another install).
function openAuthField(key, envelope) {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, envelope.nonce, { authTagLength: 16 })
    decipher.setAAD(buildAuthenticatedContextAad(envelope.keyId, envelope.suite))
    decipher.setAuthTag(envelope.authTag)
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString("utf8")
  } catch {
    return undefined
  }
}

// The app's own Electron binary is run with -e and ELECTRON_RUN_AS_NODE: Node
// mode only, so no window, no app code path and no temp file. Only stdout comes
// back, and only its payload is kept.
const HELPER_SCRIPT =
  'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))'
const AT_REST_MS = 10 * 1000

function atRestPayload(electronPath) {
  return new Promise((resolve) => {
    execFile(electronPath, ["-e", HELPER_SCRIPT], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      timeout: AT_REST_MS,
      maxBuffer: 1 << 20,
      windowsHide: true,
    }, (err, stdout) => resolve(err ? undefined : String(stdout ?? "")))
  })
}

// parseAtRestPayload: {version: 1, atRestSecretKey} as the app's own rules
// require (a canonical-base64, 32-byte, non-all-zero secret).
function parseAtRestPayload(raw) {
  let held
  try {
    held = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!held || held.version !== 1 || typeof held.atRestSecretKey !== "string") return undefined
  const secret = base64Of(held.atRestSecretKey, 32)
  if (secret === undefined || secret.every((b) => b === 0)) return undefined
  return held.atRestSecretKey
}

// findWorkBuddyElectron: the app's own binary, or undefined. A path the user
// named wins when it is there; otherwise the installer's own record, the
// standard install roots, and the same two directories on any other drive (so
// an install on D: is found too). A bad WORKBUDDY_ELECTRON_BIN is not fatal:
// it falls through to the search rather than failing the sign-in. Nothing is
// ever searched for by content, and a path is only used when it names exactly
// this product's executable.
const ELECTRON_BIN_ENV = "WORKBUDDY_ELECTRON_BIN"
const UNINSTALL_ROOTS = [
  "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
]

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function sameProduct(path, site) {
  try {
    return basename(path).toLowerCase() === site.exeName.toLowerCase()
  } catch {
    return false
  }
}

function regQuery(root, needle) {
  return new Promise((resolve) => {
    execFile("reg.exe", ["query", root, "/s", "/f", needle, "/d"], { timeout: AT_REST_MS, maxBuffer: 4 << 20, windowsHide: true },
      (err, stdout) => resolve(err ? "" : String(stdout ?? "")))
  })
}

// registryPaths: the paths the installer itself recorded. Only a value that is
// exactly this product's executable is taken (DisplayIcon, for instance, reads
// "D:\Program Files\WorkBuddy\WorkBuddy.exe,0").
async function registryPaths(site) {
  const out = []
  for (const root of UNINSTALL_ROOTS) {
    const text = await regQuery(root, site.exeName)
    if (!text) continue
    for (const m of text.matchAll(/[A-Za-z]:\\[^\r\n"]*?\.exe/gu)) {
      const path = m[0].trim()
      if (sameProduct(path, site) && !out.includes(path)) out.push(path)
    }
  }
  return out
}

function rootPaths(site) {
  const roots = [process.env.ProgramFiles, process.env.ProgramW6432, process.env["ProgramFiles(x86)"], "C:\\Program Files", "C:\\Program Files (x86)"]
  const out = []
  for (const root of roots) {
    if (typeof root !== "string" || root.trim() === "") continue
    const path = join(root, site.installDir, site.exeName)
    if (!out.includes(path)) out.push(path)
  }
  return out
}

function drivePaths(site) {
  const out = []
  for (let c = 0; c < 26; c++) {
    const drive = String.fromCharCode(65 + c) + ":\\"
    for (const dir of ["Program Files", "Program Files (x86)"]) out.push(join(drive, dir, site.installDir, site.exeName))
  }
  return out
}

const electronFound = new Map() // site id -> path, "" for none

async function findWorkBuddyElectron(site) {
  if (process.platform !== "win32" && process.platform !== "darwin") return undefined
  const held = electronFound.get(site.id)
  if (held !== undefined) return held || undefined
  const found = await discoverElectron(site)
  electronFound.set(site.id, found ?? "")
  return found
}

async function discoverElectron(site) {
  // A path the user named, when it is really there. One that is empty, stale
  // or wrong is not an error: the search below carries on, so a bad env var
  // can never be the reason a sign-in fails.
  const explicit = (process.env[ELECTRON_BIN_ENV] ?? "").trim()
  if (explicit !== "" && isFile(explicit)) return explicit
  if (process.platform === "darwin") {
    const path = join("/Applications", `${site.installDir}.app`, "Contents", "MacOS", "Electron")
    return isFile(path) ? path : undefined
  }
  for (const path of await registryPaths(site)) if (isFile(path)) return path
  for (const path of rootPaths(site)) if (isFile(path)) return path
  for (const path of drivePaths(site)) if (isFile(path)) return path
  return undefined
}

// The protector key is kept in memory only, single-flight, and named by its own
// id: an envelope naming a different id means another install sealed it, and
// no key reachable here opens it.
const atRestKeys = new Map() // site id -> { keyId, key }
const atRestPending = new Map() // site id -> promise

async function atRestKey(site, keyId) {
  const held = atRestKeys.get(site.id)
  if (held) return held.keyId === keyId ? held.key : undefined
  let pending = atRestPending.get(site.id)
  if (!pending) {
    pending = (async () => {
      const electron = await findWorkBuddyElectron(site)
      if (!electron) return undefined
      const secret = parseAtRestPayload(await atRestPayload(electron))
      if (!secret) return undefined
      const key = createHash("sha256").update(secret, "utf8").digest()
      return { keyId: createHash("sha256").update(key).digest("hex").slice(0, 16), key }
    })().finally(() => atRestPending.delete(site.id))
    atRestPending.set(site.id, pending)
  }
  const found = await pending
  if (!found) return undefined
  atRestKeys.set(site.id, found)
  return found.keyId === keyId ? found.key : undefined
}

// openSealed opens one sealed value for this site; undefined when it cannot be
// opened, so a sign-in that can't be read is never taken as a plain one.
async function openSealed(site, value) {
  const envelope = parseWrappedField(value)
  if (!envelope) return undefined
  const key = await atRestKey(site, envelope.keyId)
  if (!key) return undefined
  return openAuthField(key, envelope)
}

// plainOrOpened: a field as it sits in the file (a plain string) or as the
// sealed value says (opened here). "" for a field that is neither, or that
// will not open.
async function plainOrOpened(site, field) {
  if (typeof field === "string") return field
  if (!isEncryptedWorkBuddyValue(field)) return ""
  return (await openSealed(site, field)) ?? ""
}

// desktopName names the account. A nickname may itself be sealed, and a sealed
// value is an object: it must never be taken as a name, so what a name may be
// is settled here, and only a string ever comes back.
async function desktopName(site, acct) {
  for (const field of ["nickname", "phoneNumber"]) {
    const value = acct[field]
    if (typeof value === "string" && value.trim() !== "") return value.trim()
    if (isEncryptedWorkBuddyValue(value)) {
      const opened = await openSealed(site, value)
      if (typeof opened === "string" && opened.trim() !== "") return opened.trim()
    }
  }
  for (const field of ["email", "emailAddress", "uid"]) {
    const value = acct[field]
    if (typeof value === "string" && value.trim() !== "") return value.trim()
  }
  return ""
}

// readDesktop is WorkBuddy desktop's sign-in as the app keeps it now, null for
// none that can be read. A plain sign-in (credential protection off, the
// default) is taken as it always was; one the app sealed is opened through the
// app's own runtime.
async function readDesktop(site) {
  let f
  try {
    f = JSON.parse(readFileSync(desktopFile(site), "utf8"))
  } catch {
    return null
  }
  try {
    const t = f?.auth ?? {}
    const acct = f?.account
    if (!acct?.uid) return null
    const access = await plainOrOpened(site, t.accessToken)
    if (!access) return null
    const now = Date.now()
    return {
      access,
      refresh: await plainOrOpened(site, t.refreshToken),
      expires: t.expiresAt > 0 ? t.expiresAt : t.expiresIn > 0 ? now + t.expiresIn * 1000 : 0,
      refreshExpiresAt: t.refreshExpiresAt > 0 ? t.refreshExpiresAt : t.refreshExpiresIn > 0 ? now + t.refreshExpiresIn * 1000 : 0,
      domain: typeof t.domain === "string" ? t.domain : "",
      tokenType: typeof t.tokenType === "string" ? t.tokenType : "",
      uid: acct.uid,
      name: (await desktopName(site, acct)) || acct.uid,
    }
  } catch {
    return null
  }
}

// desktopSignIn uses the account WorkBuddy desktop is signed in to: nothing
// is copied (a copied refresh token would be the app's and the plugin's
// both, and the first to use it would sign the other out); its file is
// read each time, as the app keeps it.
function desktopSignIn(site) {
  return {
    url: "",
    instructions: `Uses the account ${site.name} desktop is signed in to.`,
    method: "auto",
    async callback() {
      const d = await readDesktop(site)
      if (!d) return { type: "failed", error: `${site.name} desktop isn't signed in` }
      return { type: "success", refresh: "", access: "", expires: 0, source: "desktop", accountId: d.name || site.name, uid: d.uid }
    },
  }
}

// desktopHeld is what a desktop sign-in was renewed to here, by site and
// account: kept in memory only, never written where the app keeps it.
const desktopHeld = new Map()

// current is the sign-in a stored auth names, fresh: WorkBuddy desktop's,
// read where it keeps it, or one kept here.
async function current(site, client, auth) {
  if (auth?.source !== "desktop") return fresh(site, client, auth)
  const d = await readDesktop(site)
  if (!d) throw new Error(`${site.name} desktop isn't signed in`)
  const k = site.id + "|" + d.uid
  const h = desktopHeld.get(k)
  const a = await fresh(site, null, h && h.expires >= d.expires ? h : d)
  desktopHeld.set(k, a)
  return a
}

// ---- allowance ----------------------------------------------------------------

// STATUS_TEXT is Go's http.StatusText, which magpie's built-in said a
// refused meter call with; a status Go has no words for is "HTTP <n>", so
// the card always has an error.
const STATUS_TEXT = {
  100: "Continue", 101: "Switching Protocols", 102: "Processing", 103: "Early Hints",
  200: "OK", 201: "Created", 202: "Accepted", 203: "Non-Authoritative Information", 204: "No Content", 205: "Reset Content",
  206: "Partial Content", 207: "Multi-Status", 208: "Already Reported", 226: "IM Used",
  300: "Multiple Choices", 301: "Moved Permanently", 302: "Found", 303: "See Other", 304: "Not Modified", 305: "Use Proxy",
  307: "Temporary Redirect", 308: "Permanent Redirect",
  400: "Bad Request", 401: "Unauthorized", 402: "Payment Required", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
  406: "Not Acceptable", 407: "Proxy Authentication Required", 408: "Request Timeout", 409: "Conflict", 410: "Gone",
  411: "Length Required", 412: "Precondition Failed", 413: "Request Entity Too Large", 414: "Request URI Too Long",
  415: "Unsupported Media Type", 416: "Requested Range Not Satisfiable", 417: "Expectation Failed", 418: "I'm a teapot",
  421: "Misdirected Request", 422: "Unprocessable Entity", 423: "Locked", 424: "Failed Dependency", 425: "Too Early",
  426: "Upgrade Required", 428: "Precondition Required", 429: "Too Many Requests", 431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
  505: "HTTP Version Not Supported", 506: "Variant Also Negotiates", 507: "Insufficient Storage", 508: "Loop Detected",
  510: "Not Extended", 511: "Network Authentication Required",
}
const statusText = (n) => STATUS_TEXT[n] || `HTTP ${n}`

// meter asks the billing API as magpie's built-in did, its errors said
// the same: WorkBuddy's message, else its code, else the HTTP status.
async function meter(site, a, path) {
  const res = await fetch(site.endpoint + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "WorkBuddy/" + UA_VERSION,
      Authorization: "Bearer " + a.access, "X-User-Id": a.uid ?? "", "X-Domain": domainOf(site, a), "X-Product": "SaaS",
      "X-IDE-Type": "WorkBuddy" },
    body: "{}",
    signal: AbortSignal.timeout(20000),
  })
  let env = {}
  try {
    env = JSON.parse(await res.text()) ?? {}
  } catch {}
  const code = Number.parseInt(env.code, 10) || 0
  if (!res.ok) {
    if (code) throw new Error(env.msg || `error ${code}`)
    if (env.msg) throw new Error(env.msg)
    throw new Error(statusText(res.status))
  }
  if (code) throw new Error(env.msg || `error ${code}`)
  return env.data ?? null
}

// capacity is a capacity the billing API sends, as a string ("438.88")
// or now and then a number; empty is 0.
function capacity(v) {
  if (v == null || v === "") return 0
  if (typeof v === "number") return v
  const s = String(v)
  const n = Number(s)
  if (s.trim() !== s || Number.isNaN(n)) throw new Error(`strconv.ParseFloat: parsing ${JSON.stringify(s)}: invalid syntax`)
  return n
}

// compact is a count as magpie says one: whole, else to two places.
const compact = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""))

// usageOf is the account's credits, from its resource summary: the plan's
// credits used against what the cycle grants, as magpie's built-in said —
// the count itself too (amount of limit, in credits), for magpie to say it
// as used or left beside the share (magpie#659).
function usageOf(sum, plan) {
  const out = { plan: plan || (sum?.IsPaidUser ? "Pro" : "Free"), windows: [] }
  let total = 0, used = 0
  for (const p of sum?.Packages ?? []) {
    total += capacity(p?.CycleTotalCapacity)
    used += capacity(p?.CycleUsedCapacity)
  }
  if (total > 0) out.windows.push({ name: "Credits", used: (100 * used) / total, display: `${compact(used)} / ${compact(total)}`, amount: used, limit: total, unit: "credits" })
  return out
}

// ---- models -----------------------------------------------------------------

// variants are the reasoning levels as OpenCode gives them to the AI SDK.
function variants(efforts) {
  return Object.fromEntries((efforts ?? []).map((e) => [e, { reasoningEffort: e }]))
}

function configModels(site) {
  return Object.fromEntries(site.models.map(([id, name, context, efforts]) => [id, {
    name,
    limit: { context, output: 0 },
    tool_call: true,
    ...(efforts ? { reasoning: true, variants: variants(efforts) } : {}),
  }]))
}

function modelOf(site, provider, m) {
  return {
    id: m.id,
    providerID: provider.id,
    name: m.name,
    api: { id: m.id, url: api(site), npm: NPM },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.context ?? 0, output: m.output ?? 0 },
    capabilities: {
      temperature: true,
      reasoning: !!m.efforts?.length,
      attachment: !!m.images,
      toolcall: true,
      input: { text: true, image: !!m.images, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: variants(m.efforts),
    // magpie's own: served at no cost to the plan's credits
    free: !!m.free,
    // magpie's own: the credits a request costs, as a multiple (0: none)
    rate: m.rate ?? 0,
  }
}

// liveModels asks WorkBuddy's product config for the plan's models: the
// "cli" agent's list, each with its details. The CLI User-Agent picks
// WorkBuddy's config (a bare WorkBuddy/<v> gets CodeBuddy IDE's, no cli).
// creditsOf reads a model's credits, the multiple WorkBuddy's picker shows
// by it: "x0.03", "0" or 0; "x0.00" is free. A rate it can't read (or
// none, or an infinite one) is undefined: the model is neither free nor
// rated. The same rule as magpie's built-in (wbCredits).
function creditsOf(c) {
  if (c == null || c === "") return undefined
  const s = String(c).trim().toLowerCase().replace(/^x/, "")
  const n = Number(s)
  return s !== "" && Number.isFinite(n) && n >= 0 ? n : undefined
}

// freeCredits says whether a model's credits are none: "x0.00", "0" or 0.
// A rate it can't read is not free.
function freeCredits(c) {
  return creditsOf(c) === 0
}

async function liveModels(site, a) {
  const headers = new Headers()
  sign(site, a, headers)
  headers.set("User-Agent", `CLI/${APP_VERSION} WorkBuddy/${UA_VERSION}`)
  headers.set("X-Requested-With", "XMLHttpRequest")
  headers.set("Accept", "application/json")
  const res = await fetch(site.endpoint + "/v3/config", { headers, signal: AbortSignal.timeout(15000) })
  const env = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${site.name}'s config: HTTP ${res.status}`)
  if (env.code) throw new Error(`${site.name}'s config: ${env.msg} (${env.code})`)
  const cfg = env.data ?? {}
  const out = []
  for (const agent of cfg.agents ?? []) {
    if (agent.name !== "cli") continue
    for (const id of agent.models ?? []) {
      const d = (cfg.models ?? []).find((x) => x.id === id)
      const m = { id, name: d?.name || id }
      if (d) {
        m.context = d.maxInputTokens
        m.output = d.maxOutputTokens
        m.images = d.supportsImages === true
        const r = creditsOf(d.credits)
        if (r !== undefined) {
          m.free = r === 0
          m.rate = r
        }
        const es = d.reasoning?.supportedEfforts ?? []
        if (es.length) {
          const canOff = d.reasoning?.canDisableThinking
          m.efforts = [...(!d.onlyReasoning && (canOff == null || canOff) ? ["none"] : []), ...es]
        }
      }
      out.push(m)
    }
  }
  // tell apart models the config names alike: deepseek-v4.1-flash and
  // deepseek-v4.1-flash-sg are both "Deepseek-V4.1-Flash"
  const first = new Map()
  for (const m of out) {
    const id = first.get(m.name)
    if (id === undefined) {
      first.set(m.name, m.id)
      continue
    }
    const rest = m.id.startsWith(id + "-") ? m.id.slice(id.length + 1) : ""
    m.name = `${m.name} (${rest ? rest.toUpperCase() : m.id})`
  }
  return out
}

// ---- the plugins --------------------------------------------------------------

function makePlugin(site) {
  return async ({ client }) => ({
    config: async (config) => {
      config.provider ??= {}
      config.provider[site.id] ??= {}
      const p = config.provider[site.id]
      p.name ??= site.name
      p.npm ??= NPM
      p.api ??= api(site)
      p.models = { ...configModels(site), ...(p.models ?? {}) }
    },
    provider: {
      id: site.id,
      // the account's own list, when it's signed in and WorkBuddy answers;
      // else the list above
      async models(provider, { auth }) {
        if (auth?.type !== "oauth" || !(auth.access || auth.source)) return provider.models
        try {
          const a = await current(site, client, auth)
          const ms = await liveModels(site, a)
          if (!ms.length) return provider.models
          return Object.fromEntries(ms.map((m) => [m.id, modelOf(site, provider, m)]))
        } catch {
          return provider.models
        }
      },
    },
    auth: {
      provider: site.id,
      // magpie renews a browser sign-in LEAD_MS before its end (an hour's
      // token), once for the account, before its requests, models and
      // usage ask; the check before each request stays for OpenCode,
      // which doesn't call this. Desktop's sign-in has no expiry stored
      // and is renewed as before.
      refreshLead: LEAD_MS,
      refresh: (auth) => refreshed(site, auth),
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "oauth") return {}
        return {
          baseURL: api(site),
          apiKey: "",
          async fetch(input, init) {
            let a = await getAuth()
            if (a?.type !== "oauth") throw new Error(`${site.name} isn't signed in`)
            a = await current(site, client, a)
            const req = input instanceof Request ? input : null
            const headers = new Headers(init?.headers ?? req?.headers)
            headers.delete("authorization")
            headers.delete("x-api-key")
            headers.delete("content-length")
            sign(site, a, headers)
            let body = init?.body
            if (body === undefined && req) body = await req.clone().text()
            const res = await fetch(req ? req.url : input, { ...init, method: init?.method ?? req?.method, headers, body: withSystem(body) })
            return res.status >= 400 ? explained(res) : kept(res)
          },
        }
      },
      // the account's credits, as magpie's built-in showed them; each
      // read keeps the sign-in (signIn), as the built-in's neither marked
      // an account lapsed nor cleared it
      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "oauth" || !(auth.access || auth.source)) return { error: "not signed in", signIn: "kept" }
        try {
          const a = await current(site, client, auth)
          // the meter has no /v2 prefix, on either site
          return { ...usageOf(await meter(site, a, "/billing/meter/get-user-resource-summary"), auth.plan), signIn: "kept" }
        } catch (e) {
          return { error: e?.message ?? String(e), signIn: "kept" }
        }
      },
      methods: [
        {
          type: "oauth",
          label: `${site.name} account (browser)`,
          authorize: () => browserSignIn(site),
        },
        {
          type: "oauth",
          label: `${site.name} desktop's sign-in`,
          authorize: async () => desktopSignIn(site),
        },
      ],
    },
  })
}

// REFUSED_HINT is what the user can do about WorkBuddy's "Illegal API
// invocation from an unapproved channel": both builds answer it to a chat
// whose system prompt is Codex's or Claude Code's own (magpie #182),
// whatever the headers. It ends the error's message, as magpie's built-in
// put it (provider.WBRefusedHint), so magpie's routing page says it apart.
const REFUSED_HINT =
  "WorkBuddy refuses chats from Codex and Claude Code (their system prompt); use it from Hermes, OpenCode or Pi, or add another provider to this group"
const REFUSED = /unapproved channel|illegal api invocation/i

// kept is an answer that went through, saying the sign-in is kept: the
// built-in never cleared a WorkBuddy account's mark, as it never set one.
function kept(res) {
  const headers = new Headers(res.headers)
  headers.set("X-Magpie-Sign-In", "kept")
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

// explained is res with REFUSED_HINT added to that refusal's message.
// Each refusal says the sign-in is kept: the built-in passed WorkBuddy's
// 401 on and never marked a WorkBuddy account lapsed.
async function explained(res) {
  const text = await res.text()
  const again = (b) => {
    const headers = new Headers(res.headers)
    headers.delete("content-length")
    headers.delete("content-encoding")
    headers.set("X-Magpie-Sign-In", "kept")
    return new Response(b, { status: res.status, statusText: res.statusText, headers })
  }
  if (!REFUSED.test(text)) return again(text)
  let msg = text.trim()
  let v
  try {
    v = JSON.parse(text)
  } catch {}
  const at = v?.error && typeof v.error === "object" ? v.error : v && typeof v === "object" ? v : null
  if (at && typeof at.message === "string") msg = at.message
  else if (typeof v?.error === "string") msg = v.error
  else if (typeof v?.msg === "string" && v.msg) msg = v.msg // WorkBuddy's own {"code", "msg"}
  msg = `${msg} — ${REFUSED_HINT}`
  const headers = new Headers(res.headers)
  headers.set("content-type", "application/json")
  headers.delete("content-length")
  headers.delete("content-encoding")
  headers.set("X-Magpie-Sign-In", "kept")
  return new Response(JSON.stringify({ error: { message: msg, type: "permission_error", code: null } }), { status: res.status, statusText: res.statusText, headers })
}

export const WorkBuddyAuthPlugin = makePlugin(SITES.workbuddy)
export const WorkBuddyAIAuthPlugin = makePlugin(SITES["workbuddy-ai"])

// for tests
export const _internal = {
  withSystem, usageOf, desktopHeld, explained, REFUSED_HINT, freeCredits, creditsOf, fresh, SITES, renewing, renewed,
  // the sealed-sign-in path (WorkBuddy 5.6 and later)
  isEncryptedWorkBuddyValue, parseWrappedField, buildAuthenticatedContextAad, openAuthField,
  parseAtRestPayload, base64Of, readDesktop, desktopFile, findWorkBuddyElectron, registryPaths, rootPaths, drivePaths,
  ELECTRON_BIN_ENV, electronFound, atRestKeys, HELPER_SCRIPT, AT_REST_MS,
}
