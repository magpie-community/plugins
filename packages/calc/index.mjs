// Exact arithmetic, unit conversion and date math, as tools magpie offers
// every agent (its MCP server /mcp/magpie/tools). The arguments are JSON
// Schema, so the package needs no zod and no other dependency.
import { addDuration, answer, between, checkZone, convert, describe, evaluate, parseDate, parseDuration } from "./calc.mjs"

const str = (v, name) => {
  if (typeof v !== "string" && typeof v !== "number") throw new Error(`${name} is a string`)
  return String(v)
}
const places = (v) => (v === undefined ? 20 : Number.isFinite(+v) ? +v : 20)

export const CalcTools = async () => ({
  tool: {
    eval: {
      description:
        "Evaluates an arithmetic expression exactly, with no floating point: 0.1+0.2 is 3/10, 2^64 is every digit. " +
        "Takes + - * / % ^ (or **), parentheses, decimals, 1e9, 0x/0b/0o literals, 1_000, and abs floor ceil round trunc min max gcd lcm fact. " +
        "Answers the exact fraction and the decimal; `rounded` says when the decimal was cut. Use it instead of doing arithmetic in your head.",
      args: {
        type: "object",
        properties: {
          expression: { type: "string", description: "e.g. (17.5 * 3 - 2) / 7, 2^100, gcd(1071, 462)" },
          places: { type: "number", description: "decimal places to write (default 20, at most 1000)" },
        },
        required: ["expression"],
      },
      async execute(args) {
        return answer(evaluate(str(args.expression, "expression")), places(args.places))
      },
    },
    convert: {
      description:
        "Converts a quantity between units exactly. Data: bit B kB MB GB TB (1000s), KiB MiB GiB TiB (1024s), kb Mb Gb (bits). " +
        "Time: ns us ms s min h d wk. Length: nm um mm cm m km in ft yd mi nmi. CSS: px pt pc. Mass: mg g kg t oz lb. " +
        "Angle: deg turn grad. Temperature: C F K. The value can be an expression (e.g. 3*1024).",
      args: {
        type: "object",
        properties: {
          value: { type: "string", description: "the amount, e.g. 1.5 or 3*1024" },
          from: { type: "string", description: "its unit, e.g. GiB" },
          to: { type: "string", description: "the unit wanted, e.g. MB" },
          places: { type: "number", description: "decimal places to write (default 20)" },
        },
        required: ["value", "from", "to"],
      },
      async execute(args) {
        const v = convert(str(args.value, "value"), str(args.from, "from").trim(), str(args.to, "to").trim())
        return { ...answer(v, places(args.places)), unit: String(args.to).trim() }
      },
    },
    date: {
      description:
        "Date and time math on the real calendar. Give `date` (ISO 8601, unix seconds or ms, or now) and get its weekday, ISO week, day of year and unix time; " +
        "add `add` (e.g. \"3d 4h\", \"-90m\", \"1y2mo\", \"P1DT2H\": years, months and days on the calendar, Jan 31 + 1mo is the last of February); " +
        "give `to` for the time between the two, in days, hours, seconds and calendar years/months/days. " +
        "`timeZone` (IANA, e.g. Asia/Shanghai) reads dates with no offset as that zone's wall time and shows the local time; without it they are UTC.",
      args: {
        type: "object",
        properties: {
          date: { type: "string", description: "the date: 2026-10-16, 2026-10-16T09:30, 2026-10-16T09:30+08:00, 1760000000, or now (the default)" },
          add: { type: "string", description: "a duration to add to date, e.g. 3d 4h, -2w, 1y2mo, P1M" },
          to: { type: "string", description: "a second date: answers the time from date (after add) to it" },
          timeZone: { type: "string", description: "an IANA time zone, e.g. Europe/Berlin" },
        },
      },
      async execute(args) {
        const tz = checkZone(args.timeZone === undefined ? "" : str(args.timeZone, "timeZone").trim())
        const now = Date.now()
        let t = parseDate(args.date === undefined ? "now" : str(args.date, "date"), tz, now)
        if (args.add !== undefined && args.add !== "") t = addDuration(t, parseDuration(str(args.add, "add")), tz)
        const out = describe(t, tz)
        if (args.to !== undefined && args.to !== "") {
          const u = parseDate(str(args.to, "to"), tz, now)
          out.to = describe(u, tz)
          out.between = between(t, u, tz)
        }
        return out
      },
    },
  },
})
