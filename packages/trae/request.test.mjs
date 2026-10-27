// Model requests: OpenAI chat completions translated for the IDE agent's
// llm_utils_chat, and its SSE events back into an OpenAI answer.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeCNAuthPlugin, _internal } from "./index.mjs"
import { fakeTrae, json, signedIn, sse } from "./fake.mjs"

// the tools named natively in the body: past calls then go back as Trae's own turns
const TOOLS_ON = [{ type: "function", function: { name: "read", parameters: { type: "object" } } }]

let f
afterEach(() => f?.close())

async function ask(body, auth = signedIn()) {
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => auth)
  return opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify(body) })
}

async function chunks(res) {
  const out = []
  for (const line of (await res.text()).split("\n")) {
    if (!line.startsWith("data: ")) continue
    const d = line.slice(6)
    out.push(d === "[DONE]" ? d : JSON.parse(d))
  }
  return out
}

const TOOLS = [{ type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } }]

test("the request is the IDE's: its headers, the device, text parts, the tools natively", async () => {
  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { response: "ok" }], ["done", {}]]))
  await ask({ model: "glm-5", max_tokens: 100, tools: TOOLS, messages: [{ role: "system", content: "be brief" }, { role: "user", content: [{ type: "text", text: "hi" }] }] })
  const r = f.seen[0]
  expect(r.headers.get("authorization")).toBe("Cloud-IDE-JWT jwt-1")
  expect(r.headers.get("x-cloudide-token")).toBe("jwt-1")
  expect(r.headers.get("x-device-id")).toBe("1234567890123456789")
  expect(r.headers.get("x-machine-id")).toBe("ab".repeat(16))
  expect(r.headers.get("x-uid")).toBe("u-1")
  expect(r.headers.get("accept")).toBe("text/event-stream")
  const b = r.json
  expect(b.function).toBe("chat_v3")
  expect(b.config_name).toBe("glm-5")
  expect(b.model).toBe("glm-5")
  expect(b.max_tokens).toBe(100)
  expect(b.stream).toBe(true)
  expect(b.messages.map((m) => m.role)).toEqual(["system", "user"])
  expect(b.messages[0].content[0].text).toBe("be brief")
  expect(b.messages[1].content).toEqual([{ type: "text", text: "hi" }])
  expect(b.tools[0].function.name).toBe("read")
  expect(typeof b.tools[0].function.parameters).toBe("string")
})

test("tool history goes back as the turns Trae made: a call and its result", () => {
  const m = _internal.traeMessages({ tools: TOOLS_ON, messages: [
    { role: "user", content: "read a" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{\"path\":\"a\"}" } }] },
    { role: "tool", tool_call_id: "c1", content: "AAA" },
    { role: "user", content: "and b" },
  ] })
  expect(m.map((x) => x.role)).toEqual(["user", "assistant", "tool", "user"])
  expect(m[1].tool_calls).toEqual([{ id: "c1", type: "function", function_call: { name: "read", arguments: "{\"path\":\"a\"}" } }])
  expect(m[1].content).toBe(null)
  expect(m[2]).toEqual({ role: "tool", tool_call_id: "c1", content: [{ type: "text", text: "AAA" }] })
})

test("an assistant turn folds into the calls turn after it, and parallel calls join one list", () => {
  // what agents send: a "let me read" turn, then the call
  const a = _internal.traeMessages({ tools: TOOLS_ON, messages: [
    { role: "user", content: "read a" },
    { role: "assistant", content: "let me read" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{\"path\":\"a\"}" } }] },
    { role: "tool", tool_call_id: "c1", content: "AAA" },
  ] })
  expect(a.map((x) => x.role)).toEqual(["user", "assistant", "tool"])
  expect(a[1].content[0].text).toBe("let me read")
  expect(a[1].tool_calls.map((c) => c.id)).toEqual(["c1"])

  // parallel calls split over two assistant turns (magpie#1275)
  const b = _internal.traeMessages({ tools: TOOLS_ON, messages: [
    { role: "user", content: "read a and b" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{\"path\":\"a\"}" } }] },
    { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "read", arguments: "{\"path\":\"b\"}" } }] },
    { role: "tool", tool_call_id: "c1", content: "AAA" },
    { role: "tool", tool_call_id: "c2", content: "BBB" },
  ] })
  expect(b.map((x) => x.role)).toEqual(["user", "assistant", "tool", "tool"])
  expect(b[1].tool_calls.map((c) => c.id)).toEqual(["c1", "c2"])
  expect(b[1].tool_calls[1].function_call).toEqual({ name: "read", arguments: "{\"path\":\"b\"}" })
})

