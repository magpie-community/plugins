// Mistral Vibe Code, as an OpenCode provider plugin (unofficial), served the
// way the official mistral-vibe CLI serves it:
//
// - Sign-in is the browser sign-in the CLI does: POST console.mistral.ai's
//   /api/vibe/sign-in with a PKCE challenge, the page it answers with is
//   opened, its poll_url is read until the browser has signed in, and
//   POST /api/vibe/sign-in/{process_id}/exchange (exchange_token +
//   code_verifier) returns an API key. That key is made for Vibe Code: its
//   calls on api.mistral.ai bill the plan's monthly Vibe Code budget, not
//   pay-as-you-go API credits. A key made the same way in the console
//   (Code > Vibe Code CLI) can be pasted instead.
// - Requests are plain OpenAI chat completions on https://api.mistral.ai/v1
//   with the key as a bearer token; the models are /v1/models. No private
//   protocol (the CLI's ACP layer is its IDE control plane, not its model
//   channel), so the loader re-signs each request, and puts an earlier
//   turn's thinking back in the typed part Mistral takes it (see
//   mistralBody below): Mistral turns an unknown message field away as 422
//   extra_forbidden.
// - Usage is the public billing read the CLI does:
//   GET api.mistral.ai/v1/billing/subscription (plan name, pay-as-you-go) and
//   GET api.mistral.ai/v1/billing/budget (vibe_budget: usage_percentage,
//   initial_budget, reset_at); the plan also comes from console's
//   /api/vibe/whoami.
//
// The provider id is "mistral-vibe", kept apart from the "mistral" preset
// (api.mistral.ai with the user's own API key).
import { createHash, randomBytes } from "node:crypto"

const ID = "mistral-vibe"

// bases are functions so tests can point them at a stand-in with the
// MISTRAL_VIBE_API_BASE / MISTRAL_VIBE_CONSOLE_API environment variables
function serviceBase(value) {
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid Mistral service base")
  }
  return url.href.replace(/\/+$/, "")
}
const apiBase = () => serviceBase(process.env.MISTRAL_VIBE_API_BASE || "https://api.mistral.ai/v1")
const consoleApi = () => serviceBase(process.env.MISTRAL_VIBE_CONSOLE_API || "https://console.mistral.ai/api")

const POLL_EVERY_MS = 1500
const SIGN_IN_TTL_MS = 10 * 60 * 1000
// one sign-in call's own deadline: the console answers these in well under a
// second, so a call still open after this is a dead connection to replace
const SIGN_IN_CALL_MS = 20_000
const DEFAULT_LIMIT = { context: 262_144, output: 65_536 }

// Prices from https://docs.mistral.ai/inference/pricing (USD per 1M tokens,
// standard tier, checked 2026-11-06), for the current LLM models only. The
// keys are the ids the docs and /v1/models agree on, plus Large 4's billing
// name; an alias is priced through its own billing_model_name, so it follows
// the model behind it rather than a price kept for the alias. Older
// generations and the speech, OCR and embedding models keep models.dev's
// price when it has one.
const DOCS_PRICES = {
  "mistral-large-4": { input: 0.7, output: 2.1, cache_read: 0.07 },
  "mistral-large-4-0": { input: 0.7, output: 2.1, cache_read: 0.07 },
  "mistral-large-4-0-a": { input: 0.7, output: 2.1, cache_read: 0.07 },
  "mistral-small-2603": { input: 0.15, output: 0.6, cache_read: 0.015 },
  "ministral-14b-2512": { input: 0.2, output: 0.2, cache_read: 0.02 },
  "ministral-8b-2512": { input: 0.15, output: 0.15, cache_read: 0.015 },
  "ministral-3b-2512": { input: 0.1, output: 0.1, cache_read: 0.01 },
  "codestral-2508": { input: 0.3, output: 0.9, cache_read: 0.03 },
  "zai-glm-5-3": { input: 1.4, output: 4.4, cache_read: 0.14 },
  "zai-glm-5-3-flash": { input: 0.15, output: 0.5, cache_read: 0.03 },
  "deepseek-v4-1-flash-1017": { input: 0.3, output: 1.2, cache_read: 0.007 },
  // mistral-large-latest is deliberately absent: the vendor still bills it as
  // mistral-large-2512 (Large 3), so models.dev's price for it is the right one.
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener("abort", onAbort, { once: true })
  })

const keyOf = (auth) => (auth?.type === "api" || auth?.key ? auth.key : auth?.access) || ""

