// Native Anthropic Messages transport for SAP AI Core Bedrock deployments.
//
// Sibling to the GPT Responses transport: it adapts the native Anthropic
// Messages routing envelope (strip the routing model, supply anthropic_version,
// choose the invoke route) without touching conversation semantics, and relays
// SAP's data-only Anthropic SSE. All credential-safe HTTP, redaction, bounded
// framing and error rendering are shared through ./transport.js.

import {
  AI_HOST, SAFE_TEXT, MAX_BODY_BYTES, isObject,
  safeError, invalid, abortReason, drain, secretsOf,
  redactError, bearerRejected, safeHeaders, streamHeaders,
  sseRelay as relay, messageFor, owns,
} from "./transport.js"

export { responseError } from "./transport.js"

const DEPLOYMENT_PATH = /^\/v2\/inference\/deployments\/[A-Za-z0-9_-]+$/
const ANTHROPIC_VERSION = "bedrock-2023-05-31"

// --- strict native request validation -------------------------------------

// Fields the plugin authoritatively rejects as out of scope (hosted, stateful,
// or non-Messages) with a specific message. Every other top-level field must be
// in ALLOWED: an unrecognized field is rejected rather than forwarded, so an
// unsupported parameter fails explicitly instead of silently reaching upstream.
const REJECTED = {
  metadata: "The \"metadata\" parameter is not supported.",
  service_tier: "The \"service_tier\" parameter is not supported.",
  container: "The \"container\" parameter is not supported.",
  mcp_servers: "Hosted MCP servers are not supported.",
  input: "Use the native Anthropic \"messages\" parameter.",
  prompt: "Use the native Anthropic \"messages\" parameter.",
  messages_history: "Use the native Anthropic \"messages\" parameter.",
}
// The recognized top-level native Messages fields. `output_config` (reasoning
// effort) and `thinking` display/block_binding controls are explicitly
// recognized; `model`/`stream` are the routing envelope consumed by dispatch.
const ALLOWED = new Set([
  "model", "messages", "system", "max_tokens", "stop_sequences",
  "temperature", "top_p", "top_k", "tools", "tool_choice", "thinking",
  "output_config", "anthropic_version", "stream",
])
const ROLES = new Set(["user", "assistant"])
const TOOL_CHOICE_TYPES = new Set(["auto", "any", "tool", "none"])
const STREAM_EVENTS = new Set([
  "message_start", "content_block_start", "content_block_delta",
  "content_block_stop", "message_delta", "message_stop", "ping", "error",
])

// Client-only per-tool hints (pi): eager tool-input streaming and deferred tool
// loading. Bedrock rejects them, so they are validated as booleans here and
// stripped during envelope adaptation; they are the only unenumerated tool
// fields tolerated — every other unknown tool field is rejected.
const CLIENT_TOOL_HINTS = new Set(["eager_input_streaming", "defer_loading"])

function validateCacheControl(cc) {
  if (cc === undefined) return
  if (!isObject(cc) || cc.type !== "ephemeral") throw invalid("Unsupported \"cache_control\"; only {\"type\":\"ephemeral\"} is accepted.")
  for (const key of Object.keys(cc)) if (key !== "type" && key !== "ttl") throw invalid("Unsupported field in \"cache_control\".")
  if ("ttl" in cc && typeof cc.ttl !== "string") throw invalid("A \"cache_control\" \"ttl\" must be a string.")
}

const TEXT_KEYS = new Set(["type", "text", "cache_control"])

function validateTextBlock(block) {
  if (!isObject(block) || block.type !== "text" || typeof block.text !== "string") throw invalid("A text block requires a string \"text\".")
  for (const key of Object.keys(block)) if (!TEXT_KEYS.has(key)) throw invalid("Unsupported field in a text block.")
  validateCacheControl(block.cache_control)
}

function allowedKeys(obj, keys, where) {
  for (const key of Object.keys(obj)) if (!keys.has(key)) throw invalid("Unsupported field in " + where + ".")
}

const TOOL_USE_KEYS = new Set(["type", "id", "name", "input", "cache_control"])
const TOOL_RESULT_KEYS = new Set(["type", "tool_use_id", "content", "is_error", "cache_control"])
const THINKING_KEYS = new Set(["type", "thinking", "signature"])
const REDACTED_KEYS = new Set(["type", "data"])

