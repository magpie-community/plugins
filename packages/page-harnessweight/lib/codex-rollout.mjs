// Read Codex rollout boundaries without retaining prompt, tool or response text.
import { createHash } from "node:crypto"
import { open, readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { StringDecoder } from "node:string_decoder"

const KEEP_MS = 30 * 86400e3
const DISCOVERY_MS = 15e3
const CHUNK_BYTES = 256 * 1024
const MAX_LINE = 8 * 1024 * 1024
const USER_TRIGGERS = new Set(["user", "composer"])
const USER_SOURCES = new Set(["cli", "vscode"])
const HASH = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const identifier = (v) => typeof v === "string" && v.length > 0 && v.length <= 512
const seconds = (v) => Number.isSafeInteger(v) && v > 0

export function defaultCodexSessionsDir(options = {}) {
  return options.codexSessionsDir ?? join(homedir(), ".codex", "sessions")
}

function newState() {
  return { offset: 0, carry: "", carryBytes: 0, malformed: 0, oversized: 0, decoder: new StringDecoder("utf8"), skipping: false,
    session: null, source: null, threadSource: null, starts: new Map(), terminals: new Map() }
}

function same(a, b) { return JSON.stringify(a) === JSON.stringify(b) }
function add(map, key, value) {
  if (!map.has(key)) map.set(key, value)
  else if (!same(map.get(key), value)) map.set(key, { conflict: true })
}

function applyLine(s, line) {
  let record
  try { record = JSON.parse(line) } catch { s.malformed++; return }
  const p = record?.payload
  if (!p || typeof p !== "object" || Array.isArray(p)) return
  if (record.type === "session_meta") {
    const meta = { session: identifier(p.id) ? p.id : false,
      source: USER_SOURCES.has(p.source) ? p.source : null, threadSource: p.thread_source === "user" ? "user" : null }
    if (s.session === null) Object.assign(s, meta)
    else if (!same({ session: s.session, source: s.source, threadSource: s.threadSource }, meta)) s.session = false
    return
  }
  if (record.type !== "event_msg") return
  if (["turn_aborted", "error"].includes(p.type) && !identifier(p.turn_id)) { s.unknownFailure = true; return }
  if (!identifier(p.turn_id)) return
  if (p.type === "task_started") {
    const a = p.turn_attribution
    const root = a?.root_turn_id ?? p.root_turn_id
    if (!a || typeof a !== "object" || !USER_TRIGGERS.has(a.turn_trigger) ||
        a.turn_id !== p.turn_id || a.parent_turn_id != null || a.initiating_agent_path != null ||
        root !== p.turn_id || (p.root_turn_id != null && p.root_turn_id !== root)) {
      s.starts.set(p.turn_id, { conflict: true }); return
    }
    add(s.starts, p.turn_id, { root,
      startedAt: seconds(p.started_at) ? p.started_at : null })
  } else if (p.type === "turn_aborted" || p.type === "error") {
    // Failure evidence must survive a later successful-looking completion.
    s.terminals.set(p.turn_id, { failed: true })
  } else if (p.type === "task_complete") {
    if (s.terminals.get(p.turn_id)?.failed) return
    const duration = Number.isSafeInteger(p.duration_ms) && p.duration_ms >= 0 ? p.duration_ms : null
    const invalidDuration = p.duration_ms != null && duration === null
    const startedAt = seconds(p.started_at) ? p.started_at : null
    const completedAt = seconds(p.completed_at) ? p.completed_at : null
    add(s.terminals, p.turn_id, { error: p.error != null, root: p.root_turn_id == null ? null : identifier(p.root_turn_id) ? p.root_turn_id : false,
      startedAt, completedAt, duration, invalidDuration })
  }
}

function feed(s, text) {
  const parts = text.split("\n")
  for (let i = 0; i < parts.length; i++) {
    if (!s.skipping) {
      s.carryBytes += Buffer.byteLength(parts[i])
      if (s.carryBytes > MAX_LINE) { s.carry = ""; s.skipping = true; s.oversized++ }
      else s.carry += parts[i]
    }
    if (i < parts.length - 1) {
      if (!s.skipping && s.carry) applyLine(s, s.carry)
      s.carry = ""
      s.carryBytes = 0
      s.skipping = false
    }
  }
}

// Original turn IDs survive replay. Import IDs are only unique within a session.
function collect(states, now) {
  const starts = new Map(), terminals = new Map()
  for (const s of states) {
    if (!identifier(s.session) || !USER_SOURCES.has(s.source) || s.threadSource !== "user") continue
    const key = (id) => HASH([id.startsWith("external-import-") ? s.session : null, id])
    for (const [id, start] of s.starts) {
      add(starts, key(id), s.unknownFailure || s.malformed || s.oversized ? { conflict: true } : start)
    }
    for (const [id, end] of s.terminals) add(terminals, key(id), end)
  }
  const rows = []
  for (const [taskKey, start] of starts) {
    const end = terminals.get(taskKey)
    if (start.conflict || !end || end.conflict || end.failed || end.error || end.invalidDuration || !end.completedAt) continue
    if (end.root != null && end.root !== start.root) continue
    if (start.startedAt != null && end.startedAt != null && start.startedAt !== end.startedAt) continue
    const started = end.startedAt ?? start.startedAt
    const duration = end.duration ?? (started && end.completedAt >= started ? (end.completedAt - started) * 1000 : null)
    const t = end.completedAt * 1000
    if (!Number.isSafeInteger(t) || !Number.isSafeInteger(duration) || duration < 0 || t > now || t < now - KEEP_MS) continue
    if (started && end.completedAt < started) continue
    rows.push({ v: 1, agent: "codex", source: "codex-rollout", taskKey,
      event: "completed", t, clock: "event", durationMs: duration,
      precision: end.duration === null ? "second" : "millisecond" })
  }
  return rows
}

// One-shot parser uses the production line parser and returns only sanitized rows.
export function parseCodexRollout(text, { now = Date.now() } = {}) {
  const state = newState()
  feed(state, text)
  return collect([state], now)
}

async function discover(root, cutoff) {
  const paths = [], issues = {}
  async function visit(dir, depth) {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) }
    catch (error) { if (error.code !== "ENOENT") issue(issues, error.code); return }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory() && depth < 4) await visit(path, depth + 1)
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        try { const info = await stat(path); if (info.mtimeMs >= cutoff) paths.push(path) }
        catch (error) { if (error.code !== "ENOENT") issue(issues, error.code) }
      }
    }
  }
  await visit(root, 0)
  return { paths, issues }
}

