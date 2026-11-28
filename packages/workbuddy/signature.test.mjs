// WorkBuddy's reasoning signature on chat completions (extra_fields), and
// what a Messages request for a model WorkBuddy serves on chat alone is told.
//
// The shape is WorkBuddy's own client's (WorkBuddy 5.5.6 and WorkBuddy AI
// 5.6.2, app.asar): a streamed delta's extra_fields are merged one level deep
// (mergeExtraFields) and go back next turn on the assistant message, beside
// `reasoning`. The server's own types, read off its errors on 2026-11-27
// (www.workbuddy.ai): messages[].extra_fields is a v2.ExtraFields,
// .reasoning_detail a v2.ReasoningDetail whose content_signature and text
// are strings, ._meta a v2.Meta. The chunks below are a real hy4-flash-free
// tool turn's envelope from that day, with extra_fields filled in as those
// types have it (the account could reach no model that signs).
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { unz } from "./testdata/unz.mjs"

let WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin, _internal
beforeAll(async () => {
  // the loader tests sign in: no real sign-in may be read
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin, _internal } = await import("./index.mjs"))
})
const offline = async () => {
  throw new Error("no network in tests")
}
const real = globalThis.fetch
globalThis.fetch = offline
afterAll(() => (globalThis.fetch = real))
afterEach(() => {
  globalThis.fetch = offline
  _internal.renewing.clear()
  _internal.renewed.clear()
})

const later = () => Date.now() + 340 * 86400_000
const signedIn = (over = {}) => ({ type: "oauth", access: "tok", refresh: "r1", expires: later(), refreshExpiresAt: later(), uid: "u1", domain: "www.workbuddy.cn", ...over })
const CHAT = "https://copilot.tencent.com/v2/chat/completions"
const MSGS = "https://copilot.tencent.com/v1/messages"

// a real chunk's envelope: WorkBuddy sends every field, empty or null
const signedChunk = (delta, finish = "", usage = null) =>
  "data: " +
  JSON.stringify({
    id: "27ba333332b2c623cf38591b7fd309d2",
    model: "claude-sig-test",
    object: "chat.completion.chunk",
    created: 1795790540,
    choices: [{ index: 0, delta: { content: "", reasoning_content: "", function_call: null, refusal: "", tool_calls: [], extra_fields: null, ...delta }, logprobs: null, finish_reason: finish }],
    usage,
  })
const SIGNATURE = "EqQBCkgIBxABGAIiQE1sZ2Fq"
// a tool turn: reasoning, then the call, the signature on the last chunk
// and _meta on another, as the client merges them from any chunk
function toolTurn(id = "chatcmpl-tool-975f112576539c10", sig = SIGNATURE, signed = true) {
  const chunk = (delta, ...rest) => {
    if (!signed) delete delta.extra_fields
    return signedChunk(delta, ...rest)
  }
  return [
    ": heartbeat\n" + chunk({ role: "assistant" }),
    chunk({ reasoning_content: "The user wants Paris." }),
    chunk({ reasoning_content: " I will call get_weather.", extra_fields: { reasoning_detail: { text: "The user wants Paris. I will call get_weather." } } }),
    chunk({ tool_calls: [{ id, type: "function", function: { name: "get_weather", arguments: "" }, index: 0 }] }),
    chunk({ tool_calls: [{ function: { name: "", arguments: '{"city": "Paris"}' }, index: 0 }], extra_fields: { _meta: { trace_id: "t1" } } }),
    chunk({ role: "assistant", function_call: { name: "", arguments: "" }, extra_fields: { reasoning_detail: { content_signature: sig } } }, "tool_calls", { prompt_tokens: 230, completion_tokens: 222, total_tokens: 452 }),
    "data: [DONE]",
    "",
  ].join("\n\n")
}
const MERGED = { reasoning_detail: { text: "The user wants Paris. I will call get_weather.", content_signature: SIGNATURE }, _meta: { trace_id: "t1" } }
const REASONING = "The user wants Paris. I will call get_weather."

// a turn that only says something, signed
const chunk = signedChunk
const textTurn = (text, sig) =>
  [chunk({ role: "assistant" }), chunk({ reasoning_content: "Say hi." }), chunk({ content: text }), chunk({ extra_fields: { reasoning_detail: { content_signature: sig } } }, "stop"), "data: [DONE]", ""].join("\n\n")

