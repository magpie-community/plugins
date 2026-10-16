// magpie#1945 (XcodeFish, trae-cn/glm-5.3-flash under Codex): the tail of
// a tool call went out as an answer of its own, beside the call: the eight
// texts below are the ones the issue lists, as Codex showed them. And a
// heredoc's command, its quotes left unescaped, was cut at a quote that
// closed an object early, the rest sent on as text.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeCNAuthPlugin, _internal } from "./index.mjs"
import { fakeTrae, signedIn, sse } from "./fake.mjs"

const LEAKED = ["]</tool_call>", "</tool_call>", "}</tool_call>", ']}]}}"}}}}</tool_call>', "}}</tool_call>", '"></tool_call>']

const TOOLS = [{ type: "function", function: { name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" }, yield_time_ms: { type: "number" } } } } }]

// what TextTools makes of s given whole, and given a piece at a time
function read(s, size = 0) {
  const t = new _internal.TextTools(TOOLS)
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

const CALL = '<tool_call>{"name":"exec_command","arguments":{"cmd":"ls","yield_time_ms":180000}}'

test("what GLM leaves between a call and its close is dropped with the close, not sent on as text", () => {
  for (const tail of LEAKED)
    for (const size of [0, 1, 3, 7]) {
      expect(read("Listing it.\n" + CALL + tail, size)).toEqual({ text: "Listing it.\n", calls: [["exec_command", { cmd: "ls", yield_time_ms: 180000 }]], error: null })
      // and the same tail again after the call's own close
      expect(read(CALL + "</tool_call>\n" + tail + "\nDone.", size)).toEqual({ text: "Done.", calls: [["exec_command", { cmd: "ls", yield_time_ms: 180000 }]], error: null })
    }
})

test("a tail alone, from a call Trae's service read itself, is no text", () => {
  for (const tail of LEAKED) for (const size of [0, 1, 4]) expect(read(tail, size)).toEqual({ text: "", calls: [], error: null })
})

test("a call Trae's service read, its tail in the text: the call, and no text beside it", async () => {
  const f = fakeTrae()
  try {
    f.route("POST /api/agent/v3/llm_utils_chat", () => sse([
      ["output", { tool_calls: [{ id: "n1", function: { name: "exec_command", arguments: '{"cmd":"ls","yield_time_ms":180000}' } }] }],
      ["output", { response: "}" }],
      ["output", { response: "}</tool" }],
      ["output", { response: "_call>" }],
      ["done", { finish_reason: "tool_calls" }],
    ]))
    const hooks = await TraeCNAuthPlugin({ client: {} })
    const opts = await hooks.auth.loader(async () => signedIn())
    const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: "glm-5.3-flash", stream: true, tools: TOOLS, messages: [{ role: "user", content: "hi" }] }) })
    const deltas = (await res.text()).split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6))).filter((x) => x.choices?.length).map((x) => x.choices[0].delta)
    expect(deltas.map((d) => d.content ?? "").join("")).toBe("")
    expect(deltas.flatMap((d) => d.tool_calls ?? []).map((t) => [t.function.name, JSON.parse(t.function.arguments)])).toEqual([["exec_command", { cmd: "ls", yield_time_ms: 180000 }]])
  } finally {
    f.close()
  }
})

test("a heredoc whose quotes were left unescaped is read whole, not cut where an object closed early", () => {
  // one quote unescaped (after y): the object read as {"cmd":"…\"y"}}
  // ended there, and the rest went out as text
  const raw = String.raw`{"name":"exec_command","arguments":{"cmd":"python3 - <<'PY'\nimport json\nprint(json.dumps({\"名\": 'v', \"n\": {\"x\": \"y"}}))\nPY\n | tail -8","yield_time_ms":180000}}`
  const cmd = `python3 - <<'PY'\nimport json\nprint(json.dumps({"名": 'v', "n": {"x": "y"}}))\nPY\n | tail -8`
  for (const size of [0, 1, 5, 13]) expect(read("<tool_call>" + raw + "</tool_call>", size)).toEqual({ text: "", calls: [["exec_command", { cmd, yield_time_ms: 180000 }]], error: null })
})

test("a call followed by text that can't be part of it, before its close, fails rather than going out guessed", () => {
  for (const size of [0, 1, 6]) {
    const r = read(CALL + "x\n</tool_call>", size)
    expect(r.calls).toEqual([])
    expect(r.error).toContain("can't be read")
  }
})

test("braces, quotes and closes that aren't a call's tail stay text", () => {
  for (const s of [
    'The map is {"a": [1, {"b": 2}]}',
    'He said "done" >',
    "The </tool_call> tag ends a call.",
    "Call it like `{\"x\": 1}</tool_call>` in the prompt.",
  ])
    for (const size of [0, 1, 5]) expect(read(s, size)).toEqual({ text: s, calls: [], error: null })
})
