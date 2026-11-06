import {
  OUTPUT_STYLE_CATALOG,
  OUTPUT_STYLE_IDS,
  SHARED_BOUNDARIES,
} from "./catalog.js"

export const OUTPUT_STYLE_MARKER = "[Output Strategy]"

const MEDIA_PART_TYPES = new Set([
  "image",
  "document",
  "image_url",
  "input_audio",
  "audio_url",
  "file",
  "input_image",
  "input_file",
])
const MEDIA_PART_KEYS = ["inlineData", "inline_data", "fileData", "file_data"]
const NESTED_PART_KEYS = ["content", "output", "parts"]
const MAX_DEPTH = 4

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function resolveStyles(selection) {
  if (isRecord(selection) && Object.prototype.hasOwnProperty.call(selection, "styles")) selection = selection.styles
  if (isRecord(selection)) return OUTPUT_STYLE_IDS.filter((id) => selection[id] === true)
  if (!Array.isArray(selection)) return []
  const selected = new Set()
  for (const entry of selection) {
    const id = typeof entry === "string" ? entry : isRecord(entry) ? entry.id : null
    if (typeof id === "string") selected.add(id)
  }
  return OUTPUT_STYLE_IDS.filter((id) => selected.has(id))
}

export function buildOutputStylesInstruction(selection) {
  const resolved = resolveStyles(selection)
  if (resolved.length === 0) return ""

  const instructions = resolved.map((id) => OUTPUT_STYLE_CATALOG[id].instruction.trim())
  const boundaries = [SHARED_BOUNDARIES]
  for (const id of resolved) {
    const boundary = OUTPUT_STYLE_CATALOG[id].boundaries
    if (boundary && !boundaries.includes(boundary)) boundaries.push(boundary)
  }
  return `${OUTPUT_STYLE_MARKER}\n${instructions.join("\n\n")}\n\n${boundaries.join("\n")}`
}

function nodeHasMedia(node, depth) {
  if (!isRecord(node) || depth > MAX_DEPTH) return false
  if (typeof node.type === "string" && MEDIA_PART_TYPES.has(node.type)) return true
  for (const key of MEDIA_PART_KEYS) {
    if (isRecord(node[key])) return true
  }
  for (const key of NESTED_PART_KEYS) {
    const nested = node[key]
    if (Array.isArray(nested) && nested.some((child) => nodeHasMedia(child, depth + 1))) {
      return true
    }
  }
  return false
}

export function hasMediaBlocks(body) {
  if (!isRecord(body)) return false
  for (const key of ["messages", "input", "contents"]) {
    const items = body[key]
    if (Array.isArray(items) && items.some((item) => nodeHasMedia(item, 0))) return true
  }
  return false
}

function contentIncludesMarker(content) {
  if (typeof content === "string") return content.includes(OUTPUT_STYLE_MARKER)
  if (!Array.isArray(content)) return false
  return content.some((block) => isRecord(block) && typeof block.text === "string" && block.text.includes(OUTPUT_STYLE_MARKER))
}

function systemFieldIncludesMarker(system) {
  return contentIncludesMarker(system)
}

// Scan every place injection can land, regardless of which request shape the
// body currently takes, so a body re-shaped between pipeline stages is never
// injected twice. User-authored text is deliberately not scanned: a user
// quoting the marker must not disable injection.
function bodyIncludesMarker(body) {
  if (contentIncludesMarker(body.instructions)) return true
  if (systemFieldIncludesMarker(body.system)) return true
  if (Array.isArray(body.messages)) {
    if (body.messages.some((message) => isRecord(message) && (message.role === "system" || message.role === "developer") && contentIncludesMarker(message.content))) return true
  }
  if (Array.isArray(body.input)) {
    if (body.input.some((item) => isRecord(item) && (item.role === "system" || item.role === "developer") && contentIncludesMarker(item.content))) return true
  }
  return false
}

// Strip any previous [Output Strategy] block from the request body so that
// repeated injection across turns replaces rather than accumulates.
function stripOutputStrategyFromBody(body) {
  if (!isRecord(body)) return { changed: false, body }
  let changed = false
  const out = { ...body }
  if (typeof out.system === "string" && out.system.includes(OUTPUT_STYLE_MARKER)) {
    out.system = stripOutputStrategy(out.system)
    changed = true
  }
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((m) => {
      if (isRecord(m) && m.role === "system" && typeof m.content === "string" && m.content.includes(OUTPUT_STYLE_MARKER)) {
        changed = true
        return { ...m, content: stripOutputStrategy(m.content) }
      }
      return m
    })
  }
  if (typeof out.instructions === "string" && out.instructions.includes(OUTPUT_STYLE_MARKER)) {
    out.instructions = stripOutputStrategy(out.instructions)
    changed = true
  }
  return { changed, body: out }
}

// Strip any previous [Output Strategy] block from a system prompt so that
// repeated injection across turns replaces rather than accumulates.
// The block runs from the marker to the end of the boundaries section.
function stripOutputStrategy(text) {
  if (typeof text !== "string") return text
  const idx = text.indexOf(OUTPUT_STYLE_MARKER)
  if (idx < 0) return text
  // Find the end of the boundaries section by locating the last boundary
  // text that belongs to the injected block.
  const boundaryEndMarkers = [
    "Active every response until user asks for normal mode.",
    "Never simplify away: input validation at trust boundaries, error handling that prevents data loss, security measures, or accessibility basics.",
    "Every shipped control works or is removed: no dead buttons, no links to nowhere, no navbar entries without destinations. No fabricated statistics, testimonials, security or compliance claims. Placeholders are labeled honestly, never disguised as final.",
  ]
  let end = idx
  for (const marker of boundaryEndMarkers) {
    const pos = text.indexOf(marker, idx)
    if (pos >= 0 && pos + marker.length > end) end = pos + marker.length
  }
  const before = text.slice(0, idx).trimEnd()
  const after = text.slice(end).trimStart()
  return (before + "\n\n" + after).replace(/\n{3,}/g, "\n\n").trim()
}

