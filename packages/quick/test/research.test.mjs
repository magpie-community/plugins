// The research bridge against the exact shapes the live qbsproxy endpoints
// returned (captured 2026-11-22): entitlement-units' pool, the
// execute → get-updates → get flow over a fake fetch, and the terminal
// statuses that stop the poller.
import { afterEach, expect, test } from "bun:test"
import * as research from "../lib/research.mjs"
import { researchResponseShape } from "./fixtures-research.mjs"

const account = { accountId: "1234567890", cookie: "a=1", mbtc: "m" }
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

// every test stubs the csrf bootstrap (the live page probe is not a test's job);
// afterEach resets it, so re-apply at the start of each test via this helper
function stubCsrf() {
  research._setCsrfLoader(async () => "test-csrf")
}
stubCsrf()

// a fake fetch serving scripted replies per path
function fakeFetch(routes) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url)
    calls.push({ url: u, init, path: u.pathname })
    for (const [match, reply] of routes) {
      if (u.pathname.includes(match)) {
        return typeof reply === "function" ? reply(u, init) : reply
      }
    }
    return new Response("not found", { status: 404 })
  }
  return calls
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } })

test("entitlements reads the live pool shape (captured 2026-11-22)", async () => {
  fakeFetch([["/entitlement-units", json(researchResponseShape.entitlements)]])
  const e = await research.entitlements(account)
  expect(e).toEqual({
    unitType: "RESEARCH_AGENT_HOUR_UNIT",
    availableMinutes: 597,
    provisionedMinutes: 600,
    overageAllowed: false,
    throttled: false,
    subscription: { name: "QBUSINESS_FREE_TIER", status: "ACTIVE", expiresAt: "2026-12-15T00:00:00.000Z" },
  })
})

test("entitlements degrades on a refusal with a re-import hint", async () => {
  fakeFetch([["/entitlement-units", new Response("denied", { status: 403 })]])
  await expect(research.entitlements(account)).rejects.toThrow(/re-import/)
})

test("start validates the goal and mode before touching the network", async () => {
  const calls = fakeFetch([])
  await expect(research.start(account, "  ")).rejects.toThrow(/goal/)
  await expect(research.start(account, "x", { mode: "MEGA" })).rejects.toThrow(/FAST or DEEP/)
  expect(calls.length).toBe(0)
})

test("start posts the live request shape and returns the research id", async () => {
  const calls = fakeFetch([["/execute-research-immediate", json({ researchId: "r-123" })]])
  const started = await research.start(account, "compare the two specs", { mode: "fast" })
  expect(started).toEqual({ researchId: "r-123", mode: "FAST" })
  const call = calls[0]
  expect(call.init.method).toBe("POST")
  expect(JSON.parse(call.init.body)).toEqual({ researchGoal: "compare the two specs", researchId: null, researchMode: "FAST" })
  // the vibranium proxy shape: Operation on the query, csrf + api target headers
  expect(call.url.searchParams.get("Operation")).toBe("VibraniumProxy")
  expect(call.url.searchParams.get("mbtc")).toBe("m")
  expect(call.init.headers["x-amzn-csrf-token"]).toBe("test-csrf")
  expect(call.init.headers["x-amzn-target"]).toBe("api")
})

test("start surfaces a server refusal with the status and body", async () => {
  fakeFetch([["/execute-research-immediate", new Response("no pool", { status: 400 })]])
  await expect(research.start(account, "x")).rejects.toThrow(/400/)
})

test("run polls get-updates to a terminal status and reads the report", async () => {
  const calls = fakeFetch([
    ["/execute-research-immediate", json({ researchId: "r-9" })],
    [
      "/get-updates",
      (() => {
        let n = 0
        return () => {
          n++
          return json(
            n < 3
              ? { researchStatus: "INVESTIGATING_TOPICS", executionVersion: n, traces: [{ taskTrace: { sequenceId: n, traceText: `step ${n}` } }] }
              : { researchStatus: "REPORT_COMPLETE", executionVersion: n, traces: [{ taskTrace: { sequenceId: n, traceText: "done" } }] },
          )
        }
      })(),
    ],
    ["/get", json(researchResponseShape.get)],
  ])
  const ticks = []
  const result = await research.run(account, "a small question", { pollMs: 1, onTick: (t) => ticks.push(t) })
  expect(result.researchId).toBe("r-9")
  expect(result.status).toBe("REPORT_COMPLETE")
  expect(result.text).toBe("The two specs agree on frame order; they differ on retry semantics.")
  expect(result.mode).toBe("FAST")
  expect(result.elapsedS).toBeGreaterThanOrEqual(0)
  expect(ticks.filter((t) => t.event === "started").length).toBe(1)
  expect(ticks.filter((t) => t.event === "progress").length).toBe(3)
  // get was called with the research id
  const getCalls = calls.filter((c) => c.path.endsWith("/get"))
  expect(JSON.parse(getCalls[0].init.body)).toEqual({ researchId: "r-9" })
})

