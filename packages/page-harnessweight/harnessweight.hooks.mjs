// HarnessWeight — the gateway hook that watches what each agent behind the
// gateway costs you.
//
//   {"port": 3496, "dataDir": "", "gatewayTimeoutMs": 2000, "agents": []}
//
// One magpie request is one model request: the gateway routes it, the client
// (the agent) has already assembled the body, and the tool declarations in
// that body are what the agent re-sends on every turn. Their size is the
// part of the input the user pays for again and again, and no upstream
// usage page counts it per agent.
//
// What this hook records, per request, by agent:
//   - the tokens the upstream reported (input, output, cache read, cache write)
//   - the tool declarations' size: how many, how many bytes, and their names
//   - the outcome (the request succeeded or not)
//
// What it never records: the conversation, the prompt, the user's words, the
// tool arguments, the credentials. Only names, counts and numbers, so the
// file it writes is safe to keep and to show.
//
// The rows go to ~/.config/magpie/harnessweight/tools.jsonl (or dataDir). The page (a
// local service next to it) reads that file and draws the comparison.
//
// The gateway's contract for this file:
//   export async function onRequest(body, ctx) — before routing. Returning
//     undefined leaves the request as it was; returning a body that changed
//     the tools, the model or the streaming rolls the whole request back.
//     This hook only reads, so it returns undefined.
//   export async function onResponse(reply, ctx) — after the reply is whole.
//     ctx.request is the accepted request, ctx.success says whether it
//     worked. This is best-effort: a notification may be lost, and that is
//     fine, a missing row is not a wrong row.

import { appendFile, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { basename, dirname } from "node:path"
import { measureTools } from "./lib/measure.mjs"
import { toolsLog } from "./lib/paths.mjs"
import { activity } from "./lib/activity.mjs"


// Rows older than this are dropped when a generation is retired: the file is
// a rolling window of the recent past, not a ledger of all time.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
// One generation is rewritten when it passes this size. The previous
// generation is kept beside it as tools.jsonl.1, so two generations hold at
// most about 16 MiB; the next rollover retires the older one.
export const MAX_FILE_BYTES = 8 * 1024 * 1024
// How often the age of the rows is checked. The check reads the file, so it
// runs on an hourly cadence rather than on every request.
export const AGE_CHECK_MS = 60 * 60 * 1000
// The longest a response waits for the lock. The hook runs on the response
// path, so contention must cost the user almost nothing: past this window
// the sample is skipped (and a throttled warning printed) instead of
// waiting. An uncontended critical section takes a few milliseconds.
export const LOCK_TIMEOUT_MS = 100
// How long to wait between attempts to take a lock (doubles up to the max).
const LOCK_RETRY_MS = 10
const LOCK_RETRY_MAX_MS = 200
// A skipped-sample warning is printed at most this often per file.
const WARN_EVERY_MS = 60 * 1000
const append = createToolsWriter()

// Two plugin hosts can run at once (the host may keep the old one alive
// during a restart) and share a dataDir. The in-process queue cannot stop
// host B from renaming over the generation host A just moved aside, so the
// whole critical section (stat, age check, rename, append) also runs under a
// cross-process lock.
//
// A lock is a small file holding the owner's pid and a token, created with
// an exclusive open ("wx"), so exactly one host can hold it. Two layers:
//   - the main lock (<file>.lock) guards the critical section;
//   - the reaper lock (<file>.reaper.lock) is held only while reclaiming a
//     dead main lock. The reaper re-reads the main lock inside it, so two
//     reclaimers cannot both unlink, and a slow one cannot delete the fresh
//     lock a live host took in the meantime.
//
// A main lock is reclaimed only when its pid is provably dead (kill(pid, 0)
// reports ESRCH). Everything else fails closed — the sample is skipped and a
// warning printed, rather than a live host's lock removed:
//   - a lock from a live pid, or a pid we cannot signal (EPERM, other user);
//   - an empty or corrupt lock (a host died between creating it and writing
//     its pid): remove <file>.lock by hand once no host is running;
//   - a leftover reaper lock (a host died while reclaiming): remove
//     <file>.reaper.lock by hand once no host is running.
// A reused pid makes a dead lock look alive: that also fails closed.
//
// Limits: local filesystems only (O_EXCL is not reliable over NFS and pids
// mean nothing across machines or pid namespaces). Normal exits, thrown
// errors and failed writes release the lock in finally; only a hard crash
// leaves one behind, and a dead holder's lock is then reclaimed.
function lockPath(file) { return file + ".lock" }
function reaperPath(file) { return file + ".reaper.lock" }

// Create a lock file exclusively and write its owner. Returns the token, or
// null if the file already exists. A failed write removes our own empty
// file: nobody else can have replaced it, since it exists and is unreadable.
async function createLock(path) {
  let handle
  try {
    handle = await open(path, "wx")
  } catch (error) {
    if (error.code === "EEXIST") return null
    throw error
  }
  const token = randomUUID()
  let closed = false
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, token, at: Date.now() }))
    closed = true
    await handle.close()
  } catch (error) {
    // A failed write or close must not leave a lock naming this live pid:
    // nobody could ever reclaim it. The file is ours (it exists, so no one
    // else can have created it), so remove it.
    if (!closed) await handle.close().catch(() => {})
    await unlink(path).catch(() => {})
    throw error
  }
  return token
}