test("a call with no name is dropped, and the result it would answer", () => {
  const a = _internal.traeMessages({ tools: TOOLS_ON, messages: [
    { role: "user", content: "do it" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "  ", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "RESULT" },
    { role: "user", content: "next" },
  ] })
  // no empty tool_calls list, and no result naming a call that isn't there;
  // the two user turns either side of the dropped pair fold together
  expect(a.map((x) => x.role)).toEqual(["user"])
  expect(a[0].content[0].text).toBe("do it\n\nnext")
  expect(a.some((x) => x.role === "tool")).toBe(false)

  // a named call beside an unnamed one keeps its own
  const b = _internal.traeMessages({ tools: TOOLS_ON, messages: [
    { role: "user", content: "do both" },
    { role: "assistant", content: null, tool_calls: [
      { id: "c1", type: "function", function: { name: "", arguments: "{}" } },
      { id: "c2", type: "function", function: { name: "read", arguments: "{\"path\":\"b\"}" } },
    ] },
    { role: "tool", tool_call_id: "c1", content: "DROPPED" },
    { role: "tool", tool_call_id: "c2", content: "KEPT" },
  ] })
  expect(b.map((x) => x.role)).toEqual(["user", "assistant", "tool"])
  expect(b[1].tool_calls.map((c) => c.id)).toEqual(["c2"])
  expect(b[2].tool_call_id).toBe("c2")
})

test("an assistant turn that loses every call keeps its text", () => {
  const m = _internal.traeMessages({ tools: TOOLS_ON, messages: [
    { role: "user", content: "hi" },
    { role: "assistant", content: "thinking out loud", tool_calls: [{ id: "c1", type: "function", function: { name: "", arguments: "{}" } }] },
    { role: "user", content: "ok" },
  ] })
  expect(m.map((x) => x.role)).toEqual(["user", "assistant", "user"])
  expect(m[1].content[0].text).toBe("thinking out loud")
  expect(m[1].tool_calls).toBeUndefined()
})

test("a result for a call the history doesn't carry goes as text, after the results that answer calls", () => {
  const m = _internal.traeMessages({ tools: TOOLS_ON, messages: [
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "AAA" },
    { role: "tool", tool_call_id: "c2", content: "BBB" },
  ] })
  // a tool turn naming no call sent is not a turn Trae takes
  expect(m.map((x) => x.role)).toEqual(["assistant", "tool", "user"])
  expect(m[1].content[0].text).toBe("AAA")
  expect(m[2].content[0].text).toBe("Result of the tool (call c2):\nBBB")
})

test("a result with no output says so: Trae refuses an empty one (4027)", () => {
  const m = _internal.traeMessages({ tools: TOOLS_ON, messages: [
    { role: "user", content: "touch a and b" },
    { role: "assistant", content: null, tool_calls: [
      { id: "c1", type: "function", function: { name: "read", arguments: "{}" } },
      { id: "c2", type: "function", function: { name: "read", arguments: "{}" } },
    ] },
    { role: "tool", tool_call_id: "c1", content: "" },
    { role: "tool", tool_call_id: "c2", content: [] },
  ] })
  expect(m.map((x) => x.role)).toEqual(["user", "assistant", "tool", "tool"])
  expect(m[2].content).toEqual([{ type: "text", text: "(no output)" }])
  expect(m[3].content).toEqual([{ type: "text", text: "(no output)" }])
})

test("without tools in the body, past calls and results go back as text, as they always did", () => {
  const msgs = [
    { role: "user", content: "read a" },
    { role: "assistant", content: "let me read", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{\"path\":\"a\"}" } }] },
    { role: "tool", tool_call_id: "c1", content: "AAA" },
    { role: "user", content: "sum it up" },
  ]
  for (const req of [{ messages: msgs }, { tools: TOOLS_ON, tool_choice: "none", messages: msgs }]) {
    const m = _internal.traeMessages(req)
    expect(m.map((x) => x.role)).toEqual(["user", "assistant", "user"])
    expect(m.some((x) => x.tool_calls || x.role === "tool")).toBe(false)
    expect(m[1].content[0].text).toBe('let me read\n<tool_call>{"name":"read","arguments":{"path":"a"}}</tool_call>')
    expect(m[2].content[0].text).toBe("Result of read (call c1):\nAAA\n\nsum it up")
  }
})

