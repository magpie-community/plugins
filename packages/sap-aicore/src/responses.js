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
const HOSTED_TOOL_TYPES = new Set([
  "web_search", "web_search_preview", "web_search_2025_03_11",
  "file_search", "code_interpreter", "computer_use_preview", "computer",
  "mcp", "image_generation", "local_shell", "shell", "apply_patch", "tool_search",
])
const UNSUPPORTED_HISTORY = new Set([
  "web_search_call", "file_search_call", "code_interpreter_call",
  "computer_call", "computer_call_output", "local_shell_call", "local_shell_call_output",
  "shell_call", "shell_call_output", "apply_patch_call", "apply_patch_call_output",
  "mcp_call", "mcp_list_tools", "mcp_approval_request", "mcp_approval_response",
  "image_generation_call",
])
const NAMESPACE_TOOL_KEYS = new Set(["type", "name", "description", "tools"])

/** @typedef {{ namespace?: string, name: string, kind: "function" | "custom" }} ToolIdentity */
/** @typedef {{ forward: Map<string, string>, back: Map<string, ToolIdentity>, declared: Map<string, ToolIdentity & { alias: string }>, declaredFunctions: Set<string> }} ToolTranslation */
/** @type {WeakMap<object, ToolTranslation>} */
const translations = new WeakMap()
const identityKey = (namespace, name) => JSON.stringify([namespace, name])
const namespaced = item => isObject(item) && typeof item.namespace === "string" && item.namespace && typeof item.name === "string" && item.name

// Custom-tool validation checks only the fields the translation reads; every
// other field is ignored (definitions) or passed through (history), so new
// Codex fields do not turn into local 400s.
/** @param {Record<string, unknown>} tool */
function validateCustomTool(tool) {
  if (typeof tool.name !== "string" || !tool.name) {
    throw invalid("A custom tool must have a non-empty string name.")
  }
}

/** @param {Record<string, unknown>} tool @param {string} alias */
function translateCustomTool(tool, alias) {
  validateCustomTool(tool)
  const grammar = isObject(tool.format) && tool.format.type === "grammar" &&
    typeof tool.format.definition === "string" && tool.format.definition
  const format = grammar
    ? { description: `Input must match the ${typeof tool.format.syntax === "string" ? tool.format.syntax + " " : ""}grammar:\n${tool.format.definition}` }
    : {}
  return {
    type: "function",
    name: alias,
    ...(typeof tool.description === "string" ? { description: tool.description } : {}),
    parameters: {
      type: "object",
      properties: { input: { type: "string", ...format } },
      required: ["input"],
      additionalProperties: false,
    },
    strict: true,
  }
}

/** @param {Record<string, unknown>} tool */
function canonicalCustomSource(tool) {
  return {
    type: "custom",
    name: tool.name,
    ...(typeof tool.description === "string" ? { description: tool.description } : {}),
    ...(isObject(tool.format) ? { format: tool.format } : {}),
  }
}

/** @param {Record<string, unknown>} item */
function validateCustomCallItem(item) {
  if (typeof item.call_id !== "string" || !item.call_id ||
      typeof item.name !== "string" || !item.name ||
      typeof item.input !== "string") {
    throw invalid("A custom_tool_call requires non-empty string call_id and name, and a string input.")
  }
  if (item.namespace != null && (typeof item.namespace !== "string" || !item.namespace)) {
    throw invalid("A custom_tool_call namespace must be a non-empty string.")
  }
}

/** @param {Record<string, unknown>} item */
function validateCustomOutputItem(item) {
  if (typeof item.call_id !== "string" || !item.call_id) {
    throw invalid("A custom_tool_call_output requires a non-empty string call_id.")
  }
}

