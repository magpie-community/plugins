// The page: loads live.js (what the plugin's host part wrote) again every
// second, works out each agent's status (model.js), and draws the office
// (scene.js) or the list. It reads nothing of magpie's but its own options,
// and has no network: live.js is one of its own files.
//
// Interaction, kept calm on purpose: nothing opens because the pointer
// passes over it. Hovering only highlights. A click on a worker, its name
// tag, or a row opens that agent's panel at the side, which stays put (it
// doesn't ride the animation) until it's closed or another agent is
// clicked. The DOM is updated in place: nothing is rebuilt each second.
(async () => {
  const M = globalThis.AgentOfficeModel
  const I = globalThis.AgentOfficeIcons
  const { Scene } = globalThis.AgentOfficeScene
  const $ = (id) => document.getElementById(id)
  const theme = await magpie.ready
  let lang = theme.lang
  let opts = {}
  try { opts = (await magpie.options.get()) || {} } catch {}
  const view = {
    mode: opts.mode === "list" ? "list" : "office",
    dim: opts.dim === "2d" ? "2d" : "3d",
    demo: opts.demo === true,
    showDone: opts.showDone !== false,
    hideAfter: M.HIDE[opts.hideAfter] !== undefined ? opts.hideAfter : M.DEFAULTS.hideAfter,
    text: opts.text !== false,
    approvalAfterSec: Number(opts.approvalAfterSec) > 0 ? Number(opts.approvalAfterSec) : M.DEFAULTS.approvalAfterSec,
  }
  const state = { snap: null, loaded: false, list: [], open: "", hover: "", showText: true }
  let floatHome = null
  const t = () => M.text(lang)
  const el = (tag, cls, text) => {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (text != null) e.textContent = text
    return e
  }
  // a status as a person reads it: the sub-state says more than the six
  function label(a) {
    const w = t()
    if (a.sub === "approval") return w.approval
    if (a.sub === "ask") return w.ask
    if (a.sub === "stopped") return w.stopped
    if (a.sub === "stuck") return M.fill(w.stuck, M.duration(Date.now() - a.at, lang))
    return w[a.status]
  }

  // ---- words -----------------------------------------------------------
  function words() {
    document.querySelectorAll("[data-t]").forEach((e) => { e.textContent = t()[e.dataset.t] })
    $("pip").textContent = floatHome ? t().pipOn : t().pip
    document.documentElement.lang = lang || "en"
    statusLegend()
    lastLegend = ""
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
  let lastLegend = ""
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
  const scene = new Scene($("office"), { dim: view.dim, onFrame: place })
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
    const sig = [a.brand.icon, a.brand.name, a.title, a.status].join("|")
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
      if (!e) continue
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
      const tf = `translate(${Math.round(it.p.x)}px, ${Math.round(it.y)}px) translate(-50%, -100%)`
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

  let moveQueued = false
  $("office").addEventListener("pointermove", (e) => {
    if (moveQueued) return
    moveQueued = true
    const x = e.offsetX, y = e.offsetY
    requestAnimationFrame(() => {
      moveQueued = false
      const k = scene.hit(x, y)
      $("office").style.cursor = k ? "pointer" : ""
      highlight(k)
    })
  })
  $("office").addEventListener("pointerleave", () => highlight(""))
  $("office").addEventListener("click", (e) => {
    const k = scene.hit(e.offsetX, e.offsetY)
    if (k) open(k)
    else close()
  })

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
    const foot = el("div", "pf")
    P.meta = el("span", "pm")
    P.copy = el("button", "pc")
    P.copy.type = "button"
    P.copy.addEventListener("click", (e) => { e.stopPropagation(); showCommand(P.copy.dataset.value, P.copy) })
    foot.append(P.meta, P.copy)
    P.src = el("div", "psrc")
    panel.replaceChildren(head, P.title, P.status, P.query, P.step, P.err, P.reply, foot, P.src)
  })()
  panel.addEventListener("click", (e) => e.stopPropagation())

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
    const more = a.status === "executing" && a.since > 3000 ? M.fill(w.ran, M.duration(a.since, lang)) : a.turns ? M.fill(w.turns, a.turns) : ""
    setText(P.stMore, more)
    const q = a.query || (state.showText ? "" : w.quiet)
    setText(P.query, q); P.query.hidden = !q
    setText(P.step, a.step ? "› " + a.step : ""); P.step.hidden = !a.step
    setText(P.err, a.error); P.err.hidden = !a.error
    setText(P.reply, a.reply ? "← " + a.reply : ""); P.reply.hidden = !a.reply
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
    setText(P.src, a.source === "files" ? w.fromFiles : w.via)
  }

  function open(key) {
    if (state.open === key) return close()
    const a = state.list.find((x) => x.key === key)
    if (!a) return
    state.open = key
    scene.selected = key
    fillPanel(a)
    panel.hidden = false
    for (const [k, e] of tags) e.classList.toggle("on", k === key)
    for (const tr of $("rows").children) tr.classList.toggle("on", tr.dataset.key === key)
  }
  function close() {
    if (!state.open) return
    state.open = ""
    scene.selected = ""
    panel.hidden = true
    for (const e of tags.values()) e.classList.remove("on")
    for (const tr of $("rows").children) tr.classList.remove("on")
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
    set(r.sub, a.status === "waiting" || a.status === "done" || a.status === "error" ? a.error || a.reply || a.step || a.query : a.step || a.query)
    r.badge.style.setProperty("--c", M.COLORS[a.status])
    set(r.badge, label(a))
    set(r.dir, a.project)
    set(r.model, a.model)
    set(r.when, M.ago(Date.now() - a.at, lang))
    r.tr.classList.toggle("on", a.key === state.open)
    return r.tr
  }
  function rows() {
    const list = M.sorted(state.list)
    $("emptyList").hidden = list.length > 0
    $("emptyList").textContent = emptyText()
    const want = list.map(rowFor)
    const body = $("rows")
    const keys = new Set(list.map((a) => a.key))
    for (const [k, r] of rowsByKey) if (!keys.has(k)) { r.tr.remove(); rowsByKey.delete(k) }
    // put rows in order, moving only the ones out of place
    want.forEach((tr, i) => { if (body.children[i] !== tr) body.insertBefore(tr, body.children[i] || null) })
  }

  function emptyText() {
    return state.loaded && state.snap ? t().empty : t().noFile
  }

  // ---- everything ------------------------------------------------------
  function refresh() {
    const now = Date.now()
    // text off in the page as well as the host: a stale live.js or a host
    // that has not restarted yet must not render what the switch hid
    state.showText = view.text && state.snap?.text !== false
    state.list = M.agents(snapshot(now), now, view)
    if (!state.showText) state.list = M.redact(state.list)
    const c = M.counts(state.list)
    const set = (id, v) => { const n = $(id); if (n.textContent !== String(v)) n.textContent = v }
    set("nNeed", c.needYou)
    set("nWork", c.working)
    set("nDone", c.done)
    $("counts").classList.toggle("alert", c.needYou > 0)
    scene.setAgents(state.list)
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
    set("note", view.demo ? t().demoOn : "")
    const age = state.snap?.written ? now - state.snap.written : 0
    const live = $("live")
    live.classList.toggle("stale", !!state.snap && age > 15000)
    live.title = state.snap ? M.fill(t().stale, M.ago(age, lang)) : ""
    if (view.mode === "list") rows()
    brandLegend()
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
    if (m === "office") { scene.resize(); scene.start() } else scene.stop()
    refresh()
  }

  // saving restarts the plugin's host (magpie's options do), so a change
  // waits until it has been left alone a moment, and only a real change is
  // written
  let saving = null
  let saved = JSON.stringify(opts)
  const textOn = () => $("optText").checked
  function wanted() {
    return { ...opts, mode: view.mode, dim: view.dim, demo: view.demo, showDone: view.showDone, hideAfter: view.hideAfter, text: textOn() }
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
    scene.setDim(d)
    if (view.mode !== "office") setMode("office")
    save()
  })

  // settings
  const menu = $("settings")
  $("settingsBtn").addEventListener("click", (e) => {
    e.stopPropagation()
    menu.hidden = !menu.hidden
    $("settingsBtn").setAttribute("aria-expanded", String(!menu.hidden))
  })
  document.addEventListener("click", (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target !== $("settingsBtn")) { menu.hidden = true; $("settingsBtn").setAttribute("aria-expanded", "false") } })
  $("optDemo").checked = view.demo
  $("optDone").checked = view.showDone
  $("optText").checked = opts.text !== false
  select("optHide", "hide", view.hideAfter)
  $("optDemo").addEventListener("change", (e) => { view.demo = e.target.checked; state.demoSnap = null; refresh(); save() })
  $("optDone").addEventListener("change", (e) => { view.showDone = e.target.checked; refresh(); save() })
  $("optText").addEventListener("change", (e) => { view.text = e.target.checked; refresh(); save() })
  $("optHide").addEventListener("click", (e) => {
    const h = e.target.closest("button")?.dataset.hide
    if (!h) return
    view.hideAfter = h
    select("optHide", "hide", h)
    refresh()
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
    if (state.open) return close()
    if (floatHome) closeFloat()
  })
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) scene.stop()
    else if (view.mode === "office") scene.start()
  })
  magpie.onTheme((th) => { lang = th.lang; words(); refresh() })

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
