// API-key lifecycle: the 20-character name, create on a blank prompt, the
// ten-key guard, optional pruning that never touches manual keys, and the
// one-time plaintext rule.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { KEY_LIMIT, fingerprint } from "./lib/protocol.mjs"
import { HOST_TAG, ensureKey, keyNameFor, keyPrefixFor, pruneKeys } from "./lib/keys.mjs"
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
  // the host segment comes from os.hostname() (4 hex — environment variables
  // are absent in macOS GUI processes), the account segment is 4 hex, and the
  // random tail is 4 hex: 1 byte only gave 256 names and two keys of one
  // account collided
  expect(keyPrefixFor("u")).toBe(`ink-${HOST_TAG}-${fingerprint("u").slice(0, 4)}-`)
  expect(HOST_TAG).toHaveLength(4)
  expect(fingerprint("u").slice(0, 4)).toHaveLength(4)
  expect(name.length).toBe(keyPrefixFor("u").length + 4)
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

test("a freshly created key is protected by NAME even when it is the oldest of three", async () => {
  f = fakeInkStone()
  const prefix = keyPrefixFor("u")
  // the newest two are newer; the protected one is the OLDEST — so keep:2
  // alone could not save it, and only protectName does
  const inUse = "oldest-in-use"
  const keys = serveKeys([
    { id: "oldest", name: `${prefix}${inUse}`, status: "active", created_at: now(1) },
    { id: "mid", name: `${prefix}bbbb`, status: "active", created_at: now(2) },
    { id: "newest", name: `${prefix}cccc`, status: "active", created_at: now(3) },
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
  const n = await pruneKeys("uaa", "u", { freeSlots: 0, protectName: `${prefix}${inUse}` })
  // the protected key and the two newest survive; nothing older remains to delete
  expect(n).toBe(0)
  expect(deleted).toEqual([])
  expect(keys.some((k) => k.id === "oldest")).toBe(true)
})

test("pruneKeys with a protected name really deletes the others when it should", async () => {
  f = fakeInkStone()
  const prefix = keyPrefixFor("u")
  const keys = serveKeys([
    { id: "old1", name: `${prefix}aaaa`, status: "active", created_at: now(1) },
    { id: "old2", name: `${prefix}bbbb`, status: "active", created_at: now(2) },
    { id: "protected", name: `${prefix}cccc`, status: "active", created_at: now(3) },
    { id: "newest", name: `${prefix}dddd`, status: "active", created_at: now(4) },
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
  const n = await pruneKeys("uaa", "u", { freeSlots: 0, protectName: `${prefix}aaaa` })
  // keep:2 protects "newest" and "protected"; protectName adds "old1";
  // only "old2" is a candidate. Drop protectName and this deletes 2 keys.
  expect(n).toBe(1)
  expect(deleted).toEqual(["old2"])
  expect(keys.some((k) => k.id === "old1")).toBe(true)
})

test("a key created without a plaintext is a clear failure, not a silent empty key", async () => {
  f = fakeInkStone()
  f.route("GET /v1/models", () => json({ object: "list", data: [] }))
  f.route("GET /api/tokenplan/v1/keys", () => ok({ total: 0, items: [] }))
  f.route("POST /api/tokenplan/v1/keys", () => fail(-15108, "created but hidden"))
  await expect(ensureKey("uaa", "u", { create: true })).rejects.toThrow(/plaintext|did not return/i)
})

test("an idempotency clash retries with a FRESH name and returns the key string", async () => {
  f = fakeInkStone()
  f.route("GET /v1/models", () => json({ object: "list", data: [] }))
  f.route("GET /api/tokenplan/v1/keys", () => ok({ total: 0, items: [] }))
  const posted = []
  // the console refuses the first name only: a retry that kept the same name
  // would keep hitting the clash, so the test goes red if the name is stale
  let refusedName = ""
  f.route("POST /api/tokenplan/v1/keys", (r) => {
    const name = r.json?.name
    posted.push(name)
    if (refusedName === "") {
      refusedName = name
      return fail(-15109, "name clash")
    }
    if (name === refusedName) return fail(-15109, "name clash")
    return ok({ key: "sk-retried" })
  })
  const key = await ensureKey("uaa", "u", { create: true })
  // must be the plaintext string; an envelope object would become
  // "Bearer [object Object]" for every later request
  expect(typeof key).toBe("string")
  expect(key).toBe("sk-retried")
  expect(posted).toHaveLength(2)
  expect(posted[1]).not.toBe(posted[0])
  expect(posted[0]).toBe(refusedName)
})

test("a refused new key is deleted by name - the cleanup listKeys carries no query", async () => {
  f = fakeInkStone()
  const keys = [{ id: "id-manual", name: "manual", status: "active", created_at: now(0) }]
  // the probe always refuses the new key, so ensureKey falls into its
  // 401-cleanup path, which lists the keys to find the one it just made
  f.route("GET /v1/models", () => json({ error: "refused" }, 401))
  f.route("GET /api/tokenplan/v1/keys", (r) => {
    // the platform as it is now: /keys rejects a bearer-only request
    // (-10002), and rejects any query param (-15100). With this fake,
    // putting the pagination query back on the cleanup listKeys call makes
    // the list fail and the refused key survive - this test goes red.
    if ((r.headers.get("cookie") ?? "") !== "uaa-token=[REDACTED_VALUE]") return fail(-10002, "request is not authenticated")
    if ([...r.query.keys()].length > 0) return fail(-15100, "API Key fetch failed, refresh page and retry")
    return ok({ total: keys.length, items: keys })
  })
  f.route("POST /api/tokenplan/v1/keys", (r) => {
    keys.push({ id: "id-new", name: r.json?.name, status: "active", created_at: now(keys.length + 1) })
    return ok({ key: "sk-refused" })
  })
  f.route("DELETE /api/tokenplan/v1/keys/id-new", (r) => {
    const i = keys.findIndex((k) => k.id === "id-new")
    if (i >= 0) keys.splice(i, 1)
    return ok({})
  })
  // probeWithRetry backs off 0+1.5+3+4.5+6s before giving up, hence the timeout
  await expect(ensureKey("[REDACTED_VALUE]", "u", { create: true })).rejects.toMatchObject({ status: 401 })
  expect(keys.some((k) => k.id === "id-new")).toBe(false)
  expect(keys).toHaveLength(1)
}, 30000)
