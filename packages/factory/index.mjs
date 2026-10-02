// Factory (Droid) subscriptions for OpenCode and magpie: WorkOS's device
// flow under droid's client, as `droid` signs in, and each model request
// sent to Factory's API with the headers droid sends. Ported from magpie's
// built-in Factory account (internal/provider/factory*.go).

import { STATUS_CODES } from "node:http"

const PROVIDER = "factory"

const WORKOS = "https://api.workos.com/user_management"
const API = "https://api.factory.ai"
const API_EU = "https://api.eu.factory.ai"
// droid's WorkOS client, production
const CLIENT_ID = "client_01HNM792M5G5G1A2THWPXKFMXB"
// the droid release the requests say they are
const VERSION = "0.231.0"
// how long before an access token lapses it is renewed (droid: a minute)
const REFRESH_LEAD = 2 * 60 * 1000
// how long an account whose whoami failed waits before asking again
const ASK_AGAIN = 10 * 60 * 1000

const ANTHROPIC = { npm: "@ai-sdk/anthropic", api: API + "/api/llm/a/v1" }
const RESPONSES = { npm: "@ai-sdk/openai", api: API + "/api/llm/o/v1" }
const CHAT = { npm: "@ai-sdk/openai-compatible", api: API + "/api/llm/o/v1" }

const E5 = ["low", "medium", "high", "xhigh", "max"]
const E6 = ["none", "low", "medium", "high", "xhigh", "max"]
const E4 = ["low", "medium", "high", "xhigh"]

// The models droid's /model picker offers, less Gemini's (sent on a route of
// Factory's own) and auto (droid picks it client side): id, name, the wire
// droid sends it on, the vendor it names in x-api-provider, context, output,
// reasoning efforts, images.
const MODELS = [
  ["claude-fable-5.1", "Fable 5.1", ANTHROPIC, "anthropic", 867000, 128000, E5, true],
  ["claude-fable-5", "Fable 5", ANTHROPIC, "anthropic", 867000, 128000, E5, true],
  ["claude-opus-5-5", "Opus 5.5", ANTHROPIC, "anthropic", 872000, 128000, E5, true],
  ["claude-opus-5", "Opus 5", ANTHROPIC, "anthropic", 867000, 128000, E5, true],
  ["claude-opus-4-8", "Opus 4.8", ANTHROPIC, "anthropic", 867000, 128000, E5, true],
  ["claude-sonnet-5-5", "Sonnet 5.5", ANTHROPIC, "anthropic", 872000, 128000, E5, true],
  ["claude-sonnet-5", "Sonnet 5", ANTHROPIC, "anthropic", 872000, 128000, E5, true],
  ["claude-sonnet-4-6", "Sonnet 4.6", ANTHROPIC, "anthropic", 931000, 64000, ["low", "medium", "high", "max"], true],
  ["claude-haiku-4-5-20251001", "Haiku 4.5", ANTHROPIC, "anthropic", 0, 0, ["low", "medium", "high"], true],
  ["gpt-6-sol", "GPT-6 Sol", RESPONSES, "openai", 1050000, 128000, E6, true],
  ["gpt-6-astra", "GPT-6 Astra", RESPONSES, "openai", 1050000, 128000, E5, true],
  ["gpt-6-luna", "GPT-6 Luna", RESPONSES, "openai", 1050000, 128000, E6, true],
  ["gpt-5.6-sol", "GPT-5.6 Sol", RESPONSES, "openai", 1050000, 128000, E6, true],
  ["gpt-5.6-terra", "GPT-5.6 Terra", RESPONSES, "openai", 1050000, 128000, E6, true],
  ["gpt-5.6-luna", "GPT-5.6 Luna", RESPONSES, "openai", 1050000, 128000, E6, true],
  ["gpt-5.5", "GPT-5.5", RESPONSES, "openai", 1050000, 128000, E4, true],
  ["gpt-5.4", "GPT-5.4", RESPONSES, "openai", 1050000, 128000, E4, true],
  ["gpt-5.3-codex", "GPT-5.3-Codex", RESPONSES, "openai", 400000, 128000, E4, true],
  ["grok-4.7", "Grok 4.7", RESPONSES, "xai", 500000, 63356, E4, true],
  ["grok-4.6", "Grok 4.6", RESPONSES, "xai", 200000, 63356, E4, true],
  ["glm-5.3", "GLM-5.3", CHAT, "fireworks", 1040000, 131072, ["low", "high", "max"], false],
  ["glm-5.3-flash", "GLM-5.3-Flash", CHAT, "fireworks", 1048576, 131072, ["low", "high", "max"], true],
  ["glm-5.2", "GLM-5.2", CHAT, "baseten", 1040000, 131072, ["high", "max"], false],
  ["kimi-k3", "Kimi K3", CHAT, "fireworks", 262144, 65536, ["low", "high", "max"], true],
  ["deepseek-v4.1-flash", "DeepSeek V4.1 Flash", CHAT, "fireworks", 1040000, 131072, ["low", "high", "max"], true],
  ["qwen3.8-max", "Qwen3.8 Max", CHAT, "fireworks", 262144, 131072, ["low", "medium", "xhigh"], false],
  ["minimax-m3", "MiniMax M3", CHAT, "fireworks", 512000, 64000, ["high"], true],
  ["minimax-m2.7", "MiniMax M2.7", ANTHROPIC, "fireworks", 196600, 64000, ["high"], false],
  ["mistral-medium-3.5", "Mistral Medium 3.5", CHAT, "mistral", 256000, 64000, ["high"], true],
  ["nemotron-3-ultra", "Nemotron 3 Ultra", CHAT, "baseten", 202000, 65536, ["high"], false],
].map(([id, name, wire, upstream, context, output, efforts, images]) => ({ id, name, wire, upstream, context, output, efforts, images }))

