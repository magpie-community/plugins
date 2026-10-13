// Trae reads a model's call for it and hands what it could not read on as a
// native call: the tool would be the JSON wrapper the prompt asked for, with
// GLM's own <arg_key>/<arg_value> tags and the text where its service stopped.
// The call is the client's, so it is read here rather than passed on as a
// tool nobody declared (2026-10-13, trae-cn/glm-5.3 under a coding agent:
// 28 of 54 calls, twelve steps in a row).
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeCNAuthPlugin, _internal } from "./index.mjs"
import { fakeTrae, signedIn, sse } from "./fake.mjs"

let f
afterEach(() => f?.close())

const TOOLS = [
  { type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" }, description: { type: "string" }, workdir: { type: "string" } } } } },
  { type: "function", function: { name: "read", parameters: { type: "object", properties: { file_path: { type: "string" }, limit: { type: "number" }, offset: { type: "number" } } } } },
]

// what a name the model wrote a call into reads as, through take()
function read(name, args = "{}") {
  const nc = new _internal.NativeCalls()
  nc.push({ id: "c1", function: { name, arguments: args } })
  return nc.take(TOOLS)[0]
}

test("a name holding the wrapper with GLM's tags is that call: the tags stand for the punctuation they replaced", () => {
  const c = read('{"name":"bash","arguments":{"command</arg_key><arg_value>ls -la</arg_value>')
  expect([c.name, JSON.parse(c.arguments)]).toEqual(["bash", { command: "ls -la" }])
})

test("a value the service cut at its tag keeps the text it got, and the quotes the model didn't escape are read", () => {
  const cut = read('{"name":"bash","arguments":{"command":"grep -n \\"x\\" a.ts | head -3</arg_value>')
  expect(JSON.parse(cut.arguments)).toEqual({ command: 'grep -n "x" a.ts | head -3' })
  const raw = read('{"name":"bash","arguments":{"command":"grep -n "x" a.ts; echo ---; grep -n "\'y\'" b.ts | head -5</arg_value>')
  expect(JSON.parse(raw.arguments)).toEqual({ command: 'grep -n "x" a.ts; echo ---; grep -n "\'y\'" b.ts | head -5' })
})

test("the native call's own arguments are kept, and the fields the name carries are filled in beside them", () => {
  const c = read('{"name":"bash","arguments":{"command</arg_key><arg_value>sed -n 1,9p a.ts</arg_value>', '{"description":"Read a.ts","workdir":"/tmp"}')
  expect(JSON.parse(c.arguments)).toEqual({ command: "sed -n 1,9p a.ts", description: "Read a.ts", workdir: "/tmp" })
})

test("the whole call in the wrapper, its arguments closed by a quote the model left unescaped", () => {
  const c = read('{"name":"bash","arguments":{"command":"grep -n "x" a.ts; echo ---; grep -n "\'y\'" b.ts | head -5","description":"Find x","workdir":"/repo"}}')
  expect(JSON.parse(c.arguments)).toEqual({ command: 'grep -n "x" a.ts; echo ---; grep -n "\'y\'" b.ts | head -5', description: "Find x", workdir: "/repo" })
})

test("a field the schema says is no string is its JSON where the text is one, and its text where it isn't", () => {
  const c = read('{"name":"read","arguments":{"file_path":"/a/b.ts","limit":55,"offset</arg_key><arg_value>405"}}')
  expect(JSON.parse(c.arguments)).toEqual({ file_path: "/a/b.ts", limit: 55, offset: 405 })
  const cut = read('{"name":"read","arguments":{"file_path":"/a/b.ts","limit</arg_key><arg_value>55')
  expect(JSON.parse(cut.arguments)).toEqual({ file_path: "/a/b.ts", limit: 55 })
})

test("a name in front of the wrapper is the name the service put there, not one the request has", () => {
  const c = read('bash_abstract_command_0>{"name":"bash","arguments":{"command":"node scan.mjs</arg_value>')
  expect([c.name, JSON.parse(c.arguments)]).toEqual(["bash", { command: "node scan.mjs" }])
})

test("a wrapper around a tool the request hasn't is left as written, for the agent to answer", () => {
  const name = '{"name":"nope","arguments":{"command</arg_key><arg_value>ls</arg_value>'
  expect(read(name).name).toBe(name)
})

test("a wrapper no field can be read from is left as written, not guessed at", () => {
  const name = '{"name":"bash","arguments":{'
  expect(read(name).name).toBe(name)
})

test("a streamed call Trae could not read reaches the agent as the call, not as an unknown tool", async () => {
  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([
    ["output", { tool_calls: [{ id: "n1", function: { name: '{"name":"bash","arguments":{"command</arg_key><arg_value>grep -n x a.ts</arg_value>', arguments: '{"description":"Find x"}' } }] }],
    ["done", { finish_reason: "tool_calls" }],
  ]))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => signedIn())
  const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: "glm-5.3", stream: true, tools: TOOLS, messages: [{ role: "user", content: "hi" }] }) })
  const calls = (await res.text()).split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6))).filter((x) => x.choices?.length).flatMap((x) => x.choices[0].delta.tool_calls ?? []).map((t) => [t.function.name, JSON.parse(t.function.arguments)])
  expect(calls).toEqual([["bash", { command: "grep -n x a.ts", description: "Find x" }]])
})

// the shapes as they arrived, from the run this was found in (trae-cn/glm-5.3,
// 2026-10-13): the fields each name carries, and the native call's own beside
// them — the service moves the arguments it read and leaves the rest behind
const REAL = [
  ['{"name":"bash","arguments":{"command</arg_key><arg_value>grep -n x a.ts</arg_value>', '{"description":"Find x"}', "bash", { command: "grep -n x a.ts", description: "Find x" }],
  ['{"name":"read","arguments":{"file_path":"/a/b.ts","limit":55,"offset</arg_key><arg_value>405"}}', "{}", "read", { file_path: "/a/b.ts", limit: 55, offset: 405 }],
]

test("the payloads themselves: every field each name carries is read, and the native call's own kept", () => {
  for (const [name, args, tool, want] of REAL) {
    const nc = new _internal.NativeCalls()
    nc.push({ id: "c1", function: { name, arguments: args } })
    const c = nc.take(TOOLS)[0]
    expect([c.name, JSON.parse(c.arguments)]).toEqual([tool, want])
  }
})
