// The OpenAI face, offline: a fake ask (no browser, no network) drives
// both reply shapes. The contract is index.mjs's call site — flatten of
// the request body, completion over the final { text, reasoning }, sse
// over an ask that reports through onUpdate and resolves with the whole.
import { expect, test } from "bun:test"
import { completion, sse } from "./openai.mjs"
import { flatten } from "./prompt.mjs"

const newId = () => "call_" + Math.random().toString(36).slice(2, 14)

test("history flattens into one prompt, systems first, tool context inlined", () => {
  const prompt = flatten([
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello", tool_calls: [{ id: "c1", function: { name: "f", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "42" },
    { role: "user", content: [{ type: "text", text: "now what?" }] },
  ])
  expect(prompt).toContain("[System]\nbe brief")
  expect(prompt).toContain("hi")
  expect(prompt).toContain("[Tool call f] {}")
  expect(prompt).toContain("[Tool result for c1]\n42")
  expect(prompt).toContain("now what?")
  expect(prompt.indexOf("be brief")).toBeLessThan(prompt.indexOf("hi"))
  // empty parts drop out; blank messages leave nothing behind
  expect(flatten([{ role: "user", content: "" }])).toBe("")
  expect(flatten([])).toBe("")
  expect(flatten(undefined)).toBe("")
})

test("completion shapes the whole reply with estimated usage", () => {
  const body = completion({
    id: "chatcmpl-abc",
    model: "gemini-3.1-pro",
    final: { text: "123456", reasoning: "ab" },
    promptTokens: 9,
    newId,
  })
  expect(body.id).toBe("chatcmpl-abc")
  expect(body.object).toBe("chat.completion")
  expect(body.model).toBe("gemini-3.1-pro")
  const msg = body.choices[0].message
  expect(msg.role).toBe("assistant")
  expect(msg.content).toBe("123456")
  expect(msg.reasoning_content).toBe("ab")
  expect(msg.reasoning).toBe("ab")
  expect(body.choices[0].finish_reason).toBe("stop")
  // characters over three: 6 + 2 = 8 -> 3
  expect(body.usage).toEqual({ prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 })
})

test("completion tolerates an empty reply", () => {
  const body = completion({ id: "chatcmpl-x", model: "m", final: {}, promptTokens: 0 })
  expect(body.choices[0].message.content).toBe("")
  expect(body.choices[0].message.reasoning_content).toBeUndefined()
  expect(body.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })
})

// a fake ask: the relay reports once through onUpdate and resolves with
// the whole reply, exactly as wrapAsk (index.mjs) does
const fakeAsk = (final, { updates = 1 } = {}) => async (onUpdate, signal) => {
  expect(signal).toBeUndefined() // index.mjs passes request?.signal, absent offline
  for (let i = 1; i <= updates; i++)
    onUpdate({
      text: final.text.slice(0, Math.ceil((final.text.length * i) / updates)),
      reasoning: final.reasoning.slice(0, Math.ceil((final.reasoning.length * i) / updates)),
    })
  return final
}

async function readSSE(res) {
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toBe("text/event-stream")
  const text = await res.text()
  const lines = text.split("\n").filter((l) => l.startsWith("data: "))
  return {
    text,
    chunks: lines.slice(0, -1).map((l) => JSON.parse(l.slice(6))),
    done: lines[lines.length - 1],
  }
}

