import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"

// What marks an ai.models entry as ours. OpenBitFun's own Magpie connection
// writes model_source "magpie" too (magpieModels.ts), so the instance id is
// what keeps the two apart: its importer mints a random UUID, this one uses a
// fixed value, so a reconnect after any downtime still recognises its entries.
export const SOURCE = "magpie"
export const INSTANCE = "magpie-openbitfun"
const RESERVED_IDS = new Set(["primary", "fast", "auto", "default"])
const MIN_CONTEXT = 32_000

// dirs::config_dir() joined with product_identity::data_namespace(), which is
// always "openbitfun" (core-types/src/product_identity.rs).
export function configPath({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (env.OPENBITFUN_CONFIG) return env.OPENBITFUN_CONFIG
  if (platform === "win32") return env.APPDATA ? path.join(env.APPDATA, "openbitfun", "config", "app.json") : null
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "openbitfun", "config", "app.json")
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "openbitfun", "config", "app.json")
}

export function pathsFor({ home = os.homedir() } = {}) {
  const dir = path.join(home, ".config", "magpie-openbitfun")
  return {
    bridge: path.join(dir, "bridge.json"),
    library: path.join(dir, "library", "mcp.json"),
    state: path.join(dir, "state.json"),
    config: configPath({ home }),
  }
}

const isOurs = (model) =>
  model?.metadata?.model_source === SOURCE && model?.metadata?.provider_instance_id === INSTANCE

// OpenBitFun's gateway address for a model, spelled as its importer spells it.
function gatewayUrl(url) {
  try {
    const parsed = new URL(url)
    parsed.pathname = parsed.pathname.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1"
    return parsed.toString()
  } catch {
    return url
  }
}

// magpieModels.ts's magpieModelImportIssue: a model whose limits OpenBitFun
// cannot persist is not imported at all.
export function importIssue(model) {
  for (const value of [model.context, model.output]) {
    if (value != null && (!Number.isSafeInteger(value) || value <= 0 || value > 0xffffffff)) return "invalidLimits"
  }
  if (model.context != null && model.context < MIN_CONTEXT) return "contextTooSmall"
  return undefined
}

// modelConfigs.ts's allocateModelConfigId: the model name, then -2, -3…
function allocateId(base, taken) {
  const free = (candidate) => !taken.has(candidate) && !RESERVED_IDS.has(candidate.toLowerCase())
  if (free(base)) return base
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (free(candidate)) return candidate
  }
}

