// A streamed Chat Completions reply (xAI's, through Zed) that Zed breaks
// off before stream_ended (#91): one that said something ends cut short,
// with a note, instead of failing the turn. One that said nothing, one
// with a tool call begun, and Anthropic's and Responses' (which magpie's
// gateway goes on with itself) still fail.
import { afterEach, expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  _internal.tokens.clear()
})

const s = { userId: "4242", access: "plain-access", systemId: "", org: "org-me", plan: "zed_pro", who: "octo" }
const NOTE = "(The reply was cut short: Zed closed the stream before it finished. Ask again to go on.)"

async function ask(wire, lines, stream = true) {
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname
    if (path === "/client/llm_tokens") return Response.json({ token: "llm-token" })
    if (path === "/completions")
      return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { headers: { "x-zed-server-supports-status-messages": "true" } })
    return new Response("", { status: 404 })
  }
  const url = wire === "chat" ? "https://cloud.zed.dev/v1/chat/completions" : "https://cloud.zed.dev/v1/messages"
  const res = await _internal.complete(s, url, {
    method: "POST",
    body: JSON.stringify({ model: wire === "chat" ? "grok-4.7" : "claude-sonnet-5", stream, messages: [{ role: "user", content: "hi" }], max_tokens: 100 }),
  })
  return { status: res.status, text: await res.text() }
}

const frames = (text) =>
  text.split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => (f === "data: [DONE]" ? "[DONE]" : JSON.parse(f.slice(6))))
const chunk = (delta, finish_reason = null, index = 0) => ({ event: { id: "c1", object: "chat.completion.chunk", created: 1, model: "grok-4.7", choices: [{ index, delta, finish_reason }] } })

test("a chat reply cut short after its text ends with the note, a stop and [DONE]", async () => {
  const r = await ask("chat", [{ status: "started" }, chunk({ role: "assistant", reasoning_content: "hm" }), chunk({ content: "Half an ans" })])
  expect(r.status).toBe(200)
  const f = frames(r.text)
  expect(f.some((x) => x.error)).toBe(false)
  expect(f.at(-1)).toBe("[DONE]")
  expect(f.at(-2)).toEqual({ id: "c1", object: "chat.completion.chunk", created: 1, model: "grok-4.7", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
  expect(f.map((x) => x.choices?.[0]?.delta?.content ?? "").join("")).toBe("Half an ans\n\n" + NOTE)
})

test("a chat reply that finished but lost its stream_ended only gets [DONE]", async () => {
  const f = frames((await ask("chat", [chunk({ content: "Done." }), chunk({}, "stop")])).text)
  expect(f.at(-1)).toBe("[DONE]")
  expect(f.map((x) => x.choices?.[0]?.delta?.content ?? "").join("")).toBe("Done.")
})

test("a chat reply cut short inside a tool call, or before saying anything, still fails", async () => {
  const tool = await ask("chat", [chunk({ content: "Let me look." }), chunk({ tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "read", arguments: '{"pa' } }] })])
  const f = frames(tool.text)
  expect(f.at(-1).error.message).toBe("the reply ended before it was complete")
  expect(f).not.toContain("[DONE]")
  const none = await ask("chat", [{ status: "started" }, chunk({ role: "assistant", content: "" })])
  expect(none.status).toBe(502)
})

test("an Anthropic reply cut short still fails, for magpie's gateway to go on with it", async () => {
  const start = { event: { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 0 } } } }
  const text = [{ event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } }, { event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } } }]
  const r = await ask("anthropic", [start, ...text])
  expect(r.text).toContain("event: error")
  expect(r.text).not.toContain("cut short")
})

test("a chat reply that isn't streamed and is cut short is a 502", async () => {
  const r = await ask("chat", [chunk({ content: "Half" })], false)
  expect(r.status).toBe(502)
})
