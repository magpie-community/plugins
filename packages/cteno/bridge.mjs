import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { agent } from "./cteno.agent.js"

export const PROFILE_ID = "magpie"
export const PICKER_GROUP = "Magpie"
export const APP_DATA_ID = "com.cteno-host.gui"
export const BASE_URL_SCHEMA = 1

// A refusal explains why nothing was written; unexpected errors omit raw text.
const refuse = (why) => Object.assign(new Error(why), { refusal: true })

const isPlainObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v)

export function appDataDirFor({
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
} = {}) {
  const override = env?.CTENO_APP_DATA_DIR?.trim()
  if (override) return override
  if (platform === "darwin") return path.join(home, "Library", "Application Support", APP_DATA_ID)
  if (platform === "win32") {
    const base = env?.APPDATA?.trim() || path.join(home, "AppData", "Roaming")
    return path.join(base, APP_DATA_ID)
  }
  const xdg = env?.XDG_DATA_HOME?.trim()
  if (xdg) return path.join(xdg, APP_DATA_ID)
  return path.join(home, ".local", "share", APP_DATA_ID)
}

export function pathsFor(opts = {}) {
  const home = opts.home ?? os.homedir()
  const control = agent.config.replace(/^~(?=\/|$)/, home)
  if (!path.isAbsolute(control)) throw new Error("agent.config must be an absolute or ~/ path")
  const dataDir = appDataDirFor({ ...opts, home })
  return {
    control,
    profiles: path.join(dataDir, "profiles.json"),
    state: path.join(path.dirname(control), ".magpie-cteno-state.json"),
  }
}

function validGatewayURL(raw) {
  if (typeof raw !== "string" || !raw.trim()) return false
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:"
}

// Reads what magpie wrote to connection.json. Returns null when disconnected
// (file absent or any of model / baseURL / gatewayKey cleared).
export function wanted(controlText) {
  if (controlText === null || controlText === undefined || controlText.trim() === "") return null
  let parsed
  try {
    parsed = JSON.parse(controlText)
  } catch {
    throw refuse("connection.json is not valid JSON")
  }
  if (!isPlainObject(parsed)) throw refuse("connection.json must be a JSON object")
  const model = typeof parsed.model === "string" ? parsed.model.trim() : ""
  const baseURL = typeof parsed.baseURL === "string" ? parsed.baseURL.trim() : ""
  const gatewayKey = typeof parsed.gatewayKey === "string" ? parsed.gatewayKey.trim() : ""
  if (!model || !baseURL || !gatewayKey) return null
  if (!validGatewayURL(baseURL)) throw refuse("connection.json baseURL must be an http(s) URL")
  const info = isPlainObject(parsed.modelInfo) ? parsed.modelInfo : {}
  const context = Number.isSafeInteger(info.context) && info.context > 0 ? info.context : null
  const output = Number.isSafeInteger(info.output) && info.output > 0
    ? (context ? Math.min(info.output, context) : info.output)
    : 8192
  return {
    model,
    baseURL,
    gatewayKey,
    context,
    output,
    images: typeof info.images === "boolean" ? info.images : undefined,
    thinking: typeof info.thinking === "boolean" ? info.thinking : undefined,
  }
}

export function buildMagpieProfile(want) {
  const endpoint = (temperature, maxTokens) => ({
    api_key: want.gatewayKey,
    base_url: want.baseURL,
    model: want.model,
    temperature,
    max_tokens: maxTokens,
    context_window_tokens: want.context,
  })
  const profile = {
    id: PROFILE_ID,
    name: want.model,
    api_format: "anthropic",
    picker_group: PICKER_GROUP,
    chat: endpoint(0.7, want.output),
    compress: endpoint(0.3, Math.min(want.output, 8192)),
  }
  if (want.images !== undefined) profile.supports_vision = want.images
  if (want.thinking !== undefined) profile.thinking = want.thinking
  return profile
}

function parseStore(text) {
  if (text === null) {
    return {
      profiles: [],
      default_profile_id: PROFILE_ID,
      base_url_schema: BASE_URL_SCHEMA,
    }
  }
  let store
  try {
    store = JSON.parse(text)
  } catch {
    throw refuse("profiles.json is not valid JSON")
  }
  if (!isPlainObject(store)) throw refuse("profiles.json root must be a JSON object")
  if ("profiles" in store && !Array.isArray(store.profiles)) {
    throw refuse("profiles.json profiles field must be an array")
  }
  const profiles = Array.isArray(store.profiles) ? store.profiles : []
  for (const item of profiles) {
    if (!isPlainObject(item) || typeof item.id !== "string" || !item.id) {
      throw refuse("profiles.json contains a profile without a string id")
    }
  }
  return store
}

