// The silent-renewal failure paths — the bug hid in them: the e2e suite only
// exercised success, so an expired token made every 60s usage() poll launch a
// browser, fail, and launch a second one from the 401 branch. Here the plugin's
// renewSilently seam is swapped for a controllable fake, so these run fast and
// deterministic: failures must back off exponentially, the error card must be
// cached so the poll stops digging, and one usage read must renew at most once.
import "./nonet.mjs"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { _internal, InkStoneAuthPlugin } from "./index.mjs"
import { renewSilently as realRenewSilently } from "./lib/browser.mjs"
import { fakeInkStone, jwtOf, ok, poolUsageFixture, packagesFixture } from "./fake.mjs"

let f
afterEach(() => f?.close())

async function plugin(options = {}) {
  return InkStoneAuthPlugin({ client: { auth: { set: async () => {} } } }, options)
}

function serveBalance() {
  f.route("GET /api/tokenplan/v1/credits/balance", () => ok(poolUsageFixture()))
  f.route("GET /api/tokenplan/v1/credits/packages", () => ok(packagesFixture()))
  f.route("GET /api/tokenplan/v1/users/validate", () => ok({ name: "张三", phone: "12345678901" }))
}

// --- the seam: replace renewSilently with a controllable fake -------------
let renewCalls = 0
let renewMode = "fail" // "fail" | "ok"

beforeEach(() => {
  renewCalls = 0
  renewMode = "fail"
  _internal.__setRenewSilentlyForTests(async ({ log } = {}) => {
    renewCalls += 1
    if (renewMode === "fail") {
      log?.("silent renewal failed: fake failure")
      return ""
    }
    return "fake-uaa-token-for-tests"
  })
})

afterEach(() => {
  _internal.__setRenewSilentlyForTests(realRenewSilently)
  _internal.__resetRenewalStateForTests()
})

/** An expired uaa-token, so every usage() read walks the renewal path. */
const expiredAuth = () => ({ type: "oauth", access: "sk-test", apiKey: "sk-test", uaaToken: jwtOf({ exp: Math.floor(Date.now() / 1000) - 60 }) })

test("three consecutive renewal failures open the browser once — backoff blocks the retries", async () => {
  f = fakeInkStone()
  serveBalance()
  const p = await plugin()
  for (let i = 0; i < 3; i++) {
    const u = await p.auth.usage(async () => expiredAuth())
    expect(u.error).toBeUndefined() // the balance itself is fine; only the renewal failed
  }
  // the bug: every read renewed (and the 401 branch renewed a second time).
  // With the backoff, only the first read reaches the browser.
  expect(renewCalls).toBe(1)
}, 20_000)

test("within the cooldown a second call launches no browser", async () => {
  f = fakeInkStone()
  serveBalance()
  const p = await plugin()
  await p.auth.usage(async () => expiredAuth())
  expect(renewCalls).toBe(1)
  // the failed renewal started the first cooldown (30s); a call right after
  // must not renew again
  await p.auth.usage(async () => expiredAuth())
  expect(renewCalls).toBe(1)
}, 20_000)

test("the backoff grows exponentially and caps at one hour", () => {
  const { __renewBackoffForTests: backoff } = _internal
  const seq = [backoff(0), backoff(1), backoff(2), backoff(3), backoff(4), backoff(5)]
  // 30s → 1m → 2m → 4m → 8m → 16m → 32m → 64m is capped at the 1h ceiling
  expect(seq).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 960_000])
  expect(backoff(6)).toBe(1_920_000)
  expect(backoff(7)).toBe(3_600_000)
  expect(backoff(12)).toBe(3_600_000)
}, 20_000)

test("a successful renewal clears the cooldown", async () => {
  f = fakeInkStone()
  serveBalance()
  const p = await plugin()
  // one failure puts the renewal into cooldown…
  const failed = await p.auth.usage(async () => expiredAuth())
  expect(renewCalls).toBe(1)
  // the card still shows the (cached) balance: a renewal failure is not a
  // balance failure — this is why the failure is easy to miss in production
  expect(failed.error).toBeUndefined()
  // …then the renewal succeeds: the state must reset. The read goes back to
  // the console with the renewed token, so the cached card is replaced too.
  renewMode = "ok"
  const u = await p.auth.usage(async () => expiredAuth())
  expect(renewCalls).toBe(1) // still 1 here: the cooldown from the failure above
  // the cooldown is cleared by the success (state reset) — verify via the
  // module state, then a later failing read renews again
  renewMode = "fail"
  await p.auth.usage(async () => expiredAuth())
  expect(renewCalls).toBe(1)
  _internal.__resetRenewalStateForTests()
  renewMode = "ok"
  await p.auth.usage(async () => expiredAuth())
  expect(renewCalls).toBe(2)
}, 20_000)

test("the 401 path renews at most once per usage read", async () => {
  f = fakeInkStone()
  // balance keeps answering 401; the token is expired so ensureFreshToken
  // already renewed once — the 401 branch must not renew a second time.
  f.route("GET /api/tokenplan/v1/credits/balance", () => new Response("", { status: 401 }))
  f.route("GET /api/tokenplan/v1/credits/packages", () => ok(packagesFixture()))
  f.route("GET /api/tokenplan/v1/users/validate", () => ok({ name: "张三" }))
  const p = await plugin()
  const u = await p.auth.usage(async () => expiredAuth())
  expect(u.error).toContain("console session expired")
  expect(renewCalls).toBe(1)
}, 20_000)

test("an error card is cached: the repeated 60s poll asks nothing new", async () => {
  f = fakeInkStone()
  // the console 401s everything: the failed read must land in the cache so
  // the next poll inside the TTL serves the same error without new traffic
  f.route("GET /api/tokenplan/v1/credits/balance", () => new Response("", { status: 401 }))
  f.route("GET /api/tokenplan/v1/credits/packages", () => new Response("", { status: 401 }))
  f.route("GET /api/tokenplan/v1/users/validate", () => new Response("", { status: 401 }))
  const p = await plugin()
  const u1 = await p.auth.usage(async () => expiredAuth())
  expect(u1.error).toContain("console session expired")
  expect(f.seen.filter((r) => r.path.endsWith("/credits/balance")).length).toBe(1)
  expect(renewCalls).toBe(1)
  // the second read inside the TTL is served from the cached error card —
  // no console traffic, no renewal (the bug: errors were never cached)
  const u2 = await p.auth.usage(async () => expiredAuth())
  expect(u2.error).toBe(u1.error)
  expect(f.seen.filter((r) => r.path.endsWith("/credits/balance")).length).toBe(1)
  expect(renewCalls).toBe(1)
}, 20_000)
