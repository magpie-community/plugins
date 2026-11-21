// Finds each agent's session files. JSONL readers keep their parsing state
// and byte cursor: a normal tick reads only appended bytes. A replacement,
// truncation or same-size rewrite starts a fresh replay. Calendar-day usage
// is refreshed even when the log has not changed.
//
// Directory discovery is not repeated every tick. The first scan walks the
// tree. After that, a tick re-stats files already inside the window and
// re-lists a directory only when its own stamp changed. A content write does
// not update the parent directory's mtime on NTFS, APFS or ext4 — only
// create, delete and rename do — so an appended file is statted on its own
// and its cold siblings are not. While a watcher is healthy, the periodic
// discovery tick (15s, or MAGPIE_AGENT_OFFICE_DISCOVER_EVERY) uses those
// directory stamps too, so a dropped create still shows up without statting
// every cold file. With no healthy watcher, that tick walks the tree in full
// (plugins#1374).
import { closeSync, existsSync, openSync, fstatSync, readFileSync, readSync, readdirSync, statSync, watch } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { basename, dirname, join, sep } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { createSessionReader, finalizeUsage, readClaude, readCodex, readCopilot, readCursor, readDsh, readGemini, readGrok, readKimi, readPi } from "./readers.mjs"
import { processExists } from "./proc.mjs"

const READ_CHUNK = 64 * 1024
const GUARD_BYTES = 64 // bounded prefix/end witnesses catch truncate-and-regrow between ticks
// A dsh session is one compressed file that is rewritten on every step, so
// decoding all of it each 1.5 s tick is wasteful while it is being written.
// The cap keeps a pathological file from stalling a tick, and an active one
// is decoded at most once every ZSTD_EVERY: its last facts stand meanwhile.
const ZSTD_MAX = 8 * 1024 * 1024
const ZSTD_EVERY = 4000
const META_MAX = 256 * 1024 // state.json / summary.json remain small
const USAGE_MAX = 32 * 1024 * 1024 // usage.json grows with every recorded turn
// A file system stamps a write with a coarse clock (Linux: one kernel tick,
// some file systems a whole second or two), so a same-size rewrite inside one
// tick leaves size, mtime, ctime and inode as they were. A sidecar stamped
// this recently is told apart by a digest of its bytes as well; one older
// than this cannot be rewritten without its stamp moving.
const RACY_MS = 2500
// Claude Code keeps one file per running process, <config>/sessions/<pid>.json.
// A mid-turn session with no live process has stopped, even when the file
// ends before a turn-ending event: `claude -p` killed from another agent.
const GONE_AFTER = 10e3
const MIDTURN = new Set(["thinking", "tool", "approval", "ask"])
// The Cursor editor's transcripts have no end-of-turn line (cursor-agent's
// do): a chat whose last line is the agent's words, quiet this long, is done.
const CURSOR_QUIET = 30e3

function env(k) { return (process.env[k] || "").trim() }
function home(...p) { return join(env("HOME") || homedir(), ...p) }
function expand(p) { return p.startsWith("~/") ? home(p.slice(2)) : p }

