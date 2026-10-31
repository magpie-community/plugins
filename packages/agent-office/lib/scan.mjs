// Finds the session files each agent writes, in each agent's own folder,
// and reads the ones that changed: whole when new, then only what was
// appended. readers.mjs turns the text into a session's facts.
//
// Cheap on purpose: it runs every second or two while magpie is open. A
// folder is listed only for files changed in the last `days`; a file is
// read again only when its size or time moved; a big file is read from its
// tail (a turn's state is in its last lines, and the start of the file —
// the session header, its first prompt — is read once and kept).
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { readClaude, readCodex, readCopilot, readDsh, readGemini, readGrok, readKimi, readPi } from "./readers.mjs"

const HEAD = 64 * 1024 // what is kept of a file's start: its header, its first prompt
const TAIL = 512 * 1024 // what is read of a big file's end
// Kimi and Grok need every event (a tool still open can be far from the end),
// so a file up to this size is replayed whole; past it the head/tail read
// keeps a tick from stalling on a pathological log.
const REPLAY_MAX = 32 * 1024 * 1024
// A dsh session is one compressed file that is rewritten on every step, so
// decoding all of it each 1.5 s tick is wasteful while it is being written.
// The cap keeps a pathological file from stalling a tick, and an active one
// is decoded at most once every ZSTD_EVERY: its last facts stand meanwhile.
const ZSTD_MAX = 8 * 1024 * 1024
const ZSTD_EVERY = 4000
const META_MAX = 256 * 1024 // a state.json / summary.json is small; never read more
// Claude Code keeps one file per running process, <config>/sessions/<pid>.json.
// A mid-turn session with no live process has stopped, even when the file
// ends before a turn-ending event: `claude -p` killed from another agent.
const GONE_AFTER = 10e3
const MIDTURN = new Set(["thinking", "tool", "approval", "ask"])

function env(k) { return (process.env[k] || "").trim() }
function home(...p) { return join(env("HOME") || homedir(), ...p) }
function expand(p) { return p.startsWith("~/") ? home(p.slice(2)) : p }

// an agent's home may be overridden by a *_HOME or *_CONFIG_DIR variable
function agentHome(homeVar, configVar, ...fallback) {
  if (env(homeVar)) return expand(env(homeVar))
  if (configVar && env(configVar)) return expand(env(configVar))
  return home(...fallback)
}

// omp keeps a profile per working identity: <home>/profiles/<name>/agent/sessions
function ompProfiles(omp) {
  const out = []
  let names = []
  try { names = readdirSync(join(omp, "profiles"), { withFileTypes: true }) } catch { return out }
  for (const e of names) {
    if (!e.isDirectory()) continue
    out.push({ agent: "omp", kind: "pi", root: join(omp, "profiles", e.name, "agent", "sessions"), depth: 1, match: (n) => n.endsWith(".jsonl"), profile: e.name })
  }
  return out
}

