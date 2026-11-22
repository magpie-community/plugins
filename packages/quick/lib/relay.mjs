// The OpenAI-compatible relay: a /v1/chat/completions request in, a Quick
// chat turn out. Stateless by default — every request opens a fresh Quick
// thread and flattens the conversation history into the text (the context
// window is 1M tokens and metering is by wall-clock minutes, so flattening
// costs nothing extra); reusing the server-side thread is a config option.
//
// Streamed turns come back as SSE, aggregated turns as one JSON reply.
// Each turn's usage metadata carries the model fingerprint the server
// reported (resolved_model_id, served_model_id), the token counts, the
// cost and the wall-clock seconds the turn took — minutes, not tokens, are
// what the quota spends.
//
// The request's thinking parameter goes out on every turn explicitly (the
// server defaults a fresh session to off and smart to medium). A tools
// request is refused with a clear 400: the chat channel has no client
// tools field, and silently dropping tools would break the caller's agent.

import { modeOf, effortOf, PROVIDER } from "./models.mjs"

// flatten turns the OpenAI messages into the text the Quick turn sends:
// system lines first, then each exchange, with tool calls named and their
// results inlined (they are context, not executable here)
export function flatten(messages) {
  const lines = []
  for (const m of messages ?? []) {
    const role = m?.role ?? "user"
    const text = typeof m?.content === "string"
      ? m.content
      : Array.isArray(m?.content)
        ? m.content.map((c) => (typeof c === "string" ? c : c?.text ?? "")).join("\n")
        : ""
    if (role === "system" || role === "developer") lines.push(`[System]\n${text}`)
    else if (role === "tool") lines.push(`[Tool result for ${m.tool_call_id ?? "call"}]\n${text}`)
    else if (role === "assistant") {
      const calls = Array.isArray(m?.tool_calls)
        ? m.tool_calls.map((c) => `[Tool call ${c?.function?.name ?? c?.id ?? ""}] ${c?.function?.arguments ?? ""}`).join("\n")
        : ""
      lines.push([text, calls].filter(Boolean).join("\n"))
    } else lines.push(text)
  }
  return lines.filter((l) => l.trim()).join("\n\n")
}

export function errorResponse(status, message, extra = {}) {
  return new Response(JSON.stringify({ error: { message, type: "quick_error", code: status, ...extra } }), {
    status,
    headers: { "content-type": "application/json" },
  })
}

// mapError turns a Quick failure into an OpenAI-shaped error. Auth failures
// say the cookie needs re-importing; usage_limit carries the resume wait.
export function mapError(e) {
  const msg = String(e?.message ?? e)
  if (/401|403|refused/.test(msg)) return errorResponse(401, `Quick: ${msg} — re-import the account's cookie`, { signIn: "expired" })
  if (/usage_limit/i.test(msg)) return errorResponse(429, `Quick: ${msg}`)
  if (/turn_duration_exceeded/i.test(msg)) return errorResponse(400, `Quick: ${msg} — split the task into smaller turns`)
  if (/timed out|socket|closed|ECONN/i.test(msg)) return errorResponse(502, `Quick: ${msg}`)
  return errorResponse(502, `Quick: ${msg}`)
}

// userPayload builds the user_message payload for a request. incognito
// defaults on (the web client's 无痕模式: the conversation stays out of the
// sidebar's recents list; verified on the live page 2026-11-22 — the flag
// rides the user_message payload and the server records it). A request's
// quick.incognito: false opts back into the visible history.
export function userPayload({ text, model, thinking, threadId, webSearch, incognito }) {
  const effort = effortOf(thinking)
  if (effort === null) throw new Error(`Quick: thinking must be one of off/low/medium/high/max, got ${JSON.stringify(thinking)}`)
  return {
    text,
    thread_id: threadId,
    agent_mode: modeOf(model),
    thinking_effort: effort,
    auto_routing: false,
    web_search_enabled: webSearch ?? true,
    incognito: incognito !== false,
  }
}

// textOf pulls the streamed text out of a turn's events (thinking deltas
// are folded into reasoning, the visible text into content). A
// routing_decision event — the server's own record of why a model was
// picked — rides out verbatim as quick.routing_decision.
export function collectTurn(events) {
  let content = ""
  let reasoning = ""
  let usage
  let routing
  for (const e of events) {
    if (e?.type === "text_delta" && typeof e.delta === "string") content += e.delta
    else if (e?.type === "text_complete" && typeof e.text === "string" && !content) content = e.text
    else if (e?.type === "thinking_delta" && typeof e.delta === "string") reasoning += e.delta
    else if (e?.type === "turn_usage") usage = e
    else if (e?.type === "routing_decision") routing = e
  }
  return { content, reasoning, usage, routing }
}

