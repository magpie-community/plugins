// Since 2026-11-18 Factory refuses a request that declares a tool under
// certain names (read, bash, edit, write, Bash, Write, get_weather: a 400
// content_policy_rejected, with nothing else in the request). The plugin
// declares such a tool as <name>_tool and gives the name back in replies.
import { afterEach, expect, test } from "bun:test"
import { FactoryAuthPlugin, _internal } from "./index.mjs"

const { DROID_LINE } = _internal
const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const API = "https://api.factory.ai"
const messages = API + "/api/llm/a/v1/messages?beta=true"
const chat = API + "/api/llm/o/v1/chat/completions"
const responses = API + "/api/llm/o/v1/responses"
const gemini = API + "/api/llm/g/v1/models/gemini-4-argon:streamGenerateContent?alt=sse"

async function loaded(reply = () => new Response('{"id":"ok"}')) {
  const seen = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    if (u.pathname === "/api/cli/whoami") return new Response(JSON.stringify({ userId: "u", orgId: "fac_D", email: "d@example.com", region: "" }))
    seen.push({ url: String(url), body: init.body })
    return reply()
  }
  let saved = { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3_600_000, accountId: "d@example.com", activeOrganizationId: "fac_D", region: "", premBaseHost: "" }
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async ({ body }) => (saved = body) } } })
  const l = await hooks.auth.loader(async () => saved)
  const post = (url, body) => l.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) })
  // what Factory was sent for a request
  const sent = async (url, body) => {
    expect((await post(url, body)).status).toBe(200)
    return JSON.parse(seen.at(-1).body)
  }
  return { post, sent, seen }
}

const sse = (events, eol = "\n") => events.map(([type, data]) => (type ? `event: ${type}${eol}` : "") + `data: ${JSON.stringify(data)}${eol}${eol}`).join("")
function bytes(text, size) {
  const data = new TextEncoder().encode(text)
  let offset = 0
  return new ReadableStream({
    pull(c) {
      if (offset >= data.length) c.close()
      else { c.enqueue(data.slice(offset, offset + size)); offset += size }
    },
  })
}
const stream = (text, size = 1) => new Response(bytes(text, size), { headers: { "content-type": "text/event-stream" } })
const frames = (text) => text.split(/\n\n/).filter(Boolean).map((f) => JSON.parse(f.split("\n").find((l) => l.startsWith("data:")).slice(5)))

const NAMES = ["read", "bash", "edit", "write", "Bash", "Write", "get_weather"]

test("the refused names are the ones in client-phrases.json", async () => {
  const file = await Bun.file(new URL("./client-phrases.json", import.meta.url)).json()
  expect(file.toolNames).toEqual(NAMES)
})

// ---- Messages ----------------------------------------------------------------

const anthropicTool = (name) => ({ name, description: name, input_schema: { type: "object", properties: {} } })

test("Messages: refused tools, tool_choice and earlier calls are renamed; a taken alias gets a suffix", async () => {
  const { sent } = await loaded()
  const request = {
    model: "claude-opus-5-5", max_tokens: 100, system: DROID_LINE,
    tools: [...NAMES, "read_tool", "grep"].map(anthropicTool),
    tool_choice: { type: "tool", name: "bash" },
    messages: [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: { path: "a" } }, { type: "tool_use", id: "t2", name: "grep", input: {} }, { type: "tool_use", id: "t3", name: "read_tool", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "read" }] },
    ],
  }
  for (const url of [messages, API + "/api/llm/a/v1/messages/count_tokens"]) {
    const b = await sent(url, request)
    expect(b.tools.map((t) => t.name)).toEqual(["read_tool_2", "bash_tool", "edit_tool", "write_tool", "Bash_tool", "Write_tool", "get_weather_tool", "read_tool", "grep"])
    // the rest of a tool is as it was
    expect(b.tools[1]).toEqual({ ...request.tools[1], name: "bash_tool" })
    expect(b.tool_choice).toEqual({ type: "tool", name: "bash_tool" })
    expect(b.messages[1].content.map((c) => c.name)).toEqual(["read_tool_2", "grep", "read_tool"])
    expect(b.messages[1].content[0].input).toEqual({ path: "a" })
    // text, results and the caller's request are not touched
    expect(b.messages[2]).toEqual(request.messages[2])
    expect(request.tools[0].name).toBe("read")
  }
})