const byId = new Map(MODELS.map((m) => [m.id, m]))

// variant is what the AI SDK package a model is on is given for an effort.
function variant(npm, effort) {
  if (npm === ANTHROPIC.npm) return { effort }
  return { reasoningEffort: effort }
}

function configModels() {
  const out = {}
  for (const m of MODELS) {
    out[m.id] = {
      id: m.id,
      name: m.name,
      provider: { npm: m.wire.npm, api: m.wire.api },
      reasoning: m.efforts.length > 0,
      attachment: m.images,
      tool_call: true,
      temperature: true,
      modalities: { input: m.images ? ["text", "image"] : ["text"], output: ["text"] },
      cost: { input: 0, output: 0 },
      limit: { context: m.context, output: m.output },
      variants: Object.fromEntries(m.efforts.map((e) => [e, variant(m.wire.npm, e)])),
    }
  }
  return out
}

// ---- tokens -----------------------------------------------------------------

class FactoryStatus extends Error {
  constructor(code, message, body) {
    super(message)
    this.code = code
    this.body = body
  }
}

// refused is WorkOS turning the refresh token away for good: any 4xx but a
// rate limit, as droid reads it.
const refused = (e) => e instanceof FactoryStatus && e.code >= 400 && e.code < 500 && e.code !== 429

function claims(jwt) {
  try {
    const part = String(jwt ?? "").split(".")[1]
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) ?? {}
  } catch {
    return {}
  }
}

const claim = (c, k) => (typeof c[k] === "string" ? c[k] : "")

// expiry is when an access token lapses, from its exp; 0 when it doesn't say.
function expiry(access) {
  const exp = claims(access).exp
  return typeof exp === "number" && exp > 0 ? Math.floor(exp) * 1000 : 0
}

// workos posts a form to WorkOS: the answer and its status.
async function workos(path, form, signal) {
  const res = await fetch(WORKOS + path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal: signal ?? AbortSignal.timeout(30_000),
  })
  return { text: await res.text(), status: res.status }
}

// authenticate asks WorkOS for tokens. A 400 carrying an OAuth error is an
// answer, not a failure: the device flow's polls are told to wait so.
async function authenticate(form, signal) {
  const { text, status } = await workos("/authenticate", form, signal)
  let t = {}
  try {
    t = JSON.parse(text) ?? {}
  } catch {}
  t.status = status
  if (status !== 200 && !t.error) throw new FactoryStatus(status, "Factory sign-in: " + vendorError(text, STATUS_CODES[status] ?? ""))
  return t
}

// renew trades a refresh token for a new pair, in the WorkOS org when one is
// named (droid's way of putting a token that names no org in one); droid's
// routine refresh names none, and WorkOS keeps the org.
async function renew(refresh, org) {
  const form = { grant_type: "refresh_token", refresh_token: refresh, client_id: CLIENT_ID }
  if (org) form.organization_id = org
  const t = await authenticate(form, AbortSignal.timeout(20_000))
  if (t.error) throw new FactoryStatus(t.status, "Factory: " + `${t.error} ${t.error_description ?? ""}`.trim())
  if (!t.access_token) throw new Error("Factory: the refresh gave no access token")
  return t
}

// ---- Factory's API ------------------------------------------------------------

// base is the Factory API the account's org is served from.
const base = (c) => (c.region === "eu" ? API_EU : API)

// llmBase is where the account's model requests go: the org's own host when
// whoami named one, else its region's API.
function llmBase(c) {
  if (c.premBaseHost) {
    const p = c.premBaseHost.replace(/\/+$/, "")
    return p.includes("://") ? p : "https://" + p
  }
  return base(c)
}

// factoryHeaders are what droid sends on every call to Factory's API.
function factoryHeaders(h, c) {
  h.set("Authorization", "Bearer " + c.access)
  h.set("X-Factory-Client", "cli")
  h.set("X-Client-Version", VERSION)
  h.set("User-Agent", "factory-cli/" + VERSION)
  if (c.activeOrganizationId) h.set("X-Factory-Org-Id", c.activeOrganizationId)
  else h.delete("X-Factory-Org-Id")
}

