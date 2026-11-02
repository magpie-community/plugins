// Shared, protocol-agnostic transport primitives.
//
// Both the GPT Responses transport and the Claude Messages transport build on
// these: credential-safe bounded body reading, secret redaction, locally-owned
// safe errors, and standard response rendering. Token management stays in the
// plugin factory and protocol semantics stay in each transport; this module
// never converts between protocols.

const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
export const AI_HOST = new RegExp(`^api\\.ai\\.${LABEL}(?:\\.${LABEL})*\\.hana\\.ondemand\\.com$`)
export const SAFE_TEXT = /^[\x21-\x7e]+$/

// Request/whole-reply and per-SSE-frame byte bound. A streaming reply is never
// accumulated as a whole; encrypted history can still make one frame large.
export const MAX_BODY_BYTES = 16 * 1024 * 1024

// Default safe statuses used only when a safe error carries no explicit status.
const STATUS = {
  "invalid-request": 400,
  destination: 400,
  "unknown-model": 404,
  "oauth-refused": 401,
  "inference-destination": 502,
  "inference-redirect": 502,
  "inference-network": 502,
  "inference-response": 502,
  "inference-timeout": 504,
  "inference-idle-timeout": 504,
  "inference-cancelled": 499,
  cancelled: 499,
  timeout: 504,
  network: 502,
  superseded: 503,
  internal: 500,
}

const MESSAGES = {
  "inference-destination": "SAP AI Core: the deployment target was unsafe.",
  "inference-redirect": "SAP AI Core: the deployment redirected the request.",
  "inference-network": "SAP AI Core: the deployment could not be reached.",
  "inference-response": "SAP AI Core: the deployment returned an unexpected response.",
  "inference-timeout": "SAP AI Core: the inference request timed out.",
  "inference-idle-timeout": "SAP AI Core: the inference stream timed out while waiting for data.",
  "inference-cancelled": "SAP AI Core: the inference request was cancelled.",
  "invalid-request": "SAP AI Core: the request was rejected.",
  internal: "The request could not be completed.",
}

export const GENERIC_MESSAGE = "The request could not be completed."

// Errors this module (and the transports that reuse it) construct are trusted
// for echoing by responseError. Anything not in this set (or not flagged
// trusted by the parent) is sanitized.
const OWNED = new WeakSet()

/** Safe descriptive text for a locally-owned error code. */
export function messageFor(code) {
  return MESSAGES[code] ?? GENERIC_MESSAGE
}

/**
 * Construct a branded, locally-owned safe error.
 * @param {string} code
 * @param {{ status?: number, retryAfter?: string, message?: string }} [options]
 * @returns {Error & { code: string, status?: number, retryAfter?: string }}
 */
export function safeError(code, options = {}) {
  const error = /** @type {Error & { code: string, status?: number, retryAfter?: string }} */ (
    new Error(options.message ?? MESSAGES[code] ?? GENERIC_MESSAGE)
  )
  error.code = code
  if (options.status !== undefined) error.status = options.status
  if (options.retryAfter !== undefined) error.retryAfter = options.retryAfter
  OWNED.add(error)
  return error
}

export const invalid = (message, status = 400) => safeError("invalid-request", { status, message })

/** @returns {boolean} */
export function owns(error) {
  return OWNED.has(error)
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
export function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

/**
 * Prefer the parent-owned abort reason (it carries inference-timeout /
 * inference-cancelled) and fall back to our own cancellation error.
 * @param {AbortSignal} [signal]
 */
export function abortReason(signal) {
  return signal?.reason ?? safeError("inference-cancelled")
}

/**
 * Drain a byte stream up to `limit`, racing the abort signal so cancellation
 * wins even when a (mocked) reader ignores reader.cancel().
 * @param {ReadableStream<Uint8Array>} stream
 * @param {AbortSignal | undefined} signal
 * @param {number} limit
 * @param {() => Error} oversize
 * @returns {Promise<Buffer>}
 */
export async function drain(stream, signal, limit, oversize) {
  if (!stream || typeof stream.getReader !== "function") throw oversize()
  const reader = stream.getReader()
  /** @type {Buffer[]} */
  const chunks = []
  let size = 0
  /** @type {(() => void) | undefined} */
  let onAbort
  const aborted = new Promise((_, reject) => {
    if (!signal) return
    onAbort = () => reject(abortReason(signal))
    signal.addEventListener("abort", onAbort, { once: true })
  })
  const cancel = () => { void reader.cancel().catch(() => {}) }
  try {
    for (;;) {
      if (signal?.aborted) throw abortReason(signal)
      const { done, value } = signal ? await Promise.race([reader.read(), aborted]) : await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw oversize()
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
    }
    return Buffer.concat(chunks, size)
  } catch (error) {
    cancel()
    if (signal?.aborted) throw abortReason(signal)
    throw error
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort)
    try { reader.releaseLock() } catch {}
  }
}

