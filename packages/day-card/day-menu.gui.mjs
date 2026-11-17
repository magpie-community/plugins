// The day menu lists every day with calls up to today, whatever day or span
// is shown (shangyuan0818 on X): a day or a week in the past used to list
// today and then the past day, as if the days between had no calls.
// usage:day's days stop at the date read, so the page reads today's days
// for the menu. Drives the real page in Chromium and WebKit, in a day, a
// week and a month, against a stub bridge that answers as magpie does.
// Run: NODE_PATH=<playwright's node_modules> node day-menu.gui.mjs
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { chromium, webkit } = require("playwright")
const page_dir = join(import.meta.dirname, "page")
const ALL = [["2026-10-20", 500], ["2026-11-01", 1000], ["2026-11-06", 2000], ["2026-11-07", 3000], ["2026-11-08", 4000], ["2026-11-09", 5000]]
const bridge = `
const ALL = ${JSON.stringify(ALL)};
window.magpie = {
  ready: Promise.resolve({ lang: "en", dark: false }),
  onTheme() {},
  // as usageapi.SpanOf: the days with calls up to date, never after it
  read: async (name, p) => {
    const today = "2026-11-09", date = p.date || today;
    const days = ALL.filter(([d]) => d <= date).map(([d, t]) => ({ date: d, calls: 1, tokens: t, cost: 1 }));
    return { date, today, from: p.from, calls: 1, errors: 0, input: 10, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 1, unpriced: 0, cacheUnknown: 0, agents: [], days, icons: {}, currency: "usd", rate: 7 };
  },
  options: { get: async () => null, set: async () => {} },
  image: { copy: async () => {}, save: async () => ({}) },
};`
const every = ["2026-11-09", "2026-11-08", "2026-11-07", "2026-11-06", "2026-11-01", "2026-10-20"]
await (async () => {
  let bad = 0
  const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++ }
  for (const [name, type] of [["chromium", chromium], ["webkit", webkit]]) {
    const browser = await type.launch()
    for (const span of ["day", "week", "month"]) {
      const p = await browser.newPage()
      const errs = []
      p.on("pageerror", (e) => errs.push(String(e)))
      await p.route("**/*", (r) => {
        const u = new URL(r.request().url())
        if (u.pathname.endsWith("/_magpie/bridge.js")) return r.fulfill({ contentType: "text/javascript", body: bridge })
        const f = join(page_dir, u.pathname.replace(/^\/day\//, ""))
        if (!existsSync(f)) return r.fulfill({ status: 404, body: "" })
        const ct = f.endsWith(".js") ? "text/javascript" : f.endsWith(".css") ? "text/css" : "text/html"
        r.fulfill({ contentType: ct, body: readFileSync(f) })
      })
      await p.goto("http://day.test/day/index.html")
      await p.waitForFunction(() => document.getElementById("date-text").textContent !== "…")
      const listed = async () => {
        await p.click("#date")
        await p.waitForSelector("#menu:not([hidden]) li")
        return p.$$eval("#menu li", (l) => l.map((x) => [x.dataset.date, x.getAttribute("aria-selected") === "true"]))
      }
      const tag = `${name} ${span}`
      let l = await listed()
      ok(JSON.stringify(l.map((x) => x[0])) === JSON.stringify(every), `${tag} today: every day (${l.map((x) => x[0]).join(" ")})`)
      await p.click('#menu li[data-date="2026-11-01"]')
      if (span !== "day") await p.click(`#spans [data-span="${span}"]`)
      await p.waitForFunction(() => /1/.test(document.getElementById("date-text").textContent) && !/Nov 9/.test(document.getElementById("date-text").textContent))
      l = await listed()
      ok(JSON.stringify(l.map((x) => x[0])) === JSON.stringify(every), `${tag} to 11-01: every day, not today then 11-01 (${l.map((x) => x[0]).join(" ")})`)
      ok(l.filter((x) => x[1]).map((x) => x[0]).join() === "2026-11-01", `${tag} to 11-01: 11-01 is the one picked`)
      await p.click('#menu li[data-date="2026-11-07"]')
      await p.waitForFunction(() => /7/.test(document.getElementById("date-text").textContent))
      ok(/Nov 7/.test(await p.textContent("#date-text")), `${tag}: a later day from the menu loads (${await p.textContent("#date-text")})`)
      ok(errs.length === 0, `${tag}: no page errors ${errs.join(";")}`)
      await p.close()
    }
    await browser.close()
  }
  console.log(bad ? `${bad} failed` : "all ok")
  process.exit(bad ? 1 : 0)
})()
