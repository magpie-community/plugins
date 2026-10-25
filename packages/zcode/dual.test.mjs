// A dual account (a GLM Coding Plan and gift plans) shows both allowances on
// its card. A plain model always spends the coding plan; the gift is spent
// only through its trial entries (GLM-5.3-Flash-Trial), the user's pick. A
// trial entry whose bucket is spent or blocked answers 429 locally; the
// gift's own quota answers (its 1113, its 1005 inside a 200) become 429 and
// keep the entry off for a minute, while any other gift answer goes on as it
// came. Nothing leaves the machine: the plugin's fetch is the fake here.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

let ZCodeAuthPlugin, _internal
async function setup() {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ ZCodeAuthPlugin, _internal } = await import("./index.mjs"))
}
await setup()

const jwt = ["{}", JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })].map((s) => Buffer.from(s).toString("base64url")).join(".") + ".sig"
const DEVICE = "11111111-2222-4333-8444-555555555555"
const KEY = "dual.secret"
const now = Math.trunc(Date.now() / 1000)
// a gift whose only live bucket serves glm-5.3-flash, a quarter used
const balance = {
  server_time: now,
  plans: [{ plan_id: "zai-start-plan", user_plan_id: "up1", name: "Start Plan", status: "active", ends_at: now + 7 * 86400,
    entitlements: [{ entitlement_id: "e1", period: "daily" }] }],
  balances: [{ plan_id: "zai-start-plan", user_plan_id: "up1", entitlement_id: "e1", show_name: "Trust Build", capabilities: ["model:glm-5.3-flash"],
    total_units: 1000, used_units: 250, remaining_units: 750, expires_at: now + 3600 }],
}
const coding = { type: "oauth", access: KEY, refresh: JSON.stringify({ site: "zai", base: "https://api.z.ai/api/anthropic", key: KEY, jwt, device: DEVICE, plan: "GLM Coding Pro" }), expires: 0 }

const sent = []
const answers = {}
const real = globalThis.fetch
beforeEach(async () => {
  _internal.routes.clear()
  _internal.blocked.clear()
  sent.length = 0
  for (const k of Object.keys(answers)) delete answers[k]
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const c = { path: url.pathname, origin: url.origin, method: init.method ?? (input instanceof Request ? input.method : "GET"), headers: Object.fromEntries(new Headers(init.headers ?? (input instanceof Request ? input.headers : {}))), body: init.body ?? await (input.body ? input.text() : undefined) }
    sent.push(c)
    const a = answers[c.path]
    if (!a) return new Response("", { status: 404 })
    return a instanceof Response ? a.clone() : typeof a === "function" ? await a(c) : a.clone()
  }
})
afterEach(() => (globalThis.fetch = real))
const ok = (data) => new Response(JSON.stringify({ code: 0, data }))

function planAndBalance() {
  answers["/api/biz/subscription/list"] = ok([{ productName: "GLM Coding Pro", status: "VALID" }])
  answers["/api/v1/zcode-plan/billing/balance"] = ok(balance)
}
const hooks = async () => (await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } })).auth
const loader = async () => (await hooks()).loader(async () => coding, { id: "zcode" })
async function sendTo(url, body) {
  const opts = await loader()
  return opts.fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "zcode", "anthropic-version": "2023-06-01" }, body })
}
const MSG = "https://api.z.ai/api/anthropic/v1/messages"
const body = (model) => JSON.stringify({ model, max_tokens: 100, messages: [{ role: "user", content: "hi" }] })

