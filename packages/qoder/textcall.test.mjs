// plugins#132: a tool call the model wrote into the text that can't be read —
// malformed JSON, or a stream that ends inside the block — was published as
// the answer, the call silently lost, as a 200 that stopped, with nothing for
// the gateway to fail over on. trae's copy of this splitter was fixed the same
// way in 0.2.5/0.2.9 (plugins#38); this is the qoder package's.
import { afterEach, expect, test } from "bun:test"
import { QoderAuthPlugin } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const API_CHAT = "https://api3.qoder.sh/v1/chat/completions"
const LISTING = { chat: [{ key: "efficient", display_name: "Efficient", enable: true }] }
const json = (v) => new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } })
const line = (body) => `data:${JSON.stringify({ headers: {}, body: typeof body === "string" ? body : JSON.stringify(body), statusCodeValue: 200, statusCode: "OK" })}\n\n`
const chunk = (delta, extra = {}) => line({ choices: [{ delta, index: 0, ...extra }], object: "chat.completion.chunk" })

// the loader's fetch against the listing and a chat reply, as busy.test.mjs does
async function chat(reply) {
  const auth = { type: "oauth", access: "jt", refresh: "rt", expires: Date.now() + 3_600_000, accountId: "one@x", uid: "u1", machineId: "m1" }
  globalThis.fetch = async (url) =>
    new URL(String(url)).pathname.endsWith("/model/list") ? json(LISTING) : new Response(reply, { headers: { "Content-Type": "text/event-stream" } })
  const hooks = await QoderAuthPlugin({ client: { auth: { set: async () => {} } } })
  const l = await hooks.auth.loader(async () => auth)
  return (stream) => l.fetch(API_CHAT, { method: "POST", body: JSON.stringify({ model: "efficient", stream, messages: [{ role: "user", content: "hi" }] }) })
}

// a streamed reply, read as its pieces
async function read(res) {
  const out = []
  for (const part of (await res.text()).split("\n")) {
    if (!part.startsWith("data: ")) continue
    const d = part.slice(6)
    out.push(d === "[DONE]" ? d : JSON.parse(d))
  }
  const frames = out.filter((x) => x !== "[DONE]")
  return {
    content: frames.map((x) => x.choices?.[0]?.delta?.content ?? "").join(""),
    finishes: frames.filter((x) => x.choices?.[0]?.finish_reason).map((x) => x.choices[0].finish_reason),
    errors: frames.filter((x) => x.error).map((x) => x.error),
    calls: frames.flatMap((x) => x.choices?.[0]?.delta?.tool_calls ?? []).map((t) => [t.function.name, t.function.arguments]),
  }
}

const UNREADABLE = "the model's tool call, written as text, can't be read; it is not sent on as the answer"
const CUT_SHORT = "the model's tool call, written as text, was cut short; it is not sent on as the answer"

// closed, JSON not whole
const CLOSED_BAD = 'Sure.\n<tool_call>{"name":"read","arguments":{"path":}}</tool_call>'
// the stream ends inside the block, its JSON whole or not
const CUT_MALFORMED = 'Sure.\n<tool_call>{"name":"read","arguments":{"path":}}'
const CUT = 'Reading.\n<tool_call>{"name":"read","arguments":{"path":"a.go"'
const WHOLE_NO_CLOSE = 'Reading.\n<tool_call>{"name":"read","arguments":{"path":"a.go"}}'
const READABLE = 'Reading.\n<tool_call>{"name":"read","arguments":{"path":"a.go"}}</tool_call>'
const READABLE_XML = 'Reading.\n<tool_call>\n<function=read>\n<parameter=path>a.go</parameter>\n</function>\n</tool_call>'

test("an unreadable call written as text ends the turn as an error, never as the answer", async () => {
  const ask = await chat(chunk({ content: CLOSED_BAD }))
  const got = await read(await ask(true))
  expect(got.content).toBe("Sure.\n")
  expect(got.errors).toEqual([{ message: UNREADABLE, code: 502 }])
  expect(got.finishes).toEqual([])
})

test("a call the stream ends inside ends the turn as an error, never as the answer", async () => {
  for (const [bad, content] of [[CUT_MALFORMED, "Sure.\n"], [CUT, "Reading.\n"]]) {
    const ask = await chat(chunk({ content: bad }))
    const got = await read(await ask(true))
    expect(got.content).toBe(content)
    expect(got.errors).toEqual([{ message: CUT_SHORT, code: 502 }])
    expect(got.finishes).toEqual([])
  }
})

test("without a stream the same replies are a 502", async () => {
  for (const [bad, said] of [[CLOSED_BAD, UNREADABLE], [CUT, CUT_SHORT]]) {
    const ask = await chat(chunk({ content: bad }))
    const res = await ask(false)
    expect(res.status).toBe(502)
    expect((await res.json()).error.message).toBe(said)
  }
})

test("a call whose JSON is whole when the stream ends without its close is still the call", async () => {
  const ask = await chat(chunk({ content: WHOLE_NO_CLOSE }))
  const got = await read(await ask(true))
  expect(got.errors).toEqual([])
  expect(got.calls).toEqual([["read", '{"path":"a.go"}']])
  expect(got.finishes).toEqual(["tool_calls"])
})

test("a readable call is still the call, whole or one character at a time", async () => {
  for (const call of [READABLE, READABLE_XML]) {
    for (const reply of [chunk({ content: call }), [...call].map((c) => chunk({ content: c })).join("")]) {
      const ask = await chat(reply + chunk({}, { finish_reason: "tool_calls" }))
      const got = await read(await ask(true))
      expect(got.errors).toEqual([])
      expect(got.calls).toEqual([["read", '{"path":"a.go"}']])
      expect(got.content).toBe("Reading.\n")
      expect(got.finishes).toEqual(["tool_calls"])
    }
  }
})

test("text that only looks like a tag stays text", async () => {
  for (const s of ["before <tool_call>incomplete", "<tool_call>hello</tool_call>"]) {
    const ask = await chat(chunk({ content: s }) + chunk({}, { finish_reason: "stop" }))
    const got = await read(await ask(true))
    expect(got.errors).toEqual([])
    expect(got.content).toBe(s)
    expect(got.finishes).toEqual(["stop"])
  }
})
