// The usage card: the credits left, the M Plan's tier and end, and its
// windows read as magpie's own MiniMax plan reader (readMiniMaxPlan) reads
// them. Nothing is claimed: no check-in is made.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { MiniMaxCodeAuthPlugin, _internal } from "./index.mjs"
import { fakeMiniMax, json } from "./fake.mjs"

let f
afterEach(() => f?.close())

const h = 3600 * 1000

// readMiniMaxPlan's own test (magpie internal/provider/planquota_test.go)
test("plan windows are read as magpie's MiniMax plan reader reads them", () => {
  const ws = _internal.planWindows({
    model_remains: [
      { model_name: "general", start_time: 1790800000000, end_time: 1790800000000 + 5 * h, current_interval_remaining_percent: 72, current_interval_status: 1, current_interval_total_count: 0,
        weekly_start_time: 1790500000000, weekly_end_time: 1790500000000 + 168 * h, current_weekly_remaining_percent: 90, current_weekly_status: 1, current_weekly_total_count: 0 },
      { model_name: "video", start_time: 1790800000000, end_time: 1790800000000 + 24 * h, current_interval_remaining_percent: 40, current_interval_status: 2, current_interval_total_count: 3,
        current_weekly_status: 3, current_weekly_total_count: 0 },
      { model_name: "music", current_interval_remaining_percent: 100, current_interval_status: 3, current_interval_total_count: 0,
        current_weekly_remaining_percent: 100, current_weekly_status: 3, current_weekly_total_count: 0 },
    ],
    base_resp: { status_code: 0, status_msg: "success" },
  })
  expect(ws.length).toBe(3)
  expect(ws[0]).toEqual({ name: "5 hours", used: 28, span: 5 * 3600, resetsAt: new Date(1790800000000 + 5 * h).toISOString() })
  expect(ws[1]).toMatchObject({ name: "7 days", used: 10, span: 7 * 86400 })
  expect(ws[1].aside).toBeUndefined()
  expect(ws[2]).toMatchObject({ name: "Video · 24 hours", used: 100, aside: true })
  expect(() => _internal.planWindows({ base_resp: { status_code: 1004, status_msg: "login fail" } })).toThrow("login fail")
  expect(_internal.planWindows({ model_remains: [], base_resp: { status_code: 0 } })).toEqual([])
})

test("a membership is read from the answer or its data", () => {
  expect(_internal.membershipOf({ data: { has_token_plan: true, op_group_id: "g1", token_plan_tier: "Plus", token_plan_expires_at: 1800000000000, op_credit_summary: { total_remaining_amount: "1234.50" } } }))
    .toEqual({ hasTokenPlan: true, opGroupId: "g1", tier: "Plus", expiresAt: 1800000000000, balance: "1234.50" })
  expect(_internal.membershipOf({ opcredit_balance: 300 })).toEqual({ balance: "300" })
  expect(_internal.usageOf({ balance: "1234.50" })).toEqual({ plan: "Free", balance: "1234.5 credits", windows: [] })
  expect(_internal.usageOf({ hasTokenPlan: true, tier: "Plus", expiresAt: 1800000000000, balance: "0" }))
    .toEqual({ plan: "M Plan Plus", until: new Date(1800000000000).toISOString(), balance: "0 credits", windows: [] })
})

const auth = { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3600_000, accountId: "a@example.com" }

function account(f, { plan = false } = {}) {
  f.route("GET /v1/api/user/info", () => json({ statusInfo: { code: 0 }, data: { userInfo: { realUserID: "u-42", userEmail: "a@example.com" } } }))
  f.route("POST /matrix/api/v1/user/get_user_extra_info", () => json({ statusInfo: { code: 0 }, data: { workspaces: [
    { workspace_id: 9, workspace_type: 1 },
    { workspace_id: 7, workspace_type: 0, op_group_id: "grp-7", opcredit_balance: "50" },
  ] } }))
  f.route("POST /matrix/api/v1/commerce/get_membership_info", () => json({ statusInfo: { code: 0 }, data: plan
    ? { has_token_plan: true, token_plan_tier: "Plus", token_plan_expires_at: 1800000000000, op_credit_summary: { total_remaining_amount: "88.5" } }
    : { has_token_plan: false, op_credit_summary: { total_remaining_amount: "1200" } } }))
  f.route("GET /v1/api/openplatform/coding_plan/remains", () => json({ model_remains: [
    { model_name: "general", start_time: 1790800000000, end_time: 1790800000000 + 5 * h, current_interval_remaining_percent: 60, current_interval_status: 1,
      weekly_start_time: 1790500000000, weekly_end_time: 1790500000000 + 168 * h, current_weekly_remaining_percent: 75, current_weekly_status: 1 },
  ], base_resp: { status_code: 0 } }))
}

test("a free account shows its credits", async () => {
  f = fakeMiniMax()
  account(f)
  const hooks = await MiniMaxCodeAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => auth)
  expect(u).toEqual({ plan: "Free", balance: "1200 credits", windows: [], user: "a@example.com", signIn: "kept" })
  // its own workspace's membership was asked for, signed, with its user id
  const m = f.seen.find((r) => r.path === "/matrix/api/v1/commerce/get_membership_info")
  expect(m.json).toEqual({ workspace_id: 7 })
  expect(m.query.get("user_id")).toBe("u-42")
  expect(m.headers.get("x-signature")).toMatch(/^[0-9a-f]{32}$/)
  // no plan, no windows asked for; and nothing claimed
  expect(f.seen.some((r) => r.path.includes("coding_plan"))).toBe(false)
  expect(f.seen.some((r) => r.path.includes("signin"))).toBe(false)
})