// Use the agent's own home variable, without inventing CONFIG_DIR aliases.
function agentHome(homeVar, ...fallback) {
  if (env(homeVar)) return expand(env(homeVar))
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

// Cursor's CLI config folder, which keeps chats/<md5 of cwd>/<chat>/meta.json:
// $CURSOR_CONFIG_DIR, else cursor in $XDG_CONFIG_HOME, else ~/.cursor
function cursorConfig() {
  if (env("CURSOR_CONFIG_DIR")) return expand(env("CURSOR_CONFIG_DIR"))
  if (env("XDG_CONFIG_HOME")) return join(expand(env("XDG_CONFIG_HOME")), "cursor")
  return home(".cursor")
}

// a Cursor chat's meta.json, which only cursor-agent writes: found by the
// chat's id under chats/*/, the folders listed again at most every 5s while
// an id is missing (a chat's meta.json can come a moment after its transcript)
function cursorMetas(config) {
  const found = new Map()
  let listed = 0
  const missing = join(config, "chats", "-", "-", "meta.json")
  return (p) => {
    const id = cursorChat(p)
    if (found.has(id)) return found.get(id)
    if (Date.now() - listed >= 5000) {
      listed = Date.now()
      let dirs = []
      try { dirs = readdirSync(join(config, "chats"), { withFileTypes: true }) } catch {}
      for (const d of dirs) {
        if (!d.isDirectory()) continue
        let chats = []
        try { chats = readdirSync(join(config, "chats", d.name)) } catch { continue }
        for (const c of chats) if (!found.has(c) && existsSync(join(config, "chats", d.name, c, "meta.json"))) found.set(c, join(config, "chats", d.name, c, "meta.json"))
      }
    }
    return found.get(id) || missing
  }
}

// the chat a Cursor transcript is of: <chat>/<chat>.jsonl or <chat>.jsonl
function cursorChat(p) { return basename(p).replace(/\.jsonl$/, "") }

// A Cursor project folder is the cwd as a slug, every run of characters
// other than letters and digits one "-" (/Users/me/my app -> Users-me-my-app),
// which can't be read back alone: it is matched against the folders that
// exist, a few hundred looked at at most. Remembered per slug.
const SLUGS = new Map()
const slugOf = (name) => String(name).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "")
export function cursorFolder(slug, root = "/") {
  if (SLUGS.has(slug)) return SLUGS.get(slug)
  let budget = 400
  const find = (dir, rest) => {
    if (--budget < 0) return ""
    let names = []
    try { names = readdirSync(dir, { withFileTypes: true }) } catch { return "" }
    for (const e of names) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue
      const sl = slugOf(e.name)
      if (!sl) continue
      if (rest === sl) return join(dir, e.name)
      if (rest.startsWith(sl + "-")) { const got = find(join(dir, e.name), rest.slice(sl.length + 1)); if (got) return got }
    }
    return ""
  }
  // Windows: C-Users-me-x is C:\Users\me\x
  const drive = process.platform === "win32" && /^[a-zA-Z]-/.test(slug) ? slug[0] + ":\\" : ""
  const got = drive ? find(drive, slug.slice(2)) : find(root, slug)
  SLUGS.set(slug, got)
  return got
}

// where each agent keeps its sessions: { agent, kind, root, depth, match }
// depth: how many folders down from root the files sit
export function sources() {
  // Vendor-documented: https://code.claude.com/docs/en/settings#find-or-create-your-settings-files
  const claude = agentHome("CLAUDE_CONFIG_DIR", ".claude")
  const codex = agentHome("CODEX_HOME", ".codex")
  const dsh = agentHome("DSH_HOME", ".dsh")
  const pi = env("PI_CODING_AGENT_DIR") ? expand(env("PI_CODING_AGENT_DIR")) : home(".pi", "agent")
  const omp = agentHome("OMP_HOME", ".omp")
  const kimi = agentHome("KIMI_CODE_HOME", ".kimi-code")
  const grok = agentHome("GROK_HOME", ".grok")
  const copilot = agentHome("COPILOT_HOME", ".copilot")
  const qoder = home(".qoder")
  const qodercn = home(".qoder-cn")
  const workbuddy = home(".workbuddy")
  const codebuddy = home(".codebuddy")
  const cursorData = agentHome("CURSOR_DATA_DIR", ".cursor")
  const cursorMeta = cursorMetas(cursorConfig())
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
    { agent: "grok", kind: "grok", root: join(grok, "sessions"), depth: 2, match: (n) => n === "updates.jsonl", meta: (p) => join(dirname(p), "summary.json"), usage: (p) => join(dirname(p), "usage.json") },
    { agent: "copilot", kind: "copilot", root: join(copilot, "session-state"), depth: 1, match: (n) => n === "events.jsonl" },
    { agent: "qoder", kind: "claude", root: join(qoder, "projects"), depth: 1, match: jsonl, live: join(qoder, "sessions") },
    { agent: "qoder-cn", kind: "claude", root: join(qodercn, "projects"), depth: 1, match: jsonl, live: join(qodercn, "sessions") },
    { agent: "workbuddy", kind: "claude", root: join(workbuddy, "projects"), depth: 1, match: jsonl, live: join(workbuddy, "sessions") },
    { agent: "codebuddy", kind: "claude", root: join(codebuddy, "projects"), depth: 1, match: jsonl, live: join(codebuddy, "sessions") },
    // Cursor: the editor's chats ("cursor-app") and cursor-agent's ("cursor",
    // told by its meta.json) both write projects/<slug>/agent-transcripts/
    { agent: "cursor-app", kind: "cursor", root: join(cursorData, "projects"), depth: 3, match: (n, p) => n.endsWith(".jsonl") && basename(dirname(p)) === n.slice(0, -6) && basename(dirname(dirname(p))) === "agent-transcripts", meta: cursorMeta },
    { agent: "cursor-app", kind: "cursor", root: join(cursorData, "projects"), depth: 2, match: (n, p) => n.endsWith(".jsonl") && basename(dirname(p)) === "agent-transcripts", meta: cursorMeta },
  ]
  return srcs
}