test("sse streams the reply as deltas and closes with [DONE]", async () => {
  const res = await sse({
    id: "chatcmpl-s1",
    model: "gemini-3.6-flash",
    promptTokens: () => 6,
    newId,
    ask: fakeAsk({ text: "hello world", reasoning: "thinking" }),
  })
  const { chunks, done } = await readSSE(res)
  expect(done).toBe("data: [DONE]")
  // every chunk is a chat.completion.chunk with the request's id and model
  for (const c of chunks) {
    expect(c.object).toBe("chat.completion.chunk")
    expect(c.id).toBe("chatcmpl-s1")
    expect(c.model).toBe("gemini-3.6-flash")
  }
  // the deltas concatenate back to the whole reply, reasoning first
  const content = chunks.map((c) => c.choices[0].delta.content ?? "").join("")
  const reasoning = chunks.map((c) => c.choices[0].delta.reasoning_content ?? "").join("")
  expect(content).toBe("hello world")
  expect(reasoning).toBe("thinking")
  // the stream closes with a finish chunk carrying the usage estimate
  const last = chunks[chunks.length - 1]
  expect(last.choices[0].finish_reason).toBe("stop")
  expect(last.usage.prompt_tokens).toBe(6)
  expect(last.usage.completion_tokens).toBe(Math.ceil(("hello world".length + "thinking".length) / 3))
  expect(last.usage.total_tokens).toBe(last.usage.prompt_tokens + last.usage.completion_tokens)
})

test("sse works when ask resolves without ever calling onUpdate", async () => {
  const res = await sse({
    id: "chatcmpl-s2",
    model: "m",
    promptTokens: () => 3,
    newId,
    ask: async (onUpdate) => ({ text: "final text", reasoning: "" }),
  })
  const { chunks, done } = await readSSE(res)
  expect(done).toBe("data: [DONE]")
  const content = chunks.map((c) => c.choices[0].delta.content ?? "").join("")
  expect(content).toBe("final text")
  expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe("stop")
})

test("sse drops an aborted signal through to ask", async () => {
  const ctl = new AbortController()
  let seen
  await sse({
    id: "chatcmpl-s3",
    model: "m",
    promptTokens: () => 0,
    newId,
    signal: ctl.signal,
    ask: async (onUpdate, signal) => {
      seen = signal
      return { text: "x", reasoning: "" }
    },
  })
  expect(seen).toBe(ctl.signal)
})

test("sse surfaces an ask failure instead of a silent empty stream", async () => {
  const boom = new Error("Gemini 拒绝了请求")
  await expect(
    sse({ id: "chatcmpl-s4", model: "m", promptTokens: () => 0, newId, ask: async () => { throw boom } }),
  ).rejects.toBe(boom)
})

// the plugin shape, offline: config, provider catalogs, loader's fetch
test("the plugin's shape serves config, models and a loader fetch", async () => {
  const { createPlugin } = await import("./index.mjs")
  const plugin = createPlugin()
  const cfg = { provider: {} }
  await plugin.config(cfg)
  expect(cfg.provider["gemini-web-relay"]).toBeTruthy()
  expect(plugin.auth.provider).toBe("gemini-web-relay")
  expect(plugin.provider.id).toBe("gemini-web-relay")
  // a visitor's catalog is the anonymous Auto only; a signed-in profile's
  // catalog is the full table
  const ms = await plugin.provider.models({}, { auth: { access: "anonymous" } })
  expect(Object.keys(ms)).toEqual(["gemini-auto"])
  const msAuthed = await plugin.provider.models({}, { auth: { access: JSON.stringify({ profileDir: "x" }) } })
  expect(Object.keys(msAuthed).length).toBeGreaterThan(1)
  // the loader answers with a fetch for the chat/completions route
  const opts = await plugin.auth.loader(async () => ({ type: "oauth", access: "anonymous" }))
  expect(typeof opts.fetch).toBe("function")
  const miss = await opts.fetch("https://gemini-web-relay.invalid/v1/other", { method: "POST" })
  expect(miss.status).toBe(404)
  const bad = await opts.fetch("https://gemini-web-relay.invalid/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json",
  })
  expect(bad.status).toBe(400)
  const unknown = await opts.fetch("https://gemini-web-relay.invalid/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "nope", messages: [{ role: "user", content: "hi" }] }),
  })
  expect(unknown.status).toBe(404)
  await plugin.dispose()
})

