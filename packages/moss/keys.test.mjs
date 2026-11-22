// Key management: naming that cannot collide across machines/accounts, the
// 50-key guard, prune that touches only this machine+account's keys, and
// ensureKey's paste-vs-create decision.
import "./nonet.mjs"
import { afterEach, describe, expect, test } from "bun:test"
import { hostname } from "node:os"
import { fingerprint } from "./lib/protocol.mjs"
import { HOST_TAG, ensureKey, keyCount, keyItems, keyNameFor, keyPrefixFor, pruneKeys } from "./lib/keys.mjs"
import { fakeMoss, json, keyRow } from "./fake.mjs"

let f
let keys

function serveKeys() {
  keys = []
  f.route("GET /portal-api/api_keys", () => json({ items: keys, total: keys.length }))
  f.route("POST /portal-api/api_keys", (r) => {
    const row = keyRow({ id: String(keys.length + 1), name: r.json?.name, created_at: new Date().toISOString() })
    keys.push({ ...row, api_key: "sk-new-plaintext" })
    return json({ ...row, api_key: "sk-new-plaintext" })
  })
  f.route("GET /v1/models", () => json({ object: "list", data: [{ id: "nex-n2.6" }] }))
  for (let i = 1; i <= 120; i++) {
    f.route(`DELETE /portal-api/api_keys/${i}`, () => {
      const id = f.seen.at(-1).path.split("/").pop()
      const at = keys.findIndex((k) => String(k.id) === id)
      if (at >= 0) keys.splice(at, 1)
      return json({ ok: true })
    })
  }
  return keys
}

afterEach(() => {
  f?.close()
  f = undefined
})

describe("key naming", () => {
  test("the name carries a host tag (from os.hostname) and an account hash, not the account name", () => {
    expect(HOST_TAG).toBe(fingerprint(hostname() || "host").slice(0, 8))
    const name = keyNameFor("张三")
    expect(name.startsWith(`moss-${HOST_TAG}-`)).toBe(true)
    expect(name).not.toContain("张三")
    expect(name.length).toBeLessThanOrEqual(50)
  })

  test("two accounts on one machine get different prefixes", () => {
    expect(keyPrefixFor("a")).not.toBe(keyPrefixFor("b"))
  })

  test("names are random enough that two in a row differ", () => {
    expect(keyNameFor("a")).not.toBe(keyNameFor("a"))
  })
})

describe("keyItems / keyCount", () => {
  test("reads the console's {items,total} and tolerates a missing total", async () => {
    f = fakeMoss()
    f.route("GET /portal-api/api_keys", () => json({ items: [keyRow(), keyRow({ id: 2 })] }))
    expect(await keyCount("t")).toBe(2)
    expect(keyItems({ items: [keyRow()] })[0].name).toBe("moss-key")
    expect(keyItems(null)).toEqual([])
  })
})

