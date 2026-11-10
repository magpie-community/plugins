// What a reply has to look like for an OpenAI-shaped client, written from the
// shape Mistral sends: GLM's typed content parts, and tool calls whose stream
// still ends "stop".

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

// readParts splits typed parts into visible text and the model's thinking.
// A part's payload is a string or a list of `{text}` items.
function readParts(parts) {
  return parts.reduce(
    (out, part) => {
      if (!isPlainObject(part)) return out
      const payload = part.type === "thinking" ? part.thinking : part.type === "text" ? part.text : null
      if (payload == null) return out
      const text = typeof payload === "string" ? payload : Array.isArray(payload) ? payload.map((item) => (isPlainObject(item) && typeof item.text === "string" ? item.text : "")).join("") : ""
      if (part.type === "thinking") out.thinking += text
      else out.text += text
      return out
    },
    { text: "", thinking: "" },
  )
}

// ReplyFixer rewrites one reply. It remembers whether tool calls were seen, so
// the turn's finish reason can say so.
export class ReplyFixer {
  #toolCalls = false

  #fixTurn(turn) {
    if (!isPlainObject(turn)) return
    if (Array.isArray(turn.content)) {
      const { text, thinking } = readParts(turn.content)
      turn.content = text
      if (thinking) turn.reasoning_content = thinking
    }
    if (Array.isArray(turn.tool_calls) && turn.tool_calls.length > 0) this.#toolCalls = true
  }

  // fixChoice rewrites one choice's message or delta.
  fixChoice(choice) {
    if (!isPlainObject(choice)) return choice
    this.#fixTurn(choice.delta ?? choice.message)
    if (this.#toolCalls && choice.finish_reason === "stop") choice.finish_reason = "tool_calls"
    return choice
  }

  // fixBody rewrites a whole JSON reply; a body with no choices (a
  // /v1/responses reply) is left alone.
  fixBody(body) {
    if (isPlainObject(body) && Array.isArray(body.choices)) for (const choice of body.choices) this.fixChoice(choice)
    return body
  }

  // fixEvent rewrites one SSE event, framing kept. A payload that doesn't
  // parse (a cut event) or `[DONE]` is returned exactly as it came.
  fixEvent(event) {
    const framed = /^([\s\S]*?)(\r?\n\r?\n)$/.exec(event)
    const block = framed ? framed[1] : event
    const gap = framed ? framed[2] : ""
    const lines = block.split(/\r?\n/)
    let changed = false
    lines.forEach((line, index) => {
      if (!line.startsWith("data:")) return
      const payload = line.slice(5).trimStart()
      if (payload === "" || payload === "[DONE]") return
      let parsed
      try {
        parsed = JSON.parse(payload)
      } catch {
        return
      }
      if (!isPlainObject(parsed)) return
      const before = JSON.stringify(parsed)
      this.fixBody(parsed)
      if (JSON.stringify(parsed) !== before) {
        lines[index] = `data: ${JSON.stringify(parsed)}`
        changed = true
      }
    })
    return changed ? lines.join(block.includes("\r\n") ? "\r\n" : "\n") + gap : event
  }

  // fixStream passes a streamed reply through, rewriting each event as it
  // arrives.
  fixStream(response) {
    if (!response.body) return response
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    const reader = response.body.getReader()
    let buffered = ""

    const drain = (controller) => {
      for (;;) {
        const gap = /\r?\n\r?\n/.exec(buffered)
        if (!gap) return
        const end = gap.index + gap[0].length
        controller.enqueue(encoder.encode(this.fixEvent(buffered.slice(0, end))))
        buffered = buffered.slice(end)
      }
    }

    const body = new ReadableStream({
      pull: async (controller) => {
        const { done, value } = await reader.read()
        if (done) {
          if (buffered) controller.enqueue(encoder.encode(this.fixEvent(buffered)))
          controller.close()
          return
        }
        buffered += decoder.decode(value, { stream: true })
        drain(controller)
      },
      cancel: (reason) => reader.cancel(reason),
    })

    // The bytes are no longer the upstream's, so its encoding and length
    // would describe the wrong body.
    const headers = new Headers(response.headers)
    headers.delete("content-encoding")
    headers.delete("content-length")
    return new Response(body, { status: response.status, statusText: response.statusText, headers })
  }
}

// fixReply rewrites one buffered reply.
export function fixReply(body) {
  return new ReplyFixer().fixBody(body)
}
