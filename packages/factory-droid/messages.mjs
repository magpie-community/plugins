import { randomUUID } from "node:crypto"
import { failure } from "./acp.mjs"

const invalid = (message) => failure(400, message)
const text = (value) => ({ type: "text", text: value })

export function contentParts(content, inToolResult = false) {
  if (typeof content === "string") return [text(content)]
  if (!Array.isArray(content)) throw invalid("Expected text or an array of message content blocks.")
  return content.flatMap((block) => {
    if (typeof block === "string") return [text(block)]
    switch (block?.type) {
      case "tool_addition":
      case "tool_removal": return [] // The request's tools array is authoritative.
      case "tool_reference":
        if (typeof block.tool_name === "string") return [text("Loaded tool: " + block.tool_name)]
        break
      case "search_result":
        return [text([block.title, block.source].filter(Boolean).join(" ") + "\n"), ...contentParts(block.content ?? "")]
      case "document": {
        const source = block.source
        let parts
        if (source?.type === "text" && typeof source.data === "string") parts = [text(source.data)]
        if (source?.type === "content") parts = contentParts(source.content, inToolResult)
        if (source?.type === "url" && /^https?:\/\//i.test(source.url)) parts = [text("Document URL (contents not attached): " + source.url)]
        if (source?.type === "base64" && typeof source.data === "string") {
          if (/^(?:text\/|application\/(?:[\w.+-]+\+)?(?:json|xml)(?:;|$))/i.test(source.media_type)) {
            try { parts = [text(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(source.data, "base64")))] }
            catch { throw invalid("Invalid UTF-8 text document.") }
          } else if (inToolResult) parts = [text("[Binary tool document omitted: " + source.media_type + "]")]
        }
        if (!parts) throw invalid("Droid requires document text, a URL, or pages supplied as images.")
        return block.title ? [text(block.title + "\n"), ...parts] : parts
      }
      case "text":
        if (typeof block.text === "string") return [text(block.text)]
        break
      case "image":
        if (block.source?.type === "base64" && block.source.data && block.source.media_type) {
          return [{ type: "image", data: block.source.data, mimeType: block.source.media_type }]
        }
        break
      case "tool_use":
        if (typeof block.id !== "string" || !block.id || typeof block.name !== "string" || !block.name) break
        return [text(JSON.stringify({ tool_use: block.name, id: block.id, input: block.input }))]
      case "tool_result":
        if (typeof block.tool_use_id !== "string" || !block.tool_use_id) throw invalid("tool_result requires a tool_use_id.")
        return [text(JSON.stringify({ tool_result: block.tool_use_id, is_error: !!block.is_error })), ...contentParts(block.content ?? "", true)]
      case "thinking":
      case "redacted_thinking": return []
    }
    throw invalid(`Unsupported message content: ${block?.type ?? "unknown"}.`)
  })
}

export function messageParts(message) {
  if (!["user", "assistant", "system", "developer"].includes(message?.role)) throw invalid("Unknown message role.")
  const parts = contentParts(message.content)
  return parts.length ? [text(`\n${message.role}:\n`), ...parts] : []
}

export function hasPrefill(messages) {
  const last = messages.at(-1)
  return last?.role === "assistant" && (typeof last.content === "string" ||
    Array.isArray(last.content) && last.content.length > 0 && last.content.every(b => b?.type === "text"))
}

export function promptParts(messages, prefill = hasPrefill(messages)) {
  return messages.flatMap((m, i) => prefill && i === messages.length - 1
    ? [text("\nContinue the following assistant response from its last character. Return only the continuation.\n"), ...contentParts(m.content)]
    : messageParts(m))
}

// Keep the current turn intact. Remove only complete older exchanges, and
// preserve system and developer instructions in their original positions.
export function replayPrompt(body, prepared) {
  const size = parts => parts.reduce((n, p) => n + Buffer.byteLength(p.text ?? p.data ?? ""), 0)
  const configured = Number(process.env.FACTORY_DROID_REPLAY_BYTES)
  const budget = Number.isSafeInteger(configured) && configured > 0 ? configured : 4 * 1024 * 1024
  if (size(prepared.prompt) <= budget) return prepared.prompt
  const rounds = []
  let current = []
  for (const m of body.messages) {
    if (m.role === "user" && !(Array.isArray(m.content) && m.content.some(b => b?.type === "tool_result"))) {
      if (current.length) rounds.push(current)
      current = []
    }
    current.push(m)
  }
  if (!rounds.length) return prepared.prompt
  const fixed = m => m.role === "system" || m.role === "developer"
  const system = body.system ? [text("\nSystem instructions:\n"), ...contentParts(body.system)] : []
  const note = text("\n[Earlier exchanges were omitted to fit the replay budget.]\n")
  const last = promptParts(current)
  let remain = budget - size(system) - size(last) - size([note])
  const parts = rounds.map(round => round.map(m => ({ fixed: fixed(m), parts: messageParts(m) })))
  for (const round of parts) for (const m of round) if (m.fixed) remain -= size(m.parts)
  let first = parts.length
  while (first > 0) {
    const cost = parts[first - 1].reduce((n, m) => n + (m.fixed ? 0 : size(m.parts)), 0)
    if (cost > remain) break
    remain -= cost
    first--
  }
  if (!first) return prepared.prompt
  return [...system, note, ...parts.flatMap((round, i) => round.flatMap(m => i >= first || m.fixed ? m.parts : [])), ...last]
}