function placeSystemInstruction(messages, system, instruction, protocol) {
  const first = messages[0]
  if (first?.role === "system" && typeof first.content === "string") {
    const nextMessages = [...messages]
    const stripped = stripOutputStrategy(first.content)
    nextMessages[0] = { ...first, content: `${stripped.trim()}\n\n${instruction}`.trim() }
    return { messages: nextMessages }
  }
  if (typeof system === "string") {
    const stripped = stripOutputStrategy(system)
    return { system: stripped ? `${stripped.trim()}\n\n${instruction}` : instruction }
  }
  if (Array.isArray(system)) {
    return { system: [...system, { type: "text", text: instruction }] }
  }
  if (system !== undefined && system !== null) {
    // A non-string, non-array system field is someone else's contract
    // (some proxies send {type:"text",...}); replacing it is data loss.
    return null
  }
  const mergeIndex = messages.findIndex(
    (message) => message?.role === "system" && typeof message.content === "string",
  )
  if (mergeIndex >= 0) {
    const nextMessages = [...messages]
    const target = messages[mergeIndex]
    const stripped = stripOutputStrategy(target.content)
    nextMessages[mergeIndex] = {
      ...target,
      content: `${stripped.trim()}\n\n${instruction}`.trim(),
    }
    return { messages: nextMessages }
  }
  // Anthropic only accepts user/assistant inside messages; system belongs at the top level.
  if (protocol === "anthropic") return { system: instruction }
  return { messages: [{ role: "system", content: instruction }, ...messages] }
}

// Wraps placeSystemInstruction's null into a skipped result.
function placeOrSkip(body, messages, instruction, protocol, resolved) {
  const placed = placeSystemInstruction(messages, body.system, instruction, protocol)
  if (!placed) return { body, applied: false, skippedReason: "unsupported_system_shape" }
  return appliedResult({ ...body, ...placed }, resolved, instruction)
}

function appendInstruction(existing, instruction) {
  const trimmed = existing.trim()
  return trimmed ? `${trimmed}\n\n${instruction}` : instruction
}

function textContent(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "").join("\n")
}

function autoClarityReason(body) {
  const items = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : typeof body.input === "string" ? [{ role: "user", content: body.input }] : []
  const text = items.slice(-3).filter((item) => item && item.role !== "system" && item.role !== "developer").map((item) => textContent(item && item.content).toLowerCase()).join("\n")
  if (!text.trim()) return null
  if (/\b(security|vulnerability|exploit|credential leak|secret leak|malware|phishing)\b/.test(text)) return "security_warning"
  if (/\b(delete|drop table|truncate|destroy|wipe|irreversible|permanently remove)\b/.test(text)) return "irreversible_action"
  if (/\b(clarify|explain in detail|more detail|step by step|why exactly|what do you mean)\b/.test(text)) return "clarification_requested"
  if (/\b(first|then|after that|before|rollback|backup)\b[\s\S]{0,240}\b(delete|drop|migrate|deploy|release)\b/.test(text)) return "order_sensitive_sequence"
  return null
}

function utf8Bytes(text) {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

function appliedResult(body, appliedStyles, instruction) {
  return { body, applied: true, appliedStyles, addedBytes: utf8Bytes(instruction) }
}

export function applyOutputStyles(body, selection) {
  try {
    const resolved = resolveStyles(selection)
    if (resolved.length === 0) return { body, applied: false, skippedReason: "no_styles" }
    if (!isRecord(body)) return { body, applied: false, skippedReason: "no_messages" }
    if (hasMediaBlocks(body)) return { body, applied: false, skippedReason: "media_content" }
    // If the request already carries an [Output Strategy] block from a
    // previous turn (e.g. a persisted conversation), strip it before
    // injecting the current selection so styles replace, never accumulate.
    const cleaned = stripOutputStrategyFromBody(body)
    if (cleaned.changed) body = cleaned.body
    const clarity = isRecord(selection) && selection.autoClarity === false ? null : autoClarityReason(body)
    if (clarity) return { body, applied: false, skippedReason: clarity }

    const instruction = buildOutputStylesInstruction(resolved)
    const messages = Array.isArray(body.messages) ? body.messages : null
    const responsesShape =
      (!messages || messages.length === 0) &&
      (typeof body.instructions === "string" || typeof body.input === "string" || Array.isArray(body.input))

    if (responsesShape) {
      if (typeof body.instructions === "string") {
        return appliedResult({ ...body, instructions: appendInstruction(body.instructions, instruction) }, resolved, instruction)
      }
      if (body.instructions !== undefined) {
        // Non-string instructions (array/object/number) are someone else's
        // contract; overwriting them is data loss. Pass through instead.
        return { body, applied: false, skippedReason: "unsupported_instructions_shape" }
      }
      return appliedResult({ ...body, instructions: instruction }, resolved, instruction)
    }

    if (!messages) return { body, applied: false, skippedReason: "no_messages" }

    return placeOrSkip(body, messages, instruction, isRecord(selection) ? selection.protocol : undefined, resolved)

  } catch {
    return { body, applied: false, skippedReason: "error" }
  }
}