/** @param {Record<string, unknown>} body @returns {ToolTranslation} */
function toolTranslation(body) {
  /** @type {Map<string, ToolIdentity>} */
  const identities = new Map()
  const declaredKeys = new Set()
  const declaredFunctions = new Set()
  const reserved = new Set()
  const add = (namespace, name, kind, isDeclared) => {
    if (typeof name !== "string" || !name) return
    if (namespace === "" && kind === "custom" && reserved.has(name)) {
      throw invalid("Conflicting tool definitions for the same name.")
    }
    const key = identityKey(namespace, name)
    const existing = identities.get(key)
    if (existing && existing.kind !== kind) {
      throw invalid("Conflicting tool definitions for the same name.")
    }
    identities.set(key, namespace ? { namespace, name, kind } : { name, kind })
    if (isDeclared) declaredKeys.add(key)
  }
  if ("tools" in body && body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw invalid("The \"tools\" parameter must be an array.")
    for (const tool of body.tools) {
      if (!isObject(tool) || typeof tool.type !== "string") {
        throw invalid("Each tool in \"tools\" must be an object with a supported \"type\".")
      }
      if (tool.type === "function") {
        if (typeof tool.name === "string" && tool.name) {
          if (identities.has(identityKey("", tool.name))) throw invalid("Conflicting tool definitions for the same name.")
          reserved.add(tool.name)
          declaredFunctions.add(tool.name)
        }
        continue
      }
      if (tool.type === "custom") {
        validateCustomTool(tool)
        add("", tool.name, "custom", true)
        continue
      }
      if (tool.type === "namespace") {
        for (const key of Object.keys(tool)) {
          if (!NAMESPACE_TOOL_KEYS.has(key)) throw invalid("Unsupported field in a namespace tool definition.")
        }
        if (typeof tool.name !== "string" || !tool.name || !Array.isArray(tool.tools) || !tool.tools.length) {
          throw invalid("A namespace tool must have a non-empty string name and a non-empty tools array.")
        }
        if ("description" in tool && tool.description !== undefined && typeof tool.description !== "string") {
          throw invalid("A namespace tool description must be a string.")
        }
        for (const nested of tool.tools) {
          if (!isObject(nested) || typeof nested.type !== "string") {
            throw invalid("Each tool in a namespace must be an object with a supported \"type\".")
          }
          if (nested.type === "function") {
            if (typeof nested.name !== "string" || !nested.name) {
              throw invalid("A namespaced function tool must have a non-empty string name.")
            }
            add(tool.name, nested.name, "function", true)
          } else if (nested.type === "custom") {
            validateCustomTool(nested)
            add(tool.name, nested.name, "custom", true)
          } else {
            throw invalid("Namespace tools may only contain function and custom tools.")
          }
        }
        continue
      }
      throw invalid("Unsupported tool type in \"tools\"; only function, custom and namespace tools are supported.")
    }
  }
  const functionCallIds = new Set()
  const functionOutputIds = new Set()
  const customCallsById = new Map()
  const customOutputsById = new Set()
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (!isObject(item) || typeof item.type !== "string") continue
    if (UNSUPPORTED_HISTORY.has(item.type)) {
      throw invalid("Unsupported hosted tool history item in \"input\".")
    }
    if (item.type === "function_call") {
      if ("namespace" in item && item.namespace !== undefined && item.namespace !== null) {
        if (!namespaced(item)) throw invalid("A namespaced function_call requires non-empty string namespace and name.")
        add(item.namespace, item.name, "function", false)
      } else if (typeof item.name === "string" && item.name) {
        if (identities.has(identityKey("", item.name))) throw invalid("Conflicting tool definitions for the same name.")
        reserved.add(item.name)
      }
      if (typeof item.call_id === "string" && item.call_id) {
        if (customCallsById.has(item.call_id) || customOutputsById.has(item.call_id)) {
          throw invalid("A custom_tool_call cannot share a call_id with a function_call.")
        }
        functionCallIds.add(item.call_id)
      }
      continue
    }
    if (item.type === "function_call_output") {
      if (typeof item.call_id === "string" && item.call_id) {
        if (customCallsById.has(item.call_id) || customOutputsById.has(item.call_id)) {
          throw invalid("A custom_tool_call requires a custom_tool_call_output, not a function_call_output.")
        }
        functionOutputIds.add(item.call_id)
      }
      continue
    }
    if (item.type === "custom_tool_call") {
      validateCustomCallItem(item)
      if (functionCallIds.has(item.call_id) || functionOutputIds.has(item.call_id) || customCallsById.has(item.call_id) || customOutputsById.has(item.call_id)) {
        throw invalid("Each custom_tool_call must have a unique call_id preceding its output.")
      }
      const ns = typeof item.namespace === "string" ? item.namespace : ""
      add(ns, item.name, "custom", false)
      customCallsById.set(item.call_id, item)
      continue
    }
    if (item.type === "custom_tool_call_output") {
      validateCustomOutputItem(item)
      const call = customCallsById.get(item.call_id)
      if (!call || customOutputsById.has(item.call_id) || functionCallIds.has(item.call_id) || functionOutputIds.has(item.call_id)) {
        throw invalid("Each custom_tool_call_output must match a preceding custom_tool_call.")
      }
      if (typeof item.name === "string" && item.name !== call.name) {
        throw invalid("A custom_tool_call_output name must match its custom_tool_call.")
      }
      customOutputsById.add(item.call_id)
    }
  }
  if (customOutputsById.size !== customCallsById.size) {
    throw invalid("Each custom_tool_call in \"input\" requires a matching custom_tool_call_output.")
  }
  const nativeNames = new Set(reserved)
  for (const identity of identities.values()) {
    if (!identity.namespace && /^[A-Za-z0-9_-]{1,64}$/.test(identity.name)) {
      nativeNames.add(identity.name)
      reserved.add(identity.name)
    }
  }
  const counts = new Map()
  for (const { namespace, name } of identities.values()) {
    if (!namespace) continue
    const flat = namespace + "__" + name
    counts.set(flat, (counts.get(flat) ?? 0) + 1)
  }
  const forward = new Map()
  const back = new Map()
  const declared = new Map()
  // Reserve all ordinary qualified names before allocating fallback aliases.
  for (const { namespace, name } of identities.values()) {
    if (!namespace) continue
    const flat = namespace + "__" + name
    if (/^[A-Za-z0-9_-]{1,64}$/.test(flat) && counts.get(flat) === 1 && !reserved.has(flat)) reserved.add(flat)
  }
  for (const [key, identity] of identities) {
    let qualified = false
    let flat = identity.name
    if (!identity.namespace) {
      qualified = /^[A-Za-z0-9_-]{1,64}$/.test(identity.name)
    } else {
      flat = identity.namespace + "__" + identity.name
      qualified = /^[A-Za-z0-9_-]{1,64}$/.test(flat) && counts.get(flat) === 1 && !nativeNames.has(flat)
    }
    const alias = qualified ? flat : "mp_ns_" + createHash("sha256").update(key).digest("hex").slice(0, 56)
    if ((!qualified && reserved.has(alias)) || back.has(alias)) throw invalid("Translated tools have conflicting names.")
    reserved.add(alias)
    forward.set(key, alias)
    back.set(alias, identity)
    if (declaredKeys.has(key)) declared.set(key, { ...identity, alias })
  }
  return { forward, back, declared, declaredFunctions }
}

