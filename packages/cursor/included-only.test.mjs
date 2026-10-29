// magpie-community/plugins#485: "Included usage only", magpie's plugin
// option (off by default). On, the included pools (Cursor Models and Other
// Models; an Enterprise account's allowance) are what stops an account, and
// On-demand and Total are shown only. Off, on-demand that can still pay keeps
// a spent account in routing, as before. The replies are dashboard fixtures
// shaped as usage.test.mjs's (GetCurrentPeriodUsage, GetHardLimit,
// usage-summary), not a real account driven past its limit.
import "./nonet.mjs" // first: no request leaves this machine
import { afterEach, expect, test } from "bun:test"
import { CursorAuthPlugin } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

let n = 0
// a sign-in of its own, so nothing asked for another is remembered for it
const fresh = () => ({
  type: "oauth",
  access: ["e30", Buffer.from(JSON.stringify({ sub: "auth0|user_included" + ++n, exp: Math.floor(Date.now() / 1000) + 7200 + n })).toString("base64url"), "sig"].join("."),
  refresh: "",
  expires: 0,
  accountId: "a@b.c",
})

const PERIOD = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage"
const HARD = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetHardLimit"
const SUMMARY = "https://cursor.com/api/usage-summary"
const BOT = "https://cursor.com/api/dashboard/get-sand-usage-status"

const provider = { models: Object.fromEntries(["auto", "composer-2.5", "claude-opus-5-5", "gpt-5.6-sol"].map((id) => [id, { id }])) }
const CURSOR = "composer-2.5" // in the Cursor Models pool
const OTHER = "claude-opus-5-5" // in Other Models

// magpie (input.magpie) with the user's option as it stands now
const magpieWith = (box) => ({ magpie: { option: (p, key) => (p === "cursor" && key === "included_only" ? box.on : undefined) } })

const reply = ({ period, hard, summary }) => async (url) => {
  url = String(url)
  if (url === PERIOD) return Response.json(period)
  if (url === HARD) return hard instanceof Response ? hard : Response.json(hard ?? {})
  if (url === SUMMARY) return Response.json(summary ?? {})
  if (url === BOT) return new Response("no", { status: 404 })
  return Response.json({})
}

async function read(hooks, replies) {
  globalThis.fetch = reply(replies)
  const a = fresh()
  return (await hooks.auth.usage(async () => a, provider)).windows
}
async function readWith(on, replies) {
  return read(await CursorAuthPlugin(magpieWith({ on })), replies)
}

// counts and stops are how magpie reads the windows
// (internal/provider/plugin_usage.go): a window not aside and used up stops
// each model it counts
function counts(w, model) {
  const m = model.toLowerCase()
  if (w.models?.length) return w.models.some((x) => x.toLowerCase() === m)
  if (w.notModels?.length) return !w.notModels.some((x) => x.toLowerCase() === m)
  return true
}
const stops = (windows, model) => windows.some((w) => !w.aside && w.used >= 100 && counts(w, model))
const byName = (windows) => Object.fromEntries(windows.map((w) => [w.name, w]))

const pools = (auto, api) => ({ billingCycleEnd: "1792833042000", planUsage: { autoPercentUsed: auto, apiPercentUsed: api, totalPercentUsed: Math.max(auto, api) } })
// a Team member's own on-demand limit, $500, $123.45 of it spent
const fixedOwn = { totalSpend: 52000, individualLimit: 50000, individualUsed: 12345, individualRemaining: 37655, limitType: "team", pooledLimit: "0" }
// a Team's org-wide pool (magpie #1868's shape), with room
const fixedPool = { totalSpend: 6334270, pooledLimit: "45120000", pooledUsed: 6334270, pooledRemaining: "38785730", individualUsed: 19855, limitType: "team" }
// a Team member with no limit of their own and no pool: unlimited
const unlimited = { individualUsed: 900, limitType: "team" }
const budgets = [
  ["a fixed on-demand limit of the member's", fixedOwn, {}],
  ["a fixed org-wide on-demand pool", fixedPool, { hardLimit: 451200 }],
  ["unlimited on-demand", unlimited, { hardLimit: 2000, perUserMonthlyLimitDollars: 0 }],
]

