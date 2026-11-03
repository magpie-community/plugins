// Reading a turn: the recorded frames of a real one, replayed.

import test from "node:test"
import assert from "node:assert/strict"
import { parseSSE, turnDeltas, readTurn } from "../src/sse.mjs"

// frame builds one SSE event as the wire carries it.
const frame = (event, data, id) => `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

function responseOf(chunks) {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

// A turn exactly as measured: thinking, then the answer, then the end.
const GOOD = [
  frame("snapshot_begin", { payload: {} }),
  frame("message_history", {
    payload: { messages: [{ message_id: "a0", role: "user", content: "1+1=?" }, { message_id: "a1", role: "assistant", content: "" }] },
  }),
  frame("active_runs_snapshot", { payload: { runs: [{ run_id: "r1", status: "RUNNING", assistant_message_id: "a1" }] } }),
  frame("user_message_created", { payload: { message_id: "m-user" } }),
  frame("assistant_message_started", { payload: { run_id: "r1", message_id: "a1" } }),
  frame("event_message_chunk", { payload: { chunk_type: "thinking", chunk_payload: { reasoning_content: "想想" } } }),
  frame("event_message_chunk", { payload: { chunk_type: "thinking_finished", chunk_payload: {} } }),
  frame("assistant_message_delta", { payload: { chunk_type: "message_chunk", chunk_payload: { content: "4" } } }),
  frame("session_title_updated", { payload: { title: "算术" } }),
  frame("assistant_message_finished", { payload: { message_id: "a1", model_name: null } }),
  frame("run_completed", { payload: { status: "COMPLETED" } }, "e1"),
]

test("parseSSE splits events, data and ids", async () => {
  const out = []
  for await (const ev of parseSSE(responseOf(["event: a\ndata: {\"x\":1}\n\n", "id: 9\nevent: b\ndata: he", "llo\n\n"]).body)) out.push(ev)
  assert.deepEqual(out[0], { event: "a", data: '{"x":1}', id: null })
  assert.deepEqual(out[1], { event: "b", data: "hello", id: "9" })
})

test("a good turn gives text, thinking, ids and completed", async () => {
  const state = await readTurn(responseOf(GOOD))
  assert.equal(state.text, "4")
  assert.equal(state.reasoning, "想想")
  assert.equal(state.completed, true)
  assert.equal(state.truncated, false)
  assert.equal(state.assistantMessageId, "a1")
  assert.equal(state.userMessageId, "m-user")
  assert.equal(state.runId, "r1")
  assert.equal(state.title, "算术")
  assert.equal(state.lastEventId, "e1")
})

test("the deltas arrive in order, thinking before text", async () => {
  const kinds = []
  for await (const part of turnDeltas(responseOf(GOOD))) {
    if (part.type === "thinking") kinds.push(`think:${part.value}`)
    if (part.type === "text") kinds.push(`text:${part.value}`)
  }
  assert.deepEqual(kinds, ["think:想想", "text:4"])
})

test("a turn that stops early is truncated, not silently complete", async () => {
  const state = await readTurn(responseOf(GOOD.slice(0, 8)))
  assert.equal(state.completed, false)
  assert.equal(state.truncated, true)
  assert.equal(state.text, "4")
})

test("a failed turn is reported as failed", async () => {
  const state = await readTurn(responseOf([...GOOD.slice(0, 8), frame("run_failed", { payload: { status: "FAILED", reason: "boom" } })]))
  assert.deepEqual(state.failed, { status: "FAILED", reason: "boom" })
  assert.equal(state.completed, false)
  assert.equal(state.truncated, false)
})

test("a rejoin's snapshot recovers text already sent", async () => {
  const chunk = frame("message_history", {
    payload: { messages: [{ message_id: "a1", role: "assistant", content: "前半段", reasoning_content: "想过了" }] },
  })
  const runs = frame("active_runs_snapshot", { payload: { runs: [{ run_id: "r1", assistant_message_id: "a1" }] } })
  const state = await readTurn(responseOf([chunk, runs, frame("assistant_message_delta", { payload: { chunk_payload: { content: "后半段" } } }), frame("run_completed", { payload: {} })]))
  assert.equal(state.text, "前半段后半段")
  assert.equal(state.reasoning, "想过了")
})

test("a new turn's snapshot is not replayed as this turn's text", async () => {
  // The room's history holds the previous answer; only the assistant message
  // the active run names is this turn's, and that one is still empty.
  const history = frame("message_history", {
    payload: { messages: [
      { message_id: "old", role: "assistant", content: "上一轮的完整回答" },
      { message_id: "new", role: "user", content: "新问题" },
      { message_id: "cur", role: "assistant", content: "" },
    ] },
  })
  const runs = frame("active_runs_snapshot", { payload: { runs: [{ run_id: "r2", assistant_message_id: "cur" }] } })
  const deltas = frame("assistant_message_delta", { payload: { chunk_payload: { content: "新回答" } } })
  const state = await readTurn(responseOf([history, runs, deltas, frame("run_completed", { payload: {} })]))
  assert.equal(state.text, "新回答")
})

test("a stream that closes before any answer is unfinished, not empty-but-done", async () => {
  // join closes after assistant_message_started, before any text or run_completed
  const state = await readTurn(responseOf([
    frame("snapshot_begin", { payload: {} }),
    frame("assistant_message_started", { payload: { run_id: "r1", message_id: "a1" } }),
  ]))
  assert.equal(state.text, "")
  assert.equal(state.completed, false)
  assert.equal(state.truncated, true)
})
