// OpenAI tools ⇄ Quick text convention.
//
// Quick's bidi protocol has no client-tool channel: its agent runtime owns the
// tool loop and executes ITS tools server-side (verified live — tool_start/
// tool_arguments/tool_result events, message_complete.tool_calls stays empty).
// But the underlying model will happily emit a caller-defined convention as
// plain text when the instruction is strong and inline (verified: a MANDATORY
// block in the user text produced exactly `<tool_call>{json}</tool_call>`).
//
// So we inject tool specs + rules into the message text, parse
// <tool_call>{"name":…,"arguments":{…}}</tool_call> blocks out of the streamed
// text, and surface them as OpenAI tool_calls. Results come back as role:'tool'
// messages, rendered into the next turn's text by renderDelta.

import { byteLen } from './translate.mjs'

/** OpenAI tools[] → compact spec list (function tools only, deduplicated by name). */
export function normalizeTools(tools) {
  if (!Array.isArray(tools)) return []
  const byName = new Map()
  for (const t of tools) {
    if (t?.type && t.type !== 'function') continue
    const fn = t?.function ?? t
    if (!fn || typeof fn.name !== 'string' || !fn.name) continue
    // OpenAI uses `parameters`; Anthropic-style shims may send `input_schema`.
    const schema = fn.parameters ?? fn.input_schema
    byName.set(fn.name, {
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters: schema && typeof schema === 'object' ? schema : { type: 'object', properties: {} },
    })
  }
  return [...byName.values()]
}

function toolSpecLine(t) {
  const params = JSON.stringify(boundedParameters(t))
  return `- ${t.name}: ${t.description || '(no description)'}\n  parameters: ${params}`
}

// JSON-Schema annotation keywords that cost bytes but carry no structure.
const SCHEMA_ANNOTATIONS = new Set([
  'description', 'title', 'examples', 'example', 'default', '$comment',
  'deprecated', 'readOnly', 'writeOnly', 'markdownDescription',
])
const SCHEMA_NESTED = new Set(['properties', 'patternProperties', '$defs', 'definitions'])
const SCHEMA_SINGLE = new Set(['items', 'additionalProperties', 'contains', 'propertyNames', 'if', 'then', 'else', 'not'])
const SCHEMA_ARRAY = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems'])

/** Strip annotation keywords recursively; keeps types/required/enum/structure. */
export function slimSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 8) return schema
  const out = {}
  for (const [k, v] of Object.entries(schema)) {
    if (SCHEMA_ANNOTATIONS.has(k)) continue
    if (SCHEMA_NESTED.has(k) && v && typeof v === 'object') {
      out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, slimSchema(pv, depth + 1)]))
    } else if (SCHEMA_SINGLE.has(k) && v && typeof v === 'object') {
      out[k] = slimSchema(v, depth + 1)
    } else if (SCHEMA_ARRAY.has(k) && Array.isArray(v)) {
      out[k] = v.map((x) => slimSchema(x, depth + 1))
    } else {
      out[k] = v
    }
  }
  return out
}

/** Per-tool schema cap: beyond this, degrade to a bare object schema. */
const SCHEMA_CAP = 3072

function boundedParameters(t) {
  const slim = slimSchema(t.parameters)
  const json = JSON.stringify(slim)
  if (byteLen(json) <= SCHEMA_CAP) return slim
  // Still too big: keep only the top-level shape so the model knows it takes an object.
  const required = Array.isArray(t.parameters?.required) ? t.parameters.required : []
  return { type: 'object', properties: {}, ...(required.length ? { required } : {}) }
}

function compactDescription(desc, maxChars = 160) {
  const s = String(desc || '').replace(/\s+/g, ' ').trim()
  if (!s) return '(no description)'
  return s.length > maxChars ? `${s.slice(0, maxChars - 1)}…` : s
}

