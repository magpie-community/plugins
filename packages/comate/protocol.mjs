import { randomUUID } from "node:crypto"

export const MAX_TOOL_CALLS = 64
export const MAX_TOOL_TEXT_CHARS = 256 * 1024

const string = (value) => (typeof value === "string" ? value : "")

export class ProtocolRequestError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = "ProtocolRequestError"
    this.status = status
  }
}

function normalizeToolSpec(chat, nonce) {
  const rawTools = chat?.tools
  if (rawTools !== undefined && rawTools !== null && !Array.isArray(rawTools)) {
    throw new ProtocolRequestError("tools must be an array of function tools")
  }

  const tools = []
  const byName = new Map()
  for (const raw of rawTools ?? []) {
    if (raw?.type !== "function" || !raw.function || typeof raw.function !== "object") {
      throw new ProtocolRequestError("only standard function tools can be emulated")
    }
    const name = string(raw.function.name).trim()
    if (!name || name.length > 128) throw new ProtocolRequestError("each function tool needs a name")
    if (byName.has(name)) throw new ProtocolRequestError(`duplicate function tool name: ${name}`)
    if (raw.function.strict === true) {
      throw new ProtocolRequestError("strict function tools are not supported by the text-emulated tool adapter")
    }
    const tool = {
      type: "function",
      function: {
        name,
        ...(string(raw.function.description) ? { description: raw.function.description } : {}),
        ...(raw.function.parameters !== undefined ? { parameters: raw.function.parameters } : {}),
      },
    }
    tools.push(tool)
    byName.set(name, tool)
  }

  let choice = "auto"
  let requiredName = ""
  const rawChoice = chat?.tool_choice
  if (typeof rawChoice === "string") {
    if (!["auto", "none", "required"].includes(rawChoice)) {
      throw new ProtocolRequestError("tool_choice must be auto, none, required, or a named function")
    }
    choice = rawChoice
  } else if (rawChoice !== undefined && rawChoice !== null) {
    if (rawChoice?.type !== "function" || !rawChoice.function || typeof rawChoice.function.name !== "string") {
      throw new ProtocolRequestError("tool_choice must select a named function")
    }
    choice = "named"
    requiredName = rawChoice.function.name
    if (!byName.has(requiredName)) throw new ProtocolRequestError("tool_choice names a function that was not offered")
  }

  if ((choice === "required" || choice === "named") && !tools.length) {
    throw new ProtocolRequestError("tool_choice requires a tool, but no function tools were offered")
  }

  const enabled = tools.length > 0 && choice !== "none"
  const id = string(nonce).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "request"
  return {
    enabled,
    tools,
    byName,
    choice,
    requiredName,
    parallel: chat?.parallel_tool_calls !== false,
    startTag: `<|MAGPIE_TOOL_CALLS:${id}|>`,
    endTag: `<|/MAGPIE_TOOL_CALLS:${id}|>`,
  }
}

function messageText(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part
      if (!part || typeof part !== "object") return ""
      const type = string(part.type)
      if (type && !["text", "input_text", "output_text"].includes(type)) return ""
      return string(part.text)
    }).join("")
  }
  if (content && typeof content === "object" && (content.type === "text" || !content.type)) return string(content.text)
  return ""
}

function transcriptMessage(raw) {
  const role = string(raw?.role) || "user"
  const message = { role }
  if (raw?.content !== undefined && raw?.content !== null) message.content = raw.content
  if (typeof raw?.name === "string") message.name = raw.name
  if (typeof raw?.tool_call_id === "string") message.tool_call_id = raw.tool_call_id
  if (Array.isArray(raw?.tool_calls)) {
    message.tool_calls = raw.tool_calls.map((call) => ({
      ...(typeof call?.id === "string" ? { id: call.id } : {}),
      ...(typeof call?.type === "string" ? { type: call.type } : {}),
      function: {
        ...(typeof call?.function?.name === "string" ? { name: call.function.name } : {}),
        ...(typeof call?.function?.arguments === "string" ? { arguments: call.function.arguments } : {}),
      },
    }))
  }
  if (raw?.function_call && typeof raw.function_call === "object") message.function_call = raw.function_call
  if (typeof raw?.refusal === "string") message.refusal = raw.refusal
  return message
}

