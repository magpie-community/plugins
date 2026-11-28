// magpie-community/plugins#1603 (gengyubo): Codex 0.172.0 through factory
// 0.1.58 on deepseek-v4.1-flash-1017, every turn 400
// content_policy_rejected in about 5s (the request and its retry with every
// tool renamed). "harness" already went as runtime; Codex's prompt still
// named Codex in its fixed identity sentences, the class of pi's, omp's,
// dsh's and Claude Code's openings Factory refuses.
//
// testdata/codex-0.171-deepseek-chat.json is magpie's chat body for
// deepseek-v4.1-flash-1017 built from a real Codex 0.171 request (magpie's
// internal/gateway/testdata/codex-0.171-three-turns.json, through
// parseResponses and buildChat at magpie 320bce6f6): Codex's prompt for a
// model it has no prompt of its own for, as the system message. The GPT
// openings are Codex's bundled prompts' own bytes (magpie's
// internal/codexcat/codex_instructions.json: gpt-6-astra, gpt-5.6-sol,
// gpt-5.5).
import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { FactoryAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const API = "https://api.factory.ai"
const responses = API + "/api/llm/o/v1/responses"
const chat = API + "/api/llm/o/v1/chat/completions"
const gemini = API + "/api/llm/g/v1/models/gemini-4-hydrogen:streamGenerateContent?alt=sse"
const DROID = "You are Droid, an AI software engineering agent built by Factory."
const CHAT = readFileSync(new URL("./testdata/codex-0.171-deepseek-chat.json", import.meta.url), "utf8")
const GEMINI = readFileSync(new URL("./testdata/codex-0.162.0-gemini.json", import.meta.url), "utf8")

const GPT = [
  ["You are Codex, an agent based on GPT-6. You and the user share one workspace.\n\n# Personality\n\nAs Codex, you are a curious, thoughtful collaborator and a lucid communicator.",
    "You are an agent based on GPT-6. You and the user share one workspace.\n\n# Personality\n\nYou are a curious, thoughtful collaborator and a lucid communicator."],
  ["You are Codex, an agent based on GPT-5. You and the user share one workspace.\n\n# Personality\n\nAs Codex, you are an excellent communicator with a curious, rich personality.",
    "You are an agent based on GPT-5. You and the user share one workspace.\n\n# Personality\n\nYou are an excellent communicator with a curious, rich personality."],
  ["You are Codex, a coding agent based on GPT-5. You and the user share one workspace.\n\n# Personality\n\nYou have a vivid inner life as Codex: intelligent, playful, curious, and deeply present.",
    "You are a coding agent based on GPT-5. You and the user share one workspace.\n\n# Personality\n\nYou have a vivid inner life: intelligent, playful, curious, and deeply present."],
  ["You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI on a user's computer.",
    "You are an agent based on GPT-5. You are running as a coding agent on a user's computer."],
]
// Codex's identity, in the sentences these change, and nothing else
const IDENTITY = /You are Codex|in the Codex CLI|Codex CLI is|Codex refers to|As Codex|inner life as Codex/

async function loaded() {
  const sent = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    if (u.pathname === "/api/cli/whoami") return new Response(JSON.stringify({ userId: "user_k", orgId: "fac_K", email: "k@example.com", region: "" }))
    sent.push({ url: String(url), body: init.body })
    if (u.pathname.startsWith("/api/llm/g/")) return new Response('data: {"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]}}]}\n\n', { headers: { "content-type": "text/event-stream" } })
    return new Response('{"id":"ok"}')
  }
  let saved = { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3_600_000, accountId: "d@example.com", activeOrganizationId: "fac_D", region: "" }
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async ({ body }) => (saved = body) } } })
  const l = await hooks.auth.loader(async () => saved)
  return async (url, body) => {
    await l.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) })
    return JSON.parse(sent.at(-1).body)
  }
}

test("Codex's real request for DeepSeek reaches Factory without Codex's identity", async () => {
  const before = JSON.parse(CHAT)
  expect(before.messages[0].content).toMatch(IDENTITY)
  const send = await loaded()
  const b = await send(chat, CHAT)
  const system = b.messages[0].content
  expect(b.messages[0].role).toBe("system")
  expect(system).not.toMatch(IDENTITY)
  expect(system.startsWith(DROID + "\nYou are a coding agent running in a terminal-based coding assistant. You are expected to be precise, safe, and helpful.\n\nYour capabilities:")).toBe(true)
  expect(system).toContain("approval before running. More on this in the \"Sandbox and approvals\" section.\n\n# How you work")
  // the rest of Codex's prompt goes as written: its skills still say Codex
  expect(system).toContain("Create or update a Codex skill")
  expect(system).toContain("Install Codex skills into $CODEX_HOME/skills")
  // the user's turns go as Codex sent them
  expect(b.messages.slice(1).filter((m) => m.role === "user")).toEqual(before.messages.slice(1).filter((m) => m.role === "user"))
})

test("Codex's GPT prompts lose only the name, on the Responses route", async () => {
  const send = await loaded()
  for (const [prompt, want] of GPT) {
    // Codex 0.171 sends its prompt as the first developer item, earlier
    // ones as instructions
    const r = await send(responses, { model: "glm-5.3-flash", instructions: "", input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: prompt }] }, { type: "message", role: "user", content: [{ type: "input_text", text: "As Codex, you are my reviewer. You are Codex, based on GPT-5." }] }] })
    expect(JSON.stringify(r)).toContain(JSON.stringify(want).slice(1, -1))
    expect(r.input.at(-1).content[0].text).toBe("As Codex, you are my reviewer. You are Codex, based on GPT-5.")
    const i = await send(responses, { model: "glm-5.3-flash", instructions: prompt, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] })
    expect(i.instructions).toBe(DROID + "\n" + want)
  }
})

test("Codex's prompt reads the same to Factory on the Gemini route", async () => {
  expect(JSON.parse(GEMINI).systemInstruction.parts[0].text).toMatch(IDENTITY)
  const send = await loaded()
  const g = await send(gemini, GEMINI)
  const si = g.systemInstruction.parts[0].text
  expect(si.startsWith(DROID + "\nYou are a coding agent running in a terminal-based coding assistant. You are expected")).toBe(true)
  expect(si).not.toMatch(IDENTITY)
  for (const [prompt, want] of GPT) {
    const r = await send(gemini, { contents: [{ role: "user", parts: [{ text: "hi" }] }], systemInstruction: { role: "user", parts: [{ text: prompt }] } })
    expect(r.systemInstruction.parts[0].text).toBe(DROID + "\n" + want)
  }
})

test("a sentence like Codex's that isn't at a line's start goes as written", () => {
  const { clientOpening } = _internal
  for (const s of ["Say: You are Codex, an agent based on GPT-6.", "the user wrote As Codex, you are fine", "You are Codex, my friend."]) expect(clientOpening(s)).toBe(s)
})
