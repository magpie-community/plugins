// The watch: what mail-watch notices, and what it does about it.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, statSync, openSync, readSync, closeSync } from "node:fs"
import { paths } from "./paths.js"

// One watch per host process: st holds the paths, the offset and the
// sent-times the cooldown reads. init() plants it once.
let st = null

// init loads the state file and, when there is none (first run), takes the
// usage log's size now as the start, so the first scan doesn't replay
// every past failure as if new. Safe to call again; only the first counts.
export function init() {
  if (st) return
  const p = paths()
  st = { ...p, offset: -1, sent: {} }
  try {
    const raw = JSON.parse(readFileSync(st.state, "utf8"))
    if (raw && typeof raw === "object") {
      const n = Number(raw.offset)
      if (Number.isFinite(n)) st.offset = n
      if (typeof raw.sent === "object" && raw.sent) st.sent = raw.sent
      if (Array.isArray(raw.mailed)) st.mailed = raw.mailed.filter((t) => typeof t === "number")
    }
  } catch {}
  if (st.offset < 0) {
    try {
      st.offset = existsSync(st.usage) ? statSync(st.usage).size : 0
    } catch {
      st.offset = 0
    }
  }
}

// init runs as the module loads too: the host imports this file as the
// plugin host starts, before any request, so a first failure right after
// the start lands ahead of the baseline, not behind it. An import-time
// failure (a folder magpie can't read) leaves st null and fail() inits
// later, from the state file or an empty log, as below.
try {
  init()
} catch {}

// forTests hands the state out and takes one in (its offset and sent-map,
// merged over what init loaded, paths kept); null resets to the state
// init would load, so a test can start over. Production never calls it.
export function forTests(s) {
  if (s === null) {
    st = null
    init()
    return st
  }
  if (!st) init()
  if (s) st = { ...st, ...s }
  return st
}

// tail reads the log's bytes from offset. Nothing is decoded here: the
// caller cuts at a newline in bytes first, so a byte that isn't UTF-8 can't
// grow into a replacement character and push the offset past a row.
function tail(from) {
  let size = 0
  try {
    size = statSync(st.usage).size
  } catch {
    return Buffer.alloc(0)
  }
  if (size <= from) return Buffer.alloc(0)
  let fh
  try {
    fh = openSync(st.usage, "r")
    const buf = Buffer.alloc(size - from)
    readSync(fh, buf, 0, buf.length, from)
    return buf
  } catch {
    return Buffer.alloc(0)
  } finally {
    if (fh !== undefined) try { closeSync(fh) } catch {}
  }
}

// fail reads the usage log's new bytes and returns one event per failure
// worth an alert: watched, the request's own outcome (a try the gateway
// handed on is not — its request was answered by a later row), and past
// its cooldown. The caller saves the returned offset when the mail went.
export function fail(opts, now = Date.now()) {
  init()
  const o = opts.watch ?? {}
  const cd = opts.cooldown ?? {}
  if (!o.errors) return { events: [], offset: st.offset }
  pruneSent(cd, now)
  let size = 0
  try {
    size = statSync(st.usage).size
  } catch {
    return { events: [], offset: st.offset }
  }
  // a log shorter than remembered was cut or replaced: start over
  if (size < st.offset) st.offset = 0
  const buf = tail(st.offset)
  // the last line may be half-written as magpie logs the call that just
  // finished: cut at the last newline in bytes, decode only that, and leave
  // the rest for the next exchange's scan
  const cut = buf.lastIndexOf(0x0a)
  if (cut < 0) return { events: [], offset: st.offset }
  const text = buf.subarray(0, cut + 1).toString("utf8")
  const end = st.offset + cut + 1
  const events = []
  for (const line of text.split("\n")) {
    if (!line) continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    if (r.handed_on) continue
    if (typeof r.status !== "number" || r.status < 400) continue
    if (!listed(o.providers, r.provider)) continue
    const key = ["error", r.provider ?? "", r.err_type || String(r.status)].join("|")
    if (cooled(cd, "error", key, now)) continue
    events.push({
      kind: "error",
      provider: r.provider ?? "",
      account: r.providerAccount ?? "",
      model: r.model ?? "",
      agent: r.agent ?? "",
      status: r.status,
      err: String(r.err ?? "").slice(0, 400),
      errType: r.err_type ?? "",
      endpoint: r.ep ?? "",
    })
  }
  st.offset = end
  return { events, offset: end }
}

