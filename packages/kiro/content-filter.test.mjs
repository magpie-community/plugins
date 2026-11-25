// plugins#1365: Kiro blocks a turn mid-stream with "Output blocked by
// content filtering policy" (CreateResponse's error or response.failed,
// or generateAssistantResponse's exception). That is a refusal, the same
// stop Anthropic gives for CONTENT_FILTERED, not an invalid_request error.
// A stream error that isn't a content filter stays an error.
import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { createHash } from "node:crypto"
import { _internal } from "./index.mjs"

const { generate, events, reply, features, timing } = _internal

let realFetch, realSleep
beforeAll(() => {
  realFetch = globalThis.fetch
  realSleep = timing.sleep
  timing.sleep = async () => {}
})
afterAll(() => {
  globalThis.fetch = realFetch
  timing.sleep = realSleep
})
beforeEach(() => {
  features.clear()
  globalThis.fetch = async () => {
    throw new Error("no network in tests")
  }
})

const PROFILE = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX"
const creds = async () => ({ token: "t", tokenType: "", idc: true, profile: PROFILE, region: "us-east-1" })
const KEY = createHash("sha256").update("kiro-feature-config-key-salt-3e9b1d7a" + "create_response_api").digest("hex")
const ARM = { configuration: { [KEY]: "create_response" } }
const FILTER = "Output blocked by content filtering policy"
const req = (more = {}) => ({ model: "claude-haiku-5.5", messages: [{ role: "user", content: "hi" }], ...more })

const sse = (...events) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } })

function kiro(answer) {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname === "/featureConfiguration") return Response.json(ARM)
    if (url.pathname === "/v1/responses") return typeof answer === "function" ? answer() : answer
    throw new Error("unexpected " + url.pathname)
  }
}

const filterError = { type: "error", error: { type: "invalid_request", message: FILTER } }
const filterFailed = { type: "response.failed", response: { error: { type: "invalid_request", code: "content_filter", message: FILTER } } }
const crashed = { type: "error", error: { type: "server_error", message: "the model crashed" } }

function frame(headers, payload) {
  const enc = new TextEncoder()
  const hs = []
  for (const [k, v] of Object.entries(headers)) {
    const name = enc.encode(k)
    const val = enc.encode(v)
    const h = new Uint8Array(1 + name.length + 1 + 2 + val.length)
    h[0] = name.length
    h.set(name, 1)
    h[1 + name.length] = 7
    new DataView(h.buffer).setUint16(2 + name.length, val.length)
    h.set(val, 4 + name.length)
    hs.push(h)
  }
  const hlen = hs.reduce((n, h) => n + h.length, 0)
  const body = enc.encode(JSON.stringify(payload))
  const total = 12 + hlen + body.length + 4
  const out = new Uint8Array(total)
  const v = new DataView(out.buffer)
  v.setUint32(0, total)
  v.setUint32(4, hlen)
  let i = 12
  for (const h of hs) {
    out.set(h, i)
    i += h.length
  }
  out.set(body, i)
  return out
}
const text = (content) => frame({ ":message-type": "event", ":event-type": "assistantResponseEvent" }, { content })
const exception = (type, message) => frame({ ":message-type": "exception", ":exception-type": type }, { message })
const bytes = (...fs) => new ReadableStream({ start(c) { for (const f of fs) c.enqueue(f); c.close() } })
const gar = (body, streaming) => reply(events(body, "claude-haiku-5.5", 0), "claude-haiku-5.5", streaming)

test("a CreateResponse content-filter error ends as a refusal, before or after text, streamed or not", async () => {
  for (const event of [filterError, filterFailed]) {
    kiro(sse(event))
    const quiet = await generate(creds, {}, req())
    expect(quiet.status).toBe(200)
    const quietBody = await quiet.json()
    expect(quietBody.stop_reason).toBe("refusal")
    expect(quietBody.content).toEqual([])
    expect(quietBody.error).toBeUndefined()

    kiro(sse({ type: "response.output_text.delta", delta: "partial" }, event))
    const done = await generate(creds, {}, req())
    expect(done.status).toBe(200)
    const doneBody = await done.json()
    expect(doneBody.stop_reason).toBe("refusal")
    expect(doneBody.content).toEqual([{ type: "text", text: "partial" }])

    kiro(sse({ type: "response.output_text.delta", delta: "partial" }, event))
    const streamed = await generate(creds, {}, req({ stream: true }))
    expect(streamed.status).toBe(200)
    const wire = await streamed.text()
    expect(wire).toContain('"text":"partial"')
    expect(wire).toContain('"stop_reason":"refusal"')
    expect(wire).not.toContain("event: error")
    expect(wire).not.toContain("invalid_request")
  }
})

