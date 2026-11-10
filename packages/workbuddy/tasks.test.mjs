// The growth centre's daily chores, on a local fake: the order the vendor's
// own client uses, what is skipped rather than imitated, and the day mark
// that keeps a second ask from reporting twice.
import { test, expect, afterEach, beforeAll } from "bun:test"

let tasks
beforeAll(async () => {
  tasks = await import("./tasks.mjs")
})

// the China build, as index.mjs's SITES names it
const site = {
  id: "workbuddy",
  name: "WorkBuddy",
  endpoint: "https://copilot.tencent.com",
  app: "5.9.3",
  cli: "2.165.0",
  appName: "WorkBuddy",
  ai: false,
}
const auth = { type: "oauth", access: "at", refresh: "r", expires: Date.now() + 3600_000, uid: "u1", domain: "" }

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  tasks._internal.forget()
})

const ok = (data = {}) => new Response(JSON.stringify({ code: 0, msg: "ok", data }), { headers: { "content-type": "application/json" } })
const busy = (code, msg) => new Response(JSON.stringify({ code, msg }), { headers: { "content-type": "application/json" } })

// serve answers by path; every call is recorded so a test can assert the
// order and the body
function serve(routes) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url))
    calls.push({ path: u.pathname, host: u.host, init, headers: new Headers(init?.headers), body: init?.body })
    const r = routes[u.pathname]
    return r ? r(init, calls) : new Response("", { status: 404 })
  }
  return calls
}

const task = (code, over = {}) => ({
  task_code: code,
  title: code,
  accept_status: "accepted",
  task_type: "single",
  progress: { current: 0, target: 1 },
  reward_credit: 100,
  ...over,
})

test("the growth headers are the chat identity, on the China origin", async () => {
  const calls = serve({ "/v2/activity/growth/tasks": () => ok({ tasks: [] }) })
  await tasks.growthTasks(site, auth)
  expect(calls).toHaveLength(1)
  const h = calls[0].headers
  expect(calls[0].host).toBe("copilot.tencent.com")
  expect(h.get("user-agent")).toBe("WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0")
  expect(h.get("origin")).toBe("https://www.codebuddy.cn")
  expect(h.get("x-agent-purpose")).toBe("conversation")
  expect(h.get("x-agent-type")).toBe("main")
  expect(h.get("x-product")).toBe("SaaS")
  expect(h.get("authorization")).toBe("Bearer at")
})

test("a completed task is claimed without reporting anything", async () => {
  const calls = serve({
    "/v2/activity/growth/tasks": () => ok({ tasks: [task("chat_5", { progress: { current: 5, target: 5 }, accept_status: "completed" })] }),
    "/activity/growth/tasks/chat_5/claim": () => ok({ credit: 100 }),
  })
  const out = await tasks.growthTasks(site, auth)
  expect(out.credit).toBe(100)
  // nothing is reported for a task the vendor already counts as done
  expect(calls.some((c) => c.path === "/v2/report")).toBe(false)
  expect(calls[calls.length - 1].path).toBe("/activity/growth/tasks/chat_5/claim")
})

test("a task is accepted, reported once per unit, then claimed", async () => {
  let reports = 0
  const calls = serve({
    "/v2/activity/growth/tasks": (_, all) =>
      ok({ tasks: [task("chat_5", { accept_status: all.filter((c) => c.path === "/v2/activity/growth/tasks/accept").length ? "accepted" : "not_accepted", progress: { current: reports, target: 2 } })] }),
    "/v2/activity/growth/tasks/accept": () => ok({ results: [{ task_code: "chat_5", status: "accepted" }] }),
    "/v2/report": () => { reports++; return ok() },
    "/activity/growth/tasks/chat_5/claim": () => ok({ credit: 100 }),
  })
  const out = await tasks.growthTasks(site, auth, { gap: 0 })
  expect(out.credit).toBe(100)
  const paths = calls.map((c) => c.path)
  expect(paths).toContain("/v2/activity/growth/tasks/accept")
  expect(paths.filter((p) => p === "/v2/report")).toHaveLength(2)
  expect(paths[paths.length - 1]).toBe("/activity/growth/tasks/chat_5/claim")
  // the report is an array of events, one send
  const body = JSON.parse(calls.find((c) => c.path === "/v2/report").body)
  expect(Array.isArray(body)).toBe(true)
  expect(body[0].eventCode).toBe("chat_request_send")
  expect(body[0].userId).toBe("u1")
})