for (const [name, paid, gift] of [
  ["a full paid week leaves an available gift usable", 100, 25],
  ["a spent gift leaves the paid plan usable", 20, 100],
  ["two available pools keep their windows apart", 20, 25],
  ["two spent pools keep the paid limit visible", 100, 100],
]) {
  test(name, async () => {
    planAndBalance()
    answers["/api/monitor/usage/quota/limit"] = ok({ limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: paid }] })
    answers["/api/v1/zcode-plan/billing/balance"] = ok({ ...balance, balances: [{ ...balance.balances[0], used_units: gift * 10, remaining_units: 1000 - gift * 10 }] })
    answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
    answers["/api/v1/zcode-plan/anthropic/v1/messages"] = ok({ type: "message", content: [] })
    const u = await (await hooks()).usage(async () => coding, { id: "zcode" })
    expect(u.windows[0].used).toBe(paid)
    expect(u.windows[1].used).toBe(gift)
    expect(u.windows[0].notModels).toEqual(["glm-5.3-flash-trial"])
    expect(u.windows[1].models).toEqual(["GLM-5.3-Flash-Trial"])
    expect(JSON.stringify(u)).not.toContain("_spent")
    // a plain model spends the coding plan whatever the gift holds
    let before = sent.length
    expect((await sendTo(MSG, body("GLM-5.3-Flash"))).status).toBe(200)
    expect(sent.slice(before).at(-1).origin).toBe("https://api.z.ai")
    expect(sent.slice(before).filter((c) => c.path.endsWith("/messages"))).toHaveLength(1)
    // the trial entry spends the gift while it has quota, and nothing else
    before = sent.length
    const t = await sendTo(MSG, body("GLM-5.3-Flash-Trial"))
    if (gift < 100) {
      expect(t.status).toBe(200)
      expect(sent.slice(before).at(-1).origin).toBe("https://zcode.z.ai")
    } else {
      expect(t.status).toBe(429)
      expect(sent.slice(before).filter((c) => c.path.endsWith("/messages"))).toHaveLength(0)
    }
  })
}

test("a spent gift retires its trial entry from the request cache", async () => {
  planAndBalance()
  answers["/api/monitor/usage/quota/limit"] = ok({ limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 20 }] })
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  await sendTo(MSG, body("GLM-5.3-Flash-Trial")) // warms the ten-minute request cache
  answers["/api/v1/zcode-plan/billing/balance"] = ok({ ...balance, balances: [{ ...balance.balances[0], used_units: 1000, remaining_units: 0 }] })
  const u = await (await hooks()).usage(async () => coding, { id: "zcode" })
  expect(u.windows[1].models).toEqual(["GLM-5.3-Flash-Trial"])
  const before = sent.length
  expect((await sendTo(MSG, body("GLM-5.3-Flash-Trial"))).status).toBe(429)
  expect(sent.slice(before).filter((c) => c.path.endsWith("/messages"))).toHaveLength(0)
})

test("fresh usage recognizes a newly replenished gift without waiting for the request cache", async () => {
  planAndBalance()
  answers["/api/monitor/usage/quota/limit"] = ok({ limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 100 }] })
  answers["/api/v1/zcode-plan/billing/balance"] = ok({ ...balance, balances: [{ ...balance.balances[0], used_units: 1000, remaining_units: 0 }] })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  await sendTo(MSG, body("GLM-5.3-Flash-Trial")) // refused locally, the bucket spent
  answers["/api/v1/zcode-plan/billing/balance"] = ok(balance)
  const u = await (await hooks()).usage(async () => coding, { id: "zcode" })
  expect(u.windows[0].notModels).toEqual(["glm-5.3-flash-trial"])
  const before = sent.length
  expect((await sendTo(MSG, body("GLM-5.3-Flash-Trial"))).status).toBe(200)
  expect(sent.slice(before).at(-1).origin).toBe("https://zcode.z.ai")
})

test("an expired gift restores the paid windows and retires its cached route", async () => {
  planAndBalance()
  answers["/api/monitor/usage/quota/limit"] = ok({ limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 20 }] })
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  await sendTo(MSG, body("glm-5.3-flash"))
  answers["/api/v1/zcode-plan/billing/balance"] = ok({ ...balance, plans: [{ ...balance.plans[0], ends_at: now - 1 }] })
  const u = await (await hooks()).usage(async () => coding, { id: "zcode" })
  expect(u.windows).toHaveLength(1)
  expect(u.windows[0].notModels).toBeUndefined()
  const before = sent.length
  await sendTo(MSG, body("glm-5.3-flash"))
  expect(sent.slice(before).at(-1).origin).toBe("https://api.z.ai")
})

