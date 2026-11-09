import { expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const dir = import.meta.dir
const page = join(dir, "page")
const read = (f) => readFileSync(join(page, f), "utf8")
const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))

// view.js is a classic script, as the page loads it
const scope = {}
new Function("globalThis", read("view.js"))(scope)
const V = scope.DayView

// usage:day as magpie answers it (internal/gui/pageday.go, usageapi.DayOf)
const day = {
  date: "2026-11-09", today: "2026-11-09",
  calls: 412, errors: 3, input: 1_200_000, output: 300_000, cacheRead: 8_000_000, cacheWrite: 500_000, reasoning: 0,
  cost: 12.345, unpriced: 2, cacheUnknown: 0,
  agents: [
    { id: "claude", name: "Claude Code", icon: "claude-color", calls: 300, input: 1_000_000, output: 200_000, cacheRead: 7_000_000, cacheWrite: 400_000, cost: 10,
      models: [
        { model: "claude-opus-4-1", provider: "anthropic", providerName: "Anthropic", icon: "claude-color", input: 800_000, output: 150_000, cacheRead: 6_000_000, cacheWrite: 300_000 },
        { model: "claude-haiku-4-5", provider: "anthropic", providerName: "Anthropic", icon: "claude-color", input: 200_000, output: 50_000, cacheRead: 1_000_000, cacheWrite: 100_000 },
      ] },
    { id: "codex", name: "Codex", icon: "openai", calls: 100, input: 150_000, output: 90_000, cacheRead: 900_000, cacheWrite: 0, cost: 2.3,
      models: [{ model: "gpt-5-codex", provider: "openai", icon: "openai", input: 150_000, output: 90_000, cacheRead: 900_000 }], moreModels: 3 },
    { id: "", name: "", icon: "generic", calls: 12, input: 50_000, output: 10_000, cacheRead: 100_000, cacheWrite: 100_000, cost: 0.04, models: [] },
  ],
  days: [
    { date: "2026-11-01", calls: 10, tokens: 1000, cost: 1 },
    { date: "2026-11-06", calls: 10, tokens: 2000, cost: 2 },
    { date: "2026-11-07", calls: 10, tokens: 3000, cost: 3 },
    { date: "2026-11-08", calls: 10, tokens: 4000, cost: 4 },
    { date: "2026-11-09", calls: 412, tokens: 10_000_000, cost: 12.345 },
  ],
  icons: {}, currency: "usd", rate: 7.1,
}

test("asks for one read, usage:day, and nothing else", () => {
  expect(pkg.magpie.permissions).toEqual(["usage:day"])
  const reads = new Set()
  for (const f of readdirSync(page).filter((f) => f.endsWith(".js"))) {
    for (const m of read(f).matchAll(/magpie\.read\(\s*"([^"]+)"/g)) reads.add(m[1])
    // no way out of the frame: magpie's policy refuses these anyway
    expect(read(f)).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts/)
  }
  expect([...reads]).toEqual(["usage:day"])
})

test("is a page magpie serves: its files in page/, scripts as files", () => {
  expect(pkg.main).toBeUndefined()
  expect(pkg.exports).toBeUndefined()
  expect(pkg.engines.magpie).toMatch(/^>=0\.1\.\d+$/)
  expect(Object.keys(pkg.magpie.page.titles).sort()).toEqual(["de", "ja", "zh", "zh-TW"])
  const html = read("index.html")
  expect(html).toContain('<script src="_magpie/bridge.js"></script>')
  // the policy runs no inline script
  for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    expect(m[1]).toMatch(/\ssrc="/)
    expect(m[2].trim()).toBe("")
  }
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (m[1].startsWith("_magpie/")) continue
    expect(m[1]).not.toMatch(/^(?:[a-z]+:|\/|\.\.)/i)
    expect(readdirSync(page)).toContain(m[1])
  }
  // magpie's GUI picks from its own menus, never a native select
  expect(html).not.toContain("<select")
})

test("every language has every word the page and the card use", () => {
  const keys = Object.keys(V.TEXT.en).sort()
  for (const [lang, t] of Object.entries(V.TEXT)) {
    expect([lang, Object.keys(t).sort()]).toEqual([lang, keys])
    for (const [k, v] of Object.entries(t)) {
      if (typeof v === "function") expect(v(2)).toContain("2")
      else expect([lang, k, v.trim() !== ""]).toEqual([lang, k, true])
    }
  }
  for (const m of read("index.html").matchAll(/data-t(?:-label)?="([^"]+)"/g)) expect(keys).toContain(m[1])
  expect([V.langOf("zh-CN"), V.langOf("zh-TW"), V.langOf("zh-Hant-HK"), V.langOf("ja-JP"), V.langOf("de-DE"), V.langOf("fr"), V.langOf("")]).toEqual(["zh", "zh-TW", "zh-TW", "ja", "de", "en", "en"])
})

test("the card: the day's tokens, cost, calls and errors, then its parts", () => {
  const c = V.card(day, "en")
  expect(c.headline).toBe("10.0M")
  expect(c.unit).toBe("tokens")
  expect(c.sub).toBe("$12.35 · 412 calls · 3 errors")
  expect(c.stats).toEqual([
    { label: "Input", value: "1.20M" },
    { label: "Output", value: "300K" },
    { label: "Cache read", value: "8.00M" },
    // 8M of the 9.7M prompt came from the cache
    { label: "Cache hits", value: "82%" },
  ])
  expect(c.date).toBe("Mon, Nov 9, 2026")
  expect(c.note).toBe("2 calls without a price")
  expect(c.empty).toBe("")
})