test("a CreateResponse content_filter stop still ends as a refusal", async () => {
  kiro(sse(
    { type: "response.output_text.delta", delta: "no" },
    { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "content_filter" }, usage: {} } },
  ))
  const out = await (await generate(creds, {}, req())).json()
  expect(out.stop_reason).toBe("refusal")
  expect(out.content).toEqual([{ type: "text", text: "no" }])
})

test("a CreateResponse stream error that is not a content filter stays an error", async () => {
  kiro(sse(crashed))
  const early = await generate(creds, {}, req())
  expect(early.status).not.toBe(200)
  expect((await early.json()).error.message).toContain("the model crashed")

  kiro(sse({ type: "response.output_text.delta", delta: "hello" }, crashed))
  const streamed = await generate(creds, {}, req({ stream: true }))
  expect(streamed.status).toBe(200)
  const wire = await streamed.text()
  expect(wire).toContain("hello")
  expect(wire).toContain("event: error")
  expect(wire).toContain("the model crashed")
  expect(wire).not.toContain('"stop_reason":"refusal"')
})

test("generateAssistantResponse's content-filter exception ends as a refusal, and another exception does not", async () => {
  for (const streaming of [false, true]) {
    const res = await gar(bytes(exception("ValidationException", FILTER)), streaming)
    expect(res.status).toBe(200)
    const body = streaming ? await res.text() : await res.json()
    const wire = typeof body === "string" ? body : JSON.stringify(body)
    expect(wire).toContain("refusal")
    expect(wire).not.toContain("event: error")
    expect(wire).not.toContain("invalid_request")
  }
  const mid = await gar(bytes(text("kept"), exception("ValidationException", FILTER)), false)
  expect(mid.status).toBe(200)
  const midBody = await mid.json()
  expect(midBody.stop_reason).toBe("refusal")
  expect(midBody.content).toEqual([{ type: "text", text: "kept" }])

  const other = await gar(bytes(exception("InternalServerException", "boom")), true)
  expect(other.status).not.toBe(200)
  expect((await other.json()).error.message).toContain("boom")
  const after = await gar(bytes(text("kept"), exception("InternalServerException", "boom")), true)
  const wire = await after.text()
  expect(wire).toContain("kept")
  expect(wire).toContain("event: error")
  expect(wire).toContain("boom")
  expect(wire).not.toContain('"stop_reason":"refusal"')
})

test("errors merely mentioning content filter infrastructure stay errors, not refusals", async () => {
  for (const message of ["content_filter_unavailable, try again", "failed to load the content filter configuration"]) {
    const err = { type: "error", error: { type: "server_error", message } }
    kiro(sse(err))
    const early = await generate(creds, {}, req())
    expect(early.status).not.toBe(200)
    expect((await early.json()).error.message).toContain(message)

    kiro(sse({ type: "response.output_text.delta", delta: "hi" }, err))
    const streamed = await generate(creds, {}, req({ stream: true }))
    const wire = await streamed.text()
    expect(wire).toContain("event: error")
    expect(wire).not.toContain('"stop_reason":"refusal"')
  }
})

test("a hosted web_search turn blocked mid-stream stops with refusal without running the search", async () => {
  let calls = []
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    calls.push(url.pathname)
    if (url.pathname === "/featureConfiguration") return Response.json(ARM)
    if (url.pathname === "/v1/responses") {
      return sse(
        { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "call_s1", name: "web_search" } },
        { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"query":"test"}' },
        { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "call_s1", name: "web_search", arguments: '{"query":"test"}' } },
        filterError,
      )
    }
    throw new Error("unexpected " + url.pathname)
  }
  const streamed = await generate(creds, {}, req({ stream: true, tools: [{ type: "web_search_20250305", name: "web_search" }] }))
  expect(streamed.status).toBe(200)
  const wire = await streamed.text()
  expect(wire).toContain("event: message_start")
  expect(wire).toContain('"stop_reason":"refusal"')
  expect(wire).toContain("event: message_stop")
  expect(wire).not.toContain("server_tool_use")
  expect(wire).not.toContain("pause_turn")
  expect(calls.filter((p) => p === "/v1/responses").length).toBe(1)
})

test("mid-stream refusal closes an open thinking or tool_use block cleanly in SSE", async () => {
  for (const deltas of [
    [{ type: "response.reasoning_text.delta", delta: "pondering" }],
    [
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "call_1", name: "read_file" } },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":"a"' },
    ],
  ]) {
    kiro(sse(...deltas, filterError))
    const streamed = await generate(creds, {}, req({ stream: true }))
    expect(streamed.status).toBe(200)
    const wire = await streamed.text()
    expect(wire).toContain("event: message_start")
    expect(wire).toContain("event: content_block_stop")
    expect(wire).toContain('"stop_reason":"refusal"')
    expect(wire).toContain("event: message_stop")
    expect(wire).not.toContain("event: error")
  }
})
