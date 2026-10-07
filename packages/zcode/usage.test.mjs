// auth.usage tells what magpie's built-in ZCode usage told for the same
// answers (internal/provider/zcode_test.go TestZCodeAccounts,
// zcode_start_test.go TestZCodeStartPlanOwnAccount, zcode_team_test.go).
import { test, expect, afterAll, beforeAll, beforeEach } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

let ZCodeAuthPlugin, _internal
beforeAll(async () => {
  // Bun reads HOME once, at start: run as HOME=$(mktemp -d) bun test, so
  // no real sign-in is ever read
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ ZCodeAuthPlugin, _internal } = await import("./index.mjs"))
})
// nothing leaves the machine; the fetch this file found is put back when
// it is done, so the next test file (bun runs them all in one process)
// doesn't inherit offline or a fake of this file's
const offline = async () => { throw new Error("no network in tests") }
const real = globalThis.fetch
afterAll(() => (globalThis.fetch = real))
beforeEach(() => {
  globalThis.fetch = offline
  _internal.routes.clear()
  _internal.teamKeys.clear()
})

const ok = (data) => new Response(JSON.stringify({ code: 0, data }))
function serve(route) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    const c = { url: u, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body }
    calls.push(c)
    return (await route(c)) ?? new Response("", { status: 404 })
  }
  return calls
}
const oauth = (state) => ({ type: "oauth", access: state.key ?? state.jwt ?? "", refresh: JSON.stringify(state), expires: 0 })
async function usage(auth, sets = []) {
  const hooks = await ZCodeAuthPlugin({ client: { auth: { set: async (x) => sets.push(x) } } })
  return hooks.auth.usage(async () => auth, { id: "zcode" })
}
const jwt = (exp) => ["{}", JSON.stringify({ exp })].map((s) => Buffer.from(s).toString("base64url")).join(".") + ".sig"

test("a Coding Plan's five hours and week", async () => {
  const reset = Date.now() + 3600_000
  const calls = serve(({ url, headers }) => {
    if (headers.Authorization !== "two.secret2") return new Response("", { status: 401 })
    if (url.pathname === "/api/biz/subscription/list") return ok([{ productName: "GLM Coding Pro", status: "VALID" }])
    if (url.pathname === "/api/monitor/usage/quota/limit")
      return ok({ level: "pro", limits: [
        { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 2000, remaining: 1500, percentage: 25, nextResetTime: reset },
        { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 10000, remaining: 9000, percentage: 10, nextResetTime: reset },
      ] })
  })
  expect(await usage(oauth({ site: "zai", key: "two.secret2" }))).toEqual({
    signIn: "kept",
    plan: "GLM Coding Pro",
    windows: [
      { name: "5 hours", used: 25, display: "500 / 2000", amount: 500, limit: 2000, resetsAt: new Date(reset).toISOString(), span: 5 * 3600 },
      { name: "Weekly", used: 10, display: "1000 / 10000", amount: 1000, limit: 10000, resetsAt: new Date(reset).toISOString(), span: 7 * 86400 },
    ],
  })
  expect(calls.every((c) => c.url.origin === "https://api.z.ai")).toBe(true)
  // an API key, BigModel's, is asked on its own site
  const bm = serve(({ url }) => (url.pathname.endsWith("/limit") ? ok({ limits: [] }) : ok([])))
  expect(await usage({ type: "api", key: "k", metadata: { site: "bigmodel" } })).toEqual({ signIn: "kept", windows: [] })
  expect(bm[0].url.origin).toBe("https://open.bigmodel.cn")
})

