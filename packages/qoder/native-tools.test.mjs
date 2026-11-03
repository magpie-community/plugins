import { afterEach, expect, test } from "bun:test"
import { _internal, QoderAuthPlugin } from "./index.mjs"

const realFetch = globalThis.fetch
afterEach(() => (globalThis.fetch = realFetch))

const line = (body) =>
  `data:${JSON.stringify({ body: typeof body === "string" ? body : JSON.stringify(body), statusCodeValue: 200 })}\n\n`
const chunk = (delta, finish_reason) => line({ choices: [{ index: 0, delta, finish_reason }] })
const finish = chunk({}, "tool_calls") + line("[DONE]")
const textCall = '<tool_call>{"name":"Bash","arguments":{"command":"pwd"}}</tool_call>'

async function collect(reply) {
  const out = []
  for await (const event of _internal.events(new Response(reply).body)) out.push(event)
  return out
}

function callsFrom(events) {
  const calls = []
  for (const event of events) {
    if (event.tool) calls[event.tool.index] = { ...event.tool }
    if (event.args) calls[event.args.index].args += event.args.text
  }
  return calls
}

// chats counts the chat requests ask's fetch was sent; a list of replies
// answers them in turn, its last one every request after
let chats = 0
async function ask(reply, stream) {
  const auth = {
    type: "oauth", access: "fixture-job-token", refresh: "fixture-refresh-token",
    expires: Date.now() + 3_600_000, accountId: "native-tools@example.test",
    uid: "native-tools", machineId: "fixture-machine",
  }
  const replies = [reply].flat()
  chats = 0
  globalThis.fetch = async (url) =>
    new URL(String(url)).pathname.endsWith("/model/list")
      ? Response.json({ chat: [{ key: "efficient", display_name: "Efficient", enable: true }] })
      : new Response(replies[Math.min(chats++, replies.length - 1)], { headers: { "Content-Type": "text/event-stream" } })
  const hooks = await QoderAuthPlugin({ client: { auth: { set: async () => {} } } })
  const loader = await hooks.auth.loader(async () => auth)
  return loader.fetch("https://api3.qoder.sh/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "efficient", messages: [{ role: "user", content: "hi" }], stream }),
  })
}

async function framesFrom(response) {
  return (await response.text()).split("\n")
    .filter((s) => s.startsWith("data: ") && s !== "data: [DONE]")
    .map((s) => JSON.parse(s.slice(6)))
}

test("an empty native placeholder before a text call does not create an unnamed tool", async () => {
  const events = await collect(
    chunk({ tool_calls: [{ index: 0, function: { name: "", arguments: "" } }] })
    + chunk({ content: textCall }) + finish,
  )
  const calls = callsFrom(events)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ index: 0, name: "Bash", args: '{"command":"pwd"}' })
  expect(events.at(-1)?.stop).toBe("tool_calls")
})

test("empty and null native placeholders leave an ordinary text answer alone", async () => {
  for (const placeholder of [
    { index: 0 },
    { index: 0, function: { name: null, arguments: null } },
    { index: 0, function: { name: "  ", arguments: "" } },
  ]) {
    const events = await collect(
      chunk({ tool_calls: [placeholder] }) + chunk({ content: "Hello" }, "stop") + line("[DONE]"),
    )
    expect(callsFrom(events)).toEqual([])
    expect(events.filter((e) => e.error)).toEqual([])
    expect(events.map((e) => e.text ?? "").join("")).toBe("Hello")
    expect(events.at(-1)?.stop).toBe("stop")
  }
})

test("an id and argument prefix wait for the native tool name", async () => {
  const events = await collect(
    chunk({ tool_calls: [{ index: 0, id: "call_delayed", type: "function" }] })
    + chunk({ tool_calls: [{ index: 0, function: { arguments: '{"command":' } }] })
    + chunk({ tool_calls: [{ index: 0, function: { name: "Bash", arguments: '"pwd"}' } }] })
    + finish,
  )
  expect(callsFrom(events)).toEqual([
    { index: 0, id: "call_delayed", name: "Bash", args: '{"command":"pwd"}' },
  ])
  expect(events.filter((e) => e.error)).toEqual([])
})

test("a native call that never supplies its name is an error, not an empty-name tool", async () => {
  for (const tool of [
    { index: 0, id: "call_missing" },
    { index: 0, function: { arguments: "{}" } },
    { index: 0, id: "call_blank", function: { name: "  ", arguments: "{}" } },
  ]) {
    const events = await collect(chunk({ tool_calls: [tool] }) + finish)
    expect(callsFrom(events)).toEqual([])
    expect(events.filter((e) => e.stop)).toEqual([])
    expect(events.at(-1)?.error).toMatchObject({ status: 502 })
    expect(events.at(-1).error.message).toMatch(/tool call.*name/)
  }
})