/**
 * Resolve the raw bytes of a Fetch-compatible body (init.body if present, else
 * the Request body), bounded and cancellable.
 * @param {string | Request} input
 * @param {*} init
 * @param {AbortSignal} [signal]
 * @returns {Promise<Buffer>}
 */
export async function readBytes(input, init, signal) {
  // Fetch semantics: init.body wins only when defined; otherwise consume the Request.
  const source = init?.body !== undefined ? init.body : (input instanceof Request ? input : undefined)
  if (source === undefined || source === null) throw invalid("A request body is required.")

  const tooLarge = () => invalid("The request body exceeds the maximum allowed size.", 413)

  if (typeof source === "string") {
    if (source.length > MAX_BODY_BYTES) throw tooLarge()
    const bytes = Buffer.from(source, "utf8")
    if (bytes.byteLength > MAX_BODY_BYTES) throw tooLarge()
    return bytes
  }
  if (source instanceof ArrayBuffer) {
    if (source.byteLength > MAX_BODY_BYTES) throw tooLarge()
    return Buffer.from(source)
  }
  if (ArrayBuffer.isView(source)) {
    if (source.byteLength > MAX_BODY_BYTES) throw tooLarge()
    return Buffer.from(source.buffer, source.byteOffset, source.byteLength)
  }
  if (typeof Blob !== "undefined" && source instanceof Blob) {
    if (source.size > MAX_BODY_BYTES) throw tooLarge()
    return drain(source.stream(), signal, MAX_BODY_BYTES, tooLarge)
  }
  if (source instanceof Request) {
    if (source.bodyUsed) throw invalid("The request body has already been consumed.")
    if (!source.body) throw invalid("A request body is required.")
    return drain(source.body, signal, MAX_BODY_BYTES, tooLarge)
  }
  if (source instanceof ReadableStream || (source && typeof source.getReader === "function")) {
    return drain(source, signal, MAX_BODY_BYTES, tooLarge)
  }
  throw invalid("The request body type is not supported.")
}

/** Parse the bounded JSON routing envelope before protocol-specific validation. */
export async function readJSONRequest(input, init, signal) {
  if (signal?.aborted) throw abortReason(signal)
  const bytes = await readBytes(input, init, signal)
  let text
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes) }
  catch { throw invalid("The request body is not valid UTF-8.") }
  let body
  try { body = JSON.parse(text) }
  catch { throw invalid("The request body is not valid JSON.") }
  if (!isObject(body)) throw invalid("The request body must be a JSON object.")
  if (typeof body.model !== "string" || !body.model || /[\x00-\x1f\x7f]/.test(body.model)) throw invalid("The \"model\" parameter must be a non-empty string.")
  return /** @type {{model: string} & Record<string, unknown>} */ (body)
}

/**
 * Collect every credential substring to redact, longest first.
 * @param {*} credentials
 * @param {*} token
 * @param {string[]} [extraSecrets]
 * @returns {string[]}
 */
export function secretsOf(credentials, token, extraSecrets) {
  const out = []
  if (token && typeof token.value === "string" && token.value) out.push(token.value)
  if (credentials) {
    const clientId = credentials.clientId
    const clientSecret = credentials.clientSecret
    if (typeof clientId === "string" && clientId) out.push(clientId)
    if (typeof clientSecret === "string" && clientSecret) out.push(clientSecret)
    if (typeof clientId === "string" && clientId && typeof clientSecret === "string" && clientSecret) {
      const raw = clientId + ":" + clientSecret
      const basic = Buffer.from(raw, "utf8").toString("base64")
      out.push(raw, basic, "Basic " + basic)
    }
  }
  // resourceGroup is actionable identity, not a secret — never redacted.
  if (Array.isArray(extraSecrets)) {
    for (const secret of extraSecrets) if (typeof secret === "string" && secret) out.push(secret)
  }
  return out.sort((a, b) => b.length - a.length)
}

