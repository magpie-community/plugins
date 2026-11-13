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
new Function("globalThis", read("icons.js"))(scope)

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

test("Amp uses its bundled official logo only when the host supplies no Amp icon", () => {
  const host = { src: "data:image/svg+xml;base64,PHN2Zy8+" }
  const amp = (icon, icons = {}) =>
    V.card({ ...day, icons, agents: [{ id: "amp", name: "Amp", icon, cost: 3.69, models: [] }] }, "en")
  expect(amp("amp", { amp: host }).agents[0].icon).toBe("amp")
  expect(amp("generic", { generic: host }).agents[0].icon).toBe("amp-official")
  for (const icon of [undefined, "", "generic", "amp"]) {
    const c = amp(icon)
    expect(c.agents[0].icon).toBe("amp-official")
    const mark = scope.DayIcons[c.agents[0].icon]
    expect(mark.mono).toBe(true)
    expect(mark.src).toStartWith("data:image/svg+xml;base64,")
    const svg = Buffer.from(mark.src.split(",")[1], "base64").toString("utf8")
    expect(svg).toContain('viewBox="0 0 281 144"')
    expect(svg).toContain("<path ")
    expect(svg).not.toMatch(/<(?:script|image|foreignObject)\b/)
  }
  const html = read("index.html")
  expect(html.indexOf('src="icons.js"')).toBeLessThan(html.indexOf('src="app.js"'))
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
      else if (Array.isArray(v)) expect([lang, k, v.flat().join("").trim() !== ""]).toEqual([lang, k, true])
      // Chinese and Japanese put no word between a date and its time
      else if (k !== "at") expect([lang, k, v.trim() !== ""]).toEqual([lang, k, true])
    }
  }
  for (const m of read("index.html").matchAll(/data-t(?:-label)?="([^"]+)"/g)) expect(keys).toContain(m[1])
  expect([V.langOf("zh-CN"), V.langOf("zh-TW"), V.langOf("zh-Hant-HK"), V.langOf("ja-JP"), V.langOf("de-DE"), V.langOf("fr"), V.langOf("")]).toEqual(["zh", "zh-TW", "zh-TW", "ja", "de", "en", "en"])
})

// the clock the card's ISSUED line reads, by this computer's zone
const now = new Date(2026, 10, 9, 23, 4)

test("the receipt: title, the day, its cost, then its parts", () => {
  const c = V.card(day, "en", {}, now)
  expect(c.title).toBe("DAILY AI STATEMENT")
  expect(c.head).toEqual([
    { label: "DATE", value: "NOV 9, 2026" },
    { label: "ISSUED", value: "NOV 9, 2026 AT 23:04" },
  ])
  expect(c.total).toBe("$12.35")
  expect(c.stats).toEqual([
    { label: "STREAK", value: "4 DAYS" },
    { label: "REQUESTS", value: "412" },
    { label: "ERRORS", value: "3" },
    // $12.345 against the $2.50 of the four days before
    { label: "VS AVERAGE DAY", value: "4.9×" },
  ])
  expect(c.tokens).toEqual([
    { label: "TOTAL TOKENS", value: "10.0M" },
    { label: "INPUT", value: "1.20M" },
    { label: "OUTPUT", value: "300K" },
    // 8M of the 9.7M prompt came from the cache
    { label: "CACHE HIT RATE", value: "82%" },
  ])
  expect(c.note).toBe("2 requests without a price")
  expect(c.empty).toBe("")
  // no errors, no ERRORS line
  expect(V.card({ ...day, errors: 0 }, "en", {}, now).stats.map((s) => s.label)).toEqual(["STREAK", "REQUESTS", "VS AVERAGE DAY"])
  // the footer is magpie's, one word of each line bold
  for (const t of Object.values(V.TEXT)) expect(t.footer[0][1]).toBe("magpie")
  // and the receipt credits nowdex, whose design it follows, in every language
  for (const lang of Object.keys(V.TEXT)) expect(V.card(day, lang, {}, now).credit).toContain("nowdex.app")
})

