// The Bun-side companion for the Trae agent row.
//
// The row's values live in ~/.trae/magpie/connection.json (written by Magpie's
// Agent page). This module does three jobs that a Magpie agent module cannot:
//
//   1. mirror Magpie's MCP servers from the plugin-owned staging file
//      ~/.trae/magpie/mcp.json into Trae's real User/mcp.json, whose location
//      differs by OS, without touching servers the user added there;
//   2. prepare a preview of the models enabled for the Trae row, and mirror
//      them into Trae's cloud only after the user confirms the preview on the
//      plugin's page (trae-page.mjs);
//   3. record the confirmed mirror in ~/.trae/magpie/model-state.json.
//
// Magpie loads index.mjs as an OpenCode plugin; that entry point starts the
// bridge and the page service. The file also runs standalone:
//
//   node bridge.mjs --once                 one MCP sync, print a summary
//   node bridge.mjs --watch                keep the MCP mirror in step
//   node bridge.mjs --clean                remove only the MCP servers this bridge added
//   node bridge.mjs --preview-models       show what a model mirror would change
//   node bridge.mjs --sync-models --confirm  mirror the previewed models
//
// Nothing here opens Trae, reads state.vscdb, or touches Trae's agent
// database. The model API authenticates with this package's own "trae-agent"
// sign-in only (see trae-api.mjs); it never reads another app's or plugin's
// credentials.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join, posix, resolve, win32 } from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import {
  endpointForForm,
  keyHash,
  modelsOfCatalog,
  previewTraeMirror,
  syncTraeModels,
} from "./trae-api.mjs"

async function fetchJson(url, options = {}, timeout = 15000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal })
    const text = await res.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    return { status: res.status, body, text }
  } finally {
    clearTimeout(timer)
  }
}

const STATE_VERSION = 1

// pathsFor is every path this bridge touches, as one machine lays them out.
// The arguments exist so tests can point it at a temporary home and OS.
export function pathsFor({
  home = homedir(),
  env = process.env,
  platform = process.platform,
  magpieConfig: magpieConfigOverride,
} = {}) {
  // The simulated platform's separators, so tests can check all three.
  const path = platform === "win32" ? win32 : posix
  const traeHome = path.join(home, ".trae")
  const magpieConfig =
    magpieConfigOverride ||
    env.MAGPIE_CONFIG_DIR ||
    (env.XDG_CONFIG_HOME
      ? path.join(env.XDG_CONFIG_HOME, "magpie")
      : path.join(home, ".config", "magpie"))
  let userData
  if (platform === "win32") {
    // Trae's Electron userData is %APPDATA%\Trae; fall back to the usual
    // home-relative place when APPDATA is not in the environment.
    userData = path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Trae")
  } else if (platform === "darwin") {
    userData = path.join(home, "Library", "Application Support", "Trae")
  } else {
    userData = path.join(home, ".config", "Trae")
  }
  return {
    home,
    platform,
    traeHome,
    magpieDir: path.join(traeHome, "magpie"),
    magpieConfig,
    connection: path.join(traeHome, "magpie", "connection.json"),
    stagingMcp: path.join(traeHome, "magpie", "mcp.json"),
    state: path.join(traeHome, "magpie", "mcp-state.json"),
    modelState: path.join(traeHome, "magpie", "model-state.json"),
    userData,
    // Trae reads its global MCP servers from User/mcp.json beside its
    // settings.json (workbench's userSettingsResource/../mcp.json).
    targetMcp: path.join(userData, "User", "mcp.json"),
    skills: path.join(traeHome, "skills"),
  }
}

// readJson is {ok, value} so a missing file and a broken one stay distinct:
// a broken target must be left alone, never overwritten.
function readJson(file) {
  try {
    const text = readFileSync(file, "utf8")
    if (!text.trim()) return { ok: true, value: undefined }
    return { ok: true, value: JSON.parse(text) }
  } catch (err) {
    if (err && err.code === "ENOENT") return { ok: true, value: undefined }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function serversOf(doc) {
  return isObject(doc) && isObject(doc.mcpServers) ? doc.mcpServers : {}
}

// writeAtomic writes beside the target and renames it in, so Trae never reads
// a half-written file. Windows can refuse the rename over an open file; the
// copy fallback still keeps the bytes in order.
function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, text, "utf8")
  try {
    renameSync(tmp, file)
  } catch {
    copyFileSync(tmp, file)
    rmSync(tmp, { force: true })
  }
}

