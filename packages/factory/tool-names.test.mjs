import { afterEach, expect, test } from "bun:test"
import { FactoryAuthPlugin, _internal } from "./index.mjs"
import { refusedName, suffixed } from "./tool-names.mjs"

const real = globalThis.fetch
afterEach(() => { globalThis.fetch = real; _internal.renamedInFull.clear() })
const A = "https://api.factory.ai/api/llm/a/v1/messages"
const R = "https://api.factory.ai/api/llm/o/v1/responses"
const C = "https://api.factory.ai/api/llm/o/v1/chat/completions"
const schema = { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
const sse = (events) => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })

// SEEN_REFUSED is what real accounts saw Factory refuse as a declared tool
// name (plugins#1291, #1306, can1357/oh-my-pi#19553), kept apart from the
// plugin's own list so a name it misses shows here.
const SEEN_REFUSED = new Set([
  "Agent", "Bash", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "Write", "Shell", "StrReplace",
  "agent", "bash", "edit", "glob", "grep", "read", "run_shell", "task", "write",
  "AgentTool", "BashTool", "WriteTool", "bash_tool", "edit_tool", "read_tool", "write_tool",
  "web_search", "read_file", "execute_command",
])
const seenRefused = (n) => typeof n === "string" && (SEEN_REFUSED.has(n) || SEEN_REFUSED.has(n.replace(/^_+/, "")))

