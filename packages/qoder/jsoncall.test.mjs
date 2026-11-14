// plugins#1113: a reply that was one JSON object in OpenAI's own wire shape,
// {"tool_calls":[{"name","arguments"}]}, written as text, went out as the
// answer with "stop", the calls lost. The replies are the issue's, byte for
// byte; the object is now those calls, finished tool_calls. One cut short,
// or with an entry that can't be read, ends the turn as an error (as
// plugins#132's <tool_call> block does); JSON in prose or code stays text.
import { afterEach, expect, test } from "bun:test"
import { QoderAuthPlugin } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const API_CHAT = "https://api3.qoder.sh/v1/chat/completions"
const LISTING = { chat: [{ key: "efficient", display_name: "Efficient", enable: true }] }
const line = (body) => `data:${JSON.stringify({ headers: {}, body: typeof body === "string" ? body : JSON.stringify(body), statusCodeValue: 200, statusCode: "OK" })}\n\n`
const chunk = (delta, extra = {}) => line({ choices: [{ delta, index: 0, ...extra }], object: "chat.completion.chunk" })
const pieces = (content, size = 3) => Array.from({ length: Math.ceil(content.length / size) }, (_, k) => chunk({ content: content.slice(k * size, (k + 1) * size) })).join("")
const STOP = chunk({}, { finish_reason: "stop" })

// the issue's replies
const BARE = '{"tool_calls":[{"name":"read_file","arguments":{"path":"a.go"}},{"name":"viking_search","arguments":{"query":"x"}}]}'
const CALLS = [
  ["read_file", { path: "a.go" }],
  ["viking_search", { query: "x" }],
]

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
  }
}

async function whole(reply) {
  const res = await ask(reply, false)
  expect(res.status).toBe(200)
  const c = (await res.json()).choices[0]
  return { text: c.message.content ?? "", calls: (c.message.tool_calls ?? []).map((t) => [t.function.name, JSON.parse(t.function.arguments)]), finish: c.finish_reason }
}

for (const [label, prose] of [
  ["bare JSON, no wrapper", ""],
  ["bare JSON after a line of prose", "Let me read that.\n"],
]) {
  test(`${label}: the calls, finished tool_calls, streamed and not`, async () => {
    const replies = [(prose ? chunk({ content: prose }) : "") + chunk({ content: BARE }) + STOP, pieces(prose + BARE) + STOP, pieces(prose + BARE, 1) + STOP]
    for (const r of replies) {
      const out = await streamed(await ask(r, true))
      expect(out.text).toBe(prose)
      expect(out.calls).toEqual(CALLS)
      expect(out.finish).toEqual(["tool_calls"])
      expect(out.errors).toEqual([])
      expect(await whole(r)).toEqual({ text: prose, calls: CALLS, finish: "tool_calls" })
    }
  })
}

test("the control: the same call inside <tool_call> is still the call", async () => {
  const r = chunk({ content: '<tool_call>{"name":"read_file","arguments":{"path":"a.go"}}</tool_call>' }) + chunk({}, { finish_reason: "tool_calls" })
  const out = await streamed(await ask(r, true))
  expect(out.calls).toEqual([CALLS[0]])
  expect(out.finish).toEqual(["tool_calls"])
})

test("arguments as a JSON string, and the function wrapper, are read too", async () => {
  const content = '{"tool_calls":[{"name":"read_file","arguments":"{\\"path\\":\\"a.go\\"}"},{"type":"function","function":{"name":"viking_search","arguments":{"query":"x"}}}]}\n'
  const out = await streamed(await ask(chunk({ content }) + STOP, true))
  expect(out.calls).toEqual(CALLS)
  expect(out.text).toBe("")
  expect(out.finish).toEqual(["tool_calls"])
})

for (const [label, content] of [
  ["cut short", "Let me read that.\n" + BARE.slice(0, 60)],
  ["an entry with no name", 'Let me read that.\n{"tool_calls":[{"arguments":{"path":"a.go"}}]}'],
  ["arguments that aren't an object", 'Let me read that.\n{"tool_calls":[{"name":"read_file","arguments":"a.go"}]}'],
  ["not JSON once whole", 'Let me read that.\n{"tool_calls":[{"name":"read_file","arguments":{"path":}}]}'],
]) {
  test(`${label}: the turn ends as an error, not the block as the answer`, async () => {
    for (const r of [chunk({ content }) + STOP, pieces(content) + STOP]) {
      const out = await streamed(await ask(r, true))
      expect(out.text).toBe("Let me read that.\n")
      expect(out.calls).toEqual([])
      expect(out.finish).toEqual([])
      expect(out.errors).toHaveLength(1)
      const res = await ask(r, false)
      expect(res.status).toBe(502)
      expect((await res.json()).error.message).toMatch(/tool call/)
    }
  })
}

test("JSON in prose, in code, or not a tool_calls object stays text", async () => {
  for (const content of [
    'Reply with {"tool_calls":[{"name":"read_file","arguments":{"path":"a.go"}}]} to call it.',
    "An example:\n```json\n" + BARE + "\n```\n",
    "Inline: `" + BARE + "`",
    '{"tool_calls":[]}',
    '{"answer":42}',
    "{tool_calls are how a model asks}",
    "{",
  ]) {
    for (const r of [chunk({ content }) + STOP, pieces(content) + STOP]) {
      const out = await streamed(await ask(r, true))
      expect(out.text).toBe(content)
      expect(out.calls).toEqual([])
      expect(out.finish).toEqual(["stop"])
      expect(out.errors).toEqual([])
      expect(await whole(r)).toEqual({ text: content, calls: [], finish: "stop" })
    }
  }
})
