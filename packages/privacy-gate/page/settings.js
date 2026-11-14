/* Middleware settings shared by the ShyPie page.
 *
 * The page owns only the options listed here. Everything else in the plugin's
 * options object is preserved. No network, no imports. */
(function (root) {
  'use strict'

  var FIELDS = [
    { key: 'binaryPolicy', type: 'select', options: ['fail', 'guide'], default: 'fail' },
    { key: 'allowUnknownProtocol', type: 'bool', default: false },
    { key: 'allowModels', type: 'list', default: [] },
    { key: 'localModels', type: 'list', default: [] },
    { key: 'localProviders', type: 'list', default: [] },
    { key: 'guideTools', type: 'list', default: [] },
    { key: 'blobBase64Chars', type: 'number', min: 64, max: 1000000, default: 400 },
    { key: 'blobHexChars', type: 'number', min: 64, max: 1000000, default: 400 },
    { key: 'scanChars', type: 'number', min: 1000, max: 5000000, default: 200000 },
    { key: 'maxNodes', type: 'number', min: 1000, max: 5000000, default: 40000 },
    { key: 'maxDepth', type: 'number', min: 1, max: 200, default: 40 },
    { key: 'logMaxLines', type: 'number', min: 0, max: 500, default: 40 },
    { key: 'logEveryRows', type: 'number', min: 1, max: 100000, default: 50 }
  ]

  var BY_KEY = {}
  for (var i = 0; i < FIELDS.length; i++) BY_KEY[FIELDS[i].key] = FIELDS[i]

  function parseList(value) {
    if (Array.isArray(value)) value = value.join('\n')
    if (typeof value !== 'string') return []
    var parts = value.split(/[\n,]+/)
    var out = []
    for (var i = 0; i < parts.length && out.length < 200; i++) {
      var item = parts[i].trim()
      if (item !== '' && out.indexOf(item) === -1) out.push(item)
    }
    return out
  }

  function numberValue(raw, field) {
    if (typeof raw === 'number' && Number.isInteger(raw)) return raw
    var text = String(raw == null ? '' : raw).trim()
    if (text === '' || !/^-?\d+$/.test(text)) return null
    var value = Number(text)
    return Number.isSafeInteger(value) ? value : null
  }

  function fromOptions(options) {
    var source = options && typeof options === 'object' ? options : {}
    var values = {}
    var invalid = []
    for (var i = 0; i < FIELDS.length; i++) {
      var field = FIELDS[i]
      var raw = source[field.key]
      if (field.type === 'list') {
        if (raw === undefined) values[field.key] = []
        else if (Array.isArray(raw)) values[field.key] = parseList(raw)
        else {
          values[field.key] = []
          invalid.push(field.key)
        }
      } else if (field.type === 'bool') {
        values[field.key] = typeof raw === 'boolean' ? raw : field.default
      } else if (field.type === 'select') {
        values[field.key] = field.options.indexOf(raw) !== -1 ? raw : field.default
      } else {
        var n = numberValue(raw, field)
        values[field.key] = n === null || n < field.min || n > field.max ? field.default : n
      }
    }
    return { values: values, invalid: invalid }
  }

  function validate(values) {
    var errors = []
    for (var i = 0; i < FIELDS.length; i++) {
      var field = FIELDS[i]
      var value = values[field.key]
      if (field.type === 'list') {
        if (!Array.isArray(value) || value.length > 200) {
          errors.push({ key: field.key, message: 'Use at most 200 entries.' })
          continue
        }
        for (var j = 0; j < value.length; j++) {
          if (typeof value[j] !== 'string' || value[j].length === 0 || value[j].length >= 200) {
            errors.push({ key: field.key, message: 'Each entry must be a non-empty string under 200 characters.' })
            break
          }
        }
      } else if (field.type === 'select') {
        if (field.options.indexOf(value) === -1) errors.push({ key: field.key, message: 'Choose fail or guide.' })
      } else if (field.type === 'bool') {
        if (typeof value !== 'boolean') errors.push({ key: field.key, message: 'Choose on or off.' })
      } else {
        var n = numberValue(value, field)
        if (n === null || n < field.min || n > field.max) {
          errors.push({ key: field.key, message: 'Use a whole number from ' + field.min + ' to ' + field.max + '.' })
        } else {
          values[field.key] = n
        }
      }
    }
    return errors
  }

  function apply(current, values) {
    var next = Object.assign({}, current && typeof current === 'object' ? current : {})
    for (var i = 0; i < FIELDS.length; i++) {
      var field = FIELDS[i]
      var value = values[field.key]
      if (field.type === 'list') next[field.key] = parseList(value)
      else if (field.type === 'bool') next[field.key] = value === true
      else if (field.type === 'select') next[field.key] = field.options.indexOf(value) !== -1 ? value : field.default
      else {
        var n = numberValue(value, field)
        next[field.key] = n === null ? field.default : n
      }
    }
    return next
  }

  function same(current, snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false
    var now = fromOptions(current).values
    for (var i = 0; i < FIELDS.length; i++) {
      var key = FIELDS[i].key
      if (JSON.stringify(now[key]) !== JSON.stringify(snapshot[key])) return false
    }
    return true
  }

  root.ShyPieSettings = {
    FIELDS: FIELDS,
    BY_KEY: BY_KEY,
    parseList: parseList,
    fromOptions: fromOptions,
    validate: validate,
    apply: apply,
    same: same
  }
})(typeof globalThis !== 'undefined' ? globalThis : this)
