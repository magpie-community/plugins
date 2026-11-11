import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"

import {
  AI_HOST, SAFE_TEXT, MAX_BODY_BYTES, isObject,
  safeError, invalid, abortReason, drain, secretsOf,
  redactError, redactErrorDetails, ERROR_PROTOCOL_FIELDS,
  bearerRejected, safeHeaders, streamHeaders, sseRelay as relay, messageFor, owns,
} from "./transport.js"

export { responseError } from "./transport.js"

const DEPLOYMENT_PATH = /^\/v2\/inference\/deployments\/[A-Za-z0-9_-]+$/

// Translate only the client tool surface. Keep the reverse map off the wire so
// both direct plugin clients and Magpie receive calls under their declared identity.
const DROPPED_HISTORY = new Set(["custom_tool_call", "custom_tool_call_output"])
/** @typedef {{ namespace: string, name: string }} ToolIdentity */
/** @typedef {{ forward: Map<string, string>, back: Map<string, ToolIdentity>, dropped: Record<string, unknown>[] }} ToolTranslation */
/** @type {WeakMap<object, ToolTranslation>} */
const translations = new WeakMap()
const identityKey = (namespace, name) => JSON.stringify([namespace, name])
const namespaced = item => isObject(item) && typeof item.namespace === "string" && item.namespace && typeof item.name === "string" && item.name

/** @param {Record<string, unknown>} body @returns {ToolTranslation} */
function toolTranslation(body) {
  /** @type {Map<string, ToolIdentity>} */
  const identities = new Map()
  const reserved = new Set()
  const dropped = []
  const add = (namespace, name) => {
    if (typeof namespace === "string" && namespace && typeof name === "string" && name) {
      identities.set(identityKey(namespace, name), { namespace, name })
    }
  }
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    if (!isObject(tool)) { continue }
    if (tool.type === "function") { reserved.add(tool.name); continue }
    if (tool.type === "namespace") {
      if (typeof tool.name !== "string" || !tool.name || !Array.isArray(tool.tools)) throw invalid("A namespace tool must have a non-empty string name and a tools array.")
      for (const nested of tool.tools) {
        if (!isObject(nested)) continue
        if (nested.type === "function") add(tool.name, nested.name)
        else dropped.push({ ...nested, namespace: tool.name })
      }
    } else dropped.push(tool)
  }
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (!isObject(item) || item.type !== "function_call") continue
    if (namespaced(item)) add(item.namespace, item.name)
    else reserved.add(item.name)
  }
  const nativeNames = new Set(reserved)
  const counts = new Map()
  for (const { namespace, name } of identities.values()) {
    const flat = namespace + "__" + name
    counts.set(flat, (counts.get(flat) ?? 0) + 1)
  }
  const forward = new Map()
  const back = new Map()
  // Reserve all ordinary qualified names before allocating fallback aliases.
  for (const { namespace, name } of identities.values()) {
    const flat = namespace + "__" + name
    if (/^[A-Za-z0-9_-]{1,64}$/.test(flat) && counts.get(flat) === 1 && !reserved.has(flat)) reserved.add(flat)
  }
  for (const [key, identity] of identities) {
    const flat = identity.namespace + "__" + identity.name
    const qualified = /^[A-Za-z0-9_-]{1,64}$/.test(flat) && counts.get(flat) === 1 && !nativeNames.has(flat)
    const alias = qualified ? flat : "mp_ns_" + createHash("sha256").update(key).digest("hex").slice(0, 56)
    if ((!qualified && reserved.has(alias)) || back.has(alias)) throw invalid("Namespaced function tools have conflicting translated names.")
    reserved.add(alias)
    forward.set(key, alias)
    back.set(alias, identity)
  }
  return { forward, back, dropped }
}