function backup(file, to) {
  if (!existsSync(file)) return
  try {
    copyFileSync(file, to || `${file}.magpie.bak`)
  } catch {
    // A backup is a courtesy; failing to take one must not block the sync.
  }
}

// beforeMcp is the copy of Trae's own mcp.json taken before the bridge first
// changes it. It sits in Magpie's folder, not in Trae's, and holds whatever
// env/header secrets the user's own servers have.
function beforeMcp(p) {
  return join(p.magpieDir, "mcp.before.json")
}

// privateFile keeps a file's secrets to the user on POSIX. Windows ignores
// the mode; its ACLs are Trae's own business.
function privateFile(file) {
  try {
    chmodSync(file, 0o600)
  } catch {
    // A filesystem without modes, or a file that just went away.
  }
}

function writeJsonFile(file, value) {
  writeAtomic(file, JSON.stringify(value, null, 2) + "\n")
  privateFile(file)
}

function summaryOf(p, parts) {
  return { target: p.targetMcp, staging: p.stagingMcp, state: p.state, ...parts }
}

// syncMcp merges the staging servers into Trae's User/mcp.json.
//
// Ownership is recorded in mcp-state.json. A server this bridge wrote is
// updated or removed only while it still matches what the bridge last wrote:
// an edit the user made in Trae is theirs, so the bridge stops managing that
// name rather than overwriting it. A name the user already had is never
// taken over.
export function syncMcp(p) {
  const stagedRead = readJson(p.stagingMcp)
  if (!stagedRead.ok) {
    throw new Error(`${p.stagingMcp} is not valid JSON: ${stagedRead.error}`)
  }
  const targetRead = readJson(p.targetMcp)
  if (!targetRead.ok) {
    throw new Error(`${p.targetMcp} is not valid JSON; left alone: ${targetRead.error}`)
  }
  if (targetRead.value !== undefined && !isObject(targetRead.value)) {
    return summaryOf(p, {
      ok: false,
      error: `${p.targetMcp} does not hold a JSON object; left alone`,
      added: [],
      updated: [],
      removed: [],
      skipped: [],
    })
  }

  const staged = serversOf(stagedRead.value)
  const target = targetRead.value ?? {}
  target.mcpServers = { ...serversOf(target) }
  const stateRead = readJson(p.state)
  const prior = stateRead.ok && isObject(stateRead.value) ? stateRead.value : {}
  const owned = isObject(prior.owned) ? prior.owned : {}

  const added = []
  const updated = []
  const removed = []
  const skipped = []
  const nextOwned = {}

  for (const [rawName, server] of Object.entries(staged)) {
    const name = String(rawName)
    if (!name || !isObject(server)) continue
    const had = Object.hasOwn(target.mcpServers, name)
    const current = target.mcpServers[name]
    const wasOwned = Object.hasOwn(owned, name)
    if (had && !wasOwned) {
      skipped.push({ name, reason: "already in Trae, not written by Magpie" })
      continue
    }
    if (had && wasOwned && !isDeepStrictEqual(current, owned[name])) {
      skipped.push({ name, reason: "edited in Trae; no longer managed by Magpie" })
      continue
    }
    if (!had) {
      target.mcpServers[name] = server
      nextOwned[name] = server
      added.push(name)
      continue
    }
    if (!isDeepStrictEqual(current, server)) {
      target.mcpServers[name] = server
      updated.push(name)
    }
    nextOwned[name] = server
  }

  for (const [name, server] of Object.entries(owned)) {
    if (Object.hasOwn(staged, name)) continue
    if (!Object.hasOwn(target.mcpServers, name)) continue
    if (isDeepStrictEqual(target.mcpServers[name], server)) {
      delete target.mcpServers[name]
      removed.push(name)
    } else {
      skipped.push({ name, reason: "edited in Trae; Magpie no longer removes it" })
    }
  }

  if (added.length || updated.length || removed.length) {
    backup(p.targetMcp, beforeMcp(p))
    privateFile(beforeMcp(p))
    writeAtomic(p.targetMcp, JSON.stringify(target, null, 2) + "\n")
  }
  if (!isDeepStrictEqual(owned, nextOwned)) {
    writeAtomic(
      p.state,
      JSON.stringify(
        { version: STATE_VERSION, updatedAt: new Date().toISOString(), owned: nextOwned },
        null,
        2,
      ) + "\n",
    )
    privateFile(p.state)
  }

  return summaryOf(p, { ok: true, added, updated, removed, skipped })
}

