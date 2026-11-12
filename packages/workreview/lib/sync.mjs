import fs from "node:fs"
import path from "node:path"

export function readJSON(file) {
  try {
    const text = fs.readFileSync(file, "utf8")
    if (!text.trim()) return null
    return JSON.parse(text)
  } catch {
    return null
  }
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.magpie-tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  fs.renameSync(tmp, file)
}

// What magpie's bridge asks Work Review's config.json to hold. A bridge with
// no complete model is a disconnected agent, not a half-applied one.
export function desired(bridge) {
  const tm = bridge?.text_model
  if (!tm || typeof tm !== "object") return null
  const endpoint = typeof tm.endpoint === "string" ? tm.endpoint.trim() : ""
  const apiKey = typeof tm.api_key === "string" ? tm.api_key.trim() : ""
  const model = typeof tm.model === "string" ? tm.model.trim() : ""
  if (!endpoint || !apiKey || !model) return null
  return {
    provider: typeof tm.provider === "string" && tm.provider.trim() ? tm.provider.trim() : "custom",
    endpoint,
    api_key: apiKey,
    model,
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function restore(state) {
  if (!state) return false
  const file = state.configPath
  const cfg = readJSON(file)
  if (cfg) {
    if (state.hadTextModel) cfg.text_model = state.original
    else delete cfg.text_model
    writeAtomic(file, cfg)
  }
  return true
}

// Bring Work Review's config.json in line with magpie's bridge once.
//
// Magpie backs up and restores the four keys in the bridge (its own file).
// This keeps the real config in step, and puts the user's text_model back
// when the bridge is disconnected. Returns a short status for the log.
export function syncOnce({ bridgePath, statePath, configPath, log = () => {} } = {}) {
  const want = desired(readJSON(bridgePath))
  let state = readJSON(statePath)

  if (!want) {
    if (!state) return "idle"
    const done = restore(state)
    try {
      fs.rmSync(statePath, { force: true })
    } catch (error) {
      log(`could not clear ${statePath}: ${error.message}`)
    }
    return done ? "restored" : "idle"
  }

  // The data dir moved (or the preference changed): put the old file back
  // before taking over the new one.
  if (state && state.configPath !== configPath) {
    restore(state)
    state = null
  }

  const cfg = readJSON(configPath)
  if (!cfg) {
    log(`Work Review's config.json is not at ${configPath}; Work Review may not be installed yet`)
    return "missing"
  }

  if (!state) {
    state = {
      configPath,
      hadTextModel: Object.prototype.hasOwnProperty.call(cfg, "text_model"),
      original: cfg.text_model ?? null,
    }
  }

  const next = { ...(cfg.text_model && typeof cfg.text_model === "object" ? cfg.text_model : {}), ...want }
  if (same(cfg.text_model, next)) {
    if (!readJSON(statePath)) writeAtomic(statePath, state)
    return "current"
  }

  cfg.text_model = next
  writeAtomic(configPath, cfg)
  writeAtomic(statePath, state)
  return "applied"
}
