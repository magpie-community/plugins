// @dannykkg on X (11-24): Claude Code through magpie on Factory was still
// refused, "the environment info not handled, and special messages being
// missed". Claude Code 2.1.327 sends its runtime context (the deferred
// tools, the agent types, the skills, the environment, the model line) as
// one system message after the first user turn. On a chat or Responses
// model (/api/llm/o) magpie translates the request, and the message arrives
// folded: into the system prompt after a blank line when no reply came
// before it, or into a user turn as one <system-reminder> after one (after
// /compact, every turn). Neither shape was adapted, and the translation
// joins the system blocks with nothing between them, so a subagent's
// prompt opened "…Claude Agent SDK.You are an agent for Claude Code, …"
// and its identity line went as it was.
//
// testdata/claude-code-2.1.327-{subagent,compact}-{chat,responses}.json are
// magpie's translations (gateway build() at a4f5e1954, billing line cut as
// the gateway cuts it) of real Claude Code 2.1.327 requests captured from a
// sandbox HOME against a local fake: a subagent's first request, and the
// turn after /compact. Paths changed to /Users/me, tools left out.
import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { FactoryAuthPlugin, _internal } from "./index.mjs"

const { DROID_LINE } = _internal
const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const API = "https://api.factory.ai"
const chat = API + "/api/llm/o/v1/chat/completions"
const responses = API + "/api/llm/o/v1/responses"
const fixture = (name) => readFileSync(new URL("./testdata/claude-code-2.1.327-" + name + ".json", import.meta.url), "utf8")

const ENV = "You have been invoked in the following environment"
const IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK."
const MODEL = ["You are powered by the model", "The exact model ID is"]
const CONFIG = "the harness executes these, not Claude, so memory"

async function loaded() {
  const sent = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    if (u.pathname === "/api/cli/whoami") return new Response(JSON.stringify({ userId: "user_k", orgId: "fac_K", email: "k@example.com", region: "" }))
    sent.push({ url: String(url), body: init.body })
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

test("a subagent's prompt, its identity glued to the next block and the environment folded in, goes without the refused phrases", async () => {
  const send = await loaded()
  for (const [url, name, prompt] of [[chat, "subagent-chat", (b) => b.messages[0].content], [responses, "subagent-responses", (b) => b.instructions]]) {
    const raw = fixture(name)
    expect(raw).toContain(IDENTITY + "You are an agent for Claude Code")
    expect(raw).toContain("\\n\\n# Environment\\n" + ENV)
    const b = await send(url, raw)
    const out = JSON.stringify(b)
    expect(out).not.toContain(IDENTITY)
    expect(out).not.toContain(ENV)
    const p = prompt(b)
    expect(p.startsWith(DROID_LINE + "\nYou are an agent for Claude Code")).toBe(true)
    expect(p.split(DROID_LINE).length).toBe(2)
    // the environment's facts stay, reworded only in its heading and opening
    expect(p).toContain("\n\n# Runtime context\nThe session environment is: \n - Primary working directory: /Users/me/proj\n - Is a git repository: true\n")
    // the deferred tools folded before it stay as they were
    expect(p).toContain("The following deferred tools are now available via ToolSearch.")
  }
})

test("the system message folded into the turn after /compact is adapted as the system message it was", async () => {
  const send = await loaded()
  for (const [url, name, turns, text] of [
    [chat, "compact-chat", (b) => b.messages, (m) => m.content],
    [responses, "compact-responses", (b) => b.input, (m) => m.content.map((p) => p.text).join("")],
  ]) {
    const raw = fixture(name)
    for (const p of [ENV, CONFIG, ...MODEL]) expect(raw).toContain(p)
    const b = await send(url, raw)
    const out = JSON.stringify(b)
    for (const p of [ENV, CONFIG, ...MODEL, IDENTITY]) expect(out).not.toContain(p)
    const last = text(turns(b).at(-1))
    // still one reminder, after the user's own words, which stay
    expect(last).toContain("now continue<system-reminder>\nThe following deferred tools are now available via ToolSearch.")
    expect(last.endsWith("\n\nToday's date is 2026-11-24.\n</system-reminder>")).toBe(true)
    expect(last).toContain("\n\n# Runtime context\nThe session environment is: \n - Primary working directory: /Users/me/proj\n")
    expect(last).toContain("\n\nCurrent model name: Opus 5.5. Model ID: claude-opus-5-5. Model knowledge cutoff: June 2026.\n\n")
    expect(last).toContain("- update-config: Use this skill to configure the Claude Code runtime via settings.json.")
    expect(last).toContain("the runtime executes these, not the assistant, so memory/preferences cannot fulfill them.")
    expect(turns(b).length).toBe(turns(JSON.parse(raw)).length)
  }
})

test("only Claude Code's generated shapes change: a user's own reminder, a fenced environment and quoted text stay", async () => {
  const send = await loaded()
  // a reminder that doesn't open as a generated system message
  const own = "<system-reminder>\nmy notes on the test harness: # Environment\nYou have been invoked in the following environment: \n - mine\n\nYou are powered by the model named X.\n</system-reminder>"
  let b = await send(chat, JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: own }] }))
  expect(b.messages[1].content).toBe(own)
  // an environment paragraph quoted in a fence of the prompt
  const fenced = "You are a helpful assistant.\n\n```\n# Environment\nYou have been invoked in the following environment: \n - Platform: darwin\n```"
  b = await send(chat, JSON.stringify({ model: "glm-5.3", messages: [{ role: "system", content: fenced }, { role: "user", content: "hi" }] }))
  expect(b.messages.find((m) => m.content.includes("```")).content).toContain("# Environment\nYou have been invoked in the following environment: \n - Platform: darwin\n```")
  // the sentence in a paragraph of its own words is not the generated paragraph
  const prose = "You are a helpful assistant.\n\n# Environment\nYou have been invoked in the following environment: a container."
  b = await send(chat, JSON.stringify({ model: "glm-5.3", messages: [{ role: "system", content: prose }, { role: "user", content: "hi" }] }))
  expect(JSON.stringify(b)).toContain("You have been invoked in the following environment: a container.")
  // the identity at the start of a longer line is still the longest one
  b = await send(chat, JSON.stringify({ model: "glm-5.3", messages: [{ role: "system", content: "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.\nrest" }, { role: "user", content: "hi" }] }))
  expect(b.messages[0].content).toBe(DROID_LINE + "\nrest")
})
