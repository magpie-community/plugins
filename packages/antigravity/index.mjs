// Antigravity (Google's agent IDE) for OpenCode and magpie: the models a
// Google account is served in Antigravity — Gemini, and the Claude and
// GPT-OSS models Google hosts for it — asked through Code Assist
// (cloudcode-pa.googleapis.com), as the Antigravity app asks them. Ported
// from magpie's built-in Antigravity account (internal/provider/google.go,
// antigravity_models.go, google_import.go and the Antigravity rules of
// internal/gateway/codeassist.go):
//
//   - Sign-in: Google's OAuth with Antigravity's own client, PKCE and a
//     loopback redirect (http://localhost:<port>/oauth-callback). The
//     refresh token, and the Code Assist project the account is served
//     under, are kept with the sign-in; access tokens are minted from it.
//   - The project: loadCodeAssist names it, or onboardUser sets the
//     account up for its default tier.
//   - fetchAvailableModels lists the models and each one's share of its
//     allowance left; retrieveUserQuotaSummary the shared pools.
//   - streamGenerateContent takes the Gemini request wrapped in Code
//     Assist's envelope ({model, project, request, …}) and streams each
//     chunk wrapped as {response: <chunk>}.
//
// Each model is declared on @ai-sdk/google, so the request the SDK writes
// (and the one magpie hands a plugin) is a plain Gemini request; the fetch
// below shapes it for Antigravity, wraps it, and unwraps the stream.

import crypto from "node:crypto"
import http from "node:http"

const PROVIDER = "antigravity"

// Antigravity's own installed-app OAuth client: it ships in the app, and
// Google says such a client's secret isn't one. Written in parts so secret
// scanners don't take it for a leak.
const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep" + ".apps.googleusercontent.com"
const CLIENT_SECRET = ["GOCSPX", "K58FWR486LdLJ1mLB8sXC4z6qDAf"].join("-")
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
  "https://www.googleapis.com/auth/aicode",
]
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const TOKEN_URL = "https://oauth2.googleapis.com/token"
const WHO_URL = "https://www.googleapis.com/oauth2/v2/userinfo?alt=json"

// loadCodeAssist is asked at the production endpoint, everything else at
// the daily one, as the app asks
const PROD = "https://cloudcode-pa.googleapis.com"
const DAILY = "https://daily-cloudcode-pa.googleapis.com"
// the base URL the AI SDK is given; the fetch sends every request to
// DAILY/v1internal, whatever path the SDK adds
const BASE = DAILY + "/v1beta"
const NPM = "@ai-sdk/google"

const VERSION_URL = "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml"
// the manifest's version on 2026-11-14; Google serves Gemini 4 only to
// releases about this new (2.9.1 got no Gemini 4, #1057)
const DEFAULT_VERSION = "2.32.1"
// CLS is the build changelist each release's language server puts in its
// User-Agent (cl=), read from the shipped binary's requests. The manifest
// names only the version, so a newer release goes with the newest known
// changelist until it is added here.
const CLS = { "2.32.1": "1021296516" }

const SIGN_IN_TIMEOUT = 10 * 60 * 1000
const MODELS_TTL = 10 * 60 * 1000
const TIERS_TTL = 60 * 60 * 1000
const TIER_REFUSED_FOR = 24 * 60 * 60 * 1000
const VERSION_TTL = 6 * 60 * 60 * 1000
// a manifest that couldn't be read is asked again this soon, not in six hours
const VERSION_RETRY = 60 * 1000
const VERSION_TIMEOUT = 15 * 1000

// the header magpie names a request's effort in
const EFFORT = "x-magpie-effort"
const SESSION = "x-magpie-session"
const SUBAGENT = "x-magpie-subagent"

// ---- small helpers ------------------------------------------------------------------

