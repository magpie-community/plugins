import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import { publishPageScript } from "./page-publish.js"
import { acquireLock, assertLockOwner, releaseLock } from "./lock-file.js"

const FLUSH_MS = 30_000
const KEEP_RECENT = 20
const MAX_BYTES = 1_000_000

function dataDir() {
  if (process.env.OUTPUT_STRATEGY_DATA_DIR) return process.env.OUTPUT_STRATEGY_DATA_DIR
  if (process.env.MAGPIE_CONFIG_DIR) return join(process.env.MAGPIE_CONFIG_DIR, "output-strategy")
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "magpie", "output-strategy")
  return join(homedir(), ".config", "magpie", "output-strategy")
}

export const statsPath = () => join(dataDir(), "stats.json")

function blank() {
  return {
    at: null,
    requests: 0,
    applied: 0,
    skipped: 0,
    injectedBytes: 0,
    styles: {},
    reasons: {},
    recent: [],
  }
}

const number = value => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function counts(base, delta) {
  const result = {}
  for (const source of [base, delta]) {
    for (const [key, value] of Object.entries(source || {})) result[key] = number(result[key]) + number(value)
  }
  return result
}

const recentKey = entry => [entry.ts, entry.applied, entry.skippedReason, entry.addedBytes, ...(entry.appliedStyles || [])].join("|")

function recent(...lists) {
  const seen = new Set()
  const result = []
  for (const entry of lists.flat()) {
    if (!entry || typeof entry !== "object") continue
    const key = recentKey(entry)
    if (seen.has(key)) continue
    seen.add(key)
    result.push({
      ts: typeof entry.ts === "string" ? entry.ts : "",
      applied: entry.applied === true,
      skippedReason: typeof entry.skippedReason === "string" ? entry.skippedReason : null,
      appliedStyles: Array.isArray(entry.appliedStyles) ? entry.appliedStyles.filter(value => typeof value === "string") : [],
      addedBytes: Math.max(0, number(entry.addedBytes)),
    })
    if (result.length === KEEP_RECENT) break
  }
  return result
}

function merge(base, delta) {
  const before = base && typeof base === "object" ? base : blank()
  const after = delta && typeof delta === "object" ? delta : blank()
  return {
    at: new Date().toISOString(),
    requests: number(before.requests) + number(after.requests),
    applied: number(before.applied) + number(after.applied),
    skipped: number(before.skipped) + number(after.skipped),
    injectedBytes: number(before.injectedBytes) + number(after.injectedBytes),
    styles: counts(before.styles, after.styles),
    reasons: counts(before.reasons, after.reasons),
    recent: recent(after.recent, before.recent),
  }
}

let total = blank()
let pending = blank()
let lastFlushAt = 0
let queue = Promise.resolve()

export function snapshot() {
  return JSON.parse(JSON.stringify(total))
}

export function record(result) {
  try {
    if (!result || typeof result !== "object") return
    const applied = result.applied === true
    const skippedReason = typeof result.skippedReason === "string" && result.skippedReason
      ? result.skippedReason
      : applied ? null : "unknown"
    const appliedStyles = [...new Set((Array.isArray(result.appliedStyles) ? result.appliedStyles : []).filter(value => typeof value === "string"))]
    const addedBytes = Math.max(0, number(result.addedBytes))
    const entry = {
      ts: typeof result.ts === "string" ? result.ts : new Date().toISOString(),
      applied,
      skippedReason,
      appliedStyles,
      addedBytes,
    }

    for (const state of [total, pending]) {
      state.requests += 1
      if (applied) {
        state.applied += 1
        state.injectedBytes += addedBytes
        for (const style of appliedStyles) state.styles[style] = number(state.styles[style]) + 1
      } else {
        state.skipped += 1
        state.reasons[skippedReason] = number(state.reasons[skippedReason]) + 1
      }
      state.recent.unshift({ ...entry, appliedStyles: [...appliedStyles] })
      if (state.recent.length > KEEP_RECENT) state.recent.length = KEEP_RECENT
    }

    if (Date.now() - lastFlushAt >= FLUSH_MS) void flush()
  } catch {
    // Telemetry must never affect a request.
  }
}

export function flush(force = false) {
  const run = async () => {
    if (pending.requests === 0) return snapshot()
    const now = Date.now()
    if (!force && now - lastFlushAt < FLUSH_MS) return snapshot()

    const delta = pending
    pending = blank()
    const path = statsPath()
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    let held = null
    try {
      await mkdir(dataDir(), { recursive: true })
      held = await acquireLock(path)
      if (!held) throw new Error("stats lock timeout")
      let stored = null
      try {
        const text = await readFile(path, "utf8")
        if (text.length <= MAX_BYTES) stored = JSON.parse(text)
      } catch {
        // Missing or malformed data is replaced by a valid summary.
      }
      const persisted = merge(stored, delta)
      await writeFile(temporary, `${JSON.stringify(persisted, null, 2)}\n`, "utf8")
      await assertLockOwner(held)
      await rename(temporary, path)
      total = merge(persisted, pending)
      lastFlushAt = now
      await publishPageScript("stats.js", "__OUTPUT_STRATEGY_STATS__", persisted)
      return snapshot()
    } catch {
      pending = merge(pending, delta)
      total = merge(total, blank())
      try { await rm(temporary, { force: true }) } catch {}
      return snapshot()
    } finally {
      await releaseLock(held)
    }
  }
  const result = queue.then(run, run)
  queue = result.catch(() => {})
  return result
}
