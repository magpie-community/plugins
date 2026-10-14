// Amp (ampcode.com) credits in OpenCode and magpie, through Amp's own plugin
// API.
//
// Amp has no model API for other programs: its agent runs on Amp's servers,
// and the routes older Amp clients called (/api/provider/…) now answer "This
// version of Amp is no longer supported". What Amp does offer is plugins, and
// a plugin can call amp.ai.generate: one of Amp's models answers, billed to
// the account. So this package carries an Amp plugin, bridge.ts, puts it in
// a folder of its own and starts `amp --no-tui` there. The plugin serves
// generate on 127.0.0.1 with a key only this package knows, and the loader's
// fetch turns each chat completion into one generate. The amp CLI signs in
// and keeps its own key: this package never reads it.
//
// generate takes one system text and one prompt, has no native tool calls
// and doesn't stream, so:
// - the conversation is written out as a transcript (transcript), and the
//   tools, with how to call them, go in the system text;
// - a model calls a tool by writing an <amp_call> block, read back by
//   parseCalls. Some at times write a call in their own native format,
//   which their serving stack takes out of the text, and such a turn is
//   asked again as an object, {content, tool_calls} (turnSchema); a model
//   that answers an object request in text is asked again for text. Each
//   model is asked first the way that worked for it last (turnWith);
// - a streamed request is answered once the whole turn is in, as one
//   stream, so that a failure is still an HTTP error magpie can fall back
//   from.
import { execFile, execFileSync, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { delimiter, isAbsolute, join } from "node:path"

const ID = "amp"
const CHAT = "@ai-sdk/openai-compatible"
// the loader's fetch answers every request itself; nothing is sent here
const BASE = "http://127.0.0.1/amp/v1"

const BRIDGE = readFileSync(new URL("./bridge.ts", import.meta.url), "utf8")
const BRIDGE_VERSION = /const VERSION = '([^']+)'/.exec(BRIDGE)?.[1] ?? ""

// Amp's reasoning efforts, lowest first. Each model takes only some, and
// generate's own default, none, is refused by most (Kimi K3, GLM 5.3, Gemini
// 3.8 Flash, Grok 4.7): a request that names none asks for low.
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
const DEFAULT_EFFORT = "low"
// generate refused maxTokens over 128000 ("Invalid request body", 131072)
const MAX_TOKENS = 128_000
const DEFAULT_MAX_TOKENS = 32_000
const START_WAIT = 60_000
const CLI_WAIT = 20_000
// how long a runner of the folder's that still runs is given for its bridge
// to answer, before it is stopped (changed by the tests)
const WAITS = { runner: 15_000 }

// models offered before the account's list is read (and OpenCode's config):
// the ones a coding agent's tool calls were tried with
const SEED = [
  ["moonshotai/kimi-k3", "Kimi K3"],
  ["zhipuai/glm-5.3", "GLM-5.3"],
  ["google-vertex/gemini-3.8-flash", "Gemini 3.8 Flash"],
]

// ---- where things are ----------------------------------------------------------

// dir is the bridge's folder: the runner's working directory, with the
// bridge in its .amp/plugins, the key, the port the bridge took and the
// billing thread.
function dir() {
  return process.env.MAGPIE_AMP_DIR || join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "magpie-amp")
}

const readText = (p) => {
  try {
    return readFileSync(p, "utf8").trim()
  } catch {
    return ""
  }
}

const writeText = (p, value) => {
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, value, { mode: 0o600 })
  renameSync(tmp, p)
}

const isFile = (p) => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

// amp is the amp CLI: AMP_BIN, else on PATH, else where its installers put
// it (a desktop app's PATH may have none of them)
function amp() {
  if (process.env.AMP_BIN) return process.env.AMP_BIN
  const name = process.platform === "win32" ? "amp.exe" : "amp"
  const home = homedir()
  const dirs = [...(process.env.PATH ?? "").split(delimiter), home && join(home, ".local", "bin"), home && join(home, ".amp", "bin")]
  for (const d of dirs) if (d && isAbsolute(d.trim()) && isFile(join(d.trim(), name))) return join(d.trim(), name)
  return ""
}

const NO_AMP = "the amp CLI isn't installed: see https://ampcode.com/manual"

