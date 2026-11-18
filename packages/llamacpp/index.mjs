// Magpie provider plugin for a local llama.cpp server.
//
// A provider whose models are the .gguf files in an explicitly configured
// scan folder (searched recursively up to `scanDepth` levels). Each model is
// classified into a type (chat / decision / embedding / completion) and wired
// to the matching API shape:
//   chat       -> /v1/chat/completions   (plain chat model)
//   decision   -> /v1/systemone          (Magpie's native decision/classifier API)
//   embedding  -> /v1/embeddings         (rewritten from a chat request)
//   completion -> /v1/completions        (rewritten from a chat request)
//
// llama-server is started/stopped on demand. The binary is NOT bundled: set
// `server` in the plugin options to your llama-server path (or leave it unset
// to use `llama-server` from PATH). Only one model is served at a time;
// switching models restarts it. State lives in <plugin dir>/runtime so it
// survives a plugin-host reload.

import { spawn } from "node:child_process"
import { openSync, closeSync, readSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync, truncateSync } from "node:fs"
import { join, resolve, relative, sep } from "node:path"
import { homedir } from "node:os"

const PROVIDER = "llamacpp"
const HERE = new URL(".", import.meta.url).pathname
const RUNTIME = join(HERE, "runtime")
const STATE_FILE = join(RUNTIME, "state.json")
const LOG_FILE = join(RUNTIME, "llama-server.log")
// No bundled binary in the community package. Resolve from options.server,
// then PATH (`llama-server`), then common install locations.
const SERVER = "llama-server"
const serverPath = (c) => {
  if (typeof c.server === "string" && c.server.trim()) return c.server.trim()
  if (existsSync("/usr/bin/llama-server")) return "/usr/bin/llama-server"
  return SERVER // rely on PATH
}

// how each model type is exposed through Magpie
const TYPE_API = {
  chat: "chat",          // npm @ai-sdk/openai-compatible -> /chat/completions
  decision: "decision",  // provider.decide + model.decides -> /systemone
  embedding: "embedding",
  completion: "completion",
}
const VALID_TYPES = Object.keys(TYPE_API)

const DEFAULTS = {
  // modelsDir is REQUIRED — there is no implicit default. Configure it with:
  //   magpie plugin options <name> '{"modelsDir":"/path/to/folder"}'
  // Until set, the plugin exposes no models and the tools explain why.
  scanDepth: 3, // recurse this many subdirectory levels looking for .gguf
  port: 18081,
  ctx: 32768,
  ngl: 99,
  backend: "GPU",
  autoStart: true,
  extraArgs: "",
  noWebui: true,
  // optional: { "model-id": "chat"|"decision"|"embedding"|"completion" }
  types: {},
  // when true, try to read GGUF metadata to guess the type (default true)
  detect: true,
}

const cfg = (options = {}) => ({
  ...DEFAULTS,
  ...(options && typeof options === "object" ? options : {}),
  types: { ...(DEFAULTS.types || {}), ...((options && options.types) || {}) },
})

const dirConfigured = (c) => typeof c.modelsDir === "string" && c.modelsDir.trim().length > 0

const dirOf = (c) => {
  if (!dirConfigured(c)) return null
  const d = String(c.modelsDir).trim()
  return d.startsWith("~/") ? join(homedir(), d.slice(2)) : resolve(d)
}

const SCAN_HINT = "Set a scan folder with: magpie plugin options <name> '{\"modelsDir\":\"/path/to/folder\"}'"

// --- GGUF type detection ---------------------------------------------------
// GGUF stores metadata keys/values with a u64 length prefix. Read just the
// header buffer and pull out the exact `general.architecture` string value,
// instead of fuzzy text matching (which false-positives on keys like
// `qwen2.embedding_length`).