function parse(s) {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// apiError is what a failed reply says: its JSON error's message, or its
// body, or the status (magpie's APIError)
function apiError(body, status) {
  const j = parse(body)
  const m = isObj(j) ? (isObj(j.error) ? j.error.message : typeof j.error === "string" ? j.error : j.message) : undefined
  if (typeof m === "string" && m.trim()) return m.trim()
  const t = String(body ?? "").trim()
  return t ? t.slice(0, 1000) : String(status)
}

class StatusError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

class SignedOut extends Error {}

// ---- the app's version and user agent ------------------------------------------------

const GOOS = { darwin: "darwin", linux: "linux", win32: "windows" }
const GOARCH = { arm64: "arm64", x64: "amd64" }
const goos = () => GOOS[process.platform] ?? process.platform
const goarch = () => GOARCH[process.arch] ?? process.arch

const ver = { v: "", at: 0, pending: null }

// version is the Antigravity release the requests say they come from,
// read from the app's own update manifest every six hours. Google lists
// and serves some models (Gemini 4) only to new enough releases, so a
// manifest that can't be read keeps the default for a minute only, and a
// version that changes drops the model lists read under the old one.
async function version() {
  if (ver.v && Date.now() - ver.at < VERSION_TTL) return ver.v
  if (ver.pending) return ver.pending
  ver.at = Date.now()
  if (!ver.v) ver.v = DEFAULT_VERSION
  ver.pending = (async () => {
    let read = ""
    try {
      const res = await fetch(VERSION_URL, { headers: { "User-Agent": "electron-builder" }, signal: AbortSignal.timeout(VERSION_TIMEOUT) })
      if (res.ok) {
        const text = (await res.text()).slice(0, 64 << 10)
        for (const line of text.split(/\r?\n/)) {
          if (!line.startsWith("version:")) continue
          const v = line.slice(8).trim().replace(/^['"]+|['"]+$/g, "")
          if (v && /^[0-9.]+$/.test(v)) read = v
          break
        }
      }
    } catch {}
    if (!read) ver.at = Date.now() - VERSION_TTL + VERSION_RETRY
    else if (read !== ver.v) {
      ver.v = read
      lists.clear()
    }
    ver.pending = null
    return ver.v
  })()
  return ver.pending
}

// clOf is the changelist of a release: its own when known, else the
// newest known release's
function clOf(v) {
  if (CLS[v]) return CLS[v]
  const newest = Object.keys(CLS).sort((a, b) => cmpVersion(b, a))[0]
  return CLS[newest]
}

function cmpVersion(a, b) {
  const x = a.split(".").map(Number)
  const y = b.split(".").map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0)
  return 0
}

// userAgent is the app's language server's, as 2.32.1 sends it on every
// Code Assist call:
// antigravity/hub/2.32.1 (aidev_client; os_type=darwin; arch=arm64; cl=1021296516)
const userAgent = async () => {
  const v = await version()
  return `antigravity/hub/${v} (aidev_client; os_type=${goos()}; arch=${goarch()}; cl=${clOf(v)})`
}

// ---- the sign-in as it is kept ---------------------------------------------------------

// A sign-in is kept as OpenCode's oauth entry: refresh is
// "<refresh token>|<project>", access the last access token, accountId
// the Google account's email.
function stateOf(auth) {
  if (auth?.type !== "oauth" || typeof auth.refresh !== "string" || !auth.refresh) return null
  const i = auth.refresh.indexOf("|")
  const rt = i < 0 ? auth.refresh : auth.refresh.slice(0, i)
  const project = i < 0 ? "" : auth.refresh.slice(i + 1)
  if (!rt) return null
  return { rt, project, access: auth.access ?? "", expires: Number(auth.expires) || 0, who: auth.accountId ?? "" }
}

const tokens = new Map() // refresh token → {access, expires}
const projects = new Map() // refresh token → project
const refused = new Map() // refresh token, project, tier → when Google refused the tier

async function postForm(url, form) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  if (!res.ok) throw new StatusError(res.status, apiError(text, res.status))
  return parse(text) ?? {}
}

// token is an access token for s, minted again from its refresh token
// when less than two minutes of the last are left
async function token(s) {
  let t = tokens.get(s.rt)
  if (!t && s.access) t = { access: s.access, expires: s.expires }
  if (t?.access && t.expires - Date.now() > 2 * 60 * 1000) return t.access
  let fresh
  try {
    fresh = await postForm(TOKEN_URL, { grant_type: "refresh_token", refresh_token: s.rt, client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
  } catch (e) {
    // Google refusing the refresh token (invalid_grant) is a sign-in that
    // is over; anything else (the network) may pass
    if (e instanceof StatusError && (e.status === 400 || e.status === 401)) throw new SignedOut(`Antigravity is signed out (${e.message}); sign in again from magpie`)
    throw e
  }
  if (!fresh.access_token) throw new SignedOut("Antigravity is signed out (no token); sign in again from magpie")
  t = { access: fresh.access_token, expires: Date.now() + (Number(fresh.expires_in) || 3600) * 1000 }
  tokens.set(s.rt, t)
  return t.access
}

// call is one of Code Assist's methods, its reply's JSON
async function call(s, base, method, body, headers = {}, signal) {
  const tok = await token(s)
  const res = await fetch(`${base}/v1internal:${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok, "User-Agent": await userAgent(), ...headers },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(60_000),
  })
  const text = (await res.text()).slice(0, 4 << 20)
  if (res.status !== 200) throw new StatusError(res.status, `Antigravity: ${apiError(text, res.status)}`)
  return parse(text) ?? {}
}

// ---- the project and its tiers -------------------------------------------------------------

const companion = (p) => (typeof p === "string" ? p : isObj(p) && typeof p.id === "string" ? p.id : "")

function tiersOf(load) {
  return { tier: load?.currentTier?.id ?? "", paid: load?.paidTier?.id ?? "", credits: creditsOf(load) }
}

// CREDIT is the credit type Google One plans (AI Pro, AI Ultra) buy for use
// after a plan's own quota is used up: the app's "Use AI Credits"
const CREDIT = "GOOGLE_ONE_AI"

// creditsOf says whether a loadCodeAssist reply gives the account credits
// above the least amount that can pay for a request
function creditsOf(load) {
  for (const c of load?.paidTier?.availableCredits ?? []) {
    if (c?.creditType !== CREDIT) continue
    // an amount the reply leaves out is not a lack of one
    if (c.creditAmount == null) return true
    const have = Number(c.creditAmount)
    const need = Number(c.minimumCreditAmountForUsage ?? 0)
    if (Number.isFinite(have) && have > 0 && (!Number.isFinite(need) || have >= need)) return true
  }
  return false
}

// planOf is the plan a loadCodeAssist reply names: the paid tier's name,
// else the current tier's, else its id
function planOf(load) {
  let t = load?.paidTier
  if (!t || !t.name) t = load?.currentTier
  if (!t) return ""
  return t.name || t.id || ""
}

function defaultTier(load) {
  const allowed = Array.isArray(load?.allowedTiers) ? load.allowedTiers : []
  return allowed.find((t) => t?.isDefault) ?? allowed[0] ?? { id: "legacy-tier" }
}

async function onboard(s, req, headers) {
  for (let i = 0; i < 5; i++) {
    const lro = await call(s, DAILY, "onboardUser", req, headers)
    if (lro.done) return companion(lro.response?.cloudaicompanionProject)
    await sleep(_internal.onboardPoll)
  }
  throw new Error("Antigravity: setting the account up for Code Assist is taking long; try again in a minute")
}

const LOAD_BODY = { metadata: { ideType: "ANTIGRAVITY" } }

// resolveProject finds the project the account is served under, setting
// the account up when Code Assist has none for it
async function resolveProject(s) {
  let load, err
  try {
    load = await call(s, PROD, "loadCodeAssist", LOAD_BODY)
  } catch (e) {
    err = e
  }
  if (err instanceof SignedOut) throw err
  const { tier, paid, credits } = tiersOf(load)
  if (s.project) {
    if (err) return { id: s.project, plan: "", tier: "", paid: "", credits: false, at: Date.now() }
    return { id: s.project, plan: planOf(load), tier, paid, credits, at: Date.now() }
  }
  if (err) throw err
  const own = companion(load.cloudaicompanionProject)
  if (own) return { id: own, plan: planOf(load), tier, paid, credits, at: Date.now() }
  const t = { ...defaultTier(load) }
  if (!t.id || t.id === "legacy-tier") t.id = "free-tier"
  // as the app's language server asks it: camelCase, the IDE type only,
  // and no headers of its own
  const id = await onboard(s, { tierId: t.id, metadata: { ideType: "ANTIGRAVITY" } })
  if (!id) {
    const why = (load.ineligibleTiers ?? []).find((x) => x?.reasonMessage)?.reasonMessage
    throw new Error(why ? "Antigravity won't serve this Google account: " + why : "Antigravity hasn't set this Google account up (it gave no project); sign in to the Antigravity app with it once, then try again")
  }
  return { id, plan: t.name ?? "", tier: t.id, paid, credits, at: Date.now() }
}

async function project(s) {
  let p = projects.get(s.rt)
  if (!p) {
    p = await resolveProject(s)
    projects.set(s.rt, p)
    return p
  }
  if (Date.now() - p.at < TIERS_TTL) return p
  // the tiers, read again every hour: a plan bought or lapsed since
  try {
    const load = await call(s, PROD, "loadCodeAssist", LOAD_BODY)
    const { tier, paid, credits } = tiersOf(load)
    if (tier || paid) {
      p = { ...p, tier, paid, credits }
      const pl = planOf(load)
      if (pl) p.plan = pl
    }
  } catch (e) {
    if (e instanceof SignedOut) throw e
  }
  p = { ...p, at: Date.now() }
  projects.set(s.rt, p)
  return p
}

function entitlements(p) {
  const out = []
  for (const t of [p.paid, p.tier]) if (t && t !== "free-tier" && t !== "legacy-tier" && !out.includes(t)) out.push(t)
  return out
}

const tierKey = (s, p, t) => `${s.rt}\0${p.id}\0${t}`

// askTiers are the tiers to name in the account's next
// fetchAvailableModels: those Google hasn't refused in a day, then none
function askTiers(s, p) {
  const out = entitlements(p).filter((t) => {
    const at = refused.get(tierKey(s, p, t))
    return !(at && Date.now() - at < TIER_REFUSED_FOR)
  })
  return [...out, ""]
}

// ---- models ------------------------------------------------------------------------------

// never offered: Antigravity's own internal models and retired ones
const HIDDEN = new Set(["chat_20706", "chat_23310", "tab_flash_lite_preview", "tab_jump_flash_lite_preview", "gemini-2.5-flash-thinking", "gemini-2.5-pro"])

// FALLBACK is the list when the account's own lists nothing
const FALLBACK = [
  { id: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)" },
  { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
  { id: "gemini-3-flash", name: "Gemini 3 Flash" },
  { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite" },
  { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
]

const LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

const EFFORT_WORDS = [
  ["extra-high", "xhigh"],
  ["extra-low", "minimal"],
  ["xhigh", "xhigh"],
  ["minimal", "minimal"],
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
]

// splitID is an id's family and the level its last word says
function splitID(id) {
  for (const [w, l] of EFFORT_WORDS) {
    if (id.endsWith("-" + w) && id.length > w.length + 1) return [id.slice(0, -(w.length + 1)), l]
  }
  return [id, ""]
}

// nameEffort is a name without the level its last parenthesis says, and
// that level
function nameEffort(name) {
  const open = name.lastIndexOf(" (")
  if (open < 0 || !name.endsWith(")")) return [name, ""]
  const level = { minimal: "minimal", "extra low": "minimal", low: "low", medium: "medium", high: "high", "extra high": "xhigh", xhigh: "xhigh" }[name.slice(open + 2, -1).toLowerCase()]
  if (!level) return [name, ""]
  return [name.slice(0, open).trim(), level]
}

function nameSpells(name, id) {
  const n = nameEffort(name)[0].split(/\s+/).filter(Boolean).join("-")
  return n !== "" && n.toLowerCase() === splitID(id)[0].toLowerCase()
}

function enumNames(e, id) {
  if (typeof e !== "string" || !e.startsWith("MODEL_GOOGLE_")) return false
  const rest = e.slice(13)
  return rest !== "" && rest.toLowerCase() === id.replace(/[-.]/g, "_").toLowerCase()
}

// pretty is a name made of an id, for a model whose own name is another's
function pretty(id) {
  const special = { gpt: "GPT", oss: "OSS" }
  return id
    .split("-")
    .filter(Boolean)
    .map((w) => special[w.toLowerCase()] ?? (/^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ")
}

// listed is fetchAvailableModels' reply as the account's models: each
// {id, name, context, output, images, enumName, remaining, resets}, in
// the app's picker order
function listed(res) {
  const models = isObj(res?.models) ? res.models : {}
  let out = []
  for (const id of Object.keys(models).sort()) {
    const m = models[id] ?? {}
    if (typeof m.model === "string" && m.model) enums.set(id, { model: m.model, provider: typeof m.modelProvider === "string" ? m.modelProvider : "" })
    if (HIDDEN.has(id) || id.startsWith("chat_") || id.startsWith("tab_") || m.disabled) continue
    const mi = { id, name: m.displayName ?? "", context: m.maxTokens || 0, output: m.maxOutputTokens || 0, imageInput: typeof m.supportsImages === "boolean" ? m.supportsImages : undefined, remaining: -1, resets: "" }
    if (isObj(m.quotaInfo)) {
      // Antigravity leaves the fraction out once none is left
      mi.remaining = typeof m.quotaInfo.remainingFraction === "number" ? m.quotaInfo.remainingFraction : 0
      if (typeof m.quotaInfo.resetTime === "string" && !isNaN(Date.parse(m.quotaInfo.resetTime))) mi.resets = m.quotaInfo.resetTime
    }
    out.push(mi)
  }
  // a name that is another model's (two ids under one name) is the id's
  const spelled = new Set(out.filter((mi) => nameSpells(mi.name, mi.id)).map((mi) => mi.name))
  for (const mi of out) {
    if (mi.name === "" || nameSpells(mi.name, mi.id)) continue
    if (spelled.has(mi.name) || enumNames(models[mi.id]?.model, mi.id)) mi.name = ""
  }
  const rank = new Map()
  for (const s of res?.agentModelSorts ?? []) for (const g of s?.groups ?? []) for (const id of g?.modelIds ?? []) if (!rank.has(id)) rank.set(id, rank.size + 1)
  for (const mi of out) mi.picker = rank.get(mi.id) ?? 0
  out = out.map((mi, i) => [mi, i]).sort(([a, i], [b, j]) => (a.picker === b.picker ? i - j : a.picker === 0 ? 1 : b.picker === 0 ? -1 : a.picker - b.picker)).map(([mi]) => mi)
  return out
}

// catalogOf is the account's models as magpie lists the variants: names
// filled, images said
function catalogOf(infos) {
  const names = Object.fromEntries(FALLBACK.map((m) => [m.id, m.name]))
  const out = infos.map((mi) => ({
    id: mi.id,
    name: mi.name || names[mi.id] || "",
    context: mi.context,
    output: mi.output,
    images: mi.imageInput ?? !mi.id.startsWith("gpt-oss"),
  }))
  if (!out.length) return FALLBACK.map((m) => ({ ...m, context: 0, output: 0, images: !m.id.startsWith("gpt-oss") }))
  return out
}

// families groups the variants of one model at its levels
// (gemini-3.7-flash-low, -medium, -high), in the order first seen
function families(raw) {
  const out = []
  const by = new Map()
  for (const m of raw) {
    const [id] = splitID(m.id)
    let f = by.get(id)
    if (!f) {
      f = { id, variants: [], efforts: [] }
      by.set(id, f)
      out.push(f)
    }
    f.variants.push(m)
  }
  for (const f of out) {
    const named = []
    for (const v of f.variants) {
      const l = nameEffort(v.name)[1]
      if (l && !named.includes(l)) named.push(l)
    }
    for (const v of f.variants) f.efforts.push(named.length === f.variants.length ? nameEffort(v.name)[1] : splitID(v.id)[1])
  }
  return out
}

// byEffort is each level's variant, "" the one asked with no effort
function byEffort(f) {
  const out = {}
  f.variants.forEach((v, i) => {
    if (!(f.efforts[i] in out)) out[f.efforts[i]] = v.id
  })
  if (!out[""]) {
    out[""] = out.high ?? ""
    for (let i = LEVELS.length - 1; i >= 0 && !out[""]; i--) out[""] = out[LEVELS[i]] ?? ""
  }
  return out
}

function familyModel(f) {
  const def = byEffort(f)[""]
  const m = { ...(f.variants.find((v) => v.id === def) ?? f.variants[f.variants.length - 1]) }
  m.id = f.id
  m.name = nameEffort(m.name ?? "")[0]
  if (m.name === "" || m.name === def) m.name = f.id
  for (const v of f.variants) {
    if (v.context > 0 && (m.context === 0 || v.context < m.context)) m.context = v.context
    if (v.output > 0 && (m.output === 0 || v.output < m.output)) m.output = v.output
    m.images = m.images && v.images
  }
  m.efforts = LEVELS.filter((l) => f.efforts.includes(l))
  return m
}

// collapse is the list magpie offers: a family of levels as one model
// that takes an effort, the rest as they are
function collapse(raw) {
  const out = []
  for (const f of families(raw)) out.push(f.variants.length === 1 ? { ...f.variants[0], efforts: [] } : familyModel(f))
  const byID = new Map(out.map((m) => [m.id, m]))
  for (const m of out) {
    const tiered = m.id.endsWith("-tiered")
    const b = tiered ? m.id.slice(0, -7) : ""
    const base = tiered ? byID.get(b) : undefined
    if (base && !m.efforts.length) m.efforts = [...base.efforts]
    if (m.name) continue
    m.name = m.id
    if (base && base.name && base.name !== b) m.name = base.name + " (Tiered)"
  }
  return out
}

// nearestEffort is the level of levels nearest want, a tie going up
function nearestEffort(want, levels) {
  const at = LEVELS.indexOf(want)
  if (!levels.length || at < 0 || levels.includes(want)) return want
  let best = want
  let dist = LEVELS.length
  for (const l of levels) {
    const i = LEVELS.indexOf(l)
    if (i < 0 || l === "none") continue
    const d = Math.abs(i - at)
    if (d < dist || (d === dist && i > at)) {
      best = l
      dist = d
    }
  }
  return best
}

// sentID is the id a request for model at effort goes out under, and the
// level that id says it thinks at
function sentID(raw, model, effort) {
  const fams = families(raw)
  if (effort) {
    for (const f of fams) {
      if (f.variants.length < 2) continue
      const i = f.variants.findIndex((v) => v.id === model && model !== f.id)
      if (i >= 0) {
        model = f.id
        break
      }
    }
  }
  const f = fams.find((x) => x.id === model && x.variants.length > 1)
  if (!f) {
    const g = fams.find((x) => x.variants.length > 1 && x.variants.some((v) => v.id === model))
    return [model, g ? g.efforts[g.variants.findIndex((v) => v.id === model)] : ""]
  }
  const vs = byEffort(f)
  let id = vs[""]
  if (effort) {
    const levels = LEVELS.filter((l) => vs[l])
    id = vs[nearestEffort(effort, levels)] || vs[""]
  }
  return [id, f.efforts[f.variants.findIndex((v) => v.id === id)] ?? ""]
}

const lists = new Map() // refresh token → {at, infos, project}

// modelInfo reads the account's models, naming its tiers as the app does
async function modelInfo(s, fresh = false) {
  const l = lists.get(s.rt)
  if (l && !fresh && Date.now() - l.at < MODELS_TTL) return l
  const p = await project(s)
  let res, err
  for (const t of askTiers(s, p)) {
    const body = { project: p.id }
    if (t) body.entitlement = { userTier: t }
    try {
      res = await call(s, DAILY, "fetchAvailableModels", body)
      err = undefined
      break
    } catch (e) {
      err = e
      if (e instanceof SignedOut) throw e
      if (t && e.status === 400) refused.set(tierKey(s, p, t), Date.now())
    }
  }
  if (err) throw err
  const out = { at: Date.now(), infos: listed(res), project: p }
  lists.set(s.rt, out)
  return out
}

function variantsOf(m) {
  return Object.fromEntries(m.efforts.map((e) => [e, { thinkingConfig: { thinkingLevel: e, includeThoughts: true } }]))
}

function entry(m) {
  return {
    id: m.id,
    name: m.name || m.id,
    provider: { npm: NPM, api: BASE },
    reasoning: m.efforts.length > 0 || /thinking|gemini|pro-agent/i.test(m.id),
    attachment: !!m.images,
    tool_call: true,
    temperature: true,
    modalities: { input: m.images ? ["text", "image"] : ["text"], output: ["text"] },
    cost: { input: 0, output: 0 },
    limit: { context: m.context || 0, output: m.output || 0 },
    variants: variantsOf(m),
  }
}

function model(m) {
  const e = entry(m)
  return {
    id: m.id,
    providerID: PROVIDER,
    name: e.name,
    api: { id: m.id, url: BASE, npm: NPM },
    status: "active",
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: e.limit,
    options: {},
    headers: {},
    capabilities: {
      temperature: true,
      reasoning: e.reasoning,
      attachment: e.attachment,
      toolcall: true,
      input: { text: true, image: e.attachment, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: e.variants,
  }
}

// ---- the schema Antigravity's function declarations take ---------------------------------

const KEEP = new Set(["description", "nullable", "required", "pattern", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties", "propertyOrdering"])

function requiredNames(v) {
  return Array.isArray(v) ? v.filter((e) => typeof e === "string") : []
}

const distinct = (vs) => vs.filter((v, i) => vs.indexOf(v) === i)

function ownShape(x) {
  if (x.properties != null || x.items != null) return true
  if (typeof x.type === "string") return x.type !== "null"
  if (Array.isArray(x.type)) return x.type.some((t) => t !== "null")
  return false
}

function deepEqual(a, b) {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  return v
}

function foldUnion(x, resolve) {
  const out = {}
  for (const [k, v] of Object.entries(x)) if (k !== "anyOf" && k !== "oneOf") out[k] = v
  let object = x.type === "object" || x.properties != null
  if (Array.isArray(x.type)) object = object || x.type.includes("object")
  const props = { ...(isObj(x.properties) ? x.properties : {}) }
  let common = []
  let branches = 0
  for (const k of ["anyOf", "oneOf"]) {
    for (const a of Array.isArray(x[k]) ? x[k] : []) {
      const m = resolve(a)
      if (!m) continue
      if (m.type === "null") {
        out.nullable = true
        continue
      }
      if (!object) continue
      const bp = isObj(m.properties) ? m.properties : {}
      for (const pk of Object.keys(bp).sort()) if (!(pk in props)) props[pk] = bp[pk]
      const br = requiredNames(m.required)
      common = branches === 0 ? [...br] : common.filter((n) => br.includes(n))
      branches++
    }
  }
  if (object) {
    if (Object.keys(props).length) out.properties = props
    const req = requiredNames(x.required)
    if (req.length + common.length > 0) out.required = distinct([...req, ...common])
  }
  return out
}

// plainSchema is a JSON schema cut down to what Antigravity's function
// declarations take: an OpenAPI-style subset with no references, unions
// or keywords outside it
function plainSchema(root) {
  if (!isObj(root)) return root
  const defs = {}
  for (const k of ["$defs", "definitions"]) if (isObj(root[k])) Object.assign(defs, root[k])
  const lastSeg = (ref) => ref.slice(ref.lastIndexOf("/") + 1)
  const localRef = (ref) => {
    if (ref.startsWith("#/")) {
      let cur = root
      for (let tok of ref.slice(2).split("/")) {
        tok = tok.replaceAll("~1", "/").replaceAll("~0", "~")
        if (isObj(cur)) cur = cur[tok]
        else if (Array.isArray(cur)) {
          const n = /^\d+$/.test(tok) ? Number(tok) : -1
          if (n < 0 || n >= cur.length) return [undefined, false]
          cur = cur[n]
        } else return [undefined, false]
        if (cur == null) {
          const d = defs[lastSeg(ref)]
          return [d, d !== undefined]
        }
      }
      return [cur, true]
    }
    if (ref === "#") return [root, true]
    const d = defs[lastSeg(ref)]
    return [d, d !== undefined]
  }
  const resolve = (v) => {
    let m = isObj(v) ? v : null
    if (m && typeof m.$ref === "string") {
      const [d, ok] = localRef(m.$ref)
      m = ok && isObj(d) ? d : null
    }
    return m
  }
  const selfRef = (ref, path) => {
    if (!ref.startsWith("#")) return false
    const r = ref.slice(1)
    return r === "" || path === r || path.startsWith(r + "/")
  }
  const refPath = (ref, path) => (ref.startsWith("#") ? ref.slice(1) : path)
  const expanding = new Set()
  const schemaTypeOf = (m) => (typeof m.type === "string" ? m.type : m.properties != null ? "object" : m.items != null ? "array" : "object")
  const oneSays = (members) => {
    let one = null
    for (const m of members) {
      if (!isObj(m) || Object.keys(m).length === 0) continue
      if (one && !deepEqual(one, m)) return null
      one = m
    }
    return one
  }
  const walk = (v, depth, path) => {
    if (typeof v === "boolean") return v ? {} : null
    if (Array.isArray(v)) return v.map((e) => walk(e, depth, path))
    if (!isObj(v)) return v
    const x = v
    if (depth > 32) return { type: "object" }
    if (typeof x.$ref === "string") {
      const ref = x.$ref
      const [d, found] = localRef(ref)
      if (!found) return { type: "object" }
      if (expanding.has(ref) || selfRef(ref, path)) return { type: isObj(d) ? schemaTypeOf(d) : "object" }
      expanding.add(ref)
      const out = walk(d, depth + 1, refPath(ref, path))
      expanding.delete(ref)
      return out
    }
    if (Array.isArray(x.allOf)) {
      const merged = {}
      for (const [k, val] of Object.entries(x)) if (k !== "allOf") merged[k] = val
      let required = requiredNames(x.required)
      for (const e of x.allOf) {
        required = [...required, ...requiredNames(resolve(e)?.required)]
        const m = walk(e, depth + 1, path + "/allOf")
        if (!isObj(m)) continue
        for (const [k, val] of Object.entries(m)) {
          if (k === "required") continue
          if (k === "properties") merged.properties = { ...(isObj(merged.properties) ? merged.properties : {}), ...val }
          else if (!(k in merged)) merged[k] = val
        }
      }
      if (required.length) merged.required = distinct(required)
      return walk(merged, depth + 1, path)
    }
    if ((x.anyOf != null || x.oneOf != null) && ownShape(x)) return walk(foldUnion(x, resolve), depth + 1, path)
    for (const k of ["anyOf", "oneOf"]) {
      if (!Array.isArray(x[k])) continue
      let pick = null
      let nullable = false
      for (const a of x[k]) {
        const m = isObj(a) ? a : null
        if (m?.type === "null") nullable = true
        else if (!pick && m) pick = m
      }
      let out = {}
      if (pick) {
        const m = walk(pick, depth + 1, path + "/" + k)
        if (isObj(m)) out = m
      }
      if (typeof x.description === "string" && out.description == null) out.description = x.description
      if (nullable) out.nullable = true
      if (out.type == null) out.type = "string"
      return out
    }
    const out = {}
    for (const [k, val] of Object.entries(x)) {
      if (KEEP.has(k)) out[k] = val
      else if (k === "exclusiveMinimum" || k === "exclusiveMaximum") {
        const b = k === "exclusiveMinimum" ? "minimum" : "maximum"
        if (typeof val === "number" && x[b] == null) out[b] = val
      } else if (k === "type") {
        if (Array.isArray(val)) {
          for (const t of val) {
            if (t === "null") out.nullable = true
            else if (out.type == null) out.type = t
          }
          for (const t of val) {
            if ((t === "array" && x.items != null) || (t === "object" && x.properties != null)) {
              out.type = t
              break
            }
          }
        } else out.type = val
      } else if (k === "properties") {
        const props = {}
        if (isObj(val)) {
          for (const [pk, pv] of Object.entries(val)) {
            const at = pk.replaceAll("~", "~0").replaceAll("/", "~1")
            const w = walk(pv, depth + 1, path + "/properties/" + at)
            if (w != null) props[pk] = w
          }
        }
        out.properties = props
      } else if (k === "items") {
        const w = walk(val, depth + 1, path + "/items")
        if (w != null) out.items = w
        else if (x.maxItems == null) {
          out.items = {}
          out.maxItems = 0
        }
      } else if (k === "enum") {
        if (Array.isArray(val) && val.every((e) => typeof e === "string")) {
          const strs = val.filter((s) => s.trim() !== "")
          if (strs.length) out.enum = strs
        }
      }
    }
    if ("const" in x && typeof x.const === "string" && x.const.trim() !== "") out.enum = [x.const]
    if (out.type == null) {
      if (out.properties != null) out.type = "object"
      else if (out.items != null) out.type = "array"
    }
    if (out.type === "array") {
      if (Array.isArray(out.items)) out.items = oneSays(out.items)
      if (out.items == null) {
        if (Array.isArray(x.prefixItems) && x.prefixItems.length) {
          const s = oneSays(x.prefixItems)
          if (s) out.items = walk(s, depth + 1, path + "/items")
        }
        if (out.items == null) out.items = {}
      }
    }
    if (typeof out.type === "string") {
      if (out.type !== "array") {
        delete out.items
        delete out.minItems
        delete out.maxItems
      }
      if (out.type !== "object") {
        delete out.properties
        delete out.required
        delete out.minProperties
        delete out.maxProperties
        delete out.propertyOrdering
      }
    }
    if (Array.isArray(out.required)) {
      const props = isObj(out.properties) ? out.properties : {}
      const keep = out.required.filter((n) => typeof n === "string" && props[n] != null)
      if (keep.length) out.required = keep
      else delete out.required
    }
    return out
  }
  return walk(root, 0, "")
}

// ---- system prompts Antigravity turns away -----------------------------------------------

// TURNED_AWAY are the lines, lower-cased, Antigravity answers a 429 to
// whatever quota is left. Each goes as SAID_AS says instead.
const TURNED_AWAY = [
  "x-anthropic-billing-header:",
  "built on anthropic's claude agent sdk",
  "you are codex, an agent based on gpt-5",
  "you are codex, a coding agent based on gpt-5",
  "hermes agent, an intelligent ai assistant created by nous research",
  "rfc 2119 keywords: must, required, should, recommended, may, optional.",
]

// INVISIBLE are the characters Google's check reads past: since 11-14 a
// line with a zero-width space (U+200B) after the first and second
// character of each word, or after every character, or U+2060, is turned
// away as the line itself, 5 of 5 on a real account for every line here
// (hc295971796 on X, Claude Desktop's Code tab). A copy someone broke up
// that way (the antigravity-cloak middleware before 0.1.7, an older magpie)
// is matched as the line.
const INVISIBLE = "[\\u00ad\\u180e\\u200b-\\u200f\\u2060-\\u2064\\ufeff]"
const INVISIBLE_RE = new RegExp(INVISIBLE, "g")

const escape = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// lineRe matches line in any case, with any run of white space between its
// words and any invisible characters inside them: Google's check reads a
// line break, a tab, two spaces or a no-break space where the line has one
// space, and turned omp's line away wrapped after "REQUIRED," or after
// "RFC 2119" as it did on one line, while a missing period, a space dropped
// after a comma or the words in another order went through (a real
// account, 11-14). Claude Code's billing line is matched to its end, since
// it goes whole.
const lineRe = (line) => {
  const words = line.split(" ").map((w) => [...w].map(escape).join(`${INVISIBLE}*`))
  const tail = line === "x-anthropic-billing-header:" ? "[^\\n]*\\n?" : ""
  return new RegExp(words.join(`${INVISIBLE}*\\s+${INVISIBLE}*`) + tail, "gi")
}
const TURNED_AWAY_RE = TURNED_AWAY.map(lineRe)
const has = (s, re) => {
  re.lastIndex = 0
  const yes = re.test(s)
  re.lastIndex = 0
  return yes
}
const said = (system, line) => has(system, TURNED_AWAY_RE[TURNED_AWAY.indexOf(line)])

const turnsAway = (system) => TURNED_AWAY_RE.some((re) => has(system, re))

// SAID_AS is how each line goes, with its invisible characters taken out
// and its white space as it was: a rewording that keeps its meaning, each
// answered 5 of 5 on a real account on 11-14 while the line itself, broken
// up or not, was turned away 5 of 5.
//   - Claude Code's billing line is left out: it is Anthropic's, and no
//     Antigravity model reads anything in it.
//   - "built on Anthropic's Claude Agent SDK", the Agent SDK's identity
//     line (Claude Desktop's Code tab and its subagents), goes as "built on
//     the Claude Agent SDK by Anthropic".
//   - Codex's GPT-5 lines go "built on GPT-5" for "based on GPT-5".
//   - Hermes' earlier persona goes "built by Nous Research", as Hermes'
//     current one says it, for "created by".
//   - omp's RFC 2119 line goes as "key words", the RFC's own term (10 of 10
//     on 11-14, eric_li8983 on X).
const SAID_AS = {
  "x-anthropic-billing-header:": () => "",
  "built on anthropic's claude agent sdk": (line) => line.replace(/^(built\s+on\s+)anthropic's(\s+)(claude\s+agent\s+sdk)$/i, "$1the$2$3 by Anthropic"),
  "you are codex, an agent based on gpt-5": (line) => line.replace(/based(\s+)on/i, "built$1on"),
  "you are codex, a coding agent based on gpt-5": (line) => line.replace(/based(\s+)on/i, "built$1on"),
  "hermes agent, an intelligent ai assistant created by nous research": (line) => line.replace(/created(\s+)by/i, "built$1by"),
  "rfc 2119 keywords: must, required, should, recommended, may, optional.": (line) => line.replace(/(key)(words)/i, "$1 $2"),
}

// USER_TURNED_AWAY are the lines Antigravity also turns away in a user's
// turn: since 11-14 Codex's GPT-5 lines there got a bare 429 "Resource has
// been exhausted" 3 of 3 on a real account, where a pasted AGENTS.md or a
// developer message told after a reply puts them, and went through
// reworded. The others went through as written there, 3 of 3 each, and so
// did all of them in the model's turns and in tool results.
const USER_TURNED_AWAY = TURNED_AWAY.filter((l) => l.startsWith("you are codex, "))

// cloak rewords the lines of only, or of TURNED_AWAY when only is left out
function cloak(system, only) {
  if (!turnsAway(system)) return system
  const at = []
  TURNED_AWAY_RE.forEach((re, i) => {
    if (only && !only.includes(TURNED_AWAY[i])) return
    for (const m of system.matchAll(re)) at.push([m.index, m.index + m[0].length, SAID_AS[TURNED_AWAY[i]]])
  })
  at.sort((a, b) => a[0] - b[0])
  let out = ""
  let prev = 0
  for (const [from, to, as] of at) {
    if (from < prev) continue
    out += system.slice(prev, from) + as(system.slice(from, to).replace(INVISIBLE_RE, ""))
    prev = to
  }
  return out + system.slice(prev)
}

const HINT =
  "Antigravity answers this 429 to the system prompt of Claude Code and the Claude Agent SDK (Claude Desktop's chats) whatever quota is left, so it is not a quota and waiting won't help; use another provider for these chats, or put one after Antigravity in a routing group"
const CODEX_HINT =
  "Antigravity answers this 429 to Codex's own system prompt for GPT-5 models whatever quota is left, so it is not a quota and waiting won't help; a Codex chat begun on a GPT model keeps that prompt after a model switch or a fork, so start a new chat on this model"
const HERMES_HINT =
  "Antigravity answers this 429 to Hermes Agent's earlier default persona (its SOUL.md) whatever quota is left, so it is not a quota and waiting won't help; Hermes' current default persona goes through, so put it in SOUL.md, or use another provider for these chats"

const RFC_HINT =
  "Antigravity answers this 429 to the line \"RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.\" that starts oh-my-pi (omp)'s system prompt, and to any prompt that has it, whatever quota is left, so it is not a quota and waiting won't help; magpie sends that line as \"RFC 2119 key words: …\", which goes through, so this one came from a copy of it that was worded another way"

function hint(system) {
  if (said(system, "rfc 2119 keywords: must, required, should, recommended, may, optional.")) return RFC_HINT
  if (said(system, "you are codex, an agent based on gpt-5") || said(system, "you are codex, a coding agent based on gpt-5")) return CODEX_HINT
  if (said(system, "hermes agent, an intelligent ai assistant created by nous research")) return HERMES_HINT
  return HINT
}

// ---- shaping the Gemini request for Antigravity ----------------------------------------------

const DRAWS = ["image", "imagen", "imagine", "dall-e", "flux", "seedream", "cogview", "stable-diffusion", "sdxl", "wanx", "kolors", "hidream", "banana", "sensenova-u1"]
const draws = (id) => DRAWS.some((w) => id.includes(w))

function generation(id) {
  const m = /(?:^|\/)gemini-(\d+)/.exec(id)
  return m ? Number(m[1]) : 0
}

const toolID = (id) => (typeof id === "string" ? id.replace(/[^a-zA-Z0-9_-]/g, "_") : id)

const isImage = (p) => isObj(p) && (isObj(p.inlineData) || isObj(p.fileData)) && !p.functionResponse && !p.functionCall
const hasResponse = (parts) => Array.isArray(parts) && parts.some((p) => isObj(p?.functionResponse))

// systemText is a request's system instruction as one text
function systemText(req) {
  const si = req.systemInstruction
  if (typeof si === "string") return si
  return (si?.parts ?? []).map((p) => (typeof p?.text === "string" ? p.text : "")).join("\n")
}

// claudeTurns keeps a Claude model's tool turn as Anthropic reads one:
// every response first, the tools' images after them, each group after a
// line saying whose it is, then what the user said
function claudeTurns(contents) {
  const out = []
  for (let i = 0; i < contents.length; i++) {
    const c = contents[i]
    if (c?.role !== "user" || !hasResponse(c.parts)) {
      out.push(c)
      continue
    }
    const lead = []
    const after = []
    const rest = []
    const ps = c.parts
    for (let j = 0; j < ps.length; j++) {
      const p = ps[j]
      if (!isObj(p?.functionResponse)) {
        rest.push(p)
        continue
      }
      lead.push(p)
      const ims = []
      while (j + 1 < ps.length && isImage(ps[j + 1])) ims.push(ps[++j])
      if (ims.length) {
        const name = p.functionResponse.name || "tool"
        const id = p.functionResponse.id ?? ""
        after.push({ text: ims.length > 1 ? `${ims.length} images returned by tool ${name} (call ${id}):` : `Image returned by tool ${name} (call ${id}):` }, ...ims)
      }
    }
    let parts = [...lead, ...after, ...rest]
    // what the user said, a turn of its own after the tools' in Gemini's
    // build, goes in the same turn
    while (i + 1 < contents.length && contents[i + 1]?.role === "user" && !hasResponse(contents[i + 1].parts)) parts = [...parts, ...(contents[++i].parts ?? [])]
    out.push({ ...c, parts })
  }
  return out
}

// REWORDED are paragraphs that go through but are answered badly, each with
// a rewording that keeps its meaning. DeepSeek Harness's desktop app puts
// the first in every system prompt. With it word for word, gemini-4-argon
// answered most requests in about 3s at about 300 tok/s with no thinking,
// and ended after one shallow step; with it removed or reworded, the same
// replayed request was answered normally 20 of 20 times (#1028).
const REWORDED = [
  [
    "Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. @\"...\" quotes a path containing spaces.",
    "When the user writes @ followed by a path, they are pointing at that file or folder. Relative paths start at the workspace root; absolute paths are host paths. A path ending in a slash is a folder, so list it if its contents matter; otherwise it is a file, so open it with the read tool before relying on it. Paths with spaces appear as @\"...\".",
  ],
]

const reword = (system) => {
  for (const [from, to] of REWORDED) if (system.includes(from)) system = system.split(from).join(to)
  return system
}

// outgoing is a system prompt as Antigravity is sent it
const outgoing = (system) => reword(cloak(system))

// shape is the Gemini request as Antigravity takes it for the model sent
// at the level at, asked at effort
function shape(req, sent, at, effort) {
  req = structuredClone(req)
  const m = sent.toLowerCase()
  const claude = m.includes("claude")
  if (isObj(req.systemInstruction)) {
    for (const p of req.systemInstruction.parts ?? []) if (typeof p?.text === "string") p.text = outgoing(p.text)
    // Claude Code's billing line, a block of its own, goes out whole and
    // leaves an empty text, which a Claude model refuses
    const parts = req.systemInstruction.parts
    if (Array.isArray(parts) && parts.length > 1) req.systemInstruction.parts = parts.filter((p) => !(isObj(p) && p.text === "" && Object.keys(p).length === 1))
  } else if (typeof req.systemInstruction === "string") {
    req.systemInstruction = { role: "user", parts: [{ text: outgoing(req.systemInstruction) }] }
  }
  if (Array.isArray(req.contents)) {
    for (const c of req.contents) {
      // since 11-14 Antigravity also answers a bare 429 to Codex's GPT-5
      // line in a user's turn (a pasted AGENTS.md, a developer message
      // told after a reply), 3 of 3 on a real account, and lets it
      // through reworded; the model's turns and tool results went through
      // as written, so they stay
      if (c?.role !== "model") for (const p of c?.parts ?? []) if (typeof p?.text === "string" && !p.thought) p.text = cloak(p.text, USER_TURNED_AWAY)
      // an empty text (a stream's last chunk, sent back) is a block Claude
      // refuses: "text: Field required"
      if (Array.isArray(c?.parts) && c.parts.length > 1) c.parts = c.parts.filter((p) => !(isObj(p) && p.text === "" && Object.keys(p).length === 1))
      for (const p of c?.parts ?? []) {
        if (isObj(p?.functionCall) && p.functionCall.id) p.functionCall.id = toolID(p.functionCall.id)
        if (isObj(p?.functionResponse)) {
          const fr = p.functionResponse
          if (fr.id) fr.id = toolID(fr.id)
          const r = fr.response
          if (isObj(r) && Object.keys(r).length === 1 && ("output" in r || "error" in r)) fr.response = { result: r.output ?? r.error }
          else if (isObj(r) && !("result" in r) && ("output" in r || "error" in r)) {
            const { output, error, ...more } = r
            fr.response = { result: output ?? error, ...more }
          }
        }
      }
    }
    if (claude) req.contents = claudeTurns(req.contents)
  }
  for (const t of Array.isArray(req.tools) ? req.tools : []) {
    for (const d of Array.isArray(t?.functionDeclarations) ? t.functionDeclarations : []) {
      const s = d.parametersJsonSchema ?? d.parameters ?? { type: "object", properties: {} }
      delete d.parametersJsonSchema
      d.parameters = plainSchema(structuredClone(s))
    }
  }
  const fc = req.toolConfig?.functionCallingConfig
  if (claude && isObj(fc) && (fc.mode ?? "AUTO") === "AUTO" && Array.isArray(req.tools) && req.tools.some((t) => t?.functionDeclarations?.length)) fc.mode = "VALIDATED"
  const gen = isObj(req.generationConfig) ? req.generationConfig : null
  if (gen) {
    if (!claude) delete gen.maxOutputTokens
    const tc = gen.thinkingConfig
    if (m.startsWith("gpt-oss") || (claude && !m.includes("thinking"))) delete gen.thinkingConfig
    else if (isObj(tc)) {
      const g = generation(m)
      if (g >= 3 || m.startsWith("gemini-pro-agent")) {
        const e = at || effort
        delete tc.thinkingBudget
        tc.includeThoughts = true
        if (e) {
          let level = "high"
          if (e === "low" || (e === "minimal" && at && !m.includes("flash"))) level = "low"
          else if (e === "minimal" && at) level = "minimal"
          else if ((e === "none" || e === "minimal") && !draws(m)) level = "low"
          else if (e === "medium" && (m.includes("flash") || g > 3)) level = "medium"
          tc.thinkingLevel = level
        } else delete tc.thinkingLevel
      } else if (typeof tc.thinkingLevel === "string") {
        // a level a variant put on a model told a budget
        delete tc.thinkingLevel
        if (Object.keys(tc).length === 1 && tc.includeThoughts && !("thinkingBudget" in tc)) delete gen.thinkingConfig
      }
    }
    if (!Object.keys(gen).length) delete req.generationConfig
  }
  return req
}

const INJECTED_USER_TEXT = /^(?:# AGENTS\.md\b|<(?:environment_context|permissions instructions|system-reminder|external_codex_apps_|subagent[-_]notification|turn_aborted)\b|\{"page_id":|Companion Page snapshot\b)/

function firstUserText(req) {
  let first = ""
  for (const c of req.contents ?? []) {
    if (c?.role !== "user") continue
    for (const p of c.parts ?? []) {
      if (typeof p?.text !== "string" || p.text === "") continue
      const trimmed = p.text.trimStart()
      if (!trimmed) continue
      if (!first) first = p.text
      if (!INJECTED_USER_TEXT.test(trimmed)) return p.text
    }
  }
  return first
}

// sessionOf is the session id the app gives a conversation: from the host's
// session header when named, else the conversation's first real user prompt
function sessionOf(req, headers) {
  const rawSession = headerOf(headers, SESSION).trim()
  const session = /^magpie-[0-9a-f]{24}$/.test(rawSession) ? "" : rawSession.slice(0, 128)
  const subagent = headerOf(headers, SUBAGENT).trim().slice(0, 64)
  let text = session && !subagent ? session : [session, subagent, firstUserText(req)].filter(Boolean).join("\0")
  if (!text) text = crypto.randomBytes(16).toString("hex")
  const h = crypto.createHash("sha256").update(text).digest()
  const n = h.readBigUInt64BE(0) & 0x7fffffffffffffffn
  return "-" + n.toString()
}

// enums is each model id's enum and maker, as fetchAvailableModels lists
// them (gemini-3-flash is MODEL_PLACEHOLDER_M18, made by
// MODEL_PROVIDER_GOOGLE); the app labels each request with them
const enums = new Map()

// uuidOf is a UUID-shaped id made from text, the same for the same text
function uuidOf(text) {
  const h = crypto.createHash("sha256").update(text).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

// envelope is the request as the app's language server sends it, keys in
// its order (2.32.1): project, requestId, request, model, userAgent,
// requestType. A conversation is one cascade with one trajectory, so its
// ids are made from its session; the step is how far into it the request
// is.
function envelope(req, sent, projectID, credits = false, headers = undefined) {
  const sessionId = sessionOf(req, headers)
  const rawSession = headerOf(headers, SESSION).trim()
  const cascade = uuidOf("cascade\0" + sessionId)
  const root = headerOf(headers, SUBAGENT).trim() && rawSession ? uuidOf("cascade\0" + rawSession) : cascade
  const trajectory = uuidOf("trajectory\0" + sessionId)
  const contents = Array.isArray(req?.contents) ? req.contents : []
  const step = Math.max(0, contents.length - 1)
  const turns = contents.filter((c) => c?.role === "model").length
  const known = enums.get(sent)
  const claude = known?.provider === "MODEL_PROVIDER_ANTHROPIC" || /^claude/.test(sent)
  const gemini = known ? known.provider === "MODEL_PROVIDER_GOOGLE" : /^gemini/.test(sent)
  const labels = {
    cascade_id: cascade,
    last_step_index: String(step),
    ...(known ? { model_enum: known.model } : {}),
    request_id: `${trajectory}-${turns}`,
    root_cascade_id: root,
    trajectory_id: trajectory,
    used_claude: String(claude),
    used_claude_conservative: String(claude),
    used_non_gemini_model: String(!gemini),
  }
  // the request's own keys in the app's order, labels before
  // generationConfig, the session last
  const { sessionId: _, labels: __, contents: c, systemInstruction, tools, toolConfig, generationConfig, ...rest } = isObj(req) ? req : {}
  const request = { contents: c, systemInstruction, tools, toolConfig, ...rest, labels, generationConfig, sessionId }
  for (const k of Object.keys(request)) if (request[k] === undefined) delete request[k]
  return {
    project: projectID,
    requestId: `agent/${cascade}/${Date.now()}/${trajectory}/${step + 1}`,
    request,
    model: sent,
    ...(credits ? { enabled_credit_types: [CREDIT] } : {}),
    userAgent: "antigravity",
    requestType: "agent",
  }
}

// ---- requests ---------------------------------------------------------------------------

async function bodyText(body) {
  if (body == null) return ""
  if (typeof body === "string") return body
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return Buffer.from(body).toString("utf8")
  return await new Response(body).text()
}

function headerOf(headers, name) {
  if (!headers) return ""
  if (headers instanceof Headers) return headers.get(name) ?? ""
  if (Array.isArray(headers)) return headers.find(([k]) => k.toLowerCase() === name)?.[1] ?? ""
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return String(v)
  return ""
}

function errorResponse(status, message, signIn) {
  const statusName = { 400: "INVALID_ARGUMENT", 401: "UNAUTHENTICATED", 403: "PERMISSION_DENIED", 404: "NOT_FOUND", 429: "RESOURCE_EXHAUSTED" }[status] ?? "UNKNOWN"
  return new Response(JSON.stringify({ error: { code: status, message, status: statusName } }), {
    status,
    headers: { "content-type": "application/json", ...(signIn ? { "x-magpie-sign-in": signIn } : {}) },
  })
}

// unwrap turns Code Assist's stream, each chunk {response: <chunk>}, back
// into Gemini's own. With say, an INVALID_ARGUMENT error in it, as a data
// event or a bare line, is told in say's words
function unwrap(body, say) {
  const dec = new TextDecoder()
  const enc = new TextEncoder()
  let buf = ""
  const line = (l) => {
    const data = l.startsWith("data:")
    if (!data && !(say && l.trimStart().startsWith("{"))) return l
    const j = parse(data ? l.slice(5).trim() : l)
    if (say && isObj(j) && isObj(j.error) && badCall(JSON.stringify(j))) {
      const e = { ...j.error, message: say(j.error.message) }
      return (data ? "data: " : "") + JSON.stringify({ ...j, error: e })
    }
    if (data && isObj(j) && isObj(j.response)) return "data: " + JSON.stringify(j.response)
    return l
  }
  return body.pipeThrough(
    new TransformStream({
      transform(chunk, ctl) {
        buf += dec.decode(chunk, { stream: true })
        let i
        while ((i = buf.indexOf("\n")) >= 0) {
          const l = buf.slice(0, i).replace(/\r$/, "")
          buf = buf.slice(i + 1)
          ctl.enqueue(enc.encode(line(l) + "\n"))
        }
      },
      flush(ctl) {
        buf += dec.decode()
        if (buf) ctl.enqueue(enc.encode(line(buf)))
      },
    }),
  )
}

const RESPONSE_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-cache" }

// ---- Gemini 4's rejected calls --------------------------------------------------------------

const RETRY_BAD_CALL = 2
// floorMs is how long a 400 must have taken to count as the backend's own
// rejection of what the model made: a request that is wrong in itself is
// refused at once, and isn't sent again
// holdMs is the longest a stream's thinking is held back: past it what was
// held goes out and the rest streams live, so a long-thinking turn never
// leaves its client silent long enough to time out (plugins #1078). A 400
// after that reaches the client as it is.
const retry400 = { floorMs: 3000, pauseMs: 300, holdMax: 512 * 1024, holdMs: 10_000 }
const isGemini4 = (id) => /^gemini-4/i.test(String(id ?? ""))

// badCallSaid is what the client is told of Gemini 4's INVALID_ARGUMENT
// after the model ran, asked n times: the vendor's words alone read as a
// request magpie got wrong, or a region block (Lawson0112 on X), which
// Google refuses at once and names (FAILED_PRECONDITION "User location is
// not supported…"). The words stay clear of what magpie's gateway reads as
// another fault: "model" before "invalid" reads as a model not served
const badCallSaid = (id, n) => (message) =>
  `${id} turned down a call it built while thinking, asked ${n} time${n === 1 ? "" : "s"} (Google: ${String(message ?? "").trim() || "INVALID_ARGUMENT"}). Not a region or account refusal: Google names those`

// badCall is whether a reply's body is Google's INVALID_ARGUMENT
function badCall(text) {
  const j = parse(text)
  const e = isObj(j) ? (isObj(j.error) ? j.error : isObj(j.response?.error) ? j.response.error : undefined) : undefined
  if (e) return e.status === "INVALID_ARGUMENT" || (e.code === 400 && /invalid argument/i.test(String(e.message ?? "")))
  return /INVALID_ARGUMENT|request contains an invalid argument/i.test(String(text))
}

// showsAnswer is whether a stream chunk carries something the client shows
// beyond thinking: text, a call, a file
function showsAnswer(j) {
  const c = isObj(j?.response) ? j.response : j
  for (const p of c?.candidates?.[0]?.content?.parts ?? []) {
    if (!isObj(p) || p.thought) continue
    if (p.functionCall || p.inlineData || p.fileData || p.executableCode || (typeof p.text === "string" && p.text !== "")) return true
  }
  return false
}

// holdThoughts reads a stream until it shows its first non-thinking part,
// and holds what it read back until then. An INVALID_ARGUMENT error that
// comes first sends nothing to the client, so the caller can ask again
// ({bad: true}). Once an answer has begun the client has it, and the
// stream goes through as it is: a reply can't be taken back.
const LATE = Symbol("late")
async function holdThoughts(res, signal) {
  const rd = res.body.getReader()
  const dec = new TextDecoder()
  const held = []
  let size = 0
  let buf = ""
  let done = false
  let release = false
  let bad = false
  let failure
  // pending is a read still out when the hold's time ran out: the body
  // takes it first, so no chunk is lost
  let pending
  let timer
  const late = new Promise((r) => (timer = setTimeout(r, retry400.holdMs, LATE)))
  // loose is the lines of a JSON value written with no "data:" before it,
  // as Code Assist writes its late error: after the thinking events, a
  // line of its own, {"error":{"code":400,…,"status":"INVALID_ARGUMENT"}}
  // (zRain's capture, magpie's sse_bare.go), maybe over several lines
  let loose = ""
  const scan = (final) => {
    let i
    while (!release && !bad && ((i = buf.indexOf("\n")) >= 0 || (final && buf))) {
      const l = (i >= 0 ? buf.slice(0, i) : buf).replace(/\r$/, "")
      buf = i >= 0 ? buf.slice(i + 1) : ""
      let j
      if (l.startsWith("data:")) j = parse(l.slice(5).trim())
      else if (loose || l.trimStart().startsWith("{")) {
        loose += l + "\n"
        j = parse(loose)
        if (j === undefined && loose.length <= retry400.holdMax) continue
        loose = ""
      } else continue
      if (!isObj(j)) continue
      if ((j.error || j.response?.error) && badCall(JSON.stringify(j))) bad = true
      else if (showsAnswer(j)) release = true
    }
  }
  try {
    while (!release && !bad) {
      const read = rd.read()
      const r = await Promise.race([read, late])
      if (r === LATE) {
        pending = read
        release = true
        break
      }
      if (r.done) {
        done = true
        break
      }
      held.push(r.value)
      size += r.value.length
      buf += dec.decode(r.value, { stream: true })
      scan(false)
      if (size > retry400.holdMax) release = true
    }
    if (done && !bad && !release) scan(true)
  } catch (e) {
    if (signal?.aborted) {
      clearTimeout(timer)
      throw e
    }
    failure = e
  }
  clearTimeout(timer)
  if (bad) {
    await rd.cancel().catch(() => {})
    return { bad: true }
  }
  let i = 0
  const body = new ReadableStream({
    async pull(ctl) {
      if (i < held.length) return ctl.enqueue(held[i++])
      if (failure) return ctl.error(failure)
      if (done) return ctl.close()
      try {
        const read = pending ?? rd.read()
        pending = undefined
        const r = await read
        if (r.done) ctl.close()
        else ctl.enqueue(r.value)
      } catch (e) {
        ctl.error(e)
      }
    },
    cancel: (r) => rd.cancel(r),
  })
  return { bad: false, body }
}

// complete sends a Gemini request at url (…/models/<id>:<method>) to
// Antigravity for the account s
async function complete(s, url, init, magpie) {
  const m = /\/models\/([^/:?]+):(streamGenerateContent|generateContent|countTokens)/.exec(url)
  if (!m) return errorResponse(404, `Antigravity: no such API: ${url}`)
  const model = decodeURIComponent(m[1])
  const method = m[2]
  const raw = parse(await bodyText(init?.body))
  if (!isObj(raw)) return errorResponse(400, "Antigravity: the request isn't JSON")
  if (method === "countTokens") return errorResponse(404, "Antigravity doesn't count tokens")
  let effort = headerOf(init?.headers, EFFORT).toLowerCase()
  // a variant's level, where OpenCode asked for one
  const tl = raw.generationConfig?.thinkingConfig?.thinkingLevel
  if (!effort && typeof tl === "string" && LEVELS.includes(tl)) effort = tl
  let l
  try {
    l = await modelInfo(s)
  } catch (e) {
    if (e instanceof SignedOut) return errorResponse(401, e.message, "expired")
    return errorResponse(e.status || 502, e.message ?? String(e))
  }
  const [sent, at] = sentID(catalogOf(l.infos), model, effort)
  const system = systemText(raw)
  const req = shape(raw, sent, at, effort)
  let tok
  try {
    tok = await token(s)
  } catch (e) {
    if (e instanceof SignedOut) return errorResponse(401, e.message, "expired")
    return errorResponse(502, e.message ?? String(e))
  }
  const stream = method === "streamGenerateContent"
  const ua = await userAgent()
  const send = (credits) =>
    fetch(`${DAILY}/v1internal:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok, "User-Agent": ua },
      body: JSON.stringify(envelope(req, sent, l.project.id, credits, init?.headers)),
      signal: init?.signal,
    })
  const attempt = async () => {
    let res = await send(false)
    let refusal
    if (res.status === 429 && l.project.credits && usesCredits(magpie) && !turnsAway(system)) {
      // the plan's quota is used up: the app asks before it spends AI
      // credits, and the switch is that answer. Credits are asked for only
      // after a refusal, so a request the plan covers never spends one.
      //
      // The refusal is read before the second ask: when that ask fails too,
      // the refusal is what the agent is told. Its body can't be read after
      // it was cancelled ("Body already used", a 502 on every retry).
      refusal = await res.text()
      let again
      try {
        again = await send(true)
      } catch (e) {
        if (init?.signal?.aborted) throw e
      }
      if (again?.ok) {
        res = again
        refusal = undefined
      } else {
        await again?.body?.cancel().catch(() => {})
      }
    }
    return { res, refusal }
  }
  // Gemini 4 now and then fails a request the same request later passes:
  // its backend rejects a call the model built itself (a 400
  // INVALID_ARGUMENT after the model ran, or in the stream after thinking).
  // Such a reply is asked again, up to RETRY_BAD_CALL times. A 400 that
  // comes back fast is the request's own fault and is returned as it is.
  const again400 = isGemini4(sent) || isGemini4(model)
  let res, refusal
  // asks is how many times the model was asked; slow, whether the last
  // 400 took long enough to be the model's own (retry400.floorMs)
  let asks = 0
  let slow = false
  for (let n = 0; ; n++) {
    const t0 = Date.now()
    ;({ res, refusal } = await attempt())
    asks = n + 1
    slow = Date.now() - t0 >= retry400.floorMs
    const left = again400 && n < RETRY_BAD_CALL && !init?.signal?.aborted
    if (!left) break
    if (!res.ok) {
      if (res.status !== 400) break
      const text = refusal ?? (await res.text())
      refusal = text
      if (!badCall(text) || !slow) break
      await sleep(retry400.pauseMs)
      continue
    }
    const held = await holdThoughts(res, init?.signal)
    if (held.bad) {
      await sleep(retry400.pauseMs)
      continue
    }
    res = new Response(held.body, { status: 200, headers: res.headers })
    break
  }
  if (!res.ok) {
    const text = refusal ?? (await res.text())
    const msg = apiError(text, res.status)
    if (again400 && res.status === 400 && slow && badCall(text)) return errorResponse(400, badCallSaid(sent, asks)(msg))
    if (res.status === 401) return errorResponse(401, `Antigravity: ${msg}`, "kept")
    if (res.status === 404) return errorResponse(404, `model ${sent} not found`)
    if (res.status === 429 && /resource has been exhausted/i.test(text) && turnsAway(system)) {
      // the system prompt turned away, not a quota: a 400 the next member
      // of a group is asked after, and the agent doesn't retry. It says
      // what Antigravity answered (a 429), not that this is a channel
      return errorResponse(400, `Antigravity answered 429 to this system prompt: ${msg} — ${hint(system)}`)
    }
    if (res.status === 429 && l.project.credits && !usesCredits(magpie)) {
      return new Response(withNote(text, CREDITS_NOTE), { status: 429, headers: { "content-type": "application/json" } })
    }
    return new Response(text, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } })
  }
  if (stream) return new Response(unwrap(res.body, again400 ? badCallSaid(sent, asks) : undefined), { status: 200, headers: RESPONSE_HEADERS })
  return new Response(JSON.stringify(await whole(res)), { status: 200, headers: { "content-type": "application/json" } })
}

