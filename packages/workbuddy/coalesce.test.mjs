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
const dec = new TextDecoder()
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

async function collect(res, flushMs) {
  const out = await (flushMs === undefined ? coalesced(res) : coalesced(res, flushMs)).text()
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

const textOf = (events) =>
  events.filter((v) => typeof v.choices?.[0]?.delta?.content === "string" && v.choices[0].delta.content)

const callsOf = (events) => events.flatMap((v) => v.choices?.[0]?.delta?.tool_calls ?? [])

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
  expect(textOf(events).map((v) => v.choices[0].delta.content).join("")).toBe("2+2等于4。")
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
  expect(callsOf(events)).toHaveLength(1)
})

test("the first reasoning chunk may carry content, and it is sent once", async () => {
  let sse = event(chunk({ role: "assistant", reasoning_content: "想", content: "答案" }))
  sse += "data: [DONE]\n\n"

  const { events } = await collect(new Response(streamOf(sse, 3), { headers: { "content-type": "text/event-stream" } }))
  expect(reasoningOf(events).map((v) => v.choices[0].delta.reasoning_content).join("")).toBe("想")
  expect(textOf(events).map((v) => v.choices[0].delta.content).join("")).toBe("答案")
  // the role goes out once, not once per emitted event
  expect(events.filter((v) => v.choices?.[0]?.delta?.role === "assistant")).toHaveLength(1)
})

test("the first reasoning chunk may carry a tool call, and it is sent once", async () => {
  let sse = event(
    chunk({ reasoning_content: "想", tool_calls: [{ index: 0, id: "c1", function: { name: "ls", arguments: "{}" } }] }),
  )
  sse += "data: [DONE]\n\n"

  const { events } = await collect(new Response(streamOf(sse, 3), { headers: { "content-type": "text/event-stream" } }))
  expect(reasoningOf(events).map((v) => v.choices[0].delta.reasoning_content).join("")).toBe("想")
  const calls = callsOf(events)
  expect(calls).toHaveLength(1)
  expect(calls[0].id).toBe("c1")
})

test("a chunk carrying both reasoning and content keeps both", async () => {
  let sse = ""
  sse += event(chunk({ reasoning_content: "想" }))
  sse += event(chunk({ reasoning_content: "一下", content: "答案" }))
  sse += "data: [DONE]\n\n"

  const { events } = await collect(new Response(streamOf(sse, 3), { headers: { "content-type": "text/event-stream" } }))
  expect(reasoningOf(events).map((v) => v.choices[0].delta.reasoning_content).join("")).toBe("想一下")
  expect(textOf(events).map((v) => v.choices[0].delta.content).join("")).toBe("答案")
})

