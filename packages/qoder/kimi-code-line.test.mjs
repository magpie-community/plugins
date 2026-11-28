// Qoder CN queues a system prompt that opens with Kimi Code's identity in
// the same 10605 / p2 / RESOURCE_LIMIT queue as DeepSeek Harness's opener;
// the same request with a neutral opening answers at once. Kimi Code Desktop
// sends exactly this line, so its Kimi K3.1 Pro calls never started.
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { qoderBody, neutralKimi, SITES } = _internal
const KIMI = "You are Kimi Code, an interactive general AI agent running on a user's computer."
const NEUTRAL = "You are a coding agent, an interactive general AI agent running on a user's computer."
const m = { key: "kmodel_latest", config: { key: "kmodel_latest", display_name: "Kimi-K3.1-Pro", max_input_tokens: 1_000_000 } }
const sent = (chat, site) => {
  const body = qoderBody(chat, m, "", undefined, site)
  expect(body.messages[0].content[0].text).toBe(body.system[0].text)
  return body.system[0].text
}

test("Kimi Code's identity line goes to Qoder as a coding agent, the rest as written", () => {
  const chat = {
    model: "kmodel_latest",
    messages: [
      { role: "system", content: KIMI + "\n\nYour primary goal is to help users with software engineering tasks." },
      { role: "user", content: KIMI + " hi" },
    ],
  }
  const text = sent(chat)
  expect(text).not.toContain("You are Kimi Code")
  expect(text).toContain(NEUTRAL + "\n\nYour primary goal is to help users with software engineering tasks.")
  // the user's own words go as written
  expect(JSON.stringify(qoderBody(chat, m).messages.slice(1))).toContain(KIMI + " hi")
  // later mentions of Kimi Code are not the identity line
  const later = KIMI + "\n\nThe Kimi Code desktop app renders Markdown."
  expect(sent({ messages: [{ role: "system", content: later }, { role: "user", content: "hi" }] })).toContain("The Kimi Code desktop app renders Markdown.")
  // QwenWork, on the same protocol, gets the same swap
  const qw = Object.values(SITES).find((s) => s?.systemPrompt)
  if (qw) expect(sent(chat, qw)).not.toContain("You are Kimi Code")
})

test("the identity is matched only at a line's start, case-insensitively, and the rest stays", () => {
  expect(neutralKimi(KIMI)).toBe(NEUTRAL)
  expect(neutralKimi("you are kimi code.")).toBe("You are a coding agent.")
  expect(neutralKimi("You are Kimi, an interactive general AI agent.")).toBe("You are a coding agent, an interactive general AI agent.")
  expect(neutralKimi("You are Kimi Code.\nBe brief.")).toBe("You are a coding agent.\nBe brief.")
  expect(neutralKimi("  You are Kimi Code.  ")).toBe("  You are a coding agent.  ")
  expect(neutralKimi("\nYou are Kimi Code.")).toBe("\nYou are a coding agent.")
  expect(neutralKimi(neutralKimi(KIMI))).toBe(NEUTRAL)
  for (const s of [NEUTRAL, "The Kimi Code desktop app renders Markdown.", "You are not Kimi Code.", "Ask Kimi Code."]) expect(neutralKimi(s)).toBe(s)
})
