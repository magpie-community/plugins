import * as mod from "./empty-reply.middleware.js"
import { check } from "../../scripts/middleware.mjs"
import { expect, test } from "bun:test"

check(import.meta.dir, mod)

// Claude Code 2.1.319 treated the early-ended stream as a broken connection:
// it retried three times and gave up with "Connection lost before a response
// was produced." A retry is a new request, so a rotating group can move on.
test("drops the end of a stream that said nothing", () => {
  const ctx = { protocol: "anthropic", stream: true, options: {}, state: {} }
  const events = [
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [] } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } },
    { type: "message_stop" },
  ]
  const out = events.filter((ev) => mod.onEvent(structuredClone(ev), ctx) !== null)
  expect(out.map((ev) => ev.type)).toEqual([
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
  ])
})
