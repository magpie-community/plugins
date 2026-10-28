// An agent's history, thinned where it was only ever read once: old tool
// results and long old texts are cut to their head and tail, images sent
// turns ago give way to a placeholder. magpie's gateway does it on the
// request, so an agent that keeps its whole history — which is most of
// them, and right — stops paying to re-read every old file and command
// output on every turn. Nothing is dropped: message count, order, ids and
// tool pairing stay as the agent sent them, and what is recent stays
// whole. Under the threshold the body passes as it came.
//
//   {"threshold": 96000}          chars of request JSON to act above
//                                 (~24k tokens; 0 disables the check)
//   {"keep_recent": 12}           messages at the end kept whole
//   {"tool_head": 600, "tool_tail": 300}    an old tool result's kept ends
//   {"text_head": 1200, "text_tail": 400}   an old text message's kept ends
//   {"drop_old_images": true}     images older than the window → a note
//
// The system prompt, the first user message (the task) and the recent
// window are never touched. Tool calls and their ids are never touched —
// an old tool result is shortened, not removed, so every tool_call still
// has its answer. Already-shortened content carries the marker and is left
// alone, so a history re-sent each turn is cut once, not again. A reply is
// never touched: what the agent keeps from it is the agent's to keep.

const MARK = "context-slim"

export function onRequest(body, ctx) {
  try {
    const o = ctx.options && typeof ctx.options === "object" ? ctx.options : {}
    const threshold = num(o.threshold, 96000)
    const keepRecent = num(o.keep_recent, 12)
    const toolHead = num(o.tool_head, 600)
    const toolTail = num(o.tool_tail, 300)
    const textHead = num(o.text_head, 1200)
    const textTail = num(o.text_tail, 400)
    const dropImages = o.drop_old_images !== false

    const messages = body && body.messages
    if (!Array.isArray(messages) || messages.length <= keepRecent + 1) return
    if (threshold > 0 && JSON.stringify(body).length < threshold) return

    // The first user message is the task the whole history serves; an
    // agent robbed of it answers a different question. Found once, kept.
    let firstUser = -1
    for (let i = 0; i < messages.length - keepRecent; i++) {
      const r = messages[i] && messages[i].role
      if (r === "user" || r === "tool") { firstUser = i; break }
    }

    let changed = false
    for (let i = 0; i < messages.length - keepRecent; i++) {
      if (i === firstUser) continue
      changed = slimMessage(messages[i], { toolHead, toolTail, textHead, textTail, dropImages }) || changed
    }
    return changed ? body : undefined
  } catch {
    // fail open: whatever went wrong, the agent's request goes on as it was
  }
}

function slimMessage(m, cfg) {
  if (!m || typeof m !== "object") return false
  if (m.role === "system" || m.role === "developer") return false
  if (m.role === "tool") return slimTool(m, "content", cfg)
  if (m.role === "assistant") {
    // tool_calls are the pairing half of the tool results below; thinking
    // blocks carry signatures their next turn checks. Neither is ours.
    let changed = false
    if (typeof m.content === "string") {
      const u = cut(m.content, cfg.textHead, cfg.textTail, "text")
      if (u !== m.content) { m.content = u; changed = true }
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b && b.type === "text" && typeof b.text === "string") {
          const u = cut(b.text, cfg.textHead, cfg.textTail, "text")
          if (u !== b.text) { b.text = u; changed = true }
        }
      }
    }
    return changed
  }
  if (m.role === "user" || m.role === undefined) {
    if (typeof m.content === "string") {
      const u = cut(m.content, cfg.textHead, cfg.textTail, "text")
      if (u !== m.content) { m.content = u; return true }
      return false
    }
    if (!Array.isArray(m.content)) return false
    let changed = false
    for (const b of m.content) {
      if (!b || typeof b !== "object") continue
      if (b.type === "tool_result") {
        // the answer half of a tool_use: kept, only shortened
        changed = slimToolResult(b, cfg) || changed
      } else if (b.type === "text" && typeof b.text === "string") {
        const u = cut(b.text, cfg.textHead, cfg.textTail, "text")
        if (u !== b.text) { b.text = u; changed = true }
      } else if (cfg.dropImages && (b.type === "image" || b.type === "image_url" || b.type === "input_image" || b.type === "document")) {
        b.type = "text"
        b.text = "[" + MARK + ": old image omitted]"
        delete b.source; delete b.image_url; delete b.url; delete b.input_image; delete b.data; delete b.citations
        changed = true
      }
    }
    return changed
  }
  return false
}

// A Chat tool result: {role:"tool", tool_call_id, content} — the content is
// the payload; the id is the pairing and stays.
function slimTool(m, key, cfg) {
  const c = m[key]
  if (typeof c === "string") {
    const u = cut(c, cfg.toolHead, cfg.toolTail, "tool output")
    if (u !== c) { m[key] = u; return true }
    return false
  }
  if (!Array.isArray(c)) return false
  let changed = false
  for (const b of c) {
    if (b && b.type === "text" && typeof b.text === "string") {
      const u = cut(b.text, cfg.toolHead, cfg.toolTail, "tool output")
      if (u !== b.text) { b.text = u; changed = true }
    }
  }
  return changed
}

// An Anthropic tool_result block: {type:"tool_result", tool_use_id,
// content: string | [{type:"text"|"image",…}]}.
function slimToolResult(b, cfg) {
  const c = b.content
  if (typeof c === "string") {
    const u = cut(c, cfg.toolHead, cfg.toolTail, "tool output")
    if (u !== c) { b.content = u; return true }
    return false
  }
  if (!Array.isArray(c)) return false
  let changed = false
  for (const part of c) {
    if (part && part.type === "text" && typeof part.text === "string") {
      const u = cut(part.text, cfg.toolHead, cfg.toolTail, "tool output")
      if (u !== part.text) { part.text = u; changed = true }
    } else if (part && cfg.dropImages && part.type === "image" && part.source) {
      part.type = "text"
      part.text = "[" + MARK + ": old image omitted]"
      delete part.source
      changed = true
    }
  }
  return changed
}

// Head and tail with a marker in between. Content already carrying the
// marker was cut on an earlier turn (the agent sends its history back each
// time) and is left as it is — idempotent, and the marker tells the agent
// what happened. Nothing to do when it already fits.
function cut(text, head, tail, what) {
  if (typeof text !== "string" || text.length <= head + tail + 80) return text
  if (text.includes("[" + MARK + ":")) return text
  const omitted = text.length - head - tail
  return text.slice(0, head) +
    "\n[" + MARK + ": " + omitted + " chars of old " + what + " omitted]\n" +
    text.slice(text.length - tail)
}

function num(v, d) {
  const n = typeof v === "number" && isFinite(v) && v >= 0 ? Math.floor(v) : NaN
  return isNaN(n) ? d : n
}
