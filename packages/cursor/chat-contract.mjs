// Chat Completions input and output contract for Cursor's AgentService.
// These helpers do not authenticate, fetch images, execute tools, or start Runs.

const CALL = "CallDynamicTool"
const NO_RESULT = "Tool use was interrupted and did not produce a result."
const ID_PREFIX = "cursorid_"
const SAFE_ID = /^[A-Za-z0-9_-]{1,512}$/
const SAFE_NAME = /^[A-Za-z0-9_-]{1,64}$/
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"]

// Advisory options are validated, removed from the effective request, and
// reported to the caller. In particular, token caps are NOT enforced. Nothing
// in a prompt supplies strict JSON, stop, schema, or output-length guarantees.
export const CHAT_CONTRACT_POLICY = Object.freeze({
  version: 1,
  instructions: "Keep message order; developer is represented as system at its original position.",
  reasoning: "First nonblank reasoning_content, reasoning, or reasoning_text wins; content reasoning parts keep their positions.",
  images: Object.freeze({
    mimeTypes: Object.freeze(IMAGE_TYPES),
    maxImageBytes: 10 * 1024 * 1024,
    maxRequestImageBytes: 20 * 1024 * 1024,
    remote: "reject; provide a base64 data URL",
  }),
  toolIds: "Chat IDs use 1–512 letters/digits/underscores/hyphens. cursorid_ is reserved for reversible native IDs; existing call_*__fc_* IDs retain their legacy newline mapping.",
  toolNames: "OpenAI function names: 1–64 letters/digits/underscores/hyphens; invalid names and JSON arguments are rejected rather than renamed or replaced.",
  options: Object.freeze({
    temperature: "advisory; ignored",
    top_p: "advisory; ignored",
    max_tokens: "advisory; ignored; token cap NOT enforced",
    max_completion_tokens: "advisory; ignored; token cap NOT enforced",
    reasoning_effort: "nearest supported effort; explicit none/off requires a served off variant",
    service_tier: "priority/fast select fast; other recognized tiers select standard with an advisory",
    tool_choice: "available tool filter and complete-step validation",
    parallel_tool_calls: "false limits the complete step to one tool call",
    stop: "only absent or empty",
    response_format: "only absent or text",
    strict: "only absent or false",
    n: "only absent or 1",
    seed: "unsupported",
    logprobs: "only absent or false",
    top_logprobs: "only absent or 0",
    logit_bias: "only absent or empty",
    presence_penalty: "only absent or 0",
    frequency_penalty: "only absent or 0",
  }),
  steps: "enforceChatStep streams ordinary text/thinking progressively; buffers tool calls until the complete batch validates, and all output for required/named/parallel=false steps; invalid/cancelled output cancels and evicts through invalidate; no model retries",
  maxBufferedStepBytes: 16 * 1024 * 1024,
})

export class ChatContractError extends Error {
  constructor(param, detail, { status = 400, code = "invalid_chat_request" } = {}) {
    super(`${param}: ${detail}`)
    this.name = "ChatContractError"
    this.status = status
    this.code = code
    this.param = param
    this.reusable = false
  }
}

const present = (v) => v !== undefined && v !== null
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && [null, Object.prototype].includes(Object.getPrototypeOf(v))
const fail = (path, detail) => { throw new ChatContractError(path, detail) }
const advisory = (field, code, message) => ({ field, code, message, enforced: false })

function string(v, path, { blank = true } = {}) {
  if (typeof v !== "string" || (!blank && !v.trim())) fail(path, "expected a nonempty string")
  return v
}

function boolean(v, path) {
  if (typeof v !== "boolean") fail(path, "expected a boolean")
  return v
}

function number(v, path, min, max, integer = false) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isSafeInteger(v)))
    fail(path, `expected ${integer ? "an integer" : "a number"} between ${min} and ${max}`)
  return v
}

function json(v, path, depth = 0) {
  if (depth > 64) fail(path, "JSON nesting exceeds 64 levels")
  if (v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return v
  if (Array.isArray(v)) return v.map((x, i) => json(x, `${path}[${i}]`, depth + 1))
  if (object(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, json(x, `${path}.${k}`, depth + 1)]))
  fail(path, "expected a JSON value")
}

export function validateToolName(name, path = "tool.name") {
  if (typeof name !== "string" || !SAFE_NAME.test(name)) fail(path, "expected 1–64 letters, digits, underscores, or hyphens")
  return name
}

