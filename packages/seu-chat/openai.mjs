// What the plugin answers: an OpenAI chat completion, streamed as SSE or
// whole, built from the reads of ChatSEU's reply.
import { heldFrom, parse } from "./prompt.mjs"
import { SeuError } from "./seu.mjs"

const UNREADABLE = "ChatSEU 把工具调用写成了读不出的形状（可能是被截断），已放弃本次回复，请重试。"

const enc = new TextEncoder()

// Streamer turns successive reads of a growing reply into chunk deltas.
// Text after the first <tool_call> (or a tail that may start one) is held,
// and becomes tool_calls when the reply ends. A read that isn't the last
// one grown (ChatSEU rewrote what it showed) adds nothing until it is again.
export class Streamer {
  constructor(toolNames = null) {
    this.toolNames = toolNames
    this.text = ""
    this.shown = 0
    this.reasoning = ""
  }

  update({ text = "", reasoning = "" }) {
    const out = {}
    if (reasoning.startsWith(this.reasoning) && reasoning.length > this.reasoning.length) {
      out.reasoning = reasoning.slice(this.reasoning.length)
      this.reasoning = reasoning
    }
    if (text.startsWith(this.text.slice(0, this.shown))) {
      this.text = text
      const upto = heldFrom(text, this.toolNames)
      if (upto > this.shown) {
        out.content = text.slice(this.shown, upto)
        this.shown = upto
      }
    }
    return out
  }

  // finish gives what is left of the text and the tool calls. What was
  // shown stopped before the first call, so the text with its calls taken
  // out still starts with it.
  finish(final, newId) {
    const p = parse(final?.text ?? this.text, newId, this.toolNames)
    const shown = this.text.slice(0, this.shown)
    let content = p.raw.startsWith(shown) ? p.raw.slice(shown.length) : ""
    if (p.calls.length) content = content.replace(/```[a-z]*\s*```/gi, "").trim() ? content.replace(/```[a-z]*\s*```/gi, "").trimEnd() : ""
    return { content, calls: p.calls, unreadable: p.unreadable ?? [] }
  }
}

export function usage(promptTokens, text, reasoning = "") {
  // the web app counts nothing; the reply is estimated at one token for
  // three characters
  const completion = Math.ceil(((text ?? "").length + (reasoning ?? "").length) / 3)
  return { prompt_tokens: promptTokens, completion_tokens: completion, total_tokens: promptTokens + completion }
}

const chunk = (id, model, delta, finish = null, extra = {}) =>
  enc.encode(
    "data: " +
      JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra }) +
      "\n\n",
  )

// sse runs ask(onUpdate, signal) and streams what it reads. It resolves
// once the reply has begun, so a failure before that (signed out, the
// model refused, a 429) throws here and goes back as an
// HTTP error, not as a 200 stream.
export async function sse({ id, model, ask, signal, promptTokens = () => 0, newId, toolNames }) {
  const st = new Streamer(toolNames)
  const abort = new AbortController()
  const both = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
  const buf = []
  let ctl = null
  let ended = false
  let failure = null
  let begun = false
  let onFirst
  const first = new Promise((r) => (onFirst = r))
  const push = (b) => (ctl ? ctl.enqueue(b) : buf.push(b))
  const deltas = (d) => {
    if (d.reasoning) push(chunk(id, model, { reasoning_content: d.reasoning }))
    if (d.content) push(chunk(id, model, { content: d.content }))
  }
  push(chunk(id, model, { role: "assistant", content: "" }))
  ;(async () => {
    try {
      const final = await ask((r) => {
        deltas(st.update(r))
        // reasoning 不算「回答已开始」——只有正文开始吐出才算。否则一个
        // 只有思考没有正文的回复会先以 200 开始流，agent 把它当完整回复。
        if (r.content || r.text) {
          begun = true
          onFirst()
        }
      }, both)
      begun = true
      onFirst()
      const { content, calls, unreadable } = st.finish(final, newId)
      if (unreadable.length) {
        push(enc.encode("data: " + JSON.stringify({ error: { message: UNREADABLE, type: "seu_unreadable_call" } }) + "\n\n"))
        push(enc.encode("data: [DONE]\n\n"))
      } else {
        if (content) push(chunk(id, model, { content }))
        if (calls.length) push(chunk(id, model, { tool_calls: calls.map((x, index) => ({ index, id: x.id, type: "function", function: x.function })) }))
        push(chunk(id, model, {}, calls.length ? "tool_calls" : "stop"))
        push(chunk(id, model, {}, null, { choices: [], usage: usage(promptTokens(final), final.text, final.reasoning) }))
        push(enc.encode("data: [DONE]\n\n"))
      }
    } catch (e) {
      failure = e
      if (begun && !both.aborted) push(enc.encode("data: " + JSON.stringify({ error: { message: String(e?.message ?? e), type: e?.code ?? "seu_error" } }) + "\n\n"))
    } finally {
      ended = true
      onFirst()
      if (ctl) try { ctl.close() } catch {}
    }
  })()
  await first
  if (failure && !begun) throw failure
  const stream = new ReadableStream({
    start(c) {
      ctl = c
      for (const b of buf.splice(0)) c.enqueue(b)
      if (ended) c.close()
    },
    cancel() {
      abort.abort()
    },
  })
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } })
}

export function completion({ id, model, final, promptTokens, newId, toolNames }) {
  const { text, calls, unreadable } = parse(final.text ?? "", newId, toolNames)
  if (unreadable.length) throw new SeuError(UNREADABLE, { code: "seu_unreadable_call", status: 502 })
  const message = { role: "assistant", content: text || (calls.length ? null : "") }
  if (final.reasoning) message.reasoning_content = final.reasoning
  if (calls.length) message.tool_calls = calls
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: calls.length ? "tool_calls" : "stop" }],
    usage: usage(promptTokens, final.text, final.reasoning),
  }
}