for (const [what, spendLimitUsage, hard] of budgets) {
  test(`Team, ${what}, included pools spent: off keeps the account in routing, on stops it`, async () => {
    const replies = { period: { ...pools(100, 100), spendLimitUsage }, hard }
    const off = await readWith(false, replies)
    expect(off.filter((w) => w.name === "Cursor Models" || w.name === "Other Models").every((w) => w.aside)).toBe(true)
    expect(stops(off, CURSOR)).toBe(false)
    expect(stops(off, OTHER)).toBe(false)

    const on = await readWith(true, replies)
    const w = byName(on)
    expect(w["Cursor Models"].aside).toBeUndefined()
    expect(w["Other Models"].aside).toBeUndefined()
    // On-demand and Total are still on the card, shown only
    expect(w["On-demand"]).toBeDefined()
    expect(w["On-demand"].aside).toBe(true)
    expect(w["Total"].aside).toBe(true)
    expect(stops(on, CURSOR)).toBe(true)
    expect(stops(on, OTHER)).toBe(true)
    // the card reads the same either way, only what routes differs
    const strip = (ws) => ws.map(({ aside, ...x }) => x)
    expect(strip(on)).toEqual(strip(off))
  })

  test(`Team, ${what}, included pools left: on or off, the account stays in routing`, async () => {
    const replies = { period: { ...pools(40, 70), spendLimitUsage }, hard }
    for (const on of [false, true]) {
      const ws = await readWith(on, replies)
      expect([on, stops(ws, CURSOR), stops(ws, OTHER)]).toEqual([on, false, false])
      expect(byName(ws)["On-demand"]).toBeDefined()
    }
  })

  test(`Team, ${what}, only Cursor Models spent: on stops Cursor's models, not the others`, async () => {
    const replies = { period: { ...pools(100, 30), spendLimitUsage }, hard }
    const on = await readWith(true, replies)
    expect(stops(on, CURSOR)).toBe(true)
    expect(stops(on, "auto")).toBe(true)
    expect(stops(on, OTHER)).toBe(false)
    const off = await readWith(false, replies)
    expect(stops(off, CURSOR)).toBe(false)
  })
}

test("a fixed on-demand budget spent with the pools: off and on both stop the account", async () => {
  const replies = { period: { ...pools(100, 100), spendLimitUsage: { ...fixedOwn, individualUsed: 50000, individualRemaining: 0 } }, hard: {} }
  for (const on of [false, true]) expect([on, stops(await readWith(on, replies), OTHER)]).toEqual([on, true])
})

test("no on-demand allowed: on changes nothing", async () => {
  const replies = { period: { ...pools(100, 100), spendLimitUsage: { individualLimit: 0, individualUsed: 0, limitType: "team" } }, hard: { hardLimit: 2000 } }
  expect(await readWith(true, replies)).toEqual(await readWith(false, replies))
})

test("the switch is read at each usage reading: a change needs no restart", async () => {
  const box = { on: false }
  const hooks = await CursorAuthPlugin(magpieWith(box))
  const replies = { period: { ...pools(100, 100), spendLimitUsage: fixedOwn }, hard: {} }
  expect(stops(await read(hooks, replies), OTHER)).toBe(false)
  box.on = true
  expect(stops(await read(hooks, replies), OTHER)).toBe(true)
  box.on = false
  expect(stops(await read(hooks, replies), OTHER)).toBe(false)
})

test("outside magpie, or a switch that can't be read, is off", async () => {
  const replies = { period: { ...pools(100, 100), spendLimitUsage: unlimited }, hard: { hardLimit: 2000 } }
  for (const input of [undefined, {}, { magpie: {} }, { magpie: { option: () => "true" } }, { magpie: { option: () => { throw new Error("gone") } } }]) {
    const ws = await read(await CursorAuthPlugin(input), replies)
    expect(stops(ws, OTHER)).toBe(false)
  }
})

const enterprise = (onDemand, used) => ({
  billingCycleEnd: "2026-11-01T00:00:00.000Z",
  membershipType: "enterprise",
  limitType: "team",
  individualUsage: { overall: { enabled: true, used, limit: 80000 } },
  teamUsage: { onDemand },
})

for (const [what, od] of [["unlimited", { enabled: true, used: 12345, limit: null }], ["a fixed budget with room", { enabled: true, used: 100, limit: 50000 }]]) {
  test(`Enterprise, ${what} on-demand: on makes the spent allowance stop the account`, async () => {
    const replies = { period: { spendLimitUsage: {} }, summary: enterprise(od, 80000) }
    expect(stops(await readWith(false, replies), OTHER)).toBe(false)
    const on = await readWith(true, replies)
    expect(byName(on)["Enterprise"].aside).toBeUndefined()
    expect(byName(on)["On-demand"].aside).toBe(true)
    expect(stops(on, OTHER)).toBe(true)
    // with room in the allowance, on stops nothing
    expect(stops(await readWith(true, { ...replies, summary: enterprise(od, 4000) }), OTHER)).toBe(false)
  })
}

test("the switch is declared for magpie's provider editor, off by default", async () => {
  const hooks = await CursorAuthPlugin()
  const o = hooks.auth.options.find((x) => x.key === "included_only")
  expect(o).toBeDefined()
  expect(o.default).toBeUndefined()
  expect(o.label).toBe("Included usage only")
  // magpie shows at most 60 and 300 characters (host.js optionsOf)
  expect(o.label.length).toBeLessThanOrEqual(60)
  expect(o.description.length).toBeLessThanOrEqual(300)
  expect(/^[a-z0-9_-]{1,40}$/.test(o.key)).toBe(true)
})