export function validateToolCallId(id, path = "tool.id") {
  if (typeof id !== "string" || !SAFE_ID.test(id)) fail(path, "expected 1–512 letters, digits, underscores, or hyphens")
  return id
}

// Opaque native IDs may contain a newline between call_ and fc_. Reserve and
// escape our prefix, so encoding remains reversible even for prefix collisions.
export function encodeCursorToolCallId(id) {
  string(id, "cursor.tool_call_id", { blank: false })
  if (SAFE_ID.test(id) && !id.startsWith(ID_PREFIX) && !/^call_.*__fc_/.test(id)) return id
  const encoded = ID_PREFIX + Buffer.from(id, "utf8").toString("base64url")
  return validateToolCallId(encoded, "cursor.tool_call_id")
}

export function decodeCursorToolCallId(id) {
  validateToolCallId(id)
  if (id.startsWith(ID_PREFIX)) {
    const bytes = Buffer.from(id.slice(ID_PREFIX.length), "base64url")
    const decoded = bytes.toString("utf8")
    if (decoded && encodeCursorToolCallId(decoded) === id) return decoded
  }
  // Compatibility with IDs emitted by the existing Cursor adapter.
  return id.startsWith("call_") ? id.replace("__fc_", "\nfc_") : id
}

export function parseToolArguments(value, path = "tool.arguments") {
  let parsed = value
  if (typeof value === "string") {
    try { parsed = JSON.parse(value) } catch { fail(path, "expected valid JSON object arguments") }
  }
  if (!object(parsed)) fail(path, "expected JSON object arguments")
  return json(parsed, path)
}

function imageBytes(url, path, budget) {
  string(url, path, { blank: false })
  // Do not include the URL in errors: a remote URL can contain credentials.
  const data = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(url)
  if (!data) fail(path, "provide data:image/png|jpeg|gif|webp;base64,...; remote URLs and other encodings are unsupported")
  const base64 = data[2]
  if (!base64 || base64.length > Math.ceil(CHAT_CONTRACT_POLICY.images.maxImageBytes / 3) * 4)
    fail(path, "empty image or image exceeds the 10 MiB limit")
  const bytes = Buffer.from(base64, "base64")
  const canonical = bytes.toString("base64")
  if (canonical.replace(/=+$/, "") !== base64.replace(/=+$/, "") || (base64.includes("=") && canonical !== base64))
    fail(path, "invalid base64 image encoding")
  if (bytes.length > CHAT_CONTRACT_POLICY.images.maxImageBytes) fail(path, "image exceeds the 10 MiB limit")
  const mimeType = data[1]
  const signature = mimeType === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
    : mimeType === "image/jpeg" ? bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))
      : mimeType === "image/gif" ? /^(GIF87a|GIF89a)$/.test(bytes.subarray(0, 6).toString("ascii"))
        : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP"
  if (!signature) fail(path, "image signature does not match its declared MIME type")
  budget.bytes += bytes.length
  if (budget.bytes > CHAT_CONTRACT_POLICY.images.maxRequestImageBytes) fail(path, "images exceed the 20 MiB request limit")
  return { mimeType, bytes, url: `data:${mimeType};base64,${canonical}` }
}

function normalizeContent(content, role, path, advisories, budget) {
  if (typeof content === "string") return content
  if (!present(content) && role === "assistant") return null
  if (!Array.isArray(content)) fail(path, "expected text or a content-part array")
  return content.map((part, i) => {
    const at = `${path}[${i}]`
    if (!object(part)) fail(at, "expected a content part")
    if (part.type === "text" || (part.type === "reasoning" && role === "assistant"))
      return { type: part.type, text: string(part.text, `${at}.text`) }
    if (["image_url", "input_image", "image"].includes(part.type)) {
      if (role !== "user" && role !== "tool") fail(at, "images are supported only in user and tool messages")
      let url, detail
      if (part.type === "image") {
        const source = part.source
        if (!object(source) || source.type !== "base64") fail(at, "provide an image_url with a base64 data URL or a base64 image source")
        url = `data:${string(source.media_type, `${at}.source.media_type`)};base64,${string(source.data, `${at}.source.data`)}`
      } else {
        url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url
        detail = part.detail ?? (object(part.image_url) ? part.image_url.detail : undefined)
      }
      if (present(detail)) {
        if (!["auto", "low", "high"].includes(detail)) fail(`${at}.detail`, "expected auto, low, or high")
        if (detail !== "auto") advisories.push(advisory(`${at}.detail`, "image_detail_ignored", "Cursor accepts image bytes; image detail is not enforced."))
      }
      return { type: "image_url", image_url: { url: imageBytes(url, `${at}.image_url`, budget).url } }
    }
    fail(`${at}.type`, "unsupported content; files, audio, and video require conversion to text or a supported image")
  })
}

