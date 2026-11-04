// Claude's thinking through Devin keeps its signature (plugins#665,
// Vigilans). GetChatMessageResponse carries it in delta_signature (field
// 10) and its type in delta_signature_type (21), beside delta_thinking (9);
// ChatMessagePrompt takes the thinking back in thinking (11), signature
// (12) and signature_type (18). The field numbers are the ones in Devin's
// proto (devin2api's all-protos.proto: GetChatMessageResponse,
// ExaChatPb_ChatMessagePrompt); the frames below are built from them, not
// captured from Devin.
import { afterEach, expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { PB, frame, fields, buildMessages, completeMessages, build, events, familiesOf, SNAPSHOT } = _internal
const dec = new TextDecoder()
const enc = new TextEncoder()
const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  _internal.forgetSigTypes?.()
})

const SIG = "EqQBCkgIBRABGAIiQL2xYzRvY0RzZWNyZXRzaWduYXR1cmU="

// tail is a Connect stream's end frame, {}
const tail = () => {
  const end = enc.encode("{}")
  const t = new Uint8Array(5 + end.length)
  t[0] = 2
  new DataView(t.buffer).setUint32(1, end.length)
  t.set(end, 5)
  return t
}
// reply is Devin's answer: thinking, its signature split in two deltas
// (the second frame also says the type), then text and the finish
const reply = (type = "anthropic") => {
  const usage = new PB().varint(2, 10).varint(3, 5).done()
  return new Response(
    new Blob([
      frame(new PB().str(9, "Let me think.").done()),
      frame(new PB().str(10, SIG.slice(0, 20)).done()),
      frame(new PB().str(10, SIG.slice(20)).str(21, type).done()),
      frame(new PB().str(3, "Hello.").done()),
      frame(new PB().varint(5, 1).bytes(7, usage).done()),
      tail(),
    ]),
  )
}
const ctx = { key: "k", server: "https://devin.test", families: familiesOf(SNAPSHOT) }
const req = (model, stream) => ({ model, max_tokens: 64, stream, thinking: { type: "adaptive" }, messages: [{ role: "user", content: "hi" }] })

// prompts is each ChatMessagePrompt a request sends: its role, text,
// calls, and the thinking it carries back
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

test("the reply's signature and its type are read", async () => {
  const got = []
  async function* fr() {
    yield { data: new PB().str(9, "hm").str(10, SIG).str(21, "anthropic").done() }
    yield { data: new PB().str(3, "ok").done() }
  }
  for await (const e of events(fr())) got.push(e)
  expect(got.slice(0, 4)).toEqual([{ reasoning: "hm" }, { signature: SIG }, { signatureType: "anthropic" }, { text: "ok" }])
})

test("a whole Messages reply's thinking carries Claude's signature", async () => {
  globalThis.fetch = async () => reply()
  const j = await (await completeMessages(ctx, req("claude-opus-5-5", false))).json()
  expect(j.content).toEqual([
    { type: "thinking", thinking: "Let me think.", signature: SIG },
    { type: "text", text: "Hello." },
  ])
})

test("a streamed Messages reply sends the signature before the thinking block stops", async () => {
  globalThis.fetch = async () => reply()
  const res = await completeMessages(ctx, req("claude-opus-5-5", true))
  const ev = (await res.text()).split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)))
  expect(ev.map((e) => e.type + (e.delta?.type ? ":" + e.delta.type : ""))).toEqual([
    "message_start",
    "content_block_start",
    "content_block_delta:thinking_delta",
    "content_block_delta:signature_delta",
    "content_block_delta:signature_delta",
    "content_block_stop",
    "content_block_start",
    "content_block_delta:text_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ])
  expect(ev[1].content_block).toEqual({ type: "thinking", thinking: "", signature: "" })
  expect(ev[3].delta.signature + ev[4].delta.signature).toBe(SIG)
  expect(ev[3].index).toBe(0)
})

test("another model's thinking stays unsigned, as before", async () => {
  globalThis.fetch = async () => reply("openai")
  const j = await (await completeMessages(ctx, req("deepseek-v4-flash", false))).json()
  expect(j.content[0]).toEqual({ type: "thinking", thinking: "Let me think.", signature: "" })
  globalThis.fetch = async () => reply("openai")
  const ev = (await (await completeMessages(ctx, req("deepseek-v4-flash", true))).text()).split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)))
  expect(ev.some((e) => e.delta?.type === "signature_delta")).toBe(false)
})

