// WPS Comate (金山办公 Comate) as an OpenAI-compatible provider for magpie
// and OpenCode.
//
// Comate's desktop app (WPSComate.exe) keeps the account it is signed in to
// as a DPAPI blob in %USERPROFILE%\.wpscomate\agent\auth\user_auth.json; the
// blob's plaintext is the wps_sid cookie. config.json's providers.official
// holds the per-device API key and the base URL the app's own agent calls.
// Both files stay readable while Comate runs, so this plugin needs no sign-in
// of its own: it reads the app's account on each request.
//
// Measured 2026-11-20 against https://comate.wps.cn/llmproxy/v1/user: GET
// /models and POST /chat/completions (streaming too) answer OpenAI-shaped
// JSON when sent Cookie: wps_sid=<sid> and Authorization: Bearer <apiKey>.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"

const NPM = "@ai-sdk/openai-compatible"
const ID = "wps-comate"
const NAME = "WPS Comate"
const DEFAULT_BASE = "https://comate.wps.cn/llmproxy/v1/user"

// Comate's listing for this account (GET /models, 2026-11-20). The id is the
// request's model field, so it stays the cloud's own name.
const MODELS = [
  ["610387340/deepseek/deepseek-v4-pro//public", "DeepSeek V4 Pro", false],
  ["610387340/deepseek/deepseek-v4.1-flash//public", "DeepSeek V4.1 Flash", true],
  ["610387340/minimax/MiniMax-M3//public", "MiniMax M3", true],
  ["610387340/xiaomi/mimo-v2.6-flash//public", "MiMo V2.6 Flash", true],
  ["610387340/xiaomi/mimo-v2.6-pro//public", "MiMo V2.6 Pro", true],
  ["610387340/zhipu/glm-5.2//public", "GLM-5.2", false],
  ["610387340/zhipu/glm-5.3-flash//public", "GLM-5.3 Flash", true],
  ["610387340/zhipu/glm-5.3//public", "GLM-5.3", false],
]
const CONTEXT = 1_000_000
const OUTPUT = 32_768

const appDir = () => join(homedir(), ".wpscomate")
const appConfig = () => join(appDir(), "config.json")
const appAuth = () => join(appDir(), "agent", "auth", "user_auth.json")

// dpapiUnprotect decrypts a base64 DPAPI blob as the current Windows user, in
// PowerShell: the account file is DPAPI's, which Node has no API for.
function dpapiUnprotect(b64) {
  const ps = [
    "Add-Type -AssemblyName System.Security",
    `$b=[Convert]::FromBase64String('${String(b64).replace(/'/g, "")}')`,
    "$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser')",
    "[Convert]::ToBase64String($p)",
  ].join("; ")
  const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  }).trim()
  return Buffer.from(out, "base64").toString("utf8").trim()
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"))

// deviceKey reads config.json's device key and base URL; absent (an older
// install), the URL known on 2026-11-20 alone.
function deviceKey() {
  try {
    const official = readJson(appConfig())?.providers?.official ?? {}
    return { key: official.apiKey ?? "", url: (official.baseUrl || DEFAULT_BASE).replace(/\/+$/, "") }
  } catch {
    return { key: "", url: DEFAULT_BASE }
  }
}

let cache = { savedAt: null, sid: "" }

// cookieOf is the wps_sid the Comate app is signed in with, decrypted from
// its account file; kept until the app writes a new sign-in (saved_at), or
// force says a 401 made the cached one suspect.
function cookieOf(force = false) {
  const file = appAuth()
  if (!existsSync(file)) {
    throw new Error(
      "WPS Comate 未安装或未登录：找不到 %USERPROFILE%\\.wpscomate\\agent\\auth\\user_auth.json。请先安装并登录 WPS Comate。",
    )
  }
  const auth = readJson(file)
  if (!force && cache.sid && cache.savedAt === auth.saved_at) return cache.sid
  if (!auth?.token) throw new Error("WPS Comate 的登录文件里没有 token，请重新登录 Comate。")
  const sid = dpapiUnprotect(auth.token)
  if (!sid) throw new Error("WPS Comate 的登录 token 解密为空，请重新登录 Comate。")
  cache = { savedAt: auth.saved_at, sid }
  return sid
}

// Comate prices each answer itself: usage.credits in the chat.completion
// body, and in the last chunk of a stream (the chunks before it carry a
// zero). The vendor has no per-account figure to read, but what this machine
// spent is known, so it is counted here -- today, this conversation, and all
// time -- and kept on disk, so a restart does not lose it.
const MAX_TRACK = 4 * 1024 * 1024
const pendingTracked = new Set()

const stateDir = () => join(homedir(), ".magpie")
const stateFile = () => join(stateDir(), "wps-comate-usage.json")
const KEEP_DAYS = 30
const KEEP_SESSIONS = 100

const round6 = (n) => Math.round(n * 1e6) / 1e6
const localDay = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function emptyState() {
  return { v: 1, total: { credits: 0, calls: 0 }, days: {}, sessions: {} }
}