// the request path end to end, offline: a stubbed session.ask plays the
// relay, and the loader's fetch answers both stream and whole
test("the loader's fetch answers a chat request through a stubbed ask", async () => {
  const { createPlugin } = await import("./index.mjs")
  const { RelaySession } = await import("./relay.mjs")
  const plugin = createPlugin()
  // a signed-in profile's auth: the full model table (a visitor only
  // gets gemini-auto). The profile is never opened — ask is stubbed.
  const auth = async () => ({ type: "oauth", access: JSON.stringify({ profileDir: "C:/fake/profile" }) })
  const opts = await plugin.auth.loader(auth)

  // stub RelaySession.ask for this test only: no browser, no network.
  // It is the same class object index.mjs constructs, so the prototype
  // patch reaches the loader's sessions.
  const calls = []
  const real = RelaySession.prototype.ask
  RelaySession.prototype.ask = async function (prompt, { model, signal, strictModel } = {}) {
    calls.push({ prompt, model: model?.name, strictModel })
    return { text: "17*23 = 391", reasoning: "" }
  }
  try {
    const body = {
      model: "gemini-3.1-pro",
      messages: [
        { role: "system", content: "You are a calculator. Answer with just the number." },
        { role: "user", content: "What is 17*23?" },
      ],
    }
    const whole = await opts.fetch("https://gemini-web-relay.invalid/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, stream: false }),
    })
    expect(whole.status).toBe(200)
    const data = await whole.json()
    expect(data.object).toBe("chat.completion")
    expect(data.choices[0].message.content).toBe("17*23 = 391")
    expect(data.choices[0].finish_reason).toBe("stop")
    expect(calls[0].strictModel).toBe(true) // strict by default
    expect(calls[0].prompt).toContain("What is 17*23?")
    expect(calls[0].prompt).toContain("[System]")

    calls.length = 0
    const streamed = await opts.fetch("https://gemini-web-relay.invalid/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, stream: true }),
    })
    expect(streamed.status).toBe(200)
    expect(streamed.headers.get("content-type")).toBe("text/event-stream")
    const text = await streamed.text()
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true)
    expect(text).toContain("17*23 = 391")
    expect(calls.length).toBe(1)
  } finally {
    RelaySession.prototype.ask = real
  }
  await plugin.dispose()
})

// 4 Neon's thinking depth rides the OpenAI reasoning_effort field, not
// three separate model ids
test("reasoning_effort maps to 4 Neon's thinking byte and is rejected for unknown values", async () => {
  const { createPlugin } = await import("./index.mjs")
  const { RelaySession } = await import("./relay.mjs")
  const plugin = createPlugin()
  const auth = async () => ({ type: "oauth", access: JSON.stringify({ profileDir: "C:/fake/profile" }) })
  const opts = await plugin.auth.loader(auth)
  const seen = []
  const real = RelaySession.prototype.ask
  RelaySession.prototype.ask = async function (prompt, { model } = {}) {
    seen.push(model)
    return { text: "ok", reasoning: "" }
  }
  try {
    const ask = (extra) =>
      opts.fetch("https://gemini-web-relay.invalid/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gemini-3.1-pro", messages: [{ role: "user", content: "hi" }], ...extra }),
      })
    for (const effort of ["low", "medium", "high"]) {
      const r = await ask({ reasoning_effort: effort })
      expect(r.status).toBe(200)
    }
    expect(seen.map((m) => m.b15)).toEqual([1, 4, 2]) // low, medium, high
    expect(seen.every((m) => m.name === "4 Neon")).toBe(true)
    // an unknown depth is a 400, not a silent default
    const bad = await ask({ reasoning_effort: "ultra" })
    expect(bad.status).toBe(400)
    // unset stays the app's own default
    const plain = await ask({})
    expect(plain.status).toBe(200)
    expect(seen[seen.length - 1].b15).toBeUndefined()
  } finally {
    RelaySession.prototype.ask = real
  }
  await plugin.dispose()
})
