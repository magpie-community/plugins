// A model that isn't Claude gets its earlier turns' reasoning back
// (plugins#703, kamikakushi). swe-2 is conditioned on the assistant turns
// before having thinking (ChatMessagePrompt field 11): with none there it
// stops emitting delta_thinking on a tool loop's later turns. The thinking
// goes back as its text alone, never with a signature (12) or its type
// (18), which only Claude's signed thinking carries (plugins#665); Claude
// gets no unsigned thinking on any path. Field numbers are Devin's proto's
// (devin2api's all-protos.proto, ExaChatPb_ChatMessagePrompt); the
// reporter's A/B against swe-2-high is what the swe-2 behaviour rests on.
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { fields, build, buildMessages, v2Chat } = _internal
const dec = new TextDecoder()
const SIG = "EqQBCkgIBRABGAIiQL2xYzRvY0RzZWNyZXRzaWduYXR1cmU="

// prompts is each ChatMessagePrompt a request sends, with the thinking,
// signature and signature type it carries
const prompts = (body) =>
  fields(body)
    .filter((f) => f.num === 3 && f.wire === 2)
    .map((f) => {
      const p = { role: 0, text: "", calls: [], thinking: null, signature: null, type: null }
      for (const g of fields(f.data)) {
        if (g.num === 2) p.role = g.n
        else if (g.num === 3) p.text = dec.decode(g.data)
        else if (g.num === 6) p.calls.push(dec.decode(fields(g.data).find((h) => h.num === 2).data))
        else if (g.num === 11) p.thinking = dec.decode(g.data)
        else if (g.num === 12) p.signature = dec.decode(g.data)
        else if (g.num === 18) p.type = dec.decode(g.data)
      }
      return p
    })
const assistant = (body) => prompts(body).filter((p) => p.role === 2)

// a two-step tool loop as a chat completion client sends it back
const chatLoop = (extra = {}) => ({
  messages: [
    { role: "user", content: "Read /a, then /b." },
    { role: "assistant", content: null, reasoning_content: "Start with /a.", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"/a"}' } }], ...extra },
    { role: "tool", tool_call_id: "call_1", content: "A" },
    { role: "assistant", content: "Now /b.", reasoning_content: "A is read; /b next.", tool_calls: [{ id: "call_2", type: "function", function: { name: "read_file", arguments: '{"path":"/b"}' } }] },
    { role: "tool", tool_call_id: "call_2", content: "B" },
  ],
  tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
})

test("a chat completion's reasoning goes back as unsigned thinking to swe-2", () => {
  expect(assistant(build(chatLoop(), "swe-2", "k")).map((p) => [p.text, p.calls, p.thinking, p.signature, p.type])).toEqual([
    ["", ["read_file"], "Start with /a.", null, null],
    ["Now /b.", ["read_file"], "A is read; /b next.", null, null],
  ])
})

test("reasoning named reasoning, as some clients send it, goes back too", () => {
  const chat = chatLoop()
  for (const m of chat.messages) if (m.reasoning_content) [m.reasoning, m.reasoning_content] = [m.reasoning_content, undefined]
  expect(assistant(build(chat, "swe-2", "k")).map((p) => p.thinking)).toEqual(["Start with /a.", "A is read; /b next."])
})

test("a turn without reasoning sends no thinking, and a turn that only thought still sends nothing", () => {
  const chat = chatLoop()
  delete chat.messages[1].reasoning_content
  chat.messages.push({ role: "assistant", content: "", reasoning_content: "nothing to say" }, { role: "user", content: "go" })
  const ps = assistant(build(chat, "swe-2", "k"))
  expect(ps.map((p) => p.thinking)).toEqual([null, "A is read; /b next."])
})