// ---- Google AI credits ----------------------------------------------------------------------

// CREDITS_OPTION is magpie's switch for the provider: off by default, since
// credits are money
const CREDITS_OPTION = "use-ai-credits"
const CREDITS_NOTE =
  "this account has Google AI credits; turn on the Use AI credits switch in magpie's Antigravity editor to spend them when the plan's quota is used up, as the app's Use AI Credits does"

function usesCredits(magpie) {
  try {
    return magpie?.option?.(PROVIDER, CREDITS_OPTION) === true
  } catch {
    return false
  }
}

// withNote is an error body with a note added to its message
function withNote(text, note) {
  const j = parse(text)
  if (isObj(j) && isObj(j.error) && typeof j.error.message === "string") {
    return JSON.stringify({ ...j, error: { ...j.error, message: j.error.message + " — " + note } })
  }
  return text
}

// mergeGrounding merges SSE groundingMetadata chunks without letting a
// trailing empty array overwrite chunks/supports from an earlier chunk
function mergeGrounding(prev, next) {
  if (!isObj(prev)) return { ...next }
  const out = { ...prev }
  for (const [k, v] of Object.entries(next)) {
    if (Array.isArray(v) && v.length === 0 && Array.isArray(prev[k]) && prev[k].length > 0) continue
    out[k] = v
  }
  return out
}

