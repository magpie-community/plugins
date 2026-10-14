// Open Design (open-design.ai) as a magpie / OpenCode provider plugin: the
// account's credits and Coding Plan through the same two keys Open Design's
// own CLI (vela) and desktop app use.
//
// Open Design's cloud has two hosts, each taking one of the account's keys
// (nexu-io/open-design apps/daemon/src/integrations/vela*.ts):
//
//   - the control plane, amr-api.open-design.ai, takes the control key
//     (vela_ctrl_…): the wallet, the billing summary and a workspace's
//     Coding Plan windows;
//   - the model plane, amr-link.open-design.ai/v1, takes the runtime key
//     (sk-amr-…): OpenAI's Chat Completions and the model list, the protocol
//     vela gives its bundled OpenCode (@ai-sdk/openai-compatible).
//
// `vela login` keeps both in ~/.amr/config.json, profiles.<profile>
// ({controlKey, runtimeKey, apiUrl, linkUrl, user}). The keys don't expire
// and nothing renews them; a refused one is signed in again.
import { readFile } from "node:fs/promises"
import { homedir, hostname } from "node:os"
import { join } from "node:path"

const PROVIDER = "opendesign"

// HOSTS are the two planes (tests point them at a local fake). An account's
// own config may name others for the same planes; only https hosts of Open
// Design's own domain are taken from it.
const HOSTS = {
  api: "https://amr-api.open-design.ai",
  link: "https://amr-link.open-design.ai/v1",
}

// where a top-up is made, as Open Design's own error says it
// (amrRechargeUrl: DEFAULT_VELA_CONSOLE_ORIGIN + /dashboard?source=open_design)
const RECHARGE = "https://open-design.ai/cloud/dashboard?source=open_design"

// the CLI version the device sign-in says it is: @powerformer/vela-cli's
// current release on npm
const CLI_VERSION = "0.1.4"

// the profiles vela knows (vela-profile.ts), prod by default
const PROFILES = new Set(["prod", "test", "feature-test", "local"])

const TIMEOUT = 20_000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : "")

// ---- the config the official client writes -----------------------------------

// amrHome is where vela keeps its config: $AMR_HOME (~ and ~/… taken as the
// home folder), else ~/.amr — the same on Windows (vela.ts configDir)
function amrHome() {
  const home = process.env.HOME || homedir()
  const v = text(process.env.AMR_HOME)
  if (v === "~") return home
  if (v.startsWith("~/")) return join(home, v.slice(2))
  if (v) return v
  return join(home, ".amr")
}

const configPath = () => join(amrHome(), "config.json")

// profileName is the profile vela reads: OPEN_DESIGN_AMR_PROFILE, else
// VELA_PROFILE, else prod; a name vela doesn't know is prod (resolveAmrProfile)
function profileName() {
  const raw = text(process.env.OPEN_DESIGN_AMR_PROFILE) || text(process.env.VELA_PROFILE)
  return PROFILES.has(raw) ? raw : "prod"
}

// ownHost is an https URL on Open Design's own domain, else ""
function ownHost(u) {
  try {
    const url = new URL(String(u))
    if (url.protocol !== "https:") return ""
    if (url.hostname !== "open-design.ai" && !url.hostname.endsWith(".open-design.ai")) return ""
    return url.href.replace(/\/+$/, "")
  } catch {
    return ""
  }
}

// linkBase is a model-plane URL as the OpenAI SDK wants it, ending in /v1
const linkBase = (u) => {
  const own = ownHost(u)
  if (!own) return ""
  return /\/v1$/.test(own) ? own : own + "/v1"
}

