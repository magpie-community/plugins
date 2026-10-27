// Kimi K3 and MiMo 2.6 Pro on Trae, under dsh, sometimes write a call in
// the tags their training has: Qwen's <function=…><parameter=k>…, or
// Anthropic's <function_calls><invoke name="…">…. Neither was read, so the
// call went to the agent as its reply text (01huadalang on magpie's
// Discord, trae 0.2.18). The two samples are the reporter's screenshots,
// as transcribed; the first was cut by the screenshot, so it is read both
// as shown and closed.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeCNAuthPlugin, _internal } from "./index.mjs"
import { fakeTrae, signedIn, sse } from "./fake.mjs"

let f
afterEach(() => f?.close())

const TOOLS = [
  { type: "function", function: { name: "compress", parameters: { type: "object", properties: { content: { type: "array", items: { type: "object" } } } } } },
  { type: "function", function: { name: "mcp__magpie-image__generation_result", parameters: { type: "object", properties: { id: { type: "string" } } } } },
  { type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } },
]

// sample 1, as the screenshot shows it (cut there)
const S1_SHOWN = '<function=compress><parameter=content>[{"endId": "m03680", "endRef": "m03680", "startId": "m03485", "startRef": "m03485", "summary": "TASK AS OF THIS BLOCK（历史）: ...'
// and as the model would have ended it
const S1 = S1_SHOWN + '"}]</parameter></function>'
const S1_ARGS = { content: [{ endId: "m03680", endRef: "m03680", startId: "m03485", startRef: "m03485", summary: "TASK AS OF THIS BLOCK（历史）: ..." }] }
// sample 2, whole in its screenshot
const S2 =
  '<function_calls><invoke name="mcp__magpie-image__generation_result"> <parameter name="id">image-6636-24</parameter> </invoke> <invoke name="mcp__magpie-image__generation_result"> <parameter name="id">image-6636-25</parameter> </invoke> <invoke name="mcp__magpie-image__generation_result"> <parameter name="id">image-6636-26</parameter> </invoke> </function_calls>'
const S2_CALLS = ["24", "25", "26"].map((n) => ["mcp__magpie-image__generation_result", { id: "image-6636-" + n }])