const IMAGE_KEYS = new Set(["type", "source", "cache_control"])
const IMAGE_SOURCE_KEYS = new Set(["type", "media_type", "data"])

// Supported content blocks: text, agent tool_use/tool_result, genuine
// signed/opaque thinking history, and — when the selected model advertises image
// input — base64 image blocks. Non-base64 sources, documents and other
// multimodal blocks are out of scope and rejected rather than silently dropped.
function validateContentBlock(block, allowImage) {
  if (!isObject(block) || typeof block.type !== "string") throw invalid("Each content block must have a string \"type\".")
  switch (block.type) {
    case "text":
      validateTextBlock(block)
      return
    case "tool_use":
      allowedKeys(block, TOOL_USE_KEYS, "a tool_use block")
      if (typeof block.id !== "string" || !block.id) throw invalid("A tool_use block requires a string \"id\".")
      if (typeof block.name !== "string" || !block.name) throw invalid("A tool_use block requires a string \"name\".")
      if (!isObject(block.input)) throw invalid("A tool_use block requires an \"input\" object.")
      validateCacheControl(block.cache_control)
      return
    case "tool_result": {
      allowedKeys(block, TOOL_RESULT_KEYS, "a tool_result block")
      if (typeof block.tool_use_id !== "string" || !block.tool_use_id) throw invalid("A tool_result block requires a string \"tool_use_id\".")
      if ("is_error" in block && typeof block.is_error !== "boolean") throw invalid("A tool_result \"is_error\" must be a boolean.")
      const content = block.content
      if (typeof content !== "string") {
        if (!Array.isArray(content)) throw invalid("A tool_result \"content\" must be a string or an array of text blocks.")
        for (const part of content) validateTextBlock(part)
      }
      validateCacheControl(block.cache_control)
      return
    }
    case "thinking":
      allowedKeys(block, THINKING_KEYS, "a thinking block")
      // Empty thinking text is still a genuine signed history block.
      if (typeof block.thinking !== "string") throw invalid("A thinking block requires a string \"thinking\".")
      if (typeof block.signature !== "string" || !block.signature) throw invalid("A thinking block requires a non-empty \"signature\".")
      return
    case "redacted_thinking":
      allowedKeys(block, REDACTED_KEYS, "a redacted_thinking block")
      if (typeof block.data !== "string" || !block.data) throw invalid("A redacted_thinking block requires a string \"data\".")
      return
    case "image": {
      if (!allowImage) throw invalid("Image blocks are not supported for this model.")
      allowedKeys(block, IMAGE_KEYS, "an image block")
      const source = block.source
      if (!isObject(source) || source.type !== "base64") throw invalid("An image block requires a \"source\" with type \"base64\".")
      allowedKeys(source, IMAGE_SOURCE_KEYS, "an image source")
      if (typeof source.media_type !== "string" || !source.media_type) throw invalid("An image source requires a string \"media_type\".")
      if (typeof source.data !== "string" || !source.data) throw invalid("An image source requires string \"data\".")
      validateCacheControl(block.cache_control)
      return
    }
    default:
      throw invalid("Unsupported content block type.")
  }
}

function validateMessages(messages, allowImage) {
  if (!Array.isArray(messages) || messages.length === 0) throw invalid("The \"messages\" parameter must be a non-empty array.")
  for (const message of messages) {
    if (!isObject(message) || typeof message.role !== "string" || !ROLES.has(message.role)) throw invalid("Each message requires role \"user\" or \"assistant\".")
    for (const key of Object.keys(message)) if (key !== "role" && key !== "content") throw invalid("Unsupported field in a message.")
    const content = message.content
    if (typeof content === "string") continue
    if (!Array.isArray(content)) throw invalid("Message \"content\" must be a string or an array of content blocks.")
    for (const block of content) validateContentBlock(block, allowImage)
  }
}

function validateSystem(system) {
  if (typeof system === "string") return
  if (!Array.isArray(system)) throw invalid("The \"system\" parameter must be a string or an array of text blocks.")
  for (const block of system) validateTextBlock(block)
}

const TOOL_KEYS = new Set([
  "type", "name", "description", "input_schema", "strict", "cache_control",
  ...CLIENT_TOOL_HINTS,
])