// cli runs the amp CLI with args and gives what it printed. It runs in the
// temporary folder, where no project's Amp plugins are.
function cli(args) {
  const exe = amp()
  if (!exe) return Promise.reject(new Error(NO_AMP))
  return new Promise((resolve, reject) => {
    execFile(exe, args, { cwd: tmpdir(), timeout: CLI_WAIT, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      const out = plain(`${stdout ?? ""}\n${stderr ?? ""}`)
      if (err) reject(new Error(lastLine(out) || err.message))
      else resolve(out)
    })
  })
}

const plain = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
const lastLine = (s) => s.trim().split("\n").filter(Boolean).at(-1)?.trim() ?? ""

// ---- the bridge ----------------------------------------------------------------

let starting = null

// bridge is the running bridge's port and key, after starting the runner if
// none answers: one start at a time.
async function bridge() {
  const d = dir()
  const key = keyOf(d)
  const port = readText(join(d, "port"))
  const h = port ? await health(port, key) : null
  if (h?.version === BRIDGE_VERSION) return { port, key }
  // a bridge of another version is stopped, and started again as this one
  // once it has gone
  if (h) {
    await stop(port, key)
    for (let i = 0; i < 20 && (await health(port, key)); i++) await new Promise((r) => setTimeout(r, 250))
  }
  starting ??= start(d, key).finally(() => (starting = null))
  return starting
}

function keyOf(d) {
  mkdirSync(d, { recursive: true, mode: 0o700 })
  const p = join(d, "key")
  let k = readText(p)
  if (!k) {
    k = "amb-" + randomBytes(24).toString("hex")
    writeText(p, k)
  }
  return k
}

async function health(port, key) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(3000) })
    return r.ok ? await r.json() : null
  } catch {
    return null
  }
}

async function stop(port, key) {
  try {
    await fetch(`http://127.0.0.1:${port}/stop`, { method: "POST", headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(3000) })
  } catch {}
}

// start writes the bridge into its folder and starts `amp --no-tui` there,
// then waits for the bridge to say its port. The runner outlives this
// process; the bridge stops it when no request has come for a while.
async function start(d, key) {
  const exe = amp()
  if (!exe) throw Object.assign(new Error(NO_AMP), { status: 503 })
  // another process (magpie and OpenCode both, say) starting it now: wait
  // for its bridge rather than start a second runner
  const lock = join(d, "start.lock")
  try {
    closeSync(openSync(lock, "wx", 0o600))
  } catch {
    if (Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? 0) < START_WAIT) return await waitFor(d, key, () => null, join(d, "runner.log"))
    rmSync(lock, { force: true })
    return start(d, key)
  }
  try {
    // The runner last started here may still run: Amp starts a plugin's
    // process again as the runner starts, so for a moment the bridge's port
    // is one nobody answers. That runner is waited for, not started twice:
    // a second exits at once ("Another Amp process is already serving
    // remote threads"), and runner.pid would then name it, not the runner
    // left running, which the bridge would never stop. One whose bridge
    // never answers is stopped.
    const old = ourRunner(d)
    if (old) {
      try {
        return await waitFor(d, key, () => (alive(old) ? null : "gone"), join(d, "runner.log"), WAITS.runner)
      } catch {}
      try {
        process.kill(old, "SIGTERM")
      } catch {}
      for (let i = 0; i < 40 && alive(old); i++) await new Promise((r) => setTimeout(r, 250))
    }
    return await spawnRunner(exe, d, key)
  } finally {
    rmSync(lock, { force: true })
  }
}

// ourRunner is the pid of the runner this package last started in d, while
// it runs: told by its command line, never a process that took its number
function ourRunner(d) {
  if (process.platform === "win32") return 0
  const pid = Number(readText(join(d, "runner.pid")))
  const id = readText(join(d, "runner-id"))
  if (!pid || !id || !alive(pid)) return 0
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).includes(`--runner-id ${id}`) ? pid : 0
  } catch {
    return 0
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === "EPERM"
  }
}

