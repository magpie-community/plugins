import {
  OUTPUT_STYLE_CATALOG,
  OUTPUT_STYLE_IDS,
  SHARED_BOUNDARIES,
} from "./catalog.js"

export const OUTPUT_STYLE_MARKER = "[Output Strategy]"

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

function contentIncludesMarker(content) {
  if (typeof content === "string") return content.includes(OUTPUT_STYLE_MARKER)
  if (!Array.isArray(content)) return false
  return content.some((block) => isRecord(block) && contentIncludesMarker(typeof block.text === "string" ? block.text : block.content))
}

// Scan every place injection can land, regardless of which request shape the
// body currently takes, so a body re-shaped between pipeline stages is never
// injected twice. User-authored text is deliberately not scanned: a user
// quoting the marker must not disable injection.
function bodyIncludesMarker(body) {
  if (contentIncludesMarker(body.instructions)) return true
  if (contentIncludesMarker(body.system)) return true
  if (Array.isArray(body.messages)) {
    if (body.messages.some((message) => isRecord(message) && (message.role === "system" || message.role === "developer") && contentIncludesMarker(message.content))) return true
  }
  if (Array.isArray(body.input)) {
    if (body.input.some((item) => isRecord(item) && (item.role === "system" || item.role === "developer") && contentIncludesMarker(item.content))) return true
  }
  return false
}

function appendInstruction(existing, instruction) {
  const trimmed = existing.trimEnd()
  return trimmed ? `${trimmed}\n\n${instruction}` : instruction
}

function placeSystemInstruction(messages, system, instruction, protocol) {
  const first = messages[0]
  if (first?.role === "system" && typeof first.content === "string") {
    const nextMessages = [...messages]
    nextMessages[0] = { ...first, content: appendInstruction(first.content, instruction) }
    return { messages: nextMessages }
  }
  if (typeof system === "string") {
    return { system: system ? appendInstruction(system, instruction) : instruction }
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
    nextMessages[mergeIndex] = { ...target, content: appendInstruction(target.content, instruction) }
    return { messages: nextMessages }
  }
  // Anthropic only accepts user/assistant inside messages; system belongs at the top level.
  if (protocol === "anthropic") return { system: instruction }
  return { messages: [{ role: "system", content: instruction }, ...messages] }
}

function placeOrSkip(body, messages, instruction, protocol, resolved) {
  const placed = placeSystemInstruction(messages, body.system, instruction, protocol)
  if (!placed) return { body, applied: false, skippedReason: "unsupported_system_shape" }
  return appliedResult({ ...body, ...placed }, resolved)
}

function responsesInput(body, instruction) {
  const message = { role: "developer", content: [{ type: "input_text", text: instruction }] }
  return Array.isArray(body.input) ? [message, ...body.input] : [message, { role: "user", content: body.input }]
}

function appliedResult(body, appliedStyles) {
  return { body, applied: true, appliedStyles }
}

export function applyOutputStyles(body, selection) {
  try {
    const resolved = resolveStyles(selection)
    if (resolved.length === 0) return { body, applied: false, skippedReason: "no_styles" }
    if (!isRecord(body)) return { body, applied: false, skippedReason: "no_messages" }
    if (bodyIncludesMarker(body)) return { body, applied: false, skippedReason: "already_applied" }

    const instruction = buildOutputStylesInstruction(resolved)
    const messages = Array.isArray(body.messages) ? body.messages : null
    const responsesShape =
      (!messages || messages.length === 0) &&
      (typeof body.instructions === "string" || typeof body.input === "string" || Array.isArray(body.input))

    if (responsesShape) {
      // Codex owns instructions: its identity and base instructions must stay
      // byte-identical. The selected styles live in their own input item.
      if (body.instructions !== undefined && typeof body.instructions !== "string") {
        return { body, applied: false, skippedReason: "unsupported_instructions_shape" }
      }
      if (typeof body.input !== "string" && !Array.isArray(body.input)) {
        return { body, applied: false, skippedReason: "no_messages" }
      }
      return appliedResult({ ...body, input: responsesInput(body, instruction) }, resolved)
    }

    if (!messages) return { body, applied: false, skippedReason: "no_messages" }

    return placeOrSkip(body, messages, instruction, isRecord(selection) ? selection.protocol : undefined, resolved)

  } catch {
    return { body, applied: false, skippedReason: "error" }
  }
}
