import { test, expect } from "bun:test"
import { _internal } from "./index.mjs"

const { buildKiro, events, reply, generate, features, sealReasoning, unsealReasoning } = _internal
const scope = "account-region-model"
const native = { reasoningText: { text: "The path costs 35.", signature: "CAQSbmF0aXZlLXNpZ25hdHVyZQ==" } }
const creds = async () => ({ token: "t", tokenType: "SSO_OIDC", idc: true, profile: "arn:aws:codewhisperer:us-east-1:1:profile/P", region: "us-east-1" })
const auth = { accountId: "account", uid: "enterprise" }
const model = "claude-opus-5.5"
const req = { model, messages: [{ role: "user", content: "Compute the path, then ask for confirmation." }] }

function frame(type, payload) {
  const enc = new TextEncoder()
  const hs = Object.entries({ ":message-type": "event", ":event-type": type }).map(([k, v]) => {
    const name = enc.encode(k), value = enc.encode(v)
    const h = new Uint8Array(4 + name.length + value.length)
    h[0] = name.length
    h.set(name, 1)
    h[1 + name.length] = 7
    new DataView(h.buffer).setUint16(2 + name.length, value.length)
    h.set(value, 4 + name.length)
    return h
  })
  const hlen = hs.reduce((n, h) => n + h.length, 0)
  const body = enc.encode(JSON.stringify(payload))
  const out = new Uint8Array(16 + hlen + body.length)
  new DataView(out.buffer).setUint32(0, out.length)
  new DataView(out.buffer).setUint32(4, hlen)
  let at = 12
  for (const h of hs) { out.set(h, at); at += h.length }
  out.set(body, at)
  return out
}

const stream = (...frames) => new ReadableStream({ start(c) { for (const f of frames) c.enqueue(f); c.close() } })
const gar = () => new Response(stream(
  frame("reasoningContentEvent", native.reasoningText),
  frame("toolUseEvent", { toolUseId: "call1", name: "confirm", input: "{}" }),
  frame("metadataEvent", { stopReason: "TOOL_USE" }),
))
const sse = (...events) => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""))
const cr = () => sse(
  { type: "response.reasoning_text.delta", delta: native.reasoningText.text },
  { type: "response.output_item.done", item: { type: "reasoning", encrypted_content: JSON.stringify(native) } },
  { type: "response.output_item.added", item: { type: "function_call", call_id: "call1", name: "confirm", arguments: "{}" } },
  { type: "response.output_item.done", item: { type: "function_call", call_id: "call1", name: "confirm", arguments: "{}" } },
  { type: "response.completed", response: { status: "completed", usage: {} } },
)
async function content(res, streamed) {
  if (!streamed) return (await res.json()).content
  const out = []
  for (const line of (await res.text()).split("\n")) {
    if (!line.startsWith("data:")) continue
    const e = JSON.parse(line.slice(5))
    if (e.type === "content_block_start") out[e.index] = { ...e.content_block }
    if (e.type === "content_block_delta") {
      const b = out[e.index], d = e.delta
      if (d.type === "thinking_delta") b.thinking += d.thinking
      if (d.type === "signature_delta") b.signature += d.signature
    }
  }
  return out
}

for (const api of ["gar", "responses"]) for (const streamed of [false, true]) {
  test(`${api}, stream=${streamed}: signed thinking survives a tool continuation`, async () => {
    const realFetch = globalThis.fetch
    const bodies = []
    features.clear()
    globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path === "/featureConfiguration") return Response.json(api === "responses" ? { configuration: { [_internal.featureKey("create_response_api")]: "create_response" } } : {})
      bodies.push(JSON.parse(init.body))
      return api === "responses" ? cr() : gar()
    }
    try {
      const blocks = await content(await generate(creds, auth, { ...req, stream: streamed }, undefined, "session"), streamed)
      const thought = blocks.find(b => b.type === "thinking")
      expect(thought.thinking).toBe(native.reasoningText.text)
      expect(thought.signature.startsWith("kiro:")).toBe(true)
      const messages = [...req.messages, { role: "assistant", content: blocks }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call1", content: "approved" }] }]
      await (await generate(creds, auth, { ...req, messages }, undefined, "session")).text()
      expect(bodies).toHaveLength(2)
      const sent = api === "responses"
        ? JSON.parse(bodies[1].input.find(it => it.type === "reasoning").encrypted_content)
        : bodies[1].conversationState.history[1].assistantResponseMessage.reasoningContent
      expect(sent).toEqual(native)
    } finally {
      globalThis.fetch = realFetch
    }
  })
}

test("a foreign Anthropic signature makes one request without reasoning", async () => {
  const realFetch = globalThis.fetch
  const bodies = []
  features.clear()
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input)).pathname === "/featureConfiguration") return Response.json({})
    bodies.push(JSON.parse(init.body))
    return gar()
  }
  try {
    const messages = [...req.messages, { role: "assistant", content: [{ type: "thinking", thinking: "foreign", signature: "EqQBCgIYAhIM1gbcDa9GJwZA2b==" }, { type: "text", text: "ready" }] }, { role: "user", content: "continue" }]
    await (await generate(creds, auth, { ...req, messages }, undefined, "session")).text()
    expect(bodies).toHaveLength(1)
    expect(bodies[0].conversationState.history[1].assistantResponseMessage).toEqual({ content: "ready" })
  } finally {
    globalThis.fetch = realFetch
  }
})