// where each agent keeps its sessions: { agent, kind, root, depth, match }
// depth: how many folders down from root the files sit
export function sources() {
  const claude = agentHome("CLAUDE_CONFIG_DIR", "", ".claude")
  const codex = agentHome("CODEX_HOME", "", ".codex")
  const dsh = agentHome("DSH_HOME", "", ".dsh")
  const pi = env("PI_CODING_AGENT_DIR") ? expand(env("PI_CODING_AGENT_DIR")) : home(".pi", "agent")
  const omp = agentHome("OMP_HOME", "OMP_CONFIG_DIR", ".omp")
  const kimi = agentHome("KIMI_CODE_HOME", "KIMI_CONFIG_DIR", ".kimi-code")
  const grok = agentHome("GROK_HOME", "GROK_CONFIG_DIR", ".grok")
  const copilot = agentHome("COPILOT_HOME", "COPILOT_CONFIG_DIR", ".copilot")
  const qoder = agentHome("QODER_CONFIG_DIR", "", ".qoder")
  const qodercn = agentHome("QODERCN_CONFIG_DIR", "", ".qoder-cn")
  const workbuddy = agentHome("WORKBUDDY_CONFIG_DIR", "", ".workbuddy")
  const codebuddy = agentHome("CODEBUDDY_CONFIG_DIR", "", ".codebuddy")
  const jsonl = (n) => n.endsWith(".jsonl")
  const srcs = [
    { agent: "claude", kind: "claude", root: join(claude, "projects"), depth: 1, match: jsonl, live: join(claude, "sessions") },
    // a subagent's file sits project/<session>/subagents/<agent>.jsonl
    { agent: "claude", kind: "claude", root: join(claude, "projects"), depth: 3, match: (n, p) => n.endsWith(".jsonl") && basename(dirname(p)) === "subagents", subagent: true },
    { agent: "codex", kind: "codex", root: join(codex, "sessions"), depth: 3, match: (n) => n.startsWith("rollout-") && n.endsWith(".jsonl") },
    { agent: "dsh", kind: "dsh", root: join(dsh, "sessions"), depth: 2, match: (n) => n === "session.v4.jsonl.zstd" || n === "session.v4.jsonl" },
    { agent: "gemini", kind: "gemini", root: home(".gemini", "tmp"), depth: 2, match: (n) => n.startsWith("session-") && (n.endsWith(".json") || n.endsWith(".jsonl")) },
    { agent: "qwen", kind: "gemini", root: home(".qwen", "tmp"), depth: 2, match: (n) => n.startsWith("session-") && (n.endsWith(".json") || n.endsWith(".jsonl")) },
    { agent: "pi", kind: "pi", root: join(pi, "sessions"), depth: 1, match: jsonl },
    { agent: "omp", kind: "pi", root: join(omp, "agent", "sessions"), depth: 1, match: jsonl },
    ...ompProfiles(omp),
    { agent: "kimi", kind: "kimi", root: join(kimi, "sessions"), depth: 4, match: (n) => n === "wire.jsonl", meta: (p) => join(dirname(dirname(dirname(p))), "state.json") },
    { agent: "grok", kind: "grok", root: join(grok, "sessions"), depth: 2, match: (n) => n === "updates.jsonl", meta: (p) => join(dirname(p), "summary.json") },
    { agent: "copilot", kind: "copilot", root: join(copilot, "session-state"), depth: 1, match: (n) => n === "events.jsonl" },
    { agent: "qoder", kind: "claude", root: join(qoder, "projects"), depth: 1, match: jsonl, live: join(qoder, "sessions") },
    { agent: "qoder-cn", kind: "claude", root: join(qodercn, "projects"), depth: 1, match: jsonl, live: join(qodercn, "sessions") },
    { agent: "workbuddy", kind: "claude", root: join(workbuddy, "projects"), depth: 1, match: jsonl, live: join(workbuddy, "sessions") },
    { agent: "codebuddy", kind: "claude", root: join(codebuddy, "projects"), depth: 1, match: jsonl, live: join(codebuddy, "sessions") },
  ]
  return srcs
}

// the files under root, `depth` folders down, changed since `since`
function walk(root, depth, match, since, out) {
  let names
  try { names = readdirSync(root, { withFileTypes: true }) } catch { return }
  for (const e of names) {
    const p = join(root, e.name)
    if (depth > 0) {
      if (!e.isDirectory()) continue
      // Codex's YYYY/MM/DD: a whole old month or day is skipped by its name
      walk(p, depth - 1, match, since, out)
    } else if (e.isFile() && match(e.name, p)) {
      let st
      try { st = statSync(p) } catch { continue }
      if (st.mtimeMs >= since) out.push({ path: p, size: st.size, mtime: st.mtimeMs })
    }
  }
}

function readRange(path, from, len) {
  const fd = openSync(path, "r")
  try {
    const b = Buffer.alloc(len)
    const n = readSync(fd, b, 0, len, from)
    return b.subarray(0, n).toString("utf8")
  } finally { closeSync(fd) }
}

function zstd(path) {
  const raw = readFileSync(path)
  if (typeof Bun !== "undefined" && Bun.zstdDecompressSync) return new TextDecoder().decode(Bun.zstdDecompressSync(raw))
  throw new Error("no zstd here")
}

// whether a process with this pid is running: EPERM is someone else's, still
// running; only ESRCH says there is none
function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e?.code !== "ESRCH" }
}