test("a week, a month or all time is a receipt of its own", () => {
  const span = { ...day, from: "2026-11-03", days: [{ date: "2026-11-03", calls: 5, tokens: 10, cost: 1 }, { date: "2026-11-07", calls: 5, tokens: 10, cost: 1 }, { date: "2026-11-08", calls: 5, tokens: 10, cost: 1 }, { date: "2026-11-09", calls: 5, tokens: 10, cost: 1 }] }
  const w = V.card(span, "en", { span: "week" }, now)
  expect(w.title).toBe("WEEKLY AI STATEMENT")
  expect(w.head[0]).toEqual({ label: "PERIOD", value: "NOV 3, 2026 – NOV 9, 2026" })
  // 4 of the 7 days had calls, and $12.345 over them
  expect(w.stats.slice(-2)).toEqual([{ label: "ACTIVE DAYS", value: "4 / 7" }, { label: "AVG ACTIVE DAY", value: "$3.09" }])
  expect(w.stats.map((s) => s.label)).not.toContain("VS AVERAGE DAY")
  expect(V.card(span, "en", { span: "month" }, now).title).toBe("MONTHLY AI STATEMENT")
  const a = V.card(span, "zh", { span: "all" }, now)
  expect(a.title).toBe("累计 AI 账单")
  expect(a.stats.slice(-2)[0]).toEqual({ label: "活跃天数", value: "4 天" })
  expect(V.card({ ...span, calls: 0 }, "en", { span: "week" }, now).empty).toBe("No calls in this period.")
  // a magpie that answers a day (no from) draws a day, never a week's title
  expect(V.card(day, "en", { span: "week" }, now).title).toBe("DAILY AI STATEMENT")
  // what the read is asked, and the steps of the arrows
  expect([V.spanFrom("day", "2026-11-09"), V.spanFrom("week", "2026-11-09"), V.spanFrom("month", "2026-11-09"), V.spanFrom("all", "2026-11-09")]).toEqual(["", "2026-11-03", "2026-10-11", "all"])
  expect([V.stepDate("week", "2026-11-09", -1, "2026-11-11"), V.stepDate("week", "2026-11-09", 1, "2026-11-11"), V.stepDate("day", "2026-11-09", 1, "2026-11-11")]).toEqual(["2026-11-02", "2026-11-11", "2026-11-10"])
  expect([V.fileName("2026-11-09"), V.fileName("2026-11-09", "week", "2026-11-03"), V.fileName("2026-11-09", "all", "2020-01-01")]).toEqual(["magpie 2026-11-09", "magpie 2026-11-03 to 2026-11-09", "magpie all 2026-11-09"])
})

test("agents and their models by cost, each with what was left out", () => {
  const withCost = { ...day, agents: day.agents.map((a) => ({ ...a, models: a.models.map((m, i) => ({ ...m, cost: [1, 9][i] ?? 0 })) })) }
  const c = V.card(withCost, "en", {}, now)
  expect(c.agentHead).toEqual(["AGENT / MODEL", "COST"])
  expect(c.agents.map((a) => [a.name, a.icon, a.value])).toEqual([
    ["CLAUDE CODE", "claude-color", "$10.00"],
    ["CODEX", "openai", "$2.30"],
    ["NO AGENT NAMED", "generic", "$0.04"],
  ])
  // the cheaper model first by tokens, but by cost second
  expect(c.agents[0].models.map((m) => [m.name, m.value])).toEqual([["CLAUDE-HAIKU-4-5", "$9.00"], ["CLAUDE-OPUS-4-1", "$1.00"]])
  expect(c.agents[0].more).toBe("")
  expect(c.agents[1].more).toBe("+3 MORE")
  // a cheaper agent with more tokens goes below a dearer one
  const flipped = V.card({ ...day, agents: [{ ...day.agents[1], cost: 20 }, day.agents[0]] }, "en", {}, now)
  expect(flipped.agents.map((a) => a.name)).toEqual(["CODEX", "CLAUDE CODE"])
  // the card's limits, and what magpie itself left out
  const small = V.card({ ...day, moreAgents: 2 }, "en", { agents: 1, models: 1 }, now)
  expect(small.agents).toHaveLength(1)
  expect(small.agents[0].more).toBe("+1 MORE")
  expect(small.moreAgents).toBe("+4 MORE")
})

