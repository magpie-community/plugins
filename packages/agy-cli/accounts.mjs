import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseStored, emailOf } from "./signin.mjs"

// agy holds one Google sign-in at a time (the system keyring's, on Windows
// and macOS; a file in its folder where there is no keyring). This file is
// the plugin's own record of the accounts that may fill that slot: each a
// full keyring value as agy writes it. When a turn says the account's quota
// is spent, the next request rotates to the next account that isn't, by
// writing it into the slot (setStoredSignIn). The account that ran out is
// kept, with the time its quota resets (from agy's /usage), and comes back
// when that passes.
//
// The store lives next to the bridge's own agy folder (bridgeGeminiDir), as
// accounts.json, readable by the user alone (0o600 / an ACL like it).
//
// Shape:
//   { "v": 1, "active": "<email>", "accounts": [
//     { "email": "…", "value": "<the keyring JSON>", "plan": "…" (what the
//       sign-in showed, if anything), "exhaustedUntil": <ms, 0: not> } ] }

const ACTIVE_TTL_MS = 5 * 60 * 1000

// accountsPath is where the store lives on this computer.
export function accountsPath(env = process.env) {
  // Keep the store beside a custom bridge state file too. Apart from keeping
  // a user's state together, this keeps tests and private bridge instances
  // from ever touching the real account store.
  if (env.AGY_BRIDGE_STATE_FILE) return path.join(path.dirname(env.AGY_BRIDGE_STATE_FILE), "accounts.json")
  const base = env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
  return path.join(base, "magpie-agy-bridge", "accounts.json")
}

// readAccounts is the store on disk, or an empty one. A store that can't be
// read or parsed counts as empty: the plugin then runs as single-account,
// on whatever agy's keyring holds.
export function readAccounts({ env = process.env, readFile = fs.readFileSync } = {}) {
  try {
    const parsed = JSON.parse(readFile(accountsPath(env), "utf8"))
    const accounts = Array.isArray(parsed?.accounts) ? parsed.accounts : []
    return {
      v: 1,
      active: typeof parsed?.active === "string" ? parsed.active : "",
      accounts: accounts.filter((a) => typeof a?.value === "string" && a.value !== "").map((a) => ({
        email: typeof a.email === "string" ? a.email : emailOf(a.value) || "",
        value: a.value,
        plan: typeof a.plan === "string" ? a.plan : "",
        exhaustedUntil: Number.isFinite(a.exhaustedUntil) && a.exhaustedUntil > 0 ? a.exhaustedUntil : 0,
      })),
    }
  } catch {
    return { v: 1, active: "", accounts: [] }
  }
}

// normalizeAccounts is the store after one account is saved or refreshed:
// one entry per email, the new value replacing the old, first-added order
// kept. The active account, when the store says one, stays active.
export function withAccount(store, { email, value, plan = "", active = false }) {
  const entry = {
    email: email || emailOf(value) || "",
    value,
    plan: plan || "",
    exhaustedUntil: 0,
  }
  const accounts = []
  let placed = false
  for (const a of store.accounts) {
    if (a.email && entry.email && a.email.toLowerCase() === entry.email.toLowerCase()) {
      if (!entry.plan) entry.plan = a.plan
      entry.exhaustedUntil = a.exhaustedUntil || 0
      accounts.push(entry)
      placed = true
    } else {
      accounts.push(a)
    }
  }
  if (!placed) accounts.push(entry)
  const out = { v: 1, active: store.active, accounts }
  if (active || !out.active || !accounts.some((a) => a.email === out.active)) {
    out.active = entry.email
  }
  return out
}

// writeAccounts saves the store. Returns false when it couldn't (no state
// directory, no permission): the rotation then doesn't happen across
// restarts, and the write says so rather than failing the request.
export function writeAccounts(store, { env = process.env, writeFile = fs.writeFileSync } = {}) {
  try {
    const file = accountsPath(env)
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const text = JSON.stringify(store, null, 2)
    writeFile(file, text, { mode: 0o600 })
    if (process.platform === "win32") restrictToUser(file)
    return true
  } catch {
    return false
  }
}

