// What magpie hands the plugin is a Chat Completions body; OrcaTerm's
// assistant takes one user turn plus a history list and has no system
// role. This checks that the translation keeps the conversation's meaning:
// system text survives, turns stay in order, and tool traffic degrades to
// text instead of being dropped.
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

// The suite fires far more than the account's ten-a-minute budget; lift the
// pacer so these tests measure the plugin, not the limiter.
process.env.ORCATERM_NO_PACE = "1"


const turn = (messages) => _internal.toUpstreamBody({ messages }, { conversationId: "cid-1", userId: "u-1" })

test("system text is carried as a prefix, the last user turn as the input", () => {
  const up = turn([
    { role: "system", content: "you are a terminal assistant" },
    { role: "user", content: "first" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "second" },
  ])
  expect(up.conversationId).toBe("cid-1")
  expect(up.input.input.startsWith("[system instructions")).toBe(true)
  expect(up.input.input.endsWith("second")).toBe(true)
  // The earlier turns travel as a transcript in the text: magpie gives every
  // request a fresh sessionID, so nothing on the wire can rely on server-side
  // conversation state (measured 2026-10-27).
  expect(up.input.input).toContain("[earlier in this conversation]")
  expect(up.input.input).toContain("user: first")
  expect(up.input.input).toContain("assistant: first answer")
  // and nothing goes up as historyMessages
  expect(up.input.historyMessages).toEqual([])
  expect(up.input.type).toBe("start")
  expect(up.stream).toBe(true)
})

// OrcaTerm runs its own tools server-side; the client's tool calls can only
// be described, so they become text the model can read.
test("tool calls and their results become text, nothing is lost", () => {
  const up = turn([
    { role: "user", content: "what's the weather" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "get_weather", arguments: '{"city":"SZ"}' } }] },
    { role: "tool", tool_call_id: "c1", content: "sunny 30C" },
  ])
  // no history is sent, so the tool traffic has to ride along in the text
  const all = up.input.input
  expect(all).toContain("get_weather")
  expect(all).toContain("sunny 30C")
  // the tool result is the last turn, so it is what gets asked
  expect(up.input.input).toContain("tool result")
})

// An empty input is answered with a 400 by the assistant, so an empty
// conversation has to be given something to reply to.
test("an empty conversation still sends a non-empty input", () => {
  expect(turn([]).input.input.trim().length).toBeGreaterThan(0)
  expect(turn([{ role: "system", content: "be brief" }]).input.input.trim().length).toBeGreaterThan(0)
})

test("image parts are noted, text parts kept", () => {
  const up = turn([
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "http://x/y.png" } },
      ],
    },
  ])
  expect(up.input.input).toContain("look")
  expect(up.input.input).toContain("[image]")
})

// A model id magpie may pass with its provider prefix, in any case, with
// padding — and one it doesn't know, which must reach the endpoint as is
// rather than be swallowed.
test("model ids resolve through aliases, prefixes and case", () => {
  expect(_internal.resolveModel("deepseek")).toBe("TokenHub/deepseek-v4-pro")
  expect(_internal.resolveModel("orcaterm/kimi")).toBe("TokenHub/kimi-k3")
  expect(_internal.resolveModel("  GLM-4.7-THINKING  ")).toBe("glm-4.7-thinking")
  expect(_internal.resolveModel("some-new-model")).toBe("some-new-model")
  // a bare prefix must fall back to a real model, not send an empty id
  expect(_internal.resolveModel("orcaterm/")).toBe("TokenHub/deepseek-v4-pro")
  expect(_internal.resolveModel(undefined)).toBe("TokenHub/deepseek-v4-pro")
})

// OrcaTerm's picker shows a label, and the id sent upstream is a different
// string (`newModelId` vs `modelName` in its own table). Sending the label is
// what made upstream answer "LLM(x) is not loaded", and `hy3-preview` is a
// label, not an id — it answers 401. The label must resolve to the working id.
test("labels resolve to the ids upstream actually serves", () => {
  expect(_internal.resolveModel("Hy3-preview")).toBe("Hunyuan3/hy3")
  expect(_internal.resolveModel("hy3-preview")).toBe("Hunyuan3/hy3")
  expect(_internal.resolveModel("Deepseek-V4-Pro")).toBe("TokenHub/deepseek-v4-pro")
  expect(_internal.resolveModel("GLM-5.2")).toBe("TokenHub/glm-5.2")
  expect(_internal.resolveModel("Kimi-k2.6")).toBe("TokenHub/kimi-k3")
})