test("streak, and the day against the average day before it", () => {
  expect(V.streak(day.days, "2026-11-09", "2026-11-09")).toBe(4)
  // today with no calls yet keeps yesterday's streak
  expect(V.streak(day.days.slice(0, 4), "2026-11-09", "2026-11-09")).toBe(3)
  // a past day with none has none
  expect(V.streak(day.days, "2026-11-05", "2026-11-09")).toBe(0)
  expect(V.streak([], "2026-11-09", "2026-11-09")).toBe(0)
  // across a month and a year
  expect(V.streak([{ date: "2025-12-31", calls: 1 }, { date: "2026-01-01", calls: 1 }], "2026-01-01", "2026-01-02")).toBe(2)
  // the days before, not the day itself
  expect(V.average(day.days, "2026-11-09")).toEqual({ days: 4, tokens: 2500, cost: 2.5 })
  expect(V.average(day.days, "2026-11-01")).toBeNull()
  expect(V.versus({ cost: 26.25 }, { cost: 2.5, tokens: 1 })).toBe("10.5×")
  expect(V.versus({ cost: 500 }, { cost: 2, tokens: 1 })).toBe("250×")
  // nothing priced: by tokens
  expect(V.versus({ cost: 0, input: 300 }, { cost: 0, tokens: 100 })).toBe("3.0×")
  // early in a day: a sliver of the average, not none
  expect(V.versus({ cost: 0.07 }, { cost: 180, tokens: 1 })).toBe("<0.1×")
  expect(V.versus({ cost: 0.5 }, { cost: 5, tokens: 1 })).toBe("0.1×")
  expect(V.versus({ cost: 1 }, null)).toBe("–")
})

test("an empty day has nothing to divide by", () => {
  const c = V.card({ date: "2026-11-09", today: "2026-11-09", calls: 0, agents: [], days: [], currency: "usd" }, "zh", {}, now)
  expect(c.empty).toBe("这一天没有调用。")
  expect(c.total).toBe("$0.00")
  expect(c.tokens[0].value).toBe("0")
  expect(c.tokens.at(-1).value).toBe("–")
  expect(c.stats[0].value).toBe("0 天")
  expect(c.stats.at(-1).value).toBe("–")
  expect(c.head[1].value).toBe("2026年11月9日 23:04")
})

test("cost in the currency magpie's Settings picked", () => {
  expect(V.money(12.345, "usd", 7.1)).toBe("$12.35")
  expect(V.money(12.345, "cny", 7.1)).toBe("¥87.65")
  // no rate known: dollars still
  expect(V.money(12.345, "cny", 0)).toBe("$12.35")
  expect([V.money(0), V.money(0.004), V.money(0.0001, "cny", 7)]).toEqual(["$0.00", "<$0.01", "<¥0.01"])
  expect(V.card({ ...day, currency: "cny" }, "zh", {}, now).total).toBe("¥87.65")
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
  expect(V.receiptDate("2026-11-09", "de")).toBe("9. NOV. 2026")
  expect(V.fileName("2026-11-09")).toBe("magpie 2026-11-09")
})

test("numbers read short", () => {
  expect([V.count(999), V.count(12345), V.count(123456), V.count(1234567), V.count(12345678), V.count(172e6), V.count(2.5e9), V.count(10.1e9)]).toEqual(["999", "12,345", "123K", "1.23M", "12.3M", "172M", "2.50B", "10.1B"])
})

test("the receipt's face comes with the page, as data the frame can load", () => {
  const fonts = {}
  new Function("globalThis", read("fonts.js"))(fonts)
  expect(Object.keys(fonts.DayFonts).sort()).toEqual(["400", "700", "800"])
  // woff2, whole: a font the frame can't fetch is loaded from these bytes
  for (const b of Object.values(fonts.DayFonts)) expect(Buffer.from(b, "base64").subarray(0, 4).toString()).toBe("wOF2")
  const html = read("index.html")
  expect(html.indexOf('src="fonts.js"')).toBeGreaterThan(-1)
  expect(html.indexOf('src="fonts.js"')).toBeLessThan(html.indexOf('src="app.js"'))
  expect(read("fonts.LICENSE.txt")).toContain("SIL OPEN FONT LICENSE")
})

// backgrounds.js, as the page loads it
const bgScope = {}
new Function("globalThis", read("backgrounds.js"))(bgScope)
const B = bgScope.DayBackgrounds

