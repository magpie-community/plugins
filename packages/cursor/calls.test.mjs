// auth.calls lists the account's own calls that didn't go through magpie,
// for magpie's Usage page, from GetFilteredUsageEvents as Cursor answers it
// (fields as a real Pro account's reply has them, 2026-11).
import "./nonet.mjs" // first: no request leaves this machine
import { afterAll, afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const data = mkdtempSync(join(tmpdir(), "cursor-calls-"))
const outside = process.env.XDG_DATA_HOME // put back when the file ends: bun test runs every file in one process
process.env.XDG_DATA_HOME = data
const { CursorAuthPlugin, _internal } = await import("./index.mjs")

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))
afterAll(() => {
  rmSync(data, { recursive: true, force: true })
  outside === undefined ? delete process.env.XDG_DATA_HOME : (process.env.XDG_DATA_HOME = outside)
})

const jwt = (exp) => ["e30", Buffer.from(JSON.stringify({ exp, sub: "calls-" + Math.random() })).toString("base64url"), "sig"].join(".")
const auth = () => ({ type: "oauth", access: jwt(Math.floor(Date.now() / 1000) + 3600), refresh: "", expires: 0 })

const EVENTS = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetFilteredUsageEvents"
const ME = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetMe"

const event = (id, at, conv, extra = {}) => ({
  timestamp: String(at),
  model: "grok-4.7-medium",
  kind: "USAGE_EVENT_KIND_INCLUDED_IN_PRO",
  requestsCosts: 0.1,
  isTokenBasedCall: true,
  tokenUsage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 45000, totalCents: 0.415 },
  owningUser: "9573301",
  isChargeable: true,
  isHeadless: false,
  conversationId: conv,
  chargedCents: 0.415,
  usageEventId: id,
  ...extra,
})

function serve(pages) {
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined })
    if (String(url) === ME) return Response.json({ userId: 9573301, email: "a@b.c" })
    if (String(url) === EVENTS) {
      const b = JSON.parse(init.body)
      return Response.json(pages[b.page - 1] ?? { usageEventsDisplay: [] })
    }
    return Response.json({})
  }
  return seen
}

test("the account's own events from since on, less its other members' and this plugin's own conversations", async () => {
  const since = Date.now() - 86_400_000
  _internal.ownConversation("conv-magpie")
  const seen = serve([
    {
      totalUsageEventsCount: 4,
      usageEventsDisplay: [
        event("ev-2", since + 2000, "conv-editor"),
        event("ev-1", since + 1000, "conv-editor", { tokenUsage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 3, totalCents: 1.5 } }),
        event("ev-3", since + 3000, "conv-magpie"),
        event("ev-4", since + 4000, "conv-teammate", { owningUser: "111" }),
        event("ev-old", since - 5000, "conv-editor"),
      ],
    },
  ])
  const hooks = await CursorAuthPlugin()
  const { calls } = await hooks.auth.calls(async () => auth(), {}, { since })
  expect(calls).toEqual([
    { rid: "ev-1", t: since + 1000, model: "grok-4.7-medium", in: 10, out: 5, cache_read: 7, cache_write: 3, cost: 0.015, session: "conv-editor" },
    { rid: "ev-2", t: since + 2000, model: "grok-4.7-medium", in: 1200, out: 300, cache_read: 45000, cache_write: 0, cost: 0.00415, session: "conv-editor" },
  ])
  const ask = seen.find((r) => r.url === EVENTS)
  expect(ask.body.startDate).toBe(String(since))
  expect(ask.body.page).toBe(1)
})

test("every page is read, up to the total", async () => {
  const since = Date.now() - 86_400_000
  const page = (from, n) => ({ totalUsageEventsCount: 150, usageEventsDisplay: Array.from({ length: n }, (_, i) => event("p" + (from + i), since + 10 + from + i, "c")) })
  const seen = serve([page(0, 100), page(100, 50)])
  const { calls } = await (await CursorAuthPlugin()).auth.calls(async () => auth(), {}, { since })
  expect(calls.length).toBe(150)
  expect(seen.filter((r) => r.url === EVENTS).map((r) => r.body.page)).toEqual([1, 2])
})

test("a reply Cursor refuses fails the reading", async () => {
  globalThis.fetch = async (url) => (String(url) === EVENTS ? new Response("{}", { status: 503 }) : Response.json({ userId: 1 }))
  await expect((await CursorAuthPlugin()).auth.calls(async () => auth(), {}, { since: Date.now() - 1000 })).rejects.toThrow()
})

test("this plugin's own conversations are kept on disk, for the next start", async () => {
  _internal.ownConversation("conv-kept")
  await new Promise((r) => setTimeout(r, 1500))
  const kept = JSON.parse(readFileSync(join(data, "opencode-cursor-auth", "conversations.json"), "utf8"))
  expect(typeof kept["conv-kept"]).toBe("number")
})
