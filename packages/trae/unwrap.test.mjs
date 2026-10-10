// bee2an on X (yetone/magpie, 2026-10-10): asked for
// {"name":…,"arguments":{…}}, the model wrote the arguments wrapped once
// more, and their agent's write got {"arguments":{"content":…,"path":…}}.
// The arguments are the ones in their screenshot, byte for byte.
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

const callsOf = (c) => c.filter((x) => x !== "[DONE]" && x.choices?.length).flatMap((x) => x.choices[0].delta.tool_calls ?? []).map((t) => [t.function.name, JSON.parse(t.function.arguments)])

// pi-go's write
const TOOLS = [
  { type: "function", function: { name: "write", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "task", parameters: { type: "object", properties: { input: { type: "object" } } } } },
]
const BEE = '{"arguments":{"content":"P\\n\\n","path":"/Users/bee/j/pi-go/playground/cases/run-20261010-1805/trail2.txt"}}'
const BARE = { content: "P\n\n", path: "/Users/bee/j/pi-go/playground/cases/run-20261010-1805/trail2.txt" }

test("bee2an's write, wrapped in a block's arguments, reaches the agent bare (streamed)", async () => {
  f = fakeTrae()
  const block = '<tool_call>{"name":"write","arguments":' + BEE + "}</tool_call>"
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([
    ["output", { response: block.slice(0, 40) }],
    ["output", { response: block.slice(40) }],
    ["done", { finish_reason: "stop" }],
  ]))
  const c = await chunks(await ask({ model: "deepseek-v4.1-flash", stream: true, tools: TOOLS, messages: [{ role: "user", content: "hi" }] }))
  expect(callsOf(c)).toEqual([["write", BARE]])
})

test("bee2an's write as Trae's native call, wrapped, reaches the agent bare (not streamed)", async () => {
  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([
    ["output", { tool_calls: [{ id: "c1", function: { name: "write", arguments: BEE.slice(0, 25) } }] }],
    ["output", { tool_calls: [{ id: "c1", function: { name: "write", arguments: BEE } }] }],
    ["done", { finish_reason: "tool_calls" }],
  ]))
  const res = await ask({ model: "deepseek-v4.1-flash", tools: TOOLS, messages: [{ role: "user", content: "hi" }] })
  const m = (await res.json()).choices[0].message
  expect(m.tool_calls.map((t) => [t.function.name, JSON.parse(t.function.arguments)])).toEqual([["write", BARE]])
})

test("a layer is only taken off where the tool has no parameter of its name", () => {
  const u = (a, n) => JSON.parse(_internal.unwrapped(a, n, TOOLS))
  expect(u(BEE, "write")).toEqual(BARE)
  // twice wrapped, and wrapped as a string
  expect(u('{"arguments":{"input":{"path":"a","content":"b"}}}', "write")).toEqual({ path: "a", content: "b" })
  expect(u('{"arguments":"{\\"path\\":\\"a\\",\\"content\\":\\"b\\"}"}', "write")).toEqual({ path: "a", content: "b" })
  // the tool's own input parameter stays
  expect(u('{"input":{"q":1}}', "task")).toEqual({ input: { q: 1 } })
  // bare arguments, a second key, a tool not in the request: as they are
  expect(u(JSON.stringify(BARE), "write")).toEqual(BARE)
  expect(u('{"arguments":{"path":"a"},"content":"b"}', "write")).toEqual({ arguments: { path: "a" }, content: "b" })
  expect(u(BEE, "other")).toEqual(JSON.parse(BEE))
})
