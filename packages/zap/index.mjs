// Bun host part of magpie-agent-zap: mirrors the outbox magpie manages
// (~/.zap/magpie-bridge.json) into Zap's ~/.zap/settings.toml. Polls both
// files and rewrites only when something drifted, so a Zap-side save of
// settings.toml is put back on the next tick, and a disconnect removes the
// provider again.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { reconcileToml } from "./toml.mjs"

const zapDir = join(homedir(), ".zap")
const OUTBOX = join(zapDir, "magpie-bridge.json")
const TOML = join(zapDir, "settings.toml")
const STATE = join(zapDir, "magpie-bridge.state.json")

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

function readText(path) {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return ""
  }
}

function writeAtomic(path, text) {
  const tmp = `${path}.magpie-${process.pid}`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

function tick(log) {
  const outbox = readJson(OUTBOX)
  if (outbox === undefined && existsSync(OUTBOX)) return // half-written; next tick
  const connected = outbox && Object.keys(outbox.models || {}).length > 0
  const state = readJson(STATE) || {}
  const { text, state: nextState, changed } = reconcileToml(readText(TOML), connected ? outbox : null, state)
  if (changed) {
    writeAtomic(TOML, text)
    log(`settings.toml: ${connected ? `magpie provider synced (${Object.keys(outbox.models).length} models)` : "magpie provider removed"}`)
  }
  const before = JSON.stringify(state)
  const after = JSON.stringify(nextState)
  if (before !== after) {
    if (Object.keys(nextState).length === 0) {
      rmSync(STATE, { force: true })
    } else {
      writeAtomic(STATE, after)
    }
  }
}

export default {
  id: "magpie-agent-zap",
  server: async () => {
    const log = (msg) => console.log(`[agent-zap] ${msg}`)
    tick(log)
    const timer = setInterval(() => {
      try {
        tick(log)
      } catch (err) {
        log(`tick failed: ${err?.message || err}`)
      }
    }, 1500)
    if (timer.unref) timer.unref()
    return {}
  },
}
