(function () {
  'use strict'

  var A = window.ShyPieAgents
  var P = window.ShyPiePolicy
  var $ = function (id) { return document.getElementById(id) }

  var COPY = {
    en: {
      kicker: 'ShyPie Filter',
      title: 'Per-agent protection',
      lede: 'Choose which Magpie agents ShyPie protects. A disabled agent bypasses the gate entirely.',
      search: 'Search agents',
      reload: 'Reload',
      save: 'Save changes',
      saved: 'Saved',
      unsaved: 'Unsaved changes',
      loading: 'Loading agents…',
      failed: 'Could not read the ShyPie options.',
      saveFailed: 'Could not save. Try again.',
      changedElsewhere: 'These options changed elsewhere. Reload before saving.',
      protected: 'protected',
      bypassed: 'bypassed',
      policyBypassed: 'bypassed by policy',
      unknown: 'Unknown / unclassified agent',
      unknownHint: 'Applies when Magpie cannot identify the calling agent.',
      other: 'Other agents',
      unknownGroup: 'Unclassified',
      addTitle: 'Add another agent id',
      addHint: 'For a plugin-added or not-yet-listed agent. You can also use the agent row menu on the Agents page.',
      addPlaceholder: 'e.g. my-agent',
      add: 'Add',
      addError: 'Use a lowercase id like my-agent.',
      empty: 'No agents match that search.',
      warningAll: 'All agents are bypassed. ShyPie is not protecting any request.',
      warningSome: 'A bypassed agent sends its requests without ShyPie.',
      patternsTitle: 'Policy patterns',
      patternsHint: 'Raw entries in disabledAgents that this page cannot show as a switch. They are preserved on save; edit them with the JSON options or CLI.',
      patternsPreserved: 'Patterns are preserved on save.'
    },
    zh: {
      kicker: 'ShyPie 防护',
      title: '按 Agent 保护',
      lede: '选择哪些 Magpie Agent 受 ShyPie 保护。关闭的 Agent 会完全绕过防护。',
      search: '搜索 Agent',
      reload: '重新加载',
      save: '保存更改',
      saved: '已保存',
      unsaved: '未保存的更改',
      loading: '正在加载 Agent…',
      failed: '无法读取 ShyPie 配置。',
      saveFailed: '保存失败，请重试。',
      changedElsewhere: '配置已在其他位置更改，请重新加载后再保存。',
      protected: '受保护',
      bypassed: '已绕过',
      policyBypassed: '被策略绕过',
      unknown: '未知 / 未分类 Agent',
      unknownHint: '当 Magpie 无法识别调用方 Agent 时适用。',
      other: '其他 Agent',
      unknownGroup: '未分类',
      addTitle: '添加其他 Agent ID',
      addHint: '用于插件添加或尚未列出的 Agent；也可以使用 Agents 页面中的 Agent 行菜单。',
      addPlaceholder: '例如 my-agent',
      add: '添加',
      addError: '请使用 my-agent 这样的小写 ID。',
      empty: '没有匹配的 Agent。',
      warningAll: '所有 Agent 都已绕过，ShyPie 当前不保护任何请求。',
      warningSome: '已绕过的 Agent 会不经过 ShyPie 直接发送请求。',
      patternsTitle: '策略模式',
      patternsHint: 'disabledAgents 中无法以开关显示的原始条目。保存时会原样保留；请通过 JSON 配置或 CLI 编辑。',
      patternsPreserved: '保存时会保留策略模式。'
    }
  }

  var state = {
    options: {},
    exact: [],
    patterns: [],
    extra: [],
    protectUnknown: true,
    rows: [],
    search: '',
    target: '',
    dirty: false,
    saved: false,
    busy: false,
    error: '',
    loaded: { disabledAgents: [], protectUnknownAgent: true, extraAgents: [] },
    pendingAction: null,
    lang: 'en'
  }

  function t(key) {
    return (COPY[state.lang] || COPY.en)[key] || COPY.en[key] || key
  }

  function setText(id, value) {
    var el = $(id)
    if (el) el.textContent = value
  }

  function uniqueList(values) {
    var out = []
    for (var i = 0; i < values.length; i++) {
      if (values[i] && out.indexOf(values[i]) === -1) out.push(values[i])
    }
    return out
  }

  function clearError() {
    state.error = ''
  }

  function applyLanguage() {
    var html = document.documentElement
    html.lang = state.lang === 'zh' ? 'zh-CN' : 'en'
    document.title = t('kicker')
    var map = {
      'search-label': 'search',
      'add-title': 'addTitle',
      'add-hint': 'addHint',
      'add': 'add',
      'save': 'save',
      'reload': 'reload',
      'kicker': 'kicker',
      'title': 'title',
      'lede': 'lede',
      'patterns-title': 'patternsTitle',
      'patterns-hint': 'patternsHint'
    }
    Object.keys(map).forEach(function (id) { setText(id, t(map[id])) })
    var search = $('search')
    if (search) search.placeholder = t('search')
    var addInput = $('add-id')
    if (addInput) addInput.placeholder = t('addPlaceholder')
    var error = $('add-error')
    if (error) error.textContent = t('addError')
    var empty = $('empty')
    if (empty) empty.textContent = t('empty')
  }

  function ensureExtra(id) {
    if (A.KNOWN_IDS[id] || state.extra.indexOf(id) !== -1) return false
    state.extra.push(id)
    return true
  }

  function configure(options) {
    state.options = options && typeof options === 'object' ? options : {}
    var split = P.split(state.options.disabledAgents)
    state.exact = split.exact
    state.patterns = split.patterns
    state.extra = A.normalizeList(state.options.extraAgents)
    for (var i = 0; i < split.exact.length; i++) ensureExtra(split.exact[i])
    state.protectUnknown = state.options.protectUnknownAgent !== false
    state.rows = A.allRows(state.extra)
    state.loaded = {
      disabledAgents: P.rawList(state.options.disabledAgents),
      protectUnknownAgent: state.protectUnknown,
      extraAgents: P.rawList(state.options.extraAgents)
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
    var next = state.exact.filter(function (item) { return item !== id })
    if (disabled) next.push(id)
    state.exact = uniqueList(next)
    clearError()
    state.dirty = true
    render()
  }

  function protectedCount() {
    var total = state.rows.length + 1
    var on = state.rows.filter(function (row) { return !isDisabled(row.id) }).length
    if (state.protectUnknown) on++
    return { on: on, total: total }
  }

  function avatar(name) {
    var parts = String(name || '?').split(/[\s._-]+/).filter(Boolean)
    return (parts.length > 1 ? parts[0].charAt(0) + parts[1].charAt(0) : String(name || '?').slice(0, 2)).toUpperCase()
  }

  function makeSwitch(label, checked, onChange, disabled) {
    var button = document.createElement('button')
    button.type = 'button'
    button.className = 'switch'
    button.setAttribute('role', 'switch')
    button.setAttribute('aria-checked', checked ? 'true' : 'false')
    button.setAttribute('aria-label', label)
    button.disabled = disabled === true
    button.addEventListener('click', function () {
      if (button.disabled) return
      onChange(button.getAttribute('aria-checked') !== 'true')
    })
    return button
  }

  function agentRow(row) {
    var item = document.createElement('div')
    item.className = 'agent' + (state.target === row.id ? ' is-target' : '')
    item.setAttribute('role', 'listitem')
    var badge = document.createElement('span')
    badge.className = 'avatar'
    badge.textContent = avatar(row.name)
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
    id.textContent = row.id + ' · ' + (pattern !== null ? t('policyBypassed') : (off ? t('bypassed') : t('protected')))
    copy.appendChild(name)
    copy.appendChild(id)
    item.appendChild(badge)
    item.appendChild(copy)
    item.appendChild(makeSwitch(
      row.id,
      !off,
      function (enabled) { setDisabled(row.id, !enabled) },
      pattern !== null || state.busy
    ))
    if (pattern !== null) item.title = t('policyBypassed') + ': ' + String(pattern)
    return item
  }

  function appendGroup(parent, title, rows) {
    if (rows.length === 0) return
    var group = document.createElement('section')
    group.className = 'group'
    var heading = document.createElement('h2')
    heading.className = 'group-title'
    heading.textContent = title
    group.appendChild(heading)
    for (var i = 0; i < rows.length; i++) group.appendChild(agentRow(rows[i]))
    parent.appendChild(group)
  }

  function renderPatterns() {
    var section = $('patterns')
    var list = $('pattern-list')
    if (!section || !list) return
    section.hidden = state.patterns.length === 0
    list.replaceChildren()
    for (var i = 0; i < state.patterns.length; i++) {
      var item = document.createElement('li')
      var value = state.patterns[i]
      item.textContent = typeof value === 'string' ? value : JSON.stringify(value)
      list.appendChild(item)
    }
  }

  function render() {
    if (!A || !P) return
    var query = state.search.trim().toLowerCase()
    var visible = state.rows.filter(function (row) {
      return query === '' || row.id.indexOf(query) !== -1 || row.name.toLowerCase().indexOf(query) !== -1
    })
    var groups = {}
    var order = []
    for (var i = 0; i < visible.length; i++) {
      var group = visible[i].group || t('other')
      if (!groups[group]) { groups[group] = []; order.push(group) }
      groups[group].push(visible[i])
    }
    var list = $('list')
    list.replaceChildren()
    for (var g = 0; g < order.length; g++) appendGroup(list, order[g], groups[order[g]])
    var showUnknown = query === '' || t('unknown').toLowerCase().indexOf(query) !== -1 || 'unknown'.indexOf(query) !== -1
    if (showUnknown) appendUnknown(list)
    $('empty').hidden = visible.length > 0 || showUnknown
    renderPatterns()

    var counts = protectedCount()
    setText('count', counts.on + ' / ' + counts.total + ' ' + t('protected'))
    var warning = $('warning')
    if (counts.on === 0) {
      warning.textContent = t('warningAll')
      warning.hidden = false
    } else if (counts.on < counts.total) {
      warning.textContent = t('warningSome')
      warning.hidden = false
    } else {
      warning.hidden = true
    }
    $('save').disabled = !state.dirty || state.busy
    $('reload').disabled = state.busy
    $('add-agent').disabled = state.busy
    $('add-id').disabled = state.busy
    var status = $('status')
    if (state.error) {
      status.textContent = state.error
      status.setAttribute('data-error', 'true')
    } else {
      status.textContent = state.dirty ? t('unsaved') : (state.saved ? t('saved') : '')
      status.removeAttribute('data-error')
    }
  }

  function appendUnknown(parent) {
    var group = document.createElement('section')
    group.className = 'group'
    var heading = document.createElement('h2')
    heading.className = 'group-title'
    heading.textContent = t('unknownGroup')
    group.appendChild(heading)
    var item = document.createElement('div')
    item.className = 'agent' + (state.target === 'unknown' ? ' is-target' : '')
    item.setAttribute('role', 'listitem')
    var badge = document.createElement('span')
    badge.className = 'avatar'
    badge.textContent = '?'
    badge.setAttribute('aria-hidden', 'true')
    var copy = document.createElement('span')
    copy.className = 'agent-copy'
    var name = document.createElement('span')
    name.className = 'agent-name'
    name.textContent = t('unknown')
    var hint = document.createElement('span')
    hint.className = 'agent-id'
    hint.textContent = t('unknownHint')
    copy.appendChild(name)
    copy.appendChild(hint)
    item.appendChild(badge)
    item.appendChild(copy)
    item.appendChild(makeSwitch(t('unknown'), state.protectUnknown, function (enabled) {
      state.protectUnknown = enabled
      clearError()
      state.dirty = true
      render()
    }, state.busy))
    group.appendChild(item)
    parent.appendChild(group)
  }

  function addAgent() {
    if (state.busy) return
    var input = $('add-id')
    var error = $('add-error')
    var id = A.normalizeId(input.value)
    if (!id) {
      error.hidden = false
      input.focus()
      return
    }
    error.hidden = true
    var added = ensureExtra(id)
    state.rows = A.allRows(state.extra)
    state.search = ''
    $('search').value = ''
    state.target = id
    clearError()
    if (added) state.dirty = true
    input.value = ''
    render()
    focusTarget()
  }

  function focusTarget() {
    var match = $('list').querySelector('.is-target')
    if (!match) return
    var control = match.querySelector('.switch:not(:disabled)')
    ;(control || match).focus()
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

  function focusAction(action) {
    if (state.busy) return
    var agent = action && action.agent
    if (!agent || typeof agent.id !== 'string') return
    var id = A.normalizeId(agent.id)
    if (!id) return
    var added = ensureExtra(id)
    state.rows = A.allRows(state.extra)
    state.search = ''
    $('search').value = ''
    state.target = id
    var named = state.rows.filter(function (row) { return row.id === id })[0]
    if (named && typeof agent.name === 'string' && agent.name.trim() !== '') named.name = agent.name.trim()
    if (added) {
      clearError()
      state.dirty = true
    }
    render()
    focusTarget()
  }

  function load() {
    state.saved = false
    clearError()
    setText('status', t('loading'))
    Promise.resolve(magpie.ready).then(function (theme) {
      state.lang = theme && String(theme.lang).toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
      applyLanguage()
      return magpie.options.get()
    }).then(function (options) {
      configure(options)
      render()
      if (state.pendingAction) {
        focusAction(state.pendingAction)
        state.pendingAction = null
      }
    }).catch(function () {
      state.error = t('failed')
      render()
    })
  }

  $('search').addEventListener('input', function (event) {
    state.search = event.target.value || ''
    render()
  })
  $('reload').addEventListener('click', function () {
    state.dirty = false
    load()
  })
  $('add-agent').addEventListener('click', addAgent)
  $('add-id').addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !state.busy) addAgent()
  })
  $('save').addEventListener('click', save)

  if (typeof magpie.onAction === 'function') {
    magpie.onAction(function (action) {
      if (state.rows.length > 0) focusAction(action)
      else state.pendingAction = action
    })
  }

  load()
})()
