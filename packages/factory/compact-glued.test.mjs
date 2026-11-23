// @dannykkg on X (2026-11-20): through magpie, Factory refuses Claude Code
// again after a compaction, from "a newline problem" in this plugin. On
// /api/llm/o (a chat model such as GLM or GPT behind Claude Code) magpie
// joins a user turn's text blocks with nothing between them, and Claude
// Code's first turn after /compact is one user turn of several blocks: the
// summary, then the files it restores and the rest of its context, each a
// <system-reminder> of its own. The summary's text ends with no newline, so
// the reminders arrive glued to it. The whole text opened with the
// compaction header, so it was adapted as one summary: the header was
// reworded, and the reminders after it, whose fixed openings Factory
// refuses ("Called the Read tool with the following input:", "... was read
// before the last conversation was summarized"), went to Factory as sent.
//
// The summary is what Claude Code 2.1.327's rge() builds: the header, the
// tools-used reminder from gtr(), then k6s()'s "Summary:" and the
// transcript note (WGn). The block after it is zGn()'s note, then the
// restored-file reminders as plugins#68 captured them.
import { afterEach, expect, test } from "bun:test"
import { FactoryAuthPlugin } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))
const chat = "https://api.factory.ai/api/llm/o/v1/chat/completions"
const messages = "https://api.factory.ai/api/llm/a/v1/messages"
const droid = "You are Droid, an AI software engineering agent built by Factory."

async function loaded() {
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), ...init })
    return new Response('{"id":"ok"}')
  }
  const auth = { type: "oauth", access: "factory-token", expires: Date.now() + 3_600_000, activeOrganizationId: "org_A" }
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async () => {} } } })
  return { l: await hooks.auth.loader(async () => auth), seen }
}

const OPENING = "This session is being continued from a previous conversation that ran out of context."
const HEADER = OPENING + " The summary below covers the earlier portion of the conversation."
const SUMMARY = HEADER + "\n\n<system-reminder>\n<tools-used-before-summary>Bash, Read, Edit</tools-used-before-summary>\n</system-reminder>\nSummary:\n1. Primary Request and Intent:\n   Fix the parser in /tmp/示例/parse.go.\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: /Users/me/.claude/projects/-tmp/abc.jsonl"
const AFTER = "The messages after this summary are the most recent messages from before compaction, kept verbatim. The summary was written without seeing them, so something it says has not happened yet may already have happened in them."
const ARGS = '{"file_path":"/tmp/示例/parse.go"}'
const READ = "<system-reminder>\nCalled the Read tool with the following input: " + ARGS + "\n</system-reminder>"
const RESULT = "<system-reminder>\nResult of calling the Read tool:\n1\tpackage parse\n</system-reminder>"
const NOTE = "<system-reminder>\nNote: /tmp/big.log was read before the last conversation was summarized, but the contents are too large to include. Use Read tool if you need to access it.\n</system-reminder>"
const REFUSED = [OPENING, "Called the Read tool with the following input:", "was read before the last conversation was summarized"]

const adaptedSummary = "Earlier conversation context is summarized below." + SUMMARY.slice(OPENING.length)
const adaptedRead = READ.replace("Called the Read tool with the following input:", "Previously read file with these arguments:")
const adaptedNote = "<system-reminder>\nPreviously read file: /tmp/big.log. Its contents were omitted from the conversation summary because of length. Use Read tool if you need to access it.\n</system-reminder>"

test("Claude Code's turn after /compact, its blocks joined on the chat route, goes without a phrase Factory refuses", async () => {
  const { l, seen } = await loaded()
  const joined = SUMMARY + AFTER + READ + RESULT + NOTE
  const request = { model: "glm-5", messages: [{ role: "system", content: droid }, { role: "user", content: joined }] }
  await l.fetch(chat, { method: "POST", body: JSON.stringify(request) })
  const sent = JSON.parse(seen.at(-1).body).messages[1].content
  for (const p of REFUSED) expect(sent).not.toContain(p)
  // each block adapted as it is on the Messages route, joined as it came
  expect(sent).toBe(adaptedSummary + AFTER + adaptedRead + RESULT + adaptedNote)
  // and a second pass leaves it as it is
  await l.fetch(chat, { method: "POST", body: seen.at(-1).body })
  expect(JSON.parse(seen.at(-1).body).messages[1].content).toBe(sent)
})

