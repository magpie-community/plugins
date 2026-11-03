import { test, afterEach, jest } from "bun:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SAPAICorePlugin } from "../src/index.js"

const cleanups = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
  jest.useRealTimers()
})

const ROOT = "https://api.ai.eu10.hana.ondemand.com"
const CREDS = {
  authUrl: "https://synthetic.authentication.eu10.hana.ondemand.com",
  baseUrl: ROOT + "/v2",
  clientId: "sentinel-client",
  clientSecret: "sentinel-client-secret",
  resourceGroup: "group-a",
}
const TOKEN = "sentinel-bearer-token"
const OPUS_SAP = "anthropic--claude-4.8-opus"
const OPUS = "claude-opus-4-8"
const OPUS_URL = ROOT + "/v2/inference/deployments/deployment-opus"

const frame = obj => `data: ${JSON.stringify(obj)}\n\n`

// A text + tool_use streamed turn, terminated by message_stop.
const STREAM = [
  { type: "message_start", message: { id: "msg_s1", type: "message", role: "assistant", model: OPUS, content: [], stop_reason: null, usage: { input_tokens: 9, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Grüß " } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "dich🙂" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "lookup", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"city\":" } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "\"Zürich🙂\"}" } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } },
  { type: "message_stop" },
]

function streamResponse(chunks, { onPull } = {}) {
  let i = 0
  const enc = new TextEncoder()
  const stream = new ReadableStream({
    pull(controller) {
      onPull?.(i)
      if (i >= chunks.length) { controller.close(); return }
      const chunk = chunks[i++]
      controller.enqueue(typeof chunk === "string" ? enc.encode(chunk) : chunk)
    },
  }, { highWaterMark: 0 })
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
}

async function fixture(inference, pluginOptions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-stream-"))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const credentialFile = path.join(dir, "credentials.json")
  fs.writeFileSync(credentialFile, JSON.stringify(CREDS), { mode: 0o600 })
  const original = globalThis.fetch
  cleanups.push(() => { globalThis.fetch = original })
  const json = body => new Response(JSON.stringify(body))
  const calls = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === "/oauth/token") return json({ access_token: TOKEN, token_type: "bearer", expires_in: 3600 })
    if (url.pathname === "/v2/lm/deployments") {
      return json({ resources: url.searchParams.get("$skip") === "0" ? [
        { id: "deployment-opus", status: "RUNNING", deploymentUrl: OPUS_URL, configurationId: "cfg-opus", details: { resources: { backendDetails: { model: { name: OPUS_SAP, version: "1" } } } } },
      ] : [] })
    }
    if (url.pathname === "/v2/lm/configurations/cfg-opus") return json({ id: "cfg-opus", scenarioId: "foundation-models", executableId: "aws-bedrock", parameterBindings: [{ key: "modelName", value: OPUS_SAP }, { key: "modelVersion", value: "1" }] })
    if (url.pathname === "/v2/lm/scenarios/foundation-models/models") return json({ count: 1, resources: [
      { model: OPUS_SAP, executableId: "aws-bedrock", provider: "Anthropic", displayName: "Claude 4.8 Opus", allowedScenarios: [{ scenarioId: "foundation-models", executableId: "aws-bedrock" }], versions: [{ name: "1", contextLength: 1000000, inputTypes: ["text"], streamingSupported: true }] },
    ] })
    calls.push({ url: url.href, init })
    return inference(url, init)
  }
  const plugin = await SAPAICorePlugin(pluginOptions)
  const signed = await plugin.auth.methods[0].authorize({ credentialFile })
  assert.equal(signed.type, "success")
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: signed.key, metadata: signed.metadata }))
  const post = (body, init = {}) => loader.fetch(ROOT + "/messages", { method: "POST", body: JSON.stringify({ model: OPUS, messages: [{ role: "user", content: "hi" }], max_tokens: 256, stream: true, ...body }), ...init })
  return { plugin, loader, post, calls }
}

