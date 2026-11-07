import { test } from "node:test"
import assert from "node:assert/strict"

import { sseEvents, answerDelta, payloadFor, systemTimeZone, upstreamDetail } from "../pplx.mjs"

// Bytes captured from a real `perplexity_ask` stream, in the order they arrive:
// a thinking block, then two answer fragments, then the final full answer.
const CAPTURED = [
  `event: message\ndata: {"backend_uuid":"b-uuid","blocks":[{"intended_usage":"pro_search_steps","plan_block":{"steps":[{"step_type":"SEARCH_WEB","search_web_content":{"queries":[{"query":"ada lovelace birthday"}]}}]}}]}\n\n`,
  `event: message\ndata: {"blocks":[{"intended_usage":"ask_text","markdown_block":{"progress":"IN_PROGRESS","chunks":["Ada Lovelace was born "]}}]}\n\n`,
  `event: message\ndata: {"blocks":[{"intended_usage":"ask_text","markdown_block":{"progress":"IN_PROGRESS","chunks":["on 10 December 1815."]}}]}\n\n`,
  `event: message\ndata: {"blocks":[{"intended_usage":"ask_text","markdown_block":{"progress":"DONE","chunks":["Ada Lovelace was born on 10 December 1815."]}}]}\n\n`,
  `event: end_of_stream\ndata: {}\n\n`,
]

/** A body that hands out the captured bytes in arbitrary slices. */
function bodyOf(parts, slices) {
  const enc = new TextEncoder()
  const bytes = enc.encode(parts.join(""))
  const cuts = slices ?? [bytes.length]
  let at = 0
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close()
      const size = cuts[Math.min(at, cuts.length - 1)] ?? bytes.length
      controller.enqueue(bytes.slice(at, at + size))
      at += size
    },
  })
}

async function collect(stream) {
  const out = []
  for await (const ev of sseEvents(stream)) out.push(ev)
  return out
}

function newState() {
  return { full: "", cleaned: "", thinkingSeen: new Set(), answerUsage: null }
}

test("sseEvents parses captured bytes into named events", async () => {
  const events = await collect(bodyOf(CAPTURED))
  assert.equal(events.length, 5)
  assert.deepEqual(events.map((e) => e.event), ["message", "message", "message", "message", "end_of_stream"])
  const first = JSON.parse(events[0].data)
  assert.equal(first.backend_uuid, "b-uuid")
})

test("sseEvents keeps events intact when bytes land mid-line", async () => {
  const events = await collect(bodyOf(CAPTURED, [7, 13, 64, 5, 200]))
  assert.equal(events.length, 5)
  const answer = events.filter((e) => e.event === "message").map((e) => JSON.parse(e.data))
  assert.equal(answer.at(-1).blocks[0].markdown_block.progress, "DONE")
})

test("sseEvents tolerates CRLF line endings", async () => {
  const body = bodyOf([`event: message\r\ndata: {"a":1}\r\n\r\n`])
  const events = await collect(body)
  assert.equal(events.length, 1)
  assert.equal(events[0].data, '{"a":1}')
})

test("answerDelta rebuilds the answer from fragments and the final block", () => {
  const state = newState()
  let text = ""
  let thinking = ""
  for (const raw of CAPTURED.slice(0, 4)) {
    const chunk = JSON.parse(raw.split("data: ")[1])
    const r = answerDelta(chunk, state)
    text += r.delta
    thinking += r.thinking
  }
  assert.equal(text, "Ada Lovelace was born on 10 December 1815.")
  assert.match(thinking, /Searching: ada lovelace birthday/)
})

test("a final block that repeats the answer does not duplicate it", () => {
  const state = newState()
  const first = answerDelta(
    { blocks: [{ intended_usage: "ask_text", markdown_block: { progress: "IN_PROGRESS", chunks: ["abc"] } }] },
    state,
  )
  const last = answerDelta(
    { blocks: [{ intended_usage: "ask_text", markdown_block: { progress: "DONE", chunks: ["abcdef"] } }] },
    state,
  )
  assert.equal(first.delta + last.delta, "abcdef")
})

test("reasoning blocks are reported separately and only once", () => {
  const state = newState()
  const chunk = {
    blocks: [{ intended_usage: "plan", plan_block: { goals: [{ description: "Find the birthday" }] } }],
  }
  assert.match(answerDelta(chunk, state).thinking, /Find the birthday/)
  assert.equal(answerDelta(chunk, state).thinking, "")
})

test("a chunk without an answer block yields nothing", () => {
  const r = answerDelta({ blocks: [{ intended_usage: "media_items" }] }, newState())
  assert.deepEqual(r, { delta: "", thinking: "" })
})

test("the payload carries the internet search focus and a real time zone", () => {
  const p = payloadFor("q", "claude50sonnet", null, "2.18", "Europe/Berlin")
  assert.equal(p.query_str, "q")
  assert.equal(p.params.model_preference, "claude50sonnet")
  assert.equal(p.params.search_focus, "internet")
  assert.equal(p.params.timezone, "Europe/Berlin")
  assert.equal(p.params.version, "2.18")
  assert.equal(p.params.mode, "copilot")
})

test("the payload uses concise mode for the free preferences", () => {
  assert.equal(payloadFor("q", "pplx_pro", null, "2.18", "UTC").params.mode, "concise")
  assert.equal(payloadFor("q", "experimental", null, "2.18", "UTC").params.mode, "concise")
})

test("the payload continues a thread when a backend uuid is known", () => {
  const p = payloadFor("follow up", "pplx_pro", "b-uuid", "2.18", "UTC")
  assert.equal(p.params.last_backend_uuid, "b-uuid")
})

test("systemTimeZone falls back to UTC instead of a hard-coded city", () => {
  assert.equal(systemTimeZone({ resolvedOptions: () => ({ timeZone: "Asia/Shanghai" }) }), "Asia/Shanghai")
  assert.equal(systemTimeZone({ resolvedOptions: () => ({}) }), "UTC")
  assert.equal(systemTimeZone({ resolvedOptions: () => { throw new Error("no ICU") } }), "UTC")
})

test("upstreamDetail prefers Perplexity's own message", () => {
  assert.equal(upstreamDetail('{"error":{"message":"nope"}}'), "nope")
  assert.equal(upstreamDetail('{"detail":"denied"}'), "denied")
  assert.equal(upstreamDetail("plain text"), "plain text")
  assert.equal(upstreamDetail(""), "")
})