// refusing stands in for Factory: a declared refused name is a 403.
function refusing(names) {
  return names.some((n) => seenRefused(n))
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

test("Claude Code's Bash goes out as droid's Execute everywhere and its call comes back as Bash", async () => {
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
  // Anthropic's server tool keeps the name Anthropic gives it; whether
  // Factory's check reads a server tool's name was not probed
  const { l, seen } = await loaded((sent) => refusing(sent.tools.filter((t) => !t.type).map((t) => t.name)) ?? Response.json({
    id: "m1", type: "message", role: "assistant", stop_reason: "tool_use",
    content: [{ type: "text", text: "Running Execute" }, { type: "tool_use", id: "t2", name: "Execute", input: { command: "pwd" } }],
  }))
  const res = await l.fetch(A, { method: "POST", body: JSON.stringify(body) })
  expect(res.status).toBe(200)
  const sent = JSON.parse(seen[0].body)
  expect(sent.tools.map((t) => t.name)).toEqual(["Execute", "Read", "web_search"])
  expect(sent.tool_choice).toEqual({ type: "tool", name: "Execute" })
  expect(sent.messages[1].content[0].name).toBe("Execute")
  expect(sent.messages[2].content[1].text).toBe("Use the Bash tool again.")
  const answer = await res.json()
  expect(answer.content[1]).toEqual({ type: "tool_use", id: "t2", name: "Bash", input: { command: "pwd" } })
  // only names are restored, never text
  expect(answer.content[0].text).toBe("Running Execute")
})

test("a streamed tool call is restored across chunk boundaries, and the stream's text is untouched", async () => {
  const events = [
    { type: "message_start", message: { id: "m1", type: "message", role: "assistant", content: [] } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I'll call Create" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "Create", input: {} } },
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
  expect(got[2].delta.text).toBe("I'll call Create")
  expect(got.length).toBe(events.length)
})

test("a refused name with a wrapped schema is renamed and unwrapped together", async () => {
  const union = { anyOf: [schema, { type: "object", properties: { script: { type: "string" } }, required: ["script"] }] }
  const { l, seen } = await loaded((sent) => refusing(sent.tools.map((t) => t.name)) ?? sse([
    { type: "message_start", message: { id: "m1", type: "message", role: "assistant", content: [] } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "Task", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"arguments\":{\"command\":\"go\"}}" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_stop" },
  ]))
  const res = await l.fetch(A, { method: "POST", body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 64, stream: true, tools: [{ name: "Agent", input_schema: union }], messages: [{ role: "user", content: "hi" }] }) })
  expect(JSON.parse(seen[0].body).tools[0].name).toBe("Task")
  const got = (await res.text()).split("\n").filter((x) => x.startsWith("data: ")).map((x) => JSON.parse(x.slice(6)))
  expect(got.find((e) => e.type === "content_block_start").content_block.name).toBe("Agent")
  const json = got.filter((e) => e.delta?.type === "input_json_delta").map((e) => e.delta.partial_json).join("")
  expect(JSON.parse(json)).toEqual({ command: "go" })
})

test("OpenAI Responses: OpenCode's bash and its earlier call go out as Execute, the streamed call comes back as bash", async () => {
  const { l, seen } = await loaded((sent) => refusing(sent.tools.map((t) => t.name)) ?? sse([
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc1", call_id: "c1", name: "Execute", arguments: "" } },
    { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc1", call_id: "c1", name: "Execute", arguments: "{}" } },
  ]))
  const body = {
    model: "gpt-6-luna", stream: true, instructions: "x",
    tools: [{ type: "function", name: "bash", parameters: schema }, { type: "function", name: "glob", parameters: schema }],
    input: [{ type: "function_call", call_id: "c0", name: "bash", arguments: "{}" }, { type: "function_call_output", call_id: "c0", output: "ok" }],
  }
  const res = await l.fetch(R, { method: "POST", body: JSON.stringify(body) })
  const sent = JSON.parse(seen[0].body)
  expect(sent.tools.map((t) => t.name)).toEqual(["Execute", "Glob"])
  expect(sent.input[0].name).toBe("Execute")
  const got = (await res.text()).split("\n").filter((x) => x.startsWith("data: ")).map((x) => JSON.parse(x.slice(6)))
  expect(got.map((e) => e.item.name)).toEqual(["bash", "bash"])
})

test("chat completions: a refused function name and its history are renamed and the reply restored", async () => {
  const { l, seen } = await loaded((sent) => refusing(sent.tools.map((t) => t.function.name)) ?? Response.json({
    object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", tool_calls: [{ id: "c2", type: "function", function: { name: "Edit", arguments: "{}" } }] } }],
  }))
  const body = {
    model: "glm-5.3", tools: [{ type: "function", function: { name: "edit", parameters: schema } }], tool_choice: { type: "function", function: { name: "edit" } },
    messages: [{ role: "user", content: "hi" }, { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "edit", arguments: "{}" } }] }, { role: "tool", tool_call_id: "c1", content: "ok" }],
  }
  const res = await l.fetch(C, { method: "POST", body: JSON.stringify(body) })
  const sent = JSON.parse(seen[0].body)
  expect(sent.tools[0].function.name).toBe("Edit")
  expect(sent.tool_choice.function.name).toBe("Edit")
  expect(sent.messages.find((m) => m.tool_calls).tool_calls[0].function.name).toBe("Edit")
  expect((await res.json()).choices[0].message.tool_calls[0].function.name).toBe("edit")
})

test("an alias never takes a name the request already declares: the droid name taken, the tool goes out suffixed", async () => {
  const alias = suffixed("Bash")
  expect(alias).toMatch(/^Bash_[0-9a-f]{4}$/)
  const { l, seen } = await loaded((sent) => refusing(sent.tools.map((t) => t.name)) ?? Response.json({
    type: "message", content: [{ type: "tool_use", id: "a", name: alias, input: {} }, { type: "tool_use", id: "b", name: "Execute", input: {} }],
  }))
  const res = await l.fetch(A, { method: "POST", body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 8, tools: [{ name: "Bash", input_schema: schema }, { name: "Execute", input_schema: schema }], messages: [{ role: "user", content: "hi" }] }) })
  expect(JSON.parse(seen[0].body).tools.map((t) => t.name)).toEqual([alias, "Execute"])
  expect((await res.json()).content.map((b) => b.name)).toEqual(["Bash", "Execute"])
})