test("a report the vendor ignored is never claimed", async () => {
  const calls = serve({
    "/v2/activity/growth/tasks": () => ok({ tasks: [task("chat_5", { progress: { current: 0, target: 1 } })] }),
    "/v2/report": () => ok(),
    "/activity/growth/tasks/chat_5/claim": () => busy(400, "task not completed"),
  })
  const out = await tasks.growthTasks(site, auth, { gap: 0 })
  expect(out.credit).toBe(0)
  expect(calls.some((c) => c.path.endsWith("/claim"))).toBe(false)
})

test("the two desktop-only Buddy apps are skipped, not imitated", async () => {
  const calls = serve({
    "/v2/activity/growth/tasks": () => ok({ tasks: [task("Buddy_App", { accept_status: "not_accepted" }), task("Buddy_App_QQ", { accept_status: "not_accepted" })] }),
  })
  const out = await tasks.growthTasks(site, auth, { gap: 0 })
  // no acceptance, no report, no claim
  expect(calls.some((c) => c.path === "/v2/activity/growth/tasks/accept")).toBe(false)
  expect(calls.some((c) => c.path === "/v2/report")).toBe(false)
  expect(calls.some((c) => c.path.endsWith("/claim"))).toBe(false)
  expect(out.logs.some((l) => l.includes("桌面端"))).toBe(true)
})

test("a real-world task is skipped with its reason", async () => {
  const calls = serve({
    "/v2/activity/growth/tasks": () => ok({ tasks: [task("wb_wechat_oa_subscribe_task", { accept_status: "not_accepted" })] }),
  })
  const out = await tasks.growthTasks(site, auth, { gap: 0 })
  expect(calls.some((c) => c.path === "/v2/report")).toBe(false)
  expect(out.logs.some((l) => l.includes("需真实操作"))).toBe(true)
})

test("an unknown task code is left alone: no event is invented for it", async () => {
  const calls = serve({
    "/v2/activity/growth/tasks": () => ok({ tasks: [task("mystery_task_42", { accept_status: "not_accepted" })] }),
  })
  await tasks.growthTasks(site, auth, { gap: 0 })
  expect(calls.some((c) => c.path === "/v2/report")).toBe(false)
  expect(calls.some((c) => c.path.endsWith("/claim"))).toBe(false)
})

test("a night task is left alone outside its window", async () => {
  const realHour = Date.prototype.getHours
  Date.prototype.getHours = () => 12
  try {
    const calls = serve({
      "/v2/activity/growth/tasks": () => ok({ tasks: [task("black_cat", { progress: { current: 0, target: 3 } })] }),
    })
    await tasks.growthTasks(site, auth, { gap: 0 })
    expect(calls.filter((c) => c.path === "/v2/report")).toHaveLength(0)
  } finally {
    Date.prototype.getHours = realHour
  }
})

