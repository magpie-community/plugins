// HarnessWeight — the interface. Served by the plugin's own service, so the
// data is a same-origin fetch away.

import { DIRECTIONS, metricValue, extrema, extremum } from "./comparison.js"
import { providerView } from "./providers.js"
import { rankedModels } from "./model-marks.js"
import { taskSource, taskEmptyKey, compareTaskSources } from "./telemetry.js"
import { explainFor, COLS, CARD_SORTS } from "./explain.js"
import { pageLanguage, languageTags, translate } from "./i18n.mjs"

const $ = (id) => document.getElementById(id)
const qs = new URLSearchParams(location.search)
// magpie's window language arrives as ?lang= (page/boot.js); opened directly,
// the browser's own language decides
const LANG = pageLanguage(qs.get("lang") || navigator.language || "")
const LOCALE = languageTags[LANG] || "en"
const T = (key, params) => translate(LANG, key, params)
document.documentElement.lang = LOCALE
document.title = T("app.title")
for (const el of document.querySelectorAll("[data-t]")) el.textContent = T(el.dataset.t)
for (const el of document.querySelectorAll("[aria-label-t]")) el.setAttribute("aria-label", T(el.getAttribute("aria-label-t")))
// sandboxed in magpie's frame the origin is opaque and storage throws
const store = {
  get(k) { try { return localStorage.getItem(k) } catch { return null } },
  set(k, v) { try { localStorage.setItem(k, v) } catch {} },
}

const state = {
  period: store.get("al.period") || "7d",
  clients: store.get("al.clients") === "1",
  sort: { key: "prompt", dir: -1 },
  metricGroup: "consumption",
  cardSort: "prompt",
  view: store.get("al.view") === "table" ? "table" : "cards",
  toolSort: "avgBytes",
  activeAgents: new Map(),
  activityKnown: false,
  data: null,
  openAgent: null,
}

// the service writes a per-start token into this page's HTML
const TOKEN = document.querySelector('meta[name="harnessweight-token"]')?.content || ""
let reloaded = false
const sessionStorageSafe = () => reloaded || location.hash === "#r"
function markReloaded() { reloaded = true; location.hash = "r" }

// ---------- formatting ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
function short(n) {
  if (n == null || !Number.isFinite(n)) return "—"
  const a = Math.abs(n)
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(Math.round(n))
}
const int = (n) => (n == null ? "—" : Math.round(n).toLocaleString(LOCALE))
const pct = (x) => (x == null || !Number.isFinite(x) ? "—" : `${(x * 100).toFixed(1)}%`)
function secs(ms) {
  if (!ms) return "—"
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}
function dur(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—"
  const m = ms / 60000
  if (m < 1) return `${Math.round(ms / 1000)}${esc(T("dur.second"))}`
  if (m < 60) return `${m.toFixed(0)}${esc(T("dur.minute"))}`
  const h = m / 60
  if (h < 24) return `${h.toFixed(1)}${esc(T("dur.hour"))}`
  return `${(h / 24).toFixed(1)}${esc(T("dur.day"))}`
}
function taskEmpty(a) { return T(taskEmptyKey(a)) }
function taskSourceText(a) { return T(`task.source.${taskSource(a)}`) }
function taskMetricLabel(a) { const source = taskSource(a); return T(source === "codex" ? "task.codexMetric" : source === "cursor" ? "task.cursorMetric" : "col.taskDuration") }
function taskSamples(a) {
  const source = taskSource(a)
  const key = source === "codex" ? "task.codexSamples" : source === "cursor" ? "task.cursorSamples" : "task.samples"
  return T(key, { count: int(a.taskDuration?.samples ?? 0) })
}
function taskValue(a) {
  const value = metricValue(a, "taskDuration")
  return `<b class="num">${dur(value)}</b>`
}

function when(at) {
  if (!at) return "—"
  return new Date(at).toLocaleString(LOCALE, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
}

// ---------- agent mark: magpie's own icon, else the initial ----------
const PALETTE = ["#17A9A2", "#F26B1D", "#6D5DFC", "#2B8AE2", "#C2410C", "#0E7C77", "#8B5CF6", "#64748B"]
function hue(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length] }
function mark(a, size = 20) {
  const initial = esc(String(a.name || a.agent || "?").trim().charAt(0).toUpperCase())
  const letter = `<span class="mark letter" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.58)}px;background:${hue(a.agent)}">${initial}</span>`
  if (!a.icon) return letter
  return `<span class="mark" style="width:${size}px;height:${size}px"><img src="${a.icon.startsWith("data:") ? a.icon : "icons/" + encodeURIComponent(a.icon)}" alt="" width="${size}" height="${size}"></span>`
}
const label = (a) => esc(a.name || a.agent)

// ---------- explanations ----------
// A small "?" that shows what a number means on hover or keyboard focus. The
// text lives in explain.js; this only renders the marker.
// A label with a small "?" next to it that opens the explanation on hover or
// keyboard focus. The label itself stays plain text; only the marker is a
// button, so a label never gets squeezed by the marker.
function tip(key, label) {
  const e = explainFor(key, LANG)
  if (!e.title || e.title.startsWith("explain.")) return label ?? ""
  return `<span class="tipwrap">${label ?? ""}<span class="tip" tabindex="0" role="button" aria-expanded="false" aria-label="${esc(e.title)}: ${esc(e.body)}"><span class="tip-body" role="tooltip"><b>${esc(e.title)}</b>${esc(e.body)}</span></span></span>`
}

