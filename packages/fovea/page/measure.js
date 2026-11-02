// fovea — the focal centre of the eye. The window a request works in
// stays sharp; the history around it, like peripheral vision, stays
// present but carries only its outline. An agent that keeps its whole
// history — which is most of them, and right — stops paying to re-read
// every old file and command output on every turn. magpie's gateway does
// it on the request. Message count, order, ids and tool pairing stay as
// the agent sent them, and what is recent stays whole. Under the
// threshold the body passes as it came.
//
//   {"threshold": 96000}          chars of request to act above (~24k
//                                 tokens; 0 acts on every request)
//   {"keep_recent": 12}           messages at the end kept whole
//   {"keep_recent_tokens": 16000} the same window as a token budget; the
//                                 larger of the two windows is kept
//   {"cut_step": 24}              cut boundary advances only in blocks of
//                                 this many messages, so cached prefixes
//                                 stay byte-identical across nearby turns
//   {"tool_head": 600, "tool_tail": 300}    an old tool result's kept ends
//   {"text_head": 1200, "text_tail": 400}   an old text message's kept ends
//   {"drop_old_images": true}     images older than the window → a note
//   {"protect": []}               regexes whose matches are left whole
//                                 (e.g. "^diff --git ", "BEGIN .*PRIVATE KEY")
//   {"state_marker": ""}          a marker the agent's own structured
//                                 state block carries. A message with the
//                                 marker is never touched, in either mode,
//                                 and its presence means the raw task
//                                 message no longer needs protecting: the
//                                 state carries the task, so that message
//                                 is thinned like any other old content
//   {"saccade": "off"}            off | auto | always. A saccade is the
//                                 eye jumping to a new target: when the
//                                 newest question is a different topic,
//                                 the old context is not carried at all —
//                                 every old message long enough to matter
//                                 collapses to one line instead of
//                                 keeping its head and tail. "auto" judges
//                                 by word overlap between the newest
//                                 question and the first task message
//                                 (a "继续" or an "ok" has no direction of
//                                 its own and keeps the old context);
//                                 "always" collapses on every request
//                                 above the threshold.
//
// The system prompt and the recent window are never touched. In the
// default mode the first user message (the task) is kept whole too; on a
// saccade it is the old task, and collapses with the rest. Tool calls and
// their ids are never touched — an old tool result is shortened or
// noted, not removed, so every tool_call still has its answer.
// Already-shortened content carries the marker and is left alone, so a
// history re-sent each turn is cut once, not again. A reply is never
// touched: what the agent keeps from it is the agent's to keep.
//
// Chat (role:"tool"), Anthropic (tool_result blocks) and the Responses API
// (function_call_output items) are read in their own shapes; a body in
// none of them passes as it came.

const MARK = "fovea"
const NOTE = "[" + MARK + ": prior topic not carried]"
const NOTE_MIN = 160          // below this a saccade leaves old text as it is
const SHIFT_OVERLAP = 0.08    // shared-word ratio under which a topic counts as new

function onRequest(body, ctx) {
  try {
    if (!body || typeof body !== "object") return
    const o = ctx && ctx.options && typeof ctx.options === "object" ? ctx.options : {}
    const cfg = {
      threshold: num(o.threshold, 96000),
      keepRecent: num(o.keep_recent, 12),
      keepTokens: num(o.keep_recent_tokens, 16000),
      cutStep: Math.max(1, num(o.cut_step, 24)),
      toolHead: num(o.tool_head, 600),
      toolTail: num(o.tool_tail, 300),
      textHead: num(o.text_head, 1200),
      textTail: num(o.text_tail, 400),
      dropImages: o.drop_old_images !== false,
      protect: patterns(o.protect),
      stateMarker: typeof o.state_marker === "string" ? o.state_marker : "",
      saccade: o.saccade === "auto" || o.saccade === "always" ? o.saccade : "off",
    }

    // Chat and Anthropic both carry body.messages; the Responses API
    // carries body.input. Size is measured by walking, not by
    // stringifying: a 5MB body would otherwise allocate 5MB of string on
    // every request, on the request path.
    const list = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : null
    if (!list) return
    if (cfg.threshold > 0 && sizeOf(body) < cfg.threshold) return

    const at = windowStart(list, cfg.keepRecent, cfg.keepTokens)
    // The boundary lands only on multiples of cut_step: while the window
    // slides a round a turn, the cut prefix stays byte-identical for many
    // turns and the provider's prompt cache settles. Under one block
    // nothing is cut yet — a history that small reads cheap whole, and
    // cutting it would churn the cache every turn (yetone's review, PR
    // #467: with the boundary sliding, a cached loop costs more, not
    // less). Options that want thinning at any size set cut_step: 1.
    const start = Math.floor(at / cfg.cutStep) * cfg.cutStep
    if (start <= 0) return

    const saccade = cfg.saccade === "always" || (cfg.saccade === "auto" && topicShifted(list))
    // A structured state block (the agent's own JSON of task, constraints,
    // decisions and verified facts) replaces the raw task message: it
    // carries what that message carried, so the message no longer earns
    // its protection and can be thinned like any other old content. The
    // block itself is never touched — in either mode.
    const hasState = cfg.stateMarker ? hasStateBlock(list, cfg.stateMarker) : false
    const firstUser = hasState ? -1 : firstUserIndex(list, start)
    let changed = false
    for (let i = 0; i < start; i++) {
      if (!saccade && i === firstUser) continue
      const item = list[i]
      if (cfg.stateMarker && carriesState(item, cfg.stateMarker)) continue
      if (list === body.input) changed = (saccade ? collapseInput : slimInput)(item, cfg) || changed
      else changed = (saccade ? collapseMessage : slimMessage)(item, cfg) || changed
    }
    return changed ? body : undefined
  } catch {
    // fail open: whatever went wrong, the agent's request goes on as it was
  }
}