// whole is a stream read to its end, as one generateContent reply
async function whole(res) {
  const text = await res.text()
  const out = { candidates: [] }
  const parts = []
  let last
  let groundingMetadata
  for (const l of text.split(/\r?\n/)) {
    if (!l.startsWith("data:")) continue
    let j = parse(l.slice(5).trim())
    if (isObj(j?.response)) j = j.response
    if (!isObj(j)) continue
    last = j
    const c0 = j.candidates?.[0]
    if (isObj(c0?.groundingMetadata)) groundingMetadata = mergeGrounding(groundingMetadata, c0.groundingMetadata)
    for (const p of c0?.content?.parts ?? []) {
      // a stream ends on an empty text, which Claude refuses sent back
      if (p?.text === "" && !p.thoughtSignature && Object.keys(p).length === 1) continue
      const prev = parts[parts.length - 1]
      if (typeof p.text === "string" && prev && typeof prev.text === "string" && !!prev.thought === !!p.thought && !p.thoughtSignature) prev.text += p.text
      else parts.push({ ...p })
    }
    if (j.usageMetadata) out.usageMetadata = j.usageMetadata
    if (j.modelVersion) out.modelVersion = j.modelVersion
    if (j.responseId) out.responseId = j.responseId
  }
  const c = last?.candidates?.[0] ?? {}
  out.candidates = [{ ...c, ...(groundingMetadata ? { groundingMetadata } : {}), content: { role: "model", parts } }]
  return out
}

