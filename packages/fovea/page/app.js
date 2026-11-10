// Offline A/B evidence for one request. No prompt content is kept: only
// counts, percentages and prefix lengths are shown. The paste-in form is
// parsed and measured in this frame, never stored or sent anywhere.
//
// The report cards render from report.js/live.js data alone. The paste-in
// A/B needs the middleware itself, which loads on demand and degrades to
// a friendly note when the page is opened where plugin files beyond the
// page folder are not served (e.g. straight from the filesystem).
(async () => {
  const $ = (id) => document.getElementById(id)
  const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
  const fmt = (n) => nf.format(Math.round(n))
  const pct = (n) => `${Math.round(n * 100)}%`

  // Follow magpie's window theme (its own setting, which may differ from
  // the OS). Outside magpie there is no bridge and the CSS falls back to
  // prefers-color-scheme.
  const applyTheme = (t) => { if (t) document.documentElement.dataset.theme = t.dark ? "dark" : "light" }
  if (globalThis.magpie) {
    magpie.onTheme?.(applyTheme)
    magpie.ready?.then(applyTheme, () => {})
  }

  function paintBar(fill, value, max, output) {
    fill.style.width = `${Math.max(1.5, Math.round((value / (max || 1)) * 100))}%`
    output.textContent = fmt(value)
  }

  function paintSummary(m) {
    $("before").textContent = fmt(m.before)
    $("after").textContent = fmt(m.after)
    $("saved").textContent = fmt(m.saved)
    $("changed").textContent = `${fmt(m.changed)} / ${fmt(m.messages)} 条消息被裁`
    $("ratio").textContent = `缩小到 ${pct(Math.min(1, m.after / m.before))}`
    $("strip-note").textContent = `${fmt(m.messages)} 条消息 · ${fmt(m.messages - m.changed)} 条原样保留`
    paintBar(document.querySelector(".fill.raw"), m.before, m.before, $("raw-bar"))
    paintBar($("slim-fill"), m.after, m.before, $("slim-bar"))
  }

  const report = globalThis.FoveaReport
  if (report) {
    $("source").textContent = ({ synthetic: "示例数据", measured: "实测数据" })[report.source] || report.source || "示例数据"
    paintSummary(report.request)
    const c = report.consecutive
    const maxPrefix = Math.max(c.baseline_prefix_share, c.fovea_prefix_share)
    paintBar($("baseline-prefix-fill"), c.baseline_prefix_share * 100, maxPrefix * 100, $("baseline-prefix"))
    paintBar($("fovea-prefix-fill"), c.fovea_prefix_share * 100, maxPrefix * 100, $("fovea-prefix"))
    $("baseline-prefix").textContent = pct(c.baseline_prefix_share)
    $("fovea-prefix").textContent = pct(c.fovea_prefix_share)
    const badge = $("prefix-badge")
    badge.textContent = c.stable_cut_prefix ? `${fmt(c.stable_cut_messages)} 条已裁消息逐字稳定` : "未验证稳定的已裁前缀"
    badge.classList.toggle("bad", !c.stable_cut_prefix)
    if (report.limits) $("limits").textContent = report.limits
  }

  const live = globalThis.FoveaLive
  if (live?.samples?.length === 4) {
    $("live-source").textContent = live.same_model ? `${live.model} · ${live.measured_at}` : "两次调用不是同一个模型，结果不可比"
    const warm = [live.samples[3], live.samples[2]] // ABBA: raw2, fovea2
    const labels = ["原始 · 暖缓存", "fovea · 暖缓存"]
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

  $("clear").addEventListener("click", () => { $("input").value = ""; $("error").textContent = "" })

  let onRequest = globalThis.FoveaOnRequest
  if (!onRequest) {
    try { ({ onRequest } = await import("../fovea.middleware.js")) } catch { /* page folder only, as in magpie's sandbox */ }
  }
  try {
    if (!onRequest) throw new Error("no middleware")
    const measure = (raw, options) => {
      const list = Array.isArray(raw.messages) ? raw.messages : raw.input
      if (!list) throw new Error("shape")
      const before = JSON.stringify(raw).length
      const body = JSON.parse(JSON.stringify(raw))
      onRequest(body, { options })
      const after = JSON.stringify(body).length
      const out = Array.isArray(body.messages) ? body.messages : body.input
      const changed = list.reduce((n, m, i) => n + (JSON.stringify(m) !== JSON.stringify(out[i]) ? 1 : 0), 0)
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
        paintSummary(measure(raw, options))
        $("source").textContent = "本机粘贴的请求（内容不显示）"
      } catch (e) {
        err.textContent = e.message === "shape"
          ? "没找到消息列表：请粘贴包含 messages 或 input 的整段请求。"
          : "这段内容读不出来：请粘贴完整的请求 JSON（从 { 到 } 整段复制）。"
      }
    })
  } catch {
    const note = document.createElement("p")
    note.className = "cap"
    note.textContent = "当前环境加载不了裁剪逻辑，粘贴复验暂不可用；上方的对照数字不受影响。"
    $("try-title")?.closest("section")?.append(note)
    $("analyze").disabled = true
    $("analyze").textContent = "此环境不可用"
  }
})()
