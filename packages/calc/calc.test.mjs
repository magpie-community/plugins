import { expect, test } from "bun:test"
import { CalcTools } from "./index.mjs"

const { tool } = await CalcTools({})
// the host calls execute(args, ctx); these tools need nothing from ctx
const call = (name, args) => tool[name].execute(args, { agent: "test", abort: AbortSignal.timeout(5000) })

test("gives three tools, each with a JSON Schema and an execute", () => {
  expect(Object.keys(tool).sort()).toEqual(["convert", "date", "eval"])
  for (const [name, t] of Object.entries(tool)) {
    expect(name).toMatch(/^[A-Za-z0-9_-]{1,48}$/)
    expect(t.description.length).toBeGreaterThan(40)
    expect(t.args.type).toBe("object")
    expect(typeof t.execute).toBe("function")
  }
})

test("eval answers exactly where floating point doesn't", async () => {
  expect(await call("eval", { expression: "0.1 + 0.2" })).toEqual({ exact: "3/10", decimal: "0.3" })
  expect(await call("eval", { expression: "2^64" })).toEqual({ exact: "18446744073709551616", decimal: "18446744073709551616" })
  expect(await call("eval", { expression: "1/3", places: 5 })).toEqual({ exact: "1/3", decimal: "0.33333", rounded: "to 5 places" })
  expect(await call("eval", { expression: "2/3", places: 3 })).toMatchObject({ decimal: "0.667" })
  expect(await call("eval", { expression: "-2^2" })).toMatchObject({ exact: "-4" })
  expect(await call("eval", { expression: "2^3^2" })).toMatchObject({ exact: "512" })
  expect(await call("eval", { expression: "2 ** -2" })).toMatchObject({ exact: "1/4", decimal: "0.25" })
  expect(await call("eval", { expression: "(17.5 * 3 - 2) / 7" })).toMatchObject({ exact: "101/14" })
  expect(await call("eval", { expression: "-7 % 3" })).toMatchObject({ exact: "-1" })
  expect(await call("eval", { expression: "0xff + 0b11 + 0o10 + 1_000" })).toMatchObject({ exact: "1266" })
  expect(await call("eval", { expression: "6.02e23 / 1e-3" })).toMatchObject({ exact: "602000000000000000000000000" })
  expect(await call("eval", { expression: "gcd(1071, 462) + lcm(4, 6) + max(1, 7/2) + round(-2.5) + floor(-0.5)" })).toMatchObject({ exact: "65/2" })
  expect(await call("eval", { expression: "fact(20)" })).toMatchObject({ exact: "2432902008176640000" })
})

test("eval says what is wrong instead of guessing", async () => {
  await expect(call("eval", { expression: "1/0" })).rejects.toThrow("division by zero")
  await expect(call("eval", { expression: "2^(1/2)" })).rejects.toThrow("whole number")
  await expect(call("eval", { expression: "(1 + 2" })).rejects.toThrow('expected ")"')
  await expect(call("eval", { expression: "sqrt(2)" })).rejects.toThrow("no function sqrt")
  await expect(call("eval", { expression: "1 +" })).rejects.toThrow("ends too soon")
  await expect(call("eval", { expression: "2 $ 3" })).rejects.toThrow("can't read")
  await expect(call("eval", { expression: "2^1000000" })).rejects.toThrow("too big")
  await expect(call("eval", {})).rejects.toThrow("expression is a string")
})

test("convert is exact across data, time, length, CSS, mass, angle and temperature", async () => {
  expect(await call("convert", { value: "1", from: "GiB", to: "MB" })).toEqual({ exact: "16777216/15625", decimal: "1073.741824", unit: "MB" })
  expect(await call("convert", { value: "100", from: "Mb", to: "MB" })).toMatchObject({ exact: "25/2" })
  expect(await call("convert", { value: "3*1024", from: "KiB", to: "MiB" })).toMatchObject({ exact: "3" })
  expect(await call("convert", { value: "90", from: "min", to: "h" })).toMatchObject({ exact: "3/2" })
  expect(await call("convert", { value: "1", from: "mi", to: "km" })).toMatchObject({ decimal: "1.609344" })
  expect(await call("convert", { value: "12", from: "pt", to: "px" })).toMatchObject({ exact: "16" })
  expect(await call("convert", { value: "1", from: "lb", to: "kg" })).toMatchObject({ decimal: "0.45359237" })
  expect(await call("convert", { value: "90", from: "deg", to: "turn" })).toMatchObject({ exact: "1/4" })
  expect(await call("convert", { value: "98.6", from: "F", to: "C" })).toMatchObject({ exact: "37" })
  expect(await call("convert", { value: "-40", from: "°C", to: "°F" })).toMatchObject({ exact: "-40" })
  expect(await call("convert", { value: "0", from: "K", to: "C" })).toMatchObject({ decimal: "-273.15" })
  await expect(call("convert", { value: "1", from: "kg", to: "m" })).rejects.toThrow("kg is mass and m is length")
  await expect(call("convert", { value: "1", from: "furlong", to: "m" })).rejects.toThrow("no unit furlong")
  await expect(call("convert", { value: "1", from: "C", to: "m" })).rejects.toThrow("can't convert")
})