// A Vibe plan is sized for one interactive CLI; magpie can put several
// agents behind the same key at once. The gate keeps that fan-out from
// reading as a burst: at most MISTRAL_VIBE_MAX_CONCURRENCY requests in flight
// per key, started at least MISTRAL_VIBE_MIN_INTERVAL_MS apart. One gate per
// key, so separate accounts never queue behind each other.
const MAX_INFLIGHT = Math.max(1, Number(process.env.MISTRAL_VIBE_MAX_CONCURRENCY) || 4)
const interval = Number(process.env.MISTRAL_VIBE_MIN_INTERVAL_MS?.trim() || 250)
const MIN_INTERVAL_MS = Number.isFinite(interval) && interval >= 0 ? interval : 250
const gates = new Map()
function gateOf(key) {
  let g = gates.get(key)
  if (!g) {
    g = { active: 0, lastStart: -Infinity, pacing: Promise.resolve(), queue: [] }
    gates.set(key, g)
  }
  return g
}
async function acquire(g, signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError")
  if (g.active >= MAX_INFLIGHT) {
    await new Promise((resolve, reject) => {
      const start = () => {
        signal?.removeEventListener("abort", onAbort)
        g.active += 1
        resolve()
      }
      const onAbort = () => {
        const i = g.queue.indexOf(start)
        if (i >= 0) g.queue.splice(i, 1)
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
      }
      g.queue.push(start)
      signal?.addEventListener("abort", onAbort, { once: true })
    })
  } else {
    g.active += 1
  }

}
function pace(g, signal, start) {
  let response
  const dispatch = g.pacing.then(async () => {
    const wait = g.lastStart + MIN_INTERVAL_MS - performance.now()
    if (wait > 0) await sleep(Math.ceil(wait), signal)
    signal?.throwIfAborted()
    g.lastStart = performance.now()
    response = Promise.resolve(start())
    // Observe rejection immediately without holding the pacing queue for headers.
    response.catch(() => {})
  })
  g.pacing = dispatch.catch(() => {})
  return dispatch.then(() => response)
}
function release(g) {
  g.active = Math.max(0, g.active - 1)
  const next = g.queue.shift()
  if (next) next()
}
async function withGate(key, signal, fn) {
  const g = gateOf(key)
  await acquire(g, signal)
  const start = () => {
    signal?.throwIfAborted()
    return fn()
  }
  let done = false
  const finish = () => {
    if (done) return
    done = true
    signal?.removeEventListener("abort", onAbort)
    release(g)
  }
  let reader
  const onAbort = () => {
    finish()
    void reader?.cancel(signal.reason).catch(() => {})
  }
  try {
    const response = await (MIN_INTERVAL_MS === 0 ? start() : pace(g, signal, start))
    if (!response.body || !response.ok) {
      finish()
      return response
    }
    reader = response.body.getReader()
    signal?.addEventListener("abort", onAbort, { once: true })
    if (signal?.aborted) onAbort()
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const chunk = await reader.read()
          if (signal?.aborted) throw signal.reason
          if (chunk.done) { finish(); controller.close() }
          else controller.enqueue(chunk.value)
        } catch (error) {
          finish()
          controller.error(error)
        }
      },
      cancel(reason) {
        finish()
        return reader.cancel(reason)
      },
    }, { highWaterMark: 0 })
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  } catch (error) {
    finish()
    throw error
  }
}

// ---- transport ----------------------------------------------------------
//
// Bun's fetch pools connections between requests. api.mistral.ai and
// console.mistral.ai are served behind Cloudflare, which closes an idle
// keep-alive connection on its own schedule; when the pool hands that socket
// to the next request, the write meets the closed peer and Bun fails the call
// before the request goes out:
//
//   ECONNRESET: The socket connection was closed unexpectedly. For more
//   information, pass verbose: true in the second argument to fetch()
//
// The dead socket is dropped with the error, so one retry takes a fresh
// connection. A POST is retried too, and only safely so: fetch resolves as
// soon as the response headers arrive, so an error thrown by the await means
// the response never started. A reset after the headers, a timeout and an
// abort come back as they are.
const STALE_SOCKET =
  /socket connection was closed unexpectedly|other side closed|connection closed|socket hang up/i

// STALE_CODES are the errno names both runtimes put on a connection the peer
// (or the pool) had already torn down: Node's undici reports ECONNRESET /
// UND_ERR_SOCKET, Bun its own ECONNRESET / ConnectionClosed, and a write to a
// half-closed socket is EPIPE.
const STALE_CODES = new Set(["ECONNRESET", "ECONNABORTED", "UND_ERR_SOCKET", "UND_ERR_CLOSED", "ConnectionClosed", "EPIPE"])

