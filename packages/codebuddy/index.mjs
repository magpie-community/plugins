// OpenCode provider plugin for Tencent's CodeBuddy (copilot.tencent.com),
// signed in with the local CodeBuddy desktop login instead of a browser.
//
// The CodeBuddy Code desktop keeps its login in plaintext .info files in
// the CodeBuddyExtension data folder, and this plugin reads one on each
// request as the app keeps it (nothing is copied, and nothing is written
// back: a token renewed here is kept in memory for this run only, so the
// desktop app is never signed out of a token it holds). WorkBuddy 5.6+
// seals its own desktop sign-in (workbuddy-desktop.info) with a
// $wbEncrypted envelope that only the app can open; the coding-copilot /
// codebuddy files this plugin reads are the CodeBuddy desktop's own, kept
// in the clear, so they stay usable where WorkBuddy's don't.
//
// Chats are chat completions at <endpoint>/v2, with the headers the
// CodeBuddy desktop's own API calls carry (cb2ai's buildHeaders): the
// account's token, user id, enterprise, domain and client User-Agent. The
// token is refreshed (POST /v2/plugin/auth/token/refresh, with
// X-Refresh-Token and X-Auth-Refresh-Source: plugin) a minute before it
// ends; a refresh that fails leaves the access token there is.

import { readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))

const SITE = {
  id: "codebuddy",
  name: "CodeBuddy",
  endpoint: "https://copilot.tencent.com",
  defaultDomain: "www.codebuddy.cn",
}

const NPM = "@ai-sdk/openai-compatible"
const api = () => SITE.endpoint + "/v2"
const UA = `codebuddy-magpie/${pkg.version ?? "0.1.0"}`

// EARLY_MS: a token this close to its end is refreshed before a request
const EARLY_MS = 60 * 1000
// LEAD_MS: this close, magpie renews it ahead of time (auth.refresh)
const LEAD_MS = 5 * 60 * 1000
// KEEP_RENEWED_MS: how long a refresh's result answers for the old refresh
// token, so two who read it after it was spent don't spend it twice
const KEEP_RENEWED_MS = 60 * 1000
// PRICE_TTL: how long a live model list is kept before it is read again
const PRICE_TTL = 5 * 60 * 1000

// ---- models ---------------------------------------------------------------

// [id, name, context, efforts, output]
//
// The CodeBuddy plan's model menu on copilot.tencent.com, the list the
// WorkBuddy China build serves (the same backend and plan). Offered before
// an account's own list is read, and when it can't be. A model with no
// output is left to models.dev.
const MODELS = [
  ["auto", "Auto", 168000],
  ["hy4-preview-f", "Hy4 preview", 1000000, ["high"]],
  ["hy3", "Hy3", 192000, ["low", "high"]],
  ["hy3-x", "Hy3-X", 192000, ["low", "high"]],
  ["deepseek-v4.1-flash", "Deepseek-V4.1-Flash", 1000000, ["none", "low", "high", "max"], 128000],
  ["glm-5.3", "GLM-5.3", 1000000, ["low", "high", "max"]],
  ["glm-5.3-flash", "GLM-5.3-Flash", 1000000, ["low", "high", "max"], 131072],
  ["glm-5.2", "GLM-5.2", 1000000, ["high", "xhigh"]],
  ["glm-5.1", "GLM-5.1", 200000],
  ["glm-5v-turbo", "GLM-5v-Turbo", 200000],
  ["minimax-m3", "MiniMax-M3", 512000],
  ["kimi-k3-1", "Kimi-K3", 1000000, ["low", "high", "xhigh"]],
  ["kimi-k2.7", "Kimi-K2.7-Code", 256000],
  ["kimi-k2.6", "Kimi-K2.6", 256000],
  ["deepseek-v4-pro", "Deepseek-V4-Pro", 1000000, ["none", "high", "xhigh"], 128000],
]

// variants are the reasoning levels as OpenCode gives them to the AI SDK.
function variants(efforts) {
  return Object.fromEntries((efforts ?? []).map((e) => [e, { reasoningEffort: e }]))
}

// configModels is the static list as a provider's models, each on the chat
// API. A model that names efforts takes them as reasoning variants.
function configModels() {
  return Object.fromEntries(MODELS.map(([id, name, context, efforts, output]) => [id, {
    name,
    limit: { context, output: output ?? 0 },
    tool_call: true,
    attachment: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    ...(efforts ? { reasoning: true, variants: variants(efforts) } : {}),
  }]))
}

