// Aelios (github.com/wusaki0723/Aelios) long-term memory for every agent
// behind magpie, as a gateway request hook. Before a request goes to its
// model, the user's turn is given what Aelios recalls for it; after the reply,
// and only when `record` is on, the turn is handed to Aelios to remember.
//
//   {"serverUrl": "https://<your-aelios>.workers.dev", "apiKeyEnv": "AELIOS_API_KEY",
//    "identity": "", "agents": [], "recall": true, "record": false, "allowRemote": false,
//    "gatewayTimeoutMs": 5000, "requestTimeoutMs": 4000, "recallBackoffMs": 30000}
//
// Aelios decides what a turn is and what to recall (POST /v1/hook/recall)
// and what to keep (POST /v1/hook/record); the hook sends a slimmed copy of
// the request (slim.mjs) and puts the memory it gets back after the last
// user message. Anything that goes wrong leaves the request as it came.
import { createHash } from "node:crypto"
import { aeliosProtocol, appendPatch, hasSecret, humanTurn, lastUserText, serverState, slim, spoken } from "./slim.mjs"

const version = "0.1.0"
const maxResponseBytes = 256 << 10
const maxRecordBytes = 2 << 20
const recordTimeoutMs = 10_000
// magpie's host gives a hook this long when gatewayTimeoutMs isn't set
const hostDefaultTimeoutMs = 1000
// the host's report() takes byte counts up to this
const maxReportBytes = 32768
const maxServices = 64

// The only codes magpie accepts. An error's own text could hold a key or
// what someone said, so nothing else ever leaves the hook.
class Failure extends Error {
  constructor(code) {
    super(`Aelios ${code}`)
    this.code = code
  }
}

// magpie's Bun host is long-lived: this lasts till the plugin is reloaded.
const backoff = new Map()
const inflight = new Set()
export function reset() {
  backoff.clear()
  inflight.clear()
}
// flush waits for the records already sent (tests use it).
export function flush() {
  return Promise.allSettled([...inflight])
}

export async function onRequest(body, ctx) {
  const report = (code, bytes) => { try { ctx.report?.(code, bytes) } catch { /* never fails the request */ } }
  // A skipped or invalid request must never reuse an earlier turn's identity.
  if (ctx.state) delete ctx.state.aelios
  let o
  try {
    o = options(ctx.options)
  } catch {
    // the host rolls back and the request goes on as it came
    report("invalid")
    throw new Failure("invalid")
  }
  try {
    return await recall(body, ctx, o, report)
  } catch {
    // fail open: whatever happened, the request goes on unchanged
    return undefined
  }
}

async function recall(body, ctx, o, report) {
  if (!o || !allowed(ctx, o)) {
    report("skipped")
    return
  }
  const protocol = aeliosProtocol(ctx.protocol)
  if (!protocol || !body || typeof body !== "object") {
    report("skipped")
    return
  }
  const slimmed = slim(body, protocol)
  if (hasSecret(lastUserText(slimmed, protocol))) {
    if (ctx.state) delete ctx.state.aelios
    report("skipped")
    return
  }
  const original = payload(ctx, o, protocol, slimmed, body)
  const route = o.routes?.find((r) =>
    (!r.agents || r.agents.includes(original.agent)) &&
    (!r.models || r.models.some((pattern) => modelMatches(pattern, original.model))))
  if (route) original.identity = route.identity
  else if (o.routes?.length && !o.identity) {
    report("skipped")
    return
  }
  // Pin metadata before any network await, including tool steps and recall:false.
  if (ctx.state) ctx.state.aelios = { protocol, slimmed, payload: original }
  o = { ...o, identity: original.identity }
  if (serverState(body, protocol) || !humanTurn(slimmed, protocol) || !o.recall) {
    report("skipped")
    return
  }
  const key = serviceKey(o)
  if ((backoff.get(key) ?? 0) > Date.now()) {
    report("unavailable")
    return
  }
  if (!o.apiKey) {
    // Aelios would refuse it; what was said is not sent without a key
    report("unauthorized")
    return
  }
  // Our own deadline ends before the host's, so a slow Aelios is told from
  // a client that went away and backs off.
  const deadline = Math.max(50, Math.min(o.requestTimeoutMs, (o.gatewayTimeoutMs ?? hostDefaultTimeoutMs) - 50))
  let r
  try {
    r = await post(o, "v1/hook/recall", { ...original, record: o.record }, ctx.signal, deadline)
  } catch (error) {
    if (ctx.signal?.aborted) return // the client went away: not Aelios's failure
    trip(key, o)
    report("unavailable")
    return
  }
  if (r.status === 401) {
    trip(key, o)
    report("unauthorized")
    return
  }
  if (r.status === 403) {
    report("unbound")
    return
  }
  if (r.status === 404 || r.status >= 500) {
    // 404: an Aelios without the hook endpoints
    trip(key, o)
    report("unavailable")
    return
  }
  if (r.status < 200 || r.status >= 300 || !r.body || typeof r.body !== "object") {
    report("invalid")
    return
  }
  const { memory, patch } = r.body
  if (memory === "off") {
    report("unbound")
    return
  }
  if (memory === "skipped" || memory === "stateful") {
    report("skipped")
    return
  }
  if (memory === "unavailable") {
    report("unavailable")
    return
  }
  if (memory === "empty" || (memory === "injected" && (typeof patch !== "string" || !patch.trim()))) {
    report("empty")
    return
  }
  if (memory !== "injected" || typeof patch !== "string") {
    report("invalid")
    return
  }
  ctx.signal?.throwIfAborted()
  if (!appendPatch(body, protocol, patch)) {
    report("empty")
    return
  }
  report("ready", Math.min(utf8(patch), maxReportBytes))
  return body
}