function staleSocket(e) {
  // a call the caller cancelled or that ran out of time says nothing about
  // the pool: it is the answer, not a socket the peer had already closed
  if (!e || typeof e !== "object") return false
  if (e.name === "AbortError" || e.name === "TimeoutError") return false
  for (const code of [e.code, e.cause?.code, e.errno, e.cause?.errno]) if (STALE_CODES.has(code)) return true
  return STALE_SOCKET.test(`${e.message ?? ""} ${e.cause?.message ?? ""}`)
}

// NET_CODES are the failures a sign-in's poll loop rides out: the network was
// briefly not there, or the edge was busy, and the same call a moment later
// is the right one. It is the loop's own retry, not the socket one above.
const NET_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
])

function transient(e) {
  if (!e || typeof e !== "object") return false
  if (e.name === "AbortError") return false
  if (e.transient === true || staleSocket(e)) return true
  if (e.name === "TimeoutError") return true
  return NET_CODES.has(e.code ?? e.cause?.code ?? e.errno)
}

// drain reads a response's body to its end and gives back the text, so its
// connection goes back to the pool reusable rather than half-read (a cancel
// would drop the socket). A body that fails mid-read is cancelled instead.
async function drain(res) {
  try {
    if (res?.body && !res.bodyUsed) return await res.text()
  } catch {}
  try {
    await res?.body?.cancel?.()
  } catch {}
  return ""
}

// RETRY_MS is the first pause before a stale-socket retry; each attempt
// waits a little longer, so a pool still handing back dead sockets is given
// the time to notice, without a caller's deadline being spent at once.
const RETRY_MS = 200
const READ_TRIES = 2
// the sign-in steps get one more try than a plain read: they run once, by
// hand, and a reset that eats them costs the user the whole browser round
// trip rather than a page of numbers
const SIGN_IN_TRIES = 3
const retryDelay = (attempt) => RETRY_MS * (attempt + 1) + Math.floor(Math.random() * 100)

// Only read-only methods can be replayed after a transport failure.
async function send(input, init = {}) {
  const method = String(init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
  const signal = init.signal ?? (input instanceof Request ? input.signal : undefined)
  const budget = ["GET", "HEAD", "OPTIONS"].includes(method) ? READ_TRIES : 0
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(input, init)
    } catch (e) {
      if (signal?.aborted || attempt >= budget || !staleSocket(e)) throw e
      await sleep(retryDelay(attempt), signal)
    }
  }
}

// readJSON is a request and its body as JSON, with the stale-socket retry
// covering both halves. fetch resolves at the response headers, so a peer
// that resets the connection after them fails res.text() instead — the same
// dead socket, one step later, and just as safe to ask again. Reads go
// through here, and so do the two sign-in steps whose repeat is harmless (a
// second start leaves an unused process behind, an exchange with the same
// token either hands out the key or does not); a chat body is streamed and
// is never read inside the retry.
async function readJSON(url, init = {}, { retries = READ_TRIES } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, init)
      if (!res.ok) {
        // A refusal is read once and kept for the error message.
        return { res, data: null, text: await drain(res) }
      }
      const text = await res.text()
      return { res, data: parseJSON(text), text }
    } catch (e) {
      if (init.signal?.aborted || attempt >= retries || !staleSocket(e)) throw e
      await sleep(retryDelay(attempt), init.signal)
    }
  }
}

function parseJSON(text) {
  try {
    if (text) return JSON.parse(text)
  } catch {}
  return null
}

// why says what a refusal said, in the few words the console puts in it
// (`{"detail":"..."}`, `{"message":"..."}`, `{"error":"..."}`), so a 4xx reads
// as the server's answer rather than only its number.
function why(text, data = parseJSON(text)) {
  const detail = data?.detail ?? data?.message ?? data?.error ?? data?.error_description
  if (typeof detail === "string" && detail !== "") return `: ${detail}`
  const s = text.replace(/\s+/g, " ").trim()
  return s ? `: ${s.slice(0, 200)}` : ""
}

// ---- the browser sign-in (vibe's setup/auth/http_browser_sign_in_gateway) ----

const newVerifier = () => randomBytes(48).toString("base64url")
const challengeOf = (verifier) => createHash("sha256").update(verifier).digest("base64url")