/** @param {unknown[]} tools @param {ToolTranslation} translation */
function translateTools(tools, translation) {
  const out = []
  const emitted = new Map()
  let changed = false
  const emitTranslated = (alias, translated, source) => {
    if (emitted.has(alias)) {
      if (!isDeepStrictEqual(emitted.get(alias), source)) {
        throw invalid("Repeated translated tools must have identical definitions.")
      }
      return
    }
    emitted.set(alias, source)
    out.push(translated)
  }
  for (const tool of tools) {
    if (isObject(tool) && tool.type === "function") { out.push(tool); continue }
    changed = true
    if (isObject(tool) && tool.type === "custom") {
      const alias = translation.forward.get(identityKey("", tool.name))
      const translated = translateCustomTool(tool, alias)
      emitTranslated(alias, translated, canonicalCustomSource(tool))
      continue
    }
    if (isObject(tool) && tool.type === "namespace" && Array.isArray(tool.tools)) {
      for (const nested of tool.tools) {
        if (!isObject(nested)) continue
        const alias = translation.forward.get(identityKey(tool.name, nested.name))
        if (!alias) throw invalid("A namespaced tool must have a non-empty string name.")
        if (nested.type === "function") {
          const translated = { ...nested, name: alias }
          emitTranslated(alias, translated, translated)
        } else if (nested.type === "custom") {
          const translated = translateCustomTool(nested, alias)
          emitTranslated(alias, translated, canonicalCustomSource(nested))
        }
      }
    }
  }
  return { tools: out, changed }
}