// Render notes outside scroll containers so table and drawer overflow never clip them.
let activeTip = null
let tipCloseTimer
function closeTip() {
  clearTimeout(tipCloseTimer)
  if (!activeTip) return
  activeTip.trigger.setAttribute('aria-expanded', 'false')
  activeTip.bubble.remove()
  activeTip = null
}
function wireTips(root) {
  for (const t of root.querySelectorAll('.tip:not([data-wired])')) {
    t.dataset.wired = '1'
    const open = () => {
      clearTimeout(tipCloseTimer)
      if (activeTip?.trigger === t) return
      closeTip()
      const bubble = document.createElement('div')
      bubble.className = 'floating-tip'
      bubble.setAttribute('aria-hidden', 'true') // trigger already contains the full accessible label
      bubble.innerHTML = t.querySelector('.tip-body').innerHTML
      bubble.addEventListener('mouseenter', () => clearTimeout(tipCloseTimer))
      bubble.addEventListener('mouseleave', () => { tipCloseTimer = setTimeout(closeTip, 180) })
      document.body.append(bubble)
      const r = t.getBoundingClientRect(), b = bubble.getBoundingClientRect()
      const left = Math.max(8, Math.min(window.innerWidth - b.width - 8, r.left + r.width / 2 - b.width / 2))
      const top = r.top >= b.height + 10 ? r.top - b.height - 8 : Math.min(window.innerHeight - b.height - 8, r.bottom + 8)
      bubble.style.left = `${left}px`
      bubble.style.top = `${Math.max(8, top)}px`
      t.setAttribute('aria-expanded', 'true')
      activeTip = {trigger:t, bubble}
    }
    const close = () => { if (activeTip?.trigger === t) closeTip() }
    t.addEventListener('mouseenter', open)
    t.addEventListener('mouseleave', () => { tipCloseTimer = setTimeout(close, 180) })
    t.addEventListener('focus', open)
    t.addEventListener('blur', close)
    t.addEventListener('click', e => { e.stopPropagation(); open() })
    t.addEventListener('keydown', e => {
      if (!['Escape', 'Enter', ' '].includes(e.key)) return
      e.stopPropagation()
      if (e.key === 'Escape') { e.preventDefault(); close() }
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activeTip?.trigger === t ? close() : open() }
    })
  }
}
document.addEventListener('scroll', closeTip, true)
window.addEventListener('resize', closeTip)
document.addEventListener('pointerdown', e => { if (!e.target.closest('.tip, .floating-tip')) closeTip() })

// Only request-start / response-finish hook observations drive activity.
// Completed-request timestamps must never masquerade as in-flight calls.
function isLive(a) {
  return state.activityKnown && (state.activeAgents.get(a.agent) || 0) > 0
}
function activityBadge(agent) {
  const count = state.activeAgents.get(agent) || 0
  return `<span class="live-badge">${tip("live", esc(T("activity.callsInFlight", { n: count })))}</span>`
}
async function refreshActivity() {
  if (document.hidden) return
  try {
    const res = await fetch(`/api/activity?k=${encodeURIComponent(TOKEN)}`, {cache:'no-store', signal:AbortSignal.timeout(4000)})
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    state.activeAgents = new Map(data.agents.map(a => [a.agent, a.count]))
    state.activityKnown = data.available === true
    if (!state.activityKnown) state.activeAgents.clear()
  } catch {
    state.activityKnown = false
    state.activeAgents.clear()
  }
  $('activityInfo').textContent = state.activityKnown
    ? T("activity.liveHint")
    : T("activity.unavailableHint")
  for (const card of document.querySelectorAll('.card[data-agent]')) {
    const active = state.activityKnown && (state.activeAgents.get(card.dataset.agent) || 0) > 0
    card.classList.toggle('live', active)
    const head = card.querySelector('.card-head')
    const old = head.querySelector('.live-badge')
    const count = state.activeAgents.get(card.dataset.agent) || 0
    if (old && old.dataset.count === String(count)) continue
    old?.remove()
    if (active) {
      head.insertAdjacentHTML('beforeend', activityBadge(card.dataset.agent))
      const badge = head.querySelector('.live-badge')
      badge.dataset.count = String(count)
      wireTips(badge)
    }
  }
}

// ---------- sparkline ----------
function spark(series, key, cls = "") {
  if (!series || series.length < 2) return ""
  const w = 240, h = cls ? 80 : 34, pad = 2
  const vals = series.map((d) => d[key])
  const max = Math.max(...vals, 1)
  const pts = vals.map((v, i) => [pad + (i * (w - pad * 2)) / (vals.length - 1), h - pad - (v / max) * (h - pad * 2)])
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ")
  const area = `${line} L${pts.at(-1)[0].toFixed(1)} ${h} L${pts[0][0].toFixed(1)} ${h} Z`
  return `<svg class="spark ${cls}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path class="a" d="${area}"/><path class="l" d="${line}"/></svg>`
}