test("a trial entry's quota refusal answers 429 and blocks the entry for a minute", async () => {
  planAndBalance()
  answers["/api/monitor/usage/quota/limit"] = ok({ limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 100 }] })
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = new Response(JSON.stringify({ code: "1005", msg: "exceed quota limit" }), { headers: { "content-type": "application/json" } })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  expect((await sendTo(MSG, body("GLM-5.3-Flash-Trial"))).status).toBe(429)
  expect(sent.filter((c) => c.origin === "https://api.z.ai" && c.path.endsWith("/messages"))).toHaveLength(0)
  const u = await (await hooks()).usage(async () => coding, { id: "zcode" })
  expect(u.windows[0].notModels).toEqual(["glm-5.3-flash-trial"])
  expect(u.windows[1].models).toEqual(["GLM-5.3-Flash-Trial"])
  _internal.blocked.clear()
  const renewed = await (await hooks()).usage(async () => coding, { id: "zcode" })
  expect(renewed.windows[0].notModels).toEqual(["glm-5.3-flash-trial"])
  expect(renewed.windows[1].aside).not.toBe(true)
})

test("blocking one model leaves another model of the same gift bucket usable", async () => {
  planAndBalance()
  answers["/api/monitor/usage/quota/limit"] = ok({ limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 100 }] })
  answers["/api/v1/zcode-plan/billing/balance"] = ok({ ...balance, balances: [{ ...balance.balances[0], capabilities: ["model:glm-5.3-flash", "model:GLM-5.2"] }] })
  _internal.blocked.set(KEY + "\0" + jwt + "\0glm-5.3-flash", Date.now() + 60_000)
  const u = await (await hooks()).usage(async () => coding, { id: "zcode" })
  expect(u.windows[0].notModels).toEqual(["glm-5.3-flash-trial", "glm-5.2-trial"])
  expect(u.windows[1].models).toEqual(["GLM-5.3-Flash-Trial", "GLM-5.2-Trial"])
  expect(u.windows[1].aside).not.toBe(true)
})

test("a spent bucket without remaining_units is skipped using its used and total counts", async () => {
  planAndBalance()
  const spent = { ...balance.balances[0], used_units: "1000", total_units: "1000" }
  delete spent.remaining_units
  answers["/api/v1/zcode-plan/billing/balance"] = ok({ ...balance, balances: [spent] })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  await sendTo(MSG, body("glm-5.3-flash"))
  expect(sent.at(-1).origin).toBe("https://api.z.ai")
  expect(sent.filter((c) => c.path === "/api/v1/zcode-plan/anthropic/v1/messages")).toHaveLength(0)
})

test("a spent gift-only account keeps its spent window as a routing limit", async () => {
  answers["/api/v1/zcode-plan/billing/balance"] = ok({ ...balance, balances: [{ ...balance.balances[0], used_units: 1000, remaining_units: 0 }] })
  const only = { type: "oauth", access: jwt, refresh: JSON.stringify({ site: "zai", base: "https://api.z.ai/api/anthropic", jwt, device: DEVICE }), expires: 0 }
  const u = await (await hooks()).usage(async () => only, { id: "zcode" })
  expect(u.windows[0].used).toBe(100)
  expect(u.windows[0].aside).toBeUndefined()
  expect(JSON.stringify(u)).not.toContain("_spent")
})


