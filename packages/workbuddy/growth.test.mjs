// WorkBuddy AI's client sends, in a chat's own body, extra_vars.growthEvent:
// a JSON string of growth events holding a chat_request_send for the
// conversation, and initiator "user" (magpie-community/plugins#691). The
// China build's chats go as before. Nothing leaves the machine.
import { afterEach, expect, test } from "bun:test"
import { WorkBuddyAIAuthPlugin, WorkBuddyAuthPlugin, _internal } from "./index.mjs"
import { unz } from "./testdata/unz.mjs"

const { withGrowth, inputLengthOf, SITES } = _internal
const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

async function ask(body, { plugin = WorkBuddyAIAuthPlugin, url = "https://www.workbuddy.ai/v2/chat/completions" } = {}) {
  let sent
  globalThis.fetch = async (_url, init) => {
    sent = { headers: new Headers(init?.headers), body: JSON.parse(unz(init.body)) }
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  }
  const hooks = await plugin({ client: {} })
  const l = await hooks.auth.loader(async () => ({ type: "oauth", access: "tok", uid: "u1", expires: Date.now() + 3600_000 }))
  const res = await l.fetch(url, { method: "POST", body: JSON.stringify(body) })
  expect(res.status).toBe(200)
  return sent
}

const call = { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] }
const result = { role: "tool", tool_call_id: "c1", content: "a long tool result that is not the user's input" }

test("a WorkBuddy AI chat carries the client's chat_request_send growth event and initiator", async () => {
  const sent = await ask({
    model: "gpt-5.5",
    stream: true,
    messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hello" }, { role: "assistant", content: "hi" }, { role: "user", content: "跑一下测试" }],
  })
  const vars = sent.body.extra_vars
  expect(vars.initiator).toBe("user")
  expect(typeof vars.growthEvent).toBe("string")
  const events = JSON.parse(vars.growthEvent)
  expect(events).toEqual([{
    eventCode: "chat_request_send",
    id: sent.headers.get("x-conversation-id"),
    extra: { inputLength: 5, requestModelId: "gpt-5.5", requestModelName: "GPT-5.5", mode: "craft", command: "" },
  }])
  expect(events[0].id).toBeTruthy()
})

test("a tool step's event counts the user's message, not the tool's result", async () => {
  const sent = await ask({ model: "custom-x", stream: true, messages: [{ role: "user", content: [{ type: "text", text: "run" }, { type: "text", text: " it" }] }, call, result] })
  const [e] = JSON.parse(sent.body.extra_vars.growthEvent)
  expect(e.extra.inputLength).toBe(6)
  // a model the table doesn't name goes by its id
  expect(e.extra.requestModelName).toBe("custom-x")
})

test("the caller's extra_vars and events are kept", async () => {
  const own = { eventCode: "expert_actual_use", id: "e1" }
  const sent = await ask({ model: "gpt-5.5", stream: true, extra_vars: { a: 1, initiator: "agent", growthEvent: JSON.stringify([own]) }, messages: [{ role: "user", content: "hi" }] })
  const vars = sent.body.extra_vars
  expect(vars.a).toBe(1)
  expect(vars.initiator).toBe("agent")
  const events = JSON.parse(vars.growthEvent)
  expect(events[0]).toEqual(own)
  expect(events[1].eventCode).toBe("chat_request_send")
})

test("the China build's chat and a non-chat go without it", async () => {
  const cn = await ask({ model: "glm-5.3", stream: true, messages: [{ role: "user", content: "hi" }] }, { plugin: WorkBuddyAuthPlugin, url: "https://copilot.tencent.com/v2/chat/completions" })
  expect(cn.body.extra_vars).toBeUndefined()
  const chat = { model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }
  expect(withGrowth(SITES["workbuddy-ai"], chat, "")).toBe(false)
  expect(chat.extra_vars).toBeUndefined()
})

test("sent as another account, the event is that conversation's alone", () => {
  const chat = { model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }
  withGrowth(SITES["workbuddy-ai"], chat, "conv-a")
  withGrowth(SITES["workbuddy-ai"], chat, "conv-b", "conv-a")
  expect(JSON.parse(chat.extra_vars.growthEvent).map((e) => e.id)).toEqual(["conv-b"])
  expect(inputLengthOf([])).toBe(0)
})

test("a chat nothing else changes keeps its own bytes, the vars set before its closing brace", async () => {
  const body = `{"model": "gpt-5.5",  "stream": true, "messages": [{"role": "system", "content": "Be brief."}, {"role": "user", "content": "hi"}], "reasoning_effort": "low"}`
  let text
  globalThis.fetch = async (_url, init) => {
    text = unz(init.body)
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  }
  const hooks = await WorkBuddyAIAuthPlugin({ client: {} })
  const l = await hooks.auth.loader(async () => ({ type: "oauth", access: "tok", uid: "u1", expires: Date.now() + 3600_000 }))
  await l.fetch("https://www.workbuddy.ai/v2/chat/completions", { method: "POST", body })
  expect(text.startsWith(body.slice(0, -1) + ',"extra_vars":{"growthEvent":')).toBe(true)
  expect(JSON.parse(text).extra_vars.initiator).toBe("user")
})