// ---------- paint ----------
function paint() {
  const d = state.data
  $("state").hidden = true
  providers.paint(d)
  paintStatus(d)
  const readError = d.telemetry && [d.telemetry.request, d.telemetry.tools, d.telemetry.tasks?.eventLog, d.telemetry.tasks?.codex].some(source => source?.state === "read-error")
  const requestsUnavailable = ["missing", "read-error"].includes(d.telemetry?.request?.state)
  const toolsUnavailable = ["missing", "read-error"].includes(d.telemetry?.tools?.state)
  $("insights").hidden = $("kpis").hidden = $("providersBlock").hidden = requestsUnavailable
  $("agentsBlock").hidden = !d.agents.length || requestsUnavailable
  $("toolsBlock").hidden = !d.agents.length || toolsUnavailable
  if (requestsUnavailable) showState(T("state.requestUnavailable"))
  else if (readError) showState(T("state.partialReadError"))
  if (!d.agents.length) {
    for (const id of ["insights", "kpis", "cards", "tools"]) $(id).innerHTML = ""
    $("table").innerHTML = ""
    showState(T(requestsUnavailable ? "state.requestUnavailable" : readError ? "state.partialReadError" : "state.noAgents"))
    return
  }
  paintInsights(d)
  paintKpis(d)
  paintCardSort()
  paintView()
  paintCards(d)
  paintTable(d)
  paintTools(d)
  wireTips(document)
  const s = d.sources || {}
  $("sources").textContent = T("sources.summary", { usageRows: int(s.usageRows), toolRows: int(s.toolRows), time: new Date(d.generatedAt).toLocaleTimeString(LOCALE) })
  if (state.openAgent) openDetail(state.openAgent, false)
}

function ago(t) {
  if (!t) return T("time.none")
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return T("time.secondsAgo", { n: Math.round(s) })
  if (s < 3600) return T("time.minutesAgo", { n: Math.round(s / 60) })
  if (s < 86400) return T("time.hoursAgo", { n: Math.round(s / 3600) })
  return T("time.daysAgo", { n: Math.round(s / 86400) })
}
function paintStatus(d) {
  const el = $("status")
  el.className = "status wait"
  el.textContent = T("telemetry.generated", { time: new Date(d.generatedAt).toLocaleTimeString(LOCALE) })
  const values = d.telemetry || {}
  const items = [
    ["request", values.request, "latestAt"], ["tools", values.tools, "latestAt"],
    ["taskLog", values.tasks?.eventLog, "latestAt"], ["codex", values.tasks?.codex, "latestCompletedAt"],
  ]
  $("telemetry").innerHTML = items.map(([key, source, timeKey]) => {
    const status = source?.state || "unavailable"
    const message = status === "observed" ? T(key === "codex" ? "telemetry.completed" : "telemetry.observed", { time: ago(source[timeKey]) }) : T(`telemetry.${status}`)
    return `<span class="telemetry-item${status === "read-error" ? " is-error" : ""}"><b>${esc(T(`telemetry.${key}`))}</b> ${esc(message)}</span>`
  }).join("")
}

function paintInsights(d) {
  const expanded = $("insights").querySelector("details")?.open || false
  const render = i => `<div class="insight${i.kind === "volume" || i.kind === "errors" ? " hot" : ""}">${esc(i.text)}</div>`
  const [primary, ...rest] = d.insights
  $("insights").innerHTML = primary ? render(primary) + (rest.length ? `<details${expanded ? " open" : ""}><summary>${esc(T("insights.more", { count: rest.length }))}</summary>${rest.map(render).join("")}</details>` : "") : ""
}

function paintKpis(d) {
  const t = d.totals
  const items = [
    [T("kpi.inputTokens"), short(t.prompt), T("kpi.requests", { count: int(t.calls) }), "prompt"],
    [T("kpi.cacheRate"), pct(t.cacheRate), T("kpi.fullPriceOf", { value: short(t.fullPrice) }), "cacheRate"],
    [T("kpi.outputTokens"), short(t.out), T("kpi.avgPerCall", { value: short(t.calls ? t.out / t.calls : 0) }), "out"],
    [T("kpi.failed"), int(t.failed), pct(t.calls ? t.failed / t.calls : 0), "errorRate"],
    [T("kpi.agents"), int(d.agents.length), d.hiddenClients ? T("kpi.hiddenClients", { count: int(d.hiddenClients) }) : T("kpi.clients"), null],
  ]
  if (t.credits > 0) items.splice(4, 0, [T("kpi.credits"), t.credits.toFixed(2), T("kpi.creditsNote")])
  $("kpis").innerHTML = items
    .map(([k, v, s, tipKey]) => `<div class="kpi" title="${esc(s)}"><div class="k">${tipKey ? tip(tipKey, k) : k}</div><div class="v num">${v}</div><div class="s" title="${esc(s)}">${esc(s)}</div></div>`)
    .join("")
}

function cardModels(a) {
  const models = rankedModels(a.models)
  if (!models.length) return ""
  return `<div class="model-strip" role="group" aria-label="${esc(T("card.modelsRanked"))}">${models.map(m => {
    const description = T("card.modelUsage", { model: m.name, count: int(m.count), share: pct(a.calls ? m.count / a.calls : 0) })
    const glyph = m.icon ? mark({ name: m.name, icon: m.icon }, 28) : `<span class="model-alias" aria-hidden="true">${esc(m.name === "unknown" ? "?" : m.name.slice(0,2).toUpperCase())}</span>`
    return `<button type="button" class="tip model-chip" aria-label="${esc(description)}" aria-expanded="false" data-model-name="${esc(m.name)}" data-model-count="${m.count}">${glyph}<span class="tip-body">${esc(description)}</span></button>`
  }).join("")}</div>`
}
const modelStripResize = new ResizeObserver(entries => entries.forEach(({ target }) => updateModelFade(target)))
function updateModelFade(strip) {
  strip.style.setProperty("--model-fade-start", strip.scrollLeft > 1 ? "20px" : "0px")
  strip.style.setProperty("--model-fade-end", strip.scrollWidth - strip.clientWidth - strip.scrollLeft > 1 ? "28px" : "0px")
}
function wireModelStrips() {
  modelStripResize.disconnect()
  for (const strip of $("cards").querySelectorAll(".model-strip")) {
    strip.addEventListener("scroll", () => updateModelFade(strip), { passive: true })
    strip.addEventListener("keydown", e => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return
      const chips = [...strip.querySelectorAll("button")], index = chips.indexOf(document.activeElement)
      const next = e.key === "Home" ? 0 : e.key === "End" ? chips.length - 1 : Math.max(0, Math.min(chips.length - 1, index + (e.key === "ArrowRight" ? 1 : -1)))
      e.preventDefault()
      chips[next]?.scrollIntoView({ block: "nearest", inline: "nearest" })
      chips[next]?.focus({ preventScroll: true })
    })
    modelStripResize.observe(strip)
    updateModelFade(strip)
  }
}