function loadState() {
  try {
    const s = JSON.parse(readFileSync(stateFile(), "utf8"))
    if (s && s.v === 1 && s.total && s.days && s.sessions) return s
  } catch {}
  return emptyState()
}

let state = emptyState()
let statePath = ""
// the file is looked up per call: tests point USERPROFILE at a temporary home
function stateNow() {
  const p = stateFile()
  if (p !== statePath) {
    statePath = p
    state = loadState()
  }
  return state
}

function saveState() {
  try {
    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(statePath || stateFile(), JSON.stringify(state), "utf8")
  } catch {}
}

function prune(st) {
  const days = Object.keys(st.days).sort()
  for (const d of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) delete st.days[d]
  const ids = Object.keys(st.sessions).sort((a, b) => (st.sessions[a].at ?? 0) - (st.sessions[b].at ?? 0))
  for (const id of ids.slice(0, Math.max(0, ids.length - KEEP_SESSIONS))) delete st.sessions[id]
}

function addTo(bucket, credits) {
  bucket.calls++
  bucket.credits = round6(bucket.credits + credits)
}

function noteCredits(credits, session) {
  if (typeof credits !== "number" || !Number.isFinite(credits) || credits <= 0) return
  const st = stateNow()
  addTo(st.total, credits)
  addTo((st.days[localDay()] ??= { credits: 0, calls: 0 }), credits)
  if (session) {
    const s = (st.sessions[session] ??= { credits: 0, calls: 0, at: 0 })
    addTo(s, credits)
    s.at = Date.now()
  }
  prune(st)
  saveState()
}

function noteUsage(usage, session) {
  noteCredits(usage?.credits, session)
}

// trackSpend reads a copy of the answer: the stream still goes to the caller
// untouched, and the copy is dropped once its usage is known.
function trackSpend(res, session) {
  if (!res.ok || !res.body) return
  const copy = res.clone()
  const p = (async () => {
    const type = copy.headers.get("content-type") ?? ""
    if (type.includes("text/event-stream")) {
      const reader = copy.body.getReader()
      const decoder = new TextDecoder()
      let buf = ""
      let last = null
      let seen = 0
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        seen += value?.length ?? 0
        if (seen > MAX_TRACK) {
          await reader.cancel().catch(() => {})
          break
        }
        buf += decoder.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (!line.startsWith("data:")) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === "[DONE]") continue
          try {
            const usage = JSON.parse(payload)?.usage
            if (usage) last = usage
          } catch {}
        }
      }
      // every chunk of a stream repeats usage; the last one is the answer's
      noteUsage(last, session)
    } else {
      const text = await copy.text()
      if (text.length > MAX_TRACK) return
      try {
        noteUsage(JSON.parse(text)?.usage, session)
      } catch {}
    }
  })()
    .catch(() => {})
    .finally(() => pendingTracked.delete(p))
  pendingTracked.add(p)
}

// the conversation the request belongs to, as magpie names it for the plugin
const sessionOf = (headers) => String(headers?.get?.("x-magpie-session") ?? "").trim().slice(0, 120)


const line = (bucket, none) => (bucket?.calls ? `${bucket.credits} 智点（${bucket.calls} 次请求）` : none)

// An organisation account's /credits answers with a verdict and no figure; a
// personal one may answer with a balance. When a number is there it is shown;
// when it is not, the card simply shows the spend (no quota line at all).
let quotaCache = { at: 0, sid: "", value: undefined }

function pickNumber(d) {
  if (!d || typeof d !== "object") return undefined
  for (const k of ["balance", "remaining", "remain", "left", "credits", "available", "total", "quota"]) {
    const v = d[k]
    if (typeof v === "number" && Number.isFinite(v)) return v
    if (v && typeof v === "object") {
      for (const kk of ["remaining", "balance", "left", "total"]) {
        if (typeof v[kk] === "number" && Number.isFinite(v[kk])) return v[kk]
      }
    }
  }
  return undefined
}

async function quotaLine(getAuth) {
  const now = Date.now()
  let sid = ""
  try {
    const auth = await getAuth()
    sid = auth?.type === "api" ? String(auth.key ?? "").trim() : auth?.type === "oauth" ? String(auth.access ?? "").trim() : ""
    if (!sid) sid = cookieOf(false)
    if (!sid) return null
    // a different account is a different quota: never answer it from the cache
    if (quotaCache.sid === sid && quotaCache.value !== undefined && now - quotaCache.at < 5 * 60 * 1000) return quotaCache.value
    const { key, url } = deviceKey()
    const headers = new Headers()
    if (key) headers.set("Authorization", `Bearer ${key}`)
    headers.set("Cookie", `wps_sid=${sid}`)
    const res = await globalThis.fetch(`${url}/credits`, { method: "GET", headers })
    if (!res.ok) return (quotaCache = { at: now, sid, value: null }).value
    const d = (await res.json().catch(() => null))?.data ?? {}
    const n = pickNumber(d)
    // display only: with amount magpie rewrites the unit to "credits"
    const out = n === undefined ? null : { name: "剩余额度", display: `${n} 智点` }
    return (quotaCache = { at: now, sid, value: out }).value
  } catch {
    return (quotaCache = { at: now, sid, value: null }).value
  }
}

