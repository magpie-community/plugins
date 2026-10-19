// plugins#38: a tool call the model wrote into its text that wasn't read
// went out as the answer, the call lost, with a 200 nothing could fail
// over on. The shapes are the issue's (deepseek-v4.1-flash on trae-cn) and
// ARNO's on Discord (trae-cn, content redacted by them as xxxx).
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeCNAuthPlugin, _internal } from "./index.mjs"
import { fakeTrae, signedIn, sse } from "./fake.mjs"

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

const deltasOf = (c) => c.filter((x) => x !== "[DONE]" && x.choices?.length).map((x) => x.choices[0].delta)
const callsOf = (c) => deltasOf(c).flatMap((d) => d.tool_calls ?? []).map((t) => [t.function.name, JSON.parse(t.function.arguments)])
const textOf = (c) => deltasOf(c).map((d) => d.content ?? "").join("")
const finishOf = (c) => c.filter((x) => x !== "[DONE]" && x.choices?.[0]?.finish_reason).map((x) => x.choices[0].finish_reason)

const TOOLS = [
  { type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } },
  { type: "function", function: { name: "write", parameters: { type: "object", properties: { content: { type: "string" }, filePath: { type: "string" } } } } },
]

// what TextTools makes of s given whole, and given a piece at a time
function read(s, size = 0, tools = TOOLS) {
  const t = new _internal.TextTools(tools)
  const pieces = size ? Array.from({ length: Math.ceil(s.length / size) }, (_, k) => s.slice(k * size, (k + 1) * size)) : [s]
  const out = { text: "", calls: [], error: null }
  for (const [k, p] of [...pieces, ""].entries()) {
    const r = t.push(p, k === pieces.length)
    out.text += r.text
    out.calls.push(...r.calls.map((c) => [c.name, JSON.parse(c.arguments)]))
    if (r.error) {
      out.error = r.error
      break
    }
  }
  return out
}

// ARNO's two replies, as sent
const ARNO_1 = '官方资料齐了。我把完整分析写成文件，聊天里给你重点。\n<tool_call>{"name":"write","arguments":{"content":"xxxxxxxx"}}'
const ARNO_2 = '文件确实丢了(可能是之前写入没成功)，我重写完整版。\n<tool_call>{"name":"write","arguments":{"content":"xxxxxx"}}</tool_call>'

test("ARNO's two replies are calls: a block closed, and one whose JSON is whole when the stream ends", () => {
  for (const size of [0, 1, 7]) {
    expect(read(ARNO_1, size)).toEqual({ text: "官方资料齐了。我把完整分析写成文件，聊天里给你重点。\n", calls: [["write", { content: "xxxxxxxx" }]], error: null })
    expect(read(ARNO_2, size)).toEqual({ text: "文件确实丢了(可能是之前写入没成功)，我重写完整版。\n", calls: [["write", { content: "xxxxxx" }]], error: null })
  }
})

test("a write's content as models get its JSON wrong is still the call: quotes left unescaped, backslashes JSON doesn't know", () => {
  // ARNO's second reply, its redacted content as a written-out analysis
  // may have it
  const contents = [
    '# 分析\n他说"官方"的资料齐了',
    "| 列 | a \\| b |\n| --- | --- |",
    "snake\\_case 和 \\*强调\\*",
    "路径 C:\\Users\\arno\\x",
    "```json\n{\"a\": 1, \"b\": \"c\"}\n```\n完",
  ]
  const want = [
    '# 分析\n他说"官方"的资料齐了',
    "| 列 | a \\| b |\n| --- | --- |",
    "snake\\_case 和 \\*强调\\*",
    "路径 C:\\Users\\arno\\x",
    '```json\n{"a": 1, "b": "c"}\n```\n完',
  ]
  contents.forEach((c, k) => {
    const s = '文件确实丢了(可能是之前写入没成功)，我重写完整版。\n<tool_call>{"name":"write","arguments":{"content":"' + c + '"}}</tool_call>'
    for (const size of [0, 5]) {
      const r = read(s, size)
      expect(r.error).toBe(null)
      expect(r.text).toBe("文件确实丢了(可能是之前写入没成功)，我重写完整版。\n")
      expect(r.calls).toEqual([["write", { content: want[k] }]])
    }
  })
})

