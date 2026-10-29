// Where magpie keeps its own files, decided in exactly one place —
// watch.js and digest.js used to each keep their own rule, and they had
// drifted (one read XDG_CONFIG_DIR, which magpie never reads; neither
// honoured a portable install).
//
// magpie's own rule (internal/appdir): a portable install — a "data"
// folder, or a ".portable" marker, beside the magpie executable — keeps
// everything in that data folder; an installed one keeps them in
// $XDG_CONFIG_HOME/magpie, else ~/.config/magpie. The hook's context
// carries no config dir, so this module finds it another way: a plugin
// installed from the registry lives under the config dir's plugins/
// folder, so walking up from this file to the nearest folder holding one
// of magpie's own files (usage.jsonl, quotas.json, providers.json,
// plugins.json) lands on the config dir — portable or installed, with
// no need to know where the executable is. A locally developed plugin
// (its files outside any config dir) finds no marker and falls back to
// the installed rule, which is what a dev install reads.
//
// MAGPIE_CONFIG_DIR is the test override (it names the parent, the way
// XDG_CONFIG_HOME does: the dir below it is "magpie"). Production never
// sets it.

import { existsSync } from "node:fs"
import { join, dirname, isAbsolute } from "node:path"
import { homedir } from "node:os"

// MARKERS are files magpie itself writes at the root of its config dir:
// usage.jsonl (every call's row), quotas.json (the last readings),
// providers.json (the sign-ins' file), plugins.json (the plugin list —
// present from the moment a registry plugin is installed, before any
// usage exists).
const MARKERS = ["usage.jsonl", "quotas.json", "providers.json", "plugins.json"]

// anchorDir walks up from this package's own folder to the config dir
// that holds it, or null when the package lives outside one.
function anchorDir() {
  const here = import.meta.dir ?? import.meta.dirname
  if (!here) return null
  let dir = here
  for (let i = 0; i < 32; i++) {
    if (MARKERS.some((m) => existsSync(join(dir, m)))) return dir
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
  return null
}

export function paths() {
  const testRoot = process.env.MAGPIE_CONFIG_DIR
  if (testRoot) {
    const dir = join(testRoot, "magpie")
    return { dir, state: join(dir, "mail-watch-state.json"), usage: join(dir, "usage.jsonl"), quotas: join(dir, "quotas.json") }
  }
  const anchored = anchorDir()
  const xdg = process.env.XDG_CONFIG_HOME
  const dir = anchored ?? (xdg && isAbsolute(xdg) ? join(xdg, "magpie") : join(homedir(), ".config", "magpie"))
  return { dir, state: join(dir, "mail-watch-state.json"), usage: join(dir, "usage.jsonl"), quotas: join(dir, "quotas.json") }
}
