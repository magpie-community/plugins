import { afterEach, expect, test } from "bun:test"
import { FactoryAuthPlugin, _internal } from "./index.mjs"
import { REFUSED_TOOL_NAMES } from "./tool-names.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))
const A = "https://api.factory.ai/api/llm/a/v1/messages"
const R = "https://api.factory.ai/api/llm/o/v1/responses"
const C = "https://api.factory.ai/api/llm/o/v1/chat/completions"
const schema = { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
const sse = (events) => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })

// refusing stands in for Factory: a declared refused name is a 403.
function refusing(names) {
  return names.some((n) => REFUSED_TOOL_NAMES.has(n))
    ? Response.json({ code: "content_policy_rejected", detail: "This request was blocked by Factory's usage policy check." }, { status: 403 })
    : null
}

async function loaded(serve) {
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), ...init })
    return serve(JSON.parse(init.body), init)
  }
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async () => { throw new Error("unexpected auth write") } } } })
  const auth = { type: "oauth", access: "test-token", expires: Date.now() + 3_600_000, activeOrganizationId: "test-org" }
  return { l: await hooks.auth.loader(async () => auth), seen }
}

test("Claude Code's Bash goes out as BashTool everywhere and its call comes back as Bash", async () => {
  const body = {
    model: "claude-opus-5-5", max_tokens: 64, system: [{ type: "text", text: _internal.DROID_LINE }],
    tools: [{ name: "Bash", input_schema: schema }, { name: "Read", input_schema: schema }, { type: "web_search_20250305", name: "web_search" }],
    tool_choice: { type: "tool", name: "Bash" },
    messages: [
      { role: "user", content: "list files" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }, { type: "text", text: "Use the Bash tool again." }] },
    ],
  }
  const { l, seen } = await loaded((sent) => refusing(sent.tools.map((t) => t.name)) ?? Response.json({
    id: "m1", type: "message", role: "assistant", stop_reason: "tool_use",
    content: [{ type: "text", text: "Running BashTool" }, { type: "tool_use", id: "t2", name: "BashTool", input: { command: "pwd" } }],
  }))
  const res = await l.fetch(A, { method: "POST", body: JSON.stringify(body) })
  expect(res.status).toBe(200)
  const sent = JSON.parse(seen[0].body)
  expect(sent.tools.map((t) => t.name)).toEqual(["BashTool", "Read", "web_search"])
  expect(sent.tool_choice).toEqual({ type: "tool", name: "BashTool" })
  expect(sent.messages[1].content[0].name).toBe("BashTool")
  expect(sent.messages[2].content[1].text).toBe("Use the Bash tool again.")
  const answer = await res.json()
  expect(answer.content[1]).toEqual({ type: "tool_use", id: "t2", name: "Bash", input: { command: "pwd" } })
  // only names are restored, never text
  expect(answer.content[0].text).toBe("Running BashTool")
})

test("a streamed tool call is restored across chunk boundaries, and the stream's text is untouched", async () => {
  const events = [
    { type: "message_start", message: { id: "m1", type: "message", role: "assistant", content: [] } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I'll call write_tool" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "write_tool", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"command\":\"x\"}" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_stop" },
  ]
  const wire = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("")
  const { l } = await loaded((sent) => refusing(sent.tools.map((t) => t.name)) ?? new Response(new ReadableStream({
    start(c) {
      const bytes = new TextEncoder().encode(wire)
      for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7))
      c.close()
    },
  }), { headers: { "content-type": "text/event-stream" } }))
  const res = await l.fetch(A, { method: "POST", body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 64, stream: true, tools: [{ name: "write", input_schema: schema }], messages: [{ role: "user", content: "hi" }] }) })
  const got = (await res.text()).split("\n").filter((x) => x.startsWith("data: ")).map((x) => JSON.parse(x.slice(6)))
  expect(got[4].content_block.name).toBe("write")
  expect(got[2].delta.text).toBe("I'll call write_tool")
  expect(got.length).toBe(events.length)
})

