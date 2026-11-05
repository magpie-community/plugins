import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeCNAuthPlugin, TraeGlobalAuthPlugin } from "./index.mjs"
import { fakeTrae, json, signedIn } from "./fake.mjs"

let f
afterEach(() => f?.close())
const STATUS = "/trae/api/v2/ug/checkin_credits/status"
const CLAIM = "/trae/api/v2/ug/checkin_credits/claim"

async function checkin(plugin = TraeCNAuthPlugin, auth = signedIn(), client = {}) {
  const hooks = await plugin({ client })
  return hooks.auth.checkin(async () => auth)
}

// claimable is a day that is not in until the claim lands: the status
// answers checked_in false, then true once the claim has been made — as
// Trae's does, and as the plugin's read-back after a claim reads it.
// claimRoute answers the claim itself; day is what the status says.
function claimable(day = {}, claimRoute = () => json({ code: 0 })) {
  let claimed = false
  f.route("POST " + STATUS, () => json({ code: 0, enable: true, checked_in: claimed, ...day }))
  f.route("POST " + CLAIM, () => { claimed = true; return claimRoute() })
}

test("a claim answering extra_credits alone is claimed with that credit", async () => {
  f = fakeTrae()
  // credits absent: Number(undefined) is NaN, and NaN + 20 read as no credit
  claimable({ credits: 0 }, () => json({ code: 0, extra_credits: 20 }))
  expect(await checkin()).toEqual({ outcome: "claimed", credit: 20 })
})

test("a claim answering neither credit says so, and the status's is the fallback", async () => {
  f = fakeTrae()
  claimable({ credits: 30 })
  expect(await checkin()).toEqual({ outcome: "claimed", credit: 30 })
  f.close()
  f = fakeTrae()
  claimable()
  expect(await checkin()).toEqual({ outcome: "claimed" })
})

// zhujiu on magpie's Discord (10-25): a check-in shown as 200 points, when
// the account got 100. The status is a real account's (yetone/magpie#808),
// the claim's answer Trae CN's real one (plugins#194): it names no credit,
// so the status's stands in, and its extra_credits is not added on top.
test("a claim with no credit of its own is the status's credits, not credits plus extra_credits", async () => {
  f = fakeTrae()
  claimable({ credits: 100, did_checked_in: false, extra_credits: 100 }, () => json({ code: 0, message: "success" }))
  expect(await checkin()).toEqual({ outcome: "claimed", credit: 100 })
})

test("a claim naming both credits and extra_credits is its credits, once", async () => {
  f = fakeTrae()
  claimable({ credits: 100, extra_credits: 100 }, () => json({ code: 0, credits: 100, extra_credits: 100 }))
  expect(await checkin()).toEqual({ outcome: "claimed", credit: 100 })
})

test("an already-checked day with extra_credits is its credits", async () => {
  f = fakeTrae()
  f.route("POST " + STATUS, () => json({ checked_in: true, code: 0, credits: 100, did_checked_in: true, enable: true, extra_credits: 100 }))
  expect(await checkin()).toEqual({ outcome: "done", credit: 100 })
})

test("a claimable day is claimed through Trae's own pages", async () => {
  f = fakeTrae()
  claimable({}, () => json({ code: 0, credits: 100 }))
  expect(await checkin()).toEqual({ outcome: "claimed", credit: 100 })
  // the status before the claim, the claim, and the status that reads the
  // day back: a claim's code 0 is not the answer by itself
  expect(f.seen.map((r) => r.path)).toEqual([STATUS, CLAIM, STATUS])
  for (const r of f.seen) {
    expect(r.json).toEqual({ req_source: 1 })
    expect(r.headers.get("authorization")).toBe("Cloud-IDE-JWT jwt-1")
  }
})

test("an already-checked day is done without claiming", async () => {
  f = fakeTrae()
  f.route("POST " + STATUS, () => json({ code: 0, enable: true, checked_in: true, credits: 100 }))
  expect(await checkin()).toEqual({ outcome: "done", credit: 100 })
  expect(f.seen.map((r) => r.path)).toEqual([STATUS])
})