/** @param {Record<string, unknown>} reference @param {ToolTranslation} translation */
function translateReference(reference, translation) {
  if (typeof reference.type !== "string") return reference
  if (HOSTED_TOOL_TYPES.has(reference.type)) {
    throw invalid("Unsupported hosted tool in \"tool_choice\".")
  }
  if (reference.type === "custom") {
    if (typeof reference.name !== "string" || !reference.name ||
        ("namespace" in reference && reference.namespace !== undefined && (typeof reference.namespace !== "string" || !reference.namespace))) {
      throw invalid("A custom tool_choice requires a non-empty string name.")
    }
    const ns = typeof reference.namespace === "string" ? reference.namespace : ""
    const target = translation.declared.get(identityKey(ns, reference.name))
    if (!target || target.kind !== "custom") {
      throw invalid("A custom tool_choice must reference a declared custom tool.")
    }
    const { namespace: _, ...rest } = reference
    return { ...rest, type: "function", name: target.alias }
  }
  if (reference.type === "function") {
    if ("namespace" in reference && reference.namespace !== undefined) {
      if (!namespaced(reference)) {
        throw invalid("A namespaced function tool_choice requires non-empty string namespace and name.")
      }
      const target = translation.declared.get(identityKey(reference.namespace, reference.name))
      if (!target || target.kind !== "function") {
        throw invalid("A namespaced function tool_choice must reference a declared namespaced function tool.")
      }
      const { namespace: _, ...rest } = reference
      return { ...rest, name: target.alias }
    }
    if (typeof reference.name === "string" && translation.declared.get(identityKey("", reference.name))?.kind === "custom") {
      throw invalid("Tool choice type conflicts with declared custom tool.")
    }
  }
  return reference
}

/** @param {unknown} choice @param {ToolTranslation} translation @param {boolean} hasTools */
function translateChoice(choice, translation, hasTools) {
  if (choice === undefined || choice === "none" || choice === "auto") return choice
  if (choice === "required") {
    if (!hasTools) throw invalid("A \"required\" tool_choice requires at least one declared tool.")
    return choice
  }
  if (!isObject(choice)) return choice
  if (!hasTools) throw invalid("A forced \"tool_choice\" requires at least one declared tool.")
  if (choice.type === "allowed_tools") {
    if (!Array.isArray(choice.tools)) return choice
    if (!choice.tools.length) throw invalid("An \"allowed_tools\" tool_choice requires a non-empty tools array.")
    const tools = choice.tools.map(tool => {
      if (!isObject(tool)) throw invalid("Each entry in \"allowed_tools.tools\" must be an object.")
      return translateReference(tool, translation)
    })
    return tools.some((tool, i) => tool !== choice.tools[i]) ? { ...choice, tools } : choice
  }
  return translateReference(choice, translation)
}

/**
 * Unwrap the `{"input": string}` arguments of a translated custom call. Partial
 * (in-progress/incomplete) arguments are not decoded incrementally; they yield
 * "" until the complete arguments arrive.
 * @param {unknown} rawArguments @param {boolean} [allowPartial]
 */
function extractCustomInput(rawArguments, allowPartial = false) {
  try {
    const parsed = typeof rawArguments === "string" ? JSON.parse(rawArguments) : undefined
    if (isObject(parsed) && Object.keys(parsed).length === 1 && typeof parsed.input === "string") {
      return parsed.input
    }
  } catch { /* fall through */ }
  if (allowPartial) return ""
  throw safeError("inference-response")
}

/** @typedef {{ identity: ToolIdentity }} CallState */

/** @param {*} item @param {ToolTranslation | undefined} translation @param {Map<string, CallState>} [calls] @param {boolean} [allowPartial] */
function restoreCall(item, translation, calls = undefined, allowPartial = false) {
  if (!isObject(item) || item.type !== "function_call" || !translation) return item
  const identity = translation.back.get(/** @type {string} */ (item.name))
  if (!identity || item.namespace) return item
  if (typeof item.id === "string") calls?.set(item.id, { identity })
  if (identity.kind === "custom") {
    const partial = allowPartial || item.status === "in_progress" || item.status === "incomplete"
    const input = extractCustomInput(item.arguments, partial)
    const { arguments: _args, namespace: _ns, encrypted_function_args: _enc, ...rest } = item
    return {
      ...rest,
      type: "custom_tool_call",
      name: identity.name,
      ...(identity.namespace ? { namespace: identity.namespace } : {}),
      input,
    }
  }
  return {
    ...item,
    name: identity.name,
    namespace: identity.namespace,
    ...(!("encrypted_function_args" in item) ? { encrypted_function_args: [] } : {}),
  }
}

