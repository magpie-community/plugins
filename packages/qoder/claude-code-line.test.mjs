// Qoder answers a system prompt that opens with Claude Code's identity line
// with 400 "Cannot find model"; the same request with only that line
// swapped for the Claude Agent SDK's goes through (ByFanX on X, 11-24).
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { qoderBody, asAgentSDK, SITES } = _internal
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
