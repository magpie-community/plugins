// Reading a request and a reply in each API's own shape (ctx.protocol:
// chat, responses, anthropic, gemini): does the request open a new turn
// (the user typed something, rather than a tool result going back), and
// does the reply end it (the model answered without asking for a tool).

const isObj = (v) => v !== null && typeof v === "object"

// tools: the request offers the model tools. Side calls an agent makes on
// its own (a title, a topic, a quota probe) usually offer none, and must
// neither open nor close a turn.
export function hasTools(body, protocol) {
  if (!isObj(body)) return false
  if (protocol === "gemini") return Array.isArray(body.tools) && body.tools.some((t) => isObj(t) && Object.keys(t).length)
  return Array.isArray(body.tools) && body.tools.length > 0
}

// opensTurn: the newest input is the user's own words, not a tool's result.
export function opensTurn(body, protocol) {
  if (!isObj(body)) return false
  switch (protocol) {
    case "responses": {
      if (typeof body.input === "string") return body.input.trim() !== ""
      if (!Array.isArray(body.input)) return false
      const last = body.input.at(-1)
      if (!isObj(last)) return false
      if (last.type != null && last.type !== "message") return false
      return last.role === "user"
    }
    case "anthropic": {
      const last = Array.isArray(body.messages) ? body.messages.at(-1) : undefined
      if (!isObj(last) || last.role !== "user") return false
      if (typeof last.content === "string") return true
      return Array.isArray(last.content) && !last.content.some((p) => isObj(p) && p.type === "tool_result")
    }
    case "gemini": {
      const last = Array.isArray(body.contents) ? body.contents.at(-1) : undefined
      if (!isObj(last) || (last.role != null && last.role !== "user")) return false
      return Array.isArray(last.parts) && !last.parts.some((p) => isObj(p) && p.functionResponse)
    }
    default: { // chat
      const last = Array.isArray(body.messages) ? body.messages.at(-1) : undefined
      return isObj(last) && last.role === "user"
    }
  }
}

// ending: what a reply says about the turn.
//   { done: true, text }   the model answered and asks for nothing more
//   { done: false }        it asked for a tool, was cut short, or can't be read
export function ending(reply, protocol) {
  if (!isObj(reply) || reply.error) return { done: false }
  switch (protocol) {
    case "responses": {
      if (reply.status != null && reply.status !== "completed") return { done: false }
      if (!Array.isArray(reply.output)) return { done: false }
      if (reply.output.some((i) => isObj(i) && typeof i.type === "string" && i.type.endsWith("_call"))) return { done: false }
      const text = reply.output
        .filter((i) => isObj(i) && i.type === "message" && Array.isArray(i.content))
        .flatMap((i) => i.content.filter((c) => isObj(c) && typeof c.text === "string" && c.type !== "reasoning").map((c) => c.text))
        .join("\n")
      return { done: true, text }
    }
    case "anthropic": {
      if (reply.type === "error") return { done: false }
      if (reply.stop_reason != null && !["end_turn", "stop_sequence"].includes(reply.stop_reason)) return { done: false }
      const parts = Array.isArray(reply.content) ? reply.content : []
      if (parts.some((p) => isObj(p) && (p.type === "tool_use" || p.type === "server_tool_use"))) return { done: false }
      return { done: true, text: parts.filter((p) => isObj(p) && p.type === "text").map((p) => p.text).join("\n") }
    }
    case "gemini": {
      const c = Array.isArray(reply.candidates) ? reply.candidates[0] : undefined
      if (!isObj(c)) return { done: false }
      if (c.finishReason != null && c.finishReason !== "STOP") return { done: false }
      const parts = Array.isArray(c.content?.parts) ? c.content.parts : []
      if (parts.some((p) => isObj(p) && p.functionCall)) return { done: false }
      return { done: true, text: parts.filter((p) => isObj(p) && typeof p.text === "string" && p.thought !== true).map((p) => p.text).join("\n") }
    }
    default: { // chat
      const choice = Array.isArray(reply.choices) ? reply.choices[0] : undefined
      if (!isObj(choice)) return { done: false }
      if (choice.finish_reason != null && choice.finish_reason !== "stop") return { done: false }
      const m = isObj(choice.message) ? choice.message : {}
      if ((Array.isArray(m.tool_calls) && m.tool_calls.length) || m.function_call) return { done: false }
      return { done: true, text: typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p) => p?.text ?? "").join("") : "" }
    }
  }
}

// firstWords: the text of the conversation's first user message, which stays
// the same on every request of one conversation, so it tells two
// conversations in one session apart (an agent and the subagents it starts).
// Only text is read: cache markers and other per-request fields move around.
// "" when the request carries no user message at all.
export function firstWords(body, protocol) {
  if (!isObj(body)) return ""
  const text = (c) => typeof c === "string" ? c
    : Array.isArray(c) ? c.map((p) => typeof p === "string" ? p : isObj(p) && typeof p.text === "string" && p.type !== "tool_result" ? p.text : "").join("\n")
    : ""
  switch (protocol) {
    case "responses": {
      if (typeof body.input === "string") return body.input
      if (!Array.isArray(body.input)) return ""
      const first = body.input.find((i) => isObj(i) && (i.type == null || i.type === "message") && i.role === "user")
      return first ? text(first.content) : ""
    }
    case "gemini": {
      const first = Array.isArray(body.contents) ? body.contents.find((c) => isObj(c) && (c.role == null || c.role === "user")) : undefined
      return first && Array.isArray(first.parts) ? first.parts.map((p) => isObj(p) && typeof p.text === "string" ? p.text : "").join("\n") : ""
    }
    default: { // anthropic and chat
      const first = Array.isArray(body.messages) ? body.messages.find((m) => isObj(m) && m.role === "user") : undefined
      return first ? text(first.content) : ""
    }
  }
}