export function prepare(body) {
  if (typeof body?.model !== "string" || !body.model.trim()) throw invalid("A model ID is required.")
  if (!Array.isArray(body.messages) || !body.messages.length) throw invalid("messages must be a non-empty array.")
  const choice = body.tool_choice?.type ?? "auto"
  if (!["none", "auto", "any", "tool"].includes(choice)) throw invalid("Unsupported tool_choice.")
  if (body.tools != null && !Array.isArray(body.tools)) throw invalid("tools must be an array.")
  const tools = (body.tools ?? []).filter((tool) => choice !== "none" && (choice !== "tool" || tool?.name === body.tool_choice.name)).map((tool) => {
    if (typeof tool?.name !== "string" || !tool.name.trim() || tool.input_schema?.type !== "object") throw invalid("Droid requires named tools with an object input_schema.")
    return { name: tool.name, description: tool.description ?? "", inputSchema: tool.input_schema }
  })
  const required = choice === "tool" || choice === "any"
  if (required && !tools.length) throw invalid("The required tool is missing from tools.")
  const prompt = (body.system ? [text("\nSystem instructions:\n"), ...contentParts(body.system)] : []).concat(promptParts(body.messages))
  return { prompt, tools, required }
}

export function estimateTokens({ prompt, tools }) {
  // Approximate text from UTF-8 bytes. Image cost depends on the model and size.
  const bytes = prompt.reduce((total, part) => total + (part.type === "image" ? 6400 : Buffer.byteLength(part.text)), 0)
  return Math.max(1, Math.ceil((bytes + Buffer.byteLength(JSON.stringify(tools))) / 4))
}

export function errorBody(error) {
  const type = ({ 400: "invalid_request_error", 401: "authentication_error", 429: "rate_limit_error" })[error.status] ?? "api_error"
  return { type: "error", error: { type, message: error.message || String(error) } }
}

// Translate a single sequence of ACP chunks for both Anthropic transports.
export function messagesResponse({ body, signal, run, close, cancel = close, id = "msg_" + randomUUID() }) {
  const encoder = new TextEncoder()
  const message = { id, type: "message", role: "assistant", model: body.model,
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
  let controller, active, index = -1, cancelled = false
  function emit(type, fields) {
    if (controller && !cancelled) controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`))
  }
  function stopBlock() {
    if (active) emit("content_block_stop", { index })
    active = undefined
  }
  function startBlock(block) {
    stopBlock()
    active = block
    index++
    if (!body.stream) message.content.push(block)
    emit("content_block_start", { index, content_block: block })
  }
  function chunk(type, value) {
    if (!value) return
    if (type === "thinking" && body.thinking?.type === "disabled") return
    if (active?.type !== type) startBlock({ type, [type]: "" })
    if (!body.stream) active[type] += value
    emit("content_block_delta", { index, delta: { type: type + "_delta", [type]: value } })
  }
  async function respond() {
    try {
      emit("message_start", { message })
      const { reason, usage, tools = [] } = await run(chunk)
      signal?.throwIfAborted()
      for (const tool of tools) {
        startBlock({ type: "tool_use", id: tool.id, name: tool.name, input: {} })
        if (!body.stream) active.input = tool.input
        emit("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } })
      }
      stopBlock()
      message.stop_reason = reason
      message.usage = { input_tokens: usage?.inputTokens ?? 0, output_tokens: usage?.outputTokens ?? 0 }
      if (usage?.cacheReadTokens) message.usage.cache_read_input_tokens = usage.cacheReadTokens
      if (usage?.cacheCreationTokens) message.usage.cache_creation_input_tokens = usage.cacheCreationTokens
      emit("message_delta", { delta: { stop_reason: reason, stop_sequence: null }, usage: message.usage })
      emit("message_stop", {})
      if (!controller) return Response.json(message)
    } catch (err) {
      if (!controller) throw err
      emit("error", errorBody(err))
    } finally {
      close()
      if (controller && !cancelled) controller.close()
    }
  }
  if (!body.stream) return respond()
  return new Response(new ReadableStream({
    start(c) { controller = c; void respond() },
    cancel() { cancelled = true; cancel() },
  }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } })
}
