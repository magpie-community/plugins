// A request's history, sent smaller: a run of blank lines folded, a system
// prompt repeated word for word dropped, a past tool result longer than
// maxToolLength cut at a word boundary, and a message repeated right after
// itself dropped. OmniRoute's lite engine, as magpie gateway middleware.
//
//   {"maxToolLength": 2000}          (the default)
//   {"compressToolResults": false}   leave every tool result whole
//   {"preserveSystemPrompt": true}   keep system messages out of all four steps
//
// Only body.messages is read, so a Chat or Anthropic request; a request
// without one (Responses, Gemini) goes on unchanged.
//
// The tool-result cut is the one step that loses words. It works on the
// history only: messages after the last assistant turn, the turn being sent
// now, are never cut. The other three steps drop only what is there twice.
//
// 移植自 OmniRoute 的 lite 引擎（open-sse/services/compression/lite.ts），
// 四步的顺序、阈值与边界回退逐条对应；未移植的两步见 PROVENANCE.json。

const DEFAULT_MAX_TOOL_LENGTH = 2000
const MIN_MAX_TOOL_LENGTH = 256
const MAX_MAX_TOOL_LENGTH = 1000000
const TOOL_TRUNCATION_LOOKBACK = 80
const TRUNCATION_SUFFIX = "\n...[truncated]"
const SYSTEM_DEDUP_KEY_CHARS = 200

export function onRequest(body, ctx) {
  if (!body || typeof body !== "object") return
  const messages = body.messages
  if (!Array.isArray(messages) || messages.length === 0) return
  const o = (ctx && ctx.options) || {}
  const preserveSystemPrompt = o.preserveSystemPrompt === true

  let next = foldWhitespace(messages, preserveSystemPrompt)
  next = dropRepeatedSystemPrompts(next, preserveSystemPrompt)
  if (o.compressToolResults !== false) next = cutToolResults(next, resolveMaxToolLength(o.maxToolLength))
  next = dropRepeatedMessages(next, preserveSystemPrompt)

  if (next === messages) return
  return { ...body, messages: next }
}

// ---------------------------------------------------------------------------
// 1. whitespace: a run of three or more newlines becomes one blank line, and
//    trailing spaces and tabs on a line go. Words are untouched.
// ---------------------------------------------------------------------------

function foldText(text) {
  return text.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+$/gm, "")
}

function foldWhitespace(messages, preserveSystemPrompt) {
  let changed = false
  const out = messages.map((msg) => {
    if (!msg || typeof msg !== "object") return msg
    if (preserveSystemPrompt && msg.role === "system") return msg
    if (typeof msg.content !== "string") return msg
    const folded = foldText(msg.content)
    if (folded === msg.content) return msg
    changed = true
    return { ...msg, content: folded }
  })
  return changed ? out : messages
}

// ---------------------------------------------------------------------------
// 2. system: a second system message whose first 200 trimmed characters are
//    the one already sent is the same prompt again, and goes.
// ---------------------------------------------------------------------------

function dropRepeatedSystemPrompts(messages, preserveSystemPrompt) {
  if (preserveSystemPrompt) return messages
  const seen = new Set()
  let changed = false
  const out = messages.filter((msg) => {
    if (!msg || msg.role !== "system" || typeof msg.content !== "string") return true
    const key = msg.content.trim().slice(0, SYSTEM_DEDUP_KEY_CHARS)
    if (seen.has(key)) {
      changed = true
      return false
    }
    seen.add(key)
    return true
  })
  return changed ? out : messages
}

// ---------------------------------------------------------------------------
// 3. tool results: a past result longer than maxToolLength is cut, backing off
//    to the nearest space within 80 characters and marking the cut.
// ---------------------------------------------------------------------------

function isWordChar(char) {
  return char !== undefined && /\S/.test(char)
}

function findWhitespaceBackward(content, cutIndex) {
  const windowStart = Math.max(0, cutIndex - TOOL_TRUNCATION_LOOKBACK)
  for (let i = cutIndex; i > windowStart; i--) {
    if (!isWordChar(content[i - 1])) return i - 1
  }
  return -1
}