test("the streak keeper runs in the vendor's order", async () => {
  const calls = serve({
    "/activity/growth/heatmap": () => ok({ cells: [{ date: tasks._internal.beijingDay(Date.now() - 86400_000), score: 0 }] }),
    "/activity/growth/streak": () => ok({
      makeup_cards: { balance: 1 },
      redemption_status: {
        tiers: [{ tier: "7d" }, { tier: "14d" }],
        tier_7d_status: "unlocked",
        tier_14d_status: "locked",
      },
    }),
    "/activity/growth/makeup-cards/use": () => ok(),
    "/billing/meter/claim-gift": () => ok({ credit: 50 }),
    "/billing/meter/claim-compensation": () => busy(40002, "already claimed"),
    "/activity/growth/redeem": () => ok(),
    "/activity/growth/lottery/summary": () => ok({ chances: 2 }),
    "/activity/growth/lottery/draw": () => ok({ prize: "credit" }),
  })
  const out = await tasks.streakBonus(site, auth, { gap: 0, drawGap: 0 })
  const paths = calls.map((c) => c.path)
  expect(paths[0]).toBe("/activity/growth/heatmap")
  expect(paths).toContain("/activity/growth/makeup-cards/use")
  expect(paths).toContain("/activity/growth/redeem")
  expect(paths.filter((p) => p === "/activity/growth/lottery/draw")).toHaveLength(2)
  expect(out.credit).toBe(50)
  // the make-up card names yesterday, the redeem a tier and a token
  const makeup = JSON.parse(calls.find((c) => c.path === "/activity/growth/makeup-cards/use").body)
  expect(makeup.target_date).toBe(tasks._internal.beijingDay(Date.now() - 86400_000))
  const redeem = JSON.parse(calls.find((c) => c.path === "/activity/growth/redeem").body)
  expect(redeem.tier).toBe("7d")
  expect(redeem.client_token).toMatch(/^[0-9a-f-]{36}$/)
})

test("a streak with nothing to do asks nothing but the reads", async () => {
  const calls = serve({
    "/activity/growth/heatmap": () => ok({ cells: [] }),
    "/activity/growth/streak": () => ok({ makeup_cards: { balance: 0 }, redemption_status: { tiers: [], tier_7d_status: "locked" } }),
    "/billing/meter/claim-gift": () => busy(40002, "taken"),
    "/billing/meter/claim-compensation": () => busy(40002, "taken"),
    "/activity/growth/lottery/summary": () => ok({ chances: 0 }),
  })
  const out = await tasks.streakBonus(site, auth, { gap: 0 })
  expect(out.logs).toEqual([])
  expect(calls.some((c) => c.path === "/activity/growth/redeem")).toBe(false)
  expect(calls.some((c) => c.path === "/activity/growth/lottery/draw")).toBe(false)
})

test("a Buddy that is back is claimed", async () => {
  const calls = serve({
    "/activity/growth/buddy/travel/status": () => ok({ state: "arrived" }),
    "/activity/growth/buddy/travel/claim": () => ok({ reward_credit: 60 }),
  })
  const out = await tasks.catTravel(site, auth)
  expect(out.credit).toBe(60)
  expect(calls.map((c) => c.path)).toEqual(["/activity/growth/buddy/travel/status", "/activity/growth/buddy/travel/claim"])
})

test("a Buddy at home departs for the first destination the config names", async () => {
  const calls = serve({
    "/activity/growth/buddy/travel/status": () => ok({ state: "idle", daily_limit_reached: false }),
    "/activity/growth/buddy/travel/config": () => ok({ locations: [{ id: 7, name: "西湖" }] }),
    "/activity/growth/buddy/travel/depart": () => ok({ location: { name: "西湖" } }),
  })
  const out = await tasks.catTravel(site, auth)
  expect(out.logs.join("")).toContain("西湖")
  const depart = JSON.parse(calls.find((c) => c.path === "/activity/growth/buddy/travel/depart").body)
  expect(depart.location_id).toBe(7)
})

test("a day already travelled departs nowhere", async () => {
  const calls = serve({
    "/activity/growth/buddy/travel/status": () => ok({ state: "idle", daily_limit_reached: true }),
  })
  const out = await tasks.catTravel(site, auth)
  expect(out.logs).toEqual([])
  expect(calls).toHaveLength(1)
})

test("a Buddy mid-journey is left to travel", async () => {
  const calls = serve({
    "/activity/growth/buddy/travel/status": () => ok({ state: "traveling" }),
  })
  await tasks.catTravel(site, auth)
  expect(calls).toHaveLength(1)
})

