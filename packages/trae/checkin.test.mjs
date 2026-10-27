// The daily check-in (签到): magpie asks Trae CN's own pages on
// api.trae.cn (/trae/api/v2/ug/checkin_credits/status, then /claim)
// through the account's fetch, which sends them as the account.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeCNAuthPlugin, _internal } from "./index.mjs"
import { fakeTrae, json, signedIn } from "./fake.mjs"

let f
afterEach(() => f?.close())

async function fetcher(auth = signedIn(), client = {}) {
  const hooks = await TraeCNAuthPlugin({ client })
  return hooks.auth.loader(async () => auth)
}

test("a check-in page is sent as the account, its answer back as it is", async () => {
  f = fakeTrae()
  f.route("POST /trae/api/v2/ug/checkin_credits/status", () => json({ code: 0, enable: true, checked_in: false, credits: 100 }))
  f.route("POST /trae/api/v2/ug/checkin_credits/claim", () => json({ code: 0, credits: 100 }))
  const o = await fetcher()
  const st = await o.fetch(f.origin + "/trae/api/v2/ug/checkin_credits/status", { method: "POST", headers: { authorization: "Bearer trae" }, body: "{}" })
  expect(st.status).toBe(200)
  expect(st.headers.get("x-magpie-sign-in")).toBe("kept")
  expect(await st.json()).toEqual({ code: 0, enable: true, checked_in: false, credits: 100 })
  const cl = await o.fetch(new Request(f.origin + "/trae/api/v2/ug/checkin_credits/claim", { method: "POST", body: "{}" }))
  expect(await cl.json()).toEqual({ code: 0, credits: 100 })
  expect(f.seen.map((r) => r.path)).toEqual(["/trae/api/v2/ug/checkin_credits/status", "/trae/api/v2/ug/checkin_credits/claim"])
  for (const r of f.seen) {
    expect(r.method).toBe("POST")
    // as Trae CN's IDE sends it (yetone/magpie#808): {req_source: 1}, its
    // device headers and a client's User-Agent, not Bun's
    expect(r.json).toEqual({ req_source: 1 })
    expect(r.headers.get("authorization")).toBe("Cloud-IDE-JWT jwt-1")
    // the account's own device in the client's 16-digit shape: this
    // account signed in before 0.2.16 with 19 digits (#194)
    expect(r.headers.get("x-device-id")).toBe("2866487253502651")
    expect(r.headers.get("x-device-type")).toBe("Windows")
    expect(r.headers.get("x-os-version")).toBe("10.0.22631")
    expect(r.headers.get("x-app-version")).toBe("0.1.69")
    expect(r.headers.get("x-device-brand")).toBeTruthy()
    expect(r.headers.get("user-agent")).toMatch(/^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\) .*TRAE-SOLO-CN\/0\.1\.69 Chrome\/[\d.]+ Electron\/[\d.]+ Safari\/537\.36$/)
    expect(r.headers.get("user-agent")).not.toMatch(/Bun/)
    // not the chat's
    for (const h of ["x-uid", "x-ide-token", "x-cloudide-token", "x-ide-version", "x-machine-id"]) expect(r.headers.has(h)).toBe(false)
  }
})

test("a check-in's own body is sent as given", async () => {
  f = fakeTrae()
  f.route("POST /trae/api/v2/ug/checkin_credits/status", () => json({ code: 0, enable: true, checked_in: true }))
  const o = await fetcher()
  await o.fetch(f.origin + "/trae/api/v2/ug/checkin_credits/status", { method: "POST", body: '{"req_source":2}' })
  expect(f.seen[0].json).toEqual({ req_source: 2 })
})

test("Trae's other pages still go with the chat's headers", async () => {
  f = fakeTrae()
  f.route("POST /trae/api/v2/pay/ide_user_ent_usage", () => json({ code: 0 }))
  const o = await fetcher()
  await o.fetch(f.origin + "/trae/api/v2/pay/ide_user_ent_usage", { method: "POST", body: "{}" })
  expect(f.seen[0].json).toEqual({})
  expect(f.seen[0].headers.get("x-uid")).toBe("u-1")
})

test("a token Trae turns away marks the sign-in", async () => {
  f = fakeTrae()
  f.route("POST /trae/api/v2/ug/checkin_credits/status", () => json({ code: 1001, enable: false, checked_in: false, message: "not able to authenticate you" }))
  const o = await fetcher()
  const st = await o.fetch(f.origin + "/trae/api/v2/ug/checkin_credits/status", { method: "POST", body: "{}" })
  expect(st.headers.get("x-magpie-sign-in")).toBe("expired")
  expect((await st.json()).code).toBe(1001)
})

