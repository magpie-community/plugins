// Notify's page: the plugin's options, edited without touching a file.
// Everything is drawn from the saved options and written back whole, so a
// field this page doesn't know (a webhook's headers, a Gotify channel's
// extras) is kept as it was.
(function () {
  "use strict"
  var t = window.NotifyI18n.t
  var root = document.getElementById("root")

  var DEFAULTS = { enabled: true, channels: [], minMinutes: 3, cooldownSeconds: 30, errors: true, agents: [], allOrigins: false, includeText: false, accounts: true, lang: "en" }
  // kind -> { name, fields: [key, label, kind, required] }
  var KINDS = {
    ntfy: { name: "ntfy", fields: [["topic", "Topic", "text", 1], ["server", "Server", "text"], ["token", "Token", "secret"], ["priority", "Priority", "number"]] },
    bark: { name: "Bark", fields: [["key", "Key", "secret", 1], ["server", "Server", "text"], ["group", "Group", "text"], ["sound", "Sound", "text"]] },
    gotify: { name: "Gotify", fields: [["server", "Server", "text", 1], ["token", "Token", "secret", 1], ["priority", "Priority", "number"]] },
    serverchan: { name: "Server酱", fields: [["key", "Key", "secret", 1]] },
    feishu: { name: "Feishu", fields: [["webhook", "Webhook URL", "secret", 1], ["secret", "Secret", "secret"]] },
    dingtalk: { name: "DingTalk", fields: [["webhook", "Webhook URL", "secret", 1], ["secret", "Secret", "secret"]] },
    wecom: { name: "WeCom", fields: [["webhook", "Webhook URL", "secret", 1]] },
    telegram: { name: "Telegram", fields: [["token", "Token", "secret", 1], ["chatId", "Chat ID", "text", 1]] },
    webhook: { name: "Custom webhook", fields: [["url", "Webhook URL", "text", 1]] }
  }
  var LANGS = [["en", "English"], ["zh", "中文"]]

  var saved = null // the options as the plugin has them
  var draft = null // what the page shows
  var note = ["", false]
  var busy = false
  var openMenu = null

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }
  var same = function (a, b) { return JSON.stringify(a) === JSON.stringify(b) }
  var dirty = function () { return !same(draft, saved) }
  function fill(o) {
    var r = Object.assign({}, DEFAULTS, o && typeof o === "object" ? o : {})
    r.channels = (Array.isArray(r.channels) ? r.channels : r.channels ? [r.channels] : []).filter(function (c) { return c && typeof c === "object" }).map(function (c) { return Object.assign({}, c) })
    r.agents = Array.isArray(r.agents) ? r.agents.map(String) : typeof r.agents === "string" && r.agents ? r.agents.split(",").map(function (s) { return s.trim() }).filter(Boolean) : []
    return r
  }
  function change() { note = ["", false]; renderBar() }

  function toggle(on, label, fn) {
    var b = el("button", "switch")
    b.type = "button"
    b.setAttribute("role", "switch")
    b.setAttribute("aria-checked", on ? "true" : "false")
    b.setAttribute("aria-label", label)
    b.addEventListener("click", function () {
      var next = b.getAttribute("aria-checked") !== "true"
      b.setAttribute("aria-checked", next ? "true" : "false")
      fn(next)
    })
    return b
  }

  // the app's own menu, not a native select
  function menu(label, items, current, pick) {
    var wrap = el("div", "menu")
    var btn = el("button", "", label)
    btn.type = "button"
    btn.setAttribute("aria-haspopup", "listbox")
    var pop = el("div", "pop")
    pop.hidden = true
    pop.setAttribute("role", "listbox")
    items.forEach(function (it) {
      var o = el("button", "", it[1])
      o.type = "button"
      o.setAttribute("role", "option")
      o.setAttribute("aria-selected", it[0] === current ? "true" : "false")
      o.addEventListener("click", function () { close(); pick(it[0]) })
      pop.appendChild(o)
    })
    function close() { pop.hidden = true; btn.setAttribute("aria-expanded", "false"); if (openMenu === close) openMenu = null }
    btn.addEventListener("click", function (e) {
      e.stopPropagation()
      var was = pop.hidden
      if (openMenu) openMenu()
      if (was) { pop.hidden = false; btn.setAttribute("aria-expanded", "true"); openMenu = close }
    })
    wrap.append(btn, pop)
    return wrap
  }
  document.addEventListener("click", function () { if (openMenu) openMenu() })
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && openMenu) openMenu() })

  function numberRow(label, key) {
    var row = el("div", "row")
    var l = el("label", "", t(label))
    var i = el("input")
    i.type = "number"; i.min = "0"; i.value = String(draft[key])
    i.addEventListener("input", function () { draft[key] = Math.max(0, Number(i.value) || 0); change() })
    row.append(l, i)
    return row
  }
  function switchRow(label, key) {
    var row = el("div", "row")
    row.append(el("span", "name", t(label)), toggle(draft[key] !== false && !!draft[key], t(label), function (v) { draft[key] = v; change() }))
    return row
  }

  function missing(c) {
    var k = KINDS[c.type]
    return !k || k.fields.some(function (f) { return f[3] && (c[f[0]] == null || String(c[f[0]]).trim() === "") })
  }

  function channel(c, i) {
    var k = KINDS[c.type]
    var box = el("div", "box chan" + (c.off ? " paused" : ""))
    var head = el("div", "chan-head")
    head.appendChild(el("span", "title", k ? t(k.name) : String(c.type || "?")))
    if (!c.off && missing(c)) head.appendChild(el("span", "warn", t("Incomplete, skipped")))
    var rm = el("button", "quiet", t("Remove"))
    rm.type = "button"
    rm.addEventListener("click", function () { draft.channels.splice(i, 1); change(); render() })
    head.append(toggle(!c.off, t("Sending"), function (v) { if (v) delete c.off; else c.off = true; box.classList.toggle("paused", !v); change() }), rm)
    box.appendChild(head)
    if (k) {
      var fields = el("div", "fields")
      k.fields.forEach(function (f) {
        var id = "c" + i + f[0]
        var lab = el("label", "", t(f[1]))
        lab.htmlFor = id
        var inp = el("input")
        inp.id = id
        inp.type = f[2] === "secret" ? "password" : f[2] === "number" ? "number" : "text"
        inp.autocomplete = "off"
        inp.spellcheck = false
        inp.value = c[f[0]] == null ? "" : String(c[f[0]])
        inp.addEventListener("input", function () {
          var v = inp.value.trim()
          if (v === "") delete c[f[0]]
          else if (f[2] === "number" || (f[0] === "chatId" && /^-?\d+$/.test(v))) c[f[0]] = Number(v)
          else c[f[0]] = v
          change()
        })
        fields.append(lab, inp)
      })
      box.appendChild(fields)
    }
    return box
  }

  var bar = el("div", "bar")
  function renderBar() {
    bar.textContent = ""
    var d = dirty()
    var s = el("span", "status" + (note[1] ? " error" : ""), note[0] || (d ? t("Unsaved changes") : ""))
    var b = el("button", "primary", t("Save"))
    b.type = "button"
    b.disabled = !d || busy
    b.addEventListener("click", function () { save(draft, true) })
    bar.append(s, b)
  }

  function save(next, full) {
    busy = true; renderBar()
    return window.magpie.options.set(next).then(function (got) {
      saved = fill(got)
      if (full) draft = fill(got)
      note = [t("Saved"), false]
    }).catch(function () {
      note = [t("Could not save"), true]
    }).then(function () { busy = false; if (full) render(); else renderBar() })
  }

  function render() {
    root.textContent = ""
    var head = el("header")
    head.appendChild(el("h1", "", t("Notify")))
    head.appendChild(toggle(draft.enabled !== false, t("Notifications on"), function (v) {
      // the switch saves at once, and only itself
      draft.enabled = v
      save(Object.assign({}, saved, { enabled: v }), false)
    }))
    root.appendChild(head)

    var ch = el("section")
    var h = el("div", "head")
    h.appendChild(el("h2", "", t("Channels")))
    h.appendChild(menu(t("Add channel"), Object.keys(KINDS).map(function (k) { return [k, t(KINDS[k].name)] }), "", function (kind) {
      draft.channels.push({ type: kind }); change(); render()
    }))
    ch.appendChild(h)
    if (!draft.channels.length) ch.appendChild(el("div", "box empty", t("No channel yet. Nothing is sent.")))
    draft.channels.forEach(function (c, i) { ch.appendChild(channel(c, i)) })
    root.appendChild(ch)

    var w = el("section")
    w.appendChild(el("div", "head")).appendChild(el("h2", "", t("When to send")))
    var box = el("div", "box")
    box.appendChild(numberRow("Only turns longer than (minutes)", "minMinutes"))
    box.appendChild(numberRow("One push per conversation every (seconds)", "cooldownSeconds"))
    box.appendChild(switchRow("Turns that end in an error", "errors"))
    box.appendChild(switchRow("Account needs signing in again", "accounts"))
    box.appendChild(switchRow("Include the start of the reply", "includeText"))
    box.appendChild(switchRow("Also gateway-key and remote requests", "allOrigins"))
    var ag = el("div", "row")
    var al = el("label", "", t("Only these agents (ids, comma separated)"))
    var ai = el("input"); ai.type = "text"; ai.placeholder = "claude, codex"; ai.style.maxWidth = "200px"; ai.spellcheck = false
    ai.value = draft.agents.join(", ")
    ai.addEventListener("input", function () { draft.agents = ai.value.split(",").map(function (s) { return s.trim() }).filter(Boolean); change() })
    ag.append(al, ai)
    box.appendChild(ag)
    var lr = el("div", "row")
    lr.appendChild(el("span", "name", t("Language of the push")))
    lr.appendChild(menu(LANGS.filter(function (l) { return l[0] === draft.lang })[0] ? LANGS.filter(function (l) { return l[0] === draft.lang })[0][1] : draft.lang, LANGS, draft.lang, function (v) { draft.lang = v; change(); render() }))
    box.appendChild(lr)
    w.appendChild(box)
    root.appendChild(w)

    root.appendChild(bar)
    renderBar()
  }

  window.NotifyI18n.onChange(function () { if (draft) render() })
  window.magpie.ready.then(function () { return window.magpie.options.get() }).then(function (o) {
    saved = fill(o); draft = fill(o); render()
  }).catch(function () {
    root.textContent = t("Could not read the settings")
  })
})()
