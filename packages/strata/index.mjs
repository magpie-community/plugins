import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync, openSync, closeSync, unlinkSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { randomUUID } from "node:crypto"

const ID = "strata"
const NPM = "@ai-sdk/openai-compatible"
const START_MS = 120_000
const starts = new Map()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function read(file) {
  try { return JSON.parse(readFileSync(file, "utf8")) }
  catch (e) { if (e.code === "ENOENT") return undefined; throw e }
}
function replace(tmp, file) {
  try {
    for (let i = 0; ; i++) {
      try { renameSync(tmp, file); return }
      catch (e) {
        if (i === 49 || !["EPERM", "EACCES", "EBUSY"].includes(e.code)) throw e
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
    }
  } finally { if (existsSync(tmp)) unlinkSync(tmp) }
}
function atomic(file, value) {
  mkdirSync(join(file, ".."), { recursive: true })
  const tmp = file + "." + randomUUID() + ".tmp"
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
  replace(tmp, file)
}
function settings(inputs) {
  const cfg = { ...inputs }
  const url = new URL(cfg.baseURL || "http://127.0.0.1:8080/v1")
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, "") !== "/v1")
    throw new Error("Strata requires a local HTTP URL ending in /v1, without credentials or query")
  url.hostname = "127.0.0.1"
  cfg.baseURL = url.href.replace(/\/$/, "")
  for (const key of ["root", "python", "config"]) {
    if (typeof cfg[key] !== "string" || !isAbsolute(cfg[key]) || !existsSync(cfg[key]))
      throw new Error(`Strata ${key}: choose an existing absolute path`)
  }
  if (typeof cfg.model !== "string" || !cfg.model.trim() || cfg.model === "configure-strata")
    throw new Error("Enter the model id from the existing Strata configuration")
  cfg.model = cfg.model.trim()
  cfg.environment = typeof cfg.environment === "string" ? JSON.parse(cfg.environment || "{}") : cfg.environment ?? {}
  if (!cfg.environment || Array.isArray(cfg.environment) || typeof cfg.environment !== "object" ||
      Object.values(cfg.environment).some((v) => typeof v !== "string"))
    throw new Error("Environment must be a JSON object of string values")
  cfg.autoStop = cfg.autoStop !== false && cfg.autoStop !== "no"
  delete cfg.apiKey
  return cfg
}
function model(id, url, provider, live) {
  const modalities = live?.architecture?.input_modalities ?? ["text"]
  return {
    id, providerID: provider.id, name: id, api: { id, url, npm: NPM },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: live?.meta?.n_ctx ?? 0, output: 0 },
    capabilities: { temperature: true, reasoning: false, toolcall: false, attachment: modalities.includes("image"),
      input: { text: true, image: modalities.includes("image") }, output: { text: true } },
    headers: {}, options: {}, variants: {},
  }
}
function runtime(directory, cfg) {
  return join(directory, "strata", "127.0.0.1-" + (new URL(cfg.baseURL).port || "80"))
}
function gateway(directory) {
  const address = process.env.MAGPIE_ADDR
  if (address) {
    const u = new URL("http://" + address)
    if (!["127.0.0.1", "localhost", "0.0.0.0"].includes(u.hostname))
      throw new Error("Cannot confirm a local Magpie gateway")
    return Number(u.port || "80")
  }
  return read(join(directory, "settings.json"))?.port || 3425
}
function policy(directory, cfg) {
  atomic(join(runtime(directory, cfg), "policy.json"), { autoStop: cfg.autoStop, gatewayPort: gateway(directory), revision: randomUUID() })
}
async function health(cfg) {
  let response
  try { response = await fetch(new URL("/health", cfg.baseURL), { signal: AbortSignal.timeout(2000) }) }
  catch (e) { if (e.name === "TimeoutError" || e.code || e.cause?.code) return false; throw e }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Strata health returned HTTP ${response.status}; the port may be occupied`) }
  let body
  try { body = await response.json() } catch { throw new Error("Strata health returned invalid JSON; refusing to start another service") }
  if (body?.service !== "strata" || body.status !== "ok")
    throw new Error("The configured port does not report a healthy Strata service")
  return true
}
async function start(directory, cfg) {
  if (await health(cfg)) return
  if (process.platform !== "win32") throw new Error("Managed Strata startup currently requires Windows")
  const dir = runtime(directory, cfg)
  mkdirSync(dir, { recursive: true })
  const script = join(dir, "manager.py")
  // Running resources live outside the installed package so uninstall cannot remove them.
  const temporary = script + "." + randomUUID() + ".tmp"
  copyFileSync(join(import.meta.dir, "manager.py"), temporary)
  replace(temporary, script)
  const log = openSync(join(dir, "manager.log"), "a", 0o600)
  const attempt = Date.now()
  const child = spawn(cfg.python, ["-B", script, dir], {
    detached: true, windowsHide: true, stdio: ["pipe", "ignore", log],
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  })
  closeSync(log)
  let failed, exitCode
  child.on("exit", (code) => { exitCode = code })
  child.on("error", (e) => { failed = e })
  child.stdin.on("error", () => {})
  child.stdin.end(JSON.stringify({ ...cfg, gatewayPort: gateway(directory) }))
  child.unref()
  const end = Date.now() + START_MS
  while (Date.now() < end) {
    if (failed) throw new Error("Cannot launch Strata manager: " + failed.message)
    const state = read(join(dir, "state.json"))
    if (state?.status === "error" && state.updated * 1000 >= attempt)
      throw new Error("Strata startup: " + state.error)
    if (exitCode && exitCode !== 0)
      throw new Error("Strata manager exited: " + (state?.error ?? "check " + join(dir, "manager.log")))
    if (await health(cfg)) return
    await sleep(100)
  }
  throw new Error(`Strata did not become ready within ${START_MS / 1000}s; see ${join(dir, "manager.log")}`)
}
async function ensure(directory, cfg) {
  const key = runtime(directory, cfg)
  if (!starts.has(key)) starts.set(key, start(directory, cfg).finally(() => starts.delete(key)))
  return starts.get(key)
}
function cancelledWait(promise, signal) {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    signal.addEventListener("abort", aborted, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted))
  })
}
export async function StrataPlugin({ client, directory = process.cwd() }) {
  return {
    async config(config) {
      const all = read(join(directory, "plugin-auth.json")) ?? {}
      const auth = Object.entries(all).find(([key]) => key === ID || key.startsWith(ID + "#"))?.[1]
      const cfg = auth?.metadata
      config.provider ??= {}
      const p = config.provider[ID] ??= { name: "Strata", npm: NPM }
      p.api = cfg?.baseURL ?? p.api ?? "http://127.0.0.1:8080/v1"
      if (cfg?.model) delete p.models?.["configure-strata"]
      p.models = { [cfg?.model ?? "configure-strata"]: { name: cfg?.model ?? "Configure Strata before requesting",
        tool_call: false, reasoning: false }, ...(p.models ?? {}) }
    },
    provider: {
      id: ID,
      async models(provider, { auth }) {
        if (!auth?.metadata) return provider.models
        const cfg = settings(auth.metadata)
        const fallback = { ...provider.models, [cfg.model]: provider.models?.[cfg.model] ?? model(cfg.model, cfg.baseURL, provider) }
        delete fallback["configure-strata"]
        try {
          const response = await fetch(cfg.baseURL + "/models", {
            headers: { Authorization: "Bearer " + auth.key }, signal: AbortSignal.timeout(2000),
          })
          if (!response.ok) { await response.body?.cancel(); throw new Error("Model discovery unavailable") }
          const body = await response.json()
          if (!Array.isArray(body.data) || !body.data.length) throw new Error("Model list is empty")
          const valid = body.data.filter((m) => typeof m?.id === "string" && m.id.trim())
          if (!valid.length) throw new Error("Model list contains no usable ids")
          return Object.fromEntries(valid.map((m) => [m.id, model(m.id, cfg.baseURL, provider, m)]))
        } catch {
          fallback[Symbol.for("magpie.fellBack")] = true
          return fallback
        }
      },
    },
    auth: {
      provider: ID,
      methods: [{
        type: "api", label: "Configure local Strata",
        prompts: [
          { type: "text", key: "root", message: "Existing Strata installation directory" },
          { type: "text", key: "python", message: "Existing Strata Python executable (absolute path)" },
          { type: "text", key: "config", message: "Existing Strata engine configuration (absolute path)" },
          { type: "text", key: "model", message: "Target model id from that configuration" },
          { type: "text", key: "baseURL", message: "Strata API URL", placeholder: "http://127.0.0.1:8080/v1" },
          { type: "text", key: "environment", message: "Launch environment as JSON (blank for {})", placeholder: "{}" },
          { type: "text", key: "apiKey", message: "Strata API key (blank when none)" },
          { type: "select", key: "autoStop", message: "Stop plugin-started Strata when Magpie really exits?",
            options: [{ label: "Yes (default)", value: "yes" }, { label: "No, keep the managed instance", value: "no" }] },
        ],
        async authorize(inputs = {}) {
          const cfg = settings(inputs)
          const auth = { type: "api", key: inputs.apiKey || "strata-local", metadata: cfg }
          await client.auth.set({ path: { id: ID }, body: auth })
          policy(directory, cfg)
          return { type: "success", key: auth.key, metadata: cfg }
        },
      }],
      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth?.metadata) return {}
        const cfg = settings(auth.metadata)
        policy(directory, cfg)
        return {
          baseURL: cfg.baseURL, apiKey: auth.key,
          async fetch(input, init) {
            const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
            signal?.throwIfAborted()
            const current = await getAuth()
            const target = settings(current.metadata)
            await cancelledWait(ensure(directory, target), signal)
            signal?.throwIfAborted()
            return fetch(input, init)
          },
        }
      },
    },
  }
}