function validateTool(tool) {
  if (!isObject(tool)) throw invalid("Each tool must be an object.")
  // Every tool field must be enumerated; the only tolerated unenumerated fields
  // are the boolean pi hints (eager_input_streaming, defer_loading), which are
  // validated here and stripped at dispatch. Any other field is rejected.
  allowedKeys(tool, TOOL_KEYS, "a tool")
  for (const hint of CLIENT_TOOL_HINTS) {
    if (hint in tool && typeof tool[hint] !== "boolean") throw invalid(`A tool "${hint}" hint must be a boolean.`)
  }
  if ("type" in tool && tool.type !== "custom") throw invalid("Only custom function tools are supported.")
  if (typeof tool.name !== "string" || !tool.name) throw invalid("A tool requires a non-empty string \"name\".")
  if ("description" in tool && typeof tool.description !== "string") throw invalid("A tool \"description\" must be a string.")
  if (!isObject(tool.input_schema)) throw invalid("A tool requires an \"input_schema\" object.")
  if ("strict" in tool && typeof tool.strict !== "boolean") throw invalid("A tool \"strict\" must be a boolean.")
  validateCacheControl(tool.cache_control)
}

const TOOL_CHOICE_KEYS = new Set(["type", "name", "disable_parallel_tool_use"])

function validateToolChoice(tc, tools) {
  if (!isObject(tc) || typeof tc.type !== "string" || !TOOL_CHOICE_TYPES.has(tc.type)) throw invalid("The \"tool_choice\" must be an object with type \"auto\", \"any\", \"tool\" or \"none\".")
  allowedKeys(tc, TOOL_CHOICE_KEYS, "\"tool_choice\"")
  if ("disable_parallel_tool_use" in tc && typeof tc.disable_parallel_tool_use !== "boolean") throw invalid("A \"tool_choice\" \"disable_parallel_tool_use\" must be a boolean.")
  if (tc.type === "tool") {
    if (typeof tc.name !== "string" || !tc.name) throw invalid("A forced tool choice requires a \"name\".")
    if (!Array.isArray(tools) || !tools.some(tool => tool.name === tc.name)) throw invalid("The selected tool must match a declared tool.")
  } else if ("name" in tc) {
    throw invalid("Only a \"tool\" tool_choice may name a tool.")
  }
  if ((tc.type === "any" || tc.type === "tool") && (!Array.isArray(tools) || !tools.length)) throw invalid("A forced tool choice requires declared tools.")
}

const THINKING_TYPES = new Set(["enabled", "disabled", "adaptive"])
const THINKING_PARAM_KEYS = new Set(["type", "budget_tokens", "display", "block_binding"])
const BLOCK_BINDING_KEYS = new Set(["prefix_mismatch_behavior"])
const OUTPUT_CONFIG_KEYS = new Set(["effort"])

function validateThinking(thinking) {
  if (!isObject(thinking)) throw invalid("The \"thinking\" parameter must be an object.")
  // Recognized native thinking modes only; an unrecognized type is rejected
  // rather than advertised as supported. display/block_binding are recognized
  // structural controls; model-specific acceptance stays with dispatch policy.
  allowedKeys(thinking, THINKING_PARAM_KEYS, "\"thinking\"")
  if (typeof thinking.type !== "string" || !THINKING_TYPES.has(thinking.type)) throw invalid("A \"thinking\" \"type\" must be \"enabled\", \"disabled\" or \"adaptive\".")
  const budget = thinking.budget_tokens
  const hasBudget = "budget_tokens" in thinking
  if (thinking.type === "enabled") {
    // Enabled thinking requires a positive integer token budget.
    if (!hasBudget || typeof budget !== "number" || !Number.isInteger(budget) || budget <= 0) throw invalid("Enabled \"thinking\" requires a positive integer \"budget_tokens\".")
  } else if (hasBudget) {
    // adaptive/disabled thinking takes no token budget.
    throw invalid("A \"budget_tokens\" applies only to enabled \"thinking\".")
  }
  if ("display" in thinking && typeof thinking.display !== "string") throw invalid("A \"thinking\" \"display\" must be a string.")
  if ("block_binding" in thinking) {
    const binding = thinking.block_binding
    if (!isObject(binding)) throw invalid("A \"thinking\" \"block_binding\" must be an object.")
    // The known client control is a free-form string; its value stays with upstream.
    allowedKeys(binding, BLOCK_BINDING_KEYS, "\"block_binding\"")
    if ("prefix_mismatch_behavior" in binding && typeof binding.prefix_mismatch_behavior !== "string") throw invalid("A \"block_binding\" \"prefix_mismatch_behavior\" must be a string.")
  }
}