function reasoning(message, path, advisories) {
  const fields = ["reasoning_content", "reasoning", "reasoning_text"]
  for (const field of fields) if (present(message[field])) string(message[field], `${path}.${field}`)
  const winner = fields.find((field) => typeof message[field] === "string" && message[field].trim())
  if (!winner) return ""
  for (const field of fields) if (field !== winner && message[field]?.trim() && message[field] !== message[winner])
    advisories.push(advisory(`${path}.${field}`, "reasoning_alias_shadowed", `${winner} takes precedence over this reasoning alias.`))
  return message[winner]
}

function errorFlag(message, path) {
  for (const key of ["is_error", "isError"]) if (present(message[key])) boolean(message[key], `${path}.${key}`)
  if (present(message.is_error) && present(message.isError) && message.is_error !== message.isError)
    fail(path, "is_error and isError disagree")
  return message.is_error ?? message.isError ?? false
}

const REQUEST_FIELDS = new Set([
  "model", "messages", "tools", "tool_choice", "parallel_tool_calls", "reasoning_effort", "service_tier", "stream", "stream_options",
  "temperature", "top_p", "max_tokens", "max_completion_tokens", "presence_penalty", "frequency_penalty", "n", "stop", "response_format",
  "seed", "logprobs", "top_logprobs", "logit_bias", "modalities", "audio", "prediction", "verbosity", "functions", "function_call",
  "web_search_options", "prompt_cache_key", "conversation_id", "prompt_cache_retention", "user", "safety_identifier", "metadata", "store",
])