async function spawnRunner(exe, d, key) {
  const plugins = join(d, ".amp", "plugins")
  mkdirSync(plugins, { recursive: true, mode: 0o700 })
  const file = join(plugins, "magpie-bridge.ts")
  if (readText(file) !== BRIDGE.trim()) writeText(file, BRIDGE)
  const idle = Number(process.env.MAGPIE_AMP_IDLE_MINUTES)
  writeText(join(d, "idle"), String(idle > 0 ? idle : 30))
  rmSync(join(d, "port"), { force: true })
  let id = readText(join(d, "runner-id"))
  if (!id) writeText(join(d, "runner-id"), (id = "magpie-" + randomBytes(4).toString("hex")))

  const log = join(d, "runner.log")
  const fd = openSync(log, "w", 0o600)
  let exited = null
  try {
    const child = spawn(exe, ["--no-tui", "--runner-id", id], { cwd: d, detached: true, windowsHide: true, stdio: ["ignore", fd, fd], env: { ...process.env, MAGPIE_AMP_DIR: d } })
    child.once("exit", (code) => (exited = code ?? -1))
    child.once("error", (e) => (exited = e.message))
    child.unref()
    // the bridge stops this runner, and no other, when it is idle
    if (child.pid) writeText(join(d, "runner.pid"), String(child.pid))
  } finally {
    closeSync(fd)
  }
  return waitFor(d, key, () => exited, log)
}

// waitFor waits for the bridge to say its port, or the runner to stop
async function waitFor(d, key, exited, log, wait = START_WAIT) {
  const until = Date.now() + wait
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 250))
    const port = readText(join(d, "port"))
    if (port && (await health(port, key))?.version === BRIDGE_VERSION) return { port, key }
    if (exited() !== null) break
  }
  const said = lastLine(plain(readText(log)))
  throw Object.assign(
    new Error(exited() !== null ? `amp --no-tui stopped (${exited()})${said ? `: ${said}` : ""}` : `the Amp bridge didn't start in ${wait / 1000}s; see ${log}`),
    { status: 503 },
  )
}

// generate asks the bridge for one generate; an error carries the status to
// answer with.
async function generate(request, signal) {
  const { port, key } = await bridge()
  let r
  try {
    r = await fetch(`http://127.0.0.1:${port}/generate`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(request),
      signal,
    })
  } catch (e) {
    if (e?.name === "AbortError") throw e
    throw Object.assign(new Error(`the Amp bridge didn't answer: ${e?.message ?? e}`), { status: 503 })
  }
  const j = await r.json().catch(() => ({}))
  if (r.ok) return j.result
  throw ampError(String(j.error ?? `the Amp bridge answered ${r.status}`))
}

// ampError reads generate's failure, "AI inference request failed (500):
// {"ok":false,"error":"…"}", as the error and the status to answer.
function ampError(raw) {
  let message = raw
  let status = 502
  const m = /request failed \((\d{3})\):\s*(\{[\s\S]*\})\s*$/.exec(raw)
  if (m) {
    status = Number(m[1])
    try {
      const j = JSON.parse(m[2])
      message = j.error || j.message || raw
      if (j.code === "internal_error") status = 503
    } catch {}
  }
  if (/not supported by model|Invalid request body/i.test(message)) status = 400
  else if (/Model not found|not deployed/i.test(message)) status = 404
  else if (status < 400 || status === 500) status = 502
  // Amp's own fault, once in a while: worth one more try
  if (status === 503) return Object.assign(new Error(message), { status, raw, again: true })
  return Object.assign(new Error(message), { status, raw })
}

// ---- reasoning efforts -----------------------------------------------------------

// what each model took: its efforts, as a refusal listed them ("Available
// efforts: low, high, max"), and how often each way of asking for a turn
// with tools worked for it (firstWay). Kept in the bridge's folder.
let known = null
const knownFile = () => join(dir(), "models.json")

function knownOf(model) {
  known ??= (() => {
    try {
      return JSON.parse(readFileSync(knownFile(), "utf8"))
    } catch {
      return {}
    }
  })()
  return known[model] ?? {}
}

function learn(model, what) {
  known[model] = { ...knownOf(model), ...what }
  try {
    writeText(knownFile(), JSON.stringify(known))
  } catch {}
}

// nearest is the effort of have closest to want; between two as close, the
// higher
function nearest(want, have) {
  if (!have?.length || have.includes(want)) return want
  const at = EFFORTS.indexOf(want)
  let best = have[0]
  for (const e of have) {
    const d = Math.abs(EFFORTS.indexOf(e) - at)
    const b = Math.abs(EFFORTS.indexOf(best) - at)
    if (d < b || (d === b && EFFORTS.indexOf(e) > EFFORTS.indexOf(best))) best = e
  }
  return best
}

