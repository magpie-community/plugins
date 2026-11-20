// Claude Code conversations, read from the plain JSONL the app writes under
// ~/.claude/projects/<project>/. The format is the app's own: one JSON
// record per line, the messages in `message.content` (a string for a user
// turn, a list of blocks for an assistant turn). Nothing here runs another
// program, so the code that reads the transcripts is this file and is
// reviewed with it.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const CLAUDE_HOME = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")
export const PROJECTS = () => join(CLAUDE_HOME(), "projects")

// The app files a session under the folder it was started in, with every
// character outside A-Z a-z 0-9 replaced by a dash.
export const projectDir = (cwd) => join(PROJECTS(), String(cwd ?? "").replace(/[^A-Za-z0-9]/g, "-"))

const readLines = (file) => {
  let raw
  try {
    raw = readFileSync(file, "utf8")
  } catch {
    return []
  }
  const out = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // A half-written line at the end of a session the app is still using.
    }
  }
  return out
}

const textOf = (content) => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
}

// Blocks the app injects around what the person actually wrote: they are
// not the person's words, so they do not belong in a summary of the task.
const DROP = [
  "system-reminder",
  "environment_context",
  "user_instructions",
  "local-command-stdout",
  "local-command-stderr",
  "local-command-caveat",
  "command-message",
  "app-context",
  "ide_opened_file",
  "ide_selection",
  "collaboration_mode",
  "skills_instructions",
]
const KEEP_INNER = ["pasted_content", "cross-session-message", "command-name", "command-args"]

export function userText(text) {
  let t = String(text ?? "")
  for (const tag of DROP) {
    t = t.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}(?:\\s[^>]*)?>`, "g"), "")
  }
  for (const tag of KEEP_INNER) {
    t = t.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}(?:\\s[^>]*)?>`, "g"), "$1 ")
  }
  t = t.replace(/\A(\/[\w:-]+)\s+/, "$1 ").trim()
  if (t.startsWith("# AGENTS.md") || t.startsWith("# Context from my IDE") || t.startsWith("<INSTRUCTIONS>")) return ""
  return t
}

export const firstLine = (text, n = 60) => {
  const t = String(text ?? "").trim()
  return t ? t.split("\n")[0].slice(0, n) : ""
}

// The title the app gave the session, or the first thing the person wrote.
export function titleOf(records) {
  let title = ""
  for (const d of records) {
    if (d?.type === "custom-title") title = d.customTitle || d.title || title
  }
  if (title) return firstLine(title)
  for (const d of records) {
    if (d?.type === "user" && !d.isMeta) {
      const t = userText(textOf(d.message?.content))
      if (t) return firstLine(t)
    }
  }
  return ""
}

// The folder the session belongs to: the app files it under the project it
// was started in, and every record carries the folder the shell was in.
export function cwdOf(records, folder) {
  const cwds = []
  for (const d of records) {
    const c = d?.cwd
    if (c && cwds[cwds.length - 1] !== c) cwds.push(c)
  }
  return cwds.find((c) => projectDir(c).split("/").pop() === folder.split("/").pop()) || cwds[cwds.length - 1] || ""
}

export function listSessions({ cwd, query } = {}) {
  let folders
  try {
    folders = readdirSync(PROJECTS(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
  const out = []
  for (const folder of folders) {
    let files
    try {
      files = readdirSync(join(PROJECTS(), folder)).filter((f) => f.endsWith(".jsonl"))
    } catch {
      continue
    }
    for (const name of files) {
      const file = join(PROJECTS(), folder, name)
      let mtime
      try {
        mtime = statSync(file).mtimeMs
      } catch {
        continue
      }
      const records = readLines(file)
      const title = titleOf(records)
      if (!title) continue
      const sessionCwd = cwdOf(records, folder)
      if (cwd && sessionCwd && sessionCwd !== cwd) continue
      if (query && !title.toLowerCase().includes(String(query).toLowerCase())) continue
      out.push({ id: name.replace(/\.jsonl$/, ""), title, cwd: sessionCwd, mtime, file })
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

export function findSession(id) {
  let folders
  try {
    folders = readdirSync(PROJECTS(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return null
  }
  const hits = []
  for (const folder of folders) {
    let files
    try {
      files = readdirSync(join(PROJECTS(), folder)).filter((f) => f.endsWith(".jsonl"))
    } catch {
      continue
    }
    for (const name of files) {
      if (!name.startsWith(id)) continue
      const file = join(PROJECTS(), folder, name)
      const records = readLines(file)
      hits.push({ id: name.replace(/\.jsonl$/, ""), title: titleOf(records), cwd: cwdOf(records, folder), file })
    }
  }
  return hits.length === 1 ? hits[0] : null
}

// The conversation as condensed text: what the person asked, what the model
// said, and what each tool call did, so another agent can pick the task up
// without the conversation being read line by line.
export function condense(records, { max = 6000 } = {}) {
  const lines = []
  for (const d of records) {
    if (d?.type === "user") {
      if (d.isMeta) continue
      const content = d.message?.content
      if (typeof content === "string") {
        const t = userText(content)
        if (t) lines.push(`[user] ${t}`)
      } else if (Array.isArray(content)) {
        const t = userText(textOf(content))
        if (t) lines.push(`[user] ${t}`)
        for (const b of content) {
          if (b?.type !== "tool_result") continue
          const out = typeof b.content === "string" ? b.content : textOf(b.content)
          lines.push(`[tool result] ${firstLine(out, 400)}`)
        }
      }
    } else if (d?.type === "assistant") {
      const content = d.message?.content
      if (!Array.isArray(content)) continue
      const t = textOf(content)
      if (t.trim()) lines.push(`[assistant] ${t.trim()}`)
      for (const b of content) {
        if (b?.type !== "tool_use") continue
        lines.push(`[tool] ${b.name} ${firstLine(JSON.stringify(b.input ?? {}), 300)}`)
      }
    }
  }
  return lines.join("\n")
}

export function readSession(id, { offset = 0 } = {}) {
  const session = findSession(id)
  if (!session) throw new Error(`Claude session ${id} not found`)
  const text = condense(readLines(session.file))
  const slice = text.slice(offset, offset + 6000)
  const next = offset + slice.length
  return {
    title: session.title,
    cwd: session.cwd,
    text: slice,
    offset,
    next_offset: next,
    total_chars: text.length,
  }
}