export function normalizeGenerationOptions(request) {
  if (!object(request)) fail("request", "expected a JSON object")
  for (const key of Object.keys(request)) if (!REQUEST_FIELDS.has(key)) fail(key, "unsupported Chat request field")
  const options = {}, advisories = []
  options.model = string(request.model, "model", { blank: false })
  for (const [key, min, max, integer] of [
    ["temperature", 0, 2, false], ["top_p", 0, 1, false],
    ["max_tokens", 1, Number.MAX_SAFE_INTEGER, true], ["max_completion_tokens", 1, Number.MAX_SAFE_INTEGER, true],
  ]) if (present(request[key])) {
    number(request[key], key, min, max, integer)
    advisories.push(advisory(key, "generation_option_ignored", `${key} is accepted for compatibility and ignored; ${key.startsWith("max_") ? "the token cap is NOT enforced" : "Cursor chooses sampling"}.`))
  }
  for (const key of ["presence_penalty", "frequency_penalty"]) if (present(request[key]) && number(request[key], key, -2, 2) !== 0)
    fail(key, "nonzero penalties are unsupported")
  if (present(request.n) && number(request.n, "n", 1, Number.MAX_SAFE_INTEGER, true) !== 1) fail("n", "only one completion is supported")
  if (present(request.seed)) {
    number(request.seed, "seed", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, true)
    fail("seed", "deterministic seeds are unsupported")
  }
  if (present(request.logprobs) && boolean(request.logprobs, "logprobs")) fail("logprobs", "token probabilities are unsupported")
  if (present(request.top_logprobs) && number(request.top_logprobs, "top_logprobs", 0, 20, true) !== 0) fail("top_logprobs", "token probabilities are unsupported")
  if (present(request.logit_bias)) {
    if (!object(request.logit_bias)) fail("logit_bias", "expected an object")
    for (const [key, value] of Object.entries(request.logit_bias)) {
      if (!/^\d+$/.test(key)) fail("logit_bias", "expected token ID keys")
      number(value, "logit_bias", -100, 100)
    }
    if (Object.keys(request.logit_bias).length) fail("logit_bias", "token biases are unsupported")
  }
  if (present(request.stop)) {
    const stops = typeof request.stop === "string" ? [request.stop] : request.stop
    if (!Array.isArray(stops) || stops.length > 4) fail("stop", "expected a string or up to four strings")
    stops.forEach((s, i) => string(s, `stop[${i}]`))
    if (stops.length && !(typeof request.stop === "string" && request.stop === "")) fail("stop", "stop sequences are unsupported")
  }
  if (present(request.response_format)) {
    if (!object(request.response_format) || request.response_format.type !== "text" || Object.keys(request.response_format).some((k) => k !== "type"))
      fail("response_format", "only text is supported; strict JSON and JSON schemas are unsupported")
  }
  if (present(request.reasoning_effort)) {
    if (!["none", "off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(request.reasoning_effort)) fail("reasoning_effort", "unknown reasoning effort")
    options.reasoning_effort = request.reasoning_effort === "off" ? "none" : request.reasoning_effort
  }
  if (present(request.service_tier)) {
    if (!["auto", "default", "flex", "scale", "priority", "fast"].includes(request.service_tier)) fail("service_tier", "unknown service tier")
    options.service_tier = request.service_tier
    if (!["priority", "fast"].includes(request.service_tier)) advisories.push(advisory("service_tier", "service_tier_mapped", "This tier selects standard service; Cursor does not enforce the requested scheduling tier."))
  }
  if (present(request.stream)) options.stream = boolean(request.stream, "stream")
  if (present(request.stream_options)) {
    if (!object(request.stream_options)) fail("stream_options", "expected an object")
    for (const key of Object.keys(request.stream_options)) if (key !== "include_usage") fail(`stream_options.${key}`, "unsupported stream option")
    if (present(request.stream_options.include_usage)) options.stream_options = { include_usage: boolean(request.stream_options.include_usage, "stream_options.include_usage") }
  }
  if (present(request.modalities) && (!Array.isArray(request.modalities) || request.modalities.length !== 1 || request.modalities[0] !== "text"))
    fail("modalities", "only text output is supported")
  for (const key of ["audio", "prediction", "verbosity", "web_search_options", "functions", "function_call"]) if (present(request[key]))
    fail(key, "unsupported; use Chat text and function tools")
  if (present(request.store) && boolean(request.store, "store")) fail("store", "server-side completion storage is unsupported")
  if (present(request.prompt_cache_key)) options.prompt_cache_key = string(request.prompt_cache_key, "prompt_cache_key")
  if (present(request.conversation_id)) options.conversation_id = string(request.conversation_id, "conversation_id")
  if (present(request.prompt_cache_retention)) {
    if (!["in-memory", "24h"].includes(request.prompt_cache_retention)) fail("prompt_cache_retention", "expected in-memory or 24h")
    advisories.push(advisory("prompt_cache_retention", "metadata_ignored", "Cursor does not enforce a requested cache retention period."))
  }
  for (const key of ["user", "safety_identifier", "metadata"]) if (present(request[key])) {
    if (key === "metadata") {
      if (!object(request[key])) fail(key, "expected an object")
      json(request[key], key)
    } else string(request[key], key)
    advisories.push(advisory(key, "metadata_ignored", "This metadata is not forwarded to Cursor."))
  }
  return { options, advisories }
}

function normalizeTools(request) {
  if (present(request.tools) && !Array.isArray(request.tools)) fail("tools", "expected an array")
  const names = new Set()
  const definitions = (request.tools ?? []).map((tool, i) => {
    const path = `tools[${i}]`
    if (!object(tool) || tool.type !== "function" || !object(tool.function)) fail(path, "only function tools are supported")
    const f = tool.function
    const name = validateToolName(f.name, `${path}.function.name`)
    if (names.has(name)) fail(`${path}.function.name`, "duplicate tool name")
    names.add(name)
    if (present(f.strict) && boolean(f.strict, `${path}.function.strict`)) fail(`${path}.function.strict`, "strict tool schema enforcement is unsupported")
    const schema = present(f.parameters) ? json(f.parameters, `${path}.function.parameters`) : { type: "object", properties: {} }
    if (!object(schema) || (present(schema.type) && schema.type !== "object")) fail(`${path}.function.parameters`, "expected an object argument schema")
    return { name, description: present(f.description) ? string(f.description, `${path}.function.description`) : "", schema, schemaText: JSON.stringify(schema) }
  })
  let choice = request.tool_choice ?? "auto", named = ""
  if (choice === "named") fail("tool_choice", "a named choice requires a function object")
  if (object(choice)) {
    if (["auto", "none", "required"].includes(choice.type) && Object.keys(choice).length === 1) choice = choice.type
    else if (choice.type === "function" && object(choice.function)) {
      named = validateToolName(choice.function.name, "tool_choice.function.name")
      if (!names.has(named)) fail("tool_choice.function.name", "named tool is not defined")
      choice = "named"
    } else fail("tool_choice", "expected auto, none, required, or a named function")
  }
  if (!["auto", "none", "required", "named"].includes(choice)) fail("tool_choice", "expected auto, none, required, or a named function")
  if (choice === "required" && !definitions.length) fail("tool_choice", "required needs at least one tool")
  if (present(request.parallel_tool_calls)) boolean(request.parallel_tool_calls, "parallel_tool_calls")
  return {
    tools: choice === "none" ? [] : named ? definitions.filter((t) => t.name === named) : definitions,
    toolPolicy: { choice, named, minCalls: choice === "required" || choice === "named" ? 1 : 0, maxCalls: request.parallel_tool_calls === false ? 1 : null },
    definitions,
  }
}

function normalizeToolAttachments(messages, completedResults) {
  const out = []
  for (const [i, message] of messages.entries()) {
    const content = message.content
    const attachment = message.role === "user" && completedResults.has(i) && Array.isArray(content) && content.length > 1
      && content[0].type === "text" && content[0].text === "Attached image(s) from tool result:"
      && content.slice(1).every((part) => part.type === "image_url")
    if (!attachment) { out.push(message); continue }
    let results = 0
    for (let at = out.length - 1; at >= 0 && out[at].role === "tool"; at--) results++
    // Pi aggregates images without call IDs. Only a single complete result
    // makes their attribution unambiguous; parallel callers must attach each
    // image directly to its tool message instead of losing the association.
    if (results !== 1) fail(`messages[${i}].content`, "parallel tool-result images have no call attribution; put each image in its matching tool message")
    const tool = out.at(-1)
    const parts = typeof tool.content === "string" ? [{ type: "text", text: tool.content }] : tool.content
    out[out.length - 1] = { ...tool, content: [...parts, ...content.slice(1)] }
  }
  return out
}

// chat retains Chat wire message shapes (canonical reasoning_content, data
// image URLs, object arguments). buildChatConversation supplies transcript
// blobs; normalizeToolResult supplies the matching native MCP result. Callers
// must expose advisories in response diagnostics: ignored options are absent
// from chat and are never implemented through prompt instructions.
export function normalizeChatRequest(request) {
  const { options, advisories } = normalizeGenerationOptions(request)
  if (!Array.isArray(request.messages) || !request.messages.length) fail("messages", "expected a nonempty array")
  const { tools, toolPolicy, definitions } = normalizeTools(request)
  const budget = { bytes: 0 }, seen = new Set(), seenCursorIds = new Set(), pending = new Set(), completedResults = new Set()
  let previous = ""
  const messages = request.messages.map((message, i) => {
    const path = `messages[${i}]`
    if (!object(message) || !["system", "developer", "user", "assistant", "tool"].includes(message.role)) fail(`${path}.role`, "unsupported message role")
    if (present(message.function_call)) fail(`${path}.function_call`, "use tool_calls; legacy function calls are unsupported")
    if (present(message.audio) || present(message.refusal)) fail(path, "audio and refusal history require explicit text conversion")
    const m = { role: message.role, content: normalizeContent(message.content, message.role, `${path}.content`, advisories, budget) }
    if (present(message.name)) fail(`${path}.name`, "named message participants are unsupported")
    if (message.role === "developer") advisories.push(advisory(`${path}.role`, "developer_as_system", "Developer instructions keep their position and use the system role; separate role precedence is not available."))
    if (message.role !== "assistant" && ["reasoning_content", "reasoning", "reasoning_text", "tool_calls"].some((key) => present(message[key]))) fail(path, "reasoning and tool calls belong to assistant messages")
    if (message.role !== "tool" && ["tool_call_id", "is_error", "isError"].some((key) => present(message[key]))) fail(path, "tool result fields belong to tool messages")
    if (message.role === "user" && previous === "tool" && !pending.size) completedResults.add(i)
    if (message.role === "user" || (message.role === "assistant" && previous !== "assistant")) pending.clear()
    if (message.role === "assistant") {
      const r = reasoning(message, path, advisories)
      if (r) m.reasoning_content = r
      if (present(message.tool_calls) && !Array.isArray(message.tool_calls)) fail(`${path}.tool_calls`, "expected an array")
      if (message.tool_calls?.length) m.tool_calls = message.tool_calls.map((call, j) => {
        const at = `${path}.tool_calls[${j}]`
        if (!object(call) || (present(call.type) && call.type !== "function") || !object(call.function)) fail(at, "expected a function call")
        const id = validateToolCallId(call.id, `${at}.id`)
        const cursorId = decodeCursorToolCallId(id)
        if (seen.has(id) || seenCursorIds.has(cursorId)) fail(`${at}.id`, "duplicate tool call ID")
        seen.add(id); seenCursorIds.add(cursorId); pending.add(id)
        return { id, type: "function", function: { name: validateToolName(call.function.name, `${at}.function.name`), arguments: parseToolArguments(call.function.arguments, `${at}.function.arguments`) } }
      })
    }
    if (message.role === "tool") {
      const id = validateToolCallId(message.tool_call_id, `${path}.tool_call_id`)
      if (!pending.delete(id)) fail(`${path}.tool_call_id`, "tool result has no unanswered call in this step")
      m.tool_call_id = id
      m.is_error = errorFlag(message, path)
    }
    if (message.role !== "system" && message.role !== "developer") previous = message.role
    return m
  })
  const chat = { ...options, messages: normalizeToolAttachments(messages, completedResults), tools: definitions.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } })), tool_choice: toolPolicy.choice === "named" ? { type: "function", function: { name: toolPolicy.named } } : toolPolicy.choice }
  if (present(request.parallel_tool_calls)) chat.parallel_tool_calls = request.parallel_tool_calls
  return { chat, tools, toolPolicy, advisories }
}

