import { onRequest } from "../fovea.middleware.js"

// Offline A/B evidence for one request. No prompt content is kept: only
// counts, percentages and prefix lengths are shown. The paste-in form is
// parsed and measured in this frame, never stored or sent anywhere.
const $ = (id) => document.getElementById(id)
const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })

function fmt(n) { return nf.format(Math.round(n)) }
function pct(n) { return `${Math.round(n * 100)}%` }

function paintBar(fill, value, max, output) {
  fill.style.width = `${Math.max(1.5, Math.round((value / (max || 1)) * 100))}%`
  output.textContent = fmt(value)
}

function render(report) {
  const { request: req, consecutive: c, limits } = report
  $("source").textContent = report.source || "synthetic"
  $("before").textContent = fmt(req.before)
  $("after").textContent = fmt(req.after)
  $("saved").textContent = fmt(req.saved)
  $("changed").textContent = `${fmt(req.changed)} / ${fmt(req.messages)} 条消息被裁剪`
  $("ratio").textContent = `缩小到原来的 ${pct(Math.min(1, req.after / req.before))}`
  paintBar(document.querySelector(".fill.raw"), req.before, req.before, $("raw-bar"))
  paintBar($("slim-fill"), req.after, req.before, $("slim-bar"))
  const maxPrefix = Math.max(c.baseline_prefix_share, c.fovea_prefix_share)
  paintBar($("baseline-prefix-fill"), c.baseline_prefix_share * 100, maxPrefix * 100, $("baseline-prefix"))
  paintBar($("fovea-prefix-fill"), c.fovea_prefix_share * 100, maxPrefix * 100, $("fovea-prefix"))
  $("baseline-prefix").textContent = pct(c.baseline_prefix_share)
  $("fovea-prefix").textContent = pct(c.fovea_prefix_share)
  const badge = $("prefix-badge")
  badge.textContent = c.stable_cut_prefix ? `${fmt(c.stable_cut_messages)} 条已裁消息逐字稳定` : "未验证稳定的已裁前缀"
  badge.classList.toggle("bad", !c.stable_cut_prefix)
  if (limits) $("limits").textContent = limits
}

const report = globalThis.FoveaReport
if (report) render(report)

const live = globalThis.FoveaLive
if (live?.samples?.length === 4) {
  $("live-source").textContent = live.same_model ? `${live.model} · ${live.measured_at}` : "模型不一致，结果不可比"
  const warm = [live.samples[3], live.samples[2]] // ABBA: raw2, fovea2
  const labels = ["原始 · 暖缓存", "Fovea · 暖缓存"]
  $("live-summary").replaceChildren(...warm.map((sample, i) => {
    const card = document.createElement("div")
    card.className = "live-card"
    const title = document.createElement("h3")
    title.textContent = labels[i]
    card.append(title)
    for (const [label, value] of [
      ["输入 token", sample.input_tokens],
      ["缓存读取 token", sample.cache_read_tokens],
      ["响应毫秒", sample.elapsed_ms],
    ]) {
      const row = document.createElement("div")
      const key = document.createElement("span")
      key.textContent = label
      const num = document.createElement("strong")
      num.textContent = value == null ? "未提供" : fmt(value)
      row.append(key, num)
      card.append(row)
    }
    return card
  }))
}

function localMeasure(raw, options) {
  const before = JSON.stringify(raw).length
  const list = Array.isArray(raw.messages) ? raw.messages : raw.input
  if (!list) throw new Error("请求里没有 messages 或 input 数组")
  const body = JSON.parse(JSON.stringify(raw))
  onRequest(body, { options })
  const after = JSON.stringify(body).length
  const changed = list.reduce((n, m, i) => n + (JSON.stringify(m) !== JSON.stringify(body.messages?.[i] ?? body.input?.[i]) ? 1 : 0), 0)
  return { before, after, saved: before - after, changed, messages: list.length }
}

$("analyze").addEventListener("click", () => {
  const err = $("error")
  err.textContent = ""
  try {
    const raw = JSON.parse($("input").value)
    const options = {
      threshold: 0,
      keep_recent: Number($("keep").value) || 0,
      cut_step: Math.max(1, Number($("step").value) || 4),
      saccade: $("mode").value,
      tool_head: 80, tool_tail: 40, text_head: 120, text_tail: 60,
    }
    const m = localMeasure(raw, options)
    $("before").textContent = fmt(m.before)
    $("after").textContent = fmt(m.after)
    $("saved").textContent = fmt(m.saved)
    $("changed").textContent = `${fmt(m.changed)} / ${fmt(m.messages)} 条消息被裁剪`
    $("ratio").textContent = `缩小到原来的 ${pct(Math.min(1, m.after / m.before))}`
    $("source").textContent = "本机粘贴的请求（内容不显示）"
    paintBar(document.querySelector(".fill.raw"), m.before, m.before, $("raw-bar"))
    paintBar($("slim-fill"), m.after, m.before, $("slim-bar"))
  } catch (e) {
    err.textContent = `无法解析：${e.message}`
  }
})

$("clear").addEventListener("click", () => { $("input").value = ""; $("error").textContent = "" })