function formatType(schema, depth = 0) {
  if (!schema || typeof schema !== 'object') return 'any'
  if (Array.isArray(schema.enum) && schema.enum.length) {
    const vals = schema.enum.slice(0, 6).map((v) => JSON.stringify(v))
    if (schema.enum.length > 6) vals.push('…')
    return vals.join('|')
  }
  const union = schema.anyOf || schema.oneOf
  if (Array.isArray(union) && union.length && depth < 2) {
    return union.slice(0, 4).map((x) => formatType(x, depth + 1)).join('|')
  }
  const t = Array.isArray(schema.type) ? schema.type.join('|') : schema.type
  if (t === 'array' || schema.items) {
    return `${depth < 2 && schema.items ? formatType(schema.items, depth + 1) : 'any'}[]`
  }
  if ((t === 'object' || schema.properties) && schema.properties && typeof schema.properties === 'object' && depth < 2) {
    const req = new Set(Array.isArray(schema.required) ? schema.required : [])
    const entries = Object.entries(schema.properties)
    const parts = entries.slice(0, 10).map(([k, v]) => `${k}${req.has(k) ? '!' : '?'}:${formatType(v, depth + 1)}`)
    if (entries.length > 10) parts.push('…')
    return `{${parts.join(',')}}`
  }
  return t || 'any'
}

/** Compact typed signature preserving all parameter names, required (!), types and enums. */
export function compactToolLine(t) {
  const props = t.parameters?.properties && typeof t.parameters.properties === 'object'
    ? t.parameters.properties
    : {}
  const req = new Set(Array.isArray(t.parameters?.required) ? t.parameters.required : [])
  const params = Object.entries(props)
    .map(([k, v]) => `${k}${req.has(k) ? '!' : '?'}: ${formatType(v, 0)}`)
    .join(', ')
  return `- ${t.name}(${params}): ${compactDescription(t.description)}`
}

/**
 * The instruction block prepended to the text we send upstream.
 * @param {Array} tools normalized tools (may be empty → returns '')
 * @param {string|object} [toolChoice] body.tool_choice
 */
// Quick rejects user_message.text over 64 KB; a huge toolset alone can eat
// most of that, so the preamble degrades: full JSON schema → compact typed
// signatures (keeps all parameter names/types) → lite (name+desc) → minimal.
const PREAMBLE_CAP = 36 * 1024

function forcedRule(tools, toolChoice) {
  // OpenAI: 'auto'|'required'|'none'|{type:'function',function:{name}}
  // Anthropic-style shims: {type:'auto'|'any'|'none'|'tool', name?}
  const tc = typeof toolChoice === 'object' && toolChoice !== null ? toolChoice : null
  const openAiName = tc?.function?.name
  const anthropicName = tc?.type === 'tool' ? tc.name : undefined
  const forced = openAiName ?? anthropicName
    ?? (toolChoice === 'required' || tc?.type === 'any' ? true : false)
  const only = typeof forced === 'string' ? tools.filter((t) => t.name === forced) : tools
  const shown = only.length ? only : tools
  const must = forced
    ? only.length === 1 && typeof forced === 'string'
      ? `This request requires the client tool "${forced}" — reply with only its <tool_call> block.`
      : 'This request requires a client tool — reply with <tool_call> block(s) only.'
    : ''
  return { shown, must }
}

/** Short reminder for reused threads where full tool specs were sent on turn 1. */
export function buildToolReminder(tools, toolChoice) {
  if (!tools.length) return ''
  const { must } = forcedRule(tools, toolChoice)
  return [
    '[Client tools from earlier in this thread are still active. Reply with ONLY <tool_call>{"name":"<tool_name>","arguments":{...}}</tool_call> when calling one; otherwise answer directly.]',
    must,
  ].filter(Boolean).join('\n')
}

