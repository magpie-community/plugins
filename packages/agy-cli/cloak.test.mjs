// cloak.mjs began as a copy of packages/antigravity's TURNED_AWAY, cloak and
// hint (#980) and its REWORDED (#1028). antigravity 0.2.0 sends nothing any
// more, so cloak.mjs is the one copy now.
import { expect, test } from "bun:test"
import { REWORDED, TURNED_AWAY, cloak, cloakUser, hint, outgoing, turnsAway } from "./cloak.mjs"

const ZW = "​"

const samples = [
  "x-anthropic-billing-header: cc_version=2.1.0.abc; cc_entrypoint=cli; cch=1a2b3;",
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  "You are Codex, an agent based on GPT-5. You are running as a coding agent.",
  "You are Codex, a coding agent based on GPT-5.",
  "You are Hermes Agent, an intelligent AI assistant created by Nous Research.",
  "RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.\n\nYou are omp.",
  "Two: RFC 2119 KEYWORDS: must, required, should, recommended, may, optional. and x-anthropic-billing-header: x",
  "RFC 2119 keywords: MUST, REQUIRED,\r\nSHOULD, RECOMMENDED, MAY, OPTIONAL.\r\n",
  "<conventions>\nRFC 2119\nkeywords:\tMUST,  REQUIRED, SHOULD, RECOMMENDED, MAY,\u00a0OPTIONAL.\n</conventions>",
  "You are Hermes Agent, an intelligent\nAI assistant created by Nous Research.",
  "RFC 2119 keywords: MUST,REQUIRED,SHOULD,RECOMMENDED,MAY,OPTIONAL.",
  "You are Hermes Agent, built by Nous Research.",
  "You are OpenCode, a coding agent that helps users with software engineering tasks.",
  "You are opencode, an interactive CLI tool that helps users with software engineering tasks.",
  "You are OpenCode, the best coding agent on the planet.",
  "You are a coding agent running in the Codex CLI, a terminal-based coding assistant. Codex CLI is an open source project led by OpenAI. You are expected to be precise, safe, and helpful.",
  "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.",
  "You are an AI agent powered by DeepSeek Harness.\n\nYou can read files.",
  "Codex's GPT-6 prompt goes as written: You are Codex, an agent based on GPT-6.",
  "You're Hermes Agent, an intelligent AI assistant created by Nous Research.",
  "Nothing to see here; Claude Agent SDK alone is fine.",
  "",
]

test("every turned-away line is reworded, with no invisible character in it", () => {
  for (const s of samples) {
    const out = cloak(s)
    expect(out).not.toMatch(/[\u00ad\u200b-\u200f\u2060-\u2064]/)
    if (turnsAway(s)) {
      expect(out).not.toBe(s)
      expect(turnsAway(out)).toBe(false)
    } else {
      expect(out).toBe(s)
    }
  }
  expect(cloak("RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.")).toBe(
    "RFC 2119 key words: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.",
  )
})

test("a turned-away line wrapped or widened by white space is reworded too", () => {
  for (const s of [samples[7], samples[8], samples[9]]) {
    expect(turnsAway(s)).toBe(true)
    expect(cloak(s)).not.toBe(s)
    expect(turnsAway(cloak(s))).toBe(false)
  }
  expect(hint(samples[8])).toContain("oh-my-pi (omp)")
  expect(turnsAway(samples[10])).toBe(false)
})

test("a turned-away line broken up by invisible characters is reworded too", () => {
  for (const line of [...TURNED_AWAY, ...samples.filter((s) => turnsAway(s)).map((s) => s.replace(/[A-Za-z0-9]{3,}/g, (w) => w[0] + ZW + w[1] + ZW + w.slice(2)))]) {
    expect(turnsAway(line)).toBe(true)
    expect(turnsAway(cloak(line))).toBe(false)
  }
})

const DSH = "Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. @\"...\" quotes a path containing spaces."

test("DeepSeek Harness's @-path paragraph goes reworded, the rest as written (#1028)", () => {
  const sys = "You are DeepSeek Harness.\n\n" + DSH + "\n\nBe brief."
  expect(outgoing(sys)).toBe("You are DeepSeek Harness.\n\nWhen the user writes @ followed by a path, they are pointing at that file or folder. Relative paths start at the workspace root; absolute paths are host paths. A path ending in a slash is a folder, so list it if its contents matter; otherwise it is a file, so open it with the read tool before relying on it. Paths with spaces appear as @\"...\".\n\nBe brief.")
  expect(outgoing("Tokens prefixed with @ are paths. Be brief.")).toBe("Tokens prefixed with @ are paths. Be brief.")
  const both = outgoing("x-anthropic-billing-header: cc\n" + DSH)
  expect(both).not.toContain("anthropic")
  expect(both).toContain("When the user writes @ followed by a path")
})

test("each reworded paragraph goes as REWORDED says", () => {
  for (const [from, to] of REWORDED) expect(outgoing(from)).toBe(to)
})

test("a user's turn goes with Codex's GPT-5 lines reworded, the others as written", () => {
  expect(cloakUser("Read AGENTS.md:\nYou are Codex, a coding agent based on GPT-5.")).toBe("Read AGENTS.md:\nYou are Codex, a coding agent built on GPT-5.")
  expect(cloakUser("You are Hermes Agent, built by Nous Research.")).toBe("You are Hermes Agent, built by Nous Research.")
})

test("DeepSeek Harness's first line goes as \"You're …\", and the variants that went through as written (#1171)", () => {
  expect(cloak("You are an AI agent powered by DeepSeek Harness.\n\nBe brief.")).toBe("You're an AI agent powered by DeepSeek Harness.\n\nBe brief.")
  expect(hint("You are an AI agent powered by DeepSeek Harness.")).toContain("DeepSeek Harness's system prompt")
  for (const s of ["You are an AI agent powered by DeepSeek.", "You are an agent powered by DeepSeek Harness.", "You're an AI agent powered by DeepSeek Harness."]) expect(cloak(s)).toBe(s)
})
