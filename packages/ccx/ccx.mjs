// Runs the ccx command (github.com/aaronwong1999/ccx) without a shell.
// ccx keeps Claude Code sessions and Codex threads on this computer linked;
// these helpers only ask it to read.
import { execFile } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const APPS = ["claude", "codex"]
export const NAME = { claude: "Claude Code", codex: "Codex" }
// ccx's tools are named from the conversation they run in: asking the Codex
// side lists Claude sessions, and the other way round
const ASK = { claude: "codex", codex: "claude" }
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,79}$/

export const ccxPath = (env = process.env) => env.CCX_BIN || join(env.HOME || homedir(), ".local", "bin", "ccx")

export function installed(env = process.env) {
  try {
    accessSync(ccxPath(env), constants.X_OK)
    return true
  } catch {
    return false
  }
}

const NOT_INSTALLED =
  "ccx isn't installed on this computer. It runs on macOS next to Claude Code and/or Codex: " +
  "curl -fsSL https://raw.githubusercontent.com/aaronwong1999/ccx/main/install.sh | sh (see github.com/aaronwong1999/ccx)"

export function run(args, { env = process.env, signal, timeout = 50_000 } = {}) {
  if (!installed(env)) return Promise.reject(new Error(NOT_INSTALLED))
  return new Promise((resolve, reject) => {
    execFile(ccxPath(env), args, { env: { PATH: env.PATH ?? "/usr/bin:/bin", HOME: env.HOME ?? homedir() }, timeout, signal, maxBuffer: 8 << 20 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || stdout || err.message).trim().replace(/^✗ /, "") || `ccx failed: ${err.message}`))
        else resolve(String(stdout))
      })
  })
}

export function app(v) {
  if (!APPS.includes(v)) throw new Error(`app is "claude" or "codex"`)
  return v
}

export function sessionId(v) {
  if (typeof v !== "string" || !SESSION_ID.test(v)) throw new Error("session_id is a Claude Code session id or a Codex thread id")
  return v
}

export function folder(v) {
  if (typeof v !== "string" || !v.startsWith("/")) throw new Error("cwd is an absolute path")
  return v
}

export const sessionsArgs = (a, cwd, query) =>
  ["call", ASK[a], "list_sessions", "-C", cwd, ...(query ? ["--query", query] : [])]

export const readArgs = (a, id, offset) =>
  ["call", ASK[a], "read_session", "--session-id", id, "--offset", String(offset)]
