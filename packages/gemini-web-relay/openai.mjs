// The OpenAI-compatible face of the relay: the reply shapes /v1/chat/
// completions answers with. The relay's ask returns the whole reply at
// once ({ text, reasoning }), so the stream here is the aggregation sent
// as SSE chunks — the way a buffered upstream is proxied — not a
// token-by-token pipe. Magpie's SDK reads both.
//
// Reasoning goes first as its own delta (reasoning_content), then the
// text, then the finish chunk with usage. [DONE] closes the stream, as
// OpenAI's clients expect.

const now = () => Math.floor(Date.now() / 1000)

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
export function completion({ id, model, final, promptTokens = 0, newId }) {
  const text = final?.text ?? ""
  const reasoning = final?.reasoning ?? ""
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
          content: text,
          // both spellings: some SDKs read reasoning_content, some
          // reasoning — the text is identical, so both ride along
          ...(reasoning ? { reasoning_content: reasoning, reasoning } : {}),
        },
        finish_reason: "stop",
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
// longer text goes out as one delta (the relay's page fetch is already
// streamed server-side; the wrapper emits the pieces as they are read).
// The reply closes with the finish chunk and [DONE], as OpenAI's SSE
// clients expect. An ask failure closes the stream short and rethrows so
// the caller's error mapping (index.mjs) can answer a JSON error instead.
export async function sse({ id, model, promptTokens, newId, ask, signal }) {
  const enc = new TextEncoder()
  let text = ""
  let reasoning = ""
  let failure = null
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`))
      try {
        const final = await ask(({ text: t, reasoning: r } = {}) => {
          if (typeof r === "string" && r.length > reasoning.length) reasoning = r
          if (typeof t === "string" && t.length > text.length) {
            send(chunk(id, model, { reasoning_content: reasoning, content: t.slice(text.length) }))
            text = t
          }
        }, signal)
        // the relay's ask resolves with the whole reply; if onUpdate never
        // fired (or fired short), emit what is still missing once
        const t = final?.text ?? ""
        const r = final?.reasoning ?? ""
        if (r.length > reasoning.length) reasoning = r
        if (t.length > text.length) {
          send(chunk(id, model, { reasoning_content: reasoning, content: t.slice(text.length) }))
          text = t
        }
        // the finish chunk goes out twice, as quick's relay does: the
        // first carries nothing (some SDKs read it as content's end), the
        // second rides the usage block for those that read it there
        send(chunk(id, model, {}, { finish: "stop" }))
        send({ ...chunk(id, model, {}, { finish: "stop" }), usage: usageOf(promptTokens, text, reasoning) })
        controller.enqueue(enc.encode("data: [DONE]\n\n"))
        controller.close()
      } catch (e) {
        failure = e
        try { controller.close() } catch {}
      }
    },
  })
  const res = new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  })
  if (failure) throw failure
  return res
}

// usageOf estimates the token counts (characters over three, as index.mjs
// does for the prompt): the web app reports none of its own
function usageOf(promptTokens, text, reasoning) {
  const prompt = Math.max(0, promptTokens | 0)
  const completion = Math.ceil((text.length + reasoning.length) / 3)
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
}