const UA = () => "magpie-mistral-vibe/0.2.0"

function checkedTarget(input, expected) {
  const actual = new URL(input instanceof Request ? input.url : input)
  const target = new URL(expected)
  if (!["http:", "https:"].includes(actual.protocol) || actual.origin !== target.origin ||
      actual.pathname !== target.pathname || actual.username || actual.password || actual.hash) {
    throw new Error("Unexpected Mistral request target")
  }
  return actual.href
}

function checkedPollTarget(pollUrl, base) {
  const actual = new URL(pollUrl)
  const prefix = `${base}/vibe/sign-in/poll/`
  const token = actual.pathname.slice(new URL(prefix).pathname.length)
  if (!/^[A-Za-z0-9._~-]+$/.test(token) || actual.search) {
    throw new Error("Unexpected Mistral request target")
  }
  return checkedTarget(actual, prefix + token)
}

function consoleHeaders(extra = {}) {
  return { accept: "application/json", "user-agent": UA(), ...extra }
}

// withTimeout gives a call its own deadline beside the caller's: whichever
// comes first ends it, and an abort the caller made still reads as one.
function withTimeout(signal, ms) {
  const t = AbortSignal.timeout(ms)
  if (!signal) return t
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, t]) : signal
}

async function startSignIn(signal) {
  const base = consoleApi()
  const code_verifier = newVerifier()
  // readJSON, not send: the payload comes back in the body, and a reset that
  // lands between the headers and the body is the same dead socket one step
  // later. A second start on a fresh connection is harmless — the process it
  // leaves unused expires on its own.
  const { res, data: d, text } = await readJSON(
    `${base}/vibe/sign-in`,
    {
      method: "POST",
      redirect: "error",
      headers: consoleHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ code_challenge: challengeOf(code_verifier), code_challenge_method: "S256" }),
      // a start that hangs is retried by the deadline, not waited on forever
      signal: withTimeout(signal, SIGN_IN_CALL_MS),
    },
    { retries: SIGN_IN_TRIES }
  )
  if (!res.ok) throw new Error(`Mistral sign-in could not start (${res.status})${why(text)}`)
  if (!d?.process_id || !d?.sign_in_url || !d?.poll_url) throw new Error("Mistral sign-in answered an unexpected payload")
  checkedProcessId(d.process_id)
  const poll_url = checkedPollTarget(d.poll_url, base)
  return { base, process_id: d.process_id, sign_in_url: d.sign_in_url, poll_url, expires_at: d.expires_at, code_verifier }
}

function signInResponseError(status, message) {
  const error = new Error(message)
  if (status === 429 || status >= 500) error.transient = true
  return error
}

function retryAfterMs(value) {
  if (!value) return 0
  if (/^\d+$/.test(value)) return Number(value) * 1000
  return Math.max(0, Date.parse(value) - Date.now()) || 0
}

function checkedProcessId(id) {
  if (typeof id !== "string" || !id || id === "." || id === ".." || /[^A-Za-z0-9._~-]/.test(id)) throw new Error("Invalid Mistral sign-in process ID")
  return encodeURIComponent(id)
}

async function pollSignIn(pollUrl, signal, base = consoleApi()) {
  const { res, data, text } = await readJSON(
    checkedPollTarget(pollUrl, base),
    { redirect: "error", headers: consoleHeaders(), signal: withTimeout(signal, SIGN_IN_CALL_MS) },
    { retries: SIGN_IN_TRIES }
  )
  if (res.status === 410) return { status: "expired" }
  if (!res.ok) {
    const error = signInResponseError(res.status, `Mistral sign-in poll answered ${res.status}${why(text)}`)
    if (res.status === 429) error.retryAfterMs = retryAfterMs(res.headers.get("retry-after"))
    throw error
  }
  return data
}

async function exchangeSignIn(processId, exchangeToken, codeVerifier, signal, base = consoleApi()) {
  // an exchange repeats on the same token, so a stale socket is safe to
  // retry here too: the server either hands out the key or has already
  // spent the token, and the second answer is the real one
  const { res, data: d, text } = await readJSON(
    `${base}/vibe/sign-in/${checkedProcessId(processId)}/exchange`,
    {
      method: "POST",
      redirect: "error",
      headers: consoleHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ exchange_token: exchangeToken, code_verifier: codeVerifier }),
      signal: withTimeout(signal, SIGN_IN_CALL_MS),
    },
    { retries: SIGN_IN_TRIES }
  )
  if (!res.ok) {
    const errorData = parseJSON(text)
    if (res.status === 403 && errorData?.error_code === 9004) {
      throw new Error("This Mistral workspace is not eligible for Vibe (403/9004). Sign in again and choose a workspace with Vibe access.")
    }
    throw signInResponseError(res.status, `Mistral sign-in exchange failed (${res.status})${why(text, errorData)}`)
  }
  if (!d?.api_key) throw new Error("Mistral sign-in exchange returned no API key")
  return d.api_key
}

