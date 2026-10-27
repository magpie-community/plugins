// #323: a call a model writes in Anthropic's tags (<function_calls> around
// <invoke name="…">) or Qwen's (<function=…>), with no <tool_call> around
// it, went to the agent as its reply text; and a parameter's value was
// JSON-parsed whatever the tool's schema said. The samples are trae's
// (01huadalang on magpie's Discord, Kimi K3 and MiMo 2.6 Pro under dsh,
// trae 0.2.19): no Qoder model has been seen writing them yet.
import { afterEach, expect, test } from "bun:test"
import { QoderAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const TOOLS = [
  { type: "function", function: { name: "compress", parameters: { type: "object", properties: { content: { type: "array", items: { type: "object" } } } } } },
  { type: "function", function: { name: "mcp__magpie-image__generation_result", parameters: { type: "object", properties: { id: { type: "string" } } } } },
  { type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } },
]

// sample 1, as the screenshot shows it (cut there), and as the model would have ended it
const S1_SHOWN = '<function=compress><parameter=content>[{"endId": "m03680", "endRef": "m03680", "startId": "m03485", "startRef": "m03485", "summary": "TASK AS OF THIS BLOCK（历史）: ...'
const S1 = S1_SHOWN + '"}]</parameter></function>'
const S1_ARGS = { content: [{ endId: "m03680", endRef: "m03680", startId: "m03485", startRef: "m03485", summary: "TASK AS OF THIS BLOCK（历史）: ..." }] }
// sample 2, whole in its screenshot
const S2 =
  '<function_calls><invoke name="mcp__magpie-image__generation_result"> <parameter name="id">image-6636-24</parameter> </invoke> <invoke name="mcp__magpie-image__generation_result"> <parameter name="id">image-6636-25</parameter> </invoke> <invoke name="mcp__magpie-image__generation_result"> <parameter name="id">image-6636-26</parameter> </invoke> </function_calls>'
const S2_CALLS = ["24", "25", "26"].map((n) => ["mcp__magpie-image__generation_result", { id: "image-6636-" + n }])
// sample 2 with the tags' namespace, as Claude-trained models write them
const NS = "ant" + "ml:"
const S2_NS = S2.replace(/<(\/?)(function_calls|invoke|parameter)\b/g, `<$1${NS}$2`)

// what the Splitter makes of the pieces, given in order, then the end
function readPieces(pieces, tools = TOOLS) {
  const s = new _internal.Splitter(tools)
  const out = { text: "", calls: [], error: null }
  for (const f of [...pieces.flatMap((p) => s.feed(p)), ...s.flush()]) {
    if (out.error) break
    if (f.text) out.text += f.text
    if (f.call) out.calls.push([f.call.name, JSON.parse(f.call.args)])
    if (f.error) out.error = f.error
  }
  return out
}
const read = (s, size = 0, tools = TOOLS) =>
  readPieces(size ? Array.from({ length: Math.ceil(s.length / size) }, (_, k) => s.slice(k * size, (k + 1) * size)) : [s], tools)
const splits = (s) => Array.from({ length: s.length - 1 }, (_, k) => [s.slice(0, k + 1), s.slice(k + 1)])

test("the two samples are calls, whole and in pieces of every size", () => {
  for (const size of [0, 1, 2, 3, 5, 7, 13, 64]) {
    expect(read(S1, size)).toEqual({ text: "", calls: [["compress", S1_ARGS]], error: null })
    expect(read(S2, size)).toEqual({ text: "", calls: S2_CALLS, error: null })
    expect(read(S2_NS, size)).toEqual({ text: "", calls: S2_CALLS, error: null })
    expect(read("先压缩一下上下文。\n" + S1, size)).toEqual({ text: "先压缩一下上下文。\n", calls: [["compress", S1_ARGS]], error: null })
    expect(read("取回三张图。\n" + S2 + "\n", size)).toEqual({ text: "取回三张图。\n", calls: S2_CALLS, error: null })
  }
})

test("split in two at any point, each is still its calls and no tag reaches the text", () => {
  for (const [a, b] of splits(S1)) expect(readPieces([a, b])).toEqual({ text: "", calls: [["compress", S1_ARGS]], error: null })
  for (const [a, b] of splits(S2)) expect(readPieces([a, b])).toEqual({ text: "", calls: S2_CALLS, error: null })
})

test("a parameter's value is its text where the tool's schema says string, bare or in <tool_call>", () => {
  expect(read("<function=bash><parameter=command>[1, 2]</parameter></function>").calls).toEqual([["bash", { command: "[1, 2]" }]])
  expect(read("<tool_call><function=bash><parameter=command>[1, 2]</parameter></function></tool_call>").calls).toEqual([["bash", { command: "[1, 2]" }]])
  expect(read(S1).calls[0][1].content).toBeArray()
})

test("Anthropic's with the closes left off between invokes: each invoke is a call", () => {
  for (const size of [0, 1, 4])
    expect(read('<function_calls>\n<invoke name="bash">\n<parameter name="command">ls</parameter>\n<invoke name="bash">\n<parameter name="command">pwd</parameter>\n</function_calls>', size)).toEqual({
      text: "",
      calls: [["bash", { command: "ls" }], ["bash", { command: "pwd" }]],
      error: null,
    })
})