test("reasoning is bound to the account, region and model scope", () => {
  const signature = sealReasoning(native, scope)
  expect(unsealReasoning(signature, scope)).toEqual(native)
  const b = JSON.parse(buildKiro({ messages: [
    ...req.messages,
    { role: "assistant", content: [{ type: "thinking", thinking: native.reasoningText.text, signature }, { type: "text", text: "ready" }] },
    { role: "user", content: "continue" },
  ] }, model, "", 0, "session", "another-account-region-model"))
  expect(b.conversationState.history[1].assistantResponseMessage).toEqual({ content: "ready" })
})

test("a separate assistant message keeps its signed reasoning when merged with its call", () => {
  const signature = sealReasoning(native, scope)
  const b = JSON.parse(buildKiro({ messages: [
    ...req.messages,
    { role: "assistant", content: [{ type: "tool_use", id: "call1", name: "confirm", input: {} }] },
    { role: "assistant", content: [{ type: "thinking", thinking: native.reasoningText.text, signature }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call1", content: "approved" }] },
  ] }, model, "", 0, "session", scope))
  expect(b.conversationState.history[1].assistantResponseMessage.reasoningContent).toEqual(native)
  expect(b.conversationState.history[1].assistantResponseMessage.toolUses).toHaveLength(1)
})

test("a signature-only event after a tool call retains its block, whole and streamed", async () => {
  for (const streamed of [false, true]) {
    const body = stream(frame("toolUseEvent", { toolUseId: "call1", name: "confirm", input: "{}" }), frame("reasoningContentEvent", { signature: native.reasoningText.signature }), frame("metadataEvent", { stopReason: "TOOL_USE" }))
    const blocks = await content(await reply(events(body, model, 0, false, scope), model, streamed), streamed)
    const thought = blocks.find(b => b.type === "thinking")
    expect(unsealReasoning(thought.signature, scope)).toEqual({ reasoningText: { text: "", signature: native.reasoningText.signature } })
  }
})

test("redacted state survives streamed and whole replies", async () => {
  for (const streamed of [false, true]) {
    const body = stream(frame("reasoningContentEvent", { redactedContent: "UkVEQUNURUQ=" }), frame("metadataEvent", { stopReason: "END_TURN" }))
    const blocks = await content(await reply(events(body, model, 0, false, scope), model, streamed), streamed)
    expect(unsealReasoning(blocks[0].data, scope)).toEqual({ redactedContent: "UkVEQUNURUQ=" })
  }
})

test("the first native-model request loads its schema and applies magpie's effort header", async () => {
  const { KiroAuthPlugin } = await import("./index.mjs?native-effort-loader")
  const realFetch = globalThis.fetch
  const bodies = [], paths = []
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname
    paths.push(path)
    if (path === "/List-Available-Models") return Response.json({ models: [{ modelId: "gpt-5.6-luna", additionalModelRequestFieldsSchema: { properties: { reasoning: { properties: { effort: { enum: ["none", "low", "medium", "high", "xhigh", "max"] } } } } } }] })
    if (path === "/featureConfiguration") return Response.json({})
    bodies.push(JSON.parse(init.body))
    return gar()
  }
  try {
    const plugin = await KiroAuthPlugin()
    const loader = await plugin.auth.loader(async () => ({ type: "oauth", access: "t", expires: Date.now() + 3600000, accountId: "account", uid: "google", loginProvider: "Google", profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/P", region: "us-east-1" }))
    const res = await loader.fetch("https://kiro.test/v1/messages", { method: "POST", headers: { "x-magpie-effort": "low" }, body: JSON.stringify({ model: "gpt-5.6-luna", output_config: { effort: "max" }, messages: req.messages }) })
    await res.text()
    expect(paths).toContain("/List-Available-Models")
    expect(bodies).toHaveLength(1)
    expect(bodies[0].additionalModelRequestFields).toEqual({ reasoning: { effort: "low" } })
  } finally {
    globalThis.fetch = realFetch
  }
})

test("Kiro's captured HTTP 400 signature refusal reaches the client", async () => {
  const realFetch = globalThis.fetch
  const bodies = []
  features.clear()
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input)).pathname === "/featureConfiguration") return Response.json({})
    bodies.push(JSON.parse(init.body))
    return Response.json({ message: "messages.1.content.0: Invalid `signature` in `thinking` block", reason: "THINKING_SIGNATURE_INVALID" }, { status: 400 })
  }
  try {
    const res = await generate(creds, auth, req, undefined, "session")
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toContain("THINKING_SIGNATURE_INVALID")
    expect(bodies).toHaveLength(1)
  } finally {
    globalThis.fetch = realFetch
  }
})