async function factoryGet(c, path) {
  const h = new Headers({ Accept: "application/json" })
  factoryHeaders(h, c)
  const res = await fetch(base(c) + path, { headers: h, signal: AbortSignal.timeout(30_000) })
  const text = await res.text()
  if (res.status !== 200) throw new FactoryStatus(res.status, "Factory: " + vendorError(text, statusLine(res.status)))
  return JSON.parse(text)
}

// firstOrg is the first WorkOS org /api/cli/org says the account is in, ""
// for none. droid asks it with the bearer token alone.
async function firstOrg(c) {
  const r = await factoryGet({ ...c, activeOrganizationId: "" }, "/api/cli/org")
  return r?.workosOrgIds?.[0] ?? ""
}

// whoami asks Factory whose the token is with the headers droid's whoami
// sends: the token, X-Factory-Whoami-Extended, and the active org when there
// is one — nothing else.
async function whoami(c, signal) {
  const h = { Authorization: "Bearer " + c.access, "X-Factory-Whoami-Extended": "true" }
  if (c.activeOrganizationId) h["X-Factory-Org-Id"] = c.activeOrganizationId
  const res = await fetch(base(c) + "/api/cli/whoami", { headers: h, signal: signal ?? AbortSignal.timeout(10_000) })
  const text = await res.text()
  if (res.status !== 200) throw new FactoryStatus(res.status, "Factory: " + vendorError(text, statusLine(res.status)))
  return JSON.parse(text) ?? {}
}

// reconcile asks whoami, as droid does for each token it holds, and keeps the
// org, region and host it names: true when any changed. An active org whoami
// refuses is left off and whoami asked again without it.
async function reconcile(c) {
  const signal = AbortSignal.timeout(10_000)
  let who
  try {
    who = await whoami(c, signal)
  } catch (e) {
    if (!(c.activeOrganizationId && e instanceof FactoryStatus && e.code === 403)) return false
    try {
      who = await whoami({ ...c, activeOrganizationId: "" }, signal)
    } catch {
      return false
    }
  }
  if (!who?.orgId) return false
  const changed = c.activeOrganizationId !== who.orgId || (c.region ?? "") !== (who.region ?? "") || (c.premBaseHost ?? "") !== (who.premBaseHostV2 ?? "")
  c.activeOrganizationId = who.orgId
  c.region = who.region ?? ""
  c.premBaseHost = who.premBaseHostV2 ?? ""
  return changed
}

// orgRefused is Factory's 403 for an X-Factory-Org-Id the user can't reach:
// "Requested active organization is not accessible by this user".
const orgRefused = (status, text) => status === 403 && text.toLowerCase().includes("active organization is not accessible")

// explain is what the user can do about a 403 Factory still answers once
// the request carries what droid sends.
function explain(status, text) {
  if (status !== 403) return ""
  if (orgRefused(status, text)) return "the Factory account's organization changed; remove the account in magpie and sign in to it again"
  return "Factory takes a Factory subscription's requests only from Droid itself. magpie opens other agents' requests to Factory's GPT, Grok and open models (GLM, Kimi…) as Droid's do, but Factory may still tell them apart, and Claude models (and MiniMax M2.7) are sent as the agent sent them, so Claude Code's and other agents' are refused there; use the model from Droid, and if Droid is refused it too, the organization's model policy or the plan doesn't allow this model"
}

// ---- opening as droid ---------------------------------------------------------
//
// Factory takes a subscription's model requests only from Droid (magpie
// #242, #506): the same account's GPT, Grok and GLM answered Droid every
// time and refused Codex, Grok Build and Claude Code every time, on the same
// models, efforts, endpoint and headers, the body the only difference. Every
// request droid sends opens its system prompt with one line (droid 0.231.0:
// its system blocks are [that line, the agent's prompt, …], sent as
// Responses' instructions joined with "\n", and on chat completions as one
// system message first, joined the same way). So another agent's request to
// /api/llm/o opens with the line too, as the built-in's factoryDroidBody
// (internal/provider/factory_client.go) has it. Anthropic's Messages
// (/api/llm/a) uses anthropicBody below to adapt fixed client metadata.
// A native Droid request goes on byte for byte.

const DROID_LINE = "You are Droid, an AI software engineering agent built by Factory."

// droidChat opens msgs' first system message with droid's line, or puts one
// before them with the line alone: false when it opens so already.
function droidChat(msgs) {
  const first = msgs[0]
  if (first && typeof first === "object" && first.role === "system") {
    const c = first.content
    if (typeof c === "string") {
      if (c.startsWith(DROID_LINE)) return false
      first.content = c.trim() === "" ? DROID_LINE : DROID_LINE + "\n" + c
      return true
    }
    if (Array.isArray(c)) {
      // droid sends a string, its blocks joined with "\n": text parts
      // alone are joined so
      let texts = [DROID_LINE]
      for (let i = 0; i < c.length; i++) {
        const p = c[i]
        if (!p || typeof p !== "object" || p.type !== "text" || typeof p.text !== "string") {
          texts = null
          break
        }
        if (i === 0 && p.text.startsWith(DROID_LINE)) return false
        texts.push(p.text)
      }
      first.content = texts ? texts.join("\n") : [{ type: "text", text: DROID_LINE }, ...c]
      return true
    }
  }
  msgs.unshift({ role: "system", content: DROID_LINE })
  return true
}

