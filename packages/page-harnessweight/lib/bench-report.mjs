import { extrema, extremum } from "../app/comparison.js"
import { translate } from "../app/i18n.mjs"
import { errorReason } from "./errors.mjs"

const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
const int = value => Number.isFinite(value) ? Math.round(value).toLocaleString("en") : "—"
const T = key => translate("en", key)

// Styles are supplied by the caller so saved data can render without I/O or requests.
export function reportHtml({ summary, rows = [], task, generatedAt, file }, styles) {
  const metric = (r, key) => key === "errorRate" ? (r.samples > 0 ? r[key] : null)
    : r.ok > 0 && Number.isFinite(r[key]) ? r[key] : null
  const keys = ["errorRate", "p50", "p95", "ttftP50"]
  const ranges = extrema(summary, keys, metric)
  const cell = (r, key) => {
    const value = metric(r, key)
    const edge = extremum(value, ranges[key], "low")
    const text = value == null ? "—" : key === "errorRate" ? `${(value * 100).toFixed(1)}%` : int(value)
    return `<td class="n${edge ? ` metric-${edge.quality}` : ""}">${text}${edge ? `<span class="extreme-label">${T(`extreme.${edge.quality}`)}</span>` : ""}</td>`
  }
  const errors = r => {
    if (!r.fail) return "—"
    const records = rows.filter(row => row.model === r.model && !(row.status >= 200 && row.status < 400))
    const samples = records.length ? records : (r.errors || r.topErrors || []).map(error => ({ error, status: Number(/HTTP\s+(\d{3})/i.exec(error)?.[1] || 0) }))
    const categories = new Map()
    for (const row of samples) {
      const reason = row.timedOut ? "timeout" : errorReason(row.status, "", row.error)
      const label = `${T(`reason.${reason}`)}${row.status ? ` · HTTP ${row.status}` : ""}`
      categories.set(label, (categories.get(label) || 0) + 1)
    }
    const groups = [...categories].sort((a, b) => b[1] - a[1])
    return `<details class="bench-errors"><summary>${esc(groups[0]?.[0] || T("reason.unknown"))}</summary><ul>${groups.map(([label, count]) => `<li>${esc(label)} · ${int(count)}</li>`).join("")}</ul><p class="hint">${int(r.fail)} / ${int(r.samples)} requests failed. Categories inferred from recorded errors; raw messages omitted.</p></details>`
  }
  const table = summary.map(r => `<tr><td><span class="provider-name">${esc(r.provider)}</span><span class="bench-model">${esc(r.model)}</span></td><td class="n">${int(r.samples)}</td>${keys.map(key => cell(r, key)).join("")}<td class="n">${int(r.timeout)}</td><td>${errors(r)}</td></tr>`).join("")
  const stats = [
    ["Providers", new Set(summary.map(r => r.provider)).size],
    ["Models without failures", summary.filter(r => r.samples > 0 && r.fail === 0).length],
    ["Models with failures", summary.filter(r => r.fail > 0).length],
    ["Requests", summary.reduce((n, r) => n + r.samples, 0)],
  ]
  const source = String(file || "Recorded benchmark results").split(/[\\/]/).pop()
  const date = new Date(generatedAt).toLocaleString("en", { dateStyle: "medium", timeStyle: "long" })
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HarnessWeight · Provider benchmark</title>
<script>const theme = new URLSearchParams(location.search).get("theme"); if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;</script>
<style>${styles}</style></head><body><main class="bench-report">
<header class="bench-heading"><div><h1>HarnessWeight</h1><p class="sub">Provider benchmark · ${esc(task)}</p></div><button class="pill" id="themeToggle" type="button" aria-label="Switch color theme">Light / dark</button></header>
<section class="provider-report" aria-label="Provider benchmark results">
<div class="report-head"><h2>Provider results</h2><p class="hint">${esc(date)} · Source: ${esc(source)}</p></div>
<dl class="report-stats">${stats.map(([label, value]) => `<div><dt>${label}</dt><dd class="num">${int(value)}</dd></div>`).join("")}</dl>
<div class="table-wrap" tabindex="0" role="region" aria-label="Provider measurements; scroll horizontally on narrow screens"><table><thead><tr><th scope="col">Provider / model</th><th scope="col" class="n">Samples</th><th scope="col" class="n">Error rate</th><th scope="col" class="n">p50<br><span class="unit">ms</span></th><th scope="col" class="n">p95<br><span class="unit">ms</span></th><th scope="col" class="n">Response<br><span class="unit">p50 · ms</span></th><th scope="col" class="n">Timeouts</th><th scope="col">Error details</th></tr></thead><tbody>${table || '<tr><td colspan="8">No recorded samples.</td></tr>'}</tbody></table></div>
<footer class="report-note"><p>Small samples from the recorded run; results depend on model, account and network conditions. These observations are not a provider ranking. Green/red mark the lowest/highest measured error rate or latency; ties share markers, equal columns stay unmarked.</p><p>Latency uses successful requests only. — means no measurement. Response p50 is the stored non-streaming response-body time (ttftP50), not first-token latency. Error details show bounded categories, not upstream payloads.</p></footer>
</section></main><script>document.getElementById("themeToggle").addEventListener("click", () => { const root = document.documentElement; const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches; root.dataset.theme = dark ? "light" : "dark"; });</script></body></html>`
}
