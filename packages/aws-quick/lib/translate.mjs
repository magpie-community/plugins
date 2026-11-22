// OpenAI ⇄ Quick message rendering + model/mode mapping.
//
// Quick's user_message carries one `text` field for the conversation.
// Desktop 1.2.4660 puts caller instructions in `custom_prompt` (live testing
// confirmed `custom_prompt` is the active field while `system_prompt` alone is
// ignored). History and tool results render into `text`.

/** Text content of one content-part object (OpenAI/Anthropic/Responses shapes). */
function partText(p) {
  if (typeof p === 'string') return p
  const t = p?.type
  if (t === 'text' || t === 'input_text' || t === 'output_text') return p.text ?? ''
  if (t === 'image_url' || t === 'input_image' || t === 'image') return '[image omitted]'
  if (t === 'file' || t === 'input_file') return '[file omitted]'
  if (t === 'tool_result') return textOf(p.content) // string or nested parts
  if (t === 'tool_use') {
    const args = typeof p.input === 'string' ? p.input : JSON.stringify(p.input ?? {})
    return `[called tool ${p.name ?? 'tool'}(${args})]`
  }
  return '' // thinking/redacted_thinking/audio/etc carry no user-visible text
}

/** Text content of an OpenAI message (string or parts array). */
export function textOf(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(partText).filter(Boolean).join('\n')
  }
  return String(content)
}

/** Agent modes the desktop client can send as `agent_mode`. */
export const AGENT_MODES = Object.freeze(['fast', 'balanced', 'smart', 'advanced'])

export const MODELS = Object.freeze(
  AGENT_MODES.map((mode) => ({
    id: mode,
    object: 'model',
    created: 0,
    owned_by: 'aws-quick',
    name: { fast: 'Quick Fast', balanced: 'Quick Balanced', smart: 'Quick Smart', advanced: 'Quick Advanced' }[mode],
  })),
)

/** Map a requested model id to an agent_mode; unknown → 'smart'. */
export function modeFor(model) {
  const m = String(model ?? '').trim().toLowerCase()
  const bare = m.includes('/') ? m.split('/').pop() : m
  return AGENT_MODES.includes(bare) ? bare : 'smart'
}

/** thinking_effort levels the 1.2.4660 desktop client sends. max is capped at high. */
export const EFFORT_LEVELS = Object.freeze(['off', 'low', 'medium', 'high'])

/**
 * thinking_effort from the X-Magpie-Effort header or body.reasoning_effort.
 * Returns undefined when unset/invalid (server then uses its default).
 * Desktop set_agent_mode caps max at high, so max/xhigh map to high.
 */
export function effortFor(effortHeader, body) {
  const raw = effortHeader ?? body?.reasoning_effort ?? body?.thinking_effort
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (EFFORT_LEVELS.includes(v)) return v
  const map = { none: 'off', minimal: 'low', low: 'low', medium: 'medium', med: 'medium', high: 'high', xhigh: 'high', max: 'high' }
  if (Object.hasOwn(map, v)) return map[v]
  return v === 'enabled' || v === 'true' ? 'high' : v === 'disabled' || v === 'false' ? 'off' : undefined
}

function renderToolCalls(calls) {
  if (!Array.isArray(calls) || !calls.length) return ''
  return calls
    .map((c) => {
      const name = c?.function?.name ?? c?.name ?? 'tool'
      const args = c?.function?.arguments ?? c?.arguments ?? ''
      return `[called tool ${name}(${typeof args === 'string' ? args : JSON.stringify(args)})]`
    })
    .join('\n')
}

export const byteLen = (s) => Buffer.byteLength(String(s ?? ''), 'utf8')
export const jsonTextBytes = (s) => byteLen(JSON.stringify(String(s ?? ''))) - 2

/** user_message.text is hard-capped at 64 KB server-side; stay under it. */
export const UPSTREAM_TEXT_LIMIT = 60 * 1024
const SYSTEM_CAP = 24 * 1024
const USER_TURN_CAP = 20 * 1024
export const TOOL_RESULT_CAP = 16 * 1024
const TRUNC_MARK = '\n…[truncated]'

function fitBytes(s, max, measure) {
  let lo = 0, hi = s.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (measure(s.slice(0, mid)) <= max) lo = mid
    else hi = mid - 1
  }
  if (lo > 0 && lo < s.length && /[\uD800-\uDBFF]/.test(s[lo - 1]) && /[\uDC00-\uDFFF]/.test(s[lo])) lo--
  return s.slice(0, lo)
}

/** Truncate to a byte budget, appending a marker. */
export function capText(s, maxBytes, measure = byteLen) {
  const str = String(s ?? '')
  if (measure(str) <= maxBytes) return str
  const room = maxBytes - measure(TRUNC_MARK)
  if (room <= 0) return fitBytes(str, maxBytes, measure)
  return fitBytes(str, room, measure) + TRUNC_MARK
}

function bounded(text, limit, measure, stats) {
  const result = capText(text, limit, measure)
  if (stats && result !== text) stats.truncated = true
  return result
}

