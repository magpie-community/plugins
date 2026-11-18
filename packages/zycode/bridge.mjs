import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { agent } from "./zycode.agent.js"

export const KEY_ENV = "MAGPIE_ZYCODE_API_KEY"
export const URL_ENV = "MAGPIE_ZYCODE_BASE_URL"
export const MODEL_ENV = agent.model
const MANAGED = ["provider", "id", "base_url", "api_key_env"]
// a refusal says why; any other error is logged without its text
const refuse = (why) => Object.assign(new Error(why), { refusal: true })

export function pathsFor(home = os.homedir()) {
  const env = agent.config.replace(/^~(?=\/|$)/, home)
  if (!path.isAbsolute(env)) throw new Error("agent.config must be an absolute or ~/ path")
  const dir = path.dirname(env)
  return { env, toml: path.join(dir, "agent.toml"), state: path.join(dir, ".magpie-zycode.json") }
}

// What local.env says magpie wants, as zycode reads that file: KEY=value
// lines, the first line of a key counts, one pair of quotes is dropped.
// null while magpie is not connected (any of the three values missing).
export function wanted(envText) {
  const found = {}
  for (const raw of (envText ?? "").split(/\r?\n/)) {
    let line = raw.trim()
    if (!line || line.startsWith("#")) continue
    if (line.startsWith("export ")) line = line.slice(7).trim()
    const eq = line.indexOf("=")
    if (eq < 1) continue
    const name = line.slice(0, eq).trim()
    if (![MODEL_ENV, KEY_ENV, URL_ENV].includes(name) || name in found) continue
    let value = line.slice(eq + 1).trim()
    if (value.length >= 2 && value[0] === value.at(-1) && `"'`.includes(value[0])) value = value.slice(1, -1)
    found[name] = value
  }
  if (!found[MODEL_ENV] || !found[KEY_ENV] || !found[URL_ENV]) return null
  const model = found[MODEL_ENV]
  if (model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) throw refuse("Unusable model id in local.env")
  let url
  try { url = new URL(found[URL_ENV]) } catch { throw refuse("Unusable gateway URL in local.env") }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw refuse("Unusable gateway URL in local.env")
  return { model, url: found[URL_ENV] }
}

// --- the [model] table of agent.toml, edited as text -----------------------
// Only what is needed to find that one table: strings, comments and
// multi-line values are followed so that a "[model]" inside one is not
// taken for a header. Anything it cannot place safely is an error, and no
// file is written.

function scanLine(line, st) {
  let i = 0
  if (st.quote) {
    const close = st.quote
    let j = 0
    while (j < line.length && !line.startsWith(close, j)) j += close[0] === '"' && line[j] === "\\" ? 2 : 1
    if (j >= line.length) return
    i = j + 3
    st.quote = null
  }
  for (; i < line.length; i++) {
    const c = line[i]
    if (c === "#") return
    if (c === '"' || c === "'") {
      const triple = c.repeat(3)
      if (line.startsWith(triple, i)) {
        const end = line.indexOf(triple, i + 3)
        if (end < 0) { st.quote = triple; return }
        i = end + 2
        continue
      }
      for (i++; i < line.length && line[i] !== c; i++) if (c === '"' && line[i] === "\\") i++
      continue
    }
    if (c === "[" || c === "{") st.depth++
    else if (c === "]" || c === "}") st.depth = Math.max(0, st.depth - 1)
  }
}