test("Messages: a request declaring no refused name goes out byte for byte", async () => {
  const { post, seen } = await loaded()
  const body = JSON.stringify({ model: "claude-opus-5-5", max_tokens: 100, system: DROID_LINE, tools: ["Read", "Execute", "Edit", "TodoWrite"].map(anthropicTool), messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Execute", input: {} }] }, { role: "user", content: [{ type: "text", text: "read bash edit" }] }] })
  await post(messages, body)
  expect(seen.at(-1).body).toBe(body)
})

test("Messages: a call in history to a tool the request doesn't declare keeps its name", async () => {
  const { sent } = await loaded()
  const b = await sent(messages, { model: "claude-opus-5-5", max_tokens: 100, system: DROID_LINE, tools: [anthropicTool("grep")], messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] }] })
  expect(b.messages[0].content[0].name).toBe("read")
})

test("Messages: a JSON reply gets the original names back", async () => {
  const { post } = await loaded(() => Response.json({ id: "msg_1", type: "message", content: [{ type: "text", text: "read_tool" }, { type: "tool_use", id: "c1", name: "read_tool", input: { path: "x" } }, { type: "tool_use", id: "c2", name: "grep", input: {} }, { type: "tool_use", id: "c3", name: "read_tool_2", input: {} }], stop_reason: "tool_use" }))
  const res = await post(messages, { model: "claude-opus-5-5", max_tokens: 100, system: DROID_LINE, tools: [anthropicTool("read"), anthropicTool("read_tool"), anthropicTool("grep")], messages: [{ role: "user", content: "hi" }] })
  const answer = await res.json()
  // read became read_tool_2, so read_tool is the caller's own and read_tool_2 the alias
  expect(answer.content.map((c) => c.name ?? c.text)).toEqual(["read_tool", "read_tool", "grep", "read"])
})

test("Messages: an SSE reply gets the original names back, split anywhere", async () => {
  const text = sse([
    ["message_start", { type: "message_start", message: { id: "msg_1", content: [] } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "bash_tool" } }],
    ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "c1", name: "bash_tool", input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"bash_tool"}' } }],
    ["content_block_stop", { type: "content_block_stop", index: 1 }],
    ["message_stop", { type: "message_stop" }],
  ])
  for (const size of [1, 7, 4096]) {
    const { post } = await loaded(() => stream(text, size))
    const res = await post(messages, { model: "claude-opus-5-5", max_tokens: 100, system: DROID_LINE, stream: true, tools: [anthropicTool("bash")], messages: [{ role: "user", content: "hi" }] })
    const out = frames(await res.text())
    expect(out[1].content_block.text).toBe("bash_tool")
    expect(out[2].content_block.name).toBe("bash")
    expect(out[3].delta.partial_json).toBe('{"command":"bash_tool"}')
  }
})

test("Messages: aliases compose with wrapped schemas, in JSON and SSE replies", async () => {
  const wrapped = { name: "write", description: "w", input_schema: { anyOf: [{ type: "object", properties: { path: { type: "string" } } }, { type: "object", properties: { id: { type: "string" } } }] } }
  const request = { model: "claude-opus-5-5", max_tokens: 100, system: DROID_LINE, tools: [wrapped], messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "write", input: { path: "a" } }] }, { role: "user", content: "hi" }] }
  const input = { path: "b" }
  let l = await loaded(() => Response.json({ id: "msg_1", type: "message", content: [{ type: "tool_use", id: "c1", name: "write_tool", input: { arguments: input } }] }))
  let res = await l.post(messages, request)
  const b = JSON.parse(l.seen.at(-1).body)
  expect(b.tools[0].name).toBe("write_tool")
  expect(Object.keys(b.tools[0].input_schema.properties)).toEqual(["arguments"])
  expect(b.messages[0].content[0]).toMatchObject({ name: "write_tool", input: { arguments: { path: "a" } } })
  expect((await res.json()).content[0]).toEqual({ type: "tool_use", id: "c1", name: "write", input })
  const text = sse([
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "c1", name: "write_tool", input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ arguments: input }) } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_stop", { type: "message_stop" }],
  ])
  l = await loaded(() => stream(text, 3))
  res = await l.post(messages, request)
  const out = frames(await res.text())
  expect(out[0].content_block.name).toBe("write")
  expect(out[1].delta.partial_json).toBe(JSON.stringify(input))
})

