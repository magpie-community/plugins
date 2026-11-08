// Mistral's GLM models answer with typed content parts
// (`[{type:"thinking",thinking:[{text}]},{type:"text",text:[{text}]}]`) where
// OpenAI clients expect a string. Ported from mistral-gateway's
// normalize_content_chunks / normalize_stream_event / normalize_completion.

export function flattenContent(content) {
  if (!Array.isArray(content)) return { text: content, reasoning: null }
  const texts = []
  const thinking = []
  for (const part of content) {
    if (!part || typeof part !== "object") continue
    if (part.type === "thinking") {
      for (const item of Array.isArray(part.thinking) ? part.thinking : []) {
        if (item && typeof item === "object") thinking.push(item.text ?? "")
      }
    } else if (part.type === "text") {
      if (typeof part.text === "string") texts.push(part.text)
      else if (Array.isArray(part.text)) {
        for (const item of part.text) {
          if (item && typeof item === "object") texts.push(item.text ?? "")
        }
      }
    }
  }
  return { text: texts.join(""), reasoning: thinking.length ? thinking.join("") : null }
}

// A choice's `message` (non-streamed) or `delta` (streamed) put in OpenAI's
// shape. A GLM stream that deltas tool calls but ends "stop" is ended
// "tool_calls", which is what clients dispatch on.
export function normalizeChoice(choice, state = {}) {
  const part = choice?.delta ?? choice?.message
  if (part && typeof part === "object") {
    if (Array.isArray(part.content)) {
      const { text, reasoning } = flattenContent(part.content)
      part.content = text
      if (reasoning) part.reasoning_content = reasoning
    }
    if (Array.isArray(part.tool_calls) && part.tool_calls.length) state.sawToolCall = true
    if (state.sawToolCall && choice.finish_reason === "stop") choice.finish_reason = "tool_calls"
  }
  return choice
}

export function normalizeJson(parsed, state = {}) {
  if (!parsed || typeof parsed !== "object") return parsed
  // /v1/responses streams and payloads carry a `response` wrapper or `output`,
  // not `choices`; those go as they came.
  if (Array.isArray(parsed.choices)) for (const choice of parsed.choices) normalizeChoice(choice, state)
  return parsed
}

// rewriteEvent turns one SSE event (its framing included) into the OpenAI
// shape. Events whose data isn't a JSON object — `[DONE]`, a comment, a cut
// payload — are returned as they came.
export function rewriteEvent(event, state = {}) {
  const frame = /^(.*?)(\r?\n\r?\n)$/s.exec(event)
  const body = frame ? frame[1] : event
  const separator = frame ? frame[2] : ""
  const lines = body.split(/\r?\n/)
  let changed = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).replace(/^ /, "")
    if (!payload || payload === "[DONE]") continue
    let parsed
    try {
      parsed = JSON.parse(payload)
    } catch {
      continue // a cut event's payload: leave the stream as it is
    }
    if (!parsed || typeof parsed !== "object") continue
    const before = JSON.stringify(parsed)
    normalizeJson(parsed, state)
    if (JSON.stringify(parsed) !== before) {
      lines[i] = `data: ${JSON.stringify(parsed)}`
      changed = true
    }
  }
  return changed ? lines.join(body.includes("\r\n") ? "\r\n" : "\n") + separator : event
}

// normalizeSseStream rewrites a whole event stream as it arrives, keeping the
// delta boundaries (and therefore the streaming UX) intact.
export function normalizeSseStream(response) {
  if (!response.body) return response
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const reader = response.body.getReader()
  const state = { sawToolCall: false }
  let buffered = ""

  const flushEvents = (controller) => {
    const SEP = /\r?\n\r?\n/
    let match
    while ((match = SEP.exec(buffered)) !== null) {
      const end = match.index + match[0].length
      controller.enqueue(encoder.encode(rewriteEvent(buffered.slice(0, end), state)))
      buffered = buffered.slice(end)
    }
  }

  const body = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) {
        if (buffered) {
          controller.enqueue(encoder.encode(rewriteEvent(buffered, state)))
          buffered = ""
        }
        controller.close()
        return
      }
      buffered += decoder.decode(value, { stream: true })
      flushEvents(controller)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })

  const headers = new Headers(response.headers)
  headers.delete("content-length")
  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}
