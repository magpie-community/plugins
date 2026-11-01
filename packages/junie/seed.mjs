import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { randomUUID, createHash } from "node:crypto"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

function read(file) {
  try { return fs.readFileSync(file, "utf8") }
  catch (error) { if (error.code !== "ENOENT") throw error }
}

function document(raw, name) {
  const value = raw === undefined ? {} : JSON.parse(raw)
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(`${name}: expected an object`)
  return value
}

function write(file, raw, expected = read(file)) {
  if (raw === expected) return
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, raw, { flag: "wx", mode: 0o600 })
    if (read(file) !== expected) throw Error("configuration_changed")
    fs.renameSync(temporary, file)
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const ECO_FIELDS = ["ecoModePerModel", "acpEcoModePerModel"]
const valueAt = (doc, key) => Object.hasOwn(doc, key) ? { value: doc[key] } : {}
const put = (doc, key, slot) => {
  if (Object.hasOwn(slot, "value")) doc[key] = slot.value
  else delete doc[key]
}

// The journal is written before each effect. Both the previous and pending
// value are recognized after a crash; a third value belongs to the user.
class Files {
  constructor(file) {
    this.file = file
    this.state = document(read(file), "journal")
    this.state.profiles ??= {}
    this.state.documents ??= {}
    this.state.ecoFields ??= {}
  }

  save() { write(this.file, JSON.stringify(this.state, null, 2) + "\n") }

  patch(file, changes) {
    const raw = read(file), doc = document(raw, file)
    const entries = this.state.documents[file] ??= {}
    let changed = false
    for (const [key, desired] of Object.entries(changes)) {
      const current = valueAt(doc, key)
      if (same(current, desired)) continue
      const entry = entries[key] ??= { before: current }
      entry.previous = entry.wrote
      entry.wrote = desired
      put(doc, key, desired)
      changed = true
    }
    if (!changed) return
    this.save()
    write(file, JSON.stringify(doc, null, 2) + "\n", raw)
  }

  ecoPreferences(file, selectors, eco, obsolete) {
    const raw = read(file), doc = document(raw, file)
    for (const field of ECO_FIELDS) {
      const preferences = document(doc[field], field)
      this.state.ecoFields[field] ??= Object.hasOwn(doc, field)
      for (const selector of obsolete) delete preferences[selector]
      for (const selector of selectors) {
        if (eco !== undefined || !Object.hasOwn(preferences, selector)) preferences[selector] = eco ?? "on"
      }
      doc[field] = JSON.stringify(preferences)
    }
    // Only map presence is journaled. Native model preferences stay owned by
    // Junie, including edits made between successive seeds.
    this.save()
    write(file, JSON.stringify(doc, null, 2) + "\n", raw)
  }

  checkProfile(file) {
    const current = read(file), entry = this.state.profiles[file]
    if (current === undefined) return
    if (!entry || (current !== entry.wrote && current !== entry.previous)) throw Error("profile_changed")
  }

  profile(file, desired) {
    this.checkProfile(file)
    const raw = read(file)
    if (raw === desired) return
    this.state.profiles[file] = { previous: raw, wrote: desired }
    this.save()
    write(file, desired, raw)
  }

  removeProfile(file) {
    this.checkProfile(file)
    if (read(file) !== undefined) fs.unlinkSync(file)
    delete this.state.profiles[file]
    this.save()
  }

  restore({ settingsFile, modelsDir }) {
    for (const file of Object.keys(this.state.profiles)) this.checkProfile(file)
    const selectors = new Set(Object.keys(this.state.profiles).map(p => `custom:${path.basename(p, ".json")}`))
    for (const file of new Set([...Object.keys(this.state.documents), settingsFile])) {
      const entries = this.state.documents[file] ?? {}
      const raw = read(file), doc = document(raw, file)
      for (const [key, entry] of Object.entries(entries)) {
        const current = valueAt(doc, key)
        if (same(current, entry.wrote) || same(current, entry.previous)) put(doc, key, entry.before)
        // Other discovery locations added while connected remain in place.
        else if (key === "model-locations" && Array.isArray(current.value) && !entry.before.value?.includes(modelsDir)) {
          doc[key] = current.value.filter(p => p !== modelsDir)
        }
      }
      if (file === settingsFile) {
        // This also handles an unchanged default that needed no patch entry.
        if (selectors.has(doc.modelForLaunch)) {
          const before = entries.modelForLaunch?.before ?? {}
          if (selectors.has(before.value)) delete doc.modelForLaunch
          else put(doc, "modelForLaunch", before)
        }
        for (const [field, existed] of Object.entries(this.state.ecoFields)) {
          if (!Object.hasOwn(doc, field)) continue
          const preferences = document(doc[field], field)
          for (const selector of selectors) delete preferences[selector]
          if (!existed && !Object.keys(preferences).length) delete doc[field]
          else doc[field] = JSON.stringify(preferences)
        }
      }
      if (raw !== undefined) write(file, JSON.stringify(doc, null, 2) + "\n", raw)
    }
    for (const file of Object.keys(this.state.profiles)) this.removeProfile(file)
    this.state = { profiles: {}, documents: {} }
    this.save()
  }
}

export const profileID = id => "magpie-" + createHash("sha256").update(id).digest("hex").slice(0, 24)