test("a stream: text, reasoning, a tool block split across events, a native call, usage", async () => {
  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([
    ["request_wait_in_queue", { position: 3 }],
    ["output", { reasoning_content: "think" }],
    ["output", { response: "Let me look. <tool" }],
    ["output", { response: '_call>{"name":"read","arguments":{"path":"a"}}</tool_call>' }],
    ["output", { tool_calls: [{ id: "n1", function: { name: "read", arguments: { path: "b" } } }] }],
    ["token_usage", { usage: { prompt_tokens: 10, completion_tokens: 5 } }],
    ["done", { finish_reason: "stop" }],
  ]))
  const res = await ask({ model: "glm-5", stream: true, tools: TOOLS, messages: [{ role: "user", content: "hi" }] })
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toBe("text/event-stream")
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  const c = await chunks(res)
  const deltas = c.filter((x) => x !== "[DONE]" && x.choices?.length).map((x) => x.choices[0].delta)
  expect(deltas.map((d) => d.content ?? "").join("")).toBe("Let me look. ")
  expect(deltas.find((d) => d.reasoning_content).reasoning_content).toBe("think")
  const calls = deltas.flatMap((d) => d.tool_calls ?? [])
  expect(calls.map((t) => [t.index, t.function.name, t.function.arguments])).toEqual([[0, "read", '{"path":"a"}'], [1, "read", '{"path":"b"}']])
  expect(calls[1].id).toBe("n1")
  expect(c.at(-3).choices[0].finish_reason).toBe("tool_calls")
  expect(c.at(-2).usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
  expect(c.at(-1)).toBe("[DONE]")
})

test("a native call streamed over several events goes on whole (#799)", async () => {
  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([
    // the arguments so far, each event
    ["output", { tool_calls: [{ id: "b1", index: 0, function: { name: "bash", arguments: "" } }] }],
    ["output", { tool_calls: [{ id: "b1", index: 0, function: { name: "bash", arguments: '{"command":"echo \\"T' } }] }],
    ["output", { tool_calls: [{ id: "b1", index: 0, function: { name: "bash", arguments: '{"command":"echo \\"Trae\\""}' } }] }],
    // only the new piece, the name only at first
    ["output", { tool_calls: [{ id: "r1", index: 1, function: { name: "read", arguments: '{"filePath":"C:/Users/j' } }] }],
    ["output", { tool_calls: [{ index: 1, function: { arguments: 'oe/a.txt"}' } }] }],
    // a whole call sent again
    ["output", { tool_calls: [{ id: "r1", index: 1, function: { name: "read", arguments: '{"filePath":"C:/Users/joe/a.txt"}' } }] }],
    ["done", {}],
  ]))
  const res = await ask({ model: "glm-5", stream: true, tools: TOOLS, messages: [{ role: "user", content: "hi" }] })
  const c = await chunks(res)
  const calls = c.filter((x) => x !== "[DONE]" && x.choices?.length).flatMap((x) => x.choices[0].delta.tool_calls ?? [])
  expect(calls.map((t) => [t.id, t.function.name, JSON.parse(t.function.arguments)])).toEqual([
    ["b1", "bash", { command: 'echo "Trae"' }],
    ["r1", "read", { filePath: "C:/Users/joe/a.txt" }],
  ])
})

test("no stream asked: one chat completion", async () => {
  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { content: "Hel" }], ["output", { content: "lo" }], ["done", {}]]))
  const res = await ask({ model: "glm-5", messages: [{ role: "user", content: "hi" }] })
  const b = await res.json()
  expect(b.object).toBe("chat.completion")
  expect(b.choices[0].message).toEqual({ role: "assistant", content: "Hello" })
  expect(b.choices[0].finish_reason).toBe("stop")
})

test("a text like a tag that isn't one goes through whole", () => {
  const t = new _internal.TextTools()
  expect(t.push("a <to").text).toBe("a ")
  expect(t.push("p> b").text).toBe("<top> b")
  expect(t.push("", true).text).toBe("")
})