test("no Buddy instance is first_buddy's job, and it is said", async () => {
  // the vendor moves progress only after a report is read, so the fake
  // counts the reports it took and answers that many units of progress
  let reported = 0
  const calls = serve({
    "/activity/growth/buddy/travel/status": () => ok({ state: "idle" }),
    "/activity/growth/buddy/travel/config": () => ok({ locations: [] }),
    "/activity/growth/buddy/travel/depart": () =>
      busy(400, "no active buddy"),
    "/v2/activity/growth/tasks": () =>
      ok({ tasks: [task("first_buddy", { accept_status: "not_accepted", task_type: "auto", progress: { current: reported, target: 1 } })] }),
    "/v2/report": () => { reported++; return ok() },
    "/activity/growth/tasks/first_buddy/claim": () => ok({ credit: 300 }),
  })
  const out = await tasks.catTravel(site, auth, { gap: 0 })
  expect(out.credit).toBe(300)
  // the fallback destination is the integer 1, as the reference sends it
  const depart = JSON.parse(calls.find((c) => c.path === "/activity/growth/buddy/travel/depart").body)
  expect(depart.location_id).toBe(1)
})

test("a blind box is opened only when one is affordable", async () => {
  const calls = serve({
    "/v2/activity/growth/buddy/quota": () => ok({ affordable: 0, max_open_count: 3 }),
  })
  const out = await tasks.buddyOpen(site, auth)
  expect(out.logs).toEqual([])
  expect(calls.some((c) => c.path.endsWith("/open"))).toBe(false)
})

test("an affordable blind box is opened within the vendor's own cap", async () => {
  const calls = serve({
    "/v2/activity/growth/buddy/quota": () => ok({ affordable: 5, max_open_count: 2 }),
    "/v2/activity/growth/buddy/open": () => ok({ name: "小黑猫" }),
  })
  const out = await tasks.buddyOpen(site, auth)
  expect(out.logs.join("")).toContain("小黑猫")
  expect(JSON.parse(calls.find((c) => c.path.endsWith("/open")).body).count).toBe(2)
})

test("the day runs only once, however often it is asked", async () => {
  const calls = serve({
    "/v2/activity/growth/tasks": () => ok({ tasks: [] }),
    "/activity/growth/heatmap": () => ok({ cells: [] }),
    "/activity/growth/streak": () => ok({ makeup_cards: { balance: 0 } }),
    "/billing/meter/claim-gift": () => busy(1, "taken"),
    "/billing/meter/claim-compensation": () => busy(1, "taken"),
    "/activity/growth/lottery/summary": () => ok({ chances: 0 }),
    "/activity/growth/buddy/travel/status": () => ok({ state: "traveling" }),
  })
  const first = await tasks.runDaily(site, auth, { gap: 0 })
  expect(first.ran).toBe(true)
  const before = calls.length
  const second = await tasks.runDaily(site, auth, { gap: 0 })
  expect(second.done).toBe(true)
  expect(calls.length).toBe(before)
})

test("the AI build has no growth centre, and a key or a team account has none", async () => {
  const calls = serve({})
  expect((await tasks.runDaily({ ...site, id: "workbuddy-ai", ai: true }, auth)).ran).toBe(false)
  expect((await tasks.runDaily(site, { ...auth, source: "key" })).ran).toBe(false)
  expect((await tasks.runDaily(site, { ...auth, enterpriseId: "ent" })).ran).toBe(false)
  expect(calls).toHaveLength(0)
})

test("a failing chore never stops the ones after it", async () => {
  const calls = serve({
    "/v2/activity/growth/tasks": () => new Response("", { status: 500 }),
    "/activity/growth/heatmap": () => ok({ cells: [] }),
    "/activity/growth/streak": () => ok({ makeup_cards: { balance: 0 }, redemption_status: { tiers: [] } }),
    "/billing/meter/claim-gift": () => busy(1, "taken"),
    "/billing/meter/claim-compensation": () => busy(1, "taken"),
    "/activity/growth/lottery/summary": () => ok({ chances: 0 }),
    "/activity/growth/buddy/travel/status": () => ok({ state: "traveling" }),
  })
  const out = await tasks.runDaily(site, auth, { gap: 0 })
  expect(out.ran).toBe(true)
  expect(calls.some((c) => c.path === "/activity/growth/buddy/travel/status")).toBe(true)
  expect(out.logs.some((l) => l.startsWith("任务失败"))).toBe(true)
})