test("an M Plan shows its tier, its end and its windows", async () => {
  f = fakeMiniMax()
  account(f, { plan: true })
  const hooks = await MiniMaxCodeAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => auth)
  expect(u.plan).toBe("M Plan Plus")
  expect(u.until).toBe(new Date(1800000000000).toISOString())
  expect(u.balance).toBe("88.5 credits")
  expect(u.windows.map((w) => [w.name, w.used])).toEqual([["5 hours", 40], ["7 days", 25]])
  const q = f.seen.find((r) => r.path === "/v1/api/openplatform/coding_plan/remains")
  expect(q.headers.get("x-group-id")).toBe("grp-7")
  expect(q.headers.get("authorization")).toBe("Bearer tok")
})

test("the account refused says so, the sign-in kept", async () => {
  f = fakeMiniMax()
  f.route("GET /v1/api/user/info", () => json({ statusInfo: { code: 1000048, message: "login expired" } }))
  const hooks = await MiniMaxCodeAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => auth)
  expect(u.error).toContain("refused")
  expect(u.signIn).toBe("kept")
  expect(await hooks.auth.usage(async () => undefined)).toEqual({ error: "not signed in" })
})

// #393: the credits' share, from the ledger MiniMax's own client reads in
// Settings → Usage → Credit details (积分明细): live batches only, amounts
// as the client reads them (strings, commas, a remaining below 0 is 0).
const day = 86400 * 1000
const batch = (type, granted, consumed, remaining, expires) =>
  ({ credit_type: type, granted_amount: granted, consumed_amount: consumed, remaining_amount: remaining, granted_at_ms: Date.now() - day, expire_at_ms: expires })

test("the credits ledger is a Credits window of the live batches", () => {
  const now = Date.now()
  const w = _internal.creditsWindow([
    batch(1, "1,000", "250", "750", now + 30 * day),
    batch(2, "500", "500", "-3", now + 2 * day), // spent past its end
    batch(2, "200", "0", "200", now + 5 * day),
    batch(2, "9999", "0", "9999", now - day), // expired: left out
    batch(3, "100", "0", "100", now + day), // a type the client doesn't show
  ], now)
  expect(w).toEqual({ name: "Credits", used: (100 * 750) / 1700, display: "750 / 1700", amount: 750, limit: 1700, unit: "credits",
    runsOutAt: new Date(now + 5 * day).toISOString(), runsOut: 200 })
  expect(_internal.creditsWindow([batch(2, "100", "0", "100", now - 1)], now)).toBeUndefined() // nothing live
  expect(_internal.creditsWindow([batch(1, "abc", "0", "1", now + day)], now)).toBeUndefined() // unreadable: unknown
})

function ledger(f, pages) {
  f.route("GET /minimax-cloud/api/v1/credit/details", (r) => {
    const n = Number(r.query.get("page_number"))
    return json({ statusInfo: { code: 0 }, details: pages[n - 1] ?? [], total_count: pages.flat().length })
  })
}

test("a free account's card shows how much of its credits is used", async () => {
  f = fakeMiniMax()
  account(f)
  const live = Date.now() + 30 * day
  ledger(f, [Array.from({ length: 20 }, () => batch(2, "50", "10", "40", live)), [batch(1, "1000", "0", "1000", live)]])
  const hooks = await MiniMaxCodeAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => auth)
  expect(u.balance).toBe("1200 credits")
  expect(u.windows).toEqual([{ name: "Credits", used: 10, display: "200 / 2000", amount: 200, limit: 2000, unit: "credits",
    runsOutAt: new Date(live).toISOString(), runsOut: 40 }])
  const asks = f.seen.filter((r) => r.path === "/minimax-cloud/api/v1/credit/details")
  expect(asks.map((r) => [r.method, r.query.get("page_number"), r.query.get("page_size"), r.query.get("include_expired"), r.query.get("user_id")]))
    .toEqual([["GET", "1", "20", "true", "u-42"], ["GET", "2", "20", "true", "u-42"]])
  expect(asks[0].headers.get("x-signature")).toMatch(/^[0-9a-f]{32}$/)
})

test("beside an M Plan the credits are aside; a ledger it can't read leaves the balance alone", async () => {
  f = fakeMiniMax()
  account(f, { plan: true })
  ledger(f, [[batch(1, "100", "25", "75", Date.now() + day)]])
  const hooks = await MiniMaxCodeAuthPlugin({ client: {} })
  let u = await hooks.auth.usage(async () => auth)
  expect(u.windows.map((w) => [w.name, w.used, !!w.aside])).toEqual([["5 hours", 40, false], ["7 days", 25, false], ["Credits", 25, true]])
  // a list cut short tells no share
  f.route("GET /minimax-cloud/api/v1/credit/details", (r) => json({ statusInfo: { code: 0 },
    details: r.query.get("page_number") === "1" ? [batch(1, "100", "0", "100", Date.now() + day)] : [], total_count: 5 }))
  u = await hooks.auth.usage(async () => auth)
  expect(u.windows.map((w) => w.name)).toEqual(["5 hours", "7 days"])
  expect(u.error).toBeUndefined()
  f.route("GET /minimax-cloud/api/v1/credit/details", () => new Response("no", { status: 500 }))
  u = await hooks.auth.usage(async () => auth)
  expect(u).toMatchObject({ plan: "M Plan Plus", balance: "88.5 credits" })
  expect(u.error).toBeUndefined()
})