test("a model chat_v3 doesn't know is asked of SOLO's function, which is kept for the account", async () => {
  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", (r) => (r.json.function === "chat_v3"
    ? sse([["error", { code: 4023, message: "model is unknown" }]])
    : sse([["output", { response: "solo" }], ["done", {}]])))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => signedIn())
  const body = JSON.stringify({ model: "kimi-k3", messages: [{ role: "user", content: "hi" }] })
  const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body })
  expect((await res.json()).choices[0].message.content).toBe("solo")
  expect(f.seen.map((r) => r.json.function)).toEqual(["chat_v3", "solo_work_lite"])
  await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body })
  expect(f.seen.at(-1).json.function).toBe("solo_work_lite")
})

test("signed out (1001, or a 401) is a 401 that marks the account", async () => {
  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["error", { code: 1001, message: "not login" }]]))
  let res = await ask({ model: "glm-5", messages: [{ role: "user", content: "hi" }] })
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
  expect((await res.json()).error.message).toContain("sign in again")
  f.route("POST /api/agent/v3/llm_utils_chat", () => json({ code: 401, message: "unauthorized" }, 401))
  res = await ask({ model: "glm-5", messages: [{ role: "user", content: "hi" }] })
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
})

test("out of quota (4008) is a 429, the account kept", async () => {
  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["error", { code: 4008, message: "quota exceeded" }]]))
  const res = await ask({ model: "glm-5", stream: true, messages: [{ role: "user", content: "hi" }] })
  expect(res.status).toBe(429)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect((await res.json()).error.message).toBe("Trae CN: quota exceeded")
})

test("a tool block with a file's content written out raw, or its arguments beside the name, goes on whole (#799)", async () => {
  f = fakeTrae()
  const block = '<tool_call>{"name":"write","arguments":{"path":"a.py","content":"import sys\n\tprint(\\"hi\\")\n"}}</tool_call>'
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([
    ["output", { response: "Writing it. " + block }],
    ["output", { response: '<tool_call>{"name":"read","path":"a.py"}</tool_call>' }],
    ["done", {}],
  ]))
  const res = await ask({ model: "glm-5", stream: true, tools: TOOLS, messages: [{ role: "user", content: "hi" }] })
  const c = await chunks(res)
  const deltas = c.filter((x) => x !== "[DONE]" && x.choices?.length).map((x) => x.choices[0].delta)
  expect(deltas.map((d) => d.content ?? "").join("")).toBe("Writing it. ")
  const calls = deltas.flatMap((d) => d.tool_calls ?? [])
  expect(calls.map((t) => [t.function.name, JSON.parse(t.function.arguments)])).toEqual([
    ["write", { path: "a.py", content: 'import sys\n\tprint("hi")\n' }],
    ["read", { path: "a.py" }],
  ])
})

test("a native call's pieces that say neither id nor name join the call being written (#799)", () => {
  const nc = new _internal.NativeCalls()
  nc.push({ id: "w1", function: { name: "write", arguments: '{"path":"a.py",' } })
  nc.push({ index: 0, function: { arguments: '"content":"x\ny"' } })
  nc.push({ function: { arguments: "}" } })
  expect(nc.take().map((t) => [t.id, t.name, JSON.parse(t.arguments)])).toEqual([["w1", "write", { path: "a.py", content: "x\ny" }]])
})

test("a whole snapshot Trae sends again, written apart from the partial one, replaces it, not joins it (plugins#24)", () => {
  const nc = new _internal.NativeCalls()
  nc.push({ id: "b1", function: { name: "bash", arguments: '{"command":"git log -' } })
  // the same call again, whole, its punctuation not the partial one's
  nc.push({ id: "b1", function: { arguments: '{"command":"git log −1 --format=′%s′"}' } })
  expect(nc.take().map((t) => [t.name, JSON.parse(t.arguments)])).toEqual([["bash", { command: "git log −1 --format=′%s′" }]])
})

test("pieces that are JSON values of their own still join the call (plugins#24)", () => {
  for (const pieces of [
    ['{"n":', "12", "}"],
    ['{"cmd":', '"ls"', "}"],
    ['{"a":', "{}", "}"],
    ['{"a":{"b":1},', '"c":', '{"b":2}', "}"],
    ["{", "}"],
  ]) {
    const nc = new _internal.NativeCalls()
    nc.push({ id: "x", function: { name: "t", arguments: pieces[0] } })
    for (const p of pieces.slice(1)) nc.push({ id: "x", function: { arguments: p } })
    expect(JSON.parse(nc.take()[0].arguments)).toEqual(JSON.parse(pieces.join("")))
  }
  // snapshots as before: each the arguments so far
  const nc = new _internal.NativeCalls()
  for (const s of ['{"p', '{"path":"a', '{"path":"a.py"}']) nc.push({ id: "r", function: { name: "read", arguments: s } })
  expect(JSON.parse(nc.take()[0].arguments)).toEqual({ path: "a.py" })
})