/** @param {unknown[]} tools @param {ToolTranslation} translation */
function translateTools(tools, translation) {
  const out = []
  const emitted = new Map()
  let changed = false
  for (const tool of tools) {
    if (isObject(tool) && tool.type === "function") { out.push(tool); continue }
    if (isObject(tool) && tool.type === "namespace" && Array.isArray(tool.tools)) {
      for (const nested of tool.tools) {
        if (!isObject(nested) || nested.type !== "function") continue
        const alias = translation.forward.get(identityKey(tool.name, nested.name))
        if (!alias) throw invalid("A namespaced function tool must have a non-empty string name.")
        const translated = { ...nested, name: alias }
        if (emitted.has(alias)) {
          if (!isDeepStrictEqual(emitted.get(alias), translated)) throw invalid("Repeated namespaced function tools must have identical definitions.")
          continue
        }
        emitted.set(alias, translated)
        out.push(translated)
      }
    }
    changed = true
  }
  return { tools: out, changed }
}

/** @param {Record<string, unknown>} reference @param {ToolTranslation} translation */
function translateReference(reference, translation) {
  if (reference.type === "function" && namespaced(reference)) {
    const alias = translation.forward.get(identityKey(reference.namespace, reference.name))
    if (alias) {
      const { namespace: _, ...rest } = reference
      return { ...rest, name: alias }
    }
  }
  return reference
}

/** Only declared, dropped targets justify relaxing a caller's choice. */
function droppedReference(reference, translation) {
  if (!isObject(reference) || typeof reference.type !== "string") return false
  return translation.dropped.some(tool => tool.type === reference.type &&
    (tool.name === undefined || tool.name === reference.name) &&
    ((tool.namespace ?? "") === (reference.namespace ?? "")) &&
    (tool.server_label === undefined || tool.server_label === reference.server_label))
}

/** @param {unknown} choice @param {ToolTranslation} translation @param {boolean} hasTools */
function translateChoice(choice, translation, hasTools) {
  if (!isObject(choice)) return choice
  if (choice.type === "allowed_tools" && Array.isArray(choice.tools)) {
    const tools = choice.tools.filter(tool => !droppedReference(tool, translation))
      .map(tool => isObject(tool) ? translateReference(tool, translation) : tool)
    const changed = tools.length !== choice.tools.length || tools.some((tool, i) => tool !== choice.tools[i])
    if (!changed) return choice
    if (!tools.length) return hasTools ? "auto" : undefined
    return { ...choice, tools }
  }
  if (droppedReference(choice, translation)) return hasTools ? "auto" : undefined
  return translateReference(choice, translation)
}

/** @param {*} item @param {ToolTranslation | undefined} translation @param {Map<string, ToolIdentity>} [calls] */
function restoreCall(item, translation, calls = undefined) {
  if (!isObject(item) || item.type !== "function_call" || !translation) return item
  const identity = translation.back.get(/** @type {string} */ (item.name))
  if (!identity || item.namespace) return item
  if (typeof item.id === "string") calls?.set(item.id, identity)
  return { ...item, ...identity, ...(!("encrypted_function_args" in item) ? { encrypted_function_args: [] } : {}) }
}

/** Restore only protocol call positions, never arguments or arbitrary metadata.
 * @param {*} response @param {ToolTranslation | undefined} translation @param {Map<string, ToolIdentity>} [calls]
 */
function restoreResponse(response, translation, calls = undefined) {
  if (!isObject(response) || response.object !== "response" || !Array.isArray(response.output) || !translation?.back.size) return response
  return { ...response, output: response.output.map(item => restoreCall(item, translation, calls)) }
}

function restoreEvent(event, translation, calls) {
  if (!translation?.back.size) return event
  const identity = event.type === "response.function_call_arguments.done" ? calls.get(event.item_id) : undefined
  const matches = identity && translation.back.get(event.name) === identity
  return { ...event,
    ...(matches ? identity : {}),
    ...("item" in event ? { item: restoreCall(event.item, translation, calls) } : {}),
    ...("response" in event ? { response: restoreResponse(event.response, translation, calls) } : {}),
  }
}

/**
 * Enforce routing, framing and stateless transport requirements only. AI Core
 * validates generation controls, tool definitions and native history shapes.
 * @param {unknown} body
 * @returns {{ model: string, store: false, stream?: boolean } & Record<string, unknown>}
 */
