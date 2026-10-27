// plugins#132: a tool call the model wrote into its text that couldn't be
// read (JSON not whole, or a stream that ended inside the block) went out
// as the answer, the call lost, with a 200 and "stop" nothing could fail
// over on. The frames are the issue's, byte for byte; the turn now ends as
// an error, as trae's has since plugins#38: the stream with the error frame
// and no finish, a request not streamed with a 502.
import { afterEach, expect, test } from "bun:test"
import { QoderAuthPlugin } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const API_CHAT = "https://api3.qoder.sh/v1/chat/completions"
const LISTING = { chat: [{ key: "efficient", display_name: "Efficient", enable: true }] }
const line = (body) => `data:${JSON.stringify({ headers: {}, body: typeof body === "string" ? body : JSON.stringify(body), statusCodeValue: 200, statusCode: "OK" })}\n\n`
const chunk = (delta, extra = {}) => line({ choices: [{ delta, index: 0, ...extra }], object: "chat.completion.chunk" })

// the issue's three replies
const CLOSED_BAD = chunk({ content: 'Sure.\n<tool_call>{"name":"read","arguments":{"path":}}</tool_call>' })
const CUT_SHORT = chunk({ content: 'Reading.\n<tool_call>{"name":"read","arguments":{"path":"a.go"' })
const READABLE = chunk({ content: 'Reading.\n<tool_call>{"name":"read","arguments":{"path":"a.go"}}</tool_call>' }) + chunk({}, { finish_reason: "tool_calls" })

// a reply's content given a few characters per frame, as a stream may
const pieces = (content, size = 3) => Array.from({ length: Math.ceil(content.length / size) }, (_, k) => chunk({ content: content.slice(k * size, (k + 1) * size) })).join("")

async function ask(reply, stream) {
  const auth = { type: "oauth", access: "jt", refresh: "rt", expires: Date.now() + 3_600_000, accountId: "one@x", uid: "u1", machineId: "m1" }
  globalThis.fetch = async (url) =>
    new URL(String(url)).pathname.endsWith("/model/list")
      ? new Response(JSON.stringify(LISTING), { headers: { "Content-Type": "application/json" } })
      : new Response(reply, { headers: { "Content-Type": "text/event-stream" } })
  const hooks = await QoderAuthPlugin({ client: { auth: { set: async () => {} } } })
  const l = await hooks.auth.loader(async () => auth)
  const body = { model: "efficient", messages: [{ role: "user", content: "hi" }], ...(stream ? { stream: true } : {}) }
  return l.fetch(API_CHAT, { method: "POST", body: JSON.stringify(body) })
}

// what a streamed reply said: its text, calls, finishes and errors
async function streamed(res) {
  expect(res.status).toBe(200)
  const frames = (await res.text())
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6))
    .filter((d) => d !== "[DONE]")
    .map((d) => JSON.parse(d))
  const deltas = frames.filter((f) => f.choices?.length).map((f) => f.choices[0].delta)
  return {
    text: deltas.map((d) => d.content ?? "").join(""),
    calls: deltas.flatMap((d) => d.tool_calls ?? []).map((t) => [t.function.name, JSON.parse(t.function.arguments)]),
    finish: frames.filter((f) => f.choices?.[0]?.finish_reason).map((f) => f.choices[0].finish_reason),
    errors: frames.filter((f) => f.error).map((f) => f.error.message),
    last: frames.at(-1),
  }
}

for (const [label, reply, text] of [
  ["closed, its JSON not whole", CLOSED_BAD, "Sure.\n"],
  ["the stream ends inside the block", CUT_SHORT, "Reading.\n"],
]) {
  test(`${label}: streamed, the turn ends with the error frame and no finish`, async () => {
    for (const r of [reply, pieces(JSON.parse(JSON.parse(reply.slice(5)).body).choices[0].delta.content)]) {
      const out = await streamed(await ask(r, true))
      expect(out.text).toBe(text)
      expect(out.text).not.toContain("<tool_call>")
      expect(out.calls).toEqual([])
      expect(out.finish).toEqual([])
      expect(out.errors).toHaveLength(1)
      expect(out.last.error).toBeTruthy()
    }
  })

  test(`${label}: not streamed, a 502 and not the block as the answer`, async () => {
    const res = await ask(reply, false)
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error.message).toMatch(/tool call/)
    expect(body.choices).toBeUndefined()
  })
}

test("a block that's only the error is a 502 streamed too: nothing was sent before it", async () => {
  const res = await ask(chunk({ content: '<tool_call>{"name":"read","arguments":{"path":}}</tool_call>' }), true)
  expect(res.status).toBe(502)
})

test("readable, the control: the call, streamed and not", async () => {
  for (const r of [READABLE, pieces('Reading.\n<tool_call>{"name":"read","arguments":{"path":"a.go"}}</tool_call>')]) {
    const out = await streamed(await ask(r, true))
    expect(out.text).toBe("Reading.\n")
    expect(out.calls).toEqual([["read", { path: "a.go" }]])
    expect(out.finish).toEqual(["tool_calls"])
    expect(out.errors).toEqual([])
  }
  const res = await ask(READABLE, false)
  expect(res.status).toBe(200)
  const msg = (await res.json()).choices[0]
  expect(msg.finish_reason).toBe("tool_calls")
  expect(msg.message.content).toBe("Reading.\n")
  expect(msg.message.tool_calls.map((t) => [t.function.name, JSON.parse(t.function.arguments)])).toEqual([["read", { path: "a.go" }]])
})

test("a block whose JSON is whole when the stream ends without its close is still the call", async () => {
  const content = 'Reading.\n<tool_call>{"name":"read","arguments":{"path":"a.go"}}'
  for (const r of [chunk({ content }), pieces(content)]) {
    const out = await streamed(await ask(r, true))
    expect(out.calls).toEqual([["read", { path: "a.go" }]])
    expect(out.finish).toEqual(["tool_calls"])
    expect(out.errors).toEqual([])
  }
  const res = await ask(chunk({ content }), false)
  expect(res.status).toBe(200)
  expect((await res.json()).choices[0].finish_reason).toBe("tool_calls")
})

test("the XML form: whole is the call, cut short or unreadable is the error", async () => {
  const whole = "<tool_call><function=read><parameter=path>a.go</parameter></function>"
  const out = await streamed(await ask(chunk({ content: whole }), true))
  expect(out.calls).toEqual([["read", { path: "a.go" }]])
  for (const bad of ["Reading.\n<tool_call><function=read><parameter=path>a.go", "Reading.\n<tool_call><function=><parameter=path>a.go</parameter></function></tool_call>"]) {
    const s = await streamed(await ask(chunk({ content: bad }), true))
    expect(s.text).toBe("Reading.\n")
    expect(s.finish).toEqual([])
    expect(s.errors).toHaveLength(1)
    expect((await ask(chunk({ content: bad }), false)).status).toBe(502)
  }
})

test("text that only looks like a tag stays text", async () => {
  for (const content of [
    "Use <tool_call>incomplete",
    "A block is <tool_call>name</tool_call> in prose.",
    'Write it as `<tool_call>{"name":` then the rest.',
    'An example:\n```\n<tool_call>{"name":"read","arguments":{"path":}}</tool_call>\n```\n',
    "Ends on <tool_c",
  ]) {
    const out = await streamed(await ask(chunk({ content }), true))
    expect(out.text).toBe(content)
    expect(out.finish).toEqual(["stop"])
    expect(out.errors).toEqual([])
    const res = await ask(chunk({ content }), false)
    expect(res.status).toBe(200)
    expect((await res.json()).choices[0].message.content).toBe(content)
  }
})