function paintCards(d) {
  const focusedModel = document.activeElement?.dataset.modelName
  const focusedAgent = document.activeElement?.closest(".card")?.dataset.agent
  const scrolls = new Map([...$("cards").querySelectorAll(".card")].map(card => [card.dataset.agent, card.querySelector(".model-strip")?.scrollLeft || 0]))
  if (activeTip && $("cards").contains(activeTip.trigger)) closeTip()
  const max = Math.max(...d.agents.map((a) => a.prompt), 1)
  const metric = state.cardSort
  const sorted = [...d.agents].sort((x, y) => {
    if (metric === "taskDuration" && metricValue(x, metric) !== null && metricValue(y, metric) !== null) {
      const group = compareTaskSources(x, y)
      if (group) return group
    }
    return cardVal(y, metric) - cardVal(x, metric)
  })
  $("cards").innerHTML = sorted
    .map((a, i) => {
      const w = (a.prompt / max) * 100
      const fullW = a.prompt ? (a.fullPrice / a.prompt) * w : 0
      const top1 = a.prompt === max && d.agents.length > 1
      const live = isLive(a)
      const value = metricValue(a, metric)
      return `<div class="card${top1 ? " top1" : ""}${live ? " live" : ""}" data-agent="${esc(a.agent)}" aria-label="${esc(T("card.detailsAria", { name: a.name || a.agent }))}">
        <div class="card-head"><span class="card-name">${mark(a, 22)}${label(a)}</span>${live ? activityBadge(a.agent) : ""}${top1 ? `<span class="tag">${esc(T("card.topSpender"))}</span>` : ""}</div>
        <div class="card-value-row"><div class="card-big num">${formatMetric(value, metric)}<small>${esc(metric === "taskDuration" ? taskMetricLabel(a) : T(`col.${metric}`))}</small></div>${cardModels(a)}</div>
        ${metric === "prompt" ? `<div class="stack" title="${esc(T("card.stackLegend"))}"><span class="cached" style="width:${(w - fullW).toFixed(2)}%"></span><span class="full" style="width:${fullW.toFixed(2)}%"></span></div>` : ""}
        ${metric === "taskDuration" ? `<p class="task-context hint">${esc(value === null ? taskEmpty(a) : `${taskSourceText(a)} · ${taskSamples(a)}`)}</p>` : ""}
        <div class="card-meta">
          <div><b class="num">${pct(metricValue(a, "cacheRate"))}</b>${tip("cacheRate", esc(T("col.cacheRate")))}</div>
          <div><b class="num">${short(metricValue(a, "avgPrompt"))}</b>${tip("avgPrompt", esc(T("col.avgPrompt")))}</div>
          <div><b class="num ${a.errorRate >= 0.03 ? "bad" : ""}">${pct(metricValue(a, "errorRate"))}</b>${tip("errorRate", esc(T("col.errorRate")))}</div>
        </div>
        <div class="card-foot"><span>${int(a.calls)} ${esc(T("col.calls"))}</span><button class="card-open" type="button" data-open-agent="${esc(a.agent)}" aria-label="${esc(T("card.detailsAria", { name: a.name || a.agent }))}">${esc(T("card.details"))} ›</button></div>
      </div>`
    })
    .join("")
  for (const card of $("cards").querySelectorAll(".card")) {
    const strip = card.querySelector(".model-strip")
    if (strip) strip.scrollLeft = scrolls.get(card.dataset.agent) || 0
    if (focusedModel && card.dataset.agent === focusedAgent) {
      const replacement = [...card.querySelectorAll(".model-chip")].find(chip => chip.dataset.modelName === focusedModel)
      queueMicrotask(() => replacement?.isConnected && replacement.focus({ preventScroll: true }))
    }
  }
  wireModelStrips()
}

function formatMetric(value, key) {
  if (key === "cacheRate" || key === "errorRate") return pct(value)
  if (key === "taskDuration" || key === "session") return dur(value)
  if (key === "p50ttft" || key === "p50ms") return secs(value)
  return key === "calls" ? int(value) : short(value)
}
const val = (a, k) => k === "agent" ? a.name || a.agent : k === "protocol" ? a.protocols?.[0]?.name || "" : metricValue(a, k)
const cardVal = (a, k) => metricValue(a, k) ?? -1
function paintView() {
  const cards = state.view === "cards"
  $("cardsHint").textContent = T(state.cardSort === "taskDuration" ? "task.sortHint" : "cards.hint")
  for (const id of ["cards", "cardSort", "cardsHint", "activityInfo"]) $(id).hidden = !cards
  $("comparison").hidden = cards
  for (const b of $("agentView").children) b.setAttribute("aria-pressed", String(b.dataset.view === state.view))
}

function paintCardSort() {
  const box = $("cardSort")
  if (!box) return
  box.innerHTML = CARD_SORTS.map(([k, nameKey]) =>
    `<button class="pill${state.cardSort === k ? " on" : ""}" data-sort="${k}" aria-pressed="${state.cardSort === k}">${esc(T(nameKey))}</button>`).join("")
}