// modelOf is a model the account's live list gave, as a provider's model.
function modelOf(provider, m) {
  return {
    id: m.id,
    providerID: provider.id,
    name: m.name ?? m.id,
    api: { id: m.id, url: api(), npm: NPM },
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
  }
}

// reasoningEfforts are the account's model entry's declared levels, as
// offered: the supported list when it has one, else the effort or default.
function reasoningEfforts(r) {
  if (!r || typeof r !== "object") return undefined
  if (Array.isArray(r.supportedEfforts) && r.supportedEfforts.length) return r.supportedEfforts.map(String)
  if (typeof r.effort === "string" && r.effort) return [r.effort]
  if (typeof r.defaultEffort === "string" && r.defaultEffort) return [r.defaultEffort]
  return undefined
}

// The routing aliases the product config lists that the API itself refuses
// ("default", "fast-model", ...), and the non-chat models a chat provider
// should never offer.
const aliasModels = new Set(["default", "default-model", "fast-model", "balanced-model", "primary-model", "deep-model"])
const isNonChat = (id) => /^(?:image|embedding|video|tts|whisper|rerank|ocr)/i.test(id)

// ---- local sign-in --------------------------------------------------------

// authDir is where the CodeBuddy desktop keeps its logins, on the three
// platforms (as cb2ai reads it).
function authDir() {
  const home = homedir()
  const base =
    process.platform === "darwin" ? join(home, "Library", "Application Support", "CodeBuddyExtension")
    : process.platform === "win32" ? join(home, "AppData", "Local", "CodeBuddyExtension")
    : join(home, ".local", "share", "CodeBuddyExtension")
  return join(base, "Data", "Public", "auth")
}

// isCodeBuddyFile: the CodeBuddy desktop's own login files. WorkBuddy's
// workbuddy-desktop.info is skipped: its tokens are a $wbEncrypted
// envelope this plugin can't open.
const isCodeBuddyFile = (name) => /coding-copilot|codebuddy/i.test(name) && !/workbuddy/i.test(name)

// desktopFiles are the *.info login files of the CodeBuddy desktop, as
// regular files, in the given dir (the app's, by default).
function desktopFiles(dir = authDir()) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => n.endsWith(".info") && isCodeBuddyFile(n))
    .map((n) => join(dir, n))
    .filter((p) => {
      try {
        return statSync(p).isFile()
      } catch {
        return false
      }
    })
}