function transcriptParts(content) {
  const parts = typeof content === "string" ? [{ type: "text", text: content }] : content ?? []
  return parts.map((part) => {
    if (part.type !== "image_url") return { ...part }
    const { bytes, mimeType } = imageBytes(part.image_url.url, "content.image_url", { bytes: 0 })
    return { type: "image", mimeType, image: { __type: "Uint8Array", hex: bytes.toString("hex") } }
  })
}

function assistantParts(message) {
  const parts = transcriptParts(message.content)
  const reasoning = [message.reasoning_content, message.reasoning, message.reasoning_text].find((s) => typeof s === "string" && s.trim())
  return reasoning ? [{ type: "reasoning", text: reasoning }, ...parts] : parts
}

// Project validated assistant display parts consistently for native matching
// and historical completion. Split pieces concatenate exactly like deltas;
// reasoning stays separate from text and no separators are invented.
export function assistantDisplay(message) {
  const parts = assistantParts(message)
  return {
    text: parts.filter((part) => part.type === "text").map((part) => part.text).join(""),
    reasoning: parts.filter((part) => part.type === "reasoning").map((part) => part.text).join(""),
  }
}

export function normalizeToolResult(message, path = "tool_result") {
  if (!object(message) || message.role !== "tool") fail(path, "expected a tool message")
  const id = validateToolCallId(message.tool_call_id, `${path}.tool_call_id`)
  const advisories = []
  const content = normalizeContent(message.content, "tool", `${path}.content`, advisories, { bytes: 0 })
  const parts = transcriptParts(content)
  const experimental_content = parts.map((part) => part.type === "image"
    ? { type: "image", mimeType: part.mimeType, data: Buffer.from(part.image.hex, "hex").toString("base64") }
    : { ...part })
  let result = experimental_content
  if (parts.every((part) => part.type === "text")) {
    result = parts.map((part) => part.text).join("")
    try { result = JSON.parse(result) } catch {}
  }
  const isError = errorFlag(message, path)
  const toolCallId = decodeCursorToolCallId(id)
  const mcpContent = parts.map((part) => part.type === "image"
    ? { content: { case: "image", value: { data: Uint8Array.from(Buffer.from(part.image.hex, "hex")), mimeType: part.mimeType } } }
    : { content: { case: "text", value: { text: part.text } } })
  return {
    id, toolCallId, parts, isError, advisories,
    transcript: { type: "tool-result", toolCallId, toolName: CALL, result, experimental_content, ...(isError ? { isError: true } : {}) },
    mcpResult: { result: { case: "success", value: { content: mcpContent, isError } } },
  }
}

