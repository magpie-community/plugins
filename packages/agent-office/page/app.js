// The page: loads live.js (what the plugin's host part wrote) again every
// second, works out each agent's status (model.js), and draws the office
// (scene.js) or the grouped workbench. It reads nothing of magpie's but its
// own options, and has no network: live.js is one of its own files.
//
// Interaction, kept calm on purpose: nothing opens because the pointer
// passes over it. Hovering only highlights. A click on a worker, its name
// tag, a list row or a side-rail row opens that agent's panel at the side,
// which stays put until it's closed or another agent is clicked. The DOM is
// updated in place: nothing is rebuilt each second unless it really changed.
(async () => {
  const M = globalThis.AgentOfficeModel
  const I = globalThis.AgentOfficeIcons
  const { Scene } = globalThis.AgentOfficeScene
  const Scene3D = globalThis.AgentOfficeScene3D
  const $ = (id) => document.getElementById(id)
  const el = (tag, cls, text) => {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (text != null) e.textContent = text
    return e
  }
  const theme = await magpie.ready
  let themeLang = theme.lang
  let opts = {}
  try { opts = (await magpie.options.get()) || {} } catch {}
  const view = {
    mode: opts.mode === "list" ? "list" : "office",
    dim: ["2d", "iso", "3d"].includes(opts.dim) ? opts.dim : "3d",
    scene: ["office", "station", "cafe", "castle", "pirate", "graveyard"].includes(opts.scene) ? opts.scene : "office",
    quality: ["low", "medium", "high"].includes(opts.quality) ? opts.quality : "medium",
    demo: opts.demo === true,
    showDone: opts.showDone !== false,
    hideAfter: M.HIDE[opts.hideAfter] !== undefined ? opts.hideAfter : M.DEFAULTS.hideAfter,
    text: opts.text !== false,
    approvalAfterSec: Number(opts.approvalAfterSec) > 0 ? Number(opts.approvalAfterSec) : M.DEFAULTS.approvalAfterSec,
    showSub: opts.showSub !== false,
    showIdle: opts.showIdle !== false,
    agents: Array.isArray(opts.agents) ? opts.agents.filter((x) => typeof x === "string") : [],
    side: opts.side !== false,
    cleared: opts.cleared && typeof opts.cleared === "object" && !Array.isArray(opts.cleared) ? { ...opts.cleared } : {},
  }
  let manualLang = opts.lang === "auto" || M.LANG_NAMES[opts.lang] ? opts.lang : "auto"
  const state = {
    snap: null, loaded: false, all: [], list: [], open: "", hover: "", showText: true,
    alerts: new Map(), alertsSeeded: false, scene3Failed: false,
  }
  let floatHome = null
  const t = () => M.text(lang)
  const navLangs = () => (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language])
  // manual pick → the newest prompt's script → magpie's theme → the browser
  function pickLang(sample) {
    return M.detectLang({ manual: manualLang, theme: themeLang, nav: navLangs(), sample: sample || M.sample(state.snap) })
  }
  let lang = pickLang()

  // a status as a person reads it: the sub-state says more than the six
  function label(a) {
    const w = t()
    if (a.sub === "approval") return w.approval
    if (a.sub === "ask") return w.ask
    if (a.sub === "stopped") return w.stopped
    if (a.sub === "noprog") return w.noProgress
    if (a.sub === "stuck") return M.fill(w.stuck, M.duration(Date.now() - a.at, lang))
    // a finished session nobody has touched for a while is idling
    if (a.idle && a.status === "done") return w.idle
    return w[a.status]
  }

  // ---- words -----------------------------------------------------------
  let lastLegend = ""
  let langSelectSig = ""
  function words() {
    document.querySelectorAll("[data-t]").forEach((e) => { e.textContent = t()[e.dataset.t] })
    $("pip").textContent = floatHome ? t().pipOn : t().pip
    document.documentElement.lang = lang || "en"
    statusLegend()
    lastLegend = ""
    railSig = ""
    todaySig = ""
    langSelectSig = ""
    syncLangSelect()
  }

  function statusLegend() {
    $("statusLegend").replaceChildren(...M.STATUSES.map((s) => {
      const e = el("span", "lg")
      const dot = el("i")
      dot.style.background = M.COLORS[s]
      e.append(dot, document.createTextNode(t()[s]))
      return e
    }))
  }

  // the agents in the office now, each once, by its own icon
  function brandLegend() {
    const ids = []
    for (const a of state.list) if (!ids.includes(a.agent)) ids.push(a.agent)
    const sig = ids.join(",")
    if (sig === lastLegend) return
    lastLegend = sig
    $("brandLegend").replaceChildren(...ids.map((id) => {
      const b = M.brand(id)
      const e = el("span", "lg")
      e.append(I.mark(b, 18), document.createTextNode(b.name))
      return e
    }))
  }

  // ---- reading live.js ---------------------------------------------------
  let loading = false
  function load() {
    if (loading) return
    loading = true
    const s = document.createElement("script")
    s.src = "live.js?t=" + Date.now()
    const done = () => { loading = false; s.remove() }
    s.onload = () => {
      const snap = globalThis.AgentOfficeLive || null
      const changed = snap?.written !== state.snap?.written
      state.snap = snap
      state.loaded = true
      done()
      if (changed) refresh()
    }
    s.onerror = () => { const first = !state.loaded; state.loaded = true; done(); if (first) refresh() }
    document.head.append(s)
  }

  function snapshot(now) {
    if (!view.demo) return state.snap
    state.demoSnap ??= M.demo(now)
    return M.merge(state.snap, state.demoSnap)
  }

  // ---- the office ------------------------------------------------------
  // two renderers share the stage: the canvas isometric/2D one and a real
  // WebGL one. They cannot share a canvas context, so each has its own and
  // only the selected one is visible and running.
  const office2 = $("office"), office3 = $("office3d")
  const scene2 = new Scene(office2, { dim: view.dim === "2d" ? "2d" : "3d", onFrame: place })
  let scene3 = null
  let scene = scene2

  function wants3D() { return view.mode === "office" && view.dim === "3d" && !!Scene3D && !state.scene3Failed }
  function ensure3D() {
    if (!wants3D()) return null
    if (!scene3) {
      try {
        scene3 = new Scene3D(office3, { scene: view.scene, quality: view.quality, agents: state.list, onFrame: place })
        if (!scene3.available) { try { scene3.dispose() } catch {} ; scene3 = null; state.scene3Failed = true }
      } catch { scene3 = null; state.scene3Failed = true }
    }
    if (scene3 && scene3.id !== view.scene) scene3.setScene(view.scene)
    return scene3
  }
  function activateScene() {
    const s3 = ensure3D()
    if (s3) {
      if (scene !== s3) { try { scene2.stop() } catch {} ; scene = s3 }
      office2.hidden = true; office3.hidden = false
      return s3
    }
    if (scene3) scene3.stop()
    scene = scene2
    office2.hidden = false; office3.hidden = true
    scene2.setDim(view.dim === "2d" ? "2d" : "3d")
    return scene2
  }
  const tags = new Map()

  function tagFor(a) {
    let e = tags.get(a.key)
    if (!e) {
      e = el("button", "tag")
      e.type = "button"
      e.dataset.key = a.key
      e.addEventListener("click", (ev) => { ev.stopPropagation(); open(a.key) })
      e.addEventListener("mouseenter", () => highlight(a.key))
      e.addEventListener("mouseleave", () => highlight(""))
      $("tags").append(e)
      tags.set(a.key, e)
    }
    const sig = [a.brand.icon, a.brand.name, a.title, a.status, a.sub].join("|")
    if (e.dataset.sig !== sig) {
      e.dataset.sig = sig
      const name = el("span", "tn", a.title)
      const dot = el("i", "td")
      dot.style.background = M.COLORS[a.status]
      e.replaceChildren(I.mark(a.brand, 15), name, dot)
      e.dataset.status = a.status
      e._w = 0 // measured again on the next frame
    }
    e.title = `${a.brand.name} · ${label(a)}`
    return e
  }

  // each frame: the tags follow their workers; nothing else moves with them
  function place(anchors) {
    const seen = new Set()
    // in the small window only the ones that need you keep a name tag
    const few = floatHome ? new Set(state.list.filter((a) => a.status === "waiting" || a.status === "error" || a.key === state.open).map((a) => a.key)) : null
    const shown = []
    for (const p of anchors) {
      const e = tags.get(p.key)
      if (!e || p.visible === false) continue
      if (!e._w) e._w = e.offsetWidth || 90
      shown.push({ e, p })
    }
    // two tags that would sit on each other are stacked, the lower one first
    shown.sort((a, b) => a.p.y - b.p.y || a.p.x - b.p.x)
    const placed = []
    const H = 24
    for (const it of shown) {
      let y = it.p.y
      for (let pass = 0; pass < 6; pass++) {
        const hit = placed.find((q) => Math.abs(q.x - it.p.x) < (q.w + it.e._w) / 2 + 4 && Math.abs(q.y - y) < H)
        if (!hit) break
        y = hit.y - H
      }
      it.y = y
      placed.push({ x: it.p.x, y, w: it.e._w })
    }
    for (const it of shown) {
      seen.add(it.p.key)
      const tf = `translate(${Math.round(it.p.x)}px, ${Math.round(it.p.y)}px) translate(-50%, -100%)`
      if (it.e.style.transform !== tf) it.e.style.transform = tf
    }
    for (const [k, e] of tags) {
      const hide = !seen.has(k) || (few ? !few.has(k) : false)
      if (e.hidden !== hide) e.hidden = hide
    }
  }

  // the pointer over a worker or its tag only highlights it
  function highlight(key) {
    if (state.hover === key) return
    state.hover = key
    scene.highlight = key
    for (const [k, e] of tags) e.classList.toggle("hot", k === key)
  }

  function bindCanvas(canvas) {
    let moveQueued = false
    canvas.addEventListener("pointermove", (e) => {
      if (moveQueued) return
      moveQueued = true
      const x = e.offsetX, y = e.offsetY
      requestAnimationFrame(() => {
        moveQueued = false
        const k = scene.hit(x, y)
        canvas.style.cursor = k ? "pointer" : (canvas === office3 ? "grab" : "")
        highlight(k)
      })
    })
    canvas.addEventListener("pointerleave", () => highlight(""))
    canvas.addEventListener("click", (e) => {
      if (scene === scene3 && scene3.dragged) { scene3.dragged = false; return }
      const k = scene.hit(e.offsetX, e.offsetY)
      if (k) open(k)
      else close()
    })
  }
  bindCanvas(office2)
  bindCanvas(office3)

  // ---- context bars ------------------------------------------------------
  // 60% is worth noticing, 85% is nearly full; both use the same bar.
  function ctxBar(c, name) {
    const e = el("div", "ctx" + (c.level === "warn" || c.level === "full" ? " " + c.level : ""))
    const bar = el("span", "bar")
    const fill = el("i")
    fill.style.width = c.pct + "%"
    bar.append(fill)
    e.append(el("span", "cn", name), bar, el("span", "cp", c.pct + "%"))
    e.title = `${name} ${M.fmtTokens(c.used)} / ${M.fmtTokens(c.window)}`
    return e
  }

  // ---- the panel ---------------------------------------------------------
  // one agent, opened by a click, at the side; it doesn't move with the
  // scene and is updated in place each second
  const panel = $("pop")
  const P = {}
  ;(() => {
    const head = el("div", "ph")
    P.mark = el("span", "pmk")
    P.agent = el("span", "pa")
    P.when = el("span", "pw")
    P.close = el("button", "px", "✕")
    P.close.type = "button"
    P.close.setAttribute("aria-label", "Close")
    P.close.addEventListener("click", close)
    head.append(P.mark, P.agent, P.when, P.close)
    P.title = el("div", "pt")
    P.status = el("div", "ps")
    P.stIcon = el("span", "pi")
    P.stText = el("span", "pst")
    P.stMore = el("span", "pn")
    P.status.append(P.stIcon, P.stText, P.stMore)
    P.query = el("div", "pq")
    P.step = el("div", "pstep")
    P.err = el("div", "perr")
    P.reply = el("div", "pr")
    P.ctx = el("div", "pctx")
    P.convoHead = el("div", "pconvo-h")
    P.msgs = el("div", "pmsgs")
    const foot = el("div", "pf")
    P.meta = el("span", "pm")
    P.copy = el("button", "pc")
    P.copy.type = "button"
    P.copy.addEventListener("click", (e) => { e.stopPropagation(); showCommand(P.copy.dataset.value, P.copy) })
    P.clear = el("button", "pc")
    P.clear.type = "button"
    P.clear.addEventListener("click", (e) => { e.stopPropagation(); clearAgent(P.clear.dataset.key) })
    foot.append(P.meta, P.copy, P.clear)
    P.src = el("div", "psrc")
    panel.replaceChildren(head, P.title, P.status, P.query, P.step, P.err, P.reply, P.ctx, P.convoHead, P.msgs, foot, P.src)
  })()
  panel.addEventListener("click", (e) => e.stopPropagation())

  const clock = (at) => {
    const d = new Date(Number(at))
    if (Number.isNaN(d.getTime())) return ""
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  }
  let msgSig = ""
  function renderMessages(msgs) {
    const sig = JSON.stringify(msgs)
    if (sig === msgSig) return
    msgSig = sig
    P.msgs.replaceChildren(...msgs.map((m) => {
      const role = m?.role === "assistant" ? "assistant" : m?.role === "tool" ? "tool" : "user"
      const row = el("div", "msg " + role)
      if (role !== "tool") row.append(el("span", "mn", m?.name || (role === "assistant" ? t().agent : role === "user" ? "you" : "")))
      row.append(document.createTextNode(String(m?.text || "")))
      if (m?.at) row.append(el("span", "mt", clock(m.at)))
      return row
    }))
  }

  const ICON = { done: "✓", error: "!", waiting: "?", thinking: "…", executing: "⟳", replying: "✎" }
  function fillPanel(a) {
    const w = t()
    const setText = (node, s) => { if (node.textContent !== s) node.textContent = s }
    if (P.mark.dataset.icon !== a.brand.icon + a.brand.name) {
      P.mark.dataset.icon = a.brand.icon + a.brand.name
      P.mark.replaceChildren(I.mark(a.brand, 18))
    }
    setText(P.agent, a.brand.name)
    setText(P.when, M.ago(Date.now() - a.at, lang))
    setText(P.title, a.title)
    P.status.className = "ps " + a.status
    setText(P.stIcon, ICON[a.status] || "")
    setText(P.stText, label(a))
    const more = a.sub === "noprog" || a.sub === "stuck" ? M.duration(Date.now() - a.at, lang)
      : a.status === "executing" && a.since > 3000 ? M.fill(w.ran, M.duration(a.since, lang))
        : a.turns ? M.fill(w.turns, a.turns) : ""
    setText(P.stMore, more)
    const q = a.query || (state.showText ? "" : w.quiet)
    setText(P.query, q); P.query.hidden = !q
    setText(P.step, a.step ? "› " + a.step : ""); P.step.hidden = !a.step
    setText(P.err, a.error); P.err.hidden = !a.error
    setText(P.reply, a.reply ? "← " + a.reply : ""); P.reply.hidden = !a.reply
    // context fullness, when the agent's files carry usage
    P.ctx.hidden = !a.ctx
    if (a.ctx) P.ctx.replaceChildren(ctxBar(a.ctx, w.context))
    // the conversation: only when text is on and the session has messages
    const msgs = state.showText && !a.private && Array.isArray(a.messages) ? a.messages.slice(-8) : []
    P.convoHead.hidden = P.msgs.hidden = !msgs.length
    if (msgs.length) {
      setText(P.convoHead, w.recent)
      renderMessages(msgs)
    }
    setText(P.meta, [a.model, a.project].filter(Boolean).join(" · "))
    const copy = a.resume || a.session
    P.copy.hidden = !copy
    const box = P.copy.nextElementSibling
    if (box?.classList.contains("pcopy")) box.remove()
    if (copy && P.copy.dataset.value !== copy) {
      P.copy.dataset.value = copy
      P.copy.dataset.label = a.resume ? w.copyResume : w.copySession
      P.copy.textContent = P.copy.dataset.label
    }
    P.clear.hidden = !M.clearable(a.status)
    P.clear.dataset.key = a.key
    setText(P.clear, w.clear)
    P.clear.title = w.clearTip
    setText(P.src, a.source === "files" ? w.fromFiles : w.via)
  }

  // out of the office until its session moves again; kept in options, only
  // for sessions live.js still has
  function clearAgent(key) {
    const a = state.list.find((x) => x.key === key)
    if (!a || !M.clearable(a.status)) return
    const now = Date.now()
    const known = new Set((snapshot(now)?.sessions || []).map((s) => s?.key))
    const next = {}
    for (const [k, at] of Object.entries(view.cleared)) if (known.has(k)) next[k] = at
    next[key] = a.at
    view.cleared = next
    close()
    refresh()
    save()
  }

  function open(key) {
    if (state.open === key) return close()
    const a = state.list.find((x) => x.key === key)
    if (!a) return
    state.open = key
    scene.selected = key
    scene.setSelected?.(key)
    msgSig = ""
    fillPanel(a)
    panel.hidden = false
    $("rail").hidden = true
    for (const [k, e] of tags) e.classList.toggle("on", k === key)
    for (const tr of $("rows").children) tr.classList.toggle("on", tr.dataset.key === key)
    for (const b of $("railGroups").querySelectorAll(".rail-row")) b.classList.toggle("on", b.dataset.key === key)
  }
  function close() {
    if (!state.open) return
    state.open = ""
    scene.selected = ""
    scene.setSelected?.(null)
    panel.hidden = true
    renderRail()
    for (const e of tags.values()) e.classList.remove("on")
    for (const tr of $("rows").children) tr.classList.remove("on")
    for (const b of $("railGroups").querySelectorAll(".rail-row")) b.classList.remove("on")
  }

  // magpie frames a page with allow="", so a page cannot reach the
  // clipboard. Show the command selected instead: ⌘C / Ctrl+C copies it
  // without a step that can only fail.
  function showCommand(s, btn) {
    const box = el("input", "pcopy")
    box.readOnly = true
    box.value = s
    box.setAttribute("aria-label", btn.dataset.label || "")
    btn.hidden = true
    btn.after(box)
    box.focus()
    box.select()
  }

  // ---- the list --------------------------------------------------------
  // rows kept by key and updated in place, so nothing jumps under the pointer
  const rowsByKey = new Map()
  const groupRows = new Map()
  function rowFor(a) {
    let r = rowsByKey.get(a.key)
    if (!r) {
      const tr = el("tr")
      tr.dataset.key = a.key
      tr.tabIndex = 0
      const c = () => { const td = el("td"); tr.append(td); return td }
      r = { tr, ag: c(), task: c(), st: c(), dir: c(), model: c(), when: c() }
      r.ag.className = "ag"; r.task.className = "task"; r.dir.className = "mono"; r.model.className = "mono"; r.when.className = "muted"
      r.mark = el("span"); r.name = el("span"); r.ag.append(r.mark, r.name)
      r.title = el("div", "lt"); r.sub = el("div", "ls"); r.task.append(r.title, r.sub)
      r.badge = el("span", "badge"); r.st.append(r.badge)
      tr.addEventListener("click", () => open(a.key))
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter") open(a.key) })
      rowsByKey.set(a.key, r)
    }
    const set = (n, s) => { if (n.textContent !== s) n.textContent = s }
    if (r.mark.dataset.icon !== a.brand.icon) { r.mark.dataset.icon = a.brand.icon; r.mark.replaceChildren(I.mark(a.brand, 16)) }
    set(r.name, a.brand.name)
    set(r.title, a.title)
    const sub = a.sub === "noprog" || a.sub === "stuck" ? label(a)
      : a.status === "waiting" || a.status === "done" || a.status === "error" ? a.error || a.reply || a.step || a.query
        : a.step || a.query
    set(r.sub, sub)
    r.badge.style.setProperty("--c", M.COLORS[a.status])
    set(r.badge, label(a))
    set(r.dir, a.project)
    set(r.model, a.model)
    set(r.when, M.ago(Date.now() - a.at, lang))
    r.tr.classList.toggle("on", a.key === state.open)
    return r.tr
  }
  // a heading row per group, reused across refreshes
  function groupRowFor(key) {
    let r = groupRows.get(key)
    if (!r) {
      const tr = el("tr", "group")
      const td = el("td")
      td.colSpan = 6
      r = { tr, label: el("span", "glabel"), count: el("span", "gcount") }
      td.append(r.label, r.count)
      tr.append(td)
      groupRows.set(key, r)
    }
    return r
  }
  function rows() {
    const body = $("rows")
    const groups = M.groups(state.list)
    const want = []
    const usedGroups = new Set()
    for (const g of groups) {
      if (!g.list.length) continue
      usedGroups.add(g.key)
      const head = groupRowFor(g.key)
      const name = t()[g.key]
      if (head.label.textContent !== name) head.label.textContent = name
      head.count.textContent = g.list.length
      want.push(head.tr, ...g.list.map(rowFor))
    }
    for (const [k, r] of rowsByKey) {
      if (!groups.some((g) => g.list.some((a) => a.key === k))) { r.tr.remove(); rowsByKey.delete(k) }
    }
    for (const [k, r] of groupRows) if (!usedGroups.has(k)) r.tr.remove()
    want.forEach((tr, i) => { if (body.children[i] !== tr) body.insertBefore(tr, body.children[i] || null) })
    while (body.children.length > want.length) body.lastElementChild.remove()
    $("emptyList").hidden = state.list.length > 0
    $("emptyList").textContent = emptyText()
  }

  function emptyText() {
    return state.loaded && state.snap ? t().empty : t().noFile
  }

  // ---- the side rail ----------------------------------------------------
  // the same three groups as the list, in a compact panel over the office;
  // a row opens the same click-only detail panel
  let railSig = ""
  function renderRail() {
    const rail = $("rail")
    const menus = ($("settings") && !$("settings").hidden) || ($("todayMenu") && !$("todayMenu").hidden)
    const show = view.side && view.mode === "office" && !floatHome && !state.open && !menus
    rail.hidden = !show
    const btn = $("sideBtn")
    btn.classList.toggle("on", view.side)
    btn.setAttribute("aria-pressed", String(view.side))
    if (!show) return
    $("railCount").textContent = state.list.length
    const groups = M.groups(state.list)
    const sig = lang + "|" + groups.map((g) => g.key + ":" + g.list.map((a) => a.key + a.status + (a.sub || "") + (a.idle ? 1 : 0)).join(",")).join("|")
    if (sig === railSig) return
    railSig = sig
    const kids = []
    for (const g of groups) {
      if (!g.list.length) continue
      kids.push(el("div", "rail-group", `${t()[g.key]} · ${g.list.length}`))
      for (const a of g.list) {
        const row = el("button", "rail-row")
        row.type = "button"
        row.dataset.key = a.key
        row.classList.toggle("on", a.key === state.open)
        row.append(I.mark(a.brand, 15))
        row.append(el("span", "rn", a.title || a.project || a.brand.name))
        const st = el("span", "rs", a.sub === "noprog" ? t().noProgress : a.idle ? t().idle : t()[a.status])
        st.style.color = M.COLORS[a.status]
        row.append(st)
        row.title = `${a.brand.name} · ${label(a)}`
        row.addEventListener("click", (e) => { e.stopPropagation(); open(a.key) })
        kids.push(row)
      }
    }
    $("railGroups").replaceChildren(...kids)
  }

  // ---- Today ------------------------------------------------------------
  let todaySig = ""
  function renderToday() {
    const data = M.today(state.list)
    $("todayTokens").textContent = data.hasUsage && data.tokens ? M.fmtTokens(data.tokens) : ""
    const sig = lang + "|" + JSON.stringify(data)
    if (sig === todaySig) return
    todaySig = sig
    const w = t()
    const panel = $("todayMenu")
    const kids = []
    if (!data.hasUsage && !data.contexts.length) {
      panel.replaceChildren(el("div", "today-note", w.noUsage))
      return
    }
    const big = el("div", "today-big")
    for (const [value, name] of [[data.turns, w.turnsL], [M.fmtTokens(data.tokens), w.tokensL], [data.agentCount, w.agentsL]]) {
      const box = el("div")
      box.append(el("b", null, String(value)), el("span", null, name))
      big.append(box)
    }
    kids.push(big)
    const agents = Object.values(data.byAgent).sort((a, b) => b.turns - a.turns || b.tokens - a.tokens)
    for (const a of agents) {
      const row = el("div", "today-row")
      row.append(I.mark(M.brand(a.agent), 16), el("span", "trn", a.name), el("span", "n", `${a.turns} ${w.turnsL} · ${M.fmtTokens(a.tokens)}`))
      kids.push(row)
    }
    if (data.projects.length) {
      kids.push(el("div", "today-head", w.topProjects))
      for (const p of data.projects) {
        const row = el("div", "today-row")
        row.append(el("span", "trn", p.project), el("span", "n", `${p.turns} ${w.turnsL} · ${M.fmtTokens(p.tokens)}`))
        kids.push(row)
      }
    }
    if (data.contexts.length) {
      kids.push(el("div", "today-head", w.context))
      for (const c of data.contexts) kids.push(ctxBar(c, c.name || c.agent))
    }
    if (!data.hasUsage) kids.push(el("div", "today-note", w.noUsage))
    else kids.push(el("div", "today-note", w.summaryNote))
    panel.replaceChildren(...kids)
  }

  // ---- the per-agent filter / language selector -------------------------
  let agentFilterSig = ""
  function renderAgentFilter() {
    const ids = [...new Set(state.all.map((a) => a.agent))].sort()
    for (const id of view.agents) if (!ids.includes(id)) ids.push(id)
    const counts = ids.map((id) => `${id}:${state.all.filter((a) => a.agent === id).length}`).join(",")
    const sig = lang + "|" + counts + "|" + view.agents.join(",")
    if (sig === agentFilterSig) return
    agentFilterSig = sig
    const box = $("optAgents")
    const kids = []
    const allRow = el("label", "af")
    const allBox = document.createElement("input")
    allBox.type = "checkbox"
    allBox.checked = view.agents.length === 0
    allBox.addEventListener("change", () => { view.agents = []; agentFilterSig = ""; renderAgentFilter(); refresh(); save() })
    allRow.append(allBox, el("span", "afn", t().allAgents))
    kids.push(allRow)
    for (const id of ids) {
      const b = M.brand(id)
      const row = el("label", "af")
      const cbox = document.createElement("input")
      cbox.type = "checkbox"
      cbox.checked = view.agents.includes(id)
      cbox.dataset.agent = id
      cbox.addEventListener("change", () => {
        const next = view.agents.filter((x) => x !== id)
        if (cbox.checked) next.push(id)
        view.agents = next
        agentFilterSig = ""
        renderAgentFilter()
        refresh()
        save()
      })
      row.append(cbox, I.mark(b, 15), el("span", "afn", b.name), el("span", "afc", String(state.all.filter((a) => a.agent === id).length)))
      kids.push(row)
    }
    box.replaceChildren(...kids)
  }

  function syncLangSelect() {
    const sel = $("optLang")
    const sig = lang + "|" + manualLang
    if (sig === langSelectSig) return
    langSelectSig = sig
    const kids = []
    const option = (value, name) => { const o = document.createElement("option"); o.value = value; o.textContent = name; return o }
    kids.push(option("auto", t().auto))
    for (const code of M.LANGS) kids.push(option(code, M.LANG_NAMES[code]))
    sel.replaceChildren(...kids)
    sel.value = manualLang
  }

  // ---- in-page toasts ---------------------------------------------------
  // magpie frames the page with allow="", so the browser's desktop
  // notifications are blocked; a small in-page toast opens the agent when
  // clicked instead.
  function showToast(a) {
    const box = $("toasts")
    while (box.children.length >= 3) box.firstElementChild.remove()
    const b = el("button", "toast" + (a.status === "error" ? " error" : ""))
    b.type = "button"
    b.append(I.mark(a.brand, 18))
    const text = el("span", "tn")
    text.append(el("b", null, a.brand.name), el("span", null, `${label(a)} · ${a.title}`))
    b.append(text)
    b.title = t().dismiss
    b.addEventListener("click", (e) => { e.stopPropagation(); b.remove(); open(a.key) })
    box.append(b)
    setTimeout(() => b.remove(), 8000)
  }
  function trackAlerts() {
    const next = new Map()
    // the first snapshot with real sessions is the baseline: sessions that
    // were already waiting when the page opened are not news
    const seeded = state.alertsSeeded === true
    for (const a of state.all) {
      // sample agents are not news
      if (String(a.key).startsWith("demo|")) continue
      next.set(a.key, a.status)
      const was = state.alerts.get(a.key)
      if (seeded && (a.status === "waiting" || a.status === "error") && was !== a.status) showToast(a)
    }
    state.alerts = next
    if (state.snap) state.alertsSeeded = true
  }

  // ---- everything ------------------------------------------------------
  function refresh() {
    const now = Date.now()
    // text off in the page as well as the host: a stale live.js or a host
    // that has not restarted yet must not render what the switch hid
    state.showText = view.text && state.snap?.text !== false
    const snap = snapshot(now)
    // follow the newest real prompt's script while the picker is on Auto
    // (sample agents are not the user's own prompts and must not pick a UI
    // language for them)
    if (manualLang === "auto") {
      const want = pickLang(M.sample(state.snap))
      if (want !== lang) { lang = want; words() }
    }
    const base = { ...view, progress: true }
    state.all = M.agents(snap, now, { ...base, agents: [], showSub: true, showIdle: true })
    state.list = M.agents(snap, now, base)
    if (!state.showText) { state.list = M.redact(state.list); state.all = M.redact(state.all) }
    const c = M.counts(state.list)
    const set = (id, v) => { const n = $(id); if (n.textContent !== String(v)) n.textContent = v }
    set("nNeed", c.needYou)
    set("nWork", c.working)
    set("nDone", c.done)
    $("counts").classList.toggle("alert", c.needYou > 0)
    const active = activateScene()
    active.setAgents(state.list)
    if (view.mode === "office") active.start()
    const keys = new Set(state.list.map((a) => a.key))
    for (const [k, e] of tags) if (!keys.has(k)) { e.remove(); tags.delete(k) }
    for (const a of state.list) tagFor(a)
    if (state.open) {
      const a = state.list.find((x) => x.key === state.open)
      if (a) fillPanel(a)
      else close()
    }
    $("empty").hidden = state.list.length > 0
    if (!$("empty").hidden) $("empty").textContent = emptyText()
    set("note", view.demo ? t().demoOn : (view.dim === "3d" && state.scene3Failed ? "WebGL unavailable · ISO view" : ""))
    const age = state.snap?.written ? now - state.snap.written : 0
    const live = $("live")
    live.classList.toggle("stale", !!state.snap && age > 15000)
    live.title = state.snap ? M.fill(t().stale, M.ago(age, lang)) : ""
    if (view.mode === "list") rows()
    brandLegend()
    renderRail()
    renderToday()
    renderAgentFilter()
    trackAlerts()
    document.title = c.needYou ? `(${c.needYou}) ${t().title}` : t().title
  }

  function select(group, attr, value) {
    $(group).querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset[attr] === value)))
  }

  function setMode(m) {
    view.mode = m
    select("modes", "mode", m)
    $("stage").hidden = m !== "office"
    $("listview").hidden = m !== "list"
    $("dims").classList.toggle("off", m !== "office")
    railSig = ""
    if (m === "office") { const s = activateScene(); s.resize(); s.start() }
    else { try { scene2.stop() } catch {} ; if (scene3) scene3.stop() }
    refresh()
  }

  // saving restarts the plugin's host (magpie's options do), so a change
  // waits until it has been left alone a moment, and only a real change is
  // written
  let saving = null
  let saved = JSON.stringify(opts)
  const textOn = () => $("optText").checked
  function wanted() {
    return {
      ...opts, mode: view.mode, dim: view.dim, demo: view.demo, showDone: view.showDone, hideAfter: view.hideAfter,
      text: textOn(), agents: view.agents.slice(), showSub: view.showSub, showIdle: view.showIdle,
      side: view.side, lang: manualLang, scene: view.scene, quality: view.quality,
      cleared: { ...view.cleared },
    }
  }
  function save() {
    clearTimeout(saving)
    saving = setTimeout(async () => {
      saving = null
      const next = wanted()
      if (JSON.stringify(next) === saved) return
      try { opts = await magpie.options.set(next); saved = JSON.stringify(opts) } catch {}
    }, 2500)
  }

  $("modes").addEventListener("click", (e) => {
    const m = e.target.closest("button")?.dataset.mode
    if (!m || m === view.mode) return
    setMode(m)
    save()
  })
  $("dims").addEventListener("click", (e) => {
    const d = e.target.closest("button")?.dataset.dim
    if (!d || d === view.dim) return
    view.dim = d
    select("dims", "dim", d)
    const s = activateScene()
    s.resize()
    if (view.mode !== "office") setMode("office")
    refresh()
    save()
  })

  // settings and the Today panel share one menu behaviour
  const menu = $("settings")
  const todayMenu = $("todayMenu")
  function closeMenus(except) {
    let changed = false
    for (const [btn, m] of [[$("settingsBtn"), menu], [$("todayBtn"), todayMenu]]) {
      if (m === except || m.hidden) continue
      m.hidden = true
      btn.setAttribute("aria-expanded", "false")
      changed = true
    }
    if (changed) renderRail()
  }
  function toggleMenu(btn, m) {
    const willOpen = m.hidden
    closeMenus(willOpen ? m : null)
    m.hidden = !willOpen
    btn.setAttribute("aria-expanded", String(willOpen))
    renderRail()
  }
  $("settingsBtn").addEventListener("click", (e) => { e.stopPropagation(); toggleMenu($("settingsBtn"), menu) })
  $("todayBtn").addEventListener("click", (e) => { e.stopPropagation(); toggleMenu($("todayBtn"), todayMenu) })
  menu.addEventListener("click", (e) => e.stopPropagation())
  todayMenu.addEventListener("click", (e) => e.stopPropagation())
  document.addEventListener("click", (e) => {
    if (menu.contains(e.target) || todayMenu.contains(e.target)) return
    if (e.target === $("settingsBtn") || e.target === $("todayBtn")) return
    closeMenus()
  })
  $("optDemo").checked = view.demo
  $("optDone").checked = view.showDone
  $("optText").checked = opts.text !== false
  $("optSub").checked = view.showSub
  $("optIdle").checked = view.showIdle
  select("optHide", "hide", view.hideAfter)
  $("optDemo").addEventListener("change", (e) => { view.demo = e.target.checked; state.demoSnap = null; refresh(); save() })
  $("optDone").addEventListener("change", (e) => { view.showDone = e.target.checked; refresh(); save() })
  $("optText").addEventListener("change", (e) => { view.text = e.target.checked; refresh(); save() })
  $("optSub").addEventListener("change", (e) => { view.showSub = e.target.checked; agentFilterSig = ""; refresh(); save() })
  $("optIdle").addEventListener("change", (e) => { view.showIdle = e.target.checked; agentFilterSig = ""; refresh(); save() })
  $("optLang").addEventListener("change", (e) => {
    manualLang = M.LANG_NAMES[e.target.value] ? e.target.value : "auto"
    lang = pickLang()
    words()
    refresh()
    save()
  })
  $("optHide").addEventListener("click", (e) => {
    const h = e.target.closest("button")?.dataset.hide
    if (!h) return
    view.hideAfter = h
    select("optHide", "hide", h)
    refresh()
    save()
  })

  // the rail can be put away; the list view keeps its own groups
  $("sideBtn").addEventListener("click", (e) => {
    e.stopPropagation()
    view.side = !view.side
    railSig = ""
    renderRail()
    save()
  })
  $("railClose").addEventListener("click", (e) => {
    e.stopPropagation()
    view.side = false
    railSig = ""
    renderRail()
    save()
  })

  // picture in picture: the office in a window of the page's own (magpie's
  // frame refuses the browser's own floating window to a sandboxed page).
  // Its bar moves it, its corner reshapes it, ✕ or Escape puts it back.
  function openFloat() {
    if (floatHome) return
    const stage = $("stage")
    const ph = el("div", "stage-slot", t().floating)
    stage.parentElement.insertBefore(ph, stage)
    floatHome = { parent: ph.parentElement, ph }
    $("floatslot").append(stage)
    $("float").hidden = false
    $("float").style.cssText = ""
    $("pip").classList.add("on")
    $("pip").textContent = t().pipOn
    railSig = ""
    renderRail()
    scene.resize()
  }
  function closeFloat() {
    if (!floatHome) return
    floatHome.parent.insertBefore($("stage"), floatHome.ph)
    floatHome.ph.remove()
    floatHome = null
    $("float").hidden = true
    $("pip").classList.remove("on")
    $("pip").textContent = t().pip
    railSig = ""
    renderRail()
    scene.resize()
  }
  $("floatClose").addEventListener("click", closeFloat)
  $("floatbar").addEventListener("pointerdown", (e) => {
    if (e.target.closest(".fclose")) return
    const f = $("float")
    const box = f.getBoundingClientRect()
    const dx = e.clientX - box.left, dy = e.clientY - box.top
    f.setPointerCapture?.(e.pointerId)
    const move = (m) => {
      const x = Math.max(0, Math.min(innerWidth - box.width, m.clientX - dx))
      const y = Math.max(0, Math.min(innerHeight - box.height, m.clientY - dy))
      Object.assign(f.style, { left: x + "px", top: y + "px", right: "auto", bottom: "auto" })
    }
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up) }
    addEventListener("pointermove", move)
    addEventListener("pointerup", up)
    e.preventDefault()
  })
  $("pip").addEventListener("click", () => {
    if (floatHome) return closeFloat()
    if (view.mode !== "office") setMode("office")
    openFloat()
  })

  // the canvas is sized only when its box really changes
  let resizeQueued = false
  new ResizeObserver(() => {
    if (resizeQueued) return
    resizeQueued = true
    requestAnimationFrame(() => { resizeQueued = false; scene.resize() })
  }).observe($("stage"))
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return
    if (!menu.hidden || !todayMenu.hidden) return closeMenus()
    if (state.open) return close()
    if (floatHome) closeFloat()
  })
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) scene.stop()
    else if (view.mode === "office") scene.start()
  })
  magpie.onTheme((th) => {
    themeLang = th.lang
    const want = pickLang()
    if (want !== lang) { lang = want; words() }
    refresh()
  })

  const SCENE_OPTIONS = [
    ["office", "🏢 Office"], ["station", "🚀 Space station"], ["cafe", "☕ Café"],
    ["castle", "🏰 Castle"], ["pirate", "🏴‍☠️ Pirate cove"], ["graveyard", "🪦 Haunted hollow"],
  ]
  if ($("optScene")) {
    $("optScene").replaceChildren(...SCENE_OPTIONS.map(([id, name]) => { const o = el("option", "", name); o.value = id; return o }))
    $("optScene").value = view.scene
    $("optQuality").value = view.quality
    $("optQuality").addEventListener("change", (e) => {
      view.quality = e.target.value
      if (scene3) scene3.setQuality(view.quality)
      save()
    })
    $("optScene").addEventListener("change", (e) => {
      view.scene = e.target.value
      // a scene belongs to the real 3D view; choosing one takes you there
      if (view.dim !== "3d") { view.dim = "3d"; select("dims", "dim", "3d") }
      if (scene3) scene3.setScene(view.scene)
      activateScene()
      refresh()
      save()
    })
  }
  select("modes", "mode", view.mode)
  select("dims", "dim", view.dim)
  words()
  setMode(view.mode)
  load()
  // the host writes live.js within a second and a half of a change; the
  // page looks every second, and "N min ago" moves with its own clock
  setInterval(load, 1000)
  setInterval(() => { if (state.open) { const a = state.list.find((x) => x.key === state.open); if (a) fillPanel(a) } }, 5000)
})()