test("the card shows the Coding windows and the gift's buckets together", async () => {
  planAndBalance()
  answers["/api/monitor/usage/quota/limit"] = ok({ level: "pro", limits: [{ type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 2000, remaining: 1500, percentage: 25 }] })
  const u = await (await hooks()).usage(async () => coding, { id: "zcode" })
  expect(u.plan).toBe("GLM Coding Pro")
  expect(u.signIn).toBe("kept")
  expect(u.error).toBeUndefined()
  expect(u.windows.map((w) => w.name)).toEqual(["5 hours", "Trust Build"])
  expect(u.windows[1]).toMatchObject({ used: 25, display: "250 / 1000", models: ["GLM-5.3-Flash-Trial"] })
  expect(u.until).toBeUndefined()
  expect(u.renew).toBeUndefined()
  expect(u.windows[1].resetsAt).toBe(new Date((now + 3600) * 1000).toISOString())
})

test("a gift read that fails after the gift was known leaves just the Coding card", async () => {
  answers["/api/biz/subscription/list"] = ok([{ productName: "GLM Coding Pro", status: "VALID" }])
  answers["/api/monitor/usage/quota/limit"] = ok({ limits: [{ type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 2000, remaining: 1500, percentage: 25 }] })
  answers["/api/v1/zcode-plan/billing/balance"] = ok(balance)
  await (await hooks()).usage(async () => coding, { id: "zcode" }) // reads and caches the gift
  answers["/api/v1/zcode-plan/billing/balance"] = new Response("", { status: 500 })
  const u = await (await hooks()).usage(async () => coding, { id: "zcode" })
  expect(u.windows.map((w) => w.name)).toEqual(["5 hours"])
  expect(u.error).toBeUndefined()
  expect(_internal.routes.get(KEY + "\0" + jwt).gift).toBeNull()
  expect(_internal.routes.get(KEY + "\0" + jwt).ttl).toBe(60_000)
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const before = sent.length
  await sendTo(MSG, body("glm-5.3-flash"))
  expect(sent.slice(before).at(-1).origin).toBe("https://api.z.ai")
})

test("a trial entry goes to the Start Plan, dressed", async () => {
  planAndBalance()
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const res = await sendTo(MSG, body("GLM-5.3-Flash-Trial"))
  expect(res.status).toBe(200)
  expect(sent.length).toBe(3) // the plan list and the balance read, then the message
  const m = sent.at(-1)
  expect(m.origin).toBe("https://zcode.z.ai")
  expect(m.path).toBe("/api/v1/zcode-plan/anthropic/v1/messages")
  expect(m.headers["x-title"]).toBe("Z Code@cli")
  expect(m.headers.authorization).toBe("Bearer " + jwt)
  expect(m.headers["x-api-key"]).toBeUndefined()
  expect(JSON.parse(m.body).system.length).toBeGreaterThan(1) // dressed
  expect(JSON.parse(m.body).model).toBe("glm-5.3-flash") // the entry's own model
})

test("a model the gift does not serve goes to the coding plan as sent", async () => {
  planAndBalance()
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const res = await sendTo(MSG, body("GLM-5.3"))
  expect(res.status).toBe(200)
  const m = sent.at(-1)
  expect(m.origin).toBe("https://api.z.ai")
  expect(m.path).toBe("/api/anthropic/v1/messages")
  // as sent, but for the sign-in's device and the conversation, as ZCode names them (#387)
  const session = _internal.sessionOf("", DEVICE)
  expect(m.headers["x-session-id"]).toBe(session)
  expect(JSON.parse(m.body)).toEqual({ ...JSON.parse(body("GLM-5.3")), metadata: { user_id: JSON.stringify({ device_id: DEVICE, account_uuid: "", session_id: session }) } })
  expect(m.headers["x-api-key"]).toBe(KEY)
  expect(m.headers["x-title"]).toBeUndefined()
})

test("a spent bucket answers the trial entry 429 without touching the coding plan", async () => {
  planAndBalance()
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = new Response(JSON.stringify({ error: { code: "1113", message: "Insufficient balance or no resource package" } }), { status: 429 })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const res = await sendTo(MSG, body("GLM-5.3-Flash-Trial"))
  expect(res.status).toBe(429)
  expect(sent.filter((c) => c.origin === "https://api.z.ai" && c.path.endsWith("/messages"))).toHaveLength(0)
  // the minute's block keeps the next one off the gift too
  const before = sent.length
  await sendTo(MSG, body("GLM-5.3-Flash-Trial"))
  expect(sent.slice(before).filter((c) => c.path.endsWith("/messages"))).toHaveLength(0)
})