export function buildToolPreamble(tools, toolChoice, { compact = false, lite = false, minimal = false } = {}) {
  if (!tools.length) return ''
  const { shown, must } = forcedRule(tools, toolChoice)
  const assemble = (specs, header) => [
    '[Client tool calling]',
    'The application you are assisting exposes the tools below; it executes them on the user\'s machine and returns each result as a [tool_result …] message.',
    'This channel has no native function-calling API — the <tool_call> marker below is the only way to invoke these tools.',
    'When the task needs one of them, reply with ONLY a block in this format (no other text):',
    '<tool_call>{"name":"<tool_name>","arguments":{<json arguments>}}</tool_call>',
    'Guidelines:',
    '- one block per call; several blocks are allowed for parallel calls;',
    '- "arguments" is a JSON object matching the parameters schema (! = required);',
    '- after a [tool_result …] message arrives, continue the task in plain text;',
    must,
    header,
    specs,
  ].filter(Boolean).join('\n')
  if (minimal) {
    return assemble(shown.map((t) => t.name).join(', '), 'Tools provided by the client (names only):')
  }
  const compactSpecs = shown.map(compactToolLine).join('\n')
  const compactHeader = 'Tools provided by the client (compact signatures; ! = required):'
  const liteSpecs = shown.map((t) => `- ${t.name}: ${compactDescription(t.description)}`).join('\n')
  const liteHeader = 'Tools provided by the client (parameter schemas omitted — use the tool name and reasonable arguments):'
  if (lite) return assemble(liteSpecs, liteHeader)
  if (compact) return assemble(compactSpecs, compactHeader)
  let out = assemble(shown.map(toolSpecLine).join('\n'), 'Tools provided by the client:')
  if (byteLen(out) > PREAMBLE_CAP) {
    // Prefer compact typed signatures so parameter names and types stay intact.
    out = assemble(compactSpecs, compactHeader)
  }
  if (byteLen(out) > PREAMBLE_CAP) {
    out = assemble(liteSpecs, liteHeader)
  }
  return out
}

const SHELL_TOOL = /^(bash|shell|sh|zsh|powershell|cmd|exec|execute_command|run_terminal_command|run_terminal_cmd|terminal)$/i
const CMD_KEY = /^(command|cmd|input|script)$/i
const TOOL_ALIASES = [
  { quick: /^(read_file|view_file|cat|open_file)$/i, client: /^(read|read_file|view_file|get_file)$/i, argAliases: { path: ['file_path', 'filePath', 'path', 'filename', 'target_file'] } },
  { quick: /^(write_file|create_file|save_file)$/i, client: /^(write|write_file|create_file|save_file)$/i, argAliases: { path: ['file_path', 'filePath', 'path', 'filename'], content: ['content', 'text', 'code'] } },
  { quick: /^(edit_file|replace_in_file|patch_file|str_replace)$/i, client: /^(edit|edit_file|replace_file_content|str_replace)$/i, argAliases: { path: ['file_path', 'filePath', 'path'], old_string: ['old_string', 'old_str', 'target', 'search'], new_string: ['new_string', 'new_str', 'replacement', 'replace'] } },
  { quick: /^(search_files|grep|grep_search|ripgrep|find_in_files)$/i, client: /^(grep|grep_search|search_files|ripgrep)$/i, argAliases: { pattern: ['pattern', 'query', 'regex', 'search'], path: ['path', 'directory', 'dir', 'cwd'] } },
  { quick: /^(list_files|glob|find_files|ls)$/i, client: /^(glob|list_files|find_by_name|list_dir)$/i, argAliases: { pattern: ['pattern', 'glob'], path: ['path', 'directory', 'dir', 'cwd'] } },
]

export function argObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch { /* not json */ }
  }
  return {}
}

/** The client's shell tool, if the request declared one. */
export function clientShellTool(tools) {
  return tools.find((t) => SHELL_TOOL.test(t.name))
    || null
}

/**
 * Quick asks to run one of its own tools (`tool_start`). Hand it to the
 * matching client tool so the command runs on the user's machine.
 * Returns `{ name, arguments }` or null when nothing local can run it.
 */