export function onResponse(reply, ctx) {
  const report = (code, bytes) => { try { ctx.report?.(code, bytes) } catch { /* nothing to fail */ } }
  try {
    const state = ctx.state?.aelios
    if (!state) return
    let o
    try { o = options(ctx.options) } catch { return }
    if (!o || !o.record || !allowed(ctx, o) || !o.apiKey) {
      report("skipped")
      return
    }
    if (hasSecret(lastUserText(state.slimmed, state.protocol)) || hasSecret(spoken(reply))) {
      report("skipped")
      return
    }
    const body = {
      ...state.payload,
      reply: reply ?? null,
      success: ctx.success === true,
    }
    if (typeof reply?.model === "string" && reply.model) body.upstream_model = reply.model
    let size
    try { size = utf8(JSON.stringify(body)) } catch { return }
    if (size > maxRecordBytes) {
      report("skipped")
      return
    }
    // Fire and forget, on a deadline of its own rather than the request's:
    // the host doesn't wait for it, and it is sent once, never retried.
    const sent = post(o, "v1/hook/record", body, undefined, recordTimeoutMs).then((r) => {
      if (r.status === 401) report("unauthorized")
      else if (r.status === 403 || r.body?.reason === "off") report("unbound")
      else if (r.status >= 200 && r.status < 300 && r.body?.recorded === true) report("ready", Math.min(size, maxReportBytes))
      else if (r.status >= 200 && r.status < 300) report("skipped")
      else report("unavailable")
    }, () => report("unavailable")).finally(() => inflight.delete(sent))
    inflight.add(sent)
  } catch {
    // nothing here can change what the client got
  }
}

function allowed(ctx, o) {
  if (o.agents && !o.agents.includes(ctx.agent)) return false
  if (ctx.origin === "local" || ctx.origin === "magpie-key") return true
  // other gateway keys (maybe a friend's), remote and unknown origins
  return o.allowRemote
}

function payload(ctx, o, protocol, slimmed, body) {
  const out = { protocol }
  const model = typeof ctx.model === "string" && ctx.model ? ctx.model : typeof body?.model === "string" ? body.model : undefined
  if (model) out.model = model
  if (typeof ctx.agent === "string" && ctx.agent) out.agent = ctx.agent
  if (typeof ctx.session === "string" && ctx.session) out.session = ctx.session
  if (o.identity) out.identity = o.identity
  out.body = slimmed
  return out
}