test("every backdrop has a name in every language, and its picture comes with the page", () => {
  const ids = [...B.list.map((b) => b.id), "custom"]
  expect(new Set(ids).size).toBe(ids.length)
  for (const [lang, t] of Object.entries(V.TEXT)) for (const id of ids) expect([lang, id, typeof t[`bg-${id}`]]).toEqual([lang, id, "string"])
  const thumbs = {}
  new Function("globalThis", read("bg/thumbs.js"))(thumbs)
  for (const b of B.list.filter((b) => b.photo)) {
    // data:, so the canvas a photo is drawn on can still be copied and saved
    const photos = {}
    new Function("globalThis", read(`bg/${b.id}.js`))(photos)
    expect(photos.DayPhotos[b.id]).toMatch(/^data:image\/jpeg;base64,\/9j\//)
    expect(thumbs.DayThumbs[b.id]).toMatch(/^data:image\/jpeg;base64,\/9j\//)
  }
  const html = read("index.html")
  expect(html.indexOf('src="backgrounds.js"')).toBeLessThan(html.indexOf('src="app.js"'))
})

test("no background is the first choice, and the card fits the room it has", () => {
  expect(B.list[0].id).toBe("none")
  expect(B.norm({ bg: "none" }).bg).toBe("none")
  expect(B.meta("none").photo).toBe(false)
  // nothing is drawn under the paper, so what was there is cleared
  const calls = []
  const ctx = { save() {}, restore() {}, clearRect: (...a) => calls.push(a), fillRect() { throw new Error("drew") } }
  B.paint(ctx, 440, 900, 2, B.norm({ bg: "none" }), null)
  expect(calls).toEqual([[0, 0, 440, 900]])
  // fit: wide room, short screen -> the height rules; narrow room -> the width
  expect(B.fit(900, 500, 592, 1100, 760, 160)).toBe(269)
  expect(B.fit(300, 2000, 592, 1100, 760, 160)).toBe(300)
  expect(B.fit(2000, 2000, 592, 1100, 760, 160)).toBe(760)
  expect(B.fit(900, 10, 592, 1100, 760, 160)).toBe(160)
  expect(B.fit(100, 10, 592, 1100, 760, 160)).toBe(100)
  expect(read("app.js")).toContain("fitCard")
})

test("a saved backdrop is made sound before it is drawn", () => {
  expect(B.norm(null)).toEqual({ bg: "teal", pad: 76, blur: 0, dim: 0, image: "" })
  expect(B.norm({ bg: "seigaiha", pad: 500, blur: -3, dim: "40" })).toEqual({ bg: "seigaiha", pad: 160, blur: 0, dim: 40, image: "" })
  expect(B.norm({ bg: "nope", pad: "x" })).toMatchObject({ bg: "teal", pad: 76 })
  // a custom backdrop needs its picture, and only a picture as data:
  expect(B.norm({ bg: "custom" }).bg).toBe("teal")
  expect(B.norm({ bg: "custom", image: "https://example.com/a.jpg" })).toMatchObject({ bg: "teal", image: "" })
  expect(B.norm({ bg: "custom", image: "data:image/jpeg;base64,AAAA", pad: 24 })).toEqual({ bg: "custom", pad: 24, blur: 0, dim: 0, image: "data:image/jpeg;base64,AAAA" })
  expect(B.meta("custom").photo).toBe(true)
  expect(B.meta("nope").id).toBe("teal")
})

test("a picture of the reader's own can be removed, and a card drawn on it goes back to teal (netube99 on X)", () => {
  const mine = B.norm({ bg: "custom", image: "data:image/jpeg;base64,AAAA", pad: 40, blur: 6 })
  // app.js's dropPicture is pick({ image: "" }): the saved options lose the picture
  expect(B.norm({ ...mine, image: "" })).toEqual({ bg: "teal", pad: 40, blur: 6, dim: 0, image: "" })
  // a picture not in use goes, and the backdrop picked stays
  expect(B.norm({ ...mine, bg: "kraft", image: "" })).toMatchObject({ bg: "kraft", image: "" })
  const app = read("app.js")
  expect(app).toContain('pick({ image: "" })')
  // the badge is a button of its own, beside the picture's swatch, never in it
  expect(app).toContain("own.append(b, del)")
  const css = read("style.css")
  // shown on hover only where there is hover, and on focus, and always where there isn't
  expect(css).toContain("@media (hover: hover) and (pointer: fine) { .sw-own:hover .sw-del")
  expect(css).toContain(".sw-own:focus-within .sw-del")
  expect(css).toContain("@media not all and (hover: hover) and (pointer: fine) { .sw-del")
})

test("the blur and dim sliders stay put while a slider is dragged (#957)", () => {
  // classList.toggle(name, undefined) flips the class, so a pattern's photo
  // must be false, not missing, or every input event hides or shows them
  for (const id of [...B.list.map((b) => b.id), "custom"]) expect([id, typeof B.meta(id).photo]).toEqual([id, "boolean"])
  expect(read("app.js")).toContain('pop.classList.toggle("photo", B.meta(bg.bg).photo === true)')
})
