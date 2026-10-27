// A request's history, sent smaller: a run of blank lines folded, a system
// prompt repeated word for word dropped, a past tool result longer than
// maxToolLength cut at a word boundary, and a message repeated right after
// itself dropped. OmniRoute's lite engine, as magpie gateway middleware.
//
//   {"maxToolLength": 2000}          (the default)
//   {"compressToolResults": false}   leave every tool result whole
//   {"preserveSystemPrompt": true}   keep system messages out of all four steps
//
// Only body.messages is read, so a Chat or an Anthropic request; a request
// without one (Responses, Gemini) goes on unchanged.
//
// The turn being sent now — every message after the last assistant one — is
// left alone by all four steps. It is the history the model has not read yet,
// and a patch, a Markdown hard break or a trailing tab in it means something.
// The tool-result cut is the one step that loses words, and it works on the
// history only. The other three drop only what is there twice: a system
// message with the same trimmed text, and a message equal to the one before it
// in every field, tool_calls and name included.
//
// 移植自 OmniRoute 的 lite 引擎（open-sse/services/compression/lite.ts），
// 四步的顺序、阈值与边界回退逐条对应；四处与它不同，见 PROVENANCE.json。

const DEFAULT_MAX_TOOL_LENGTH = 2000
const MIN_MAX_TOOL_LENGTH = 256
const MAX_MAX_TOOL_LENGTH = 1000000
const TOOL_TRUNCATION_LOOKBACK = 80
const TRUNCATION_SUFFIX = "\n...[truncated]"

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

// The turn being sent starts after the last assistant message: findLastIndex,
// written out. A history with no assistant message has no past at all — every
// message in it is the turn being sent, and none of the four steps touch it.
function turnStart(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === "assistant") return i + 1
  }
  return 0
}

// ---------------------------------------------------------------------------
// 1. whitespace: a run of three or more newlines becomes one blank line, and
//    trailing spaces and tabs on a line go. Words are untouched.
// ---------------------------------------------------------------------------

function foldText(text) {
  return text.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+$/gm, "")
}

function foldWhitespace(messages, preserveSystemPrompt) {
  const start = turnStart(messages)
  let changed = false
  const out = messages.map((msg, index) => {
    if (index >= start) return msg
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
// 2. system: a second system message with the same trimmed text is the same
//    prompt again, and goes. Two prompts that share an opening are two prompts.
// ---------------------------------------------------------------------------

function dropRepeatedSystemPrompts(messages, preserveSystemPrompt) {
  if (preserveSystemPrompt) return messages
  const start = turnStart(messages)
  const seen = new Set()
  let changed = false
  const out = messages.filter((msg, index) => {
    if (index >= start) return true
    if (!msg || msg.role !== "system" || typeof msg.content !== "string") return true
    const text = msg.content.trim()
    if (seen.has(text)) {
      changed = true
      return false
    }
    seen.add(text)
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

// A cut between a high and a low surrogate pair leaves half a character, which
// is neither a word boundary nor valid text: emoji and CJK never offer a space
// to back off to. Step back one unit instead.
function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff
}

function avoidSplitSurrogate(text, cutIndex) {
  if (cutIndex <= 0 || cutIndex >= text.length) return cutIndex
  return isHighSurrogate(text.charCodeAt(cutIndex - 1)) && isLowSurrogate(text.charCodeAt(cutIndex))
    ? cutIndex - 1
    : cutIndex
}

function cutText(text, maxLength) {
  const cutIndex = avoidSplitSurrogate(text, backOffToWordBoundary(text, maxLength))
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
  const currentTurnStart = turnStart(messages)
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
// 4. a message equal to the one before it — same role, and every other field
//    the same too — says nothing new and goes. Comparing the content alone
//    would merge two different tool calls, or two speakers with one line.
//    Tool results are left alone.
// ---------------------------------------------------------------------------

// Every field counts, and key order does not: JSON.stringify alone would call
// the same message different because a body wrote its keys in another order.
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]"
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}"
  }
  return JSON.stringify(value) ?? "null"
}

function dropRepeatedMessages(messages, preserveSystemPrompt) {
  const start = turnStart(messages)
  let changed = false
  const out = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (!msg || typeof msg !== "object") {
      out.push(msg)
      continue
    }
    if (i >= start || (preserveSystemPrompt && msg.role === "system")) {
      out.push(msg)
      continue
    }
    const previous = i > 0 ? messages[i - 1] : undefined
    if (
      i > 0 &&
      msg.role !== "tool" &&
      previous &&
      typeof previous === "object" &&
      previous.role === msg.role &&
      canonical(previous) === canonical(msg)
    ) {
      changed = true
      continue
    }
    out.push(msg)
  }
  return changed ? out : messages
}
