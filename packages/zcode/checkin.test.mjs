// auth.checkin claims the gift plans ZCode's preview lists for an account
// (magpie-community/plugins#503). The preview and the "already claimed"
// replies are real (#503's capture of 10-29, the 10-06 preview in
// usage.test.mjs); the code 0 claim reply has not been seen yet, so its
// fixture carries only the code.
import { test, expect, afterAll, beforeAll, beforeEach } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { readFileSync, realpathSync } from "node:fs"

let ZCodeAuthPlugin, _internal
beforeAll(async () => {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ ZCodeAuthPlugin, _internal } = await import("./index.mjs"))
})
const offline = async () => { throw new Error("no network in tests") }
const real = globalThis.fetch
afterAll(() => (globalThis.fetch = real))
beforeEach(() => {
  globalThis.fetch = offline
  _internal.routes.clear()
})

// serve is the fake zcode.z.ai: route answers each request, and a request
// it doesn't answer is a 404
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
const json = (v, status = 200) => new Response(typeof v === "string" ? v : JSON.stringify(v), { status })
const jwt = (exp) => ["{}", JSON.stringify({ exp })].map((s) => Buffer.from(s).toString("base64url")).join(".") + ".sig"
const now = Math.trunc(Date.now() / 1000)
const DEVICE = "11111111-2222-4333-8444-555555555555"
const TOKEN = jwt(now + 86400)
const oauth = (state) => ({ type: "oauth", access: state.key ?? state.jwt ?? "", refresh: JSON.stringify(state), expires: 0 })
const SIGNED_IN = oauth({ site: "zai", jwt: TOKEN, device: DEVICE })
async function checkin(auth = SIGNED_IN) {
  const hooks = await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
  return hooks.auth.checkin(async () => auth, { id: "zcode" })
}

// #503: the preview of an account with nothing to claim
const PREVIEW_NONE = '{"code":0,"msg":"","data":{"plans":[],"server_time":1793318263}}'
// 10-30 (the owner's account, read for hykql's report on Discord): the
// preview of an account with nothing to claim carries no data at all
const PREVIEW_NO_DATA = '{"code":0,"msg":"","logid":"202610300535585c4e3de75769b684da87"}'
// usage.test.mjs's real preview, the day's ZCode Trust Build unclaimed
const PREVIEW_ONE = {
  code: 0, msg: "",
  data: {
    server_time: 1791216750,
    plans: [{
      user_plan_id: "upl_2107141892427358208", plan_id: "zcode-v3-start-plan-trust-1006", name: "ZCode Trust Build",
      description: "ZCode Global Build", priority: 110, status: "active", starts_at: 1791216750, ends_at: 1791302400,
      entitlements: [{ entitlement_id: "zcode-v3-start-plan-trust-1006", show_name: "GLM-5.3-Flash", meter: "model_usage",
        unit_type: "token", capabilities: ["model:glm-5.3-flash"], grant_units: 100000000, period: "one_time", priority: 110, effective_at: 0 }],
    }],
  },
}
const PREVIEW_TWO = { ...PREVIEW_ONE, data: { ...PREVIEW_ONE.data, plans: [...PREVIEW_ONE.data.plans, { plan_id: "zcode-v3-start-plan-1029", name: "ZCODE GLOBAL BUILD", status: "active" }] } }
// #503's reply to claiming a plan claimed before, as it came
const CLAIMED_BEFORE = '{"code":1003,"msg":"target already exists","data":{"server_time":1793318302,"message":"You have already claimed this plan."},"logid":"202610292358223079156af0f90065850e"}'
// a code 0 claim: only the code is read
const CLAIMED_NOW = '{"code":0,"msg":""}'
// the 10-06 answer to a claim without the app's captcha (#30)
const CAPTCHA = '{"code":3007,"msg":"captcha verify failed"}'

