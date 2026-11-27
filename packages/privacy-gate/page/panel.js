(function () {
  'use strict'

  var A = window.ShyPieAgents
  var P = window.ShyPiePolicy
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
      changedElsewhere: 'Changed elsewhere; reload.',
      protected: 'protected',
      unknown: 'Unknown agent',
      policy: 'Policy patterns are preserved on save.',
      policyBypassed: 'bypassed by policy'
    },
    zh: {
      title: '按 Agent 保护',
      lede: '关闭的 Agent 会完全绕过防护。',
      save: '保存',
      saved: '已保存',
      unsaved: '未保存',
      failed: '加载失败。',
      saveFailed: '保存失败。',
      changedElsewhere: '配置已更改，请重新加载。',
      protected: '受保护',
      unknown: '未知 Agent',
      policy: '策略模式会在保存时保留。',
      policyBypassed: '被策略绕过'
    }
  }

  var state = {
    exact: [],
    patterns: [],
    extra: [],
    protectUnknown: true,
    lang: 'en',
    dirty: false,
    saved: false,
    busy: false,
    error: '',
    loaded: { disabledAgents: [], protectUnknownAgent: true, extraAgents: [] }
  }

  function t(key) {
    return (COPY[state.lang] || COPY.en)[key] || COPY.en[key] || key
  }

  function setText(id, value) {
    var el = $(id)
    if (el) el.textContent = value
  }

  function clearError() {
    state.error = ''
  }

  function configure(options) {
    var source = options && typeof options === 'object' ? options : {}
    var split = P.split(source.disabledAgents)
    state.exact = split.exact
    state.patterns = split.patterns
    state.extra = A.normalizeList(source.extraAgents)
    for (var i = 0; i < split.exact.length; i++) {
      if (!A.KNOWN_IDS[split.exact[i]] && state.extra.indexOf(split.exact[i]) === -1) state.extra.push(split.exact[i])
    }
    state.protectUnknown = source.protectUnknownAgent !== false
    state.loaded = {
      disabledAgents: P.rawList(source.disabledAgents),
      protectUnknownAgent: state.protectUnknown,
      extraAgents: P.rawList(source.extraAgents)
    }
  }

  function patternFor(id) {
    return P.patternFor(state.patterns, id)
  }

  function isDisabled(id) {
    return state.exact.indexOf(id) !== -1 || patternFor(id) !== null
  }

  function setDisabled(id, disabled) {
    if (patternFor(id) !== null) return
    state.exact = state.exact.filter(function (item) { return item !== id })
    if (disabled) state.exact.push(id)
    clearError()
    state.dirty = true
    render()
  }

  function shownRows() {
    var out = []
    for (var i = 0; i < A.KNOWN.length; i++) {
      if (SHOWN.indexOf(A.KNOWN[i].id) !== -1 || isDisabled(A.KNOWN[i].id)) out.push(A.KNOWN[i])
    }
    var custom = A.customRows(state.extra)
    custom.sort(function (a, b) {
      var ad = isDisabled(a.id) ? 0 : 1
      var bd = isDisabled(b.id) ? 0 : 1
      return ad - bd
    })
    return out.concat(custom.slice(0, 3))
  }

  function count() {
    var rows = shownRows()
    var on = rows.filter(function (row) { return !isDisabled(row.id) }).length
    if (state.protectUnknown) on++
    return { on: on, total: rows.length + 1 }
  }

  function makeSwitch(id, checked, disabled, onToggle) {
    var button = document.createElement('button')
    button.type = 'button'
    button.className = 'switch'
    button.setAttribute('role', 'switch')
    button.setAttribute('aria-checked', checked ? 'true' : 'false')
    button.setAttribute('aria-label', id)
    button.disabled = disabled === true
    button.addEventListener('click', function () {
      if (button.disabled) return
      if (typeof onToggle === 'function') onToggle(button.getAttribute('aria-checked') !== 'true')
      else setDisabled(id, button.getAttribute('aria-checked') === 'true')
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
    var pattern = patternFor(row.id)
    var off = pattern !== null || state.exact.indexOf(row.id) !== -1
    id.textContent = row.id + (pattern !== null ? ' · ' + t('policyBypassed') : '')
    copy.appendChild(name)
    copy.appendChild(id)
    item.appendChild(badge)
    item.appendChild(copy)
    item.appendChild(makeSwitch(row.id, !off, pattern !== null || state.busy, function (enabled) {
      setDisabled(row.id, !enabled)
    }))
    if (pattern !== null) item.title = t('policyBypassed') + ': ' + String(pattern)
    return item
  }

  function render() {
    if (!A || !P) return
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
    unknown.appendChild(makeSwitch('unknown', state.protectUnknown, state.busy, function (on) {
      state.protectUnknown = on
      clearError()
      state.dirty = true
      render()
    }))
    list.appendChild(unknown)

    var problem = $('panel-patterns')
    problem.hidden = state.patterns.length === 0
    problem.textContent = state.patterns.length === 0 ? '' : t('policy')

    var c = count()
    setText('panel-count', c.on + ' / ' + c.total + ' ' + t('protected'))
    $('panel-save').disabled = !state.dirty || state.busy
    var status = $('panel-status')
    if (state.error) {
      status.textContent = state.error
      status.setAttribute('data-error', 'true')
    } else {
      status.textContent = state.dirty ? t('unsaved') : (state.saved ? t('saved') : '')
      status.removeAttribute('data-error')
    }
  }

  function save() {
    if (state.busy || !state.dirty) return
    state.busy = true
    clearError()
    render()
    var edit = {
      patterns: state.patterns,
      exact: state.exact,
      protectUnknown: state.protectUnknown,
      extra: state.extra
    }
    Promise.resolve(magpie.options.get()).then(function (current) {
      if (!P.sameAgentFields(current, state.loaded)) {
        var conflict = new Error('options changed elsewhere')
        conflict.conflict = true
        throw conflict
      }
      return magpie.options.set(P.mergeOptions(current, edit))
    }).then(function (saved) {
      configure(saved)
      state.busy = false
      state.dirty = false
      state.saved = true
      clearError()
      render()
    }).catch(function (error) {
      state.busy = false
      state.error = error && error.conflict ? t('changedElsewhere') : t('saveFailed')
      render()
    })
  }

  $('panel-save').addEventListener('click', save)

  state.saved = false
  clearError()
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
    state.error = t('failed')
    render()
  })
})()
