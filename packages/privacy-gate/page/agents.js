/* Shared agent catalogue and small pure helpers for the ShyPie page and panel.
 * This file is loaded as a plain browser script; it makes no network calls. */
(function (root) {
  'use strict'

  var KNOWN = [
    { id: 'claude', name: 'Claude Code', group: 'Coding agents' },
    { id: 'claude-code', name: 'Claude Code (legacy id)', group: 'Coding agents' },
    { id: 'claude-desktop', name: 'Claude Desktop', group: 'Desktop apps' },
    { id: 'codex', name: 'Codex', group: 'Coding agents' },
    { id: 'dsh', name: 'DeepSeek Harness', group: 'Coding agents' },
    { id: 'gemini', name: 'Gemini CLI', group: 'Coding agents' },
    { id: 'qwen', name: 'Qwen Code', group: 'Coding agents' },
    { id: 'kimi', name: 'Kimi Code', group: 'Coding agents' },
    { id: 'grok', name: 'Grok', group: 'Coding agents' },
    { id: 'opencode', name: 'OpenCode', group: 'Coding agents' },
    { id: 'pi', name: 'Pi', group: 'Coding agents' },
    { id: 'omp', name: 'omp', group: 'Coding agents' },
    { id: 'cursor', name: 'Cursor', group: 'Desktop apps' },
    { id: 'copilot', name: 'Copilot CLI', group: 'Coding agents' },
    { id: 'aider', name: 'Aider', group: 'Coding agents' },
    { id: 'devin', name: 'Devin', group: 'Coding agents' }
  ]

  var KNOWN_IDS = {}
  for (var i = 0; i < KNOWN.length; i++) KNOWN_IDS[KNOWN[i].id] = true

  function normalizeId(value) {
    if (typeof value !== 'string') return ''
    var id = value.trim().toLowerCase()
    return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(id) ? id : ''
  }

  function normalizeList(value) {
    var out = []
    if (!Array.isArray(value)) return out
    for (var i = 0; i < value.length && out.length < 200; i++) {
      var id = normalizeId(value[i])
      if (id && out.indexOf(id) === -1) out.push(id)
    }
    return out
  }

  function customRows(ids) {
    var out = []
    for (var i = 0; i < ids.length; i++) {
      if (!KNOWN_IDS[ids[i]]) out.push({ id: ids[i], name: ids[i], group: 'Other agents' })
    }
    return out
  }

  function allRows(extraIds) {
    return KNOWN.concat(customRows(normalizeList(extraIds)))
  }

  root.ShyPieAgents = {
    KNOWN: KNOWN,
    KNOWN_IDS: KNOWN_IDS,
    normalizeId: normalizeId,
    normalizeList: normalizeList,
    customRows: customRows,
    allRows: allRows
  }
})(typeof globalThis !== 'undefined' ? globalThis : this)