// whoami names the plan behind a key (console.mistral.ai/api/vibe/whoami)
async function whoami(key, base = consoleApi()) {
  const { res, data } = await readJSON(`${base}/vibe/whoami`, {
    redirect: "error",
    headers: consoleHeaders({ Authorization: `Bearer ${key}` }),
    signal: AbortSignal.timeout(8000),
  })
  return res.ok ? data : null
}

function accountIdentity(who) {
  const kind = typeof who?.plan_type === "string" ? who.plan_type.trim().toLowerCase() : ""
  const name = typeof who?.plan_name === "string" ? who.plan_name.trim() : ""
  if (kind === "api") return { kind, plan: "Mistral Studio API" }
  if (kind === "chat" && name) {
    const plans = { INDIVIDUAL: "Mistral Pro", FREE: "Mistral Free", EDU: "Mistral Student", TEAM: "Mistral Team" }
    return { kind, plan: plans[name.toUpperCase()] ?? name }
  }
  if (kind === "mistral_code" && name) {
    const plans = { F: "Free Codestral", E: "Code Enterprise" }
    return { kind, plan: plans[name.toUpperCase()] ?? name }
  }
  return { kind }
}

// ---- models: /v1/models, limits filled from models.dev when it knows them ----

let devModels = null
async function modelsDev() {
  if (devModels) return devModels
  try {
    const { res, data } = await readJSON("https://models.dev/api.json", { signal: AbortSignal.timeout(5000) })
    devModels = res.ok ? (data?.mistral?.models ?? {}) : {}
  } catch {
    devModels = {}
  }
  return devModels
}

// priceOf is a model's list price as OpenCode and magpie take it: USD per
// 1M tokens, with the cache read and write beside input and output. docs
// first, then models.dev, and undefined when nothing prices it rather than
// a made-up zero.
function priceOf(m, dev) {
  const caps = m?.capabilities ?? {}
  const billing = typeof m?.billing_model_name === "string" ? m.billing_model_name : ""
  const aliases = Array.isArray(m?.aliases) ? m.aliases : []
  const names = [billing, ...aliases, m?.id].filter((id) => typeof id === "string" && id)
  const stated = names.map((id) => DOCS_PRICES[id]).find(Boolean)
  // a speech or non-chat model's models.dev price may be per minute, page or
  // character rather than per token, so only chat models without audio take it
  const audio =
    caps.audio === true || caps.audio_transcription === true || caps.audio_transcription_realtime === true || caps.audio_speech === true
  const chat = caps.completion_chat ?? true
  const p = stated ?? (chat && !audio ? names.map((id) => dev?.[id]?.cost).find(Boolean) : undefined)
  if (!p || typeof p !== "object") return undefined
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0)
  const cache = p.cache && typeof p.cache === "object" ? p.cache : {}
  return {
    input: n(p.input),
    output: n(p.output),
    cache: { read: n(p.cache_read ?? cache.read), write: n(p.cache_write ?? cache.write) },
  }
}