test("looseJSON reads raw control characters in strings only", () => {
  expect(_internal.looseJSON('{"a":"x\ny","b":"\\"q\\""}')).toEqual({ a: "x\ny", b: '"q"' })
  expect(_internal.looseJSON('{"a":\n1}')).toEqual({ a: 1 })
  expect(_internal.looseJSON('{"a":"x')).toBe(null)
})

test("a block DeepSeek closes with its own tags, or writes as its own invoke, is a call; its tags don't reach the agent (magpie#823)", async () => {
  // as Dazzle-sys' screenshot had it, in pieces
  const hermes = '<tool_call>{"name":"bash","arguments":{"command":"cd /e/Project && echo \\"### $spec\\"; done"}}</｜DSML｜parameter>\n</｜DSML｜invoke'
  const t = new _internal.TextTools()
  const out = [t.push("Checking. " + hermes.slice(0, 30)), t.push(hermes.slice(30, 95)), t.push(hermes.slice(95)), t.push("", true)]
  expect(out.map((o) => o.text).join("")).toBe("Checking. ")
  expect(out.flatMap((o) => o.calls).map((c) => [c.name, JSON.parse(c.arguments)])).toEqual([["bash", { command: 'cd /e/Project && echo "### $spec"; done' }]])

  f = fakeTrae()
  const dsml = '<｜DSML｜function_calls>\n<｜DSML｜invoke name="read">\n<｜DSML｜parameter name="path" string="true">a b.py</｜DSML｜parameter>\n<｜DSML｜parameter name="limit" string="false">20</｜DSML｜parameter>\n</｜DSML｜invoke>\n<|DSML|invoke name="read"><|DSML|parameter name="path" string="true">c</|DSML|parameter></|DSML|invoke>\n</｜DSML｜function_calls>'
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([
    ["output", { response: "Reading. " + dsml.slice(0, 50) }],
    ["output", { response: dsml.slice(50, 140) }],
    ["output", { response: dsml.slice(140) }],
    ["done", {}],
  ]))
  const res = await ask({ model: "glm-5", stream: true, tools: TOOLS, messages: [{ role: "user", content: "hi" }] })
  const c = await chunks(res)
  const deltas = c.filter((x) => x !== "[DONE]" && x.choices?.length).map((x) => x.choices[0].delta)
  expect(deltas.map((d) => d.content ?? "").join("")).toBe("Reading. ")
  const calls = deltas.flatMap((d) => d.tool_calls ?? [])
  expect(calls.map((t) => [t.function.name, JSON.parse(t.function.arguments)])).toEqual([
    ["read", { path: "a b.py", limit: 20 }],
    ["read", { path: "c" }],
  ])
  expect(c.at(-2).choices[0].finish_reason).toBe("tool_calls")
})

test("a <tool_call> with only DeepSeek's closing tags after it says nothing; one wrapping its invoke is the call (magpie#823 again)", () => {
  // Dazzle-sys' pi screenshot: the whole reply, cut short
  const junk = "<tool_call>\n</｜DSML｜parameter>\n</｜DSML｜invoke>\n</"
  for (const cut of [5, 14, 30, junk.length]) {
    const t = new _internal.TextTools()
    const out = [t.push(junk.slice(0, cut)), t.push(junk.slice(cut)), t.push("", true)]
    expect(out.map((o) => o.text).join("")).toBe("")
    expect(out.flatMap((o) => o.calls)).toEqual([])
  }
  const wrapped = 'Looking.<tool_call>\n<｜DSML｜invoke name="bash">\n<｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>\n</｜DSML｜invoke>\n</tool_call>'
  const t = new _internal.TextTools()
  const out = [t.push(wrapped.slice(0, 20)), t.push(wrapped.slice(20)), t.push("", true)]
  expect(out.map((o) => o.text).join("")).toBe("Looking.")
  expect(out.flatMap((o) => o.calls).map((c) => [c.name, JSON.parse(c.arguments)])).toEqual([["bash", { command: "ls" }]])
  // a block that's text, not tags, stays as it was
  const u = new _internal.TextTools()
  expect([u.push("<tool_call>hello</tool_call> ok"), u.push("", true)].map((o) => o.text).join("")).toBe("<tool_call>hello</tool_call> ok")
})