function consumer(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const events = []
  const next = async () => {
    for (;;) {
      const split = buffer.indexOf("\n\n")
      if (split >= 0) {
        const block = buffer.slice(0, split); buffer = buffer.slice(split + 2)
        const data = block.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n")
        if (data) { const event = JSON.parse(data); events.push(event); return event }
        continue
      }
      const chunk = await reader.read()
      if (chunk.done) return null
      buffer += decoder.decode(chunk.value, { stream: true })
    }
  }
  return { reader, events, next, async finish() { while (await next()) {} return events } }
}

test("a streamed request routes to /invoke-with-response-stream and relays text then tool-arg deltas before the terminal", async () => {
  const { post, calls } = await fixture(() => streamResponse(STREAM.map(frame)))
  const response = await post()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("content-type"), "text/event-stream")
  assert.equal(calls.at(-1).url, OPUS_URL + "/invoke-with-response-stream")

  const c = consumer(response)
  const events = await c.finish()
  const text = events.filter(e => e.type === "content_block_delta" && e.delta.type === "text_delta").map(e => e.delta.text).join("")
  assert.equal(text, "Grüß dich🙂")
  const toolJson = events.filter(e => e.type === "content_block_delta" && e.delta.type === "input_json_delta").map(e => e.delta.partial_json).join("")
  assert.deepEqual(JSON.parse(toolJson), { city: "Zürich🙂" })
  assert.equal(events.find(e => e.type === "content_block_start" && e.index === 1).content_block.id, "toolu_1")
  assert.equal(events.at(-1).type, "message_stop")
})

test("each relayed frame carries the native SSE event name, including the error frame", async () => {
  // SAP relays data-only frames; clients such as pi dispatch on the `event:` name
  // and skip nameless frames, so they must be synthesized from the event type.
  const { post } = await fixture(() => streamResponse([
    frame(STREAM[0]), frame(STREAM[9]), frame(STREAM[10]), // message_start, message_delta, message_stop
  ]))
  const raw = await new Response((await post()).body).text()
  const frames = raw.split("\n\n").filter(Boolean)
  for (const block of frames) {
    const name = block.split("\n").find(l => l.startsWith("event:"))?.slice(6).trim()
    const data = JSON.parse(block.split("\n").find(l => l.startsWith("data:")).slice(5).trim())
    assert.equal(name, data.type, "each frame names its event type")
  }
  assert.ok(frames.some(b => b.includes("event: message_delta")), "stop reason frame is named")
  assert.ok(frames.some(b => b.includes("event: message_stop")))

  // A local truncation failure frame is also a named error event.
  const { post: post2 } = await fixture(() => streamResponse([frame(STREAM[0])]))
  const raw2 = await new Response((await post2()).body).text()
  assert.ok(raw2.includes("event: error"), "truncation yields a named error frame")
})

test("the relay pulls one frame per read and does not reach the terminal until consumed", async () => {
  let pulls = 0
  const { post } = await fixture(() => streamResponse(STREAM.map(frame), { onPull: () => { pulls++ } }))
  const c = consumer(await post())
  // Read only the first text delta.
  let first
  do { first = await c.next() } while (first && !(first.type === "content_block_delta" && first.delta.type === "text_delta"))
  assert.equal(first.delta.text, "Grüß ")
  assert.ok(pulls < STREAM.length, `stopped consumer must not drain the whole reply (pulls=${pulls})`)
  const rest = await c.finish()
  assert.equal(rest.at(-1).type, "message_stop")
})

test("fragmented bytes across frame and multibyte boundaries reassemble without corruption", async () => {
  const bytes = Buffer.from(STREAM.map(frame).join(""), "utf8")
  const chunks = []
  for (let i = 0; i < bytes.length; i += 3) chunks.push(bytes.subarray(i, i + 3))
  const { post } = await fixture(() => streamResponse(chunks))
  const events = await consumer(await post()).finish()
  const text = events.filter(e => e.type === "content_block_delta" && e.delta.type === "text_delta").map(e => e.delta.text).join("")
  assert.equal(text, "Grüß dich🙂")
  assert.equal(events.at(-1).type, "message_stop")
})

