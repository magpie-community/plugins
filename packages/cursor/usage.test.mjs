// auth.usage tells what magpie's built-in Cursor account shows
// (internal/provider/cursor_usage.go), against Cursor's replies as its tests
// give them (cursor_usage_test.go).
import "./nonet.mjs" // first: no request leaves this machine
import { afterEach, expect, test } from "bun:test"
import { CursorAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

// a token that runs out in an hour
const jwt = (exp) => ["e30", Buffer.from(JSON.stringify({ exp })).toString("base64url"), "sig"].join(".")
const tok = jwt(Math.floor(Date.now() / 1000) + 3600)
const auth = { type: "oauth", access: tok, refresh: "", expires: 0, accountId: "a@b.c" }
// a sign-in of its own, so no plan asked before is remembered for it
let n = 0
const fresh = () => ({ ...auth, access: jwt(Math.floor(Date.now() / 1000) + 7200 + ++n) })

const firstParty = ["grok-4.7@256k", "grok-4.7@500k", "grok-4.6", "grok-4.7-xhigh-fast", "cursor-grok-4.7-high-fast", "cursor-grok-4.6-high-fast", "grok-4.5-fast-high", "auto", "default", "composer-2.5", "COMPOSER-2.5-FAST", "composer"]
const bucketed = ["future-first-party", "grok-4.8-high", "cursor-grok-4.8-xhigh-fast"]
const others = ["claude-opus-5-5@300k", "claude-opus-5-5@1m", "claude-opus-5-5", "gpt-5.6-sol", "gemini-3.1-pro", "grok-3", "grok-4.70", "grok-4.80-high", "unknown-model"]
const provider = { models: Object.fromEntries([...firstParty, ...bucketed, ...others].map((id) => [id, { id }])) }

async function run(a, reply) {
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), method: init.method, headers: init.headers, body: init.body })
    return reply(String(url))
  }
  const hooks = await CursorAuthPlugin()
  return { u: await hooks.auth.usage(async () => a, provider), seen }
}

// counts is whether a window counts model, as magpie reads the lists
// (internal/provider/plugin_usage.go)
function counts(w, model) {
  const m = model.toLowerCase()
  if (w.models?.length) return w.models.some((x) => x.toLowerCase() === m)
  if (w.notModels?.length) return !w.notModels.some((x) => x.toLowerCase() === m)
  return true
}

const PERIOD = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage"
const PLAN = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo"

test("the period's three windows, reset at the cycle's end", async () => {
  const { u, seen } = await run(auth, (url) =>
    url === PLAN
      ? Response.json({ planInfo: { planName: "Pro" } })
      : Response.json({ billingCycleEnd: "1792833042000", planUsage: { autoPercentUsed: 12.5, apiPercentUsed: 40, totalPercentUsed: 20 } }),
  )
  expect(seen.find((r) => r.url === PERIOD)).toEqual({
    url: PERIOD,
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
    body: "{}",
  })
  const at = new Date(1792833042000).toISOString()
  expect(u.windows.map(({ models, notModels, ...w }) => w)).toEqual([
    { name: "Cursor Models", used: 12.5, resetsAt: at },
    { name: "Other Models", used: 40, resetsAt: at },
    { name: "Total", used: 20, resetsAt: at, aside: true },
  ])
  expect(u.error).toBeUndefined()
})

test("the card names the plan as cursor-agent about does (GetPlanInfo's planName), asked once an hour", async () => {
  const a = fresh()
  const reply = (url) =>
    url === PLAN ? Response.json({ planInfo: { planName: "Pro+" } }) : Response.json({ planUsage: { autoPercentUsed: 1, apiPercentUsed: 2, totalPercentUsed: 3 } })
  const first = await run(a, reply)
  expect(first.u.plan).toBe("Pro+")
  const plan = first.seen.find((r) => r.url === PLAN)
  expect(plan.method).toBe("POST")
  expect(plan.headers.Authorization).toBe(`Bearer ${a.access}`)
  const again = await run(a, reply)
  expect(again.u.plan).toBe("Pro+")
  expect(again.seen.map((r) => r.url)).toEqual([PERIOD])
})