const PREVIEW = "/api/v1/zcode-plan/billing/preview"
const CLAIM = "/api/v1/zcode-plan/billing/claim"
const TOUCH = "/api/v1/marketing/touch"
// the marketing feed of an account with no banner up
const TOUCH_NONE = '{"code":0,"msg":"","data":{"deliveries":[]}}'
// claimWith serves the preview (and the feed, touch) and answers each
// claim with claim(plan_id)
function claimWith(preview, claim, touch = TOUCH_NONE) {
  return serve(({ url, method, body }) => {
    if (url.pathname === PREVIEW && method === "GET") return json(preview)
    if (url.pathname === TOUCH && method === "GET") return typeof touch === "function" ? touch() : json(touch)
    if (url.pathname === CLAIM && method === "POST") return claim(JSON.parse(body).plan_id)
  })
}
const claims = (calls) => calls.filter((c) => c.url.pathname === CLAIM)

// only the answer of nothing to claim is asked again: until wakes
// magpie's loop half an hour out, so a plan dropped into the feed later
// in the day is still claimed. claimed, done and captcha settle for the
// day (a claimed plan leaves the feed; a captcha plan re-asked makes
// ZCode demand its captcha again; a done plan re-asked posts a claim
// answered 1003), and a failed needs none — magpie asks a failed again
// of its own.
test("an inactive says until half an hour out; claimed, done, captcha and failed say none", async () => {
  const soon = (r) => {
    const t = Date.parse(r.until)
    expect(t).toBeGreaterThan(Date.now() + 25 * 60_000)
    expect(t).toBeLessThan(Date.now() + 35 * 60_000)
  }
  const none = (r) => expect(r.until).toBeUndefined()
  claimWith(PREVIEW_NONE, () => json(CLAIMED_NOW))
  soon(await checkin())
  claimWith(PREVIEW_ONE, () => json(CLAIMED_NOW))
  none(await checkin())
  claimWith(PREVIEW_ONE, () => json(CLAIMED_BEFORE))
  none(await checkin())
  claimWith(PREVIEW_ONE, () => json(CAPTCHA, 400))
  none(await checkin())
  claimWith("", () => json(CLAIMED_NOW))
  none(await checkin())
})

test("nothing to claim: inactive, and no claim is asked", async () => {
  const calls = claimWith(PREVIEW_NONE, () => json(CLAIMED_NOW))
  const r = await checkin()
  expect(r).toEqual({ outcome: "inactive", message: "no ZCode gift plan to claim", until: expect.any(String) })
  expect(claims(calls)).toEqual([])
  // the preview went out as the app's billing calls do
  const p = calls.find((c) => c.url.pathname === PREVIEW)
  expect(p.url.pathname).toBe(PREVIEW)
  expect(p.url.searchParams.get("app_version")).toBe("3.16.3")
  expect(p.url.searchParams.get("platform")).toBe(`${process.platform}-${process.arch}`)
  expect(p.headers.Authorization).toBe("Bearer " + TOKEN)
  expect(p.headers["X-Device-Mid"]).toBe(DEVICE)
  expect(p.headers["X-ZCode-App-Version"]).toBe("3.16.3")
  expect(p.headers["X-Platform"]).toBe(`${process.platform}-${process.arch}`)
})

test("one plan to claim, claimed with code 0", async () => {
  _internal.routes.set("\0" + TOKEN, { stale: true })
  const calls = claimWith(PREVIEW_ONE, () => json(CLAIMED_NOW))
  const r = await checkin()
  expect(r).toEqual({ outcome: "claimed", message: "claimed ZCode Trust Build" })
  const [c] = claims(calls)
  expect(claims(calls).length).toBe(1)
  expect(c.url.origin).toBe("https://zcode.z.ai")
  expect(JSON.parse(c.body)).toEqual({ plan_id: "zcode-v3-start-plan-trust-1006" })
  expect(c.headers.Authorization).toBe("Bearer " + TOKEN)
  expect(c.headers["X-Device-Mid"]).toBe(DEVICE)
  expect(c.headers["X-ZCode-App-Version"]).toBe("3.16.3")
  expect(c.headers["X-Platform"]).toBe(`${process.platform}-${process.arch}`)
  expect(c.headers["Content-Type"]).toBe("application/json")
  // the route is read again, so the next request uses the plan
  expect(_internal.routes.has("\0" + TOKEN)).toBe(false)
})

test("a plan claimed before (HTTP 200, code 1003) is done, not a failure", async () => {
  claimWith(PREVIEW_ONE, () => json(CLAIMED_BEFORE))
  expect(await checkin()).toEqual({ outcome: "done", message: "already claimed: ZCode Trust Build" })
})