/**
 * Replace every secret substring in a single string.
 * @param {string} value
 * @param {string[]} secrets
 */
export function redactString(value, secrets) {
  let out = value
  for (const secret of secrets) if (secret) out = out.split(secret).join("[redacted]")
  return out
}

export const ERROR_PROTOCOL_FIELDS = new Set(["code", "type", "param", "status"])

/**
 * Redact credential echoes in descriptive error details. Native error category
 * fields are preserved by the caller, not by arbitrary nested key names.
 * @param {*} value
 * @param {string[]} secrets
 * @returns {*}
 */
export function redactErrorDetails(value, secrets) {
  if (typeof value === "string") return redactString(value, secrets)
  if (Array.isArray(value)) return value.map(v => redactErrorDetails(v, secrets))
  if (isObject(value)) {
    const out = Object.create(null)
    for (const key of Object.keys(value)) out[key] = redactErrorDetails(value[key], secrets)
    return out
  }
  return value
}

/**
 * @param {*} error
 * @param {string[]} secrets
 */
export function redactError(error, secrets) {
  if (!isObject(error)) return redactErrorDetails(error, secrets)
  const out = Object.create(null)
  for (const key of Object.keys(error)) out[key] = ERROR_PROTOCOL_FIELDS.has(key) ? error[key] : redactErrorDetails(error[key], secrets)
  return out
}

/**
 * True only for a verified invalid/expired Bearer rejection.
 * @param {string | null} header
 */
export function bearerRejected(header) {
  if (!header || !/^Bearer\b/i.test(header)) return false
  return /\berror\s*=\s*(?:"(?:invalid_token|expired_token)"|(?:invalid_token|expired_token))(?=\s|,|$)/i.test(header)
}

/**
 * Build the safe, local-only JSON response headers: drop every upstream header,
 * keep a numeric-seconds Retry-After only.
 * @param {Response} upstream
 */
export function safeHeaders(upstream) {
  const headers = new Headers({ "content-type": "application/json", "x-magpie-sign-in": "kept" })
  const retryAfter = upstream.headers.get("retry-after")
  if (retryAfter && /^\d{1,10}$/.test(retryAfter)) headers.set("retry-after", retryAfter)
  return headers
}

export function streamHeaders() {
  return new Headers({ "content-type": "text/event-stream", "x-magpie-sign-in": "kept" })
}

export const SSE_ENCODER = new TextEncoder()

/**
 * Generic bounded, data-only SSE relay. Emits at most one frame per pull with
 * no read-ahead or whole-reply accumulation; byte framing precedes UTF-8
 * decoding so split code points and split frames are harmless. Protocol
 * specifics are supplied by callbacks:
 *   classify(event, eventName) -> { terminal, redacted } or throws a safe error
 *     for a malformed/mislabelled frame. `redacted === event` means unchanged.
 *   errorEvent(code) -> the serialized protocol error frame for a local failure.
 * @param {ReadableStream<Uint8Array>} upstream
 * @param {AbortSignal | undefined} signal
 * @param {{ classify: (event: any, name: string) => { terminal: boolean, redacted: any, name?: string }, errorEvent: (code: string) => string }} hooks
 * @returns {ReadableStream<Uint8Array>}
 */