// Only '*' is special; punctuation in a model name is always literal.
function modelMatches(pattern, model) {
  if (!model) return false
  const regex = new RegExp("^" + pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i")
  return regex.test(model) || regex.test(model.slice(model.lastIndexOf("/") + 1))
}

function options(raw = {}, env = process.env) {
  raw = raw && typeof raw === "object" ? raw : {}
  const text = (v) => {
    if (v === undefined || v === null || v === "") return undefined
    if (typeof v !== "string" || !v.trim()) throw new Failure("invalid")
    return v.trim()
  }
  const bool = (name, fallback) => {
    if (raw[name] === undefined || raw[name] === null) return fallback
    if (typeof raw[name] !== "boolean") throw new Failure("invalid")
    return raw[name]
  }
  const int = (name, fallback, min, max) => {
    const v = raw[name] ?? fallback
    if (v === undefined) return undefined
    if (!Number.isInteger(v) || v < min || v > max) throw new Failure("invalid")
    return v
  }
  const serverUrl = text(raw.serverUrl)
  // validated even without a server, so a mistake shows up at once
  const recall = bool("recall", true)
  const record = bool("record", false)
  const allowRemote = bool("allowRemote", false)
  const gatewayTimeoutMs = int("gatewayTimeoutMs", undefined, 100, 10_000)
  const requestTimeoutMs = int("requestTimeoutMs", 4000, 50, 9000)
  const recallBackoffMs = int("recallBackoffMs", 30_000, 0, 3_600_000)
  let agents
  if (raw.agents !== undefined && raw.agents !== null) {
    if (!Array.isArray(raw.agents) || !raw.agents.every((a) => typeof a === "string" && a.trim())) throw new Failure("invalid")
    agents = raw.agents.length ? raw.agents.map((a) => a.trim()) : undefined
  }
  const identity = text(raw.identity)
  if (identity !== undefined && identity.length > 128) throw new Failure("invalid")
  let routes
  if (raw.routes !== undefined) {
    if (!Array.isArray(raw.routes) || raw.routes.length > 64) throw new Failure("invalid")
    routes = raw.routes.map((route) => {
      if (!route || typeof route !== "object" || Array.isArray(route) ||
          typeof route.identity !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(route.identity) ||
          ["v1", "api", "admin", "health", "mcp", "memory-mcp", "memory-admin", "guide-dog"].includes(route.identity.toLowerCase()))
        throw new Failure("invalid")
      const selectors = {}
      for (const name of ["models", "agents"]) {
        if (route[name] === undefined) continue
        if (!Array.isArray(route[name]) || !route[name].length ||
            !route[name].every((v) => typeof v === "string" && v.trim() && (name !== "models" || v.length <= 200)))
          throw new Failure("invalid")
        selectors[name] = route[name].map((v) => v.trim())
      }
      if (!selectors.models && !selectors.agents) throw new Failure("invalid")
      return { identity: route.identity, ...selectors }
    })
  }
  const apiKeyEnv = text(raw.apiKeyEnv) ?? "AELIOS_API_KEY"
  const apiKey = text(raw.apiKey) ?? text(env[apiKeyEnv])
  if (!serverUrl) return
  let server
  try {
    server = new URL(serverUrl)
  } catch {
    throw new Failure("invalid")
  }
  // a key is never sent in clear text to another machine, kept in a URL
  // that logs show, or followed through a redirect
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(server.hostname)
  if (server.username || server.password || server.search || server.hash ||
      !(server.protocol === "https:" || (server.protocol === "http:" && local)))
    throw new Failure("invalid")
  server.pathname = server.pathname.replace(/\/+$/, "") + "/"
  return { server, apiKey, identity, routes, agents, recall, record, allowRemote, gatewayTimeoutMs, requestTimeoutMs, recallBackoffMs }
}

// post sends JSON to the configured server only and reads at most 256 KiB
// of the answer. It throws only when no answer came (network, deadline,
// cancellation, an answer cut off); any status comes back.
async function post(o, route, body, signal, timeoutMs) {
  const own = new AbortController()
  const timer = setTimeout(() => own.abort(), timeoutMs)
  timer.unref?.()
  const combined = signal ? AbortSignal.any([signal, own.signal]) : own.signal
  try {
    combined.throwIfAborted()
    const headers = { "Content-Type": "application/json", "User-Agent": `magpie-aelios/${version}` }
    headers.Authorization = /^bearer\s/i.test(o.apiKey) ? o.apiKey : `Bearer ${o.apiKey}`
    const r = await fetch(new URL(route, o.server), { method: "POST", headers, body: JSON.stringify(body), signal: combined, redirect: "error" })
    if (r.status < 200 || r.status >= 300) {
      try { await r.body?.cancel() } catch { /* already gone */ }
      return { status: r.status, body: undefined }
    }
    return { status: r.status, body: await json(r) }
  } finally {
    clearTimeout(timer)
  }
}

async function json(r) {
  const reader = r.body?.getReader()
  if (!reader) return undefined
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxResponseBytes) {
        try { await reader.cancel() } catch { /* already gone */ }
        return undefined
      }
      chunks.push(value)
    }
  } finally {
    try { reader.releaseLock() } catch { /* released */ }
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))
  } catch {
    return undefined
  }
}

function trip(key, o) {
  if (!o.recallBackoffMs) return
  backoff.delete(key)
  backoff.set(key, Date.now() + o.recallBackoffMs)
  while (backoff.size > maxServices) backoff.delete(backoff.keys().next().value)
}
function serviceKey(o) { return createHash("sha256").update([o.server.href, o.apiKey ?? "", o.identity ?? ""].join("\0")).digest("hex") }
function utf8(text) { return Buffer.byteLength(text, "utf8") }