test("a claim ZCode wants the app's captcha for is captcha: claimed in the ZCode app", async () => {
  claimWith(PREVIEW_ONE, () => json(CAPTCHA, 400))
  const r = await checkin()
  expect(r.outcome).toBe("captcha")
  expect(r.message).toContain("ZCode Trust Build: claim it in the ZCode app (captcha verify failed)")
})

test("a claim that doesn't read is failed (unknown), never claimed", async () => {
  for (const answer of [
    () => json("", 500),
    () => json("<html>bad gateway</html>", 502),
    () => json("not json at all"), // HTTP 200, garbled
    () => json("{}"), // no code
    () => json('{"code":0}', 500), // a code 0 on an HTTP error is no claim
    () => json('{"code":1001,"msg":"system busy"}'),
    () => { throw new Error("socket hang up") },
  ]) {
    claimWith(PREVIEW_ONE, answer)
    const r = await checkin()
    expect(r.outcome).toBe("failed")
    expect(r.message).toStartWith("ZCode Trust Build: ")
    // a failed claim never touches the account's sign-in
    expect(r.signIn).toBeUndefined()
  }
})

test("a preview with nothing in it is nothing to claim, not a failed check-in", async () => {
  for (const body of [PREVIEW_NO_DATA, '{"code":0,"msg":"","data":null}', '{"code":0,"msg":"","data":{"server_time":1793318263}}', '{"code":0,"msg":"","data":{"plans":null}}']) {
    const calls = serve(({ url }) => (url.pathname === PREVIEW ? json(body) : json(CLAIMED_NOW)))
    expect(await checkin()).toEqual({ outcome: "inactive", message: "no ZCode gift plan to claim", until: expect.any(String) })
    expect(claims(calls)).toEqual([])
  }
})

test("a preview that doesn't read is failed (unknown), and nothing is claimed", async () => {
  for (const answer of [
    () => json("", 500),
    () => json("garbled"),
    () => json('{"code":0,"data":{"plans":"zcode-v3-start-plan-1029"}}'), // a plan list that isn't a list
    () => json('{"code":0,"data":"plans"}'), // data that isn't an object
    () => json('{"code":401,"msg":"token invalid"}', 401),
    () => { throw new Error("no network in tests") },
  ]) {
    const calls = serve(({ url }) => (url.pathname === PREVIEW ? answer() : json(CLAIMED_NOW)))
    const r = await checkin()
    expect(r.outcome).toBe("failed")
    expect(r.signIn).toBeUndefined()
    expect(claims(calls)).toEqual([])
  }
})

test("one claimed and one failed is failed, naming the claimed one, so it is asked again", async () => {
  claimWith(PREVIEW_TWO, (id) => (id === "zcode-v3-start-plan-1029" ? json("", 503) : json(CLAIMED_NOW)))
  const r = await checkin()
  expect(r.outcome).toBe("failed")
  expect(r.message).toBe("claimed ZCode Trust Build; ZCODE GLOBAL BUILD: HTTP 503, unreadable reply (empty)")
  // asked again: the one claimed answers 1003 now
  claimWith(PREVIEW_TWO, (id) => (id === "zcode-v3-start-plan-1029" ? json(CLAIMED_NOW) : json(CLAIMED_BEFORE)))
  expect(await checkin()).toEqual({ outcome: "claimed", message: "claimed ZCODE GLOBAL BUILD" })
})

test("an account with no ZCode session asks nothing", async () => {
  const calls = serve(() => json(CLAIMED_NOW))
  const key = await checkin({ type: "api", key: "k", metadata: { site: "zai" } })
  expect(key.outcome).toBe("ineligible")
  const expired = await checkin(oauth({ site: "zai", jwt: jwt(now - 60), device: DEVICE }))
  expect(expired.outcome).toBe("failed")
  expect(expired.message).toContain("sign-in has expired")
  expect(expired.signIn).toBeUndefined()
  expect(calls).toEqual([])
})

