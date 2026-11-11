// Where HarnessWeight reads and writes. Both the hook and the service resolve
// paths here, so they always agree.
import { homedir } from "node:os"
import { existsSync, realpathSync, renameSync } from "node:fs"
import { dirname, isAbsolute, join, parse, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

// One directory, one string. The host may name the config dir through
// input.directory while the hook sees it as its cwd; a symlinked path
// (/var -> /private/var on macOS) would otherwise give the two different
// spellings of the same disk directory. Resolve symlinks as far as the
// directory exists, so both sides name it identically.
function canonical(dir) {
  const path = resolve(dir)
  try {
    return realpathSync(path)
  } catch { /* not created yet: canonicalize the nearest existing parent */ }
  const parts = []
  let current = path
  for (;;) {
    const parent = dirname(current)
    if (parent === current) return path
    parts.unshift(parse(current).base)
    try {
      return join(realpathSync(parent), ...parts)
    } catch { /* keep walking up */ }
    current = parent
  }
}

// The host passes its config directory to server() and also starts the hook
// there. Probe cwd for the hook; standalone launches fall back to XDG/home.
export function magpieDir(options = {}) {
  if (options.directory) return canonical(options.directory)
  try {
    const cwd = process.cwd()
    if (cwd !== ROOT && ["usage.jsonl", "plugins.json", "providers.json"].some((f) => existsSync(join(cwd, f)))) return canonical(cwd)
  } catch { /* cwd may have been removed */ }
  const xdg = process.env.XDG_CONFIG_HOME
  return canonical(xdg && isAbsolute(xdg) ? join(xdg, "magpie") : join(homedir(), ".config", "magpie"))
}

// magpie's own usage ledger: one JSON line per gateway request.
export function usageLog(options = {}) {
  return options.usageLog ? resolve(options.usageLog) : join(magpieDir(options), "usage.jsonl")
}

// The tool-weight samples the hook writes. Kept outside the plugin's folder
// so a reinstall or an update does not wipe them.
export function toolsLog(options = {}) {
  if (options.dataDir) return join(canonical(options.dataDir), "tools.jsonl")
  const dir = join(magpieDir(options), "harnessweight")
  // the plugin was called Agent Lens until 0.4.0: carry its samples over once
  const old = join(magpieDir(options), "agent-lens")
  if (!existsSync(dir) && existsSync(old)) {
    try { renameSync(old, dir) } catch {
      // Another host may have completed the same migration concurrently.
      if (!existsSync(dir) && existsSync(old)) return join(old, "tools.jsonl")
    }
  }
  return join(dir, "tools.jsonl")
}
