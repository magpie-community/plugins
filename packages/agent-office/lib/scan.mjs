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
import { readClaude, readCodex, readDsh, readGemini, readPi } from "./readers.mjs"

const HEAD = 64 * 1024 // what is kept of a file's start: its header, its first prompt
const TAIL = 512 * 1024 // what is read of a big file's end
const ZSTD_MAX = 16 * 1024 * 1024 // a compressed session bigger than this is skipped

function env(k) { return (process.env[k] || "").trim() }
function home(...p) { return join(env("HOME") || homedir(), ...p) }
function expand(p) { return p.startsWith("~/") ? home(p.slice(2)) : p }

// where each agent keeps its sessions: { agent, kind, root, depth, match }
// depth: how many folders down from root the files sit
export function sources() {
  const claude = env("CLAUDE_CONFIG_DIR") ? expand(env("CLAUDE_CONFIG_DIR")) : home(".claude")
  const codex = env("CODEX_HOME") ? expand(env("CODEX_HOME")) : home(".codex")
  const dsh = env("DSH_HOME") ? expand(env("DSH_HOME")) : home(".dsh")
  const pi = env("PI_CODING_AGENT_DIR") ? expand(env("PI_CODING_AGENT_DIR")) : home(".pi", "agent")
  const qoder = env("QODER_CONFIG_DIR") ? expand(env("QODER_CONFIG_DIR")) : home(".qoder")
  const qodercn = env("QODERCN_CONFIG_DIR") ? expand(env("QODERCN_CONFIG_DIR")) : home(".qoder-cn")
  const workbuddy = env("WORKBUDDY_CONFIG_DIR") ? expand(env("WORKBUDDY_CONFIG_DIR")) : home(".workbuddy")
  const codebuddy = env("CODEBUDDY_CONFIG_DIR") ? expand(env("CODEBUDDY_CONFIG_DIR")) : home(".codebuddy")
  const jsonl = (n) => n.endsWith(".jsonl")
  return [
    { agent: "claude", kind: "claude", root: join(claude, "projects"), depth: 1, match: jsonl },
    { agent: "codex", kind: "codex", root: join(codex, "sessions"), depth: 3, match: (n) => n.startsWith("rollout-") && n.endsWith(".jsonl") },
    { agent: "dsh", kind: "dsh", root: join(dsh, "sessions"), depth: 2, match: (n) => n === "session.v4.jsonl.zstd" || n === "session.v4.jsonl" },
    { agent: "gemini", kind: "gemini", root: home(".gemini", "tmp"), depth: 2, match: (n) => n.startsWith("session-") && (n.endsWith(".json") || n.endsWith(".jsonl")) },
    { agent: "qwen", kind: "gemini", root: home(".qwen", "tmp"), depth: 2, match: (n) => n.startsWith("session-") && (n.endsWith(".json") || n.endsWith(".jsonl")) },
    { agent: "pi", kind: "pi", root: join(pi, "sessions"), depth: 1, match: jsonl },
    { agent: "omp", kind: "pi", root: home(".omp", "agent", "sessions"), depth: 1, match: jsonl },
    { agent: "qoder", kind: "claude", root: join(qoder, "projects"), depth: 1, match: jsonl },
    { agent: "qoder-cn", kind: "claude", root: join(qodercn, "projects"), depth: 1, match: jsonl },
    { agent: "workbuddy", kind: "claude", root: join(workbuddy, "projects"), depth: 1, match: jsonl },
    { agent: "codebuddy", kind: "claude", root: join(codebuddy, "projects"), depth: 1, match: jsonl },
  ]
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
    } else if (e.isFile() && match(e.name)) {
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

function readerFor(kind, agent) {
  switch (kind) {
    case "claude": return (t, id) => readClaude(t, agent, id)
    case "codex": return (t, id) => readCodex(t, id)
    case "dsh": return (t, id) => readDsh(t, id)
    case "gemini": return (t, id) => readGemini(t, agent, id)
    case "pi": return (t, id) => readPi(t, agent, id)
  }
}

function idOf(src, path) {
  const name = basename(path)
  if (src.kind === "dsh") return basename(dirname(path))
  if (src.kind === "codex") { const m = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[^.]*)?\.jsonl$/i.exec(name); return m ? m[1] : name }
  return name.replace(/\.jsonl?$/, "").replace(/^\d{4}-\d{2}-\d{2}T[^_]+_/, "")
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
  const o = { days: 2, max: 40, ...opts }
  const files = new Map() // path -> { size, mtime, head, session }
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
    let titles = null
    for (const f of keep) {
      let c = files.get(f.path)
      if (!c || c.size !== f.size || c.mtime !== f.mtime) {
        try { c = readOne(f, c) } catch (e) { continue }
        files.set(f.path, c)
      }
      if (!c.session) continue
      if (c.session.agent === "codex") {
        titles ??= codexTitles()
        const t = titles.get(c.session.id)
        if (t) c.session.title = t.length > 48 ? t.slice(0, 47) + "…" : t
      }
      out.push(c.session)
    }
    return out
  }

  function readOne(f, was) {
    const read = readerFor(f.src.kind, f.src.agent)
    const id = idOf(f.src, f.path)
    let text
    if (f.path.endsWith(".zstd")) {
      if (f.size > ZSTD_MAX) return { size: f.size, mtime: f.mtime, session: was?.session || null }
      text = zstd(f.path)
    } else if (f.size <= HEAD + TAIL) {
      text = readRange(f.path, 0, f.size)
    } else {
      // the start once (header, first prompt), and the end every time
      const head = was?.head ?? readRange(f.path, 0, HEAD)
      let tail = readRange(f.path, f.size - TAIL, TAIL)
      tail = tail.slice(tail.indexOf("\n") + 1)
      text = head.slice(0, head.lastIndexOf("\n") + 1) + tail
      const s = read(text, id)
      s.path = f.path
      return { size: f.size, mtime: f.mtime, head, session: finish(s, f) }
    }
    const s = read(text, id)
    s.path = f.path
    return { size: f.size, mtime: f.mtime, session: finish(s, f) }
  }

  function finish(s, f) {
    if (!s.id) s.id = idOf(f.src, f.path)
    if (!s.updated) s.updated = f.mtime
    // the file's own time: a line being written is the session at work
    s.touched = f.mtime
    s.key = `${s.agent}|${s.id}`
    return s
  }

  return { scan, files, setSources: (x) => { srcs = x; files.clear() } }
}
