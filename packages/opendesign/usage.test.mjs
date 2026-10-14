import "./nonet.mjs"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { _internal } from "./index.mjs"
import { fakeOpenDesign, json, PREFLIGHT, SUMMARY, WALLET } from "./fake.mjs"

let fake
const wasWs = process.env.VELA_WORKSPACE_ID
beforeEach(() => {
  delete process.env.VELA_WORKSPACE_ID
  fake = fakeOpenDesign()
})
afterEach(() => {
  fake.close()
  wasWs === undefined ? delete process.env.VELA_WORKSPACE_ID : (process.env.VELA_WORKSPACE_ID = wasWs)
})

const auth = (key = "sk-amr-r vela_ctrl_c") => async () => ({ type: "api", key })
const all = () => {
  fake.route("GET /api/v1/wallet/balance", () => json(WALLET))
  fake.route("GET /api/v1/billing/summary", () => json(SUMMARY))
  fake.route("GET /api/v1/workspaces/current", () => json({ activeWorkspaceId: "ws_1" }))
  fake.route("GET /api/v1/workspaces/ws_1/billing/preflight", () => json(PREFLIGHT))
}

test("the card: plan, wallet and credit buckets, period end, Coding Plan windows shortest first", async () => {
  all()
  const u = await _internal.usage(auth())
  expect(u.error).toBeUndefined()
  expect(u.plan).toBe("Pro")
  expect(u.balance).toBe("$12.35 · 42k plan credits + 12k top-up credits")
  expect(u.until).toBe("2026-11-01T00:00:00.000Z")
  expect(u.renew).toBe("auto")
  expect(u.signIn).toBe("kept")
  expect(u.windows.map((w) => [w.name, w.used, w.span, w.resetsAt])).toEqual([
    ["5 hours", 25, 18000, "2026-10-14T11:00:00.000Z"],
    ["Weekly", 25, 604800, "2026-10-19T00:00:00.000Z"],
  ])
  expect(u.windows[0].display).toBe("1500 / 6000 credits")
})

test("every control-plane read carries only the control key, never the runtime key", async () => {
  all()
  await _internal.usage(auth())
  expect(fake.seen.length).toBe(4)
  for (const r of fake.seen) expect(r.headers.get("authorization")).toBe("Bearer vela_ctrl_c")
})

test("credit strings past a double's precision divide exactly", () => {
  expect(_internal.share("1", "3")).toBe(33.33)
  expect(_internal.share("99999999999999999999", "100000000000000000000")).toBe(99.99)
  expect(_internal.share("5", "0")).toBeNull()
})

test("an account with no Coding Plan shows no windows, VELA_WORKSPACE_ID is the workspace", async () => {
  process.env.VELA_WORKSPACE_ID = "ws_env"
  fake.route("GET /api/v1/wallet/balance", () => json(WALLET))
  fake.route("GET /api/v1/billing/summary", () => json({ ...SUMMARY, membershipTier: "free", subscriptionStatus: "none" }))
  fake.route("GET /api/v1/workspaces/ws_env/billing/preflight", () => json({ ...PREFLIGHT, codingPlan: { ...PREFLIGHT.codingPlan, eligible: false } }))
  const u = await _internal.usage(auth())
  expect(u.windows).toEqual([])
  expect(u.plan).toBe("Free")
  expect(u.error).toBeUndefined()
  expect(fake.seen.some((r) => r.path === "/api/v1/workspaces/current")).toBe(false)
})

test("a Coding Plan read that fails says so and keeps the balance", async () => {
  all()
  fake.route("GET /api/v1/workspaces/ws_1/billing/preflight", () => json({ message: "boom" }, 500))
  const u = await _internal.usage(auth())
  expect(u.balance).toStartWith("$12.35")
  expect(u.error).toContain("Coding Plan limits couldn't be read")
  expect(u.signIn).toBe("kept")
})

test("a refused control key marks the sign-in", async () => {
  all()
  fake.route("GET /api/v1/wallet/balance", () => json({ message: "unauthorized" }, 401))
  const u = await _internal.usage(auth())
  expect(u.signIn).toBe("expired")
  expect(u.error).toContain("sign in again")
})

test("a runtime key alone has no balance to read, and asks for nothing", async () => {
  const u = await _internal.usage(auth("sk-amr-only"))
  expect(u.error).toContain("vela_ctrl_")
  expect(u.signIn).toBe("kept")
  expect(fake.seen.length).toBe(0)
})

test("a cancelled subscription doesn't renew, and a past-due one says so", () => {
  const u = _internal.usageOf({ summary: { ...SUMMARY, subscriptionStatus: "past_due", subscriptionCancelAtPeriodEnd: true } })
  expect(u.plan).toBe("Pro (past due)")
  expect(u.renew).toBe("off")
})

test("money is a decimal string or nothing", () => {
  expect(_internal.money("0")).toBe("$0.00")
  expect(_internal.money("0.004")).toBe("$0.004")
  expect(_internal.money("abc")).toBe("")
  expect(_internal.money("-1")).toBe("")
})
