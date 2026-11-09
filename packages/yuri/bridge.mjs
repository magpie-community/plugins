import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { parse, parseTree, modify, applyEdits } from "./vendor/main.js"
import { agent } from "./yuri.agent.js"

const PACKAGE = "@magpie-community/opencode-magpie-provider"
const SPEC = `${PACKAGE}@0.1.0`
const compatiblePackages = [PACKAGE, "opencode-magpie-plugin"]
const parseOptions = { allowTrailingComma: true, allowEmptyContent: true }

export function pathsFor(home = os.homedir(), env = process.env) {
  const directory = path.resolve(env.OPENCODE_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode"))
  const configs = ["opencode.json", "opencode.jsonc"].map(name => path.join(directory, name))
  if (env.OPENCODE_CONFIG) configs.push(path.resolve(env.OPENCODE_CONFIG))
  // Use the descriptor as the source of truth for both sides of the bridge.
  const control = agent.config.replace(/^~(?=\/|$)/, home)
  return { control, configs: [...new Set(configs)], target: env.OPENCODE_CONFIG ? path.resolve(env.OPENCODE_CONFIG) : null, state: path.join(path.dirname(control), "state.json") }
}

function read(file) {
  try {
    const st = fs.lstatSync(file)
    if (!st.isFile() || st.isSymbolicLink()) throw new Error("Yuri bridge requires regular files, not links")
    return fs.readFileSync(file, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  if (text === null) {
    fs.rmSync(file, { force: true })
    return
  }
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600
    fs.writeFileSync(temporary, text, { flag: "wx", mode })
    fs.renameSync(temporary, file)
  } finally { fs.rmSync(temporary, { force: true }) }
}

function config(text) {
  const errors = []
  const source = (text ?? "").replace(/^\uFEFF/, "")
  const parsed = parse(source, errors, parseOptions)
  const value = parsed === undefined ? {} : parsed
  if (errors.length || typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid OpenCode JSONC; no configuration changed")
  if (value.plugins !== undefined && !Array.isArray(value.plugins)) throw new Error("OpenCode plugins must be an array")
  const keys = parseTree(source, [], parseOptions)?.children?.map(node => node.children[0].value) ?? []
  if (new Set(keys).size !== keys.length) throw new Error("Duplicate configuration keys; no configuration changed")
  return value
}

function edit(text, keys, value) {
  const bom = text?.startsWith("\uFEFF") ? "\uFEFF" : ""
  const source = (text ?? "{}").slice(bom.length)
  // No formatting pass: touch only the inserted/removed JSON tokens, keeping
  // unrelated comments and the user's original formatting intact.
  const result = bom + applyEdits(source, modify(source, keys, value, {}))
  config(result)
  return result
}

function hasPlugin(entry, file) {
  const spec = typeof entry === "string" ? entry : entry?.package
  if (typeof spec !== "string") return false
  if (compatiblePackages.some(name => spec === name || spec.startsWith(`${name}@`) || spec.startsWith(`npm:${name}@`))) return true
  if (!spec.startsWith(".") && !path.isAbsolute(spec) && !spec.startsWith("file://")) return false
  let location = spec.startsWith("file://") ? fileURLToPath(spec) : path.resolve(path.dirname(file), spec)
  if (!fs.existsSync(location)) throw new Error("A local plugin path is missing; resolve it before connecting Yuri")
  if (!fs.statSync(location).isDirectory()) location = path.dirname(location)
  // A local package directory, or its dist/index.mjs entry, has the same id.
  for (let depth = 0; depth < 2; depth++, location = path.dirname(location)) {
    const manifest = path.join(location, "package.json")
    if (fs.existsSync(manifest)) return compatiblePackages.includes(JSON.parse(fs.readFileSync(manifest, "utf8")).name)
  }
  return false
}

function desired(control, tokenFile) {
  if (!control?.baseURL && !control?.gatewayKey) return null
  if (typeof control.baseURL !== "string" || typeof control.gatewayKey !== "string" || !/^[\x21-\x7e]+$/.test(control.gatewayKey)) throw new Error("Incomplete Yuri connection; reconnect in Magpie")
  const url = new URL(control.baseURL)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid Magpie API URL")
  return { package: SPEC, options: { agentID: "yuri", remote: { baseURL: control.baseURL, tokenFile } } }
}

function json(file) {
  const text = read(file)
  return text === null ? null : JSON.parse(text)
}

// Persist the before/after edit before touching the config. On a crash, replay
// only those two exact states; never overwrite a concurrent user edit.
function recover(p) {
  const pending = json(p.state + ".pending")
  if (!pending) return
  if (!p.configs.includes(pending.file)) throw new Error("Recovery target changed; retain Yuri recovery files")
  const current = read(pending.file)
  if (current !== pending.before && current !== pending.after) throw new Error("Configuration changed during recovery; retain Yuri recovery files")
  if (current !== pending.after) write(pending.file, pending.after)
  write(p.state, pending.state === null ? null : JSON.stringify(pending.state))
  fs.unlinkSync(p.state + ".pending")
}

function commit(p, file, before, after, state) {
  if (read(file) !== before) throw new Error("Configuration changed during update; retry")
  write(p.state + ".pending", JSON.stringify({ file, before, after, state }))
  recover(p)
}

function restore(text, state) {
  if (text === state.after) return state.before
  const cfg = config(text)
  const matches = (cfg.plugins ?? []).flatMap((entry, index) => isDeepStrictEqual(entry, state.entry) ? [index] : [])
  if (matches.length > 1) throw new Error("Managed plugin duplicated; retain Yuri recovery files")
  // A removed, upgraded or edited entry is the user's new choice, not ours.
  if (!matches.length) return text
  return edit(text, ["plugins", matches[0]], undefined)
}

function locked(p, fn) {
  fs.mkdirSync(path.dirname(p.state), { recursive: true, mode: 0o700 })
  const lock = p.state + ".lock"
  try { fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 }) } catch (error) {
    if (error.code !== "EEXIST") throw error
    const pid = Number(read(lock))
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid Yuri bridge lock")
    try { process.kill(pid, 0) } catch (probe) {
      if (probe.code !== "ESRCH") throw probe
      fs.unlinkSync(lock)
      return locked(p, fn)
    }
    throw new Error("Another Yuri bridge operation is running")
  }
  try { return fn() } finally { fs.unlinkSync(lock) }
}

export function syncBridge(p = pathsFor()) {
  if (read(p.control) === null && read(p.state) === null && read(p.state + ".pending") === null) return "disconnected"
  return locked(p, () => {
    recover(p)
    const state = json(p.state)
    const entry = desired(json(p.control), p.control)
    if (state && !p.configs.includes(state.file)) throw new Error("OpenCode config location changed; disconnect using the original location")
    if (!entry) {
      if (state) {
        const before = read(state.file)
        commit(p, state.file, before, restore(before, state), null)
      }
      return "disconnected"
    }
    const documents = p.configs.map(file => ({ file, text: read(file) })).map(doc => ({ ...doc, value: config(doc.text) }))
    if (state) {
      const doc = documents.find(doc => doc.file === state.file)
      const matches = (doc.value.plugins ?? []).flatMap((item, index) => isDeepStrictEqual(item, state.entry) ? [index] : [])
      if (matches.length > 1) throw new Error("Managed plugin duplicated; retain Yuri recovery files")
      // Do not fight a user editing/removing/upgrading the managed entry.
      if (!matches.length) return "user-managed"
      if (!isDeepStrictEqual(entry, state.entry)) {
        const after = edit(doc.text, ["plugins", matches[0]], entry)
        commit(p, doc.file, doc.text, after, { ...state, before: restore(doc.text, state), after, entry })
      }
      return "connected"
    }
    if (documents.some(doc => (doc.value.plugins ?? []).some(item => hasPlugin(item, doc.file)))) return "existing"
    const doc = (p.target && documents.find(doc => doc.file === p.target)) || documents.findLast(doc => doc.text !== null) || documents.find(doc => doc.file.endsWith("opencode.jsonc"))
    const after = edit(doc.text, ["plugins", -1], entry)
    commit(p, doc.file, doc.text, after, { version: 1, file: doc.file, before: doc.text, after, entry })
    return "connected"
  })
}

export function startBridge(p = pathsFor(), { interval = 3000, onError = () => console.error("Yuri bridge paused; check OpenCode configuration. Recovery files retained.") } = {}) {
  const stamp = () => {
    const text = read(p.control)
    if (text === null) return null
    const stat = fs.statSync(p.control, { bigint: true })
    return `${stat.ino}:${stat.mtimeNs}:${text}`
  }
  let observed = stamp()
  let failed = false
  const tick = () => {
    try {
      const current = stamp()
      if (current === observed) return
      syncBridge(p)
      observed = current
      failed = false
    } catch {
      // Parser/network errors may include credentials or source lines.
      if (!failed) onError()
      failed = true
    }
  }
  const timer = setInterval(tick, interval)
  timer.unref?.()
  // Magpie unwires an agent before its host exits on disable/removal.
  process.once("exit", tick)
  return () => {
    clearInterval(timer)
    process.removeListener("exit", tick)
  }
}
