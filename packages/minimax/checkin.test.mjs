// The daily check-in (每日签到): the panel's day statuses and the claim's
// answers, as the minimax-cloud endpoints answer them (quota-hub's
// minimax2api worked them out). Everything runs against the local fake.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { MiniMaxCodeAuthPlugin, MiniMaxCodeGlobalAuthPlugin } from "./index.mjs"
import { _internal } from "./index.mjs"
import { fakeMiniMax, json } from "./fake.mjs"

let f
afterEach(() => f?.close())

const STATUS = "/minimax-cloud/api/v1/signin/status"
const CLAIM = "/minimax-cloud/api/v1/signin/claim"
const auth = { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3600_000, accountId: "a@example.com", realUserID: "u-42" }

const day = (over = {}) => ({ day_no: 1, points: 10, status: 2, is_today: true, ...over })

const week = (todayNo, over = {}) => Array.from({ length: 7 }, (_, i) => {
  const dayNo = i + 1
  const status = dayNo < todayNo ? 3 : dayNo === todayNo ? 2 : 1
  return day({ day_no: dayNo, status, is_today: dayNo === todayNo, ...over })
})

async function checkin() {
  const plugin = await MiniMaxCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
  return plugin.auth.checkin(async () => auth)
}

test("a claimable day is claimed, its points and the streak reported", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, () => json({ base_resp: { status_code: 0 }, data: { days: week(7) } }))
  f.route("POST " + CLAIM, (r) => {
    expect(r.headers.get("authorization")).toBe("Bearer tok")
    return json({ base_resp: { status_code: 0 }, data: { claim_result: 1, points: 20, day_no: 7 } })
  })
  expect(await checkin()).toEqual({ outcome: "claimed", credit: 20, streak: 7 })
})

test("a claimed day is done, the streak counting it", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, () => json({ base_resp: { status_code: 0 }, data: { days: week(1, { status: 3 }) } }))
  expect(await checkin()).toEqual({ outcome: "done", credit: 10, streak: 1 })
})

test("the claim saying already-today is done", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, () => json({ base_resp: { status_code: 0 }, data: { days: week(1) } }))
  f.route("POST " + CLAIM, () => json({ base_resp: { status_code: 0 }, data: { claim_result: 2, points: 10 } }))
  expect(await checkin()).toEqual({ outcome: "done", credit: 10, streak: 1 })
})

test("a claimable mid-week day is claimed with the streak before it", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, () => json({ base_resp: { status_code: 0 }, data: { days: week(3) } }))
  f.route("POST " + CLAIM, () => json({ base_resp: { status_code: 0 }, data: { claim_result: 1, points: 20 } }))
  expect(await checkin()).toEqual({ outcome: "claimed", credit: 20, streak: 3 })
})

test("a claimed mid-week day reports the points and streak", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, () => json({
    base_resp: { status_code: 0 },
    data: { days: week(4, { status: 3 }) },
  }))
  expect(await checkin()).toEqual({ outcome: "done", credit: 10, streak: 4 })
})

test("the check-in requests are signed like the account API", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, () => json({ base_resp: { status_code: 0 }, data: { days: week(1) } }))
  f.route("POST " + CLAIM, () => json({ base_resp: { status_code: 0 }, data: { claim_result: 1, points: 20 } }))
  await checkin()
  const status = f.seen.find((r) => r.path === STATUS)
  const claim = f.seen.find((r) => r.path === CLAIM)
  for (const r of [status, claim]) {
    expect(r.headers.get("user-agent")).toBe("MiniMaxCode")
    expect(r.headers.get("yy")).toBeTruthy()
    expect(r.headers.get("x-timestamp")).toBeTruthy()
    expect(r.headers.get("x-signature")).toBeTruthy()
    expect(r.query.get("device_platform")).toBe("web")
    expect(r.query.get("is_desktop")).toBe("1")
    expect(r.query.get("desktop_version")).toBeTruthy()
    expect(r.query.get("client")).toBe("mcode")
    expect(r.query.get("user_id")).toBe("u-42")
    expect(r.query.get("timezone_offset")).toBe(String(new Date().getTimezoneOffset() * -60))
  }
  expect(claim?.text).toBe("{}")
})

// Magic_zero on Discord: the international site's check-in was refused
// (HTTP 401) while the same account chatted. MiniMax Code asks it as the
// account (user_id its realUserID); the fake turns away anyone else, as
// a check-in asked as user 0 was.
const asTheAccount = (r) => (r.query.get("user_id") === "u-42" ? null : new Response("", { status: 401 }))

test("the international check-in is asked as the account, not as user 0", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, (r) => asTheAccount(r) ?? json({ base_resp: { status_code: 0 }, data: { days: week(2) } }))
  f.route("POST " + CLAIM, (r) => asTheAccount(r) ?? json({ base_resp: { status_code: 0 }, data: { claim_result: 1, points: 20 } }))
  const plugin = await MiniMaxCodeGlobalAuthPlugin({ client: { auth: { set: async () => {} } } })
  expect(await plugin.auth.checkin(async () => auth)).toEqual({ outcome: "claimed", credit: 20, streak: 2 })
  expect(f.seen.filter((r) => r.path === STATUS || r.path === CLAIM).map((r) => r.query.get("user_id"))).toEqual(["u-42", "u-42"])
})