const history = (assistant) => ({
  model: "claude-opus-5-5",
  messages: [
    { role: "user", content: "Read /a." },
    { role: "assistant", content: assistant },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "A" }] },
  ],
})
const use = { type: "tool_use", id: "toolu_01", name: "read_file", input: { path: "/a" } }

test("the next request sends Claude's signed thinking back on the prompt that follows it", () => {
  const ps = prompts(buildMessages(history([{ type: "thinking", thinking: "Read it first.", signature: SIG }, { type: "text", text: "Reading it." }, use]), "claude-opus-5-5", "k"))
  const a = ps.find((p) => p.role === 2)
  expect(a).toEqual({ role: 2, text: "Reading it.", calls: ["read_file"], thinking: "Read it first.", signature: SIG, type: "anthropic" })
  // with no text, the calls' prompt carries it
  const only = prompts(buildMessages(history([{ type: "thinking", thinking: "t", signature: SIG }, use]), "claude-opus-5-5", "k")).find((p) => p.role === 2)
  expect(only).toEqual({ role: 2, text: "", calls: ["read_file"], thinking: "t", signature: SIG, type: "anthropic" })
})

test("thinking after the text goes on a prompt of its own ahead of the calls", () => {
  const ps = prompts(
    buildMessages(
      history([{ type: "thinking", thinking: "one", signature: "s1" }, { type: "text", text: "Reading it." }, { type: "thinking", thinking: "two", signature: "s2" }, use]),
      "claude-opus-5-5",
      "k",
    ),
  ).filter((p) => p.role === 2)
  expect(ps.map((p) => [p.text, p.calls, p.thinking, p.signature])).toEqual([
    ["Reading it.", [], "one", "s1"],
    ["", ["read_file"], "two", "s2"],
  ])
})

test("the signature's type Devin said goes back with it", async () => {
  globalThis.fetch = async () => reply("anthropic-bedrock")
  const j = await (await completeMessages(ctx, req("claude-opus-5-5", false))).json()
  expect(_internal.sigTypeOf?.(SIG)).toBe("anthropic-bedrock")
  const a = prompts(buildMessages(history([...j.content, use]), "claude-opus-5-5", "k")).find((p) => p.role === 2)
  expect([a.thinking, a.signature, a.type]).toEqual(["Let me think.", SIG, "anthropic-bedrock"])
})

test("unsigned thinking to Claude goes no further, and another model's goes without a signature", () => {
  const unsigned = prompts(buildMessages(history([{ type: "thinking", thinking: "t", signature: "" }, use]), "claude-opus-5-5", "k")).find((p) => p.role === 2)
  expect([unsigned.thinking, unsigned.signature, unsigned.type]).toEqual([null, null, null])
  // another model's thinking goes back as its text alone (plugins#703)
  const other = prompts(buildMessages(history([{ type: "thinking", thinking: "t", signature: SIG }, use]), "deepseek-v4-flash-high", "k")).find((p) => p.role === 2)
  expect([other.thinking, other.signature, other.type]).toEqual(["t", null, null])
  // a turn that only thought still sends nothing of its own
  const ps = prompts(buildMessages({ messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: SIG }] }] }, "claude-opus-5-5", "k"))
  expect(ps.some((p) => p.role === 2)).toBe(false)
})

test("a chat completion's request is the same as before", () => {
  const chat = { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo", reasoning_content: "t" }, { role: "user", content: "go" }] }
  const ps = prompts(build(chat, "claude-opus-5-5", "k"))
  expect(ps.every((p) => p.thinking === null && p.signature === null && p.type === null)).toBe(true)
})

test("a streamed chat completion passes the signature over and still ends", async () => {
  globalThis.fetch = async () => reply()
  const res = await _internal.complete(ctx, { model: "claude-opus-5-5", stream: true, messages: [{ role: "user", content: "hi" }] })
  const lines = (await res.text()).split("\n").filter((l) => l.startsWith("data: "))
  expect(lines[lines.length - 1]).toBe("data: [DONE]")
  expect(lines.some((l) => l.includes(SIG.slice(0, 20)))).toBe(false)
})