export function sseRelay(upstream, signal, { classify, errorEvent }) {
  const reader = upstream.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let chunk = new Uint8Array(0)
  let cursor = 0
  let skipLF = false
  let lineEmpty = true
  let frameBytes = 0
  /** @type {Uint8Array[]} */
  let parts = []
  let finished = false
  let released = false
  let onAbort = () => {}

  const release = () => {
    if (released) return
    released = true
    signal?.removeEventListener("abort", onAbort)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
    chunk = new Uint8Array(0)
    parts = []
  }
  const fail = (output, code) => {
    finished = true
    release()
    output.enqueue(SSE_ENCODER.encode(errorEvent(code)))
    output.close()
  }

  // Scan bytes only up to the next blank line. A CR completes a line
  // immediately; a following LF is consumed as part of the same newline.
  const takeFrame = () => {
    let start = cursor
    while (cursor < chunk.length) {
      const byte = chunk[cursor++]
      if (skipLF) {
        skipLF = false
        if (byte === 10) {
          if (!frameBytes) start = cursor
          else if (++frameBytes > MAX_BODY_BYTES) throw safeError("inference-response")
          continue
        }
      }
      if (++frameBytes > MAX_BODY_BYTES) throw safeError("inference-response")
      if (byte !== 10 && byte !== 13) { lineEmpty = false; continue }
      skipLF = byte === 13
      if (lineEmpty) {
        parts.push(chunk.subarray(start, cursor))
        const text = parts.map(part => decoder.decode(part, { stream: true })).join("") + decoder.decode()
        parts = []
        frameBytes = 0
        return text
      }
      lineEmpty = true
    }
    if (cursor > start) parts.push(chunk.subarray(start, cursor))
    return null
  }

  return new ReadableStream({
    start(output) {
      onAbort = () => {
        if (finished) return
        finished = true
        release()
        output.error(safeError("inference-cancelled"))
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      if (signal?.aborted) onAbort()
    },
    async pull(output) {
      if (finished) { output.close(); return }
      try {
        for (;;) {
          const raw = takeFrame()
          if (raw !== null) {
            const lines = raw.split(/\r\n|\r|\n/)
            const data = []
            let name = ""
            for (const line of lines) {
              const colon = line.indexOf(":")
              const field = colon < 0 ? line : line.slice(0, colon)
              let value = colon < 0 ? "" : line.slice(colon + 1)
              if (value.startsWith(" ")) value = value.slice(1)
              if (field === "data") data.push(value)
              else if (field === "event") name = value
            }
            if (!data.length) continue // comment / keep-alive / metadata only
            let event
            try { event = JSON.parse(data.join("\n")) } catch { throw safeError("inference-response") }
            const { terminal, redacted, name: emitName } = classify(event, name)
            let text
            if (redacted === event) {
              text = raw.replace(/\r\n|\r/g, "\n")
            } else {
              // Rebuild a redacted frame without a leading blank line, preserving any
              // non-data lines (e.g. an existing `event:`) ahead of the new data.
              const kept = lines.filter(line => line && !line.startsWith("data:"))
              text = [...kept, "data: " + JSON.stringify(redacted)].join("\n") + "\n\n"
            }
            // Some upstreams (SAP) relay data-only frames; clients that dispatch on
            // the SSE `event:` name need it synthesized from the event type.
            if (emitName && !/^event:/m.test(text)) text = "event: " + emitName + "\n" + text
            output.enqueue(SSE_ENCODER.encode(text))
            if (terminal) {
              finished = true
              release()
              output.close()
            }
            return
          }
          let next
          try { next = await reader.read() }
          catch {
            if (!finished) fail(output, "inference-network")
            return
          }
          if (finished) return
          if (next.done) {
            // EOF without a valid, fully framed terminal is truncation, not
            // completion. This also rejects any trailing partial UTF-8/frame.
            fail(output, "inference-response")
            return
          }
          chunk = next.value
          cursor = 0
        }
      } catch {
        if (!finished) fail(output, "inference-response")
      }
    },
    cancel() {
      finished = true
      release()
    },
  }, { highWaterMark: 0 })
}

/**
 * Convert a locally-owned safe error into a standard JSON Response. Only errors
 * created here (or by a transport reusing this module) or flagged `trusted` by
 * the parent are echoed; everything else is sanitized to a generic internal
 * error.
 * @param {*} error
 * @param {boolean} [trusted]
 * @returns {Response}
 */
export function responseError(error, trusted = false) {
  const safe = (trusted === true || OWNED.has(error)) &&
    error && typeof error.code === "string" && typeof error.message === "string"

  const code = safe ? error.code : "internal"
  const message = safe ? error.message : GENERIC_MESSAGE
  const status = safe && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : (STATUS[code] ?? 500)

  const headers = new Headers({ "content-type": "application/json" })
  if (safe && /^\d{1,10}$/.test(String(error.retryAfter ?? ""))) {
    headers.set("retry-after", String(error.retryAfter))
  }

  // X-Magpie-Sign-In: "expired" only for a locally verified oauth-refused; every
  // other response keeps the session ("kept") so the host never lapses it falsely.
  headers.set("x-magpie-sign-in", code === "oauth-refused" ? "expired" : "kept")

  return new Response(JSON.stringify({ error: { code, message } }), { status, headers })
}