// cleanMcp removes only the servers recorded as Magpie's, and only while they
// still match what this bridge wrote.
export function cleanMcp(p) {
  const targetRead = readJson(p.targetMcp)
  if (!targetRead.ok) {
    throw new Error(`${p.targetMcp} is not valid JSON; left alone: ${targetRead.error}`)
  }
  if (targetRead.value !== undefined && !isObject(targetRead.value)) {
    return summaryOf(p, {
      ok: false,
      error: `${p.targetMcp} does not hold a JSON object; left alone`,
      removed: [],
      skipped: [],
    })
  }
  const target = targetRead.value ?? {}
  const servers = serversOf(target)
  const stateRead = readJson(p.state)
  const owned = stateRead.ok && isObject(stateRead.value) && isObject(stateRead.value.owned)
    ? stateRead.value.owned
    : {}
  const removed = []
  const skipped = []
  for (const [name, server] of Object.entries(owned)) {
    if (!Object.hasOwn(servers, name)) continue
    if (isDeepStrictEqual(servers[name], server)) {
      delete servers[name]
      removed.push(name)
    } else {
      skipped.push({ name, reason: "edited in Trae; left as it is" })
    }
  }
  if (removed.length) {
    target.mcpServers = servers
    backup(p.targetMcp, beforeMcp(p))
    privateFile(beforeMcp(p))
    writeAtomic(p.targetMcp, JSON.stringify(target, null, 2) + "\n")
  }
  if (existsSync(p.state)) rmSync(p.state, { force: true })
  return summaryOf(p, { ok: true, removed, skipped })
}

// gatewayModels reads the model list from Magpie's own gateway: the same list
// the Trae row's picker shows, already narrowed to the models the user
// enabled for Trae. It uses only the per-agent key Magpie handed this row in
// connection.json; it never reads Magpie's gateway keys.
async function gatewayModels(conn) {
  let origin
  try {
    origin = new URL(conn.endpoint).origin
  } catch {
    throw new Error(`The Trae row's endpoint is not a URL: ${conn.endpoint}`)
  }
  const res = await fetchJson(`${origin}/v1/models`, {
    headers: { Authorization: `Bearer ${conn.apiKey}`, Accept: "application/json" },
  })
  if (res.status === 200 && isObject(res.body)) return modelsOfCatalog(res.body)
  throw new Error(`Magpie's gateway answered ${res.status} for ${origin}/v1/models`)
}

// Model mirroring is an explicit action from the plugin's page: preview what
// would change, then apply after the user confirms. It never runs on connect
// or on the bridge's polling loop.
let modelBusy = false

function connectionOf(p) {
  const read = readJson(p.connection)
  return read.ok && isObject(read.value) && read.value.endpoint && read.value.apiKey
    ? read.value
    : null
}

export async function previewModels(p = pathsFor()) {
  const conn = connectionOf(p)
  if (!conn) return { skipped: true, reason: "disconnected" }
  if (process.env.MAGPIE_TRAE_NO_API === "1" || process.env.MAGPIE_TRAE_NO_UI === "1") {
    return { skipped: true, reason: "disabled" }
  }
  let models
  try {
    models = await gatewayModels(conn)
  } catch (err) {
    return { ok: false, code: "unreachable", error: err instanceof Error ? err.message : String(err) }
  }
  return previewTraeMirror(p, { models, endpoint: conn.endpoint })
}

export async function applyMirror(p = pathsFor(), { previewId, confirm } = {}) {
  if (confirm !== true) {
    return { ok: false, code: "confirm-required", error: "The user has not confirmed the mirror." }
  }
  if (!previewId) {
    return { ok: false, code: "preview-required", error: "Refresh the preview before mirroring." }
  }
  const conn = connectionOf(p)
  if (!conn) return { skipped: true, reason: "disconnected" }
  if (process.env.MAGPIE_TRAE_NO_API === "1" || process.env.MAGPIE_TRAE_NO_UI === "1") {
    return { skipped: true, reason: "disabled" }
  }
  const preview = await previewModels(p)
  if (!preview.ok) return preview
  if (preview.previewId !== previewId) {
    return {
      ok: false,
      code: "stale-preview",
      error: "The model list changed since the preview; refresh it and confirm again.",
    }
  }
  if (modelBusy) return { skipped: true, reason: "busy" }

  modelBusy = true
  const endpoint = endpointForForm(conn.endpoint)
  const base = {
    status: "working",
    endpoint,
    total: preview.wanted.length,
    at: new Date().toISOString(),
  }
  writeJsonFile(p.modelState, base)
  try {
    const result = await syncTraeModels(p, {
      models: preview.wanted,
      endpoint: conn.endpoint,
      keyHash: keyHash(conn.apiKey),
    })
    const state = {
      ...base,
      status: result.ok ? "ok" : result.code || "failed",
      action: result.action,
      added: result.added,
      removed: result.removed,
      kept: result.kept,
      conflicts: result.conflicts,
      failed: result.failed,
      rows: result.rows,
      host: result.host,
      error: result.error,
      at: new Date().toISOString(),
    }
    writeJsonFile(p.modelState, state)
    return { ok: Boolean(result.ok), state, result }
  } catch (err) {
    const state = {
      ...base,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      at: new Date().toISOString(),
    }
    writeJsonFile(p.modelState, state)
    return { ok: false, state, result: null }
  } finally {
    modelBusy = false
  }
}

