import fs from "node:fs"
import { open } from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { discover, projectModels, isPermittedModel, parseDate } from "./discovery.js"
import { validateRequest, dispatch, responseError } from "./responses.js"
import { validateRequest as validateMessagesRequest, dispatch as messagesDispatch } from "./messages.js"
import { readJSONRequest } from "./transport.js"
import { pluginRevision } from "./revision.js"

// Per-protocol transports keyed by the registry entry's protocol. The account
// lifecycle, discovery, token ownership and cancellation around them are shared;
// only request parsing and dispatch differ per native protocol.
const TRANSPORTS = {
  responses: { validateRequest, dispatch },
  anthropic: { validateRequest: validateMessagesRequest, dispatch: messagesDispatch },
}
// Account-root client routes the host rewrites to, mapped to their protocol.
const ROUTES = { "/responses": "responses", "/messages": "anthropic" }
// Recognition for unavailable-model errors only; eligibility remains discovery's.
const KNOWN_CLAUDE_MODELS = new Set(["claude-opus-4-8", "claude-sonnet-4-6"])

const PROVIDER_ID = "sap-aicore"
const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
const AUTH_HOST = new RegExp(`^${LABEL}\\.authentication\\.${LABEL}\\.hana\\.ondemand\\.com$`)
const AI_HOST = new RegExp(`^api\\.ai\\.${LABEL}(?:\\.${LABEL})*\\.hana\\.ondemand\\.com$`)
const MAX_BYTES = 65536
const TIMEOUT_MS = 15000
const DEFAULT_IDLE_TIMEOUT_MS = 120000
const DEFAULT_TOTAL_TIMEOUT_MS = 900000
const MAX_TOTAL_TIMEOUT_MS = 3600000
const ERRORS = {
  input: "SAP AI Core: invalid credential file path.",
  file: "SAP AI Core: credential file could not be read.",
  credentials: "SAP AI Core: credential file is invalid.",
  destination: "SAP AI Core: unsafe request destination.",
  "oauth-response": "SAP AI Core: token endpoint returned an unexpected response.",
  "oauth-refused": "SAP AI Core: sign-in was refused by the token endpoint.",
  network: "SAP AI Core: token endpoint could not be reached.",
  timeout: "SAP AI Core: token acquisition timed out.",
  cancelled: "SAP AI Core: token acquisition was cancelled.",
  superseded: "SAP AI Core: account was replaced before this operation completed.",
  "inference-timeout": "SAP AI Core: the inference request timed out.",
  "inference-idle-timeout": "SAP AI Core: the inference stream timed out while waiting for data.",
  "inference-cancelled": "SAP AI Core: the inference request was cancelled.",
  "unknown-model": "SAP AI Core: requested model has no verified available deployment.",
  "unavailable-model": "SAP AI Core: requested model has no verified running deployment.",
}

const DISCOVERY_ERRORS = {
  destination: "SAP AI Core: model discovery used an unsafe destination.",
  response: "SAP AI Core: model discovery returned an unexpected response.",
  network: "SAP AI Core: model discovery could not be reached.",
  timeout: "SAP AI Core: model discovery timed out.",
  cancelled: "SAP AI Core: model discovery was cancelled.",
  exhausted: "SAP AI Core: model discovery exceeded its bounds.",
  identity: "SAP AI Core: a Claude deployment's model identity could not be resolved.",
  conflict: "SAP AI Core: distinct Claude deployments resolved to the same model identity.",
}
const OWNED_ERRORS = new WeakSet()


/** @returns {Error & {code: string, status?: number, retryAfter?: string}} */
function failure(code) {
  const error = Object.assign(new Error(ERRORS[code]), { code })
  OWNED_ERRORS.add(error)
  return error
}