// The catalog magpie hands an agent says images: true for every model, whether
// or not it takes them (checked against /v1/models on 0.1.4332). OpenBitFun
// decides what to offer from these two flags, so they come from the gateway's
// own /v1/models, the list OpenBitFun's own probe reads. Unreachable keeps what
// magpie said, since a gateway that is down is not a model without pictures.
async function capabilities({ url, key }, models) {
  const unknown = new Map(models.map((model) => [model.id, null]))
  let data
  try {
    const response = await fetch(`${String(url).replace(/\/+$/, "")}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(4000),
    })
    if (!response.ok) return unknown
    data = (await response.json())?.data
  } catch {
    return unknown
  }
  if (!Array.isArray(data)) return unknown
  const found = new Map()
  for (const model of data) {
    if (!model || typeof model.id !== "string") continue
    found.set(model.id, {
      images: Array.isArray(model.modalities?.input) && model.modalities.input.includes("image"),
      tools: model.tool_call !== false,
    })
  }
  return found
}

// An AIModelConfig, in config-contracts' field order: what its importer writes.
function entryFor(model, want, id, known) {
  const context = model.context ?? undefined
  const output = model.output == null
    ? undefined
    : Math.min(model.output, Math.floor((context ?? 128_128) * 40 / 100))
  const multimodal = (known?.images ?? model.images) === true
  const tools = known?.tools !== false
  const capability = ["text_chat"]
  if (tools) capability.push("function_calling")
  if (multimodal) capability.push("image_understanding")
  const entry = {
    id,
    name: "Magpie",
    provider: "openai",
    model_name: model.id,
    base_url: gatewayUrl(want.url),
    api_key: want.key,
    ...(context == null ? {} : { context_window: context }),
    ...(output == null ? {} : { max_tokens: output }),
    enabled: true,
    category: multimodal ? "multimodal" : "general_chat",
    capabilities: capability,
    recommended_for: [],
    metadata: {
      model_source: SOURCE,
      provider_instance_id: INSTANCE,
      magpie_catalog_name: model.name && model.name !== model.id ? model.name : model.id,
      ...(model.output == null ? {} : { magpie_max_output_tokens: model.output }),
    },
    auth: { type: "api_key" },
  }
  return entry
}

// A user's own settings on one of our entries survive a reconnect: only the
// gateway, the key and the catalog's own facts follow magpie.
function refresh(known, model, want, found) {
  const fresh = entryFor(model, want, known.id, found)
  const next = { ...known, base_url: fresh.base_url, api_key: fresh.api_key, metadata: fresh.metadata }
  for (const key of ["context_window", "max_tokens", "category", "capabilities"]) {
    if (key in fresh) next[key] = fresh[key]
    else delete next[key]
  }
  return next
}

export function mergeModels(current, want, found = new Map()) {
  const kept = current.filter((model) => !isOurs(model))
  const mine = new Map()
  for (const model of current) {
    if (isOurs(model) && model.model_name) mine.set(model.model_name, model)
  }
  const taken = new Set(current.map((model) => model?.id).filter(Boolean))
  for (const model of want.models) {
    if (importIssue(model)) continue
    const capabilities = found.get(model.id) ?? null
    const known = mine.get(model.id)
    if (known) {
      kept.push(refresh(known, model, want, capabilities))
      continue
    }
    const id = allocateId(model.id, taken)
    taken.add(id)
    kept.push(entryFor(model, want, id, capabilities))
  }
  return kept
}

export function revertModels(current) {
  return current.filter((model) => !isOurs(model))
}

const modelsFor = (current, bridgeWanted, found) => {
  // An empty catalog is magpie not knowing yet, not magpie offering nothing.
  return bridgeWanted.models.length ? mergeModels(current, bridgeWanted, found) : current
}

// OpenBitFun keeps its MCP servers in app.json itself, in the shape it calls
// Cursor's (mcp/config/json_config.rs), so magpie cannot hand them a file of
// their own. It writes one into this agent's folder instead and this merges
// them in, remembering what each name held so switching off puts back exactly
// that, including the user's own servers whose names magpie never saw.
export function readLibraryMcp(file) {
  const text = read(file)
  if (text === null) return null
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const servers = parsed?.mcpServers
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return null
  return servers
}

export function mergeServers(current, wanted, prior) {
  const next = { ...current }
  if (wanted) {
    for (const [name, config] of Object.entries(wanted)) {
      if (!(name in prior)) prior[name] = name in current ? current[name] : null
      next[name] = config
    }
    return next
  }
  for (const [name, was] of Object.entries(prior)) {
    if (was === null || was === undefined) delete next[name]
    else next[name] = was
  }
  for (const name of Object.keys(prior)) delete prior[name]
  return next
}

// A bridge file magpie wrote, checked: null while the agent is off, so a
// half-written or hand-broken file leaves OpenBitFun alone.
export function wanted(read) {
  if (!read || typeof read !== "object") return null
  const bridge = read.bridge
  if (!bridge || typeof bridge !== "object") return null
  if (bridge.version !== 1) return null
  if (typeof bridge.key !== "string" || !bridge.key.trim()) return null
  if (!Array.isArray(bridge.models)) return null
  let url
  try {
    url = new URL(String(bridge.url ?? ""))
  } catch {
    return null
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null
  return { url: bridge.url, key: bridge.key, models: bridge.models }
}

function read(file) {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile()) throw new Error(`${file} is not a regular file`)
    return fs.readFileSync(file, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
}

function write(file, text, mode = 0o600) {
  let keep = mode
  try {
    keep = fs.statSync(file).mode & 0o777
  } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = path.join(path.dirname(file), `.magpie-${randomUUID()}.tmp`)
  try {
    fs.writeFileSync(temp, text, { mode: keep, flag: "wx" })
    fs.renameSync(temp, file)
  } finally {
    fs.rmSync(temp, { force: true })
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// app.json is rewritten whole, so a number spelled 1.0 comes back as 1: the same
// value, not the same text. Keeping the file as the user had it before the first
// write lets the common case, connect and then switch off, put it back byte for
// byte. A file the user edited while connected is restored from the entries
// instead, since the snapshot no longer describes it.
function stateOf(paths) {
  if (!paths.state) return null
  try {
    const saved = JSON.parse(fs.readFileSync(paths.state, "utf8"))
    if (typeof saved?.original !== "string") return null
    return { version: 1, original: saved.original, mcp: saved.mcp && typeof saved.mcp === "object" ? saved.mcp : {} }
  } catch {
    return null
  }
}

// One pass: make ai.models say what the bridge file asks, or take our entries
// out again. Keys and their order are left as they were, and app.json is never
// made: an OpenBitFun that never ran has nothing to keep up.
export async function sync(paths) {
  const config = paths.config ?? configPath()
  if (!config) return "no-openbitfun"
  const bridgeWanted = wanted(JSON.parse(read(paths.bridge) ?? "null"))
  const libraryFile = paths.library ? readLibraryMcp(paths.library) : null
  // magpie keeps the file and empties it when the agent is given no server any
  // more, so an empty list means take ours away, not keep the last set.
  const library = libraryFile && Object.keys(libraryFile).length ? libraryFile : null
  const connected = Boolean(bridgeWanted || libraryFile)
  const text = read(config)
  if (text === null) return connected ? "no-openbitfun" : "disconnected"
  let file
  try {
    file = JSON.parse(text)
  } catch {
    return "unreadable"
  }
  if (!file || typeof file !== "object" || Array.isArray(file)) return "unreadable"

  const models = Array.isArray(file.ai?.models) ? file.ai.models : []
  const wrapper = file.mcp_servers && typeof file.mcp_servers === "object" ? file.mcp_servers : null
  const servers = wrapper?.mcpServers && typeof wrapper.mcpServers === "object" && !Array.isArray(wrapper.mcpServers)
    ? wrapper.mcpServers
    : {}
  const state = stateOf(paths)
  const found = bridgeWanted ? await capabilities(bridgeWanted, bridgeWanted.models) : new Map()
  const nextModels = bridgeWanted
    ? modelsFor(models, bridgeWanted, found)
    : revertModels(models)
  const prior = state?.mcp ?? {}
  const nextServers = mergeServers(servers, library, prior)

  if (same(nextModels, models) && same(nextServers, servers)) {
    if (!connected) fs.rmSync(paths.state ?? "", { force: true })
    return connected ? "connected" : "disconnected"
  }

  // Keep the file as the user had it before the first write, so that a switch
  // off can put it back byte for byte, number spellings included.
  const original = state?.original ?? (models.some(isOurs) || Object.keys(prior).length ? null : text)
  if (!same(nextModels, models)) {
    if (!file.ai || typeof file.ai !== "object") file.ai = {}
    file.ai.models = nextModels
  }
  if (!same(nextServers, servers)) {
    if (Object.keys(nextServers).length) {
      if (!file.mcp_servers || typeof file.mcp_servers !== "object") file.mcp_servers = {}
      file.mcp_servers.mcpServers = nextServers
    } else if (wrapper) {
      delete wrapper.mcpServers
      if (!Object.keys(wrapper).length) delete file.mcp_servers
    }
  }
  // The file goes back to its exact text when nothing of ours is left in it and
  // the rest reads as it did, which is what switching the agent off comes to.
  const restored = original !== null && Object.keys(prior).length === 0 && !nextModels.some(isOurs)
    && same(JSON.parse(original), file)
  write(config, restored ? original : JSON.stringify(file, null, 2) + (text.endsWith("\n") ? "\n" : ""))
  if (!restored && paths.state) write(paths.state, JSON.stringify({ version: 1, original: original ?? text, mcp: prior }))
  else fs.rmSync(paths.state ?? "", { force: true })
  return connected ? "connected" : "disconnected"
}

export function startBridge(paths = pathsFor(), { interval = 1000, onError = (error) => console.error(`openbitfun bridge paused: ${error.message}`) } = {}) {
  let lastError = ""
  const tick = () => {
    sync(paths).catch((error) => {
      if (error.message !== lastError) onError(error)
      lastError = error.message
    })
  }
  tick()
  const timer = setInterval(tick, interval)
  timer.unref?.()
  return () => clearInterval(timer)
}