function availableEfforts(message) {
  const m = /Available efforts:\s*([a-z, ]+)/i.exec(message)
  return m ? m[1].split(",").map((s) => s.trim()).filter((e) => EFFORTS.includes(e)) : null
}

// ---- the conversation as one prompt ---------------------------------------------

function text(content) {
  if (content == null) return ""
  if (typeof content === "string") return content
  if (Array.isArray(content))
    return content
      .map((p) => (p?.type === "text" ? p.text : p?.type === "image_url" || p?.type === "image" ? "[image omitted]" : ""))
      .filter(Boolean)
      .join("\n")
  return JSON.stringify(content)
}

// transcript writes the conversation's turns after the system text. Each
// earlier turn is written the same way every time, so a request's prompt
// starts with the one before's, for a model that caches prefixes.
function transcript(messages) {
  const out = []
  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") continue
    if (m.role === "user") out.push(`<user>\n${text(m.content)}\n</user>`)
    else if (m.role === "assistant") {
      const calls = (m.tool_calls ?? []).map((c) => `<amp_call id="${c.id}" name="${c.function?.name}">${c.function?.arguments ?? "{}"}</amp_call>`)
      out.push(`<assistant>\n${[text(m.content), ...calls].filter(Boolean).join("\n")}\n</assistant>`)
    } else if (m.role === "tool") out.push(`<amp_result id="${m.tool_call_id}">\n${text(m.content)}\n</amp_result>`)
  }
  return out.join("\n\n") + "\n\nWrite the assistant's next turn."
}

// Not <tool_call>: a serving stack may take that tag for its own native tool
// call and strip it (Kimi K3 answered nothing).
const TOOL_RULES = `

# Calling tools
You have NO native function calling in this conversation: a native tool call
is lost and nothing runs. Earlier calls are shown as <amp_call> blocks and
their results as <amp_result> blocks. Give the tools to call now in
tool_calls; when you answer in plain text instead, write each call as a block
exactly like this, the arguments being one JSON object matching the tool's
parameters:

<amp_call name="TOOL_NAME">{"param": "value"}</amp_call>

You may call several tools in one turn. After your last call, STOP: never
write <amp_result>, <user> or <assistant> yourself; each result comes back in
the next prompt. When you are done or need the user, call no tool.

# Tools
`

function system(messages, tools) {
  let s = messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => text(m.content))
    .join("\n\n")
  if (tools.length)
    s += TOOL_RULES + tools.map((t) => `### ${t.function.name}\n${t.function.description ?? ""}\nparameters: ${JSON.stringify(t.function.parameters ?? {})}`).join("\n\n")
  return s
}

function turnSchema(names) {
  return {
    name: "assistant_turn",
    description: "The assistant's next turn: text for the user and the tools to call now",
    fields: {
      content: { type: "string", description: "Text for the user; may be empty while calling tools" },
      tool_calls: {
        type: "array",
        description: "Tools to call now, in order; empty when done or when you need the user",
        items: {
          type: "object",
          properties: {
            name: { type: "string", enum: names },
            arguments: { type: "object", description: "The tool's arguments, matching its parameters schema", additionalProperties: true },
          },
          required: ["name", "arguments"],
        },
      },
    },
  }
}

// parseCalls reads the calls a text reply makes, and its text before them.
// The reply is cut at the first <amp_result>, <user> or <assistant> it
// writes itself: what follows is a made-up result or turn.
function parseCalls(reply) {
  const stop = reply.search(/<(amp_result|user|assistant)[\s>]/)
  const body = stop >= 0 ? reply.slice(0, stop) : reply
  // any attributes, in any order: a model copies the transcript's id="…" too
  const re = /<amp_call\b([^>]*)>([\s\S]*?)<\/amp_call>/g
  const calls = []
  let content = body
  for (let m; (m = re.exec(body)); ) {
    if (!calls.length) content = body.slice(0, m.index)
    calls.push({ name: /\bname\s*=\s*"([^"]+)"/.exec(m[1])?.[1] ?? "", raw: m[2].trim() })
  }
  return { content: content.trim(), calls }
}

