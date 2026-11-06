// The card's small helpers in isolation: numbers and timestamps from the
// console are loosely typed, so every shape has to degrade to "unknown" rather
// than to a fake zero.
import "./nonet.mjs"
import { expect, test } from "bun:test"
import { cardOf, compact, flexNum, isoOf, localDay, optionalNum, packageRows, windowsOf } from "./lib/quota.mjs"

test("flexNum reads loose numbers and turns junk into 0", () => {
  expect(flexNum(600000)).toBe(600000)
  expect(flexNum("600000")).toBe(600000)
  expect(flexNum("591300.25")).toBe(591300.25)
  expect(flexNum(null)).toBe(0)
  expect(flexNum("")).toBe(0)
  expect(flexNum("abc")).toBe(0)
  expect(flexNum(-5)).toBe(0)
  expect(flexNum(Infinity)).toBe(0)
})

test("optionalNum keeps 'missing' distinct from 0", () => {
  expect(optionalNum(0)).toBe(0)
  expect(optionalNum("0")).toBe(0)
  expect(optionalNum(null)).toBeUndefined()
  expect(optionalNum(undefined)).toBeUndefined()
  expect(optionalNum("")).toBeUndefined()
  expect(optionalNum("abc")).toBeUndefined()
})

test("compact keeps at most two decimals and no thousands separators", () => {
  expect(compact(1000)).toBe("1000")
  expect(compact(9831.7)).toBe("9831.7")
  expect(compact(0.333)).toBe("0.33")
  expect(compact(0)).toBe("0")
})

test("isoOf accepts ISO strings and second/millisecond stamps, and rejects nonsense", () => {
  expect(isoOf("2026-11-05T08:00:00Z")).toBe("2026-11-05T08:00:00.000Z")
  // a local wall-clock time: compare against the same parse, not a fixed UTC
  // string, so the test does not depend on the runner's timezone
  expect(isoOf("2026-11-05 08:00:00")).toBe(new Date("2026-11-05T08:00:00").toISOString())
  // 0 is not "1970" — it is a missing timestamp, as a number or a string
  expect(isoOf(0)).toBeUndefined()
  expect(isoOf("0")).toBeUndefined()
  // second- and millisecond-scale stamps arrive as strings too
  expect(isoOf("1762320000")).toBe(new Date(1762320000 * 1000).toISOString())
  expect(isoOf("1762320000000")).toBe(new Date(1762320000000).toISOString())
  expect(isoOf(null)).toBeUndefined()
  expect(isoOf("")).toBeUndefined()
  expect(isoOf("not a date")).toBeUndefined()
})

test("localDay reads a local calendar day and ignores junk", () => {
  // build the expected day from the same local-time parse, so the assertion
  // holds in every timezone (a fixed UTC string fails west of UTC)
  const stamp = "2026-11-28T00:00:00.000Z"
  const d = new Date(stamp)
  const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  expect(localDay(stamp)).toBe(expected)
  expect(localDay("not a date")).toBeUndefined()
})

test("windowsOf skips disabled, limitless and unmeasurable windows", () => {
  const out = windowsOf({
    usage_windows: {
      "5h": { enabled: false, limit_credits: 10, remaining_credits: 1 },
      "7d": { enabled: true, limit_credits: 0, remaining_credits: 0 },
    },
  })
  expect(out).toEqual([])
})

test("windowsOf clamps an over-spent window to 100% and prefers used_credits", () => {
  const [five] = windowsOf({
    usage_windows: {
      "5h": { enabled: true, limit_credits: 10, used_credits: 25, remaining_credits: 0, next_recover_at: 0 },
    },
  })
  expect(five.used).toBe(100)
  expect(five.display).toBe("25 / 10")
  expect(five.resetsAt).toBeUndefined()
})

test("packageRows tolerates every envelope and filters empty or dead packs", () => {
  const packs = [
    { remark: "每月免费基础包", remaining_credits: 6.5, total_credits: 10, status: "available" },
    { remark_en: "Top-up", remaining_credits: 3, total_credits: 3, status: "unused" },
    { remark: "empty", remaining_credits: 0, total_credits: 10, status: "available" },
    { remark: "expired", remaining_credits: 5, total_credits: 5, status: "expired" },
  ]
  const rows = packageRows({ packages: packs })
  expect(rows.map((r) => r.name)).toEqual(["每月免费基础包", "Top-up"])
  // amount is the *used* share: 10 - 3.5, used is the percentage, limit is the total
  expect(rows[0]).toEqual({
    name: "每月免费基础包",
    used: 35,
    display: "剩 6.5 / 10",
    amount: 3.5,
    limit: 10,
    unit: "墨点",
    aside: true,
  })
  expect(packageRows({ items: packs }).length).toBe(2)
  expect(packageRows(packs).length).toBe(2)
  expect(packageRows(null)).toEqual([])
  // a pack with no name still gets a readable label
  expect(packageRows([{ remaining_credits: 1, total_credits: 2 }])[0].name).toBe("墨点包1")
  // a pack with no total shows only the remainder, never "剩 1 / 0"
  const noTotal = packageRows([{ remaining_credits: 1, status: "available" }])[0]
  expect(noTotal.display).toBe("剩 1")
  expect(noTotal.limit).toBeUndefined()
  expect(noTotal.amount).toBeUndefined()
  // a pack with no expiry loses runsOutAt and never mutates resetsAt
  expect(packageRows([{ remaining_credits: 1, total_credits: 1 }])[0].resetsAt).toBeUndefined()
})

test("cardOf with nothing at all still produces a card, not a crash", () => {
  const card = cardOf()
  expect(card.plan).toBe("墨点计划 (Token Plan)")
  expect(card.windows).toEqual([])
  expect(card.balance).toBeUndefined()
  expect(card.signIn).toBe("kept")
})

test("cardOf shows a pack count even when the balance number is missing", () => {
  const card = cardOf({ balance: { active_package_count: 2 } })
  expect(card.balance).toBe("2 个可用包")
})