const readGgufHead = (file, limit = 256 * 1024) => {
  let fd
  try {
    fd = openSync(file, "r")
    const size = Math.min(limit, statSync(file).size)
    const buf = Buffer.alloc(size)
    readSync(fd, buf, 0, size, 0)
    if (buf.toString("ascii", 0, 4) !== "GGUF") return null
    return buf
  } catch { return null } finally { if (fd != null) closeSync(fd) }
}

// read a GGUF metadata value that is a plain string, by exact key
const ggufString = (buf, key) => {
  const kb = Buffer.from(key, "utf8")
  let from = 0
  while (from + kb.length <= buf.length) {
    const idx = buf.indexOf(kb, from)
    if (idx < 0) return null
    const pre = idx - 8
    if (pre >= 0 && Number(buf.readBigUInt64LE(pre)) === kb.length) {
      const to = idx + kb.length
      if (to + 12 <= buf.length && buf.readUInt32LE(to) === 8) { // 8 = string
        const vlen = Number(buf.readBigUInt64LE(to + 4))
        if (vlen > 0 && vlen < 1024 && to + 12 + vlen <= buf.length) {
          return buf.toString("utf8", to + 12, to + 12 + vlen)
        }
      }
    }
    from = idx + 1
  }
  return null
}

const detectType = (file) => {
  const buf = readGgufHead(file)
  if (!buf) return "chat"
  const t = buf.toString("latin1")
  // decision models: "<arch>.decision.type" key (Laya, Clef, ...)
  if (/\.decision\.type\b/.test(t)) return "decision"
  if (/decisions/.test(t) && /output_modalities/.test(t)) return "decision"
  // exact architecture value decides embedding vs chat
  const arch = ggufString(buf, "general.architecture") || ""
  if (/embed|bert/i.test(arch)) return "embedding"
  return "chat" // qwen/llama/gemma/... and default; 'types' option can force
}

const withType = (m, c) => {
  const forced = c.types?.[m.id]
  const type = VALID_TYPES.includes(forced) ? forced : (c.detect === false ? "chat" : m.detectedType || "chat")
  return { ...m, type }
}

// Recursively collect .gguf files up to `maxDepth` subdirectory levels.
// The id is the path relative to the scan root (without .gguf) using '/',
// so identically named files in different subfolders never collide.
const walkGguf = (root, maxDepth) => {
  const out = []
  const visit = (dir, depth) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (depth < maxDepth) visit(p, depth + 1)
      } else if (/\.gguf$/i.test(e.name) && (e.isFile() || e.isSymbolicLink())) {
        try { statSync(p) } catch { continue } // skip broken symlinks
        out.push(p)
      }
    }
  }
  visit(root, 0)
  return out
}

const relId = (root, file) => relative(root, file).replace(/\.gguf$/i, "").split(sep).join("/")

const models = (c) => {
  const d = dirOf(c)
  if (!d || !existsSync(d)) return []
  const depth = Math.max(0, Math.min(10, Number(c.scanDepth) || 3))
  return walkGguf(d, depth)
    .sort((a, b) => a.localeCompare(b))
    .map((p) => ({
      id: relId(d, p),
      file: p,
      size: statSync(p).size,
      detectedType: c.detect === false ? "chat" : detectType(p),
    }))
    .map((m) => withType(m, c))
}

const modelEntry = (m, c) => {
  const entry = {
    id: m.id,
    name: m.id,
    limit: { context: Number(c.ctx) || 32768, output: 8192 },
    tool_call: true,
  }
  if (m.type === "decision") {
    entry.decides = true
    entry.tool_call = false
    entry.name = `${m.id} (decision)`
  } else if (m.type === "embedding") {
    entry.tool_call = false
    entry.name = `${m.id} (embedding)`
  } else if (m.type === "completion") {
    entry.tool_call = false
    entry.name = `${m.id} (completion)`
  }
  return entry
}

const modelMap = (c) => Object.fromEntries(models(c).map((m) => [m.id, modelEntry(m, c)]))
const hasDecision = (c) => models(c).some((m) => m.type === "decision")

