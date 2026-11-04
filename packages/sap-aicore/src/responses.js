import {
  AI_HOST, SAFE_TEXT, MAX_BODY_BYTES, isObject,
  safeError, invalid, abortReason, drain, secretsOf,
  redactError, redactErrorDetails, ERROR_PROTOCOL_FIELDS,
  bearerRejected, safeHeaders, streamHeaders, sseRelay as relay, messageFor, owns,
} from "./transport.js"

export { responseError } from "./transport.js"

const DEPLOYMENT_PATH = /^\/v2\/inference\/deployments\/[A-Za-z0-9_-]+$/

const ALLOWED = new Set([
  "model", "input", "instructions", "max_output_tokens", "prompt_cache_key",
  "reasoning", "include", "tools", "tool_choice",
  "store", "stream", "background",
])

// --- strict stateless parameter validation --------------------------------

const MESSAGE_PART = new Set(["input_text", "output_text"])

/**
 * Validate message content: a string or an array of parts. Text parts are
 * always accepted; `input_image` parts are accepted only when the selected
 * model advertises image input. Other multimodal parts are rejected.
 * @param {unknown} content
 * @param {boolean} allowImage
 */
function validateMessageContent(content, allowImage) {
  if (typeof content === "string") return
  if (!Array.isArray(content)) throw invalid("Message content must be a string or an array of text parts.")
  for (const part of content) {
    if (!isObject(part) || typeof part.type !== "string") throw invalid("Only text message content is supported.")
    if (part.type === "input_image") {
      if (!allowImage) throw invalid("Image content is not supported for this model.")
      validateInputImage(part)
      continue
    }
    if (!MESSAGE_PART.has(part.type) || typeof part.text !== "string") throw invalid("Only text message content is supported.")
  }
}

const IMAGE_DETAIL = new Set(["auto", "low", "high"])
const INPUT_IMAGE_KEYS = new Set(["type", "image_url", "detail"])

/**
 * Validate an `input_image` part: a data or https `image_url` string with an
 * optional `detail`. Stateful file references and unknown fields are rejected.
 * @param {Record<string, unknown>} part
 */
function validateInputImage(part) {
  for (const key of Object.keys(part)) if (!INPUT_IMAGE_KEYS.has(key)) throw invalid("Unsupported field in an input_image part.")
  if (typeof part.image_url !== "string" || !/^(?:data:|https:\/\/)/i.test(part.image_url)) throw invalid("An input_image requires an \"image_url\" data or https URL string.")
  if ("detail" in part && (typeof part.detail !== "string" || !IMAGE_DETAIL.has(part.detail))) throw invalid("An input_image \"detail\" must be \"auto\", \"low\" or \"high\".")
}

/**
 * Validate one input item: supported stateless message / function_call /
 * function_call_output / reasoning history only. Stateful references and
 * unverified item types are rejected.
 * @param {unknown} item
 * @param {boolean} allowImage
 */
function validateInputItem(item, allowImage) {
  if (!isObject(item)) throw invalid("Each input item must be an object.")
  const type = item.type
  if (type === undefined || type === "message") {
    if (!["user", "assistant", "system", "developer"].includes(String(item.role))) throw invalid("A message requires a supported role.")
    validateMessageContent(item.content, allowImage)
    return
  }
  if (type === "function_call") {
    if (typeof item.call_id !== "string" || !item.call_id || typeof item.name !== "string" || !item.name || typeof item.arguments !== "string") throw invalid("A function call requires call_id, name and string arguments.")
    return
  }
  if (type === "function_call_output") {
    if (typeof item.call_id !== "string" || !item.call_id || typeof item.output !== "string") throw invalid("A function result requires call_id and string output.")
    return
  }
  if (type === "reasoning") {
    if (!Array.isArray(item.summary) || !item.summary.every(part => isObject(part) && part.type === "summary_text" && typeof part.text === "string") ||
        (item.encrypted_content !== undefined && typeof item.encrypted_content !== "string")) throw invalid("A reasoning item requires a native summary and optional encrypted content.")
    return
  }
  throw invalid("Unsupported input item type.")
}

const TOOL_KEYS = new Set(["type", "name", "description", "parameters", "strict"])

/**
 * Validate a function tool definition. Hosted tools and unverified fields are
 * rejected; parameter schema contents are left to upstream validation.
 * @param {unknown} tool
 */
function validateTool(tool) {
  if (!isObject(tool) || tool.type !== "function") throw invalid("Only function tools are supported in the \"tools\" parameter.")
  for (const key of Object.keys(tool)) if (!TOOL_KEYS.has(key)) throw invalid("Unsupported field in a function tool definition.")
  if (typeof tool.name !== "string" || !tool.name) throw invalid("A function tool requires a non-empty string \"name\".")
  if ("description" in tool && typeof tool.description !== "string") throw invalid("A function tool \"description\" must be a string.")
  if ("parameters" in tool && !isObject(tool.parameters)) throw invalid("A function tool \"parameters\" must be an object.")
  if ("strict" in tool && typeof tool.strict !== "boolean") throw invalid("A function tool \"strict\" must be a boolean.")
}

