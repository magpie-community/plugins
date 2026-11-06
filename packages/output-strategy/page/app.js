(function () {
  "use strict"

  var i18n = globalThis.OutputStrategyI18n
  var t = function (text) {
    if (i18n && typeof i18n.t === "function") return i18n.t(text)
    return text
  }
  var byId = function (id) { return document.getElementById(id) }
  var form = byId("stylesForm")
  var fieldset = byId("stylesFieldset")
  var list = byId("stylesList")
  var saveButton = byId("saveButton")
  var message = byId("formMessage")
  var options = {}
  var inputs = Object.create(null)
  var loaded = false
  var saving = false
  var dirty = false
  var catalog = readCatalog(globalThis.OUTPUT_STRATEGY_CATALOG)
  var stats = globalThis.__OUTPUT_STRATEGY_STATS__

  function readCatalog(value) {
    var entries = Array.isArray(value) ? value : value && Array.isArray(value.styles) ? value.styles : []
    return entries.filter(function (entry) {
      return entry && typeof entry.id === "string" && entry.id.length > 0
    }).map(function (entry) {
      return {
        id: entry.id,
        label: typeof entry.label === "string" && entry.label ? entry.label : entry.id,
        description: typeof entry.description === "string" ? entry.description : "",
      }
    })
  }

  function element(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text != null) node.textContent = text
    return node
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild)
  }

  function setMessage(text, isError) {
    message.textContent = text
    message.className = "form-message" + (isError ? " error" : "")
  }

  function selectedTotal() {
    return catalog.reduce(function (total, style) {
      return total + (inputs[style.id] && inputs[style.id].checked ? 1 : 0)
    }, 0)
  }

  function updateSelection() {
    byId("selectedCount").textContent = selectedTotal() + " / " + catalog.length
  }

  function updateControls() {
    var unavailable = !loaded || saving || catalog.length === 0
    fieldset.disabled = unavailable
    saveButton.disabled = unavailable || !dirty
    saveButton.textContent = saving ? "正在保存…" : "保存更改"
  }

  function renderCatalogState() {
    byId("catalogState").textContent = catalog.length
      ? t("{n} styles; injected in catalog order.").replace("{n}", String(catalog.length))
      : t("Catalog not loaded")
  }

  function renderCatalog() {
    clear(list)
    inputs = Object.create(null)

    if (!catalog.length) {
      list.append(element("p", "empty-state", t("目录未载入。样式开关暂不可用，统计仍可使用。")))
      renderCatalogState()
      updateSelection()
      updateControls()
      return
    }

    renderCatalogState()
    catalog.forEach(function (style) {
      var input = element("input")
      var copy = element("span", "style-copy")
      var row = element("label", "style-row")
      input.type = "checkbox"
      input.id = "style-" + style.id
      input.name = style.id
      input.setAttribute("data-style-id", style.id)
      input.addEventListener("change", function () {
        dirty = true
        setMessage("有未保存的更改。")
        updateSelection()
        updateControls()
      })
      copy.append(
        element("span", "style-name", t(style.label)),
        element("span", "style-description", t(style.description))
      )
      row.setAttribute("for", input.id)
      row.append(copy, input)
      list.append(row)
      inputs[style.id] = input
    })
    updateSelection()
    updateControls()
  }

  function metric(value) {
    if (value == null || value === "") return "—"
    var number = Number(value)
    if (!Number.isFinite(number) || number < 0) return "—"
    return String(Math.floor(number))
  }

  function styleCounts() {
    if (!stats || typeof stats !== "object") return null
    var counts = stats.styles || stats.byStyle
    return counts && typeof counts === "object" && !Array.isArray(counts) ? counts : {}
  }

  function renderStats() {
    var available = !!stats && typeof stats === "object"
    byId("statRequests").textContent = available ? metric(stats.requests) : "—"
    byId("statApplied").textContent = available ? metric(stats.applied) : "—"
    byId("statSkipped").textContent = available ? metric(stats.skipped) : "—"
    byId("statInjectedBytes").textContent = available ? metric(stats.injectedBytes) : "—"
    byId("statsState").textContent = available
      ? "数据仅保存在本机。"
      : "统计暂不可用；样式设置仍可使用。"

    var counts = styleCounts()
    var labels = {}
    var order = catalog.map(function (style) {
      labels[style.id] = t(style.label)
      return style.id
    })
    if (counts) {
      Object.keys(counts).forEach(function (id) {
        if (order.indexOf(id) === -1) order.push(id)
      })
    }

    var host = byId("styleStats")
    clear(host)
    if (!order.length) {
      var empty = element("li", "empty-state", available ? "还没有样式注入记录。" : "暂无样式统计。")
      host.append(empty)
      return
    }
    order.forEach(function (id) {
      var item = element("li")
      item.append(
        element("span", "", labels[id] || id),
        element("output", "", counts ? metric(counts[id] || 0) : "—")
      )
      host.append(item)
    })
  }

  function applyOptions(next) {
    options = next && typeof next === "object" ? next : {}
    var styles = options.styles && typeof options.styles === "object" ? options.styles : {}
    catalog.forEach(function (style) {
      if (inputs[style.id]) inputs[style.id].checked = styles[style.id] === true
    })
    dirty = false
    updateSelection()
    updateControls()
  }

  function save(event) {
    event.preventDefault()
    if (!loaded || saving || !catalog.length) return

    var styles = Object.assign({},
      options.styles && typeof options.styles === "object" ? options.styles : {}
    )
    catalog.forEach(function (style) { styles[style.id] = inputs[style.id].checked === true })
    var next = Object.assign({}, options, { styles: styles })
    saving = true
    setMessage("正在保存…")
    updateControls()

    Promise.resolve()
      .then(function () { return globalThis.magpie.options.set(next) })
      .then(function (saved) {
        applyOptions(saved && typeof saved === "object" ? saved : next)
        setMessage("已保存。")
      })
      .catch(function () {
        setMessage("保存失败。更改尚未写入，请重试。", true)
      })
      .then(function () {
        saving = false
        updateControls()
      })
  }

  // The page runs in a sandboxed frame with CSP form-action 'none'; form
  // submission never dispatches a submit event there, so the button must
  // call save() directly. The submit listener stays for keyboard/Enter.
  saveButton.addEventListener("click", save)
  form.addEventListener("submit", save)
  renderCatalog()
  renderStats()

  if (i18n && typeof i18n.onChange === "function") {
    i18n.onChange(function () {
      renderCatalogState()
      renderStats()
    })
  }

  if (!globalThis.magpie || !globalThis.magpie.options ||
      typeof globalThis.magpie.options.get !== "function" ||
      typeof globalThis.magpie.options.set !== "function") {
    setMessage("配置桥接不可用，当前只能查看。", true)
    updateControls()
    return
  }

  Promise.resolve()
    .then(function () { return globalThis.magpie.options.get() })
    .then(function (current) {
      loaded = true
      applyOptions(current)
      setMessage(catalog.length ? "选择样式后保存。" : "目录未载入，无法更改样式。", !catalog.length)
    })
    .catch(function () {
      loaded = false
      setMessage("设置读取失败，请重新打开页面。", true)
      updateControls()
    })
})()
