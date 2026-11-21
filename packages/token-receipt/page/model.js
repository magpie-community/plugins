// What the receipt says, worked out without the DOM so `node --test` can load it.
// Periods, dates and money follow dsh-token-receipt's client; the usage itself
// comes from magpie's `usage:day` read.
(function (root) {
  const DAY_MS = 24 * 60 * 60 * 1000
  const PERIODS = ['day', 'week', 'month', 'last7', 'last30', 'last90', 'all']
  const ROLLING_DAYS = { last7: 7, last30: 30, last90: 90 }
  const BILL_CODES = { day: 'D', week: 'W', month: 'M', last7: '7', last30: '30', last90: '90', all: 'A' }
  // "all" runs from the first day magpie has calls for, which only the read knows;
  // until then its range starts here
  const ALL_START = new Date(2000, 0, 1)
  const LOCALES = ['en', 'zh', 'zh-TW', 'ja']

  // CNY normally comes from magpie's own rate (Settings); this is dsh-context's
  // fixed fallback. JPY is a dated ECB/Frankfurter reference quote:
  // https://api.frankfurter.dev/v1/2026-11-13?base=USD&symbols=JPY
  const FALLBACK_CNY_RATE = 1 / 0.15
  const JPY_RATE = 160
  const JPY_RATE_DATE = '2026-11-13'
  const CURRENCIES = ['usd', 'cny', 'jpy']

  function normalizeLocale(raw) {
    const value = String(raw || 'en').trim().toLowerCase().replace('_', '-')
    if (value.startsWith('zh')) return /^zh-(tw|hk|mo|hant)/.test(value) ? 'zh-TW' : 'zh'
    if (value.startsWith('ja')) return 'ja'
    return 'en'
  }
  const isCjk = (lang) => lang === 'zh' || lang === 'zh-TW' || lang === 'ja'

  function isPeriod(value) {
    return PERIODS.includes(value)
  }

  // ---- dates (local calendar) ----
  function pad(n) {
    return String(n).padStart(2, '0')
  }
  function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate())
  }
  function addDays(date, n) {
    const d = new Date(date)
    d.setDate(d.getDate() + n)
    return d
  }
  function startOfWeek(date) {
    const d = startOfDay(date)
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
    return d
  }
  function startOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1)
  }
  function minDate(a, b) {
    return a.getTime() <= b.getTime() ? a : b
  }
  function clampToToday(date, now = new Date()) {
    return minDate(startOfDay(date), startOfDay(now))
  }
  function dateKey(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  }
  function monthKey(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`
  }

  // Day, week and month are the calendar period holding the anchor. A rolling
  // period ends on the anchor and reaches back N days. `end` is exclusive.
  function periodRange(period, anchor) {
    if (period === 'all') return { start: new Date(ALL_START), end: addDays(startOfDay(anchor), 1) }
    if (ROLLING_DAYS[period]) {
      const end = addDays(startOfDay(anchor), 1)
      return { start: addDays(end, -ROLLING_DAYS[period]), end }
    }
    if (period === 'week') {
      const start = startOfWeek(anchor)
      return { start, end: addDays(start, 7) }
    }
    if (period === 'month') {
      const start = startOfMonth(anchor)
      return { start, end: new Date(start.getFullYear(), start.getMonth() + 1, 1) }
    }
    const start = startOfDay(anchor)
    return { start, end: addDays(start, 1) }
  }

  function shiftAnchor(period, anchor, delta, now = new Date()) {
    if (period === 'all') return startOfDay(now)
    let next
    if (period === 'week') next = addDays(startOfWeek(anchor), delta * 7)
    else if (period === 'month') next = new Date(anchor.getFullYear(), anchor.getMonth() + delta, 1)
    else next = addDays(startOfDay(anchor), delta * (ROLLING_DAYS[period] || 1))
    return clampToToday(next, now)
  }

  // The anchor a period starts from when the reader switches to it: a rolling
  // period ends on the last day of what was on screen, never after today.
  function anchorForPeriod(next, current, anchor, now = new Date()) {
    if (next === 'all') return startOfDay(now)
    if (!ROLLING_DAYS[next]) return clampToToday(anchor, now)
    return clampToToday(addDays(periodRange(current, anchor).end, -1), now)
  }

  function isCurrentPeriod(period, anchor, now = new Date()) {
    if (period === 'all') return true
    return addDays(periodRange(period, anchor).end, -1).getTime() >= startOfDay(now).getTime()
  }

  // usage:day refuses a `date` after today, so this week's, this month's and a
  // rolling period's last day stop at today.
  function usageParams(period, anchor, now = new Date(), tz) {
    const { start, end } = periodRange(period, anchor)
    const last = minDate(addDays(end, -1), startOfDay(now))
    const params = period === 'day' ? { date: dateKey(start) }
      : period === 'all' ? { date: dateKey(startOfDay(now)), from: 'all' }
      : { date: dateKey(last), from: dateKey(start) }
    if (tz) params.tz = tz
    return params
  }

  function parseDateKey(value, now = new Date()) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''))
    if (!match) return null
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
    const date = new Date(year, month - 1, day)
    if (year < 1970 || date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
    return clampToToday(date, now)
  }
  function parseMonthKey(value, now = new Date()) {
    const match = /^(\d{4})-(\d{2})$/.exec(String(value || ''))
    if (!match) return null
    const [year, month] = [Number(match[1]), Number(match[2])]
    if (year < 1970 || month < 1 || month > 12) return null
    return clampToToday(new Date(year, month - 1, 1), now)
  }

  // ---- labels ----
  function fullDate(date, lang) {
    if (isCjk(lang)) return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }
  function shortDate(date, lang) {
    if (isCjk(lang)) return `${date.getMonth() + 1}月${date.getDate()}日`
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()
  }
  function monthYear(date, lang) {
    if (isCjk(lang)) return `${date.getFullYear()}年${date.getMonth() + 1}月`
    return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  }
  function rangeLabel(start, last, lang) {
    if (isCjk(lang)) {
      const first = `${start.getFullYear()}年${start.getMonth() + 1}月${start.getDate()}日`
      const year = last.getFullYear() !== start.getFullYear() ? `${last.getFullYear()}年` : ''
      const second = `${year}${last.getMonth() + 1}月${last.getDate()}日`
      return lang === 'ja' ? `${first}〜${second}` : `${first} – ${second}`
    }
    const first = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    const second = last.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    return `${first} – ${second}`
  }
  function periodLabel(period, start, endExclusive, lang) {
    if (period === 'day') return fullDate(start, lang)
    if (period === 'month') return monthYear(start, lang)
    return rangeLabel(start, addDays(endExclusive, -1), lang)
  }
  function periodName(period, copy) {
    return copy[period] || copy.day
  }
  function relativeLabel(period, start, anchor, copy, now = new Date()) {
    const today = startOfDay(now)
    if (ROLLING_DAYS[period] || period === 'all') return startOfDay(anchor).getTime() === today.getTime() ? copy.throughToday : ''
    if (period === 'day') {
      const diff = Math.round((today.getTime() - start.getTime()) / DAY_MS)
      return diff === 0 ? copy.today : diff === 1 ? copy.yesterday : ''
    }
    if (period === 'week') {
      const diff = Math.round((startOfWeek(today).getTime() - start.getTime()) / (7 * DAY_MS))
      return diff === 0 ? copy.thisWeek : diff === 1 ? copy.lastWeek : ''
    }
    const diff = (today.getFullYear() - start.getFullYear()) * 12 + today.getMonth() - start.getMonth()
    return diff === 0 ? copy.thisMonth : diff === 1 ? copy.lastMonth : ''
  }

  // ---- numbers and money ----
  const EXACT = {}
  function fmtExact(value, lang) {
    const key = normalizeLocale(lang)
    EXACT[key] = EXACT[key] || new Intl.NumberFormat(key === 'zh' ? 'zh-CN' : key === 'ja' ? 'ja-JP' : key === 'zh-TW' ? 'zh-TW' : 'en-US')
    return EXACT[key].format(Number(value) || 0)
  }
  // when the bill was printed, in full: 2026-11-14 22:27:05, by this computer's clock
  function fmtDateTime(date) {
    return `${dateKey(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  }

  // printed after the thanks line in every language
  const SITE = 'usemagpie.ai'

  function fmtCompact(value) {
    const n = Number(value) || 0
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}K`
    return String(n)
  }

  function displayRates(cnyRate) {
    const cny = Number(cnyRate)
    return { usd: 1, cny: Number.isFinite(cny) && cny > 0 ? cny : FALLBACK_CNY_RATE, jpy: JPY_RATE }
  }
  function defaultCurrencyForLocale(lang) {
    const l = normalizeLocale(lang)
    return l === 'zh' ? 'cny' : l === 'ja' ? 'jpy' : 'usd'
  }
  function resolveCurrency(preference, lang) {
    return CURRENCIES.includes(preference) ? preference : defaultCurrencyForLocale(lang)
  }
  const MONEY = {
    standard: new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    standardSmall: new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 }),
    jpy: new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }),
    jpySmall: new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 6 }),
  }
  function fmtMoney(usd, currency = 'usd', rates = displayRates()) {
    if (typeof usd !== 'number' || !Number.isFinite(usd)) return '—'
    const selected = CURRENCIES.includes(currency) ? currency : 'usd'
    const amount = usd * rates[selected]
    const symbol = selected === 'usd' ? '$' : '¥'
    if (amount > 0 && amount < 0.000001) return `<${symbol}0.000001`
    const isJpy = selected === 'jpy'
    const small = amount > 0 && amount < (isJpy ? 1 : 0.01)
    const formatter = isJpy ? (small ? MONEY.jpySmall : MONEY.jpy) : small ? MONEY.standardSmall : MONEY.standard
    return `${symbol}${formatter.format(amount)}`
  }

  // ---- the bill ----
  function hashSuffix(input) {
    let hash = 0x811c9dc5
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(16).toUpperCase().padStart(8, '0').slice(0, 4)
  }
  // A calendar period is named by its start (a month by YYYY-MM); a rolling one
  // by the day it ends on.
  function billDate(period, start, endExclusive) {
    if (ROLLING_DAYS[period] || period === 'all') return dateKey(addDays(endExclusive, -1))
    return period === 'month' ? monthKey(start) : dateKey(start)
  }
  function billNumber(period, date, totalTokens, requests) {
    const code = BILL_CODES[period] || 'D'
    return `TR-${code}-${String(date || '').replaceAll('-', '')}-${hashSuffix(`${period}:${date}:${totalTokens}:${requests}`)}`
  }

  function num(value) {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  function tokensOf(row) {
    return num(row && row.input) + num(row && row.output) + num(row && row.cacheRead) + num(row && row.cacheWrite)
  }
  function shortModelName(name) {
    const text = String(name || '').trim()
    return text.includes('/') ? text.slice(text.lastIndexOf('/') + 1) : text
  }

  // One row per model name, whichever agents and providers it came through.
  // Calls magpie knows no model for (imported from an agent's session files)
  // group by where they came from instead. usage:day may cut an agent's model
  // list short, so what its models don't account for becomes a remainder the
  // receipt folds into "+N more".
  function groupModels(raw) {
    const grouped = new Map()
    const sum = { total: 0, requests: 0, cost: 0, unpriced: 0 }
    for (const agent of Array.isArray(raw && raw.agents) ? raw.agents : []) {
      for (const m of Array.isArray(agent && agent.models) ? agent.models : []) {
        const name = shortModelName(m.model)
        const source = name ? '' : String(m.providerName || m.provider || '').trim()
        const key = name ? name.toLowerCase() : `\u0000unidentified:${source.toLowerCase()}`
        const row = grouped.get(key) || { model: name, source, unidentified: !name, total: 0, requests: 0, cost: 0, unpriced: 0 }
        row.total += tokensOf(m)
        row.requests += num(m.calls)
        row.cost += num(m.cost)
        row.unpriced += num(m.unpriced)
        grouped.set(key, row)
        sum.total += tokensOf(m)
        sum.requests += num(m.calls)
        sum.cost += num(m.cost)
        sum.unpriced += num(m.unpriced)
      }
    }
    const rows = [...grouped.values()].map(finishModel).sort((a, b) => b.total - a.total)
    const rest = {
      total: Math.max(0, tokensOf(raw) - sum.total),
      requests: Math.max(0, num(raw && raw.calls) - sum.requests),
      cost: Math.max(0, num(raw && raw.cost) - sum.cost),
      unpriced: Math.max(0, num(raw && raw.unpriced) - sum.unpriced),
    }
    // float sums of the same costs can differ by a hair
    if (rest.cost < 1e-9) rest.cost = 0
    return { rows, rest: rest.total > 0 || rest.requests > 0 ? rest : null }
  }
  function finishModel(row) {
    // a model none of whose calls had a price has no cost to show, not $0
    const priced = row.requests > row.unpriced || row.cost > 0
    return {
      model: row.model,
      source: row.source,
      unidentified: row.unidentified,
      total: row.total,
      requests: row.requests,
      costUsd: priced ? row.cost : null,
      complete: row.unpriced === 0,
    }
  }

  // Hidden for now: calls magpie knows no model for (imported from an agent's
  // session files, e.g. Antigravity CLI's "Local session") print no row of
  // their own. Their tokens and requests still count in the receipt's totals,
  // and they don't land in "+N more" either: that remainder is what usage:day's
  // totals hold beyond every model row, these rows included. Set this to true,
  // or pass { showUnidentified: true } to toReceipt, to print them last again,
  // labelled with their source ("Unidentified · Local session").
  const SHOW_UNIDENTIFIED = false

  // A longer period has more models: a day prints 4, a week 6, a month and longer 8.
  // Each agent with the logo usage:day sends for it: its `icons` map holds data:
  // pictures by name (a mono one is a mark drawn in currentColor). Only data:
  // pictures load in the page's frame, so anything else prints as an initial.
  function agentsOf(raw) {
    const icons = raw && raw.icons && typeof raw.icons === 'object' ? raw.icons : {}
    return (Array.isArray(raw && raw.agents) ? raw.agents : [])
      .map((a) => {
        const icon = Object.prototype.hasOwnProperty.call(icons, a.icon) ? icons[a.icon] : null
        const src = icon && typeof icon.src === 'string' && icon.src.startsWith('data:image/') ? icon.src : null
        return {
          id: String(a.id || ''),
          name: String(a.name || a.id || '?'),
          src,
          mono: Boolean(src && icon.mono),
          cost: num(a.cost),
          calls: num(a.calls),
        }
      })
      .sort((a, b) => b.cost - a.cost || b.calls - a.calls)
  }

  const MAX_MODEL_ROWS = { day: 4, week: 6, last7: 6, month: 8, last30: 8, last90: 8, all: 8 }

  function toReceipt(raw, { period, anchor, now = new Date(), copy, lang, showUnidentified = SHOW_UNIDENTIFIED }) {
    const range = periodRange(period, anchor)
    const end = range.end
    // all time starts on the first day the read found calls on
    const firstDay = period === 'all' ? parseDateKey(raw.from, now) : null
    const start = firstDay || range.start
    const totals = {
      inputTokens: num(raw.input),
      outputTokens: num(raw.output),
      cacheReadTokens: num(raw.cacheRead),
      cacheWriteTokens: num(raw.cacheWrite),
      reasoningTokens: num(raw.reasoning),
      totalTokens: tokensOf(raw),
      requests: num(raw.calls),
      errors: num(raw.errors),
      agents: (Array.isArray(raw.agents) ? raw.agents.length : 0) + num(raw.moreAgents),
    }
    const unpriced = num(raw.unpriced)
    const pricing = {
      totalUsd: num(raw.cost),
      unpriced,
      partial: unpriced > 0,
      rates: displayRates(raw.rate),
    }
    const { rows, rest } = groupModels(raw)
    // rows are by tokens; the unidentified take none of the limit and print last
    const limit = MAX_MODEL_ROWS[period] || MAX_MODEL_ROWS.day
    const named = rows.filter((row) => !row.unidentified)
    const shown = named.slice(0, limit)
    const hidden = named.slice(limit)
    const unidentified = rows.filter((row) => row.unidentified).map((row) => ({
      ...row,
      model: row.source ? copy.unknownModelFrom.replace('{source}', row.source) : copy.unknownModel,
    }))
    let more = null
    if (hidden.length || rest) {
      const pricedHidden = hidden.filter((row) => row.costUsd !== null)
      const restCost = rest && (rest.requests > rest.unpriced || rest.cost > 0) ? rest.cost : null
      const costs = pricedHidden.map((row) => row.costUsd).concat(restCost === null ? [] : [restCost])
      more = {
        model: hidden.length ? copy.moreModels.replace('{n}', hidden.length) : copy.otherModels,
        total: hidden.reduce((s, row) => s + row.total, 0) + (rest ? rest.total : 0),
        requests: hidden.reduce((s, row) => s + row.requests, 0) + (rest ? rest.requests : 0),
        costUsd: costs.length ? costs.reduce((s, c) => s + c, 0) : null,
        complete: hidden.every((row) => row.complete) && !(rest && rest.unpriced > 0),
      }
    }
    const date = billDate(period, start, end)
    return {
      period,
      lang,
      start,
      end,
      date,
      label: period === 'all' && !firstDay ? copy.allTime : periodLabel(period, start, end, lang),
      billNo: billNumber(period, date, totals.totalTokens, totals.requests),
      generatedAt: now,
      totals,
      pricing,
      models: shown.concat(more ? [more] : [], showUnidentified ? unidentified : []),
      agents: agentsOf(raw),
      empty: totals.requests === 0 && totals.totalTokens === 0,
    }
  }

  function normalizeOptions(raw) {
    const o = raw && typeof raw === 'object' ? raw : {}
    return {
      period: isPeriod(o.period) ? o.period : 'day',
      currency: CURRENCIES.includes(o.currency) ? o.currency : 'auto',
    }
  }

  const api = {
    DAY_MS, PERIODS, LOCALES, CURRENCIES, JPY_RATE, JPY_RATE_DATE, MAX_MODEL_ROWS, SHOW_UNIDENTIFIED,
    normalizeLocale, isCjk, isPeriod, pad, startOfDay, addDays, startOfWeek, startOfMonth, clampToToday,
    dateKey, monthKey, periodRange, shiftAnchor, anchorForPeriod, isCurrentPeriod, usageParams,
    parseDateKey, parseMonthKey, fullDate, shortDate, monthYear, periodLabel, periodName, relativeLabel,
    fmtExact, fmtCompact, fmtDateTime, SITE, displayRates, defaultCurrencyForLocale, resolveCurrency, fmtMoney,
    hashSuffix, billDate, billNumber, tokensOf, shortModelName, groupModels, agentsOf, toReceipt, normalizeOptions,
  }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.TRModel = api
})(globalThis)
