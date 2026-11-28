import { test } from "node:test"
import assert from "node:assert/strict"
import { sse, completion } from "./openai.mjs"

const readAll = async (res) => {
  const t = await new Response(res.body).text()
  return t.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).filter((x) => x !== "[DONE]").map((x) => JSON.parse(x))
}

test("流式中途读不出调用：以 error 事件结束，不发 finish_reason", async () => {
  const text = '我来查：\n{"name":"bash","arguments":{"command":"ls -la ~/Des'
  const ask = async (onUpdate) => { onUpdate({ text }); return { text, reasoning: "" } }
  const events = await readAll(await sse({ id: "x", model: "m", ask, newId: () => "c", promptTokens: () => 1, toolNames: ["bash"] }))
  assert.ok(events.some((e) => e.error?.type === "seu_unreadable_call"), "有 error 事件")
  assert.ok(!events.some((e) => e.choices?.[0]?.finish_reason === "stop"), "没有 finish_reason: stop")
})

test("非流式读不出调用：抛 502 seu_unreadable_call", async () => {
  const text = '{"name":"bash","arguments":{"command":"ls'
  assert.throws(
    () => completion({ id: "x", model: "m", final: { text }, promptTokens: 1, newId: () => "c", toolNames: ["bash"] }),
    (e) => e.code === "seu_unreadable_call" && e.status === 502,
  )
})

test("读得出时行为不变：有 tool_calls 且 finish_reason 为 tool_calls", async () => {
  const text = '{"name":"bash","arguments":{"command":"ls"}}'
  const ask = async () => ({ text, reasoning: "" })
  const events = await readAll(await sse({ id: "x", model: "m", ask, newId: () => "c", promptTokens: () => 1, toolNames: ["bash"] }))
  assert.ok(events.some((e) => e.choices?.[0]?.finish_reason === "tool_calls"))
})
