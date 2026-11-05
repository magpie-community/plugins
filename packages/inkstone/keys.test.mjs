// API-key lifecycle: the 20-character name, create on a blank prompt, the
// ten-key guard, optional pruning that never touches manual keys, and the
// one-time plaintext rule.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { KEY_LIMIT } from "./lib/protocol.mjs"
import { ensureKey, keyNameFor, keyPrefixFor, pruneKeys } from "./lib/keys.mjs"
import { fakeInkStone, json, ok, fail } from "./fake.mjs"

let f
afterEach(() => f?.close())

const now = (n) => new Date(Date.UTC(2026, 10, 1, 0, 0, n)).toISOString()

function serveKeys(initial = []) {
  const keys = initial.map((k) => ({ ...k }))
  f.route("GET /v1/models", () => json({ object: "list", data: [] }))
  f.route("GET /api/tokenplan/v1/keys", () => ok({ total: keys.length, items: keys }))
  f.route("POST /api/tokenplan/v1/keys", (r) => {
    const name = r.json?.name
    keys.push({ id: `id-${keys.length + 1}`, name, status: "active", created_at: now(keys.length + 1) })
    return ok({ key: "sk-new" })
  })
  return keys
}

test("a key name fits the console's 20-character limit and carries this host and account", () => {
  const name = keyNameFor("u")
  expect(name.length).toBeLessThanOrEqual(20)
  expect(name.startsWith(keyPrefixFor("u"))).toBe(true)
  expect(keyPrefixFor("u").startsWith("ink-")).toBe(true)
})

test("a pasted key is probed and used as-is, with no key created", async () => {
  f = fakeInkStone()
  serveKeys([])
  expect(await ensureKey("uaa", "u", { apiKey: "sk-pasted", create: true })).toBe("sk-pasted")
  expect(f.seen.some((r) => r.method === "POST" && r.path.endsWith("/keys"))).toBe(false)
})

test("a blank prompt creates one key with an idempotency key", async () => {
  f = fakeInkStone()
  serveKeys([])
  expect(await ensureKey("uaa", "u", { create: true })).toBe("sk-new")
  const post = f.seen.find((r) => r.method === "POST" && r.path.endsWith("/keys"))
  expect(post.json.name.startsWith(keyPrefixFor("u"))).toBe(true)
  expect(post.headers.get("idempotency-key")).toBeTruthy()
  expect(post.json.name.length).toBeLessThanOrEqual(20)
})

test("an account at the ten-key limit is refused unless pruning is on", async () => {
  f = fakeInkStone()
  const keys = serveKeys(
    Array.from({ length: KEY_LIMIT }, (_, i) => ({
      id: `k${i}`,
      name: `manual-${i}`,
      status: "active",
      created_at: now(i + 1),
    })),
  )
  await expect(ensureKey("uaa", "u", { create: true })).rejects.toMatchObject({ code: "key_limit" })
  expect(keys.length).toBe(KEY_LIMIT)
})

test("pruning frees a slot for a new key and deletes only this machine's old keys", async () => {
  f = fakeInkStone()
  const prefix = keyPrefixFor("u")
  const keys = serveKeys([
    { id: "old", name: `${prefix}aaaa`, status: "active", created_at: now(1) },
    { id: "keep1", name: `${prefix}bbbb`, status: "active", created_at: now(2) },
    { id: "keep2", name: `${prefix}cccc`, status: "active", created_at: now(3) },
    { id: "manual", name: "my-own-key", status: "active", created_at: now(4) },
    { id: "unknown", name: `${prefix}dddd`, status: "active", created_at: "" },
  ])
  const deleted = []
  for (const k of keys) {
    f.route("DELETE /api/tokenplan/v1/keys/" + k.id, () => {
      deleted.push(k.id)
      const i = keys.findIndex((x) => x.id === k.id)
      if (i >= 0) keys.splice(i, 1)
      return ok({})
    })
  }
  const n = await pruneKeys("uaa", "u", { freeSlots: 0 })
  expect(n).toBe(1)
  expect(deleted).toEqual(["old"])
  expect(keys.some((k) => k.id === "manual")).toBe(true)
  expect(keys.some((k) => k.id === "unknown")).toBe(true)
})

test("pruning never deletes a key whose age is unknown, including created_at 0", async () => {
  f = fakeInkStone()
  const prefix = keyPrefixFor("u")
  const keys = serveKeys([
    { id: "zero", name: `${prefix}aaaa`, status: "active", created_at: 0 },
    { id: "empty", name: `${prefix}bbbb`, status: "active", created_at: "" },
    { id: "keep1", name: `${prefix}cccc`, status: "active", created_at: now(1) },
  ])
  const deleted = []
  for (const k of keys) {
    f.route("DELETE /api/tokenplan/v1/keys/" + k.id, () => {
      deleted.push(k.id)
      const i = keys.findIndex((x) => x.id === k.id)
      if (i >= 0) keys.splice(i, 1)
      return ok({})
    })
  }
  const n = await pruneKeys("uaa", "u", { freeSlots: 0 })
  expect(n).toBe(0)
  expect(deleted).toEqual([])
  expect(keys.length).toBe(3)
})

test("a key created without a plaintext is a clear failure, not a silent empty key", async () => {
  f = fakeInkStone()
  f.route("GET /v1/models", () => json({ object: "list", data: [] }))
  f.route("GET /api/tokenplan/v1/keys", () => ok({ total: 0, items: [] }))
  f.route("POST /api/tokenplan/v1/keys", () => fail(-15108, "created but hidden"))
  await expect(ensureKey("uaa", "u", { create: true })).rejects.toThrow(/plaintext|did not return/i)
})

test("an idempotency clash retries and returns the key string, not the raw envelope", async () => {
  f = fakeInkStone()
  f.route("GET /v1/models", () => json({ object: "list", data: [] }))
  f.route("GET /api/tokenplan/v1/keys", () => ok({ total: 0, items: [] }))
  let posts = 0
  f.route("POST /api/tokenplan/v1/keys", () => {
    posts += 1
    return posts === 1 ? fail(-15109, "idempotency conflict") : ok({ key: "sk-retried" })
  })
  const key = await ensureKey("uaa", "u", { create: true })
  // must be the plaintext string; an envelope object would become
  // "Bearer [object Object]" for every later request
  expect(typeof key).toBe("string")
  expect(key).toBe("sk-retried")
  expect(posts).toBe(2)
})