test("Messages: a reply with nothing aliased is returned as it came", async () => {
  const body = JSON.stringify({ id: "msg_1", type: "message", content: [{ type: "tool_use", id: "c1", name: "read_tool", input: {} }] })
  const { post } = await loaded(() => new Response(body, { headers: { "content-type": "application/json" } }))
  const res = await post(messages, { model: "claude-opus-5-5", max_tokens: 100, system: DROID_LINE, tools: [anthropicTool("grep")], messages: [{ role: "user", content: "hi" }] })
  expect(await res.text()).toBe(body)
})

// ---- chat completions --------------------------------------------------------

const chatTool = (name) => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } })

test("chat: refused tools, tool_choice and earlier calls are renamed", async () => {
  const { sent } = await loaded()
  const request = {
    model: "kimi-k3",
    messages: [
      { role: "system", content: DROID_LINE },
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }, { id: "c2", type: "function", function: { name: "grep", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "bash" },
    ],
    tools: ["bash", "bash_tool", "grep", "Write"].map(chatTool),
    tool_choice: { type: "function", function: { name: "Write" } },
  }
  const b = await sent(chat, request)
  expect(b.tools.map((t) => t.function.name)).toEqual(["bash_tool_2", "bash_tool", "grep", "Write_tool"])
  expect(b.tools[0]).toEqual({ ...request.tools[0], function: { ...request.tools[0].function, name: "bash_tool_2" } })
  expect(b.tool_choice).toEqual({ type: "function", function: { name: "Write_tool" } })
  expect(b.messages[2].tool_calls.map((c) => c.function.name)).toEqual(["bash_tool_2", "grep"])
  expect(b.messages[2].tool_calls[0].function.arguments).toBe('{"command":"ls"}')
  expect(b.messages[3]).toEqual(request.messages[3])
})

test("chat: a request declaring no refused name goes out byte for byte", async () => {
  const { post, seen } = await loaded()
  const body = JSON.stringify({ model: "kimi-k3", messages: [{ role: "system", content: DROID_LINE }, { role: "user", content: "bash" }], tools: ["Read", "Execute"].map(chatTool) })
  await post(chat, body)
  expect(seen.at(-1).body).toBe(body)
})

test("chat: a JSON reply gets the original names back", async () => {
  const { post } = await loaded(() => Response.json({ id: "c", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: "read_tool", tool_calls: [{ id: "c1", type: "function", function: { name: "read_tool", arguments: "{}" } }, { id: "c2", type: "function", function: { name: "grep", arguments: "{}" } }] } }] }))
  const res = await post(chat, { model: "kimi-k3", messages: [{ role: "system", content: DROID_LINE }, { role: "user", content: "hi" }], tools: [chatTool("read"), chatTool("grep")] })
  const answer = await res.json()
  expect(answer.choices[0].message.tool_calls.map((c) => c.function.name)).toEqual(["read", "grep"])
  expect(answer.choices[0].message.content).toBe("read_tool")
})

test("chat: an SSE reply gets the original names back, split anywhere", async () => {
  const delta = (calls) => [null, { id: "c", choices: [{ index: 0, delta: { tool_calls: calls } }] }]
  const text = sse([
    [null, { id: "c", choices: [{ index: 0, delta: { role: "assistant", content: "edit_tool" } }] }],
    delta([{ index: 0, id: "c1", type: "function", function: { name: "edit_tool", arguments: "" } }]),
    delta([{ index: 0, function: { arguments: '{"path":"edit_tool"}' } }]),
  ]) + "data: [DONE]\n\n"
  for (const size of [1, 5, 4096]) {
    const { post } = await loaded(() => stream(text, size))
    const res = await post(chat, { model: "kimi-k3", stream: true, messages: [{ role: "system", content: DROID_LINE }, { role: "user", content: "hi" }], tools: [chatTool("edit")] })
    const raw = await res.text()
    expect(raw.endsWith("data: [DONE]\n\n")).toBe(true)
    const out = frames(raw.replace("data: [DONE]\n\n", ""))
    expect(out[0].choices[0].delta.content).toBe("edit_tool")
    expect(out[1].choices[0].delta.tool_calls[0].function.name).toBe("edit")
    expect(out[2].choices[0].delta.tool_calls[0].function.arguments).toBe('{"path":"edit_tool"}')
  }
})

