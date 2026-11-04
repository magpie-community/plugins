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

// canonical -> [sapIdentity, displayName, version, deploymentId, configId]
const MODELS = {
  "claude-opus-4-8": ["anthropic--claude-4.8-opus", "Claude 4.8 Opus", "1", "deployment-opus", "cfg-opus"],
  "claude-sonnet-4-6": ["anthropic--claude-4.6-sonnet", "Claude 4.6 Sonnet", "1", "deployment-sonnet", "cfg-sonnet"],
  "claude-opus-4-9": ["anthropic--claude-4.9-opus", "Claude 4.9 Opus", "2", "deployment-newer", "cfg-newer"],
}
const urlFor = id => ROOT + "/v2/inference/deployments/" + id
const frame = obj => `data: ${JSON.stringify(obj)}\n\n`

function wholeMessage(model, content, stop_reason = "end_turn") {
  return { id: "msg_" + stop_reason, type: "message", role: "assistant", model, content, stop_reason, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 8 } }
}

function anthropicError(status, message) {
  return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }), { status })
}

function streamOf(model, content) {
  const chunks = [
    { type: "message_start", message: { ...wholeMessage(model, []), content: [], stop_reason: null } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: content[0].text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } },
    { type: "message_stop" },
  ]
  return new Response(new ReadableStream({
    start(c) { for (const ch of chunks) c.enqueue(new TextEncoder().encode(frame(ch))); c.close() },
  }), { status: 200, headers: { "content-type": "text/event-stream" } })
}

async function fixture(respond) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-cont-"))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const credentialFile = path.join(dir, "credentials.json")
  fs.writeFileSync(credentialFile, JSON.stringify(CREDS), { mode: 0o600 })
  const original = globalThis.fetch
  cleanups.push(() => { globalThis.fetch = original })
  const bodies = []
  const json = body => new Response(JSON.stringify(body))
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === "/oauth/token") return json({ access_token: TOKEN, token_type: "bearer", expires_in: 3600 })
    if (url.pathname === "/v2/lm/deployments") {
      return json({ resources: url.searchParams.get("$skip") === "0" ? Object.values(MODELS).map(([sap, , version, did, cid]) =>
        ({ id: did, status: "RUNNING", deploymentUrl: urlFor(did), configurationId: cid, details: { resources: { backendDetails: { model: { name: sap, version } } } } })) : [] })
    }
    if (url.pathname.startsWith("/v2/lm/configurations/")) {
      const cid = url.pathname.slice("/v2/lm/configurations/".length)
      const entry = Object.values(MODELS).find(m => m[4] === cid)
      return json({ id: cid, scenarioId: "foundation-models", executableId: "aws-bedrock", parameterBindings: [{ key: "modelName", value: entry[0] }, { key: "modelVersion", value: entry[2] }] })
    }
    if (url.pathname === "/v2/lm/scenarios/foundation-models/models") {
      return json({ count: 3, resources: Object.values(MODELS).map(([sap, displayName, version]) =>
        ({ model: sap, executableId: "aws-bedrock", provider: "Anthropic", displayName, allowedScenarios: [{ scenarioId: "foundation-models", executableId: "aws-bedrock" }], versions: [{ name: version, contextLength: 1000000, inputTypes: ["text"], streamingSupported: true }] })) })
    }
    const body = JSON.parse(init.body)
    bodies.push({ url: url.href, body })
    return respond(body, url)
  }
  const plugin = await SAPAICorePlugin()
  const signed = await plugin.auth.methods[0].authorize({ credentialFile })
  assert.equal(signed.type, "success")
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: signed.key, metadata: signed.metadata }))
  const post = (model, body, init = {}) => loader.fetch(ROOT + "/messages", { method: "POST", body: JSON.stringify({ model, max_tokens: 512, ...body }), ...init })
  return { post, bodies }
}

function readStream(response) {
  return (async () => {
    const reader = response.body.getReader()
    const dec = new TextDecoder()
    let buf = ""
    const events = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const data = buf.slice(0, i).split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n")
        buf = buf.slice(i + 2)
        if (data) events.push(JSON.parse(data))
      }
    }
    return events
  })()
}

// A request-validating upstream for the agent tool loop. Turn 1 emits a signed
// (empty-text) thinking block, text, and a tool_use. The continuation must
// replay the complete assistant content in order with the authentic signature
// and a tool_result paired by the original tool_use id, otherwise 400.
const SIGNATURE = "SIG-scenario-7f3a"
const TOOL_ID = "toolu_01CITY"