export function buildToolCatalog(tools) {
  if (!tools.length) return ""
  let text = `<dynamic_tool_catalog>\nThe MCP namespace "magpie" has the tools below. Use only ${CALL} for these tools. Arguments must match the supplied schemas.\n`
  for (const tool of tools) text += `<call>${CALL}({"namespace":"magpie","toolName":${JSON.stringify(tool.name)},"arguments":{...}})\n${tool.description}\narguments schema: ${tool.schemaText}\n</call>\n`
  return text + "</dynamic_tool_catalog>"
}

function joinSplitCalls(messages) {
  const out = []
  for (const message of messages) {
    const prev = out.at(-1)
    if (message.role === "assistant" && prev?.role === "assistant" && prev.tool_calls?.length) {
      out[out.length - 1] = {
        role: "assistant",
        content: [...assistantParts(prev), ...assistantParts(message)],
        tool_calls: [...prev.tool_calls, ...(message.tool_calls ?? [])],
      }
    } else out.push(message)
  }
  return out
}

export function buildChatConversation(contract) {
  const out = [], pending = new Map()
  let results = [], last = ".", size = 0, previous = ""
  const add = (message) => out.push(Buffer.from(JSON.stringify(message)))
  const flush = () => { if (results.length) add({ role: "tool", content: results }); results = [] }
  const answer = () => {
    for (const id of pending.keys()) results.push(normalizeToolResult({ role: "tool", tool_call_id: id, content: NO_RESULT, is_error: true }).transcript)
    pending.clear(); flush()
  }
  const catalog = buildToolCatalog(contract.tools)
  if (catalog) { add({ role: "system", content: catalog }); size += catalog.length }
  for (const message of joinSplitCalls(contract.chat.messages)) {
    if (message.role === "tool") {
      pending.delete(message.tool_call_id)
      const result = normalizeToolResult(message)
      results.push(result.transcript)
      size += result.parts.filter((part) => part.type === "text").reduce((n, p) => n + p.text.length, 0)
      previous = "tool"
      continue
    }
    if (message.role === "system" || message.role === "developer") {
      flush()
      const text = transcriptParts(message.content).map((part) => part.text).join("")
      add({ role: "system", content: text }); size += text.length
      continue
    }
    // An instruction may separate assistant fragments of one pending tool
    // step. Keep that instruction in place without inventing an early result.
    if (!(message.role === "assistant" && previous === "assistant" && pending.size)) answer()
    previous = message.role
    const content = message.role === "assistant" ? assistantParts(message) : transcriptParts(message.content)
    size += content.filter((part) => part.type === "text" || part.type === "reasoning").reduce((n, p) => n + p.text.length, 0)
    if (message.role === "user") last = content.filter((part) => part.type === "text").map((part) => part.text).join("") || "."
    for (const call of message.tool_calls ?? []) {
      const args = call.function.arguments
      content.push({ type: "tool-call", toolCallId: decodeCursorToolCallId(call.id), toolName: CALL, args: { namespace: "magpie", toolName: call.function.name, arguments: args } })
      pending.set(call.id, call)
      size += call.function.name.length + JSON.stringify(args).length
    }
    add({ role: message.role, content })
  }
  answer()
  return { msgs: out, last, estimate: Math.floor(size / 4) }
}

