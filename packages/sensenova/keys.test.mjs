// The API-key lifecycle: the keys one account can reuse and prune never
// reach another saved account's keys. Everything runs against the local fake.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { ensureKey, findReusableKey, keyPrefix, pruneKeys } from "./lib/keys.mjs"
import { fakeSenseNova, json } from "./fake.mjs"

let f
afterEach(() => f?.close())

const KEYS_PATH = "/lite/console/v1/metered/api-keys"

// a day apart, so "newest two" is unambiguous
const day = (n) => new Date(Date.UTC(2026, 0, n)).toISOString()

/** One account's keys, as the console lists them (plaintext api_key included). */
const keyRow = (name, n) => ({ id: name, displayname: name, api_key: `sk-${name}`, create_time: day(n) })

test("pruning one account's old keys never touches another saved account's key", async () => {
  f = fakeSenseNova()
  const alice = keyPrefix("alice")
  const bob = keyPrefix("bob")
  expect(alice).not.toStartWith(bob)

  // alice has three keys; bob has one, older than all of alice's
  const rows = [
    keyRow(`${alice}20260101`, 1),
    keyRow(`${alice}20260102`, 2),
    keyRow(`${alice}20260103`, 3),
    keyRow(`${bob}20260104`, 4),
  ]
  f.route("GET " + KEYS_PATH, () => json({ api_keys: rows, total_count: rows.length }))
  f.route("DELETE " + KEYS_PATH + "/" + `${bob}20260104`, () => json({}))
  for (const r of rows.filter((k) => k.displayname.startsWith(alice))) {
    f.route("DELETE " + KEYS_PATH + "/" + r.displayname, () => json({}))
  }

  const deleted = await pruneKeys("tok", { username: "alice", log: () => {} })
  expect(deleted).toBe(1) // only alice's oldest; the newest two stay

  const gone = f.seen.filter((r) => r.method === "DELETE").map((r) => r.path.split("/").pop())
  expect(gone).toEqual([`${alice}20260101`])
  expect(gone.some((id) => id.startsWith(bob))).toBe(false)
})

test("the key in use is never pruned, even when it is the oldest", async () => {
  f = fakeSenseNova()
  const alice = keyPrefix("alice")
  const rows = [keyRow(`${alice}20260101`, 1), keyRow(`${alice}20260102`, 2), keyRow(`${alice}20260103`, 3)]
  f.route("GET " + KEYS_PATH, () => json({ api_keys: rows, total_count: 3 }))
  for (const r of rows) f.route("DELETE " + KEYS_PATH + "/" + r.displayname, () => json({}))

  const deleted = await pruneKeys("tok", { username: "alice", activeSuffix: "20260101", log: () => {} })
  expect(deleted).toBe(0)
  expect(f.seen.filter((r) => r.method === "DELETE")).toEqual([])
})

test("reuse picks this account's newest working key, never another account's", async () => {
  f = fakeSenseNova()
  const alice = keyPrefix("alice")
  const bob = keyPrefix("bob")
  const rows = [keyRow(`${alice}20260101`, 1), keyRow(`${bob}20260102`, 2), keyRow(`${bob}20260103`, 3)]
  f.route("GET " + KEYS_PATH, () => json({ api_keys: rows, total_count: 3 }))
  // every key the fake is probed with answers fine
  f.route("GET /models", () => json({ data: [] }))

  const reused = await findReusableKey("tok", f.origin, { username: "alice" })
  expect(reused).toBe(`sk-${alice}20260101`)
  expect(reused).not.toContain(bob)
})

test("a full account with no key to reuse is a key_limit error, not a deletion", async () => {
  f = fakeSenseNova()
  const alice = keyPrefix("alice")
  const rows = Array.from({ length: 20 }, (_, i) => keyRow(`${alice}2026${String(i + 1).padStart(4, "0")}`, i + 1))
  f.route("GET " + KEYS_PATH, () => json({ api_keys: rows, total_count: 20 }))
  f.route("GET /models", () => json({}, 401))

  const err = await ensureKey("tok", "alice", { baseURL: f.origin }).then(() => null, (e) => e)
  expect(err?.code).toBe("key_limit")
  expect(f.seen.filter((r) => r.method === "DELETE")).toEqual([])
})