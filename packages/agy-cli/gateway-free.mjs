import fs from "node:fs"
import path from "node:path"

// Antigravity's desktop app keeps its gateway in ~/.gemini/config/config.json
// ({"gateway":{"enabled":true,"url":…}}), and agy reads the same file: an agy
// on ~/.gemini lists and serves the gateway's models, not the Google
// account's, and its /usage reads no Google quota at all ({"groups": []},
// agy 1.5.18: on a gateway it asks Google nothing). When magpie has wired
// the app to itself, that gateway is magpie (canlee886 on X, plugins#1591).
// A file that can't be read as JSON counts as on: the folder without the
// gateway is right either way.
export function appGatewayOn(home) {
  let text
  try {
    text = fs.readFileSync(path.join(home, ".gemini", "config", "config.json"), "utf8")
  } catch {
    return false
  }
  try {
    const gateway = JSON.parse(text)?.gateway
    return gateway?.enabled === true
  } catch {
    return true
  }
}

// gatewayFreeDir is agy's own ~/.gemini without the app's gateway, for an agy
// that has to stay on its own folder (its Google sign-in is in a file there,
// antigravity-cli/antigravity-oauth-token, where no keyring is; or
// AGY_BRIDGE_GEMINI_DIR=default) while the app's gateway is on. agy takes it
// as --gemini-dir (acp) or --gemini_dir (agy -p): every entry of ~/.gemini is
// linked into it, so agy reads and renews that sign-in where it is, and its
// config folder is the user's with one file different: config.json without
// the app's gateway and the models it lists. null when it can't be made.
export function gatewayFreeDir(home, env = process.env, platform = process.platform) {
  const src = path.join(home, ".gemini")
  const base = env.XDG_STATE_HOME || path.join(home, ".local", "state")
  const dir = path.join(base, "magpie-agy-bridge", "agy-own")
  try {
    fs.mkdirSync(path.join(dir, "config"), { recursive: true, mode: 0o700 })
    linkAll(src, dir, new Set(["config"]), platform)
    linkAll(path.join(src, "config"), path.join(dir, "config"), new Set(["config.json"]), platform)
    writeWithoutGateway(path.join(src, "config", "config.json"), path.join(dir, "config", "config.json"))
  } catch {
    return null
  }
  return dir
}

function entries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

// linkAll links each entry of src (but those in skip) into dir, and takes
// out a link of dir's whose entry is gone. What agy made in dir itself is
// left as it is.
function linkAll(src, dir, skip, platform) {
  const wanted = new Set()
  for (const entry of entries(src)) {
    if (skip.has(entry.name)) continue
    wanted.add(entry.name)
    const target = path.join(src, entry.name)
    const at = path.join(dir, entry.name)
    let isDir = entry.isDirectory()
    if (entry.isSymbolicLink()) {
      try { isDir = fs.statSync(target).isDirectory() } catch { continue }
    }
    linkOne(target, at, isDir, platform)
  }
  for (const entry of entries(dir)) {
    if (skip.has(entry.name) || wanted.has(entry.name)) continue
    const at = path.join(dir, entry.name)
    if (linked(at)) try { fs.rmSync(at, { force: true }) } catch {}
  }
}

// linked: at is a link (a junction on Windows reads as one too)
function linked(at) {
  try {
    return fs.lstatSync(at).isSymbolicLink()
  } catch {
    return false
  }
}

function sameTarget(at, target) {
  try {
    return path.resolve(path.dirname(at), fs.readlinkSync(at)) === path.resolve(target)
  } catch {
    return false
  }
}

function linkOne(target, at, isDir, platform) {
  if (linked(at)) {
    if (sameTarget(at, target)) return
    fs.rmSync(at, { force: true })
  } else if (fs.existsSync(at)) {
    // agy's own in this folder: never thrown away
    return
  }
  if (platform === "win32") {
    // a junction needs no privilege; a file link does, so a file that
    // can't be linked is copied (the folders hold what agy writes)
    if (isDir) return fs.symlinkSync(target, at, "junction")
    try {
      fs.symlinkSync(target, at, "file")
    } catch {
      fs.copyFileSync(target, at)
    }
    return
  }
  fs.symlinkSync(target, at)
}

// writeWithoutGateway writes the user's config.json without "gateway" and
// "models" (the list the app takes from the gateway), through a temp file
// and a rename, so agy never reads half of it. One that can't be read as
// JSON gives an empty object.
function writeWithoutGateway(from, to) {
  let config = {}
  try {
    const read = JSON.parse(fs.readFileSync(from, "utf8"))
    if (read && typeof read === "object" && !Array.isArray(read)) config = read
  } catch {}
  delete config.gateway
  delete config.models
  const text = JSON.stringify(config, null, 2)
  try {
    if (fs.readFileSync(to, "utf8") === text) return
  } catch {}
  const tmp = `${to}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text, { mode: 0o600 })
  fs.renameSync(tmp, to)
}