// The earliest index the window must keep: the count and the token budget
// each name one, and the larger window wins — a few huge recent messages
// must not be cut just because they are few.
function windowStart(list, keepCount, keepTokens) {
  const byCount = Math.max(0, list.length - keepCount)
  if (keepTokens <= 0) return byCount
  let used = 0
  let i = list.length - 1
  for (; i >= 0; i--) {
    used += Math.ceil(sizeOf(list[i]) / 4)
    // the message that tips the budget over does not fit: the window
    // starts after it, not on it — stopping on it shielded exactly the
    // huge old message the budget was meant to give up
    if (used > keepTokens) break
  }
  return Math.min(byCount, Math.max(0, i + 1))
}

function firstUserIndex(list, start) {
  for (let i = 0; i < start; i++) {
    const r = list[i] && list[i].role
    if (r === "user") return i
  }
  return -1
}

// A state block is one message carrying the marker. It is found in the
// text of the message, wherever the agent put it.
function hasStateBlock(list, marker) {
  for (const item of list) {
    if (carriesState(item, marker)) return true
  }
  return false
}

function carriesState(item, marker) {
  if (!item || typeof item !== "object" || !marker) return false
  if (typeof item.content === "string") return item.content.includes(marker)
  if (!Array.isArray(item.content)) return false
  for (const b of item.content) {
    if (b && typeof b === "object" && typeof b.text === "string" && b.text.includes(marker)) return true
  }
  return false
}

// ── peripheral: the default mode, head and tail with a marker ──────────

function slimMessage(m, cfg) {
  if (!m || typeof m !== "object") return false
  if (m.role === "system" || m.role === "developer") return false
  if (m.role === "tool") return slimContent(m, "content", cfg.toolHead, cfg.toolTail, cfg)
  if (m.role === "assistant") {
    // tool_calls are the pairing half of the tool results below; thinking
    // blocks carry signatures their next turn checks. Neither is ours.
    let changed = false
    if (typeof m.content === "string") {
      const u = cut(m.content, cfg.textHead, cfg.textTail, "text", cfg)
      if (u !== m.content) { m.content = u; changed = true }
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b && b.type === "text" && typeof b.text === "string") {
          const u = cut(b.text, cfg.textHead, cfg.textTail, "text", cfg)
          if (u !== b.text) { b.text = u; changed = true }
        }
      }
    }
    return changed
  }
  if (m.role === "user" || m.role === undefined) {
    if (typeof m.content === "string") {
      const u = cut(m.content, cfg.textHead, cfg.textTail, "text", cfg)
      if (u !== m.content) { m.content = u; return true }
      return false
    }
    if (!Array.isArray(m.content)) return false
    let changed = false
    for (const b of m.content) {
      if (!b || typeof b !== "object") continue
      if (b.type === "tool_result") {
        // the answer half of a tool_use: kept, only shortened
        changed = slimContent(b, "content", cfg.toolHead, cfg.toolTail, cfg) || changed
      } else if (b.type === "text" && typeof b.text === "string") {
        const u = cut(b.text, cfg.textHead, cfg.textTail, "text", cfg)
        if (u !== b.text) { b.text = u; changed = true }
      } else if (cfg.dropImages && isImage(b.type)) {
        note(b, b.type === "input_image", "[" + MARK + ": old image omitted]")
        changed = true
      }
    }
    return changed
  }
  return false
}