function discoveryFailure(error) {
  const code = Object.hasOwn(DISCOVERY_ERRORS, error?.code) ? error.code : "response"
  /** @type {Error & {code: string, status?: number, retryAfter?: string}} */
  const safe = Object.assign(new Error(DISCOVERY_ERRORS[code]), { code: "discovery-" + code, status: code === "cancelled" ? 499 : code === "timeout" ? 504 : 502 })
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) safe.status = error.status
  if (/^\d{1,10}$/.test(error?.retryAfter ?? "")) safe.retryAfter = error.retryAfter
  OWNED_ERRORS.add(safe)
  return safe
}

function safeFailure(error) {
  return OWNED_ERRORS.has(error) ? error : failure("network")
}

const DISCOVERY_TTL_MS = 300000

function retireAtOf(entries) {
  let soonest
  for (const name of Object.keys(entries)) {
    const at = parseDate(entries[name]?.metadata?.retirementDate ?? "")
    if (at === null) continue
    if (soonest === undefined || at < soonest) soonest = at
  }
  return soonest
}

function credentialPath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || !path.isAbsolute(value)) {
    throw failure("input")
  }
  return path.normalize(value)
}

function reference(credentialFile) {
  const normalized = credentialPath(credentialFile)
  return {
    credentialFile: normalized,
    key: "sap-aicore:path:" + createHash("sha256").update("sap-aicore:path:" + normalized).digest("hex"),
  }
}

function storedReference(auth) {
  if (auth?.type !== "api") throw failure("credentials")
  const ref = reference(auth.metadata?.credentialFile)
  if (auth.key !== ref.key) throw failure("credentials")
  return ref
}

function serviceURL(raw) {
  if (typeof raw !== "string" || !/^https:\/\//i.test(raw) || /[\x00-\x20\x7f-\x9f\\\s?#]/.test(raw)) {
    throw failure("destination")
  }
  if (/%(?:2f|5c|2e)/i.test(raw) || /\/(?:\.|\.\.)(?:\/|$)/.test(raw)) throw failure("destination")
  let url
  try { url = new URL(raw) } catch { throw failure("destination") }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) {
    throw failure("destination")
  }
  return url
}

function root(raw, auth) {
  const url = serviceURL(raw)
  if (!(auth ? AUTH_HOST : AI_HOST).test(url.hostname)) throw failure("credentials")
  const suffix = auth ? "/oauth/token" : "/v2"
  if (!["/", suffix].includes(url.pathname)) throw failure("credentials")
  return url.origin
}

function credentials(bytes) {
  let value
  try { value = JSON.parse(bytes) } catch { throw failure("credentials") }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("credentials")
  for (const field of ["authUrl", "baseUrl", "clientId", "clientSecret", "resourceGroup"]) {
    if (typeof value[field] !== "string" || !value[field].trim()) throw failure("credentials")
  }
  for (const field of ["clientId", "clientSecret"]) {
    // Limit raw Basic credentials to the supported unambiguous subset.
    if (/[:\x00-\x1f\x7f-\x9f]/.test(value[field]) || !value[field].isWellFormed()) throw failure("credentials")
  }
  if (!/^[\x21-\x7e]+$/.test(value.resourceGroup)) throw failure("credentials")
  try {
    return {
      tokenURL: root(value.authUrl, true) + "/oauth/token",
      aiRoot: root(value.baseUrl, false),
      clientId: value.clientId,
      clientSecret: value.clientSecret,
      resourceGroup: value.resourceGroup,
    }
  } catch { throw failure("credentials") }
}

async function bounded(operation, controller) {
  let timer
  let onAbort
  const stop = new Promise((_, reject) => {
    onAbort = () => reject(controller.signal.reason?.code ? controller.signal.reason : failure("cancelled"))
    controller.signal.addEventListener("abort", onAbort, { once: true })
    timer = setTimeout(() => controller.abort(failure("timeout")), TIMEOUT_MS)
  })
  try {
    if (controller.signal.aborted) throw controller.signal.reason ?? failure("cancelled")
    return await Promise.race([Promise.resolve().then(operation), stop])
  } finally {
    clearTimeout(timer)
    controller.signal.removeEventListener("abort", onAbort)
  }
}

