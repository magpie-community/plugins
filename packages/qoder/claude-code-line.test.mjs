// Qoder answers a system prompt that opens with Claude Code's identity line
// with 400 "Cannot find model"; the same request with only that line
// swapped for the Claude Agent SDK's goes through (ByFanX on X, 11-24).
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { qoderBody, asAgentSDK, harnessComma, SITES } = _internal
const CC = "You are Claude Code, Anthropic's official CLI for Claude."
const SDK = "You are a Claude agent, built on Anthropic's Claude Agent SDK."
const m = { key: "glm-5.4", name: "GLM-5.4" }
const sent = (chat, site) => {
  const body = qoderBody(chat, m, "", undefined, site)
  expect(body.messages[0].content[0].text).toBe(body.system[0].text)
  return body.system[0].text
}

test("Claude Code's identity line goes to Qoder as the Agent SDK's, the rest as written", () => {
  const chat = {
    model: "glm-5.4",
    messages: [
      { role: "system", content: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.80; cc_entrypoint=cli;" }, { type: "text", text: CC }, { type: "text", text: "\nYou are an interactive agent that helps users with software engineering tasks." }] },
      { role: "user", content: "You are Claude Code, Anthropic's official CLI for Claude. hi" },
    ],
  }
  const text = sent(chat)
  expect(text).not.toContain("You are Claude Code")
  expect(text).toContain(SDK + "\nYou are an interactive agent that helps users with software engineering tasks.")
  expect(text).toContain("x-anthropic-billing-header: cc_version=2.1.80; cc_entrypoint=cli;")
  // the user's own words go as written
  expect(JSON.stringify(qoderBody(chat, m).messages.slice(1))).toContain("You are Claude Code, Anthropic's official CLI for Claude. hi")
  // QwenWork, on the same protocol, gets the same swap
  const qw = Object.values(SITES).find((s) => s?.systemPrompt)
  if (qw) expect(sent(chat, qw)).not.toContain("You are Claude Code")
})

test("the SDK form and other white space are swapped; other prompts are left alone", () => {
  expect(asAgentSDK(CC.replace(".", ", running within the Claude Agent SDK."))).toBe(SDK)
  expect(asAgentSDK("You are Claude Code,\nAnthropic's  official CLI for Claude.\n\nBe brief.")).toBe(SDK + "\n\nBe brief.")
  for (const s of [SDK, "You are a coding agent.", "Claude Code is Anthropic's official CLI for Claude."]) expect(asAgentSDK(s)).toBe(s)
})

// plugins#1517, #1220: Qoder CN queues a system prompt holding DeepSeek
// Harness's opener, as written, in a queue that never moves; a comma before
// "powered by" passes (lirenQa1's bisect on #1220, the reporter's literal line).
const DSH = "You are an AI agent powered by DeepSeek Harness."
test("DeepSeek Harness's opener goes to Qoder with a comma, the name kept and the user's words as written", () => {
  const chat = {
    model: "dfmodel",
    messages: [
      { role: "developer", content: DSH + "\n\nBe brief." },
      { role: "user", content: DSH + " hi" },
    ],
  }
  const text = sent(chat)
  expect(text).not.toContain(DSH)
  expect(text).toContain("You are an AI agent, powered by DeepSeek Harness.\n\nBe brief.")
  expect(JSON.stringify(qoderBody(chat, m).messages.slice(1))).toContain(DSH + " hi")
  const parts = sent({ model: "dfmodel", messages: [{ role: "system", content: [{ type: "text", text: DSH }] }, { role: "user", content: "hi" }] })
  expect(parts).toContain("You are an AI agent, powered by DeepSeek Harness.")
  expect(harnessComma(harnessComma(DSH))).toBe("You are an AI agent, powered by DeepSeek Harness.")
  for (const s of ["You are a helpful assistant.", "You are a Qoder agent. Use the instructions below.", "This agent is powered by DeepSeek Harness."]) expect(harnessComma(s)).toBe(s)
})