export function validateRequest(body) {
  if (!isObject(body)) throw invalid("The request body must be a JSON object.")
  const b = /** @type {Record<string, unknown>} */ (body)

  if ("previous_response_id" in b) throw invalid("The \"previous_response_id\" parameter is not supported; responses are stateless.")
  if ("conversation" in b) throw invalid("The \"conversation\" parameter is not supported; responses are stateless.")
  if (typeof b.model !== "string" || !b.model || /[\x00-\x1f\x7f]/.test(b.model)) {
    throw invalid("The \"model\" parameter must be a non-empty string.")
  }
  if ("stream" in b && typeof b.stream !== "boolean") {
    throw invalid("The \"stream\" parameter must be a boolean.")
  }
  if ("background" in b && b.background !== false) {
    throw invalid("The \"background\" parameter must be false; background responses are not supported.")
  }
  if ("store" in b && b.store !== false) {
    throw invalid("The \"store\" parameter must be false; stateful responses are not supported.")
  }

  // Copy every field, including client_metadata and future protocol extensions.
  /** @type {Record<string, unknown>} */
  const out = { ...b, store: false }
  const translation = toolTranslation(b)
  if (translation.back.size) translations.set(out, translation)
  let allDropped = false
  if (Array.isArray(b.tools)) {
    const { tools, changed } = translateTools(b.tools, translation)
    if (changed) {
      if (tools.length > 0) out.tools = tools
      else { delete out.tools; allDropped = true }
    }
  }
  const hasTools = Array.isArray(out.tools) && out.tools.length > 0
  const choice = allDropped && out.tool_choice === "required" ? undefined : translateChoice(out.tool_choice, translation, hasTools)
  if (choice === undefined) delete out.tool_choice
  else out.tool_choice = choice
  if (Array.isArray(b.input)) {
    const needsClean = b.input.some(item => isObject(item) && (
      (typeof item.type === "string" && DROPPED_HISTORY.has(item.type)) ||
      (item.type === "function_call" && namespaced(item))
    ))
    if (needsClean) {
      out.input = b.input
        .filter(item => !(isObject(item) && typeof item.type === "string" && DROPPED_HISTORY.has(item.type)))
        .map(item => {
          if (isObject(item) && item.type === "function_call" && namespaced(item)) {
            const { namespace, ...rest } = item
            const alias = translation.forward.get(identityKey(namespace, item.name))
            if (Array.isArray(rest.encrypted_function_args) && !rest.encrypted_function_args.length) delete rest.encrypted_function_args
            return { ...rest, name: alias }
          }
          return item
        })
    }
  }
  // Preserve the existing stateless continuity default without rewriting an
  // explicit include value or altering nested tools/history.
  if (!("include" in b) && ("reasoning" in b ||
      (Array.isArray(out.tools) && out.tools.length > 0) ||
      (Array.isArray(out.input) && out.input.some(item => isObject(item) && item.type === "reasoning")))) {
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
 * @param {ToolTranslation | undefined} translation
 * @returns {ReadableStream<Uint8Array>}
 */
function sseRelay(upstream, signal, secrets, translation) {
  // Output-item IDs belong to this reply, not to the request-wide tool-name map.
  const calls = new Map()
  const classify = (event, name) => {
    if (!isObject(event) || typeof event.type !== "string" || (name && name !== event.type)) throw safeError("inference-response")
    const status = RESPONSE_TERMINALS.get(event.type)
    if (status && (!isObject(event.response) || !isResponseShape(event.response) || event.response.status !== status)) throw safeError("inference-response")
    const terminal = Boolean(status) || event.type === "error" || event.type === "response.error"
    return { terminal, redacted: restoreEvent(redactEvent(event, secrets), translation, calls) }
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
    const stream = sseRelay(response.body, signal, secretsOf(credentials, token, extraSecrets), translations.get(body))
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

  // Restore translated tool identities; redact secrets only from failed responses.
  const failed = !response.ok || (isObject(native) && (native.error != null || native.status === "failed"))
  const serialized = failed
    ? JSON.stringify(restoreResponse(redactFailure(native, secretsOf(credentials, token, extraSecrets)), translations.get(body)))
    : JSON.stringify(restoreResponse(native, translations.get(body)))

  return new Response(serialized, { status: response.status, headers: safeHeaders(response) })
}