test("windows, names and terms as Go reads them", () => {
  const ws = _internal.limitWindows({ limits: [
    { unit: 3, usage: 1000, currentValue: 420, percentage: 42 }, // the percentage stands
    { unit: 6, usage: 800, currentValue: 200 }, // none: from the current value
    { unit: 1, number: 30, percentage: 7.5 },
    { unit: 4, number: 3 },
    { unit: 5, number: 1, usage: 0, remaining: 5 },
    { unit: 0 },
  ] })
  expect(ws).toEqual([
    { name: "5 hours", used: 42, display: "420 / 1000", amount: 420, limit: 1000, span: 18000 },
    { name: "Weekly", used: 25, display: "200 / 800", amount: 200, limit: 800, span: 604800 },
    { name: "0 hours", used: 7.5, span: 1800 },
    { name: "3 days", used: 0, span: 3 * 86400 },
    { name: "Monthly", used: 0, aside: true, span: 30 * 86400 }, // a whole of 0: no cap
    { name: "Credits", used: 0 },
  ])
  // Beijing times: the next renewal, auto or not; else the valid span's end
  expect(_internal.termOf([{ status: "EXPIRED", nextRenewTime: "2026-01-01 00:00:00" },
    { status: "VALID", autoRenew: 1, nextRenewTime: "2026-10-18 12:00:00" }]))
    .toEqual({ until: "2026-10-18T04:00:00.000Z", renew: "auto" })
  expect(_internal.termOf([{ status: "valid", autoRenew: false, valid: "2026-09-18 12:00:00-2026-10-18 12:00:00" }]))
    .toEqual({ until: "2026-10-18T04:00:00.000Z", renew: "off" })
  expect(_internal.termOf([{ status: "VALID", autoRenew: true, valid: "2026-09-18-2026-10-18" }])).toEqual({})
  expect(_internal.termOf([{ status: "VALID", valid: "2026-09-18 - 2026-10-18" }])).toEqual({ until: "2026-10-17T16:00:00.000Z", renew: "off" })
})

// #659: a window counted in amounts says the count as used or as left, as
// its share is said (magpie's QuotaWindow.Count, quotaCount in the GUI);
// amount is what is used of limit. A window that told only the vendor's
// used-first text froze that count beside a "% left" figure — ZCode's gift
// card read "28395087 / 100000000 · 71.6% left".
test("a counted window carries what is used of the whole", async () => {
  serve(({ url }) => {
    if (url.pathname === "/api/biz/subscription/list") return ok([{ productName: "GLM Coding Pro", status: "VALID" }])
    if (url.pathname === "/api/monitor/usage/quota/limit")
      return ok({ level: "pro", limits: [
        { type: "TOKENS_LIMIT", unit: 3, number: 5, usage: 2000, remaining: 1500, percentage: 25, nextResetTime: Date.now() + 3600_000 },
      ] })
  })
  const w = (await usage(oauth({ site: "zai", key: "two.secret2" }))).windows[0]
  // 500 of 2000 used: magpie says "500 / 2,000" used, "1,500 / 2,000" left
  expect([w.used, w.amount, w.limit]).toEqual([25, 500, 2000])
})

// Go's TestZCodeNoMonthlyCap (#366): the month's MCP tool calls are named
// and set aside as the built-in's are, so an older plan's uncapped month,
// told as 100% used, never reads as the account run out
test("the month's MCP calls: named and set aside, an uncapped month nothing used", () => {
  const reset = Date.now() + 3 * 3600_000
  const month = Date.now() + 20 * 86400_000
  expect(_internal.limitWindows({ level: "pro", limits: [
    { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 0, nextResetTime: reset },
    { type: "TIME_LIMIT", unit: 5, number: 1, usage: 0, currentValue: 0, remaining: 0, percentage: 100, nextResetTime: month },
  ] })).toEqual([
    { name: "5 hours", used: 0, resetsAt: new Date(reset).toISOString(), span: 5 * 3600 },
    { name: "MCP · Month", used: 0, aside: true, resetsAt: new Date(month).toISOString(), span: 30 * 86400 },
  ])
  // capped and used up: still shown as used, still aside
  const ws = _internal.limitWindows({ limits: [
    { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 10, nextResetTime: reset },
    { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 30, nextResetTime: month },
    { type: "TIME_LIMIT", unit: 5, number: 1, usage: 100, currentValue: 100, remaining: 0, percentage: 100, nextResetTime: month },
  ] })
  expect(ws.map((w) => [w.name, w.used, !!w.aside, w.display])).toEqual([
    ["5 hours", 10, false, undefined],
    ["Weekly", 30, false, undefined],
    ["MCP · Month", 100, true, "100 / 100"],
  ])
})