// A Responses API item: function_call_output carries the tool result
// (call_id is the pairing, kept), message carries the text. function_call
// and reasoning items are left as they are.
function slimInput(it, cfg) {
  if (!it || typeof it !== "object") return false
  if (it.type === "function_call_output" || it.type === "custom_tool_call_output") return slimContent(it, "output", cfg.toolHead, cfg.toolTail, cfg)
  if (it.role === "system" || it.role === "developer") return false
  if (it.type === "message" || it.role === "user" || it.role === "assistant") {
    if (typeof it.content === "string") {
      const u = cut(it.content, cfg.textHead, cfg.textTail, "text", cfg)
      if (u !== it.content) { it.content = u; return true }
      return false
    }
    if (!Array.isArray(it.content)) return false
    let changed = false
    for (const b of it.content) {
      if (!b || typeof b !== "object") continue
      if (typeof b.text === "string") {
        const u = cut(b.text, cfg.textHead, cfg.textTail, "text", cfg)
        if (u !== b.text) { b.text = u; changed = true }
      } else if (cfg.dropImages && isImage(b.type)) {
        note(b, b.type === "input_image", "[" + MARK + ": old image omitted]")
        changed = true
      }
    }
    return changed
  }
  return false
}

// The payload of a tool result, as a string or as parts: {role:"tool",
// content} in Chat, a tool_result block's content in Anthropic,
// function_call_output's output in the Responses API.
function slimContent(holder, key, head, tail, cfg) {
  const c = holder[key]
  if (typeof c === "string") {
    const u = cut(c, head, tail, "tool output", cfg)
    if (u !== c) { holder[key] = u; return true }
    return false
  }
  if (!Array.isArray(c)) return false
  let changed = false
  for (const part of c) {
    if (!part || typeof part !== "object") continue
    if ((part.type === "text" || part.type === "input_text") && typeof part.text === "string") {
      const u = cut(part.text, head, tail, "tool output", cfg)
      if (u !== part.text) { part.text = u; changed = true }
    } else if (cfg.dropImages && isImage(part.type)) {
      note(part, part.type === "input_image", "[" + MARK + ": old image omitted]")
      changed = true
    }
  }
  return changed
}

// ── saccade: a new topic, and the old context is not carried ───────────
// Long-enough old content becomes one line; short acks stay as they are
// (they cost nothing and keep the flow readable). Pairing survives the
// same way as in the default mode: tool calls and ids untouched, tool
// results noted, not removed.

function collapseMessage(m, cfg) {
  if (!m || typeof m !== "object") return false
  if (m.role === "system" || m.role === "developer") return false
  if (m.role === "tool") return collapseContent(m, "content", cfg)
  if (m.role === "assistant") {
    let changed = false
    if (typeof m.content === "string") changed = collapseText(m, "content", cfg)
    else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b && b.type === "text" && typeof b.text === "string") changed = collapseText(b, "text", cfg) || changed
      }
    }
    return changed
  }
  if (m.role === "user" || m.role === undefined) {
    if (typeof m.content === "string") return collapseText(m, "content", cfg)
    if (!Array.isArray(m.content)) return false
    let changed = false
    for (const b of m.content) {
      if (!b || typeof b !== "object") continue
      if (b.type === "tool_result") changed = collapseContent(b, "content", cfg) || changed
      else if (b.type === "text" && typeof b.text === "string") changed = collapseText(b, "text", cfg) || changed
      else if (isImage(b.type)) { note(b, b.type === "input_image", NOTE); changed = true }
    }
    return changed
  }
  return false
}

function collapseInput(it, cfg) {
  if (!it || typeof it !== "object") return false
  if (it.type === "function_call_output" || it.type === "custom_tool_call_output") return collapseContent(it, "output", cfg)
  if (it.role === "system" || it.role === "developer") return false
  if (it.type === "message" || it.role === "user" || it.role === "assistant") {
    if (typeof it.content === "string") return collapseText(it, "content", cfg)
    if (!Array.isArray(it.content)) return false
    let changed = false
    for (const b of it.content) {
      if (!b || typeof b !== "object") continue
      if (typeof b.text === "string") changed = collapseText(b, "text", cfg) || changed
      else if (isImage(b.type)) { note(b, b.type === "input_image", NOTE); changed = true }
    }
    return changed
  }
  return false
}

function collapseContent(holder, key, cfg) {
  const c = holder[key]
  if (typeof c === "string") return collapseText(holder, key, cfg)
  if (!Array.isArray(c)) return false
  let changed = false
  for (const part of c) {
    if (!part || typeof part !== "object") continue
    if ((part.type === "text" || part.type === "input_text") && typeof part.text === "string") changed = collapseText(part, "text", cfg) || changed
    else if (isImage(part.type)) { note(part, part.type === "input_image", NOTE); changed = true }
  }
  return changed
}

