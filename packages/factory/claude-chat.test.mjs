// Echoo on magpie's Discord: Claude Code on GLM-5.3-Flash through this
// plugin got "API Error: 403 Factory: Forbidden" on every turn, while Codex
// worked on the same account and model. GLM is a chat model, served on
// /api/llm/o, so magpie translates Claude Code's Messages request into chat
// completions (or Responses) before it reaches the plugin. Only
// anthropicBody (the /api/llm/a route) adapted Claude Code's fixed phrases
// Factory refuses; on /api/llm/o they went to Factory as they were.
//
// testdata/claude-code-2.1.300-glm-{chat,responses}.json are magpie's
// translations of a real Claude Code 2.1.300 request, captured from a
// sandbox HOME (paths changed to /Users/me, tools left out).
import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { FactoryAuthPlugin, _internal } from "./index.mjs"

const { DROID_LINE } = _internal
const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const API = "https://api.factory.ai"
const chat = API + "/api/llm/o/v1/chat/completions"
const responses = API + "/api/llm/o/v1/responses"

const CHAT = readFileSync(new URL("./testdata/claude-code-2.1.300-glm-chat.json", import.meta.url), "utf8")
const RESPONSES = readFileSync(new URL("./testdata/claude-code-2.1.300-glm-responses.json", import.meta.url), "utf8")

// the phrases the plugin already adapts on /api/llm/a because Factory refuses them
const REFUSED = [
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  "You have been invoked in the following environment",
  "You are powered by the model",
  "the harness executes these, not Claude, so memory",
]

async function loaded() {
  const sent = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    if (u.pathname === "/api/cli/whoami") return new Response(JSON.stringify({ userId: "user_k", orgId: "fac_K", email: "k@example.com", region: "" }))
    sent.push({ url: String(url), headers: new Headers(init.headers), body: init.body })
    return new Response('{"id":"ok"}')
  }
  let saved = { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3_600_000, accountId: "d@example.com", activeOrganizationId: "fac_D", region: "" }
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async ({ body }) => (saved = body) } } })
  const l = await hooks.auth.loader(async () => saved)
  return async (url, body) => {
    const res = await l.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body })
    expect(res.status).toBe(200)
    return JSON.parse(sent.at(-1).body)
  }
}

test("Claude Code's request made chat completions goes without the phrases Factory refuses", async () => {
  const send = await loaded()
  for (const p of REFUSED) expect(CHAT).toContain(p)
  const b = await send(chat, CHAT)
  const out = JSON.stringify(b)
  for (const p of REFUSED) expect(out).not.toContain(p)
  const m = b.messages
  expect(m[0].role).toBe("system")
  expect(m[0].content.startsWith(DROID_LINE + "\nYou are an agent working with the user")).toBe(true)
  expect(m[0].content.split(DROID_LINE).length).toBe(2)
  // the user's words and the attribution reminder joined to them stay
  expect(m[1].content).toBe(JSON.parse(CHAT).messages[1].content)
  // the environment Claude Code sent as a system message, folded into a
  // user turn by the translation: reworded, its facts kept
  expect(m[2].content.startsWith("# Runtime context\nThe session environment is: \n - Primary working directory: /Users/me/proj\n")).toBe(true)
  expect(m[2].content).toContain("\n\nCurrent model: glm-5.3-flash.\n\n")
  expect(m[2].content).toContain("the harness executes these, not the assistant, so memory")
  expect(m.length).toBe(JSON.parse(CHAT).messages.length)
  expect(b.model).toBe("glm-5.3-flash")
})

test("Claude Code's request made Responses goes without the phrases Factory refuses", async () => {
  const send = await loaded()
  for (const p of REFUSED) expect(RESPONSES).toContain(p)
  const b = await send(responses, RESPONSES)
  const out = JSON.stringify(b)
  for (const p of REFUSED) expect(out).not.toContain(p)
  expect(b.instructions.startsWith(DROID_LINE + "\nYou are an agent working with the user")).toBe(true)
  expect(b.instructions.split(DROID_LINE).length).toBe(2)
  const system = b.input.find((i) => i.role === "system")
  expect(system.content[0].text.startsWith("# Runtime context\nThe session environment is: \n")).toBe(true)
  expect(b.input.length).toBe(JSON.parse(RESPONSES).input.length)
})

test("a reminder joined to the user's words is adapted as the block it was, the words kept", async () => {
  const send = await loaded()
  const joined = "<system-reminder>\nYou are powered by the model named GLM-5.3-Flash.\n</system-reminder>\nwhat model are you? You are powered by the model, right?"
  let b = await send(chat, JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: joined }] }))
  expect(b.messages[1].content).toBe("<system-reminder>\nCurrent model name: GLM-5.3-Flash.\n</system-reminder>\nwhat model are you? You are powered by the model, right?")
  // the user's own text, with no generated reminder, goes on as it is
  const own = "You are powered by the model named in my config. You have been invoked in the following environment: mine"
  b = await send(chat, JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: own }] }))
  expect(b.messages[1].content).toBe(own)
  // Responses keeps blocks apart: each input_text is adapted on its own
  b = await send(responses, JSON.stringify({ model: "glm-5.3-flash", input: [{ role: "user", content: [{ type: "input_text", text: "<system-reminder>\nYou are powered by the model glm-5.3-flash.\n</system-reminder>" }, { type: "input_text", text: "hi" }] }] }))
  expect(b.input[0].content.map((p) => p.text)).toEqual(["<system-reminder>\nCurrent model: glm-5.3-flash.\n</system-reminder>", "hi"])
})

test("tool output quoting Claude Code's identity is encoded, on chat and Responses", async () => {
  const send = await loaded()
  const read = "1\tconst id = \"You are Claude Code, Anthropic's official CLI for Claude.\""
  let b = await send(chat, JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "read it" }, { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "Read", arguments: "{}" } }] }, { role: "tool", tool_call_id: "c1", content: read }] }))
  const tool = b.messages.find((m) => m.role === "tool")
  expect(tool.content).not.toContain("You are Claude Code")
  expect(tool.content.startsWith("Tool output encoded as a JSON string.")).toBe(true)
  expect(tool.tool_call_id).toBe("c1")
  b = await send(responses, JSON.stringify({ model: "glm-5.3-flash", input: [{ type: "function_call", call_id: "c1", name: "Read", arguments: "{}" }, { type: "function_call_output", call_id: "c1", output: read }] }))
  expect(b.input[1].output).not.toContain("You are Claude Code")
  expect(b.input[1].call_id).toBe("c1")
  // other tool output stays byte for byte
  b = await send(chat, JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "tool", tool_call_id: "c2", content: "ok" }] }))
  expect(b.messages.find((m) => m.role === "tool").content).toBe("ok")
})

test("Codex's request is only opened with droid's line, as before", async () => {
  const send = await loaded()
  const dev = "<permissions instructions>\nYou are powered by the model gpt-5.5 says nothing here.\n</permissions instructions>"
  const b = await send(responses, JSON.stringify({ model: "glm-5.3-flash", instructions: "You are Codex, a coding agent based on GPT-5.", input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: dev }] }, { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n  <cwd>/Users/me/proj</cwd>\n</environment_context>" }, { type: "input_text", text: "hi" }] }] }))
  expect(b.instructions).toBe(DROID_LINE + "\nYou are Codex, a coding agent based on GPT-5.")
  expect(b.input[0].content[0].text).toBe(dev)
  expect(b.input[1].content.map((p) => p.text)).toEqual(["<environment_context>\n  <cwd>/Users/me/proj</cwd>\n</environment_context>", "hi"])
})
