import { test } from "bun:test"
import assert from "node:assert/strict"
import { sseRelay } from "../src/transport.js"

const source = text => new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode(text))
    controller.close()
  },
})
const read = async stream => new Response(stream).text()
const errorEvent = code => `data: ${JSON.stringify({ error: code })}\n\n`

test("sseRelay drops a non-terminal frame whose classifier returns null", async () => {
  const upstream = source('data: {"type":"keep"}\n\ndata: {"type":"drop"}\n\ndata: {"type":"end"}\n\n')
  const out = await read(sseRelay(upstream, undefined, {
    classify: event => ({ terminal: event.type === "end", redacted: event.type === "drop" ? null : event }),
    errorEvent,
  }))
  assert.equal(out, 'data: {"type":"keep"}\n\ndata: {"type":"end"}\n\n')
})

test("sseRelay fails the stream when a terminal frame is dropped", async () => {
  const upstream = source('data: {"type":"end"}\n\n')
  const out = await read(sseRelay(upstream, undefined, {
    classify: () => ({ terminal: true, redacted: null }),
    errorEvent,
  }))
  assert.equal(out, errorEvent("inference-response"))
})

test("sseRelay renames an existing event: line from the classifier name only", async () => {
  const upstream = source('event: old\ndata: {"type":"old"}\n\nevent: end\ndata: {"type":"end"}\n\n')
  const out = await read(sseRelay(upstream, undefined, {
    classify: event => event.type === "old"
      ? { terminal: false, redacted: { type: "new" }, name: "new" }
      : { terminal: true, redacted: { ...event, extra: 1 } },
    errorEvent,
  }))
  // A rebuilt frame without a classifier name keeps its original event: line.
  assert.equal(out, 'event: new\ndata: {"type":"new"}\n\nevent: end\ndata: {"type":"end","extra":1}\n\n')
})
