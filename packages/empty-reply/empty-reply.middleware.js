// empty-reply.middleware.js
//
// Some chat models return reasoning and nothing else. magpie translates that
// to end_turn (Anthropic) or response.completed (Responses), the agent thinks
// the turn is done, and stops. Drop the end events and the client retries.
//
// Middleware runs after routing, so it can't start another upstream itself.
// With routing "rotate" the retry lands on the next member; with a fixed
// order it lands on the same one. Gateway-side fix: yetone/magpie#3358.

const note = "empty reply from the model (no text; try again)"

// Text, refusals and tool calls are answers. Reasoning is not; a reply made
// of reasoning alone is exactly what we're catching. Unknown part types
// count as answers, so new tool-call shapes keep working.
function hasAnswer(p) {
  if (!p) return false
  switch (p.type) {
    case "text":
    case "output_text":
      return !!p.text
    case "refusal":
      return !!p.refusal
    case "thinking":
    case "redacted_thinking":
    case "reasoning":
    case "summary_text":
    case "reasoning_text":
      return false
    case "message":
      return (p.content || []).some(hasAnswer)
  }
  return true
}

function contentHasAnswer(content) {
  return (content || []).some(hasAnswer)
}

function outputHasAnswer(resp) {
  return ((resp && resp.output) || []).some(hasAnswer)
}

// Tracks one Anthropic stream; an event it returns true for gets dropped.
// Only end_turn is hidden. max_tokens and refusal come from the model and
// are left alone.
function anthropic(ev, s) {
  switch (ev.type) {
    case "content_block_start":
      if (hasAnswer(ev.content_block)) s.answered = true
      return false
    case "content_block_delta": {
      const d = ev.delta || {}
      if (d.type === "text_delta") {
        if (d.text) s.answered = true
      } else if (d.type !== "thinking_delta" && d.type !== "signature_delta") {
        s.answered = true
      }
      return false
    }
    case "message_delta":
      if (!s.answered && (ev.delta || {}).stop_reason === "end_turn") {
        s.empty = true
        return true
      }
      return false
    case "message_stop":
      return !!s.empty
  }
  return false
}

// Same for a Responses stream. The output on response.completed is checked
// too: a completed that carries the text without the deltas still counts.
function responses(ev, s) {
  switch (ev.type) {
    case "response.output_item.added":
    case "response.output_item.done":
      if (hasAnswer(ev.item)) s.answered = true
      return false
    case "response.content_part.added":
    case "response.content_part.done":
      if (hasAnswer(ev.part)) s.answered = true
      return false
    case "response.output_text.delta":
      if (ev.delta) s.answered = true
      return false
    case "response.function_call_arguments.delta":
    case "response.custom_tool_call_input.delta":
    case "response.mcp_call_arguments.delta":
      s.answered = true
      return false
    case "response.completed": {
      // incomplete means max_output_tokens or a filter: not our business
      if ((ev.response || {}).status === "incomplete") return false
      if (!s.answered && !outputHasAnswer(ev.response)) {
        s.empty = true
        return true
      }
      return false
    }
  }
  return false
}

// undefined keeps an event, null drops it. The agent then sees the stream
// end early, which is retryable; end_turn would have finished the turn.
export function onEvent(ev, ctx) {
  const s = ctx.state
  if (!s) return undefined
  let drop = false
  if (ctx.protocol === "responses") drop = responses(ev, s)
  else if (ctx.protocol === "anthropic") drop = anthropic(ev, s)
  return drop ? null : undefined
}

// Whole replies (no streaming) get an error body instead. Middleware can't
// set the status code, so Responses goes back with status "failed".
export function onResponse(body, ctx) {
  if (!body) return undefined
  if (ctx.protocol === "anthropic" && body.type === "message" && body.stop_reason === "end_turn" && !contentHasAnswer(body.content)) {
    return { type: "error", error: { type: "api_error", message: note } }
  }
  if (ctx.protocol === "responses" && body.status === "completed" && !outputHasAnswer(body)) {
    return { ...body, status: "failed", error: { code: "empty_reply", message: note } }
  }
  return undefined
}