test("a refused tool droid has no name for goes out suffixed, the same in every request of the process", async () => {
  const { l, seen } = await loaded((sent) => refusing(sent.tools.map((t) => t.name)) ?? Response.json({ type: "message", content: [] }))
  const body = JSON.stringify({ model: "claude-opus-5-5", max_tokens: 8, tools: [{ name: "TaskCreate", input_schema: schema }, { name: "bash", input_schema: schema }, { name: "run_shell", input_schema: schema }], messages: [{ role: "user", content: "hi" }] })
  for (let i = 0; i < 2; i++) expect((await l.fetch(A, { method: "POST", body })).status).toBe(200)
  const names = seen.map((s) => JSON.parse(s.body).tools.map((t) => t.name))
  // two refused tools with one droid name: the first takes it
  expect(names[0]).toEqual([suffixed("TaskCreate"), "Execute", suffixed("run_shell")])
  expect(names[1]).toEqual(names[0])
  expect(names[0].some((n) => seenRefused(n))).toBe(false)
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
    type: "message", content: [{ type: "tool_use", id: "a", name: "Execute", input: { name: "Execute", nested: { name: "Execute" } } }],
  }))
  const res = await l.fetch(A, { method: "POST", body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 8, tools: [{ name: "Bash", input_schema: schema }], messages: [{ role: "user", content: "hi" }] }) })
  expect((await res.json()).content[0]).toEqual({ type: "tool_use", id: "a", name: "Bash", input: { name: "Execute", nested: { name: "Execute" } } })
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
  expect(sent.tools.map((t) => t.name)).toEqual(["Execute", "Create"])
  expect(sent.tool_choice.tools.map((t) => t.name)).toEqual(["Execute", "Create"])
  expect(sent.input[0].name).toBe("Create")
})

test("a stream event whose JSON spans several data lines is restored, CRLF kept", async () => {
  const event = { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "Execute", input: {} } }
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

// @a1pha1nthefog (X, 2026-11-19): dsh (DeepSeek Harness) on Factory's Opus
// 5.5 got content_policy_rejected on its first turn, the user message "1",
// and again on 0.1.50: dsh declares web_search too, which two real accounts
// saw refused the same day (can1357/oh-my-pi#19553).
// The fixture is dsh 0.2.1-rc.2's own request (dsh headless, captured as it
// left dsh): its prompt is 2.5 KB, and it declares bash, edit, glob, grep,
// read and write, names Factory refuses. Through magpie it reaches Factory as
// chat completions or, for a Claude model, as Messages.
const dsh = JSON.parse(await Bun.file(new URL("./testdata/dsh-0.2.1-chat.json", import.meta.url)).text())
const dshNames = dsh.tools.map((t) => t.function.name)

test("dsh's own first request declares names Factory refuses", () => {
  expect(dshNames.filter((n) => seenRefused(n)).sort()).toEqual(["bash", "edit", "glob", "grep", "read", "web_search", "write"])
  // and the plugin's list holds every one of them
  expect(dshNames.filter((n) => seenRefused(n)).every(refusedName)).toBe(true)
})

test("dsh's request on chat completions goes out with no refused name, its prompt as dsh wrote it, and a streamed call comes back as bash", async () => {
  const chunk = (delta, extra = {}) => ({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta, ...extra }] })
  const { l, seen } = await loaded((sent) => refusing(sent.tools.map((t) => t.function.name)) ?? new Response(
    [chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "Execute", arguments: "" } }] }),
     chunk({ tool_calls: [{ index: 0, function: { arguments: "{\"command\":\"ls\"}" } }] }),
     chunk({}, { finish_reason: "tool_calls" })].map((c) => "data: " + JSON.stringify(c) + "\n\n").join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } }))
  const res = await l.fetch(C, { method: "POST", body: JSON.stringify({ ...dsh, model: "glm-5.3" }) })
  expect(res.status).toBe(200)
  // taken on the first try, not after a refusal
  expect(seen.length).toBe(1)
  const sent = JSON.parse(seen[0].body)
  const names = sent.tools.map((t) => t.function.name)
  expect(names.some((n) => seenRefused(n))).toBe(false)
  expect(names.filter((n, i) => n !== dshNames[i])).toEqual(["Execute", "Edit", "Glob", "Grep", "Read", "WebSearch", "Create"])
  // only the names change: descriptions (their "harness" read runtime), schemas and dsh's own text stay
  expect(sent.tools.map((t) => t.function.parameters)).toEqual(dsh.tools.map((t) => t.function.parameters))
  expect(sent.tools.map((t) => t.function.description)).toEqual(dsh.tools.map((t) => _internal.harnessText(t.function.description)))
  expect(sent.messages.slice(-2)).toEqual(dsh.messages.slice(-2))
  const text = await res.text()
  const calls = text.split("\n").filter((x) => x.startsWith("data: {")).map((x) => JSON.parse(x.slice(6)))
  expect(calls[0].choices[0].delta.tool_calls[0].function.name).toBe("bash")
  expect(text).toEndWith("data: [DONE]\n\n")
})

