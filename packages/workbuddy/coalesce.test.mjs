// WorkBuddy streams reasoning as 1-4 character deltas. OpenCode stores each
// streamed delta as its own part and rewrites the whole message per part, so
// one long answer became thousands of parts and stalled the server (measured:
// 2,263 reasoning parts for 7,729 characters; message seq jumped 16,987 to
// 21,519). The fetch path now holds consecutive reasoning deltas and emits
// them as one event, which leaves the text unchanged and cuts the part count
// by orders of magnitude.
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { coalesced } = _internal

const enc = new TextEncoder()
const event = (value) => `data: ${JSON.stringify(value)}\n\n`
// WorkBuddy sends finish_reason: "" on every delta; only a named reason ends
// a block, so the coalescer must not treat the empty string as one.
const chunk = (delta, extra = {}) => ({
  id: "x",
  model: "m",
  choices: [{ index: 0, delta, finish_reason: "", ...extra }],
})

function streamOf(text, step = 7) {
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < text.length; i += step) controller.enqueue(enc.encode(text.slice(i, i + step)))
      controller.close()
    },
  })
}

async function collect(res) {
  const out = await coalesced(res).text()
  const events = out
    .split("\n\n")
    .filter(Boolean)
    .map((e) => e.replace(/^data:\s?/, ""))
    .filter((e) => e && e !== "[DONE]" && !e.startsWith(":"))
    .map((e) => JSON.parse(e))
  return { out, events }
}

const reasoningOf = (events) =>
  events.filter((v) => typeof v.choices?.[0]?.delta?.reasoning_content === "string" && v.choices[0].delta.reasoning_content)

test("many tiny reasoning deltas become one event, text unchanged", async () => {
  const thought = "我们需要回答中文一句话。问题：用一句话回答：2+2 等于几？ 答：2+2等于4。"
  let sse = ""
  for (const ch of thought) sse += event(chunk({ reasoning_content: ch }))
  sse += event(chunk({ content: "2+2等于4。" }))
  sse += event({ id: "x", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { total_tokens: 3 } })
  sse += "data: [DONE]\n\n"

  const { out, events } = await collect(new Response(streamOf(sse), { headers: { "content-type": "text/event-stream" } }))
  const reasoning = reasoningOf(events)
  expect(reasoning.map((v) => v.choices[0].delta.reasoning_content).join("")).toBe(thought)
  expect(reasoning.length).toBe(1)
  expect(events.some((v) => v.choices?.[0]?.delta?.content === "2+2等于4。")).toBe(true)
  expect(events.find((v) => v.choices?.[0]?.finish_reason === "stop")?.usage).toEqual({ total_tokens: 3 })
  expect(out).toContain("data: [DONE]")
})

test("a tool call closes one reasoning block and the next block is separate", async () => {
  let sse = ""
  for (const ch of "先查目录。") sse += event(chunk({ reasoning_content: ch }))
  sse += event(chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "ls", arguments: "{}" } }] }))
  for (const ch of "再看文件。") sse += event(chunk({ reasoning_content: ch }))
  sse += event(chunk({ content: "好了" }))
  sse += "data: [DONE]\n\n"

  const { events } = await collect(new Response(streamOf(sse, 5), { headers: { "content-type": "text/event-stream" } }))
  const reasoning = reasoningOf(events)
  expect(reasoning.length).toBe(2)
  expect(reasoning.map((v) => v.choices[0].delta.reasoning_content).join("")).toBe("先查目录。再看文件。")
})

test("a chunk carrying both reasoning and content keeps both", async () => {
  let sse = ""
  sse += event(chunk({ reasoning_content: "想" }))
  sse += event(chunk({ reasoning_content: "一下", content: "答案" }))
  sse += "data: [DONE]\n\n"

  const { events } = await collect(new Response(streamOf(sse, 3), { headers: { "content-type": "text/event-stream" } }))
  expect(reasoningOf(events).map((v) => v.choices[0].delta.reasoning_content).join("")).toBe("想一下")
  const text = events.filter((v) => typeof v.choices?.[0]?.delta?.content === "string" && v.choices[0].delta.content)
  expect(text.map((v) => v.choices[0].delta.content).join("")).toBe("答案")
})

test("the reasoning field is 'reasoning' when that is what WorkBuddy sends", async () => {
  let sse = ""
  for (const ch of "想一下") sse += event(chunk({ reasoning: ch }))
  sse += "data: [DONE]\n\n"
  const { events } = await collect(new Response(streamOf(sse, 4), { headers: { "content-type": "text/event-stream" } }))
  const reasoning = events.filter((v) => typeof v.choices?.[0]?.delta?.reasoning === "string" && v.choices[0].delta.reasoning)
  expect(reasoning.length).toBe(1)
  expect(reasoning[0].choices[0].delta.reasoning).toBe("想一下")
  expect(reasoning[0].choices[0].delta.reasoning_content).toBeUndefined()
})

test("a non-streaming response passes through untouched", async () => {
  const res = new Response('{"ok":true}', { headers: { "content-type": "application/json" } })
  expect(await coalesced(res).text()).toBe('{"ok":true}')
})