// droidBody is body, a request to Factory's /api/llm/o at path, as droid
// would open it: Responses' instructions, or chat completions' first system
// message, starting with droid's line. Anything else, a body that can't be
// read, or one that already starts so is returned as it is.
function droidBody(path, body) {
  if (!path.includes("/llm/o/") || body == null) return body
  let text
  if (typeof body === "string") text = body
  else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) text = Buffer.from(body instanceof ArrayBuffer ? body : body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)).toString("utf8")
  else return body
  let m
  try {
    m = JSON.parse(text)
  } catch {
    return body
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return body
  if (path.endsWith("/responses")) {
    const v = m.instructions
    if (v !== undefined && v !== null && typeof v !== "string") return body // not something droid sends
    const ins = v ?? ""
    if (ins.startsWith(DROID_LINE)) return body
    m.instructions = ins.trim() === "" ? DROID_LINE : DROID_LINE + "\n" + ins
  } else if (path.endsWith("/chat/completions")) {
    if (!Array.isArray(m.messages) || !droidChat(m.messages)) return body
  } else return body
  return JSON.stringify(m)
}

// errorReply is an error as the API the request was for words one:
// Anthropic's on /llm/a/, OpenAI's on the others.
function errorReply(url, status, type, message, headers = new Headers()) {
  headers.set("content-type", "application/json")
  headers.delete("content-length")
  headers.delete("content-encoding")
  const anthropic = new URL(url).pathname.includes("/llm/a/")
  const body = anthropic ? { type: "error", error: { type, message } } : { error: { message, type, code: null } }
  return new Response(JSON.stringify(body), { status, headers })
}

// said is an answer with magpie's X-Magpie-Sign-In, which tells what it
// means for the account's sign-in whatever its status: "expired" marks it
// lapsed, "kept" leaves it be. magpie takes it off before the agent sees it.
function said(res, v) {
  const h = new Headers(res.headers)
  h.set("X-Magpie-Sign-In", v)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h })
}

// ---- API keys -----------------------------------------------------------------
//
// A Factory API key (fk-…), as droid takes one from FACTORY_API_KEY: its
// om() hands the key on as the token, sent as "Authorization: Bearer fk-…"
// with the headers every request carries, and never renewed. droid's active
// org (st(), X-Factory-Org-Id) is what a sign-in stored, so a key alone
// sends none. As the built-in's factory_key.go keeps one.

const isKey = (a) => a?.type === "api" && typeof a.key === "string" && a.key.trim() !== ""

// keyAccount is a key as the account the requests are signed with.
function keyAccount(a) {
  const md = a.metadata ?? {}
  const key = a.key.trim()
  return {
    key: true,
    access: key,
    refresh: "",
    expires: 0,
    accountId: md.email || md.userId || "",
    email: md.email ?? "",
    userId: md.userId ?? "",
    activeOrganizationId: "",
    region: md.region ?? "",
    premBaseHost: md.premBaseHost ?? "",
    whoKnown: typeof md.region === "string",
  }
}

// ---- sign-in ----------------------------------------------------------------

// signedInWith is the account WorkOS just signed in, as droid keeps it: a
// token that names no org (the JWT's external_org_id or org_id) is put in
// the first org /api/cli/org lists, and whoami, asked without an org header,
// gives Factory's own id for the org the token is in (the active org droid
// then sends as X-Factory-Org-Id) and where Factory serves it from. droid
// carries on without either when they fail.
async function signedInWith(t) {
  const cl = claims(t.access_token)
  const c = {
    access: t.access_token,
    refresh: t.refresh_token ?? "",
    expires: expiry(t.access_token),
    orgId: t.organization_id || claim(cl, "org_id"),
    email: t.user?.email || claim(cl, "email"),
    userId: t.user?.id || claim(cl, "sub"),
    activeOrganizationId: "",
    region: "",
    premBaseHost: "",
  }
  if (!c.orgId && !claim(cl, "external_org_id")) {
    let org = ""
    try {
      org = await firstOrg(c)
    } catch {}
    if (org) {
      const r = await renew(c.refresh, org)
      c.access = r.access_token
      c.expires = expiry(r.access_token)
      c.orgId = org
      if (r.refresh_token) c.refresh = r.refresh_token
    }
  }
  try {
    const who = await whoami(c)
    c.activeOrganizationId = who.orgId ?? ""
    c.region = who.region ?? ""
    c.premBaseHost = who.premBaseHostV2 ?? ""
    c.email ||= who.email ?? ""
    c.userId ||= who.userId ?? ""
  } catch (e) {
    if (!c.email && !c.userId) throw e
  }
  const user = c.email || c.userId
  if (!user) throw new Error("signed in, but Factory didn't say whose account it is; try again")
  return { ...c, accountId: user }
}

