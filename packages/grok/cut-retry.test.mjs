import { noRealGrok } from "./nocli.mjs"
import { afterAll, afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GrokAuthPlugin, _internal } from "./index.mjs"

noRealGrok()

// A cut before the first byte is asked again. Once a byte has arrived the
// stream is passed on, and a later cut just ends: magpie 0.1.3298+ writes
// the response.failed. This plugin must not invent one (it had no
// sequence_number, and Grok Build rejected it).
const realFetch = globalThis.fetch
const realWarn = console.warn
afterEach(() => {
  globalThis.fetch = realFetch
  console.warn = realWarn
  _internal.limited.clear()
})
const home = mkdtempSync(join(tmpdir(), "grok-cut-retry-"))
afterAll(() => rmSync(home, { recursive: true, force: true }))
const expires = Date.now() + 24 * 3600_000
writeFileSync(join(home, "auth.json"), JSON.stringify({
  test: { key: "test-token", email: "test@example.invalid", expires_at: new Date(expires).toISOString() },
}))
const auth = { type: "oauth", refresh: home, access: "test-token", expires, accountId: "test@example.invalid" }

function event(type, fields = {}) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`
}

function created(id = "resp_test") {
  return event("response.created", {
    response: { id, object: "response", created_at: 1_700_000_000, status: "in_progress", model: "grok-4.7" },
  })
}

function sse(parts, { fail } = {}) {
  const enc = new TextEncoder()
  let index = 0
  const stream = new ReadableStream({
    pull(controller) {
      if (index < parts.length) {
        controller.enqueue(enc.encode(parts[index]))
        index += 1
        return
      }
      if (fail) controller.error(new Error(fail))
      else controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
}

function die(message) {
  const stream = new ReadableStream({
    pull(controller) {
      controller.error(new Error(message))
    },
  })
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
}

function eventsOf(text) {
  const events = []
  for (const line of text.split(/\r?\n/)) {
    const data = line.startsWith("data:") ? line.slice(5).trim() : ""
    if (!data.startsWith("{")) continue
    events.push(JSON.parse(data))
  }
  return events
}

async function ask(attempts) {
  let calls = 0
  console.warn = () => {}
  globalThis.fetch = async () => {
    const make = attempts[calls]
    calls += 1
    if (!make) throw new Error(`unexpected fetch ${calls}`)
    return make()
  }
  const hooks = await GrokAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => auth)
  const res = await opts.fetch("https://cli-chat-proxy.grok.com/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "grok-4.7", input: "hi", stream: true }),
  })
  const text = await res.text()
  return { calls, res, text }
}

test("a stream cut before any byte is asked again", async () => {
  const { calls, res, text } = await ask([
    () => die("ECONNRESET"),
    () => sse([
      created("resp_b"),
      event("response.output_text.delta", { delta: "pong" }),
      event("response.completed", { response: { id: "resp_b", created_at: 1_700_000_001, status: "completed" } }),
    ]),
  ])
  expect(calls).toBe(2)
  expect(res.status).toBe(200)
  expect(text).toContain("pong")
  expect(text).toContain("resp_b")
  expect(eventsOf(text).some((item) => item.type === "response.failed")).toBe(false)
})

test("a stream that ends before output is not asked again", async () => {
  const { calls, text } = await ask([
    () => sse([created("resp_empty")]),
    () => sse([event("response.output_text.delta", { delta: "nope" })]),
  ])
  expect(calls).toBe(1)
  expect(text).toContain("resp_empty")
  expect(text).not.toContain("nope")
})

test("three cuts before any byte invent no response.failed", async () => {
  const { calls, res, text } = await ask([
    () => die("ECONNRESET"),
    () => die("socket connection was closed unexpectedly"),
    () => die("unexpected EOF"),
  ])
  expect(calls).toBe(3)
  expect(res.status).toBe(200)
  expect(text).toBe("")
  expect(text).not.toContain("response.failed")
  expect(text).not.toContain("created_at")
})

test("reasoning is forwarded and a later cut is not asked again", async () => {
  const { calls, text } = await ask([
    () => sse([
      created("resp_think"),
      event("response.reasoning_summary_text.delta", { delta: "thinking-once" }),
    ], { fail: "ECONNRESET" }),
    () => sse([event("response.output_text.delta", { delta: "should-not-retry" })]),
  ])
  expect(calls).toBe(1)
  expect(text).toContain("thinking-once")
  expect(text).toContain("resp_think")
  expect(text).not.toContain("should-not-retry")
  expect(text).not.toContain("response.failed")
})

test("a cut after output is not asked again and invents no event", async () => {
  const { calls, text } = await ask([
    () => sse([
      created("resp_out"),
      event("response.output_text.delta", { delta: "pong" }),
    ], { fail: "ECONNRESET" }),
    () => sse([event("response.output_text.delta", { delta: "should-not-retry" })]),
  ])
  expect(calls).toBe(1)
  expect(text).toContain("pong")
  expect(text).toContain("resp_out")
  expect(text).not.toContain("should-not-retry")
  expect(eventsOf(text).map((item) => item.type)).toEqual(["response.created", "response.output_text.delta"])
})

test("an upstream response.failed is passed on", async () => {
  const { calls, text } = await ask([
    () => sse([
      created("resp_no"),
      event("response.failed", {
        response: { id: "resp_no", created_at: 5, status: "failed", error: { message: "context too long" } },
      }),
    ]),
    () => sse([event("response.output_text.delta", { delta: "nope" })]),
  ])
  expect(calls).toBe(1)
  expect(text).toContain("context too long")
  expect(text).not.toContain("nope")
  expect(text).not.toContain("stream ended before output")
})

test("an upstream error event is passed on", async () => {
  const { calls, text } = await ask([
    () => sse([event("error", { error: { type: "server_error", message: "upstream said no" } })]),
    () => sse([event("response.output_text.delta", { delta: "nope" })]),
  ])
  expect(calls).toBe(1)
  expect(text).toContain("upstream said no")
  expect(text).not.toContain("nope")
})

test("a 429 after a cut before any byte is the real answer", async () => {
  const { calls, res, text } = await ask([
    () => die("ECONNRESET"),
    () => new Response("slow down", { status: 429, headers: { "content-type": "text/plain", "retry-after": "12" } }),
  ])
  expect(calls).toBe(2)
  expect(res.status).toBe(429)
  expect(text).toBe("slow down")
  expect(res.headers.get("x-magpie-sign-in")).toBe("kept")
  expect(text).not.toContain("response.failed")
  const held = _internal.limited.get(home)
  expect(held?.until).toBeGreaterThan(Date.now())
})

test("an aborted stream is not asked again", async () => {
  const { calls, text } = await ask([
    () => die("The operation was aborted."),
    () => sse([event("response.output_text.delta", { delta: "nope" })]),
  ])
  expect(calls).toBe(1)
  expect(text).toBe("")
  expect(text).not.toContain("nope")
  expect(text).not.toContain("response.failed")
})

test("cancelling the stream stops the upstream read", async () => {
  let pulls = 0
  let cancelled = false
  const enc = new TextEncoder()
  console.warn = () => {}
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) {
      pulls += 1
      controller.enqueue(enc.encode(event("response.output_text.delta", { delta: "x" })))
    },
    cancel() { cancelled = true },
  }), { status: 200, headers: { "content-type": "text/event-stream" } })
  const hooks = await GrokAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => auth)
  const res = await opts.fetch("https://cli-chat-proxy.grok.com/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "grok-4.7", input: "hi", stream: true }),
  })
  const reader = res.body.getReader()
  const first = await reader.read()
  expect(new TextDecoder().decode(first.value)).toContain('"delta":"x"')
  const pulled = pulls
  await reader.cancel()
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(cancelled).toBe(true)
  expect(pulls).toBe(pulled)
  expect(pulls).toBeLessThan(5)
})

test("a JSON answer is not retried or rewritten", async () => {
  let calls = 0
  console.warn = () => {}
  globalThis.fetch = async () => {
    calls += 1
    return Response.json({ output: [{ type: "message" }] })
  }
  const hooks = await GrokAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => auth)
  const res = await opts.fetch("https://cli-chat-proxy.grok.com/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "grok-4.7", input: "hi" }),
  })
  const body = await res.json()
  expect(calls).toBe(1)
  expect(body.output[0].type).toBe("message")
  expect(res.headers.get("x-grok-auth-hold")).toBeNull()
  expect(res.headers.get("x-magpie-sign-in")).toBe("kept")
})
