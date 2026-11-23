// The OpenAI-compatible face of the relay: the reply shapes /v1/chat/
// completions answers with. The relay's ask returns the whole reply at
// once ({ text, reasoning }), so the stream here is the aggregation sent
// as SSE chunks — the way a buffered upstream is proxied — not a
// token-by-token pipe. Magpie's SDK reads both.
//
// Reasoning goes first as its own delta (reasoning_content), then the
// text, then the finish chunk with usage. [DONE] closes the stream, as
// OpenAI's clients expect.
//
// Tool calls ride the ```tool_call fence the request-side prompt taught
// (prompt.mjs): the final text is scanned for those fences, each becomes
// one OpenAI tool_call, and the remaining text is the content. A reply
// that is only fences answers with content null and finish_reason
// "tool_calls", exactly the OpenAI shape.

const now = () => Math.floor(Date.now() / 1000)

// parseToolCalls extracts every ```tool_call fence from a reply. The
// fence carries one JSON object {"name":…,"arguments":…}; a fence whose
// JSON does not parse keeps its raw text as the arguments string (the
// caller can still see what the model wrote). Anything outside the
// fences is returned as the remaining text.
export function parseToolCalls(text) {
  const calls = []
  const rest = []
  const re = /```tool_call\s*\n([\s\S]*?)```/g
  let last = 0
  for (const m of text.matchAll(re)) {
    rest.push(text.slice(last, m.index))
    last = m.index + m[0].length
    const raw = m[1].trim()
    let name = ""
    let args = ""
    try {
      const obj = JSON.parse(raw)
      name = String(obj?.name ?? "")
      args = typeof obj?.arguments === "string" ? obj.arguments : JSON.stringify(obj?.arguments ?? {})
    } catch {
      // not JSON: keep the raw fence text as the arguments payload
      name = ""
      args = raw
    }
    if (name || args) calls.push({ name, arguments: args })
  }
  rest.push(text.slice(last))
  // the prose between fences is trimmed and re-joined: the fences leave
  // their surrounding newlines behind, and the content should not carry
  // the gaps
  return { calls, text: rest.map((s) => s.trim()).filter(Boolean).join("\n") }
}

const newCallId = () => "call_" + Math.random().toString(36).slice(2, 14)

// openAIToolCalls shapes the parsed fences as OpenAI tool_calls.
function openAIToolCalls(calls) {
  return calls.map((c) => ({
    id: newCallId(),
    type: "function",
    function: { name: c.name, arguments: c.arguments },
  }))
}

// chunk is one SSE chunk in OpenAI's shape
function chunk(id, model, delta, { finish } = {}) {
  return {
    id,
    object: "chat.completion.chunk",
    created: now(),
    model,
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  }
}

// completion builds the whole chat.completion body. final is the relay's
// { text, reasoning }; promptTokens is the caller's estimate for the
// request's flattened prompt (index.mjs: prompt.length / 3, the same
// characters-over-three the reply is estimated with — the web app reports
// no token counts of its own).
export function completion({ id, model, final, promptTokens = 0 }) {
  const parsed = parseToolCalls(final?.text ?? "")
  const reasoning = final?.reasoning ?? ""
  const calls = parsed.calls.length ? openAIToolCalls(parsed.calls) : null
  const text = parsed.text
  const completionTokens = Math.ceil((text.length + reasoning.length) / 3)
  return {
    id,
    object: "chat.completion",
    created: now(),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          // a pure tool-call reply answers with null content, as OpenAI does
          content: calls ? (text || null) : text,
          // both spellings: some SDKs read reasoning_content, some
          // reasoning — the text is identical, so both ride along
          ...(reasoning ? { reasoning_content: reasoning, reasoning } : {}),
          ...(calls ? { tool_calls: calls } : {}),
        },
        finish_reason: calls ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: Math.max(0, promptTokens | 0),
      completion_tokens: completionTokens,
      total_tokens: Math.max(0, promptTokens | 0) + completionTokens,
    },
  }
}

// sse answers the streamed form. ask(onUpdate, signal) runs the relay
// turn; onUpdate({ text, reasoning }) may fire more than once, and each
// longer text becomes one delta (the relay's page fetch is already
// streamed server-side; the wrapper emits the pieces as they are read).
// The reply closes with the finish chunk and [DONE], as OpenAI's SSE
// clients expect. An ask failure rejects here — before any stream is
// returned — so the caller's error mapping (index.mjs) answers a JSON
// error instead of a silently empty 200.
export async function sse({ id, model, promptTokens, ask, signal }) {
  const enc = new TextEncoder()
  let text = ""
  let reasoning = ""
  const deltas = [] // the pieces emitted while ask runs
  const final = await ask(({ text: t, reasoning: r } = {}) => {
    if (typeof r === "string" && r.length > reasoning.length) reasoning = r
    const grew = typeof t === "string" && t.length > text.length
    // reasoning may grow on its own (the model thinking longer without new
    // text): it still streams, as its own delta
    if (!grew && reasoning.length > (deltas.at(-1)?.reasoning_content ?? "").length)
      deltas.push({ reasoning_content: reasoning })
    if (grew) {
      deltas.push({ reasoning_content: reasoning, content: t.slice(text.length) })
      text = t
    }
  }, signal)
  // the relay's ask resolves with the whole reply; fold it in, in case
  // onUpdate never fired or fired short of the end
  const t = final?.text ?? ""
  const r = final?.reasoning ?? ""
  if (r.length > reasoning.length) reasoning = r
  if (t.length > text.length) {
    deltas.push({ reasoning_content: reasoning, content: t.slice(text.length) })
    text = t
  }
  // tool calls are read from the whole final text once the turn is done:
  // a fence may span the deltas, so it is parsed here, not per delta
  const parsed = parseToolCalls(text)
  const calls = parsed.calls.length ? openAIToolCalls(parsed.calls) : null
  // promptTokens arrives as the caller's function (index.mjs) — call it
  // here, at the same moment the JSON path would
  const usage = usageOf(typeof promptTokens === "function" ? promptTokens() : promptTokens, parsed.text, reasoning)
  const stream = new ReadableStream({
    start(controller) {
      const send = (obj) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`))
      for (const d of deltas) send(chunk(id, model, d))
      if (calls)
        // each tool call arrives as its own delta, the way OpenAI's
        // streamed tool calls do: index counts them, the first carries
        // id and name, the arguments ride their own field
        for (const [i, c] of calls.entries())
          send(chunk(id, model, { tool_calls: [{ index: i, id: c.id, type: c.type, function: c.function }] }))
      // the finish chunk goes out twice, as quick's relay does: the
      // first closes the content, the second rides the usage block for
      // the SDKs that read it there
      send(chunk(id, model, {}, { finish: calls ? "tool_calls" : "stop" }))
      send({ ...chunk(id, model, {}, { finish: calls ? "tool_calls" : "stop" }), usage })
      controller.enqueue(enc.encode("data: [DONE]\n\n"))
      controller.close()
    },
    // a client hanging up must not keep the relay generating for it
    cancel() {
      try { signal?.abort?.() } catch {}
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  })
}

// usageOf estimates the token counts (characters over three, as index.mjs
// does for the prompt): the web app reports none of its own
function usageOf(promptTokens, text, reasoning) {
  const prompt = Math.max(0, promptTokens | 0)
  const completion = Math.ceil((text.length + reasoning.length) / 3)
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
}
