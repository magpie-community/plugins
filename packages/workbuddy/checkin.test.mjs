// The daily check-in through the billing meter, with WorkBuddy's own path
// and idempotent answer. Everything stays on a local fake.
import { test, expect, afterAll, beforeAll, afterEach } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

let WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin, _internal
beforeAll(async () => {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin, _internal } = await import("./index.mjs"))
})
const offline = async () => { throw new Error("no network in tests") }
const real = globalThis.fetch
globalThis.fetch = offline
afterAll(() => (globalThis.fetch = real))
afterEach(() => {
  globalThis.fetch = offline
  _internal.renewing.clear()
  _internal.renewed.clear()
})

const later = () => Date.now() + 3600_000
const ok = (data = {}) => new Response(JSON.stringify({ code: 0, msg: "ok", data }))
const business = (code, msg) => new Response(JSON.stringify({ code, msg }))
const checkinOf = async (plugin, auth, client = {}) => (await plugin({ client })).auth.checkin(async () => auth)

function serve(routes) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url))
    calls.push({ url: u, init, headers: new Headers(init?.headers) })
    const r = routes[u.pathname]
    return r ? r(init) : new Response("", { status: 404 })
  }
  return calls
}

test("China asks the activity status, then claims through /v2", async () => {
  const calls = serve({
    "/v2/billing/meter/checkin-activity-status": () => ok({ active: true, todayCheckedIn: false }),
    "/v2/billing/meter/daily-checkin": () => ok(),
  })
  const auth = { type: "oauth", access: "at", refresh: "r", expires: later(), uid: "u", domain: "" }
  expect(await checkinOf(WorkBuddyAuthPlugin, auth)).toEqual({ outcome: "claimed" })
  expect(calls.map((c) => c.url.pathname)).toEqual(["/v2/billing/meter/checkin-activity-status", "/v2/billing/meter/daily-checkin"])
  const c = calls[1]
  expect(c.init.method).toBe("POST")
  expect(c.init.body).toBe("{}")
  expect(c.headers.get("authorization")).toBe("Bearer at")
  expect(c.headers.get("x-user-id")).toBe("u")
  expect(c.headers.get("user-agent")).toBe("WorkBuddy/5.5.6")
})

test("the activity status already claimed is done without another claim", async () => {
  const calls = serve({ "/v2/billing/meter/checkin-activity-status": () => ok({ active: true, today_checked_in: true, daily_credit: 100 }) })
  const auth = { type: "oauth", access: "at", refresh: "r", expires: later(), uid: "u", domain: "" }
  expect(await checkinOf(WorkBuddyAuthPlugin, auth)).toEqual({ outcome: "done", credit: 100 })
  expect(calls).toHaveLength(1)
})

test("the status code for an already checked day is done", async () => {
  const calls = serve({ "/v2/billing/meter/checkin-activity-status": () => business(1001, "今天已签到，请明天再来") })
  const auth = { type: "oauth", access: "at", refresh: "r", expires: later(), uid: "u", domain: "" }
  expect(await checkinOf(WorkBuddyAuthPlugin, auth)).toEqual({ outcome: "done" })
  expect(calls).toHaveLength(1)
})

test("an inactive activity is inactive", async () => {
  const calls = serve({ "/v2/billing/meter/checkin-activity-status": () => ok({ active: false, todayCheckedIn: false }) })
  const auth = { type: "oauth", access: "at", refresh: "r", expires: later(), uid: "u", domain: "" }
  expect(await checkinOf(WorkBuddyAuthPlugin, auth)).toEqual({ outcome: "inactive" })
  expect(calls).toHaveLength(1)
})

test("WorkBuddy's already, ineligible and ended codes are distinct", async () => {
  const auth = { type: "oauth", access: "at", refresh: "r", expires: later(), uid: "u", domain: "" }
  for (const [code, expected] of [[1001, { outcome: "done" }], [1002, { outcome: "ineligible", message: "not eligible" }], [1003, { outcome: "inactive", message: "event over" }]]) {
    serve({
      "/v2/billing/meter/checkin-activity-status": () => ok({ active: true, todayCheckedIn: false }),
      "/v2/billing/meter/daily-checkin": () => business(code, code === 1001 ? "already" : code === 1002 ? "not eligible" : "event over"),
    })
    expect(await checkinOf(WorkBuddyAuthPlugin, auth)).toEqual(expected)
  }
})