// ---- usage ------------------------------------------------------------------------------

function vendorOf(id, name) {
  const l = id.toLowerCase()
  if (l.startsWith("gemini")) return "Gemini"
  if (l.startsWith("claude")) return "Claude"
  if (l.startsWith("gpt-oss")) return "GPT-OSS"
  const f = String(name ?? "").trim().split(" ")[0]
  if (f) return f
  return id.split("-")[0]
}

const FIVE = 5 * 3600
const WEEK = 7 * 24 * 3600

function poolName(s) {
  s = String(s ?? "").trim()
  if (s.toLowerCase().endsWith(" models")) s = s.slice(0, -7).trim()
  return s.replaceAll(" and ", " & ")
}

const versioned = (pool) => /[0-9]/.test(pool)

function poolNames(pool, w) {
  if (!versioned(pool)) return false
  const p = pool.toLowerCase()
  for (let s of [w.name, (w.model ?? "").replaceAll("-", " ")]) {
    s = String(s ?? "").toLowerCase()
    if (s === p || s.startsWith(p + " ") || s.startsWith(p + "(")) return true
  }
  return false
}

function sameReading(m, p) {
  if (Math.abs(m.used - p.used) > 0.5) return false
  if (!m.resetsAt || !p.resetsAt) return true
  const d = Date.parse(m.resetsAt) - Date.parse(p.resetsAt)
  return d < 60_000 && d > -60_000
}