// Release a lock we hold. Unconditional: while we are alive nobody else
// removes it (a main lock is only reclaimed for a dead pid, a reaper lock
// never), so it cannot have been replaced. Re-reading it first would keep a
// live pid's lock forever whenever that read failed (EMFILE, EIO...).
// A failed unlink would leave this live host's lock in place and block every
// writer, this one included, until the host exits: say so (throttled, file
// name and error code only).
async function removeLock(path) {
  await unlink(path).catch((error) => {
    if (error.code === "ENOENT") return
    const key = `${path}:release:${error.code}`
    const at = Date.now()
    if (at - (warnedAt.get(key) ?? -Infinity) < WARN_EVERY_MS) return
    warnedAt.set(key, at)
    console.warn(`[harnessweight] could not release ${basename(path)} (${error.code ?? "error"}); samples are skipped until it is removed or this host exits`)
  })
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // ESRCH: no such process, the owner is gone.
    if (error.code === "ESRCH") return false
    // EPERM: the process exists but belongs to another user.
    return null
  }
}

// The lock's owner: undefined when there is no lock, null when it cannot be
// identified (empty, truncated, corrupt — including the instant between a
// live host creating it and writing its pid).
async function readLock(path) {
  let text
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") return undefined
    return null
  }
  try {
    const parsed = JSON.parse(text)
    const pid = Number(parsed?.pid)
    const token = typeof parsed?.token === "string" ? parsed.token : ""
    if (!Number.isInteger(pid) || pid <= 0 || !token) return null
    return { pid, token }
  } catch {
    // Empty, truncated or corrupt: the owner cannot be identified.
    return null
  }
}

// Take the main lock, reclaiming it first if its owner is provably dead.
// The deadline is absolute, fixed when the request was queued. One attempt
// is always made, so a free lock is taken even late; a held one fails at
// once. Throws a coded error when it cannot be taken in time.
async function acquireLock(file, deadline) {
  const path = lockPath(file)
  let wait = LOCK_RETRY_MS
  let reason = "held"
  for (;;) {
    const token = await createLock(path)
    if (token) return { path, token }
    const outcome = await reclaimDeadLock(file)
    reason = outcome
    // Checked on every path, "reclaimed" included: hosts that keep
    // reclaiming and losing the race must still give up on time.
    if (Date.now() >= deadline) {
      const error = new Error(`tools log lock not acquired (${reason})`)
      error.code = "HW_LOCK_TIMEOUT"
      error.reason = reason
      throw error
    }
    if (outcome === "reclaimed") continue
    // Never sleep past the deadline: the wait bound is what keeps the
    // response path fast.
    await sleep(Math.min(wait, Math.max(0, deadline - Date.now())))
    wait = Math.min(wait * 2, LOCK_RETRY_MAX_MS)
  }
}