test("agents by their tokens, each with its models and what was left out", () => {
  const c = V.card(day, "en")
  expect(c.agents.map((a) => [a.name, a.icon, a.value])).toEqual([
    ["Claude Code", "claude-color", "8.60M · $10.00"],
    ["Codex", "openai", "1.14M · $2.30"],
    ["No agent named", "generic", "260K · $0.04"],
  ])
  expect(c.agents[0].share).toBe(1)
  expect(c.agents[1].share).toBeCloseTo(1.14 / 8.6)
  expect(c.agents[0].models.map((m) => [m.name, m.value])).toEqual([["claude-opus-4-1", "7.25M"], ["claude-haiku-4-5", "1.35M"]])
  expect(c.agents[0].models[0].share).toBe(1)
  expect(c.agents[0].models[1].share).toBeCloseTo(1.35 / 7.25)
  expect(c.agents[0].more).toBe("")
  expect(c.agents[1].more).toBe("+3 more")
  // the card's limits, and what magpie itself left out
  const small = V.card({ ...day, moreAgents: 2 }, "en", { agents: 1, models: 1 })
  expect(small.agents).toHaveLength(1)
  expect(small.agents[0].more).toBe("+1 more")
  expect(small.moreAgents).toBe("+4 more")
})

test("streak, average active day and the last two weeks", () => {
  expect(V.streak(day.days, "2026-11-09", "2026-11-09")).toBe(4)
  // today with no calls yet keeps yesterday's streak
  expect(V.streak(day.days.slice(0, 4), "2026-11-09", "2026-11-09")).toBe(3)
  // a past day with none has none
  expect(V.streak(day.days, "2026-11-05", "2026-11-09")).toBe(0)
  expect(V.streak([], "2026-11-09", "2026-11-09")).toBe(0)
  // across a month and a year
  expect(V.streak([{ date: "2025-12-31", calls: 1 }, { date: "2026-01-01", calls: 1 }], "2026-01-01", "2026-01-02")).toBe(2)
  expect(V.average(day.days, "2026-11-08")).toEqual({ days: 4, tokens: 2500, cost: 2.5 })
  expect(V.average([], "2026-11-08")).toBeNull()
  const c = V.card(day, "en")
  expect(c.streak).toEqual({ label: "Streak", value: "4 days" })
  expect(c.average.value).toBe("2.00M · $4.47")
  expect(c.bars).toHaveLength(14)
  expect(c.bars[0]).toEqual({ date: "2026-10-27", tokens: 0 })
  expect(c.bars.at(-1)).toEqual({ date: "2026-11-09", tokens: 10_000_000 })
  expect(c.bars.filter((b) => b.tokens).length).toBe(5)
})

test("an empty day has nothing to divide by", () => {
  const c = V.card({ date: "2026-11-09", today: "2026-11-09", calls: 0, agents: [], days: [], currency: "usd" }, "zh")
  expect(c.empty).toBe("这一天没有调用。")
  expect(c.headline).toBe("0")
  expect(c.stats.at(-1).value).toBe("–")
  expect(c.streak.value).toBe("0 天")
  expect(c.average.value).toBe("–")
  expect(c.sub).toBe("$0 · 0 次调用")
})

test("cost in the currency magpie's Settings picked", () => {
  expect(V.money(12.345, "usd", 7.1)).toBe("$12.35")
  expect(V.money(12.345, "cny", 7.1)).toBe("¥87.65")
  // no rate known: dollars still
  expect(V.money(12.345, "cny", 0)).toBe("$12.35")
  expect([V.money(0), V.money(0.004), V.money(0.0001, "cny", 7)]).toEqual(["$0", "<$0.01", "<¥0.01"])
  expect(V.card({ ...day, currency: "cny" }, "zh").sub).toBe("¥87.65 · 412 次调用 · 3 次错误")
})

test("hit rate leaves out what a vendor counts no cache for", () => {
  expect(V.hitRate({ input: 100, cacheRead: 300 })).toBe(0.75)
  expect(V.hitRate({ input: 100, cacheRead: 300, cacheUnknown: 100 })).toBe(1)
  expect(V.hitRate({})).toBeNull()
  expect(V.percent(0.004)).toBe("0.4%")
})

test("dates in the reader's language, by the calendar", () => {
  expect(V.shift("2026-03-01", -1)).toBe("2026-02-28")
  expect(V.shift("2026-12-31", 1)).toBe("2027-01-01")
  expect(V.dateLabel("2026-11-09", "zh")).toContain("2026")
  expect(V.dateLabel("2026-11-09", "de")).toContain("2026")
  expect(V.fileName("2026-11-09")).toBe("magpie 2026-11-09")
})

test("numbers read short", () => {
  expect([V.count(999), V.count(12345), V.count(123456), V.count(1234567), V.count(12345678), V.count(2.5e9)]).toEqual(["999", "12,345", "123K", "1.23M", "12.3M", "2.50B"])
})
