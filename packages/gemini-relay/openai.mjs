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
// turn; onUpdate({ text, reasoning }) fires as the page reads each frame,
// and every growth of the running text becomes one delta. The Response is
// returned the moment the FIRST delta arrives (the old gemini-web plugin's
// way, openai.mjs:64): magpie's first-token deadline starts counting from
// the returned response, so a slow generation past 60 s no longer reads
// as "no answer" — the stream is already open and speaking. A failure
// before the first delta still rejects here, so the caller's error mapping
// (index.mjs) answers a JSON error instead of a silently empty 200.
export async function sse({ id, model, promptTokens, ask, signal }) {
  const enc = new TextEncoder()
  let text = ""
  let reasoning = ""
  let ctl = null
  let ended = false
  let failure = null
  let begun = false // the first delta has been sent (or ask has finished)
  // resolves when the first delta lands (or a fast failure — auth, model
  // refused, 429 — is already in). The promise exists before run starts,
  // so an onUpdate fired synchronously inside ask still trips it (the old
  // plugin's way, openai.mjs:75); the interval is only the backstop for a
  // run that failed before any delta.
  let onFirst
  const first = new Promise((r) => {
    const t = setInterval(() => { if (ended || failure) { clearInterval(t); r() } }, 100)
    onFirst = () => { clearInterval(t); r() }
  })
  // a client hanging up must not keep the relay generating for it
  const abort = new AbortController()
  const both = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
  // deltas that land before the Response is returned buffer here and are
  // flushed into the stream at start (the old plugin's way, openai.mjs:76)
  const buf = []
  const send = (obj) => {
    const b = obj === null ? enc.encode("data: [DONE]\n\n") : enc.encode(`data: ${JSON.stringify(obj)}\n\n`)
    if (ctl) ctl.enqueue(b)
    else buf.push(b)
  }
  const deltas = (d) => {
    if (d.reasoning) send(chunk(id, model, { reasoning_content: d.reasoning }))
    if (d.content) send(chunk(id, model, { content: d.content }))
  }
  // the streamer turns the relay's cumulative onUpdate reads into deltas
  // (the same shape the old plugin's Streamer uses: a read that isn't a
  // growth of what was shown adds nothing)
  // heldFrom mirrors the old plugin's prompt.mjs: a tail that may be the
  // start of a ```tool_call fence is held back until the fence completes
  // (or proves itself prose), so a fence never leaks as content deltas.
  const heldFrom = (s) => {
    const i = s.lastIndexOf("```")
    return i < 0 ? s.length : i
  }
  const st = {
    text: "",
    shown: 0,
    reasoning: "",
    update({ text: t = "", reasoning: r = "" } = {}) {
      const out = {}
      if (typeof r === "string" && r.startsWith(this.reasoning) && r.length > this.reasoning.length) {
        out.reasoning = r.slice(this.reasoning.length)
        this.reasoning = r
      }
      if (typeof t === "string" && t.startsWith(this.text.slice(0, this.shown))) {
        this.text = t
        const upto = heldFrom(t)
        if (upto > this.shown) {
          out.content = t.slice(this.shown, upto)
          this.shown = upto
        }
      }
      return out
    },
    // finish gives what is left of the text once the fences are parsed out
    finish() {
      const { calls, text } = parseToolCalls(this.text)
      const shown = this.text.slice(0, this.shown)
      const content = text.startsWith(shown) ? text.slice(shown.length) : ""
      return { content, calls }
    },
  }
  const run = (async () => {
    try {
      const final = await ask((r) => {
        const d = st.update(r)
        if (d.reasoning || d.content) {
          begun = true
          onFirst()
          deltas(d)
        }
      }, both)
      begun = true
      onFirst()
      const d = st.update(final ?? {})
      if (d.reasoning || d.content) deltas(d)
      text = st.text
      reasoning = st.reasoning
      // tool calls are read from the whole final text once the turn is
      // done: a fence may span the deltas, so it is parsed here
      const { content, calls } = st.finish()
      const openai = calls.length ? openAIToolCalls(calls) : null
      const usage = usageOf(typeof promptTokens === "function" ? promptTokens() : promptTokens, text, reasoning)
      if (openai)
        for (const [i, c] of openai.entries())
          send(chunk(id, model, { tool_calls: [{ index: i, id: c.id, type: c.type, function: c.function }] }))
      if (content) send(chunk(id, model, { content }))
      // the finish chunk goes out twice, as quick's relay does: the
      // first closes the content, the second rides the usage block
      const fin = openai ? "tool_calls" : "stop"
      send(chunk(id, model, {}, { finish: fin }))
      const last = chunk(id, model, {}, { finish: fin })
      last.usage = usage
      send(last)
      send(null) // [DONE]
    } catch (e) {
      failure = e
      // a failure after deltas have streamed goes into the stream as an
      // error event (the client already got a 200); only a failure before
      // the first delta rejects here and becomes an HTTP error
      if (begun) send({ error: { message: String(e?.message ?? e), type: e?.code ?? "gemini_error" } })
    } finally {
      ended = true
      onFirst()
      try { ctl?.close() } catch {}
    }
  })()
  await first
  if (failure && !begun) {
    await run
    throw failure
  }
  const stream = new ReadableStream({
    start(controller) {
      ctl = controller
      // deltas that arrived while the caller awaited the Response go first
      for (const b of buf.splice(0)) try { controller.enqueue(b) } catch {}
      if (ended) try { controller.close() } catch {}
    },
    // a client hanging up must not keep the relay generating for it
    cancel() { try { abort.abort() } catch {} },
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