const unquote = (s) => (/^(["']).*\1$/.test(s) ? s.slice(1, -1) : s)

function modelTable(text) {
  const lines = text.split(/(?<=\n)/)
  const st = { quote: null, depth: 0 }
  let owner = -1 // line of the open table's header, -1 before the first
  let header = -1
  let end = lines.length
  const keys = new Map()
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const atStart = !st.quote && st.depth === 0
    const t = line.trim()
    if (atStart && t.startsWith("[")) {
      const m = /^\[(\[)?\s*([^\]#]*?)\s*\]\]?\s*(#.*)?$/.exec(t)
      if (!m) throw refuse("A table header in agent.toml is not readable")
      const name = m[2].split(".").map((s) => unquote(s.trim())).join(".")
      if (owner === header && header >= 0 && end === lines.length) end = i
      owner = i
      if (name === "model" || name.startsWith("model.")) {
        if (m[1] || name !== "model" || header >= 0) throw refuse("agent.toml has a [model] layout this plugin does not edit")
        header = i
      }
      continue
    }
    let entry
    if (atStart) {
      if (owner === -1 && /^\s*(["']?)model\1\s*[.=]/.test(line)) throw refuse("agent.toml sets model outside a [model] table")
      const k = /^\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*=/.exec(line)
      if (k && header >= 0 && owner === header) {
        const name = k[1] ?? k[2] ?? k[3]
        if (keys.has(name)) throw refuse("agent.toml repeats a key of [model]")
        entry = { i, line, multi: false }
        keys.set(name, entry)
      }
    }
    scanLine(line, st)
    if (entry) entry.multi = st.quote !== null || st.depth > 0
  }
  if (st.quote || st.depth) throw refuse("agent.toml ends inside a value")
  return { lines, header, end, keys }
}

const valueOf = (line) => {
  const m = /^[^=]*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?\r?\n?$/.exec(line)
  if (!m) return undefined
  try { return m[1][0] === "'" ? m[1].slice(1, -1) : JSON.parse(m[1]) } catch { return undefined }
}

export function applyModel(text, { model, url }) {
  const src = text ?? ""
  const eol = src.includes("\r\n") ? "\r\n" : "\n"
  const values = { provider: "openai", id: model, base_url: url, api_key_env: KEY_ENV }
  const table = modelTable(src)
  const make = (k, indent = "", nl = eol) => `${indent}${k} = ${JSON.stringify(values[k])}${nl}`
  if (table.header < 0) {
    const gap = src.trim() === "" ? "" : (src.endsWith("\n") ? "" : eol) + eol
    return src + gap + `[model]${eol}` + MANAGED.map((k) => make(k)).join("")
  }
  const lines = [...table.lines]
  const added = []
  for (const k of MANAGED) {
    const e = table.keys.get(k)
    if (!e) { added.push(make(k)); continue }
    if (e.multi) throw refuse(`[model] ${k} spans several lines`)
    if (valueOf(e.line) === values[k]) continue
    lines[e.i] = make(k, /^\s*/.exec(e.line)[0], /\r?\n$/.exec(e.line)?.[0] ?? "")
  }
  if (added.length) {
    if (!lines[table.header].endsWith("\n")) lines[table.header] += eol
    lines.splice(table.header + 1, 0, ...added)
  }
  return lines.join("")
}

// Takes magpie's lines out of text that was edited after the bridge wrote
// it: a line is put back, or removed, only while it still reads as the
// bridge wrote it. What the user changed since stays.
function revert(current, state) {
  const was = modelTable(state.original ?? "")
  const wrote = modelTable(state.last)
  const now = modelTable(current)
  if (now.header < 0) return current
  const lines = [...now.lines]
  const drop = new Set()
  for (const k of MANAGED) {
    const mine = now.keys.get(k)
    if (!mine || mine.line !== wrote.keys.get(k)?.line) continue
    const old = was.keys.get(k)
    if (old) lines[mine.i] = old.line.endsWith("\n") || !mine.line.endsWith("\n") ? old.line : old.line + (/\r\n$/.test(mine.line) ? "\r\n" : "\n")
    else drop.add(mine.i)
  }
  let next = lines.filter((_, i) => !drop.has(i))
  if (was.header < 0) {
    const left = modelTable(next.join(""))
    const body = left.lines.slice(left.header + 1, left.end).some((l) => l.trim() !== "")
    if (!body) next = next.filter((_, i) => i !== left.header && !(i > left.header && i < left.end))
  }
  const out = next.join("")
  if (state.original !== null && out.trimEnd() === state.original.trimEnd()) return state.original
  return out
}

// --- files ---------------------------------------------------------------

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
  if (text === null) { fs.rmSync(file, { force: true }); return }
  let keep = mode
  try { keep = fs.statSync(file).mode & 0o777 } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = path.join(path.dirname(file), `.magpie-${randomUUID()}.tmp`)
  try {
    fs.writeFileSync(temp, text, { mode: keep, flag: "wx" })
    fs.renameSync(temp, file)
  } finally {
    fs.rmSync(temp, { force: true })
  }
}

// One pass: make agent.toml say what local.env asks, or put it back.
export function sync(p = pathsFor()) {
  const want = wanted(read(p.env))
  const raw = read(p.state)
  const state = raw === null ? null : JSON.parse(raw)
  if (!want && !state) return "disconnected"
  const current = read(p.toml)
  if (want) {
    const next = applyModel(current, want)
    const kept = state ?? { version: 1, original: current }
    if (!state || state.last !== next) write(p.state, JSON.stringify({ ...kept, last: next }))
    if (next !== current) write(p.toml, next)
    return "connected"
  }
  if (current !== null) {
    const back = current === state.last ? state.original : revert(current, state)
    if (back !== current) write(p.toml, back === null || (state.original === null && back.trim() === "") ? null : back)
  }
  fs.rmSync(p.state, { force: true })
  return "disconnected"
}

export function startBridge(p = pathsFor(), { interval = 1000, onError = (e) => console.error(`zycode bridge paused, agent.toml left as it is${e.refusal ? `: ${e.message}` : ""}`) } = {}) {
  let last
  let lastError = ""
  const tick = () => {
    try {
      const want = wanted(read(p.env))
      const sig = JSON.stringify(want)
      if (sig === last && !(want === null && read(p.state) !== null)) return
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