export function mapQuickTool(quickName, rawArgs, clientTools) {
  const args = argObject(rawArgs)
  const name = String(quickName || '')
  const exact = clientTools.find((t) => t.name === name)
    || clientTools.find((t) => t.name.toLowerCase() === name.toLowerCase())
  const shell = !exact && SHELL_TOOL.test(name)
    ? clientShellTool(clientTools)
    : null
  const aliasRule = !exact && !shell
    ? TOOL_ALIASES.find((r) => r.quick.test(name))
    : null
  const aliased = aliasRule ? clientTools.find((t) => aliasRule.client.test(t.name)) : null
  const tool = exact || shell || aliased
  if (!tool) return null
  const props = tool.parameters?.properties && typeof tool.parameters.properties === 'object'
    ? tool.parameters.properties
    : {}
  const keys = Object.keys(props)
  const command = args.command || args.cmd || args.input || args.script || ''
  if (!keys.length) {
    if (shell) {
      return { name: tool.name, arguments: command && !args.command ? { ...args, command } : (Object.keys(args).length ? args : { command }) }
    }
    return { name: tool.name, arguments: args }
  }
  const out = {}
  for (const key of keys) {
    if (Object.hasOwn(args, key) && args[key] != null) out[key] = args[key]
  }
  if (aliasRule) {
    for (const group of Object.values(aliasRule.argAliases)) {
      const targetKey = keys.find((k) => group.some((g) => g.toLowerCase() === k.toLowerCase()))
      if (!targetKey || out[targetKey] != null) continue
      const srcKey = Object.keys(args).find((k) => group.some((g) => g.toLowerCase() === k.toLowerCase()) && args[k] != null)
      if (srcKey) out[targetKey] = args[srcKey]
    }
    const req = Array.isArray(tool.parameters?.required) ? tool.parameters.required : []
    if (req.some((k) => out[k] == null)) return null
    return Object.keys(out).length ? { name: tool.name, arguments: out } : null
  }
  const hasCmd = Object.keys(out).some((k) => CMD_KEY.test(k))
  if (!hasCmd && command) {
    const key = keys.find((k) => CMD_KEY.test(k))
    if (!key) {
      if (!exact || !Object.keys(out).length) return null
    } else {
      out[key] = command
    }
  }
  return { name: tool.name, arguments: out }
}

const OPEN_TAG = '<tool_call>'
const CLOSE_TAG = '</tool_call>'

/** Longest suffix of `buf` that is a proper prefix of `tag` (0 if none). */
function heldPrefixLen(buf, tag) {
  const max = Math.min(buf.length, tag.length - 1)
  for (let k = max; k >= 1; k--) {
    if (buf.endsWith(tag.slice(0, k))) return k
  }
  return 0
}

/** Advance JSON string-literal state across `chunk` so </tool_call> inside a string value is not treated as a close tag. */
function findUnquotedCloseTag(str, startIdx, state) {
  let { inStr, esc } = state
  let i = startIdx
  const n = str.length
  const closeLen = CLOSE_TAG.length
  while (i < n) {
    if (!inStr && str[i] === '<') {
      if (i + closeLen > n) {
        // Potential partial </tool_call> split across deltas — stop before '<'.
        if (CLOSE_TAG.startsWith(str.slice(i))) {
          state.inStr = inStr
          state.esc = esc
          return { found: -1, safeEnd: i }
        }
      } else if (str.startsWith(CLOSE_TAG, i)) {
        state.inStr = false
        state.esc = false
        return { found: i, safeEnd: i }
      }
    }
    const ch = str[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
    } else if (ch === '"') {
      inStr = true
    }
    i++
  }
  state.inStr = inStr
  state.esc = esc
  return { found: -1, safeEnd: n }
}

/**
 * Incremental parser: feed text_delta strings, get back visible text and
 * completed tool calls. Blocks split across deltas are handled — including a
 * tag split mid-token (`<` + `tool_call>…`) and literal `</tool_call>` inside
 * JSON string arguments. A dangling <tool_call> at end() is reported via `dropped`.
 */