test("a claim 401 while credits still read points to WorkBuddy's own app", async () => {
  const calls = serve({
    "/v2/billing/meter/checkin-activity-status": () => ok({ active: true, todayCheckedIn: false }),
    "/v2/billing/meter/daily-checkin": () => new Response("", { status: 401 }),
    "/billing/meter/get-user-resource-summary": () => ok({}),
  })
  const auth = { type: "oauth", access: "at", refresh: "r", expires: later(), uid: "u", domain: "" }
  expect(await checkinOf(WorkBuddyAuthPlugin, auth)).toEqual({ outcome: "ineligible", message: "WorkBuddy's check-in takes WorkBuddy's own app" })
  expect(calls).toHaveLength(3)
})

test("an unreadable reply is failed, never claimed", async () => {
  serve({
    "/v2/billing/meter/checkin-activity-status": () => ok({ active: true, todayCheckedIn: false }),
    "/v2/billing/meter/daily-checkin": () => new Response("<html>"),
  })
  const auth = { type: "oauth", access: "at", refresh: "r", expires: later(), uid: "u", domain: "" }
  const out = await checkinOf(WorkBuddyAuthPlugin, auth)
  expect(out.outcome).toBe("failed")
  expect(out.message).toContain("unreadable")
})

test("a transient billing failure retries twice, then reports failure", async () => {
  let calls = 0
  serve({
    "/v2/billing/meter/checkin-activity-status": () => ok({ active: true, todayCheckedIn: false }),
    "/v2/billing/meter/daily-checkin": () => { calls++; return business(10000, "API request failed with status code: 500") },
  })
  const auth = { type: "oauth", access: "at", refresh: "r", expires: later(), uid: "u", domain: "" }
  const out = await checkinOf(WorkBuddyAuthPlugin, auth)
  expect(out.outcome).toBe("failed")
  expect(calls).toBe(3)
}, 8000)

test("a token near its end is renewed before the claim", async () => {
  const sets = []
  const calls = serve({
    "/v2/plugin/auth/token/refresh": () => ok({ accessToken: "new", refreshToken: "r2", expiresIn: 3600 }),
    "/v2/billing/meter/checkin-activity-status": () => ok({ active: true, todayCheckedIn: false }),
    "/v2/billing/meter/daily-checkin": () => ok(),
  })
  const auth = { type: "oauth", access: "old", refresh: "r", expires: Date.now() + 60_000, uid: "u", domain: "" }
  expect(await checkinOf(WorkBuddyAuthPlugin, auth, { auth: { set: async (x) => sets.push(x) } })).toEqual({ outcome: "claimed" })
  expect(calls[0].url.pathname).toBe("/v2/plugin/auth/token/refresh")
  expect(calls[1].headers.get("authorization")).toBe("Bearer new")
  expect(sets).toHaveLength(1)
})

test("a day already in reports today's credit, the built-in's word for it", async () => {
  serve({ "/v2/billing/meter/checkin-activity-status": () => ok({ active: true, today_checked_in: true, today_credit: 30, daily_credit: 100 }) })
  const auth = { type: "oauth", access: "at", refresh: "r", expires: later(), uid: "u", domain: "" }
  expect(await checkinOf(WorkBuddyAuthPlugin, auth)).toEqual({ outcome: "done", credit: 30 })
})

test("the claim's credit, streak and message reach the card", async () => {
  serve({
    "/v2/billing/meter/checkin-activity-status": () => ok({ active: true, todayCheckedIn: false }),
    "/v2/billing/meter/daily-checkin": () => ok({ credit: 30, streak_days: 3, message: "签到成功，连续签到3天" }),
  })
  const auth = { type: "oauth", access: "at", refresh: "r", expires: later(), uid: "u", domain: "" }
  expect(await checkinOf(WorkBuddyAuthPlugin, auth)).toEqual({ outcome: "claimed", credit: 30, streak: 3, message: "签到成功，连续签到3天" })
})

test("an unclassified failure leaves the hook as a throw, not a failed answer", async () => {
  // magpie's wbCheckinFailed runs on a thrown error and keeps the offline
  // words for its 1-minute backoff; a returned failed waits 30 minutes
  globalThis.fetch = async () => { throw new Error("ECONNRESET: The socket connection was closed unexpectedly.") }
  const auth = { type: "oauth", access: "at", refresh: "r", expires: later(), uid: "u", domain: "" }
  expect(checkinOf(WorkBuddyAuthPlugin, auth)).rejects.toThrow("ECONNRESET")
})

test("WorkBuddy AI's plugin has no check-in", async () => {
  // the meter is China's; the AI build has no claim endpoint (#47)
  const hooks = await WorkBuddyAIAuthPlugin({ client: {} })
  expect(hooks.auth.checkin).toBeUndefined()
})