function metricCell(a, key, formatted, ranges) {
  const value = metricValue(a, key)
  const edge = key === "taskDuration" ? null : extremum(value, ranges[key], DIRECTIONS[key])
  const note = key === "taskDuration" ? `<span class="extreme-label">${esc(value === null ? taskEmpty(a) : `${taskSourceText(a)} · ${taskSamples(a)}`)}</span>` : ""
  return `<td class="n ${edge ? `metric-${edge.quality}` : ""}" data-metric="${key}"${key === "taskDuration" && value === null ? ` title="${esc(taskEmpty(a))}"` : ""}>${value === null ? "—" : formatted}${note}${edge ? `<span class="extreme-label" title="${esc(T(`extreme.${edge.edge}`))}">${esc(T(`extreme.${edge.quality}`))}</span>` : ""}</td>`
}

const TABLE_GROUPS = [
  ["consumption", ["calls", "prompt", "avgPrompt", "cacheRate", "fullPrice", "out"]],
  ["stability", ["errorRate", "p50ttft", "p50ms"]],
  ["tasks", ["taskDuration", "session"]],
  ["tools", ["toolTokens", "protocol"]],
]
const tableCols = [COLS[0], ...TABLE_GROUPS.flatMap(([, keys]) => keys.map(k => COLS.find(([key]) => key === k)))]
function paintMetricGroup() {
  const keys = TABLE_GROUPS.find(([group]) => group === state.metricGroup)[1]
  $("taskCompareHint").hidden = state.metricGroup !== "tasks"
  $("metricGroups").innerHTML = TABLE_GROUPS.map(([group]) => `<button type="button" class="pill${group === state.metricGroup ? " on" : ""}" data-metric-group="${group}" aria-pressed="${group === state.metricGroup}">${esc(T(`table.group.${group}`))}</button>`).join("")
  for (const row of $("table").rows) {
    if (row.classList.contains("column-groups")) {
      [...row.cells].forEach((cell, i) => { cell.hidden = i > 0 && TABLE_GROUPS[i - 1][0] !== state.metricGroup })
    } else {
      [...row.cells].forEach((cell, i) => { cell.hidden = i > 0 && !keys.includes(tableCols[i][0]) })
    }
  }
}
function sortTable() {
  const { key, dir } = state.sort
  const agents = new Map(state.data.agents.map(a => [a.agent, a]))
  const collator = new Intl.Collator(LOCALE, { numeric: true, sensitivity: "base" })
  const body = $("table").tBodies[0]
  const rows = [...body.rows].sort((x, y) => {
    const agentA = agents.get(x.dataset.agent), agentB = agents.get(y.dataset.agent)
    const a = val(agentA, key), b = val(agentB, key)
    if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1
    if (key === "taskDuration") { const group = compareTaskSources(agentA, agentB); if (group) return group }
    return (typeof a === "string" ? collator.compare(a, b) : a - b) * dir
  })
  for (const row of rows) body.moveBefore ? body.moveBefore(row, null) : body.append(row)
  for (const th of $("table").querySelectorAll("th[data-key]")) {
    if (th.dataset.key === key) th.setAttribute("aria-sort", key === "taskDuration" ? "other" : dir < 0 ? "descending" : "ascending")
    else th.removeAttribute("aria-sort")
  }
}
function paintTable(d) {
  const ranges = extrema(d.agents)
  const groups = TABLE_GROUPS.map(([group, keys]) => `<th scope="colgroup" colspan="${keys.length}">${esc(T(`table.group.${group}`))}</th>`).join("")
  const head = tableCols.map(([k, nameKey, n, tipKey]) => `<th scope="col" class="${n ? "n" : ""}" data-key="${k}"><div class="column-heading"><button type="button" data-table-sort="${k}">${esc(T(nameKey))}<span class="sort-icon" aria-hidden="true">↕</span></button>${tipKey ? tip(tipKey) : ""}</div></th>`).join("")
  const body = d.agents.map(a => `<tr data-agent="${esc(a.agent)}"><th scope="row" class="agent"><button type="button" class="agent-open who" data-open-agent="${esc(a.agent)}">${mark(a, 18)}${label(a)}</button></th>${tableCols.slice(1).map(([key]) => key === "protocol" ? `<td class="proto-cell" title="${esc(a.protocols?.map(p => p.name).join(", "))}">${esc(a.protocols?.[0]?.name || "—")}</td>` : metricCell(a, key, formatMetric(metricValue(a, key), key), ranges)).join("")}</tr>`).join("")
  $("table").innerHTML = `<caption class="sr-only" id="comparison-caption">${esc(T("table.title"))}</caption><thead><tr class="column-groups"><th></th>${groups}</tr><tr>${head}</tr></thead><tbody>${body}</tbody>`
  paintMetricGroup()
  sortTable()
}