// ---- Responses ---------------------------------------------------------------

const responsesTool = (name) => ({ type: "function", name, description: name, parameters: { type: "object", properties: {} }, strict: false })

test("Responses: refused tools, tool_choice and earlier calls are renamed", async () => {
  const { sent } = await loaded()
  const request = {
    model: "gpt-6.1", instructions: DROID_LINE,
    input: [
      { role: "user", content: "go" },
      { type: "function_call", call_id: "c1", name: "write", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "write" },
      { type: "function_call", call_id: "c2", name: "grep", arguments: "{}" },
    ],
    tools: [responsesTool("write"), responsesTool("grep"), { type: "web_search" }],
    tool_choice: { type: "function", name: "write" },
  }
  const b = await sent(responses, request)
  expect(b.tools).toEqual([{ ...request.tools[0], name: "write_tool" }, request.tools[1], request.tools[2]])
  expect(b.tool_choice).toEqual({ type: "function", name: "write_tool" })
  expect(b.input.filter((i) => i.type === "function_call").map((i) => i.name)).toEqual(["write_tool", "grep"])
  expect(b.input[2]).toEqual(request.input[2])
  // "auto" and the like have no name to change
  expect((await sent(responses, { ...request, tool_choice: "auto" })).tool_choice).toBe("auto")
})

test("Responses: a request declaring no refused name goes out byte for byte", async () => {
  const { post, seen } = await loaded()
  const body = JSON.stringify({ model: "gpt-6.1", instructions: DROID_LINE, input: [{ role: "user", content: "write" }], tools: [responsesTool("Read")] })
  await post(responses, body)
  expect(seen.at(-1).body).toBe(body)
})

test("Responses: a JSON reply gets the original names back", async () => {
  const { post } = await loaded(() => Response.json({ id: "resp_1", output: [{ type: "message", content: [{ type: "output_text", text: "write_tool" }] }, { type: "function_call", call_id: "c1", name: "write_tool", arguments: "{}" }, { type: "function_call", call_id: "c2", name: "grep", arguments: "{}" }] }))
  const res = await post(responses, { model: "gpt-6.1", instructions: DROID_LINE, input: [{ role: "user", content: "hi" }], tools: [responsesTool("write"), responsesTool("grep")] })
  const answer = await res.json()
  expect(answer.output.slice(1).map((o) => o.name)).toEqual(["write", "grep"])
  expect(answer.output[0].content[0].text).toBe("write_tool")
})

test("Responses: an SSE reply gets the original names back, split anywhere", async () => {
  const call = (name) => ({ type: "function_call", id: "fc_1", call_id: "c1", name, arguments: "" })
  const text = sse([
    ["response.created", { type: "response.created", response: { id: "resp_1", output: [] } }],
    ["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: call("write_tool") }],
    ["response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"p":"write_tool"}' }],
    ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { ...call("write_tool"), arguments: '{"p":"write_tool"}' } }],
    ["response.completed", { type: "response.completed", response: { id: "resp_1", output: [{ ...call("write_tool"), arguments: "{}" }] } }],
  ])
  for (const size of [1, 11, 4096]) {
    const { post } = await loaded(() => stream(text, size))
    const res = await post(responses, { model: "gpt-6.1", instructions: DROID_LINE, stream: true, input: [{ role: "user", content: "hi" }], tools: [responsesTool("write")] })
    const out = frames(await res.text())
    expect(out[1].item.name).toBe("write")
    expect(out[2].delta).toBe('{"p":"write_tool"}')
    expect(out[3].item.name).toBe("write")
    expect(out[4].response.output[0].name).toBe("write")
  }
})

// ---- Gemini ------------------------------------------------------------------

