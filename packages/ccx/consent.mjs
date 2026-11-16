// What the user has allowed this package to read.
//
// The transcripts these tools return are sent to whichever model reads them
// through magpie's MCP server. So the package asks first, and the answer is
// kept in a state file of its own: nothing is listed and nothing is read
// until the user allows that project (or that one conversation).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const stateFile = () => join(homedir(), ".config", "magpie", "tools-ccx.json")

const read = () => {
  try {
    const d = JSON.parse(readFileSync(stateFile(), "utf8"))
    return { projects: Array.isArray(d?.projects) ? d.projects : [], conversations: Array.isArray(d?.conversations) ? d.conversations : [] }
  } catch {
    return { projects: [], conversations: [] }
  }
}

export function write(state) {
  const file = stateFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ projects: state.projects ?? [], conversations: state.conversations ?? [] }, null, 2))
}

export const getState = read

export function allowProject(cwd) {
  const state = read()
  if (!state.projects.includes(cwd)) state.projects.push(cwd)
  write(state)
  return state
}

export function allowConversation(id) {
  const state = read()
  if (!state.conversations.includes(id)) state.conversations.push(id)
  write(state)
  return state
}

export function isAllowed({ cwd, id }) {
  const state = read()
  if (id && state.conversations.includes(id)) return true
  if (cwd && state.projects.includes(cwd)) return true
  return false
}

// What to tell the user when the tools are not allowed to read yet: the
// projects and conversations on offer, and the one command that allows one.
export const INSTRUCTIONS =
  "These tools read your Claude Code and Codex conversations, and what they return is sent to the model that asks for it. " +
  "Nothing is read until you allow it. To allow a project, run:\n" +
  "  magpie plugin allow-ccx project <folder>\n" +
  "To allow a single conversation, run:\n" +
  "  magpie plugin allow-ccx conversation <id>\n" +
  "Allowed projects and conversations are kept in " +
  stateFile()

export function notAllowed(candidates) {
  const lines = []
  if (candidates?.length) {
    lines.push("Not allowed yet. On this Mac:")
    for (const c of candidates.slice(0, 10)) lines.push(`  ${c.cwd || "(no folder)"}  ·  ${c.title}`)
  }
  return [INSTRUCTIONS, ...lines].join("\n")
}

export const hasState = () => existsSync(stateFile())