function validateOutputConfig(oc) {
  if (!isObject(oc)) throw invalid("The \"output_config\" parameter must be an object.")
  // Reasoning effort is the only recognized control; its value stays with upstream.
  allowedKeys(oc, OUTPUT_CONFIG_KEYS, "\"output_config\"")
  if ("effort" in oc && (typeof oc.effort !== "string" || !oc.effort)) throw invalid("An \"output_config\" \"effort\" must be a non-empty string.")
}

/**
 * Validate a parsed native Anthropic Messages body. Structure and the recognized
 * field allowlist are enforced; model/version-specific restrictions (sampling,
 * thinking, output ceiling) stay with dispatch policy and the upstream. The
 * routing `model` and the `stream` selector are retained here and handled by
 * dispatch. Returns the validated body verbatim.
 * @param {unknown} body
 */
export function validateRequest(body, entry) {
  const allowImage = entry?.capabilities?.image === true
  if (!isObject(body)) throw invalid("The request body must be a JSON object.")
  const b = /** @type {Record<string, unknown>} */ (body)
  for (const key of Object.keys(b)) {
    if (Object.hasOwn(REJECTED, key)) throw invalid(REJECTED[key])
    if (!ALLOWED.has(key)) throw invalid("The request includes an unsupported parameter.")
  }

  const model = b.model
  if (typeof model !== "string" || model.length < 1 || /[\x00-\x1f\x7f]/.test(model)) throw invalid("The \"model\" parameter must be a non-empty string.")

  validateMessages(b.messages, allowImage)
  if ("system" in b) validateSystem(b.system)

  if (!("max_tokens" in b)) throw invalid("The \"max_tokens\" parameter is required.")
  // Zero was accepted by both baselines; negative and non-integer are rejected.
  if (typeof b.max_tokens !== "number" || !Number.isInteger(b.max_tokens) || b.max_tokens < 0) throw invalid("The \"max_tokens\" parameter must be a non-negative integer.")

  if ("stop_sequences" in b) {
    if (!Array.isArray(b.stop_sequences) || !b.stop_sequences.every(s => typeof s === "string")) throw invalid("The \"stop_sequences\" parameter must be an array of strings.")
  }
  for (const key of ["temperature", "top_p"]) {
    if (key in b && (typeof b[key] !== "number" || !Number.isFinite(b[key]))) throw invalid(`The "${key}" parameter must be a number.`)
  }
  const topK = b.top_k
  if ("top_k" in b && (typeof topK !== "number" || !Number.isInteger(topK) || topK < 0)) throw invalid("The \"top_k\" parameter must be a non-negative integer.")

  if ("tools" in b) {
    if (!Array.isArray(b.tools)) throw invalid("The \"tools\" parameter must be an array of tools.")
    for (const tool of b.tools) validateTool(tool)
  }
  if ("tool_choice" in b) validateToolChoice(b.tool_choice, b.tools)
  if ("thinking" in b) validateThinking(b.thinking)
  if ("output_config" in b) validateOutputConfig(b.output_config)

  // Client version header is input metadata; a conflicting body version is
  // rejected rather than forwarded. Dispatch always supplies the Bedrock value.
  if ("anthropic_version" in b && b.anthropic_version !== ANTHROPIC_VERSION) throw invalid(`The "anthropic_version" must be "${ANTHROPIC_VERSION}".`)
  if ("stream" in b && typeof b.stream !== "boolean") throw invalid("The \"stream\" parameter must be a boolean.")

  return b
}

// --- dispatch --------------------------------------------------------------

/**
 * The exact Bedrock invoke route for the eligible deployment. The whole-reply
 * route is /invoke; streaming is /invoke-with-response-stream. No API-version
 * query is ever appended.
 * @param {*} entry
 * @param {string | undefined} aiRoot
 * @param {boolean} streaming
 */
function targetURL(entry, aiRoot, streaming) {
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
  return raw + (streaming ? "/invoke-with-response-stream" : "/invoke")
}