test("Gemini: declarations, calls, results and allowed names are renamed", async () => {
  const { sent } = await loaded()
  const declaration = (name) => ({ name, description: name, parameters: { type: "object", properties: {} } })
  const request = {
    contents: [
      { role: "user", parts: [{ text: "go" }] },
      { role: "model", parts: [{ functionCall: { name: "edit", args: { path: "a" } } }, { functionCall: { name: "grep", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { name: "edit", response: { output: "edit" } } }] },
    ],
    tools: [{ functionDeclarations: [declaration("edit"), declaration("grep")] }],
    toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["edit", "grep"] } },
  }
  const b = await sent(gemini, request)
  expect(b.tools[0].functionDeclarations.map((d) => d.name)).toEqual(["edit_tool", "grep"])
  expect(b.contents[1].parts.map((p) => p.functionCall.name)).toEqual(["edit_tool", "grep"])
  expect(b.contents[1].parts[0].functionCall.args).toEqual({ path: "a" })
  expect(b.contents[2].parts[0].functionResponse).toEqual({ name: "edit_tool", response: { output: "edit" } })
  expect(b.toolConfig.functionCallingConfig).toEqual({ mode: "ANY", allowedFunctionNames: ["edit_tool", "grep"] })
})

test("Gemini: a request declaring no refused name keeps its names", async () => {
  const { sent } = await loaded()
  const request = { contents: [{ role: "model", parts: [{ functionCall: { name: "bash", args: {} } }] }], tools: [{ functionDeclarations: [{ name: "grep" }] }] }
  const b = await sent(gemini, request)
  expect(b.tools).toEqual(request.tools)
  expect(b.contents).toEqual(request.contents)
})

test("Gemini: SSE and JSON replies get the original names back", async () => {
  const chunk = (parts) => [null, { candidates: [{ content: { role: "model", parts } }] }]
  const text = sse([chunk([{ text: "edit_tool" }]), chunk([{ functionCall: { name: "edit_tool", args: { path: "edit_tool" } } }, { functionCall: { name: "grep", args: {} } }])])
  const request = { contents: [{ role: "user", parts: [{ text: "hi" }] }], tools: [{ functionDeclarations: [{ name: "edit" }, { name: "grep" }] }] }
  for (const size of [1, 9, 4096]) {
    const { post } = await loaded(() => stream(text, size))
    const out = frames(await (await post(gemini, request)).text())
    expect(out[0].candidates[0].content.parts[0].text).toBe("edit_tool")
    expect(out[1].candidates[0].content.parts.map((p) => p.functionCall.name)).toEqual(["edit", "grep"])
    expect(out[1].candidates[0].content.parts[0].functionCall.args).toEqual({ path: "edit_tool" })
  }
  const { post } = await loaded(() => Response.json({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "edit_tool", args: {} } }] } }] }))
  expect((await (await post(gemini, request)).json()).candidates[0].content.parts[0].functionCall.name).toBe("edit")
  // a stream without alt=sse is an array of such objects
  const array = await loaded(() => Response.json([{ candidates: [{ content: { parts: [{ functionCall: { name: "edit_tool", args: {} } }] } }] }]))
  expect((await (await array.post(gemini, request)).json())[0].candidates[0].content.parts[0].functionCall.name).toBe("edit")
})

// ---- composition -------------------------------------------------------------

test("a retry without the older images aliases the request again, the same way", async () => {
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }
  let calls = 0
  const { post, seen } = await loaded(() => (++calls === 1 ? new Response("Request Entity Too Large", { status: 413 }) : Response.json({ id: "msg_1", type: "message", content: [{ type: "tool_use", id: "c1", name: "read_tool", input: {} }] })))
  const res = await post(messages, { model: "claude-opus-5-5", max_tokens: 100, system: DROID_LINE, tools: [anthropicTool("read")], messages: [{ role: "user", content: [image, { type: "text", text: "a" }] }, { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] }, { role: "user", content: [image] }] })
  expect(res.status).toBe(200)
  expect(seen.length).toBe(2)
  for (const call of seen) expect(JSON.parse(call.body).tools[0].name).toBe("read_tool")
  expect(JSON.parse(seen[1].body).messages[1].content[0].name).toBe("read_tool")
  expect((await res.json()).content[0].name).toBe("read")
})