test("an account saved without its user id has it looked up before the check-in", async () => {
  f = fakeMiniMax()
  f.route("GET /v1/api/user/info", () => json({ statusInfo: { code: 0 }, data: { userInfo: { realUserID: "u-42", userEmail: "a@example.com" } } }))
  f.route("GET " + STATUS, (r) => asTheAccount(r) ?? json({ base_resp: { status_code: 0 }, data: { days: week(1, { status: 3 }) } }))
  const plugin = await MiniMaxCodeGlobalAuthPlugin({ client: { auth: { set: async () => {} } } })
  const { realUserID, ...noID } = auth
  expect(await plugin.auth.checkin(async () => noID)).toEqual({ outcome: "done", credit: 10, streak: 1 })
  expect(f.seen.map((r) => r.path)).toEqual(["/v1/api/user/info", STATUS])
})

test("an account whose user id can't be read is failed without a check-in", async () => {
  f = fakeMiniMax()
  f.route("GET /v1/api/user/info", () => new Response("", { status: 401 }))
  const plugin = await MiniMaxCodeGlobalAuthPlugin({ client: { auth: { set: async () => {} } } })
  const { realUserID, ...noID } = auth
  const out = await plugin.auth.checkin(async () => noID)
  expect(out.outcome).toBe("failed")
  expect(f.seen.filter((r) => r.path === STATUS)).toHaveLength(0)
})

// MiniMax Code 0.6.12's minimax-cloud origins (chunk-5ADYFF2U, HA):
// agent.minimaxi.com for cn, agent.minimax.io for en, the account API's
// hosts. The China site's chat host (agent.minimax.cn) is not one of them.
test("the China panel is asked on MiniMax Code's minimax-cloud host, not the chat host", async () => {
  f = fakeMiniMax()
  const was = { ..._internal.SITES["minimax-code"] }
  Object.assign(_internal.SITES["minimax-code"], {
    agent: f.origin,
    llm: "https://chat.example",
  })
  try {
    f.route("GET " + STATUS, () => json({ base_resp: { status_code: 0 }, data: { days: week(1, { status: 3 }) } }))
    const plugin = await MiniMaxCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
    const out = await plugin.auth.checkin(async () => auth)
    expect(out).toEqual({ outcome: "done", credit: 10, streak: 1 })
    expect(f.seen.filter((r) => r.path === STATUS)).toHaveLength(1)
  } finally {
    Object.assign(_internal.SITES["minimax-code"], was)
  }
})

// Magic_zero on Discord, with 0.1.4: still "check-in: the sign-in was
// refused (HTTP 401)" while chats went through. minimax-cloud answers a
// token it doesn't take with 401 {"error":"invalid access token"} (asked
// of agent.minimax.io). MiniMax Code's /checkin (T9.request) meets a 401
// by renewing the sign-in (handleUnauthorized), reading the user id again
// for the new token, and asking once more; the plugin's chat fetch also
// renews on a 401, so only the check-in showed it.
const refused = () => json({ error: "invalid access token" }, 401)
const onlyNew = (r) => (r.headers.get("authorization") === "Bearer new" ? null : refused())

for (const [name, Plugin] of [["international", MiniMaxCodeGlobalAuthPlugin], ["China", MiniMaxCodeAuthPlugin]]) {
  test(`a ${name} check-in turned away with 401 is renewed and asked once more, as MiniMax Code does`, async () => {
    f = fakeMiniMax()
    const saved = []
    f.route("POST /oauth2/token", () => json({ access_token: "new", refresh_token: "r2", token_type: "Bearer", expires_in: 3600 }))
    f.route("GET /v1/api/user/info", (r) => onlyNew(r) ?? json({ statusInfo: { code: 0 }, data: { userInfo: { realUserID: "u-42" } } }))
    f.route("GET " + STATUS, (r) => onlyNew(r) ?? asTheAccount(r) ?? json({ base_resp: { status_code: 0 }, data: { days: week(2) } }))
    f.route("POST " + CLAIM, (r) => onlyNew(r) ?? asTheAccount(r) ?? json({ base_resp: { status_code: 0 }, data: { claim_result: 1, points: 20 } }))
    const plugin = await Plugin({ client: { auth: { set: async (v) => (saved.push(v.body), true) } } })
    expect(await plugin.auth.checkin(async () => auth)).toEqual({ outcome: "claimed", credit: 20, streak: 2 })
    const asked = f.seen.map((r) => [r.path, r.headers.get("authorization")])
    expect(asked).toEqual([
      [STATUS, "Bearer tok"],
      ["/oauth2/token", null],
      ["/v1/api/user/info", "Bearer new"],
      [STATUS, "Bearer new"],
      [CLAIM, "Bearer new"],
    ])
    expect(f.seen.find((r) => r.path === "/oauth2/token").form).toMatchObject({ grant_type: "refresh_token", refresh_token: "r" })
    expect(saved.map((a) => a.access)).toEqual(["new"])
  })
}

