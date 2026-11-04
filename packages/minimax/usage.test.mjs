// The usage card: the credits left, the M Plan's tier and end, and its
// windows read as magpie's own MiniMax plan reader (readMiniMaxPlan) reads
// them. Nothing is claimed: no check-in is made.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { MiniMaxCodeAuthPlugin, MiniMaxCodeGlobalAuthPlugin, _internal } from "./index.mjs"
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

// A user's report: the console said 总额度 150% · 已用 24% and the card only 83%.
// Shaped as that account's reply, with the times left out.
const consoleReply = { model_remains: [
  { model_name: "general", current_interval_status: 1, current_interval_total_count: -1, current_interval_used_count: -1, current_interval_used_percent: "1%", current_interval_total_percent: "100%",
    current_weekly_status: 1, current_weekly_total_count: -1, current_weekly_used_count: -1, current_weekly_used_percent: "24%", current_weekly_total_percent: "150%" },
  { model_name: "video", current_interval_status: 1, current_interval_total_count: 3, current_interval_used_count: 0, current_interval_used_percent: "0%", current_interval_total_percent: "100%",
    current_weekly_status: 1, current_weekly_total_count: 21, current_weekly_used_count: 1, current_weekly_used_percent: "5%", current_weekly_total_percent: "100%" },
], base_resp: { status_code: 0 } }

test("the console's reply says what was granted, whatever it is", () => {
  const ws = _internal.planWindows(consoleReply)
  expect(ws.map((w) => [w.name, w.used, w.amount, w.limit, w.unit])).toEqual([
    ["Allowance", 1, undefined, undefined, undefined],
    ["7 days", 16, 24, 150, "%"],
    ["Video · Allowance", 0, 0, 3, "videos"],
    ["Video · 7 days", 5, 1, 21, "videos"],
  ])
  const general = (fields) => _internal.planWindows({ model_remains: [{ model_name: "general", ...fields }], base_resp: { status_code: 0 } })
  // no list of offers: a total nobody has seen yet reads the same way
  expect(general({ current_interval_status: 1, current_interval_used_percent: "50%", current_interval_total_percent: "200%", current_weekly_status: 1, current_weekly_used_percent: "30%", current_weekly_total_percent: "300%" }).map((w) => [w.used, w.amount, w.limit]))
    .toEqual([[25, 50, 200], [10, 30, 300]])
  // a plain 100% total is a share alone; used up is 100 whatever the figures say
  expect(general({ current_weekly_status: 1, current_weekly_used_percent: "24%", current_weekly_total_percent: "100%" })[0].limit).toBeUndefined()
  expect(general({ current_weekly_status: 2, current_weekly_used_percent: "149%", current_weekly_total_percent: "150%" })[0]).toMatchObject({ used: 100, amount: 150, limit: 150 })
  // a week without a limit says so on the plan's own bucket
  expect(general({ current_interval_status: 1, current_interval_used_percent: "1%", current_interval_total_percent: "100%", current_weekly_status: 3, current_weekly_total_count: -1 }).at(-1))
    .toEqual({ name: "7 days", display: "Unlimited", aside: true })
})

test("coding_plan/remains alone multiplies its share by the boost", () => {
  const week = (boost) => _internal.planWindows({ model_remains: [{ model_name: "general", current_weekly_status: 1, current_weekly_remaining_percent: 83, ...boost }], base_resp: { status_code: 0 } })[0]
  expect(week({ weekly_boost_permille: 1500 })).toMatchObject({ used: 17, amount: 25.5, limit: 150, unit: "%" })
  for (const plain of [{}, { weekly_boost_permille: 1000 }, { weekly_boost_permille: 0 }]) {
    expect(week(plain).used).toBe(17)
    expect(week(plain).limit).toBeUndefined()
  }
})

test("the plan is named as the console names it, else by its tier's line", () => {
  expect(_internal.usageOf({ hasTokenPlan: true, title: "TokenPlanMax-年度会员", tier: "Max" }).plan).toBe("TokenPlanMax-年度会员")
  expect(_internal.usageOf({ hasTokenPlan: true, tier: "Max" }).plan).toBe("Token Plan Max")
  expect(_internal.usageOf({ hasTokenPlan: true, tier: "Explore" }).plan).toBe("M Plan Explore")
  expect(_internal.usageOf({ hasTokenPlan: true }).plan).toBe("M Plan")
})