test("a trial entry's quota error inside a 200 becomes 429", async () => {
  planAndBalance()
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = new Response(JSON.stringify({ code: 1005, msg: "exceed quota limit", logid: "x" }), { status: 200, headers: { "content-type": "application/json" } })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const res = await sendTo(MSG, body("GLM-5.3-Flash-Trial"))
  expect(res.status).toBe(429)
  expect(sent.filter((c) => c.origin === "https://api.z.ai" && c.path.endsWith("/messages"))).toHaveLength(0)
})

test("a trial entry's 200 success answers normally: no replay", async () => {
  planAndBalance()
  const sse = new Response("data: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = sse
  const res = await sendTo(MSG, body("GLM-5.3-Flash-Trial"))
  expect(res.status).toBe(200)
  expect(res.headers.get("x-magpie-sign-in")).toBe("kept")
  expect(sent.filter((c) => c.path === "/api/anthropic/v1/messages").length).toBe(0)
  expect(await res.text()).toBe("data: {}\n\n")
})

test("a gift refusal answers the trial entry as it came, unblocked", async () => {
  planAndBalance()
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = new Response(JSON.stringify({ code: "3012", msg: "unusual activity" }), { status: 405 })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const res = await sendTo(MSG, body("GLM-5.3-Flash-Trial"))
  expect(res.status).toBe(405)
  expect(sent.filter((c) => c.origin === "https://api.z.ai" && c.path.endsWith("/messages"))).toHaveLength(0)
  expect(_internal.blocked.size).toBe(0)
  const before = sent.length
  await sendTo(MSG, body("GLM-5.3-Flash-Trial"))
  expect(sent.slice(before).some((c) => c.origin === "https://zcode.z.ai")).toBe(true)
})

test("a ZCode sign-in that expired after the gift was cached goes to the coding plan", async () => {
  planAndBalance()
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const dead = ["{}", JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 10 })].map((s) => Buffer.from(s).toString("base64url")).join(".") + ".sig"
  _internal.routes.set(KEY + "\0" + dead, { start: false, gift: { models: ["glm-5.3-flash"] }, at: Date.now(), ttl: 600_000 })
  const aged = { ...coding, refresh: JSON.stringify({ ...JSON.parse(coding.refresh), jwt: dead }) }
  const opts = await (await hooks()).loader(async () => aged, { id: "zcode" })
  const res = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "zcode" }, body: body("glm-5.3-flash") })
  expect(res.status).toBe(200)
  expect(sent.at(-1).origin).toBe("https://api.z.ai")
  expect(sent.at(-1).headers["x-api-key"]).toBe(KEY)
})

// a failed gift read is unknown, not "no gift": a ten-minute "none" hid
// the account's -Trial models for ten minutes after one hiccup
test("a gift read that fails at once is asked again in a minute", async () => {
  answers["/api/biz/subscription/list"] = ok([{ productName: "GLM Coding Pro", status: "VALID" }])
  answers["/api/v1/zcode-plan/billing/balance"] = new Response("", { status: 500 })
  await sendTo(MSG, body("glm-5.3-flash"))
  const r = _internal.routes.get(KEY + "\0" + jwt)
  expect(r.start).toBe(false) // on the coding plan
  expect(r.gift).toBeNull() // the balance read failed: no gift known
  expect(r.ttl).toBe(60_000) // the gift is unknown: a minute
})

test("a coding account with no gift keeps its 10-minute cache", async () => {
  answers["/api/biz/subscription/list"] = ok([{ productName: "GLM Coding Pro", status: "VALID" }])
  answers["/api/v1/zcode-plan/billing/balance"] = ok({ server_time: now, plans: [], balances: [] })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  await sendTo(MSG, body("GLM-5.3"))
  const r = _internal.routes.get(KEY + "\0" + jwt)
  expect(r.start).toBe(false)
  expect(r.gift).toBeNull()
  expect(r.ttl).toBe(600_000) // plan list read fine: 10 minutes, not 1
})

