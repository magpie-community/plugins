import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const BRIDGE_DIR = ".magpie-workreview"
export const BRIDGE_FILE = "agent.json"
export const STATE_FILE = "state.json"
export const APP_DIR = "work-review"

// Work Review uses Rust's dirs::data_dir()/work-review for config.json and
// dirs::config_dir()/work-review for its data-location.json preference.
export function dataRoot({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  if (env.WORK_REVIEW_HOME) return path.resolve(env.WORK_REVIEW_HOME)
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), APP_DIR)
  if (platform === "darwin") return path.join(home, "Library", "Application Support", APP_DIR)
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), APP_DIR)
}

export function configRoot({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), APP_DIR)
  if (platform === "darwin") return path.join(home, "Library", "Application Support", APP_DIR)
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), APP_DIR)
}

// A data dir moved in Work Review's settings is saved in data-location.json.
export function readDataLocation({ env, home, platform } = {}) {
  const file = path.join(configRoot({ env, home, platform }), "data-location.json")
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"))
    const dir = typeof parsed?.data_dir === "string" ? parsed.data_dir.trim() : ""
    return dir ? path.resolve(dir) : ""
  } catch {
    return ""
  }
}

export function resolveConfigPath(options = {}) {
  const moved = readDataLocation(options)
  return path.join(moved || dataRoot(options), "config.json")
}

export function bridgeDir({ home = os.homedir() } = {}) {
  return path.join(home, BRIDGE_DIR)
}

export function bridgePath(options) {
  return path.join(bridgeDir(options), BRIDGE_FILE)
}

export function statePath(options) {
  return path.join(bridgeDir(options), STATE_FILE)
}