/**
 * @param {unknown} body
 * @param {*} [entry] selected deployment entry; its capabilities gate image input.
 * @returns {{ model: string, store: false, stream?: boolean } & Record<string, unknown>}
 */
export function validateRequest(body, entry) {
  const allowImage = entry?.capabilities?.image === true
  if (!isObject(body)) throw invalid("The request body must be a JSON object.")
  const b = /** @type {Record<string, unknown>} */ (body)

  // Stateful / unsupported keys get specific, non-echoing messages.
  if ("previous_response_id" in b) throw invalid("The \"previous_response_id\" parameter is not supported; responses are stateless.")
  if ("conversation" in b) throw invalid("The \"conversation\" parameter is not supported; responses are stateless.")

  for (const key of Object.keys(b)) {
    if (ALLOWED.has(key)) continue
    if (key === "messages" || key === "prompt" || key === "functions" || key === "function_call") {
      throw invalid("Chat Completions fields are not supported; use the Responses \"input\" parameter.")
    }
    throw invalid("The request includes an unsupported parameter.")
  }

  // model — structural only; identity (verified vs unavailable) is owned by discovery.
  const model = b.model
  if (typeof model !== "string" || model.length < 1 || /[\x00-\x1f\x7f]/.test(model)) {
    throw invalid("The \"model\" parameter must be a non-empty string.")
  }

  // input — a string or an array of supported stateless history items.
  const input = b.input
  let reasoningHistory = false
  if (typeof input !== "string") {
    if (!Array.isArray(input)) throw invalid("The \"input\" parameter must be a string or an array of input items.")
    for (const item of input) {
      validateInputItem(item, allowImage)
      if (item.type === "reasoning") reasoningHistory = true
    }
  }

  if ("instructions" in b && typeof b.instructions !== "string") {
    throw invalid("The \"instructions\" parameter must be a string.")
  }

  if ("max_output_tokens" in b) {
    const n = b.max_output_tokens
    // Positive integer only. No invented minimum — upstream validates values (1 failed live).
    if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
      throw invalid("The \"max_output_tokens\" parameter must be a positive integer.")
    }
  }

  if ("prompt_cache_key" in b && typeof b.prompt_cache_key !== "string") {
    throw invalid("The \"prompt_cache_key\" parameter must be a string.")
  }

  if ("reasoning" in b) {
    const r = b.reasoning
    // Live GPT-6 probes verified low/medium/high with optional summary:"auto".
    const bad = () => invalid("The \"reasoning\" parameter requires \"effort\" set to \"low\", \"medium\" or \"high\", with optional \"summary\" set to \"auto\".")
    if (!isObject(r)) throw bad()
    for (const key of Object.keys(r)) if (key !== "effort" && key !== "summary") throw bad()
    if ((r.effort !== "low" && r.effort !== "medium" && r.effort !== "high") || ("summary" in r && r.summary !== "auto")) throw bad()
  }

  if ("include" in b) {
    const inc = b.include
    // Only the verified encrypted-reasoning include is supported.
    if (!Array.isArray(inc) || !inc.every(v => v === "reasoning.encrypted_content")) {
      throw invalid("The \"include\" parameter may only contain \"reasoning.encrypted_content\".")
    }
  }

  if ("tools" in b) {
    const tools = b.tools
    if (!Array.isArray(tools)) throw invalid("The \"tools\" parameter must be an array of function tools.")
    for (const tool of tools) validateTool(tool)
  }

  if ("tool_choice" in b) {
    const tc = b.tool_choice
    const ok = tc === "auto" || tc === "none" || tc === "required" || (isObject(tc) && tc.type === "function")
    if (!ok) throw invalid("The \"tool_choice\" parameter must be \"auto\", \"none\", \"required\" or a function tool choice.")
    if (tc === "required" || isObject(tc)) {
      if (!Array.isArray(b.tools) || !b.tools.length) throw invalid("A forced function choice requires declared tools.")
      if (isObject(tc) && (Object.keys(tc).some(key => key !== "type" && key !== "name") || typeof tc.name !== "string" || !b.tools.some(tool => tool.name === tc.name))) throw invalid("The selected function must match a declared tool.")
    }
  }

  // Installed magpie may force stream true/false before the plugin sees the
  // request. The native boolean is preserved verbatim (true → incremental SSE,
  // false/omitted → whole JSON); only its type is checked.
  if ("stream" in b && typeof b.stream !== "boolean") {
    throw invalid("The \"stream\" parameter must be a boolean.")
  }
  if ("background" in b && b.background !== false) {
    throw invalid("The \"background\" parameter must be false; background responses are not supported.")
  }
  if ("store" in b && b.store !== false) {
    throw invalid("The \"store\" parameter must be false; stateful responses are not supported.")
  }

  // Preserve supported fields; this transport forces stateless responses and
  // relays the native stream flag unchanged.
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const key of ALLOWED) {
    if (key === "store") continue
    if (key in b) out[key] = b[key]
  }
  out.store = false
  // Stateless reasoning continuity: when the caller omits "include", request the
  // opaque encrypted reasoning that keeps function-tool and reasoning history
  // replayable across stateless turns. An explicit include (even []) is kept.
  if (!("include" in b) && (reasoningHistory || "reasoning" in b || (Array.isArray(b.tools) && b.tools.length > 0))) {
    out.include = ["reasoning.encrypted_content"]
  }
  return /** @type {{ model: string, store: false, stream?: boolean } & Record<string, unknown>} */ (out)
}