test("a token near its end is renewed first", async () => {
  f = fakeTrae()
  f.route("POST /cloudide/api/v3/trae/oauth/ExchangeToken", () => json({ Result: { Token: "jwt-2", RefreshToken: "r-2", TokenExpireAt: Date.now() + 86400_000 } }))
  f.route("POST /trae/api/v2/ug/checkin_credits/status", () => json({ code: 0, enable: true, checked_in: true, credits: 100 }))
  const saved = []
  const o = await fetcher(signedIn({ expires: Date.now() + 30_000 }), { auth: { set: async (x) => saved.push(x) } })
  const st = await o.fetch(f.origin + "/trae/api/v2/ug/checkin_credits/status", { method: "POST", body: "{}" })
  expect(st.headers.get("x-magpie-sign-in")).toBe("renewed")
  expect(f.seen.at(-1).headers.get("authorization")).toBe("Cloud-IDE-JWT jwt-2")
  expect(saved[0].body.access).toBe("jwt-2")
})

test("other hosts' pages and other paths aren't sent as a page", async () => {
  f = fakeTrae()
  const o = await fetcher()
  const r = await o.fetch(f.origin + "/cloudide/whatever", { method: "POST", body: "{}" })
  expect(r.status).toBe(400) // not a chat: refused, nothing sent
  expect(f.seen).toEqual([])
})

// #194: Trae CN answered a claim on the plugin's 19-digit device id 9074,
// and the same account and token on a 16-digit one were taken. The
// check-in goes on the account's own device in that shape; it is never
// rotated, and no two accounts share one.
test("an account signed in before 0.2.16 checks in on one 16-digit id made from its own device, every time", () => {
  const a = signedIn()
  const id = _internal.ugDevice(a)
  expect(id).toMatch(/^[1-9]\d{15}$/)
  // the same on every check-in, and not the 19 digits cut short
  expect(_internal.ugDevice(signedIn())).toBe(id)
  expect(id).not.toBe("1234567890123456")
  // another account's, or another device's, is not this one
  expect(_internal.ugDevice(signedIn({ uid: "u-2" }))).not.toBe(id)
  expect(_internal.ugDevice(signedIn({ deviceId: "9876543210987654321" }))).not.toBe(id)
  // an account with no uid still has its own
  expect(_internal.ugDevice(signedIn({ uid: "" }))).toMatch(/^[1-9]\d{15}$/)
})

test("an id already in the client's shape is the account's own, as it is", () => {
  expect(_internal.ugDevice(signedIn({ deviceId: "1234567890123456" }))).toBe("1234567890123456")
  expect(_internal.ugDevice(signedIn({ deviceId: "123456789012345" }))).toBe("123456789012345")
  expect(_internal.ugDevice(signedIn({ deviceId: "", uid: "" }))).toBe("")
})

test("a new Trae CN sign-in's device is 16 digits; Trae Global's stays 19", () => {
  expect(_internal.newDevice(_internal.SITES["trae-cn"]).deviceId).toMatch(/^[1-9]\d{15}$/)
  expect(_internal.newDevice(_internal.SITES["trae-global"]).deviceId).toMatch(/^[1-9]\d{18}$/)
})

test("an account with a 16-digit device checks in on it; an old one's chat pages keep the 19 digits it signed in with", async () => {
  f = fakeTrae()
  f.route("POST /trae/api/v2/ug/checkin_credits/claim", () => json({ code: 0 }))
  f.route("POST /trae/api/v2/pay/ide_user_ent_usage", () => json({ code: 0 }))
  const o16 = await fetcher(signedIn({ deviceId: "1234567890123456" }))
  await o16.fetch(f.origin + "/trae/api/v2/ug/checkin_credits/claim", { method: "POST", body: "{}" })
  expect(f.seen.at(-1).headers.get("x-device-id")).toBe("1234567890123456")
  const o19 = await fetcher()
  await o19.fetch(f.origin + "/trae/api/v2/ug/checkin_credits/claim", { method: "POST", body: "{}" })
  expect(f.seen.at(-1).headers.get("x-device-id")).toBe("2866487253502651")
  await o19.fetch(f.origin + "/trae/api/v2/pay/ide_user_ent_usage", { method: "POST", body: "{}" })
  expect(f.seen.at(-1).headers.get("x-device-id")).toBe("1234567890123456789")
})

test("a 9095 on the account's device is the day's answer: nothing is sent again on another id", async () => {
  f = fakeTrae()
  f.route("POST /trae/api/v2/ug/checkin_credits/claim", () => json({ code: 9095, message: "当前设备今日已经签到" }))
  const o = await fetcher()
  const r = await o.fetch(f.origin + "/trae/api/v2/ug/checkin_credits/claim", { method: "POST", body: "{}" })
  expect((await r.json()).code).toBe(9095)
  expect(f.seen.length).toBe(1)
})
