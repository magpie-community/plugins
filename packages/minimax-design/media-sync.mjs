import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { enrichMediaParameters, mediaCapability, mediaSpec } from "./media-capabilities.mjs"

const providerID = "provider-magpiedesign"
const adapter = fs.readFileSync(new URL("./media.adapter.js", import.meta.url), "utf8")
const digest = (value) => createHash("sha256").update(value).digest("hex").slice(0, 24)
const validModelID = (value) => typeof value === "string" && value.length > 0 && value.length <= 256 &&
  !/[\s\u0000-\u001f]/.test(value)

export function mediaPaths(home = os.homedir(), platform = process.platform, appData = process.env.APPDATA) {
  if (platform !== "darwin" && platform !== "win32") throw new Error("MiniMax Design requires macOS or Windows.")
  if (platform === "win32" && !appData) throw new Error("APPDATA is required on Windows.")
  const data = platform === "darwin"
    ? path.join(home, "Library/Application Support/@hilo/desktop")
    : path.join(appData, "@hilo/desktop")
  return { control: path.join(data, "hub-config.json"), store: path.join(data, "media-models"),
    state: path.join(data, ".magpie-media", "ownership.json") }
}

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) }
  catch (error) { if (error.code === "ENOENT") return null; throw error }
}

function atomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, text, { flag: "wx", mode: 0o600 })
    fs.renameSync(temporary, file)
  } finally { fs.rmSync(temporary, { force: true }) }
}

export function connection(paths) {
  const entry = readJSON(paths.control)?.config?.customModels?.["user-custom-magpie"]
  if (entry?.apiKey !== "magpie-minimax-design") return null
  const url = new URL(entry.baseUrl)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid MiniMax Design gateway URL.")
  }
  return { baseURL: url.href.replace(/\/$/, ""), key: entry.apiKey }
}

export async function discoverMedia(gateway) {
  const response = await fetch(`${gateway.baseURL}/models`, {
    headers: { Authorization: `Bearer ${gateway.key}`, "X-Magpie-Drawers": "1", "X-Magpie-Videomakers": "1" },
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`Media discovery returned HTTP ${response.status}.`)
  const body = await response.json()
  if (!Array.isArray(body.data)) throw new Error("Media discovery returned no model catalogue.")
  const models = new Map()
  for (const model of body.data) {
    if (!["image", "video"].includes(model.kind)) continue
    if (!validModelID(model.id)) {
      throw new Error("Media discovery returned an invalid model ID.")
    }
    const name = model.magpie_label ?? model.display_name ?? model.id
    if (typeof name !== "string" || !name.trim()) throw new Error("Media discovery returned an invalid model name.")
    models.set(`${model.kind}:${model.id}`, { ref: model.id, type: model.kind, name: name.slice(0, 60),
      images: model.modalities?.input?.includes("image") === true, owner: model.owned_by,
      parameters: model.supported_parameters })
  }
  return enrichMediaParameters([...models.values()])
}

export function applyMedia(paths, gateway, catalogue) {
  const capabilities = catalogue.map(mediaCapability)
  const state = readJSON(paths.state)
  if (!gateway && !state) return { models: 0, connected: false }
  if (state && (state.version !== 1 || !Array.isArray(state.ids) ||
      state.ids.some((id) => typeof id !== "string" || !/^custom-[a-f0-9]{24}$/.test(id)))) {
    throw new Error("Invalid Magpie media ownership record.")
  }
  fs.mkdirSync(paths.store, { recursive: true, mode: 0o700 })
  const config = path.join(paths.store, "config.json")
  const lock = `${config}.lock`
  fs.mkdirSync(lock)
  try {
    const current = readJSON(config) ?? { version: 1, providers: [], models: [] }
    if (current.version !== 1 || !Array.isArray(current.providers) || !Array.isArray(current.models)) {
      throw new Error("Unsupported or damaged Design media store.")
    }
    const owned = new Set(state?.ids ?? [])
    if (!state && current.providers.some((provider) => provider.id === providerID)) throw new Error("Magpie media provider ID is already in use.")
    const ownModels = new Map(current.models.filter((model) => owned.has(model.id)).map((model) => [model.id, model]))
    const others = current.models.filter((model) => !owned.has(model.id))
    const providers = current.providers.filter((provider) => provider.id !== providerID)
    const now = Date.now()
    const entries = gateway ? catalogue.map((model) => {
      const id = `custom-${digest(`${model.type}:${model.ref}`)}`
      if (others.some((existing) => existing.id === id)) throw new Error("A media model ID is already in use.")
      if (!owned.has(id) && fs.existsSync(path.join(paths.store, "models", id))) throw new Error("An unmanaged media model directory is already in use.")
      const previous = ownModels.get(id)
      return {
        id, name: model.name, type: model.type, provider: providerID, upstreamModel: model.ref,
        spec: { kind: "own" }, adapter: { kind: "own" }, enabled: previous?.enabled ?? true,
        createdAt: previous?.createdAt ?? now, updatedAt: previous?.name === model.name ? previous.updatedAt : now,
        pollIntervalSec: 5, timeoutMin: 30, outputsPerTask: 1,
      }
    }) : []
    if (others.length + entries.length > 200 || providers.length + (gateway ? 1 : 0) > 50) {
      throw new Error("Design's media model/provider limit would be exceeded; no models were truncated.")
    }
    if (gateway) providers.push({
      id: providerID, name: "Magpie", template: "custom", baseUrl: gateway.baseURL,
      headers: [{ name: "Authorization", prefix: "Bearer ", secret: true, value: gateway.key }],
      createdAt: current.providers.find((provider) => provider.id === providerID)?.createdAt ?? now,
    })
    const next = { ...current, providers, models: [...others, ...entries] }
    const pending = { version: 1, ids: [...new Set([...owned, ...entries.map((entry) => entry.id)])] }
    atomic(paths.state, JSON.stringify(pending))
    for (const [index, entry] of entries.entries()) {
      const folder = path.join(paths.store, "models", entry.id)
      const capability = capabilities[index]
      const files = { "spec.json": JSON.stringify(mediaSpec(capability), null, 2),
        "adapter.js": adapter.replace("const capability = null", () => `const capability = ${JSON.stringify(capability)}`) }
      for (const [name, text] of Object.entries(files)) {
        const file = path.join(folder, name)
        if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === text) continue
        atomic(file, text)
        entry.updatedAt = now
      }
    }
    if (JSON.stringify(next) !== JSON.stringify(current)) atomic(config, JSON.stringify(next, null, 2) + "\n")
    const kept = new Set(entries.map((entry) => entry.id))
    for (const id of owned) if (!kept.has(id)) fs.rmSync(path.join(paths.store, "models", id), { recursive: true, force: true })
    if (gateway) atomic(paths.state, JSON.stringify({ version: 1, ids: [...kept] }))
    else fs.rmSync(paths.state)
    return { models: entries.length, connected: !!gateway }
  } finally { fs.rmdirSync(lock) }
}

export async function syncMedia(paths) {
  const gateway = connection(paths)
  const catalogue = gateway ? await discoverMedia(gateway) : []
  if (JSON.stringify(connection(paths)) !== JSON.stringify(gateway)) throw new Error("Design connection changed during discovery.")
  return applyMedia(paths, gateway, catalogue)
}