function outputFailure(path, detail) {
  return new ChatContractError(path, detail, { status: 502, code: "cursor_output_contract" })
}

// Events are complete native-decoder pieces, not fragmented Chat wire deltas:
// {text}, {reasoning}, {tool:{index,id,name,args}}, {stop,usage}, or {error}.
// The source iterator must END for this model step, even if its native Run
// remains open awaiting external tool results. Passing the whole Run here
// would wait for results before exposing the calls needed to produce them.
export function validateChatStep(events, contract) {
  if (!Array.isArray(events)) throw outputFailure("step", "expected a complete event array")
  const allowed = new Set(contract.tools.map((tool) => tool.name)), seen = new Set(), seenCursorIds = new Set()
  const output = []
  let calls = 0, terminal = false
  for (const event of events) {
    if (!object(event) || terminal) throw outputFailure("step", "invalid event or data after the terminal event")
    if (event.error) throw outputFailure("step", "Cursor returned an error before completing the step")
    if (["tool", "text", "reasoning", "stop"].filter((key) => event[key] !== undefined).length !== 1)
      throw outputFailure("step", "expected one output event kind")
    if (event.tool) {
      const tool = event.tool
      let id, name, args
      try {
        if (!object(tool)) fail("tool", "expected a complete tool call")
        id = validateToolCallId(tool.id)
        name = validateToolName(tool.name)
        args = parseToolArguments(tool.args)
      } catch (error) {
        if (!(error instanceof ChatContractError)) throw error
        throw outputFailure(error.param, "Cursor returned an invalid tool call")
      }
      if (!allowed.has(name)) throw outputFailure("tool.name", "Cursor called a tool outside the allowed set")
      const cursorId = decodeCursorToolCallId(id)
      if (seen.has(id) || seenCursorIds.has(cursorId)) throw outputFailure("tool.id", "Cursor reused a tool call ID")
      if (tool.index !== calls) throw outputFailure("tool.index", "Cursor returned inconsistent tool call indices")
      seen.add(id); seenCursorIds.add(cursorId); calls++
      output.push({ ...event, tool: { ...tool, id, name, args: JSON.stringify(args) } })
    } else {
      if (event.stop) {
        if (event.stop !== (calls ? "tool_calls" : "stop")) throw outputFailure("step.stop", "finish reason does not match the tool calls")
        terminal = true
      } else if (typeof event.text !== "string" && typeof event.reasoning !== "string") throw outputFailure("step", "unknown output event")
      output.push(event)
    }
  }
  if (!terminal) throw outputFailure("step", "Cursor did not complete the model step")
  if (calls < contract.toolPolicy.minCalls) throw outputFailure("tool_choice", "Cursor completed the step without the required tool call")
  if (contract.toolPolicy.maxCalls !== null && calls > contract.toolPolicy.maxCalls) throw outputFailure("parallel_tool_calls", "Cursor returned multiple calls when parallel_tool_calls was false")
  return output
}

