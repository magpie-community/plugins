/* Policy merging for the ShyPie page and panel.
 *
 * `disabledAgents` is a middleware policy list, not just a catalogue of ids:
 * it may contain globs and values the UI cannot represent. Those entries are
 * kept verbatim and merged back on save. This file is a plain browser script
 * and makes no network calls. */
(function (root) {
  'use strict'

  var A = root.ShyPieAgents

  function rawList(value) {
    return Array.isArray(value) ? value.slice(0, 200) : []
  }

  function isExactId(value) {
    return typeof value === 'string' && A.normalizeId(value) === value
  }

  function split(disabled) {
    var exact = []
    var patterns = []
    var raw = rawList(disabled)
    for (var i = 0; i < raw.length; i++) {
      if (isExactId(raw[i])) {
        if (exact.indexOf(raw[i]) === -1) exact.push(raw[i])
      } else {
        patterns.push(raw[i])
      }
    }
    return { exact: exact, patterns: patterns }
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  // Mirrors the middleware's matchesAny: case-sensitive, with '*' spanning
  // anything and a trailing '/*' treated as a path prefix.
  function matches(pattern, agent) {
    if (typeof pattern !== 'string' || typeof agent !== 'string') return false
    if (pattern === agent || pattern === '*') return true
    if (pattern.endsWith('/*') && agent.startsWith(pattern.slice(0, -1))) return true
    if (pattern.indexOf('*') === -1) return false
    var source = pattern.split('*').map(escapeRegExp).join('.*')
    return new RegExp('^' + source + '$').test(agent)
  }

  function patternFor(patterns, agent) {
    for (var i = 0; i < patterns.length; i++) {
      if (matches(patterns[i], agent)) return patterns[i]
    }
    return null
  }

  function unique(values) {
    var out = []
    for (var i = 0; i < values.length; i++) {
      if (typeof values[i] === 'string' && values[i] !== '' && out.indexOf(values[i]) === -1) out.push(values[i])
    }
    return out
  }

  function mergeDisabled(patterns, exact) {
    return rawList(patterns).concat(unique(rawList(exact)))
  }

  function mergeOptions(current, edit) {
    return Object.assign({}, current && typeof current === 'object' ? current : {}, {
      disabledAgents: mergeDisabled(edit.patterns, edit.exact),
      protectUnknownAgent: edit.protectUnknown !== false,
      extraAgents: unique(rawList(edit.extra))
    })
  }

  function sameAgentFields(current, loaded) {
    if (!current || typeof current !== 'object' || !loaded || typeof loaded !== 'object') return false
    var currentDisabled = JSON.stringify(rawList(current.disabledAgents))
    var loadedDisabled = JSON.stringify(rawList(loaded.disabledAgents))
    if (currentDisabled !== loadedDisabled) return false
    var currentUnknown = current.protectUnknownAgent !== false
    var loadedUnknown = loaded.protectUnknownAgent !== false
    if (currentUnknown !== loadedUnknown) return false
    return JSON.stringify(rawList(current.extraAgents)) === JSON.stringify(rawList(loaded.extraAgents))
  }

  root.ShyPiePolicy = {
    rawList: rawList,
    isExactId: isExactId,
    split: split,
    matches: matches,
    patternFor: patternFor,
    mergeDisabled: mergeDisabled,
    mergeOptions: mergeOptions,
    sameAgentFields: sameAgentFields
  }
})(typeof globalThis !== 'undefined' ? globalThis : this)