// Reclaim a main lock whose owner is provably dead. Only one host reclaims
// at a time (the reaper lock), and it re-reads the main lock inside the
// reaper lock, so it can only unlink the lock it judged dead. Returns
// "reclaimed", or why not: "held" (live or unprovable owner), "unreadable"
// (empty/corrupt lock), "reaper" (another reaper, or a leftover one).
async function reclaimDeadLock(file) {
  const main = lockPath(file)
  const reaper = reaperPath(file)
  const reaperToken = await createLock(reaper)
  // Never remove a reaper lock we did not create: it may belong to a live
  // host. A leftover one blocks reclaiming until removed by hand.
  if (!reaperToken) return "reaper"
  try {
    const current = await readLock(main)
    if (current === undefined) return "reclaimed" // gone already: try again
    if (current === null) return "unreadable"
    if (alive(current.pid) !== false) return "held"
    await unlink(main).catch((error) => { if (error.code !== "ENOENT") throw error })
    return "reclaimed"
  } finally {
    await removeLock(reaper)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// The hook's own options, filled in by the gateway before the first call.
let OPTIONS = {
  port: 3496,
  dataDir: "",
  gatewayTimeoutMs: 2000,
  agents: [],
}

function dataPath() {
  return toolsLog(OPTIONS)
}

// The agent names this hook watches; empty means all of them.
function wanted(agent) {
  if (!agent) return false
  if (!Array.isArray(OPTIONS.agents) || OPTIONS.agents.length === 0) return true
  return OPTIONS.agents.some((a) => String(a).trim().toLowerCase() === String(agent).toLowerCase())
}

// The tokens a reply reports, in the shapes the four protocols use.
function usageOf(reply) {
  const u = reply?.usage ?? reply?.usage_metadata ?? reply?.usageMetadata
  if (!u || typeof u !== "object") return null
  return {
    in: num(u.input_tokens ?? u.prompt_tokens ?? u.promptTokenCount ?? u.input),
    out: num(u.output_tokens ?? u.completion_tokens ?? u.candidatesTokenCount ?? u.output),
    cacheRead: num(u.cache_read_input_tokens ?? u.cached_content_token_count ?? u.cacheRead),
    cacheWrite: num(u.cache_creation_input_tokens ?? u.cacheWrite),
  }
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

// The row this hook writes. Everything in it is a number or a name.
function row(ctx, body, reply, success) {
  const tools = measureTools(body)
  const r = {
    t: Date.now(),
    agent: ctx?.agent ?? "unknown",
    model: ctx?.model ?? body?.model ?? "unknown",
    protocol: ctx?.protocol ?? "unknown",
    path: ctx?.path ?? "",
    tools: tools.count,
    toolBytes: tools.bytes,
    toolNames: tools.names.slice(0, 60),
    ok: success !== false,
  }
  const u = usageOf(reply)
  if (u) {
    r.in = u.in
    r.out = u.out
    r.cacheRead = u.cacheRead
    r.cacheWrite = u.cacheWrite
  }
  return r
}

// The hook's entry point: called before the request goes to the model.
// This hook only reads, so it returns undefined and the request goes on
// exactly as it came.
export async function onRequest(body, ctx) {
  OPTIONS = { ...OPTIONS, ...(ctx?.options ?? {}) }
  const agent = ctx?.agent ?? "unknown"
  // ctx.state survives until onResponse. ctx.signal does NOT: the host
  // aborts it when this hook returns, even while the model is still running.
  try {
    if (wanted(agent)) activity.start(dataPath(), ctx, agent)
  } catch { /* Tracking must never interrupt the user's request. */ }
  return undefined
}

// The hook's other entry point: called after the model replied. This is
// where the row is written.
export async function onResponse(reply, ctx) {
  // Clear before any filtering or disk work, including failed responses.
  try { activity.finish(ctx) } catch { /* best-effort telemetry */ }
  OPTIONS = { ...OPTIONS, ...(ctx?.options ?? {}) }
  const agent = ctx?.agent ?? "unknown"
  if (!wanted(agent)) return

  try {
    // ctx.request is the request the gateway accepted; it carries the tool
    // declarations, which the reply knows nothing about.
    const body = ctx?.request
    await append(dataPath(), row(ctx, body, reply, ctx?.success !== false))
  } catch {
    // A hook that fails leaves the request as it was. Never let a write
    // error touch the user's request.
  }
}

// A skipped sample is reported, at most once a minute per file and code,
// with no sample content: only the file name and the reason.
const warnedAt = new Map()
function warnSkipped(error, file) {
  const code = error?.code ?? error?.name ?? "error"
  const key = `${file}:${code}:${error?.reason ?? ""}`
  const at = Date.now()
  if (at - (warnedAt.get(key) ?? -Infinity) < WARN_EVERY_MS) return
  warnedAt.set(key, at)
  const why = error?.reason === "unreadable" ? `${basename(file)}.lock is empty or corrupt; remove it once no host is running`
    : error?.reason === "reaper" ? `${basename(file)}.reaper.lock is held or left over; remove it once no host is running`
    : error?.reason === "reclaimed" ? `${basename(file)}.lock was contended past the wait budget`
    : error?.code === "HW_LOCK_TIMEOUT" ? `${basename(file)}.lock is held by another host`
    : `${code}`
  console.warn(`[harnessweight] tool sample skipped: ${why}`)
}

// Append one row to the data file. The log is append-only: rows are never
// rewritten in place. When a generation grows past the size limit, or holds
// rows older than the window, it is renamed aside (tools.jsonl.1) and a new
// generation starts. The whole stat → age check → rename → append runs under
// the in-process queue and the cross-process lock, so no host can rename a
// generation another host just moved aside.
export function createToolsWriter({
  now = Date.now,
  maxBytes = MAX_FILE_BYTES,
  lockTimeoutMs = LOCK_TIMEOUT_MS,
  warn = warnSkipped,
} = {}) {
  const states = new Map()
  return function append(file, row) {
    const line = JSON.stringify(row) + "\n"
    const bytes = Buffer.byteLength(line)
    // Refuse an oversized sample rather than allow unbounded telemetry.
    if (bytes > maxBytes) return Promise.reject(new RangeError(`Tool sample exceeds ${maxBytes} bytes`))
    let state = states.get(file)
    if (!state) { state = { tail: Promise.resolve(), checkedAt: -Infinity }; states.set(file, state) }
    // The wait budget starts now, not when this row reaches the head of the
    // queue: N queued requests behind a held lock all give up about
    // lockTimeoutMs after they arrived, instead of N × lockTimeoutMs.
    const deadline = Date.now() + lockTimeoutMs
    const pending = state.tail.then(async () => {
      await mkdir(dirname(file), { recursive: true })
      const lock = await acquireLock(file, deadline)
      try {
        let st
        try { st = await stat(file) } catch (error) { if (error.code !== "ENOENT") throw error }
        const time = now()
        let rotate = Boolean(st) && st.size + bytes > maxBytes
        if (!rotate && time - state.checkedAt >= AGE_CHECK_MS) {
          if (st?.size) {
            const text = await readFile(file, "utf8")
            rotate = text.split("\n").some((line) => {
              try { const r = JSON.parse(line); return Number.isFinite(r?.t) && r.t < time - MAX_AGE_MS }
              catch { return false }
            })
          }
          state.checkedAt = time
        }
        if (rotate) {
          // The old generation moves aside whole; nothing is rewritten.
          await rename(file, file + ".1")
          state.checkedAt = time
        }
        await appendFile(file, line, "utf8")
      } finally {
        await removeLock(lock.path)
      }
    }).catch((error) => {
      try { warn(error, file) } catch { /* reporting must not mask the error */ }
      throw error
    })
    // A failed sample must not poison later requests.
    state.tail = pending.catch(() => {})
    return pending
  }
}