// Adapt the routing envelope only: drop the canonical routing model and the
// stream selector, strip the validated non-native client tool hints
// (eager_input_streaming, defer_loading), supply the Bedrock anthropic_version.
// Conversation semantics are preserved verbatim.

function stripToolHints(tools) {
  if (!Array.isArray(tools)) return tools
  let changed = false
  const out = tools.map(tool => {
    if (!isObject(tool) || !Object.keys(tool).some(k => CLIENT_TOOL_HINTS.has(k))) return tool
    changed = true
    const clean = {}
    for (const k of Object.keys(tool)) if (!CLIENT_TOOL_HINTS.has(k)) clean[k] = tool[k]
    return clean
  })
  return changed ? out : tools
}

function bedrockBody(body) {
  const out = {}
  for (const key of Object.keys(body)) {
    if (key === "model" || key === "stream") continue
    out[key] = body[key]
  }
  if ("tools" in out) out.tools = stripToolHints(out.tools)
  out.anthropic_version = ANTHROPIC_VERSION
  return out
}

const isNonNegInt = n => typeof n === "number" && Number.isInteger(n) && n >= 0

// A native Anthropic message envelope: an assistant message with a non-empty id,
// a content array, and a usage object carrying non-negative integer input/output
// token counts. `opener` selects the streaming message_start form (initial
// stop_reason strictly null) versus a completed whole reply (a non-empty stop
// reason string, so a future native reason is preserved, not restricted).
function isMessageEnvelope(m, opener) {
  if (!isObject(m) || m.type !== "message") return false
  if (typeof m.id !== "string" || !m.id) return false
  if (m.role !== "assistant") return false
  if (!Array.isArray(m.content)) return false
  if (opener ? m.stop_reason !== null : (typeof m.stop_reason !== "string" || !m.stop_reason)) return false
  const usage = m.usage
  return isObject(usage) && isNonNegInt(usage.input_tokens) && isNonNegInt(usage.output_tokens)
}

function isMessageShape(native) {
  return isMessageEnvelope(native, false)
}

// Native Anthropic success output is immutable; a failure's descriptive fields
// are redacted while native category fields (ERROR_PROTOCOL_FIELDS) are kept, so
// a secret echoed in any sibling field — not just under `error` — is scrubbed.
function redactFailure(native, secrets) {
  if (isMessageShape(native)) return native
  const redacted = redactError(native, secrets)
  if (isObject(native) && "error" in native) redacted.error = redactError(native.error, secrets)
  return redacted
}

function redactStreamError(event, secrets) {
  return redactFailure(event, secrets)
}

function errorEvent(code) {
  return `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: messageFor(code) } })}\n\n`
}

// Validate the native event stream's shape and ordering without accumulating
// content. A valid stream opens with one message_start whose message carries an
// initial null stop_reason, surfaces a message_delta carrying a non-null
// stop_reason before the terminal message_stop, and never repeats or reorders
// those markers. An error frame may terminate the stream at any point.
function sseRelay(upstream, signal, secrets) {
  let started = false
  let stopReasonSeen = false
  const malformed = () => safeError("inference-response")
  const classify = (event, name) => {
    if (!isObject(event) || typeof event.type !== "string" || (name && name !== event.type)) throw malformed()
    if (!STREAM_EVENTS.has(event.type)) throw malformed()
    switch (event.type) {
      case "ping":
        break
      case "message_start":
        // Exactly one opener, a valid assistant envelope with a null stop reason.
        if (started || !isMessageEnvelope(event.message, true)) throw malformed()
        started = true
        break
      case "message_delta": {
        if (!started) throw malformed()
        const delta = event.delta
        if (!isObject(delta)) throw malformed()
        // A delta either omits stop_reason (null included) or resolves it exactly
        // once with a non-empty string; a malformed or duplicate reason is invalid.
        if ("stop_reason" in delta && delta.stop_reason !== null) {
          if (typeof delta.stop_reason !== "string" || !delta.stop_reason || stopReasonSeen) throw malformed()
          stopReasonSeen = true
        }
        break
      }
      case "content_block_start":
      case "content_block_delta":
      case "content_block_stop":
        if (!started) throw malformed()
        break
      case "message_stop":
        // A terminal is valid only after the opener and a resolved stop reason.
        if (!started || !stopReasonSeen) throw malformed()
        break
    }
    const terminal = event.type === "message_stop" || event.type === "error"
    const redacted = event.type === "error" ? redactStreamError(event, secrets) : event
    // SAP relays data-only frames; emit the native `event:` name so clients that
    // dispatch on it (e.g. pi) see message_delta/message_stop and the stop reason.
    return { terminal, redacted, name: event.type }
  }
  return relay(upstream, signal, { classify, errorEvent })
}

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