const configModels = () =>
  Object.fromEntries(
    MODELS.map(([id, name, images]) => [
      id,
      {
        name,
        limit: { context: CONTEXT, output: OUTPUT },
        tool_call: true,
        attachment: images,
        modalities: { input: images ? ["text", "image"] : ["text"], output: ["text"] },
      },
    ]),
  )

export const WpsComateAuthPlugin = async () => ({
  config: async (config) => {
    config.provider ??= {}
    config.provider[ID] ??= {}
    const p = config.provider[ID]
    p.name ??= NAME
    p.npm ??= NPM
    p.api ??= DEFAULT_BASE
    p.models = { ...configModels(), ...(p.models ?? {}) }
  },
  provider: {
    id: ID,
    async models(provider) {
      return provider.models
    },
  },
  auth: {
    provider: ID,
    loader: async (getAuth) => {
      const auth = await getAuth()
      // the sign-in magpie holds: a pasted wps_sid (api) or the one a sign-in
      // read (oauth). Only when there is none does the account file get read
      // and decrypted on each request.
      const stored = auth?.type === "api" ? String(auth.key ?? "").trim() : auth?.type === "oauth" ? String(auth.access ?? "").trim() : ""
      const { key, url } = deviceKey()
      const sidOf = (force) => (!force && stored ? stored : cookieOf(force))
      const first = sidOf(false)
      return {
        baseURL: url,
        apiKey: key,
        async fetch(input, init) {
          const req = input instanceof Request ? input : null
          const target = String(req ? req.url : input)
          const headers = new Headers(init?.headers ?? req?.headers)
          headers.delete("authorization")
          headers.delete("x-api-key")
          headers.delete("content-length")
          const k = deviceKey()
          if (k.key) headers.set("Authorization", `Bearer ${k.key}`)
          headers.set("Cookie", `wps_sid=${first}`)
          let body = init?.body
          if (body === undefined && req) body = await req.clone().text()
          const session = sessionOf(headers)
          const send = async () => {
            const out = await globalThis.fetch(target, { ...init, method: init?.method ?? req?.method ?? "POST", headers, body })
            if (out.ok) trackSpend(out, session)
            return out
          }
          const res = await send()
          // a refused cookie: Comate may have signed in again and rewritten
          // its account file, so it is read once more and the request sent
          // again — only for a body that can go again, and never a third time
          if (res.status !== 401) return res
          if (body != null && typeof body !== "string" && !ArrayBuffer.isView(body) && !(body instanceof ArrayBuffer)) return res
          let sid
          try {
            sid = cookieOf(true)
          } catch {
            return res
          }
          if (!sid) return res
          headers.set("Cookie", `wps_sid=${sid}`)
          return send()
        },
      }
    },
    // the composer's card: what this machine spent, taken from the usage.credits
    // every answer carries -- today, this conversation, and all time. Comate's
    // own /credits is asked only for a balance, and an account that has no figure
    // to give simply shows the spend instead.
    usage: async (getAuth) => {
      // a request still streaming has its price in flight: give it a moment
      if (pendingTracked.size) await Promise.race([Promise.allSettled([...pendingTracked]), new Promise((r) => setTimeout(r, 1000))])
      const st = stateNow()
      const today = st.days[localDay()] ?? { credits: 0, calls: 0 }
      const lastId = Object.keys(st.sessions).sort((a, b) => (st.sessions[b].at ?? 0) - (st.sessions[a].at ?? 0))[0]
      const last = lastId ? st.sessions[lastId] : null
      const windows = [
        { name: "今日消耗", display: line(today, "今天还没有请求") },
        { name: "本对话消耗", display: last ? line(last, "还没有记录") : "还没有记录" },
        { name: "总计消耗", display: line(st.total, "还没有请求") },
      ]
      const q = await quotaLine(getAuth)
      if (q) windows.push(q)
      return { plan: "WPS Comate", windows, signIn: "kept" }
    },
    methods: [
      {
        type: "oauth",
        label: "WPS Comate 本机登录（自动读取）",
        // the account is the desktop app's own: nothing to ask, nothing to
        // open, the callback reads and decrypts it
        authorize: async () => ({
          url: "",
          instructions: "使用本机已登录的 WPS Comate 账号（自动读取）。",
          method: "auto",
          async callback() {
            const sid = cookieOf(true)
            return { type: "success", refresh: "", access: sid, expires: 0, accountId: "WPS Comate" }
          },
        }),
      },
      {
        type: "api",
        label: "粘贴 wps_sid（自动读取失败时）",
        placeholder: "wps_sid cookie 的值（V02S…）",
      },
    ],
  },
})
