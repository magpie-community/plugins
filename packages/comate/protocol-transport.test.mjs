import assert from "node:assert/strict"
import { test } from "node:test"
import { _internal } from "./index.mjs"

const fixtureLicense = "synthetic-test-credential"
const endpoint = "http://127.0.0.1:8627/v1/chat/completions"
const authRecord = { type: "api", source: "comate-paste", key: fixtureLicense, port: 8627 }

function uuidSource() {
  let next = 1
  return () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`
}

async function* bytes(text) {
  yield new TextEncoder().encode(text)
}

async function loadedAuth(fetchImpl, randomUUID = uuidSource()) {
  const pluginFactory = _internal.createPlugin({ fetchImpl, randomUUID, discoveryOptions: { port: 8627 } })
  const plugin = await pluginFactory({})
  const auth = await plugin.auth.loader(async () => authRecord)
  return { plugin, auth }
}

function requestBody({ stream = true } = {}) {
  return JSON.stringify({ model: "fixture-model", stream, messages: [{ role: "user", content: "hello" }] })
}

test("text-only validation accepts known text parts and rejects every unknown typed part", () => {
  assert.equal(_internal.isTextOnly([{ content: "plain" }]), true)
  assert.equal(_internal.isTextOnly([{ content: ["plain", { text: "legacy" }, { type: "text", text: "typed" }, { type: "input_text", text: "input" }, { type: "output_text", text: "output" }] }]), true)
  for (const type of ["input_file", "function", "tool_result", "future_part", "image_url", "input_audio"]) {
    assert.equal(_internal.isTextOnly([{ content: [{ type, text: "payload" }] }]), false, `${type} should be rejected`)
  }
  assert.equal(_internal.isTextOnly([{ content: [{ type: "text", text: "hello", source: { type: "url" } }] }]), false)
  assert.equal(_internal.isTextOnly([{ content: [{ type: "text", text: "hello", image_url: "fixture" }] }]), false)
})

test("empty messages and whitespace-only text return a clear 400 without contacting Comate", async () => {
  let calls = 0
  const { auth } = await loadedAuth(async () => { calls += 1; throw new Error("should not contact Comate") })
  for (const messages of [[], [{ role: "user", content: "  \n" }], [{ role: "user", content: [{ type: "text", text: "" }] }]]) {
    const response = await auth.fetch(endpoint, { method: "POST", body: JSON.stringify({ model: "fixture-model", messages }) })
    assert.equal(response.status, 400)
    assert.match(await response.text(), /at least one non-empty text value/)
  }
  for (const type of ["input_file", "function", "tool_result", "future_part"]) {
    const response = await auth.fetch(endpoint, { method: "POST", body: JSON.stringify({ model: "fixture-model", messages: [{ role: "user", content: [{ type, payload: "ignored" }] }] }) })
    assert.equal(response.status, 400)
    assert.match(await response.text(), /accepts text parts only/)
  }
  assert.equal(calls, 0)
})

test("EOF without task_done is an SSE error and remote cancellation uses the trace ID", async () => {
  const calls = []
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith("/api/v1/conversations/init")) {
      const body = new ReadableStream({
        async start(controller) {
          for await (const chunk of bytes('data: {"kind":"text-delta","delta":"partial"}\n\n')) controller.enqueue(chunk)
          controller.close()
        },
      })
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
    }
    return new Response(null, { status: 200 })
  }
  const { auth } = await loadedAuth(fakeFetch)
  const response = await auth.fetch(endpoint, { method: "POST", body: requestBody() })
  const result = await response.text()
  assert.equal(response.status, 200)
  assert.match(result, /data: \{"error":/)
  const errorLine = result.split("\n").find((line) => line.startsWith("data: {\"error\":"))
  assert.ok(errorLine)
  assert.equal(JSON.parse(errorLine.slice(6)).error.type, "api_error")

  const init = calls.find((call) => call.url.endsWith("/api/v1/conversations/init"))
  const cancel = calls.find((call) => call.url.endsWith("/cancel"))
  assert.equal(init.init.redirect, "error")
  const initPayload = JSON.parse(init.init.body)
  assert.ok(cancel.url.endsWith(`/${initPayload.traceId}/cancel`))
  assert.equal(cancel.init.redirect, "error")
})

test("required tools never stream ordinary text or reasoning before validation", async () => {
  const outputs = [
    "ordinary Comate answer",
    "<|MAGPIE_TOOL_CALLS:fixture-nonce|[malformed marker",
  ]
  const fakeFetch = async () => {
    const text = outputs.shift()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ kind: "text-delta", delta: text })}\n\n`))
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ kind: "thinking-delta", delta: "hidden Comate reasoning" })}\n\n`))
        controller.enqueue(new TextEncoder().encode('data: {"type":"task_done","status":"completed"}\n\n'))
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
  }
  const { auth } = await loadedAuth(fakeFetch)
  const body = JSON.stringify({
    model: "fixture-model",
    stream: true,
    tool_choice: "required",
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    messages: [{ role: "user", content: "Call lookup." }],
  })

  for (const expectedRejectedText of outputs.slice()) {
    const response = await auth.fetch(endpoint, { method: "POST", body })
    const result = await response.text()
    assert.equal(response.status, 200)
    assert.match(result, /data: \{"error":/)
    assert.ok(!result.includes(expectedRejectedText))
    assert.ok(!result.includes("hidden Comate reasoning"))
    assert.ok(!result.includes('"finish_reason":"stop"'))
    assert.match(result, /data: \[DONE\]/)
  }
})

test("an abort stops local stream consumption, requests remote cancel, and removes its listener", async () => {
  const calls = []
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith("/api/v1/conversations/init")) {
      const body = new ReadableStream({
        start(controller) {
          init.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true })
        },
      })
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
    }
    return new Response(null, { status: 200 })
  }
  const { auth } = await loadedAuth(fakeFetch)
  const outer = new AbortController()
  const response = await auth.fetch(endpoint, { method: "POST", body: requestBody(), signal: outer.signal })
  const reader = response.body.getReader()
  const first = await reader.read()
  assert.equal(first.done, false)
  outer.abort()
  const rest = []
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    rest.push(new TextDecoder().decode(next.value))
  }
  assert.equal(rest.join(""), "")
  assert.ok(calls.some((call) => call.url.endsWith("/cancel")))
  assert.ok(calls.every((call) => call.init.redirect === "error"))
})

test("a refused Comate license expires sign-in and redacts the known credential", async () => {
  const fakeFetch = async (_url, init) => {
    assert.equal(init.redirect, "error")
    return new Response(JSON.stringify({ message: `rejected ${fixtureLicense}` }), {
      status: 403,
      headers: { "content-type": "application/json" },
    })
  }
  const { auth } = await loadedAuth(fakeFetch)
  const response = await auth.fetch(endpoint, { method: "POST", body: requestBody({ stream: false }) })
  const body = await response.text()
  assert.equal(response.status, 401)
  assert.equal(response.headers.get("X-Magpie-Sign-In"), "expired")
  assert.ok(!body.includes(fixtureLicense))
  assert.match(body, /\[redacted\]/)
})

test("live model discovery sends licenses only to the loopback endpoint and rejects redirects", async () => {
  let captured
  const fakeFetch = async (url, init) => {
    captured = { url: String(url), init }
    return new Response(JSON.stringify({ code: 0, data: [{ modelId: "fixture-model", modelType: "fixture-type", displayName: "Fixture" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  const { plugin } = await loadedAuth(fakeFetch)
  const models = await plugin.provider.models({ id: "comate", models: {} }, { auth: authRecord })
  assert.ok(models["fixture-model"])
  assert.match(captured.url, /^http:\/\/127\.0\.0\.1:8627\/list-model$/)
  assert.equal(captured.init.redirect, "error")
  assert.equal(models["fixture-model"].capabilities.toolcall, true)
})

test("request cancellation detaches the caller abort listener immediately", async () => {
  const listeners = new Set()
  const outerSignal = {
    aborted: false,
    addEventListener(_type, handler) { listeners.add(handler) },
    removeEventListener(_type, handler) { listeners.delete(handler) },
  }
  let cancelRequest
  const task = _internal.requestTask({
    fetchImpl: async (url, init) => {
      cancelRequest = { url: String(url), init }
      return new Response(null, { status: 200 })
    },
    base: "http://127.0.0.1:8627",
    traceId: "trace-fixture",
    license: fixtureLicense,
    outerSignal,
  })
  assert.equal(listeners.size, 1)
  await task.cancel()
  assert.equal(listeners.size, 0)
  assert.ok(cancelRequest.url.endsWith("/trace-fixture/cancel"))
  assert.equal(cancelRequest.init.redirect, "error")
})
