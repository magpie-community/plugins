// Agent Lens — the interface. Served by the plugin's own service, so the
// data is a same-origin fetch away.

const $ = (id) => document.getElementById(id)
const qs = new URLSearchParams(location.search)
// sandboxed in magpie's frame the origin is opaque and storage throws
const store = {
  get(k) { try { return localStorage.getItem(k) } catch { return null } },
  set(k, v) { try { localStorage.setItem(k, v) } catch {} },
}

const state = {
  period: store.get("al.period") || "7d",
  clients: store.get("al.clients") === "1",
  sort: { key: "prompt", dir: -1 },
  data: null,
  openAgent: null,
}

// the service writes a per-start token into this page's HTML
const TOKEN = document.querySelector('meta[name="agent-lens-token"]')?.content || ""
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
const int = (n) => (n == null ? "—" : Math.round(n).toLocaleString("en-US"))
const pct = (x) => (x == null || !Number.isFinite(x) ? "—" : `${(x * 100).toFixed(1)}%`)
function secs(ms) {
  if (!ms) return "—"
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}
function when(t) {
  if (!t) return "—"
  return new Date(t).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
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
  if (!d.agents.length) {
    for (const id of ["insights", "kpis", "cards", "tools"]) $(id).innerHTML = ""
    $("table").innerHTML = ""
    showState("这段时间网关没有记录到 Agent 的请求。用任意 Agent 走一次网关，再回来刷新。")
    return
  }
  paintStatus(d)
  paintInsights(d)
  paintKpis(d)
  paintCards(d)
  paintTable(d)
  paintTools(d)
  const s = d.sources || {}
  $("sources").textContent = `用量记录 ${int(s.usageRows)} 条 · 工具采样 ${int(s.toolRows)} 条 · 更新于 ${new Date(d.generatedAt).toLocaleTimeString("zh-CN")}`
  if (state.openAgent) openDetail(state.openAgent, false)
}