// path is root, or a descendant. A shared prefix is not a descendant
// (/agent vs /agent-office).
function isUnder(root, path) {
  if (path === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return path.startsWith(prefix)
}
function relDepth(root, dir) {
  if (dir === root) return 0
  if (!isUnder(root, dir)) return -1
  return dir.slice(root.length + 1).split(sep).length
}
function fileRec(path, st) {
  return { path, size: st.size, mtime: st.mtimeMs, ctime: st.ctimeMs, dev: st.dev, ino: st.ino, birthtime: st.birthtimeMs }
}
// Directory identity for "did the set of names change". mtime moves on
// create/delete/rename. It does not move when an existing file is rewritten,
// which is why known files are re-statted on their own.
function dirStamp(st) { return st.mtimeMs + ":" + st.dev + ":" + st.ino }

// A cursor buffers only the current unfinished line. StringDecoder carries
// an incomplete UTF-8 code point between chunks AND between scan ticks.
function framing() { return { started: false, quoted: false, escape: false, depth: 0, complete: false, invalid: false } }
function framePart(state, text) {
  for (const char of text) {
    if (state.invalid) return
    if (!state.started) {
      if (/\s/.test(char)) continue
      state.started = true
      if (char !== "{") { state.invalid = true; return }
      state.depth = 1
    } else if (state.complete) {
      if (!/\s/.test(char)) state.invalid = true
    } else if (state.quoted) {
      if (state.escape) state.escape = false
      else if (char === "\\") state.escape = true
      else if (char === '"') state.quoted = false
    } else if (char === '"') state.quoted = true
    else if (char === "{" || char === "[") state.depth++
    else if (char === "}" || char === "]") { state.depth--; if (state.depth === 0) state.complete = true }
  }
}
function cursor() {
  return { offset: 0, decoder: new StringDecoder("utf8"), parts: [], framedParts: 0, frame: framing(), committedTail: false, prefix: Buffer.alloc(0), tail: Buffer.alloc(0) }
}
// Size growth alone cannot distinguish append from truncate-and-regrow
// between ticks. Verify at most 128 old bytes without parsing any history.
function appendWitnessMatches(f, c, read) {
  const fd = openSync(f.path, "r")
  try {
    const st = fstatSync(fd)
    if (st.dev !== f.dev || st.ino !== f.ino || st.size < c.offset) return false
    const prefix = Buffer.alloc(c.prefix.length)
    if (prefix.length && (read(fd, prefix, 0, prefix.length, 0) !== prefix.length || !prefix.equals(c.prefix))) return false
    if (c.offset > prefix.length && c.tail.length) {
      const tail = Buffer.alloc(c.tail.length)
      if (read(fd, tail, 0, tail.length, c.offset - tail.length) !== tail.length || !tail.equals(c.tail)) return false
    }
    return true
  } finally { closeSync(fd) }
}
class ExtendedTail extends Error {}

function* readAppended(f, c, read) {
  const fd = openSync(f.path, "r")
  const buf = Buffer.alloc(READ_CHUNK)
  try {
    const st = fstatSync(fd)
    // The path can rotate between walk() and open(). Retry next tick rather
    // than adding another file's bytes to the existing reader.
    if (st.dev !== f.dev || st.ino !== f.ino || st.size < c.offset) throw new Error("session file changed while opening")
    while (c.offset < f.size) {
      const n = read(fd, buf, 0, Math.min(buf.length, f.size - c.offset), c.offset)
      if (!n) break
      c.offset += n
      const block = buf.subarray(0, n)
      if (c.prefix.length < GUARD_BYTES) c.prefix = Buffer.concat([c.prefix, block.subarray(0, GUARD_BYTES - c.prefix.length)])
      c.tail = Buffer.from(n >= GUARD_BYTES ? block.subarray(n - GUARD_BYTES) : Buffer.concat([c.tail, block]).subarray(-GUARD_BYTES))
      const text = c.decoder.write(block)
      let start = 0
      while (start < text.length) {
        const end = text.indexOf("\n", start)
        const part = text.slice(start, end < 0 ? text.length : end)
        if (c.committedTail) {
          // A valid record at EOF was already applied. Its later newline
          // must not count it twice. Non-whitespace extending that record
          // instead invalidates the speculative EOF parse and needs replay.
          if (/\S/.test(part)) throw new ExtendedTail()
          if (end >= 0) c.committedTail = false
        } else if (end >= 0) {
          c.parts.push(part)
          const line = c.parts.join("")
          c.parts = []
          c.framedParts = 0
          c.frame = framing()
          yield line
        } else if (part) {
          c.parts.push(part)
        }
        if (end < 0) break
        start = end + 1
      }
    }
    // Completed lines already went straight to the reader, even when they
    // span many read chunks. Only the unfinished EOF record needs lexical
    // framing; remember which fragments were framed on earlier ticks.
    for (; c.framedParts < c.parts.length; c.framedParts++) framePart(c.frame, c.parts[c.framedParts])
    // Some clients flush a complete JSON record before its newline. Accept
    // it once, but never repeatedly parse a growing base64/text fragment.
    if (!c.committedTail && c.frame.complete && !c.frame.invalid && !c.frame.quoted) {
      const tail = c.parts.join("")
      let complete = false
      try { const record = JSON.parse(tail); complete = !!record && typeof record === "object" && !Array.isArray(record) } catch { c.frame.invalid = true }
      if (complete) {
        c.parts = []
        c.framedParts = 0
        c.frame = framing()
        c.committedTail = true
        yield tail
      }
    }
  } finally { closeSync(fd) }
}

function zstd(path) {
  const raw = readFileSync(path)
  if (typeof Bun !== "undefined" && Bun.zstdDecompressSync) return new TextDecoder().decode(Bun.zstdDecompressSync(raw))
  throw new Error("no zstd here")
}

// whether a process with this pid exists: EPERM is someone else's, still
// running; only ESRCH says there is none
const pidAlive = processExists

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
    case "grok": return (t, id, meta, now, usage) => readGrok(t, id, meta, { now, usage })
    case "cursor": return (t, id, meta, now) => readCursor(t, id, meta, { now })
  }
}