// quotaScan reads the quotas file as magpie wrote it and returns the
// windows the user watches: exhausted, or over the low line. A window the
// cooldown already sent is left out. The caller saves afterwards.
export function quotaScan(opts, now = Date.now()) {
  init()
  const o = opts.watch ?? {}
  const cd = opts.cooldown ?? {}
  const wantExhausted = o.quotaExhausted !== false
  const lowAt = Number(o.quotaLowPct)
  const wantLow = o.quotaLow === true && Number.isFinite(lowAt) && lowAt > 0 && lowAt < 100
  if (!wantExhausted && !wantLow) return []
  pruneSent(cd, now)
  let quotas
  try {
    quotas = JSON.parse(readFileSync(st.quotas, "utf8"))
  } catch {
    return []
  }
  if (!quotas || typeof quotas !== "object") return []
  const out = []
  for (const [key, entry] of Object.entries(quotas)) {
    // magpie's own key shape (internal/provider keepLast): provider + "/"
    // + the account lowercased — "claude/me@example.com". The provider is
    // everything before the first slash, the account everything after.
    const slash = key.indexOf("/")
    const provider = slash < 0 ? key : key.slice(0, slash)
    const account = slash < 0 ? "" : key.slice(slash + 1)
    if (!listed(o.providers, provider)) continue
    const windows = entry?.quota?.windows
    if (!Array.isArray(windows)) continue
    for (const w of windows) {
      const used = Number(w?.used)
      if (!Number.isFinite(used)) continue
      // quotas.json holds the last readings, not the live state: a window
      // whose reset already passed is a stale reading, not a window still
      // full — skip it, or it re-alerts every cooldown forever. A window
      // with no parseable reset keeps alerting: its state is unknown,
      // and silence would hide a real exhaustion.
      if (expired(w?.resetsAt, now)) continue
      const exhausted = wantExhausted && used >= 100
      const low = wantLow && used >= lowAt && used < 100
      if (!exhausted && !low) continue
      const kind = exhausted ? "quotaExhausted" : "quotaLow"
      // the kind is in the key: a "low" mail sent an hour ago must not
      // silence the "exhausted" one when the window reaches 100%
      if (cooled(cd, "quota", ["quota", kind, key, w.name].join("|"), now)) continue
      out.push({ kind, provider, account, window: w.name ?? "", used, resetsAt: w.resetsAt ?? "" })
    }
  }
  return out
}

// expired is whether a window's reset time has already passed: magpie
// writes resetsAt as an RFC 3339 string (Go's time.Time in JSON), a
// millisecond number, or a second number — all three parse here.
function expired(resetsAt, now) {
  if (resetsAt === undefined || resetsAt === null || resetsAt === "") return false
  let t
  if (typeof resetsAt === "number") t = resetsAt > 1e12 ? resetsAt : resetsAt * 1000
  else t = Date.parse(String(resetsAt))
  return Number.isFinite(t) && t < now
}

// the cooldown: a key that sent within its kind's minutes is left out, and
// a key about to be sent is marked now. Unconfigured, errors wait 10
// minutes and quota windows 4 hours. st must be inited.
function cooled(cooldownOpts, kind, key, now) {
  const mins = Number(cooldownOpts?.[kind])
  const ms = Number.isFinite(mins) && mins >= 0 ? mins * 60_000 : (kind === "error" ? 10 : 240) * 60_000
  const last = st.sent[key]
  if (typeof last === "number" && now - last < ms) return true
  st.sent[key] = now
  return false
}

// listed is whether provider is one the user asked for: an empty list is
// every provider, a non-empty one only those on it.
function listed(list, provider) {
  if (!Array.isArray(list) || !list.length) return true
  return list.includes(provider)
}

// pruneSent drops sent-marks older than the longest cooldown still in
// force, so the map doesn't grow without bound: a mark's only job is to
// hold its key quiet for its own window, and the longest window (the
// quota one, 4 hours by default) bounds how long any mark can matter.
// Suppression itself still reads each kind's own window in cooled().
function pruneSent(cd, now) {
  const eff = (kind, def) => {
    const n = Number(cd?.[kind])
    return Number.isFinite(n) && n >= 0 ? n : def
  }
  const keepAfter = now - Math.max(eff("error", 10), eff("quota", 240)) * 60_000
  for (const k of Object.keys(st.sent)) {
    if (typeof st.sent[k] !== "number" || st.sent[k] < keepAfter) delete st.sent[k]
  }
}

// takeWithinCap slices events to the mail budget left this hour and
// records the mails about to be queued, so a bad hour can't send one
// mail per key without bound: the per-key cooldown caps each key, this
// caps the hour. cap is maxMailsPerHour; unset or invalid means 20.
// The count is of mails queued, not delivered — a queued mail that then
// fails still spent its slot, the way a sent one would.
export function takeWithinCap(events, cap, now = Date.now()) {
  init()
  const limit = Number.isFinite(Number(cap)) && Number(cap) > 0 ? Math.floor(Number(cap)) : 20
  if (!Array.isArray(st.mailed)) st.mailed = []
  const hourAgo = now - 3_600_000
  st.mailed = st.mailed.filter((t) => typeof t === "number" && t > hourAgo)
  const room = Math.max(0, limit - st.mailed.length)
  const taken = events.slice(0, room)
  for (let i = 0; i < taken.length; i++) st.mailed.push(now)
  return taken
}

// save writes the state file, atomically — and it merges, never replaces:
// the file is one object shared with the digest (digest.js keeps its
// cursor, digestOffset, in it), and a scan that stringified only the
// watch's own fields used to wipe that cursor on every exchange, so the
// digest re-read the whole log. Disk fields the watch doesn't own survive;
// the watch's own fields (offset, sent, mailed) always win.
export function save() {
  if (!st) return
  try {
    mkdirSync(st.dir, { recursive: true })
    let disk = {}
    try {
      const raw = JSON.parse(readFileSync(st.state, "utf8"))
      if (raw && typeof raw === "object") disk = raw
    } catch {}
    const tmp = st.state + ".tmp"
    writeFileSync(tmp, JSON.stringify({ ...disk, ...st }))
    renameSync(tmp, st.state)
  } catch {}
}