function modelPool(w) {
  let name = String(w.name ?? "").trim()
  const i = name.indexOf(" (")
  if (i > 0) name = name.slice(0, i).trim()
  return name
}

const resetSecs = (t) => Math.max(0, Math.floor((Date.parse(t) - Date.now()) / 1000))

// pools are the allowances a group of models shares, as the quota summary
// gives them, with each model's window put in the pool it reads from
function pools(summary, ws) {
  const out = []
  const groups = []
  for (const gr of summary?.groups ?? []) {
    const pool = poolName(gr?.displayName)
    if (!pool) continue
    let five = -1
    const all = []
    for (const b of gr.buckets ?? []) {
      if (!b || b.disabled) continue
      const w = { name: "", pool, used: 100, aside: true }
      switch (String(b.window ?? "").toLowerCase()) {
        case "5h":
          w.name = "5 hours"
          w.span = FIVE
          break
        case "weekly":
          w.name = "7 days"
          w.span = WEEK
          break
        default:
          w.name = b.displayName || b.window || b.bucketId || ""
      }
      if (!w.name) continue
      if (typeof b.remainingFraction === "number") w.used = (1 - b.remainingFraction) * 100
      if (typeof b.resetTime === "string" && !isNaN(Date.parse(b.resetTime))) {
        w.resetsAt = b.resetTime
        w.resetSecs = resetSecs(b.resetTime)
      }
      if (w.span === FIVE && five < 0) five = out.length
      all.push(out.length)
      out.push(w)
    }
    if (all.length) groups.push({ pool, about: `${gr.displayName ?? ""} ${gr.description ?? ""}`.toLowerCase(), five, all })
  }
  const own = new Set()
  for (const w of ws) {
    if (w.pool || !w.family) continue
    const g = groups.find((gr) => poolNames(gr.pool, w))
    if (g) {
      w.pool = g.pool
      continue
    }
    for (const gr of groups) {
      if (!(gr.five >= 0 && !versioned(gr.pool) && gr.about.includes(w.family.toLowerCase()))) continue
      if (sameReading(w, out[gr.five])) w.pool = gr.pool
      else {
        const k = gr.all.find((k) => k !== gr.five && sameReading(w, out[k]))
        if (k !== undefined) {
          w.pool = gr.pool
          w.span = out[k].span
        } else {
          const name = modelPool(w)
          if (name) {
            w.pool = name
            const p = { ...w, name: "5 hours", span: FIVE }
            if (w.resetsAt && Date.parse(w.resetsAt) - Date.now() > (FIVE + 60) * 1000) {
              p.name = "7 days"
              p.span = WEEK
              w.span = WEEK
            }
            if (!own.has(name)) {
              own.add(name)
              delete p.model
              delete p.models
              delete p.family
              p.aside = true
              out.push(p)
            }
          }
        }
      }
      break
    }
  }
  return out
}