async function readCredentials(file, controller) {
  return bounded(async () => {
    let handle
    try {
      // Nonblocking open prevents a FIFO from occupying an fs worker before its type is checked.
      handle = await open(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0))
      if (controller.signal.aborted) throw failure("cancelled")
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > MAX_BYTES) throw failure("file")
      const bytes = Buffer.alloc(MAX_BYTES + 1)
      let size = 0
      while (size < bytes.length) {
        if (controller.signal.aborted) throw failure("cancelled")
        const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size)
        if (!bytesRead) break
        size += bytesRead
      }
      if (size > MAX_BYTES) throw failure("file")
      return credentials(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)))
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason ?? failure("cancelled")
      throw error?.code && Object.hasOwn(ERRORS, error.code) ? error : failure("file")
    } finally {
      if (handle) await handle.close().catch(() => {})
    }
  }, controller)
}

async function responseJSON(response, signal) {
  const reader = response.body?.getReader()
  if (!reader) throw failure("oauth-response")
  const chunks = []
  let size = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener("abort", cancel, { once: true })
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason ?? failure("cancelled")
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) throw failure("oauth-response")
      chunks.push(value)
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))
  } catch (error) {
    cancel()
    if (signal.aborted) throw signal.reason ?? failure("cancelled")
    throw failure("oauth-response")
  } finally {
    signal.removeEventListener("abort", cancel)
    reader.releaseLock()
  }
}

async function exchange(creds, controller) {
  return bounded(async () => {
    const started = performance.now()
    // Bun's macOS monotonic clock pauses during sleep; SAP token lifetime does not.
    const wallStarted = Date.now()
    let response
    try {
      response = await globalThis.fetch(creds.tokenURL, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: "Basic " + Buffer.from(`${creds.clientId}:${creds.clientSecret}`, "utf8").toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
        signal: controller.signal,
      })
    } catch {
      if (controller.signal.aborted) throw controller.signal.reason ?? failure("cancelled")
      throw failure("network")
    }
    if (controller.signal.aborted) {
      void response.body?.cancel().catch(() => {})
      throw controller.signal.reason ?? failure("cancelled")
    }
    if (response.redirected || (response.url && response.url !== creds.tokenURL) || (response.status >= 300 && response.status < 400)) {
      void response.body?.cancel().catch(() => {})
      throw failure("oauth-response")
    }
    const oauthFailure = () => {
      const error = failure("oauth-response")
      if (response.status >= 400 && response.status <= 599) error.status = response.status
      const retryAfter = response.headers.get("retry-after")
      if (/^\d{1,10}$/.test(retryAfter ?? "")) error.retryAfter = retryAfter
      return error
    }
    let body
    try { body = await responseJSON(response, controller.signal) }
    catch (error) {
      if (controller.signal.aborted || response.ok) throw error
      throw oauthFailure()
    }
    if (response.status === 401 && body?.error === "invalid_client" && /^Basic(?:\s|$)/i.test(response.headers.get("www-authenticate") ?? "")) {
      throw Object.assign(failure("oauth-refused"), { status: 401 })
    }
    const lifetime = body?.expires_in * 1000
    if (!response.ok || typeof body?.access_token !== "string" || !/^[\x21-\x7e]+$/.test(body.access_token) ||
        typeof body.expires_in !== "number" || !Number.isFinite(lifetime) || lifetime <= 0 || lifetime > Number.MAX_SAFE_INTEGER ||
        (body.token_type !== undefined && (typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer"))) {
      throw oauthFailure()
    }
    const expiresAt = started + lifetime
    const wallExpiresAt = wallStarted + lifetime
    if (!Number.isFinite(expiresAt) || !Number.isFinite(wallExpiresAt) ||
        performance.now() >= expiresAt || Date.now() >= wallExpiresAt) throw failure("oauth-response")
    const margin = Math.min(60000, lifetime / 2)
    return { value: body.access_token, expiresAt, wallExpiresAt, renewAt: expiresAt - margin, wallRenewAt: wallExpiresAt - margin }
  }, controller)
}

function requestTarget(input, init) {
  const request = input instanceof Request ? input : null
  const url = serviceURL(request ? request.url : String(input))
  const method = init?.method ?? request?.method ?? "GET"
  const protocol = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname] : undefined
  if (typeof method !== "string" || method.toUpperCase() !== "POST" ||
      !AI_HOST.test(url.hostname) || protocol === undefined) throw failure("destination")
  return { origin: url.origin, signal: init?.signal ?? request?.signal, protocol }
}