const TOOLS = [{ type: "function", function: { name: "get_weather", description: "Get the weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }]
const USER = { role: "user", content: "What's the weather in Paris right now? Use the tool." }
// what OpenCode sends back: the call, its reasoning as reasoning_content (or
// none), never extra_fields, which its SDK never kept
const call = (over = {}) => ({ role: "assistant", content: "", tool_calls: [{ id: "chatcmpl-tool-975f112576539c10", type: "function", function: { name: "get_weather", arguments: '{"city": "Paris"}' } }], ...over })
const RESULT = { role: "tool", tool_call_id: "chatcmpl-tool-975f112576539c10", content: '{"temp_c": 12}' }
const turn1 = (model = "claude-sig-test") => JSON.stringify({ model, stream: true, messages: [USER], tools: TOOLS })
const turn2 = (model = "claude-sig-test", asst = call()) => JSON.stringify({ model, stream: true, messages: [USER, asst, RESULT], tools: TOOLS })

// serve answers every chat with the next of replies (an SSE body, or a
// Response), and keeps what was sent
function serve(replies) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url instanceof Request ? url.url : url))
    // the config, credits and reports the loader may ask for besides
    if (!/\/(chat\/completions|messages)$/.test(u.pathname)) return new Response(JSON.stringify({ code: 0, data: {} }), { headers: { "content-type": "application/json" } })
    calls.push({ path: u.pathname, body: unz(init?.body) })
    const r = replies.shift() ?? toolTurn()
    if (r instanceof Response) return r
    return new Response(r, { headers: { "content-type": "text/event-stream" } })
  }
  return calls
}

async function loader({ plugin = WorkBuddyAuthPlugin, auth = signedIn() } = {}) {
  const hooks = await plugin({ client: { auth: { set: async () => {} } } })
  return hooks.auth.loader(async () => auth)
}

async function send(opts, body, session = "sess-sig", url = CHAT) {
  const headers = { "content-type": "application/json" }
  if (session) headers[_internal.SESSION] = session
  const res = await opts.fetch(url, { method: "POST", headers, body })
  return { res, text: await res.text() }
}

const sentAssistant = (c) => JSON.parse(c.body).messages.find((m) => m.role === "assistant")

test("the merge is WorkBuddy's client's: one level deep, anything else replaced", () => {
  const m = _internal.mergeExtraFields
  expect(m(undefined, null)).toBeUndefined()
  expect(m({ a: 1 }, null)).toEqual({ a: 1 })
  expect(m(undefined, {})).toBeUndefined()
  expect(m({ reasoning_detail: { text: "t" }, _meta: { x: 1 } }, { reasoning_detail: { content_signature: "s" }, _meta: "y" })).toEqual({ reasoning_detail: { text: "t", content_signature: "s" }, _meta: "y" })
  // two levels down is replaced, not merged
  expect(m({ a: { b: { c: 1 } } }, { a: { b: { d: 2 } } })).toEqual({ a: { b: { d: 2 } } })
})

test("a tool turn's signature goes back on that turn, with its reasoning, as WorkBuddy's client sends it", async () => {
  const calls = serve([toolTurn(), toolTurn("chatcmpl-tool-next")])
  const opts = await loader()
  const first = await send(opts, turn1())
  // the client still gets the reply's extra_fields, as before
  expect(first.text).toContain(SIGNATURE)
  await send(opts, turn2())
  const a = sentAssistant(calls[1])
  expect(a.extra_fields).toEqual(MERGED)
  expect(a.reasoning).toBe(REASONING)
  expect(a.reasoning_content).toBeUndefined()
  expect(a.tool_calls[0].id).toBe("chatcmpl-tool-975f112576539c10")
})

test("the reasoning the client sent back is kept, and the signature set beside it", async () => {
  const calls = serve([toolTurn(), toolTurn("chatcmpl-tool-next")])
  const opts = await loader()
  await send(opts, turn1())
  await send(opts, turn2("claude-sig-test", call({ reasoning_content: "the client's own words" })))
  const a = sentAssistant(calls[1])
  expect(a.extra_fields).toEqual(MERGED)
  expect(a.reasoning).toBe("the client's own words")
})