function paintTools(d) {
  const withTools = d.agents.filter((a) => a.tools)
  if (!withTools.length) {
    $("toolsHint").textContent = T("tools.hint")
    $("tools").innerHTML = `<div class="waiting">${esc(T("tools.empty"))}</div>`
    return
  }
  const sorted = [...withTools].sort((a, b) => (b.tools[state.toolSort] ?? 0) - (a.tools[state.toolSort] ?? 0))
  const max = sorted[0].tools.avgBytes || 1
  $("toolsHint").innerHTML = `${esc(T("tools.sampling", { since: when(d.toolsSince), samples: int(d.toolSamples) }))}
    <span class="sortbar inline">${[["avgBytes", T("tools.sortBytes")], ["avgTokens", T("tools.sortTokens")], ["avgCount", T("tools.sortCount")], ["shareOfPrompt", T("tools.sortShare")]]
      .map(([k, n]) => `<button class="pill${state.toolSort === k ? " on" : ""}" data-tsort="${k}" aria-pressed="${state.toolSort === k}">${n}</button>`).join("")}</span>`
  $("tools").innerHTML = `<div class="table-wrap" style="padding:4px 16px">${sorted
    .map((a, i) => `<div class="tool-row">
      <div class="agent who">${mark(a, 18)}<b>${label(a)}</b></div>
      <div class="tool-track"><div class="tool-fill${i === 0 && sorted.length > 1 ? " hot" : ""}" style="width:${((a.tools.avgBytes / max) * 100).toFixed(1)}%"></div></div>
      <div class="tool-val num">${esc(a.tools.shareOfPrompt != null ? T("tools.perAgentShare", { count: Math.round(a.tools.avgCount), tokens: short(a.tools.avgTokens), share: pct(a.tools.shareOfPrompt) }) : T("tools.perAgent", { count: Math.round(a.tools.avgCount), tokens: short(a.tools.avgTokens) }))}</div>
    </div>`)
    .join("")}</div>`
}

// ---------- detail drawer ----------
function distribution(items, total) {
  if (!items?.length) return `<p class="hint">${esc(T("detail.noRecords"))}</p>`
  return items.map(m => `<div class="dist-row"><div><span>${esc(m.label || m.name)}</span><span class="num">${esc(T("detail.countPct", { count: int(m.count), pct: pct(total ? m.count / total : 0) }))}</span></div><div class="dist-track"><span style="width:${Math.min(100, total ? m.count / total * 100 : 0)}%"></span></div></div>`).join("")
}