const readState = () => {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")) } catch { return null }
}
const writeState = (s) => {
  mkdirSync(RUNTIME, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(s))
}

const alive = (pid) => {
  if (!pid) return false
  try { process.kill(Number(pid), 0); return true } catch { return false }
}

const portOf = (c) => Number(c.port) || 18081
const baseURL = (c) => `http://127.0.0.1:${portOf(c)}/v1`

const health = async (c) => {
  try {
    const r = await fetch(`http://127.0.0.1:${portOf(c)}/health`, { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch { return false }
}

// verify the healthy endpoint is OUR server with OUR alias, not another
// llama.cpp instance that happens to listen on the same port
const ready = async (c, modelId) => {
  if (!(await health(c))) return false
  try {
    const r = await fetch(baseURL(c) + "/models", { signal: AbortSignal.timeout(1500) })
    const data = (await r.json())?.data ?? []
    return data.some((m) => m.id === modelId || (m.aliases ?? []).includes(modelId))
  } catch { return false }
}

const log = (text) => {
  try {
    mkdirSync(RUNTIME, { recursive: true })
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 8 * 1024 * 1024) truncateSync(LOG_FILE)
    appendFileSync(LOG_FILE, `[plugin] ${new Date().toISOString()} ${text}\n`)
  } catch {}
}

const argsFor = (m, c) => {
  const args = [
    "-m", m.file,
    "-a", m.id,
    "--host", "127.0.0.1",
    "--port", String(portOf(c)),
    "-ngl", String(Number(c.ngl)),
    "-c", String(Number(c.ctx) || 32768),
    "--parallel", "1",
  ]
  if (c.noWebui !== false) args.push("--no-webui")
  if (typeof c.extraArgs === "string" && c.extraArgs.trim()) args.push(...c.extraArgs.trim().split(/\s+/))
  return args
}

const stop = async (c, { quiet = false } = {}) => {
  const s = readState()
  const pid = s?.pid
  if (!pid || !alive(pid)) { writeState({ model: null, pid: null, port: c.port, at: null, type: null }); return }
  for (const sig of ["SIGTERM", "SIGKILL"]) {
    try { process.kill(-Number(pid), sig) } catch {
      try { process.kill(Number(pid), sig) } catch {}
    }
    for (let i = 0; i < 20; i++) {
      if (!alive(pid)) break
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!alive(pid)) break
  }
  if (!quiet) log(`stopped pid ${pid} (model ${s.model ?? "?"})`)
  writeState({ model: null, pid: null, port: c.port, at: null, type: null })
}

const start = async (modelId, c) => {
  const m = models(c).find((x) => x.id === modelId)
  if (!m) throw new Error(
    dirConfigured(c)
      ? `Unknown model ${JSON.stringify(modelId)}. Available in ${dirOf(c)}: ${models(c).map((x) => x.id).join(", ") || "(none)"}`
      : `No modelsDir configured. ${SCAN_HINT}`
  )
  const server = serverPath(c)
  if (server !== SERVER && !existsSync(server))
    throw new Error(`llama-server not found at ${server}; set the "server" option to your llama-server path`)

  await stop(c, { quiet: true })

  mkdirSync(RUNTIME, { recursive: true })
  const { openSync: open } = await import("node:fs")
  const out = open(LOG_FILE, "a")
  const env = { ...process.env }
  env.GGML_OPENVINO_DEVICE = String(c.backend || "GPU").toUpperCase() === "CPU" ? "CPU" : "GPU"

  let child
  try {
    child = spawn(server, argsFor(m, c), {
      cwd: RUNTIME, env, detached: true, stdio: ["ignore", out, out],
    })
  } catch (e) {
    throw new Error(`cannot start llama-server (${server}): ${e.message}. Install llama.cpp or set the "server" option.`)
  }
  child.on("error", (e) => log(`spawn error: ${e.message}`))
  child.unref()
  writeState({ model: m.id, pid: child.pid, port: portOf(c), at: Date.now(), type: m.type })
  log(`started pid ${child.pid}: ${m.file} [${m.type}]`)

  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if (!alive(child.pid)) throw new Error(`llama-server exited during startup; see ${LOG_FILE}`)
    if (await ready(c, m.id)) return m
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`llama-server did not become healthy within 180s; see ${LOG_FILE}`)
}

let queue = Promise.resolve()
const serial = (fn) => {
  const run = queue.then(fn, fn)
  queue = run.catch(() => {})
  return run
}

const ensure = (modelId, c) => serial(async () => {
  const s = readState()
  if (s?.model === modelId && alive(s.pid) && await ready(c, modelId)) return
  await start(modelId, c)
})

const current = async (c) => {
  const s = readState()
  const h = await health(c)
  return {
    running: Boolean(h && s?.pid && alive(s.pid)),
    model: h ? (s?.model ?? null) : null,
    type: h ? (s?.type ?? null) : null,
    pid: h ? (s?.pid ?? null) : null,
    port: portOf(c),
    since: s?.at ? new Date(s.at).toISOString() : null,
    backend: String(c.backend || "GPU").toUpperCase(),
    modelsDir: dirOf(c),
    configured: dirConfigured(c),
  }
}

const tail = (n = 40) => {
  try {
    const lines = readFileSync(LOG_FILE, "utf8").split("\n")
    return lines.slice(-Math.min(Math.max(Number(n) || 40, 1), 200)).join("\n")
  } catch { return "" }
}

// --- protocol adapters for types Magpie doesn't natively model -------------

// Magpie sends every model a chat-completions body. For embedding/completion
// models we translate the chat request to llama.cpp's native endpoint and wrap
// the result back into a chat-completion response so the agent sees a normal
// (text) answer. Decision models already speak /systemone natively.
const parseBody = (init) => {
  try {
    const raw = typeof init?.body === "string" ? init.body : new TextDecoder().decode(init?.body)
    return JSON.parse(raw)
  } catch { return null }
}

const lastUserText = (messages = []) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== "user") continue
    const x = m.content
    if (typeof x === "string") return x
    if (Array.isArray(x)) return x.map((p) => (typeof p === "string" ? p : p?.text || "")).join("\n")
  }
  return ""
}

