// Mistral's GLM models answer with typed content parts
// (`[{type:"thinking",thinking:[{text}]},{type:"text",text:[{text}]}]`) where
// OpenAI clients expect a string. Written from the behaviour measured against
// the API — not translated from another implementation.

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

// textOf reads the text out of a part's payload: a string, or a list of
// `{text}` items.
function textOf(payload) {
  if (typeof payload === "string") return payload
  if (!Array.isArray(payload)) return ""
  let out = ""
  for (const item of payload) if (isObject(item) && typeof item.text === "string") out += item.text
  return out
}

// splitParts turns typed parts into the two strings OpenAI clients read:
// visible text, and the model's thinking.
export function splitParts(parts) {
  let text = ""
  let thinking = ""
  if (!Array.isArray(parts)) return { text: parts, thinking: null }
  for (const part of parts) {
    if (!isObject(part)) continue
    if (part.type === "thinking") thinking += textOf(part.thinking)
    else if (part.type === "text") text += textOf(part.text)
  }
  return { text, thinking: thinking || null }
}

// rewriteTurn fixes one choice's `message` or `delta` in place, and records
// that tool calls were seen so a later `stop` can be reported as
// `tool_calls` — the reason clients dispatch on.
export function rewriteTurn(choice, seen = { toolCalls: false }) {
  const turn = choice?.delta ?? choice?.message
  if (isObject(turn)) {
    if (Array.isArray(turn.content)) {
      const { text, thinking } = splitParts(turn.content)
      turn.content = text
      if (thinking) turn.reasoning_content = thinking
    }
    if (Array.isArray(turn.tool_calls) && turn.tool_calls.length > 0) seen.toolCalls = true
    if (seen.toolCalls && choice.finish_reason === "stop") choice.finish_reason = "tool_calls"
  }
  return choice
}

// rewritePayload rewrites a whole JSON body. `/v1/responses` bodies carry no
// `choices` and go as they came.
export function rewritePayload(body, seen = { toolCalls: false }) {
  if (!isObject(body) || !Array.isArray(body.choices)) return body
  for (const choice of body.choices) rewriteTurn(choice, seen)
  return body
}

// rewriteEvent rewrites one SSE event, framing included. A payload that does
// not parse (a cut event) or is `[DONE]` is left exactly as it was.
export function rewriteEvent(event, seen = { toolCalls: false }) {
  const framed = /^([\s\S]*?)(\r?\n\r?\n)$/.exec(event)
  const body = framed ? framed[1] : event
  const gap = framed ? framed[2] : ""
  const newline = body.includes("\r\n") ? "\r\n" : "\n"
  const lines = body.split(/\r?\n/)
  let touched = false
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("data:")) continue
    const payload = lines[i].slice(5).trimStart()
    if (!payload || payload === "[DONE]") continue
    let parsed
    try {
      parsed = JSON.parse(payload)
    } catch {
      continue
    }
    if (!isObject(parsed)) continue
    const before = JSON.stringify(parsed)
    rewritePayload(parsed, seen)
    if (JSON.stringify(parsed) !== before) {
      lines[i] = `data: ${JSON.stringify(parsed)}`
      touched = true
    }
  }
  return touched ? lines.join(newline) + gap : event
}

// rewriteStream passes a streamed reply through, rewriting each event as it
// arrives so the deltas (and the streaming itself) stay intact.
export function rewriteStream(response) {
  if (!response.body) return response
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const upstream = response.body.getReader()
  const seen = { toolCalls: false }
  let pending = ""

  const body = new ReadableStream({
    async pull(controller) {
      const { done, value } = await upstream.read()
      if (done) {
        if (pending) controller.enqueue(encoder.encode(rewriteEvent(pending, seen)))
        controller.close()
        return
      }
      pending += decoder.decode(value, { stream: true })
      for (;;) {
        const gap = /\r?\n\r?\n/.exec(pending)
        if (!gap) break
        const end = gap.index + gap[0].length
        controller.enqueue(encoder.encode(rewriteEvent(pending.slice(0, end), seen)))
        pending = pending.slice(end)
      }
    },
    cancel(reason) {
      return upstream.cancel(reason)
    },
  })

  // The body is no longer the upstream's bytes: a content-encoding or length
  // kept from it would describe the old ones.
  const headers = new Headers(response.headers)
  headers.delete("content-encoding")
  headers.delete("content-length")
  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}
