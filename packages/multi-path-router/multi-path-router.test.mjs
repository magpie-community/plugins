import * as mod from "./multi-path-router.middleware.js"
import { check } from "../../scripts/middleware.mjs"
import { test, expect } from "bun:test"

// 1. Run standard cases.json through the magpie middleware runner
check(import.meta.dir, mod)

// 2. Exact test suite for CST DeepSeek Peak / Off-peak time window calculations
test("DeepSeek CST peak & off-peak calculations", () => {
  // Monday 2026-10-19 10:00:00 CST (UTC+8 is 2026-10-19T02:00:00Z) -> Morning Peak (not off-peak)
  expect(mod.isDeepSeekOffPeak("2026-10-19T02:00:00Z")).toBe(false)

  // Monday 2026-10-19 11:59:00 CST (UTC 03:59:00Z) -> Morning Peak
  expect(mod.isDeepSeekOffPeak("2026-10-19T03:59:00Z")).toBe(false)

  // Monday 2026-10-19 12:00:00 CST (UTC 04:00:00Z) -> Lunch Off-peak! (12:00-14:00)
  expect(mod.isDeepSeekOffPeak("2026-10-19T04:00:00Z")).toBe(true)

  // Monday 2026-10-19 13:30:00 CST (UTC 05:30:00Z) -> Lunch Off-peak!
  expect(mod.isDeepSeekOffPeak("2026-10-19T05:30:00Z")).toBe(true)

  // Monday 2026-10-19 14:00:00 CST (UTC 06:00:00Z) -> Afternoon Peak (14:00-18:00)
  expect(mod.isDeepSeekOffPeak("2026-10-19T06:00:00Z")).toBe(false)

  // Monday 2026-10-19 17:59:00 CST (UTC 09:59:00Z) -> Afternoon Peak
  expect(mod.isDeepSeekOffPeak("2026-10-19T09:59:00Z")).toBe(false)

  // Monday 2026-10-19 18:00:00 CST (UTC 10:00:00Z) -> Night Off-peak! (18:00-次日09:00)
  expect(mod.isDeepSeekOffPeak("2026-10-19T10:00:00Z")).toBe(true)

  // Tuesday 2026-10-20 02:00:00 CST (UTC 2026-10-19T18:00:00Z) -> Night Off-peak!
  expect(mod.isDeepSeekOffPeak("2026-10-19T18:00:00Z")).toBe(true)

  // Saturday 2026-10-24 10:00:00 CST (UTC 02:00:00Z) -> Weekend All-day Off-peak!
  expect(mod.isDeepSeekOffPeak("2026-10-24T02:00:00Z")).toBe(true)

  // Sunday 2026-10-25 15:00:00 CST (UTC 07:00:00Z) -> Weekend All-day Off-peak!
  expect(mod.isDeepSeekOffPeak("2026-10-25T07:00:00Z")).toBe(true)
})