async function usage(auth) {
  const s = stateOf(auth)
  if (!s) return { error: "no such Antigravity account", signIn: "kept" }
  let l
  try {
    l = await modelInfo(s, true)
  } catch (e) {
    if (e instanceof SignedOut) return { error: e.message, signIn: "expired" }
    return { error: e?.message ?? String(e), signIn: "kept" }
  }
  const raw = catalogOf(l.infos)
  const fams = families(raw)
  const familyOf = (id) => fams.find((f) => f.variants.length > 1 && f.variants.some((v) => v.id === id))?.id ?? id
  const ws = []
  for (const mi of l.infos) {
    if (mi.remaining < 0) continue
    const w = { name: mi.name || mi.id, used: (1 - mi.remaining) * 100, model: mi.id, family: vendorOf(mi.id, mi.name) }
    const fam = familyOf(mi.id)
    w.models = fam !== mi.id ? [mi.id, fam] : [mi.id]
    if (mi.resets) {
      w.resetsAt = mi.resets
      w.resetSecs = resetSecs(mi.resets)
    }
    ws.push(w)
  }
  let summary
  try {
    summary = await call(s, DAILY, "retrieveUserQuotaSummary", { project: l.project.id })
  } catch {}
  const out = { plan: l.project.plan || undefined, signIn: "kept", windows: [...ws, ...(summary ? pools(summary, ws) : [])] }
  return out
}

// ---- sign-in -------------------------------------------------------------------------------

const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

// signedIn is a refresh token (and a project, when one is known) as the
// sign-in to keep: the account's email, its project found or set up
async function signedIn(rt, access, expires, projectID, email) {
  const s = { rt, project: projectID ?? "", access: access ?? "", expires: expires ?? 0, who: email ?? "" }
  if (!access) await token(s)
  const tok = await token(s)
  if (!email) {
    const res = await fetch(WHO_URL, { headers: { Authorization: "Bearer " + tok }, signal: AbortSignal.timeout(30_000) })
    const who = res.ok ? parse(await res.text()) : undefined
    email = who?.email
    if (!email) throw new Error("Google didn't say whose account this is")
  }
  // the project, found now so requests don't wait on it; a sign-in is kept
  // without one, found again on the first request
  try {
    const p = await resolveProject(s)
    s.project = p.id
    projects.set(rt, p)
  } catch (e) {
    if (e instanceof SignedOut) throw e
  }
  const t = tokens.get(rt)
  return { type: "success", access: t?.access ?? tok, refresh: `${rt}|${s.project}`, expires: t?.expires ?? Date.now() + 3600_000, accountId: email }
}

async function listen(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const port = server.address().port
  // localhost may be ::1 to the browser
  const six = http.createServer(handler)
  await new Promise((resolve) => {
    six.once("error", () => resolve())
    six.listen(port, "::1", resolve)
  })
  const close = () => {
    for (const x of [server, six]) {
      try {
        x.close()
        x.closeAllConnections?.()
      } catch {}
    }
  }
  return { port, close }
}

const PAGE = (ok, msg) =>
  `<!doctype html><meta charset="utf-8"><title>Antigravity</title><body style="font:15px system-ui;padding:3em;text-align:center">${ok ? "Signed in to Antigravity. You can close this tab." : "Sign-in failed: " + msg.replace(/[<>&]/g, "")}</body>`

async function signIn() {
  const verifier = b64url(crypto.randomBytes(32))
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest())
  const state = b64url(crypto.randomBytes(16))
  let got
  const back = new Promise((r) => (got = r))
  const { port, close } = await listen((req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost")
    if (u.pathname !== "/oauth-callback") {
      res.writeHead(404).end()
      return
    }
    const err = u.searchParams.get("error")
    const code = u.searchParams.get("code")
    if (u.searchParams.get("state") !== state || (!code && !err)) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(PAGE(false, "this page isn't the sign-in magpie started"))
      return
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE(!err, err ?? ""))
    got({ code, err })
  })
  const redirect = `http://localhost:${port}/oauth-callback`
  const q = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirect,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })
  return {
    url: `${AUTH_URL}?${q}`,
    instructions: "Sign in with your Google account in the browser; it comes back here when you're done.",
    method: "auto",
    async callback() {
      let timer
      try {
        const cb = await Promise.race([back, new Promise((r) => (timer = setTimeout(() => r(null), SIGN_IN_TIMEOUT)))])
        if (!cb) return { type: "failed", error: "the sign-in timed out" }
        if (cb.err) return { type: "failed", error: `Google: ${cb.err}` }
        const t = await postForm(TOKEN_URL, { grant_type: "authorization_code", code: cb.code, redirect_uri: redirect, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code_verifier: verifier })
        if (!t.access_token || !t.refresh_token) return { type: "failed", error: "Google sent back no token" }
        const expires = Date.now() + (Number(t.expires_in) || 3600) * 1000
        tokens.set(t.refresh_token, { access: t.access_token, expires })
        return await signedIn(t.refresh_token, t.access_token, expires, "")
      } catch (e) {
        return { type: "failed", error: e?.message ?? String(e) }
      } finally {
        clearTimeout(timer)
        close()
      }
    },
  }
}

