// The credit pools: what the console's pool-usage answers, as magpie's
// usage windows. Everything runs against the local fake.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { SenseNovaAuthPlugin } from "./index.mjs"
import { fakeSenseNova, json } from "./fake.mjs"

let f
afterEach(() => f?.close())

const auth = { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3600_000, accountId: "yiheng13" }

const pool = (over = {}) => ({
  name: "通用积分池",
  pool_type: "default",
  model_ids: ["glm-5.2"],
  window_5h: { limit: "120000", used: "39657.43456", remaining: "80342.56544", reset_at: "1730000000" },
  window_7d: { limit: "1200000", used: "237942.98928", remaining: "962057.01072", reset_at: "1731000000" },
  grant_balance: "12733.76104",
  nearest_grant_expiry: "1732000000",
  ...over,
})

async function usage() {
  const plugin = await SenseNovaAuthPlugin({ client: { auth: { set: async () => {} } } })
  return plugin.auth.usage(async () => auth)
}

test("a pool's windows are the card's windows: the spent share, the count and the reset", async () => {
  f = fakeSenseNova()
  f.route("GET /lite/console/v1/tokenplan/pool-usage", (r) => {
    expect(r.headers.get("authorization")).toBe("Bearer tok")
    return json({ plan: { id: "free", name: "Free Plan" }, pools: [pool()] })
  })
  const u = await usage()
  expect(u.plan).toBe("Free Plan")
  expect(u.user).toBe("yiheng13")
  const w = u.windows.find((x) => x.name.endsWith("5 hours"))
  expect(w.used).toBeCloseTo(33.05, 1) // the SPENT share: 39657.43 / 120000
  expect(w.amount).toBe(39657.43)
  expect(w.limit).toBe(120000)
  expect(w.unit).toBe("credits")
  expect(w.display).toBe("39657.43 / 120000")
  expect(w.resetsAt).toBe(new Date(1730000000 * 1000).toISOString())
  expect(w.name).toBe("通用积分池 · 5 hours")
})

test("the default pool's two windows come first, a dedicated pool's after them", async () => {
  f = fakeSenseNova()
  f.route("GET /lite/console/v1/tokenplan/pool-usage", () =>
    json({
      plan: { name: "Free Plan" },
      pools: [
        pool({ name: "Flash-Lite积分池", pool_type: "dedicated", window_5h: { limit: "120000", used: "897.29", remaining: "119102.71", reset_at: "1730000000" }, grant_balance: undefined }),
        pool(),
      ],
    }),
  )
  const u = await usage()
  // the GUI draws the first two windows as meters: the default pool's own
  expect(u.windows[0].name).toStartWith("通用积分池")
  expect(u.windows[1].name).toBe("通用积分池 · 7 days")
  expect(u.windows.slice(2).map((w) => w.name)).toEqual(["Flash-Lite积分池 · 5 hours", "Flash-Lite积分池 · 7 days"])
})

test("a grant is a balance that expires, told as the account's balance", async () => {
  f = fakeSenseNova()
  f.route("GET /lite/console/v1/tokenplan/pool-usage", () => json({ plan: { name: "Free Plan" }, pools: [pool()] }))
  const u = await usage()
  // the GUI draws a usage balance as its own chip; a grant is never a window
  expect(u.balance).toContain("12733.76")
  expect(u.balance).toContain("granted")
  expect(u.windows.some((w) => w.name.includes("grants"))).toBe(false)
})

test("a pool with no window of its own is left out", async () => {
  f = fakeSenseNova()
  f.route("GET /lite/console/v1/tokenplan/pool-usage", () =>
    json({
      plan: { name: "Free Plan" },
      pools: [pool({ window_5h: undefined, window_7d: undefined, grant_balance: undefined, nearest_grant_expiry: undefined })],
    }),
  )
  const u = await usage()
  expect(u.windows).toEqual([])
})

test("a pool the console reports no limit for is skipped", async () => {
  f = fakeSenseNova()
  f.route("GET /lite/console/v1/tokenplan/pool-usage", () =>
    json({ plan: { name: "Free Plan" }, pools: [pool({ window_5h: { limit: "0", used: "0" } })] }),
  )
  const u = await usage()
  expect(u.windows.some((x) => x.name.endsWith("5 hours"))).toBe(false)
})

test("the console refusing the token is an error, not an empty card", async () => {
  f = fakeSenseNova()
  f.route("GET /lite/console/v1/tokenplan/pool-usage", () => json({ code: 16, message: "Unauthenticated" }, 401))
  f.route("POST /oauth2/token", () => json({ error: "invalid_grant" }, 400))
  const u = await usage()
  expect(u.error).toContain("sign in again")
  expect(u.signIn).toBe("expired")
})

test("a token the console refuses is renewed and the read tried again", async () => {
  f = fakeSenseNova()
  let calls = 0
  f.route("GET /lite/console/v1/tokenplan/pool-usage", (r) => {
    calls++
    if (r.headers.get("authorization") === "Bearer tok") return json({ code: 16 }, 401)
    return json({ plan: { name: "Free Plan" }, pools: [pool()] })
  })
  f.route("POST /oauth2/token", () => json({ access_token: "tok2", refresh_token: "r2", expires_in: 3600 }))
  const u = await usage()
  expect(u.error).toBeUndefined()
  expect(u.plan).toBe("Free Plan")
  expect(calls).toBe(2) // refused, renewed, tried again
})

test("not signed in says so", async () => {
  const plugin = await SenseNovaAuthPlugin({ client: { auth: { set: async () => {} } } })
  const u = await plugin.auth.usage(async () => ({ type: "oauth" }))
  expect(u.error).toBe("not signed in")
})
