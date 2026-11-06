// auth.checkin claims the gift plans the app's marketing feed (touch)
// offers for an account (magpie-community/plugins#503). The feed and the
// "already claimed" replies are real (#503's captures of 10-29 and 10-30,
// touch-1030-wk.json, the 10-06 preview in usage.test.mjs); the code 0
// claim reply has not been seen yet, so its fixture carries only the
// code. The v3.17 client replaced the old preview polling with the feed
// alone (docs/marketing-touch-client.md), so the preview is read no
// more; the rewards center's gifts are website-side — claimed in the
// client, spent here by freeFirst once they land on the account.
import { test, expect, afterAll, beforeAll, beforeEach } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { readFileSync, realpathSync } from "node:fs"

let ZCodeAuthPlugin, _internal, resetRateWait
beforeAll(async () => {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ ZCodeAuthPlugin, _internal, resetRateWait } = await import("./index.mjs"))
})
const offline = async () => { throw new Error("no network in tests") }
const real = globalThis.fetch
afterAll(() => (globalThis.fetch = real))
beforeEach(() => {
  globalThis.fetch = offline
  _internal.routes.clear()
  resetRateWait() // each test starts with no hold of its own (they share an account key)
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
// jsonWith is json with headers: a Retry-After comes as one
const jsonWith = (v, status, headers) => new Response(typeof v === "string" ? v : JSON.stringify(v), { status, headers })
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
// #503's reply to claiming a plan claimed before, as it came
const CLAIMED_BEFORE = '{"code":1003,"msg":"target already exists","data":{"server_time":1793318302,"message":"You have already claimed this plan."},"logid":"202610292358223079156af0f90065850e"}'
// a code 0 claim: only the code is read
const CLAIMED_NOW = '{"code":0,"msg":""}'
// the 10-06 answer to a claim without the app's captcha (#30)
const CAPTCHA = '{"code":3007,"msg":"captcha verify failed"}'
// 11-04: the answer to a claim for a plan the account is not offered yet.
// The same six accounts answered it under an older APP_VERSION's header
// and four of them claimed with code 0 under 3.17.2's.
const NOT_ELIGIBLE = '{"code":1004,"msg":"your account is not eligible for this plan yet"}'
// 11-04 (#503, MiniFullC): what ZCode says to a client that asked too
// often, with HTTP 429 — read 180 times over four days at magpie's
// 30-minute retry
const RATE_LIMITED = '{"code":3002,"msg":"请求过于频繁"}'

const PREVIEW = "/api/v1/zcode-plan/billing/preview"
const CLAIM = "/api/v1/zcode-plan/billing/claim"
const TOUCH = "/api/v1/marketing/touch"
// the marketing feed of an account with no banner up
const TOUCH_NONE = '{"code":0,"msg":"","data":{"deliveries":[]}}'
// claimWith serves the feed (touch) and answers each claim with
// claim(plan_id). The preview is served with a forever-broken answer: the
// v3.17 client reads it no more, and a check-in that still did would fail.
function claimWith(claim, touch = TOUCH_NONE) {
  return serve(({ url, method, body }) => {
    if (url.pathname === PREVIEW && method === "GET") return json("", 500)
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
  claimWith(() => json(CLAIMED_NOW))
  soon(await checkin())
  claimWith(() => json(CLAIMED_NOW), touchOf(WEEKEND))
  none(await checkin())
  claimWith(() => json(CLAIMED_BEFORE), touchOf(WEEKEND))
  none(await checkin())
  claimWith(() => json(CAPTCHA, 400), touchOf(WEEKEND))
  none(await checkin())
  // a plan not offered now can be offered later in the day: read again
  claimWith(() => json(NOT_ELIGIBLE), touchOf(WEEKEND))
  soon(await checkin())
  // a failed check-in settles for none: magpie asks a failed again itself
  claimWith(() => json(CLAIMED_NOW), () => { throw new Error("feed unreachable") })
  none(await checkin())
})

test("nothing to claim: inactive, and no claim is asked", async () => {
  const calls = claimWith(() => json(CLAIMED_NOW))
  const r = await checkin()
  expect(r).toEqual({ outcome: "inactive", message: "no ZCode gift plan to claim", until: expect.any(String) })
  expect(claims(calls)).toEqual([])
  // the touch feed went out as the app's billing calls do (the seq counts
  // up across the process's asks)
  const t = calls.find((c) => c.url.pathname === TOUCH)
  expect(Number(t.url.searchParams.get("seq"))).toBeGreaterThanOrEqual(0)
  expect(t.headers.Authorization).toBe("Bearer " + TOKEN)
  expect(t.headers["X-Device-Mid"]).toBe(DEVICE)
  expect(t.headers["X-ZCode-App-Version"]).toBe("3.17.2")
  expect(t.headers["X-Client-Language"]).toBeTruthy()
})

// the v3.17 client replaced the preview polling with the feed alone
// (docs/marketing-touch-client.md), so whatever the preview answers is
// nothing to claim, and it is not asked at all
test("the preview is not read anymore", async () => {
  for (const answer of [
    PREVIEW_NONE,
    PREVIEW_NO_DATA,
    () => json(PREVIEW_ONE),
    () => json("", 500),
    () => json("garbled"),
    () => json('{"code":401,"msg":"token invalid"}', 401),
    () => { throw new Error("no network in tests") },
  ]) {
    const calls = serve(({ url }) => (url.pathname === PREVIEW ? (typeof answer === "function" ? answer() : json(answer)) : json(CLAIMED_NOW)))
    expect(await checkin()).toEqual({ outcome: "inactive", message: "no ZCode gift plan to claim", until: expect.any(String) })
    expect(calls.filter((c) => c.url.pathname === PREVIEW)).toHaveLength(0)
    expect(claims(calls)).toEqual([])
  }
})

test("one plan to claim, claimed with code 0", async () => {
  _internal.routes.set("\0" + TOKEN, { stale: true })
  const calls = claimWith(() => json(CLAIMED_NOW), touchOf([TRUST, "ZCode Trust Build"]))
  const r = await checkin()
  expect(r).toEqual({ outcome: "claimed", message: "claimed ZCode Trust Build" })
  const [c] = claims(calls)
  expect(claims(calls).length).toBe(1)
  expect(c.url.origin).toBe("https://zcode.z.ai")
  expect(JSON.parse(c.body)).toEqual({ plan_id: TRUST })
  expect(c.headers.Authorization).toBe("Bearer " + TOKEN)
  expect(c.headers["X-Device-Mid"]).toBe(DEVICE)
  expect(c.headers["X-ZCode-App-Version"]).toBe("3.17.2")
  expect(c.headers["X-Platform"]).toBe(`${process.platform}-${process.arch}`)
  expect(c.headers["Content-Type"]).toBe("application/json")
  // the route is read again, so the next request uses the plan
  expect(_internal.routes.has("\0" + TOKEN)).toBe(false)
})

test("a plan claimed before (HTTP 200, code 1003) is done, not a failure", async () => {
  claimWith(() => json(CLAIMED_BEFORE), touchOf([TRUST, "ZCode Trust Build"]))
  expect(await checkin()).toEqual({ outcome: "done", message: "already claimed: ZCode Trust Build" })
})

test("a claim ZCode wants the app's captcha for is captcha: claimed in the ZCode app", async () => {
  claimWith(() => json(CAPTCHA, 400), touchOf([TRUST, "ZCode Trust Build"]))
  const r = await checkin()
  expect(r.outcome).toBe("captcha")
  expect(r.message).toContain("ZCode Trust Build: claim it in the ZCode app (captcha verify failed)")
})

test("a claim ZCode is not offering yet (code 1004) is ineligible, read again later", async () => {
  claimWith(() => json(NOT_ELIGIBLE), touchOf([TRUST, "ZCode Trust Build"]))
  const r = await checkin()
  expect(r.outcome).toBe("ineligible")
  expect(r.message).toBe("ZCode Trust Build: your account is not eligible for this plan yet")
  const t = Date.parse(r.until)
  expect(t).toBeGreaterThan(Date.now() + 25 * 60_000)
  expect(t).toBeLessThan(Date.now() + 35 * 60_000)
})

test("a 1004 beside a claimed plan is claimed, naming the one not offered", async () => {
  claimWith((id) => (id === GLOBAL ? json(NOT_ELIGIBLE) : json(CLAIMED_NOW)), touchOf([TRUST, "ZCode Trust Build"], [GLOBAL, "ZCODE GLOBAL BUILD"]))
  const r = await checkin()
  expect(r.outcome).toBe("claimed")
  expect(r.message).toContain("ZCODE GLOBAL BUILD: your account is not eligible for this plan yet")
})

test("a rate-limited feed is failed with an until half an hour out", async () => {
  claimWith(() => json(CLAIMED_NOW), () => json("", 429))
  const r = await checkin()
  expect(r.outcome).toBe("failed")
  expect(r.message).toContain("Too Many Requests")
  const t = Date.parse(r.until)
  expect(t).toBeGreaterThan(Date.now() + 25 * 60_000)
  expect(t).toBeLessThan(Date.now() + 35 * 60_000)
})

// the hold itself: magpie asks a failed again after 30 minutes of its own
// whatever `until` says, so the plugin must be the one that waits
test("a check-in inside the wait asks ZCode nothing, and answers the failed it gave", async () => {
  const calls = claimWith(() => json(CLAIMED_NOW), () => json("", 429))
  const first = await checkin()
  expect(first.outcome).toBe("failed")
  const asked = calls.length // what the first read spent
  const again = await checkin()
  expect(again.outcome).toBe("failed")
  expect(again.message).toBe(first.message) // the same failed, replayed
  expect(again.until).toBe(first.until)
  expect(calls.length).toBe(asked) // not one request more
})

test("a check-in after the wait reaches ZCode again", async () => {
  const calls = claimWith(() => json(CLAIMED_NOW), () => json("", 429))
  await checkin()
  const asked = calls.length
  resetRateWait(true) // stand where the wait has passed
  await checkin()
  expect(calls.length).toBeGreaterThan(asked)
})

test("a Retry-After ZCode sent is honored", async () => {
  claimWith(() => json(CLAIMED_NOW), () => jsonWith("", 429, { "retry-after": "7200" }))
  const r = await checkin()
  expect(r.outcome).toBe("failed")
  const t = Date.parse(r.until)
  expect(t).toBeGreaterThan(Date.now() + 110 * 60_000)
  expect(t).toBeLessThan(Date.now() + 130 * 60_000)
})

test("a claim ZCode rate limited (3002) is failed and held too", async () => {
  claimWith(() => json(RATE_LIMITED, 400), touchOf([TRUST, "ZCode Trust Build"]))
  const r = await checkin()
  expect(r.outcome).toBe("failed")
  expect(r.message).toContain("ZCode Trust Build: 请求过于频繁")
  expect(Date.parse(r.until)).toBeGreaterThan(Date.now() + 25 * 60_000)
})

// stateOf gives a sign-in that has a jwt and no API key (the
// Start-Plan-only accounts that claim gift plans) key: "", so a hold keyed
// by the key alone would answer for every one of them
test("another keyless sign-in still reaches ZCode while one is held", async () => {
  claimWith(() => json(CLAIMED_NOW), () => json("", 429))
  expect((await checkin()).outcome).toBe("failed") // the first account is held
  const other = claimWith(() => json(CLAIMED_NOW), touchOf([TRUST, "ZCode Trust Build"]))
  const r = await checkin(oauth({ site: "zai", jwt: jwt(now + 86401), device: DEVICE }))
  expect(other.length).toBeGreaterThan(0) // asked ZCode all the same
  expect(r.outcome).toBe("claimed")
})

test("a claim ZCode keeps limiting waits longer each time", async () => {
  claimWith(() => json(RATE_LIMITED, 400), touchOf([TRUST, "ZCode Trust Build"]))
  const first = Date.parse((await checkin()).until)
  resetRateWait(true) // the wait passed, so the next claim reaches ZCode
  claimWith(() => json(RATE_LIMITED, 400), touchOf([TRUST, "ZCode Trust Build"]))
  const second = Date.parse((await checkin()).until)
  expect(second - first).toBeGreaterThan(20 * 60_000) // ~30 min -> ~60 min
})

test("the wait doubles while ZCode keeps turning the ask away, and a read that comes through forgets it", async () => {
  claimWith(() => json(CLAIMED_NOW), () => json("", 429))
  const first = Date.parse((await checkin()).until)
  resetRateWait(true) // the wait passed, so the next ask reaches ZCode
  const second = Date.parse((await checkin()).until)
  expect(second - first).toBeGreaterThan(20 * 60_000) // ~30 min -> ~60 min
  // a read that comes through (nothing to claim) forgets the wait
  resetRateWait(true)
  claimWith(() => json(CLAIMED_NOW), TOUCH_NONE)
  expect((await checkin()).outcome).toBe("inactive")
  claimWith(() => json(CLAIMED_NOW), () => json("", 429))
  expect(Date.parse((await checkin()).until)).toBeLessThan(Date.now() + 35 * 60_000)
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
    claimWith(answer, touchOf([TRUST, "ZCode Trust Build"]))
    const r = await checkin()
    expect(r.outcome).toBe("failed")
    expect(r.message).toStartWith("ZCode Trust Build: ")
    // a failed claim never touches the account's sign-in
    expect(r.signIn).toBeUndefined()
  }
})

test("one claimed and one failed is failed, naming the claimed one, so it is asked again", async () => {
  claimWith((id) => (id === GLOBAL ? json("", 503) : json(CLAIMED_NOW)), touchOf([TRUST, "ZCode Trust Build"], [GLOBAL, "ZCODE GLOBAL BUILD"]))
  const r = await checkin()
  expect(r.outcome).toBe("failed")
  expect(r.message).toBe("claimed ZCode Trust Build; ZCODE GLOBAL BUILD: HTTP 503, unreadable reply (empty)")
  // asked again: the one claimed answers 1003 now
  claimWith((id) => (id === GLOBAL ? json(CLAIMED_NOW) : json(CLAIMED_BEFORE)), touchOf([TRUST, "ZCode Trust Build"], [GLOBAL, "ZCODE GLOBAL BUILD"]))
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
const TRUST = "zcode-v3-start-plan-trust-1006"
const GLOBAL = "zcode-v3-start-plan-1029"
// touchOf is a feed whose banners each claim one plan: an entry is a
// plan_id, or [plan_id, name]
const touchOf = (...plans) => ({
  code: 0, msg: "",
  data: {
    deliveries: plans.map((p) => {
      const [id, name = "ZCODE WEEKEND BUILD"] = Array.isArray(p) ? p : [p]
      return {
        campaign_id: "2101141259813175296",
        banner: {
          background: { type: "zcode_plan", args: { zcode_plan: { plan_id: id, name, grant_units: 500000000, period: "one_time" } } },
          buttons: [
            { text: "领取", action: { type: "claim_zcode_plan", args: { plan_id: id } } },
            { text: "关闭", action: { type: "close", args: {} } },
          ],
        },
      }
    }),
  },
})
const CLAIMED_WEEKEND = '{"code":0,"msg":"","data":{"server_time":1793369500,"plan":{"user_plan_id":"upl_2116171180260274176","plan_id":"zcode-v3-start-plan-1030-wk","name":"ZCODE WEEKEND BUILD","description":"","priority":101,"status":"active","starts_at":1793369500,"ends_at":1793581200,"entitlements":[{"entitlement_id":"ent-zcode-v3-start-plan-1030-wk-1","show_name":"GLM-5.3-Flash","meter":"model_usage","unit_type":"token","capabilities":["model:glm-5.3-flash"],"grant_units":500000000,"period":"one_time","priority":101,"effective_at":1793372400}]},"message":"Plan claimed successfully."},"logid":"202610301411405bf5f9f3da141d910e7e"}'

test("a banner plan is claimed from the app's marketing feed", async () => {
  const calls = claimWith((id) => (id === WEEKEND ? json(CLAIMED_WEEKEND) : json("", 404)), touchOf(WEEKEND))
  expect(await checkin()).toEqual({ outcome: "claimed", message: "claimed ZCODE WEEKEND BUILD" })
  expect(claims(calls).map((c) => JSON.parse(c.body))).toEqual([{ plan_id: WEEKEND }])
  // the feed went out as the app asks it
  const t = calls.find((c) => c.url.pathname === TOUCH)
  expect(t.method).toBe("GET")
  expect(Number(t.url.searchParams.get("seq"))).toBeGreaterThanOrEqual(0)
  expect(t.headers.Authorization).toBe("Bearer " + TOKEN)
  expect(t.headers["X-Device-Mid"]).toBe(DEVICE)
  expect(t.headers["X-ZCode-App-Version"]).toBe("3.17.2")
  expect(t.headers["X-Client-Language"]).toBeTruthy()
  // asked again, the plan answers 1003: done
  claimWith(() => json(CLAIMED_BEFORE), touchOf(WEEKEND))
  expect(await checkin()).toEqual({ outcome: "done", message: "already claimed: ZCODE WEEKEND BUILD" })
})

test("a feed with no claim button, or nothing in it, is nothing to claim", async () => {
  const closeOnly = { code: 0, msg: "", data: { deliveries: [{ campaign_id: "1", banner: { buttons: [{ action: { type: "close", args: {} } }] } }] } }
  for (const feed of [TOUCH_NONE, '{"code":0,"msg":""}', closeOnly]) {
    const calls = claimWith(() => json(CLAIMED_NOW), feed)
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
    claimWith(() => json(CLAIMED_NOW), feed)
    const r = await checkin()
    expect(r.outcome).toBe("failed")
    expect(r.signIn).toBeUndefined()
  }
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
  const calls = claimWith((id) => (id === WEEKEND ? json(CLAIMED_WEEKEND) : json("", 404)), TOUCH_REAL)
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
  const calls = claimWith(() => json(CLAIMED_WEEKEND), feed)
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
  const calls = claimWith(() => json(CLAIMED_WEEKEND), after)
  expect(await checkin()).toEqual({ outcome: "inactive", message: "no ZCode gift plan to claim", until: expect.any(String) })
  expect(claims(calls)).toEqual([])
})

// ZCode names only zh-CN or en-US to the feed (marketingTouchService's
// localeSchema in zai-org/ZCode@a9fe401); a computer set to another
// locale asked with it as it was
test("the feed is asked in zh-CN or en-US only, as the app asks it", async () => {
  const realDTF = Intl.DateTimeFormat
  try {
    for (const [locale, want] of [["zh-Hans-CN", "zh-CN"], ["zh-TW", "zh-CN"], ["zh-CN", "zh-CN"], ["en-GB", "en-US"], ["ja-JP", "en-US"], ["", "en-US"]]) {
      Intl.DateTimeFormat = function () { return { resolvedOptions: () => ({ locale }) } }
      const calls = claimWith(() => json("", 404))
      await checkin()
      expect([locale, calls.find((c) => c.url.pathname === TOUCH).headers["X-Client-Language"]]).toEqual([locale, want])
    }
  } finally {
    Intl.DateTimeFormat = realDTF
  }
})