function transcriptLine(m, measure, stats, toolResultCap = TOOL_RESULT_CAP) {
  const text = textOf(m.content)
  if (m.role === 'assistant') {
    const calls = renderToolCalls(m.tool_calls)
    return `assistant: ${[text, calls].filter(Boolean).join('\n')}`
  }
  if (m.role === 'tool' || m.role === 'function') {
    return `[tool_result ${[m.name, m.tool_call_id].filter(Boolean).join(' ')}]\n${bounded(text, toolResultCap, measure, stats)}`
  }
  return `${m.role}: ${text}`
}

/**
 * Full-transcript text for a NEW thread: system prompt + rendered history +
 * the final user turn. Everything the model needs in one user_message.
 * `maxBytes` bounds the result (oldest history dropped first); `stats` is
 * mutated with {truncated:true} when anything was cut.
 */
export function renderTranscript(messages, systemText, {
  maxBytes = Infinity, stats, measure = byteLen,
  turnCap = USER_TURN_CAP, toolResultCap = TOOL_RESULT_CAP,
} = {}) {
  const lastMsg = messages.at(-1)
  const raw = lastMsg?.role === 'user' ? textOf(lastMsg.content) : lastMsg && transcriptLine(lastMsg, measure, stats, toolResultCap)
  const last = bounded(raw || '(empty)', Math.min(turnCap, maxBytes), measure, stats)
  const sep = measure('\n\n')
  let room = maxBytes - measure(last)
  let system = ''
  if (systemText) {
    const label = '[system instructions]\n'
    const body = bounded(systemText, Math.min(SYSTEM_CAP, room - measure(label) - sep), measure, stats)
    if (body) {
      system = label + body
      room -= measure(system) + sep
    }
  }
  // Visit only the newest suffix that can fit. Account for its heading and separators.
  const kept = []
  let used = 0
  let head = ''
  for (let i = messages.length - 2; i >= 0; i--) {
    const line = transcriptLine(messages[i], measure, stats, toolResultCap)
    const heading = i ? `[conversation so far — ${i} earlier message(s) omitted]\n` : '[conversation so far]\n'
    used += measure(line) + sep
    if (used + measure(heading) > room) {
      if (stats) stats.truncated = true
      break
    }
    kept.push(line)
    head = heading
  }
  return [system, head + kept.reverse().join('\n\n'), last].filter(Boolean).join('\n\n')
}

/**
 * Water-filling per-block byte cap for a delta so single or parallel tool
 * results use the full available frame budget instead of stopping at a fixed
 * 16 KB / 48 KB ceiling. Short blocks keep their full size and excess room
 * flows to larger blocks; when everything fits, returns `maxBytes` (no cap).
 */
export function fairBlockCap(delta, maxBytes, measure = byteLen) {
  if (!Number.isFinite(maxBytes) || !Array.isArray(delta) || !delta.length) return maxBytes
  const sep = measure('\n\n')
  let overhead = 0
  const sizes = []
  for (const m of delta) {
    if (m.role !== 'user' && m.role !== 'tool' && m.role !== 'function') continue
    const text = textOf(m.content)
    const header = (m.role === 'tool' || m.role === 'function')
      ? `[tool_result ${[m.name, m.tool_call_id].filter(Boolean).join(' ')}]\n`
      : ''
    if (!header && !text) continue
    if (sizes.length) overhead += sep
    if (header) overhead += measure(header)
    sizes.push(measure(text))
  }
  if (!sizes.length) return maxBytes
  let budget = Math.max(0, maxBytes - overhead)
  const sorted = sizes.slice().sort((a, b) => a - b)
  for (let i = 0; i < sorted.length; i++) {
    const share = Math.floor(budget / (sorted.length - i))
    if (sorted[i] <= share) {
      budget -= sorted[i]
    } else {
      return Math.max(1024, share)
    }
  }
  return Math.max(1024, maxBytes - overhead)
}

/**
 * Delta text for a REUSED thread: only the new user/tool content.
 * Per-block caps apply first (`toolResultCap` / `turnCap`); then the
 * NEWEST blocks are kept within `maxBytes` — the current turn's question is
 * never sacrificed for older tool results.
 */
export function renderDelta(delta, {
  maxBytes = Infinity, stats, measure = byteLen,
  turnCap = USER_TURN_CAP, toolResultCap = TOOL_RESULT_CAP,
} = {}) {
  const kept = []
  let used = 0
  for (let i = delta.length - 1; i >= 0; i--) {
    const m = delta[i]
    let block
    if (m.role === 'user') block = bounded(textOf(m.content), turnCap, measure, stats)
    else if (m.role === 'tool' || m.role === 'function') block = transcriptLine(m, measure, stats, toolResultCap)
    if (!block) continue
    const size = measure(block) + (kept.length ? measure('\n\n') : 0)
    if (used + size > maxBytes) {
      if (stats) stats.truncated = true
      if (!kept.length) return capText(block, maxBytes, measure)
      const marker = `[${i + 1} earlier message(s) omitted]\n`
      return (used + measure(marker) <= maxBytes ? marker : '') + kept.reverse().join('\n\n')
    }
    kept.push(block)
    used += size
  }
  return kept.reverse().join('\n\n')
}
