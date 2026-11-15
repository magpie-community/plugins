import assert from "node:assert/strict"
import { test } from "node:test"
import path from "node:path"
import {
  accountsPath, activeEmailOf, markExhausted, markRestored, pickAccount,
  readAccounts, resetTimesOf, rotateOff, withAccount, writeAccounts,
} from "../accounts.mjs"

const NOW = Date.parse("2026-11-13T00:00:00Z")
const value = (email) => JSON.stringify({ token: { access_token: "a", refresh_token: "r" }, id_token_email: email })
const account = (email, exhaustedUntil = 0, plan = "") => ({ email, value: value(email), plan, exhaustedUntil })

const store = (accounts, active = "") => ({ v: 1, active, accounts })

test("accountsPath keeps the store beside a custom state file, else under XDG state", () => {
  assert.equal(
    accountsPath({ AGY_BRIDGE_STATE_FILE: path.join("C:", "tmp", "bridge", "state.json") }),
    path.join("C:", "tmp", "bridge", "accounts.json"),
  )
  assert.equal(
    accountsPath({ XDG_STATE_HOME: path.join("x", "state") }),
    path.join("x", "state", "magpie-agy-bridge", "accounts.json"),
  )
})

test("readAccounts returns the store on disk, or an empty one when it can't be read", () => {
  const json = JSON.stringify(store(
    [account("one@example.com"), { email: "bad", value: "", plan: "x" }, account("two@example.com", 5)],
    "one@example.com",
  ))
  const got = readAccounts({ env: {}, readFile: () => json })
  assert.equal(got.active, "one@example.com")
  assert.deepEqual(got.accounts.map((a) => a.email), ["one@example.com", "two@example.com"])
  assert.equal(got.accounts[1].exhaustedUntil, 5)
  assert.deepEqual(readAccounts({ env: {}, readFile: () => { throw new Error("no") } }), { v: 1, active: "", accounts: [] })
  // a value with no email field takes its email from the token
  const anonymous = readAccounts({ env: {}, readFile: () => JSON.stringify(store([{ value: value("hidden@example.com") }])) })
  assert.equal(anonymous.accounts[0].email, "hidden@example.com")
})

test("withAccount upserts one entry, keeps first-added order, and names the first account active", () => {
  let s = store([])
  s = withAccount(s, { email: "a@example.com", value: value("a@example.com") })
  s = withAccount(s, { email: "b@example.com", value: value("b@example.com") })
  assert.equal(s.active, "a@example.com")
  assert.deepEqual(s.accounts.map((a) => a.email), ["a@example.com", "b@example.com"])
  // re-saving the first account replaces it without moving it
  s = withAccount(s, { email: "a@example.com", value: value("a@example.com"), plan: "Pro" })
  assert.deepEqual(s.accounts.map((a) => a.email), ["a@example.com", "b@example.com"])
  assert.equal(s.accounts[0].plan, "Pro")
  assert.equal(s.active, "a@example.com")
  // an explicit active flag moves the active mark
  s = withAccount(s, { email: "b@example.com", value: value("b@example.com"), active: true })
  assert.equal(s.active, "b@example.com")
})

test("pickAccount prefers the active account, then the earliest free one, then the soonest to reset", () => {
  const s = store([account("a"), account("b"), account("c")], "b")
  assert.deepEqual(pickAccount(s, { now: NOW }), { account: s.accounts[1], rotated: false })
  // active exhausted, next free keeps first-added order
  const s2 = store([account("a"), account("b", NOW + 1000), account("c")], "b")
  assert.deepEqual(pickAccount(s2, { now: NOW }), { account: s2.accounts[0], rotated: true })
  // all spent: stay on the active account so the client sees the error that clears first
  const s3 = store([account("a", NOW + 9000), account("b", NOW + 5000)], "b")
  assert.deepEqual(pickAccount(s3, { now: NOW }), { account: s3.accounts[1], rotated: false })
  // empty store
  assert.equal(pickAccount(store([]), { now: NOW }), null)
})