// salvage reads the calls a model wrote into an object's content instead of
// its tool_calls, and the text before them: <amp_call> blocks, GLM's own
// format (<tool_call>NAME<arg_key>K</arg_key><arg_value>V</arg_value>
// </tool_call>), or a JSON list of {name, arguments}. GLM-5.3 wrote
// "Now I'll create the two files.<tool_call>tool_calls</arg_key><arg_value>
// [{"name": "write", "arguments": {…}}, …]". Only calls of the request's own
// tools count, so a list in a final answer isn't taken for calls.
function salvage(content, names) {
  const known = new Set(names)
  const ok = (calls) => calls.length > 0 && calls.every((c) => known.has(c.name))
  const tags = parseCalls(content)
  if (ok(tags.calls)) return tags
  const glm = []
  const re = /<tool_call>\s*([\w.-]+)\s*((?:<arg_key>[\s\S]*?<\/arg_key>\s*<arg_value>[\s\S]*?<\/arg_value>\s*)*)<\/tool_call>/g
  for (let m; (m = re.exec(content)); ) {
    const args = {}
    for (const a of m[2].matchAll(/<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g)) {
      try {
        args[a[1].trim()] = JSON.parse(a[2])
      } catch {
        args[a[1].trim()] = a[2]
      }
    }
    glm.push({ name: m[1], raw: JSON.stringify(args) })
  }
  if (ok(glm)) return { content: content.slice(0, content.indexOf("<tool_call>")).trim(), calls: glm }
  const start = content.search(/\[\s*\{\s*"name"/)
  if (start < 0) return null
  for (let end = content.lastIndexOf("]"), tries = 0; end > start && tries < 50; end = content.lastIndexOf("]", end - 1), tries++) {
    let list
    try {
      list = JSON.parse(content.slice(start, end + 1))
    } catch {
      continue
    }
    if (!Array.isArray(list)) return null
    const calls = list.map((c) => ({ name: String(c?.name ?? ""), raw: typeof c?.arguments === "string" ? c.arguments : JSON.stringify(c?.arguments ?? {}) }))
    if (!ok(calls)) return null
    const before = content.slice(0, start)
    const cut = before.indexOf("<tool_call>")
    return { content: (cut >= 0 ? before.slice(0, cut) : before).trim(), calls }
  }
  return null
}

// repairArgs gives arguments as one JSON object's text, or null when they
// can't be one: text or a code fence around the object is cut away, and an
// object given as a string is unwrapped.
function repairArgs(raw) {
  const ok = (s, depth = 0) => {
    try {
      const v = JSON.parse(s)
      if (typeof v === "string" && depth < 2) return ok(v, depth + 1)
      return v && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : null
    } catch {
      return null
    }
  }
  const direct = ok(raw)
  if (direct !== null) return direct
  const a = raw.indexOf("{")
  const b = raw.lastIndexOf("}")
  return a >= 0 && b > a ? ok(raw.slice(a, b + 1)) : null
}

// ---- models --------------------------------------------------------------------

// Amp names its models provider/model; magpie offers them by the model's
// own name (kimi-k3), unless two providers' share one
const full = new Map(SEED.map(([f]) => [shortOf(f), f]))

function shortOf(id) {
  return id.includes("/") ? id.slice(id.indexOf("/") + 1) : id
}

// listModels reads `amp plugins show-agent-options`: the models a plugin
// may ask for, "  provider/model (Name)" under "Models"
function listModels(out) {
  const models = []
  let inModels = false
  for (const line of plain(out).split("\n")) {
    if (/^\S/.test(line)) inModels = line.trim() === "Models"
    else if (inModels) {
      const m = /^\s+(\S+\/\S+)(?:\s+\((.*)\))?\s*$/.exec(line)
      if (m) models.push({ full: m[1], name: m[2] || m[1] })
    }
  }
  const counts = new Map()
  for (const m of models) counts.set(shortOf(m.full), (counts.get(shortOf(m.full)) ?? 0) + 1)
  return models.map((m) => ({ ...m, id: counts.get(shortOf(m.full)) > 1 ? m.full : shortOf(m.full) }))
}

function runtimeModel(m) {
  const efforts = (knownOf(m.full).efforts ?? EFFORTS.slice(2)).filter((e) => e !== "none")
  return {
    id: m.id,
    providerID: ID,
    name: m.name,
    api: { id: m.id, url: BASE, npm: CHAT },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 0, output: 0 },
    capabilities: {
      temperature: false,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: Object.fromEntries(efforts.map((e) => [e, { reasoningEffort: e }])),
  }
}

async function models() {
  const list = listModels(await cli(["plugins", "show-agent-options"]))
  if (!list.length) throw new Error("amp listed no models")
  // the seed's first, then Amp's order: magpie offers the first ones when
  // the user has picked none
  const rank = new Map(SEED.map(([f], i) => [f, i]))
  list.sort((a, b) => (rank.get(a.full) ?? SEED.length) - (rank.get(b.full) ?? SEED.length))
  for (const m of list) full.set(m.id, m.full)
  return list
}

// ampModel is Amp's id for the model a request names
async function ampModel(id) {
  id = String(id ?? "")
  if (full.has(id)) return full.get(id)
  if (id.includes("/")) return id
  try {
    await models()
  } catch {}
  return full.get(id) ?? id
}

// ---- a chat completion as a generate -------------------------------------------

const debug = (entry) => {
  if (!process.env.MAGPIE_AMP_LOG) return
  try {
    writeFileSync(join(dir(), "calls.jsonl"), JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n", { flag: "a", mode: 0o600 })
  } catch {}
}

const newID = (prefix) => prefix + randomBytes(12).toString("hex")

// ask runs one generate at the model's nearest effort, learning a model's
// efforts from a refusal and asking once more
async function ask(request, signal) {
  const have = knownOf(request.model).efforts
  if (have) request = { ...request, reasoningEffort: nearest(request.reasoningEffort, have) }
  try {
    return await generate(request, signal).catch(async (e) => {
      if (!e.again) throw e
      await new Promise((r) => setTimeout(r, 1000))
      return generate(request, signal)
    })
  } catch (e) {
    const efforts = availableEfforts(e.message)
    if (!efforts?.length) throw e
    learn(request.model, { efforts })
    const next = nearest(request.reasoningEffort, efforts)
    if (next === request.reasoningEffort) throw e
    return await generate({ ...request, reasoningEffort: next }, signal)
  }
}

const REFUSED_TEXT = /returned text instead of only the requested object/i
// models asked for an object first until text has failed them less: asked
// for text, GLM 5.3 answered nothing, and GPT-6 Luna said it couldn't run
// commands in this session and called no tool
const OBJECT_FIRST = /^(openai|zhipuai)\//

// firstWay is the way a model is asked first: the one that has failed it
// least, counted per model (models.json: text and object, [worked,
// failed]). The counts start from one turn the prior way worked and the
// other failed, and are halved past 20, so a model whose ways change is
// followed.
function firstWay(model) {
  const k = knownOf(model)
  const prior = OBJECT_FIRST.test(model) ? "object" : "text"
  const rate = (way) => {
    const [ok, bad] = k[way] ?? [0, 0]
    return (bad + (way === prior ? 0 : 1)) / (ok + bad + 1)
  }
  const other = prior === "text" ? "object" : "text"
  return rate(other) < rate(prior) ? other : prior
}

function count(model, way, worked) {
  const c = [...(knownOf(model)[way] ?? [0, 0])]
  c[worked ? 0 : 1]++
  if (c[0] + c[1] > 20) c.forEach((n, i) => (c[i] = n / 2))
  learn(model, { [way]: c })
}

// turnWith asks for a turn that may call tools, first the way that has
// failed the model least (firstWay):
// - a text answer that is empty, or only the sentence before a call
//   ("Fixing them:"), had its call taken out: it is asked again as an
//   object;
// - an object refused because the model answered in text is asked again as
//   text.
// Only turns that show how the model calls tools are counted: a refused
// object whose text is a final answer, with no call, is neither way's
// failure.
async function turnWith(request, names, signal) {
  const model = request.model
  const asObject = async () => {
    let out
    try {
      out = await ask({ ...request, schema: turnSchema(names) }, signal)
    } catch (e) {
      if (REFUSED_TEXT.test(e.message)) return null
      throw e
    }
    const parsed = { content: typeof out?.content === "string" ? out.content : "", calls: [] }
    for (const c of Array.isArray(out?.tool_calls) ? out.tool_calls : [])
      parsed.calls.push({ name: String(c?.name ?? ""), raw: typeof c?.arguments === "string" ? c.arguments : JSON.stringify(c?.arguments ?? {}) })
    return (!parsed.calls.length && salvage(parsed.content, names)) || parsed
  }
  const asText = async () => {
    const reply = String((await ask(request, signal)) ?? "").trim()
    const parsed = parseCalls(reply)
    return { parsed, empty: !reply, cut: !!reply && !parsed.calls.length && /:$/.test(reply) }
  }

  if (firstWay(model) === "object") {
    const o = await asObject()
    if (o) {
      count(model, "object", true)
      return { mode: "object", parsed: o }
    }
    const t = await asText()
    if (t.parsed.calls.length) {
      count(model, "object", false)
      count(model, "text", true)
    }
    return { mode: "object→text", parsed: t.parsed }
  }
  const t = await asText()
  if (!t.empty && !t.cut) {
    count(model, "text", true)
    return { mode: "text", parsed: t.parsed }
  }
  count(model, "text", false)
  const o = await asObject()
  if (o) {
    count(model, "object", true)
    return { mode: `${t.empty ? "text" : "cut"}→object`, parsed: o }
  }
  // the object refused because the model has a text answer to give, which
  // the empty one lost (a final answer, as Kimi K3's was): asked once more
  if (t.empty) return { mode: "text→object→text", parsed: (await asText()).parsed }
  return { mode: "cut→object→refused", parsed: t.parsed }
}

// turn answers a chat completion: the assistant's content and tool calls
async function turn(chat, signal) {
  const messages = Array.isArray(chat.messages) ? chat.messages : []
  const tools = (Array.isArray(chat.tools) ? chat.tools : []).filter((t) => t?.type === "function" && t.function?.name)
  const names = tools.map((t) => t.function.name)
  const asked = Number(chat.max_completion_tokens ?? chat.max_tokens)
  const request = {
    model: await ampModel(chat.model),
    system: system(messages, tools),
    prompt: transcript(messages),
    maxTokens: Number.isInteger(asked) && asked > 0 ? Math.min(asked, MAX_TOKENS) : DEFAULT_MAX_TOKENS,
    reasoningEffort: EFFORTS.includes(chat.reasoning_effort) ? chat.reasoning_effort : DEFAULT_EFFORT,
  }
  const t0 = Date.now()
  let mode = "text"
  let parsed = { content: "", calls: [] }
  if (tools.length) ({ mode, parsed } = await turnWith(request, names, signal))
  else parsed.content = String((await ask(request, signal)) ?? "")
  const allowed = new Set(names)
  let bad = 0
  const calls = parsed.calls.map((c) => {
    const args = repairArgs(c.raw)
    if (args === null || !allowed.has(c.name)) bad++
    return { id: newID("call_"), type: "function", function: { name: c.name, arguments: args ?? c.raw } }
  })
  debug({ model: request.model, effort: request.reasoningEffort, mode, ms: Date.now() - t0, messages: messages.length, tools: tools.length, promptChars: request.prompt.length, calls: calls.length, bad })
  return { content: parsed.content, calls }
}

const errorResponse = ({ status, message }) =>
  new Response(JSON.stringify({ error: { message, type: "amp_error", code: status } }), {
    status,
    headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": "kept" },
  })

// answer is the chat completion's response, streamed or not. Amp reports no
// token counts to a plugin, so none are given.
async function answer(chat, signal) {
  let r
  try {
    r = await turn(chat, signal)
  } catch (e) {
    if (e?.name === "AbortError") throw e
    debug({ model: chat.model, error: String(e?.message ?? e).slice(0, 300) })
    return errorResponse({ status: e?.status ?? 502, message: String(e?.message ?? e) })
  }
  const id = newID("chatcmpl-")
  const created = Math.floor(Date.now() / 1000)
  const model = String(chat.model ?? "")
  const finish = r.calls.length ? "tool_calls" : "stop"
  const headers = { "X-Magpie-Sign-In": "kept" }
  if (!chat.stream) {
    const message = { role: "assistant", content: r.content || null, ...(r.calls.length ? { tool_calls: r.calls } : {}) }
    return Response.json({ id, object: "chat.completion", created, model, choices: [{ index: 0, message, finish_reason: finish }] }, { headers })
  }
  const chunk = (delta, finish_reason = null) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`
  let body = chunk({ role: "assistant", content: "" })
  if (r.content) body += chunk({ content: r.content })
  r.calls.forEach((c, index) => {
    body += chunk({ tool_calls: [{ index, id: c.id, type: "function", function: c.function }] })
  })
  body += chunk({}, finish) + "data: [DONE]\n\n"
  return new Response(body, { headers: { ...headers, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } })
}

// ---- sign-in and usage ------------------------------------------------------------

// whoami reads `amp usage`: who the CLI is signed in as, and the credits
// left. "Signed in as <email> (<name>)", then "**Individual credits:** $68.60
// remaining …"
function readUsage(out) {
  out = plain(out)
  const who = /Signed in as\s+(\S+)(?:\s+\(([^)]+)\))?/.exec(out)
  const credits = /\*{0,2}([A-Za-z][\w ]*credits):?\*{0,2}:?\s*(\$[\d,]+(?:\.\d+)?)\s+remaining/i.exec(out)
  return {
    user: who ? who[1] : "",
    plan: credits ? credits[1].trim() : "",
    balance: credits ? credits[2] : "",
  }
}

async function whoami() {
  if (!amp()) throw new Error(NO_AMP)
  let out
  try {
    out = await cli(["usage"])
  } catch (e) {
    throw new Error(`Amp isn't signed in: run \`amp login\` (${e.message})`)
  }
  const u = readUsage(out)
  if (!u.user) throw new Error(`Amp isn't signed in: run \`amp login\`${lastLine(out) ? ` (${lastLine(out)})` : ""}`)
  return u
}

// current takes the amp CLI's sign-in as it is: the account is the CLI's,
// and the key stays in the CLI's own store
async function current() {
  const u = await whoami()
  return {
    url: "",
    instructions: `Amp is signed in as ${u.user}.`,
    method: "auto",
    callback: async () => ({ type: "success", key: "amp-cli", metadata: { email: u.user } }),
  }
}

// ---- the plugin ---------------------------------------------------------------------

export async function AmpAuthPlugin() {
  return {
    auth: {
      provider: ID,
      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth) return {}
        return {
          baseURL: BASE,
          apiKey: "amp-cli",
          async fetch(input, init = {}) {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
            if (!/\/chat\/completions$/.test(new URL(url).pathname)) return errorResponse({ status: 404, message: "only chat completions are served" })
            let chat
            try {
              const b = init.body ?? (input instanceof Request ? await input.clone().text() : undefined)
              chat = JSON.parse(typeof b === "string" ? b : new TextDecoder().decode(b))
            } catch {
              return errorResponse({ status: 400, message: "a request that isn't JSON" })
            }
            return answer(chat, init.signal ?? (input instanceof Request ? input.signal : undefined))
          },
        }
      },
      methods: [{ type: "oauth", label: "Use the amp CLI's sign-in", authorize: current }],
      // magpie's: the credits left, as `amp usage` says
      async usage() {
        try {
          const u = await whoami()
          return { plan: u.plan, user: u.user, balance: u.balance, windows: [], signIn: "kept" }
        } catch (e) {
          return { error: e.message, windows: [], signIn: "kept" }
        }
      },
    },
    async config(config) {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      config.provider[ID] = {
        name: "Amp",
        npm: CHAT,
        api: BASE,
        ...was,
        models: {
          ...Object.fromEntries(SEED.map(([f, name]) => [shortOf(f), { name, limit: { context: 0, output: 0 }, tool_call: true, reasoning: true }])),
          ...(was.models ?? {}),
        },
      }
    },
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        if (!auth) return provider?.models ?? {}
        // a list amp couldn't give is a failure: magpie keeps the one it had
        return Object.fromEntries((await models()).map((m) => [m.id, runtimeModel(m)]))
      },
    },
  }
}

// for tests
export const _internal = { salvage, dir, amp, bridge, ampError, nearest, availableEfforts, text, transcript, system, turnSchema, parseCalls, repairArgs, listModels, turn, answer, readUsage, BRIDGE_VERSION, EFFORTS, WAITS, full, shortOf, runtimeModel, reset: () => ((known = null), full.clear(), SEED.forEach(([f]) => full.set(shortOf(f), f))) }
