(function () {
  'use strict'

  var A = window.ShyPieAgents
  var $ = function (id) { return document.getElementById(id) }
  var SHOWN = ['claude', 'codex', 'dsh', 'gemini', 'qwen', 'kimi', 'opencode', 'cursor']
  var COPY = {
    en: {
      title: 'Agent protection',
      lede: 'Disabled agents bypass the gate entirely.',
      save: 'Save',
      saved: 'Saved',
      unsaved: 'Unsaved changes',
      failed: 'Could not load.',
      saveFailed: 'Could not save.',
      protected: 'protected',
      unknown: 'Unknown agent',
      other: 'Other agents'
    },
    zh: {
      title: '按 Agent 保护',
      lede: '关闭的 Agent 会完全绕过防护。',
      save: '保存',
      saved: '已保存',
      unsaved: '未保存',
      failed: '加载失败。',
      saveFailed: '保存失败。',
      protected: '受保护',
      unknown: '未知 Agent',
      other: '其他 Agent'
    }
  }

  var state = {
    options: {},
    disabled: [],
    extra: [],
    protectUnknown: true,
    lang: 'en',
    dirty: false,
    saved: false,
    busy: false
  }

  function t(key) {
    return (COPY[state.lang] || COPY.en)[key] || COPY.en[key] || key
  }

  function setText(id, value) {
    var el = $(id)
    if (el) el.textContent = value
  }

  function configure(options) {
    state.options = options && typeof options === 'object' ? options : {}
    state.disabled = A.normalizeList(state.options.disabledAgents)
    state.extra = A.normalizeList(state.options.extraAgents)
    state.protectUnknown = state.options.protectUnknownAgent !== false
  }

  function isDisabled(id) {
    return state.disabled.indexOf(id) !== -1
  }

  function setDisabled(id, off) {
    state.disabled = state.disabled.filter(function (item) { return item !== id })
    if (off) state.disabled.push(id)
    state.dirty = true
    render()
  }

  function shownRows() {
    var all = A.KNOWN
    var out = []
    for (var j = 0; j < all.length; j++) {
      if (SHOWN.indexOf(all[j].id) !== -1 || isDisabled(all[j].id)) out.push(all[j])
    }
    var custom = A.customRows(state.extra)
    return out.concat(custom.slice(0, 2))
  }

  function count() {
    var rows = shownRows()
    var on = rows.filter(function (row) { return !isDisabled(row.id) }).length
    if (state.protectUnknown) on++
    return { on: on, total: rows.length + 1 }
  }

  function makeSwitch(id, checked, onToggle) {
    var button = document.createElement('button')
    button.type = 'button'
    button.className = 'switch'
    button.setAttribute('role', 'switch')
    button.setAttribute('aria-checked', checked ? 'true' : 'false')
    button.setAttribute('aria-label', id)
    button.addEventListener('click', function () {
      var on = button.getAttribute('aria-checked') !== 'true'
      if (typeof onToggle === 'function') onToggle(on)
      else setDisabled(id, !on)
    })
    return button
  }

  function rowView(row) {
    var item = document.createElement('div')
    item.className = 'agent'
    item.setAttribute('role', 'listitem')
    var badge = document.createElement('span')
    badge.className = 'avatar'
    badge.textContent = String(row.name || row.id).slice(0, 2).toUpperCase()
    badge.setAttribute('aria-hidden', 'true')
    var copy = document.createElement('span')
    copy.className = 'agent-copy'
    var name = document.createElement('span')
    name.className = 'agent-name'
    name.textContent = row.name
    var id = document.createElement('span')
    id.className = 'agent-id'
    id.textContent = row.id
    copy.appendChild(name)
    copy.appendChild(id)
    item.appendChild(badge)
    item.appendChild(copy)
    item.appendChild(makeSwitch(row.id, !isDisabled(row.id)))
    return item
  }

  function render() {
    if (!A) return
    var list = $('panel-list')
    list.replaceChildren()
    var rows = shownRows()
    for (var i = 0; i < rows.length; i++) list.appendChild(rowView(rows[i]))
    var unknown = document.createElement('div')
    unknown.className = 'agent'
    unknown.setAttribute('role', 'listitem')
    var badge = document.createElement('span')
    badge.className = 'avatar'
    badge.textContent = '?'
    badge.setAttribute('aria-hidden', 'true')
    var copy = document.createElement('span')
    copy.className = 'agent-copy'
    var name = document.createElement('span')
    name.className = 'agent-name'
    name.textContent = t('unknown')
    copy.appendChild(name)
    unknown.appendChild(badge)
    unknown.appendChild(copy)
    unknown.appendChild(makeSwitch('unknown', state.protectUnknown, function (on) {
      state.protectUnknown = on
      state.dirty = true
      render()
    }))
    list.appendChild(unknown)

    var c = count()
    setText('panel-count', c.on + ' / ' + c.total + ' ' + t('protected'))
    $('panel-save').disabled = !state.dirty || state.busy
    if (!state.busy) setText('panel-status', state.dirty ? t('unsaved') : (state.saved ? t('saved') : ''))
  }

  function save() {
    if (state.busy || !state.dirty) return
    state.busy = true
    var next = Object.assign({}, state.options, {
      disabledAgents: state.disabled.slice(),
      protectUnknownAgent: state.protectUnknown !== false,
      extraAgents: state.extra.slice()
    })
    Promise.resolve(magpie.options.set(next)).then(function (saved) {
      state.options = saved && typeof saved === 'object' ? saved : next
      configure(state.options)
      state.dirty = false
      state.saved = true
      state.busy = false
      setText('panel-status', t('saved'))
      render()
    }).catch(function () {
      state.busy = false
      setText('panel-status', t('saveFailed'))
      render()
    })
  }

  if (typeof magpie.onAction === 'function') {
    magpie.onAction(function () { /* the panel has no per-agent action */ })
  }

  $('panel-save').addEventListener('click', save)

  state.saved = false
  Promise.resolve(magpie.ready).then(function (theme) {
    state.lang = theme && String(theme.lang).toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
    setText('panel-title', t('title'))
    setText('panel-lede', t('lede'))
    setText('panel-save', t('save'))
    return magpie.options.get()
  }).then(function (options) {
    configure(options)
    render()
  }).catch(function () {
    setText('panel-status', t('failed'))
  })
})()
