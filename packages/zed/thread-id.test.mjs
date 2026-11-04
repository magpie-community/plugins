// Zed's editor names each completion's thread and prompt in CompletionBody:
// thread_id once per agent thread, prompt_id again for each message the
// user sends (zed crates/cloud_llm_client CompletionBody; crates/agent
// thread.rs). The plugin sent neither, so every request was a thread of its
// own to Zed's cloud, and a Gemini 4 Argon conversation read no cache on 11
// requests of 180k to 230k tokens (plugins#731).
import { afterEach, expect, test } from "bun:test"
import { ZedAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  _internal.tokens.clear()
})

const s = { userId: "4242", access: "plain-access", systemId: "", org: "org-me", plan: "zed_pro", who: "octo" }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// sent is the CompletionBody the plugin hands Zed for a request to path.
async function sent(path, body, headers, who = s) {
  let got
  globalThis.fetch = async (url, init) => {
    const p = new URL(String(url)).pathname
    if (p === "/client/llm_tokens") return Response.json({ token: "llm-token" })
    if (p === "/completions") {
      got = JSON.parse(init.body)
      return new Response(JSON.stringify({ status: "stream_ended" }) + "\n", { headers: { "x-zed-server-supports-status-messages": "true" } })
    }
    return new Response("", { status: 404 })
  }
  const res = await _internal.complete(who, "https://cloud.zed.dev" + path, { method: "POST", headers, body: JSON.stringify(body) })
  await res.text().catch(() => {})
  return got
}

const ARGON = "/v1beta/models/gemini-4-argon:streamGenerateContent"
const call = { functionCall: { name: "read", args: { path: "a.go" } } }
const answer = { functionResponse: { name: "read", response: { content: "package a" } } }
const turns = {
  first: [{ role: "user", parts: [{ text: "read a.go" }] }],
  toolRound: [{ role: "user", parts: [{ text: "read a.go" }] }, { role: "model", parts: [call] }, { role: "user", parts: [answer] }],
  next: [{ role: "user", parts: [{ text: "read a.go" }] }, { role: "model", parts: [call] }, { role: "user", parts: [answer] }, { role: "model", parts: [{ text: "done" }] }, { role: "user", parts: [{ text: "now b.go" }] }],
}
const gemini = (contents) => ({ contents, systemInstruction: { parts: [{ text: "You are a coding agent." }] } })

test("a Gemini conversation keeps one thread_id, and a new prompt_id only for a message the user sends", async () => {
  const h = { [_internal.SESSION]: "ses_abc" }
  const a = await sent(ARGON, gemini(turns.first), h)
  const b = await sent(ARGON, gemini(turns.toolRound), h)
  const c = await sent(ARGON, gemini(turns.next), h)
  expect(a.thread_id).toMatch(UUID)
  expect(a.prompt_id).toMatch(UUID)
  expect(b.thread_id).toBe(a.thread_id)
  expect(c.thread_id).toBe(a.thread_id)
  // the tool call's answer is the same prompt, as in Zed's editor
  expect(b.prompt_id).toBe(a.prompt_id)
  expect(c.prompt_id).not.toBe(a.prompt_id)
  expect(c.provider).toBe("google")
  expect(c.model).toBe("gemini-4-argon")
})

test("the session header goes no further than the plugin, and names nothing it was made from", async () => {
  const got = await sent(ARGON, gemini(turns.first), { [_internal.SESSION]: "ses_abc" })
  const text = JSON.stringify(got)
  expect(text).not.toContain("ses_abc")
  expect(text).not.toContain(_internal.SESSION)
  expect(text).not.toContain("4242")
})

test("two sessions, or two accounts, are two threads", async () => {
  const a = await sent(ARGON, gemini(turns.first), { [_internal.SESSION]: "ses_abc" })
  const b = await sent(ARGON, gemini(turns.first), { [_internal.SESSION]: "ses_xyz" })
  const c = await sent(ARGON, gemini(turns.first), { [_internal.SESSION]: "ses_abc" }, { ...s, userId: "777" })
  expect(b.thread_id).not.toBe(a.thread_id)
  expect(c.thread_id).not.toBe(a.thread_id)
})

test("with no session, the first message the user sent names the thread", async () => {
  const a = await sent(ARGON, gemini(turns.first))
  const c = await sent(ARGON, gemini(turns.next))
  expect(a.thread_id).toMatch(UUID)
  expect(c.thread_id).toBe(a.thread_id)
  expect(c.prompt_id).not.toBe(a.prompt_id)
})

