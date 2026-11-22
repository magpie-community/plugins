// The account pool: rotation order, the bench after a pool-level failure,
// the cooldown's expiry, and the summary the usage panel reads. Nothing
// here touches a real host.
import { expect, test } from "bun:test"
import { AccountPool } from "../lib/pool.mjs"

const accounts = [{ accountId: "a" }, { accountId: "b" }, { accountId: "c" }]

test("pick rotates round-robin and skips benched accounts", () => {
  let t = 1_000
  const p = new AccountPool(accounts, { now: () => t, cooldownMs: 5_000 })
  expect(p.pick().accountId).toBe("a")
  expect(p.pick().accountId).toBe("b")
  expect(p.pick().accountId).toBe("c")
  expect(p.pick().accountId).toBe("a") // wraps
})

test("a pool-level failure benches the account and moves the turn on", () => {
  let t = 1_000
  const p = new AccountPool(accounts, { now: () => t, cooldownMs: 5_000 })
  const first = p.pick()
  p.report(first, false, "Quick: the cookie or mbtc was refused (401)")
  // a is benched: the next pick is b
  expect(p.pick().accountId).toBe("b")
  const s = p.summary().find((x) => x.accountId === "a")
  expect(s.usable).toBe(false)
  expect(s.lastError).toContain("401")
  expect(s.retryInMs).toBeGreaterThan(0)
})

test("a benched account comes back after the cooldown", () => {
  let t = 1_000
  const p = new AccountPool(accounts, { now: () => t, cooldownMs: 5_000 })
  const a = p.pick()
  p.report(a, false, "usage_limit")
  expect(p.pick().accountId).toBe("b")
  // a is usable again after the cooldown — the cursor is at c, so the next
  // pick is c, then a (rotation continues from where it left off)
  t += 6_000
  expect(p.pick().accountId).toBe("c")
  expect(p.pick().accountId).toBe("a")
})

test("when every account is benched pick returns null", () => {
  let t = 1_000
  const p = new AccountPool(accounts, { now: () => t, cooldownMs: 5_000 })
  for (let i = 0; i < 3; i++) p.report(p.pick(), false, "usage_limit")
  expect(p.pick()).toBe(null)
  t += 6_000
  expect(p.pick()).not.toBe(null) // the cooldown expires
})

test("poolLevel names the account-scoped failures", () => {
  expect(AccountPool.poolLevel("Quick: the cookie or mbtc was refused (401)")).toBe(true)
  expect(AccountPool.poolLevel("403")).toBe(true)
  expect(AccountPool.poolLevel("usage_limit: wait 12m")).toBe(true)
  expect(AccountPool.poolLevel("sign-in expired")).toBe(true)
  expect(AccountPool.poolLevel("Quick: timed out waiting for message_complete")).toBe(false)
  expect(AccountPool.poolLevel("the request has no messages")).toBe(false)
})

test("an empty pool picks nothing", () => {
  const p = new AccountPool([])
  expect(p.pick()).toBe(null)
  expect(p.summary()).toEqual([])
})