test("#38's shapes: escaped quotes and an attribute-framed opener are calls; a block cut short is an error, never text", () => {
  // the issue's repro, case by case
  expect(read('Sure. <tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>')).toEqual({ text: "Sure. ", calls: [["bash", { command: "ls" }]], error: null })
  for (const size of [0, 3]) {
    expect(read('<tool_call>{\\"name\\":\\"bash\\",\\"arguments\\":{\\"command\\":\\"ls\\"}}</tool_call>', size)).toEqual({ text: "", calls: [["bash", { command: "ls" }]], error: null })
    expect(read('<tool_call name="bash">\n<parameter name="command">ls</parameter>\n</tool_call>', size)).toEqual({ text: "", calls: [["bash", { command: "ls" }]], error: null })
    // the name as JSON, then its parameters (magpie#917's shape)
    expect(read('<tool_call>{"name":"bash"}>\n<parameter name="command">ls -la</parameter>\n</tool_call>', size)).toEqual({ text: "", calls: [["bash", { command: "ls -la" }]], error: null })
  }
  // a quote in a command escaped as a whole block's are
  expect(read('<tool_call>{\\"name\\":\\"bash\\",\\"arguments\\":{\\"command\\":\\"echo \\\\\\"hi\\\\\\"\\"}}</tool_call>').calls).toEqual([["bash", { command: 'echo "hi"' }]])
  for (const cut of [
    '<tool_call>{"name":"bash","arguments":{"command":"cd "C:/x"',
    '<tool_call>{"name":"write","arguments":{"content":"## 结论\\n1. 先',
    '<tool_call name="bash">\n<parameter name="command">ls -',
  ]) {
    for (const size of [0, 4]) {
      const r = read("Running it.\n" + cut, size)
      expect(r.error).toContain("cut short")
      expect(r.text).toBe("Running it.\n")
      expect(r.calls).toEqual([])
    }
  }
  // closed, but not JSON however read
  const bad = read('<tool_call>{"name":"bash","arguments":{"command":}}</tool_call>')
  expect(bad.error).toContain("can't be read")
  expect(bad.text).toBe("")
})

test("a call cut short with only its closing braces missing is still the call (#38)", () => {
  // the stream's last characters are lost, and what is lost is only the
  // containers' ends: every string is closed, so the call's fields are
  // whole. Most of the issue's cut-off calls were this shape.
  for (const size of [0, 1, 4]) {
    expect(read('Running it.\n<tool_call>{"name":"bash","arguments":{"command":"ls -la"', size)).toEqual({
      text: "Running it.\n",
      calls: [["bash", { command: "ls -la" }]],
      error: null,
    })
    expect(read('<tool_call>{"name":"bash","arguments":{"command":"ls -la"}', size)).toEqual({
      text: "",
      calls: [["bash", { command: "ls -la" }]],
      error: null,
    })
    expect(read('<tool_call>{"name":"write","arguments":{"content":"a\\nb","filePath":"x"}', size)).toEqual({
      text: "",
      calls: [["write", { content: "a\nb", filePath: "x" }]],
      error: null,
    })
    expect(read('<tool_call>{"name":"bash","arguments":{"argv":["ls","-la"]', size)).toEqual({
      text: "",
      calls: [["bash", { argv: ["ls", "-la"] }]],
      error: null,
    })
    // the close tag itself cut short is the stream's, not the call's
    expect(read('<tool_call>{"name":"bash","arguments":{"command":"ls -la"}</tool_call', size)).toEqual({
      text: "",
      calls: [["bash", { command: "ls -la" }]],
      error: null,
    })
  }
  // a value still being written is not repaired: its string is open, or
  // its key has no value yet
  for (const cut of [
    '<tool_call>{"name":"bash","arguments":{"command":"rm -rf /tmp/fo',
    '<tool_call>{"name":"bash","arguments":{"command":"ls","x":',
    // a number may have been cut (12 from 123), so it isn't closed here
    '<tool_call>{"name":"bash","arguments":{"command":"ls","timeout":12',
  ]) {
    for (const size of [0, 4]) {
      const r = read(cut, size)
      expect(r.error).toContain("cut short")
      expect(r.calls).toEqual([])
    }
  }
})