test("dsh's request translated to Messages for a Claude model goes out with no refused name", async () => {
  const { l, seen } = await loaded((sent) => refusing(sent.tools.map((t) => t.name)) ?? Response.json({
    id: "m1", type: "message", role: "assistant", stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "t1", name: "Create", input: { path: "a.txt", content: "x" } }],
  }))
  const body = {
    model: "claude-opus-5-5", max_tokens: 64,
    system: dsh.messages[0].content,
    tools: dsh.tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })),
    messages: dsh.messages.slice(1).map((m) => ({ role: m.role, content: m.content })),
  }
  const res = await l.fetch(A, { method: "POST", body: JSON.stringify(body) })
  expect(res.status).toBe(200)
  expect(JSON.parse(seen[0].body).tools.map((t) => t.name).some((n) => seenRefused(n))).toBe(false)
  expect((await res.json()).content[0].name).toBe("write")
})

test("the names two real accounts saw refused on 11-19 go out as droid's, and any of them behind leading underscores is refused too", async () => {
  expect(["web_search", "read_file", "execute_command", "_read", "__bash", "_web_search"].every(refusedName)).toBe(true)
  expect(["omp_read", "readfile", "run_bash", "shell_command", "Read", "WebSearch", "web_fetch"].some(refusedName)).toBe(false)
  const { l, seen } = await loaded((sent) => refusing(sent.tools.map((t) => t.function.name)) ?? Response.json({
    id: "c1", object: "chat.completion", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
      tool_calls: [{ id: "x", type: "function", function: { name: "WebSearch", arguments: "{}" } }] } }],
  }))
  const tools = ["web_search", "read_file", "execute_command", "_grep"].map((name) => ({ type: "function", function: { name, parameters: schema } }))
  const res = await l.fetch(C, { method: "POST", body: JSON.stringify({ model: "glm-5.3", tools, messages: [{ role: "user", content: "hi" }] }) })
  expect(res.status).toBe(200)
  expect(seen.length).toBe(1)
  expect(JSON.parse(seen[0].body).tools.map((t) => t.function.name)).toEqual(["WebSearch", "Read", "Execute", "Grep"])
  expect((await res.json()).choices[0].message.tool_calls[0].function.name).toBe("web_search")
})

// Factory's list grows without notice: a fake that refuses a name the
// plugin doesn't list stands in for the next one it adds.
const refusingAlso = (extra) => (names) => names.some((n) => seenRefused(n) || extra.includes(n))
  ? Response.json({ code: "content_policy_rejected", detail: "This request was blocked by Factory's usage policy check." }, { status: 403 })
  : null