export function createToolCallParser({ allowedNames } = {}) {
  let buf = ''
  let inBlock = false
  let blockJson = ''
  let scanState = { inStr: false, esc: false }
  let dropped = false
  const pending = [] // parsed calls waiting for id assignment

  const drain = () => {
    const text = []
    const calls = []
    for (;;) {
      if (!inBlock) {
        const idx = buf.indexOf(OPEN_TAG)
        if (idx === -1) {
          // Hold back a suffix that could be the start of <tool_call>.
          const hold = heldPrefixLen(buf, OPEN_TAG)
          text.push(buf.slice(0, buf.length - hold))
          buf = buf.slice(buf.length - hold)
          break
        }
        text.push(buf.slice(0, idx))
        buf = buf.slice(idx + OPEN_TAG.length)
        inBlock = true
        blockJson = ''
        scanState = { inStr: false, esc: false }
        continue
      }
      const res = findUnquotedCloseTag(buf, 0, scanState)
      if (res.found === -1) {
        blockJson += buf.slice(0, res.safeEnd)
        buf = buf.slice(res.safeEnd)
        break
      }
      blockJson += buf.slice(0, res.found)
      buf = buf.slice(res.found + CLOSE_TAG.length)
      inBlock = false
      const call = parseCall(blockJson)
      if (call && (!allowedNames || allowedNames.has(call.name))) calls.push(call)
      else dropped = true
      blockJson = ''
    }
    return { text: text.join(''), calls }
  }

  return {
    /** Feed a delta; returns {text, calls:[{name, arguments(object)}]}. */
    push(delta) {
      if (!delta) return { text: '', calls: [] }
      buf += delta
      const r = drain()
      for (const c of r.calls) pending.push(c)
      return { text: r.text, calls: r.calls }
    },
    /** Flush at stream end. Returns {text, calls, dropped}. */
    end() {
      const r = drain()
      for (const c of r.calls) pending.push(c)
      let tail = r.text
      if (inBlock) {
        // Fallback: if a malformed block left an unclosed quote before a real
        // </tool_call>, don't swallow any plain text that followed the tag.
        const full = blockJson + buf
        const lastClose = full.lastIndexOf(CLOSE_TAG)
        if (lastClose !== -1) tail += full.slice(lastClose + CLOSE_TAG.length)
        dropped = true
        inBlock = false
        blockJson = ''
        buf = ''
      } else if (buf) {
        // held-back tag prefix at EOS is just literal text
        tail += buf
        buf = ''
      }
      return { text: tail, calls: r.calls, dropped: dropped || undefined }
    },
    /** All calls seen so far (for session bookkeeping). */
    get calls() { return pending },
  }
}

/** Repair common LLM JSON glitches (unescaped control chars inside strings, trailing commas). */
function repairJson(raw) {
  let out = ''
  let inStr = false
  let esc = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (inStr) {
      if (esc) { out += ch; esc = false }
      else if (ch === '\\') { out += ch; esc = true }
      else if (ch === '"') { out += ch; inStr = false }
      else if (ch === '\n') out += '\\n'
      else if (ch === '\r') out += '\\r'
      else if (ch === '\t') out += '\\t'
      else if (ch.charCodeAt(0) < 0x20) out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
      else out += ch
    } else {
      if (ch === '"') inStr = true
      out += ch
    }
  }
  // Strip trailing commas outside strings: `, }` or `, ]`
  let cleaned = ''
  inStr = false
  esc = false
  for (let i = 0; i < out.length; i++) {
    const ch = out[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      cleaned += ch
    } else if (ch === '"') {
      inStr = true
      cleaned += ch
    } else if (ch === ',') {
      let j = i + 1
      while (j < out.length && /\s/.test(out[j])) j++
      if (out[j] === '}' || out[j] === ']') continue
      cleaned += ch
    } else {
      cleaned += ch
    }
  }
  return cleaned
}

function parseJsonLenient(raw) {
  try { return JSON.parse(raw) } catch { /* retry repaired */ }
  try { return JSON.parse(repairJson(raw)) } catch { return null }
}

function parseCall(json) {
  let raw = json.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(raw)
  if (fenced) raw = fenced[1].trim()
  const obj = parseJsonLenient(raw)
  if (!obj || typeof obj !== 'object') return null
  const name = obj?.name ?? obj?.tool ?? obj?.function?.name
  if (typeof name !== 'string' || !name) return null
  let args = obj.arguments ?? obj.function?.arguments ?? obj.args ?? obj.input ?? obj.parameters ?? {}
  if (typeof args === 'string') {
    args = parseJsonLenient(args)
  }
  if (args == null || typeof args !== 'object' || Array.isArray(args)) return null
  return { name, arguments: args }
}

/** Assign OpenAI-style ids to parsed calls: call_<rand>. */
export function withCallIds(calls) {
  return calls.map((c) => ({
    id: `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'function',
    function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
  }))
}