// --- dispatch --------------------------------------------------------------

/**
 * Validate the eligible deployment and resolve the exact /responses route.
 * @param {*} entry
 * @param {string} [aiRoot]
 * @returns {string}
 */
function targetURL(entry, aiRoot) {
  const raw = entry?.deploymentURL
  const reject = () => safeError("inference-destination", { status: 502 })
  if (typeof raw !== "string" || !/^https:\/\//i.test(raw) ||
      /[\x00-\x20\x7f-\x9f\\\s?#]/.test(raw) || /%(?:2f|5c|2e)/i.test(raw)) throw reject()
  let url
  try { url = new URL(raw) } catch { throw reject() }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) throw reject()
  if (!AI_HOST.test(url.hostname)) throw reject()
  if (typeof aiRoot === "string" && aiRoot && url.origin !== aiRoot) throw reject()
  if (!DEPLOYMENT_PATH.test(url.pathname) || raw !== url.origin + url.pathname) throw reject()
  return raw + "/responses"
}

function redactFailure(native, secrets) {
  if (isObject(native) && native.object === "response") {
    // Native output/history, identity, usage and terminal status are immutable.
    return native.error == null ? native : { ...native, error: redactError(native.error, secrets) }
  }
  if (isObject(native) && "error" in native) {
    const out = Object.create(null)
    for (const key of Object.keys(native)) out[key] = key === "error" ? redactError(native.error, secrets) : ERROR_PROTOCOL_FIELDS.has(key) ? native[key] : redactErrorDetails(native[key], secrets)
    return out
  }
  return redactError(native, secrets)
}

/**
 * Read the whole native JSON reply, bounded and cancellable.
 * @param {Response} response
 * @param {AbortSignal} [signal]
 */
async function readNative(response, signal) {
  if (!response.body) throw safeError("inference-response")
  let bytes
  try {
    bytes = await drain(response.body, signal, MAX_BODY_BYTES, () => safeError("inference-response", { status: 502, message: messageFor("inference-response") }))
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal)
    if (owns(error)) throw error
    throw safeError("inference-response")
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    throw safeError("inference-response")
  }
}

const TERMINAL_STATUS = new Set(["completed", "incomplete", "failed"])

/**
 * A terminal native Responses object — never a scalar, Chat completion,
 * in-progress or otherwise malformed body.
 * @param {*} native
 */
function isResponseShape(native) {
  return isObject(native) && native.object === "response" &&
    typeof native.id === "string" && Array.isArray(native.output) &&
    typeof native.status === "string" && TERMINAL_STATUS.has(native.status)
}

const RESPONSE_TERMINALS = new Map([
  ["response.completed", "completed"],
  ["response.incomplete", "incomplete"],
  ["response.failed", "failed"],
])

/**
 * Serialize a safe, locally-owned SSE error event. The type is always "error";
 * a terminal success is never fabricated.
 * @param {string} code
 */
function errorEvent(code) {
  return `data: ${JSON.stringify({ type: "error", error: { code, message: messageFor(code) } })}\n\n`
}

/**
 * Redact only descriptive error fields. Native output/history and response
 * identity are immutable, even when they overlap a credential string.
 * @param {Record<string, unknown>} event
 * @param {string[]} secrets
 */
function redactEvent(event, secrets) {
  if (isObject(event.response) && event.response.object === "response") {
    const response = redactFailure(event.response, secrets)
    return response === event.response ? event : { ...event, response }
  }
  if (event.type === "error" || event.type === "response.error") {
    if (!("error" in event)) return redactError(event, secrets)
    const { error, ...fields } = event
    return { ...redactError(fields, secrets), error: redactError(error, secrets) }
  }
  return event.error == null ? event : { ...event, error: redactError(event.error, secrets) }
}