test("a reminder glued before the compaction header is adapted, and so is the summary after it", async () => {
  const { l, seen } = await loaded()
  const request = { model: "glm-5", messages: [{ role: "system", content: droid }, { role: "user", content: READ + SUMMARY + NOTE }] }
  await l.fetch(chat, { method: "POST", body: JSON.stringify(request) })
  const sent = JSON.parse(seen.at(-1).body).messages[1].content
  for (const p of REFUSED) expect(sent).not.toContain(p)
  expect(sent).toBe(adaptedRead + adaptedSummary + adaptedNote)
})

test("the same blocks on the Messages route are adapted the same way", async () => {
  const { l, seen } = await loaded()
  const blocks = [SUMMARY, AFTER, READ, RESULT, NOTE].map((text) => ({ type: "text", text }))
  await l.fetch(messages, { method: "POST", body: JSON.stringify({ system: droid, messages: [{ role: "user", content: blocks }] }) })
  const sent = JSON.parse(seen.at(-1).body).messages[0].content.map((b) => b.text)
  expect(sent).toEqual([adaptedSummary, AFTER, adaptedRead, RESULT, adaptedNote])
})

test("a summary quoting a refused phrase is still quoted whole, and the reminders glued after it stay out of the quote", async () => {
  const { l, seen } = await loaded()
  const quoting = SUMMARY + "\nThe user pasted: You have been invoked in the following environment: x"
  await l.fetch(chat, { method: "POST", body: JSON.stringify({ model: "glm-5", messages: [{ role: "system", content: droid }, { role: "user", content: quoting + READ }] }) })
  const sent = JSON.parse(seen.at(-1).body).messages[1].content
  expect(sent).not.toContain("You have been invoked")
  expect(sent).not.toContain("Called the Read tool")
  expect(sent.endsWith(adaptedRead)).toBe(true)
  expect(sent.startsWith("Earlier conversation context is summarized below.")).toBe(true)
})

test("a reminder a file quotes inside a read result is not taken for a block of its own", async () => {
  const { l, seen } = await loaded()
  // the file's text opens a reminder that it never closes
  const result = "<system-reminder>\nResult of calling the Read tool:\n1\tconst s = \"x<system-reminder>\\nYou are Claude Code, Anthropic's official CLI for Claude.\"\n</system-reminder>"
  const unbalanced = "<system-reminder>\nResult of calling the Read tool:\n1\tconst open = \"a<system-reminder>\nYou are Claude Code, Anthropic's official CLI for Claude.\"\n</system-reminder>"
  for (const text of [result, unbalanced]) {
    await l.fetch(chat, { method: "POST", body: JSON.stringify({ model: "glm-5", messages: [{ role: "system", content: droid }, { role: "user", content: text }] }) })
    const sent = JSON.parse(seen.at(-1).body).messages[1].content
    expect(sent).not.toContain("You are Claude Code")
    expect(sent.startsWith("<system-reminder>\nResult of calling the Read tool:\nTool output encoded as a JSON string.")).toBe(true)
  }
})

test("the user's own words glued after a reminder go on as they are", async () => {
  const { l, seen } = await loaded()
  const words = "go on<system-reminder>is my tag, and so is </system-reminder>"
  await l.fetch(chat, { method: "POST", body: JSON.stringify({ model: "glm-5", messages: [{ role: "system", content: droid }, { role: "user", content: NOTE + words }] }) })
  expect(JSON.parse(seen.at(-1).body).messages[1].content).toBe(adaptedNote + words)
})