let drawerOpener = null
function openDetail(agent, focus = true) {
  if (focus) drawerOpener = document.activeElement
  const a = state.data?.agents.find(x => x.agent === agent)
  if (!a) return closeDetail()
  const previousDetails = !focus ? [...$("detail").querySelectorAll('details')].map(d => d.open) : []
  const previousQuery = !focus ? $("detail").querySelector('.tool-search input')?.value || '' : ''
  const controls = 'button, input, summary, a[href], [tabindex="0"]'
  const focusedIndex = !focus ? [...$("detail").querySelectorAll(controls)].indexOf(document.activeElement) : -1
  const selection = document.activeElement instanceof HTMLInputElement ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null
  state.openAgent = agent
  const modelCount = a.models.reduce((n,m) => n + m.count, 0)
  const protoNames = {anthropic:'Anthropic Messages', responses:'OpenAI Responses', chat:'OpenAI Chat Completions', gemini:'Google Gemini', other:T('detail.otherProtocol')}
  const protocolCount = a.protocols.reduce((n,p) => n + p.count, 0)
  const toolNames = a.tools?.names || []
  const cache = Math.max(0, Math.min(100, a.cacheRate * 100))
  const failure = a.calls ? a.failed / a.calls : 0
  $("detail").innerHTML = `<div class="detail detail-guide">
    <header class="detail-heading"><h3 class="who">${mark(a,32)}${label(a)}</h3><p class="hint">${when(a.first ?? state.data.since)} — ${when(a.last ?? state.data.generatedAt)} · ${esc(T('detail.selectedPeriod'))}</p></header>
    <div class="detail-summary"><strong>${esc(T('detail.summaryRequests', { calls: int(a.calls) }))}</strong><p>${esc(T('detail.summaryBody', { avg: short(a.avgPrompt), cache: pct(a.cacheRate), failed: int(a.failed), cancelled: int(a.cancelled) }))}</p><small>${esc(T('detail.summaryNote'))}</small></div>
    <section class="sec" data-task-duration><h4>${esc(T('detail.taskTitle'))} ${tip('taskDuration')}</h4><div class="detail-metrics"><div><span>${esc(taskMetricLabel(a))}</span>${taskValue(a)}</div><div><span>${esc(T('task.completed'))}</span><b>${int(a.taskDuration?.samples ?? 0)}</b></div><div><span>${esc(T('task.total'))}</span><b>${dur(a.taskDuration?.totalMs)}</b></div></div>${metricValue(a, "taskDuration") === null ? `<p class="empty-note">${esc(taskEmpty(a))}</p>` : ""}<p class="hint">${esc(taskSourceText(a))} · ${esc(T('detail.taskNote'))}</p>${a.taskDuration?.sources?.includes('codex-rollout') ? `<p class="hint">${esc(T('detail.codexTaskSource', { ms: int(a.taskDuration.precision?.millisecond ?? 0), sec: int(a.taskDuration.precision?.second ?? 0) }))}</p>` : ''}</section>
    <section class="sec"><h4>${esc(T('detail.inputTitle'))} ${tip('prompt')}</h4>
      <div class="detail-metrics"><div><span>${esc(T('detail.totalInput'))}</span><b>${short(a.prompt)}</b></div><div><span>${esc(T('detail.avgInput'))}</span><b>${short(a.avgPrompt)}</b></div><div><span>${esc(T('detail.generatedOutput'))}</span><b>${short(a.out)}</b></div></div>
      ${a.prompt ? `<div class="composition" aria-label="${esc(T('explain.cacheRate.title'))} ${pct(a.cacheRate)}"><span style="width:${cache}%"></span><span style="width:${100-cache}%"></span></div>
      <div class="composition-key"><span>● ${esc(T('detail.cacheReads'))} ${short(a.cacheRead)} · ${pct(a.cacheRate)}</span><span>● ${esc(T('detail.nonCacheReads'))} ${short(a.fullPrice)}</span></div>` : `<p class="empty-note">${esc(T('detail.noInput'))}</p>`}
      <p class="hint">${esc(T('detail.cacheNote'))}</p>
      <details><summary>${esc(T('detail.inputBreakdown'))}</summary><dl class="detail-facts"><dt>${esc(T('detail.freshInput'))}</dt><dd>${short(a.in)}</dd><dt>${esc(T('detail.cacheWrite'))}</dt><dd>${short(a.cacheWrite)}</dd>${a.credits > 0 ? `<dt>${esc(T('detail.credits'))}</dt><dd>${a.credits.toFixed(2)} credits</dd>` : ''}</dl></details>
    </section>
    <section class="sec"><h4>${esc(T('detail.latencyTitle'))}</h4><div class="detail-metrics"><div><span>${esc(T('detail.ttft'))} ${tip('p50ttft')}</span><b>${secs(a.p50ttft)}</b></div><div><span>${esc(T('detail.fullResponse'))} ${tip('p50ms')}</span><b>${secs(a.p50ms)}</b></div><div><span>${esc(T('detail.failureRate'))} ${tip('errorRate')}</span><b>${pct(failure)}</b></div></div><p class="hint">${esc(T('detail.latencyNote'))}</p></section>
    <section class="sec"><h4>${esc(T('detail.toolsTitle'))} ${tip('toolTokens')}</h4>${a.tools ? `<div class="detail-metrics"><div><span>${esc(T('detail.toolsPerRequest'))}</span><b>${esc(T('detail.toolsPerRequestValue', { count: Math.round(a.tools.avgCount) }))}</b></div><div><span>${esc(T('detail.toolSize'))}</span><b>≈${short(a.tools.avgTokens)}</b></div><div><span>${esc(T('detail.validSamples'))}</span><b>${esc(T('detail.validSamplesValue', { count: int(a.tools.samples) }))}</b></div></div><p>${esc(T('detail.toolsNote'))}</p><p class="hint">${esc(T('detail.toolsCaveat', { samples: int(a.tools.samples), calls: int(a.calls) }))}</p><details class="tool-inventory"><summary>${esc(T('detail.toolInventory'))}</summary><label class="tool-search">${esc(T('detail.toolFilter'))}<input type="search" placeholder="${esc(T('detail.toolSearchPlaceholder'))}" aria-label="${esc(T('detail.toolFilter'))}"></label><div class="chips tool-list">${toolNames.map(t=>`<span class="chip mono" data-tool-name="${esc(t.name.toLowerCase())}">${esc(t.name)}</span>`).join('')}</div><p class="hint">${esc(T('detail.toolInventoryNote'))}</p></details>` : `<p class="empty-note">${esc(T('detail.toolsEmpty'))}</p>`}</section>
    <section class="sec"><h4>${esc(T('detail.modelsTitle'))}</h4><p class="hint">${esc(T('detail.modelsNote', { count: a.models.length }))}</p>${distribution(a.models,a.calls)}${modelCount < a.calls ? `<p class="hint">${esc(T('detail.remaining', { count: int(a.calls-modelCount) }))}</p>` : ''}</section>
    <section class="sec"><h4>${esc(T('detail.protocolsTitle'))} ${tip('protocol')}</h4><p class="hint">${esc(T('detail.protocolsNote'))}</p>${distribution(a.protocols.map(p=>({...p,label:protoNames[p.name] || p.name})),a.calls)}${protocolCount < a.calls ? `<p class="hint">${esc(T('detail.remaining', { count: int(a.calls-protocolCount) }))}</p>` : ''}</section>
    <section class="sec"><h4>${esc(T('detail.sessionTitle'))} ${tip('sessionMedian')}</h4>${a.session?.measured ? `<div class="detail-metrics"><div><span>${esc(T('detail.medianSpan'))}</span><b>${dur(a.session.median)}</b></div><div><span>${esc(T('detail.p90Span'))}</span><b>${dur(a.session.p90)}</b></div><div><span>${esc(T('detail.measuredSessions'))}</span><b>${int(a.session.measured)}</b></div></div><p class="hint">${esc(T('detail.sessionNote', { open: int(a.session.open || 0) }))}</p>` : `<div class="empty-note"><strong>${esc(T('detail.sessionUnavailable'))}</strong><p>${esc(T('detail.sessionEmpty'))}</p></div>`}</section>
    <section class="sec"><h4>${esc(T('detail.trendTitle'))}</h4>${spark(a.series,'prompt','big') || `<p class="hint">${esc(T('detail.trendEmpty'))}</p>`}<p class="hint">${esc(T('detail.trendNote'))}</p></section>
  </div>`
  wireTips($("detail"))
  const search = $("detail").querySelector('.tool-search')
  if (search) search.insertAdjacentHTML('afterend', `<p class="hint" id="toolSearchStatus" role="status"></p>`)
  $("detail").querySelector('.tool-search input')?.addEventListener('input', e => {
    const term = e.target.value.trim().toLowerCase()
    const items = [...$("detail").querySelectorAll('[data-tool-name]')]
    for (const item of items) item.hidden = !item.dataset.toolName.includes(term)
    $("toolSearchStatus").textContent = term && items.every(item => item.hidden) ? T("detail.toolsNoResults") : ""
  })
  if (!focus) {
    $("detail").querySelectorAll('details').forEach((d,i) => { d.open = !!previousDetails[i] })
    const input = $("detail").querySelector('.tool-search input')
    if (input) { input.value = previousQuery; input.dispatchEvent(new Event('input')) }
    const focused = $("detail").querySelectorAll(controls)[focusedIndex]
    focused?.focus({ preventScroll: true })
    if (focused instanceof HTMLInputElement && selection) focused.setSelectionRange(...selection)
  }
  const dr = $("drawer")
  dr.inert = false
  for (const el of document.querySelectorAll("body > header, main, footer")) el.inert = true
  dr.classList.add("open")
  dr.setAttribute("aria-hidden", "false")
  $("scrim").hidden = false
  if (focus) { dr.scrollTop = 0; dr.focus() }
}
function closeDetail() {
  const closedAgent = state.openAgent
  state.openAgent = null
  $("drawer").inert = true
  for (const el of document.querySelectorAll("body > header, main, footer")) el.inert = false
  $("drawer").classList.remove("open")
  $("drawer").setAttribute("aria-hidden", "true")
  $("scrim").hidden = true
  if (drawerOpener?.isConnected && drawerOpener !== document.body) drawerOpener.focus()
  else [...document.querySelectorAll("[data-open-agent]")].find(el => el.dataset.openAgent === closedAgent && el.getClientRects().length)?.focus()
}