async function listModels(key) {
  const { res, data: j } = await readJSON(`${apiBase()}/models`, {
    redirect: "error",
    headers: { Authorization: `Bearer ${key}`, "user-agent": UA() },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) return null
  const dev = await modelsDev()
  const out = {}
  for (const m of j?.data ?? []) {
    if (!m?.id || typeof m.id !== "string") continue
    const billing = typeof m.billing_model_name === "string" ? m.billing_model_name : ""
    const aliases = Array.isArray(m.aliases) ? m.aliases : []
    const d = [billing, ...aliases, m.id].map((id) => dev[id]).find(Boolean) ?? {}
    const caps = m.capabilities ?? {}
    const image = caps.vision ?? d.attachment ?? false
    const reasoning = caps.reasoning ?? d.reasoning ?? false
    const toolcall = caps.function_calling ?? d.tool_call ?? true
    const chat = caps.completion_chat ?? true
    const context =
      Number(m.max_context_length) > 0 ? Number(m.max_context_length) : d.limit?.context ?? DEFAULT_LIMIT.context
    const inputs = {
      text: caps.ocr !== true,
      image: image === true,
      audio: caps.audio === true || caps.audio_transcription === true || caps.audio_transcription_realtime === true,
      video: false,
      pdf: Array.isArray(d.modalities?.input) && d.modalities.input.includes("pdf"),
    }
    const outputs = { text: chat === true, image: false, audio: caps.audio_speech === true, video: false, pdf: false }
    const modalities = (kinds) => Object.keys(kinds).filter((k) => kinds[k])
    const model = {
      name: d.name ?? m.id,
      limit: {
        context,
        output: d.limit?.output ?? DEFAULT_LIMIT.output,
      },
      tool_call: toolcall,
      attachment: image,
      reasoning,
      temperature: chat,
      // OpenCode 1.x's model shape, so magpie and 2.x see what the model
      // takes and gives (and leave a TTS or an embedding out of chat lists)
      modalities: { input: modalities(inputs), output: modalities(outputs) },
      capabilities: {
        temperature: chat,
        reasoning,
        attachment: image,
        toolcall,
        input: inputs,
        output: outputs,
        interleaved: false,
      },
    }
    const cost = priceOf(m, dev)
    if (cost) model.cost = cost
    out[m.id] = model
  }
  return out
}

// ---- usage: the billing reads (vibe's app_server/_billing.py) ----

const usageInFlight = new Map()
function refreshUsage(key) {
  const base = apiBase()
  const consoleBase = consoleApi()
  const id = JSON.stringify([base, consoleBase, key])
  if (usageInFlight.has(id)) return usageInFlight.get(id)
  const pending = readUsage(key, base, consoleBase).finally(() => usageInFlight.delete(id))
  usageInFlight.set(id, pending)
  return pending
}

async function readUsage(key, base = apiBase(), consoleBase = consoleApi()) {
  const headers = { Authorization: `Bearer ${key}`, "user-agent": UA() }
  const ask = async (url) => {
    const { res, data } = await readJSON(url, { headers, redirect: "error", signal: AbortSignal.timeout(8000) })
    return res.ok ? data : null
  }
  const [subscription, budget, who] = (await Promise.allSettled([
    ask(`${base}/billing/subscription`),
    ask(`${base}/billing/budget`),
    whoami(key, consoleBase),
  ])).map((read) => read.status === "fulfilled" ? read.value : null)
  const identity = accountIdentity(who)
  const vb = budget?.vibe_budget
  const ab = budget?.api_budget
  const windows = []
  const statusWindow = (name, display) => ({ name, display, aside: true })
  const windowOf = (name, w, aside) => {
    if (!Number.isFinite(w?.usage_percentage) || w.usage_percentage < 0 || w.initial_budget === 0) return null
    const resetsAt = w.reset_at ? Date.parse(w.reset_at) : NaN
    const span = Number.isFinite(resetsAt) ? Math.max(3600, Math.floor((resetsAt - Date.now()) / 1000)) : 30 * 86400
    const out = {
      name,
      used: w.usage_percentage,
      resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
      span,
    }
    if (Number.isFinite(w.initial_budget) && w.initial_budget > 0) {
      out.amount = Math.round(w.initial_budget * (w.usage_percentage / 100) * 1e6) / 1e6
      out.limit = w.initial_budget
      if (typeof w.currency === "string") out.unit = w.currency.trim().toUpperCase()
    }
    if (aside) out.aside = true
    return out
  }

  if (identity.kind === "api") {
    windows.push(statusWindow("Vibe Code account", "Studio API key. Create a Vibe CLI key under Code > Vibe CLI."))
  } else {
    const name = "Monthly Vibe Code"
    // The organization budget can be readable with a Studio key as well.
    const monthly = windowOf(name, vb, identity.kind !== "chat")
    windows.push(monthly ?? statusWindow(name, vb?.initial_budget === 0 ? "No monthly budget" : "Budget unavailable"))
    const payg = [vb?.payg_enabled, subscription?.vibe_payg_enabled].find((value) => typeof value === "boolean")
    windows.push(statusWindow("Pay as you go", payg === undefined ? "Unknown" : payg ? "On" : "Off"))
    if (!identity.plan) {
      const billingPlan = typeof subscription?.plan_name === "string" && subscription.plan_name.trim()
      const display = billingPlan ? `Plan not confirmed · Billing reports ${billingPlan}` : "Plan not confirmed"
      windows.push(statusWindow("Vibe Code account", display))
    }
  }
  const abm = windowOf("Platform API credits", ab, true)
  if (abm) windows.push(abm)
  return identity.plan ? { plan: identity.plan, windows } : { windows, signIn: "kept" }
}

// ---- an earlier turn's thinking, in the shape Mistral takes it ----

// api.mistral.ai reads each chat message strictly: a field it doesn't know
// turns the whole request away as 422 "Extra inputs are not permitted"
// (extra_forbidden, loc ["body","messages",2,"assistant",
// "reasoning_content"]). An earlier assistant turn's thinking comes back
// from most clients in one of these fields — reasoning_content (OpenCode,
// pi, Claude Code through a gateway), reasoning (OpenRouter's) and
// reasoning_details (OpenRouter's structured one) — so a conversation with
// a thinking turn in it never gets through. Mistral returns a thinking turn
// as a typed content part and takes it back that way, so the thinking goes
// there, ahead of the turn's own text, as magpie's own Mistral handling
// gives it (#494).
const THINKING_FIELDS = ["reasoning_content", "reasoning", "reasoning_details"]

// thinkingText is the thinking a message carries in THINKING_FIELDS.
function thinkingText(m) {
  for (const f of THINKING_FIELDS.slice(0, 2)) {
    const v = m[f]
    if (typeof v === "string" && v !== "") return v
  }
  const details = m.reasoning_details
  if (!Array.isArray(details)) return ""
  let out = ""
  for (const d of details) {
    if (!d || typeof d !== "object") continue
    if (typeof d.text === "string" && d.text !== "") out += d.text
    else if (typeof d.summary === "string") out += d.summary
  }
  return out
}

function stripExtraFields(value, allowed) {
  const extras = Object.keys(value).filter((field) => !allowed.includes(field))
  for (const field of extras) delete value[field]
  return extras.length > 0
}

// asMistralMessage follows Mistral's user, assistant, and text chunk schemas.
// Convert thinking before removing host fields. A prefill keeps its content.
function asMistralMessage(m) {
  const c = m.content
  let changed = false
  if (Array.isArray(c)) {
    for (const part of c) {
      if (part?.type === "text" && stripExtraFields(part, ["type", "text"])) changed = true
    }
  }
  if (m.role === "user") return stripExtraFields(m, ["role", "content"]) || changed
  if (THINKING_FIELDS.some((f) => f in m)) {
    const think = thinkingText(m)
    for (const f of THINKING_FIELDS) delete m[f]
    changed = true
    if (think !== "" && m.role === "assistant" && m.prefix !== true) {
      const part = { type: "thinking", thinking: [{ type: "text", text: think }] }
      if (typeof c === "string") m.content = c === "" ? [part] : [part, { type: "text", text: c }]
      else if (Array.isArray(c)) m.content = [part, ...c]
      else m.content = [part]
    }
  }
  if (m.role === "assistant") return stripExtraFields(m, ["role", "content", "tool_calls", "prefix"]) || changed
  return changed
}

// mistralBody is a chat request's body with every message's thinking in the
// shape Mistral takes, and without the fields it turns away. A body with no
// such field comes back as it was, byte for byte, and so does one that isn't
// a chat request's JSON.
function mistralBody(body) {
  if (typeof body !== "string") return body
  let q
  try {
    q = JSON.parse(body)
  } catch {
    return body
  }
  if (!q || typeof q !== "object" || !Array.isArray(q.messages)) return body
  let changed = false
  for (const m of q.messages) if (m && typeof m === "object" && asMistralMessage(m)) changed = true
  return changed ? JSON.stringify(q) : body
}

// ---- the plugin ----

export const MistralVibeAuthPlugin = async ({ client } = {}) => ({
  config: async (cfg) => {
    cfg.provider ??= {}
    cfg.provider[ID] ??= {
      name: "Mistral Vibe Code",
      npm: "@ai-sdk/openai-compatible",
      api: apiBase(),
      models: {},
    }
  },
  auth: {
    provider: ID,
    usage: async (getAuth) => {
      const key = keyOf(await getAuth())
      if (!key) return { error: "Not signed in", windows: [] }
      return refreshUsage(key)
    },
    loader: async (getAuth) => {
      const auth = await getAuth()
      const key = keyOf(auth)
      if (!key) return {}
      const base = apiBase()
      return {
        baseURL: base,
        apiKey: "mistral-vibe", // the engine's placeholder; the fetch below signs
        async fetch(input, init = {}) {
          const target = checkedTarget(input, `${base}/chat/completions`)
          const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
          headers.set("Authorization", `Bearer ${key}`)
          headers.set("User-Agent", UA())
          const body = mistralBody(init.body)
          if (body !== init.body) headers.delete("content-length")
          const signal = init.signal ?? (input instanceof Request ? input.signal : undefined)
          return withGate(JSON.stringify([base, key]), signal, () => send(input instanceof Request ? input : target, {
            ...init, headers, redirect: "error", ...(body !== init.body ? { body } : {}),
          }))
        },
      }
    },
    methods: [
      {
        type: "oauth",
        label: "Sign in with Mistral (browser)",
        authorize: async (_inputs, { signal } = {}) => {
          const p = await startSignIn(signal)
          return {
            url: p.sign_in_url,
            instructions: "Sign in to your Mistral account on the page that opens. The sign-in finishes here by itself.",
            method: "auto",
            callback: async (_code, { signal: cbSignal } = {}) => {
              // the host's authorize signal often ends with the authorize
              // call; using it here would cancel the first poll at once, and
              // the sign-in would never be seen through
              const s = cbSignal ?? (signal?.aborted ? undefined : signal)
              const deadline = (Date.parse(p.expires_at) || Date.now() + SIGN_IN_TTL_MS)
              // a poll that fails on a dead pooled socket, a 429 or a 5xx is
              // the network, not the sign-in: the loop asks again until the
              // link's own deadline. A 4xx that isn't 410 is the server
              // refusing the process, and asking again would only repeat it.
              let misses = 0
              while (Date.now() < deadline) {
                let r
                try {
                  r = await pollSignIn(p.poll_url, s, p.base)
                  misses = 0
                } catch (e) {
                  if (s?.aborted) throw e
                  if (!transient(e)) return { type: "failed", error: e?.message ?? String(e) }
                  misses++
                  const wait = Math.max(Math.min(POLL_EVERY_MS * misses, 10_000), e.retryAfterMs ?? 0)
                  if (wait >= deadline - Date.now()) {
                    return { type: "failed", error: `Sign-in poll failed: ${e?.message ?? e}. Start sign-in again.` }
                  }
                  await sleep(wait, s)
                  continue
                }
                if (r?.status === "completed" && r.exchange_token) {
                  // the token stays good until the process expires, so a
                  // transient failure here is asked again rather than thrown
                  // away: the user's browser round trip is not spent twice
                  for (;;) {
                    try {
                      const key = await exchangeSignIn(p.process_id, r.exchange_token, p.code_verifier, s, p.base)
                      const who = await whoami(key, p.base).catch(() => null)
                      const out = { type: "success", key, metadata: { plan: accountIdentity(who).plan, vibeEntitlement: who?.has_paid_vibe_entitlement } }
                      if (who?.customer_id != null) out.accountId = String(who.customer_id)
                      return out
                    } catch (e) {
                      if (!transient(e) || Date.now() > deadline) return { type: "failed", error: `Sign-in exchange failed: ${e?.message ?? e}` }
                      await sleep(POLL_EVERY_MS, s)
                    }
                  }
                }
                if (r?.status === "expired") return { type: "failed", error: "The sign-in expired; start it again" }
                if (r?.status === "denied") return { type: "failed", error: r.message || "The sign-in was denied" }
                if (r?.status === "error") return { type: "failed", error: r.message || "The sign-in failed" }
                await sleep(Math.min(POLL_EVERY_MS, Math.max(0, deadline - Date.now())), s)
              }
              s?.throwIfAborted()
              return { type: "failed", error: "The sign-in timed out; start it again" }
            },
          }
        },
      },
      {
        type: "api",
        label: "Vibe Code API key",
        placeholder: "key made in console.mistral.ai under Code > Vibe CLI",
      },
    ],
  },
  provider: {
    id: ID,
    async models(provider, { auth } = {}) {
      const key = keyOf(auth)
      if (!key) return provider?.models ?? {}
      const got = await listModels(key).catch(() => null)
      return got && Object.keys(got).length ? got : (provider?.models ?? {})
    },
  },
})

// for tests
export const _internal = {
  startSignIn,
  pollSignIn,
  exchangeSignIn,
  whoami,
  listModels,
  readUsage,
  keyOf,
  priceOf,
  DOCS_PRICES,
  mistralBody,
  THINKING_FIELDS,
  ID,
  apiBase,
  consoleApi,
  send,
  readJSON,
  drain,
  staleSocket,
  transient,
  why,
  SIGN_IN_TRIES,
  READ_TRIES,
}