// The sessions folder of a Claude-format agent: which session ids have a
// running process. null when it can't say: the folder has never held such a
// file (an agent/version that keeps none), or can't be read. Once it has
// held one, an empty folder means no process runs.
export function createProcesses() {
  const dirs = new Map()
  function running(dir) {
    let d = dirs.get(dir)
    if (!d) { d = { kept: false, files: new Map() }; dirs.set(dir, d) }
    let names
    try { names = readdirSync(dir) } catch { return null }
    const seen = new Set()
    for (const n of names) {
      if (!/^\d+\.json$/.test(n)) continue
      seen.add(n)
      const p = join(dir, n)
      let st
      try { st = statSync(p) } catch { continue }
      let f = d.files.get(n)
      if (!f || f.mtime !== st.mtimeMs) {
        let j
        try { j = JSON.parse(readFileSync(p, "utf8")) } catch { j = null }
        if (!j) { d.files.delete(n); return null } // half-written: unknown this time
        const here = !j.pidDomain || j.pidDomain === process.platform
        f = { mtime: st.mtimeMs, pid: Number(j.pid), id: String(j.sessionId || ""), here }
        d.files.set(n, f)
      }
      if (f.id && Number.isInteger(f.pid) && f.pid > 0) d.kept = true
    }
    for (const n of d.files.keys()) if (!seen.has(n)) d.files.delete(n)
    if (!d.kept) return null
    const ids = new Set()
    for (const f of d.files.values()) if (f.id && (!f.here || pidAlive(f.pid))) ids.add(f.id)
    return ids
  }
  return { running }
}

function readerFor(kind, agent, src = {}) {
  switch (kind) {
    case "claude": return (t, id, meta, now) => readClaude(t, agent, id, { subagent: !!src.subagent, now })
    case "codex": return (t, id, meta, now) => readCodex(t, id, { now })
    case "dsh": return (t, id, meta, now) => readDsh(t, id, { now })
    case "gemini": return (t, id, meta, now) => readGemini(t, agent, id, { now })
    case "pi": return (t, id, meta, now) => readPi(t, agent, id, { now })
    case "copilot": return (t, id, meta, now) => readCopilot(t, id, { now })
    case "kimi": return (t, id, meta, now) => readKimi(t, id, meta, { now })
    case "grok": return (t, id, meta, now) => readGrok(t, id, meta, { now })
  }
}

function idOf(src, path) {
  const name = basename(path)
  if (src.kind === "dsh") return basename(dirname(path))
  if (src.kind === "codex") { const m = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[^.]*)?\.jsonl$/i.exec(name); return m ? m[1] : name }
  // the session folder names the session: ~/.grok/sessions/<project>/<session>
  if (src.kind === "grok" || src.kind === "copilot") return basename(dirname(path))
  if (src.kind === "kimi") {
    const child = basename(dirname(path)) // …/<session>/agents/<agent>/wire.jsonl
    const session = basename(dirname(dirname(dirname(path))))
    return child === "main" ? session : `${session}/${child}`
  }
  return name.replace(/\.jsonl?$/, "").replace(/^\d{4}-\d{2}-\d{2}T[^_]+_/, "")
}

// the parent a source's file layout implies, for a child session without one
function parentOf(src, path, id) {
  if (src.kind === "claude" && src.subagent) return basename(dirname(dirname(path))) // project/<session>/subagents/<agent>.jsonl
  const i = String(id || "").lastIndexOf("/")
  return i > 0 ? String(id).slice(0, i) : ""
}

// state.json / summary.json, bounded: a broken or huge one is simply ignored
function readMeta(src, path) {
  if (typeof src.meta !== "function") return null
  try {
    const file = src.meta(path)
    const st = statSync(file)
    if (!st.isFile() || st.size > META_MAX) return null
    return JSON.parse(readFileSync(file, "utf8"))
  } catch { return null }
}

// Codex names a thread in session_index.jsonl ({id, thread_name}), the
// latest line for an id winning
function codexTitles() {
  const dir = env("CODEX_HOME") ? expand(env("CODEX_HOME")) : home(".codex")
  const out = new Map()
  try {
    for (const l of readFileSync(join(dir, "session_index.jsonl"), "utf8").split("\n")) {
      if (!l) continue
      try { const d = JSON.parse(l); if (d.id && d.thread_name) out.set(d.id, String(d.thread_name).trim()) } catch {}
    }
  } catch {}
  return out
}