async function deviceSignIn() {
  const { text, status } = await workos("/authorize/device", { client_id: CLIENT_ID })
  if (status !== 200) throw new FactoryStatus(status, "Factory sign-in: " + vendorError(text, STATUS_CODES[status] ?? ""))
  const dc = JSON.parse(text)
  if (!dc.device_code || !dc.user_code) throw new Error("Factory's sign-in gave no device code")
  let interval = Math.max(dc.interval ?? 0, 1) * 1000
  // WorkOS answers expired_token once the code lapses; stop a little after
  // that regardless, so a lost poll can't run forever
  const until = Date.now() + (Math.max(dc.expires_in ?? 0, 300) + 30) * 1000
  return {
    url: dc.verification_uri_complete || dc.verification_uri,
    instructions: `Confirm the code ${dc.user_code} on Factory's page`,
    method: "auto",
    async callback() {
      for (;;) {
        await new Promise((r) => setTimeout(r, interval))
        if (Date.now() > until) throw new Error("the code expired; start again")
        let t
        try {
          t = await authenticate({
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: dc.device_code,
            client_id: CLIENT_ID,
          })
        } catch {
          continue // a hiccup: ask again
        }
        if (t.error === "authorization_pending") continue
        if (t.error === "slow_down") {
          interval += 1000
          continue
        }
        if (t.error === "expired_token") throw new Error("the code expired; start again")
        if (t.error === "access_denied") throw new Error("the sign-in was declined")
        if (t.error || !t.access_token) throw new Error("Factory: " + (`${t.error ?? ""} ${t.error_description ?? ""}`.trim() || "no token came back"))
        const c = await signedInWith(t)
        return { type: "success", ...c }
      }
    },
  }
}

// ---- usage ------------------------------------------------------------------
//
// How much of the plan the account has used, as magpie's built-in Factory
// account shows it (internal/provider/factory_usage.go) and droid's /status
// asks it: GET /api/billing/limits. Standard usage runs in rolling 5-hour,
// weekly and monthly windows, each a percent used and when it ends; Droid
// Core, the open models Factory hosts, has windows of its own; extra usage
// is a balance in cents.

// CORE are the models Droid Core's windows count: those of a vendor other
// than Anthropic, OpenAI and xAI. Standard's count every other model.
const CORE = MODELS.filter((m) => !["anthropic", "openai", "xai"].includes(m.upstream)).map((m) => m.id)

// statusLine is a status as Go's HTTP client names it, "403 Forbidden".
const statusLine = (status) => `${status} ${STATUS_CODES[status] ?? ""}`.trim()

// vendorError is the message in an error body as magpie reads it: Factory's
// {error: {message}} or {error}, {message}, {detail}, else the body cut
// short after the status.
function vendorError(text, fallback) {
  let v
  try {
    v = JSON.parse(text)
  } catch {}
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const err = v.detail !== undefined && v.detail !== null ? v.detail : v.error
    if (Array.isArray(v.errors) && typeof v.errors[0]?.message === "string" && v.errors[0].message) return v.errors[0].message
    if (err && typeof err === "object" && typeof err.message === "string" && err.message) return err.message
    if (typeof err === "string" && err) return err
    const m = (typeof v.message === "string" && v.message) || (typeof v.msg === "string" && v.msg)
    if (m) return m
  }
  const s = String(text ?? "").split(/\s+/).filter(Boolean).join(" ")
  if (!s || s.startsWith("<")) return fallback
  const r = [...s]
  return fallback + ": " + (r.length > 300 ? r.slice(0, 300).join("") + "…" : s)
}

// windowEnd reads a window's end: an ISO time or epoch milliseconds, as
// droid hands either to new Date.
function windowEnd(v) {
  if (typeof v === "string" && v) {
    if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/i.test(v) && !isNaN(Date.parse(v))) return new Date(v).toISOString()
    if (/^[+-]?\d+$/.test(v) && Number(v) > 0) return new Date(Number(v)).toISOString()
    return undefined
  }
  if (typeof v === "number" && v > 0) return new Date(Math.trunc(v)).toISOString()
  return undefined
}

// dollars is cents as Go's $%.2f writes them: a half cent rounds to even.
function dollars(cents) {
  const x = cents / 100
  const tie = Number.isInteger(x * 8) && !Number.isInteger(x * 4) // .125, .375, .625, .875 exactly
  if (!tie) return "$" + x.toFixed(2)
  const lo = Math.floor(x * 100)
  return "$" + ((lo % 2 === 0 ? lo : lo + 1) / 100).toFixed(2)
}

