// Where HarnessWeight reads and writes. Both the hook and the service resolve
// paths here, so they always agree.
import { homedir } from "node:os"
import { existsSync, renameSync } from "node:fs"
import { join, resolve } from "node:path"

// magpie keeps its files under $XDG_CONFIG_HOME/magpie, ~/.config/magpie by default.
export function magpieDir() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(base, "magpie")
}

// magpie's own usage ledger: one JSON line per gateway request.
export function usageLog(options = {}) {
  return options.usageLog ? resolve(options.usageLog) : join(magpieDir(), "usage.jsonl")
}

// The tool-weight samples the hook writes. Kept outside the plugin's folder
// so a reinstall or an update does not wipe them.
export function toolsLog(options = {}) {
  if (options.dataDir) return join(resolve(options.dataDir), "tools.jsonl")
  const dir = join(magpieDir(), "harnessweight")
  // the plugin was called Agent Lens until 0.4.0: carry its samples over once
  const old = join(magpieDir(), "agent-lens")
  if (!existsSync(dir) && existsSync(old)) {
    try { renameSync(old, dir) } catch { return join(old, "tools.jsonl") }
  }
  return join(dir, "tools.jsonl")
}