const chatResponse = (id, text) => ({
  id: `chatcmpl-${id}`,
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model: id,
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: String(text) } }],
})

const adaptFetch = async (input, init, modelId, type, c) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input))
  const body = parseBody(init)
  const fetchIntoLlama = (u, b) => globalThis.fetch(u, { ...init, body: JSON.stringify(b) })

  if (type === "embedding") {
    const text = lastUserText(body?.messages)
    const r = await fetchIntoLlama(baseURL(c) + "/embeddings", { model: modelId, input: text })
    const j = await r.json()
    const vec = j?.data?.[0]?.embedding ?? j?.embedding ?? []
    const out = chatResponse(modelId, JSON.stringify({ dim: vec.length, embedding: vec }))
    return new Response(JSON.stringify(out), { status: r.status, headers: { "content-type": "application/json" } })
  }

  if (type === "completion") {
    const prompt = lastUserText(body?.messages)
    const r = await fetchIntoLlama(baseURL(c) + "/completions", {
      model: modelId,
      prompt,
      max_tokens: body?.max_tokens ?? body?.max_completion_tokens ?? 512,
      temperature: body?.temperature,
      stream: false,
    })
    const j = await r.json()
    const text = j?.choices?.[0]?.text ?? ""
    const out = chatResponse(modelId, text)
    return new Response(JSON.stringify(out), { status: r.status, headers: { "content-type": "application/json" } })
  }

  // chat and decision pass through unchanged (decision already targets /systemone)
  return globalThis.fetch(input, init)
}