export function catalog(payload, source) {
  if (!Array.isArray(payload?.data) || !payload.data.length || payload.has_more) throw Error("Invalid or empty gateway catalog")
  const result = new Map()
  for (const model of payload.data) {
    if (typeof model?.id !== "string" || !model.id || result.has(model.id)) throw Error("Invalid or duplicate model ID")
    const profile = {
      id: model.id,
      baseUrl: source.baseUrl,
      apiType: "OpenAICompletion",
      apiKey: source.apiKey,
      displayName: `${model.magpie_label || model.display_name || model.id} · Magpie`,
      providerName: "Magpie",
    }
    if (Number.isSafeInteger(model.context_length) && model.context_length > 0) profile.maxContextLength = model.context_length
    result.set(model.id, profile)
  }
  return result
}

function locations(junieHome) {
  const root = path.resolve(junieHome)
  return {
    modelsDir: path.join(root, "magpie", "models"),
    settingsFile: path.join(root, "settings.json"),
    configFile: path.join(root, "config.json"),
    stateFile: path.join(root, "magpie", "seed-state.json"),
  }
}

export async function seed({ junieHome, model, eco, fetchImpl = globalThis.fetch }) {
  if (eco !== undefined && !["on", "off"].includes(eco)) throw Error("--eco must be on or off")
  const at = locations(junieHome)
  const source = document(read(path.join(junieHome, "magpie", "connection.json")), "connection.json")
  if (source.apiType !== "OpenAICompletion" || typeof source.baseUrl !== "string" ||
      !source.baseUrl.endsWith("/chat/completions") || typeof source.id !== "string" || !source.id || typeof source.apiKey !== "string") {
    throw Error("Connect Junie in Magpie before seeding its models")
  }
  const url = new URL(source.baseUrl.replace(/\/chat\/completions$/, "/models"))
  if (!["http:", "https:"].includes(url.protocol)) throw Error("Unsupported gateway URL")
  const response = await fetchImpl(url.href, {
    headers: { Authorization: "Bearer " + source.apiKey, "User-Agent": "Junie", Accept: "application/json" },
    signal: AbortSignal.timeout(10000), redirect: "error",
  })
  if (!response.ok) throw Error(`Gateway catalog returned HTTP ${response.status}`)
  const models = catalog(await response.json(), source)
  if (!models.has(model ?? source.id)) throw Error("The requested default model is absent from the gateway catalog")
  const files = new Files(at.stateFile)
  const settings = document(read(at.settingsFile), "settings.json")
  const config = document(read(at.configFile), "config.json")
  const discovery = config["model-locations"] ?? []
  if (!Array.isArray(discovery)) throw Error("model-locations must be an array")
  const profiles = new Map([...models].map(([id, profile]) => [path.join(at.modelsDir, profileID(id) + ".json"), JSON.stringify(profile, null, 2) + "\n"]))
  const selectors = [...models.keys()].map(id => `custom:${profileID(id)}`)
  const selected = `custom:${profileID(model ?? source.id)}`
  const changes = {
    modelForLaunch: { value: selected },
    onboardingDefaultModelChosen: { value: "true" },
    providerForLaunch: {},
    mixForLaunch: {},
  }
  for (const field of ECO_FIELDS) document(settings[field], field)
  // Refuse collisions or user edits before any mutation.
  for (const file of new Set([...profiles.keys(), ...Object.keys(files.state.profiles)])) files.checkProfile(file)
  for (const [file, raw] of profiles) files.profile(file, raw)
  const obsolete = Object.keys(files.state.profiles).filter(file => !profiles.has(file))
  if (!discovery.includes(at.modelsDir)) files.patch(at.configFile, { "model-locations": { value: [...discovery, at.modelsDir] } })
  files.patch(at.settingsFile, changes)
  files.ecoPreferences(at.settingsFile, selectors, eco, obsolete.map(p => `custom:${path.basename(p, ".json")}`))
  for (const file of obsolete) files.removeProfile(file)
  return { models: models.size, selected, eco: "unavailable_for_custom_profiles", modelsDir: at.modelsDir }
}

export function removeSeed(junieHome) {
  const at = locations(junieHome)
  if (read(at.stateFile) === undefined) return
  new Files(at.stateFile).restore(at)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: {
      model: { type: "string" }, eco: { type: "string" }, remove: { type: "boolean" }, help: { type: "boolean", short: "h" },
    } })
    if (values.help) console.log("Usage: node seed.mjs [--model provider/model] [--eco on|off] [--remove]\nSyncs Magpie's catalog into Junie. Native ECO is unavailable for custom profiles in Junie 3893.6.")
    else {
      const junieHome = process.env.JUNIE_HOME || path.join(os.homedir(), ".junie")
      if (values.remove) {
        if (values.model !== undefined || values.eco !== undefined) throw Error("--remove cannot be combined with --model or --eco")
        removeSeed(junieHome)
        console.log("Removed seeded profiles and restored unchanged launch settings. Magpie manages connection.json separately.")
      } else {
        const result = await seed({ junieHome, model: values.model, eco: values.eco })
        console.log(`Synced ${result.models} models to ${result.modelsDir}; launch model: ${result.selected}. Restart Junie to reload /model.`)
        console.log("ECO preferences are saved. Native ECO is unavailable for custom profiles in Junie 3893.6; saving on does not enable it.")
      }
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
