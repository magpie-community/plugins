// auth.checkin: WorkBuddy's daily 签到 plus the growth center's daily pass.
// Nothing leaves the machine: fetch is answered by the routes below.
import { test, expect, afterAll, afterEach } from "bun:test"
import { _internal } from "./index.mjs"

const { growthTaskList, growthAcceptCandidates, growthReportEvent, workbuddyCheckin, SITES } = _internal
const site = SITES.workbuddy
const auth = { type: "oauth", access: "token", uid: "u1", domain: "www.workbuddy.cn" }

const real = globalThis.fetch
afterAll(() => (globalThis.fetch = real))
afterEach(() => (globalThis.fetch = real))

const ok = (data) => new Response(JSON.stringify({ code: 0, msg: "ok", data }))

// serve answers by host + path; a route answers a Response, or throws.
function serve(routes) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url))
    calls.push({ path: u.pathname, method: init?.method || "GET", body: init?.body, headers: new Headers(init?.headers) })
    const hit = routes[u.hostname + u.pathname] ?? routes[u.pathname]
    if (!hit) return new Response("", { status: 404 })
    return hit(init)
  }
  return calls
}

test("the task list flattens both progress shapes and derives claimability", () => {
  const tasks = growthTaskList({
    tasks: [
      { task_code: "a", accept_status: "completed", target: 1, current: 1, reward_credit: 100 },
      { task_code: "b", accept_status: "in_progress", progress: { current: 2, target: 5 } },
      { task_code: "c", accept_status: "claimed", target: 1, current: 1 },
      { task_code: "d", accept_status: "not_accepted", locked: true, target: 1, current: 1 },
      { task_code: "e", accept_status: "accepted", progress: { current: 3, target: 3 } },
    ],
  })
  expect(tasks.map((t) => [t.task_code, t.current, t.target, t.claimable])).toEqual([
    ["a", 1, 1, true],
    ["b", 2, 5, false],
    ["c", 1, 1, false],
    ["d", 1, 1, false],
    ["e", 3, 3, true],
  ])
})

test("only tasks not enrolled yet are accepted", () => {
  const tasks = growthTaskList({
    tasks: [
      { task_code: "fresh" },
      { task_code: "missing-status", accept_status: "" },
      { task_code: "pending", accept_status: "not_accepted" },
      { task_code: "running", accept_status: "accepted" },
      { task_code: "completed", accept_status: "completed" },
      { task_code: "gone", accept_status: "not_accepted", claimed: true },
      { task_code: "locked", accept_status: "", locked: true },
      { task_code: "" },
    ],
  })
  expect(growthAcceptCandidates(tasks)).toEqual(["fresh", "missing-status", "pending"])
})

test("the activity report carries the event and the account", () => {
  const [ev] = growthReportEvent(auth)
  expect(ev.eventCode).toBe("chat_request_send")
  expect(ev.userId).toBe("u1")
  expect(ev.conversationId).toBe(ev.requestId)
  expect(ev.conversationId).toBe(ev.rootRequestId)
  expect(ev.agentType).toBe("conversation")
  expect(Array.isArray(ev.mentionContexts)).toBe(true)
})

test("a check-in claims today's credits and the growth pass claims a task", async () => {
  const calls = serve({
    "/v2/billing/meter/checkin-activity-status": () => ok({ active: true, today_checked_in: false }),
    "/v2/billing/meter/daily-checkin": () => ok({ credit: 100, streak_days: 3, message: "签到成功" }),
    "www.codebuddy.cn/v2/report": () => ok({}),
    "www.codebuddy.cn/billing/meter/claim-gift": () => new Response(JSON.stringify({ code: 1, msg: "already" })),
    "www.codebuddy.cn/billing/meter/claim-compensation": () => new Response(JSON.stringify({ code: 1, msg: "already" })),
    "/v2/activity/growth/tasks": () =>
      ok({ tasks: [{ task_code: "t1", title: "任务一", accept_status: "completed", target: 1, current: 1, reward_credit: 50 }] }),
    "www.workbuddy.cn/activity/growth/tasks/t1/claim": () => ok({ credit: 50 }),
    "/activity/growth/streak": () => ok({ streak: { days: 3 }, makeup_cards: { balance: 0 }, redemption_status: { tiers: [] } }),
    "/activity/growth/lottery/chances": () => ok({ balance: 0 }),
    "/activity/growth/buddy/travel/status": () => ok({ state: "traveling" }),
  })
  const out = await workbuddyCheckin(site, auth)
  expect(out.outcome).toBe("claimed")
  expect(out.credit).toBe(150)
  expect(out.streak).toBe(3)
  expect(out.message).toContain("签到成功")
  expect(out.message).toContain("任务一 +50")
  const claim = calls.find((c) => c.path.endsWith("/tasks/t1/claim"))
  expect(claim.headers.get("x-client-platform")).toBe("web")
  expect(claim.headers.get("authorization")).toBe("Bearer token")
})

test("an already checked-in day still runs the task pass", async () => {
  serve({
    "/v2/billing/meter/checkin-activity-status": () => ok({ active: true, today_checked_in: true, today_credit: 100, streak_days: 4 }),
    "www.codebuddy.cn/v2/report": () => ok({}),
    "www.codebuddy.cn/billing/meter/claim-gift": () => new Response(JSON.stringify({ code: 1 })),
    "www.codebuddy.cn/billing/meter/claim-compensation": () => new Response(JSON.stringify({ code: 1 })),
    "/v2/activity/growth/tasks": () => ok({ tasks: [] }),
    "/activity/growth/streak": () => ok({ streak: { days: 4 }, makeup_cards: { balance: 0 }, redemption_status: { tiers: [] } }),
    "/activity/growth/lottery/chances": () => ok({ balance: 0 }),
    "/activity/growth/buddy/travel/status": () => ok({ state: "idle", daily_limit_reached: true }),
  })
  const out = await workbuddyCheckin(site, auth)
  expect(out.outcome).toBe("claimed")
  expect(out.credit).toBe(100)
  expect(out.message).toContain("今日已签到")
  expect(out.message).toContain("活跃上报 ok")
})

test("the international build has no check-in hook", async () => {
  const plugin = await (await import("./index.mjs")).WorkBuddyAIAuthPlugin({ client: {} })
  expect(plugin.auth.checkin).toBeUndefined()
})