// a Start Plan with one bucket, GLM-5.1's tokens for the day, a quarter used
function startBalance(now, status) {
  return { server_time: now, plans: [{ plan_id: "zai-start-plan", user_plan_id: "up1", name: "Start Plan", status, ends_at: now + 7 * 86400,
    entitlements: [{ entitlement_id: "e1", period: "daily" }] }],
    balances: [{ plan_id: "zai-start-plan", user_plan_id: "up1", entitlement_id: "e1", show_name: "GLM-5.1", capabilities: ["model:GLM-5.1"],
      total_units: "1000000", used_units: 250000, remaining_units: 750000, expires_at: now + 3600 }] }
}

test("ZCode's Start Plan: its buckets, each for its models", async () => {
  const now = Math.trunc(Date.now() / 1000)
  const token = jwt(now + 86400)
  let balance = startBalance(now, "active")
  const calls = serve(({ url, headers }) => {
    if (url.pathname !== "/api/v1/zcode-plan/billing/balance") return
    if (!headers["X-Device-Mid"]) return new Response(JSON.stringify({ code: 3001, msg: "parameter error" }), { status: 400 })
    if (headers.Authorization !== "Bearer " + token || !url.searchParams.get("app_version")) return new Response("", { status: 401 })
    return ok(balance)
  })
  const auth = oauth({ site: "bigmodel", jwt: token, device: "11111111-2222-4333-8444-555555555555" })
  expect(await usage(auth)).toEqual({
    signIn: "kept",
    plan: "Start Plan", until: new Date((now + 7 * 86400) * 1000).toISOString(), renew: "off",
    windows: [{ name: "GLM-5.1", used: 25, display: "250000 / 1000000", amount: 250000, limit: 1000000, resetsAt: new Date((now + 3600) * 1000).toISOString(), span: 86400,
      models: ["GLM-5.1", "GLM-5.1-Trial"] }],
  })
  expect(calls[0].url.origin).toBe("https://zcode.z.ai")
  expect(calls[0].headers["X-Device-Mid"]).toBe("11111111-2222-4333-8444-555555555555")

  const over = { signIn: "kept", error: "this account has no GLM Coding Plan, and ZCode's Start Plan has ended or was never started" }
  balance = startBalance(now, "expired")
  expect(await usage(auth)).toEqual(over)
  // still "active" past its end is over too, as ZCode reads it
  balance = { ...startBalance(now, "active"), server_time: now + 8 * 86400 }
  expect(await usage(auth)).toEqual(over)
  // a bucket counted by what remains, spanned by its period
  balance = startBalance(now, "active")
  balance.balances = [{ plan_id: "zai-start-plan", capabilities: [" model: GLM-5-Turbo ", "model:"], total_units: 200, remaining_units: "150",
    period_start: now, period_end: now + 7 * 86400 }]
  expect((await usage(auth)).windows).toEqual([{ name: "GLM-5-Turbo", used: 25, display: "50 / 200", amount: 50, limit: 200, span: 7 * 86400, models: ["GLM-5-Turbo", "GLM-5-Turbo-Trial"] }])

  // its token run out
  expect(await usage(oauth({ site: "zai", jwt: jwt(now - 60) }))).toEqual({ signIn: "kept", error: "ZCode's sign-in has expired; sign in to ZCode again (or add the account again in magpie)" })
})

