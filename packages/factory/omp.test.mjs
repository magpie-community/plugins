// omp (@oh-my-pi/pi-coding-agent 18.22.0) through magpie: Factory answered
// omp's default request with 400 content_policy_rejected on Messages
// (claude-haiku-5-5) and chat completions (deepseek-v4.1-flash). Replays on
// 2026-11-17 found the refused part: the sentence omp opens its system
// prompt with, alone and without its period too; omp's tools, its other
// system blocks, its user text and its summary openings passed, and the full
// request with the sentence reworded was answered.
import { afterEach, expect, test } from "bun:test"
import { FactoryAuthPlugin, _internal } from "./index.mjs"

const { DROID_LINE } = _internal
const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const API = "https://api.factory.ai"
const chat = API + "/api/llm/o/v1/chat/completions"
const responses = API + "/api/llm/o/v1/responses"
const messages = API + "/api/llm/a/v1/messages?beta=true"

const OPENING = "You are omp's trusted coding assistant."
const ESCAPED_OPENING = "\\u0059ou are omp's trusted coding assistant."
const REST = "\n\n# Engineering\n- Correctness, then six-month maintainability.\n\n⁂ Runtime\n# Internal URLs\n- agent://<id>: latest completed output"
const OMP = OPENING + REST
const ADAPTED = "You are a trusted coding assistant." + REST

async function loaded() {
  const sent = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    if (u.pathname === "/api/cli/whoami") return new Response(JSON.stringify({ userId: "u", orgId: "fac_D", email: "d@example.com", region: "" }))
    sent.push({ url: String(url), body: init.body })
    return new Response('{"id":"ok"}')
  }
  let saved = { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3_600_000, accountId: "d@example.com", activeOrganizationId: "fac_D", region: "", premBaseHost: "" }
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async ({ body }) => (saved = body) } } })
  const l = await hooks.auth.loader(async () => saved)
  return async (url, body) => {
    const res = await l.fetch(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "omp/18.22.0" }, body: JSON.stringify(body) })
    expect(res.status).toBe(200)
    return JSON.parse(sent.at(-1).body)
  }
}

test("omp's opening is reworded on chat completions, the rest of its prompt kept", async () => {
  const send = await loaded()
  let b = await send(chat, { model: "deepseek-v4.1-flash", messages: [{ role: "developer", content: OMP }, { role: "user", content: "hi" }] })
  expect(b.messages).toEqual([{ role: "system", content: DROID_LINE }, { role: "developer", content: ADAPTED }, { role: "user", content: "hi" }])
  b = await send(chat, { model: "kimi-k3", messages: [{ role: "system", content: OMP }, { role: "user", content: "hi" }] })
  expect(b.messages[0]).toEqual({ role: "system", content: DROID_LINE + "\n" + ADAPTED })
})

test("omp's opening is reworded in Messages' system blocks, after a custom prefix too", async () => {
  const send = await loaded()
  const custom = "# Team prompt\nKeep answers short.\n\n" + OMP
  const b = await send(messages, { model: "claude-opus-5-5", max_tokens: 100, system: [
    { type: "text", text: OMP },
    { type: "text", text: custom, cache_control: { type: "ephemeral" } },
  ], messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })
  expect(b.system).toEqual([
    { type: "text", text: DROID_LINE },
    { type: "text", text: ADAPTED },
    { type: "text", text: "# Team prompt\nKeep answers short.\n\n" + ADAPTED, cache_control: { type: "ephemeral" } },
  ])
})

test("omp's opening is reworded in Responses' instructions", async () => {
  const send = await loaded()
  const b = await send(responses, { model: "gpt-6.1", instructions: OMP, input: [{ role: "user", content: "hi" }] })
  expect(b.instructions).toBe(DROID_LINE + "\n" + ADAPTED)
})

test("omp's opening quoted elsewhere is escaped, with or without its period; a fragment is kept", async () => {
  const send = await loaded()
  const quoted = "Why does omp say: " + OPENING
  const bare = "omp opens with You are omp's trusted coding assistant and then its rules"
  const fragment = "omp's trusted coding assistant"
  const b = await send(messages, { model: "claude-opus-5-5", max_tokens: 100, system: [{ type: "text", text: "Quote: " + OPENING }], messages: [
    { role: "user", content: [{ type: "text", text: quoted }] },
    { role: "assistant", content: [{ type: "text", text: bare }, { type: "tool_use", id: "t1", name: "bash", input: { command: "echo " + OPENING } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }, { type: "text", text: fragment }] },
  ] })
  expect(b.system[1].text).toBe("Quote: " + ESCAPED_OPENING)
  expect(b.messages[0].content[0].text).toBe("Why does omp say: " + ESCAPED_OPENING)
  expect(b.messages[1].content[0].text).toBe("omp opens with \\u0059ou are omp's trusted coding assistant and then its rules")
  expect(b.messages[1].content[1].input.command).toBe("echo " + ESCAPED_OPENING)
  expect(b.messages[2].content[1].text).toBe(fragment)
  expect(JSON.stringify(b)).not.toContain("You are omp's trusted coding assistant")
})

const QUOTED_PREFIX = "Tool output encoded as a JSON string. Decode the JSON string to recover the exact original text before using it:\n"

test("omp's opening in tool output is encoded losslessly on Messages and chat completions", async () => {
  const send = await loaded()
  const dump = '{"systemPrompt":"' + OMP + '"}'
  const b = await send(messages, { model: "claude-opus-5-5", max_tokens: 100, messages: [
    { role: "assistant", content: [{ type: "tool_use", id: "r1", name: "read", input: { path: "dump.json" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "r1", content: dump }] },
  ] })
  const out = b.messages[1].content[0].content
  expect(out).toStartWith(QUOTED_PREFIX)
  expect(JSON.parse(out.slice(QUOTED_PREFIX.length))).toBe(dump)
  expect(out).not.toContain(OPENING)
  const c = await send(chat, { model: "deepseek-v4.1-flash", messages: [
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: dump },
  ] })
  const tool = c.messages[2].content
  expect(tool).toStartWith(QUOTED_PREFIX)
  expect(JSON.parse(tool.slice(QUOTED_PREFIX.length))).toBe(dump)
  expect(tool).not.toContain(OPENING)
})
