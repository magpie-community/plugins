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
const V = scope.UsageView

// usage:summary as magpie answers it (pluginpage.go, pageRead)
const summary = {
  period: "7d", since: "2026-10-09T00:00:00+08:00", calls: 1234, errors: 12,
  input: 3456789, output: 210000, cacheRead: 2000000, cost: 41.5,
  models: [
    { model: "claude-sonnet-4-5", calls: 200, input: 3000000, output: 150000, cost: 30 },
    { model: "gpt-5-codex", calls: 1000, input: 450000, output: 50000, cost: 11 },
    { model: "deepseek-chat", calls: 34, input: 6789, output: 10000, cost: 0.5 },
  ],
}

test("asks for one read, usage:summary, and nothing else", () => {
  expect(pkg.magpie.permissions).toEqual(["usage:summary"])
  const reads = new Set()
  for (const f of readdirSync(page).filter((f) => f.endsWith(".js"))) {
    for (const m of read(f).matchAll(/magpie\.read\(\s*"([^"]+)"/g)) reads.add(m[1])
    // no way out of the frame: magpie's policy refuses these anyway
    expect(read(f)).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts/)
  }
  expect([...reads]).toEqual(["usage:summary"])
})

test("is a page magpie serves: its files in page/, scripts as files", () => {
  expect(pkg.main).toBeUndefined()
  expect(pkg.exports).toBeUndefined()
  expect(pkg.magpie.page).toEqual({
    title: "Usage glance",
    titles: { zh: "用量速览", "zh-TW": "用量速覽", ja: "使用量の概要", de: "Nutzung im Überblick" },
    file: "page/index.html",
    icon: "page/icon.svg",
  })
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
})

test("totals: calls, errors with their share, tokens, cost", () => {
  expect(V.tiles(summary, "en")).toEqual([
    { key: "calls", label: "Calls", value: "1,234", sub: "" },
    { key: "errors", label: "Errors", value: "12", sub: "1.0% of calls", bad: true },
    { key: "tokens", label: "Tokens", value: "3.67M", sub: "Input 3.46M · Output 210K · cache read 2.00M" },
    { key: "cost", label: "Cost", value: "$41.50", sub: "$0.03 per call" },
  ])
  expect(V.tiles(summary, "zh-CN")[0].label).toBe("调用")
})

test("an empty period has nothing to divide by", () => {
  const t = V.tiles({ calls: 0, errors: 0, input: 0, output: 0, cacheRead: 0, cost: 0, models: [] }, "en")
  expect(t.map((x) => x.value)).toEqual(["0", "0", "0", "$0"])
  expect(t[1]).toMatchObject({ sub: "", bad: false })
  expect(V.rows({ models: [] }, "tokens")).toEqual([])
  expect(V.since({ since: "0001-01-01T00:00:00Z" }, "en")).toContain("Since")
  expect(V.since({}, "en")).toBe("")
})

test("models sort by tokens, calls or cost, the bar a share of the first", () => {
  const byTokens = V.rows(summary, "tokens", "en")
  expect(byTokens.map((r) => r.name)).toEqual(["claude-sonnet-4-5", "gpt-5-codex", "deepseek-chat"])
  expect(byTokens[0]).toEqual({ name: "claude-sonnet-4-5", value: "3.15M", detail: "200 calls", share: 1 })
  expect(V.rows(summary, "calls", "en").map((r) => [r.name, r.value, r.detail])).toEqual([
    ["gpt-5-codex", "1,000", "$11.00"], ["claude-sonnet-4-5", "200", "$30.00"], ["deepseek-chat", "34", "$0.50"],
  ])
  const byCost = V.rows(summary, "cost", "zh")
  expect(byCost.map((r) => r.value)).toEqual(["$30.00", "$11.00", "$0.50"])
  expect(byCost[1].share).toBeCloseTo(11 / 30)
  expect(byCost[0].detail).toBe("200 调用")
  // a sort it doesn't know is tokens
  expect(V.rows(summary, "nope", "en")[0].name).toBe("claude-sonnet-4-5")
})

test("numbers read short", () => {
  expect([V.count(999), V.count(12345), V.count(123456), V.count(1234567), V.count(12345678), V.count(2.5e9)]).toEqual(["999", "12,345", "123K", "1.23M", "12.3M", "2.50B"])
  expect([V.money(0), V.money(0.004), V.money(1234.5)]).toEqual(["$0", "<$0.01", "$1,234.50"])
})
