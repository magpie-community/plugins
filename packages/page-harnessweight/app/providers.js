import { extrema, extremum } from "./comparison.js"

import { PROVIDER_ICONS } from "./provider-icons.js"

export function providerView({ T, esc, int, pct, locale, mark, onModelChange }) {
  const $ = id => document.getElementById(id)
  const date = t => new Date(t).toLocaleString(locale, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZoneName: "short" })
  let data, provider = "", agent = "", sharing = false, available = false, reasonsOpen = false
  const name = id => data.agents.find(a => a.agent === id)?.name || id
  const providerBrand = id => Object.hasOwn(data?.providerView?.brands || {}, id) ? data.providerView.brands[id] : {}
  const providerName = id => id === "unknown" ? T("providers.unknown") : providerBrand(id).name || id
  let modelOptions = "", expanded = false
  const richPicker = globalThis.CSS?.supports("appearance", "base-select") ?? false
  const providerMark = (id, size = 24) => mark({ agent: id, name: providerName(id), icon: providerBrand(id).icon || PROVIDER_ICONS[id] }, size)
  const rate = value => Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "—"
  const option = (value, label) => `<option value="${esc(value)}">${esc(label)}</option>`
  const pickerButton = richPicker ? '<button type="button"><selectedcontent></selectedcontent></button>' : ""
  const reasonLabel = r => r.status >= 400 ? `${T(`reason.${r.reason}`)} · HTTP ${r.status}`
    : r.status === 200 ? `${T(`reason.${r.reason}`)} · ${T("providers.midStream")}`
    : `${T(`reason.${r.reason}`)} · ${T("providers.noStatus")}`

  function paint(d) {
    data = d
    const view = d.providerView
    available = ["providerOptions", "models", "providers"].every(key => Array.isArray(view?.[key]))
    $("providerUnavailable").hidden = available
    $("providerReport").hidden = !available
    $("providerModel").disabled = !available
    $("providerPicker").hidden = !available
    if (!available) {
      provider = agent = ""
      modelOptions = ""
      $("providerReportMark").innerHTML = ""
      reasonsOpen = false
      share(false)
      for (const id of ["providerGallery", "providerHarnesses", "providerModel", "providerReportTitle", "providerScope", "providerKpis", "providerTable", "providerReasons"]) $(id).innerHTML = ""
      $("providerShare").disabled = true
      return
    }
    if (!view.providerOptions.includes(provider)) provider = view.providers[0]?.provider || ""
    // Preserve a selected model across an empty period so the empty state is explicit.
    const models = view.model && !view.models.includes(view.model) ? [...view.models, view.model] : view.models
    const nextModels = pickerButton + option("", T("providers.allModels")) + models.map(m => option(m, m)).join("")
    if (modelOptions !== nextModels) $("providerModel").innerHTML = modelOptions = nextModels
    $("providerModel").value = view.model
    render()
  }
  function render() {
    if (!available) return
    const focused = document.activeElement
    const focusedProvider = focused?.dataset.provider
    const focusedAgent = focused?.dataset.providerAgent
    const focusInCoverage = focused?.closest?.("#providerHarnesses")
    const focusedReason = focused?.id === "providerAll" || focused?.matches("#providerReasonDetail > summary")
    const p = data.providerView.providers.find(p => p.provider === provider)
    const calls = new Map(data.providerView.providers.map(p => [p.provider, p.calls]))
    const options = [...data.providerView.providerOptions].sort((a, b) =>
      (calls.get(b) || 0) - (calls.get(a) || 0) || (a < b ? -1 : a > b ? 1 : 0))
    // Keep a selected provider visible when the gallery is collapsed.
    const initial = options.slice(0, 6)
    if (provider && !initial.includes(provider)) initial.splice(5, 1, provider)
    const visible = expanded ? options : initial
    $("providerGallery").innerHTML = visible.map(id => {
      const sample = data.providerView.providers.find(p => p.provider === id)
      return `<button type="button" class="provider-tile" data-provider="${esc(id)}" aria-pressed="${id === provider}" aria-controls="providerReport">${providerMark(id, 36)}<span class="provider-tile-name">${esc(providerName(id))}</span><span class="provider-tile-meta">${int(sample?.harnesses.length || 0)} ${esc(T("providers.harnessCount"))} · ${int(sample?.calls || 0)} ${esc(T("providers.requests"))}</span><span class="provider-tile-state">${esc(T(id === provider ? "providers.selected" : "providers.viewReport"))}</span></button>`
    }).join("")
    $("providerExpand").hidden = options.length <= 6
    $("providerExpand").textContent = expanded ? T("providers.showLess") : `${T("providers.showAll")} (${int(options.length)})`
    $("providerExpand").setAttribute("aria-expanded", String(expanded))
    $("providerReportTitle").textContent = provider ? providerName(provider) : T("providers.title")
    $("providerReportMark").innerHTML = provider ? providerMark(provider, 56) : ""
    $("providerScope").textContent = `${date(data.since)} — ${date(data.generatedAt)} · ${data.providerView.model || T("providers.allModels")} · ${$("clients").checked ? T("providers.withClients") : T("providers.agentsOnly")}`
    $("providerKpis").innerHTML = p ? [
      [T("col.errorRate"), rate(p.errorRate), "report-primary"],
      [T("providers.harnessCount"), int(p.harnesses.length), ""],
      [T("col.calls"), int(p.calls), ""], [T("kpi.failed"), int(p.failed), ""],
      [T("providers.cancelled"), int(p.cancelled), ""],
    ].map(([label, value, className]) => `<div class="${className}"><dt>${esc(label)}</dt><dd class="num">${esc(value)}</dd></div>`).join("") : ""
    $("providerShare").disabled = !p
    if (!p) {
      $("providerHarnesses").innerHTML = ""
      $("providerTable").innerHTML = ""
      $("providerReasons").innerHTML = `<p class="empty-note">${esc(T("providers.empty"))}</p>`
      restoreProviderFocus(focusedProvider)
      return
    }
    const ranges = extrema(p.harnesses, ["errorRate"], (row, key) => row[key])
    $("providerHarnesses").innerHTML = p.harnesses.map(a => {
      return `<button type="button" class="provider-harness" data-provider-agent="${esc(a.agent)}" aria-controls="providerReasonDetail" aria-pressed="${agent === a.agent}"><span class="provider-harness-name">${mark(data.agents.find(row => row.agent === a.agent) || { agent: a.agent, name: name(a.agent) }, 32)}<strong>${esc(name(a.agent))}</strong></span><span class="provider-harness-rate"><span class="num">${rate(a.errorRate)}</span><span>${esc(T("col.errorRate"))}</span></span><span class="provider-harness-counts"><span>${int(a.calls)} ${esc(T("providers.requests"))}</span><span>${int(a.failed)} ${esc(T("kpi.failed"))} · ${int(a.cancelled)} ${esc(T("providers.cancelled"))}</span></span></button>`
    }).join("")
    const cells = p.harnesses.map(a => {
      const edge = extremum(a.errorRate, ranges.errorRate, "low")
      const top = a.reasons[0]
      return `<tr><td><button class="provider-agent" aria-controls="providerReasonDetail" data-provider-agent="${esc(a.agent)}" aria-pressed="${agent === a.agent}">${mark(data.agents.find(row => row.agent === a.agent) || { agent: a.agent, name: name(a.agent) }, 24)}<span>${esc(name(a.agent))}</span></button></td>
        <td class="n">${int(a.calls)}</td><td class="n">${int(a.failed)}</td>
        <td class="n ${edge ? `metric-${edge.quality}` : ""}">${pct(a.errorRate)}${edge ? `<span class="extreme-label">${esc(T(`extreme.${edge.quality}`))}</span>` : ""}</td>
        <td class="n">${int(a.cancelled)}</td><td class="reason-cell">${top ? esc(reasonLabel(top)) : "—"}</td></tr>`
    }).join("")
    $("providerTable").innerHTML = `<thead><tr>${["col.agent", "col.calls", "kpi.failed", "col.errorRate", "providers.cancelled", "providers.topReason"].map((k, i) => `<th scope="col"${i > 0 && i < 5 ? ' class="n"' : ""}>${esc(T(k))}</th>`).join("")}</tr></thead><tbody>${cells}</tbody>`
    renderReasons(p)
    if (focusedProvider) restoreProviderFocus(focusedProvider)
    else if (focusedAgent) {
      const replacement = [...$(focusInCoverage ? "providerHarnesses" : "providerTable").querySelectorAll("[data-provider-agent]")].find(b => b.dataset.providerAgent === focusedAgent)
      replacement?.focus({ preventScroll: true })
    } else if (focusedReason) {
      $("providerReasonDetail")?.querySelector("summary")?.focus({ preventScroll: true })
    }
  }
  function restoreProviderFocus(id) {
    if (!id) return
    const replacement = [...$("providerGallery").querySelectorAll("[data-provider]")].find(b => b.dataset.provider === id)
    replacement?.focus({ preventScroll: true })
  }
  function renderReasons(p) {
    if (!p.harnesses.some(a => a.agent === agent)) agent = ""
    const selected = p.harnesses.find(a => a.agent === agent)
    const b = selected || p
    $("providerReasons").innerHTML = `<details id="providerReasonDetail" class="reason-detail"${reasonsOpen ? " open" : ""}>
      <summary><span>${esc(T("providers.reasons"))} <span class="reason-context">· ${esc(selected ? name(agent) : T("providers.allHarnesses"))}</span></span><span class="reason-count num">${int(b.failed)}</span></summary>
      <div class="reason-body">${selected ? `<button id="providerAll" class="pill">${esc(T("providers.allHarnesses"))}</button>` : ""}
      ${b.reasons.length ? `<ul class="reason-list">${b.reasons.map(r => `<li><span>${esc(reasonLabel(r))}</span><b class="num">${int(r.count)} · ${pct(r.count / b.failed)}</b></li>`).join("")}</ul><p class="hint">${esc(T("providers.reasonShare"))}</p>` : `<p class="empty-note">${esc(T("providers.noFailures"))}</p>`}</div></details>`
    $("providerReasonDetail")?.addEventListener("toggle", e => { reasonsOpen = e.target.open })
    $("providerAll")?.addEventListener("click", () => { agent = ""; render() })
  }
  $("providerGallery").addEventListener("click", e => {
    const button = e.target.closest("[data-provider]")
    if (!button) return
    provider = button.dataset.provider
    agent = ""
    reasonsOpen = false
    render()
  })
  $("providerExpand").addEventListener("click", () => { expanded = !expanded; render() })
  $("providerModel").addEventListener("change", e => { agent = ""; reasonsOpen = false; onModelChange(e.target.value) })
  for (const id of ["providerTable", "providerHarnesses"]) $(id).addEventListener("click", e => {
    const button = e.target.closest("[data-provider-agent]")
    if (button) {
      agent = agent === button.dataset.providerAgent ? "" : button.dataset.providerAgent
      reasonsOpen = true
      render()
      for (const b of $(id).querySelectorAll("button")) if (b.dataset.providerAgent === button.dataset.providerAgent) b.focus({ preventScroll: true })
    }
  })
  function share(value) {
    if (value && ($("providerShare").disabled || $("providersBlock").getAttribute("aria-busy") === "true")) return
    sharing = value
    document.body.classList.toggle("share-mode", sharing)
    $("providerShare").setAttribute("aria-pressed", String(sharing))
    $("providerShare").textContent = T(sharing ? "providers.exitShare" : "providers.share")
    if (sharing) window.scrollTo(0, 0)
  }
  $("providerShare").addEventListener("click", () => share(!sharing))
  document.addEventListener("keydown", e => { if (e.key === "Escape" && sharing) share(false) })
  return { paint, isSharing: () => sharing }
}