test("every API's tool round shares its prompt, and the next message gets a new one", async () => {
  const anthropic = (m) => ({ model: "claude-sonnet-5", max_tokens: 100, stream: true, messages: m })
  const chat = (m) => ({ model: "gpt-5", stream: true, messages: m })
  const responses = (m) => ({ model: "gpt-5", stream: true, input: m })
  const cases = [
    [
      "/v1/messages",
      anthropic([{ role: "user", content: "read a.go" }]),
      anthropic([{ role: "user", content: "read a.go" }, { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "package a" }] }] }]),
      anthropic([{ role: "user", content: "read a.go" }, { role: "assistant", content: "ok" }, { role: "user", content: [{ type: "text", text: "now b.go" }] }]),
    ],
    [
      "/v1/chat/completions",
      chat([{ role: "user", content: "read a.go" }]),
      chat([{ role: "user", content: "read a.go" }, { role: "assistant", tool_calls: [{ id: "t1", type: "function", function: { name: "read", arguments: "{}" } }] }, { role: "tool", tool_call_id: "t1", content: "package a" }]),
      chat([{ role: "user", content: "read a.go" }, { role: "assistant", content: "ok" }, { role: "user", content: [{ type: "text", text: "now b.go" }] }]),
    ],
    [
      "/v1/responses",
      responses([{ role: "user", content: [{ type: "input_text", text: "read a.go" }] }]),
      responses([{ role: "user", content: [{ type: "input_text", text: "read a.go" }] }, { type: "function_call", call_id: "t1", name: "read", arguments: "{}" }, { type: "function_call_output", call_id: "t1", output: "package a" }]),
      responses([{ role: "user", content: [{ type: "input_text", text: "read a.go" }] }, { role: "assistant", content: [{ type: "output_text", text: "ok" }] }, { role: "user", content: [{ type: "input_text", text: "now b.go" }] }]),
    ],
  ]
  for (const [path, first, round, next] of cases) {
    const h = { [_internal.SESSION]: "ses_" + path }
    const a = await sent(path, first, h)
    const b = await sent(path, round, h)
    const c = await sent(path, next, h)
    expect([path, a.thread_id]).toEqual([path, expect.stringMatching(UUID)])
    expect([path, b.thread_id, c.thread_id]).toEqual([path, a.thread_id, a.thread_id])
    expect([path, b.prompt_id]).toEqual([path, a.prompt_id])
    expect([path, c.prompt_id === a.prompt_id]).toEqual([path, false])
  }
})

test("chat.headers names Zed's requests' session, and no other provider's", async () => {
  const p = await ZedAuthPlugin({})
  const out = { headers: {} }
  await p["chat.headers"]({ sessionID: "ses_abc", model: { providerID: "zed", id: "gemini-4-argon" } }, out)
  expect(out.headers[_internal.SESSION]).toBe("ses_abc")
  const other = { headers: {} }
  await p["chat.headers"]({ sessionID: "ses_abc", model: { providerID: "anthropic", id: "claude-sonnet-5" } }, other)
  expect(other.headers).toEqual({})
})

test("the loader's fetch keeps a Request's headers, the session among them", async () => {
  let got
  globalThis.fetch = async (url, init) => {
    const p = new URL(String(url)).pathname
    if (p === "/client/llm_tokens") return Response.json({ token: "llm-token" })
    if (p === "/completions") {
      got = JSON.parse(init.body)
      return new Response(JSON.stringify({ status: "stream_ended" }) + "\n", { headers: { "x-zed-server-supports-status-messages": "true" } })
    }
    return new Response("", { status: 404 })
  }
  const auth = { type: "oauth", refresh: JSON.stringify({ userId: "4242", access: "plain-access" }), access: "plain-access", expires: Date.now() + 3600e3 }
  const p = await ZedAuthPlugin({})
  const sdk = await p.auth.loader(async () => auth)
  expect(typeof sdk.fetch).toBe("function")
  const one = async (contents) => {
    const req = new Request("https://cloud.zed.dev" + ARGON, { method: "POST", headers: { [_internal.SESSION]: "ses_abc" }, body: JSON.stringify(gemini(contents)) })
    const res = await sdk.fetch(req)
    await res.text().catch(() => {})
    return got
  }
  const a = await one(turns.first)
  const b = await one([{ role: "user", parts: [{ text: "something else entirely" }] }])
  // the same session, though the first message differs: the header was read
  expect(a.thread_id).toMatch(UUID)
  expect(b.thread_id).toBe(a.thread_id)
})