function issue(issues, code = "UNKNOWN") { issues[code] = (issues[code] ?? 0) + 1 }

export function createCodexReader(options = {}) {
  const dir = defaultCodexSessionsDir(options)
  const clock = options.now ?? Date.now
  const states = new Map()
  let paths = [], discovered = -Infinity, rows = [], reading = null, issues = {}, discoveryIssues = {}
  async function refresh() {
    if (reading) return reading
    reading = (async () => {
      const now = clock()
      if (now - discovered >= DISCOVERY_MS) {
        const found = await discover(dir, now - KEEP_MS)
        paths = found.paths; discoveryIssues = found.issues; discovered = now
      }
      issues = { ...discoveryIssues }
      const active = new Set(paths)
      for (const path of states.keys()) if (!active.has(path)) states.delete(path)
      for (const path of paths) {
        let handle
        try {
          handle = await open(path, "r")
          const info = await handle.stat()
          let s = states.get(path)
          if (!s || s.dev !== info.dev || s.ino !== info.ino || info.size < s.offset ||
              (info.size === s.offset && (info.mtimeMs !== s.mtimeMs || info.ctimeMs !== s.ctimeMs))) {
            s = newState(); s.dev = info.dev; s.ino = info.ino; states.set(path, s)
          }
          const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
          while (s.offset < info.size) {
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - s.offset), s.offset)
            if (!bytesRead) break
            s.offset += bytesRead
            feed(s, s.decoder.write(buffer.subarray(0, bytesRead)))
          }
          s.mtimeMs = info.mtimeMs
          s.ctimeMs = info.ctimeMs
        } catch (error) {
          if (error.code !== "ENOENT") issue(issues, error.code)
          // Never expose a stale successful sample after a read failure.
          states.delete(path)
        } finally { if (handle) await handle.close().catch(error => issue(issues, error.code)) }
      }
      for (const s of states.values()) {
        if (s.malformed) issues.malformedJson = (issues.malformedJson ?? 0) + s.malformed
        if (s.oversized) issues.oversizedLine = (issues.oversizedLine ?? 0) + s.oversized
      }
      rows = collect(states.values(), now)
    })().catch(error => { rows = []; issue(issues, error.code) }).finally(() => { reading = null })
    return reading
  }
  return { refresh, rows: () => rows, file: dir, error: () => Object.keys(issues).length > 0, issues: () => ({ ...issues }) }
}