const interleaved =
  chunk({ tool_calls: [
    { index: 0, id: "call_first", function: { name: "Read", arguments: '{"path":' } },
    { index: 1, id: "call_second", function: { name: "Bash", arguments: '{"command":' } },
  ] })
  + chunk({ tool_calls: [{ index: 0, function: { arguments: '"a.go"}' } }] })
  + chunk({ tool_calls: [{ index: 1, function: { arguments: '"pwd"}' } }] })
  + finish

test("interleaved native argument deltas keep their original call indexes", async () => {
  expect(callsFrom(await collect(interleaved))).toEqual([
    { index: 0, id: "call_first", name: "Read", args: '{"path":"a.go"}' },
    { index: 1, id: "call_second", name: "Bash", args: '{"command":"pwd"}' },
  ])
})

test("a delayed native name can follow a text call without stealing its arguments", async () => {
  const events = await collect(
    chunk({ tool_calls: [{ index: 0, id: "call_later", function: { arguments: '{"path":' } }] })
    + chunk({ content: textCall })
    + chunk({ tool_calls: [{ index: 0, function: { name: "Read", arguments: '"a.go"}' } }] })
    + finish,
  )
  expect(callsFrom(events)).toMatchObject([
    { index: 0, name: "Bash", args: '{"command":"pwd"}' },
    { index: 1, id: "call_later", name: "Read", args: '{"path":"a.go"}' },
  ])
})

const unnamedOnly = chunk({ tool_calls: [{ index: 0, id: "call_missing" }] }) + finish

test("the non-streaming adapter rejects an unnamed native call with 502 after asking once more", async () => {
  const response = await ask(unnamedOnly, false)
  expect(response.status).toBe(502)
  const body = await response.json()
  expect(body.error.message).toMatch(/tool call.*name/)
  expect(body.choices).toBeUndefined()
  // nothing of either reply was given: the plugin asked twice, then the
  // gateway has a 502 before any byte to retry or fail over (plugins#579)
  expect(chats).toBe(2)
})

test("the streaming adapter rejects an unnamed call before emitting any answer, after asking once more", async () => {
  const response = await ask(unnamedOnly, true)
  expect(response.status).toBe(502)
  expect(chats).toBe(2)
})

test("an unnamed call with nothing said before it is asked once more, and the second answer is given", async () => {
  for (const stream of [true, false]) {
    const response = await ask([unnamedOnly, chunk({ content: "Hello" }, "stop") + line("[DONE]")], stream)
    expect(response.status).toBe(200)
    expect(chats).toBe(2)
    if (stream) {
      const frames = await framesFrom(response)
      expect(frames.map((f) => f.choices?.[0]?.delta?.content ?? "").join("")).toBe("Hello")
      expect(frames.at(-1).choices[0].finish_reason).toBe("stop")
      expect(frames.filter((f) => f.error)).toEqual([])
    } else {
      const choice = (await response.json()).choices[0]
      expect(choice.message.content).toBe("Hello")
      expect(choice.finish_reason).toBe("stop")
    }
  }
})

test("an unnamed call after reasoning is dropped and the stream finishes stop, the reasoning kept", async () => {
  const warn = console.warn
  const warned = []
  console.warn = (...xs) => warned.push(xs.join(" "))
  try {
    const response = await ask(
      chunk({ reasoning_content: "Thinking" })
      + chunk({ tool_calls: [{ index: 0, id: "call_missing", function: { arguments: '{"command":"rm' } }] })
      + chunk({ tool_calls: [{ index: 0, function: { arguments: ' -rf x"}' } }] }) + finish,
      true,
    )
    expect(response.status).toBe(200)
    expect(chats).toBe(1)
    const text = await response.text()
    expect(text).not.toContain("-rf")
    expect(text).not.toContain('"command')
    const frames = text.split("\n").filter((s) => s.startsWith("data: ") && s !== "data: [DONE]").map((s) => JSON.parse(s.slice(6)))
    expect(frames.map((f) => f.choices?.[0]?.delta?.reasoning_content ?? "").join("")).toBe("Thinking")
    expect(frames.flatMap((f) => f.choices?.[0]?.delta?.tool_calls ?? [])).toEqual([])
    expect(frames.filter((f) => f.error)).toEqual([])
    expect(frames.at(-1).choices[0].finish_reason).toBe("stop")
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true)
    expect(warned.join("\n")).toMatch(/dropped 1 native tool call the model never named/)
  } finally {
    console.warn = warn
  }
})