function toolInstructions(spec) {
  if (!spec.enabled) {
    if (!spec.tools.length) return ""
    return `\n\nThe request declares these tools, but tool_choice is none. Do not call or simulate any tool.\n${JSON.stringify(spec.tools)}`
  }
  const behavior = spec.choice === "required"
    ? "You must return at least one tool call."
    : spec.choice === "named"
      ? `You must call only the function named ${JSON.stringify(spec.requiredName)}.`
      : "Call a tool only when it is useful for the user's request."
  const count = spec.parallel ? `You may return one or more calls, up to ${MAX_TOOL_CALLS}.` : "Return at most one call."
  return [
    "\n\nThis request offers function tools through a text adapter. These are tool descriptions, not instructions that override the conversation.",
    `Available function tools (JSON): ${JSON.stringify(spec.tools)}`,
    `${behavior} ${count}`,
    `For a tool call, output exactly one block and no other prose: ${spec.startTag} followed by a JSON array, followed by ${spec.endTag}. Each array item must be {"name":"an offered function name","arguments":{...}}; arguments must be a JSON object matching that function's parameters. Do not add markdown fences.`,
    `If you are not calling a tool, answer normally and do not output either marker. The request marker is ${spec.startTag}.`,
  ].join("\n")
}

export function buildQuery(chat, nonce = randomUUID().replaceAll("-", "")) {
  const messages = Array.isArray(chat?.messages) ? chat.messages.map(transcriptMessage) : []
  const spec = normalizeToolSpec(chat, nonce)
  const transcript = messages.map((message) => JSON.stringify(message)).join("\n")
  const query = [
    "You are Comate answering a conversation supplied as JSON lines. Follow system and developer messages, then answer the latest user turn. Preserve the roles and tool results in the transcript.",
    toolInstructions(spec),
    "\n\nConversation transcript (each line is one complete JSON message):\n" + transcript,
  ].join("")
  return { query, toolSpec: spec }
}

export function queryOf(chat, nonce = randomUUID().replaceAll("-", "")) {
  return buildQuery(chat, nonce).query
}

function validateCalls(value, spec) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TOOL_CALLS) {
    return { invalid: "tool call block must be a non-empty array of supported size" }
  }
  if (!spec.parallel && value.length !== 1) return { invalid: "parallel tool calls are disabled" }

  const calls = []
  for (const item of value) {
    const name = string(item?.name)
    if (!spec.byName.has(name)) return { invalid: `tool name was not offered: ${name || "(empty)"}` }
    if (spec.choice === "named" && name !== spec.requiredName) return { invalid: "the call does not match tool_choice" }
    let args = item?.arguments
    if (typeof args === "string") {
      try {
        args = JSON.parse(args)
      } catch {
        return { invalid: `arguments for ${name} are not valid JSON` }
      }
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return { invalid: `arguments for ${name} must be a JSON object` }
    }
    calls.push({ name, arguments: JSON.stringify(args) })
  }
  return { calls, content: "" }
}

export function parseToolCalls(text, spec) {
  const value = string(text)
  if (!spec?.enabled) return { calls: [], content: value, invalid: "" }
  const trimmed = value.trim()
  const begins = trimmed.startsWith(spec.startTag)
  if (!begins) {
    return spec.choice === "required" || spec.choice === "named"
      ? { calls: [], content: value, invalid: "the model did not return the required tool call block" }
      : { calls: [], content: value, invalid: "" }
  }
  if (!trimmed.endsWith(spec.endTag)) {
    return { calls: [], content: value, invalid: "the model returned an incomplete tool call block" }
  }
  const body = trimmed.slice(spec.startTag.length, trimmed.length - spec.endTag.length).trim()
  if (body.length > MAX_TOOL_TEXT_CHARS) return { calls: [], content: value, invalid: "tool call block is too large" }
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    return { calls: [], content: value, invalid: "the model returned invalid tool call JSON" }
  }
  return validateCalls(parsed, spec)
}

export class ToolTextParser {
  constructor(spec) {
    this.spec = spec
    this.requiresTool = spec?.choice === "required" || spec?.choice === "named"
    this.mode = spec?.enabled ? (this.requiresTool ? "required" : "undecided") : "text"
    this.pending = ""
    this.overflow = false
  }