// #503, 10-30 (kongbai01203): the ZCode app's claim banner comes from its
// marketing feed, and the plan is in neither /billing/preview nor
// /billing/current while the banner is up. The delivery is shaped as the
// capture describes it (data.deliveries[].banner.buttons[].action and
// banner.background.args.zcode_plan); the claim reply is the capture's own.
const WEEKEND = "zcode-v3-start-plan-1030-wk"
const touchOf = (...plans) => ({
  code: 0, msg: "",
  data: {
    deliveries: plans.map((id) => ({
      campaign_id: "2101141259813175296",
      banner: {
        background: { type: "zcode_plan", args: { zcode_plan: { plan_id: id, name: "ZCODE WEEKEND BUILD", grant_units: 500000000, period: "one_time" } } },
        buttons: [
          { text: "领取", action: { type: "claim_zcode_plan", args: { plan_id: id } } },
          { text: "关闭", action: { type: "close", args: {} } },
        ],
      },
    })),
  },
})
const CLAIMED_WEEKEND = '{"code":0,"msg":"","data":{"server_time":1793369500,"plan":{"user_plan_id":"upl_2116171180260274176","plan_id":"zcode-v3-start-plan-1030-wk","name":"ZCODE WEEKEND BUILD","description":"","priority":101,"status":"active","starts_at":1793369500,"ends_at":1793581200,"entitlements":[{"entitlement_id":"ent-zcode-v3-start-plan-1030-wk-1","show_name":"GLM-5.3-Flash","meter":"model_usage","unit_type":"token","capabilities":["model:glm-5.3-flash"],"grant_units":500000000,"period":"one_time","priority":101,"effective_at":1793372400}]},"message":"Plan claimed successfully."},"logid":"202610301411405bf5f9f3da141d910e7e"}'

test("a banner plan the preview doesn't list is claimed from the app's marketing feed", async () => {
  const calls = claimWith(PREVIEW_NO_DATA, (id) => (id === WEEKEND ? json(CLAIMED_WEEKEND) : json("", 404)), touchOf(WEEKEND))
  expect(await checkin()).toEqual({ outcome: "claimed", message: "claimed ZCODE WEEKEND BUILD" })
  expect(claims(calls).map((c) => JSON.parse(c.body))).toEqual([{ plan_id: WEEKEND }])
  // the feed went out as the app asks it
  const t = calls.find((c) => c.url.pathname === TOUCH)
  expect(t.method).toBe("GET")
  expect(Number(t.url.searchParams.get("seq"))).toBeGreaterThanOrEqual(0)
  expect(t.headers.Authorization).toBe("Bearer " + TOKEN)
  expect(t.headers["X-Device-Mid"]).toBe(DEVICE)
  expect(t.headers["X-ZCode-App-Version"]).toBe("3.16.3")
  expect(t.headers["X-Client-Language"]).toBeTruthy()
  // asked again, the plan answers 1003: done
  claimWith(PREVIEW_NO_DATA, () => json(CLAIMED_BEFORE), touchOf(WEEKEND))
  expect(await checkin()).toEqual({ outcome: "done", message: "already claimed: ZCODE WEEKEND BUILD" })
})

test("a plan both lists name is claimed once", async () => {
  const both = { code: 0, msg: "", data: { plans: [{ plan_id: WEEKEND, name: "ZCODE WEEKEND BUILD" }] } }
  const calls = claimWith(both, () => json(CLAIMED_WEEKEND), touchOf(WEEKEND))
  expect((await checkin()).outcome).toBe("claimed")
  expect(claims(calls)).toHaveLength(1)
})

test("a feed with no claim button, or nothing in it, is nothing to claim", async () => {
  const closeOnly = { code: 0, msg: "", data: { deliveries: [{ campaign_id: "1", banner: { buttons: [{ action: { type: "close", args: {} } }] } }] } }
  for (const feed of [TOUCH_NONE, '{"code":0,"msg":""}', closeOnly]) {
    const calls = claimWith(PREVIEW_NO_DATA, () => json(CLAIMED_NOW), feed)
    expect(await checkin()).toEqual({ outcome: "inactive", message: "no ZCode gift plan to claim", until: expect.any(String) })
    expect(claims(calls)).toEqual([])
  }
})

