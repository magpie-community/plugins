import { noRealGrok } from "./nocli.mjs"
import { afterAll, afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GrokAuthPlugin } from "./index.mjs"

noRealGrok()

// Grok Build rejects a 200 that ends as {"error":...} with no created_at
// ("missing field created_at"). A cut before output is asked again; a later
// cut, or one that keeps failing, is closed as response.failed.
const realFetch = globalThis.fetch
const realWarn = console.warn
afterEach(() => {
  globalThis.fetch = realFetch
  console.warn = realWarn
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

test("a stream cut before output is asked again", async () => {
  const { calls, res, text } = await ask([
    () => sse([created("resp_a"), event("response.reasoning_summary_text.delta", { delta: "thinking-once" })], { fail: "ECONNRESET" }),
    () => sse([
      created("resp_b"),
      event("response.output_text.delta", { delta: "pong" }),
      event("response.completed", { response: { id: "resp_b", created_at: 1_700_000_001, status: "completed" } }),
    ]),
  ])
  expect(calls).toBe(2)
  expect(res.status).toBe(200)
  expect(res.headers.get("x-grok-auth-hold")).toBe("cut-retry")
  expect(text).toContain("pong")
  expect(text).not.toContain("thinking-once")
  expect(text).not.toContain("resp_a")
})

test("a stream that ends before output is asked again", async () => {
  const { calls, text } = await ask([
    () => sse([created("resp_empty")]),
    () => sse([
      created("resp_ok"),
      event("response.output_text.delta", { delta: "pong" }),
      event("response.completed", { response: { id: "resp_ok", created_at: 1_700_000_002, status: "completed" } }),
    ]),
  ])
  expect(calls).toBe(2)
  expect(text).toContain("pong")
  expect(text).not.toContain("resp_empty")
})

test("three cuts end as response.failed with created_at", async () => {
  const { calls, res, text } = await ask([
    () => sse([created("resp_1")], { fail: "ECONNRESET" }),
    () => sse([created("resp_2")], { fail: "socket connection was closed unexpectedly" }),
    () => sse([created("resp_3")], { fail: "ECONNRESET" }),
  ])
  expect(calls).toBe(3)
  expect(res.status).toBe(200)
  const failed = eventsOf(text).find((item) => item.type === "response.failed")?.response
  expect(failed.status).toBe("failed")
  expect(failed.created_at).toBe(1_700_000_000)
  expect(failed.id).toBe("resp_3")
  expect(text).toContain("event: response.created")
  expect(text).toContain("event: response.failed")
  expect(text).not.toContain('"type":"api_error"')
})

test("a cut after output is not asked again", async () => {
  const { calls, text } = await ask([
    () => sse([
      created("resp_out"),
      event("response.output_text.delta", { delta: "pong" }),
    ], { fail: "ECONNRESET" }),
    () => sse([event("response.output_text.delta", { delta: "should-not-retry" })]),
  ])
  expect(calls).toBe(1)
  expect(text).toContain("pong")
  expect(text).not.toContain("should-not-retry")
  const failed = eventsOf(text).find((item) => item.type === "response.failed")?.response
  expect(failed.created_at).toBe(1_700_000_000)
  expect(failed.id).toBe("resp_out")
})

test("an aborted stream is not asked again", async () => {
  const { calls, text } = await ask([
    () => sse([created("resp_abort")], { fail: "The operation was aborted." }),
    () => sse([event("response.output_text.delta", { delta: "nope" })]),
  ])
  expect(calls).toBe(1)
  expect(text).not.toContain("nope")
  const failed = eventsOf(text).find((item) => item.type === "response.failed")?.response
  expect(typeof failed.created_at).toBe("number")
  expect(failed.error.message).toContain("The operation was aborted.")
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