test("a disabled day is inactive", async () => {
  f = fakeTrae()
  f.route("POST " + STATUS, () => json({ code: 0, enable: false }))
  expect(await checkin()).toEqual({ outcome: "inactive" })
  expect(f.seen.map((r) => r.path)).toEqual([STATUS])
})

test("the device's already-checked answer is ineligible", async () => {
  f = fakeTrae()
  f.route("POST " + STATUS, () => json({ code: 0, enable: true, checked_in: false }))
  f.route("POST " + CLAIM, () => json({ code: 9095, message: "this device has checked in today", credits: 100 }))
  // which device it was is said too (plugins#436): no client here, so
  // magpie's own
  const out = await checkin()
  expect(out).toEqual({ outcome: "ineligible", message: "this device has checked in today (sent on magpie's own device for this account: no Trae CN client profile was found on this machine)" })
})

// 9074 is not "the pool is busy": the same account, token and headers were
// taken on a 16-digit id where a 19-digit one got 9074 (plugins#194), and
// on 2026-10-23 the same account and headers were taken on a device id Trae
// had never seen while this account's own id answered 9074. The account is
// told what Trae said and that the device is what it refused — not sent to
// check in in Trae CN's app, which is not where the problem is. Signing the
// account in to a client here is the one thing seen to change it, but it
// hasn't been tried on a real account, so the message doesn't promise it;
// and on a claim that already rode a client's device there is nothing to
// advise, so it says nothing.
test("Trae's 9074 on the claim says the device is what Trae refused, and promises no fix", async () => {
  f = fakeTrae()
  f.route("POST " + STATUS, () => json({ code: 0, enable: true, checked_in: false }))
  f.route("POST " + CLAIM, () => json({ code: 9074, message: "当前参与用户太多" }))
  const out = await checkin()
  expect(out.outcome).toBe("ineligible")
  expect(out.message).toContain("当前参与用户太多")
  expect(out.message).toContain("9074")
  expect(out.message).toContain("device")
  // it says which device it went on, and advises nothing (plugins#436)
  expect(out.message).toContain("sent on magpie's own device for this account")
  expect(out.message).not.toMatch(/sign (it )?in|log ?in|check in in the Trae CN app/i)
  // the check-in rides ugDevice like every other ug page: the 19-digit
  // sign-in device becomes the account's own 15-digit shape (#194,
  // plugins#709); the
  // one claim more goes on the id made from the uid (plugins#709, #722)
  expect(f.seen.map((r) => r.headers.get("x-device-id"))).toEqual(["166487253502651", "166487253502651", "422507670212903"])
})

// plugins#709 and #722: with no Trae CN client on the machine, Trae CN
// answers the plugin's claim 9074 every day, while three tools that check
// the same accounts in with no client are taken first time — trae-mate,
// providers-hub (#722's reporter, daily) and wild-work (#709's log: no
// 9074 at all, so its 8s retry never ran). A 9074 there is claimed once
// more, at once, in trae-mate's request: body {}, x-user-region CN, its
// headers, and the 15-digit id it makes from the uid. The bytes are #709's
// literal 9074 and Trae CN's real success (plugins#194).
const REFUSED = '{"code":9074,"message":"当前参与用户太多，请稍后再试"}'
const raw = (text) => new Response(text, { headers: { "content-type": "application/json" } })
const shaped = (r) => r.headers.get("user-agent") === "VSCode 1.107.1 (TRAE SOLO CN)"

