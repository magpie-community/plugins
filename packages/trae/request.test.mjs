// Model requests: OpenAI chat completions translated for the IDE agent's
// llm_utils_chat, and its SSE events back into an OpenAI answer.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeCNAuthPlugin, _internal } from "./index.mjs"
import { fakeTrae, json, signedIn, sse } from "./fake.mjs"

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

test("the request is the IDE's: its headers, the device, text parts, the tools natively and in the prompt", async () => {
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
  expect(b.messages.map((m) => m.role)).toEqual(["system", "system", "user"])
  expect(b.messages[0].content[0].text).toContain("<tool_call>")
  expect(b.messages[2].content).toEqual([{ type: "text", text: "hi" }])
  expect(b.tools[0].function.name).toBe("read")
  expect(typeof b.tools[0].function.parameters).toBe("string")
})

test("tool history goes in as text", () => {
  const m = _internal.traeMessages({ messages: [
    { role: "user", content: "read a" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{\"path\":\"a\"}" } }] },
    { role: "tool", tool_call_id: "c1", content: "AAA" },
    { role: "tool", tool_call_id: "c2", content: "BBB" },
  ] })
  expect(m.map((x) => x.role)).toEqual(["user", "assistant", "user"])
  expect(m[1].content[0].text).toBe('<tool_call>{"name":"read","arguments":{"path":"a"}}</tool_call>')
  expect(m[2].content[0].text).toContain("Result of read (call c1):\nAAA")
  expect(m[2].content[0].text).toContain("BBB")
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

test("arg_key/arg_value tool blocks are normalized", () => {
  const t = new _internal.TextTools(new Set(["bash"]))
  const r = t.push('<tool_call><arg_key>name</arg_key><arg_value>bash</arg_value><arg_key>arguments</arg_key><arg_value>{"command":"pwd"}</arg_value></tool_call>')
  expect(r.text).toBe("")
  expect(r.calls).toEqual([{ id: "", name: "bash", arguments: '{"command":"pwd"}' }])
})

test("tool blocks tolerate trailing protocol residue but reject unknown calls", () => {
  const t = new _internal.TextTools(new Set(["bash"]))
  const recovered = t.push('<tool_call>{"name":"bash","arguments":{}}</arg_value></tool_call>')
  expect(recovered.calls).toEqual([{ id: "", name: "bash", arguments: "{}" }])

  const unknown = t.push('<tool_call>{"name":"codemode","arguments":{"code":"1"}}</tool_call>')
  expect(unknown.calls).toEqual([])
  expect(unknown.text).toContain("codemode")
})

test("a native call leaked into the name field is recovered as its embedded object", async () => {
  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([
    ["output", { tool_calls: [{ id: "n1", function: { name: '{"name":"bash","arguments":{"command":"pwd"}}', arguments: "" } }] }],
    ["done", {}],
  ]))
  const res = await ask({ model: "glm-5", stream: false, messages: [{ role: "user", content: "hi" }] })
  const body = await res.json()
  expect(body.choices[0].message.tool_calls[0].function).toEqual({ name: "bash", arguments: '{"command":"pwd"}' })
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

test("a response payload in an unlabelled SSE event is not dropped", async () => {
  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["delta", { response: "complete" }]]))
  const res = await ask({ model: "glm-5", stream: true, messages: [{ role: "user", content: "hi" }] })
  const c = await chunks(res)
  const text = c.filter((x) => x !== "[DONE]" && x.choices?.length).map((x) => x.choices[0].delta.content ?? "").join("")
  expect(text).toBe("complete")
  expect(c.at(-1)).toBe("[DONE]")
})

test("trailing embedded reasoning JSON is separated from visible response text", async () => {
  expect(_internal.splitEmbeddedReasoning('Done. {"reasoning_content":"internal notes"}')).toEqual({ text: "Done.", reasoning: "internal notes" })
  expect(_internal.splitEmbeddedReasoning('{"ok":true}')).toEqual({ text: "{\"ok\":true}", reasoning: "" })

  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { response: 'Done. {"reasoning_content":"internal notes"}' }]]))
  const res = await ask({ model: "glm-5", stream: false, messages: [{ role: "user", content: "hi" }] })
  const body = await res.json()
  expect(body.choices[0].message.content).toBe("Done.")
  expect(body.choices[0].message.reasoning_content).toBe("internal notes")
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