function ago(t) {
  if (!t) return "还没有"
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return `${Math.round(s)} 秒前`
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`
  return `${Math.round(s / 86400)} 天前`
}
function paintStatus(d) {
  const fresh = d.lastTool && Date.now() - d.lastTool < 15 * 60e3
  const el = $("status")
  el.className = "status " + (fresh ? "live" : d.lastTool ? "idle" : "wait")
  el.textContent = fresh ? `采集中 · 最近一次请求 ${ago(d.lastUsage)} · 工具采样 ${ago(d.lastTool)}`
    : d.lastTool ? `15 分钟内没有新采样 · 上次 ${ago(d.lastTool)}（用一下 Agent 就会恢复）`
    : "hook 已装好，等第一条请求经过网关"
}

function paintInsights(d) {
  $("insights").innerHTML = d.insights
    .map((i) => `<div class="insight${i.kind === "volume" || i.kind === "errors" ? " hot" : ""}">${esc(i.text)}</div>`)
    .join("")
}

function paintKpis(d) {
  const t = d.totals
  const items = [
    ["输入 token", short(t.prompt), `${int(t.calls)} 次请求`],
    ["缓存命中", pct(t.cacheRate), `按原价算的 ${short(t.fullPrice)}`],
    ["输出 token", short(t.out), `平均 ${short(t.calls ? t.out / t.calls : 0)}/次`],
    ["失败", int(t.failed), pct(t.calls ? t.failed / t.calls : 0)],
    ["Agent", int(d.agents.length), d.hiddenClients ? `另有 ${int(d.hiddenClients)} 次脚本/内部请求未计` : "网关后面的客户端"],
  ]
  if (t.credits > 0) items.splice(4, 0, ["credits", t.credits.toFixed(2), "magpie 记账的按量额度"])
  $("kpis").innerHTML = items
    .map(([k, v, s]) => `<div class="kpi"><div class="k">${k}</div><div class="v num">${v}</div><div class="s">${esc(s)}</div></div>`)
    .join("")
}

function paintCards(d) {
  const max = Math.max(...d.agents.map((a) => a.prompt), 1)
  $("cards").innerHTML = d.agents
    .map((a, i) => {
      const w = (a.prompt / max) * 100
      const fullW = a.prompt ? (a.fullPrice / a.prompt) * w : 0
      const top1 = i === 0 && d.agents.length > 1
      return `<div class="card${top1 ? " top1" : ""}" tabindex="0" role="button" data-agent="${esc(a.agent)}" aria-label="${label(a)} 详情">
        <div class="card-head"><span class="card-name">${mark(a, 22)}${label(a)}</span>${top1 ? '<span class="tag">花得最多</span>' : ""}</div>
        <div class="card-big num">${short(a.prompt)}<small>输入 token</small></div>
        <div class="stack" title="浅色：缓存读取；深色：按原价"><span class="cached" style="width:${(w - fullW).toFixed(2)}%"></span><span class="full" style="width:${fullW.toFixed(2)}%"></span></div>
        <div class="card-meta">
          <div><b class="num">${pct(a.cacheRate)}</b>缓存命中</div>
          <div><b class="num">${short(a.avgPrompt)}</b>每次读</div>
          <div><b class="num ${a.errorRate >= 0.03 ? "bad" : ""}">${pct(a.errorRate)}</b>失败率</div>
        </div>
        ${spark(a.series, "prompt")}
      </div>`
    })
    .join("")
}

const COLS = [
  ["agent", "Agent", false],
  ["calls", "请求", true],
  ["prompt", "输入 token", true],
  ["avgPrompt", "每次读", true],
  ["cacheRate", "缓存命中", true],
  ["fullPrice", "按原价", true],
  ["out", "输出", true],
  ["errorRate", "失败率", true],
  ["p50ttft", "首字 p50", true],
  ["p50ms", "耗时 p50", true],
  ["toolTokens", "工具 token/次", true],
]
const val = (a, k) => (k === "toolTokens" ? a.tools?.avgTokens ?? -1 : k === "agent" ? a.name || a.agent : a[k])

function paintTable(d) {
  const { key, dir } = state.sort
  const rows = [...d.agents].sort((x, y) => {
    const a = val(x, key), b = val(y, key)
    return typeof a === "string" ? a.localeCompare(b) * dir : ((a ?? 0) - (b ?? 0)) * dir
  })
  const topAgent = d.agents[0]?.agent
  const head = COLS.map(([k, label, n]) => `<th class="${n ? "n" : ""}" data-key="${k}" ${k === key ? `aria-sort="${dir < 0 ? "descending" : "ascending"}"` : ""} tabindex="0">${label}</th>`).join("")
  const body = rows
    .map((a) => `<tr tabindex="0" data-agent="${esc(a.agent)}">
      <td class="agent"><span class="who">${mark(a, 18)}${label(a)}${a.agent === topAgent && d.agents.length > 1 ? '<span class="dot hot" title="花得最多"></span>' : ""}</span></td>
      <td class="n">${int(a.calls)}</td>
      <td class="n">${short(a.prompt)}</td>
      <td class="n">${short(a.avgPrompt)}</td>
      <td class="n">${pct(a.cacheRate)}</td>
      <td class="n">${short(a.fullPrice)}</td>
      <td class="n">${short(a.out)}</td>
      <td class="n ${a.errorRate >= 0.03 ? "bad" : ""}">${pct(a.errorRate)}</td>
      <td class="n">${secs(a.p50ttft)}</td>
      <td class="n">${secs(a.p50ms)}</td>
      <td class="n">${a.tools ? short(a.tools.avgTokens) : "—"}</td>
    </tr>`)
    .join("")
  $("table").innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`
}

function paintTools(d) {
  const withTools = d.agents.filter((a) => a.tools)
  if (!withTools.length) {
    $("toolsHint").textContent = "Agent 每次请求都会把自己的工具清单重发一遍，这部分也按 token 计费。"
    $("tools").innerHTML = `<div class="waiting">还没有采样。网关 hook 会从下一次请求开始记录每个 Agent 带了哪些工具、有多大（只记名字和大小，不记内容）。用一会儿 Agent 后刷新即可。</div>`
    return
  }
  const sorted = [...withTools].sort((a, b) => b.tools.avgBytes - a.tools.avgBytes)
  const max = sorted[0].tools.avgBytes || 1
  $("toolsHint").textContent = `从 ${when(d.toolsSince)} 开始采样，共 ${int(d.toolSamples)} 次请求。token 数按每 token 约 3.5 字节估算，各 Agent 口径一致。`
  $("tools").innerHTML = `<div class="table-wrap" style="padding:4px 16px">${sorted
    .map((a, i) => `<div class="tool-row">
      <div class="agent who">${mark(a, 18)}<b>${label(a)}</b></div>
      <div class="tool-track"><div class="tool-fill${i === 0 && sorted.length > 1 ? " hot" : ""}" style="width:${((a.tools.avgBytes / max) * 100).toFixed(1)}%"></div></div>
      <div class="tool-val num">${Math.round(a.tools.avgCount)} 个 · ≈${short(a.tools.avgTokens)} token${a.tools.shareOfPrompt != null ? ` · 占 ${pct(a.tools.shareOfPrompt)}` : ""}</div>
    </div>`)
    .join("")}</div>`
}

