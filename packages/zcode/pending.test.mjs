// A gift plan that has not started yet (windy, Discord: "今天23点要生效的Start
// Plan就没显示"), and a coding account's gift buckets told apart from its
// Coding Plan windows ("无法区分Coding Plan 和Start Plan的额度").
//
// The balance's plans are as ZCode's /billing/balance says them
// give them: plan_id, user_plan_id, name, status, starts_at and ends_at in
// Unix seconds (usage.test.mjs's fixtures are real replies). Which
// status a plan not started yet carries has not been seen, so these tests
// give it both "active" and an unknown word: the plugin goes by starts_at.
// Nothing leaves the machine: fetch is a fake.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

let ZCodeAuthPlugin, _internal
beforeAll(async () => {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ ZCodeAuthPlugin, _internal } = await import("./index.mjs"))
})
const real = globalThis.fetch
afterAll(() => (globalThis.fetch = real))
beforeEach(() => {
  globalThis.fetch = async () => { throw new Error("no network in tests") }
  _internal.routes.clear()
  _internal.blocked.clear()
})

const ok = (data) => new Response(JSON.stringify({ code: 0, data }))
function serve(route) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const c = { url: new URL(String(url)), headers: init.headers ?? {} }
    calls.push(c)
    return (await route(c)) ?? new Response("", { status: 404 })
  }
  return calls
}
const oauth = (state) => ({ type: "oauth", access: state.key ?? state.jwt ?? "", refresh: JSON.stringify(state), expires: 0 })
async function usage(auth) {
  const hooks = await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
  return hooks.auth.usage(async () => auth, { id: "zcode" })
}
const jwt = (exp) => ["{}", JSON.stringify({ exp })].map((s) => Buffer.from(s).toString("base64url")).join(".") + ".sig"
const two = (n) => String(n).padStart(2, "0")
// the start as the card says it: this computer's time
const local = (sec) => {
  const d = new Date(sec * 1000)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}
const PENDING = "ZCode gift plan not started yet"

const now = Math.trunc(Date.now() / 1000)
const later = now + 5 * 3600
const live = { plan_id: "zcode-v3-start-plan", user_plan_id: "up1", name: "Start Plan", status: "active", starts_at: now - 86400, ends_at: now + 3600,
  entitlements: [{ entitlement_id: "e1", period: "daily" }] }
const next = (status) => ({ plan_id: "zcode-v3-start-plan", user_plan_id: "up2", name: "Start Plan", status, starts_at: later, ends_at: later + 7 * 86400,
  entitlements: [{ entitlement_id: "e2", period: "daily" }] })
const bucket = (up, left, model = "GLM-5.1") => ({ plan_id: "zcode-v3-start-plan", user_plan_id: up, entitlement_id: up === "up1" ? "e1" : "e2",
  show_name: "GLM-5.1", capabilities: ["model:" + model], total_units: 1000, used_units: 1000 - left, remaining_units: left, expires_at: up === "up1" ? now + 3600 : later + 86400 })

function zcode(balance, coding) {
  return serve(({ url }) => {
    if (url.pathname === "/api/v1/zcode-plan/billing/balance") return ok({ server_time: now, ...balance })
    if (url.pathname === "/api/v1/marketing/touch") return ok({ deliveries: [] })
    if (!coding) return
    if (url.pathname === "/api/biz/subscription/list") return ok([{ productName: "GLM Coding Pro", status: "VALID" }])
    if (url.pathname === "/api/monitor/usage/quota/limit") return ok({ level: "pro", limits: [{ type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 25 }] })
  })
}
const codingAuth = () => oauth({ site: "zai", base: "https://api.z.ai/api/anthropic", key: "k.pending", jwt: jwt(now + 86400), device: "d", plan: "GLM Coding Pro" })
const startAuth = () => oauth({ site: "zai", jwt: jwt(now + 86400), device: "d" })

for (const status of ["active", "pending_unknown_word"]) {
  test(`a coding account's Start Plan that starts later is named with its start (status ${status})`, async () => {
    // the only gift plan has not started: before, no gift was live, so the
    // card read no balance and the plan was left out
    zcode({ plans: [next(status)], balances: [bucket("up2", 1000)] }, true)
    const u = await usage(codingAuth())
    expect(u.plan).toBe("GLM Coding Pro")
    expect(u.windows).toEqual([
      { name: "5 hours", used: 25, span: 5 * 3600 },
      { name: PENDING, used: 0, aside: true, display: `Start Plan · ${local(later)}` },
    ])
    // and nothing is routed to it before it starts: no gift for requests
    const s = JSON.parse(codingAuth().refresh)
    expect((await _internal.plansOf(s)).gift).toBeNull()
  })
}

test("beside the Coding Plan, a live gift's buckets carry their plan's name, and the next plan its start", async () => {
  zcode({ plans: [live, next("active")], balances: [bucket("up1", 400), bucket("up2", 1000)] }, true)
  const u = await usage(codingAuth())
  expect(u.windows.map((w) => w.name)).toEqual(["5 hours", "GLM-5.1-Trial · Start Plan", PENDING])
  // the live plan's bucket is the one counted; the coming plan's full one isn't
  expect(u.windows[1]).toMatchObject({ used: 60, display: "600 / 1000", models: ["GLM-5.1-Trial"] })
  expect(u.windows[2]).toEqual({ name: PENDING, used: 0, aside: true, display: `Start Plan · ${local(later)}` })
  // the Coding Plan's window leaves the gift's models to the gift
  expect(u.windows[0].notModels).toEqual(["glm-5.1-trial"])
})

test("a gift-only account whose next Start Plan starts later shows today's and names the next", async () => {
  zcode({ plans: [live, next("active")], balances: [bucket("up1", 400), bucket("up2", 1000)] })
  const u = await usage(startAuth())
  expect(u.error).toBeUndefined()
  expect(u.plan).toBe("Start Plan")
  expect(u.until).toBe(new Date((now + 3600) * 1000).toISOString())
  expect(u.windows.map((w) => [w.name, w.display])).toEqual([
    ["GLM-5.1", "600 / 1000"],
    [PENDING, `Start Plan · ${local(later)}`],
  ])
})

test("a gift-only account whose only plan starts later gets a card, not 'ended or never started'", async () => {
  zcode({ plans: [{ ...next("active"), name: "ZCode Trust Build" }], balances: [] })
  const u = await usage(startAuth())
  expect(u).toEqual({ signIn: "kept", plan: "ZCode Trust Build", windows: [{ name: PENDING, used: 0, aside: true, display: `ZCode Trust Build · ${local(later)}` }] })
})

test("several coming plans are each named, the soonest first; an expired one with a later start is not", async () => {
  const far = { ...next("active"), user_plan_id: "up3", name: "ZCode 1024 Dev Day", starts_at: later + 86400 }
  const gone = { ...next("expired"), user_plan_id: "up4", name: "Old Grant" }
  zcode({ plans: [far, gone, next("active")], balances: [] }, true)
  const u = await usage(codingAuth())
  expect(u.windows.filter((w) => w.name === PENDING).map((w) => w.display)).toEqual([
    `Start Plan · ${local(later)}`,
    `ZCode 1024 Dev Day · ${local(later + 86400)}`,
  ])
})

test("a plan whose start has come is live, not coming", async () => {
  zcode({ plans: [{ ...next("active"), starts_at: now }], balances: [bucket("up2", 1000)] })
  const u = await usage(startAuth())
  expect(u.windows.map((w) => w.name)).toEqual(["GLM-5.1"])
})