const providers = providerView({ T, esc, int, pct, locale: LOCALE, mark, onModelChange: model => {
  state.providerModel = model
  load()
} })
let loadSequence = 0

// ---------- loading ----------
function showState(text, err = false) {
  $("state").hidden = false
  $("state").className = err ? "state err" : "state"
  $("state").textContent = text
}

async function load() {
  if (providers.isSharing()) return
  const sequence = ++loadSequence
  $("providersBlock").setAttribute("aria-busy", "true")
  $("providerShare").disabled = true
  if (!state.data) $("cards").innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>'
  try {
    const p = new URLSearchParams({ period: state.period, tz: String(new Date().getTimezoneOffset()) })
    if (state.clients) p.set("clients", "1")
    if (state.providerModel) p.set("providerModel", state.providerModel)
    p.set("lang", LANG)
    p.set("k", TOKEN)
    const res = await fetch(`/api/summary?${p}`, { cache: "no-store" })
    if (res.status === 403 && !sessionStorageSafe("al.reloaded")) { markReloaded(); return location.reload() }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (sequence !== loadSequence || providers.isSharing()) return
    state.data = data
    paint()
  } catch (e) {
    if (sequence === loadSequence) {
      showState(T("state.loadError", { message: e.message }), true)
      $("providerReport").hidden = true
    }
  } finally {
    if (sequence === loadSequence) $("providersBlock").setAttribute("aria-busy", "false")
  }
}

// ---------- events ----------
function selectPeriod() {
  for (const b of $("periods").children) b.setAttribute("aria-selected", String(b.dataset.period === state.period))
}
$("periods").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-period]")
  if (!b || b.dataset.period === state.period) return
  state.period = b.dataset.period
  store.set("al.period", state.period)
  selectPeriod()
  load()
})
$("clients").checked = state.clients
$("clients").addEventListener("change", (e) => {
  state.clients = e.target.checked
  store.set("al.clients", state.clients ? "1" : "0")
  load()
})
const pick = (e) => e.target.closest("[data-agent]")?.dataset.agent
$("cards").addEventListener("click", (e) => { if (e.target.closest(".tip")) return; const a = pick(e); if (a) openDetail(a) })
$("agentView").addEventListener("click", e => {
  const b = e.target.closest("button[data-view]")
  if (!b) return
  state.view = b.dataset.view
  store.set("al.view", state.view)
  paintView()
})
$("cardSort").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-sort]")
  if (!b || b.dataset.sort === state.cardSort) return
  state.cardSort = b.dataset.sort
  paintView()
  paintCardSort()
  paintCards(state.data)
  wireTips($("cards"))
})
$("toolsHint").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tsort]")
  if (!b) return
  state.toolSort = b.dataset.tsort
  paintTools(state.data)
})
$("metricGroups").addEventListener("click", e => {
  const button = e.target.closest("button[data-metric-group]")
  if (!button) return
  state.metricGroup = button.dataset.metricGroup
  const keys = TABLE_GROUPS.find(([group]) => group === state.metricGroup)[1]
  if (!keys.includes(state.sort.key) && state.sort.key !== "agent") state.sort = { key: keys[0], dir: -1 }
  paintMetricGroup()
  sortTable()
  $("metricGroups").querySelector(`[data-metric-group="${state.metricGroup}"]`).focus()
})
$("table").addEventListener("click", (e) => {
  if (e.target.closest(".tip")) return
  const button = e.target.closest("button[data-table-sort]")
  if (button) {
    const k = button.dataset.tableSort
    state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : 1 }
    sortTable()
    $("sortStatus").textContent = k === "taskDuration" ? T("task.sortedBySource") : T("table.sorted", { column: T(tableCols.find(([key]) => key === k)[1]), direction: T(state.sort.dir < 0 ? "sort.descending" : "sort.ascending"), count: state.data.agents.length })
    return
  }
  const a = pick(e)
  if (a) openDetail(a)
})
$("drawer").addEventListener("keydown", e => {
  if (e.key !== "Tab") return
  const controls = [...$("drawer").querySelectorAll('button, input, summary, a[href], [tabindex="0"]')].filter(el => el.getClientRects().length)
  const first = controls[0], last = controls.at(-1)
  if (e.shiftKey && (document.activeElement === first || document.activeElement === $("drawer"))) { e.preventDefault(); last?.focus() }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
})
$("close").addEventListener("click", closeDetail)
$("scrim").addEventListener("click", closeDetail)
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.openAgent) closeDetail() })

selectPeriod()
await load()
await refreshActivity()
setInterval(load, 60_000)
async function pollActivity() {
  await refreshActivity()
  setTimeout(pollActivity, 2000)
}
setTimeout(pollActivity, 2000)
