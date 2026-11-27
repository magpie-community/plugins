import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createHash, randomUUID } from "node:crypto"
import { constants, accessSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, dirname, isAbsolute, join } from "node:path"
import { accountScope, configOption, connect, failure, optionValues } from "./acp.mjs"

export const baseURL = "http://factory-droid.invalid/v1"
export const npm = "@ai-sdk/anthropic"

const runCLI = promisify(execFile)
const freshFor = 60_000
const keepFor = 24 * 60 * 60_000
const retryAfter = 10_000
const maximumEntries = 32
const fallback = Symbol.for("magpie.fellBack")

function asModels(rows, provisional = false) {
  const models = Object.fromEntries([["default", "Droid default", false, []], ...rows].map(([id, name, image, efforts]) => [id, {
    name, api: { id, url: baseURL, npm },
    capabilities: { toolcall: true, attachment: image, reasoning: efforts.length > 0,
      input: { text: true, image }, output: { text: true } },
    variants: Object.fromEntries(efforts.map(effort => [effort, { effort }])),
  }]))
  if (provisional) Object.defineProperty(models, fallback, { value: true })
  return models
}

function normalize(models, image) {
  if (!Array.isArray(models)) throw failure(502, "Droid returned an invalid model catalog.")
  return models.filter(m => m && !m.disabled).map(m => {
    if (typeof m.id !== "string" || !m.id) throw failure(502, "Droid returned a model without an ID.")
    const name = typeof m.displayName === "string" && m.displayName ? m.displayName : m.id
    const efforts = (m.supportedReasoningEfforts ?? []).filter(e => typeof e === "string" && !m.disabledReasoningEfforts?.includes(e))
    return [m.id, name, image && !m.noImageSupport, efforts]
  })
}

async function discover(key, signal) {
  const rpc = connect({ key, signal })
  try {
    const caps = await rpc.initialize()
    if (caps._meta?.factory?.modelsList) {
      try {
        const { models } = await rpc.request("_factory/models/list", {})
        const rows = normalize(models, !!caps.promptCapabilities?.image)
        if (rows.length && caps.promptCapabilities?.image) {
          try {
            const { stdout } = await runCLI(process.env.FACTORY_DROID_BIN || "droid", ["exec", "--list-tools"], {
              env: key ? { ...process.env, FACTORY_API_KEY: key } : process.env, signal, timeout: 3_000, windowsHide: true,
            })
            if (/^\s*(?:[•*-]\s*)?GenerateImage\b/m.test(stdout)) rows.push(["droid-image", "Factory Droid Image", true, []])
          } catch { signal?.throwIfAborted() }
        }
        return rows
      } catch (error) {
        if (error.rpcCode !== -32601) throw error
      }
    }
    const { models, configOptions } = await rpc.newSession()
    const legacy = models?.availableModels
    if (Array.isArray(legacy) && legacy.length) {
      return normalize(legacy.map(m => ({ id: m.modelId, displayName: m.name, disabled: m.disabled })), false)
    }
    const picker = configOption(configOptions, "model")
    if (Array.isArray(picker?.options)) {
      return normalize(optionValues(picker).map(m => ({ id: m.value, displayName: m.name })), false)
    }
    if (Array.isArray(legacy)) return []
    throw failure(502, "Droid did not provide session models.")
  } finally { rpc.close() }
}

// Identify the executable actually found on PATH. GUI and terminal PATHs can
// differ even when both run the same installation. A replacement invalidates it.
function executable() {
  const bin = process.env.FACTORY_DROID_BIN || "droid"
  const names = process.platform === "win32" && !/\.exe$/i.test(bin) ? [bin, bin + ".exe"] : [bin]
  const paths = isAbsolute(bin) || /[\\/]/.test(bin) ? names
    : (process.env.PATH || "").split(delimiter).flatMap(dir => names.map(name => join(dir, name)))
  for (const path of paths) {
    try {
      accessSync(path, constants.X_OK)
      const file = realpathSync(path)
      const st = statSync(file)
      if (st.isFile()) return [file, st.size, st.mtimeMs]
    } catch {}
  }
  return [bin, null]
}

