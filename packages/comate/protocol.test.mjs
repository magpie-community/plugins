import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import {
  buildQuery,
  consumeComateSSE,
  events,
  newState,
  parseToolCalls,
  piecesOf,
  ProtocolRequestError,
  ToolTextParser,
} from "./protocol.mjs"

const tools = [
  { type: "function", function: { name: "lookup", description: "Look up a value", parameters: { type: "object", properties: { key: { type: "string" } } } } },
  { type: "function", function: { name: "search", parameters: { type: "object" } } },
]

function specFor(toolChoice = "auto", offered = tools) {
  return buildQuery({ tools: offered, tool_choice: toolChoice, messages: [] }, "deadbeef").toolSpec
}

async function* byteChunks(...values) {
  const encoder = new TextEncoder()
  for (const value of values) yield encoder.encode(value)
}

test("query transcript keeps assistant calls and tool results in role-preserving JSON lines", () => {
  const { query } = buildQuery({
    messages: [
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"key":"x"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "RESULT_42" },
    ],
  }, "trace")
  assert.match(query, /"role":"assistant"/)
  assert.match(query, /"tool_call_id":"call_1"/)
  assert.match(query, /RESULT_42/)
})

test("strict function schemas are rejected because the adapter cannot guarantee schema validation", () => {
  assert.throws(
    () => buildQuery({ tools: [{ type: "function", function: { name: "lookup", strict: true, parameters: { type: "object" } } }] }, "trace"),
    (error) => error instanceof ProtocolRequestError && /strict function tools are not supported/.test(error.message),
  )
})

test("auto permits ordinary text while required and named choices require the requested function", () => {
  assert.equal(parseToolCalls("ordinary answer", specFor("auto")).invalid, "")
  assert.match(parseToolCalls("ordinary answer", specFor("required")).invalid, /required tool call block/)

  const named = specFor({ type: "function", function: { name: "lookup" } })
  const markerBlock = (name) => `${named.startTag}[{"name":"${name}","arguments":{"key":"x"}}]${named.endTag}`
  assert.equal(parseToolCalls(markerBlock("lookup"), named).calls[0].name, "lookup")
  assert.match(parseToolCalls(markerBlock("search"), named).invalid, /does not match tool_choice/)
  assert.match(parseToolCalls("no call", named).invalid, /required tool call block/)
})

test("text parser recognizes a fragmented tool marker after leading whitespace", () => {
  const spec = specFor("auto")
  const block = `${spec.startTag}[{"name":"lookup","arguments":{"key":"x"}}]${spec.endTag}`
  const parser = new ToolTextParser(spec)
  assert.deepEqual(parser.push(` \n${block.slice(0, 9)}`), [])
  assert.deepEqual(parser.push(block.slice(9, 25)), [])
  assert.deepEqual(parser.push(block.slice(25)), [])
  const result = parser.finish()
  assert.equal(result.invalid, "")
  assert.equal(result.calls[0].name, "lookup")
  assert.equal(result.text, "")
})

test("required tool mode buffers ordinary text until final validation", () => {
  const parser = new ToolTextParser(specFor("required"))
  assert.deepEqual(parser.push("ordinary answer"), [])
  assert.deepEqual(parser.push(" and hidden reasoning"), [])
  const result = parser.finish()
  assert.match(result.invalid, /required tool call block/)
  assert.equal(result.text, "")
  assert.deepEqual(result.calls, [])
})

test("unknown tool names and malformed marker blocks are rejected", () => {
  const spec = specFor("auto")
  const unknown = `${spec.startTag}[{"name":"not_offered","arguments":{}}]${spec.endTag}`
  assert.match(parseToolCalls(unknown, spec).invalid, /tool name was not offered/)
  assert.match(parseToolCalls(`${spec.startTag}{bad}${spec.endTag}`, spec).invalid, /invalid tool call JSON/)
})

test("cumulative patches emit only their new suffix and ignore type-only patches", () => {
  const state = newState()
  assert.deepEqual(piecesOf({ kind: "element-add", element: { id: "answer", type: "TEXT", content: "Hel" } }, state), [{ text: "Hel" }])
  assert.deepEqual(piecesOf({ kind: "element-patch", eid: "answer", patch: { type: "TEXT", done: true } }, state), [])
  assert.deepEqual(piecesOf({ kind: "element-patch", patch: { id: "answer", content: "Hello" } }, state), [{ text: "lo" }])
  assert.deepEqual(piecesOf({ kind: "element-patch", patch: { id: "answer", content: "Hello" } }, state), [])
  assert.throws(
    () => piecesOf({ kind: "element-patch", patch: { id: "answer", content: "" } }, state),
    /shortened cumulative element content/,
  )
})

test("text deltas and cumulative patches share element state without duplicating output", () => {
  const state = newState()
  const pieces = piecesOf({ kind: "delta-batch", chunks: [
    { kind: "text-delta", eid: "answer", delta: "Hel" },
    { kind: "element-patch", eid: "answer", patch: { content: "Hello" } },
    { kind: "element-patch", eid: "answer", patch: { content: "Hello!" } },
  ] }, state)
  assert.deepEqual(pieces, [{ text: "Hel" }, { text: "lo" }, { text: "!" }])
})

test("SSE event reader handles split UTF-8 and frame boundaries and rejects malformed JSON", async () => {
  const encoder = new TextEncoder()
  const japanese = encoder.encode('data: {"kind":"text-delta","delta":"快"}\n\n')
  const split = japanese.indexOf(0xe5) + 1
  const eventsRead = []
  for await (const value of events((async function* () { yield japanese.slice(0, split); yield japanese.slice(split) })())) eventsRead.push(value)
  assert.deepEqual(eventsRead, [{ kind: "text-delta", delta: "快" }])

  await assert.rejects(async () => {
    for await (const _ of events(byteChunks("data: {not-json}\n\n"))) { /* consume */ }
  }, /invalid SSE JSON frame/)
})

test("only completed task_done is success; failed task and EOF are failures", async () => {
  const completed = await consumeComateSSE(byteChunks(
    ': keepalive\n\n',
    'data: {"kind":"text-delta","delta":"Hello "}\n\n',
    'data: {"type":"task_done","status":"completed"}\n\n',
  ))
  assert.equal(completed.ok, true)
  assert.equal(completed.text, "Hello ")

  const failed = await consumeComateSSE(byteChunks('data: {"type":"task_failed","errorMessage":"provider failed"}\n\n'))
  assert.equal(failed.ok, false)
  assert.match(failed.error, /provider failed/)

  const eof = await consumeComateSSE(byteChunks('data: {"kind":"text-delta","delta":"partial"}\n\n'))
  assert.equal(eof.ok, false)
  assert.match(eof.error, /before a terminal task event/)
})

test("sanitized replay of the captured Comate element-add and task_done SSE shape", async () => {
  // Frame and chunk structure comes from a real capture; every identifier and text value is synthetic.
  const fixture = readFileSync(new URL("./protocol-live-text.sse", import.meta.url), "utf8")
  const replay = await consumeComateSSE(byteChunks(fixture))
  assert.equal(replay.ok, true)
  assert.equal(replay.text, "Sanitized fixture answer.")
  assert.equal(replay.terminal.status, "completed")
})

test("a malformed SSE frame cannot be skipped before a later completion event", async () => {
  await assert.rejects(
    () => consumeComateSSE(byteChunks('data: oops\n\n', 'data: {"type":"task_done","status":"completed"}\n\n')),
    /invalid SSE JSON frame/,
  )
})