test("a delta with an empty reasoning field does not drop other fields", async () => {
  let sse = event(chunk({ role: "assistant", reasoning_content: "" }))
  sse += event(chunk({ content: "hi" }))
  sse += "data: [DONE]\n\n"

  const { events } = await collect(new Response(streamOf(sse, 4), { headers: { "content-type": "text/event-stream" } }))
  expect(textOf(events).map((v) => v.choices[0].delta.content).join("")).toBe("hi")
  expect(events.some((v) => v.choices?.[0]?.delta?.role === "assistant")).toBe(true)
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

test("held reasoning goes out on the clock, so other clients stay live", async () => {
  let controller
  const body = new ReadableStream({
    start(c) {
      controller = c
      c.enqueue(enc.encode(event(chunk({ reasoning_content: "先" }))))
    },
  })
  const res = coalesced(new Response(body, { headers: { "content-type": "text/event-stream" } }), 20)
  const reader = res.body.getReader()

  const first = await reader.read()
  const firstText = dec.decode(first.value)
  expect(firstText).toContain('"reasoning_content":"先"')

  // nothing more until the clock passes the flush interval
  await new Promise((r) => setTimeout(r, 60))
  controller.enqueue(enc.encode(event(chunk({ reasoning_content: "后" }))))
  const second = await reader.read()
  expect(dec.decode(second.value)).toContain('"reasoning_content":"后"')

  controller.enqueue(enc.encode("data: [DONE]\n\n"))
  await reader.read()
  controller.close()
})
test("usage on the chunk that closes a reasoning block still reaches the client", async () => {
  let sse = event(chunk({ reasoning_content: "a" }))
  sse += event({ id: "x", model: "m", choices: [{ index: 0, delta: { reasoning_content: "b" }, finish_reason: "" }], usage: { total_tokens: 7 } })
  sse += "data: [DONE]\n\n"

  const { events } = await collect(new Response(streamOf(sse), { headers: { "content-type": "text/event-stream" } }))
  const withUsage = events.filter((v) => v.usage)
  expect(withUsage).toHaveLength(1)
  expect(withUsage[0].usage).toEqual({ total_tokens: 7 })
  expect(reasoningOf(events).map((v) => v.choices[0].delta.reasoning_content).join("")).toBe("ab")
})

test("a chunk with several choices is passed through whole", async () => {
  const sse =
    `data: ${JSON.stringify({ id: "x", model: "m", choices: [{ index: 0, delta: { reasoning_content: "r1" }, finish_reason: "" }, { index: 1, delta: { content: "c1" }, finish_reason: "" }] })}\n\n` +
    `data: ${JSON.stringify({ id: "x", model: "m", choices: [{ index: 0, delta: { reasoning_content: "r2" }, finish_reason: "" }, { index: 1, delta: { content: "c2" }, finish_reason: "" }] })}\n\n` +
    "data: [DONE]\n\n"
  const { events } = await collect(new Response(streamOf(sse), { headers: { "content-type": "text/event-stream" } }))
  const both = events.find((v) => v.choices?.length === 2)
  expect(both.choices[1].delta.content).toBe("c1")
  expect(both.choices[0].delta.reasoning_content).toBe("r1")
  // the event is forwarded as it arrived, not rebuilt from choice 0
  expect(both.choices[0].finish_reason).toBe("")
  expect(both.choices[1].finish_reason).toBe("")
  // the second chunk's choice 1 must survive too
  const second = events.filter((v) => v.choices?.length === 2)[1]
  expect(second.choices[1].delta.content).toBe("c2")
})

test("CR-only event separators keep every event", async () => {
  const sse =
    event(chunk({ reasoning_content: "a" })).replace(/\n/g, "\r") +
    event(chunk({ content: "C" }, { finish_reason: "stop" })).replace(/\n/g, "\r") +
    "data: [DONE]\r\r"
  const { events } = await collect(new Response(streamOf(sse, 5), { headers: { "content-type": "text/event-stream" } }))
  expect(reasoningOf(events).map((v) => v.choices[0].delta.reasoning_content).join("")).toBe("a")
  expect(textOf(events).map((v) => v.choices[0].delta.content).join("")).toBe("C")
  expect(events.some((v) => v.choices?.[0]?.finish_reason === "stop")).toBe(true)
})

test("the size cap flushes a long thought while the stream is still open", async () => {
  let controller
  const body = new ReadableStream({
    start(c) {
      controller = c
      for (let i = 0; i < 20000; i += 1000) c.enqueue(enc.encode(event(chunk({ reasoning_content: "字".repeat(1000) }))))
    },
  })
  // far longer than the test takes, so only the size cap can flush
  const res = coalesced(new Response(body, { headers: { "content-type": "text/event-stream" } }), 60000)
  const reader = res.body.getReader()
  const seen = []
  let text = ""
  while (seen.length < 2) {
    const r = await reader.read()
    if (r.done) break
    text += dec.decode(r.value)
    for (const part of text.split("\n\n")) {
      if (!part.startsWith("data: ")) continue
      const v = JSON.parse(part.slice(6))
      if (typeof v.choices?.[0]?.delta?.reasoning_content === "string") seen.push(v.choices[0].delta.reasoning_content)
    }
    text = ""
  }
  expect(seen.length).toBe(2)
  expect(seen[0].length).toBeGreaterThanOrEqual(8192)
  expect(seen[1].length).toBeGreaterThanOrEqual(8192)
  expect(seen[0].length + seen[1].length).toBe(18000)
  controller.close()
  await reader.cancel().catch(() => {})
})

test("a repeated usage on the closing chunk is sent once", async () => {
  const usage = { prompt_tokens: 10, completion_tokens: 9, total_tokens: 19 }
  let sse = event({ ...chunk({ reasoning_content: "a" }), usage })
  sse += event({ ...chunk({ content: "x", reasoning_content: "" }, { finish_reason: "stop" }), usage })
  sse += "data: [DONE]\n\n"
  const { events } = await collect(new Response(streamOf(sse), { headers: { "content-type": "text/event-stream" } }))
  expect(events.filter((v) => v.usage)).toHaveLength(1)
  expect(events.filter((v) => v.usage)[0].usage).toEqual(usage)
})

test("a newer usage on the closing chunk replaces the earlier one", async () => {
  let sse = event({ ...chunk({ reasoning_content: "a" }), usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })
  sse += event({ ...chunk({ content: "x", reasoning_content: "" }, { finish_reason: "stop" }), usage: { prompt_tokens: 10, completion_tokens: 9, total_tokens: 19 } })
  sse += "data: [DONE]\n\n"
  const { events } = await collect(new Response(streamOf(sse), { headers: { "content-type": "text/event-stream" } }))
  const last = events.filter((v) => v.usage).at(-1)
  expect(last.usage.total_tokens).toBe(19)
})

test("reasoning in 'reasoning' survives an empty reasoning_content beside it", async () => {
  let sse = event(chunk({ reasoning_content: "", reasoning: "think" }))
  sse += event(chunk({ content: "ans" }, { finish_reason: "stop" }))
  sse += "data: [DONE]\n\n"
  const { events } = await collect(new Response(streamOf(sse), { headers: { "content-type": "text/event-stream" } }))
  const reasoning = events.filter((v) => typeof v.choices?.[0]?.delta?.reasoning === "string" && v.choices[0].delta.reasoning)
  expect(reasoning.map((v) => v.choices[0].delta.reasoning).join("")).toBe("think")
  expect(textOf(events).map((v) => v.choices[0].delta.content).join("")).toBe("ans")
})
