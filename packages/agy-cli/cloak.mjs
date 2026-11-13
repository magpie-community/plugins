// System prompt lines Antigravity turns away, and paragraphs it answers
// badly, the same lists and the same rewrites as
// packages/antigravity/index.mjs (TURNED_AWAY, breakUp, cloak, hint,
// REWORDED, reword, outgoing). Each package ships on its own, so the code is
// a copy; cloak.test.mjs fails when the two give a different answer.
//
// Antigravity answers a 429 "Resource has been exhausted" to a request whose
// system prompt has one of these lines, whatever quota is left, and lets the
// same prompt through with a zero-width space after the first and second
// character of each word. agy-cli hands the client's system prompt to agy
// (session instructions, or <external_system_instructions> in the prompt),
// and agy sends it to Antigravity as written, so it is broken up here before
// it goes. What the bridge keys sessions on (instructionsIdentity) is the
// prompt as the client wrote it.

// TURNED_AWAY are the lines, lower-cased.
export const TURNED_AWAY = [
  "x-anthropic-billing-header:",
  "built on anthropic's claude agent sdk",
  "you are codex, an agent based on gpt-5",
  "you are codex, a coding agent based on gpt-5",
  "hermes agent, an intelligent ai assistant created by nous research",
  "rfc 2119 keywords: must, required, should, recommended, may, optional.",
]

const ZW = "​"

export function turnsAway(system) {
  const low = String(system ?? "").toLowerCase()
  return TURNED_AWAY.some((l) => low.includes(l))
}

const asciiLower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase())

// breakUp puts a zero-width space after the first and after the second
// character of every run of three or more letters or digits in a line.
// One after the first letter only stopped working on 11-11.
const breakUp = (line) => line.replace(/[A-Za-z0-9]{3,}/g, (w) => w[0] + ZW + w[1] + ZW + w.slice(2))

export function cloak(system) {
  if (typeof system !== "string" || !turnsAway(system)) return system
  const low = asciiLower(system)
  const at = []
  for (const line of TURNED_AWAY) {
    for (let i = 0; ; ) {
      const j = low.indexOf(line, i)
      if (j < 0) break
      at.push([j, j + line.length])
      i = j + line.length
    }
  }
  at.sort((a, b) => a[0] - b[0])
  let out = ""
  let prev = 0
  for (const [from, to] of at) {
    if (from < prev) continue
    out += system.slice(prev, from) + breakUp(system.slice(from, to))
    prev = to
  }
  return out + system.slice(prev)
}

// REWORDED are paragraphs that go through but are answered badly, each with
// a rewording that keeps its meaning. DeepSeek Harness's desktop app puts
// the first in every system prompt; word for word, gemini-4-argon answered
// most requests in about 3s with no thinking and ended after one shallow
// step (antigravity #1028).
export const REWORDED = [
  [
    "Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. @\"...\" quotes a path containing spaces.",
    "When the user writes @ followed by a path, they are pointing at that file or folder. Relative paths start at the workspace root; absolute paths are host paths. A path ending in a slash is a folder, so list it if its contents matter; otherwise it is a file, so open it with the read tool before relying on it. Paths with spaces appear as @\"...\".",
  ],
]

export function reword(system) {
  if (typeof system !== "string") return system
  for (const [from, to] of REWORDED) if (system.includes(from)) system = system.split(from).join(to)
  return system
}

// outgoing is system text as agy is handed it: broken up, then reworded
export const outgoing = (system) => reword(cloak(system))

const HINT =
  "Antigravity answers this 429 to the system prompt of Claude Code and the Claude Agent SDK (Claude Desktop's chats) whatever quota is left, so it is not a quota and waiting won't help; use another provider for these chats, or put one after Antigravity in a routing group"

const CODEX_HINT =
  "Antigravity answers this 429 to Codex's own system prompt for GPT-5 models whatever quota is left, so it is not a quota and waiting won't help; a Codex chat begun on a GPT model keeps that prompt after a model switch or a fork, so start a new chat on this model"
const HERMES_HINT =
  "Antigravity answers this 429 to Hermes Agent's earlier default persona (its SOUL.md) whatever quota is left, so it is not a quota and waiting won't help; Hermes' current default persona goes through, so put it in SOUL.md, or use another provider for these chats"

const RFC_HINT =
  "Antigravity answers this 429 to the line \"RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.\" that starts oh-my-pi (omp)'s system prompt, and to any prompt that has it, whatever quota is left, so it is not a quota and waiting won't help; magpie breaks that line up before it goes, so this one came from a copy of it that was worded another way"

export function hint(system) {
  const low = String(system ?? "").toLowerCase()
  if (low.includes("rfc 2119 keywords: must, required, should, recommended, may, optional.")) return RFC_HINT
  if (low.includes("you are codex, an agent based on gpt-5") || low.includes("you are codex, a coding agent based on gpt-5")) return CODEX_HINT
  if (low.includes("hermes agent, an intelligent ai assistant created by nous research")) return HERMES_HINT
  return HINT
}