// connected says the Trae row has a model prepared: Magpie wrote an endpoint
// and a gateway key into the connection file. A row switched off (or a plugin
// Magpie just disabled) leaves {} or no file there; MCP entries this bridge
// wrote are then taken back out.
function connected(file) {
  const read = readJson(file)
  if (!read.ok || !isObject(read.value)) return false
  return Boolean(read.value.endpoint && read.value.apiKey)
}

// syncAll keeps the local MCP mirror in step. Model mirroring is never run
// here: it writes to Trae's cloud and only runs from the page after the user
// confirms a preview.
export async function syncAll(p = pathsFor()) {
  const out = { connected: connected(p.connection) }
  privateFile(p.connection)
  privateFile(p.stagingMcp)
  try {
    out.mcp = out.connected ? syncMcp(p) : cleanMcp(p)
  } catch (err) {
    out.mcp = { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  out.models = { skipped: true, reason: "manual" }
  return out
}

// startBridge is what index.mjs calls once per plugin host. It syncs now and
// then every two seconds; setInterval is unref'd so it never keeps the host
// alive on its own. Model writes take longer than a tick, so a second run is
// queued rather than started beside the first.
export function startBridge(p = pathsFor()) {
  let running = false
  let queued = false
  const run = async () => {
    if (running) {
      queued = true
      return
    }
    running = true
    try {
      await syncAll(p)
    } catch (err) {
      console.error(`trae bridge: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      running = false
      if (queued) {
        queued = false
        setTimeout(run, 100)
      }
    }
  }
  run()
  const timer = setInterval(run, 2000)
  if (typeof timer.unref === "function") timer.unref()
  // Magpie restores the row's file before it stops the host on disable or
  // removal. If that left the row disconnected, take the mirrored MCP servers
  // out too; a normal Magpie quit keeps a connected row's file and its servers.
  const onExit = () => {
    try {
      if (!connected(p.connection)) cleanMcp(p)
    } catch {
      // Nothing left to do while the process is going away.
    }
  }
  process.once("exit", onExit)
  return {
    paths: p,
    sync: run,
    stop() {
      clearInterval(timer)
      process.removeListener("exit", onExit)
    },
  }
}

// Standalone use, for a host that is not running or for checking the wiring.
async function main() {
  const args = new Set(process.argv.slice(2))
  const p = pathsFor()
  if (args.has("--clean")) {
    console.log(JSON.stringify(cleanMcp(p), null, 2))
    return
  }
  if (args.has("--preview-models")) {
    console.log(JSON.stringify(await previewModels(p), null, 2))
    return
  }
  if (args.has("--sync-models")) {
    if (!args.has("--confirm")) {
      console.error("Refusing to write to Trae's cloud without --confirm. Run --preview-models first.")
      process.exitCode = 1
      return
    }
    const preview = await previewModels(p)
    if (!preview.ok) {
      console.log(JSON.stringify(preview, null, 2))
      process.exitCode = 1
      return
    }
    console.log(JSON.stringify(await applyMirror(p, { previewId: preview.previewId, confirm: true }), null, 2))
    return
  }
  if (args.has("--watch")) {
    const bridge = startBridge(p)
    console.log(`watching ${p.stagingMcp} -> ${p.targetMcp}`)
    process.on("SIGINT", () => {
      bridge.stop()
      process.exit(0)
    })
    await new Promise(() => {})
    return
  }
  console.log(JSON.stringify(await syncAll(p), null, 2))
}

const invoked =
  typeof process !== "undefined" &&
  process.argv &&
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invoked) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
