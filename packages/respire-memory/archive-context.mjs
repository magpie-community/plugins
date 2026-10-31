// Reused from Respire Codex: bounded extraction with original-evidence readback.
const record = value => value && typeof value === 'object' && !Array.isArray(value)

export const DIRECT_LIMIT = 256000
export const CHUNK_LIMIT = 48000
export const MAX_CHUNKS = 12
const FRAGMENT_LIMIT = 6000
const TYPES = new Set(['userMessage', 'agentMessage', 'commandExecution', 'mcpToolCall', 'dynamicToolCall', 'fileChange'])

/** Prepare ordered evidence from exactly one turn; never silently discard dialogue. */
export function prepareArchiveContext(items) {
  const fragments = []
  const groups = []
  let clippedTools = 0
  let omittedAttachments = 0
  let originalChars = 0
  for (const [index, item] of items.entries()) {
    if (!TYPES.has(item.type)) continue
    let text
    const dialogue = item.type === 'userMessage' || item.type === 'agentMessage'
    if (item.type === 'userMessage') {
      text = (item.content || []).map(part => {
        if (typeof part.text === 'string') return part.text
        omittedAttachments++
        return '[Non-text attachment omitted: ' + String(part.type) + ']'
      }).join('\n')
    } else if (item.type === 'agentMessage') text = item.text || ''
    else text = JSON.stringify(item)
    originalChars += text.length
    const start = fragments.length
    // Split originals before preparing previews so every omitted middle remains readable.
    let offset = 0
    let part = 0
    do {
      let end = Math.min(text.length, offset + FRAGMENT_LIMIT)
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
      fragments.push({
        source: 'item-' + index + '-part-' + part++, type: item.type,
        ...(item.phase ? { phase: item.phase } : {}),
        ...(item.status ? { status: item.status } : {}),
        ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}),
        text: text.slice(offset, end),
      })
      offset = end
    } while (offset < text.length)
    groups.push({ dialogue, parts: fragments.slice(start), chars: text.length })
  }
  let prepared = fragments
  if (JSON.stringify(fragments).length > DIRECT_LIMIT) {
    prepared = groups.flatMap(({ dialogue, parts, chars }) => {
      if (dialogue || parts.length <= 2) return parts
      clippedTools++
      return [parts[0], parts.at(-1)].map(fragment => ({
        ...fragment, partial: true, originalChars: chars,
        text: fragment.text + '\n[PARTIAL: middle tool evidence available through respire_turn_evidence]',
      }))
    })
  }
  const serialized = JSON.stringify(prepared)
  const chunks = []
  if (serialized.length <= DIRECT_LIMIT) chunks.push(prepared)
  else {
    let chunk = []
    for (const fragment of prepared) {
      if (JSON.stringify([...chunk, fragment]).length > CHUNK_LIMIT) {
        chunks.push(chunk)
        chunk = []
      }
      chunk.push(fragment)
    }
    if (chunk.length) chunks.push(chunk)
  }
  if (chunks.length > MAX_CHUNKS) throw new Error('archive-segment-limit')
  return {
    chunks, fragments, userSources: fragments.filter(x => x.type === 'userMessage').map(x => x.source),
    coverage: clippedTools || omittedAttachments ? 'partial' : 'complete',
    originalChars, preparedChars: serialized.length, clippedTools, omittedAttachments,
  }
}

/** Only accept small, source-linked candidate data, never free-form executable instructions. */
export function parseExtraction(text, fragments) {
  if (typeof text !== 'string' || text.length > 6000) throw new Error('extraction-output-limit')
  let value
  try { value = JSON.parse(text) } catch { throw new Error('invalid-extraction') }
  const sources = new Set(fragments.map(x => x.source))
  const valid = (entry, fact) => record(entry) && typeof entry.text === 'string' &&
    entry.text.trim().length > 0 && entry.text.length <= 1500 &&
    Array.isArray(entry.sources) && entry.sources.length > 0 &&
    entry.sources.every(source => sources.has(source)) &&
    (!fact || ['confirmed', 'proposed', 'uncertain'].includes(entry.status)) &&
    Object.keys(entry).every(key => ['text', 'sources', ...(fact ? ['status'] : [])].includes(key))
  if (!record(value) || Object.keys(value).some(key => !['facts', 'constraints'].includes(key)) ||
      !Array.isArray(value.facts) || !Array.isArray(value.constraints) ||
      value.facts.length > 24 || value.constraints.length > 24 ||
      !value.facts.every(x => valid(x, true)) || !value.constraints.every(x => valid(x, false))) {
    throw new Error('invalid-extraction')
  }
  return value
}

/** Evidence stays in memory for this worker; unknown or oversized reads fail closed. */
export function readEvidence(fragments, sources) {
  if (!Array.isArray(sources) || !sources.length || sources.length > 4 ||
      sources.some(source => typeof source !== 'string')) throw new Error('invalid-evidence')
  const selected = sources.map(source => fragments.find(x => x.source === source))
  if (selected.some(x => !x) || JSON.stringify(selected).length > CHUNK_LIMIT) throw new Error('invalid-evidence')
  return selected
}