export function createScanner(opts = {}) {
  const o = { days: 2, max: 40, zstdMax: ZSTD_MAX, zstdEvery: ZSTD_EVERY, ...opts }
  const files = new Map() // path -> { size, mtime, head, session }
  const procs = createProcesses()
  let srcs = o.sources || sources()

  // one pass: every changed file read again; gives the sessions, latest first
  function scan(now = Date.now()) {
    const since = now - o.days * 86400e3
    const found = []
    for (const src of srcs) {
      if (!existsSync(src.root)) continue
      const got = []
      walk(src.root, src.depth, src.match, since, got)
      for (const f of got) found.push({ ...f, src })
    }
    found.sort((a, b) => b.mtime - a.mtime)
    const keep = found.slice(0, o.max)
    const live = new Set(keep.map((f) => f.path))
    for (const p of files.keys()) if (!live.has(p)) files.delete(p)
    const out = []
    const running = new Map() // a live-process folder, once per tick
    let titles = null
    for (const f of keep) {
      let c = files.get(f.path)
      const changed = !c || c.size !== f.size || c.mtime !== f.mtime
      if (changed) {
        const zstd = f.path.endsWith(".zstd")
        // decode an active compressed session at most once every
        // zstdEvery ms; its file time still says it is at work
        if (zstd && c?.session && now - (c.decodedAt || 0) < o.zstdEvery) {
          c.size = f.size
          c.mtime = f.mtime
          c.session.touched = Math.max(c.session.touched || 0, f.mtime)
        } else {
          try { c = readOne(f, c, now) } catch (e) { continue }
          files.set(f.path, c)
        }
      }
      if (!c.session) continue
      const s = c.session
      if (s.agent === "codex") {
        titles ??= codexTitles()
        const t = titles.get(s.id)
        if (t) s.title = t.length > 48 ? t.slice(0, 47) + "…" : t
      }
      if (f.src.live && MIDTURN.has(s.phase) && now - f.mtime >= GONE_AFTER) {
        if (!running.has(f.src.live)) running.set(f.src.live, procs.running(f.src.live))
        const ids = running.get(f.src.live)
        if (ids && !ids.has(s.id)) { out.push({ ...s, phase: "aborted", pending: [], gone: true }); continue }
      }
      out.push(s)
    }
    return out
  }

  function readOne(f, was, now = Date.now()) {
    const read = readerFor(f.src.kind, f.src.agent, f.src)
    const id = idOf(f.src, f.path)
    const meta = readMeta(f.src, f.path)
    let text
    if (f.path.endsWith(".zstd")) {
      if (f.size > o.zstdMax) return { size: f.size, mtime: f.mtime, session: was?.session || null, decodedAt: now }
      text = zstd(f.path)
      const s = read(text, id, meta, now)
      s.path = f.path
      return { size: f.size, mtime: f.mtime, session: finish(s, f), decodedAt: now }
    } else if ((f.src.kind === "kimi" || f.src.kind === "grok") && f.size <= REPLAY_MAX) {
      // every event matters: a tool still open may be far from the end
      text = readRange(f.path, 0, f.size)
    } else if (f.size <= HEAD + TAIL) {
      text = readRange(f.path, 0, f.size)
    } else {
      // the start once (header, first prompt), and the end every time
      const head = was?.head ?? readRange(f.path, 0, HEAD)
      let tail = readRange(f.path, f.size - TAIL, TAIL)
      tail = tail.slice(tail.indexOf("\n") + 1)
      text = head.slice(0, head.lastIndexOf("\n") + 1) + tail
      const s = read(text, id, meta, now)
      s.path = f.path
      return { size: f.size, mtime: f.mtime, head, session: finish(s, f) }
    }
    const s = read(text, id, meta, now)
    s.path = f.path
    return { size: f.size, mtime: f.mtime, session: finish(s, f) }
  }

  function finish(s, f) {
    if (!s.id) s.id = idOf(f.src, f.path)
    if (f.src.subagent) {
      s.subagent = true
      if (!s.parent) s.parent = parentOf(f.src, f.path, s.id)
    }
    if (f.src.kind === "kimi" && s.subagent && !s.parent) s.parent = parentOf(f.src, f.path, s.id)
    if (f.src.profile) s.profile = f.src.profile
    if (!s.updated) s.updated = f.mtime
    // the file's own time: a line being written is the session at work
    s.touched = f.mtime
    s.key = `${s.agent}|${s.id}`
    return s
  }

  return { scan, files, setSources: (x) => { srcs = x; files.clear() } }
}