// ---------- detail drawer ----------
function openDetail(agent, focus = true) {
  const a = state.data?.agents.find((x) => x.agent === agent)
  if (!a) return closeDetail()
  state.openAgent = agent
  const models = a.models.map((m) => `<span class="chip">${esc(m.name)} · ${int(m.count)}</span>`).join("")
  const protos = a.protocols.map((p) => `<span class="chip">${esc(p.name)} · ${int(p.count)}</span>`).join("")
  const tools = a.tools ? a.tools.names.map((t) => `<span class="chip mono">${esc(t.name)}</span>`).join("") : ""
  $("detail").innerHTML = `<div class="detail">
    <h3 class="who">${mark(a, 28)}${label(a)}</h3>
    ${a.name && a.name !== a.agent ? `<p class="hint">网关里的标识：<code>${esc(a.agent)}</code></p>` : ""}
    <p class="hint">${when(a.first)} — ${when(a.last)}</p>
    <div class="sec"><h4>每天读进模型的 token</h4>${spark(a.series, "prompt", "big") || '<p class="hint">不到两天的数据，画不出趋势。</p>'}</div>
    <div class="sec"><h4>用量</h4><div class="dl">
      <div><b class="num">${int(a.calls)}</b>请求</div>
      <div><b class="num">${short(a.prompt)}</b>输入 token</div>
      <div><b class="num">${short(a.cacheRead)}</b>缓存读取</div>
      <div><b class="num">${short(a.cacheWrite)}</b>缓存写入</div>
      <div><b class="num">${short(a.in)}</b>未缓存输入</div>
      <div><b class="num">${short(a.out)}</b>输出 token</div>
      <div><b class="num">${pct(a.cacheRate)}</b>缓存命中</div>
      <div><b class="num">${int(a.failed)} / ${int(a.cancelled)}</b>失败 / 主动取消</div>
      <div><b class="num">${secs(a.p50ttft)}</b>首字 p50</div>
      <div><b class="num">${secs(a.p50ms)}</b>耗时 p50</div>
      ${a.credits > 0 ? `<div><b class="num">${a.credits.toFixed(2)}</b>credits</div>` : ""}
    </div></div>
    <div class="sec"><h4>用过的模型</h4><div class="chips">${models || "—"}</div></div>
    <div class="sec"><h4>协议</h4><div class="chips">${protos || "—"}</div></div>
    <div class="sec"><h4>工具定义</h4>${a.tools
      ? `<p class="hint">平均每次带 ${Math.round(a.tools.avgCount)} 个，约 ${short(a.tools.avgTokens)} token（${int(a.tools.samples)} 次采样）</p><div class="chips">${tools}</div>`
      : '<p class="hint">还没有采样。</p>'}</div>
  </div>`
  const dr = $("drawer")
  dr.classList.add("open")
  dr.setAttribute("aria-hidden", "false")
  $("scrim").hidden = false
  if (focus) dr.focus()
}
function closeDetail() {
  state.openAgent = null
  $("drawer").classList.remove("open")
  $("drawer").setAttribute("aria-hidden", "true")
  $("scrim").hidden = true
}

// ---------- loading ----------
function showState(text, err = false) {
  $("state").hidden = false
  $("state").className = err ? "state err" : "state"
  $("state").textContent = text
}

async function load() {
  if (!state.data) $("cards").innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>'
  try {
    const p = new URLSearchParams({ period: state.period, tz: String(new Date().getTimezoneOffset()) })
    if (state.clients) p.set("clients", "1")
    p.set("k", TOKEN)
    const res = await fetch(`/api/summary?${p}`, { cache: "no-store" })
    if (res.status === 403 && !sessionStorageSafe("al.reloaded")) { markReloaded(); return location.reload() }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    state.data = await res.json()
    paint()
  } catch (e) {
    showState(`读不到数据：${e.message}。确认 magpie 网关在运行，再刷新。`, true)
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
$("cards").addEventListener("click", (e) => { const a = pick(e); if (a) openDetail(a) })
$("table").addEventListener("click", (e) => {
  const th = e.target.closest("th[data-key]")
  if (th) {
    const k = th.dataset.key
    state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : k === "agent" ? 1 : -1 }
    return paintTable(state.data)
  }
  const a = pick(e)
  if (a) openDetail(a)
})
for (const id of ["cards", "table"]) {
  $(id).addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return
    const th = e.target.closest("th[data-key]")
    if (th) { e.preventDefault(); return th.click() }
    const a = pick(e)
    if (a) { e.preventDefault(); openDetail(a) }
  })
}
$("close").addEventListener("click", closeDetail)
$("scrim").addEventListener("click", closeDetail)
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.openAgent) closeDetail() })

selectPeriod()
await load()
setInterval(load, 60_000)