test("a check-in still turned away after the renewal is failed, asked only twice", async () => {
  f = fakeMiniMax()
  f.route("POST /oauth2/token", () => json({ access_token: "new", refresh_token: "r2", token_type: "Bearer", expires_in: 3600 }))
  f.route("GET /v1/api/user/info", () => json({ statusInfo: { code: 0 }, data: { userInfo: { realUserID: "u-42" } } }))
  f.route("GET " + STATUS, refused)
  const plugin = await MiniMaxCodeGlobalAuthPlugin({ client: { auth: { set: async () => true } } })
  const out = await plugin.auth.checkin(async () => auth)
  expect(out.outcome).toBe("failed")
  expect(out.message).toBe("check-in: the sign-in was refused (HTTP 401)")
  expect(out.signIn).toBeUndefined()
  expect(f.seen.filter((r) => r.path === STATUS)).toHaveLength(2)
  expect(f.seen.filter((r) => r.path === "/oauth2/token")).toHaveLength(1)
})

test("a 401 whose renewal says the account is signed out says so", async () => {
  f = fakeMiniMax()
  f.route("POST /oauth2/token", () => json({ error: "invalid_grant" }, 400))
  f.route("GET " + STATUS, refused)
  const plugin = await MiniMaxCodeGlobalAuthPlugin({ client: { auth: { set: async () => true } } })
  const out = await plugin.auth.checkin(async () => auth)
  expect(out.outcome).toBe("failed")
  expect(out.signIn).toBe("expired")
  expect(f.seen.filter((r) => r.path === STATUS)).toHaveLength(1)
})

test("a 403 is not renewed", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, () => new Response("no", { status: 403 }))
  const out = await checkin()
  expect(out.outcome).toBe("failed")
  expect(f.seen.filter((r) => r.path === "/oauth2/token")).toHaveLength(0)
})

test("a day that hasn't started is inactive", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, () => json({ base_resp: { status_code: 0 }, data: { days: week(8).map((d) => ({ ...d, status: 1 })) } }))
  expect(await checkin()).toEqual({ outcome: "inactive" })
})

test("a day that isn't available is ineligible", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, () => json({ base_resp: { status_code: 0 }, data: { days: week(1, { status: 4 }) } }))
  expect(await checkin()).toEqual({ outcome: "ineligible" })
})

test("a panel without days is failed", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, () => json({ base_resp: { status_code: 0 }, data: { days: [] } }))
  const out = await checkin()
  expect(out.outcome).toBe("failed")
  expect(out.message).toContain("no panel")
})

test("a reply without a panel is failed", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, () => json({}))
  const out = await checkin()
  expect(out.outcome).toBe("failed")
  expect(out.message).toContain("no panel")
})

test("a non-2xx panel is failed", async () => {
  for (const body of [
    json({ error: "invalid signature" }, 400),
    json({ message: "internal" }, 502),
  ]) {
    f?.close()
    f = fakeMiniMax()
    f.route("GET " + STATUS, () => body)
    const out = await checkin()
    expect(out.outcome).toBe("failed")
    expect(out.message).toMatch(/HTTP (400|502)/)
  }
})

test("a panel without today is inactive and no claim is made", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, () => json({ base_resp: { status_code: 0 }, data: { days: week(8).map((d) => ({ ...d, is_today: false })) } }))
  expect(await checkin()).toEqual({ outcome: "inactive" })
  expect(f.seen.filter((r) => r.path === CLAIM)).toHaveLength(0)
})

test("the panel's error is failed with its words", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, () => json({ base_resp: { status_code: 1004, status_msg: "login fail" } }))
  const out = await checkin()
  expect(out.outcome).toBe("failed")
  expect(out.message).toContain("login fail")
})

test("a turned-away token is failed without signing the account out", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, () => new Response("no", { status: 401 }))
  const out = await checkin()
  expect(out.outcome).toBe("failed")
  expect(out.signIn).toBeUndefined()
})

test("a forbidden check-in is failed without signing the account out", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, () => new Response("no", { status: 403 }))
  const out = await checkin()
  expect(out.outcome).toBe("failed")
  expect(out.message).toContain("403")
  expect(out.signIn).toBeUndefined()
})

test("an unknown claim_result is failed", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, () => json({ base_resp: { status_code: 0 }, data: { days: week(1) } }))
  f.route("POST " + CLAIM, () => json({ base_resp: { status_code: 0 }, data: { claim_result: 9 } }))
  const out = await checkin()
  expect(out.outcome).toBe("failed")
  expect(out.message).toContain("claim_result")
})

test("a not-signed-in account is failed without a request", async () => {
  f = fakeMiniMax()
  const plugin = await MiniMaxCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
  const out = await plugin.auth.checkin(async () => ({ type: "api", key: "k" }))
  expect(out.outcome).toBe("failed")
  expect(out.message).toBe("not signed in")
  expect(f.seen.length).toBe(0)
})