function validRow(row) {
  if (!Array.isArray(row) || row.length !== 4) return false
  const [id, name, image, efforts] = row
  return typeof id === "string" && id.length > 0 && typeof name === "string" && typeof image === "boolean" &&
    Array.isArray(efforts) && efforts.every(e => typeof e === "string")
}

function readSnapshot(file) {
  if (!file) return
  try {
    if (statSync(file).size > 2_000_000) return
    const data = JSON.parse(readFileSync(file, "utf8"))
    const age = Date.now() - data.at
    if (data.version !== 1 || !Number.isSafeInteger(data.at) || age < 0 || age >= keepFor || !Array.isArray(data.rows)) return
    if (!data.rows.every(validRow)) return
    return { at: data.at, models: asModels(data.rows) }
  } catch {}
}

function saveSnapshot(file, at, rows) {
  if (!file) return
  const dir = dirname(file)
  const temp = file + "." + randomUUID() + ".tmp"
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(temp, JSON.stringify({ version: 1, at, rows }), { mode: 0o600, flag: "wx" })
    renameSync(temp, file)
    const files = readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
    if (files.length > maximumEntries) {
      const oldest = files.map(name => ({ name, at: statSync(join(dir, name)).mtimeMs })).sort((a, b) => b.at - a.at)
      for (const { name } of oldest.slice(maximumEntries)) rmSync(join(dir, name), { force: true })
    }
  } catch {} finally {
    try { rmSync(temp, { force: true }) } catch {}
  }
}

async function waitForFirstList(pending, signal) {
  let timer, abort
  try {
    await Promise.race([pending, new Promise((resolve, reject) => {
      timer = setTimeout(resolve, 6_000)
      if (signal) {
        abort = () => reject(signal.reason)
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
      }
    })])
  } finally {
    clearTimeout(timer)
    if (abort) signal.removeEventListener("abort", abort)
  }
}

export function createCatalog() {
  const entries = new Map()
  function trimEntries() {
    for (const [id, entry] of entries) {
      if (entries.size <= maximumEntries) break
      if (!entry.pending) entries.delete(id)
    }
  }
  return {
    async models(savedKey, signal) {
      signal?.throwIfAborted()
      const key = savedKey || process.env.FACTORY_API_KEY
      const owner = accountScope(key)
      if (!owner) return asModels(await discover(key, signal))
      const id = createHash("sha256").update(JSON.stringify([owner, executable()])).digest("hex")
      const cacheHome = process.env.XDG_CACHE_HOME || join(homedir(), ".cache")
      const file = key ? join(cacheHome, "magpie", "factory-droid", "models", id + ".json") : undefined
      let entry = entries.get(id)
      if (!entry) {
        entry = { snapshot: readSnapshot(file), nextAttempt: 0 }
        entries.set(id, entry)
      }
      const now = Date.now()
      if (entry.snapshot && now - entry.snapshot.at >= keepFor) entry.snapshot = undefined
      if (entry.snapshot && now - entry.snapshot.at < freshFor) {
        trimEntries()
        return entry.snapshot.models
      }
      if (!entry.pending && now >= entry.nextAttempt) {
        entry.pending = discover(key).then(rows => {
          const at = Date.now()
          entry.snapshot = { at, models: asModels(rows) }
          entry.error = undefined
          saveSnapshot(file, at, rows)
        }).catch(error => {
          entry.error = error
          entry.nextAttempt = Date.now() + retryAfter
          if (error.status === 401 || error.status === 403) {
            entry.snapshot = undefined
            try { if (file) rmSync(file, { force: true }) } catch {}
          }
        }).finally(() => { entry.pending = undefined; trimEntries() })
      }
      if (!entry.snapshot && entry.pending) await waitForFirstList(entry.pending, signal)
      if (entry.snapshot) return entry.snapshot.models
      if (entry.error) throw entry.error
      return asModels([], true)
    },
    warming() {
      const pending = [...entries.values()].map(e => e.pending).filter(Boolean)
      if (pending.length) return Promise.all(pending)
    },
  }
}