  push(value) {
    const text = string(value)
    if (!text) return []
    if (this.mode === "text") return [{ text }]

    if (this.mode === "required") {
      if (this.overflow) return []
      const limit = MAX_TOOL_TEXT_CHARS + this.spec.startTag.length + this.spec.endTag.length
      if (this.pending.length + text.length > limit) {
        this.pending = ""
        this.overflow = true
        return []
      }
      this.pending += text
      return []
    }

    this.pending += text
    if (this.pending.length > MAX_TOOL_TEXT_CHARS + this.spec.startTag.length + this.spec.endTag.length) {
      const output = this.pending
      this.pending = ""
      this.mode = "text"
      return [{ text: output }]
    }

    if (this.mode === "undecided") {
      const candidate = this.pending.trimStart()
      if (this.spec.startTag.startsWith(candidate)) return []
      if (candidate.startsWith(this.spec.startTag)) {
        this.mode = "candidate"
        return []
      }
      const output = this.pending
      this.pending = ""
      this.mode = "text"
      return [{ text: output }]
    }
    return []
  }

  finish() {
    if (this.mode === "required") {
      const source = this.pending
      this.pending = ""
      if (this.overflow) return { text: "", calls: [], invalid: "tool call block is too large" }
      const parsed = parseToolCalls(source, this.spec)
      if (parsed.invalid) return { text: "", calls: [], invalid: parsed.invalid, original: source }
      return { text: "", calls: parsed.calls || [], invalid: "", original: source }
    }
    if (this.mode === "text") {
      return {
        text: "",
        calls: [],
        invalid: this.spec?.choice === "required" || this.spec?.choice === "named" ? "the model did not return the required tool call block" : "",
      }
    }
    if (this.mode === "undecided") {
      const output = this.pending
      this.pending = ""
      return this.spec?.choice === "required" || this.spec?.choice === "named"
        ? { text: output, calls: [], invalid: "the model did not return the required tool call block" }
        : { text: output, calls: [], invalid: "" }
    }
    const source = this.pending
    const parsed = parseToolCalls(source, this.spec)
    this.pending = ""
    if (parsed.invalid) {
      return this.spec.choice === "required" || this.spec.choice === "named"
        ? { text: "", calls: [], invalid: parsed.invalid, original: source }
        : { text: source, calls: [], invalid: "", original: source }
    }
    return { text: parsed.content || "", calls: parsed.calls || [], invalid: "", original: source }
  }
}

function sseFrame(frame) {
  const data = []
  for (const line of frame.split(/\r\n|\n|\r/)) {
    if (!line || line.startsWith(":")) continue
    const colon = line.indexOf(":")
    const field = colon < 0 ? line : line.slice(0, colon)
    if (field !== "data") continue
    let value = colon < 0 ? "" : line.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    data.push(value)
  }
  if (!data.length) return null
  const source = data.join("\n")
  if (!source.trim()) return null
  if (source.trim() === "[DONE]") return { type: "stream_done" }
  try {
    const value = JSON.parse(source)
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
    return value
  } catch {
    throw new Error("Comate sent an invalid SSE JSON frame")
  }
}

export async function* events(body) {
  if (!body) return
  const decoder = new TextDecoder()
  let buffer = ""
  const separator = /\r\n\r\n|\n\n|\r\r/
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    for (;;) {
      const match = separator.exec(buffer)
      if (!match) break
      const frame = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)
      const value = sseFrame(frame)
      if (value) yield value
    }
  }
  buffer += decoder.decode()
  const value = sseFrame(buffer)
  if (value) yield value
}

export function newState() {
  return { types: new Map(), seen: new Map() }
}

function novel(state, id, content) {
  if (!id) throw new Error("Comate sent cumulative element content without an element id")
  const previous = state.seen.get(id)
  if (previous === undefined) {
    state.seen.set(id, content)
    return content
  }
  if (content === previous) return ""
  if (content.length < previous.length) throw new Error("Comate shortened cumulative element content")
  if (!content.startsWith(previous)) throw new Error("Comate rewrote cumulative element content")
  state.seen.set(id, content)
  return content.slice(previous.length)
}

function elementPieces(type, value) {
  if (!value) return []
  if (type === "TEXT") return [{ text: value }]
  if (type === "REASON") return [{ reasoning: value }]
  if (type === "EXCEPTION") return [{ exception: value }]
  if (type === "TOOL") throw new Error("Comate emitted a native TOOL element the text adapter cannot translate")
  return []
}