test("date describes a date in UTC, or in a time zone", async () => {
  expect(await call("date", { date: "2026-10-16" })).toEqual({
    iso: "2026-10-16T00:00:00.000Z", weekday: "Friday", unix: 1792108800, unixMs: 1792108800000, dayOfYear: 289, isoWeek: "2026-W42",
  })
  // a wall time in a zone, and an offset given in the date itself
  expect(await call("date", { date: "2026-10-16T09:30", timeZone: "Asia/Shanghai" })).toMatchObject({ iso: "2026-10-16T01:30:00.000Z", local: "2026-10-16T09:30:00+08:00" })
  expect(await call("date", { date: "2026-10-16T09:30+08:00" })).toMatchObject({ iso: "2026-10-16T01:30:00.000Z" })
  // unix seconds and milliseconds
  expect(await call("date", { date: "1792108800" })).toMatchObject({ iso: "2026-10-16T00:00:00.000Z" })
  expect(await call("date", { date: "1792108800000" })).toMatchObject({ iso: "2026-10-16T00:00:00.000Z" })
  // ISO weeks at a year's edge: 2027-01-01 is a Friday, in 2026's week 53
  expect(await call("date", { date: "2027-01-01" })).toMatchObject({ isoWeek: "2026-W53", weekday: "Friday" })
  expect(await call("date", { date: "2024-12-30" })).toMatchObject({ isoWeek: "2025-W01" })
  // now is the default
  const before = Date.now()
  const now = await call("date", {})
  expect(now.unixMs).toBeGreaterThanOrEqual(before)
  expect(now.unixMs - before).toBeLessThan(60_000)
})

test("date adds on the calendar: month ends and a DST change", async () => {
  expect(await call("date", { date: "2026-01-31", add: "1mo" })).toMatchObject({ iso: "2026-02-28T00:00:00.000Z" })
  expect(await call("date", { date: "2024-02-29", add: "1y" })).toMatchObject({ iso: "2025-02-28T00:00:00.000Z" })
  expect(await call("date", { date: "2026-10-16T12:00Z", add: "-90m" })).toMatchObject({ iso: "2026-10-16T10:30:00.000Z" })
  expect(await call("date", { date: "2026-10-16", add: "P1DT2H" })).toMatchObject({ iso: "2026-10-17T02:00:00.000Z" })
  expect(await call("date", { date: "2026-10-16", add: "2 weeks 1d" })).toMatchObject({ iso: "2026-10-31T00:00:00.000Z" })
  // New York springs forward on 2026-03-08: a day later is noon again, 23 hours on
  const r = await call("date", { date: "2026-03-07T12:00", add: "1d", timeZone: "America/New_York" })
  expect(r).toMatchObject({ local: "2026-03-08T12:00:00-04:00", iso: "2026-03-08T16:00:00.000Z" })
  const d = await call("date", { date: "2026-03-07T12:00", add: "24h", timeZone: "America/New_York" })
  expect(d.local).toBe("2026-03-08T13:00:00-04:00")
})

test("date counts the time between two dates", async () => {
  const r = await call("date", { date: "2024-02-29", to: "2026-10-16T10:30Z" })
  expect(r.between).toEqual({ calendar: "2y 7mo 17d 10h 30m", days: 960.4375, hours: 23050.5, minutes: 1383030, seconds: 82981800, ms: 82981800000 })
  expect(r.to.weekday).toBe("Friday")
  const back = await call("date", { date: "2026-10-16", to: "2026-01-01" })
  expect(back.between).toMatchObject({ calendar: "-9mo 15d", days: -288 })
  expect((await call("date", { date: "2026-10-16", to: "2026-10-16" })).between.calendar).toBe("0s")
})

test("date says what is wrong", async () => {
  await expect(call("date", { date: "2026-02-30" })).rejects.toThrow("no such date")
  await expect(call("date", { date: "next tuesday" })).rejects.toThrow("not a date")
  await expect(call("date", { date: "2026-10-16", add: "3 fortnights" })).rejects.toThrow("no duration unit")
  await expect(call("date", { date: "2026-10-16", add: "1.5mo" })).rejects.toThrow("whole")
  await expect(call("date", { timeZone: "Mars/Olympus" })).rejects.toThrow("no time zone")
})