test("a team seat: the team plan's windows, name, end and resets, its key found and saved", async () => {
  const reset = Date.now() + 2 * 3600_000
  let made = null
  const TOKEN = "Bearer team-token"
  serve(({ url, method, headers, body }) => {
    const p = url.pathname, org = headers["Bigmodel-Organization"], proj = headers["Bigmodel-Project"]
    if (url.origin !== "https://bigmodel.cn") return
    if (p === "/api/biz/team/subscribe/product/querySubscribeDetail" && headers.Authorization === TOKEN && org === "t1" && proj === "tp1")
      return ok({ hasSubscription: true, status: "EFFECTIVE", memberGrantStatus: "VALID", productId: "prod-1", productName: "GLM Coding Team Pro",
        subscribeEndTime: "2026-12-31 23:59:59" })
    if (p === "/api/biz/v1/organization/t1/projects/tp1/api_keys" && headers.Authorization === TOKEN && org === "t1" && proj === "tp1") {
      if (method === "POST") {
        made = JSON.parse(body)
        return ok({ name: "zcode-team-api-key", apiKey: "tk", keyType: 2 })
      }
      return ok([{ name: "zcode-team-api-key", apiKey: "wrong-type", keyType: 1 }, ...(made ? [{ name: "zcode-team-api-key", apiKey: "tk", keyType: 2 }] : [])])
    }
    if (p === "/api/biz/v1/organization/t1/projects/tp1/api_keys/copy/tk") return ok({ secretKey: "ts" })
    if (p === "/api/biz/customer-package-reset/list" && headers.Authorization === TOKEN && org === "t1" && proj === "tp1" && url.searchParams.get("targetType") === "TEAM")
      return ok({
        fiveHourResets: [{ available: true, expireTime: "2026-11-30 23:59:59" }, { available: true, expireTime: 1790000000 }, { available: false, expireTime: 1 }],
        weekResets: [{ available: true, expireTime: "2026-12-31 23:59:59" }],
      })
    if (p === "/api/monitor/usage/quota/limit") {
      if (headers.Authorization !== "tk.ts" || url.searchParams.get("type") !== "2" || headers["Set-Language"] !== "zh") return ok({ limits: [] })
      return ok({ limits: [
        { type: "CREDIT_LIMIT", unit: 3, percentage: 42, currentValue: 420, usage: 1000, nextResetTime: reset },
        { type: "CREDIT_LIMIT", unit: 6, percentage: 10, currentValue: 1000, usage: 10000, nextResetTime: reset + 86400000 },
      ] })
    }
  })
  const sets = []
  const state = { site: "bigmodel", base: "https://open.bigmodel.cn/api/anthropic", token: TOKEN, org: "t1", project: "tp1", plan: "GLM Coding Team Pro" }
  expect(await usage(oauth(state), sets)).toEqual({
    signIn: "kept",
    plan: "GLM Coding Team Pro", until: "2026-12-31T15:59:59.000Z", renew: "off",
    resets: { count: 3, byWindow: true, fiveHour: 2, weekly: 1, until: new Date(1790000000 * 1000).toISOString() },
    windows: [
      { name: "5 hours", used: 42, display: "420 / 1000", amount: 420, limit: 1000, resetsAt: new Date(reset).toISOString(), span: 5 * 3600 },
      { name: "Weekly", used: 10, display: "1000 / 10000", amount: 1000, limit: 10000, resetsAt: new Date(reset + 86400000).toISOString(), span: 7 * 86400 },
    ],
  })
  expect(made).toEqual({ name: "zcode-team-api-key", keyType: 2 })
  expect(sets.length).toBe(1)
  expect(sets[0].path).toEqual({ id: "zcode" })
  expect(sets[0].body.access).toBe("tk.ts")
  expect(JSON.parse(sets[0].body.refresh)).toEqual({ ...state, key: "tk.ts", device: expect.any(String) })
})

test("Z.ai's refusals are the card's error", async () => {
  serve(() => new Response("", { status: 401 }))
  expect(await usage(oauth({ site: "zai", key: "k" }))).toEqual({ signIn: "kept", error: "Unauthorized" })
  serve(() => new Response(JSON.stringify({ code: 1001, msg: "Authorization Token非法" }), { status: 401 }))
  expect(await usage(oauth({ site: "zai", key: "k" }))).toEqual({ signIn: "kept", error: "Authorization Token非法 (401, code 1001)" })
  serve(() => new Response(JSON.stringify({ code: 500, msg: "" })))
  expect(await usage(oauth({ site: "zai", key: "k" }))).toEqual({ signIn: "kept", error: "error 500" })
  expect(await usage(undefined)).toEqual({ signIn: "kept", error: "not signed in" })
})

// magpie's built-in starts every card from the saved plan (zcode.go
// zcodeQuota, zcode_team.go zcodeTeamQuota, zcode_start.go zcodeStartQuota)
test("the saved plan stays on the card when the reply has no level, a team detail fails, or on an error", async () => {
  serve(({ url }) => {
    if (url.pathname === "/api/monitor/usage/quota/limit") return ok({ limits: [] })
    if (url.pathname === "/api/biz/subscription/list") return ok([])
  })
  const own = await usage(oauth({ site: "zai", key: "k", plan: "GLM Coding Max" }))
  expect(own.plan).toBe("GLM Coding Max")
  expect(own.error).toBeUndefined()

  serve(({ url }) => {
    if (url.pathname === "/api/monitor/usage/quota/limit") return ok({ limits: [] })
    return new Response("", { status: 500 })
  })
  const team = { site: "bigmodel", base: "https://open.bigmodel.cn/api/anthropic", key: "tk.ts", token: "Bearer t", org: "t1", project: "tp1", plan: "GLM Coding Team Pro" }
  expect((await usage(oauth(team))).plan).toBe("GLM Coding Team Pro")

  serve(() => new Response("", { status: 401 }))
  expect(await usage(oauth({ site: "zai", key: "k", plan: "GLM Coding Max" }))).toEqual({ signIn: "kept", plan: "GLM Coding Max", error: "Unauthorized" })
})

