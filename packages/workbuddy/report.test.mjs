// WorkBuddy AI's client reports each chat on /v2/report (plugins#691); the
// plugin sends the same reports for the user's own chats, once the reply
// has been read to its end. Nothing leaves the machine.
import { afterEach, expect, test } from "bun:test"
import { WorkBuddyAIAuthPlugin, WorkBuddyAuthPlugin, _internal } from "./index.mjs"

const { replyFacts, stepOf } = _internal
const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const SSE_STOP = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":120,"completion_tokens":8,"total_tokens":128,"prompt_tokens_details":{"cached_tokens":100}}}\n\ndata: [DONE]\n\n'
const SSE_TOOLS = 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":50,"completion_tokens":5,"total_tokens":55}}\n\ndata: [DONE]\n\n'

async function chatThrough(plugin, body, reply, { read = true, status = 200, source } = {}) {
  const sent = []
  const reports = []
  let done
  const all = new Promise((r) => (done = r))
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.endsWith("/v2/report")) {
      reports.push({ url: u, headers: new Headers(init.headers), body: JSON.parse(init.body) })
      if (reports.length === 3 || reports.some((r) => r.body.some((e) => e.eventCode === "chat_response_complete")) || (reports.length === 2 && !reports[1].body.some((e) => e.eventCode === "chat_request_response"))) done()
      return Response.json({ code: 0, msg: "OK" })
    }
    sent.push(u)
    return new Response(reply, { status, headers: { "content-type": "text/event-stream" } })
  }
  const hooks = await plugin({ client: {} })
  const auth = source === "key" ? { type: "api", key: "sk-test" } : { type: "oauth", access: "tok", uid: "u1", name: "小明", expires: Date.now() + 3600_000 }
  const l = await hooks.auth.loader(async () => auth)
  const res = await l.fetch("https://www.workbuddy.ai/v2/chat/completions", { method: "POST", headers: new Headers(), body: JSON.stringify(body) })
  if (read) await res.text()
  await Promise.race([all, new Promise((r) => setTimeout(r, 300))])
  return { res, sent, reports }
}

const send = { model: "glm-5.3", stream: true, messages: [{ role: "system", content: "s" }, { role: "user", content: "你好呀" }] }
const call = { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] }

test("a user's send answered to its end is reported as the client reports it", async () => {
  const { reports } = await chatThrough(WorkBuddyAIAuthPlugin, send, SSE_STOP)
  expect(reports.map((r) => r.body.map((e) => e.eventCode))).toEqual([
    ["chat_message_send"],
    ["chat_request_send", "chat_message_response", "chat_message_status", "chat_request_response"],
    ["agent_task_completed", "chat_response_complete"],
  ])
  const [first, second] = reports
  expect(first.url).toBe("https://www.workbuddy.ai/v2/report")
  expect(first.headers.get("authorization")).toBe("Bearer tok")
  expect(first.headers.get("x-user-id")).toBe("u1")
  expect(first.headers.get("x-product")).toBe("SaaS")
  const msg = first.body[0]
  expect(msg.userId).toBe("u1")
  expect(msg.username).toBe("小明")
  expect(msg.machineId).toMatch(/^[0-9a-f]{64}$/)
  expect(msg.conversationId).toMatch(/^[0-9a-f]{32}$/)
  const req = second.body[0]
  expect(req.inputLength).toBe(3)
  expect(req.requestModelId).toBe("glm-5.3")
  const resp = second.body[1]
  expect([resp.inputToken, resp.outputToken, resp.totalToken, resp.cachedTokens]).toEqual([120, 8, 128, 100])
  expect(resp.finishReason).toBe("stop")
  // one conversation, one turn across every event
  const all = reports.flatMap((r) => r.body)
  expect(new Set(all.filter((e) => e.conversationId).map((e) => e.conversationId)).size).toBe(1)
})

test("a step that ends in tool calls reports its message only", async () => {
  const { reports } = await chatThrough(WorkBuddyAIAuthPlugin, { ...send, messages: [...send.messages, call, { role: "tool", tool_call_id: "c1", content: "x" }] }, SSE_TOOLS)
  expect(reports.map((r) => r.body.map((e) => e.eventCode))).toEqual([["chat_message_send"], ["chat_message_response", "chat_message_status"]])
})

test("nothing is reported for a reply not read to its end, a refusal, the China build or a key", async () => {
  expect((await chatThrough(WorkBuddyAIAuthPlugin, send, SSE_STOP, { read: false })).reports).toEqual([])
  expect((await chatThrough(WorkBuddyAIAuthPlugin, send, '{"error":{"message":"no"}}', { status: 400 })).reports).toEqual([])
  expect((await chatThrough(WorkBuddyAuthPlugin, send, SSE_STOP)).reports).toEqual([])
  expect((await chatThrough(WorkBuddyAIAuthPlugin, send, SSE_STOP, { source: "key" })).reports).toEqual([])
})

test("the reply passes through unchanged", async () => {
  const { res } = await chatThrough(WorkBuddyAIAuthPlugin, send, SSE_STOP, { read: false })
  expect(await res.text()).toBe(SSE_STOP)
})

test("replyFacts reads the last usage and finish reason; stepOf counts the turn's steps", () => {
  expect(replyFacts('{"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}')).toEqual({ finish: "stop", input: 3, output: 2, total: 5, cached: 0 })
  expect(replyFacts("")).toEqual({ finish: "", input: 0, output: 0, total: 0, cached: 0 })
  const s = stepOf({ model: "m", messages: [{ role: "user", content: "ab" }, call, { role: "tool", content: "x" }, call, { role: "tool", content: "y" }] })
  expect(s).toMatchObject({ model: "m", input: 2, userSend: false, step: 3, toolCalls: 2 })
  expect(stepOf(send).userSend).toBe(true)
})