test("a refused name with a wrapped schema is renamed and unwrapped together", async () => {
  const union = { anyOf: [schema, { type: "object", properties: { script: { type: "string" } }, required: ["script"] }] }
  const { l, seen } = await loaded((sent) => refusing(sent.tools.map((t) => t.name)) ?? sse([
    { type: "message_start", message: { id: "m1", type: "message", role: "assistant", content: [] } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "AgentTool", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"arguments\":{\"command\":\"go\"}}" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_stop" },
  ]))
  const res = await l.fetch(A, { method: "POST", body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 64, stream: true, tools: [{ name: "Agent", input_schema: union }], messages: [{ role: "user", content: "hi" }] }) })
  expect(JSON.parse(seen[0].body).tools[0].name).toBe("AgentTool")
  const got = (await res.text()).split("\n").filter((x) => x.startsWith("data: ")).map((x) => JSON.parse(x.slice(6)))
  expect(got.find((e) => e.type === "content_block_start").content_block.name).toBe("Agent")
  const json = got.filter((e) => e.delta?.type === "input_json_delta").map((e) => e.delta.partial_json).join("")
  expect(JSON.parse(json)).toEqual({ command: "go" })
})

test("OpenAI Responses: OpenCode's bash and its earlier call go out as bash_tool, the streamed call comes back as bash", async () => {
  const { l, seen } = await loaded((sent) => refusing(sent.tools.map((t) => t.name)) ?? sse([
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc1", call_id: "c1", name: "bash_tool", arguments: "" } },
    { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc1", call_id: "c1", name: "bash_tool", arguments: "{}" } },
  ]))
  const body = {
    model: "gpt-6-luna", stream: true, instructions: "x",
    tools: [{ type: "function", name: "bash", parameters: schema }, { type: "function", name: "glob", parameters: schema }],
    input: [{ type: "function_call", call_id: "c0", name: "bash", arguments: "{}" }, { type: "function_call_output", call_id: "c0", output: "ok" }],
  }
  const res = await l.fetch(R, { method: "POST", body: JSON.stringify(body) })
  const sent = JSON.parse(seen[0].body)
  expect(sent.tools.map((t) => t.name)).toEqual(["bash_tool", "glob"])
  expect(sent.input[0].name).toBe("bash_tool")
  const got = (await res.text()).split("\n").filter((x) => x.startsWith("data: ")).map((x) => JSON.parse(x.slice(6)))
  expect(got.map((e) => e.item.name)).toEqual(["bash", "bash"])
})

test("chat completions: a refused function name and its history are renamed and the reply restored", async () => {
  const { l, seen } = await loaded((sent) => refusing(sent.tools.map((t) => t.function.name)) ?? Response.json({
    object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", tool_calls: [{ id: "c2", type: "function", function: { name: "edit_tool", arguments: "{}" } }] } }],
  }))
  const body = {
    model: "glm-5.3", tools: [{ type: "function", function: { name: "edit", parameters: schema } }], tool_choice: { type: "function", function: { name: "edit" } },
    messages: [{ role: "user", content: "hi" }, { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "edit", arguments: "{}" } }] }, { role: "tool", tool_call_id: "c1", content: "ok" }],
  }
  const res = await l.fetch(C, { method: "POST", body: JSON.stringify(body) })
  const sent = JSON.parse(seen[0].body)
  expect(sent.tools[0].function.name).toBe("edit_tool")
  expect(sent.tool_choice.function.name).toBe("edit_tool")
  expect(sent.messages.find((m) => m.tool_calls).tool_calls[0].function.name).toBe("edit_tool")
  expect((await res.json()).choices[0].message.tool_calls[0].function.name).toBe("edit")
})