/**
 * Relay native Responses SSE: classify each frame's terminal/redaction and hand
 * the bounded framing to the shared relay.
 * @param {ReadableStream<Uint8Array>} upstream
 * @param {AbortSignal | undefined} signal
 * @param {string[]} secrets
 * @returns {ReadableStream<Uint8Array>}
 */
function sseRelay(upstream, signal, secrets) {
  const classify = (event, name) => {
    if (!isObject(event) || typeof event.type !== "string" || (name && name !== event.type)) throw safeError("inference-response")
    const status = RESPONSE_TERMINALS.get(event.type)
    if (status && (!isObject(event.response) || !isResponseShape(event.response) || event.response.status !== status)) throw safeError("inference-response")
    const terminal = Boolean(status) || event.type === "error" || event.type === "response.error"
    return { terminal, redacted: redactEvent(event, secrets) }
  }
  return relay(upstream, signal, { classify, errorEvent })
}

/**
 * Perform exactly one account-authenticated upstream call and return native
 * JSON or incremental SSE. Never retries; never forwards incoming headers.
 * @param {{ entry: *, body: Record<string, unknown>, credentials: *, token: *, signal?: AbortSignal, extraSecrets?: string[], rejectedToken?: () => void }} args
 * @returns {Promise<Response>}
 */
export async function dispatch({ entry, body, credentials, token, signal, extraSecrets, rejectedToken: onRejectedToken } = /** @type {*} */ ({})) {
  if (signal?.aborted) throw abortReason(signal)

  const url = targetURL(entry, credentials?.aiRoot)

  const bearer = token?.value
  if (typeof bearer !== "string" || !SAFE_TEXT.test(bearer)) throw safeError("internal", { status: 500 })
  const resourceGroup = credentials?.resourceGroup
  if (typeof resourceGroup !== "string" || !SAFE_TEXT.test(resourceGroup)) throw safeError("internal", { status: 500 })

  // Outgoing allowlist only — incoming SDK tokens/headers never propagate.
  const streaming = body.stream === true
  const headers = {
    "content-type": "application/json",
    accept: streaming ? "text/event-stream" : "application/json",
    authorization: "Bearer " + bearer,
    "AI-Resource-Group": resourceGroup,
  }
  const payload = JSON.stringify(body)

  // Exactly one fetch, captured at call time.
  const fetchImpl = globalThis.fetch
  let response
  try {
    response = await fetchImpl(url, { method: "POST", redirect: "error", headers, body: payload, signal })
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal)
    throw safeError("inference-network")
  }

  if (signal?.aborted) {
    void response.body?.cancel().catch(() => {})
    throw abortReason(signal)
  }

  if (response.redirected || response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400) ||
      (response.url && response.url !== url)) {
    void response.body?.cancel().catch(() => {})
    throw safeError("inference-redirect")
  }

  // Verified invalid/expired Bearer: drop the token immediately (before any read)
  // so recovery never reuses it. The upstream status/code are preserved.
  const rejectedToken = response.status === 401 && bearerRejected(response.headers.get("www-authenticate"))
  if (rejectedToken && typeof onRejectedToken === "function") onRejectedToken()

  // A successful streaming request yields a native text/event-stream the plugin
  // relays incrementally; anything else from a 2xx reply is a safe failure.
  if (streaming && response.ok) {
    const contentType = response.headers.get("content-type") || ""
    if (!response.body || !/^text\/event-stream(?:\s*;|\s*$)/i.test(contentType)) {
      void response.body?.cancel().catch(() => {})
      throw safeError("inference-response")
    }
    const stream = sseRelay(response.body, signal, secretsOf(credentials, token, extraSecrets))
    return new Response(stream, { status: response.status, headers: streamHeaders() })
  }

  let native
  try {
    native = await readNative(response, signal)
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal)
    if (!response.ok) {
      // Malformed error body: keep the HTTP status and Retry-After, surface a safe
      // fallback code. The request is never replayed.
      const fallback = JSON.stringify({ error: { code: "inference-response", message: messageFor("inference-response") } })
      return new Response(fallback, { status: response.status, headers: safeHeaders(response) })
    }
    throw error
  }

  // A 2xx reply must be a terminal native Responses object.
  if (response.ok && !isResponseShape(native)) throw safeError("inference-response")

  // Preserve native output verbatim; redact secrets only from failed responses.
  const failed = !response.ok || (isObject(native) && (native.error != null || native.status === "failed"))
  const serialized = failed
    ? JSON.stringify(redactFailure(native, secretsOf(credentials, token, extraSecrets)))
    : JSON.stringify(native)

  return new Response(serialized, { status: response.status, headers: safeHeaders(response) })
}