test("a call the stream ends inside is cut short, never text", () => {
  for (const s of [S1_SHOWN, S2.slice(0, 95), '<function_calls><invoke name="bash"><parameter name="command">ls -']) {
    for (const size of [0, 1, 6]) {
      const r = read("Working.\n" + s, size)
      expect(r.text).toBe("Working.\n")
      expect(r.calls).toEqual([])
      expect(r.error).toContain("cut short")
    }
  }
  for (const size of [0, 1, 6]) {
    const r = read(S2.slice(0, 200), size)
    expect([r.text, r.calls]).toEqual(["", S2_CALLS.slice(0, 1)])
    expect(r.error).toContain("cut short")
  }
  expect(read(S1_SHOWN + '"}]</parameter>')).toEqual({ text: "", calls: [["compress", S1_ARGS]], error: null })
})

test("a tool the request didn't declare, or no tools at all, is no call: the text stays as written", () => {
  const s = '<function_calls><invoke name="delete_everything"><parameter name="path">/</parameter></invoke></function_calls>'
  for (const size of [0, 1, 5]) {
    expect(read(s, size)).toEqual({ text: s, calls: [], error: null })
    expect(read("<function=nope><parameter=x>1</parameter></function>", size)).toEqual({ text: "<function=nope><parameter=x>1</parameter></function>", calls: [], error: null })
    expect(read(S2, size, [])).toEqual({ text: S2, calls: [], error: null })
  }
})

test("prose about the tags stays text: in a sentence, in backticks, in a code fence", () => {
  for (const s of [
    "Claude wraps its calls in <function_calls> tags; each one is an <invoke> block.",
    'Use `<function_calls><invoke name="bash"><parameter name="command">ls</parameter></invoke></function_calls>` to call it.',
    'Example:\n```xml\n<function_calls>\n<invoke name="bash">\n<parameter name="command">ls</parameter>\n</invoke>\n</function_calls>\n```\nThat is the format.',
    "Qwen writes `<function=bash>` and then its parameters.",
    'The <invoke name="bash"> tag names a tool, and the call ends later.',
    "a < b and c > d, <function_calls without a close",
  ]) {
    for (const size of [0, 1, 3, 8]) expect(read(s, size)).toEqual({ text: s, calls: [], error: null })
  }
})

const API_CHAT = "https://api3.qoder.sh/v1/chat/completions"
const LISTING = { chat: [{ key: "efficient", display_name: "Efficient", enable: true }] }
const line = (body) => `data:${JSON.stringify({ headers: {}, body: JSON.stringify(body), statusCodeValue: 200, statusCode: "OK" })}\n\n`
const chunk = (delta, extra = {}) => line({ choices: [{ delta, index: 0, ...extra }], object: "chat.completion.chunk" })

async function ask(reply, stream, tools = TOOLS) {
  const auth = { type: "oauth", access: "jt", refresh: "rt", expires: Date.now() + 3_600_000, accountId: "one@x", uid: "u1", machineId: "m1" }
  globalThis.fetch = async (url) =>
    new URL(String(url)).pathname.endsWith("/model/list")
      ? new Response(JSON.stringify(LISTING), { headers: { "Content-Type": "application/json" } })
      : new Response(reply, { headers: { "Content-Type": "text/event-stream" } })
  const hooks = await QoderAuthPlugin({ client: { auth: { set: async () => {} } } })
  const l = await hooks.auth.loader(async () => auth)
  const body = { model: "efficient", tools, messages: [{ role: "user", content: "hi" }], ...(stream ? { stream: true } : {}) }
  return l.fetch(API_CHAT, { method: "POST", body: JSON.stringify(body) })
}

test("through the plugin, streamed and not: sample 2's three calls, finished as tool calls", async () => {
  const cut = [17, 60, 61, 140, 250, 300]
  const parts = cut.map((c, k) => S2.slice(k ? cut[k - 1] : 0, c)).concat(S2.slice(cut.at(-1)))
  const reply = parts.map((p) => chunk({ content: p })).join("") + chunk({}, { finish_reason: "stop" })

  const res = await ask(reply, true)
  expect(res.status).toBe(200)
  const frames = (await res.text())
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)))
  const deltas = frames.filter((f) => f.choices?.length).map((f) => f.choices[0].delta)
  expect(deltas.map((d) => d.content ?? "").join("")).toBe("")
  expect(deltas.flatMap((d) => d.tool_calls ?? []).map((t) => [t.function.name, JSON.parse(t.function.arguments)])).toEqual(S2_CALLS)
  expect(frames.filter((f) => f.choices?.[0]?.finish_reason).map((f) => f.choices[0].finish_reason)).toEqual(["tool_calls"])

  const whole = await ask(reply, false)
  expect(whole.status).toBe(200)
  const m = (await whole.json()).choices[0]
  expect(m.message.content ?? "").toBe("")
  expect(m.message.tool_calls.map((t) => [t.function.name, JSON.parse(t.function.arguments)])).toEqual(S2_CALLS)
  expect(m.finish_reason).toBe("tool_calls")

  // no tool declared: the tags are text
  const off = await ask(reply, false, [])
  expect((await off.json()).choices[0].message.content).toBe(S2)
})