test("a plan-list failure on a key account takes the dual route, not gift-only", async () => {
  answers["/api/biz/subscription/list"] = new Response("", { status: 500 })
  answers["/api/v1/zcode-plan/billing/balance"] = ok(balance)
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  await sendTo(MSG, body("GLM-5.3"))
  const r = _internal.routes.get(KEY + "\0" + jwt)
  expect(r.start).toBe(false) // dual: coding first, gift for its models
  expect(r.gift).toMatchObject({ models: ["glm-5.3-flash"] })
  expect(r.ttl).toBe(60_000) // unsure: the plan list failed
})

// several plans can be active at once: the gift is what any live plan's live
// bucket can spend, whatever the plan is named
test("every live plan spends first by its buckets' models, and the card shows them all", async () => {
  answers["/api/biz/subscription/list"] = ok([{ productName: "GLM Coding Pro", status: "VALID" }])
  answers["/api/monitor/usage/quota/limit"] = ok({ limits: [{ type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 2000, remaining: 1500, percentage: 25 }] })
  answers["/api/v1/zcode-plan/billing/balance"] = ok({
    server_time: now,
    plans: [
      { plan_id: "zai-start-plan", user_plan_id: "up1", name: "Start Plan", status: "active", ends_at: now + 7 * 86400, entitlements: [{ entitlement_id: "e1", period: "daily" }] },
      { plan_id: "zai-bonus-plan", user_plan_id: "up2", name: "GLM Festival Grant", status: "active", ends_at: now + 3 * 86400, entitlements: [{ entitlement_id: "e2", period: "weekly" }] },
      { plan_id: "zai-old-plan", user_plan_id: "up3", name: "Old Grant", status: "active", ends_at: now - 86400, entitlements: [{ entitlement_id: "e3", period: "daily" }] },
    ],
    balances: [
      ...balance.balances,
      { plan_id: "zai-bonus-plan", user_plan_id: "up2", entitlement_id: "e2", show_name: "GLM-5.2", capabilities: ["model:GLM-5.2"], total_units: 100, used_units: 10, remaining_units: 90, expires_at: now + 3600 },
      { plan_id: "zai-bonus-plan", user_plan_id: "up2", entitlement_id: "e2b", show_name: "GLM-5.2 late", capabilities: ["model:glm-5.2"], total_units: 100, used_units: 100, remaining_units: 0, expires_at: now + 3600 },
      { plan_id: "zai-old-plan", user_plan_id: "up3", entitlement_id: "e3", show_name: "Old", capabilities: ["model:glm-4"], total_units: 10, used_units: 0, remaining_units: 10, expires_at: now + 3600 },
    ],
  })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  // plain models stay on the coding plan; the trial entries spend the gift
  for (const [m, origin] of [["glm-5.3-flash", "https://api.z.ai"], ["GLM-5.2", "https://api.z.ai"], ["GLM-5.3-Flash-Trial", "https://zcode.z.ai"], ["GLM-5.2-Trial", "https://zcode.z.ai"]]) {
    const before = sent.length
    expect((await sendTo(MSG, body(m))).status).toBe(200)
    expect(sent.slice(before).at(-1).origin).toBe(origin)
  }
  // the ended plan's bucket does not put GLM-4 on the gift
  const before = sent.length
  expect((await sendTo(MSG, body("GLM-4"))).status).toBe(200)
  expect(sent.slice(before).at(-1).origin).toBe("https://api.z.ai")
  // the card shows both plans' live buckets, spent ones included, none of the
  // ended plan's, each named after its plan as there are two
  const u = await (await hooks()).usage(async () => coding, { id: "zcode" })
  expect(u.windows.map((w) => w.name)).toEqual(["5 hours", "Start Plan · Trust Build", "GLM Festival Grant · GLM-5.2-Trial", "GLM Festival Grant · GLM-5.2 late"])
  expect(u.windows.some((w) => w.name === "Old")).toBe(false)
  expect(u.windows[0].notModels).toEqual(["glm-5.3-flash-trial", "glm-5.2-trial"])
  expect(u.windows.at(-1).aside).toBe(true) // a spent sibling cannot cap a live bucket
})

