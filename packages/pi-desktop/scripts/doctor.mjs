#!/usr/bin/env node
// Read-only check of the Magpie → Pi-Desktop connection. Prints no secrets; reads
// Pi-Desktop's database from a temporary copy that it deletes afterwards.
//   node --no-warnings scripts/doctor.mjs        (Node 22.5+ for the database check)
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { LEVELS, MAX_MODELS, agent } from "../pi-desktop.agent.js"

const KEY = `magpie-${agent.id}`
const PLUGIN_ID = "local.magpie-gateway"
// The manifest Magpie keeps, and the folder Pi-Desktop loads as a local plugin.
const manifestPath = process.env.MAGPIE_PI_DESKTOP_MANIFEST || join(homedir(), agent.config.replace(/^~[\\/]/, ""))
const pluginDir = dirname(manifestPath)
const dataDir = process.env.PI_DESKTOP_DATA_DIR || join(homedir(), ".pi-desktop")
const LOAD = `in Pi-Desktop, Extensions › More actions › Load local plugin, and choose ${pluginDir}`
const RESTART = "quit Pi-Desktop from its tray icon and open it again (or turn Magpie Gateway off and on under Extensions)"
let failed = 0
const ok = (msg) => console.log(`ok    ${msg}`)
const info = (msg) => console.log(`info  ${msg}`)
const fail = (msg) => { failed++; console.log(`FAIL  ${msg}`) }
// Only this agent's own gateway key name is printed; it is public (the manifest says it too).
const keyLabel = (key) => (key === KEY ? key : key ? "(another key, not shown)" : "(none)")
const samePath = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase()

// 1. Magpie's side: the manifest connect() writes while Pi-Desktop's row is on.
let manifest = null
try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")) } catch {}
const bridge = manifest?.magpie
const providers = Array.isArray(manifest?.contributes?.providers) ? manifest.contributes.providers.map((p) => ({ ...p, models: p.models || [] })) : []
const declared = providers.flatMap((p) => p.models)
if (!bridge?.baseUrl) {
  manifest = null
  fail(`Magpie is not keeping ${manifestPath}: turn Pi-Desktop on in Magpie's Agents page, or run: magpie ${agent.id} provider magpie`)
} else {
  ok(`Magpie keeps ${manifestPath}: ${bridge.baseUrl}, key ${keyLabel(bridge.apiKey)}, ${declared.length} models in ${providers.map((p) => `${p.name} (${p.models.length})`).join(", ")}`)
  const problems = manifestProblems()
  if (problems.length) fail(`Pi-Desktop will not accept the manifest: ${problems.slice(0, 3).join("; ")}`)
  else ok(`manifest is one Pi-Desktop accepts; ${declared.filter((m) => m.defaultThinkingLevel).length} models start on a thinking level of their own, ${declared.filter((m) => !m.thinkingLevels).length} have none from Magpie and start on off`)
}

// The rules Pi-Desktop 0.22's host applies to what this manifest uses.
function manifestProblems() {
  const out = []
  if (manifest.id !== PLUGIN_ID) out.push(`id is ${manifest.id}`)
  if (typeof manifest.main !== "string" || !existsSync(join(pluginDir, manifest.main))) out.push(`main entry ${manifest.main} is missing`)
  if (!manifest.permissions?.includes("provider.register")) out.push("provider.register is not requested")
  if (providers.length === 0) out.push("no provider")
  const seen = new Set()
  for (const p of providers) {
    if (p.models.length > MAX_MODELS) out.push(`${p.name} declares ${p.models.length} models, more than ${MAX_MODELS}`)
    if (p.baseUrl !== bridge.baseUrl) out.push(`${p.name} points at ${p.baseUrl}`)
    for (const m of p.models) {
      if (seen.has(m.id)) out.push(`${m.id} is declared twice`)
      seen.add(m.id)
      if (m.thinkingLevels?.some((level) => !LEVELS.includes(level))) out.push(`${m.id} has a level Pi-Desktop does not know`)
      if (m.defaultThinkingLevel && !m.thinkingLevels?.includes(m.defaultThinkingLevel)) out.push(`${m.id} starts on a level it does not have`)
    }
  }
  return out
}

// 2. The gateway serves Pi-Desktop the models the manifest declares.
if (manifest) {
  try {
    const res = await fetch(`${bridge.baseUrl}/models`, { headers: { authorization: `Bearer ${bridge.apiKey}` }, signal: AbortSignal.timeout(8000) })
    const body = await res.json().catch(() => null)
    const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : []
    const served = new Set(list.map((m) => m?.id ?? m?.slug).filter((id) => typeof id === "string" && id))
    if (!res.ok) fail(`gateway ${bridge.baseUrl}/models answered HTTP ${res.status}`)
    else if (served.size === 0) fail(`gateway lists no models for Pi-Desktop: check magpie visible ${agent.id}`)
    else {
      const ids = new Set(declared.map((m) => m.id))
      const added = [...served].filter((id) => !ids.has(id)), gone = [...ids].filter((id) => !served.has(id))
      if (added.length + gone.length === 0) ok(`gateway serves the same ${served.size} models to Pi-Desktop`)
      else info(`gateway serves ${served.size} models, ${added.length} not in the manifest yet and ${gone.length} no longer served${added.length ? ` (e.g. ${added.slice(0, 3).join(", ")})` : ""}; Magpie rewrites the manifest when its models change, so check again in a moment`)
    }
  } catch (e) { fail(`gateway ${bridge.baseUrl} not reachable: ${e.name}`) }
}