test("a message that carries its own extra_fields goes as it is", async () => {
  const calls = serve([toolTurn(), toolTurn("chatcmpl-tool-next")])
  const opts = await loader()
  await send(opts, turn1())
  const own = { reasoning_detail: { content_signature: "the client's" } }
  await send(opts, turn2("claude-sig-test", call({ extra_fields: own })))
  expect(sentAssistant(calls[1]).extra_fields).toEqual(own)
})

test("kept apart by conversation, account and model", async () => {
  // another session
  let calls = serve([toolTurn(), toolTurn("x")])
  let opts = await loader()
  await send(opts, turn1(), "sess-a")
  await send(opts, turn2(), "sess-b")
  expect(sentAssistant(calls[1]).extra_fields).toBeUndefined()
  // another model
  calls = serve([toolTurn(), toolTurn("x")])
  await send(opts, turn1("claude-sig-test"), "sess-c")
  await send(opts, turn2("claude-sig-other"), "sess-c")
  expect(sentAssistant(calls[1]).extra_fields).toBeUndefined()
  // another account, same session
  calls = serve([toolTurn(), toolTurn("x")])
  await send(opts, turn1(), "sess-d")
  opts = await loader({ auth: signedIn({ uid: "u2" }) })
  await send(opts, turn2(), "sess-d")
  expect(sentAssistant(calls[1]).extra_fields).toBeUndefined()
  // and the same three again: found
  calls = serve([toolTurn("x")])
  opts = await loader()
  await send(opts, turn2(), "sess-c")
  expect(sentAssistant(calls[0]).extra_fields).toEqual(MERGED)
})

test("with no session, the conversation is its first user message", async () => {
  const calls = serve([toolTurn(), toolTurn("x")])
  const opts = await loader()
  await send(opts, turn1(), "")
  await send(opts, turn2(), "")
  expect(sentAssistant(calls[1]).extra_fields).toEqual(MERGED)
})

test("a turn without tool calls is found by its text", async () => {
  const calls = serve([textTurn("Hi there.", "sig-text"), textTurn("Bye.", "sig-2")])
  const opts = await loader()
  await send(opts, JSON.stringify({ model: "claude-sig-test", stream: true, messages: [{ role: "user", content: "hi" }] }), "sess-text")
  await send(
    opts,
    JSON.stringify({ model: "claude-sig-test", stream: true, messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "text", text: "Hi there." }] }, { role: "user", content: "bye" }] }),
    "sess-text",
  )
  const a = sentAssistant(calls[1])
  expect(a.extra_fields).toEqual({ reasoning_detail: { content_signature: "sig-text" } })
  expect(a.reasoning).toBe("Say hi.")
})

test("a JSON answer's message is read for it too", async () => {
  const msg = { role: "assistant", content: "", reasoning_content: "r", tool_calls: [{ id: "call-json", type: "function", function: { name: "get_weather", arguments: "{}" } }], extra_fields: { reasoning_detail: { content_signature: "sig-json" } } }
  const json = new Response(JSON.stringify({ id: "x", object: "chat.completion", choices: [{ index: 0, message: msg, finish_reason: "tool_calls" }] }), { headers: { "content-type": "application/json" } })
  const calls = serve([json, toolTurn("x")])
  const opts = await loader()
  const first = await send(opts, JSON.stringify({ model: "claude-sig-test", messages: [USER], tools: TOOLS }), "sess-json")
  expect(JSON.parse(first.text).choices[0].message.extra_fields.reasoning_detail.content_signature).toBe("sig-json")
  const asst = { role: "assistant", content: "", tool_calls: msg.tool_calls }
  await send(opts, JSON.stringify({ model: "claude-sig-test", messages: [USER, asst, { role: "tool", tool_call_id: "call-json", content: "{}" }], tools: TOOLS }), "sess-json")
  expect(sentAssistant(calls[1]).extra_fields).toEqual({ reasoning_detail: { content_signature: "sig-json" } })
  expect(sentAssistant(calls[1]).reasoning).toBe("r")
})