// desktopAuth is a login file's account as a sign-in: the tokens under
// auth, the account beside it. null for a file with none (a sealed token,
// no access token, or no uid).
function desktopAuth(file) {
  let f
  try {
    f = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
  const t = f?.auth ?? {}
  const sealed = (v) => !!(v && typeof v === "object" && v.$wbEncrypted)
  if (sealed(t.accessToken) || sealed(t.refreshToken)) return null
  if (typeof t.accessToken !== "string" || !t.accessToken || !f?.account?.uid) return null
  const now = Date.now()
  const acct = f.account
  return {
    access: t.accessToken,
    refresh: typeof t.refreshToken === "string" ? t.refreshToken : "",
    expires: t.expiresAt > 0 ? t.expiresAt : t.expiresIn > 0 ? now + t.expiresIn * 1000 : 0,
    refreshExpiresAt: t.refreshExpiresAt > 0 ? t.refreshExpiresAt : t.refreshExpiresIn > 0 ? now + t.refreshExpiresIn * 1000 : 0,
    domain: typeof t.domain === "string" ? t.domain : "",
    tokenType: typeof t.tokenType === "string" ? t.tokenType : "",
    uid: acct.uid,
    ...(typeof acct.enterpriseId === "string" && acct.enterpriseId.trim() ? { enterpriseId: acct.enterpriseId.trim() } : {}),
    name: acct.nickname || acct.phoneNumber || acct.displayName || acct.uid,
    file,
    source: "desktop",
  }
}

function isStale(a) {
  return !!a.expires && Date.now() >= a.expires - EARLY_MS
}

// readDesktop is the CodeBuddy desktop's sign-in, as the app keeps it:
// the first usable file — one whose access token isn't about to end — or
// the one expiring latest when none is. null for none.
function readDesktop(dir) {
  const now = Date.now()
  const usable = (a) => a.expires <= 0 || now < a.expires - EARLY_MS
  let best = null
  for (const file of desktopFiles(dir)) {
    const a = desktopAuth(file)
    if (!a) continue
    if (!best || (usable(a) && !usable(best)) || (usable(a) === usable(best) && a.expires >= best.expires)) best = a
  }
  return best
}

// notDesktop says why there is no desktop sign-in to use: every matching
// file is sealed, else the desktop isn't signed in.
function notDesktop(dir) {
  const files = desktopFiles(dir)
  if (!files.length) return `${SITE.name} desktop isn't signed in`
  for (const file of files) {
    let t = {}
    try {
      t = JSON.parse(readFileSync(file, "utf8"))?.auth ?? {}
    } catch {}
    if (t.accessToken?.$wbEncrypted || t.refreshToken?.$wbEncrypted)
      return `${SITE.name} desktop keeps its sign-in encrypted, which can't be read; open the desktop app and sign in again`
  }
  return `${SITE.name} desktop isn't signed in`
}

// desktopSignIn uses the account the CodeBuddy desktop is signed in to:
// nothing is copied (a renewed token would be the app's and the plugin's
// both, and the first to use it would sign the other out); its file is
// read each time, as the app keeps it.
function desktopSignIn(dir) {
  return {
    url: "",
    instructions: `Uses the account ${SITE.name} desktop is signed in to.`,
    method: "auto",
    async callback() {
      const d = readDesktop(dir)
      if (!d) return { type: "failed", error: notDesktop(dir) }
      return { type: "success", refresh: "", access: "", expires: 0, source: "desktop", accountId: d.name || SITE.name, uid: d.uid }
    },
  }
}

// ---- requests -------------------------------------------------------------

function domainOf(a) {
  return a.domain || SITE.defaultDomain
}

// enterpriseHeaders names the enterprise (team) an account signed in as:
// X-Enterprise-Id and X-Tenant-Id, both the account's enterpriseId, as the
// desktop's own client sends them. Without them the API answers as the
// personal account. A personal account has none and sends none.
function enterpriseHeaders(a) {
  const id = typeof a?.enterpriseId === "string" ? a.enterpriseId.trim() : ""
  return id ? { "X-Enterprise-Id": id, "X-Tenant-Id": id } : {}
}

// sign sets on headers what the CodeBuddy desktop sends with a chat: the
// account's token, user id, enterprise and domain (cb2ai's buildHeaders).
function sign(a, headers) {
  headers.set("Authorization", "Bearer " + a.access)
  headers.set("X-User-Id", a.uid ?? "")
  headers.set("X-Domain", domainOf(a))
  headers.set("User-Agent", UA)
  for (const [k, v] of Object.entries(enterpriseHeaders(a))) headers.set(k, v)
}

// ---- renewal --------------------------------------------------------------

const TOKEN_FIELDS = ["access", "refresh", "expires", "refreshExpiresAt", "domain", "tokenType"]

function refreshable(a) {
  return !!a.refresh && !(a.refreshExpiresAt && Date.now() >= a.refreshExpiresAt)
}

// merge takes a token CodeBuddy gave (a refresh) into the sign-in, times
// given as at-ms or in-seconds.
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

// merged is a with the tokens another's refresh gave over it.
function merged(a, next) {
  const out = { ...a }
  for (const k of TOKEN_FIELDS) if (k in next) out[k] = next[k]
  return out
}

// refreshToken spends a's refresh token at the backend. Nothing of the
// tokens is ever put in a message: a failure says the status and the
// backend's own message only.
async function refreshToken(a) {
  const res = await fetch(SITE.endpoint + "/v2/plugin/auth/token/refresh", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: "Bearer " + a.access,
      "X-Refresh-Token": a.refresh,
      "X-Auth-Refresh-Source": "plugin",
      "X-Domain": domainOf(a),
      "User-Agent": UA,
      ...enterpriseHeaders(a),
    },
    body: "{}",
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let env = {}
  try {
    env = JSON.parse(text)
  } catch {}
  if (!res.ok) {
    const why = env.msg || env.message || env.error?.message || text.slice(0, 200) || res.statusText
    throw new Error(`${SITE.name}: ${why} (HTTP ${res.status}${env.code ? ", code " + env.code : ""})`)
  }
  if (env.code) throw new Error(`${SITE.name}: ${env.msg || "error"} (${env.code})`)
  const data = env.data
  if (!data?.accessToken) throw new Error(`${SITE.name} gave no refreshed token`)
  return data
}

// renewing is each refresh under way, by the refresh token it spends;
// renewed is what each gave, kept a minute so one that read the old
// refresh token after it was spent takes that rather than spending it
// again.
const renewing = new Map()
const renewed = new Map()

function renew(a, save) {
  const key = a.refresh
  const done = renewed.get(key)
  if (done && Date.now() - done.at < KEEP_RENEWED_MS) return Promise.resolve(merged(a, done.next))
  let r = renewing.get(key)
  if (!r) {
    r = (async () => {
      const got = await refreshToken(a)
      if (!got?.accessToken) throw new Error(`${SITE.name} gave no refreshed token`)
      const next = merge(a, got)
      renewed.set(key, { next, at: Date.now() })
      await save?.(next)
      return next
    })().finally(() => renewing.delete(key))
    renewing.set(key, r)
  }
  return r.then((next) => merged(a, next))
}

// fresh is the sign-in with an access token that isn't about to end:
// refreshed when it is, and only held here (save is called by the caller,
// for a sign-in whose tokens the host keeps). A refresh that fails, or a
// refresh token that has ended, leaves the access token there is.
async function fresh(client, a) {
  if (!isStale(a)) return a
  if (!refreshable(a)) {
    if (a.access) return a
    throw new Error(`this ${SITE.name} account is signed out; sign in again`)
  }
  try {
    return await renew(a, async (next) => {
      try {
        await client?.auth?.set?.({ path: { id: SITE.id }, body: next })
      } catch {}
    })
  } catch (e) {
    if (a.access) return a
    throw e
  }
}

// held is what a desktop sign-in was renewed to here, by uid: kept in
// memory only, never written where the app keeps it.
const held = new Map()

// current is the sign-in a stored auth names, fresh: the CodeBuddy
// desktop's, read where it keeps it, or one renewed here. dir is the auth
// folder to read (the desktop's, by default; tests pass their own).
async function current(client, auth, dir) {
  if (auth?.source !== "desktop") return fresh(client, auth)
  const d = readDesktop(dir)
  if (!d) throw new Error(notDesktop(dir))
  const h = held.get(d.uid)
  const a = await fresh(null, h && h.expires >= d.expires ? h : d)
  held.set(d.uid, a)
  return a
}

// refreshed is what magpie's auth.refresh gives for a sign-in the host
// keeps: the fields a refresh changed, nothing when there's nothing to
// renew, and nothing for a desktop sign-in (its file is read each time).
async function refreshed(auth) {
  if (auth?.type !== "oauth" || auth.source === "desktop" || !auth.access || !auth.refresh) return undefined
  if (!refreshable(auth)) throw new Error(`this ${SITE.name} account is signed out; sign in again`)
  const next = await renew(auth)
  const out = {}
  for (const k of TOKEN_FIELDS) if (k in next && next[k] !== auth[k]) out[k] = next[k]
  return Object.keys(out).length ? out : undefined
}

// ---- live models ----------------------------------------------------------

const lists = new Map()
const listKey = (a) => `${a.uid ?? ""}|${a.enterpriseId ?? ""}`

// liveModels is the account's enterprise model config as the backend keeps
// it (cb2ai's List): GET /console/enterprises/<eid>/config/models with the
// account's headers. A personal account (no enterprise id) has none.
async function liveModels(a) {
  const eid = a.enterpriseId
  if (!eid) return []
  const res = await fetch(SITE.endpoint + "/console/enterprises/" + encodeURIComponent(eid) + "/config/models", {
    method: "GET",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: "Bearer " + a.access,
      "X-User-Id": a.uid ?? "",
      "X-Domain": domainOf(a),
      "User-Agent": UA,
      ...enterpriseHeaders(a),
    },
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) return []
  const env = await res.json().catch(() => null)
  return env && Array.isArray(env.data) ? env.data : []
}

// toEntry is a config model as the plugin serves it.
function toEntry(m) {
  if (!m || typeof m !== "object") return null
  const id = String(m.id ?? "")
  if (!id || aliasModels.has(id) || isNonChat(id)) return null
  const context = Number(m.maxInputTokens) > 0 ? Number(m.maxInputTokens) : Number(m.maxAllowedSize) || 0
  return {
    id,
    name: typeof m.name === "string" && m.name ? m.name : id,
    context,
    output: Number(m.maxOutputTokens) > 0 ? Number(m.maxOutputTokens) : 0,
    images: !!m.supportsImages,
    efforts: reasoningEfforts(m.reasoning),
  }
}

// listed is the account's live list as read, cached for PRICE_TTL.
async function listed(a, fresh = false) {
  const k = listKey(a)
  const was = lists.get(k)
  if (!fresh && was && Date.now() - was.at < PRICE_TTL) return was.list
  let list = []
  try {
    list = await liveModels(a)
  } catch {}
  lists.set(k, { at: Date.now(), list })
  if (lists.size > 64) lists.delete(lists.keys().next().value)
  return list
}

// ---- one plugin -----------------------------------------------------------

function makePlugin() {
  return async ({ client }) => {
    return {
      config: async (config) => {
        config.provider ??= {}
        config.provider[SITE.id] ??= {}
        const p = config.provider[SITE.id]
        p.name ??= SITE.name
        p.npm ??= NPM
        p.api ??= api()
        p.models = { ...configModels(), ...(p.models ?? {}) }
      },
      provider: {
        id: SITE.id,
        // the account's own model list, when it's signed in as an
        // enterprise and the backend answers; else the static list above
        async models(provider, { auth }) {
          if (auth?.type !== "oauth" || !(auth.access || auth.source)) return provider.models
          try {
            const a = await current(client, auth)
            const entries = (await listed(a, true)).map(toEntry).filter(Boolean)
            if (!entries.length) return provider.models
            return Object.fromEntries(entries.map((m) => [m.id, modelOf(provider, m)]))
          } catch {
            return provider.models
          }
        },
      },
      auth: {
        provider: SITE.id,
        refreshLead: LEAD_MS,
        rotating: true,
        refresh: (auth) => refreshed(auth),
        methods: [
          {
            type: "oauth",
            label: `${SITE.name} desktop's sign-in`,
            authorize: () => desktopSignIn(),
          },
        ],
        async loader(getAuth) {
          const auth = await getAuth()
          if (auth?.type !== "oauth") return {}
          return {
            // no baseURL: a model's own api.url says where it is served,
            // <endpoint>/v2 for every chat
            baseURL: "",
            apiKey: "",
            async fetch(input, init) {
              const stored = await getAuth()
              if (stored?.type !== "oauth") throw new Error(`${SITE.name} isn't signed in`)
              const a = await current(client, stored)
              const req = input instanceof Request ? input : null
              const headers = new Headers(init?.headers ?? req?.headers)
              headers.delete("authorization")
              headers.delete("x-api-key")
              headers.delete("content-length")
              sign(a, headers)
              let body = init?.body
              if (body === undefined && req) body = await req.clone().text()
              const url = input instanceof Request ? input.url : String(input)
              const res = await fetch(url, { ...init, method: init?.method ?? req?.method, headers, body })
              if (res.status !== 401) return res
              // a 401: the token was refused. The desktop account is never
              // marked expired — its file is read on each request, so
              // signing in to the desktop app again is enough.
              await res.body?.cancel().catch(() => {})
              const message =
                `${SITE.name} refused this account's sign-in (401). ` +
                (a.source === "desktop" ? `Open ${SITE.name} desktop and sign in again.` : `Sign in to ${SITE.name} again.`)
              return new Response(JSON.stringify({ error: { message, type: "authentication_error", code: 401 } }), {
                status: 401,
                statusText: "Unauthorized",
                headers: { "content-type": "application/json", "X-Magpie-Sign-In": a.source === "desktop" ? "kept" : "expired" },
              })
            },
          }
        },
      },
    }
  }
}

export const CodeBuddyAuthPlugin = makePlugin()
export const _internal = { SITE, api, UA, MODELS, configModels, modelOf, variants, authDir, isCodeBuddyFile, desktopFiles, desktopAuth, readDesktop, notDesktop, desktopSignIn, domainOf, enterpriseHeaders, sign, isStale, refreshable, merge, merged, refreshToken, renew, fresh, current, refreshed, liveModels, toEntry, listed, makePlugin }