function toolLoopUpstream({ streamTurn2 = false } = {}) {
  return (body, url) => {
    const assistant = body.messages.find(m => m.role === "assistant")
    if (!assistant) {
      // Turn 1.
      return new Response(JSON.stringify(wholeMessage(body.messages[0]?.content ? "claude-x" : "claude-x", [
        { type: "thinking", thinking: "", signature: SIGNATURE },
        { type: "text", text: "Looking that up." },
        { type: "tool_use", id: TOOL_ID, name: "lookup", input: { city: "Zürich" } },
      ], "tool_use")))
    }
    // Continuation: validate full ordered history and signature/id pairing.
    const order = assistant.content.map(b => b.type)
    const thinking = assistant.content.find(b => b.type === "thinking")
    const toolUse = assistant.content.find(b => b.type === "tool_use")
    const last = body.messages[body.messages.length - 1]
    const toolResult = Array.isArray(last.content) ? last.content.find(b => b.type === "tool_result") : null
    if (order[0] !== "thinking" || order[order.length - 1] !== "tool_use") return anthropicError(400, "assistant content order not replayed")
    if (!thinking || thinking.signature !== SIGNATURE) return anthropicError(400, "invalid or missing thinking signature " + CREDS.clientSecret)
    if (!toolResult || toolResult.tool_use_id !== toolUse.id) return anthropicError(400, "mismatched tool_result")
    const content = [{ type: "text", text: "AICORE_TOOL_OK:Zürich" }]
    return streamTurn2 && url.pathname.endsWith("/invoke-with-response-stream")
      ? streamOf("claude-x", content)
      : new Response(JSON.stringify(wholeMessage("claude-x", content)))
  }
}

function continuation(first, extra = {}) {
  return {
    messages: [
      { role: "user", content: "weather in Zürich?" },
      { role: "assistant", content: first.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: TOOL_ID, content: "12°C" }] },
    ],
    tools: [{ name: "lookup", input_schema: { type: "object" } }],
    tool_choice: { type: "auto" },
    ...extra,
  }
}

const TOOL_TURN1 = { messages: [{ role: "user", content: "weather in Zürich?" }], tools: [{ name: "lookup", input_schema: { type: "object" } }] }

test("a whole agent tool loop replays signed (empty-text) thinking and pairs tool_result by id", async () => {
  const { post, bodies } = await fixture(toolLoopUpstream())
  const first = await (await post("claude-opus-4-8", TOOL_TURN1)).json()
  assert.equal(first.stop_reason, "tool_use")
  assert.equal(first.content.find(b => b.type === "tool_use").id, TOOL_ID)

  const final = await post("claude-opus-4-8", continuation(first))
  assert.equal(final.status, 200)
  assert.equal((await final.json()).content[0].text, "AICORE_TOOL_OK:Zürich")

  // The forwarded continuation body carried the full ordered history verbatim.
  const sent = bodies.at(-1).body
  assert.deepEqual(sent.messages[1].content.map(b => b.type), ["thinking", "text", "tool_use"])
  assert.equal(sent.messages[1].content[0].signature, SIGNATURE)
  assert.equal(sent.messages[1].content[0].thinking, "")
  assert.equal("model" in sent, false)
})

test("a streamed continuation turn completes the tool loop", async () => {
  const { post } = await fixture(toolLoopUpstream({ streamTurn2: true }))
  const first = await (await post("claude-opus-4-8", TOOL_TURN1)).json()
  const events = await readStream(await post("claude-opus-4-8", continuation(first, { stream: true })))
  const text = events.filter(e => e.type === "content_block_delta").map(e => e.delta.text).join("")
  assert.equal(text, "AICORE_TOOL_OK:Zürich")
  assert.equal(events.at(-1).type, "message_stop")
})

test("a tampered thinking signature is surfaced as an upstream error, never repaired", async () => {
  const { post } = await fixture(toolLoopUpstream())
  const first = await (await post("claude-opus-4-8", TOOL_TURN1)).json()
  const tampered = structuredClone(first)
  tampered.content.find(b => b.type === "thinking").signature = "FORGED"
  const response = await post("claude-opus-4-8", continuation(tampered))
  assert.equal(response.status, 400)
  const text = await response.text()
  assert.equal(text.includes(CREDS.clientSecret), false, "credential echo in the native error is redacted")
})

test("a mismatched tool_result id is surfaced as an upstream error, never repaired", async () => {
  const { post } = await fixture(toolLoopUpstream())
  const first = await (await post("claude-opus-4-8", TOOL_TURN1)).json()
  const bad = {
    messages: [
      { role: "user", content: "weather?" },
      { role: "assistant", content: first.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_WRONG", content: "x" }] },
    ],
    tools: [{ name: "lookup", input_schema: { type: "object" } }],
  }
  assert.equal((await post("claude-opus-4-8", bad)).status, 400)
})

test("redacted_thinking and cache_control are forwarded verbatim for upstream validation", async () => {
  const seen = {}
  const { post } = await fixture((body) => {
    const assistant = body.messages.find(m => m.role === "assistant")
    seen.redacted = assistant?.content.some(b => b.type === "redacted_thinking" && b.data === "opaque-blob")
    seen.cache = body.system?.[0]?.cache_control?.type === "ephemeral"
    return new Response(JSON.stringify(wholeMessage("claude-x", [{ type: "text", text: "ok" }])))
  })
  await post("claude-opus-4-8", {
    system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "redacted_thinking", data: "opaque-blob" }, { type: "text", text: "prior" }] },
      { role: "user", content: "again" },
    ],
  })
  assert.equal(seen.redacted, true)
  assert.equal(seen.cache, true)
})


test("the generic newer model runs the same whole tool loop by contract", async () => {
  const { post } = await fixture(toolLoopUpstream())
  const first = await (await post("claude-opus-4-9", TOOL_TURN1)).json()
  assert.equal(first.stop_reason, "tool_use")
  const final = await post("claude-opus-4-9", continuation(first))
  assert.equal((await final.json()).content[0].text, "AICORE_TOOL_OK:Zürich")
})