test("rotateOff hands the active mark to the next free account, or stays put", () => {
  // the call site marks the account exhausted first, then clears the active
  // mark so the next request picks the earliest free account
  let s = markExhausted(store([account("a"), account("b")], "a"), "a", 0, { now: NOW }).store
  assert.deepEqual(rotateOff(s, "a", { now: NOW }), { store: { ...s, active: "b" }, changed: true })
  // the exhausted account isn't chosen again
  s = markExhausted(store([account("a"), account("b", NOW + 5000), account("c")], "a"), "a", 0, { now: NOW }).store
  const r = rotateOff(s, "a", { now: NOW })
  assert.equal(r.store.active, "c")
  // unknown email and an already-correct active mark are no-ops
  assert.deepEqual(rotateOff(s, "nope", { now: NOW }), { store: s, changed: false })
  const alreadyOff = store([account("a", NOW + 5000), account("c")], "c")
  assert.deepEqual(rotateOff(alreadyOff, "a", { now: NOW }), { store: alreadyOff, changed: false })
})

test("markExhausted stamps only the named account, with a 15-minute backoff when no reset is known", () => {
  let s = store([account("a"), account("b")])
  const r = markExhausted(s, "a", 0, { now: NOW })
  assert.equal(r.changed, true)
  assert.equal(r.store.accounts[0].exhaustedUntil, NOW + 15 * 60 * 1000)
  assert.equal(r.store.accounts[1].exhaustedUntil, 0)
  // a known reset is honored; a spent account keeps the earlier time
  const s2 = store([account("a", NOW + 1000)])
  assert.equal(markExhausted(s2, "a", NOW + 2000, { now: NOW }).store.accounts[0].exhaustedUntil, NOW + 1000)
  assert.equal(markExhausted(s2, "a", 0, { now: NOW }).store.accounts[0].exhaustedUntil, NOW + 1000)
})

test("markRestored clears one account's exhaustion", () => {
  const s = store([account("a", NOW + 5000), account("b", NOW + 5000)])
  const r = markRestored(s, "a")
  assert.equal(r.changed, true)
  assert.equal(r.store.accounts[0].exhaustedUntil, 0)
  assert.equal(r.store.accounts[1].exhaustedUntil, NOW + 5000)
})

test("resetTimesOf records the earliest reset per model id", () => {
  const usage = {
    windows: [
      { models: ["gemini"], resetsAt: "2026-11-14T00:00:00Z" },
      { models: ["gemini", "claude"], resetsAt: "2026-11-13T00:00:00Z" },
      { models: ["claude"], resetsAt: "2026-11-12T00:00:00Z" },
      { models: [], resetsAt: "2026-11-11T00:00:00Z" },
    ],
  }
  const times = resetTimesOf(usage)
  assert.equal(times.get("gemini"), Date.parse("2026-11-13T00:00:00Z"))
  assert.equal(times.get("claude"), Date.parse("2026-11-12T00:00:00Z"))
  assert.equal(times.get(""), Date.parse("2026-11-11T00:00:00Z"))
})

test("activeEmailOf names the account a keyring value holds", () => {
  assert.equal(activeEmailOf(value("me@example.com")), "me@example.com")
  assert.equal(activeEmailOf("not json"), "")
})

test("writeAccounts writes the JSON with owner-only permissions", () => {
  let wrote = null
  const ok = writeAccounts(store([account("a@example.com")], "a@example.com"), {
    env: { AGY_BRIDGE_STATE_FILE: "/tmp/agy-bridge-test/state.json" },
    writeFile: (file, text, opts) => { wrote = { file, text, opts } },
  })
  assert.equal(ok, true)
  assert.equal(wrote.file, accountsPath({ AGY_BRIDGE_STATE_FILE: "/tmp/agy-bridge-test/state.json" }))
  assert.deepEqual(JSON.parse(wrote.text).accounts, [{ email: "a@example.com", value: value("a@example.com"), plan: "", exhaustedUntil: 0 }])
  assert.equal(wrote.opts.mode, 0o600)
  // a failed write is reported false, not thrown
  assert.equal(writeAccounts(store([]), { env: {}, writeFile: () => { throw new Error("nope") } }), false)
})