test("a feed that doesn't read is failed (unknown), never nothing to claim", async () => {
  for (const feed of [
    () => json("", 500),
    () => json("garbled"),
    () => json('{"code":0,"data":{"deliveries":"x"}}'),
    () => { throw new Error("no network in tests") },
  ]) {
    claimWith(PREVIEW_NO_DATA, () => json(CLAIMED_NOW), feed)
    const r = await checkin()
    expect(r.outcome).toBe("failed")
    expect(r.signIn).toBeUndefined()
  }
  // a preview plan is still claimed beside it, and the check-in is asked again
  const calls = claimWith(PREVIEW_ONE, () => json(CLAIMED_NOW), () => json("", 502))
  const r = await checkin()
  expect(r.outcome).toBe("failed")
  expect(r.message).toStartWith("claimed ZCode Trust Build; gift plans to claim: ")
  expect(claims(calls)).toHaveLength(1)
})

// #503, 10-30 22:11 +08:00 (kongbai01203, comment 6526694290): the real
// marketing/touch reply for the account that claimed ZCODE WEEKEND BUILD,
// in testdata/touch-1030-wk.json. The bytes are the reporter's own, but
// their paste was cut short inside success_popup.description.content's
// HTML (2510 of 2628 characters); only the closing `"}}}}]}}` that string
// and the objects it was in need is added, and the reporter's "…" mark
// taken off. What the real reply has that touchOf above doesn't: a close
// button with "args": null, button text as {format, content}, a bundle
// background, resource_position and priority, and a success_popup whose
// own buttons (navigate, copy_text) and hero repeat the zcode_plan.
const TOUCH_REAL = readFileSync(new URL("./testdata/touch-1030-wk.json", import.meta.url), "utf8")

test("the real banner feed: its one claim button is claimed, by the plan's name", async () => {
  const calls = claimWith(PREVIEW_NO_DATA, (id) => (id === WEEKEND ? json(CLAIMED_WEEKEND) : json("", 404)), TOUCH_REAL)
  expect(await checkin()).toEqual({ outcome: "claimed", message: "claimed ZCODE WEEKEND BUILD" })
  // one claim, of the claim button's plan_id, with the body the app sends;
  // the close button and the success popup's buttons claim nothing
  expect(claims(calls).map((c) => c.body)).toEqual(['{"plan_id":"zcode-v3-start-plan-1030-wk"}'])
  const [c] = claims(calls)
  expect(c.headers.Authorization).toBe("Bearer " + TOKEN)
  expect(c.headers["X-Device-Mid"]).toBe(DEVICE)
  // nothing is sent back to the feed (marketing/touch/action is the
  // banner's confirm/close, not a claim)
  expect(calls.filter((x) => x.method !== "GET").map((x) => x.url.pathname)).toEqual([CLAIM])
})

test("the real delivery without its claim button is nothing to claim", async () => {
  const feed = JSON.parse(TOUCH_REAL)
  const banner = feed.data.deliveries[0].banner
  banner.buttons = banner.buttons.filter((b) => b.action.type !== "claim_zcode_plan")
  expect(banner.buttons.map((b) => b.action.type)).toEqual(["close"])
  // the zcode_plan it still describes (background, success popup) is no
  // offer to claim
  expect(JSON.stringify(feed)).toContain('"zcode_plan":{"plan_id":"zcode-v3-start-plan-1030-wk"')
  const calls = claimWith(PREVIEW_NO_DATA, () => json(CLAIMED_WEEKEND), feed)
  expect(await checkin()).toEqual({ outcome: "inactive", message: "no ZCode gift plan to claim", until: expect.any(String) })
  expect(claims(calls)).toEqual([])
})

test("after the claim the feed has no delivery: nothing to claim, not a failure", async () => {
  // kongbai01203's second finding (10-30): once claimed, the campaign leaves
  // the account's deliveries while its window is still open (to 11-02
  // 09:00). The count (0) is theirs; these bytes are the real reply's
  // top level with its deliveries emptied. magpie keeps the day's claim
  // (checkin.go, claimedOn) over this later inactive.
  const after = JSON.parse(TOUCH_REAL)
  after.data.deliveries = []
  const calls = claimWith(PREVIEW_NO_DATA, () => json(CLAIMED_WEEKEND), after)
  expect(await checkin()).toEqual({ outcome: "inactive", message: "no ZCode gift plan to claim", until: expect.any(String) })
  expect(claims(calls)).toEqual([])
})