// openaiChunk is one SSE chunk in OpenAI's shape
export function openaiChunk(id, model, delta, { finish } = {}) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  }
}

// usageMeta is the per-turn metadata: the server's model fingerprint plus
// the wall-clock the turn took (the quota spends minutes, not tokens)
export function usageMeta(usage, startedAt) {
  if (!usage) return {}
  const meta = {
    "quick.model": usage.model ?? "",
    "quick.resolved_model_id": usage.resolved_model_id ?? "",
    "quick.served_model_id": usage.served_model_id ?? "",
    "quick.router": usage.router ?? "fixed",
    "quick.cost_usd": usage.cost_usd ?? 0,
    "quick.context_window": usage.context_window ?? 1_000_000,
  }
  if (usage.input_tokens !== undefined) meta["quick.input_tokens"] = usage.input_tokens
  if (usage.output_tokens !== undefined) meta["quick.output_tokens"] = usage.output_tokens
  if (usage.cache_read_tokens !== undefined) meta["quick.cache_read_tokens"] = usage.cache_read_tokens
  if (usage.cache_write_tokens !== undefined) meta["quick.cache_write_tokens"] = usage.cache_write_tokens
  if (startedAt) meta["quick.turn_seconds"] = Math.max(0, (Date.now() - startedAt) / 1000)
  return meta
}

// relayTurn runs one turn on a connected QuickSocket and answers with
// either an SSE stream or an aggregated JSON body. threadId reuses the
// server-side thread (same-thread continuation); a response header echoes
// it back so a caller can pin the next request to the same thread. An
// aborted signal stops reading the turn, asks the server to stop, and
// finishes with finish_reason "aborted".
export async function relayTurn({ socket, body, model, stream, signal, threadId }) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  if (!messages.length) return errorResponse(400, "Quick: the request has no messages")
  if (Array.isArray(body?.tools) && body.tools.length) {
    return errorResponse(400, "Quick: tool calling is not supported on the Quick chat channel — the server takes no client tools field. Remove `tools` or route this request to another provider.")
  }
  const quickOpts = body?.quick && typeof body.quick === "object" ? body.quick : {}
  let payload
  try {
    payload = userPayload({
      text: flatten(messages),
      model,
      thinking: body?.thinking ?? body?.reasoning_effort,
      threadId,
      webSearch: body?.web_search,
      incognito: quickOpts.incognito,
    })
  } catch (e) {
    return errorResponse(400, e.message)
  }
  const id = "chatcmpl-" + crypto.randomUUID().slice(0, 8)
  const startedAt = Date.now()
  let events = []
  try {
    for await (const e of socket.chat(payload, { signal })) events.push(e)
  } catch (e) {
    return mapError(e)
  }
  const { content, reasoning, usage, routing } = collectTurn(events)
  const meta = usageMeta(usage, startedAt)
  if (routing) meta["quick.routing_decision"] = routing.payload ?? routing
  const thread = events.find((e) => e?.thread_id)?.thread_id ?? payload.thread_id
  if (thread) meta["quick.thread_id"] = thread
  meta["quick.incognito"] = payload.incognito
  const finish = events.some((e) => e?.type === "message_complete") ? "stop" : signal?.aborted ? "aborted" : "length"
  if (stream) {
    const enc = new TextEncoder()
    const chunks = []
    // reasoning goes first, as its own delta, the way the SDK reads it
    if (reasoning) chunks.push(openaiChunk(id, model, { reasoning_content: reasoning }))
    if (content) chunks.push(openaiChunk(id, model, { content }))
    chunks.push(openaiChunk(id, model, {}, { finish }))
    chunks.push(openaiChunk(id, model, {}, { finish }))
    const sse = chunks.map((c, i) => {
      if (i === chunks.length - 2) c.quick = meta // usage rides the last content chunk
      if (i === chunks.length - 1) c.usage = usage ? { prompt_tokens: usage.input_tokens ?? 0, completion_tokens: usage.output_tokens ?? 0, total_tokens: usage.total_tokens ?? 0 } : undefined
      return c
    })
    const body2 = sse.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n"
    return new Response(enc.encode(body2), { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", ...(thread ? { "x-quick-thread-id": thread } : {}) } })
  }
  const out = {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, ...(reasoning ? { reasoning_content: reasoning } : {}) },
        finish_reason: finish,
      },
    ],
    usage: usage
      ? { prompt_tokens: usage.input_tokens ?? 0, completion_tokens: usage.output_tokens ?? 0, total_tokens: usage.total_tokens ?? 0 }
      : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    quick: meta,
  }
  return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json", ...(thread ? { "x-quick-thread-id": thread } : {}) } })
}

export { PROVIDER }