describe("ensureKey", () => {
  test("a pasted key is probed and used as-is", async () => {
    f = fakeMoss()
    serveKeys()
    const key = await ensureKey("t", "acct", { apiKey: "sk-pasted" })
    expect(key).toBe("sk-pasted")
    expect(keys).toHaveLength(0) // nothing created
  })

  test("a pasted key the vendor refuses fails the sign-in", async () => {
    f = fakeMoss()
    serveKeys()
    f.route("GET /v1/models", () => json({}, 403))
    await expect(ensureKey("t", "acct", { apiKey: "sk-dead", probeDelays: [0] })).rejects.toThrow("403")
  }, 20_000)

  test("a pasted key still warming up is retried, not refused", async () => {
    f = fakeMoss()
    serveKeys()
    let n = 0
    f.route("GET /v1/models", () => {
      n++
      return n < 3 ? json({}, 403) : json({ object: "list", data: [] })
    })
    const key = await ensureKey("t", "acct", { apiKey: "sk-warm", probeDelays: [0, 10, 10] })
    expect(key).toBe("sk-warm")
  })

  test("no paste + create creates a moss-* key, probes it, and returns the plaintext", async () => {
    f = fakeMoss()
    serveKeys()
    const key = await ensureKey("t", "acct", {})
    expect(key).toBe("sk-new-plaintext")
    expect(keys).toHaveLength(1)
    expect(keys[0].name.startsWith("moss-")).toBe(true)
  })

  test("create=false with no paste says so", async () => {
    f = fakeMoss()
    serveKeys()
    await expect(ensureKey("t", "acct", { create: false })).rejects.toThrow("no MOSS API key")
  })

  test("a full account without prune refuses with key_limit and deletes nothing", async () => {
    f = fakeMoss()
    serveKeys()
    for (let i = 0; i < 50; i++) keys.push(keyRow({ id: String(i + 1), name: `manual-${i}`, created_at: new Date().toISOString() }))
    let caught
    try {
      await ensureKey("t", "acct", {})
    } catch (e) {
      caught = e
    }
    expect(caught?.code).toBe("key_limit")
    expect(keys).toHaveLength(50)
  })

  test("a full account with prune frees a slot by deleting this account's oldest keys, then creates", async () => {
    f = fakeMoss()
    serveKeys()
    const prefix = keyPrefixFor("acct")
    for (let i = 0; i < 50; i++) {
      const ours = i < 3
      keys.push(
        keyRow({
          id: String(i + 1),
          name: ours ? `${prefix}old-${i}` : `manual-${i}`,
          created_at: new Date(Date.now() - (100 - i) * 60_000).toISOString(),
        }),
      )
    }
    const key = await ensureKey("t", "acct", { prune: true, probeDelays: [0] })
    expect(key).toBe("sk-new-plaintext")
    // the 51st creation succeeded: need = 50 - 49 = 1, so prune freed one
    // slot by deleting the oldest of this account's keys (old-0; the
    // keep-newest-two guard protects old-2 and old-1), manual keys stayed
    expect(keys.filter((k) => k.name.startsWith("manual-"))).toHaveLength(47)
    expect(keys.find((k) => k.name === `${prefix}old-0`)).toBeUndefined()
    expect(keys.find((k) => k.name === `${prefix}old-1`)).toBeDefined()
    expect(keys.find((k) => k.name === `${prefix}old-2`)).toBeDefined()
  })

  test("a create that returns no plaintext deletes the orphan by name and says so", async () => {
    f = fakeMoss()
    serveKeys()
    let n = 0
    f.route("POST /portal-api/api_keys", (r) => {
      n++
      const row = keyRow({ id: String(100 + n), name: r.json?.name, created_at: new Date().toISOString() })
      keys.push(row)
      // first attempt: no plaintext (the soft-refusal shape); then a good one
      return n === 1 ? json({ id: row.id, name: row.name }) : json({ ...row, api_key: "sk-new-plaintext" })
    })
    const key = await ensureKey("t", "acct", { probeDelays: [0] })
    expect(key).toBe("sk-new-plaintext")
    // the orphan (no plaintext) was deleted; the good key remains
    expect(keys.filter((k) => k.id === "101")).toHaveLength(0)
    expect(keys.filter((k) => k.id === "102")).toHaveLength(1)
  })
})

describe("pruneKeys", () => {
  test("keeps the newest two of this account, deletes older ones, never touches manual or unreadable keys", async () => {
    f = fakeMoss()
    serveKeys()
    const prefix = keyPrefixFor("acct")
    const mk = (id, name, created_at) => keyRow({ id, name, created_at })
    keys.push(
      mk("1", `${prefix}a`, new Date(Date.now() - 10 * 60_000).toISOString()),
      mk("2", `${prefix}b`, new Date(Date.now() - 20 * 60_000).toISOString()),
      mk("3", `${prefix}c`, new Date(Date.now() - 30 * 60_000).toISOString()),
      mk("4", "manual", new Date(Date.now() - 5 * 60_000).toISOString()),
      mk("5", `${prefix}broken`, ""),
    )
    const deleted = await pruneKeys("t", "acct", {})
    expect(deleted).toBe(1)
    const names = keys.map((k) => k.name)
    expect(names).toContain(`${prefix}a`)
    expect(names).toContain(`${prefix}b`)
    expect(names).toContain("manual")
    expect(names).toContain(`${prefix}broken`) // age unknown → never deleted
    expect(names).not.toContain(`${prefix}c`)
  })

  test("protects the key created this sign-in even when it is the oldest", async () => {
    f = fakeMoss()
    serveKeys()
    const prefix = keyPrefixFor("acct")
    keys.push(
      keyRow({ id: "1", name: `${prefix}fresh`, created_at: new Date(Date.now() - 60 * 60_000).toISOString() }),
      keyRow({ id: "2", name: `${prefix}old1`, created_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString() }),
      keyRow({ id: "3", name: `${prefix}old2`, created_at: new Date(Date.now() - 3 * 60 * 60_000).toISOString() }),
    )
    const deleted = await pruneKeys("t", "acct", { protectName: `${prefix}fresh` })
    // fresh is protected; old1 keeps the newest-two slot; old2 goes
    expect(deleted).toBe(1)
    expect(keys.map((k) => k.name).sort()).toEqual([`${prefix}fresh`, `${prefix}old1`].sort())
  })

  test("another machine's or another account's keys are out of reach", async () => {
    f = fakeMoss()
    serveKeys()
    keys.push(
      keyRow({ id: "1", name: `moss-deadbeef-aaaaaaaa-x`, created_at: new Date().toISOString() }),
      keyRow({ id: "2", name: keyPrefixFor("other") + "x", created_at: new Date().toISOString() }),
    )
    expect(await pruneKeys("t", "acct", {})).toBe(0)
    expect(keys).toHaveLength(2)
  })
})