test("run stops on failure statuses without reading a report as success", async () => {
  fakeFetch([
    ["/execute-research-immediate", json({ researchId: "r-10" })],
    ["/get-updates", json({ researchStatus: "FAILED_PLAN_GENERATION", traces: [] })],
  ])
  const result = await research.run(account, "a doomed question", { pollMs: 1 })
  expect(result.status).toBe("FAILED_PLAN_GENERATION")
  expect(result.text).toBe("")
})

test("run's out-of-budget read is marked timedOut, the run keeps its id", async () => {
  fakeFetch([
    ["/execute-research-immediate", json({ researchId: "r-11" })],
    ["/get-updates", json({ researchStatus: "INVESTIGATING_TOPICS", traces: [] })],
    ["/get", json({ researchStatus: "INVESTIGATING_TOPICS", report: { reportText: "partial" } })],
  ])
  const result = await research.run(account, "a slow question", { pollMs: 1, budgetMs: 30 })
  expect(result.timedOut).toBe(true)
  expect(result.status).toBe("INVESTIGATING_TOPICS")
  expect(result.text).toBe("partial")
})

test("an aborted signal cancels the run and reports it", async () => {
  const calls = fakeFetch([
    ["/execute-research-immediate", json({ researchId: "r-12" })],
    ["/get-updates", json({ researchStatus: "INVESTIGATING_TOPICS", traces: [] })],
    ["/cancel", json({ ok: true })],
  ])
  const ac = new AbortController()
  ac.abort()
  const result = await research.run(account, "stop me", { pollMs: 1, signal: ac.signal })
  expect(result.aborted).toBe(true)
  expect(result.status).toBe("USER_CANCELED")
  expect(calls.some((c) => c.path.endsWith("/cancel"))).toBe(true)
})

test("poll errors are survived, not fatal — the next tick continues", async () => {
  fakeFetch([
    ["/execute-research-immediate", json({ researchId: "r-13" })],
    [
      "/get-updates",
      (() => {
        let n = 0
        return () => {
          n++
          if (n === 1) return new Response("flaky", { status: 503 })
          return json({ researchStatus: "REPORT_COMPLETE", traces: [] })
        }
      })(),
    ],
    ["/get", json({ researchStatus: "REPORT_COMPLETE", report: { reportText: "recovered" } })],
  ])
  const ticks = []
  const result = await research.run(account, "flaky server", { pollMs: 1, onTick: (t) => ticks.push(t) })
  expect(result.status).toBe("REPORT_COMPLETE")
  expect(result.text).toBe("recovered")
  expect(ticks.some((t) => t.event === "poll_error")).toBe(true)
})

test("the terminal set matches the web client's enum", () => {
  for (const s of ["REPORT_COMPLETE", "INVESTIGATION_COMPLETE", "TERMINATED", "USER_CANCELED", "FAILED_PLAN_GENERATION", "FAILED_INVESTIGATION", "FAILED_INVESTIGATION_QUEUED_FOR_RETRY"]) {
    expect(research.TERMINAL_STATUSES.has(s)).toBe(true)
  }
  // in-progress statuses must NOT end the poll
  for (const s of ["BOOTSTRAPPING", "GENERATING_PLAN", "QUEUED_FOR_INVESTIGATION", "INVESTIGATING_TOPICS", "PLAN_REFINEMENT", "GENERATING_REPORT", "REPORT_IN_PROGRESS"]) {
    expect(research.TERMINAL_STATUSES.has(s)).toBe(false)
  }
})
