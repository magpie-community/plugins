// The usage card: the credits left and what was granted of them, the M
// Plan's tier and end, and its windows read as magpie's own MiniMax plan
// reader (readMiniMaxPlan) reads them. Nothing is claimed: no check-in is
// made.
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

function account(f, { plan = false, ledger } = {}) {
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
  // the credit ledger, when the test gives one: a reply, or a page by its
  // page_number
  if (ledger) f.route("GET /minimax-cloud/api/v1/credit/details", (r) => json(typeof ledger === "function" ? ledger(r.query.get("page_number")) : ledger))
}

// a lot of the credit ledger as MiniMax Code's settings page reads one: a
// free grant of 500, 300 left of it, its end comfortably ahead so the card
// counts it whenever the test runs
const DAY = 86400_000
const END = 1790000000000 + 30 * DAY
const LOT = (over = {}) => ({ credit_type: 2, granted_amount: "500", remaining_amount: "300", consumed_amount: "200",
  granted_at_ms: 1790000000000, expire_at_ms: Date.now() + 30 * DAY, ...over })

test("a lot is read as MiniMax Code's own reader reads it", () => {
  expect(_internal.lotOf(LOT({ expire_at_ms: END }))).toEqual({ granted: 500, left: 300, used: 200, at: 1790000000000, end: END })
  // amounts may come with separators; a negative remaining is already spent
  expect(_internal.lotOf(LOT({ credit_type: 1, granted_amount: "2,000.50", remaining_amount: "-7", expire_at_ms: END })))
    .toEqual({ granted: 2000.5, left: 0, used: 200, at: 1790000000000, end: END })
  expect(_internal.lotOf(LOT({ remaining_amount: "-x", expire_at_ms: END }))).toBeUndefined()
  // only purchased and free grants count, and only whole ones
  expect(_internal.lotOf(LOT({ credit_type: 0 }))).toBeUndefined()
  expect(_internal.lotOf(LOT({ credit_type: "2", expire_at_ms: END }))).toEqual(_internal.lotOf(LOT({ expire_at_ms: END })))
  expect(_internal.lotOf(LOT({ expire_at_ms: undefined }))).toBeUndefined()
  expect(_internal.lotOf(LOT({ consumed_amount: "lots" }))).toBeUndefined()
  expect(_internal.lotOf(null)).toBeUndefined()
  // a page is its lots and their count, as the client validates them
  expect(_internal.lotsOf({ details: [LOT({ expire_at_ms: END })], total_count: 5 }))
    .toEqual({ lots: [{ granted: 500, left: 300, used: 200, at: 1790000000000, end: END }], total: 5 })
  expect(_internal.lotsOf({ data: { details: [LOT({ expire_at_ms: END })], total_count: 5 } }).total).toBe(5)
  expect(() => _internal.lotsOf({ details: [] })).toThrow("credits: no ledger in the reply")
})

test("the credits window says used of the granted total, WorkBuddy's card's shape", () => {
  const now = 1791000000000
  const live = (over = {}) => _internal.lotOf(LOT({ expire_at_ms: now + DAY, ...over }))
  expect(_internal.creditsWindow([live({ granted_amount: "1,000", remaining_amount: "250" }), live({ granted_amount: 500, remaining_amount: "500" })], now))
    .toEqual({ name: "Credits", used: (100 * 750) / 1500, display: "750 / 1500", amount: 750, limit: 1500, unit: "credits" })
  // a lot that ended doesn't count: its credits are gone, not spent
  expect(_internal.creditsWindow([live({ expire_at_ms: now - 1 })], now)).toBeUndefined()
  expect(_internal.creditsWindow([], now)).toBeUndefined()
  expect(_internal.creditsWindow([live({ granted_amount: "2250", remaining_amount: "2232.4" })], now).display).toBe("17.6 / 2250")
})

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

// the card's credits window, from the credit ledger MiniMax Code's settings
// page reads (Settings → Usage → Credit Details): what the account's lots
// granted against what is left of them
test("the credits left and the granted total are the card's, from the ledger", async () => {
  f = fakeMiniMax()
  account(f, { ledger: { details: [LOT(), LOT({ credit_type: 1, granted_amount: "2,000.50", remaining_amount: "1500.25", consumed_amount: "500.25" })], total_count: 2 } })
  const hooks = await MiniMaxCodeAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => auth)
  expect(u.plan).toBe("Free")
  expect(u.balance).toBe("1200 credits") // the summary's left, still said
  expect(u.windows).toEqual([{ name: "Credits", used: (100 * 700.25) / 2500.5, display: "700.25 / 2500.5", amount: 700.25, limit: 2500.5, unit: "credits" }])
  // asked as MiniMax Code asks it: the first page, a hundred lots at most,
  // the expired ones in (left out here by their own end), signed, as the account
  const r = f.seen.find((x) => x.path === "/minimax-cloud/api/v1/credit/details")
  expect(r.method).toBe("GET")
  expect(r.query.get("page_number")).toBe("1")
  expect(r.query.get("page_size")).toBe("100")
  expect(r.query.get("include_expired")).toBe("true")
  expect(r.query.get("user_id")).toBe("u-42")
  expect(r.headers.get("x-signature")).toMatch(/^[0-9a-f]{32}$/)
})

test("an M Plan's card leads with the credits window", async () => {
  f = fakeMiniMax()
  account(f, { plan: true, ledger: { details: [LOT()], total_count: 1 } })
  const hooks = await MiniMaxCodeAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => auth)
  expect(u.windows.map((w) => w.name)).toEqual(["Credits", "5 hours", "7 days"])
})

// the page is a hundred lots: a ledger longer than that is paged until its
// own total_count, as the settings page scrolls it
test("a ledger longer than a page is paged to its end", async () => {
  f = fakeMiniMax()
  const mk = (i) => LOT({ granted_at_ms: 1790000000000 + i, granted_amount: "1", remaining_amount: "1", consumed_amount: "0" })
  account(f, { ledger: (page) => ({ details: Array.from({ length: page === "1" ? 100 : 50 }, (_, i) => mk((Number(page) - 1) * 100 + i)), total_count: 150 }) })
  const hooks = await MiniMaxCodeAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => auth)
  expect(u.windows[0]).toEqual({ name: "Credits", used: 0, display: "0 / 150", amount: 0, limit: 150, unit: "credits" })
  expect(f.seen.filter((r) => r.path === "/minimax-cloud/api/v1/credit/details").map((r) => r.query.get("page_number"))).toEqual(["1", "2"])
})

test("a ledger that can't be read leaves the card as it was", async () => {
  f = fakeMiniMax()
  account(f)
  f.route("GET /minimax-cloud/api/v1/credit/details", () => new Response("busy", { status: 503 }))
  const hooks = await MiniMaxCodeAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => auth)
  expect(u).toEqual({ plan: "Free", balance: "1200 credits", windows: [], user: "a@example.com", signIn: "kept" })
  expect(u.error).toBeUndefined()
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