// readProfile reads the profile vela signed in to. A file that's missing
// says so (ENOENT); one that can't be read or parsed is an error, never
// "signed out".
async function readProfile(path = configPath(), profile = profileName()) {
  const raw = await readFile(path, "utf8")
  let j
  try {
    j = JSON.parse(raw)
  } catch {
    throw new Error(`${path} isn't valid JSON`)
  }
  const p = j?.profiles?.[profile]
  if (!p || typeof p !== "object") return null
  const user = p.user && typeof p.user === "object" ? p.user : {}
  return {
    profile,
    controlKey: text(p.controlKey),
    runtimeKey: text(p.runtimeKey),
    apiUrl: ownHost(p.apiUrl),
    linkUrl: linkBase(p.linkUrl),
    email: text(user.email),
    uid: text(user.id),
    plan: text(user.plan),
  }
}

// ---- an account's keys ------------------------------------------------------

// keysOf reads the two keys out of a pasted API key: the runtime key alone,
// or both keys together (in either order, any space or comma between)
function keysOf(pasted) {
  const parts = String(pasted ?? "").split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean)
  const control = parts.find((s) => s.startsWith("vela_ctrl_")) ?? ""
  const runtime = parts.find((s) => s.startsWith("sk-amr-")) ?? parts.find((s) => !s.startsWith("vela_ctrl_")) ?? ""
  return { runtime, control }
}

// accountOf is a saved sign-in as what this plugin needs: the two keys and
// the hosts they go to. A sign-in taken from vela's config ("amr") follows
// that config: a `vela login` since changes the keys, as the desktop app
// follows it. A config that can't be read keeps the keys saved.
async function accountOf(a) {
  if (!a || typeof a !== "object") return null
  let acc
  if (a.type === "api") {
    const k = keysOf(a.key)
    acc = { runtime: k.runtime, control: k.control, api: HOSTS.api, link: HOSTS.link, email: "", from: "key" }
  } else {
    acc = {
      runtime: text(a.access),
      control: text(a.control),
      api: ownHost(a.apiUrl) || HOSTS.api,
      link: linkBase(a.linkUrl) || HOSTS.link,
      email: text(a.email),
      from: text(a.from),
      profile: text(a.profile),
    }
  }
  if (acc.from === "amr") {
    try {
      const p = await readProfile(configPath(), acc.profile || profileName())
      if (p?.runtimeKey) {
        acc.runtime = p.runtimeKey
        acc.control = p.controlKey || acc.control
        if (p.apiUrl) acc.api = p.apiUrl
        if (p.linkUrl) acc.link = p.linkUrl
        acc.email = p.email || acc.email
      }
    } catch {}
  }
  return acc
}

// ---- talking to Open Design -------------------------------------------------

// Lapsed is a key Open Design turned away: magpie marks the account
class Lapsed extends Error {
  constructor(message) {
    super(message)
    this.expired = true
    this.signIn = "expired"
  }
}

const safeJson = (t) => {
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}

// said is Open Design's own words from an error body, never a page of HTML
function said(j, raw, fallback) {
  const m = j?.error?.message ?? j?.message ?? (typeof j?.error === "string" ? j.error : "") ?? ""
  const s = text(m) || text(raw)
  if (!s || s.startsWith("<")) return fallback
  return s.length > 300 ? s.slice(0, 300) + "…" : s
}