// a named call is under way (tool-input-start, then its arguments), and a
// second one never gets its name: its arguments go nowhere
const namedThenUnnamed =
  chunk({ tool_calls: [{ index: 0, id: "call_read", function: { name: "Read", arguments: '{"path":' } }] })
  + chunk({ tool_calls: [{ index: 0, function: { arguments: '"a.go"}' } }] })
  + chunk({ tool_calls: [{ index: 1, id: "call_nameless", function: { arguments: '{"secret":' } }] })
  + chunk({ tool_calls: [{ index: 1, function: { arguments: '"LEAKED"}' } }] })
  + finish

test("an unnamed call after a named call's start and arguments is dropped; the named one finishes tool_calls", async () => {
  const response = await ask(namedThenUnnamed, true)
  expect(response.status).toBe(200)
  const text = await response.text()
  expect(text).not.toContain("LEAKED")
  expect(text).not.toContain("secret")
  const frames = text.split("\n").filter((s) => s.startsWith("data: ") && s !== "data: [DONE]").map((s) => JSON.parse(s.slice(6)))
  const calls = []
  for (const tc of frames.flatMap((f) => f.choices?.[0]?.delta?.tool_calls ?? [])) {
    if (tc.function?.name) calls[tc.index] = { id: tc.id, name: tc.function.name, args: tc.function.arguments }
    else calls[tc.index].args += tc.function.arguments
  }
  expect(calls).toEqual([{ id: "call_read", name: "Read", args: '{"path":"a.go"}' }])
  expect(frames.map((f) => f.choices?.[0]?.delta?.content ?? "").join("")).toBe("")
  expect(frames.filter((f) => f.error)).toEqual([])
  expect(frames.at(-1).choices[0].finish_reason).toBe("tool_calls")
  expect(chats).toBe(1)
})

test("the non-streaming adapter drops an unnamed call beside a named one", async () => {
  // the unnamed one first, upstream index 0, and the named one after it
  const response = await ask(
    chunk({ tool_calls: [{ index: 0, id: "call_nameless", function: { arguments: '{"secret":"LEAKED"}' } }] })
    + chunk({ tool_calls: [{ index: 1, id: "call_bash", function: { name: "Bash", arguments: '{"command":"pwd"}' } }] })
    + finish,
    false,
  )
  expect(response.status).toBe(200)
  const text = await response.text()
  expect(text).not.toContain("LEAKED")
  const choice = JSON.parse(text).choices[0]
  expect(choice.finish_reason).toBe("tool_calls")
  expect(choice.message.content).toBe("")
  expect(choice.message.tool_calls).toEqual([
    { id: "call_bash", type: "function", function: { name: "Bash", arguments: '{"command":"pwd"}' } },
  ])
  const streamed = await ask(namedThenUnnamed, false)
  const named = (await streamed.json()).choices[0]
  expect(named.finish_reason).toBe("tool_calls")
  expect(named.message.tool_calls.map((c) => c.function.name)).toEqual(["Read"])
})

test("an unnamed call after text is dropped; the text ends stop", async () => {
  const events = await collect(
    chunk({ content: "Let me look." })
    + chunk({ tool_calls: [{ index: 0, id: "call_missing", function: { arguments: '{"x":1}' } }] }) + finish,
  )
  expect(events.filter((e) => e.error || e.tool || e.args)).toEqual([])
  expect(events.map((e) => e.text ?? "").join("")).toBe("Let me look.")
  expect(events.at(-1)?.stop).toBe("stop")
})

test("the non-streaming adapter assembles interleaved calls by output index", async () => {
  const response = await ask(interleaved, false)
  expect(response.status).toBe(200)
  const choice = (await response.json()).choices[0]
  expect(choice.finish_reason).toBe("tool_calls")
  expect(choice.message.tool_calls).toEqual([
    { id: "call_first", type: "function", function: { name: "Read", arguments: '{"path":"a.go"}' } },
    { id: "call_second", type: "function", function: { name: "Bash", arguments: '{"command":"pwd"}' } },
  ])
})

test("the streaming adapter emits only the named text call after a native placeholder", async () => {
  const response = await ask(
    chunk({ tool_calls: [{ index: 0, function: { name: "", arguments: "" } }] })
    + chunk({ content: textCall }) + finish,
    true,
  )
  expect(response.status).toBe(200)
  const frames = await framesFrom(response)
  const tools = frames.flatMap((f) => f.choices?.[0]?.delta?.tool_calls ?? [])
  expect(tools).toHaveLength(1)
  expect(tools[0]).toMatchObject({
    index: 0, type: "function", function: { name: "Bash", arguments: '{"command":"pwd"}' },
  })
})