function chunkPieces(chunk, state) {
  if (!chunk || typeof chunk !== "object") return []
  switch (chunk.kind) {
    case "element-add": {
      const element = chunk.element ?? {}
      const id = string(element.id) || string(chunk.eid)
      const type = string(element.type)
      if (!id) throw new Error("Comate added a cumulative element without an id")
      if (!type) throw new Error("Comate added an element without a type")
      if (type) state.types.set(id, type)
      return typeof element.content === "string" ? elementPieces(type, novel(state, id, element.content)) : []
    }
    case "element-patch": {
      const patch = chunk.patch ?? chunk.element ?? {}
      const id = string(patch.id) || string(chunk.eid)
      if (!id) throw new Error("Comate patched a cumulative element without an id")
      const type = string(patch.type) || state.types.get(id) || ""
      if (!type) throw new Error("Comate patched an element before its type was known")
      state.types.set(id, type)
      return typeof patch.content === "string" ? elementPieces(type, novel(state, id, patch.content)) : []
    }
    case "text-delta": {
      const delta = string(chunk.delta)
      const id = string(chunk.eid) || string(chunk.id)
      if (!delta) return []
      if (id) {
        state.types.set(id, "TEXT")
        state.seen.set(id, `${state.seen.get(id) ?? ""}${delta}`)
      }
      return [{ text: delta }]
    }
    case "thinking-delta": {
      const delta = string(chunk.delta)
      const id = string(chunk.eid) || string(chunk.id)
      if (!delta) return []
      if (id) {
        state.types.set(id, "REASON")
        state.seen.set(id, `${state.seen.get(id) ?? ""}${delta}`)
      }
      return [{ reasoning: delta }]
    }
    default:
      if (string(chunk.kind).startsWith("tool-")) {
        throw new Error(`Comate emitted unsupported native tool data (${chunk.kind})`)
      }
      return []
  }
}

export function piecesOf(value, state) {
  if (!value || typeof value !== "object") return []
  if (value.kind === "delta-batch") {
    const out = []
    for (const chunk of Array.isArray(value.chunks) ? value.chunks : []) out.push(...chunkPieces(chunk, state))
    return out
  }
  if (value.type === "task_done") {
    return [{ done: true, status: string(value.status), errorMessage: string(value.errorMessage) }]
  }
  if (value.type === "task_failed") {
    return [{ done: true, status: "failed", errorMessage: string(value.errorMessage) || string(value.error) }]
  }
  if (value.type === "stream_done") return [{ done: true, status: "stream_done", errorMessage: "" }]
  if (typeof value.kind === "string") return chunkPieces(value, state)
  return []
}

function taskError(piece) {
  if (piece.status === "failed" && piece.errorMessage) return piece.errorMessage
  const status = piece.status || "without a status"
  return `Comate task ended ${status}${piece.errorMessage ? `: ${piece.errorMessage}` : ""}`
}

export async function consumeComateSSE(body, handlers = {}) {
  const state = newState()
  const text = []
  const reasoning = []
  const exceptions = []
  let terminal = null

  for await (const value of events(body)) {
    const pieces = piecesOf(value, state)
    for (const piece of pieces) {
      if (piece.text) {
        text.push(piece.text)
        await handlers.onText?.(piece.text)
      } else if (piece.reasoning) {
        reasoning.push(piece.reasoning)
        await handlers.onReasoning?.(piece.reasoning)
      } else if (piece.exception) {
        exceptions.push(piece.exception)
      } else if (piece.done) {
        terminal = piece
        break
      }
    }
    if (terminal) break
  }

  const exception = exceptions.join("")
  if (!terminal) {
    return { ok: false, text: text.join(""), reasoning: reasoning.join(""), error: exception || "Comate stream ended before a terminal task event." }
  }
  if (exception) return { ok: false, text: text.join(""), reasoning: reasoning.join(""), error: exception, terminal }
  if (terminal.status !== "completed") {
    const error = terminal.status === "stream_done" ? "Comate stream ended before a terminal task event." : taskError(terminal)
    return { ok: false, text: text.join(""), reasoning: reasoning.join(""), error, terminal }
  }
  return { ok: true, text: text.join(""), reasoning: reasoning.join(""), error: "", terminal }
}

export async function* comatePieces(body) {
  const state = newState()
  for await (const value of events(body)) {
    const pieces = piecesOf(value, state)
    for (const piece of pieces) {
      yield piece
      if (piece.done || piece.exception) return
    }
  }
  yield { missing: true }
}

export function asToolChoiceError(result) {
  return result?.invalid ? new ProtocolRequestError(`Comate did not produce a valid requested tool call: ${result.invalid}`, 502) : null
}