function idOf(src, path) {
  const name = basename(path)
  if (src.kind === "dsh") return basename(dirname(path))
  if (src.kind === "codex") { const m = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[^.]*)?\.jsonl$/i.exec(name); return m ? m[1] : name }
  // the session folder names the session: ~/.grok/sessions/<project>/<session>
  if (src.kind === "grok" || src.kind === "copilot") return basename(dirname(path))
  if (src.kind === "cursor") return cursorChat(path)
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
function readMeta(src, path, field = "meta") {
  if (typeof src[field] !== "function") return null
  try {
    const file = src[field](path)
    const st = statSync(file)
    if (!st.isFile() || st.size > (field === "usage" ? USAGE_MAX : META_MAX)) return null
    return JSON.parse(readFileSync(file, "utf8"))
  } catch { return null }
}

// Each sidecar's revision, "size:mtime:ctime:ino", with "#digest" added
// while its stamp is too recent to tell a same-size rewrite apart.
function sidecars(src, path, stat = statSync) {
  return ["meta", "usage"].map((field) => {
    if (typeof src[field] !== "function") return ""
    try {
      const file = src[field](path), st = stat(file)
      const sig = `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`
      if (!st.isFile() || st.size > (field === "usage" ? USAGE_MAX : META_MAX)) return sig
      if (Date.now() - Math.max(st.mtimeMs, st.ctimeMs) >= RACY_MS) return sig
      return sig + "#" + createHash("sha1").update(readFileSync(file)).digest("hex")
    } catch { return "missing" }
  }).join("|")
}

// One sidecar revision is another when their stamps match and, where both
// carry a digest, the digests do. A stamp that has aged past RACY_MS drops
// its digest, which does not make it a new revision.
function sameSidecar(a, b) {
  if (a === b) return true
  if (a == null || b == null) return false
  const [sa, da] = a.split("#"), [sb, db] = b.split("#")
  return sa === sb && (!da || !db || da === db)
}
function sameSidecars(a, b) {
  if (a === b) return true
  if (a == null || b == null) return false
  const x = a.split("|"), y = b.split("|")
  return x.length === y.length && x.every((v, i) => sameSidecar(v, y[i]))
}

