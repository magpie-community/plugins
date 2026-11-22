// Reading the console session out of the profile's Cookies sqlite.
//
// Chromium stores cookies in the profile's Default directory; only the value
// column is encrypted, so "did the console session land" needs no decryption.
// The file moved across versions: current Chrome/Edge keep it at
// Default/Network/Cookies, older ones at Default/Cookies. Both are checked.
// The completion signal for a sign-in window without CDP is a row for the
// console's session cookie that is NEWER than this launch (keep_sign_in keeps
// the previous sign-in's row, so "a row exists" is not "this sign-in
// finished").
//
// While the browser runs it holds the library lock, so every poll COPIES the
// database before querying (into the profile's own 0700 directory, not the
// system temp: the copy holds plaintext cookie rows). A locked database
// reads as "not yet" and the next poll tries again — Chrome flushes cookies
// to disk on its own ~30s timer.
import { copyFileSync, existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { COOKIE_DOMAINS, SESSION_COOKIE_NAMES, cookieDomainMatches } from "./protocol.mjs"

// Chromium time is "microseconds since 1601-01-01". Unix ms = µs/1000 - offset.
const CHROMIUM_EPOCH_OFFSET_MS = 11644473600000
export const chromiumMicros = (unixMs = Date.now()) => (unixMs + CHROMIUM_EPOCH_OFFSET_MS) * 1000
const unixMsOf = (chromiumUs) => Number(chromiumUs) / 1000 - CHROMIUM_EPOCH_OFFSET_MS

/** A row's identity: Chrome keeps creation_utc on overwrite and moves last_update_utc. */
const rowKey = (r) => `${r.host_key}\u0000${r.creation_utc}\u0000${r.last_update_utc}`

/** Where the Cookies database lives, newest layout first. */
const cookiesDbPaths = (profile) => [join(profile, "Default", "Network", "Cookies"), join(profile, "Default", "Cookies")]

/**
 * All rows of the profile's Cookies database (read from a copy). A missing
 * database, a lock, or no sqlite runtime yields [] — the caller treats that
 * as "not yet".
 */
export function cookieRows(profile, { sqliteOpen } = {}) {
  const db = cookiesDbPaths(profile).find(existsSync)
  if (!db) return []
  const open = sqliteOpen ?? defaultSqliteOpen
  let tmp = ""
  try {
    tmp = join(profile, `.moss-cookie-probe-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
    copyFileSync(db, tmp)
    return open(tmp)
  } catch {
    return [] // locked / no sqlite: treat as "not written yet"
  } finally {
    if (tmp) {
      try {
        rmSync(tmp, { force: true })
      } catch {}
    }
  }
}

/** The first of the console's session-cookie names present in a row list. */
export function sessionRowOf(rows) {
  return rows.find((r) => r?.name && SESSION_COOKIE_NAMES.includes(String(r.name))) ?? null
}

/**
 * Baseline: every console-session row in the profile before this launch.
 * A fresh (first sign-in) profile naturally yields an empty set.
 */
export function cookieBaseline(profile, opts = {}) {
  return cookieRows(profile, opts)
    .filter((r) => r?.name && SESSION_COOKIE_NAMES.includes(String(r.name)) && cookieDomainMatches(r.host_key))
    .map(rowKey)
}

/**
 * Is the sign-in finished? There must be a console session-cookie row on one
 * of the console's domains that is NOT in the baseline and is unexpired.
 */
export function profileHasNewCookie(profile, baseline = [], { sqliteOpen, nowMs = Date.now() } = {}) {
  const seen = new Set(baseline)
  return cookieRows(profile, { sqliteOpen }).some((r) => {
    if (!r?.name || !SESSION_COOKIE_NAMES.includes(String(r.name))) return false
    if (!cookieDomainMatches(r.host_key, COOKIE_DOMAINS)) return false
    if (seen.has(rowKey(r))) return false // present before this launch: the old session
    const expires = Number(r.expires_utc ?? 0)
    // 0 is a session cookie (dies with the window) — it counts; anything
    // dated must still be live.
    return !expires || unixMsOf(expires) > nowMs
  })
}

/** The default sqlite opener: bun:sqlite readonly. Tests inject a fake. */
function defaultSqliteOpen(dbPath) {
  const { Database } = require("bun:sqlite")
  const db = new Database(dbPath, { readonly: true })
  try {
    return db.query("SELECT host_key, name, creation_utc, last_update_utc, expires_utc FROM cookies").all()
  } finally {
    db.close()
  }
}
