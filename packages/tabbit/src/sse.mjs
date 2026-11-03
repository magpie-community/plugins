// Tabbit's turn stream, read as the events the web app reads.
//
// The wire is `text/event-stream` with `event:`/`data:`/`id:` lines and a
// blank line between events. The names measured on a real turn, in order:
//
//   snapshot_begin, message_history, active_runs_snapshot, snapshot_end
//   user_message_created
//   assistant_message_started
//   event_message_chunk      chunk_type=thinking        → chunk_payload.reasoning_content
//   event_message_chunk      chunk_type=thinking_finished
//   assistant_message_delta  chunk_type=message_chunk   → chunk_payload.content
//   session_title_updated
//   assistant_message_finished
//   run_completed
//   room_reset_required
//
// `run_failed` replaces the last three when the turn does not finish.

import { streamTimeoutMs } from "./api.mjs"

// parseSSE turns a byte stream into {event, data, id} records. It is a plain
// reader, not an EventSource: no reconnect, no last-event-id store — the
// caller decides whether to rejoin.
export async function* parseSSE(body, { signal } = {}) {
  const reader = body.getReader()
  // A pending reader.read() is not woken by signal.aborted on its own: cancel
  // the body so a stream that has gone quiet ends when its bound says so.
  const wake = () => {
    try {
      const cancelled = reader.cancel(signal?.reason)
      // cancel() is a promise; a rejected one here is the stream already gone
      if (cancelled && typeof cancelled.catch === "function") cancelled.catch(() => {})
    } catch {
      /* already gone */
    }
  }
  if (signal) {
    if (signal.aborted) wake()
    else signal.addEventListener("abort", wake, { once: true })
  }
  const decoder = new TextDecoder()
  let buffer = ""
  let event = ""
  let id = null
  let data = []
  const flush = function* () {
    if (data.length || event) yield { event: event || "message", data: data.join("\n"), id }
    event = ""
    id = null
    data = []
  }
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted")
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      for (;;) {
        const at = buffer.indexOf("\n")
        if (at < 0) break
        const line = buffer.slice(0, at).replace(/\r$/, "")
        buffer = buffer.slice(at + 1)
        if (line === "") {
          yield* flush()
          continue
        }
        if (line.startsWith(":")) continue
        const colon = line.indexOf(":")
        const field = colon < 0 ? line : line.slice(0, colon)
        const raw = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "")
        if (field === "event") event = raw
        else if (field === "data") data.push(raw)
        else if (field === "id") id = raw
      }
    }
    yield* flush()
  } finally {
    signal?.removeEventListener?.("abort", wake)
    try {
      await reader.cancel()
    } catch {
      /* the stream is over either way */
    }
  }
}

function safeJSON(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// turnDeltas is one turn, as it arrives: the text and thinking chunks in
// order, then what the conversation needs to hang the next turn off.
//
// A stream that stops without `run_completed` is reported as truncated: an
// answer cut in half that looks whole is the failure worth naming.
export async function* turnDeltas(response, { signal, timeoutMs = streamTimeoutMs(), onTimeout } = {}) {
  const reason = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    reason.abort(new Error("Tabbit's turn timed out"))
    // A timed-out turn keeps running at Tabbit: stop it so it stops spending
    // the account's allowance.
    try {
      onTimeout?.()
    } catch {
      /* stopping is best effort */
    }
  }, timeoutMs)
  const onAbort = () => reason.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  }
  let history = []
  const state = {
    text: "",
    reasoning: "",
    userMessageId: null,
    assistantMessageId: null,
    runId: null,
    model: null,
    title: null,
    completed: false,
    failed: null,
    truncated: false,
    lastEventId: null,
  }
  try {
    for await (const frame of parseSSE(response.body, { signal: reason.signal })) {
      if (frame.id) state.lastEventId = frame.id
      const payload = safeJSON(frame.data)
      switch (frame.event) {
        case "message_history": {
          // Held until active_runs_snapshot says which message this turn is
          // answering: the snapshot lists the room's whole history, and the
          // old answers in it are not this turn's text.
          history = payload?.payload?.messages ?? []
          break
        }
        case "active_runs_snapshot": {
          const run = payload?.payload?.runs?.[0]
          if (run) {
            state.runId = run.run_id ?? state.runId
            state.assistantMessageId = run.assistant_message_id ?? state.assistantMessageId
            const mine = history.find((m) => m?.message_id && m.message_id === run.assistant_message_id)
            // A rejoin mid-turn is the only case with text already written.
            if (mine && typeof mine.content === "string" && mine.content) {
              state.text = mine.content
              yield { type: "text", value: mine.content, replay: true }
            }
            if (mine && typeof mine.reasoning_content === "string" && mine.reasoning_content) state.reasoning = mine.reasoning_content
          }
          break
        }
        case "user_message_created":
          state.userMessageId = payload?.payload?.message_id ?? payload?.payload?.chunk_payload?.message_id ?? state.userMessageId
          break
        case "assistant_message_started":
          state.runId = payload?.payload?.run_id ?? state.runId
          state.assistantMessageId = payload?.payload?.message_id ?? payload?.payload?.chunk_payload?.message_id ?? state.assistantMessageId
          yield { type: "started", messageId: state.assistantMessageId, runId: state.runId }
          break
        case "event_message_chunk":
          if (payload?.payload?.chunk_type === "thinking") {
            const value = payload?.payload?.chunk_payload?.reasoning_content ?? ""
            if (value) {
              state.reasoning += value
              yield { type: "thinking", value }
            }
          }
          break
        case "assistant_message_delta": {
          const value = payload?.payload?.chunk_payload?.content ?? ""
          if (value) {
            state.text += value
            yield { type: "text", value }
          }
          break
        }
        case "session_title_updated":
          state.title = payload?.payload?.title ?? payload?.payload?.chunk_payload?.title ?? state.title
          break
        case "assistant_message_finished":
          state.assistantMessageId = payload?.payload?.message_id ?? state.assistantMessageId
          state.model = payload?.payload?.model_name ?? state.model
          break
        case "run_completed":
          state.completed = true
          break
        case "run_failed":
          state.failed = payload?.payload ?? { status: "FAILED" }
          break
        default:
          break
      }
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.("abort", onAbort)
  }
  // No run_completed and no run_failed: the turn did not finish, even when it
  // produced no text at all. An empty reply that looks finished is an answer
  // an agent will take as the answer.
  if (!state.completed && !state.failed) state.truncated = true
  if (timedOut) state.timedOut = true
  yield { type: "end", state }
}

// readTurn drains turnDeltas into the finished turn, for a caller that wants
// the whole answer rather than its pieces.
export async function readTurn(response, options = {}) {
  for await (const part of turnDeltas(response, options)) {
    if (part.type === "end") return part.state
  }
  return null
}

export const _internal = { safeJSON }