test("a plan Cursor doesn't say leaves the card's plan out", async () => {
  const a = fresh()
  const { u } = await run(a, (url) => (url === PLAN ? new Response("no", { status: 500 }) : Response.json({ planUsage: { autoPercentUsed: 1 } })))
  expect(u.plan).toBeUndefined()
  expect(u.windows.length).toBe(3)
})

for (const bucket of [["default", "composer-2.5", "cursor-grok-4.5-high", "future-first-party", "Grok-4.8"], undefined]) {
  test(`each model counts in the pool magpie puts it in (autoBucketModels ${bucket ? "given" : "left out"})`, async () => {
    const { u } = await run(auth, () =>
      Response.json({ billingCycleEnd: "1792833042000", planUsage: { autoPercentUsed: 25, apiPercentUsed: 100, totalPercentUsed: 100 }, autoBucketModels: bucket }),
    )
    const [cursor, other, total] = u.windows
    const pool = bucket ? [...firstParty, ...bucketed] : firstParty
    const rest = bucket ? others : [...others, ...bucketed]
    for (const m of pool) expect([m, counts(cursor, m), counts(other, m)]).toEqual([m, true, false])
    for (const m of rest) expect([m, counts(cursor, m), counts(other, m)]).toEqual([m, false, true])
    expect(total.models).toBeUndefined()
    expect(total.notModels).toBeUndefined()
  })
}

test("an enterprise plan's spend is no window", async () => {
  expect((await run(fresh(), () => Response.json({ spendLimitUsage: {} }))).u).toEqual({ windows: [], signIn: "kept" })
})

test("a refused token is the status magpie says", async () => {
  expect((await run(fresh(), () => new Response("no", { status: 401 }))).u).toEqual({ error: "Unauthorized", windows: [], signIn: "kept" })
})

test("a run-out sign-in says so, and asks nothing", async () => {
  const { u, seen } = await run({ ...auth, access: jwt(1) }, () => Response.json({}))
  expect(u).toEqual({ error: "Cursor's sign-in has run out; sign in to Cursor again", windows: [], signIn: "kept" })
  expect(seen).toEqual([])
})

// the built-in's 401 for any "expired", a token's or a trial's, which marked
// no account (errorResponse says kept)
test("anything expired is the built-in's 401", () => {
  const { failure } = _internal
  const says = (msg) => failure(400, JSON.stringify({ code: "failed_precondition", message: msg }))
  for (const m of ["Your access token has expired", "Session expired, please log in again", "Your free trial has expired", "This link has expired"])
    expect(says(m)).toEqual({ status: 401, message: m + " — sign in to Cursor again in magpie" })
})

// The built-in's usage read neither marked nor cleared the account, so each
// read says kept, a clean one too.
test("a usage read keeps the account, clean or not", async () => {
  const PERIOD_OK = () => Response.json({ billingCycleEnd: "1792833042000", planUsage: { autoPercentUsed: 1, apiPercentUsed: 2, totalPercentUsed: 3 } })
  expect((await run(fresh(), PERIOD_OK)).u.signIn).toBe("kept")
  expect((await run(fresh(), () => new Response("no", { status: 401 }))).u.signIn).toBe("kept")
  expect((await run({ ...auth, access: jwt(1) }, PERIOD_OK)).u.signIn).toBe("kept")
})

// the gateway names the provider before a plugin's error
test("an error doesn't name Cursor again", () => {
  const f = _internal.failure(429, JSON.stringify({ code: "resource_exhausted", message: "slow down" }))
  expect(f).toEqual({ status: 429, message: "usage limit reached: slow down" })
})

test("a model list Cursor couldn't give fails, not shrinks to the configured few", async () => {
  globalThis.fetch = async () => new Response("down", { status: 503 })
  const hooks = await CursorAuthPlugin()
  const configured = { models: { auto: { id: "auto" } } }
  await expect(hooks.provider.models(configured, { auth: fresh() })).rejects.toThrow()
})