function findWhitespaceForward(content, cutIndex) {
  const windowEnd = Math.min(content.length, cutIndex + TOOL_TRUNCATION_LOOKBACK)
  for (let i = cutIndex; i < windowEnd; i++) {
    if (!isWordChar(content[i])) return i
  }
  return -1
}

function backOffToWordBoundary(content, cutIndex) {
  const onWordBoundary = !isWordChar(content[cutIndex - 1]) || !isWordChar(content[cutIndex])
  if (onWordBoundary) return cutIndex
  const backward = findWhitespaceBackward(content, cutIndex)
  if (backward !== -1) return backward
  const forward = findWhitespaceForward(content, cutIndex)
  if (forward !== -1) return forward
  return cutIndex
}

function cutText(text, maxLength) {
  const cutIndex = backOffToWordBoundary(text, maxLength)
  return text.slice(0, cutIndex) + TRUNCATION_SUFFIX
}

function cutToolResultBlocks(msg, maxLength) {
  if (msg.role !== "user" || !Array.isArray(msg.content)) {
    return { message: msg, changed: false }
  }
  let changed = false
  const content = msg.content.map((block) => {
    if (!block || typeof block !== "object" || block.type !== "tool_result") return block
    const inner = block.content
    if (typeof inner === "string") {
      if (inner.length <= maxLength) return block
      changed = true
      return { ...block, content: cutText(inner, maxLength) }
    }
    if (Array.isArray(inner)) {
      let innerChanged = false
      const nextInner = inner.map((part) => {
        if (!part || typeof part !== "object" || part.type !== "text") return part
        if (typeof part.text !== "string" || part.text.length <= maxLength) return part
        innerChanged = true
        return { ...part, text: cutText(part.text, maxLength) }
      })
      if (innerChanged) {
        changed = true
        return { ...block, content: nextInner }
      }
      return block
    }
    return block
  })
  if (changed) return { message: { ...msg, content }, changed: true }
  return { message: msg, changed: false }
}

function resolveMaxToolLength(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_TOOL_LENGTH
  const n = Math.floor(value)
  if (n < MIN_MAX_TOOL_LENGTH || n > MAX_MAX_TOOL_LENGTH) return DEFAULT_MAX_TOOL_LENGTH
  return n
}

function cutToolResults(messages, maxLength) {
  // findLastIndex, written out: the turn being sent starts after it.
  let lastAssistant = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === "assistant") {
      lastAssistant = i
      break
    }
  }
  const currentTurnStart = lastAssistant === -1 ? messages.length : lastAssistant + 1
  let changed = false
  const out = messages.map((msg, index) => {
    if (index >= currentTurnStart) return msg
    if (!msg || typeof msg !== "object") return msg
    if (msg.role === "tool" && typeof msg.content === "string") {
      if (msg.content.length <= maxLength) return msg
      changed = true
      return { ...msg, content: cutText(msg.content, maxLength) }
    }
    const r = cutToolResultBlocks(msg, maxLength)
    if (r.changed) changed = true
    return r.message
  })
  return changed ? out : messages
}

// ---------------------------------------------------------------------------
// 4. a message whose content is character for character the one before it, in
//    the same role, says nothing new and goes. Tool results are left alone.
// ---------------------------------------------------------------------------

function dropRepeatedMessages(messages, preserveSystemPrompt) {
  let changed = false
  const out = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (!msg || typeof msg !== "object") {
      out.push(msg)
      continue
    }
    if (preserveSystemPrompt && msg.role === "system") {
      out.push(msg)
      continue
    }
    const previous = i > 0 ? messages[i - 1] : undefined
    const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
    if (
      i > 0 &&
      msg.role !== "tool" &&
      previous &&
      typeof previous === "object" &&
      previous.role === msg.role &&
      typeof previous.content === "string" &&
      previous.content === text
    ) {
      changed = true
      continue
    }
    out.push(msg)
  }
  return changed ? out : messages
}