/** Restore only protocol call positions, never arguments or arbitrary metadata.
 * @param {*} response @param {ToolTranslation | undefined} translation @param {Map<string, CallState>} [calls] @param {boolean} [allowPartial]
 */
function restoreResponse(response, translation, calls = undefined, allowPartial = false) {
  if (!isObject(response) || response.object !== "response" || !Array.isArray(response.output) || !translation?.back.size) return response
  const partial = allowPartial || response.status !== "completed"
  return { ...response, output: response.output.map(item => restoreCall(item, translation, calls, partial)) }
}

/** @param {*} event @param {ToolTranslation | undefined} translation @param {Map<string, CallState>} calls */
function restoreEvent(event, translation, calls) {
  if (!translation?.back.size) return event
  if (event.type === "response.function_call_arguments.delta") {
    const state = calls.get(event.item_id)
    if (!state || state.identity.kind !== "custom") return event
    // Custom input is not streamed incrementally: drop JSON-encoded argument
    // deltas and deliver the complete input once, at `.done`.
    return null
  }
  if (event.type === "response.function_call_arguments.done") {
    const state = calls.get(event.item_id)
    const matches = state && (!("name" in event) || translation.back.get(event.name) === state.identity)
    if (!matches) return event
    if (state.identity.kind === "custom") {
      const input = extractCustomInput(event.arguments, false)
      const { arguments: _args, name: _name, ...rest } = event
      return {
        ...rest,
        type: "response.custom_tool_call_input.done",
        ...("name" in event ? { name: state.identity.name } : {}),
        ...(state.identity.namespace ? { namespace: state.identity.namespace } : {}),
        input,
      }
    }
    return {
      ...event,
      name: state.identity.name,
      ...(state.identity.namespace ? { namespace: state.identity.namespace } : {}),
    }
  }
  const partialItem = event.type === "response.output_item.added"
  return {
    ...event,
    ...("item" in event ? { item: restoreCall(event.item, translation, calls, partialItem) } : {}),
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
  if (Array.isArray(b.tools)) {
    const { tools, changed } = translateTools(b.tools, translation)
    if (changed) out.tools = tools
  }
  const hasTools = Array.isArray(out.tools) && out.tools.length > 0
  if ("tool_choice" in out && out.tool_choice !== undefined) {
    out.tool_choice = translateChoice(out.tool_choice, translation, hasTools)
  }
  if (Array.isArray(b.input)) {
    const needsTranslation = b.input.some(item => isObject(item) && (
      item.type === "custom_tool_call" ||
      item.type === "custom_tool_call_output" ||
      (item.type === "function_call" && namespaced(item))
    ))
    if (needsTranslation) {
      out.input = b.input.map(item => {
        if (!isObject(item)) return item
        if (item.type === "function_call" && namespaced(item)) {
          const { namespace, ...rest } = item
          const alias = translation.forward.get(identityKey(namespace, item.name))
          if (Array.isArray(rest.encrypted_function_args) && !rest.encrypted_function_args.length) delete rest.encrypted_function_args
          return { ...rest, name: alias }
        }
        if (item.type === "custom_tool_call") {
          const { input: rawInput, namespace, ...rest } = item
          const ns = typeof namespace === "string" ? namespace : ""
          const alias = translation.forward.get(identityKey(ns, item.name))
          if (rest.id === null) delete rest.id
          if (rest.status === null) delete rest.status
          if (Array.isArray(rest.encrypted_function_args) && !rest.encrypted_function_args.length) delete rest.encrypted_function_args
          return {
            ...rest,
            type: "function_call",
            name: alias,
            arguments: JSON.stringify({ input: rawInput }),
          }
        }
        if (item.type === "custom_tool_call_output") {
          const { name: _name, ...rest } = item
          if (rest.id === null) delete rest.id
          if (rest.status === null) delete rest.status
          return { ...rest, type: "function_call_output" }
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
    const redacted = restoreEvent(redactEvent(event, secrets), translation, calls)
    // Rename an existing `event:` line when restoration changed the type;
    // data-only frames stay data-only.
    return { terminal, redacted, ...(name && redacted ? { name: redacted.type } : {}) }
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