test("XcodeFish's two on 0.2.6 (#38): <toolcall> without the underscore is read as <tool_call> is, and a stream that ends inside an opener is cut short", () => {
  for (const size of [0, 1, 4]) {
    // glm-5.3-flash's empty block beside a real call: no call, and not text
    expect(read("<toolcall></toolcall>", size)).toEqual({ text: "", calls: [], error: null })
    expect(read('<toolcall>{"name":"bash","arguments":{"command":"ls"}}</toolcall>', size)).toEqual({ text: "", calls: [["bash", { command: "ls" }]], error: null })
    expect(read('<toolcall name="bash">\n<parameter name="command">ls</parameter>\n</toolcall>', size)).toEqual({ text: "", calls: [["bash", { command: "ls" }]], error: null })
    expect(read('<toolcall>{"name":"bash","arguments":{"command":}}</toolcall>', size).error).toContain("can't be read")
    for (const cut of ["<tool_call name", "<tool_call", '<tool_call name="ba', "<toolcall name"]) {
      const r = read("Running it.\n" + cut, size)
      expect(r).toEqual({ text: "Running it.\n", calls: [], error: r.error })
      expect(r.error).toContain("cut short")
    }
  }
  // in backticks it is prose, as <tool_call> is
  for (const s of ["Each call goes in a `<toolcall>` block.", "The tag is `<tool_call name", "Write `<toolcall>{\"name\":\"x\"}</toolcall>` to call."]) {
    for (const size of [0, 1, 6]) expect(read(s, size)).toEqual({ text: s, calls: [], error: null })
  }
})

test("prose that mentions <tool_call> stays text: in backticks, in a code fence, or a tag named in passing", () => {
  for (const s of [
    'Write `<tool_call>{"name":"bash","arguments":{}}</tool_call>` to call a tool.',
    "Each call goes in a `<tool_call>` block.",
    'Example:\n```\n<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>\n```\nThat is all.',
    "The <tool_call> tag wraps a call; </tool_call> ends it.",
    "<tool_call>hello</tool_call> ok",
  ]) {
    for (const size of [0, 1, 6]) expect(read(s, size)).toEqual({ text: s, calls: [], error: null })
  }
})

test("a stream whose call is cut short ends with an error, not a finish, and the block isn't the answer", async () => {
  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([
    ["output", { response: "Running it.\n<tool_call>" }],
    ["output", { response: '{"name":"bash","arguments":{"command":"cd "C:/x"' }],
    ["done", { finish_reason: "stop" }],
  ]))
  const res = await ask({ model: "deepseek-v4.1-flash", stream: true, tools: TOOLS, messages: [{ role: "user", content: "hi" }] })
  const c = await chunks(res)
  expect(textOf(c)).toBe("Running it.\n")
  expect(textOf(c)).not.toContain("<tool_call")
  expect(finishOf(c)).toEqual([])
  expect(c.find((x) => x !== "[DONE]" && x.error).error.message).toContain("cut short")
  expect(c.at(-1)).toBe("[DONE]")

  // asked without a stream, it is a failure the gateway can fail over on
  const res2 = await ask({ model: "deepseek-v4.1-flash", tools: TOOLS, messages: [{ role: "user", content: "hi" }] })
  expect(res2.status).toBe(502)
  expect((await res2.json()).error.message).toContain("cut short")
})

test("ARNO's second reply through the plugin: a write call, the reply finished as one that called tools", async () => {
  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([
    ["output", { response: ARNO_2.slice(0, 30) }],
    ["output", { response: ARNO_2.slice(30, 60) }],
    ["output", { response: ARNO_2.slice(60) }],
    ["done", { finish_reason: "stop" }],
  ]))
  // the agent declared the tool as Write
  const tools = [{ type: "function", function: { name: "Write", parameters: { type: "object", properties: { content: { type: "string" } } } } }]
  const c = await chunks(await ask({ model: "deepseek-v4.1-flash", stream: true, tools, messages: [{ role: "user", content: "hi" }] }))
  expect(textOf(c)).toBe("文件确实丢了(可能是之前写入没成功)，我重写完整版。\n")
  expect(callsOf(c)).toEqual([["Write", { content: "xxxxxx" }]])
  expect(finishOf(c)).toEqual(["tool_calls"])
})
