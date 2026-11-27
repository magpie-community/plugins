import { test } from "bun:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { createRequire } from "node:module"

const dir = import.meta.dir
const page = join(dir, "page")
const read = (f) => readFileSync(join(page, f), "utf8")
const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))

// model.js, i18n.js and ink.js are classic scripts that also export for a test,
// as the page loads them
const load = createRequire(import.meta.url)
const M = load("./page/model.js")
const { DICT } = load("./page/i18n.js")
const { INK, inkPixels } = load("./page/ink.js")

// ---- what the page asks of magpie, and what it can reach ----

const scripts = () => readdirSync(page).filter((f) => f.endsWith(".js"))
// a script's code without its comments, which may name an address without loading it
const code = (f) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

test("asks for one read, usage:day, and nothing else", () => {
  assert.deepEqual(pkg.magpie.permissions, ["usage:day"])
  const reads = new Set()
  for (const f of scripts()) {
    for (const m of code(f).matchAll(/magpie\.read\(\s*["']([^"']+)["']/g)) reads.add(m[1])
    // no way out of the frame: magpie's policy refuses these anyway
    assert.doesNotMatch(code(f), /\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts/, f)
  }
  assert.deepEqual([...reads], ["usage:day"])
})

test("every picture it loads is data the page carries, never an address", () => {
  for (const f of scripts()) {
    // an Image or FontFace is given bytes or a data: URL, not a link the frame can't follow
    for (const m of code(f).matchAll(/\.src\s*=\s*["']([^"']+)["']/g)) assert.match(m[1], /^data:/, f)
    assert.doesNotMatch(code(f), /https?:\/\/[^\s"'`)]+\.(?:png|jpe?g|webp|svg|woff2?)/i, f)
  }
})

test("is a page magpie serves: its files in page/, scripts as files", () => {
  assert.equal(pkg.main, undefined)
  assert.equal(pkg.exports, undefined)
  assert.deepEqual(pkg.magpie.page, {
    title: "Token receipt",
    titles: { zh: "Token 账单", "zh-TW": "Token 帳單", ja: "トークン明細" },
    file: "page/index.html",
    icon: "page/icon.svg",
  })
  assert.equal(pkg.name, "@magpie-community/page-token-receipt")
  const html = read("index.html")
  assert.ok(html.includes('<script src="_magpie/bridge.js"></script>'))
  // the policy runs no inline script
  for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    assert.match(m[1], /\ssrc="/)
    assert.equal(m[2].trim(), "")
  }
  const files = readdirSync(page)
  const used = new Set()
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (m[1].startsWith("_magpie/")) continue
    assert.doesNotMatch(m[1], /^(?:[a-z]+:|\/|\.\.)/i)
    assert.ok(files.includes(m[1]), m[1])
    used.add(m[1])
  }
  // a script the page forgot to load is a bug that only shows in magpie
  for (const f of scripts()) assert.ok(used.has(f), `${f} is not loaded by index.html`)
})

test("ships what it embeds: the fonts' licenses and the notice", () => {
  const files = readdirSync(page)
  assert.ok(files.includes("fonts.LICENSE.txt"))
  const licenses = read("fonts.LICENSE.txt")
  assert.match(licenses, /Inter Project Authors/)
  assert.match(licenses, /JetBrains Mono Project Authors/)
  assert.ok(pkg.files.includes("NOTICE") && pkg.files.includes("page"))
})

// ---- the receipt: periods, money, models, agents ----

const copy = DICT.en
const d = (y, m, day) => new Date(y, m - 1, day)
const NOW = d(2026, 11, 14) // a Saturday

// The shape usage:day answered on magpie 0.1.4095 (trimmed).
function usageFixture(overrides = {}) {
  return {
    from: '2026-11-09', date: '2026-11-14', today: '2026-11-14',
    calls: 120, errors: 2, input: 3000, output: 700, cacheRead: 50000, cacheWrite: 300, reasoning: 90,
    cost: 12.5, unpriced: 10, cacheUnknown: 0, currency: 'usd', rate: 6.684938,
    days: [{ date: '2026-11-14', calls: 120, tokens: 54000, cost: 12.5 }],
    agents: [
      {
        id: 'agy', name: 'Antigravity CLI', calls: 70,
        models: [
          { model: 'gemini-4-carbon', provider: 'session-unknown', calls: 40, input: 1000, output: 200, cacheRead: 20000, cacheWrite: 0, cost: 8, unpriced: 0 },
          { model: '', provider: 'session-unknown', providerName: 'Local session', calls: 10, input: 500, output: 100, cacheRead: 1000, cacheWrite: 0, cost: 0, unpriced: 10 },
          { model: 'deepseek-v4.1-flash', provider: 'workbuddy', calls: 20, input: 300, output: 100, cacheRead: 9000, cacheWrite: 0, cost: 1, unpriced: 0 },
        ],
      },
      {
        id: 'dsh', name: 'DeepSeek Harness', calls: 50,
        models: [
          { model: 'opencode-go/DeepSeek-V4.1-Flash', provider: 'opencode-go', calls: 30, input: 700, output: 200, cacheRead: 15000, cacheWrite: 300, cost: 2.5, unpriced: 0 },
          { model: 'gpt-6.1-sol', provider: 'codex', calls: 20, input: 500, output: 100, cacheRead: 5000, cacheWrite: 0, cost: 1, unpriced: 0 },
        ],
      },
    ],
    ...overrides,
  }
}

test('calendar periods hold the anchor; weeks start on Monday', () => {
  const week = M.periodRange('week', NOW)
  assert.equal(M.dateKey(week.start), '2026-11-09')
  assert.equal(M.dateKey(week.end), '2026-11-16')
  const month = M.periodRange('month', d(2026, 12, 31))
  assert.equal(M.dateKey(month.start), '2026-12-01')
  assert.equal(M.dateKey(month.end), '2027-01-01')
  const sunday = M.periodRange('week', d(2026, 11, 15))
  assert.equal(M.dateKey(sunday.start), '2026-11-09')
})

test('rolling periods end on the anchor', () => {
  const r7 = M.periodRange('last7', NOW)
  assert.equal(M.dateKey(r7.start), '2026-11-08')
  assert.equal(M.dateKey(r7.end), '2026-11-15')
  const r30 = M.periodRange('last30', d(2026, 1, 10))
  assert.equal(M.dateKey(r30.start), '2025-12-12')
})

test('usage:day params never ask for a date after today', () => {
  assert.deepEqual(M.usageParams('day', NOW, NOW, 'Asia/Shanghai'), { date: '2026-11-14', tz: 'Asia/Shanghai' })
  assert.deepEqual(M.usageParams('week', NOW, NOW), { date: '2026-11-14', from: '2026-11-09' })
  assert.deepEqual(M.usageParams('month', NOW, NOW), { date: '2026-11-14', from: '2026-11-01' })
  assert.deepEqual(M.usageParams('month', d(2026, 10, 3), NOW), { date: '2026-10-31', from: '2026-10-01' })
  assert.deepEqual(M.usageParams('last30', NOW, NOW), { date: '2026-11-14', from: '2026-10-16' })
  assert.deepEqual(M.usageParams('week', d(2025, 12, 31), NOW), { date: '2026-01-04', from: '2025-12-29' })
})

test('shifting steps by the period and stops at today', () => {
  assert.equal(M.dateKey(M.shiftAnchor('week', NOW, -1, NOW)), '2026-11-02')
  assert.equal(M.dateKey(M.shiftAnchor('month', d(2026, 1, 20), -1, NOW)), '2025-12-01')
  assert.equal(M.dateKey(M.shiftAnchor('last7', NOW, -1, NOW)), '2026-11-07')
  assert.equal(M.dateKey(M.shiftAnchor('last30', d(2026, 11, 1), 1, NOW)), '2026-11-14')
  assert.equal(M.dateKey(M.shiftAnchor('day', NOW, 1, NOW)), '2026-11-14')
})

test('switching to a rolling period ends it on the last day shown', () => {
  assert.equal(M.dateKey(M.anchorForPeriod('last7', 'month', d(2026, 10, 5), NOW)), '2026-10-31')
  assert.equal(M.dateKey(M.anchorForPeriod('last7', 'week', NOW, NOW)), '2026-11-14')
  assert.equal(M.dateKey(M.anchorForPeriod('week', 'last30', d(2026, 10, 5), NOW)), '2026-10-05')
})

test('the current period is the one still running today', () => {
  assert.equal(M.isCurrentPeriod('week', d(2026, 11, 9), NOW), true)
  assert.equal(M.isCurrentPeriod('week', d(2026, 11, 8), NOW), false)
  assert.equal(M.isCurrentPeriod('last7', NOW, NOW), true)
  assert.equal(M.isCurrentPeriod('last7', d(2026, 11, 13), NOW), false)
  assert.equal(M.isCurrentPeriod('month', d(2026, 11, 1), NOW), true)
})

test('relative labels name today and the period before it', () => {
  assert.equal(M.relativeLabel('day', d(2026, 11, 13), d(2026, 11, 13), copy, NOW), 'Yesterday')
  assert.equal(M.relativeLabel('week', d(2026, 11, 2), d(2026, 11, 2), copy, NOW), 'Last week')
  assert.equal(M.relativeLabel('month', d(2026, 11, 1), NOW, copy, NOW), 'This month')
  assert.equal(M.relativeLabel('last30', d(2026, 10, 16), NOW, copy, NOW), 'Through today')
  assert.equal(M.relativeLabel('last30', d(2026, 10, 15), d(2026, 11, 13), copy, NOW), '')
})

test('period labels follow the language', () => {
  const { start, end } = M.periodRange('week', d(2026, 12, 30))
  assert.equal(M.periodLabel('week', start, end, 'zh'), '2026年12月28日 – 2027年1月3日')
  assert.equal(M.periodLabel('week', start, end, 'ja'), '2026年12月28日〜2027年1月3日')
  assert.equal(M.periodLabel('month', d(2026, 11, 1), d(2026, 12, 1), 'zh-TW'), '2026年11月')
  assert.equal(M.periodLabel('day', NOW, d(2026, 11, 15), 'en'), 'Nov 14, 2026')
})

test('locales map onto the four the page speaks', () => {
  assert.equal(M.normalizeLocale('zh'), 'zh')
  assert.equal(M.normalizeLocale('zh-CN'), 'zh')
  assert.equal(M.normalizeLocale('zh-TW'), 'zh-TW')
  assert.equal(M.normalizeLocale('zh_Hant'), 'zh-TW')
  assert.equal(M.normalizeLocale('ja-JP'), 'ja')
  assert.equal(M.normalizeLocale('de'), 'en')
})

test('currency follows the language unless picked, and CNY uses magpie’s rate', () => {
  assert.equal(M.resolveCurrency('auto', 'zh'), 'cny')
  assert.equal(M.resolveCurrency('auto', 'zh-TW'), 'usd')
  assert.equal(M.resolveCurrency('auto', 'ja'), 'jpy')
  assert.equal(M.resolveCurrency('jpy', 'en'), 'jpy')
  const rates = M.displayRates(7)
  assert.equal(M.fmtMoney(10, 'cny', rates), '¥70.00')
  assert.equal(M.fmtMoney(10, 'cny', M.displayRates(0)), '¥66.67')
  assert.equal(M.fmtMoney(1.5, 'jpy', rates), '¥240')
  assert.equal(M.fmtMoney(0.004, 'usd', rates), '$0.004')
  assert.equal(M.fmtMoney(null, 'usd', rates), '—')
  assert.equal(M.fmtMoney(1234.5, 'usd', rates), '$1,234.50')
})

test('bill numbers are stable and carry the period code', () => {
  const a = M.billNumber('last30', '2026-11-14', 1000, 10)
  assert.match(a, /^TR-30-20261114-[0-9A-F]{4}$/)
  assert.equal(a, M.billNumber('last30', '2026-11-14', 1000, 10))
  assert.notEqual(a, M.billNumber('last30', '2026-11-14', 1001, 10))
  assert.equal(M.billDate('month', d(2026, 11, 1), d(2026, 12, 1)), '2026-11')
  assert.equal(M.billDate('last7', d(2026, 11, 8), d(2026, 11, 15)), '2026-11-14')
})

test('models merge by name across agents and providers', () => {
  const { rows, rest } = M.groupModels(usageFixture())
  const flash = rows.find((r) => r.model.toLowerCase() === 'deepseek-v4.1-flash')
  assert.equal(flash.requests, 50)
  assert.equal(flash.costUsd, 3.5)
  assert.equal(flash.total, 300 + 100 + 9000 + 700 + 200 + 15000 + 300)
  const unknown = rows.find((r) => r.unidentified)
  assert.equal(unknown.costUsd, null)
  assert.equal(unknown.complete, false)
  assert.equal(rest, null)
  assert.deepEqual(rows.map((r) => r.total), [...rows.map((r) => r.total)].sort((a, b) => b - a))
})

test('the receipt folds what agents left out into one row, before unidentified rows', () => {
  const raw = usageFixture({ calls: 130, input: 3500, cost: 13 })
  const r = M.toReceipt(raw, { period: 'week', anchor: NOW, now: NOW, copy, lang: 'en', showUnidentified: true })
  // three named models fit in a week's six rows, then the remainder, then the unidentified source
  assert.deepEqual(r.models.map((m) => m.model), ['deepseek-v4.1-flash', 'gemini-4-carbon', 'gpt-6.1-sol', 'Other models', 'Unidentified · Local session'])
  const more = r.models[3]
  assert.equal(more.complete, true)
  assert.equal(more.requests, 10) // only the remainder: 130 calls less the models' 120
  assert.equal(more.total, 500)
  assert.equal(more.costUsd, 0.5)
})

// n named models, the first with the most tokens, plus one unidentified row with more tokens than any
function manyModels(n) {
  const models = Array.from({ length: n }, (_, i) => ({ model: `m${i + 1}`, calls: 1, input: (n - i) * 1000, cost: 1 }))
  models.push({ model: '', provider: 'session-unknown', providerName: 'Local session', calls: 5, input: 10_000_000, cost: 0, unpriced: 5 })
  const sum = (k) => models.reduce((s, m) => s + (m[k] || 0), 0)
  return { calls: sum('calls'), input: sum('input'), cost: sum('cost'), unpriced: 5, agents: [{ id: 'a', models }] }
}

test('an unidentified source takes no row of the limit and prints last, with its source', () => {
  const r = M.toReceipt(manyModels(2), { period: 'day', anchor: NOW, now: NOW, copy, lang: 'en', showUnidentified: true })
  assert.deepEqual(r.models.map((m) => m.model), ['m1', 'm2', 'Unidentified · Local session'])
  const last = r.models[2]
  assert.equal(last.costUsd, null)
  assert.equal(last.total, 10_000_000)
  const zh = M.toReceipt(manyModels(2), { period: 'day', anchor: NOW, now: NOW, copy: DICT.zh, lang: 'zh', showUnidentified: true })
  assert.equal(zh.models[2].model, '未识别模型 · Local session')
})

test('how many models print depends on the period: day 4, week 6, month and longer 8', () => {
  const expect = { day: 4, week: 6, last7: 6, month: 8, last30: 8, last90: 8, all: 8 }
  for (const [period, limit] of Object.entries(expect)) {
    const r = M.toReceipt(manyModels(10), { period, anchor: NOW, now: NOW, copy, lang: 'en', showUnidentified: true })
    const names = r.models.map((m) => m.model)
    assert.deepEqual(names.slice(0, limit), Array.from({ length: limit }, (_, i) => `m${i + 1}`), period)
    assert.equal(names[limit], `+${10 - limit} more models`, period)
    assert.equal(names[limit + 1], 'Unidentified · Local session', period)
    assert.equal(names.length, limit + 2, period)
  }
})

test('named models still sort by tokens, not cost', () => {
  const raw = {
    calls: 2, input: 1100, cost: 51,
    agents: [{ id: 'a', models: [
      { model: 'cheap-and-busy', calls: 1, input: 1000, cost: 1 },
      { model: 'dear-and-quiet', calls: 1, input: 100, cost: 50 },
    ] }],
  }
  const r = M.toReceipt(raw, { period: 'day', anchor: NOW, now: NOW, copy, lang: 'en' })
  assert.deepEqual(r.models.map((m) => m.model), ['cheap-and-busy', 'dear-and-quiet'])
})

test('model-less calls from different sources print as separate rows', () => {
  const raw = {
    calls: 3, input: 700, cost: 0, unpriced: 3,
    agents: [
      { id: 'a', models: [{ model: '', providerName: 'Local session', calls: 1, input: 100, unpriced: 1 }] },
      { id: 'b', models: [{ model: '', providerName: 'Local session', calls: 1, input: 200, unpriced: 1 }, { model: '', provider: 'imported', calls: 1, input: 400, unpriced: 1 }] },
    ],
  }
  const r = M.toReceipt(raw, { period: 'day', anchor: NOW, now: NOW, copy, lang: 'en', showUnidentified: true })
  assert.deepEqual(r.models.map((m) => [m.model, m.total]), [['Unidentified · imported', 400], ['Unidentified · Local session', 300]])
  const bare = M.toReceipt({ calls: 1, input: 5, agents: [{ id: 'a', models: [{ model: '', calls: 1, input: 5 }] }] }, { period: 'day', anchor: NOW, now: NOW, copy, lang: 'en', showUnidentified: true })
  assert.equal(bare.models[0].model, 'Unidentified model')
})

test('the receipt totals, pricing and bill come from usage:day', () => {
  const r = M.toReceipt(usageFixture(), { period: 'week', anchor: NOW, now: NOW, copy, lang: 'en' })
  assert.equal(r.totals.totalTokens, 3000 + 700 + 50000 + 300)
  assert.equal(r.totals.requests, 120)
  assert.equal(r.totals.errors, 2)
  assert.equal(r.totals.agents, 2)
  assert.equal(r.pricing.totalUsd, 12.5)
  assert.equal(r.pricing.partial, true)
  assert.equal(r.pricing.rates.cny, 6.684938)
  assert.equal(r.date, '2026-11-09')
  assert.match(r.billNo, /^TR-W-20261109-/)
  assert.equal(r.label, 'Nov 9 – Nov 15, 2026')
  assert.equal(r.empty, false)
})

test('an empty period prints an empty receipt', () => {
  const r = M.toReceipt({ calls: 0, cost: 0, agents: [] }, { period: 'day', anchor: NOW, now: NOW, copy, lang: 'en' })
  assert.equal(r.empty, true)
  assert.deepEqual(r.models, [])
  assert.equal(r.pricing.partial, false)
})

test('the last 90 days roll back from the anchor', () => {
  const r = M.periodRange('last90', NOW)
  assert.equal(M.dateKey(r.start), '2026-08-17')
  assert.deepEqual(M.usageParams('last90', NOW, NOW), { date: '2026-11-14', from: '2026-08-17' })
  assert.equal(M.dateKey(M.shiftAnchor('last90', NOW, -1, NOW)), '2026-08-16')
  assert.match(M.billNumber('last90', '2026-11-14', 1, 1), /^TR-90-20261114-/)
})

test('all time asks usage:day for everything up to today and never steps', () => {
  assert.deepEqual(M.usageParams('all', d(2026, 3, 1), NOW, 'Asia/Shanghai'), { date: '2026-11-14', from: 'all', tz: 'Asia/Shanghai' })
  assert.equal(M.isCurrentPeriod('all', NOW, NOW), true)
  assert.equal(M.dateKey(M.shiftAnchor('all', NOW, -1, NOW)), '2026-11-14')
  assert.equal(M.dateKey(M.anchorForPeriod('all', 'month', d(2026, 3, 1), NOW)), '2026-11-14')
  assert.equal(M.dateKey(M.anchorForPeriod('last30', 'all', NOW, NOW)), '2026-11-14')
})

test('an all-time receipt runs from the first day the read found', () => {
  const r = M.toReceipt(usageFixture({ from: '2026-01-20' }), { period: 'all', anchor: NOW, now: NOW, copy, lang: 'en' })
  assert.equal(r.label, 'Jan 20 – Nov 14, 2026')
  assert.match(r.billNo, /^TR-A-20261114-/)
  const none = M.toReceipt({ calls: 0, agents: [] }, { period: 'all', anchor: NOW, now: NOW, copy, lang: 'en' })
  assert.equal(none.label, 'All time')
  const r90 = M.toReceipt(manyModels(10), { period: 'last90', anchor: NOW, now: NOW, copy, lang: 'en' })
  assert.equal(r90.models[8].model, '+2 more models')
})

test('unidentified rows are hidden by default, yet their calls stay in the totals and out of "+N more"', () => {
  assert.equal(M.SHOW_UNIDENTIFIED, false)
  const raw = manyModels(10)
  const r = M.toReceipt(raw, { period: 'week', anchor: NOW, now: NOW, copy, lang: 'en' })
  assert.deepEqual(r.models.map((m) => m.model), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', '+4 more models'])
  assert.equal(r.models[6].requests, 4) // the four hidden named models, not the 5 unidentified calls
  assert.equal(r.totals.requests, raw.calls)
  assert.equal(r.totals.totalTokens, raw.input)
})

test('agents print by cost with the icon usage:day gives each, or none', () => {
  const svg = 'data:image/svg+xml;base64,PHN2Zy8+'
  const raw = usageFixture({
    icons: { 'codex-color': { src: svg }, pi: { src: svg, mono: true }, evil: { src: 'https://example.com/x.svg' } },
    agents: [
      { id: 'pi', name: 'Pi', icon: 'pi', cost: 2, calls: 5, models: [] },
      { id: 'codex', name: 'Codex', icon: 'codex-color', cost: 9, calls: 1, models: [] },
      { id: 'odd', name: 'Odd', icon: 'evil', cost: 0, calls: 9, models: [] },
      { id: 'bare', icon: 'generic', cost: 0, calls: 1, models: [] },
    ],
  })
  const r = M.toReceipt(raw, { period: 'week', anchor: NOW, now: NOW, copy, lang: 'en' })
  assert.deepEqual(r.agents.map((a) => [a.name, a.src, a.mono]), [
    ['Codex', svg, false],
    ['Pi', svg, true],
    ['Odd', null, false], // only data: pictures; the frame couldn't load anything else
    ['bare', null, false],
  ])
  assert.equal(r.totals.agents, 4)
  assert.equal(copy.agents, 'Agents')
  assert.equal(DICT.zh.agents, 'Agents')
})

test('the generated time prints in full: date and seconds', () => {
  assert.equal(M.fmtDateTime(new Date(2026, 10, 4, 9, 5, 7)), '2026-11-04 09:05:07')
})

test('the thanks line names the site', () => {
  for (const lang of M.LOCALES) assert.ok(!/usemagpie/.test(DICT[lang].thankYou), lang) // the site is added once, not per language
  assert.equal(M.SITE, 'usemagpie.ai')
})

test('saved options are checked before use', () => {
  assert.deepEqual(M.normalizeOptions({ period: 'last7', currency: 'jpy' }), { period: 'last7', currency: 'jpy' })
  assert.deepEqual(M.normalizeOptions({ period: 'year', currency: 'eur' }), { period: 'day', currency: 'auto' })
  assert.deepEqual(M.normalizeOptions(undefined), { period: 'day', currency: 'auto' })
})

test('every language has every word', () => {
  const keys = Object.keys(DICT.en).sort()
  for (const lang of M.LOCALES) assert.deepEqual(Object.keys(DICT[lang]).sort(), keys, lang)
  for (const period of M.PERIODS) assert.ok(DICT.en[period], period)
})

// ---- the logos, re-inked to one ink ----

// a size×size RGBA picture, painted by fn(x, y) → [r, g, b, a] or null (clear)
function picture(size, fn) {
  const p = new Uint8ClampedArray(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const c = fn(x, y)
      if (c) p.set(c, (y * size + x) * 4)
    }
  }
  return p
}
const at = (p, size, x, y) => Array.from(p.slice((y * size + x) * 4, (y * size + x) * 4 + 4))

test('a light coloured mark on a clear ground prints in solid ink, like a mono one', () => {
  // a pale gradient triangle, Antigravity-like: well under half its box is painted
  const size = 10
  const p = picture(size, (x, y) => (x <= y && x + y >= 9 ? [200, 120 + x * 10, 240, 255] : null))
  assert.equal(inkPixels(p, size, size, false), 'mark')
  assert.deepEqual(at(p, size, 5, 9), [...INK, 255])
  assert.deepEqual(at(p, size, 0, 0), [0, 0, 0, 0]) // the clear ground stays clear
})

test('a mono logo is a mark even when it fills its box', () => {
  const size = 4
  const p = picture(size, () => [90, 90, 90, 255])
  assert.equal(inkPixels(p, size, size, true), 'mark')
  assert.deepEqual(at(p, size, 1, 1), [...INK, 255])
})

test('a tile stretches its tones: darkest to ink, lightest to white', () => {
  // a blue tile with a light symbol in the middle, Codex-like
  const size = 10
  const p = picture(size, (x, y) => (x >= 4 && x <= 5 && y >= 4 && y <= 5 ? [230, 235, 255, 255] : [40, 90, 200, 255]))
  assert.equal(inkPixels(p, size, size, false), 'tile')
  assert.deepEqual(at(p, size, 0, 0), [...INK, 255])
  assert.deepEqual(at(p, size, 4, 4), [255, 255, 255, 255])
})

test('a tile on a light ground drops the ground and inks what is drawn on it', () => {
  // a white tile with a mid-tone mark, Codex-like: stretching would leave the mark grey
  const size = 10
  const p = picture(size, (x, y) => (x >= 2 && x <= 7 && y >= 3 && y <= 6 ? [110, 140, 230, 255] : [255, 255, 255, 255]))
  assert.equal(inkPixels(p, size, size, false), 'ground')
  assert.deepEqual(at(p, size, 4, 4), [...INK, 255])
  assert.equal(at(p, size, 0, 0)[3], 0) // the white ground lets the paper through
})

test('a tile of one tone prints as ink, not white', () => {
  const size = 6
  const p = picture(size, () => [250, 120, 40, 255])
  assert.equal(inkPixels(p, size, size, false), 'tile')
  assert.deepEqual(at(p, size, 2, 2), [...INK, 255])
})

test('an empty picture is left alone', () => {
  const p = picture(4, () => null)
  assert.equal(inkPixels(p, 4, 4, false), 'empty')
})
