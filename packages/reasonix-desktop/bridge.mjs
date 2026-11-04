import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { parseTOML, stringify, parseEnv } from "./vendor.mjs"
import { agent } from "./reasonix-desktop.agent.js"

export const PROVIDER = "magpie-agent"
export const KEY = "MAGPIE_REASONIX_DESKTOP_API_KEY"
const active = new Map()
const parse = (text) => parseTOML(text || "", { integersAsBigInt: "asNeeded" })

export function pathsFor(home = os.homedir()) {
  const control = agent.config.replace(/^~(?=\/|$)/, home)
  if (!path.isAbsolute(control)) throw new Error("Agent config must name an absolute path or ~/ path")
  const reasonix = path.dirname(control)
  return {
    control,
    config: path.join(reasonix, "config.toml"),
    env: path.join(reasonix, ".env"),
    state: path.join(reasonix, ".magpie-bridge", "state.json"),
  }
}

function read(file) {
  try {
    const st = fs.lstatSync(file)
    if (!st.isFile() || st.isSymbolicLink()) throw new Error("Bridge refuses non-regular files")
    return fs.readFileSync(file, "utf8")
  } catch (e) {
    if (e.code === "ENOENT") return null
    throw e
  }
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  // Preserve the user's directory; all bridge-created files are private.
  if (text === null) {
    fs.rmSync(file, { force: true })
    return
  }
  const temp = path.join(path.dirname(file), `.magpie-${randomUUID()}.tmp`)
  try {
    fs.writeFileSync(temp, text, { mode: 0o600, flag: "wx" })
    fs.renameSync(temp, file)
  } finally {
    fs.rmSync(temp, { force: true })
  }
}

function json(file) {
  const raw = read(file)
  return raw === null ? null : JSON.parse(raw)
}

function lock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    fs.writeFileSync(file, String(process.pid), { mode: 0o600, flag: "wx" })
  } catch (e) {
    if (e.code !== "EEXIST") throw e
    const pid = Number(read(file))
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid bridge lock; inspect .magpie-bridge/lock")
    try { process.kill(pid, 0) } catch (error) {
      if (error.code !== "ESRCH") throw error
      fs.unlinkSync(file)
      return lock(file)
    }
    throw new Error("Another bridge operation is running")
  }
  return () => fs.unlinkSync(file)
}

// A durable journal precedes every multi-file change. Recovery accepts only
// the exact before/after states; concurrent edits are never overwritten.
function recover(p) {
  const journalPath = p.state + ".pending"
  const journal = json(journalPath)
  if (!journal) return
  for (const change of journal.changes) {
    if (![p.config, p.env].includes(change.file)) throw new Error("Invalid bridge journal target")
    const current = read(change.file)
    if (current !== change.before && current !== change.after) throw new Error("Bridge recovery paused: configuration changed; retain .magpie-bridge for recovery")
  }
  for (const change of journal.changes) if (read(change.file) !== change.after) write(change.file, change.after)
  write(p.state, journal.state === null ? null : JSON.stringify(journal.state))
  fs.unlinkSync(journalPath)
}

function commit(p, changes, state) {
  for (const change of changes) {
    if (read(change.file) !== change.before) throw new Error("Configuration changed during bridge update; retry")
  }
  write(p.state + ".pending", JSON.stringify({ changes, state }))
  recover(p)
}

