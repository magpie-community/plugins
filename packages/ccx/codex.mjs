// Codex threads, read through Codex's own app-server: the same JSON-RPC
// interface the Codex desktop app talks to, over the `codex` CLI the app
// bundles. No thread format is parsed here and no code of ours sits in the
// read path — the vendor's own API answers.
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const APP_BUNDLES = [
  "/Applications/ChatGPT.app",
  "/Applications/Codex.app",
  `${homedir()}/Applications/ChatGPT.app`,
  `${homedir()}/Applications/Codex.app`,
]

// The CLI bundled inside the Codex app, so the threads it answers are the
// ones that app writes and the formats match.
export function codexBin(env = process.env) {
  if (env.CCX_CODEX_BIN) return env.CCX_CODEX_BIN
  for (const app of APP_BUNDLES) {
    const bin = join(app, "Contents/Resources/codex-cli/bin/codex")
    if (existsSync(bin)) return bin
  }
  return "codex"
}

export const NO_CODEX =
  "Codex not found. These tools read Codex threads through the Codex desktop app's own CLI: install the Codex app, or set CCX_CODEX_BIN to the codex binary."

class AppServer {
  constructor(bin, env) {
    this.p = spawn(bin, ["app-server"], { env, stdio: ["pipe", "pipe", "ignore"] })
    this.id = 0
    this.buffer = ""
    this.waiting = new Map()
    this.p.stdout.on("data", (chunk) => this.onData(chunk))
    this.p.on("error", (err) => this.failAll(err))
  }

  onData(chunk) {
    this.buffer += chunk.toString()
    let at
    while ((at = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, at)
      this.buffer = this.buffer.slice(at + 1)
      if (!line.trim()) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.id === undefined) continue
      const waiter = this.waiting.get(msg.id)
      if (!waiter) continue
      this.waiting.delete(msg.id)
      if (msg.error) waiter.reject(new Error(msg.error?.message || String(msg.error)))
      else waiter.resolve(msg.result || {})
    }
  }

  failAll(err) {
    for (const waiter of this.waiting.values()) waiter.reject(err)
    this.waiting.clear()
  }

  request(method, params, timeout = 60000) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error(`Codex ${method} timed out`))
      }, timeout)
      this.waiting.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      this.p.stdin.write(JSON.stringify({ id, method, params }) + "\n")
    })
  }

  close() {
    try {
      this.p.kill()
    } catch {
      // already gone
    }
  }
}

let server = null

async function appServer(env = process.env) {
  if (server) return server
  const bin = codexBin(env)
  server = new AppServer(bin, env)
  try {
    await server.request("initialize", {
      clientInfo: { name: "magpie-tools-ccx", version: "0.2.0" },
      capabilities: { experimentalApi: true },
    })
    server.p.stdin.write(JSON.stringify({ method: "initialized" }) + "\n")
  } catch (err) {
    server.close()
    server = null
    if (err?.code === "ENOENT") throw new Error(NO_CODEX)
    throw err
  }
  return server
}

export function closeServer() {
  server?.close()
  server = null
}

const firstLine = (text, n = 60) => {
  const t = String(text ?? "").trim()
  return t ? t.split("\n")[0].slice(0, n) : ""
}

const titleOf = (t) => firstLine(t?.name || t?.preview || "")

export async function listSessions({ cwd, query } = {}) {
  const s = await appServer()
  const params = { limit: 100, sortKey: "updated_at", sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"] }
  if (cwd) params.cwd = cwd
  if (query) params.searchTerm = query
  const res = await s.request("thread/list", params)
  return (res.data || [])
    .filter((t) => !t.ephemeral && titleOf(t))
    .map((t) => ({
      id: t.id,
      title: titleOf(t),
      cwd: t.cwd || "",
      mtime: (t.updatedAt || 0) * 1000,
      path: t.path || "",
    }))
}

export async function findSession(id) {
  const s = await appServer()
  const res = await s.request("thread/read", { threadId: id, includeTurns: false })
  const t = res.thread
  if (!t) throw new Error(`Codex session ${id} not found`)
  return { id: t.id, title: titleOf(t), cwd: t.cwd || "" }
}

// The thread as condensed text: what the person asked, what the model said,
// and what each tool call did and returned.
export function condenseTurns(turns, { max = 6000 } = {}) {
  const lines = []
  for (const turn of turns || []) {
    for (const item of turn.items || []) {
      if (item.type === "userMessage") {
        const t = (item.content || [])
          .filter((c) => c?.type === "text" && typeof c.text === "string")
          .map((c) => c.text)
          .join("\n")
        if (t.trim()) lines.push(`[user] ${t.trim()}`)
      } else if (item.type === "agentMessage") {
        if (item.phase === "final_answer" && item.text?.trim()) lines.push(`[assistant] ${item.text.trim()}`)
      } else if (item.type === "reasoning") {
        const summary = (item.summary || []).join(" ")
        if (summary.trim()) lines.push(`[thinking] ${firstLine(summary, 300)}`)
      } else if (item.type === "commandExecution") {
        lines.push(`[tool] ${firstLine(item.command || "", 300)}`)
      } else if (item.type === "functionCall" || item.type === "mcpToolCall") {
        lines.push(`[tool] ${item.name || "call"} ${firstLine(JSON.stringify(item.arguments ?? item.input ?? {}), 300)}`)
      } else if (item.type === "functionCallOutput" || item.type === "mcpToolCallOutput") {
        lines.push(`[tool result] ${firstLine(item.output ?? "", 400)}`)
      } else if (item.type === "fileChange") {
        lines.push(`[file change] ${firstLine(JSON.stringify(item.changes ?? item.paths ?? ""), 300)}`)
      }
    }
  }
  return lines.join("\n")
}

export async function readSession(id, { offset = 0 } = {}) {
  const s = await appServer()
  const res = await s.request("thread/read", { threadId: id, includeTurns: true })
  const t = res.thread
  if (!t) throw new Error(`Codex session ${id} not found`)
  const text = condenseTurns(t.turns)
  const slice = text.slice(offset, offset + 6000)
  const next = offset + slice.length
  return {
    title: titleOf(t),
    cwd: t.cwd || "",
    text: slice,
    offset,
    next_offset: next,
    total_chars: text.length,
  }
}