// Apply the selected deployment's established request restrictions before any
// inference credential is sent. The frozen `entry.requestPolicy` is present only
// for the verified baseline versions; a newer deployment carries none, so its
// request passes through to upstream validation unchanged ("no newer inference"
// restriction is invented here).
function applyPolicy(entry, body, streaming) {
  // Streaming is relayed only when the matched version reports it supported.
  if (streaming && entry?.capabilities?.streaming !== true) throw invalid("Streaming is not supported for this model.")
  const policy = entry?.requestPolicy
  if (!isObject(policy)) return
  if (typeof policy.maxOutputTokens === "number" && typeof body.max_tokens === "number" && body.max_tokens > policy.maxOutputTokens) {
    throw invalid(`The "max_tokens" parameter must not exceed ${policy.maxOutputTokens} for this model.`)
  }
  const hasTemperature = "temperature" in body
  const hasTopP = "top_p" in body
  if (policy.rejectTemperature && hasTemperature) throw invalid("This model does not support the \"temperature\" parameter.")
  if (policy.rejectTopP && hasTopP) throw invalid("This model does not support the \"top_p\" parameter.")
  if (policy.rejectCombinedSampling && hasTemperature && hasTopP) throw invalid("This model does not support \"temperature\" and \"top_p\" together.")
  const thinkingEnabled = isObject(body.thinking) && body.thinking.type === "enabled"
  if (policy.rejectEnabledThinking && thinkingEnabled) throw invalid("This model does not support enabled thinking with a fixed budget.")
  const tc = body.tool_choice
  const forcedTool = isObject(tc) && (tc.type === "any" || tc.type === "tool")
  if (policy.rejectForcedToolThinking && thinkingEnabled && forcedTool) throw invalid("This model does not support forced tool use with enabled thinking.")
}

/**
 * Perform exactly one account-authenticated Bedrock invoke and return native
 * Anthropic JSON or incremental SSE. Never retries; never forwards incoming
 * headers.
 * @param {{ entry: *, body: Record<string, unknown>, credentials: *, token: *, signal?: AbortSignal, extraSecrets?: string[], rejectedToken?: () => void }} args
 * @returns {Promise<Response>}
 */
export async function dispatch({ entry, body, credentials, token, signal, extraSecrets, rejectedToken: onRejectedToken } = /** @type {*} */ ({})) {
  if (signal?.aborted) throw abortReason(signal)

  const streaming = body.stream === true
  applyPolicy(entry, body, streaming)
  const url = targetURL(entry, credentials?.aiRoot, streaming)

  const bearer = token?.value
  if (typeof bearer !== "string" || !SAFE_TEXT.test(bearer)) throw safeError("internal", { status: 500 })
  const resourceGroup = credentials?.resourceGroup
  if (typeof resourceGroup !== "string" || !SAFE_TEXT.test(resourceGroup)) throw safeError("internal", { status: 500 })

  const headers = {
    "content-type": "application/json",
    accept: streaming ? "text/event-stream" : "application/json",
    authorization: "Bearer " + bearer,
    "AI-Resource-Group": resourceGroup,
  }
  const payload = JSON.stringify(bedrockBody(body))

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

  const rejectedToken = response.status === 401 && bearerRejected(response.headers.get("www-authenticate"))
  if (rejectedToken && typeof onRejectedToken === "function") onRejectedToken()

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
      const fallback = JSON.stringify({ type: "error", error: { type: "api_error", message: messageFor("inference-response") } })
      return new Response(fallback, { status: response.status, headers: safeHeaders(response) })
    }
    throw error
  }

  if (response.ok && !isMessageShape(native)) throw safeError("inference-response")

  const failed = !response.ok || (isObject(native) && native.type === "error")
  const serialized = failed
    ? JSON.stringify(redactFailure(native, secretsOf(credentials, token, extraSecrets)))
    : JSON.stringify(native)

  return new Response(serialized, { status: response.status, headers: safeHeaders(response) })
}
