// The caller's prompt-cache marks reach Kiro (#110: "kiro cli cache 率为 0").
// Kiro's generateAssistantResponse takes Bedrock's cachePoint
// ({"type":"default"}) on a userInputMessage, on an assistantResponseMessage
// and as an entry of the tools (the CodeWhisperer streaming model's
// UserInputMessage.cachePoint, AssistantResponseMessage.cachePoint and
// Tool::CachePoint; Kiro CLI 2.27's model list tells
// supportsPromptCaching and maximumCacheCheckpointsPerRequest). Tried
// with a real account on 2026-10-24, Kiro caches a repeated prompt without
// them too (the second call billed about half the credits, marked or not,
// and kiro-cli 2.32 sends none); the marks stay as the caller's intent.
// Why magpie showed 0% is cache-unknown.test.mjs: Kiro reports no tokens.
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { buildKiro } = _internal
const sent = (r) => JSON.parse(buildKiro(r, "claude-sonnet-4.5", "", 0)).conversationState
const EPH = { type: "ephemeral" }
const POINT = { type: "default" }

// where Claude Code 2.1.296 put its marks, from a captured request (texts
// cut short): the last two system blocks, and the last message, the
// system-role message holding a hook's context after a tool result
const claudeCode = {
  model: "claude-sonnet-4.5",
  system: [
    { type: "text", text: "x-anthropic-billing-header: cc_version=2" },
    { type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.", cache_control: EPH },
    { type: "text", text: "You are an agent working with the user …", cache_control: EPH },
  ],
  messages: [
    { role: "user", content: [{ type: "text", text: "<system-reminder>\nAttribution …</system-reminder>" }, { type: "text", text: "run echo hi" }] },
    { role: "system", content: "# Environment\nYou have been invoked in the following environment: …" },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "sleep 6; echo hi", description: "say hi" } }] },
    { role: "user", content: [{ tool_use_id: "toolu_01", type: "tool_result", is_error: false, content: "hi" }] },
    { role: "system", content: [{ type: "text", text: "PreToolUse:Bash hook additional context: …", cache_control: EPH }] },
  ],
  tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
}

test("Claude Code's marks go on the messages they end up in", () => {
  const s = sent(claudeCode)
  // the instructions are at the head of the first message, so its mark
  // covers them; the hook's context joins the tool result's message
  expect(s.history[0].userInputMessage.cachePoint).toEqual(POINT)
  expect(s.history[1].assistantResponseMessage.cachePoint).toBeUndefined()
  expect(s.currentMessage.userInputMessage.cachePoint).toEqual(POINT)
  expect(s.currentMessage.userInputMessage.userInputMessageContext.tools).toEqual([
    { toolSpecification: { name: "Bash", description: "Run a command", inputSchema: { json: claudeCode.tools[0].input_schema } } },
  ])
})

test("a marked tool is followed by a cachePoint, as magpie marks the last tool of a translated request", () => {
  const r = {
    system: "You are Codex.",
    messages: [
      { role: "user", content: [{ type: "text", text: "hi", cache_control: EPH }] },
      { role: "assistant", content: [{ type: "text", text: "hello", cache_control: EPH }] },
      { role: "user", content: "and now?" },
    ],
    tools: [
      { name: "a", input_schema: { type: "object", properties: {} } },
      { name: "b", input_schema: { type: "object", properties: {} }, cache_control: EPH },
    ],
  }
  const s = sent(r)
  expect(s.currentMessage.userInputMessage.userInputMessageContext.tools.map((t) => Object.keys(t)[0])).toEqual(["toolSpecification", "toolSpecification", "cachePoint"])
  expect(s.history[0].userInputMessage.cachePoint).toEqual(POINT)
  expect(s.history[1].assistantResponseMessage.cachePoint).toEqual(POINT)
  expect(s.currentMessage.userInputMessage.cachePoint).toBeUndefined()
})

test("nothing marked, nothing sent", () => {
  const s = sent({ messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }, { role: "user", content: "again" }] })
  expect(JSON.stringify(s)).not.toContain("cachePoint")
})

test("at most 4, the last ones kept", () => {
  const msgs = []
  for (let i = 0; i < 6; i++) {
    msgs.push({ role: "user", content: [{ type: "text", text: "q" + i, cache_control: EPH }] })
    msgs.push({ role: "assistant", content: "a" + i })
  }
  msgs.push({ role: "user", content: [{ type: "text", text: "last", cache_control: EPH }] })
  const s = sent({ messages: msgs, tools: [{ name: "t", input_schema: { type: "object", properties: {} }, cache_control: EPH }] })
  const body = JSON.stringify(s)
  expect(body.match(/cachePoint/g).length).toBe(4)
  expect(s.currentMessage.userInputMessage.cachePoint).toEqual(POINT)
  expect(s.currentMessage.userInputMessage.userInputMessageContext.tools.some((t) => t.cachePoint)).toBe(false)
  expect(s.history.filter((e) => e.userInputMessage?.cachePoint).map((e) => e.userInputMessage.content)).toEqual(["q3", "q4", "q5"])
})