test("a 9074 with no client here is claimed once more in the client-less tools' request, and taken", async () => {
  f = fakeTrae()
  let claimed = false
  f.route("POST " + STATUS, () => json({ code: 0, enable: true, checked_in: claimed, credits: 100 }))
  f.route("POST " + CLAIM, (r) => {
    if (!shaped(r)) return raw(REFUSED)
    claimed = true
    return raw('{"code":0,"message":"success"}')
  })
  expect(await checkin()).toEqual({ outcome: "claimed", credit: 100 })
  expect(f.seen.map((r) => r.path)).toEqual([STATUS, CLAIM, CLAIM, STATUS])
  const second = f.seen[2]
  expect(second.json).toEqual({})
  const h = Object.fromEntries(second.headers)
  // trae-mate's device_map.rs ids for uid "u-1", worked out apart from the plugin
  expect(h["x-device-id"]).toBe("422507670212903")
  expect(h["x-market-user-id"]).toBe("f8c30378-f888-4639-bdd1-9e53e2d66f48")
  expect(h["vscode-sessionid"]).toBe("d169d4eac9d32be67855cbec44a37e20b06b57dc68b4e252edace023e037e7e7")
  expect(h).toMatchObject({
    authorization: "Cloud-IDE-JWT jwt-1",
    "x-user-region": "CN",
    "x-market-client-id": "VSCode 1.107.1",
    "x-lgw-req-sdk-type": "3",
    "package-type": "stable_cn",
    "x-lscbd-aid": "787976",
    "x-lscbd-platform": "windows",
    "app-version": "0.1.45",
    "accept-language": "zh-CN",
  })
  expect(h["x-tt-trace-id"]).toMatch(/^00-[0-9a-f]{16}-01$/)
  expect(h["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/)
  // none of the IDE's device headers, nor the chat's
  for (const k of ["x-app-version", "x-device-brand", "x-device-type", "x-os-version", "x-uid", "x-ide-token"]) expect(h[k]).toBeUndefined()
  // the read-back after it goes as before
  expect(f.seen[3].headers.get("x-device-id")).toBe("166487253502651")
})

test("a second 9074 is the day's answer: two claims, never a third", async () => {
  f = fakeTrae()
  f.route("POST " + STATUS, () => json({ code: 0, enable: true, checked_in: false }))
  f.route("POST " + CLAIM, () => raw(REFUSED))
  const out = await checkin()
  expect(out.outcome).toBe("ineligible")
  expect(out.message).toContain("(9074)")
  expect(out.message).toContain("claimed again")
  expect(f.seen.map((r) => r.path)).toEqual([STATUS, CLAIM, CLAIM])
  expect(f.seen.map(shaped)).toEqual([false, false, true])
})

test("only a 9074 is claimed again: another refusal is one claim", async () => {
  for (const answer of ['{"code":9095,"message":"当前设备今日已经签到"}', '{"code":1005,"message":"x"}', '{"code":9004,"message":"x"}']) {
    f = fakeTrae()
    f.route("POST " + STATUS, () => json({ code: 0, enable: true, checked_in: false }))
    f.route("POST " + CLAIM, () => raw(answer))
    await checkin()
    expect(f.seen.map((r) => r.path)).toEqual([STATUS, CLAIM])
    f.close()
    f = undefined
  }
})

test("an account with no uid is not claimed again", async () => {
  f = fakeTrae()
  f.route("POST " + STATUS, () => json({ code: 0, enable: true, checked_in: false }))
  f.route("POST " + CLAIM, () => raw(REFUSED))
  expect((await checkin(TraeCNAuthPlugin, signedIn({ uid: "" }))).outcome).toBe("ineligible")
  expect(f.seen.map((r) => r.path)).toEqual([STATUS, CLAIM])
})

// a claim's code 0 is not the answer: Trae answers it for a claim that
// registered nothing, so the status is read back after it
test("a claim answered success that didn't land is the day's answer, not a retry", async () => {
  f = fakeTrae()
  f.route("POST " + STATUS, () => json({ code: 0, enable: true, checked_in: false }))
  f.route("POST " + CLAIM, () => json({ code: 0, credits: 100 }))
  const out = await checkin()
  expect(out).toMatchObject({ outcome: "ineligible" })
  expect(out.message).toContain("not in")
  // the status before the claim, the claim, and the read-back that found
  // the day still out
  expect(f.seen.map((r) => r.path)).toEqual([STATUS, CLAIM, STATUS])
})

// ineligible, not failed: magpie retries a failed check-in with backoff for
// the rest of the day and each retry is another claim, so a claim answered
// code 0 while the status still says the day is out — this plugin's own
// premise for an account Trae keeps refusing — would claim many times a day,
// and a status that lags a claim that did land would read as not in once and
// claim again. An ineligible is the day's answer in magpie's eyes: it asks
// that account no more until tomorrow, and only reads its status, so a lag
// that catches up within the day still reads as done.
test("a claim that didn't land is ineligible, which magpie reads rather than asks again", async () => {
  f = fakeTrae()
  f.route("POST " + STATUS, () => json({ code: 0, enable: true, checked_in: false }))
  f.route("POST " + CLAIM, () => json({ code: 0, credits: 100 }))
  const out = await checkin()
  expect(out).toMatchObject({ outcome: "ineligible" })
  // the status before the claim, the claim, and the read-back that found the
  // day still out — no second claim on the day
  expect(f.seen.map((r) => r.path)).toEqual([STATUS, CLAIM, STATUS])
  // magpie's next pass reads the status alone, which is what a day already
  // answered with an ineligible asks of the plugin: the claim is not sent
  f.seen.length = 0
  f.route("POST " + STATUS, () => json({ code: 0, enable: true, checked_in: true, credits: 100 }))
  const later = await checkin()
  expect(later).toEqual({ outcome: "done", credit: 100 })
  expect(f.seen.map((r) => r.path)).toEqual([STATUS])
})

// a read-back that can't be read after a claim is the day's answer too: the
// claim was made and whether the day is in isn't known, so it is read again
// rather than claimed again
test("a read-back that can't be read is not claimed again that day", async () => {
  f = fakeTrae()
  let n = 0
  f.route("POST " + STATUS, () => (n++ === 0 ? json({ code: 0, enable: true, checked_in: false }) : new Response("<html>gateway</html>")))
  f.route("POST " + CLAIM, () => json({ code: 0 }))
  const out = await checkin()
  expect(out).toMatchObject({ outcome: "ineligible" })
  expect(out.message).toContain("unreadable")
  expect(out.message).toContain("nothing is claimed again today")
})

test("a claim that lands is claimed on the status's word, its credit the read-back's", async () => {
  f = fakeTrae()
  let claimed = false
  f.route("POST " + STATUS, () => json({ code: 0, enable: true, checked_in: claimed, credits: claimed ? 120 : 0 }))
  f.route("POST " + CLAIM, () => { claimed = true; return json({ code: 0 }) })
  expect(await checkin()).toEqual({ outcome: "claimed", credit: 120 })
})

test("an unreadable status reply is failed", async () => {
  f = fakeTrae()
  f.route("POST " + STATUS, () => new Response("<html>gateway</html>"))
  const out = await checkin()
  expect(out).toMatchObject({ outcome: "failed" })
  expect(out.message).toContain("unreadable")
})

test("an unreadable claim reply is failed, never claimed", async () => {
  f = fakeTrae()
  f.route("POST " + STATUS, () => json({ code: 0, enable: true, checked_in: false }))
  f.route("POST " + CLAIM, () => new Response(""))
  const out = await checkin()
  expect(out).toMatchObject({ outcome: "failed" })
  expect(out.message).toContain("unreadable")
})

test("an expired sign-in is failed and marked", async () => {
  f = fakeTrae()
  f.route("POST " + STATUS, () => json({ code: 1001, message: "not able to authenticate you" }))
  const out = await checkin()
  expect(out).toMatchObject({ outcome: "failed" })
})

test("Trae Global has no check-in", async () => {
  expect(await checkin(TraeGlobalAuthPlugin)).toEqual({ outcome: "inactive", message: "Trae Global has no daily check-in" })
})