// Codex names a thread in session_index.jsonl ({id, thread_name}), the
// latest line for an id winning
function codexTitles(was, readBytes) {
  const dir = env("CODEX_HOME") ? expand(env("CODEX_HOME")) : home(".codex")
  const path = join(dir, "session_index.jsonl")
  let f
  try {
    const st = statSync(path)
    f = { path, size: st.size, mtime: st.mtimeMs, ctime: st.ctimeMs, dev: st.dev, ino: st.ino, birthtime: st.birthtimeMs }
  } catch { return { titles: new Map() } }
  const same = was?.path === path && was.dev === f.dev && was.ino === f.ino && was.birthtime === f.birthtime
  if (same && was.size === f.size && was.mtime === f.mtime && was.ctime === f.ctime) return was
  const reusable = same && was.cursor && f.size > was.size && f.size >= was.cursor.offset && appendWitnessMatches(f, was.cursor, readBytes)
  let c = reusable ? was : { cursor: cursor(), titles: new Map() }
  const consume = () => {
    for (const line of readAppended(f, c.cursor, readBytes)) {
      try { const d = JSON.parse(line); if (d.id && d.thread_name) c.titles.set(d.id, String(d.thread_name).trim()) } catch {}
    }
  }
  try { consume() }
  catch (error) {
    if (error instanceof ExtendedTail && reusable) { c = { cursor: cursor(), titles: new Map() }; consume() }
    else return was || { titles: new Map() }
  }
  return Object.assign(c, f)
}