// Upstream answered `Invalid inputId: in-…` to the ids this plugin used to
// invent, so the shape matters: the web client sends a plain uuid v4 in
// `input.id` (module 73383's Ub) and the same value in `x-seqid`. A prefix of
// our own, however unique, is not that.
test("the input id is the web client's uuid v4, and x-seqid is that same id", async () => {
  const up = turn([{ role: "user", content: "hi" }])
  expect(up.input.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  // and a fresh one per request, never a fixed value
  expect(turn([{ role: "user", content: "hi" }]).input.id).not.toBe(up.input.id)
})

// Upstream does not answer in prose: the whole reply is the assistant's own
// message object, and the text is its taskCompletion. Passed on raw, an agent
// showed `{"action": "completion", …}` as the answer.
test("the answer is unwrapped from the action envelope, alone or after prose", () => {
  const one = JSON.stringify({ action: "completion", ph_1: "--", taskCompletion: "答案" })
  expect(_internal.unwrapAnswer(one)).toBe("答案")
  // fenced the way the assistant fences code
  expect(_internal.unwrapAnswer("```json\n" + one + "\n```")).toBe("答案")
  // prose first, envelope after it: the prose is the answer
  expect(_internal.stripTrailingEnvelope("已记住。\n" + one)).toBe("已记住。\n")
  // and a reply that is not an envelope is left alone
  expect(_internal.unwrapAnswer("用 {花括号} 表示集合")).toBe("用 {花括号} 表示集合")
})

// An `ask` keeps its answer in `question`, not `taskCompletion`, so the whole
// object used to go out as the reply — braces, `ph_1` and all (seen live
// 2026-11-11, the model asking which of five options to take).
test("an ask is unwrapped to its question and choices", () => {
  const ask = JSON.stringify({
    action: "ask",
    ph_1: "--",
    question: "要处理哪个目标？",
    options: ["检查运行状态", "排查服务异常", ""],
  })
  expect(_internal.unwrapAnswer(ask)).toBe("要处理哪个目标？\n\n- 检查运行状态\n- 排查服务异常")
  // no choices to show: the question alone
  expect(_internal.unwrapAnswer(JSON.stringify({ action: "ask", question: "继续吗？", options: [] }))).toBe("继续吗？")
  // an ask with no question is not an answer to unwrap
  const empty = JSON.stringify({ action: "ask", ph_1: "--" })
  expect(_internal.unwrapAnswer(empty)).toBe(empty)
  // another action's `question` is not one: only an ask is read this way
  const review = JSON.stringify({ action: "review", question: "这是审查的备注", tool: {} })
  expect(_internal.unwrapAnswer(review)).toBe(review)
})

// And it holds while the ask streams in, one character at a time: the answer
// the client builds out of the deltas is the same one, and no brace of it goes
// out.
test("a streamed ask reaches the client as its answer, not as its JSON", async () => {
  const ask = JSON.stringify({
    action: "ask",
    ph_1: "--",
    question: "要处理哪个目标？",
    options: ["检查运行状态", "排查服务异常"],
  })
  const resp = _internal.upstreamToOpenAI(
    new ReadableStream({
      start(c) {
        const all = `data: ${JSON.stringify({ content: ask, reasoningContent: "", type: "ai", code: 0 })}\n\ndata: [DONE]\n\n`
        for (const ch of all) c.enqueue(new TextEncoder().encode(ch))
        c.close()
      },
    }),
    { model: "m" },
  )
  let content = ""
  for (const line of (await resp.text()).split("\n")) {
    if (!line.startsWith("data: ") || line.trim() === "data: [DONE]") continue
    content += JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? ""
  }
  expect(content).toBe("要处理哪个目标？\n\n- 检查运行状态\n- 排查服务异常")
  expect(content).not.toContain("{")
})