test("a native stream error frame surfaces and redacts credential echoes", async () => {
  const chunks = [frame(STREAM[0]), frame({ type: "error", message: "fail " + CREDS.clientSecret, details: { echo: CREDS.clientSecret }, error: { type: "overloaded_error", message: "native failure" } })]
  const { post } = await fixture(() => streamResponse(chunks))
  const raw = await new Response((await post()).body).text()
  // The redacted error frame must be a single well-formed event: the data line
  // immediately follows the name, with no blank line splitting them.
  assert.ok(/event: error\ndata: \{/.test(raw), "redacted error frame keeps data adjacent to its event name")
  const parsed = await consumer({ body: new Response(raw).body }).finish()
  const error = parsed.find(e => e.type === "error")
  assert.ok(error && error.error.type === "overloaded_error")
  assert.equal(raw.includes(CREDS.clientSecret), false)
  assert.equal(error.error.message, "native failure")
})

test("a stream truncated before message_stop ends in a safe error, never a fabricated completion", async () => {
  const chunks = [frame(STREAM[0]), frame(STREAM[2])] // message_start + a text delta, then EOF
  const { post } = await fixture(() => streamResponse(chunks))
  const events = await consumer(await post()).finish()
  assert.equal(events.some(e => e.type === "message_stop"), false)
  assert.equal(events.at(-1).type, "error")
})

test("an unknown stream event type is rejected as a safe error", async () => {
  const chunks = [frame(STREAM[0]), frame({ type: "totally_unknown_event" })]
  const { post } = await fixture(() => streamResponse(chunks))
  const events = await consumer(await post()).finish()
  assert.equal(events.at(-1).type, "error")
})

test("cancelling a streamed consumer aborts the owned upstream and an independent request recovers", async () => {
  let cancelled = false
  const gated = () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(frame(STREAM[0]) + frame(STREAM[2]))) },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 }), { status: 200, headers: { "content-type": "text/event-stream" } })
  const { post } = await fixture((url) => url.pathname.endsWith("/invoke-with-response-stream") ? gated() : new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: OPUS, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } })))
  const abort = new AbortController()
  const response = await post({}, { signal: abort.signal })
  const c = consumer(response)
  await c.next() // message_start
  abort.abort()
  await assert.rejects(c.finish())
  await new Promise(r => setTimeout(r, 20))
  assert.equal(cancelled, true, "owned upstream body was cancelled")
  // An independent non-streaming request recovers.
  const recovered = await post({ stream: false })
  assert.equal(recovered.status, 200)
  assert.equal((await recovered.json()).content[0].text, "ok")
})

test("malformed terminal states (bare, missing stop reason, out-of-order, bad or duplicate opener) end in a safe error", async () => {
  const cases = {
    "bare terminal": [frame({ type: "message_stop" })],
    "terminal without a resolved stop reason": [frame(STREAM[0]), frame({ type: "message_stop" })],
    "content before the opener": [frame(STREAM[1]), frame(STREAM[0])],
    "opener without an initial null stop_reason": [frame({ type: "message_start", message: { ...STREAM[0].message, stop_reason: "end_turn" } })],
    "duplicate opener": [frame(STREAM[0]), frame(STREAM[0])],
    "opener without identity": [frame({ type: "message_start", message: { ...STREAM[0].message, id: "" } })],
    "opener with wrong role": [frame({ type: "message_start", message: { ...STREAM[0].message, role: "user" } })],
    "opener without usage": [frame({ type: "message_start", message: { ...STREAM[0].message, usage: undefined } })],
    "malformed stop reason": [frame(STREAM[0]), frame({ type: "message_delta", delta: { stop_reason: "" } }), frame(STREAM[10])],
    "duplicate stop reason": [frame(STREAM[0]), frame(STREAM[9]), frame(STREAM[9]), frame(STREAM[10])],
  }
  for (const [label, chunks] of Object.entries(cases)) {
    const { post } = await fixture(() => streamResponse(chunks))
    const events = await consumer(await post()).finish()
    assert.equal(events.some(e => e.type === "message_stop"), false, label)
    assert.equal(events.at(-1).type, "error", label)
  }
})

