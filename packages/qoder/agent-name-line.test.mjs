// Qoder CN parks a request whose system prompt holds another agent's name
// and then a comma ("You are ZCode, an interactive agent", "You are Codex,
// based on GPT-5.") in the 10605 queue that never moves; the same words as
// two sentences are answered at once (duiniwukenaihe's bisect on #1667).
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { qoderBody, nameAlone, SITES } = _internal
const m = { key: "hmodel", name: "HungerG" }
const sent = (chat, site) => {
  const body = qoderBody(chat, m, "", undefined, site)
  expect(body.messages[0].content[0].text).toBe(body.system[0].text)
  return body.system[0].text
}

test("ZCode's and Codex's openers go to Qoder as two sentences, the user's words as written", () => {
  for (const [given, want] of [
    ["You are ZCode, an interactive agent", "You are ZCode. You are an interactive agent"],
    ["You are Codex, based on GPT-5.", "You are Codex. You are based on GPT-5."],
  ]) {
    const chat = {
      model: "hmodel",
      messages: [
        { role: "system", content: given + "\n\nYou are an agent working with the user toward their goals." },
        { role: "user", content: given + " hi" },
      ],
    }
    const text = sent(chat)
    expect(text).not.toContain(given)
    expect(text).toContain(want + "\n\nYou are an agent working with the user toward their goals.")
    expect(JSON.stringify(qoderBody(chat, m).messages.slice(1))).toContain(given + " hi")
    // QwenWork, on the same protocol, gets the same
    const qw = Object.values(SITES).find((s) => s?.systemPrompt)
    if (qw) expect(sent(chat, qw)).not.toContain(given)
  }
})

test("the name is any capitalized one before a comma and a phrase that describes it", () => {
  // the table's parked forms
  expect(nameAlone("You are ZCode, an interactive agent.")).toBe("You are ZCode. You are an interactive agent.")
  expect(nameAlone("Hello. You are ZCode, an interactive, agent")).toBe("Hello. You are ZCode. You are an interactive, agent")
  expect(nameAlone("You are Kimi Code, an interactive general AI agent running on a user's computer.")).toBe("You are Kimi Code. You are an interactive general AI agent running on a user's computer.")
  expect(nameAlone("You are ChatGPT, a large language model trained by OpenAI.")).toBe("You are ChatGPT. You are a large language model trained by OpenAI.")
  // once is enough
  expect(nameAlone(nameAlone("You are ZCode, an interactive agent"))).toBe("You are ZCode. You are an interactive agent")
  // left as written: forms that were answered, Qoder's own names, and a
  // comma that doesn't start a description
  for (const s of [
    "You are ZCode. You are an interactive agent",
    "You are opencode, an interactive agent",
    "You are a helpful assistant.",
    "You are an AI agent, powered by DeepSeek Harness.",
    "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
    "You are Qoder, an AI coding assistant.",
    "You are Lingma, an intelligent coding assistant.",
    "You are Dev, and you answer briefly.",
    "If you are ZCode, an agent, say so.",
  ]) expect(nameAlone(s)).toBe(s)
})