// limitWindows turns the limits into windows: standard's by their span,
// then Droid Core's, then the extra usage left. For routing, standard counts
// the vendors' models and Core the open ones Factory hosts; with extra usage
// to spend, a window used up stops neither.
function limitWindows(l) {
  const out = []
  const cents = typeof l.extraUsageBalanceCents === "number" ? l.extraUsageBalanceCents : null
  const extra = l.extraUsageAllowed === true && cents !== null && cents > 0
  const add = (p, prefix, core) => {
    if (!p || typeof p !== "object") return
    for (const [w, name, span] of [
      [p.fiveHour, "5 hours", 5 * 3600],
      [p.weekly, "7 days", 7 * 24 * 3600],
      [p.monthly, "30 days", 30 * 24 * 3600],
    ]) {
      if (!w || typeof w !== "object") continue
      const used = typeof w.usedPercent === "number" ? w.usedPercent : 0
      const win = { name: prefix + name, used: Math.min(Math.max(used, 0), 100), span }
      const end = windowEnd(w.windowEnd)
      if (end) win.resetsAt = end
      if (extra) win.aside = true
      if (core) win.models = CORE
      else win.notModels = CORE
      out.push(win)
    }
  }
  add(l.limits?.standard, "", false)
  add(l.limits?.core, "Droid Core · ", true)
  if (cents !== null && cents > 0) out.push({ name: "Extra usage", used: 0, display: dollars(cents), aside: true })
  return out
}

// ---- the plugin ---------------------------------------------------------------

function bodyModel(body) {
  try {
    if (body == null) return ""
    const s = typeof body === "string" ? body : body instanceof ArrayBuffer || ArrayBuffer.isView(body) ? Buffer.from(body).toString("utf8") : ""
    return JSON.parse(s)?.model ?? ""
  } catch {
    return ""
  }
}

// Factory's Anthropic route accepts Droid's client preamble. Keep the
// caller's instructions, tools and history, adapting only fixed client
// metadata that Factory refuses (including Claude Code's wrappers).
const CLAUDE_IDENTITIES = new Set([
  "You are Claude Code, Anthropic's official CLI for Claude.",
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
])

function anthropicBody(body) {
  let request
  try {
    const text = typeof body === "string" ? body
      : body instanceof ArrayBuffer ? Buffer.from(body).toString("utf8")
      : ArrayBuffer.isView(body) ? Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8") : ""
    request = JSON.parse(text)
  } catch {
    return body
  }
  if (!request || !Array.isArray(request.messages)) return body
  if (request.system != null && typeof request.system !== "string" && !Array.isArray(request.system)) return body
  if (Array.isArray(request.system) && request.system.some((b) => b?.type === "text" && typeof b.text !== "string")) return body

  let changed = false
  const system = typeof request.system === "string" ? [{ type: "text", text: request.system }] : request.system ?? []
  if (typeof request.system === "string") changed = true
  const kept = []
  for (const block of system) {
    // Attribution is consumed here; Factory does not strip Anthropic's
    // billing block and requires the Droid identity to be first.
    if (block?.type === "text" && block.text?.startsWith("x-anthropic-billing-header: cc_version=")) {
      changed = true
      continue
    }
    if (block?.type === "text" && CLAUDE_IDENTITIES.has(block.text)) {
      block.text = DROID_LINE
      changed = true
    }
    kept.push(block)
  }
  const identity = kept.findIndex((b) => b?.type === "text" && b.text === DROID_LINE)
  if (identity < 0) {
    kept.unshift({ type: "text", text: DROID_LINE })
    changed = true
  } else if (identity > 0) {
    kept.unshift(...kept.splice(identity, 1))
    changed = true
  }
  if (changed) request.system = kept

  for (const message of request.messages) {
    if (message?.role !== "user" || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block?.type !== "text" || typeof block.text !== "string") continue
      if (block.text.startsWith("<system-reminder>\n# Environment\nYou have been invoked in the following environment:")) {
        block.text = block.text.replace("# Environment", "# Runtime context")
          .replace("You have been invoked in the following environment:", "The session environment is:")
        changed = true
      } else if (block.text.startsWith("<system-reminder>\nYou are powered by the model named")) {
        block.text = block.text.replace("You are powered by the model named", "Current model name:")
          .replace("The exact model ID is", "Model ID:")
          .replace("Assistant knowledge cutoff is", "Model knowledge cutoff:")
        changed = true
      }
    }
  }
  return changed ? JSON.stringify(request) : body
}

