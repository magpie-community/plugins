// A Go reply Command Code stops sending before its finish line (#91): a
// streamed one that said something ends cut short, with a note, instead of
// failing the turn; one that said nothing, or a non-streamed one, is a 502.
import { afterEach, expect, test } from "bun:test"
import { CommandCodePlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  _internal.subsSeen.clear()
})

const NOTE = "(The reply was cut short: Command Code closed the stream before it finished. Ask again to go on.)"

async function ask(lines, stream) {
  globalThis.fetch = async (url) => {
    if (new URL(String(url)).pathname === "/alpha/generate") return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
    return new Response("", { status: 404 })
  }
  const hooks = await CommandCodePlugin()
  const opts = await hooks.auth.loader(async () => ({ type: "api", key: "go-key", metadata: { plan: "Go" } }))
  const res = await opts.fetch("https://api.commandcode.ai/provider/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "deepseek/deepseek-v4-pro", stream, messages: [{ role: "user", content: "hi" }] }),
  })
  return { status: res.status, text: await res.text() }
}

const frames = (text) =>
  text.split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => (f === "data: [DONE]" ? "[DONE]" : JSON.parse(f.slice(6))))

test("a streamed reply cut short after its text ends with the note, a stop and [DONE]", async () => {
  const r = await ask([{ type: "reasoning-delta", text: "thinking" }, { type: "text-delta", text: "Half an ans" }], true)
  expect(r.status).toBe(200)
  const f = frames(r.text)
  expect(f.at(-1)).toBe("[DONE]")
  expect(f.some((x) => x.error)).toBe(false)
  expect(f.map((x) => x.choices?.[0]?.delta?.content ?? "").join("")).toBe("Half an ans\n\n" + NOTE)
  expect(f.at(-2).choices[0].finish_reason).toBe("stop")
})

test("a streamed reply cut short after a whole tool call finishes as tool_calls", async () => {
  const r = await ask([{ type: "tool-call", toolCallId: "c1", toolName: "read", input: { path: "a" } }], true)
  const f = frames(r.text)
  expect(f.at(-1)).toBe("[DONE]")
  expect(f.at(-2).choices[0].finish_reason).toBe("tool_calls")
  expect(f.flatMap((x) => x.choices?.[0]?.delta?.tool_calls ?? []).map((c) => c.function.name)).toEqual(["read"])
})

test("a reply cut short with only reasoning says the note without a blank line before it", async () => {
  const f = frames((await ask([{ type: "reasoning-delta", text: "hm" }], true)).text)
  expect(f.map((x) => x.choices?.[0]?.delta?.content ?? "").join("")).toBe(NOTE)
})

test("a reply cut short before saying anything, or not streamed, is still a 502", async () => {
  const none = await ask([{ type: "start" }], true)
  expect(none.status).toBe(502)
  const whole = await ask([{ type: "text-delta", text: "Half" }], false)
  expect(whole.status).toBe(502)
  expect(JSON.parse(whole.text).error.message).toBe("the reply ended before it was complete")
})