test("a membership is read from the answer or its data", () => {
  expect(_internal.membershipOf({ data: { has_token_plan: true, op_group_id: "g1", token_plan_tier: "Plus", token_plan_expires_at: 1800000000000, op_credit_summary: { total_remaining_amount: "1234.50" } } }))
    .toEqual({ hasTokenPlan: true, opGroupId: "g1", tier: "Plus", expiresAt: 1800000000000, balance: "1234.50" })
  expect(_internal.membershipOf({ opcredit_balance: 300 })).toEqual({ balance: "300" })
  expect(_internal.usageOf({ balance: "1234.50" })).toEqual({ plan: "Free", balance: "1234.5 credits", windows: [] })
  expect(_internal.usageOf({ hasTokenPlan: true, tier: "Plus", expiresAt: 1800000000000, balance: "0" }))
    .toEqual({ plan: "Token Plan Plus", until: new Date(1800000000000).toISOString(), balance: "0 credits", windows: [] })
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

test("a plan reads the console's windows and title, and goes on without them", async () => {
  f = fakeMiniMax()
  account(f, { plan: true })
  f.route("GET /backend/account/token_plan/remains_percent", () => json(consoleReply))
  f.route("GET /v1/api/openplatform/charge/combo/cycle_audio_resource_package", () => json({ current_subscribe: { current_subscribe_title: "TokenPlanMax-年度会员" }, base_resp: { status_code: 0 } }))
  const hooks = await MiniMaxCodeAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => auth)
  expect(u.plan).toBe("TokenPlanMax-年度会员")
  expect(u.windows.find((w) => w.name === "7 days")).toMatchObject({ used: 16, amount: 24, limit: 150 })
  const asked = f.seen.find((r) => r.path === "/backend/account/token_plan/remains_percent")
  expect(asked.headers.get("authorization")).toBe("Bearer tok")
  expect(asked.headers.get("x-group-id")).toBe("grp-7")
  expect(f.seen.some((r) => r.path.includes("coding_plan"))).toBe(false)

  f.route("GET /backend/account/token_plan/remains_percent", () => new Response("nope", { status: 500 }))
  f.route("GET /v1/api/openplatform/charge/combo/cycle_audio_resource_package", () => json({ base_resp: { status_code: 1033 } }))
  const off = await hooks.auth.usage(async () => auth)
  expect(off.plan).toBe("Token Plan Plus")
  expect(off.windows.find((w) => w.name === "7 days").used).toBe(25)
})

// A stall is what the fallback is for, and magpie allows usage 20 seconds. Asked
// one after another these two would take 10 here.
test("the console's endpoints not answering leave the coding_plan/remains windows in time", async () => {
  f = fakeMiniMax()
  account(f, { plan: true })
  f.route("GET /backend/account/token_plan/remains_percent", () => new Promise(() => {}))
  f.route("GET /v1/api/openplatform/charge/combo/cycle_audio_resource_package", () => new Promise(() => {}))
  const hooks = await MiniMaxCodeAuthPlugin({ client: {} })
  const start = Date.now()
  const u = await hooks.auth.usage(async () => auth)
  expect(Date.now() - start).toBeLessThan(8000)
  expect(u.error).toBeUndefined()
  expect(u.plan).toBe("Token Plan Plus")
  expect(u.windows.map((w) => [w.name, w.used])).toEqual([["5 hours", 40], ["7 days", 25]])
}, 15000)

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
  expect(u.plan).toBe("Token Plan Plus")
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
  expect(u).toMatchObject({ plan: "Token Plan Plus", balance: "88.5 credits" })
  expect(u.error).toBeUndefined()
})

// #666's side note: on the international site both membership endpoints
// answer 404 "404 page not found", even through a proxy. That is no plan
// read, not a Free one, and the card goes on with the credits ledger.
test("a site without the membership API shows its credits and no plan", async () => {
  f = fakeMiniMax()
  const notFound = () => new Response("404 page not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } })
  f.route("GET /v1/api/user/info", () => json({ statusInfo: { code: 0 }, data: { userInfo: { realUserID: "u-42", userEmail: "a@example.com" } } }))
  f.route("POST /matrix/api/v1/user/get_user_extra_info", notFound)
  f.route("POST /matrix/api/v1/commerce/get_membership_info", notFound)
  const live = Date.now() + 30 * day
  ledger(f, [[batch(2, "500", "100", "400", live)]])
  const hooks = await MiniMaxCodeGlobalAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => auth)
  expect(u.error).toBeUndefined()
  expect(u.plan).toBeUndefined()
  expect(u.user).toBe("a@example.com")
  expect(u.windows.map((w) => [w.name, w.display])).toEqual([["Credits", "100 / 500"]])
  // one of them failing another way is still an error
  f.route("POST /matrix/api/v1/commerce/get_membership_info", () => new Response("no", { status: 500 }))
  expect((await hooks.auth.usage(async () => auth)).error).toBe("membership: HTTP 500")
})
