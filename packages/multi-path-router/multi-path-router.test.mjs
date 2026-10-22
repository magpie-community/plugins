import * as mod from "./multi-path-router.middleware.js"
import { check } from "../../scripts/middleware.mjs"
import { test, expect } from "bun:test"

// 1. Run standard cases.json through the magpie middleware runner
check(import.meta.dir, mod)

// 2. The optional preset window, in UTC+8 wherever the test runs
test("preset off-peak window in CST", () => {
  // Monday 2026-10-19 10:00 CST (UTC 02:00Z) -> morning peak
  expect(mod.isOffPeakPreset("2026-10-19T02:00:00Z")).toBe(false)

  // Monday 11:59 CST -> morning peak
  expect(mod.isOffPeakPreset("2026-10-19T03:59:00Z")).toBe(false)

  // Monday 12:00 CST -> lunch
  expect(mod.isOffPeakPreset("2026-10-19T04:00:00Z")).toBe(true)

  // Monday 13:30 CST -> lunch
  expect(mod.isOffPeakPreset("2026-10-19T05:30:00Z")).toBe(true)

  // Monday 14:00 CST -> afternoon peak
  expect(mod.isOffPeakPreset("2026-10-19T06:00:00Z")).toBe(false)

  // Monday 17:59 CST -> afternoon peak
  expect(mod.isOffPeakPreset("2026-10-19T09:59:00Z")).toBe(false)

  // Monday 18:00 CST -> night
  expect(mod.isOffPeakPreset("2026-10-19T10:00:00Z")).toBe(true)

  // Tuesday 02:00 CST -> night
  expect(mod.isOffPeakPreset("2026-10-19T18:00:00Z")).toBe(true)

  // Saturday 10:00 CST and Sunday 15:00 CST -> weekends all day
  expect(mod.isOffPeakPreset("2026-10-24T02:00:00Z")).toBe(true)
  expect(mod.isOffPeakPreset("2026-10-25T07:00:00Z")).toBe(true)

  // the old name still points at the preset
  expect(mod.isDeepSeekOffPeak("2026-10-24T02:00:00Z")).toBe(true)
})

// 3. The schedule is opt-in, and a user window replaces the preset
const at = (now, schedule) => {
  const body = { model: "smart-router", messages: [] }
  const options = { now, schedule, mapping: { "smart-router": "plain" } }
  mod.onRequest(body, { options, state: {} })
  return body.model
}

test("offpeak_mapping needs the schedule to say off-peak", () => {
  const mapping = { "smart-router": "cheap" }
  const sat = "2026-10-24T07:00:00Z"
  expect(at(sat, { offpeak_mapping: mapping })).toBe("cheap")
  expect(at(sat, { cst_deepseek_offpeak: true, offpeak_mapping: mapping })).toBe("cheap")
  expect(at(sat, { cst_deepseek_offpeak: false, offpeak_mapping: mapping })).toBe("plain")
  expect(at(sat, { cst_deepseek_offpeak: false })).toBe("plain")
})

test("a user window sets its own days, hours and offset", () => {
  const monday = { "smart-router": "cheap" }
  // Monday 2026-10-19 07:00 CST, inside 00:30-08:30 in UTC+8
  expect(at("2026-10-18T23:00:00Z", { offpeak: { start: "00:30", end: "08:30", tz: 8 }, offpeak_mapping: monday })).toBe("cheap")
  // same clock time, other offset
  expect(at("2026-10-18T23:00:00Z", { offpeak: { start: "00:30", end: "08:30", tz: -5 }, offpeak_mapping: monday })).toBe("plain")
  // Sunday is not in the window's days
  expect(at("2026-10-18T23:00:00Z", { offpeak: { days: [0], start: "00:30", end: "08:30", tz: 8 }, offpeak_mapping: monday })).toBe("plain")
  // a window crossing midnight owns the early hours of the next day
  expect(at("2026-10-18T21:00:00Z", { offpeak: { days: [0], start: "22:00", end: "06:00", tz: 8 }, offpeak_mapping: monday })).toBe("cheap")
  // several windows may be listed
  expect(at("2026-10-18T23:00:00Z", { offpeak: [{ start: "10:00", end: "11:00" }, { start: "00:30", end: "08:30" }], offpeak_mapping: monday })).toBe("cheap")
  // a malformed window never matches
  expect(at("2026-10-18T23:00:00Z", { offpeak: { start: "25:00", end: "08:30" }, offpeak_mapping: monday })).toBe("plain")
})

test("mapping reads own string targets only", () => {
  const run = (model, mapping) => {
    const body = { model, messages: [] }
    mod.onRequest(body, { options: { mapping }, state: {} })
    return body.model
  }
  expect(run("constructor", { "smart-router": "plain" })).toBe("constructor")
  expect(run("__proto__", { "smart-router": "plain" })).toBe("__proto__")
  expect(run("toString", { "smart-router": "plain" })).toBe("toString")
  expect(run("toString", { "*": "plain" })).toBe("plain")
  expect(run("claude-3", { "/^claude-(.*)$/": "plain" })).toBe("plain")
  expect(run("claude-3", { "/^claude-(.*)$/": { nested: true } })).toBe("claude-3")
})