// 3. Pi-Desktop's side: it has to load the folder Magpie keeps, not a copy of it.
let live = false
if (!existsSync(dataDir)) fail(`no Pi-Desktop data folder at ${dataDir} (set PI_DESKTOP_DATA_DIR if it moved)`)
else {
  let entry
  try {
    const registry = JSON.parse(readFileSync(join(dataDir, "plugins", "registry.json"), "utf8"))
    entry = (Array.isArray(registry) ? registry : registry.plugins || []).find((p) => p?.id === PLUGIN_ID)
  } catch {}
  if (!entry) fail(`Pi-Desktop has no ${PLUGIN_ID} plugin: ${LOAD}`)
  else if (entry.source !== "dev" || !entry.path || !samePath(entry.path, pluginDir)) {
    fail(`Pi-Desktop uses its own copy of the plugin (${entry.version}, at ${entry.path}), so it does not follow Magpie's models: ${LOAD}. The saved key stays.`)
  } else if (!entry.enabled) fail("the Magpie Gateway plugin is off: turn it on in Pi-Desktop's Extensions")
  else { live = true; ok(`Pi-Desktop loads Magpie Gateway from ${entry.path} and reads it again each time it starts`) }
}

if (manifest) await checkProviderRows()
console.log(failed ? `\n${failed} problem(s)` : "\nall checks passed")
process.exitCode = failed ? 1 : 0

// 4. The provider rows Pi-Desktop's host made from the manifest.
async function checkProviderRows() {
  const db = join(dataDir, "pi.sqlite")
  if (!existsSync(db)) return info("no pi.sqlite yet; open Pi-Desktop once")
  let DatabaseSync
  try { ({ DatabaseSync } = await import("node:sqlite")) } catch { return info("provider rows not checked: needs Node 22.5+ (node:sqlite)") }
  const dir = mkdtempSync(join(tmpdir(), "magpie-pi-doctor-"))
  const copy = join(dir, "pi.sqlite")
  let conn
  try {
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(db + suffix)) copyFileSync(db + suffix, copy + suffix)
    conn = new DatabaseSync(copy, { readOnly: true })
    const find = conn.prepare("SELECT enabled, base_url, secret_ref, config_json FROM providers WHERE id = ?")
    const hasSecret = conn.prepare("SELECT 1 FROM secrets_meta WHERE secret_ref = ?")
    for (const p of providers) {
      const row = find.get(`plugin:${PLUGIN_ID}:${p.id}`)
      if (!row) { fail(`Pi-Desktop has no ${p.name} provider yet: ${live ? RESTART : LOAD}`); continue }
      let models = []
      try { models = JSON.parse(row.config_json).models || [] } catch {}
      const same = models.length === p.models.length && p.models.every((m, i) => models[i].id === m.id && (models[i].defaultThinkingLevel ?? undefined) === m.defaultThinkingLevel)
      if (!row.enabled) fail(`the ${p.name} provider is disabled: turn the Magpie Gateway plugin on in Pi-Desktop's Extensions`)
      else if (!same) fail(`Pi-Desktop's ${p.name} has an older model list (${models.length} models, Magpie now offers ${p.models.length} there): ${live ? RESTART : LOAD}`)
      else if (!(row.secret_ref && hasSecret.get(row.secret_ref))) fail(`no key saved for ${p.name}: Settings › AI providers › Add provider › ${p.name}, enter ${KEY} and save`)
      else ok(`${p.name} ready at ${row.base_url}: ${models.length} models, as Magpie offers them`)
    }
    const known = new Set(providers.map((p) => `plugin:${PLUGIN_ID}:${p.id}`))
    const extra = conn.prepare("SELECT id FROM providers WHERE id LIKE ?").all(`plugin:${PLUGIN_ID}:%`).filter((row) => !known.has(row.id))
    if (extra.length) info(`Pi-Desktop still has ${extra.map((row) => row.id.split(":").pop()).join(", ")} from an older model list; it goes when Pi-Desktop starts again`)
  } finally {
    try { conn?.close() } catch {}
    for (const suffix of ["-shm", "-wal", ""]) { try { unlinkSync(copy + suffix) } catch {} }
    try { rmdirSync(dir) } catch {}
  }
}
