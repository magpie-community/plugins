// marovole on X: Gemini 4 models on Factory 400 "Invalid model ID in request
// body" now and then, success and failure taking turns in one conversation.
// The plugin said one x-session-id for every request of its process, so
// every conversation, model and subagent shared one Factory session. droid
// opens a session per conversation (createProxyHeaders' sessionId), and
// Factory's routing keeps a session on the provider it was opened with.
import { afterEach, expect, test } from "bun:test"
import { FactoryAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// a fake Factory that, as a session lock would, keeps each x-session-id on
// the provider its first request named and refuses a model of another one
async function loaded() {
  const seen = []
  const locked = new Map()
  globalThis.fetch = async (url, init) => {
    const h = new Headers(init.headers)
    seen.push({ url: String(url), headers: h, body: init.body })
    const s = h.get("x-session-id")
    const p = h.get("x-api-provider")
    if (!locked.has(s)) locked.set(s, p)
    if (locked.get(s) !== p)
      return new Response(JSON.stringify({ error: { message: "Factory: Invalid model ID in request body" } }), { status: 400, headers: { "content-type": "application/json" } })
    return new Response('data: {"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]}}]}\n\n', { headers: { "content-type": "text/event-stream" } })
  }
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async () => {} } } })
  const l = await hooks.auth.loader(async () => ({ type: "oauth", access: "factory-token", expires: Date.now() + 3_600_000, activeOrganizationId: "org_A" }))
  // what magpie's host does for a request: the chat.headers hooks are told
  // the conversation, and the headers they set reach the loader's fetch
  const ask = async (conversation, url, body, extra = {}, providerID = "factory") => {
    const out = { headers: {} }
    await hooks["chat.headers"]?.({ sessionID: conversation, model: { providerID } }, out)
    return l.fetch(url, { method: "POST", headers: { "content-type": "application/json", ...out.headers, ...extra }, body: JSON.stringify(body) })
  }
  return { ask, seen, hooks }
}

const gemini = "https://api.factory.ai/api/llm/g/v1/models/gemini-4-argon:streamGenerateContent?alt=sse"
const claude = "https://api.factory.ai/api/llm/a/v1/messages"
const gBody = { contents: [{ role: "user", parts: [{ text: "hi" }] }] }
const cBody = { model: "claude-opus-5-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }

test("a Gemini conversation beside a Claude one isn't refused: each conversation is its own Factory session", async () => {
  const { ask, seen } = await loaded()
  const results = []
  for (let i = 0; i < 3; i++) {
    results.push((await ask("magpie-aaaaaaaaaaaaaaaaaaaaaaaa", claude, cBody)).status)
    results.push((await ask("magpie-bbbbbbbbbbbbbbbbbbbbbbbb", gemini, gBody)).status)
  }
  expect(results).toEqual([200, 200, 200, 200, 200, 200])
  const ids = seen.map((s) => s.headers.get("x-session-id"))
  for (const id of ids) expect(id).toMatch(UUID)
  // one conversation keeps its id, two never share one
  expect(new Set(ids.filter((_, i) => i % 2 === 0)).size).toBe(1)
  expect(new Set(ids.filter((_, i) => i % 2 === 1)).size).toBe(1)
  expect(ids[0]).not.toBe(ids[1])
  // the header that carried the conversation never reaches Factory
  for (const s of seen) expect(s.headers.get(_internal.CONVERSATION)).toBeNull()
})

test("a subagent is a session of its own, the same one on each of its requests", async () => {
  const { ask, seen } = await loaded()
  await ask("s1", gemini, gBody)
  await ask("s1", gemini, gBody, { "x-magpie-subagent": "agent-1" })
  await ask("s1", gemini, gBody, { "x-magpie-subagent": "agent-1" })
  const ids = seen.map((s) => s.headers.get("x-session-id"))
  expect(ids[0]).not.toBe(ids[1])
  expect(ids[1]).toBe(ids[2])
})

test("another provider's request names no conversation, and one with none keeps the process's session", async () => {
  const { hooks, ask, seen } = await loaded()
  const out = { headers: {} }
  await hooks["chat.headers"]({ sessionID: "s1", model: { providerID: "cursor" } }, out)
  expect(out.headers).toEqual({})
  await ask("", gemini, gBody)
  await ask("", gemini, gBody)
  const ids = seen.map((s) => s.headers.get("x-session-id"))
  expect(ids[0]).toMatch(UUID)
  expect(ids[0]).toBe(ids[1])
})

test("sessionId is a stable v4 UUID of the conversation and subagent", () => {
  const { sessionId } = _internal
  expect(sessionId("s1", "", "fb")).toMatch(UUID)
  expect(sessionId("s1", "", "fb")).toBe(sessionId("s1", undefined, "fb"))
  expect(sessionId("s1", "", "fb")).not.toBe(sessionId("s2", "", "fb"))
  expect(sessionId("s1", "a", "fb")).not.toBe(sessionId("s1", "", "fb"))
  expect(sessionId("", "a", "fb")).toBe("fb")
  expect(sessionId("  ", "", "fb")).toBe("fb")
})

test("with no hook (OpenCode 2), the session magpie or OpenCode names on the request names the Factory session", async () => {
  const { l, seen } = await (async () => {
    const seen = []
    globalThis.fetch = async (url, init) => (seen.push(new Headers(init.headers)), new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } }))
    const hooks = await FactoryAuthPlugin({ client: { auth: { set: async () => {} } } })
    return { l: await hooks.auth.loader(async () => ({ type: "oauth", access: "t", expires: Date.now() + 3_600_000, activeOrganizationId: "org_A" })), seen }
  })()
  const go = (headers) => l.fetch(gemini, { method: "POST", headers, body: JSON.stringify(gBody) })
  await go({ "x-magpie-session": "s1" })
  await go({ "x-opencode-session": "s1" })
  await go({ "x-magpie-session": "s2" })
  const ids = seen.map((h) => h.get("x-session-id"))
  expect(ids[0]).toBe(_internal.sessionId("s1", "", ""))
  expect(ids[1]).toBe(ids[0])
  expect(ids[2]).not.toBe(ids[0])
})