test("an alias never takes a name the request already declares", async () => {
  const { l, seen } = await loaded((sent) => refusing(sent.tools.map((t) => t.name)) ?? Response.json({
    type: "message", content: [{ type: "tool_use", id: "a", name: "BashTool_", input: {} }, { type: "tool_use", id: "b", name: "BashTool", input: {} }],
  }))
  const res = await l.fetch(A, { method: "POST", body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 8, tools: [{ name: "Bash", input_schema: schema }, { name: "BashTool", input_schema: schema }], messages: [{ role: "user", content: "hi" }] }) })
  expect(JSON.parse(seen[0].body).tools.map((t) => t.name)).toEqual(["BashTool_", "BashTool"])
  expect((await res.json()).content.map((b) => b.name)).toEqual(["Bash", "BashTool"])
})

test("a request without a refused name, and a refused reply, go on as they are", async () => {
  const body = JSON.stringify({ model: "claude-opus-5-5", max_tokens: 8, system: [{ type: "text", text: _internal.DROID_LINE }], tools: [{ name: "Read", input_schema: schema }], messages: [{ role: "user", content: "hi" }] })
  const { l, seen } = await loaded(() => Response.json({ type: "error", error: { type: "overloaded_error", message: "busy" } }, { status: 529 }))
  const res = await l.fetch(A, { method: "POST", body })
  expect(seen[0].body).toBe(body)
  expect(res.status).toBe(529)
})

test("a call's own arguments are never renamed, even when one equals an alias", async () => {
  const { l } = await loaded((sent) => refusing(sent.tools.map((t) => t.name)) ?? Response.json({
    type: "message", content: [{ type: "tool_use", id: "a", name: "BashTool", input: { name: "BashTool", nested: { name: "BashTool" } } }],
  }))
  const res = await l.fetch(A, { method: "POST", body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 8, tools: [{ name: "Bash", input_schema: schema }], messages: [{ role: "user", content: "hi" }] }) })
  expect((await res.json()).content[0]).toEqual({ type: "tool_use", id: "a", name: "Bash", input: { name: "BashTool", nested: { name: "BashTool" } } })
})

test("Responses: allowed_tools and custom tool calls follow the alias", async () => {
  const { l, seen } = await loaded((sent) => refusing(sent.tools.map((t) => t.name)) ?? Response.json({ object: "response", output: [] }))
  await l.fetch(R, { method: "POST", body: JSON.stringify({
    model: "gpt-6-luna", instructions: "x",
    tools: [{ type: "function", name: "bash", parameters: schema }, { type: "custom", name: "write" }],
    tool_choice: { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "bash" }, { type: "custom", name: "write" }] },
    input: [{ type: "custom_tool_call", call_id: "c0", name: "write", input: "x" }, { type: "custom_tool_call_output", call_id: "c0", output: "ok" }],
  }) })
  const sent = JSON.parse(seen[0].body)
  expect(sent.tools.map((t) => t.name)).toEqual(["bash_tool", "write_tool"])
  expect(sent.tool_choice.tools.map((t) => t.name)).toEqual(["bash_tool", "write_tool"])
  expect(sent.input[0].name).toBe("write_tool")
})

test("a stream event whose JSON spans several data lines is restored, CRLF kept", async () => {
  const event = { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "BashTool", input: {} } }
  const lines = JSON.stringify(event, null, 1).split("\n").map((l) => "data: " + l).join("\r\n")
  const wire = "event: content_block_start\r\n" + lines + "\r\n\r\nevent: message_stop\r\ndata: {\"type\":\"message_stop\"}\r\n\r\n"
  const { l } = await loaded((sent) => refusing(sent.tools.map((t) => t.name)) ?? new Response(wire, { headers: { "content-type": "text/event-stream" } }))
  const res = await l.fetch(A, { method: "POST", body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 8, stream: true, tools: [{ name: "Bash", input_schema: schema }], messages: [{ role: "user", content: "hi" }] }) })
  const text = await res.text()
  const frames = text.split("\r\n\r\n").filter(Boolean)
  expect(frames.length).toBe(2)
  expect(frames[0].split("\r\n")[0]).toBe("event: content_block_start")
  expect(JSON.parse(frames[0].split("\r\n")[1].slice(6)).content_block.name).toBe("Bash")
  expect(frames[1]).toBe("event: message_stop\r\ndata: {\"type\":\"message_stop\"}")
})
