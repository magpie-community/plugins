// The credit card: the console's display strings become the card's balance
// line, transactions become a best-effort "recent activity" row, and a failed
// read is said, never guessed as 0.
import "./nonet.mjs"
import { describe, expect, test } from "bun:test"
import { cardOf, localDay, optionalNum, spendRowOf } from "./lib/quota.mjs"
import { usageSummaryBody } from "./fake.mjs"

describe("small quota helpers", () => {
  test("optionalNum keeps 0, drops blanks and non-numbers", () => {
    expect(optionalNum(0)).toBe(0)
    expect(optionalNum("34.56")).toBe(34.56)
    expect(optionalNum("")).toBeUndefined()
    expect(optionalNum(null)).toBeUndefined()
    expect(optionalNum("n/a")).toBeUndefined()
  })

  test("localDay uses the local calendar day, not UTC", () => {
    // 2026-11-20T20:00:00Z is 2026-11-21 in UTC+8: the date must not slip back
    const d = localDay("2026-11-20T20:00:00Z")
    expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(d).toBe(
      (() => {
        const x = new Date("2026-11-20T20:00:00Z")
        return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`
      })(),
    )
    expect(localDay("not a date")).toBeUndefined()
  })
})

describe("spendRowOf", () => {
  test("sums the last 7 days' spends and grants into one recent-activity row", () => {
    const now = Date.parse("2026-11-21T03:00:00Z")
    const daysAgo = (d, h) => new Date(now - d * 86_400_000 - h * 3_600_000).toISOString()
    const row = spendRowOf(
      {
        items: [
          { credit_points: -12.5, created_at: daysAgo(0, 1) },
          { credit_points: -3.5, created_at: daysAgo(1, 1) },
          { credit_points: 100, created_at: daysAgo(2, 1) },
          { credit_points: -99, created_at: daysAgo(9, 0) }, // older than 7 days: not "recent"
          { credit_points: 55, created_at: "not a date" }, // undated: left out, not guessed
          { credit_points: 0, created_at: daysAgo(0, 2) }, // zero: skipped
          { credit_points: "junk", created_at: daysAgo(0, 3) }, // unparseable: skipped
          null,
        ],
      },
      { nowMs: now },
    )
    expect(row?.name).toBe("近期流水")
    expect(row?.aside).toBe(true)
    expect(row?.display).toContain("近期消耗 16")
    expect(row?.display).toContain("近期到账 100")
  })

  test("an empty or broken list returns null — no invented numbers", () => {
    expect(spendRowOf({ items: [] })).toBeNull()
    expect(spendRowOf(null)).toBeNull()
    expect(spendRowOf({ items: [{ credit_points: "junk" }] })).toBeNull()
  })

  test("the 7-day window boundary: exactly 7 days still counts, a tick older does not", () => {
    const now = Date.parse("2026-11-21T00:00:00Z")
    const edge = new Date(now - 7 * 86_400_000).toISOString()
    const older = new Date(now - 7 * 86_400_000 - 1).toISOString()
    const inRow = spendRowOf({ items: [{ credit_points: -5, created_at: edge }] }, { nowMs: now })
    expect(inRow?.display).toContain("近期消耗 5")
    const outRow = spendRowOf({ items: [{ credit_points: -5, created_at: older }] }, { nowMs: now })
    expect(outRow).toBeNull()
  })

  test("a future-dated movement is left out of the recent window", () => {
    const now = Date.parse("2026-11-21T00:00:00Z")
    const row = spendRowOf(
      { items: [{ credit_points: 10, created_at: new Date(now + 3_600_000).toISOString() }] },
      { nowMs: now },
    )
    expect(row).toBeNull()
  })
})

describe("cardOf", () => {
  test("the console's display strings become the balance line; frozen and days join", () => {
    const card = cardOf({
      summary: usageSummaryBody(),
      user: "张三",
      spendRow: { name: "近期流水", used: 0, display: "近期消耗 16 · 2026-11-21", aside: true },
    })
    expect(card.plan).toBe("MOSS 积分")
    expect(card.user).toBe("张三")
    expect(card.balance).toContain("1,200.00")
    expect(card.balance).toContain("冻结 34.56")
    expect(card.windows[0].name).toBe("近期流水")
    expect(card.windows[1].name).toBe("预估可用")
    expect(card.windows[1].display).toContain("12")
    expect(card.signIn).toBe("kept")
  })

  test("the daily-gift row points at MOSS Create, where the 50 credits are granted", () => {
    const card = cardOf({ summary: usageSummaryBody() })
    const daily = card.windows.find((w) => w.name === "每日赠送")
    expect(daily?.display).toContain("create.moss.cn")
    expect(daily?.display).toContain("50")
    expect(daily?.aside).toBe(true)
  })

  test("a missing summary still yields an honest, empty card", () => {
    const card = cardOf({ errors: ["usage summary: HTTP 403"] })
    expect(card.plan).toBe("MOSS 积分")
    expect(card.windows).toEqual([])
    expect(card.balance).toBeUndefined()
    expect(card.error).toContain("403")
  })

  test("frozen of 0 is not shown as a frozen line", () => {
    const card = cardOf({ summary: { display_available_points: "500.00", frozen_points: 0 } })
    expect(card.balance).toBe("500.00 积分")
    expect(card.balance).not.toContain("冻结")
  })

  test("fallback shapes: the total-remaining string is used when available is missing", () => {
    const card = cardOf({ summary: { display_total_remaining_points: "900.50" } })
    expect(card.balance).toBe("900.50 积分")
  })

  test("a balance line is omitted when the console sent no readable amount", () => {
    const card = cardOf({ summary: {} })
    expect(card.balance).toBeUndefined()
    // the daily-gift aside row is still there — it does not depend on the balance
    expect(card.windows.some((w) => w.name === "每日赠送")).toBe(true)
  })

  test("a frozen amount without its display string is not invented", () => {
    const card = cardOf({ summary: { display_available_points: "10.00", frozen_points: 5 } })
    expect(card.balance).toBe("10.00 积分")
    expect(card.balance).not.toContain("冻结")
  })

  test("the days row rounds down and disappears for zero or missing days", () => {
    expect(cardOf({ summary: { estimated_available_days: 12.9 } }).windows.find((w) => w.name === "预估可用")?.display).toContain("12")
    expect(cardOf({ summary: { estimated_available_days: 0 } }).windows.find((w) => w.name === "预估可用")).toBeUndefined()
    expect(cardOf({ summary: {} }).windows.find((w) => w.name === "预估可用")).toBeUndefined()
  })

  test("errors land on the summary card too, with the rows kept", () => {
    const card = cardOf({ summary: usageSummaryBody(), errors: ["transactions read skipped: HTTP 500"] })
    expect(card.error).toContain("transactions")
    expect(card.balance).toContain("1,200.00")
    expect(card.signIn).toBe("kept")
  })
})