test("a call split over two messages keeps both halves' reasoning", () => {
  const chat = {
    messages: [
      { role: "user", content: "Read both." },
      { role: "assistant", content: null, reasoning_content: "First /a.", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "assistant", content: null, reasoning_content: "And /b.", tool_calls: [{ id: "call_2", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "A" },
      { role: "tool", tool_call_id: "call_2", content: "B" },
    ],
  }
  const ps = assistant(build(chat, "swe-2", "k"))
  expect(ps.map((p) => [p.calls, p.thinking])).toEqual([[["read_file", "read_file"], "First /a.\n\nAnd /b."]])
})

test("Claude gets no unsigned thinking from a chat completion", () => {
  for (const uid of ["claude-opus-5-5", "claude-sonnet-4-6-thinking"]) {
    const ps = prompts(build(chatLoop(), uid, "k"))
    expect(ps.every((p) => p.thinking === null && p.signature === null && p.type === null)).toBe(true)
  }
})

// OpenCode 2's language model: a reply's reasoning parts
const v2Prompt = [
  { role: "user", content: [{ type: "text", text: "Read /a." }] },
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "Start with /a." },
      { type: "tool-call", toolCallId: "call_1", toolName: "read_file", input: { path: "/a" } },
    ],
  },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "call_1", toolName: "read_file", output: { type: "text", value: "A" } }] },
]

test("OpenCode 2's reasoning parts go back as reasoning_content, and on to swe-2 as thinking", () => {
  const chat = v2Chat({ prompt: v2Prompt }, "swe-2")
  const a = chat.messages.find((m) => m.role === "assistant")
  expect(a.reasoning_content).toBe("Start with /a.")
  expect(assistant(build(chat, "swe-2", "k")).map((p) => [p.calls, p.thinking, p.signature])).toEqual([[["read_file"], "Start with /a.", null]])
  // and not on to Claude
  const claude = v2Chat({ prompt: v2Prompt }, "claude-opus-5-5")
  expect(prompts(build(claude, "claude-opus-5-5", "k")).every((p) => p.thinking === null)).toBe(true)
})

test("an assistant turn with no reasoning part has no reasoning_content", () => {
  const prompt = [v2Prompt[0], { role: "assistant", content: [{ type: "text", text: "ok" }] }]
  const a = v2Chat({ prompt }, "swe-2").messages.find((m) => m.role === "assistant")
  expect("reasoning_content" in a).toBe(false)
})

// Messages to a model that isn't Claude: a thinking block goes back as its
// text, whatever signature it has; to Claude only signed thinking, with it
const messagesLoop = (thinking) => ({
  messages: [
    { role: "user", content: "Read /a." },
    { role: "assistant", content: [thinking, { type: "tool_use", id: "toolu_01", name: "read_file", input: { path: "/a" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "A" }] },
  ],
})

test("Messages: another model's thinking goes back without a signature", () => {
  for (const signature of ["", SIG, undefined]) {
    const ps = assistant(buildMessages(messagesLoop({ type: "thinking", thinking: "Start with /a.", signature }), "swe-2", "k"))
    expect(ps.map((p) => [p.calls, p.thinking, p.signature, p.type])).toEqual([[["read_file"], "Start with /a.", null, null]])
  }
  // an empty one sends nothing
  const empty = assistant(buildMessages(messagesLoop({ type: "thinking", thinking: "", signature: "" }), "swe-2", "k"))
  expect(empty.map((p) => p.thinking)).toEqual([null])
})

test("Messages: Claude's signed thinking is as #665 left it, and its unsigned none", () => {
  const signed = assistant(buildMessages(messagesLoop({ type: "thinking", thinking: "Start with /a.", signature: SIG }), "claude-opus-5-5", "k"))
  expect(signed.map((p) => [p.calls, p.thinking, p.signature, p.type])).toEqual([[["read_file"], "Start with /a.", SIG, "anthropic"]])
  // a signed block whose text is empty sends its signature without text
  const bare = assistant(buildMessages(messagesLoop({ type: "thinking", thinking: "", signature: SIG }), "claude-opus-5-5", "k"))
  expect(bare.map((p) => [p.thinking, p.signature])).toEqual([[null, SIG]])
  const unsigned = assistant(buildMessages(messagesLoop({ type: "thinking", thinking: "Start with /a.", signature: "" }), "claude-opus-5-5", "k"))
  expect(unsigned.map((p) => [p.thinking, p.signature, p.type])).toEqual([[null, null, null]])
})