export const LlamaCppPlugin = async (_input, options = {}) => {
  const c = cfg(options)

  return {
    config: async (config) => {
      config.provider ??= {}
      const entry = config.provider[PROVIDER] ??= {
        name: "Local llama.cpp",
        npm: "@ai-sdk/openai-compatible",
        api: baseURL(c),
        models: modelMap(c),
      }
      // Enable Magpie's native decision-model protocol only if such a model exists.
      if (hasDecision(c)) entry.decide = true
    },

    auth: {
      provider: PROVIDER,
      methods: [{ type: "api", label: "本地服务", placeholder: "任意字符串（本地服务不校验密钥）" }],

      async loader() {
        return {
          baseURL: baseURL(c),
          async fetch(input, init) {
            const body = parseBody(init)
            const modelId = body?.model
            if (!modelId) throw new Error("llamacpp: no model in request")

            const m = models(c).find((x) => x.id === modelId)
            const type = m?.type || "chat"

            if (c.autoStart === false) {
              const st = await current(c)
              if (!st.running || st.model !== modelId) {
                throw new Error(`llamacpp: server not running with ${modelId}; start it with the llamacpp_start tool (autoStart is off)`)
              }
            } else {
              await ensure(modelId, c)
            }

            if (type === "embedding" || type === "completion") {
              return adaptFetch(input, init, modelId, type, c)
            }
            return globalThis.fetch(input, init)
          },
        }
      },
    },

    provider: {
      id: PROVIDER,
      async models() { return modelMap(c) },
    },

    tool: {
      llamacpp_status: {
        description: "Show the local llama.cpp server state: running model, type, pid, port, backend.",
        args: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => current(c),
      },
      llamacpp_models: {
        description: "List GGUF models found recursively in the configured folder (up to scanDepth levels), with their auto-detected or configured type (chat/decision/embedding/completion).",
        args: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({
          dir: dirOf(c),
          scanDepth: Math.max(0, Number(c.scanDepth) || 3),
          configured: dirConfigured(c),
          hint: dirConfigured(c) ? undefined : SCAN_HINT,
          models: models(c).map((m) => ({
            id: m.id,
            type: m.type,
            detectedType: m.detectedType,
            overridden: Boolean(c.types?.[m.id]),
            sizeMiB: Math.round(m.size / 1048576),
          })),
        }),
      },
      llamacpp_start: {
        description: "Start the local llama.cpp server with a GGUF model (chat/decision/embedding/completion). Stops any other model first.",
        args: {
          type: "object",
          properties: { model: { type: "string", description: "Model id: path relative to the scan folder, without .gguf (e.g. 'chat/llama' or 'top-level')." } },
          required: ["model"],
          additionalProperties: false,
        },
        execute: async ({ model }) => {
          const m = await serial(() => start(model, c))
          return { started: m.id, type: m.type, file: m.file, ...(await current(c)) }
        },
      },
      llamacpp_stop: {
        description: "Stop the local llama.cpp server and free its memory.",
        args: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => { await serial(() => stop(c)); return await current(c) },
      },
      llamacpp_restart: {
        description: "Restart the local llama.cpp server, optionally switching to another model.",
        args: {
          type: "object",
          properties: { model: { type: "string", description: "Optional model id; defaults to the currently loaded one." } },
          additionalProperties: false,
        },
        execute: async ({ model } = {}) => {
          const s = readState()
          const id = model || s?.model || models(c)[0]?.id
          if (!id) throw new Error("no model to restart; pass model=")
          const m = await serial(() => start(id, c))
          return { restarted: m.id, type: m.type, ...(await current(c)) }
        },
      },
      llamacpp_logs: {
        description: "Read the tail of the local llama.cpp server log.",
        args: {
          type: "object",
          properties: { lines: { type: "integer", description: "Number of lines (1-200, default 40)." } },
          additionalProperties: false,
        },
        execute: async ({ lines } = {}) => tail(lines),
      },
    },
  }
}