// control is one control-plane read, with the control key as vela's daemon
// sends it (only the Authorization header: vela-wallet.ts). 401 and 403 are
// the key refused.
async function control(acc, path, { method = "GET", body, signal } = {}) {
  let res
  try {
    res = await fetch(acc.api + path, {
      method,
      headers: {
        accept: "application/json",
        ...(acc.control ? { authorization: `Bearer ${acc.control}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: signal ?? AbortSignal.timeout(TIMEOUT),
    })
  } catch (e) {
    throw new Error(`Open Design: ${e?.message ?? e}`)
  }
  const raw = await res.text().catch(() => "")
  const j = safeJson(raw)
  return { status: res.status, ok: res.ok, body: j, raw }
}

// ---- usage --------------------------------------------------------------------

// money is a dollar amount Open Design sends as a decimal string ("1.5000");
// anything else is no amount (vela-wallet.ts's parser)
function money(v) {
  const s = typeof v === "number" && Number.isFinite(v) ? String(v) : text(v)
  if (!/^\d+(?:\.\d+)?$/.test(s)) return ""
  const n = Number(s)
  return n === 0 || n >= 0.01 ? `$${n.toFixed(2)}` : `$${Number(n.toFixed(4))}`
}

// creditCount is a credit count (a decimal string) said short: whole below
// ten thousand, then k, then M
function creditCount(v) {
  const n = Number(text(v) || v)
  if (!Number.isFinite(n)) return ""
  const w = Math.round(n)
  const a = Math.abs(w)
  if (a < 10_000) return String(w)
  if (a < 1_000_000) return `${Number((w / 1000).toFixed(a < 100_000 ? 1 : 0))}k`
  return `${Number((w / 1_000_000).toFixed(1))}M`
}

// share is used/limit as a percent, from the digit strings the Coding Plan
// sends (they can be past what a double holds exactly): BigInt where both
// are whole, a plain division otherwise
function share(used, limit) {
  const u = text(used) || String(used ?? "")
  const l = text(limit) || String(limit ?? "")
  if (/^\d+$/.test(u) && /^\d+$/.test(l)) {
    const L = BigInt(l)
    if (L === 0n) return null
    return Number((BigInt(u) * 10000n) / L) / 100
  }
  const a = Number(u)
  const b = Number(l)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null
  return Math.round((a / b) * 10000) / 100
}

// spanName is a window's length as its card says it
function spanName(seconds) {
  const s = Number(seconds)
  if (!Number.isFinite(s) || s <= 0) return "Coding Plan"
  const day = 86400
  if (s % day === 0) return s / day === 1 ? "Daily" : s / day === 7 ? "Weekly" : `${s / day} days`
  if (s % 3600 === 0) return `${s / 3600} hours`
  return `${Math.round(s / 60)} minutes`
}

// planWindows are the Coding Plan's windows as magpie's, shortest first
// (contracts/src/api/collab.ts: codingPlan.windows[] with durationSeconds,
// usedCredits, limitCredits, remainingCredits and resetsAt)
function planWindows(plan) {
  if (!plan || plan.eligible === false) return []
  const out = []
  for (const w of Array.isArray(plan.windows) ? plan.windows : []) {
    const used = share(w?.usedCredits, w?.limitCredits)
    if (used === null) continue
    const span = Math.max(0, Number(w?.durationSeconds) || 0)
    const win = {
      name: spanName(span),
      used: Math.max(0, used),
      display: `${creditCount(w.usedCredits)} / ${creditCount(w.limitCredits)} credits`,
      ...(span ? { span } : {}),
    }
    const at = Date.parse(text(w?.resetsAt))
    if (Number.isFinite(at)) win.resetsAt = new Date(at).toISOString()
    out.push(win)
  }
  return out.sort((a, b) => (a.span ?? 0) - (b.span ?? 0))
}

// planName is the membership tier as the dashboard writes it: "pro" is Pro,
// and a subscription that isn't active says what it is
function planName(summary) {
  const t = text(summary?.membershipTier)
  if (!t) return ""
  const name = t[0].toUpperCase() + t.slice(1)
  const st = text(summary?.subscriptionStatus).toLowerCase()
  return st && !["active", "trialing", "none", "free"].includes(st) ? `${name} (${st.replace(/_/g, " ")})` : name
}

// creditsLine is the summary's two credit buckets beside the wallet: the
// plan's credits and the ones bought (balances.subscriptionCredits and
// balances.rechargeCredits, decimal strings)
function creditsLine(summary) {
  const b = summary?.balances
  if (!b || typeof b !== "object") return ""
  const parts = []
  const sub = creditCount(b.subscriptionCredits)
  const top = creditCount(b.rechargeCredits)
  if (sub) parts.push(`${sub} plan credits`)
  if (top) parts.push(`${top} top-up credits`)
  return parts.join(" + ")
}

// usageOf is the card from what was read: the plan, the wallet's dollars
// and the credit buckets as its balance, the Coding Plan's windows
function usageOf({ wallet, summary, preflight }) {
  const out = { windows: planWindows(preflight?.codingPlan) }
  const plan = planName(summary)
  if (plan) out.plan = plan
  const dollars = money(wallet?.balanceUsd) || money(summary?.balanceUsd) || money(preflight?.balanceUsd)
  const credits = creditsLine(summary)
  const balance = [dollars, credits].filter(Boolean).join(" · ")
  if (balance) out.balance = balance
  const until = Date.parse(text(summary?.subscriptionCurrentPeriodEnd))
  if (Number.isFinite(until)) {
    out.until = new Date(until).toISOString()
    out.renew = summary?.subscriptionCancelAtPeriodEnd === true ? "off" : "auto"
  }
  return out
}

// workspaceOf is the account's active workspace, whose Coding Plan the
// windows are: $VELA_WORKSPACE_ID as vela takes it, else the control
// plane's current one. "" when the account has none.
async function workspaceOf(acc) {
  const env = text(process.env.VELA_WORKSPACE_ID)
  if (env) return env
  const r = await control(acc, "/api/v1/workspaces/current")
  if (r.status === 401 || r.status === 403) throw new Lapsed(`Open Design refused the control key (${said(r.body, r.raw, `HTTP ${r.status}`)}) — sign in again`)
  if (r.status === 404) return ""
  if (!r.ok) throw new Error(`the workspace read answered HTTP ${r.status} (${said(r.body, r.raw, "no answer")})`)
  return text(r.body?.activeWorkspaceId) || text(r.body?.workspaceId)
}

// readPlan is the workspace's Coding Plan (billing preflight), null when the
// account has no workspace
async function readPlan(acc) {
  const id = await workspaceOf(acc)
  if (!id) return null
  const r = await control(acc, `/api/v1/workspaces/${encodeURIComponent(id)}/billing/preflight`)
  if (r.status === 401 || r.status === 403) throw new Lapsed(`Open Design refused the control key (${said(r.body, r.raw, `HTTP ${r.status}`)}) — sign in again`)
  if (!r.ok) throw new Error(`HTTP ${r.status} (${said(r.body, r.raw, "no answer")})`)
  return r.body
}

// readJSON is one control-plane read whose 401/403 is the key refused
async function readJSON(acc, path) {
  const r = await control(acc, path)
  if (r.status === 401 || r.status === 403) throw new Lapsed(`Open Design refused the control key (${said(r.body, r.raw, `HTTP ${r.status}`)}) — sign in again`)
  if (!r.ok) throw new Error(`${path} answered HTTP ${r.status} (${said(r.body, r.raw, "no answer")})`)
  if (!r.body || typeof r.body !== "object") throw new Error(`${path} answered with no JSON`)
  return r.body
}

// usage is magpie's own hook. The wallet and the billing summary are the
// card; the Coding Plan's windows are read beside them, and a failure there
// says so on the card while the balance still shows. A sign-in without the
// control key (a pasted runtime key alone) has nothing to read.
async function usage(getAuth) {
  const acc = await accountOf(await getAuth())
  if (!acc?.control)
    return {
      windows: [],
      error: "No control key: paste the control key (vela_ctrl_…) beside the runtime key, or sign in to Open Design, to see the balance",
      signIn: "kept",
    }
  try {
    const plan = readPlan(acc).then(
      (v) => ({ v }),
      (e) => ({ e }),
    )
    const [wallet, summary] = await Promise.allSettled([readJSON(acc, "/api/v1/wallet/balance"), readJSON(acc, "/api/v1/billing/summary")])
    const p = await plan
    for (const r of [wallet, summary]) if (r.status === "rejected" && r.reason?.expired) throw r.reason
    if (p.e?.expired) throw p.e
    if (wallet.status === "rejected" && summary.status === "rejected") throw wallet.reason
    const out = usageOf({
      wallet: wallet.status === "fulfilled" ? wallet.value : null,
      summary: summary.status === "fulfilled" ? summary.value : null,
      preflight: p.v ?? null,
    })
    const errs = []
    if (wallet.status === "rejected" && !out.balance) errs.push(`the balance couldn't be read: ${wallet.reason?.message ?? wallet.reason}`)
    if (summary.status === "rejected") errs.push(`the plan couldn't be read: ${summary.reason?.message ?? summary.reason}`)
    if (p.e) errs.push(`Coding Plan limits couldn't be read: ${String(p.e?.message ?? p.e).replace(/^Open Design: /, "")}`)
    if (errs.length) out.error = errs.join("; ")
    return { ...out, ...(acc.email ? { user: acc.email } : {}), signIn: "kept" }
  } catch (e) {
    return { windows: [], error: String(e?.message ?? e), signIn: e?.expired ? "expired" : "kept" }
  }
}

// ---- requests -----------------------------------------------------------------

// failure is the model plane's refusal as magpie should read it, keyed on
// the codes Open Design's own client keys on (vela-errors.ts
// classifyAmrAccountFailureDetails), in the body's error object or at its
// top: money is a 429 to top up, a plan gate a 403, a refused key a 401 that
// marks the sign-in. An upstream_provider_* fault is Open Design's own
// providers' credentials (the link gateway rewrites them to 500): an outage,
// never the user's sign-in.
function failure(status, raw) {
  if (!(status >= 400 && status <= 599)) status = 502
  const j = safeJson(raw)
  const e = j?.error && typeof j.error === "object" ? j.error : j ?? {}
  const code = (text(e.code) || text(j?.code)).toLowerCase()
  const action = (text(e.accountAction) || text(j?.accountAction)).toLowerCase()
  const msg = said(j, raw, `HTTP ${status}`)
  if (code === "insufficient_balance" || action === "recharge")
    return { status: 429, message: `out of Open Design credits — top up at ${RECHARGE} (${msg})` }
  if (code === "tier_model_not_entitled")
    return { status: 403, message: `this model isn't in the account's Open Design plan — pick another model, or upgrade the plan (${msg})` }
  if (code === "tier_request_kind_not_entitled")
    return { status: 403, message: `the account's Open Design plan doesn't include this kind of request — pick another model, or upgrade the plan (${msg})` }
  if (/^upstream_provider_(?:unauthenticated|forbidden)$/.test(code) || /\bupstream_provider_(?:unauthenticated|forbidden)\b/.test(raw ?? ""))
    return { status: 502, message: `Open Design's own upstream provider refused it — an outage on their side, not the sign-in (${msg})` }
  if (code === "auth_required" || action === "relogin" || status === 401)
    return { status: 401, message: `Open Design refused the runtime key — sign in again (${msg})`, signIn: "expired" }
  return { status, message: msg }
}

const errorResponse = ({ status, message, signIn }) =>
  new Response(JSON.stringify({ error: { message, type: "opendesign_error", code: status } }), {
    status,
    headers: { "Content-Type": "application/json", ...(signIn ? { "X-Magpie-Sign-In": signIn } : {}) },
  })

// kept is a good answer saying the sign-in held
function kept(res) {
  const headers = new Headers(res.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  headers.set("X-Magpie-Sign-In", "kept")
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

// ---- models -------------------------------------------------------------------

// SEED is the list before the account's own was read: model ids named in
// vela's own binary (@powerformer/vela-cli 0.1.4). The account's /models
// replaces it at the first listing.
const SEED = ["deepseek-v4-flash", "deepseek-v4-pro", "claude-sonnet-4.6"]

const CAPS = new Set(["gpt", "glm", "ai", "api"])
const MIXED = { mimo: "MiMo", deepseek: "DeepSeek" }

// prettify is a model id as a name: deepseek-v4-flash is "DeepSeek V4 Flash"
function prettify(id) {
  return String(id)
    .split("/")
    .pop()
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => {
      const l = w.toLowerCase()
      if (MIXED[l]) return MIXED[l]
      if (CAPS.has(l)) return l.toUpperCase()
      if (/^[vk]\d/.test(l)) return l.toUpperCase()
      return w.charAt(0).toUpperCase() + w.slice(1)
    })
    .join(" ")
}

const KINDS = ["text", "image", "audio", "video", "pdf"]

// tokens is a positive whole count, or undefined
function tokens(...vs) {
  for (const v of vs) {
    const n = typeof v === "string" ? Number(v) : v
    if (Number.isFinite(n) && n > 0) return Math.floor(n)
  }
  return undefined
}

// parseModels reads the link plane's /models: OpenAI's {data: [{id, …}]}
// with metadata (context_budget, output_budget, and context_limit where
// the gateway sends it) and OpenRouter's architecture.input_modalities
function parseModels(j) {
  const list = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : []
  const out = []
  const seen = new Set()
  for (const m of list) {
    const id = text(m?.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const meta = m?.metadata && typeof m.metadata === "object" ? m.metadata : {}
    const mods = m?.architecture?.input_modalities
    const input = Array.isArray(mods) && mods.length ? Object.fromEntries(KINDS.map((k) => [k, mods.map((x) => String(x).toLowerCase()).includes(k) || (k === "pdf" && mods.includes("file"))])) : undefined
    out.push({
      id,
      name: text(m?.name) || text(meta.display_name) || prettify(id),
      context: tokens(meta.context_limit, meta.context_length, m?.context_length, meta.context_budget),
      output: tokens(meta.output_budget, meta.max_output_tokens),
      input,
    })
  }
  return out
}

const configModel = (m) => ({ name: m.name ?? prettify(m.id), limit: { context: m.context ?? 0, output: m.output ?? 0 }, tool_call: true })

const runtimeModel = (m, link) => ({
  id: m.id,
  providerID: PROVIDER,
  name: m.name || m.id,
  api: { id: m.id, url: link, npm: "@ai-sdk/openai-compatible" },
  status: "active",
  headers: {},
  options: {},
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  // 0 where the list says nothing: magpie takes models.dev's for the model
  limit: { context: m.context ?? 0, output: m.output ?? 0 },
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: !!m.input?.image,
    toolcall: true,
    input: m.input ?? { text: true },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
    interleaved: false,
  },
  release_date: "",
  variants: {},
})

// ---- sign-in -----------------------------------------------------------------

// fromConfig takes the account vela (or the desktop app, which runs vela)
// is signed in to, reading ~/.amr/config.json and changing nothing
async function fromConfig() {
  const path = configPath()
  const profile = profileName()
  return {
    url: "",
    instructions: `Uses the Open Design account in ${path} (profile ${profile}).`,
    method: "auto",
    async callback() {
      let p
      try {
        p = await readProfile(path, profile)
      } catch (e) {
        return {
          type: "failed",
          error: e?.code === "ENOENT" ? `Open Design isn't signed in on this computer: ${path} doesn't exist (run \`vela login\`, or sign in in the Open Design app)` : `${path}: ${e?.message ?? e}`,
        }
      }
      if (!p?.runtimeKey) return { type: "failed", error: `Open Design isn't signed in: ${path} has no runtime key for profile ${profile}` }
      return success(p, { from: "amr", profile })
    },
  }
}

// success is a sign-in as magpie keeps an OAuth one: the runtime key as the
// access token, the control key and the hosts beside it, refresh "" (the
// keys don't expire)
function success(p, extra = {}) {
  const email = text(p.email)
  return {
    type: "success",
    access: p.runtimeKey,
    refresh: "",
    expires: 0,
    control: p.controlKey ?? "",
    ...(p.apiUrl ? { apiUrl: p.apiUrl } : {}),
    ...(p.linkUrl ? { linkUrl: p.linkUrl } : {}),
    ...(email ? { email, accountId: email } : {}),
    ...(text(p.uid) ? { uid: text(p.uid) } : {}),
    ...extra,
  }
}

// startDevice opens vela's device authorization (`vela login`): a code, the
// page that approves it, and the secret the approval is polled with
async function startDevice() {
  const acc = { api: HOSTS.api, control: "" }
  const r = await control(acc, "/api/v1/cli/device-authorizations", {
    method: "POST",
    body: { cliVersion: CLI_VERSION, host: hostname() || "magpie", profile: "prod" },
  })
  const d = r.body
  if (!r.ok || !text(d?.deviceId) || !text(d?.deviceSecret))
    throw new Error(`Open Design sign-in: the device authorization answered HTTP ${r.status} (${said(d, r.raw, "incomplete")})`)
  const expires = Date.parse(text(d.expiresAt))
  return {
    deviceId: text(d.deviceId),
    deviceSecret: text(d.deviceSecret),
    userCode: text(d.userCode),
    url: ownHost(d.activationUrl) || text(d.activationUrl),
    interval: Number(d.pollIntervalSeconds) > 0 ? Number(d.pollIntervalSeconds) : 2,
    until: Number.isFinite(expires) ? Math.min(expires, Date.now() + 15 * 60_000) : Date.now() + 10 * 60_000,
  }
}

// pollDevice waits until the page approves the code, giving the account's
// keys; a network error or a 5xx is a poll to try again
async function pollDevice(d, { nap = sleep, now = Date.now } = {}) {
  const acc = { api: HOSTS.api, control: "" }
  while (now() < d.until) {
    await nap(d.interval * 1000)
    let r
    try {
      r = await control(acc, `/api/v1/cli/device-authorizations/${encodeURIComponent(d.deviceId)}/token`, { method: "POST", body: { deviceSecret: d.deviceSecret } })
    } catch {
      continue
    }
    const b = r.body ?? {}
    if (r.ok && text(b.runtimeKey) && text(b.controlKey)) {
      const user = b.user && typeof b.user === "object" ? b.user : {}
      return { runtimeKey: text(b.runtimeKey), controlKey: text(b.controlKey), email: text(user.email), uid: text(user.id) }
    }
    if (r.status >= 500) continue
    const st = text(b.status).toLowerCase()
    if (r.status === 404 || ["expired", "denied", "rejected", "canceled", "cancelled"].includes(st))
      throw new Error(`Open Design sign-in: the request was ${st || "not found"} — start again`)
    if (r.status === 401 || r.status === 403 || r.status === 400)
      throw new Error(`Open Design sign-in: ${text(b.error) === "invalid_device_secret" ? "the code is no longer valid" : said(b, r.raw, `HTTP ${r.status}`)} — start again`)
    // pending, or an answer not known here: the next poll
  }
  throw new Error("Open Design sign-in: the code ran out before it was approved")
}

async function deviceSignIn() {
  const d = await startDevice()
  return {
    url: d.url,
    instructions: `Approve the sign-in on the page that opens${d.userCode ? ` — the code is ${d.userCode}` : ""}.`,
    method: "auto",
    async callback() {
      try {
        return success(await pollDevice(d), { from: "device" })
      } catch (e) {
        return { type: "failed", error: e?.message ?? String(e) }
      }
    },
  }
}

// ---- the plugin --------------------------------------------------------------

async function bodyText(input, init) {
  const b = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined)
  if (b === undefined || b === null) return undefined
  if (typeof b === "string") return b
  if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return new TextDecoder().decode(b)
  try {
    return await new Response(b).text()
  } catch {
    return undefined
  }
}

export const OpenDesignPlugin = async () => ({
  config: async (cfg) => {
    cfg.provider ??= {}
    const was = cfg.provider[PROVIDER] ?? {}
    cfg.provider[PROVIDER] = {
      name: "Open Design",
      npm: "@ai-sdk/openai-compatible",
      api: HOSTS.link,
      ...was,
      models: { ...Object.fromEntries(SEED.map((id) => [id, configModel({ id })])), ...(was.models ?? {}) },
    }
  },

  auth: {
    provider: PROVIDER,

    async loader(getAuth) {
      const first = await accountOf(await getAuth())
      if (!first?.runtime) return {}
      return {
        baseURL: first.link,
        apiKey: first.runtime,
        // every request to the model plane: the runtime key as it stands
        // (a sign-in from vela's config follows a later `vela login`), and
        // Open Design's refusals said as magpie reads them
        async fetch(input, init = {}) {
          const acc = await accountOf(await getAuth())
          if (!acc?.runtime) return errorResponse({ status: 401, message: "Open Design: not signed in", signIn: "expired" })
          const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
          // the SDK built the URL on the loader's base; a later config may
          // name another link host, which the request follows
          const base = new URL(first.link)
          const now = new URL(acc.link)
          if (url.origin !== base.origin && url.origin !== now.origin) return errorResponse({ status: 400, message: `Open Design: refusing to send the key to ${url.origin}` })
          const target = new URL(acc.link + url.pathname.slice(base.pathname.replace(/\/+$/, "").length) + url.search)
          const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
          headers.set("Authorization", `Bearer ${acc.runtime}`)
          headers.delete("content-length")
          headers.delete("host")
          const method = init?.method ?? (input instanceof Request ? input.method : "POST")
          const body = await bodyText(input, init)
          let res
          try {
            res = await fetch(target, { ...init, method, headers, body, signal: init?.signal ?? (input instanceof Request ? input.signal : undefined) })
          } catch (e) {
            return errorResponse({ status: 502, message: `Open Design: ${e?.message ?? e}` })
          }
          if (!res.ok) return errorResponse(failure(res.status, (await res.text().catch(() => "")).slice(0, 1 << 20)))
          return kept(res)
        },
      }
    },

    usage,

    methods: [
      { type: "oauth", label: "Sign in to Open Design (browser)", authorize: deviceSignIn },
      { type: "oauth", label: "Open Design app's or vela CLI's sign-in (~/.amr/config.json)", authorize: fromConfig },
      { type: "api", label: "Open Design keys: runtime key (sk-amr-…), and the control key (vela_ctrl_…) after a space for the balance", placeholder: "sk-amr-… vela_ctrl_…" },
    ],
  },

  provider: {
    id: PROVIDER,
    // the plan decides which models an account gets, so the list is the
    // account's own, read at its runtime key
    async models(provider, { auth } = {}) {
      const have = provider?.models ?? {}
      const acc = await accountOf(auth)
      if (!acc?.runtime) return have
      let res
      try {
        res = await fetch(acc.link + "/models", { headers: { accept: "application/json", authorization: `Bearer ${acc.runtime}` }, signal: AbortSignal.timeout(TIMEOUT) })
      } catch {
        return have
      }
      const raw = await res.text().catch(() => "")
      if (res.status === 401) throw new Lapsed(`Open Design refused the runtime key (${said(safeJson(raw), raw, "HTTP 401")}) — sign in again`)
      if (!res.ok) return have
      const ms = parseModels(safeJson(raw))
      if (!ms.length) return have
      return Object.fromEntries(ms.map((m) => [m.id, runtimeModel(m, acc.link)]))
    },
  },
})

// for tests
export const _internal = {
  HOSTS,
  RECHARGE,
  SEED,
  amrHome,
  configPath,
  profileName,
  ownHost,
  linkBase,
  readProfile,
  keysOf,
  accountOf,
  money,
  creditCount,
  share,
  spanName,
  planWindows,
  planName,
  creditsLine,
  usageOf,
  usage,
  failure,
  parseModels,
  prettify,
  startDevice,
  pollDevice,
  success,
  fromConfig,
}

// The shape the plugin host looks for: default {id, server}.
export default { id: PROVIDER, server: OpenDesignPlugin }
