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

test("a claim answering extra_credits alone is claimed with that credit", async () => {
  f = fakeTrae()
  f.route("POST " + STATUS, () => json({ code: 0, enable: true, checked_in: false, credits: 0 }))
  f.route("POST " + CLAIM, () => json({ code: 0, extra_credits: 20 }))
  // credits absent: Number(undefined) is NaN, and NaN + 20 read as no credit
  expect(await checkin()).toEqual({ outcome: "claimed", credit: 20 })
})

test("a claim answering neither credit says so, and the status's is the fallback", async () => {
  f = fakeTrae()
  f.route("POST " + STATUS, () => json({ code: 0, enable: true, checked_in: false, credits: 30 }))
  f.route("POST " + CLAIM, () => json({ code: 0 }))
  expect(await checkin()).toEqual({ outcome: "claimed", credit: 30 })
  f.close()
  f = fakeTrae()
  f.route("POST " + STATUS, () => json({ code: 0, enable: true, checked_in: false }))
  f.route("POST " + CLAIM, () => json({ code: 0 }))
  expect(await checkin()).toEqual({ outcome: "claimed" })
})

test("a claimable day is claimed through Trae's own pages", async () => {
  f = fakeTrae()
  f.route("POST " + STATUS, () => json({ code: 0, enable: true, checked_in: false }))
  f.route("POST " + CLAIM, () => json({ code: 0, credits: 100 }))
  expect(await checkin()).toEqual({ outcome: "claimed", credit: 100 })
  expect(f.seen.map((r) => r.path)).toEqual([STATUS, CLAIM])
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
  expect(await checkin()).toEqual({ outcome: "ineligible", message: "this device has checked in today" })
})

test("Trae's 9074 on the claim is the day's answer, on the account's own device", async () => {
  f = fakeTrae()
  f.route("POST " + STATUS, () => json({ code: 0, enable: true, checked_in: false }))
  f.route("POST " + CLAIM, () => json({ code: 9074, message: "当前参与用户太多" }))
  const out = await checkin()
  expect(out.outcome).toBe("ineligible")
  expect(out.message).toContain("当前参与用户太多")
  expect(out.message).toContain("check in in the Trae CN app")
  // the check-in rides ugDevice like every other ug page: the 19-digit
  // sign-in device becomes the account's own 16-digit shape (#194)
  expect(f.seen.map((r) => r.headers.get("x-device-id"))).toEqual(["2866487253502651", "2866487253502651"])
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