// what TextTools makes of the pieces, given in order, then the end
function readPieces(pieces, tools = TOOLS) {
  const t = new _internal.TextTools(tools)
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
const read = (s, size = 0, tools = TOOLS) =>
  readPieces(size ? Array.from({ length: Math.ceil(s.length / size) }, (_, k) => s.slice(k * size, (k + 1) * size)) : [s], tools)
// every split of s in two
const splits = (s) => Array.from({ length: s.length - 1 }, (_, k) => [s.slice(0, k + 1), s.slice(k + 1)])

test("the reporter's two replies are calls, whole and in pieces of every size", () => {
  for (const size of [0, 1, 2, 3, 5, 7, 13, 64]) {
    expect(read(S1, size)).toEqual({ text: "", calls: [["compress", S1_ARGS]], error: null })
    expect(read(S2, size)).toEqual({ text: "", calls: S2_CALLS, error: null })
    // with the text a model writes before them
    expect(read("先压缩一下上下文。\n" + S1, size)).toEqual({ text: "先压缩一下上下文。\n", calls: [["compress", S1_ARGS]], error: null })
    expect(read("取回三张图。\n" + S2 + "\n", size)).toEqual({ text: "取回三张图。\n", calls: S2_CALLS, error: null })
  }
})

test("split in two at any point, each is still its calls and no tag reaches the text", () => {
  for (const [a, b] of splits(S1)) expect(readPieces([a, b])).toEqual({ text: "", calls: [["compress", S1_ARGS]], error: null })
  for (const [a, b] of splits(S2)) expect(readPieces([a, b])).toEqual({ text: "", calls: S2_CALLS, error: null })
})

test("a parameter's value is JSON where the tool's schema says array or object, its text where it says string", () => {
  expect(read('<function=bash><parameter=command>[1, 2]</parameter></function>').calls).toEqual([["bash", { command: "[1, 2]" }]])
  expect(read(S1).calls[0][1].content).toBeArray()
})

test("Qwen's form inside <tool_call>, and Anthropic's with the closes left off between invokes, are calls too", () => {
  for (const size of [0, 1, 4]) {
    expect(read("<tool_call>\n<function=bash>\n<parameter=command>\nls -la\n</parameter>\n</function>\n</tool_call>", size)).toEqual({ text: "", calls: [["bash", { command: "ls -la" }]], error: null })
    expect(read('<function_calls>\n<invoke name="bash">\n<parameter name="command">ls</parameter>\n<invoke name="bash">\n<parameter name="command">pwd</parameter>\n</function_calls>', size)).toEqual({ text: "", calls: [["bash", { command: "ls" }], ["bash", { command: "pwd" }]], error: null })
  }
})

test("a call the stream ends inside is cut short, never text: sample 1 as the screenshot shows it", () => {
  for (const s of [S1_SHOWN, S2.slice(0, 95), '<function_calls><invoke name="bash"><parameter name="command">ls -']) {
    for (const size of [0, 1, 6]) {
      const r = read("Working.\n" + s, size)
      expect(r.text).toBe("Working.\n")
      expect(r.calls).toEqual([])
      expect(r.error).toContain("cut short")
    }
  }
  // cut inside the second invoke: the first is still a call, then the error
  for (const size of [0, 1, 6]) {
    const r = read(S2.slice(0, 200), size)
    expect([r.text, r.calls]).toEqual(["", S2_CALLS.slice(0, 1)])
    expect(r.error).toContain("cut short")
  }
  // its parameter closed, the close of the function left off: the call
  expect(read(S1_SHOWN + '"}]</parameter>')).toEqual({ text: "", calls: [["compress", S1_ARGS]], error: null })
})

test("a tool the request didn't declare is no call: the text stays as written", () => {
  const s = '<function_calls><invoke name="delete_everything"><parameter name="path">/</parameter></invoke></function_calls>'
  for (const size of [0, 1, 5]) {
    expect(read(s, size)).toEqual({ text: s, calls: [], error: null })
    expect(read("<function=nope><parameter=x>1</parameter></function>", size)).toEqual({ text: "<function=nope><parameter=x>1</parameter></function>", calls: [], error: null })
    // no tools declared at all
    expect(read(S2, size, [])).toEqual({ text: S2, calls: [], error: null })
  }
})

test("prose about <function_calls> stays text: in a sentence, in backticks, in a code fence", () => {
  for (const s of [
    "Claude wraps its calls in <function_calls> tags; each one is an <invoke> block.",
    "Use `<function_calls><invoke name=\"bash\"><parameter name=\"command\">ls</parameter></invoke></function_calls>` to call it.",
    'Example:\n```xml\n<function_calls>\n<invoke name="bash">\n<parameter name="command">ls</parameter>\n</invoke>\n</function_calls>\n```\nThat is the format.',
    "Qwen writes `<function=bash>` and then its parameters.",
    'The <invoke name="bash"> tag names a tool, and the call ends later.',
    "a < b and c > d, <function_calls without a close",
  ]) {
    for (const size of [0, 1, 3, 8]) expect(read(s, size)).toEqual({ text: s, calls: [], error: null })
  }
})

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

test("through the plugin, streamed and not: sample 2's three calls, finished as tool calls", async () => {
  f = fakeTrae()
  const cut = [17, 60, 61, 140, 250, 300]
  const pieces = cut.map((c, k) => S2.slice(k ? cut[k - 1] : 0, c)).concat(S2.slice(cut.at(-1)))
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([...pieces.map((p) => ["output", { response: p }]), ["done", { finish_reason: "stop" }]]))
  const body = { model: "kimi-k3", tools: TOOLS, messages: [{ role: "user", content: "hi" }] }

  const c = await chunks(await ask({ ...body, stream: true }))
  const d = deltasOf(c)
  expect(d.map((x) => x.content ?? "").join("")).toBe("")
  expect(d.flatMap((x) => x.tool_calls ?? []).map((t) => [t.function.name, JSON.parse(t.function.arguments)])).toEqual(S2_CALLS)
  expect(c.filter((x) => x !== "[DONE]" && x.choices?.[0]?.finish_reason).map((x) => x.choices[0].finish_reason)).toEqual(["tool_calls"])

  const res = await ask(body)
  expect(res.status).toBe(200)
  const m = (await res.json()).choices[0]
  expect(m.message.content ?? "").toBe("")
  expect(m.message.tool_calls.map((t) => [t.function.name, JSON.parse(t.function.arguments)])).toEqual(S2_CALLS)
  expect(m.finish_reason).toBe("tool_calls")
})