function formatStore(store, referenceText) {
  const eol = referenceText?.includes("\r\n") ? "\r\n" : "\n"
  const trailing = referenceText === null || referenceText === undefined || /\r?\n$/.test(referenceText) ? eol : ""
  return JSON.stringify(store, null, 2).replace(/\n/g, eol) + trailing
}

export function applyProfile(text, want) {
  const store = parseStore(text)
  const list = Array.isArray(store.profiles) ? [...store.profiles] : []
  const mine = buildMagpieProfile(want)
  const idx = list.findIndex((p) => p.id === PROFILE_ID)
  if (idx >= 0) list[idx] = mine
  else list.push(mine)

  const next = { ...store, profiles: list, default_profile_id: PROFILE_ID }
  if (text === null && !("base_url_schema" in next)) next.base_url_schema = BASE_URL_SCHEMA

  if (text !== null) {
    try {
      if (JSON.stringify(store) === JSON.stringify(next)) return text
    } catch {}
  }
  return formatStore(next, text)
}

// Removes magpie's profile from a profiles.json that was edited while
// connected, keeping every other profile and user edit untouched.
function revertEdited(current, state) {
  const store = parseStore(current)
  const list = (Array.isArray(store.profiles) ? store.profiles : []).filter((p) => p.id !== PROFILE_ID)
  if (state.original === null && list.length === 0) return null

  const next = { ...store, profiles: list }
  if (next.default_profile_id === PROFILE_ID) {
    if (typeof state.previousDefault === "string") next.default_profile_id = state.previousDefault
    else delete next.default_profile_id
  }
  return formatStore(next, current)
}

function read(file) {
  try {
    const st = fs.lstatSync(file)
    if (!st.isFile()) throw refuse("The bridge edits only regular files")
    return fs.readFileSync(file, "utf8")
  } catch (e) {
    if (e.code === "ENOENT") return null
    throw e
  }
}

function write(file, text, mode = 0o600) {
  if (text === null) {
    fs.rmSync(file, { force: true })
    return
  }
  const existing = fs.existsSync(file) ? fs.lstatSync(file) : null
  if (existing && !existing.isFile()) throw refuse("The bridge edits only regular files")
  const keep = existing ? existing.mode & 0o777 : mode
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = path.join(path.dirname(file), `.magpie-${randomUUID()}.tmp`)
  try {
    fs.writeFileSync(temp, text, { mode: keep, flag: "wx" })
    fs.renameSync(temp, file)
  } finally {
    fs.rmSync(temp, { force: true })
  }
}

export function sync(p = pathsFor()) {
  const want = wanted(read(p.control))
  const rawState = read(p.state)
  let state = null
  if (rawState !== null) {
    try {
      state = JSON.parse(rawState)
    } catch {
      throw refuse("state file is not valid JSON")
    }
  }
  if (!want && !state) return "disconnected"

  const current = read(p.profiles)
  if (want) {
    let previousDefault = state?.previousDefault ?? null
    if (!state && current !== null) {
      const parsed = parseStore(current)
      if (typeof parsed.default_profile_id === "string" && parsed.default_profile_id !== PROFILE_ID) {
        previousDefault = parsed.default_profile_id
      }
    }
    const next = applyProfile(current, want)
    const kept = state ?? { version: 1, original: current, previousDefault }
    if (!state || state.last !== next) write(p.state, JSON.stringify({ ...kept, last: next }))
    if (next !== current) write(p.profiles, next)
    return "connected"
  }

  if (current !== null) {
    const back = current === state.last ? state.original : revertEdited(current, state)
    if (back !== current) write(p.profiles, back)
  }
  fs.rmSync(p.state, { force: true })
  return "disconnected"
}

export function startBridge(
  p = pathsFor(),
  {
    interval = 1000,
    onError = (e) => console.error(`cteno bridge paused, profiles.json left as it is${e.refusal ? `: ${e.message}` : ""}`),
  } = {},
) {
  let last
  let lastError = ""
  const tick = () => {
    try {
      const want = wanted(read(p.control))
      const sig = JSON.stringify(want)
      const needsOverwriteHeal = want !== null && read(p.state) !== null && (() => {
        const cur = read(p.profiles)
        if (cur === null) return true
        try {
          const s = JSON.parse(cur)
          return !Array.isArray(s?.profiles) || !s.profiles.some((x) => x?.id === PROFILE_ID)
        } catch {
          return false
        }
      })()
      if (sig === last && !needsOverwriteHeal && !(want === null && read(p.state) !== null)) return
      sync(p)
      last = sig
      lastError = ""
    } catch (error) {
      last = undefined
      if (error.message !== lastError) onError(error)
      lastError = error.message
    }
  }
  tick()
  const timer = setInterval(tick, interval)
  timer.unref?.()
  return () => clearInterval(timer)
}