test("a model that signs nothing (extra_fields null throughout) is sent as before", async () => {
  // the real hy4-flash-free turn: every extra_fields null
  const unsigned = toolTurn(undefined, undefined, false)
  expect(unsigned).not.toContain(SIGNATURE)
  const calls = serve([unsigned, unsigned])
  const opts = await loader()
  await send(opts, turn1("hy4-flash-free"), "sess-free")
  await send(opts, turn2("hy4-flash-free"), "sess-free")
  expect(sentAssistant(calls[1]).extra_fields).toBeUndefined()
  expect(calls[1].body).not.toContain("extra_fields")
})

test("a kept signature WorkBuddy turns away goes no more: the chat is sent again without it", async () => {
  const refused = new Response(JSON.stringify({ error: { code: "400001", internal_code: "11159", message: "Invalid `signature` in `thinking` block" } }), { status: 400, headers: { "content-type": "application/json" } })
  const calls = serve([toolTurn(), refused, toolTurn("x")])
  const opts = await loader()
  await send(opts, turn1(), "sess-bad")
  const { res } = await send(opts, turn2(), "sess-bad")
  expect(res.status).toBe(200)
  expect(calls.length).toBe(3)
  expect(sentAssistant(calls[1]).extra_fields).toEqual(MERGED)
  expect(sentAssistant(calls[2]).extra_fields).toBeUndefined()
})

test("WorkBuddy AI keeps them the same way", async () => {
  const calls = serve([toolTurn(), toolTurn("x")])
  const opts = await loader({ plugin: WorkBuddyAIAuthPlugin, auth: signedIn({ domain: "www.workbuddy.ai" }) })
  await send(opts, turn1(), "sess-ai", "https://www.workbuddy.ai/v2/chat/completions")
  await send(opts, turn2(), "sess-ai", "https://www.workbuddy.ai/v2/chat/completions")
  expect(sentAssistant(calls[1]).extra_fields).toEqual(MERGED)
})

// ---- a Messages request for a model served on chat alone -------------------------

test("a model WorkBuddy serves on chat alone, asked on Messages, is told to go on chat", async () => {
  // the China build's answer to gpt-5.5 on /v1/messages was a 400, glm-5.3's a 500
  const body = (model) => JSON.stringify({ model, max_tokens: 64, messages: [{ role: "user", content: "hi" }] })
  for (const [model, status] of [["gpt-5.5", 400], ["glm-5.3", 500]]) {
    serve([new Response(JSON.stringify({ code: 11101, msg: "model not supported" }), { status, headers: { "content-type": "application/json" } })])
    const { res, text } = await send(await loader(), body(model), "s", MSGS)
    expect(res.status).toBe(400)
    const e = JSON.parse(text).error
    expect(e.type).toBe("invalid_request_error")
    expect(e.message).toStartWith("model not supported — ")
    expect(e.message).toContain(`serves ${model} on chat completions only`)
  }
  // a Claude model's failure there is its own, and goes as it came
  serve([new Response(JSON.stringify({ code: 11101, msg: "bad" }), { status: 400, headers: { "content-type": "application/json" } })])
  const claude = await send(await loader(), body("claude-opus-5.5"), "s", MSGS)
  expect(claude.res.status).toBe(400)
  expect(claude.text).toBe(JSON.stringify({ code: 11101, msg: "bad" }))
  // WorkBuddy AI has no Messages route: its 404 says the same
  serve([new Response("404 Route Not Found", { status: 404 })])
  const ai = await send(await loader({ plugin: WorkBuddyAIAuthPlugin, auth: signedIn({ domain: "www.workbuddy.ai" }) }), body("claude-opus-5.5"), "s", "https://www.workbuddy.ai/v1/messages")
  expect(ai.res.status).toBe(404)
  expect(JSON.parse(ai.text).error.message).toBe("404 Route Not Found — WorkBuddy AI serves claude-opus-5.5 on chat completions only, not on Anthropic's Messages API (/v1/messages): send it as a chat completions request (in OpenCode, the provider's OpenAI-compatible API), where its reasoning signature goes back too")
})

test("a chat's own failure gets no Messages hint", async () => {
  serve([new Response(JSON.stringify({ code: 11101, msg: "bad" }), { status: 400, headers: { "content-type": "application/json" } })])
  const { res, text } = await send(await loader(), turn1("gpt-5.5"), "s")
  expect(res.status).toBe(400)
  expect(text).not.toContain("chat completions only")
})