// the built-in left a limit ZCode's config doesn't name at 0
test("a model ZCode's config gives no limits has none made up", () => {
  expect(_internal.entry({ id: "GLM-9", context: 0, output: 0, efforts: [] }).limit).toEqual({ context: 0, output: 0 })
  expect(_internal.entry({ id: "GLM-9", context: 300_000, output: 8_000, efforts: [] }).limit).toEqual({ context: 300_000, output: 8_000 })
})

// The ZCode app's own list of manual-claim gift plans: GET /billing/preview
// is read with the usage card, and a plan it lists that the balance does not
// hold is named on the card, to be claimed in the ZCode app (the claim needs
// the app's captcha attestation, see claimHint). Both fixtures are real
// responses: one account's preview while the day's ZCode Trust Build was
// still unclaimed, and one after it had claimed it. The plugin never asks
// the claim endpoint.
const PREVIEW_CLAIMABLE = {
  server_time: 1791216750,
  plans: [{
    user_plan_id: "upl_2107141892427358208", plan_id: "zcode-v3-start-plan-trust-1006", name: "ZCode Trust Build",
    description: "ZCode Global Build", priority: 110, status: "active", starts_at: 1791216750, ends_at: 1791302400,
    entitlements: [{ entitlement_id: "zcode-v3-start-plan-trust-1006", show_name: "GLM-5.3-Flash", meter: "model_usage",
      unit_type: "token", capabilities: ["model:glm-5.3-flash"], grant_units: 100000000, period: "one_time", priority: 110, effective_at: 0 }],
  }],
}
const PREVIEW_CLAIMED = { server_time: 1791276990, plans: [] }
const TRUST_BUILD = { name: "ZCode Trust Build", used: 0, aside: true, display: "1 to claim · claim it in the ZCode app" }

// the Start Plan's own card, with the preview answering what preview says
async function startCard(now, token, preview) {
  const calls = serve(({ url }) => {
    if (url.pathname === "/api/v1/zcode-plan/billing/balance") return ok(startBalance(now, "active"))
    if (url.pathname === "/api/v1/zcode-plan/billing/preview") return preview(calls)
  })
  const auth = oauth({ site: "zai", jwt: token, device: "11111111-2222-4333-8444-555555555555" })
  return { u: await usage(auth), calls }
}

test("a gift plan ZCode holds but has not granted is named on the card, to claim in the app", async () => {
  const now = Math.trunc(Date.now() / 1000)
  const token = jwt(now + 86400)
  const { u, calls } = await startCard(now, token, () => ok(PREVIEW_CLAIMABLE))
  expect(u.windows).toEqual([
    { name: "GLM-5.1", used: 25, display: "250000 / 1000000", amount: 250000, limit: 1000000, resetsAt: new Date((now + 3600) * 1000).toISOString(), span: 86400,
      models: ["GLM-5.1", "GLM-5.1-Trial"] },
    TRUST_BUILD,
  ])
  // it is no allowance: set aside, so routing, caps and the menu bar pass it over
  expect(u.windows.at(-1).aside).toBe(true)
  // the preview went out as ZCode's own client asks it
  const p = calls.find((c) => c.url.pathname.endsWith("/preview"))
  expect(p.method).toBe("GET")
  expect(p.url.searchParams.get("app_version")).toBe("3.14.3")
  expect(p.url.searchParams.get("platform")).toBe(`${process.platform}-${process.arch}`)
  expect(p.headers.Authorization).toBe("Bearer " + token)
  expect(p.headers["X-Device-Mid"]).toBe("11111111-2222-4333-8444-555555555555")
  // nothing claims it here
  expect(calls.some((c) => c.url.pathname.endsWith("/claim"))).toBe(false)
})