function collapseText(holder, key, cfg) {
  const t = holder[key]
  if (typeof t !== "string" || t === NOTE || t.length <= NOTE_MIN) return false
  if (cfg.protect.some((re) => re.test(t))) return false
  holder[key] = NOTE
  return true
}

// ── the saccade judgement ──────────────────────────────────────────────
// The newest question against the task the history serves: shared words
// (latin words of 3+, each CJK char) tell same-topic from new-topic.
// Both sides need at least four words to judge on — a "继续" or an "ok"
// keeps the old context carried, which is the safe way round. A question
// inside an Anthropic tool_result carrier is not a question; textOf
// reads only text parts, so those carriers never speak for the topic.

function topicShifted(list) {
  const last = lastQuestion(list)
  const first = firstTask(list)
  if (!last || !first) return false
  const a = words(last)
  const b = words(first)
  if (a.size < 4 || b.size < 4) return false
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return shared / Math.min(a.size, b.size) < SHIFT_OVERLAP
}

function firstTask(list) {
  for (const it of list) {
    if (it && it.role === "user") {
      const t = textOf(it)
      if (t) return t
    }
  }
  return null
}

function lastQuestion(list) {
  for (let i = list.length - 1; i >= 0; i--) {
    const it = list[i]
    if (!it || it.role !== "user") continue
    const t = textOf(it)
    if (t) return t
  }
  return null
}

// An item's own words: a string content, or the text parts of an array —
// tool_result content and image payloads are the machinery, not the
// question.
function textOf(it) {
  if (typeof it.content === "string") return it.content
  if (!Array.isArray(it.content)) return null
  let out = ""
  for (const b of it.content) {
    if (b && (b.type === "text" || b.type === "input_text") && typeof b.text === "string") out += " " + b.text
  }
  return out.trim() || null
}

function words(text) {
  const out = new Set()
  for (const w of String(text).toLowerCase().match(/[a-z0-9_]{3,}|[\u4e00-\u9fff]/g) || []) out.add(w)
  return out
}

// ── shared ─────────────────────────────────────────────────────────────

function isImage(type) {
  return type === "image" || type === "image_url" || type === "input_image"
}

// Turn an image part into a text note in place, dropping the payload keys.
function note(part, responses, text) {
  const type = responses ? "input_text" : "text"
  for (const k of Object.keys(part)) delete part[k]
  part.type = type
  part.text = text
}

// Head and tail with a marker in between. Content already carrying the
// marker was cut on an earlier turn (the agent sends its history back each
// time) and is left as it is — idempotent, and the marker tells the agent
// what happened. Nothing to do when it already fits, or when a protect
// pattern says this text must stay whole.
function cut(text, head, tail, what, cfg) {
  if (typeof text !== "string" || text.length <= head + tail + 80) return text
  if (text.includes("[" + MARK + ":")) return text
  if (cfg.protect.length && cfg.protect.some((re) => re.test(text))) return text
  const headEnd = safeHead(text, head)
  const tailStart = safeTail(text, text.length - tail)
  if (tailStart <= headEnd) return text
  const endStart = tailStart
  const omitted = endStart - headEnd
  return text.slice(0, headEnd) +
    "\n[" + MARK + ": " + omitted + " chars of old " + what + " omitted]\n" +
    text.slice(endStart)
}

function safeHead(text, n) {
  if (n > 0 && n < text.length && high(text.charCodeAt(n - 1)) && low(text.charCodeAt(n))) return n - 1
  return n
}

function safeTail(text, n) {
  if (n > 0 && n < text.length && high(text.charCodeAt(n - 1)) && low(text.charCodeAt(n))) return n + 1
  return n
}

function high(c) { return c >= 0xD800 && c <= 0xDBFF }
function low(c) { return c >= 0xDC00 && c <= 0xDFFF }


// Sum of the body's string lengths, plus a little per node, without
// building the joined string. Enough to decide "is this request big", and
// ~4 chars a token for the window budget.
function sizeOf(v) {
  if (v === null || v === undefined) return 0
  if (typeof v === "string") return v.length
  if (typeof v !== "object") return 8
  let n = 8
  if (Array.isArray(v)) {
    for (const x of v) n += sizeOf(x)
    return n
  }
  for (const k of Object.keys(v)) n += k.length + 2 + sizeOf(v[k])
  return n
}

function patterns(v) {
  if (!Array.isArray(v)) return []
  const out = []
  for (const p of v) {
    if (typeof p !== "string" || !p) continue
    try { out.push(new RegExp(p)) } catch { /* an invalid pattern protects nothing */ }
  }
  return out
}

function num(v, d) {
  const n = typeof v === "number" && isFinite(v) && v >= 0 ? Math.floor(v) : NaN
  return isNaN(n) ? d : n
}

globalThis.FoveaOnRequest = onRequest;