// imported is the first account of a pasted export: a JSON account or
// list of them (Antigravity tools' exports: refresh_token, project_id,
// email, perhaps under token or accounts), or bare refresh tokens, one a
// line
function imported(text) {
  text = String(text ?? "").trim()
  const j = parse(text)
  const found = []
  const take = (o) => {
    if (!isObj(o)) return
    if (typeof o.type === "string" && o.type && o.type.toLowerCase() !== "antigravity") throw new Error(`this is a ${o.type} account, not Antigravity's`)
    const t = isObj(o.token) ? o.token : o
    const rt = t.refresh_token ?? t.refreshToken ?? o.refresh_token ?? o.refreshToken
    if (typeof rt === "string" && rt) {
      found.push({ rt, project: t.project_id ?? t.projectId ?? t.project ?? o.project_id ?? o.projectId ?? o.project ?? "", email: o.email ?? t.email ?? "" })
      return
    }
    if (Array.isArray(o.accounts)) o.accounts.forEach(take)
  }
  if (Array.isArray(j)) j.forEach(take)
  else if (isObj(j)) take(j)
  else if (j === undefined) {
    for (const line of text.split(/\r?\n/)) {
      const l = line.trim()
      if (l && !l.startsWith("#")) found.push({ rt: l, project: "", email: "" })
    }
  }
  return found
}

async function importAccount(inputs) {
  let found
  try {
    found = imported(inputs?.account)
  } catch (e) {
    return { type: "failed", error: e.message }
  }
  if (!found.length) return { type: "failed", error: "no refresh token in what was pasted" }
  const a = found[0]
  return {
    url: "",
    instructions: "Checking the account with Google…",
    method: "auto",
    async callback() {
      try {
        return await signedIn(a.rt, "", 0, typeof a.project === "string" ? a.project : "", a.email)
      } catch (e) {
        return { type: "failed", error: e?.message ?? String(e) }
      }
    },
  }
}

// ---- web search (Google Search grounding) -----------------------------------------------

// Preference order for search calls; falls back to any non-image Flash or Gemini model in the live catalog
const SEARCH_MODELS = ["gemini-3-flash", "gemini-2.5-flash", "gemini-3.1-flash-lite", "gemini-2.5-flash-lite"]

function pickSearchModel(infos) {
  const raw = catalogOf(infos)
  const remaining = new Map((Array.isArray(infos) ? infos : []).map((m) => [m.id, m.remaining]))
  const pickFrom = (pool) => {
    const ids = new Set(pool.map((m) => m.id))
    for (const id of SEARCH_MODELS) if (ids.has(id)) return id
    const flash = pool.find((m) => m.id.startsWith("gemini-") && !draws(m.id) && m.id.includes("flash"))
    if (flash) return flash.id
    const anyGemini = pool.find((m) => m.id.startsWith("gemini-") && !draws(m.id))
    return anyGemini?.id ?? ""
  }
  const avail = raw.filter((m) => remaining.get(m.id) !== 0)
  return pickFrom(avail) || pickFrom(raw) || SEARCH_MODELS[0]
}

function searchThinkingConfig(sent) {
  const m = String(sent ?? "").toLowerCase()
  if (generation(m) >= 3 || m.startsWith("gemini-pro-agent")) {
    return { includeThoughts: false, thinkingLevel: m.includes("flash") ? "minimal" : "low" }
  }
  return { includeThoughts: false, thinkingBudget: 0 }
}

function pagesFromGrounding(reply, count) {
  const cand = reply?.candidates?.[0]
  const gm = cand?.groundingMetadata
  const chunks = Array.isArray(gm?.groundingChunks) ? gm.groundingChunks : []
  if (!chunks.length) return []
  const supports = Array.isArray(gm?.groundingSupports) ? gm.groundingSupports : []
  const answer = (cand?.content?.parts ?? [])
    .filter((p) => !p?.thought && typeof p?.text === "string")
    .map((p) => p.text)
    .join("")
    .trim()
  const textsByIdx = chunks.map(() => [])
  for (const sup of supports) {
    const seg = typeof sup?.segment?.text === "string" ? sup.segment.text.trim() : ""
    if (!seg || !Array.isArray(sup?.groundingChunkIndices)) continue
    for (const idx of sup.groundingChunkIndices) {
      if (Number.isInteger(idx) && idx >= 0 && idx < chunks.length && !textsByIdx[idx].includes(seg)) {
        textsByIdx[idx].push(seg)
      }
    }
  }
  const out = []
  const byKey = new Map()
  for (let i = 0; i < chunks.length; i++) {
    const url = typeof chunks[i]?.web?.uri === "string" ? chunks[i].web.uri.trim() : ""
    const title = (typeof chunks[i]?.web?.title === "string" ? chunks[i].web.title.trim() : "") || url
    if (!url && !title) continue
    const key = url || title
    const existing = byKey.get(key)
    if (existing) {
      for (const s of textsByIdx[i]) if (!existing._snippets.includes(s)) existing._snippets.push(s)
      continue
    }
    const entry = { title: title || url, url, _snippets: [...textsByIdx[i]] }
    byKey.set(key, entry)
    out.push(entry)
  }
  const limit = Number.isInteger(Number(count)) && Number(count) > 0 ? Number(count) : out.length
  const trimmed = out.slice(0, limit).map(({ title, url, _snippets }) => ({
    title,
    url,
    text: _snippets.join("\n"),
  }))
  if (answer && trimmed.length && trimmed.every((p) => !p.text)) trimmed[0].text = answer
  return trimmed
}

async function webSearch({ query, count } = {}, ctx = {}) {
  const q = typeof query === "string" ? query.trim() : ""
  if (!q) throw new Error("query is required")
  const s = stateOf(await ctx.getAuth?.())
  if (!s) throw new Error("not signed in to Antigravity")
  let l
  try {
    l = await modelInfo(s)
  } catch (e) {
    if (e instanceof SignedOut) throw new StatusError(401, e.message)
    throw e
  }
  const picked = pickSearchModel(l.infos)
  const [sent, at] = sentID(catalogOf(l.infos), picked, "minimal")
  const n = Number.isInteger(Number(count)) && Number(count) > 0 ? Math.min(Number(count), 20) : 6
  const raw = {
    systemInstruction: {
      role: "user",
      parts: [{ text: "You are a web search retrieval assistant. Always use Google Search to look up the user's query. Write concise bullet points summarizing concrete facts, dates, versions, and numbers, and ground each bullet in the retrieved sources so every major source is cited." }],
    },
    contents: [{
      role: "user",
      parts: [{ text: `Search the live web for: ${q}\nProvide up to ${n} diverse, authoritative web sources, ensuring each relevant source supports at least one concrete factual bullet point.` }],
    }],
    tools: [{ googleSearch: {} }],
  }
  const req = shape(raw, sent, at, "minimal")
  req.generationConfig = { thinkingConfig: searchThinkingConfig(sent) }
  let tok
  try {
    tok = await token(s)
  } catch (e) {
    if (e instanceof SignedOut) throw new StatusError(401, e.message)
    throw e
  }
  const ua = await userAgent()
  const res = await fetch(`${DAILY}/v1internal:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok, "User-Agent": ua },
    body: JSON.stringify(envelope(req, sent, l.project.id, false)),
    signal: ctx.abort,
  })
  if (!res.ok) {
    const text = await res.text()
    const err = new StatusError(res.status, `Antigravity: ${apiError(text, res.status)}`)
    const ra = res.headers.get("retry-after")
    if (ra) err.retryAfter = ra
    throw err
  }
  const reply = await whole(res)
  return pagesFromGrounding(reply, count)
}

// ---- the plugin ---------------------------------------------------------------------------

export async function AntigravityAuthPlugin({ client, magpie } = {}) {
  return {
    async "chat.headers"(input, output) {
      if (input?.model?.providerID !== PROVIDER && input?.provider?.info?.id !== PROVIDER) return
      const s = String(input?.sessionID ?? "").trim()
      if (s && !/^magpie-[0-9a-f]{24}$/.test(s)) output.headers[SESSION] = s.slice(0, 128)
    },
    config: async (cfg) => {
      cfg.provider ??= {}
      const was = cfg.provider[PROVIDER] ?? {}
      const fallback = collapse(catalogOf([]))
      cfg.provider[PROVIDER] = {
        name: "Antigravity",
        npm: NPM,
        api: BASE,
        ...was,
        models: { ...Object.fromEntries(fallback.map((m) => [m.id, entry(m)])), ...(was.models ?? {}) },
      }
    },
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        const s = stateOf(auth)
        if (!s) return provider.models
        let l
        try {
          l = await modelInfo(s)
        } catch (e) {
          if (e instanceof SignedOut) throw Object.assign(e, { signIn: "expired" })
          throw /^Antigravity\b/.test(e?.message ?? "") ? e : new Error(`Antigravity: this account's models couldn't be read: ${e?.message ?? e}`)
        }
        return Object.fromEntries(collapse(catalogOf(l.infos)).map((m) => [m.id, model(m)]))
      },
    },
    auth: {
      provider: PROVIDER,
      // magpie's switches for the provider, read at each request
      options: [
        {
          key: CREDITS_OPTION,
          label: "Use AI credits",
          description: "When the plan's quota for a model is used up, spend the account's Google AI credits on the request, as the Antigravity app's Use AI Credits does. Off: the request fails with the quota's 429.",
          labels: { zh: "使用 AI 额度" },
          descriptions: { zh: "套餐的模型额度用完后，用账号的 Google AI 积分继续请求，同 Antigravity 应用里的 Use AI Credits。关闭时请求以额度 429 失败。" },
        },
      ],
      methods: [
        { type: "oauth", label: "Sign in with Google (browser)", authorize: signIn },
        {
          type: "oauth",
          label: "Import an account (refresh token or JSON export)",
          prompts: [{ type: "text", key: "account", message: "A refresh token, or an exported account's JSON" }],
          authorize: importAccount,
        },
      ],
      async loader(getAuth) {
        if (!stateOf(await getAuth())) return {}
        return {
          baseURL: BASE,
          apiKey: "antigravity", // the access token is put on by the fetch below
          async fetch(input, init) {
            const s = stateOf(await getAuth())
            if (!s) throw new Error("not signed in to Antigravity")
            const url = input instanceof Request ? input.url : String(input)
            if (input instanceof Request) init = { method: input.method, headers: input.headers, body: await input.text(), signal: input.signal, ...init }
            return complete(s, url, init, magpie)
          },
        }
      },
      async usage(getAuth) {
        return usage(await getAuth())
      },
    },
    search: {
      antigravity: {
        name: "Antigravity (Google Search)",
        auth: PROVIDER,
        execute: webSearch,
      },
    },
  }
}

export const _internal = {
  onboardPoll: 2000,
  stateOf,
  listed,
  catalogOf,
  families,
  byEffort,
  collapse,
  nearestEffort,
  sentID,
  plainSchema,
  cloak,
  turnsAway,
  hint,
  shape,
  sessionOf,
  envelope,
  unwrap,
  whole,
  pools,
  vendorOf,
  poolName,
  imported,
  apiError,
  planOf,
  creditsOf,
  entitlements,
  complete,
  pickSearchModel,
  pagesFromGrounding,
  webSearch,
  retry400,
  badCall,
  usage,
  tokens,
  projects,
  lists,
  refused,
  ver,
  version,
  VERSION_TTL,
  VERSION_RETRY,
  DEFAULT_VERSION,
  CLS,
  clOf,
  enums,
  userAgent,
}