test("a valid message_start, resolved message_delta and message_stop sequence is relayed as a completion", async () => {
  const { post } = await fixture(() => streamResponse([frame(STREAM[0]), frame(STREAM[9]), frame(STREAM[10])]))
  const events = await consumer(await post()).finish()
  assert.equal(events.at(-1).type, "message_stop")
  assert.equal(events.find(e => e.type === "message_delta").delta.stop_reason, "tool_use")
})

test("arriving stream chunks reset the idle timeout so active Claude turns exceed a single idle window", async () => {
  const chunks = [frame(STREAM[0]), frame(STREAM[1]), frame(STREAM[2]), frame(STREAM[3]), frame(STREAM[4]), frame(STREAM[9]), frame(STREAM[10])]
  let i = 0
  const enc = new TextEncoder()
  const paced = () => new Response(new ReadableStream({
    async pull(controller) {
      if (i >= chunks.length) { controller.close(); return }
      await new Promise(r => setTimeout(r, 20))
      controller.enqueue(enc.encode(chunks[i++]))
    },
  }, { highWaterMark: 0 }), { status: 200, headers: { "content-type": "text/event-stream" } })
  // Total duration (~140ms) exceeds the 55ms idle window, but each chunk arrives within 20ms.
  const { post } = await fixture(paced, { idleTimeoutMs: 55, totalTimeoutMs: 500 })
  const events = await consumer(await post()).finish()
  assert.equal(events.at(-1).type, "message_stop")
})

test("a stalled Claude stream rejects with inference-idle-timeout while an active stream exceeding totalTimeoutMs rejects with inference-timeout", async () => {
  let stalledCancelled = false
  const stalled = () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(frame(STREAM[0]))) },
    cancel() { stalledCancelled = true },
  }, { highWaterMark: 0 }), { status: 200, headers: { "content-type": "text/event-stream" } })
  const { post: postStalled } = await fixture(stalled, { idleTimeoutMs: 25, totalTimeoutMs: 500 })
  const c1 = consumer(await postStalled())
  assert.equal((await c1.next()).type, "message_start")
  let idleErr
  await assert.rejects(c1.finish(), err => { idleErr = err; return true })
  assert.equal(idleErr.code, "inference-idle-timeout")
  await new Promise(r => setImmediate(r))
  assert.equal(stalledCancelled, true)

  // Continuous ping chunks keep resetting the 50ms idle timer, but the 70ms total ceiling still terminates the stream.
  let activeCancelled = false
  let opened = false
  const enc = new TextEncoder()
  const endless = () => new Response(new ReadableStream({
    async pull(controller) {
      if (!opened) {
        opened = true
        controller.enqueue(enc.encode(frame(STREAM[0])))
        return
      }
      await new Promise(r => setTimeout(r, 15))
      controller.enqueue(enc.encode(frame({ type: "ping" })))
    },
    cancel() { activeCancelled = true },
  }, { highWaterMark: 0 }), { status: 200, headers: { "content-type": "text/event-stream" } })
  const { plugin, post: postEndless } = await fixture(endless)
  await plugin.config({ provider: { "sap-aicore": { options: { idleTimeoutMs: 50, totalTimeoutMs: 70 } } } })
  const c2 = consumer(await postEndless())
  let totalErr
  await assert.rejects(c2.finish(), err => { totalErr = err; return true })
  assert.equal(totalErr.code, "inference-timeout")
  await new Promise(r => setImmediate(r))
  assert.equal(activeCancelled, true)
})