test("a request refused for a name not listed yet goes once more with every tool renamed, and that tool set goes renamed from then on", async () => {
  const refuse = refusingAlso(["web_fetch"])
  const { l, seen } = await loaded((sent) => refuse(sent.tools.map((t) => t.function.name)) ?? Response.json({
    id: "c1", object: "chat.completion", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
      tool_calls: [{ id: "x", type: "function", function: { name: JSON.parse(seen.at(-1).body).tools[1].function.name, arguments: "{}" } }] } }],
  }))
  const body = JSON.stringify({ ...dsh, model: "glm-5.3", stream: false })
  const res = await l.fetch(C, { method: "POST", body })
  expect(res.status).toBe(200)
  expect(seen.length).toBe(2)
  const first = JSON.parse(seen[0].body).tools.map((t) => t.function.name)
  const second = JSON.parse(seen[1].body).tools.map((t) => t.function.name)
  expect(first).toContain("web_fetch")
  expect(second).not.toContain("web_fetch")
  expect(second).toContain(suffixed("web_fetch"))
  // droid's names stay as they are; dsh's others are renamed too
  expect(second).toContain("Execute")
  expect(second.filter((n) => dshNames.includes(n))).toEqual([])
  // only names change
  expect(JSON.parse(seen[1].body).tools.map((t) => t.function.description)).toEqual(dsh.tools.map((t) => _internal.harnessText(t.function.description)))
  expect((await res.json()).choices[0].message.tool_calls[0].function.name).toBe("create_goal")
  // the next turn of the same tool set is renamed in full at once
  const again = await l.fetch(C, { method: "POST", body })
  expect(again.status).toBe(200)
  expect(seen.length).toBe(3)
  expect(JSON.parse(seen[2].body).tools.map((t) => t.function.name)).toEqual(second)
})

test("refused again with every tool renamed, it is the request's content, and that refusal is the answer after two tries", async () => {
  const { l, seen } = await loaded(() => Response.json({ code: "content_policy_rejected", detail: "This request was blocked by Factory's usage policy check." }, { status: 403 }))
  const res = await l.fetch(C, { method: "POST", body: JSON.stringify({ ...dsh, model: "glm-5.3", stream: false }) })
  expect(res.status).toBe(400)
  expect((await res.json()).error.code).toBe("content_policy_rejected")
  expect(seen.length).toBe(2)
  expect(_internal.renamedInFull.size).toBe(0)
})

// plugins#1446: these five built-in Cowork declarations were each refused
// by name on an Anthropic Messages request.
const COWORK_MCP_NAMES = [
  "mcp__cowork__present_files",
  "mcp__cowork__screenshot_artifact",
  "mcp__cowork__screenshot_file_preview",
  "mcp__workspace__bash",
  "mcp__workspace__web_fetch",
]

test("Cowork's five built-in MCP tool names go through full retry, and their call is restored", async () => {
  const refused = new Set(COWORK_MCP_NAMES)
  const { l, seen } = await loaded((sent) => {
    if (sent.tools.some((t) => refused.has(t.name))) {
      return Response.json({ code: "content_policy_rejected", detail: "This request was blocked by Factory's usage policy check." }, { status: 403 })
    }
    const called = JSON.parse(seen.at(-1).body).tools[0].name
    return Response.json({
      id: "m1", type: "message", role: "assistant", stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "t1", name: called, input: {} }],
    })
  })
  const body = JSON.stringify({
    model: "claude-opus-5-5", max_tokens: 128,
    tools: COWORK_MCP_NAMES.map((name) => ({ name, input_schema: { type: "object", properties: {} } })),
    messages: [{ role: "user", content: "请只回复 OK" }],
  })
  const res = await l.fetch(A, { method: "POST", body })
  expect(res.status).toBe(200)
  expect(seen.length).toBe(2)
  const first = JSON.parse(seen[0].body).tools.map((t) => t.name)
  const second = JSON.parse(seen[1].body).tools.map((t) => t.name)
  expect(first).toEqual(COWORK_MCP_NAMES)
  expect(second).not.toEqual(first)
  expect(second.every((name, i) => name.startsWith(COWORK_MCP_NAMES[i] + "_"))).toBe(true)
  expect((await res.json()).content[0].name).toBe(COWORK_MCP_NAMES[0])
})

test("a refused request that declares no tools is not sent again", async () => {
  const { l, seen } = await loaded(() => Response.json({ code: "content_policy_rejected", detail: "blocked" }, { status: 403 }))
  const res = await l.fetch(C, { method: "POST", body: JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "hi" }] }) })
  expect(res.status).toBe(400)
  expect(seen.length).toBe(1)
})