const CREDENTIAL_HEADERS = new Set(["api-key", "x-api-key", "x-goog-api-key", "openai-api-key", "x-auth-token", "x-access-token", "client-secret", "x-client-secret"])

function incomingSecrets(input, init) {
  const secrets = []
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
  headers.forEach((value, key) => {
    if (key === "authorization" || key === "proxy-authorization") secrets.push(value, value.replace(/^\S+\s+/, ""))
    else if (CREDENTIAL_HEADERS.has(key)) secrets.push(value)
  })
  return secrets
}

function clampTimeout(value, fallback) {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) return fallback
  return Math.min(MAX_TOTAL_TIMEOUT_MS, Math.max(1, Math.floor(value)))
}

export async function SAPAICorePlugin(input) {
  const generations = new Map()
  const candidates = new Map()
  let idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS
  let totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS

  function applyTimeouts(source) {
    if (!source || typeof source !== "object") return
    for (const candidate of [source.options, source]) {
      if (!candidate || typeof candidate !== "object") continue
      const rawIdle = candidate.idleTimeoutMs ?? candidate.streamIdleTimeoutMs
      const rawTotal = candidate.totalTimeoutMs ?? candidate.inferenceTimeoutMs ?? candidate.timeoutMs
      if (rawIdle !== undefined) idleTimeoutMs = clampTimeout(rawIdle, idleTimeoutMs)
      if (rawTotal !== undefined) totalTimeoutMs = clampTimeout(rawTotal, totalTimeoutMs)
      else if (rawIdle !== undefined && totalTimeoutMs < idleTimeoutMs) totalTimeoutMs = idleTimeoutMs
    }
  }
  applyTimeouts(input?.config?.provider?.[PROVIDER_ID])
  applyTimeouts(input)

  if (typeof input?.client?.app?.log === "function") {
    void pluginRevision().then(version => input.client.app.log({
      body: { service: PROVIDER_ID, level: "info", message: `version ${version}` },
    })).catch(() => {})
  }

  function generation(ref) {
    return { ref, credentials: null, token: null, flight: null, load: null, snapshot: null, discovery: null, retired: false, controller: new AbortController() }
  }

  function retire(gen) {
    gen.retired = true
    gen.controller.abort(failure("superseded"))
    gen.flight?.controller.abort(failure("superseded"))
    gen.discovery?.controller.abort(failure("superseded"))
    gen.credentials = gen.token = gen.load = gen.flight = gen.snapshot = gen.discovery = null
  }

  function current(gen) {
    if (gen.retired || (generations.get(gen.ref.key) !== gen && candidates.get(gen.ref.key) !== gen)) throw failure("superseded")
  }

  function initialize(ref) {
    if (!generations.has(ref.key)) generations.set(ref.key, generation(ref))
    return generations.get(ref.key)
  }

  async function loaded(gen) {
    current(gen)
    if (!gen.credentials) {
      if (!gen.load) {
        const load = readCredentials(gen.ref.credentialFile, gen.controller).then(creds => {
          current(gen)
          gen.credentials = creds
        })
        gen.load = load
        load.catch(() => {
          if (gen.load === load) {
            gen.load = null
            if (!gen.retired) gen.controller = new AbortController()
          }
        })
      }
      await gen.load
      current(gen)
    }
  }

  async function tokenFor(gen, signal, check = async () => current(gen)) {
    current(gen)
    if (signal?.aborted) throw failure("cancelled")
    await check()
    if (gen.token && performance.now() < gen.token.renewAt && Date.now() < gen.token.wallRenewAt) return gen.token
    if (!gen.flight) {
      const flight = { controller: new AbortController(), owners: new Set(), result: null }
      gen.flight = flight
      flight.result = exchange(gen.credentials, flight.controller)
      // Observe rejection even if every request owner leaves before the exchange settles.
      flight.result.catch(() => {})
    }
    const flight = gen.flight
    const owner = Symbol()
    flight.owners.add(owner)
    let rejectAbort
    const aborted = new Promise((_, reject) => { rejectAbort = reject })
    const release = () => {
      flight.owners.delete(owner)
      if (!flight.owners.size && gen.flight === flight) {
        gen.flight = null
        flight.controller.abort(failure("cancelled"))
      }
    }
    const cancel = () => { release(); rejectAbort(failure("cancelled")) }
    signal?.addEventListener("abort", cancel, { once: true })
    try {
      if (signal?.aborted) throw failure("cancelled")
      const token = await Promise.race([flight.result, aborted])
      await check()
      current(gen)
      if (signal?.aborted) throw failure("cancelled")
      if (gen.flight !== flight || performance.now() >= token.expiresAt || Date.now() >= token.wallExpiresAt) throw failure("superseded")
      gen.token = token
      return token
    } catch (error) {
      await check()
      throw safeFailure(error)
    } finally {
      signal?.removeEventListener("abort", cancel)
      release()
    }
  }

  async function authorize(inputs) {
    let ref
    try {
      if (!inputs || typeof inputs !== "object" || Array.isArray(inputs) || Object.keys(inputs).length !== 1 || !Object.hasOwn(inputs, "credentialFile")) throw failure("input")
      ref = reference(inputs.credentialFile)
    } catch { return { type: "failed", error: ERRORS.input } }
    if (candidates.has(ref.key)) retire(candidates.get(ref.key))
    const gen = generation(ref)
    candidates.set(ref.key, gen)
    try {
      await loaded(gen)
      await tokenFor(gen)
      current(gen)
      if (generations.has(ref.key)) retire(generations.get(ref.key))
      generations.set(ref.key, gen)
      candidates.delete(ref.key)
      return { type: "success", key: ref.key, metadata: { credentialFile: ref.credentialFile } }
    } catch (error) {
      if (candidates.get(ref.key) === gen) candidates.delete(ref.key)
      retire(gen)
      return { type: "failed", error: safeFailure(error).message }
    }
  }

  async function registryFor(gen, signal, check = async () => current(gen)) {
    current(gen)
    if (signal?.aborted) throw failure("cancelled")
    await loaded(gen)
    await tokenFor(gen, signal, check)
    await check()
    if (signal?.aborted) throw failure("cancelled")
    const cached = gen.snapshot
    if (cached && performance.now() - cached.completedAt < DISCOVERY_TTL_MS &&
        Date.now() - cached.wallCompletedAt < DISCOVERY_TTL_MS &&
        (cached.retireAt === undefined || Date.now() < cached.retireAt)) {
      return cached.entries
    }
    if (!gen.discovery) {
      const flight = { controller: new AbortController(), owners: new Set(), result: null }
      let authError = null
      let usedToken
      flight.result = discover({
        aiRoot: gen.credentials.aiRoot,
        resourceGroup: gen.credentials.resourceGroup,
        bearer: async () => {
          try { usedToken = await tokenFor(gen, flight.controller.signal); return usedToken.value }
          catch (error) { authError = safeFailure(error); throw error }
        },
        signal: flight.controller.signal,
        rejectedToken: () => { if (gen.token === usedToken) gen.token = null },
      }).then(
        entries => {
          current(gen)
          if (gen.discovery === flight && !flight.controller.signal.aborted && flight.owners.size) {
            gen.snapshot = { entries, completedAt: performance.now(), wallCompletedAt: Date.now(), retireAt: retireAtOf(entries) }
          }
          return entries
        },
        error => {
          current(gen)
          throw authError ?? discoveryFailure(error)
        },
      )
      gen.discovery = flight
      flight.result.catch(() => {})
    }
    const flight = gen.discovery
    const owner = Symbol()
    flight.owners.add(owner)
    let rejectAbort
    const aborted = new Promise((_, reject) => { rejectAbort = reject })
    const release = () => {
      flight.owners.delete(owner)
      if (!flight.owners.size && gen.discovery === flight) {
        gen.discovery = null
        flight.controller.abort(failure("cancelled"))
      }
    }
    const cancel = () => { release(); rejectAbort(failure("cancelled")) }
    signal?.addEventListener("abort", cancel, { once: true })
    try {
      if (signal?.aborted) throw failure("cancelled")
      const entries = await Promise.race([flight.result, aborted])
      await check()
      current(gen)
      if (signal?.aborted) throw failure("cancelled")
      return entries
    } catch (error) {
      await check()
      throw error
    } finally {
      signal?.removeEventListener("abort", cancel)
      release()
    }
  }

  async function models(given, context) {
    if (!context?.auth) return {}
    const gen = initialize(storedReference(context.auth))
    try { return projectModels(await registryFor(gen)) }
    catch (error) {
      current(gen)
      error.signIn = error?.code === "oauth-refused" ? "expired" : "kept"
      throw error
    }
  }

  async function loader(getAuth) {
    let ref
    try { ref = storedReference(await getAuth()) } catch (error) { throw safeFailure(error) }
    const gen = initialize(ref)
    await loaded(gen)
    let revoked = false
    async function selected() {
      if (revoked) throw failure("superseded")
      let now
      try { now = storedReference(await getAuth()) } catch { revoked = true; throw failure("superseded") }
      if (now.key !== ref.key || now.credentialFile !== ref.credentialFile || generations.get(ref.key) !== gen || gen.retired) {
        revoked = true
        throw failure("superseded")
      }
    }
    await selected()
    try { await registryFor(gen, undefined, selected) }
    catch {
      // Discovery failure is surfaced by the active fetch as an HTTP response;
      // throwing from the loader would let the host flatten status and headers.
      await selected()
    }
    await selected()
    const aiRoot = gen.credentials.aiRoot
    return {
      baseURL: gen.credentials.aiRoot,
      fetch: async (input, init) => {
        let target
        try {
          target = requestTarget(input, init)
          if (target.origin !== aiRoot) throw failure("destination")
        } catch (error) { return responseError(safeFailure(error), true) }
        const controller = new AbortController()
        const cancel = () => controller.abort(failure("inference-cancelled"))
        const replace = () => controller.abort(failure("superseded"))
        target.signal?.addEventListener("abort", cancel, { once: true })
        gen.controller.signal.addEventListener("abort", replace, { once: true })
        if (target.signal?.aborted) cancel()
        if (gen.controller.signal.aborted) replace()
        let handedOff = false
        let cleaned = false
        const totalTimer = setTimeout(() => controller.abort(failure("inference-timeout")), totalTimeoutMs)
        let idleTimer
        const touchIdle = () => {
          if (cleaned || controller.signal.aborted) return
          clearTimeout(idleTimer)
          idleTimer = setTimeout(() => controller.abort(failure(handedOff ? "inference-idle-timeout" : "inference-timeout")), idleTimeoutMs)
        }
        touchIdle()
        let rejectAbort
        const aborted = new Promise((_, reject) => { rejectAbort = reject })
        const onAbort = () => rejectAbort(controller.signal.reason)
        controller.signal.addEventListener("abort", onAbort, { once: true })
        let disposeBody = () => {}
        const cleanup = () => {
          if (cleaned) return
          cleaned = true
          disposeBody()
          clearTimeout(totalTimer)
          clearTimeout(idleTimer)
          controller.signal.removeEventListener("abort", onAbort)
          target.signal?.removeEventListener("abort", cancel)
          gen.controller.signal.removeEventListener("abort", replace)
          if (!controller.signal.aborted) controller.abort(failure("inference-cancelled"))
        }
        try {
          if (controller.signal.aborted) throw controller.signal.reason
          const check = async () => {
            await Promise.race([selected(), aborted])
            if (controller.signal.aborted) throw controller.signal.reason
          }
          const work = (async () => {
            await check()
            const transport = TRANSPORTS[target.protocol]
            const request = await readJSONRequest(input, init, controller.signal)
            const entries = await registryFor(gen, controller.signal, check)
            await check()
            const entry = entries[request.model]
            if (!entry) {
              const code = isPermittedModel(request.model) || KNOWN_CLAUDE_MODELS.has(request.model) ? "unavailable-model" : "unknown-model"
              throw Object.assign(failure(code), { status: 404 })
            }
            // The client route must match the selected model's native protocol:
            // a model is never dispatched through another protocol's transport.
            if (entry.protocol !== target.protocol) throw Object.assign(failure("destination"), { status: 400 })
            const body = transport.validateRequest(request, entry)
            const token = await tokenFor(gen, controller.signal, check)
            await check()
            if (controller.signal.aborted) throw controller.signal.reason
            const response = await transport.dispatch({
              entry, body, credentials: gen.credentials, token, signal: controller.signal,
              extraSecrets: incomingSecrets(input, init),
              rejectedToken: () => { if (gen.token === token) gen.token = null },
            })
            await check()
            return response
          })()
          const response = await Promise.race([work, aborted])
          if (!response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) return response

          // A streamed fetch owns its deadline and account/request listeners
          // until the consumer finishes or cancels, not merely until headers.
          const reader = response.body.getReader()
          let ended = false
          const cancelBody = () => {
            void reader.cancel().catch(() => {})
            reader.releaseLock()
          }
          const body = new ReadableStream({
            start(output) {
              const abort = () => {
                if (ended) return
                ended = true
                output.error(controller.signal.reason)
                cancelBody()
                cleanup()
              }
              disposeBody = () => controller.signal.removeEventListener("abort", abort)
              controller.signal.addEventListener("abort", abort, { once: true })
              if (controller.signal.aborted) abort()
            },
            async pull(output) {
              try {
                const chunk = await reader.read()
                if (ended) return
                if (chunk.done) {
                  ended = true
                  output.close()
                  reader.releaseLock()
                  cleanup()
                } else {
                  touchIdle()
                  output.enqueue(chunk.value)
                }
              } catch (error) {
                if (ended) return
                ended = true
                // dispatch exposes only locally sanitized stream errors.
                output.error(controller.signal.aborted ? controller.signal.reason : error)
                cancelBody()
                cleanup()
              }
            },
            cancel() {
              ended = true
              controller.abort(failure("inference-cancelled"))
              cancelBody()
              cleanup()
            },
          }, { highWaterMark: 0 })
          const streamed = new Response(body, { status: response.status, headers: response.headers })
          handedOff = true
          touchIdle()
          return streamed
        } catch (error) {
          return responseError(error, OWNED_ERRORS.has(error))
        } finally {
          if (!handedOff) cleanup()
        }
      },
    }
  }

  return {
    async config(config) {
      config.provider ??= {}
      config.provider[PROVIDER_ID] = {
        name: "SAP AI Core", npm: "@ai-sdk/openai", models: {},
        ...config.provider[PROVIDER_ID],
      }
      applyTimeouts(config.provider[PROVIDER_ID])
    },
    auth: {
      provider: PROVIDER_ID,
      methods: [{
        type: "api", keyless: true, label: "SAP AI Core credential file",
        prompts: [{ key: "credentialFile", message: "Absolute path to your SAP AI Core credential file", type: "text" }],
        authorize,
      }],
      loader,
    },
    provider: { id: PROVIDER_ID, models },
  }
}