test("a claimed account's card has no line at all", async () => {
  const now = Math.trunc(Date.now() / 1000)
  const { u } = await startCard(now, jwt(now + 86400), () => ok(PREVIEW_CLAIMED))
  expect(u.windows.map((w) => w.name)).toEqual(["GLM-5.1"])
  expect(u.error).toBeUndefined()
})

test("a preview that fails shows nothing and leaves the card as it was", async () => {
  const now = Math.trunc(Date.now() / 1000)
  const token = jwt(now + 86400)
  const before = (await startCard(now, token, () => new Response("", { status: 404 }))).u
  const refused = (await startCard(now, token, () => new Response(JSON.stringify({ code: 3007, msg: "captcha verify failed" }), { status: 400 }))).u
  const thrown = (await startCard(now, token, () => {
    throw new Error("no network in tests")
  })).u
  for (const u of [refused, thrown]) {
    expect(u).toEqual(before)
    expect(u.error).toBeUndefined()
    expect(u.windows.some((w) => w.aside)).toBe(false)
  }
  // an expired sign-in is no preview request either
  const calls = serve(() => undefined)
  expect((await usage(oauth({ site: "zai", jwt: jwt(now - 60) }))).error).toContain("sign-in has expired")
  expect(calls.some((c) => c.url.pathname.endsWith("/preview"))).toBe(false)
})

test("the card's error stays the error: no line is added over it", async () => {
  const now = Math.trunc(Date.now() / 1000)
  const { u } = await startCard(now, jwt(now + 86400), () => ok(PREVIEW_CLAIMABLE))
  expect(u.windows.at(-1)).toEqual(TRUST_BUILD) // a working card gets it
  const calls = serve(({ url }) => {
    if (url.pathname === "/api/v1/zcode-plan/billing/balance") return ok(startBalance(now, "expired"))
    if (url.pathname === "/api/v1/zcode-plan/billing/preview") return ok(PREVIEW_CLAIMABLE)
  })
  const over = await usage(oauth({ site: "zai", jwt: jwt(now + 86400), device: "d" }))
  expect(over).toEqual({ signIn: "kept", error: "this account has no GLM Coding Plan, and ZCode's Start Plan has ended or was never started" })
  expect(calls.some((c) => c.url.pathname.endsWith("/preview"))).toBe(false) // nothing to put it on
})

test("several claimable plans are counted", async () => {
  const now = Math.trunc(Date.now() / 1000)
  const two = { ...PREVIEW_CLAIMABLE, plans: [PREVIEW_CLAIMABLE.plans[0], { plan_id: "zcode-v3-start-plan-trust-1007", name: "ZCode Trust Build", status: "active" }] }
  const { u } = await startCard(now, jwt(now + 86400), () => ok(two))
  expect(u.windows.at(-1)).toEqual({ name: "ZCode Trust Build", used: 0, aside: true, display: "2 to claim · claim them in the ZCode app" })
})

// a coding account with gift plans: the line goes last, after both allowances
test("a coding account's line goes after its coding and gift windows", async () => {
  const now = Math.trunc(Date.now() / 1000)
  const token = jwt(now + 86400)
  const calls = serve(({ url }) => {
    if (url.pathname === "/api/biz/subscription/list") return ok([{ productName: "GLM Coding Pro", status: "VALID" }])
    if (url.pathname === "/api/monitor/usage/quota/limit") return ok({ level: "pro", limits: [{ type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 25 }] })
    if (url.pathname === "/api/v1/zcode-plan/billing/balance") return ok(startBalance(now, "active"))
    if (url.pathname === "/api/v1/zcode-plan/billing/preview") return ok(PREVIEW_CLAIMABLE)
  })
  const auth = oauth({ site: "zai", key: "k", jwt: token, device: "d" })
  const u = await usage(auth)
  expect(u.plan).toBe("GLM Coding Pro")
  expect(u.windows.map((w) => w.name)).toEqual(["5 hours", "GLM-5.1-Trial", "ZCode Trust Build"])
  expect(u.windows.at(-1)).toEqual(TRUST_BUILD)
  expect(calls.filter((c) => c.url.pathname.endsWith("/preview"))).toHaveLength(1)
})
