(function () {
  "use strict"

  var i18n = globalThis.OutputStrategyI18n
  var t = function (text) { return i18n ? i18n.t(text) : text }
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
  var lastMessage = ["Reading settings…", false]
  var catalog = readCatalog(globalThis.OUTPUT_STRATEGY_CATALOG)

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
    lastMessage = [text, isError === true]
    message.textContent = t(text)
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
    saveButton.textContent = t(saving ? "Saving…" : "Save changes")
  }

  function renderCatalogState() {
    byId("catalogState").textContent = catalog.length
      ? t("{n} styles; injected in catalog order.").replace("{n}", String(catalog.length))
      : t("Catalog not loaded")
  }

  function renderCatalog() {
    var checked = Object.create(null)
    catalog.forEach(function (style) {
      if (inputs[style.id]) checked[style.id] = inputs[style.id].checked === true
    })
    clear(list)
    inputs = Object.create(null)
    renderCatalogState()
    if (!catalog.length) {
      list.append(element("p", "empty-state", t("Catalog not loaded; style toggles unavailable.")))
      updateSelection()
      updateControls()
      return
    }

    catalog.forEach(function (style) {
      var input = element("input")
      var copy = element("span", "style-copy")
      var row = element("label", "style-row")
      input.type = "checkbox"
      input.id = "style-" + style.id
      input.name = style.id
      input.checked = checked[style.id] === true
      input.setAttribute("data-style-id", style.id)
      input.addEventListener("change", function () {
        dirty = true
        setMessage("Unsaved changes.")
        updateSelection()
        updateControls()
      })
      copy.append(element("span", "style-name", t(style.label)), element("span", "style-description", t(style.description)))
      row.setAttribute("for", input.id)
      row.append(copy, input)
      list.append(row)
      inputs[style.id] = input
    })
    updateSelection()
    updateControls()
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
    var styles = Object.assign({}, options.styles && typeof options.styles === "object" ? options.styles : {})
    catalog.forEach(function (style) { styles[style.id] = inputs[style.id].checked === true })
    var next = Object.assign({}, options, { styles: styles })
    saving = true
    setMessage("Saving…")
    updateControls()
    Promise.resolve()
      .then(function () { return globalThis.magpie.options.set(next) })
      .then(function (saved) {
        applyOptions(saved && typeof saved === "object" ? saved : next)
        setMessage("Saved.")
      })
      .catch(function () { setMessage("Could not save. Nothing was written; try again.", true) })
      .then(function () {
        saving = false
        updateControls()
      })
  }

  // The sandboxed frame has CSP form-action 'none'; call save directly.
  saveButton.addEventListener("click", save)
  form.addEventListener("submit", save)
  renderCatalog()
  if (i18n) i18n.onChange(function () {
    renderCatalog()
    setMessage(lastMessage[0], lastMessage[1])
  })

  var host = globalThis.magpie
  if (!host || !host.options || typeof host.options.get !== "function" || typeof host.options.set !== "function") {
    setMessage("Configuration bridge unavailable; view only.", true)
    updateControls()
    return
  }

  Promise.resolve()
    .then(function () { return host.options.get() })
    .then(function (current) {
      loaded = true
      applyOptions(current)
      setMessage(catalog.length ? "Pick styles and save." : "Catalog not loaded; styles cannot be changed.", !catalog.length)
    })
    .catch(function () {
      loaded = false
      setMessage("Could not read settings; reopen the page.", true)
      updateControls()
    })
})()
