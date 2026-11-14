import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { enrichMediaParameters, mediaCapability, mediaSpec } from "./media-capabilities.mjs"
import { speechModel } from "./speech.mjs"

const providerID = "provider-magpiedesign"
const adapter = fs.readFileSync(new URL("./media.adapter.js", import.meta.url), "utf8")
const digest = (value) => createHash("sha256").update(value).digest("hex").slice(0, 24)
const validModelID = (value) => typeof value === "string" && value.length > 0 && value.length <= 256 &&
  value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)

export function mediaPaths(home = os.homedir(), platform = process.platform, appData = process.env.APPDATA) {
  if (platform !== "darwin" && platform !== "win32") throw new Error("MiniMax Design requires macOS or Windows.")
  if (platform === "win32" && !appData) throw new Error("APPDATA is required on Windows.")
  const data = platform === "darwin"
    ? path.join(home, "Library/Application Support/@hilo/desktop")
    : path.join(appData, "@hilo/desktop")
  return { control: path.join(data, "hub-config.json"), store: path.join(data, "media-models"),
    state: path.join(data, ".magpie-media", "ownership.json") }
}

export function prepareAgentPath(paths, home = os.homedir()) {
  const target = path.dirname(paths.control)
  if (!fs.existsSync(target)) return false
  const entry = path.join(home, ".minimax-design")
  const existing = fs.lstatSync(entry, { throwIfNoEntry: false })
  if (existing) {
    if (!existing.isSymbolicLink() || fs.realpathSync(entry) !== fs.realpathSync(target)) {
      throw new Error(`MiniMax Design agent path is occupied: ${entry}`)
    }
    return true
  }
  fs.symlinkSync(target, entry, process.platform === "win32" ? "junction" : "dir")
  return true
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

export async function discoverMedia(gateway, options = {}, providers = {}) {
  const routes = options.imageRoutes ?? {}
  const parameters = options.mediaParameters ?? {}
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters) ||
      Object.entries(parameters).some(([ref, value]) => !validModelID(ref) || !value ||
        typeof value !== "object" || Array.isArray(value))) {
    throw new Error("mediaParameters must map model IDs to parameter schemas.")
  }
  if (!routes || typeof routes !== "object" || Array.isArray(routes) ||
      Object.entries(routes).some(([from, to]) => !validModelID(from) || !validModelID(to) || from === to) ||
      new Set(Object.values(routes)).size !== Object.keys(routes).length ||
      Object.values(routes).some((to) => Object.hasOwn(routes, to))) {
    throw new Error("imageRoutes must map distinct model IDs without chains or duplicate targets.")
  }
  const response = await fetch(`${gateway.baseURL}/models`, {
    headers: { Authorization: `Bearer ${gateway.key}`, "X-Magpie-Drawers": "1", "X-Magpie-Videomakers": "1" },
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`Media discovery returned HTTP ${response.status}.`)
  const body = await response.json()
  if (!Array.isArray(body.data)) throw new Error("Media discovery returned no model catalogue.")
  const sourceModels = new Map(Object.entries(providers).flatMap(([id, provider]) =>
    Object.entries(provider.models ?? {}).map(([modelID, model]) => [`${id}/${modelID}`, model])))
  const models = new Map()
  for (const model of body.data) {
    let type = model.kind
    if (!["image", "video"].includes(type)) {
      if (!speechModel(model) && !speechModel(sourceModels.get(model.id) ?? {})) continue
      type = "speech"
    }
    if (!validModelID(model.id)) {
      throw new Error("Media discovery returned an invalid model ID.")
    }
    const name = model.magpie_label ?? model.display_name ?? model.id
    if (typeof name !== "string" || !name.trim()) throw new Error("Media discovery returned an invalid model name.")
    models.set(`${type}:${model.id}`, { ref: model.id, type, name: name.slice(0, 60),
      images: model.modalities?.input?.includes("image") === true ||
        model.supported_endpoint_types?.includes("image-edit") === true, owner: model.owned_by,
      imageOnly: model.modalities?.output?.includes("image") === true && !model.modalities.output.includes("text"),
      mediaRequest: model.media_request,
      parameters: type === "speech" && Array.isArray(model.supported_parameters) ? undefined : model.supported_parameters })
  }
  for (const [from, to] of Object.entries(routes)) {
    const model = models.get(`image:${from}`)
    if (!model) continue
    const replacement = models.get(`image:${to}`)
    if (!replacement) throw new Error(`Configured image route is unavailable: ${to}`)
    models.set(`image:${model.ref}`, { ...replacement, ref: model.ref, name: model.name, requestModel: replacement.ref })
    models.delete(`image:${replacement.ref}`)
  }
  for (const model of models.values()) {
    const ref = model.requestModel ?? model.ref
    const source = sourceModels.get(ref)
    if (!source) continue
    model.mediaRequest ??= source.media_request
    if (source.modalities?.input?.includes("image")) model.images = true
    const declared = { ...source.supported_parameters }
    const limit = source.capabilities?.maxReferences
    if (declared.input_references === undefined && limit !== undefined && limit !== null) {
      declared.input_references = { type: "range", min: source.capabilities?.generate === false ? 1 : 0, max: limit }
    }
    if (source.capabilities?.edit === false) declared.input_references = { type: "range", min: 0, max: 0 }
    if (Object.keys(declared).length) {
      if (model.parameters === undefined) model.parameterSource = "plugin-config"
      model.parameters = { ...declared, ...model.parameters }
    }
  }
  const catalogue = await enrichMediaParameters([...models.values()])
  for (const model of catalogue) {
    const manual = parameters[model.requestModel ?? model.ref]
    if (!manual) continue
    if (model.parameters === undefined) model.parameterSource = "plugin-options"
    model.parameters = { ...manual, ...model.parameters }
  }
  return catalogue
}

export function applyMedia(paths, gateway, catalogue) {
  const capabilities = catalogue.map((model) => {
    const capability = mediaCapability(model)
    if (model.requestModel) capability.requestModel = model.requestModel
    return capability
  })
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

export async function syncMedia(paths, options = {}, providers = {}) {
  const gateway = connection(paths)
  const catalogue = gateway ? await discoverMedia(gateway, options, providers) : []
  if (JSON.stringify(connection(paths)) !== JSON.stringify(gateway)) throw new Error("Design connection changed during discovery.")
  return applyMedia(paths, gateway, catalogue)
}