export const FactoryAuthPlugin = async ({ client }) => {
  // the session id this process's requests carry
  const session = crypto.randomUUID()
  // serializes checking, rotating and saving tokens: WorkOS rotates the
  // refresh token, so two refreshes would spend it twice
  let lock = Promise.resolve()
  const locked = (fn) => {
    const run = lock.then(fn, fn)
    lock = run.catch(() => {})
    return run
  }
  // when each account last asked whoami for its org, so one whoami can't
  // answer doesn't ask before every request, nor hold back the others
  const asked = new Map()
  const askedOf = (c) => asked.get(c.accountId || c.refresh || c.access || "") ?? 0
  const ask = (c) => asked.set(c.accountId || c.refresh || c.access || "", Date.now())

  // account is the account getAuth reads, with what keeps its token live
  // and its org right.
  const account = (getAuth) => {
    const save = async (c) => {
      const { type: _t, ...rest } = c
      await client.auth.set({ path: { id: PROVIDER }, body: { ...rest, type: "oauth" } })
    }
    const current = async () => {
      const a = await getAuth()
      if (isKey(a)) return keyAccount(a)
      if (a?.type !== "oauth" || !a.access) throw new Error("Factory: not signed in")
      return { ...a }
    }

    // keyed is a key account with where Factory serves its org: whoami,
    // asked with the key and no org (droid's st() is null for a key), as
    // droid's yP checks a key before it is used, and as the built-in asks
    // it when the key is added. What it names is kept in the key's
    // metadata, so magpie shows whose the key is; a whoami that fails is
    // asked again ASK_AGAIN later, the request going on meanwhile.
    const keyed = async (c) => {
      if (c.whoKnown || Date.now() - askedOf(c) < ASK_AGAIN) return c
      ask(c)
      let who
      try {
        who = await whoami({ ...c, activeOrganizationId: "" })
      } catch {
        return c
      }
      c.region = who.region ?? ""
      c.premBaseHost = who.premBaseHostV2 ?? ""
      c.email ||= who.email ?? ""
      c.userId ||= who.userId ?? ""
      c.whoKnown = true
      const a = await getAuth()
      if (isKey(a) && a.key === c.access) {
        const metadata = { ...(a.metadata ?? {}), email: c.email, userId: c.userId, region: c.region, premBaseHost: c.premBaseHost }
        await client.auth.set({ path: { id: PROVIDER }, body: { ...a, metadata } }).catch(() => {})
      }
      return c
    }

    // orgOf fills in the active org when there is none: droid asks
    // whoami as soon as it holds a token and sends the orgId it answers
    // as X-Factory-Org-Id on every request after.
    const orgOf = async (c) => {
      if (c.activeOrganizationId || Date.now() - askedOf(c) < ASK_AGAIN) return c
      ask(c)
      if (await reconcile(c)) await save(c)
      return c
    }

    // fresh is a live token, renewed near its end; renewed is told when
    // it was, the built-in's clearing of the account's lapse.
    const fresh = (renewed) =>
      locked(async () => {
        const c = await current()
        if (c.key) return keyed(c) // an API key: nothing to renew, and no org with it
        if ((c.expires > 0 && Date.now() < c.expires - REFRESH_LEAD) || !c.refresh) return orgOf(c)
        let t
        try {
          t = await renew(c.refresh, "")
        } catch (e) {
          // a hiccup while the token still runs: go on with it
          if (!refused(e) && c.expires > 0 && Date.now() < c.expires) return orgOf(c)
          if (refused(e)) throw Object.assign(new Error(`${c.accountId || "the account"}'s Factory sign-in has expired — sign in again (${e.message})`), { lapsed: true })
          throw e
        }
        c.access = t.access_token
        c.expires = expiry(t.access_token)
        if (t.refresh_token) c.refresh = t.refresh_token
        // droid asks whoami again for each new token, keeping the org it names
        await reconcile(c)
        ask(c)
        await save(c)
        renewed?.()
        return c
      })

    // mendOrg answers Factory refusing a request: an active org it
    // can't reach is left off and whoami asked again without it; with
    // no header sent, the token is put in the first org /api/cli/org
    // lists. Any other 403 to an account that sent no org asks whoami
    // for one. True when the request is worth sending again; renewed is
    // told when the token was.
    const mendOrg = (status, text, renewed) =>
      locked(async () => {
        if (status !== 403) return false
        const isOrg = orgRefused(status, text)
        const c = await current()
        if (c.key) return false // an API key carries no org droid would send
        if (c.activeOrganizationId) {
          if (!isOrg) return false // the org was sent: the refusal is about something else
          const was = c.activeOrganizationId
          c.activeOrganizationId = ""
          if ((await reconcile(c)) && c.activeOrganizationId === was) c.activeOrganizationId = "" // whoami names the org refused: send none
          ask(c)
          await save(c)
          return true
        }
        if (!isOrg) {
          ask(c)
          if ((await reconcile(c)) && c.activeOrganizationId) {
            await save(c)
            return true
          }
          return false
        }
        if (!c.refresh) return false
        let org = ""
        try {
          org = await firstOrg(c)
        } catch {}
        if (!org) return false
        let t
        try {
          t = await renew(c.refresh, org)
        } catch {
          return false
        }
        c.access = t.access_token
        c.expires = expiry(t.access_token)
        c.orgId = org
        if (t.refresh_token) c.refresh = t.refresh_token
        await save(c)
        renewed?.()
        return true
      })

    // usage is the account's limits, asked once more when Factory refused
    // an org that was put right. signIn is what the read did to the
    // built-in's lapse mark: a renewal took it off whatever came after, a
    // refused one put it on, a read that renewed nothing left it be (a
    // clean read too)
    const usage = async () => {
      let signIn = "kept"
      const onRenew = () => (signIn = "renewed")
      const limits = async () => {
        const c = await fresh(onRenew)
        const h = new Headers({ Accept: "application/json" })
        factoryHeaders(h, c)
        const res = await fetch(base(c) + "/api/billing/limits", { headers: h, signal: AbortSignal.timeout(15_000) })
        const text = await res.text()
        if (res.status !== 200) throw new FactoryStatus(res.status, "Factory: " + vendorError(text, statusLine(res.status)), text)
        return JSON.parse(text)
      }
      try {
        let l
        try {
          l = await limits()
        } catch (e) {
          if (!(e instanceof FactoryStatus && e.body !== undefined && (await mendOrg(e.code, e.body, onRenew).catch(() => false)))) throw e
          l = await limits()
        }
        if (!l?.limits?.standard) return { error: "Factory: the account reported no limits", signIn }
        return { windows: limitWindows(l), signIn }
      } catch (e) {
        if (e?.lapsed) signIn = "expired"
        return { error: e?.message ?? String(e), signIn }
      }
    }

    return { fresh, mendOrg, usage }
  }

  return {
    config: async (config) => {
      config.provider ??= {}
      const was = config.provider[PROVIDER] ?? {}
      config.provider[PROVIDER] = {
        name: "Factory",
        npm: CHAT.npm,
        api: CHAT.api,
        ...was,
        models: { ...configModels(), ...(was.models ?? {}) },
      }
    },
    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: "oauth",
          label: "Sign in with Factory (device code)",
          authorize: deviceSignIn,
        },
        // droid's FACTORY_API_KEY: the key is the bearer, never renewed
        { type: "api", label: "Factory API key (fk-…)", placeholder: "fk-…" },
      ],
      // magpie's own hook: the account's limits
      async usage(getAuth) {
        return account(getAuth).usage()
      },
      async loader(getAuth) {
        const first = await getAuth()
        if (first?.type !== "oauth" && !isKey(first)) return {}

        const { fresh, mendOrg } = account(getAuth)

        const send = async (input, init, body, renewed) => {
          const c = await fresh(renewed)
          let url = input instanceof Request ? input.url : String(input)
          // an EU org is served from Factory's EU region, an on-prem one
          // from its own host: the request goes there
          const to = llmBase(c)
          if (to !== API && url.startsWith(API)) url = to + url.slice(API.length)
          const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
          h.delete("x-api-key")
          factoryHeaders(h, c)
          const model = byId.get(bodyModel(body))
          const path = new URL(url).pathname
          const upstream = model ? model.upstream : path.includes("/llm/o/") ? "openai" : "anthropic"
          h.set("x-api-provider", upstream)
          h.set("x-session-id", session)
          h.set("x-assistant-message-id", crypto.randomUUID())
          h.set("x-provider-routing-source", "registry_default")
          if (upstream === "openai") h.set("OpenAI-Platform", "org-bHuLtG1fGmYk5YaOihAAXFBw")
          // droid's Anthropic client is made with the key "placeholder",
          // which Anthropic's SDK sends beside the bearer token
          if (path.includes("/llm/a/")) h.set("X-Api-Key", "placeholder")
          // another agent's request opens as droid's does (droidBody)
          const out = path.includes("/llm/a/") && path.endsWith("/messages")
            ? anthropicBody(body) : droidBody(path, body)
          if (out !== body) h.delete("content-length")
          return fetch(url, { ...init, method: init?.method ?? (input instanceof Request ? input.method : "POST"), headers: h, body: out })
        }

        return {
          apiKey: "placeholder",
          async fetch(input, init) {
            let body = init?.body
            if (body == null && input instanceof Request && input.body) body = new Uint8Array(await input.arrayBuffer())
            if (body instanceof ReadableStream) body = new Uint8Array(await new Response(body).arrayBuffer())
            const url = input instanceof Request ? input.url : String(input)
            // the built-in takes an account's lapse off when it renews the
            // token, whatever the request then meets, and never for an
            // answer: a 401 of Factory's leaves it be, and so does a success
            // with no renewal on the way
            let renewed = false
            const onRenew = () => (renewed = true)
            const answer = (res) => said(res, renewed ? "renewed" : "kept")
            let res
            try {
              res = await send(input, init, body, onRenew)
              if (res.status !== 403) return answer(res)
              let text = await res.text()
              if (await mendOrg(res.status, text, onRenew).catch(() => false)) {
                res = await send(input, init, body, onRenew)
                if (res.status !== 403) return answer(res)
                text = await res.text()
              }
              const why = explain(res.status, text)
              // the refusal, then what to do about it, as provider.Explain joins them
              const msg = `${vendorError(text, statusLine(res.status))} — ${why}`
              return answer(errorReply(url, res.status, "permission_error", msg, new Headers(res.headers)))
            } catch (e) {
              // Factory refused to renew the sign-in: the built-in failed the
              // request (magpie's 502) and marked the account lapsed
              if (e?.lapsed) return said(errorReply(url, 502, "api_error", e.message), "expired")
              throw e
            }
          },
        }
      },
    },
  }
}

// for tests
export const _internal = { limitWindows, windowEnd, dollars, vendorError, CORE, droidBody, DROID_LINE }