// invalidate MUST cancel the owned native Run and evict its continuation state
// before resolving. Cached replay iterators have no Run ownership: their hook
// leaves the active owner intact. A rejection propagates; this helper never
// retries a model request.
export async function* enforceChatStep(events, contract, { invalidate } = {}) {
  if (typeof invalidate !== "function") throw new TypeError("enforceChatStep requires an invalidate hook that cancels and evicts the native Run")
  const constrained = contract.toolPolicy.minCalls > 0 || contract.toolPolicy.maxCalls !== null
  const buffered = []
  let bytes = 0, invalidated = false, completed = false, terminal = false, toolsStarted = false
  const evict = async (error) => {
    if (invalidated) return
    invalidated = true
    await invalidate({ reason: "chat_contract", reusable: false, error: { status: error.status ?? 502, code: error.code ?? "cursor_output_contract", param: error.param ?? "step" } })
  }
  try {
    for await (const event of events) {
      if (event?.error) {
        await evict(event.error)
        yield event
        completed = true
        return
      }
      if (!object(event) || terminal || ["tool", "text", "reasoning", "stop"].filter((key) => event[key] !== undefined).length !== 1)
        throw outputFailure("step", "invalid event or data after the terminal event")
      if (event.stop !== undefined) terminal = true
      if (event.tool !== undefined) toolsStarted = true
      if (event.text !== undefined || event.reasoning !== undefined) {
        if (typeof (event.text ?? event.reasoning) !== "string") throw outputFailure("step", "invalid display output")
        // The native decoder places complete tool calls at the end of a step.
        if (toolsStarted) throw outputFailure("step", "display output arrived after the tool batch")
        if (!constrained) { yield event; continue }
      }
      bytes += Buffer.byteLength(JSON.stringify(event) ?? "")
      if (bytes > CHAT_CONTRACT_POLICY.maxBufferedStepBytes) throw outputFailure("step", "buffered step exceeds the 16 MiB limit")
      buffered.push(event)
    }
    for (const event of validateChatStep(buffered, contract)) yield event
    completed = true
  } catch (error) {
    await evict(error)
    throw error
  } finally {
    if (!completed) await evict(outputFailure("step", "step cancelled before delivery completed"))
  }
}