test("a gift-only account sends every request to the gift, and reads no balance to do it", async () => {
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const only = { type: "oauth", access: jwt, refresh: JSON.stringify({ site: "zai", base: "https://api.z.ai/api/anthropic", jwt, device: DEVICE }), expires: 0 }
  const opts = await (await hooks()).loader(async () => only, { id: "zcode" })
  const res = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("glm-5.3-flash") })
  expect(res.status).toBe(200)
  expect(sent.at(-1).origin).toBe("https://zcode.z.ai")
  expect(sent.filter((c) => c.path === "/api/v1/zcode-plan/billing/balance").length).toBe(0)
})

// #369: a GLM Coding Plan account whose plan list read no plan once was sent
// to the Start Plan for ten minutes, and every request answered 405
test("a key's plan list that once reads no plan after reading one is asked again in a minute", async () => {
  answers["/api/biz/subscription/list"] = ok([{ productName: "GLM Coding Lite", status: "VALID" }])
  answers["/api/v1/zcode-plan/billing/balance"] = ok(balance)
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  await sendTo(MSG, body("GLM-5.3"))
  const id = KEY + "\0" + jwt
  expect(_internal.routes.get(id)).toMatchObject({ start: false, ttl: 600_000 })
  _internal.routes.get(id).at = 0 // the ten minutes are up
  answers["/api/biz/subscription/list"] = ok([])
  await sendTo(MSG, body("GLM-5.3"))
  expect(_internal.routes.get(id)).toMatchObject({ start: true, ttl: 60_000 })
  // read the same way again, it is known: ten minutes
  _internal.routes.get(id).at = 0
  await sendTo(MSG, body("GLM-5.3"))
  expect(_internal.routes.get(id)).toMatchObject({ start: true, ttl: 600_000 })
})

test("a Start Plan refusal on a key account reads its plans again on the next request", async () => {
  answers["/api/biz/subscription/list"] = ok([{ productName: "GLM Coding Lite", status: "VALID" }])
  answers["/api/v1/zcode-plan/billing/balance"] = ok(balance)
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = new Response(JSON.stringify({ error: { message: "Method Not Allowed" } }), { status: 405 })
  const id = KEY + "\0" + jwt
  _internal.routes.set(id, { start: true, gift: null, at: Date.now(), ttl: 600_000 })
  let res = await sendTo(MSG, body("GLM-5.3"))
  expect(res.status).toBe(405)
  expect(sent.at(-1).origin).toBe("https://zcode.z.ai")
  res = await sendTo(MSG, body("GLM-5.3"))
  expect(res.status).toBe(200)
  expect(sent.at(-1).origin).toBe("https://api.z.ai")
  expect(sent.at(-1).headers["x-api-key"]).toBe(KEY)
})

// #379: a plan bought, a gift claimed or a plan lapsed reaches the requests
// when the card shows it
test("a card read reads the route again", async () => {
  answers["/api/biz/subscription/list"] = ok([{ productName: "GLM Coding Pro", status: "VALID" }])
  answers["/api/v1/zcode-plan/billing/balance"] = ok(balance)
  answers["/api/monitor/usage/quota/limit"] = ok({ limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 10 }] })
  const id = KEY + "\0" + jwt
  _internal.routes.set(id, { start: true, gift: null, at: Date.now(), ttl: 600_000 })
  const u = await (await hooks()).usage(async () => coding, { id: "zcode" })
  expect(u.windows[0].used).toBe(10)
  expect(_internal.routes.get(id)).toMatchObject({ start: false, gift: { models: ["glm-5.3-flash"] } })
})