describe("ensureKey failure edges", () => {
  test("a probe that cannot decide (500) does not refuse the pasted key and does not storm", async () => {
    // The vendor's probe only calls a key refused on 401/403; any other
    // answer (500 here) is "unknown", so the paste is kept and ONE request
    // is made (no retry loop on non-401/403 outcomes).
    f = fakeMoss()
    serveKeys()
    let probes = 0
    f.route("GET /v1/models", () => {
      probes++
      return json({ message: "boom" }, 500)
    })
    const key = await ensureKey("t", "acct", { apiKey: "sk-x", probeDelays: [0, 10, 10] })
    expect(key).toBe("sk-x")
    expect(probes).toBe(1)
  })

  test("the console always omitting the plaintext exhausts the retries; orphans without a deletable id stay", async () => {
    f = fakeMoss()
    serveKeys()
    let created = 0
    f.route("POST /portal-api/api_keys", (r) => {
      created++
      const row = keyRow({ id: String(200 + created), name: r.json?.name, created_at: new Date().toISOString() })
      keys.push(row)
      return json({ id: row.id, name: row.name }) // no api_key: the soft-refusal shape
    })
    let caught
    try {
      await ensureKey("t", "acct", { probeDelays: [0] })
    } catch (e) {
      caught = e
    }
    expect(caught?.code).toBe("no_plaintext")
    // three create attempts; the orphans' ids sit outside the fake's DELETE
    // routes (1..120), so deleteKeyByName reports them undeletable — the
    // message must say "could not be deleted", not claim a removal
    expect(created).toBe(3)
    expect(String(caught.message)).toContain("could not be deleted")
    expect(keys.filter((k) => String(k.id).startsWith("2"))).toHaveLength(3)
  })

  test("a create that keeps failing with a server error surfaces the vendor error", async () => {
    f = fakeMoss()
    serveKeys()
    let attempts = 0
    f.route("POST /portal-api/api_keys", () => {
      attempts++
      return json({ message: "maas tenant already exists" }, 500)
    })
    await expect(ensureKey("t", "acct", { probeDelays: [0] })).rejects.toThrow("maas tenant already exists")
    expect(attempts).toBe(3)
  })

  test("keyCount prefers the reported total over the page length, and reads the wrapped shape", async () => {
    f = fakeMoss()
    f.route("GET /portal-api/api_keys", () => json({ items: [keyRow(), keyRow({ id: 2 })], total: 50 }))
    expect(await keyCount("t")).toBe(50)
    f.route("GET /portal-api/api_keys", () => json({ data: { items: [keyRow()], total: 7 } }))
    expect(await keyCount("t")).toBe(7)
  })

  test("a no-plaintext orphan whose list read fails is reported as not removed", async () => {
    f = fakeMoss()
    serveKeys()
    let listed = 0
    f.route("GET /portal-api/api_keys", () => {
      listed++
      // the first list is keyCount's (must succeed so we reach the create);
      // later lists are deleteKeyByName's (failing: the orphan stays)
      return listed === 1 ? json({ items: [], total: 0 }) : json({ message: "list refused" }, 500)
    })
    let n = 0
    f.route("POST /portal-api/api_keys", (r) => {
      n++
      const row = keyRow({ id: String(300 + n), name: r.json?.name, created_at: new Date().toISOString() })
      keys.push(row)
      return json({ id: row.id, name: row.name })
    })
    let caught
    try {
      await ensureKey("t", "acct", { probeDelays: [0] })
    } catch (e) {
      caught = e
    }
    expect(caught?.code).toBe("no_plaintext")
    expect(String(caught.message)).toContain("could not be deleted")
  })

  test("a failing key list at count time surfaces the console error", async () => {
    f = fakeMoss()
    f.route("GET /portal-api/api_keys", () => json({ message: "list refused" }, 500))
    await expect(ensureKey("t", "acct", {})).rejects.toThrow("list refused")
  })
})