export function createScanner(opts = {}) {
  const o = { days: 2, max: 40, zstdMax: ZSTD_MAX, zstdEvery: ZSTD_EVERY, ...opts }
  const files = new Map() // path -> file identity, JSONL cursor/reader, published session
  const readBytes = typeof o.readSync === "function" ? o.readSync : readSync
  const statSidecar = typeof o.statSync === "function" ? o.statSync : statSync
  const procs = createProcesses()
  const readDir = typeof o.readdirSync === "function" ? o.readdirSync : readdirSync
  const statEntry = typeof o.scanStat === "function" ? o.scanStat : statSync
  const watchImpl = typeof o.watch === "function" ? o.watch : o.watch === true ? watch : null
  const discoverEvery = (() => {
    if (Number.isFinite(o.discoverEvery) && o.discoverEvery >= 0) return o.discoverEvery
    const n = Number(process.env.MAGPIE_AGENT_OFFICE_DISCOVER_EVERY)
    if (Number.isFinite(n) && n >= 0) return n
    return 15_000
  })()
  let srcs = o.sources || sources()
  let titleCache = null
  let discoveredAt = null
  const tree = new Map() // source object -> listing cache and watcher

  function cacheOf(src) {
    let c = tree.get(src)
    if (!c) {
      c = {
        listings: new Map(), hot: new Map(), watcher: null, watchFailed: false, closed: false,
        dirtyDirs: new Set(), dirtyFiles: new Set(), forceFull: false,
      }
      tree.set(src, c)
    }
    return c
  }
  function forgetUnder(cache, dir) {
    for (const key of [...cache.listings.keys()]) if (key === dir || isUnder(dir, key)) cache.listings.delete(key)
    for (const key of [...cache.hot.keys()]) if (key === dir || isUnder(dir, key)) cache.hot.delete(key)
  }
  function namesOf(dir, depth) {
    let ents
    try { ents = readDir(dir, { withFileTypes: true }) } catch { return null }
    const names = []
    for (const e of ents) {
      if (depth > 0) { if (e.isDirectory()) names.push(e.name) }
      else if (e.isFile()) names.push(e.name)
    }
    return names
  }
  function consider(cache, path, since, add) {
    let st
    try { st = statEntry(path) } catch { cache.hot.delete(path); return }
    if (!st.isFile() || st.mtimeMs < since) { cache.hot.delete(path); return }
    add(fileRec(path, st))
  }
  function remember(cache, dir, st, names, prev) {
    if (prev) {
      const next = new Set(names)
      for (const name of prev.names) if (!next.has(name)) forgetUnder(cache, join(dir, name))
    }
    cache.listings.set(dir, { stamp: dirStamp(st), names })
  }
  function walkFull(cache, dir, depth, match, since, add) {
    let st
    try { st = statEntry(dir) } catch { forgetUnder(cache, dir); return }
    const names = namesOf(dir, depth)
    if (!names) { forgetUnder(cache, dir); return }
    remember(cache, dir, st, names, cache.listings.get(dir))
    for (const name of names) {
      const p = join(dir, name)
      if (depth > 0) walkFull(cache, p, depth - 1, match, since, add)
      else if (match(name, p)) consider(cache, p, since, add)
    }
  }
  // Stamp unchanged: keep the cached names, do not readdir, do not stat cold files.
  function refreshMtime(cache, dir, depth, match, since, add) {
    let st
    try { st = statEntry(dir) } catch { forgetUnder(cache, dir); return }
    const prev = cache.listings.get(dir)
    if (!prev || prev.stamp !== dirStamp(st)) {
      relist(cache, dir, depth, match, since, add, st)
      return
    }
    if (depth === 0) return
    for (const name of prev.names) refreshMtime(cache, join(dir, name), depth - 1, match, since, add)
  }
  function relist(cache, dir, depth, match, since, add, st) {
    const names = namesOf(dir, depth)
    if (!names) { forgetUnder(cache, dir); return }
    const prev = cache.listings.get(dir)
    const prevNames = new Set(prev?.names || [])
    remember(cache, dir, st, names, prev)
    for (const name of names) {
      const p = join(dir, name)
      if (depth > 0) {
        if (!prevNames.has(name) || !cache.listings.has(p)) walkFull(cache, p, depth - 1, match, since, add)
        else refreshMtime(cache, p, depth - 1, match, since, add)
      } else if (match(name, p)) consider(cache, p, since, add)
    }
  }
  function remaining(src, dir) {
    const d = relDepth(src.root, dir)
    if (d < 0 || d > src.depth) return -1
    return src.depth - d
  }
  function noteWatch(cache, root, name) {
    if (!name) { cache.forceFull = true; return }
    const n = String(name)
    const abs = n === root || isUnder(root, n) ? n : join(root, n)
    // Only the directory that contains the change. Ancestor mtimes do not
    // move, and re-listing the source root would stat the whole tree again.
    cache.dirtyFiles.add(abs)
    cache.dirtyDirs.add(abs)
    const parent = dirname(abs)
    if (parent === root || isUnder(root, parent)) cache.dirtyDirs.add(parent)
  }
  function armWatch(src, cache) {
    if (!watchImpl || cache.closed || cache.watcher || cache.watchFailed) return
    try {
      const w = watchImpl(src.root, { recursive: true }, (event, name) => noteWatch(cache, src.root, name))
      w?.on?.("error", () => {
        cache.watchFailed = true
        try { w.close() } catch {}
        cache.watcher = null
      })
      w?.unref?.()
      cache.watcher = w
    } catch { cache.watchFailed = true }
  }
  function refreshWatched(src, cache, since, add) {
    const dirtyDirs = cache.dirtyDirs
    const dirtyFiles = cache.dirtyFiles
    const force = cache.forceFull
    cache.dirtyDirs = new Set()
    cache.dirtyFiles = new Set()
    cache.forceFull = false
    if (force || !cache.listings.has(src.root)) {
      walkFull(cache, src.root, src.depth, src.match, since, add)
      return
    }
    for (const p of [...cache.hot.keys()]) if (isUnder(src.root, p)) consider(cache, p, since, add)
    const dirs = [...dirtyDirs].filter((d) => remaining(src, d) >= 0).sort((a, b) => a.length - b.length)
    for (const dir of dirs) {
      let st
      try { st = statEntry(dir) } catch { forgetUnder(cache, dir); continue }
      // A content append does not move the parent stamp. The named file is
      // statted from dirtyFiles; relist only for a create, delete, or rename,
      // or a directory we have never listed.
      const prev = cache.listings.get(dir)
      if (prev && prev.stamp === dirStamp(st)) continue
      if (!st.isDirectory()) { forgetUnder(cache, dir); continue }
      relist(cache, dir, remaining(src, dir), src.match, since, add, st)
    }
    for (const file of dirtyFiles) {
      if (!isUnder(src.root, file)) continue
      if (relDepth(src.root, dirname(file)) !== src.depth) continue
      if (src.match(basename(file), file)) consider(cache, file, since, add)
    }
  }
  function collect(src, since, full, out) {
    const cache = cacheOf(src)
    let dirSt
    try { dirSt = statEntry(src.root) } catch { dirSt = null }
    if (!dirSt?.isDirectory()) {
      forgetUnder(cache, src.root)
      try { cache.watcher?.close() } catch {}
      cache.watcher = null
      return
    }
    armWatch(src, cache)
    const added = new Set()
    const add = (rec) => {
      if (added.has(rec.path)) return
      added.add(rec.path)
      cache.hot.set(rec.path, rec)
      out.push(rec)
    }
    // A healthy watcher already reports creates. The periodic tick then
    // checks directory stamps instead of statting every cold file. A full
    // walk is the first listing, an unnamed watch event, or the periodic
    // tick when nothing is watching.
    const healthy = !!(cache.watcher && !cache.watchFailed)
    if (!cache.listings.has(src.root) || cache.forceFull || (full && !healthy)) {
      cache.forceFull = false
      walkFull(cache, src.root, src.depth, src.match, since, add)
    } else if (healthy) {
      if (full) refreshMtime(cache, src.root, src.depth, src.match, since, add)
      refreshWatched(src, cache, since, add)
    } else {
      refreshMtime(cache, src.root, src.depth, src.match, since, add)
      for (const p of [...cache.hot.keys()]) if (isUnder(src.root, p) && !added.has(p)) consider(cache, p, since, add)
    }
    for (const p of [...cache.hot.keys()]) if (isUnder(src.root, p) && !added.has(p)) cache.hot.delete(p)
  }
  function close() {
    for (const c of tree.values()) {
      c.closed = true
      try { c.watcher?.close() } catch {}
      c.watcher = null
    }
  }
  function resume() {
    for (const c of tree.values()) c.closed = false
  }

  // One pass: append-only JSONL changes reuse reader state; latest sessions first.
  function scan(now = Date.now()) {
    const since = now - o.days * 86400e3
    const full = discoveredAt == null || now - discoveredAt >= discoverEvery
    if (full) discoveredAt = now
    const found = []
    for (const src of srcs) {
      const got = []
      collect(src, since, full, got)
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
      const metadata = sidecars(f.src, f.path, statSidecar)
      const changed = !c || c.size !== f.size || c.mtime !== f.mtime || c.ctime !== f.ctime || c.dev !== f.dev || c.ino !== f.ino || c.birthtime !== f.birthtime || !sameSidecars(c.metadata, metadata) || (c.cursor && c.cursor.offset < f.size)
      if (changed) {
        const zstd = f.path.endsWith(".zstd")
        // Leave size/mtime at the last decoded revision while throttled, so
        // a final write is still decoded after the throttle interval elapses.
        if (zstd && c?.session && now - (c.decodedAt || 0) < o.zstdEvery) {
          c.session.touched = Math.max(c.session.touched || 0, f.mtime)
        } else {
          try {
            c = readOne({ ...f, metadata }, c, now)
            c.metadata = metadata
            files.set(f.path, c)
          } catch (e) {
            // Keep valid facts/cursor progress through a transient read
            // failure. Do not mark the new metadata revision consumed.
            if (!c?.session) continue
          }
        }
      }
      if (!c.session) continue
      // Keep scanner-derived path/title/time fields out of the parser's
      // stable state, so they cannot override subsequent log events.
      const parsed = c.reader ? c.reader.session : c.session
      finalizeUsage(parsed, now)
      const s = c.reader ? finish({ ...parsed, path: f.path }, f) : c.session
      c.session = s
      if (s.agent === "codex") {
        if (!titles) { titleCache = codexTitles(titleCache, readBytes); titles = titleCache.titles }
        const t = titles.get(s.id)
        if (t) s.title = t.length > 48 ? t.slice(0, 47) + "…" : t
      }
      if (f.src.live && MIDTURN.has(s.phase) && now - f.mtime >= GONE_AFTER) {
        if (!running.has(f.src.live)) running.set(f.src.live, procs.running(f.src.live))
        const ids = running.get(f.src.live)
        if (ids && !ids.has(s.id)) { out.push({ ...s, phase: "aborted", pending: [], gone: true }); continue }
      }
      if (f.src.kind === "cursor" && s.agent === "cursor-app" && !s.cursorEnds && s.cursorLast === "text" && s.phase === "thinking" && now - f.mtime >= CURSOR_QUIET) {
        out.push({ ...s, phase: "done" })
        continue
      }
      out.push(s)
    }
    return out
  }

  function readOne(f, was, now = Date.now()) {
    const id = idOf(f.src, f.path)
    const sig = f.metadata.split("|")
    const before = was?.metadata?.split("|")
    const compressed = f.path.endsWith(".zstd")
    const document = f.src.kind === "gemini" && f.path.endsWith(".json")
    if (compressed || document) {
      // A rewritten compressed blob / JSON document has no append cursor.
      if (compressed && f.size > o.zstdMax) return { ...f, session: was?.session || null, decodedAt: now }
      const text = compressed ? zstd(f.path) : readFileSync(f.path, "utf8")
      const s = readerFor(f.src.kind, f.src.agent, f.src)(text, id, readMeta(f.src, f.path), now, readMeta(f.src, f.path, "usage"))
      s.path = f.path
      return { size: f.size, mtime: f.mtime, ctime: f.ctime, dev: f.dev, ino: f.ino, birthtime: f.birthtime, session: finish(s, f), decodedAt: now }
    }
    const sameFile = was && was.dev === f.dev && was.ino === f.ino && was.birthtime === f.birthtime
    const rewritten = sameFile && f.size === was.size && (f.mtime !== was.mtime || f.ctime !== was.ctime)
    const reusable = sameFile && was.reader && was.cursor && f.size >= was.cursor.offset && !rewritten && (f.size === was.cursor.offset || appendWitnessMatches(f, was.cursor, readBytes))
    let c = reusable ? was : {
      reader: createSessionReader(f.src.kind, f.src.agent, id, { subagent: !!f.src.subagent }),
      cursor: cursor(),
    }
    const changes = { now, mtime: f.mtime }
    // Do not retain a whole usage.json snapshot or re-aggregate it on each
    // append. The reader keeps its daily totals; re-read only a new revision.
    if (!reusable || !sameSidecar(before?.[0], sig[0])) changes.meta = readMeta(f.src, f.path)
    if (!reusable || !sameSidecar(before?.[1], sig[1])) changes.usage = readMeta(f.src, f.path, "usage")
    try { c.reader.update(readAppended(f, c.cursor, readBytes), changes) }
    catch (error) {
      if (!(error instanceof ExtendedTail) || !reusable) throw error
      c = { reader: createSessionReader(f.src.kind, f.src.agent, id, { subagent: !!f.src.subagent }), cursor: cursor() }
      c.reader.update(readAppended(f, c.cursor, readBytes), { meta: readMeta(f.src, f.path), usage: readMeta(f.src, f.path, "usage"), now, mtime: f.mtime })
    }
    Object.assign(c, { size: f.size, mtime: f.mtime, ctime: f.ctime, dev: f.dev, ino: f.ino, birthtime: f.birthtime, decodedAt: now })
    c.session = finish({ ...c.reader.session, path: f.path }, f)
    return c
  }

  function finish(s, f) {
    if (!s.id) s.id = idOf(f.src, f.path)
    if (f.src.subagent) {
      s.subagent = true
      if (!s.parent) s.parent = parentOf(f.src, f.path, s.id)
    }
    if (f.src.kind === "kimi" && s.subagent && !s.parent) s.parent = parentOf(f.src, f.path, s.id)
    if (f.src.profile) s.profile = f.src.profile
    if (f.src.kind === "cursor" && !s.cwd) {
      // projects/<slug>/agent-transcripts/[<chat>/]<chat>.jsonl
      let d = dirname(f.path)
      if (basename(d) !== "agent-transcripts") d = dirname(d)
      const slug = basename(dirname(d))
      const cwd = cursorFolder(slug)
      if (cwd) { s.cwd = cwd; s.project = basename(cwd) }
      else s.project = slug.slice(slug.lastIndexOf("-") + 1)
    }
    if (!s.updated) s.updated = f.mtime
    // the file's own time: a line being written is the session at work
    s.touched = f.mtime
    s.key = `${s.agent}|${s.id}`
    return s
  }

  return {
    scan, files, close, resume,
    setSources: (x) => { close(); tree.clear(); srcs = x; files.clear(); titleCache = null; discoveredAt = null },
  }
}