function desired(control) {
  if (!control?.gatewayKey && !control?.baseURL) return null
  if (typeof control.model !== "string" || !control.model.trim() || typeof control.gatewayKey !== "string" || !control.gatewayKey || typeof control.baseURL !== "string") throw new Error("Incomplete Magpie connection; select its model again")
  const url = new URL(control.baseURL)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid Magpie gateway URL")
  if (/[\r\n'\\]/.test(control.gatewayKey)) throw new Error("Unsupported gateway key encoding")
  const entry = {
    name: PROVIDER, display_name: "Magpie", kind: "openai", base_url: control.baseURL,
    models: [control.model], default: control.model, api_key_env: KEY,
  }
  const info = control.modelInfo || {}
  if (Number.isSafeInteger(info.context) && info.context > 0) entry.context_window = info.context
  if (Number.isSafeInteger(info.output) && info.output > 0) entry.max_output_tokens = info.output
  if (typeof info.images === "boolean") entry.model_overrides = { [control.model]: { vision: info.images } }
  return { entry, key: control.gatewayKey, ref: `${PROVIDER}/${control.model}` }
}

function patchKey(raw, value) {
  const text = raw || ""
  // Refuse ambiguous multiline assignments of the owned key instead of
  // touching another credential's continuation lines.
  const lines = text.split(/(?<=\n)/)
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${KEY}\\s*=`)
  const found = lines.filter(line => pattern.test(line))
  if (found.length > 1) throw new Error("Duplicate bridge credential assignments")
  if (found.length && parseEnv(found[0])[KEY] !== parseEnv(text)[KEY]) throw new Error("Multiline bridge credentials are unsupported")
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  const assignment = value === undefined ? "" : `${KEY}='${value}'${eol}`
  if (found.length) return lines.map(line => pattern.test(line) ? assignment : line).join("")
  return value === undefined ? text : text + (text && !text.endsWith("\n") ? eol : "") + assignment
}

function assertOwned(cfg, env, state) {
  const previous = parse(state.lastConfig)
  if (!isDeepStrictEqual(cfg.providers?.find(p => p.name === PROVIDER), previous.providers?.find(p => p.name === PROVIDER))) throw new Error("Managed Magpie provider was edited; disconnect before reconnecting")
  if (cfg.default_model !== previous.default_model) throw new Error("Default model was edited; disconnect before reconnecting")
  if (parseEnv(env || "")[KEY] !== parseEnv(state.lastEnv || "")[KEY]) throw new Error("Bridge credential was edited; disconnect before reconnecting")
}

function restoredConfig(config, state) {
  if (config === state.lastConfig) return state.originalConfig
  const cfg = parse(config)
  const original = parse(state.originalConfig)
  const previous = parse(state.lastConfig)
  const entry = cfg.providers?.find(p => p.name === PROVIDER)
  if (entry && !isDeepStrictEqual(entry, previous.providers?.find(p => p.name === PROVIDER))) throw new Error("Managed provider changed; restore it before disconnecting (backup retained)")
  cfg.providers = (cfg.providers || []).filter(p => p.name !== PROVIDER)
  if (!cfg.providers.length && !Object.hasOwn(original, "providers")) delete cfg.providers
  if (cfg.default_model === previous.default_model) {
    if (Object.hasOwn(original, "default_model")) cfg.default_model = original.default_model
    else delete cfg.default_model
  }
  if (Array.isArray(cfg.desktop?.provider_access) && !original.desktop?.provider_access?.includes(PROVIDER)) cfg.desktop.provider_access = cfg.desktop.provider_access.filter(name => name !== PROVIDER)
  return stringify(cfg)
}

function restoredEnv(env, state) {
  if (env === state.lastEnv) return state.originalEnv
  const mine = parseEnv(state.lastEnv || "")[KEY]
  return parseEnv(env || "")[KEY] === mine ? patchKey(env, parseEnv(state.originalEnv || "")[KEY]) : env
}

export function syncBridge(p = pathsFor()) {
  if (read(p.control) === null && read(p.state) === null && read(p.state + ".pending") === null) return "disconnected"
  const unlock = lock(path.join(path.dirname(p.state), "lock"))
  try {
    recover(p)
    const state = json(p.state)
    const control = json(p.control)
    const want = desired(control)
    if (!want && !state) return "disconnected"
    const config = read(p.config)
    const env = read(p.env)
    const cfg = parse(config)
    if (want) {
      if (state) assertOwned(cfg, env, state)
      else {
        if (cfg.providers?.some(entry => entry.name === PROVIDER)) throw new Error("Provider magpie-agent already exists; rename it before connecting")
        if (Object.hasOwn(parseEnv(env || ""), KEY) || cfg.providers?.some(entry => entry.api_key_env === KEY)) throw new Error("Bridge credential name already belongs to existing configuration")
      }
      const next = { ...cfg, default_model: want.ref, providers: [...(cfg.providers || []).filter(entry => entry.name !== PROVIDER), want.entry] }
      if (Array.isArray(cfg.desktop?.provider_access)) next.desktop = { ...cfg.desktop, provider_access: [...new Set([...cfg.desktop.provider_access, PROVIDER])] }
      const nextConfig = isDeepStrictEqual(cfg, next) ? config : stringify(next)
      const nextEnv = parseEnv(env || "")[KEY] === want.key ? env : patchKey(env, want.key)
      if (state && config === nextConfig && env === nextEnv) return "connected"
      const nextState = {
        version: 1,
        originalConfig: state ? restoredConfig(config, state) : config,
        originalEnv: state ? restoredEnv(env, state) : env,
        lastConfig: nextConfig, lastEnv: nextEnv,
      }
      commit(p, [{ file: p.env, before: env, after: nextEnv }, { file: p.config, before: config, after: nextConfig }], nextState)
      return "connected"
    }
    const nextConfig = restoredConfig(config, state)
    const nextEnv = restoredEnv(env, state)
    commit(p, [{ file: p.config, before: config, after: nextConfig }, { file: p.env, before: env, after: nextEnv }], null)
    return "disconnected"
  } finally { unlock() }
}

export function startBridge(p = pathsFor(), { interval = 750, onError = () => console.error("Reasonix bridge paused; run magpie-reasonix sync for details (configuration retained).") } = {}) {
  if (active.has(p.state)) return active.get(p.state)
  let previousError = ""
  const tick = () => {
    try { syncBridge(p); previousError = "" } catch (error) {
      // Parser errors can contain a source line; never write those to logs.
      if (error.message !== previousError) onError()
      previousError = error.message
    }
  }
  tick()
  const timer = setInterval(tick, interval)
  timer.unref?.()
  const stop = () => { clearInterval(timer); active.delete(p.state) }
  active.set(p.state, stop)
  return stop
}
