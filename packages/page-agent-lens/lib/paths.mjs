// Where Agent Lens reads and writes. Both the hook and the service resolve
// paths here, so they always agree.
import { homedir } from "node:os"
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
  const dir = options.dataDir ? resolve(options.dataDir) : join(magpieDir(), "agent-lens")
  return join(dir, "tools.jsonl")
}