// On Windows a file's mode isn't its ACL: the store holds refresh tokens,
// so the broad groups come off it, as the migration store did.
function restrictToUser(file) {
  try {
    fs.chmodSync(file, 0o600)
    // icacls already grants the owner; this only trims broad groups.
    execFileSync("icacls.exe", [file, "/inheritance:r", "/grant:r", `${os.userInfo().username}:F`], { windowsHide: true })
  } catch {}
}

// pickAccount is the account the next request should run on: the active one
// when its quota isn't spent, else the next one that isn't, in order. The
// active account is left alone when nothing else is free: the request then
// runs on it and says what agy said (the client sees the quota error, and
// the account comes back when its window resets).
export function pickAccount(store, { now = Date.now() } = {}) {
  const usable = (a) => !a.exhaustedUntil || a.exhaustedUntil <= now
  const accounts = store.accounts
  if (!accounts.length) return null
  const active = accounts.find((a) => a.email && a.email === store.active) ?? null
  if (active && usable(active)) return { account: active, rotated: false }
  const next = accounts.find(usable) ?? null
  if (next) return { account: next, rotated: next !== active }
  // everything is spent: stay on the account whose exhaustion ends soonest,
  // so the error the client sees is the one that clears first
  const soonest = [...accounts].sort((a, b) => (a.exhaustedUntil || Infinity) - (b.exhaustedUntil || Infinity))[0]
  return { account: active ?? soonest, rotated: false }
}

// nextRotation clears the active mark so the following request picks
// again: the account that ran out is spent, so the earliest free one takes
// its place, keeping first-added order among the free ones.
export function rotateOff(store, email, { now = Date.now() } = {}) {
  const hit = store.accounts.find((a) => a.email && email && a.email.toLowerCase() === email.toLowerCase())
  if (!hit) return { store, changed: false }
  const usable = (a) => !a.exhaustedUntil || a.exhaustedUntil <= now
  const next = store.accounts.find(usable)
  const active = next ? next.email : store.active
  if (active === store.active) return { store, changed: false }
  return { store: { v: 1, active, accounts: store.accounts }, changed: true }
}

// markExhausted is the store after an account ran out of quota. Its
// exhaustedUntil is the shorter of what it was and the given time; a
// missing time (0) keeps the current one, or, with none, a backoff so the
// account isn't tried again at once.
export function markExhausted(store, email, until, { now = Date.now() } = {}) {
  const fallback = now + 15 * 60 * 1000
  let changed = false
  const accounts = store.accounts.map((a) => {
    if (!email || (a.email && a.email.toLowerCase() !== email.toLowerCase())) return a
    // exhaustedUntil is the earliest future time either a prior mark or a
    // usage reset says; with neither, a backoff so the account isn't tried
    // again at once.
    const known = []
    if (a.exhaustedUntil > now) known.push(a.exhaustedUntil)
    if (until > now) known.push(until)
    const u = known.length ? Math.min(...known) : fallback
    if (a.exhaustedUntil !== u) changed = true
    return { ...a, exhaustedUntil: u }
  })
  return { store: { v: 1, active: store.active, accounts }, changed }
}

// markRestored clears an account's exhaustion: its usage was read and shows
// quota. Returns the store and whether it changed.
export function markRestored(store, email) {
  let changed = false
  const accounts = store.accounts.map((a) => {
    if (!email || (a.email && a.email.toLowerCase() !== email.toLowerCase())) return a
    if (a.exhaustedUntil) changed = true
    return { ...a, exhaustedUntil: 0 }
  })
  return { store: { v: 1, active: store.active, accounts }, changed }
}

// resetTimesOf is when each window in a usage read resets, keyed by model
// id: the earliest reset of a window that says it. A rotation mark uses the
// earliest one across the models the request asked for.
export function resetTimesOf(usage) {
  const out = new Map()
  for (const w of usage?.windows ?? []) {
    const at = w?.resetsAt ? Date.parse(w.resetsAt) : NaN
    if (!Number.isFinite(at) || at <= 0) continue
    const models = Array.isArray(w.models) ? w.models : []
    const list = models.length ? models : [""]
    for (const m of list) {
      const was = out.get(m)
      if (was == null || at < was) out.set(m, at)
    }
  }
  return out
}

// activeEmailOf is the account a stored keyring value names, "" when it
// doesn't say: the store's active account follows what the slot holds.
export function activeEmailOf(raw) {
  return emailOf(raw)
}
