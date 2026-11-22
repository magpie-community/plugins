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

/**
 * The instruction block prepended to the text we send upstream.
 * @param {Array} tools normalized tools (may be empty → returns '')
 * @param {string|object} [toolChoice] body.tool_choice
 */
// Quick rejects user_message.text over 64 KB; a huge toolset alone can eat
// most of that, so the preamble degrades to name+description when needed.
const PREAMBLE_CAP = 40 * 1024

export function buildToolPreamble(tools, toolChoice, { lite = false, minimal = false } = {}) {
  if (!tools.length) return ''
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
  const assemble = (specs, header) => [
    '[Client tool calling]',
    'The application you are assisting exposes the tools below; it executes them on the user\'s machine and returns each result as a [tool_result …] message.',
    'This channel has no native function-calling API — the <tool_call> marker below is the only way to invoke these tools.',
    'When the task needs one of them, reply with ONLY a block in this format (no other text):',
    '<tool_call>{"name":"<tool_name>","arguments":{<json arguments>}}</tool_call>',
    'Guidelines:',
    '- one block per call; several blocks are allowed for parallel calls;',
    '- "arguments" is a JSON object matching the parameters schema;',
    '- after a [tool_result …] message arrives, continue the task in plain text;',
    must,
    header,
    specs,
  ].filter(Boolean).join('\n')
  if (minimal) {
    return assemble(shown.map((t) => t.name).join(', '), 'Tools provided by the client (names only):')
  }
  const liteSpecs = shown.map((t) => `- ${t.name}: ${t.description || '(no description)'}`).join('\n')
  const liteHeader = 'Tools provided by the client (parameter schemas omitted — use the tool name and reasonable arguments):'
  let out = lite
    ? assemble(liteSpecs, liteHeader)
    : assemble(shown.map(toolSpecLine).join('\n'), 'Tools provided by the client:')
  if (!lite && byteLen(out) > PREAMBLE_CAP) {
    // 20+ Claude-Code-sized schemas can exceed the 64 KB message cap on their
    // own — keep names + descriptions, drop parameter schemas entirely.
    out = assemble(liteSpecs, liteHeader)
  }
  return out
}

const SHELL_TOOL = /^(bash|shell|sh|zsh|powershell|cmd|exec|execute_command|run_terminal_command|run_terminal_cmd|terminal)$/i
const CMD_KEY = /^(command|cmd|input|script)$/i

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
  const shell = !exact && SHELL_TOOL.test(name)
    ? clientShellTool(clientTools)
    : null
  const tool = exact || shell
  if (!tool) return null
  const props = tool.parameters?.properties && typeof tool.parameters.properties === 'object'
    ? tool.parameters.properties
    : {}
  const keys = Object.keys(props)
  const command = args.command || args.cmd || args.input || args.script || ''
  if (!keys.length) {
    return { name: tool.name, arguments: command && !args.command ? { ...args, command } : (Object.keys(args).length ? args : { command }) }
  }
  const out = {}
  for (const key of keys) {
    if (Object.hasOwn(args, key) && args[key] != null) out[key] = args[key]
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

/**
 * Incremental parser: feed text_delta strings, get back visible text and
 * completed tool calls. Blocks split across deltas are handled — including a
 * tag split mid-token (`<` + `tool_call>…`), which is held back rather than
 * flushed. A dangling <tool_call> at end() is reported via `dropped`.
 */
export function createToolCallParser({ allowedNames } = {}) {
  let buf = ''
  let inBlock = false
  let blockJson = ''
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
        continue
      }
      const idx = buf.indexOf(CLOSE_TAG)
      if (idx === -1) {
        // Same holdback for a split </tool_call> — keep it out of blockJson.
        const hold = heldPrefixLen(buf, CLOSE_TAG)
        blockJson += buf.slice(0, buf.length - hold)
        buf = buf.slice(buf.length - hold)
        break
      }
      blockJson += buf.slice(0, idx)
      buf = buf.slice(idx + CLOSE_TAG.length)
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
        // unterminated block → not shown to the user
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

function parseCall(json) {
  let raw = json.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(raw)
  if (fenced) raw = fenced[1].trim()
  let obj
  try { obj = JSON.parse(raw) } catch { return null }
  const name = obj?.name ?? obj?.tool ?? obj?.function?.name
  if (typeof name !== 'string' || !name) return null
  let args = obj.arguments ?? obj.function?.arguments ?? obj.args ?? obj.input ?? obj.parameters ?? {}
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { return null }
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
