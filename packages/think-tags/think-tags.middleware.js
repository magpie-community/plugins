// A model's thinking, where its reply's text is: New API's
// thinking_to_content, and the other way round.
//
//   {"mode": "strip"}       (the default)
//   {"mode": "to_content"}
//
// "strip": a model that writes its thinking into the reply as
// <think>…</think> at the start of its text has that block taken out, so
// an agent doesn't keep it in its history and send it back each turn. Only
// a block that opens the text is taken; <think> later on, in code the model
// writes, stays. Within the block, a </think> in Markdown code (an inline
// span, or a fenced block) is the thinking's words, an example written out,
// not its end (magpie-community/plugins#176, as magpie's gateway reads it
// since #2634). Anthropic, Chat and Responses replies, streamed or whole.
//
// "to_content": a Chat reply's reasoning_content (or reasoning) is put in
// its text as <think>…</think>, for a client that shows only the text.
// Chat only: an Anthropic thinking block carries a signature, and turned
// into text it would fail the next turn. It changes what the agent keeps
// and sends back, so it suits a chat client better than a coding agent.

const OPEN = "<think>"
const CLOSE = "</think>"

export function onEvent(ev, ctx) {
  const toContent = ctx.options && ctx.options.mode === "to_content"
  if (toContent) return Array.isArray(ev.choices) ? reasoningToText(ev, ctx.state) : undefined
  const st = ctx.state
  if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
    return edit(ev.delta, "text", strip(st, "a" + ev.index), ev)
  }
  if (ev.type === "response.output_text.delta") return edit(ev, "delta", strip(st, "r" + ev.item_id + ":" + ev.content_index), ev)
  if (ev.type === "response.output_text.done" && typeof ev.text === "string") return edit(ev, "text", stripWhole, ev)
  if (ev.type === "response.content_part.done" && ev.part && typeof ev.part.text === "string") return edit(ev.part, "text", stripWhole, ev)
  if (ev.type === "response.output_item.done" && ev.item) return stripItem(ev.item) ? ev : undefined
  if (ev.type === "response.completed" && ev.response && Array.isArray(ev.response.output)) {
    let changed = false
    for (const it of ev.response.output) changed = stripItem(it) || changed
    return changed ? ev : undefined
  }
  if (Array.isArray(ev.choices)) {
    let changed = false
    for (const c of ev.choices) {
      if (!c || !c.delta) continue
      const s = strip(st, "c" + c.index)
      if (typeof c.delta.content === "string") {
        const u = s(c.delta.content)
        if (u !== c.delta.content) {
          c.delta.content = u
          changed = true
        }
      }
      // a stream that ends while text is held back gives it back; what is
      // held inside the block is thinking, and stays out
      if (c.finish_reason && st["c" + c.index] && st["c" + c.index].carry && !st["c" + c.index].inside) {
        c.delta.content = (c.delta.content || "") + st["c" + c.index].carry
        st["c" + c.index].carry = ""
        changed = true
      }
    }
    return changed ? ev : undefined
  }
}

export function onResponse(body, ctx) {
  if (ctx.status >= 400) return
  let changed = false
  const fix = (o, k) => {
    if (o && typeof o[k] === "string") {
      const u = stripWhole(o[k])
      if (u !== o[k]) {
        o[k] = u
        changed = true
      }
    }
  }
  if (ctx.options && ctx.options.mode === "to_content") {
    if (!Array.isArray(body.choices)) return
    for (const c of body.choices) {
      const m = c && c.message
      if (!m) continue
      const r = typeof m.reasoning_content === "string" ? m.reasoning_content : typeof m.reasoning === "string" ? m.reasoning : ""
      if (!r) continue
      m.content = OPEN + "\n" + r + "\n" + CLOSE + "\n\n" + (m.content || "")
      delete m.reasoning_content
      delete m.reasoning
      changed = true
    }
    return changed ? body : undefined
  }
  if (Array.isArray(body.content)) {
    const first = body.content.find((b) => b && b.type === "text")
    fix(first, "text")
  }
  if (Array.isArray(body.choices)) for (const c of body.choices) fix(c && c.message, "content")
  if (Array.isArray(body.output)) for (const it of body.output) changed = stripItem(it) || changed
  return changed ? body : undefined
}

function edit(obj, key, f, ev) {
  if (!obj || typeof obj[key] !== "string") return
  const u = f(obj[key])
  if (u === obj[key]) return
  obj[key] = u
  return ev
}

function stripItem(it) {
  if (!it || it.type !== "message" || !Array.isArray(it.content)) return false
  const p = it.content.find((x) => x && x.type === "output_text")
  if (!p || typeof p.text !== "string") return false
  const u = stripWhole(p.text)
  if (u === p.text) return false
  p.text = u
  return true
}

// stripWhole takes a think block off the start of a whole text: up to its
// first </think> outside Markdown code
function stripWhole(t) {
  const lead = /^\s*/.exec(t)[0]
  if (!t.startsWith(OPEN, lead.length)) return t
  const rest = t.slice(lead.length + OPEN.length)
  const [at] = findClose({ span: 0, fence: 0, mid: false }, rest, true)
  return at < 0 ? t : rest.slice(at + CLOSE.length).replace(/^\s+/, "")
}

// findClose gives where </think> is first outside Markdown code in s, read
// on from the pieces before (m: the open inline span's backticks, the open
// fence's, and whether the line is past its leading spaces), or -1 and how
// much of the end of s to hold back for the next piece: a close tag or a
// run of backticks that may go on there. Unless last; then nothing is
// held. An inline span is taken to end with its line, so a stray backtick
// can't swallow the answer. magpie's mdCode (internal/gateway/chat.go).
function findClose(m, s, last) {
  for (let j = 0; j < s.length; ) {
    const c = s[j]
    if (c === "`") {
      let k = j
      while (k < s.length && s[k] === "`") k++
      if (k === s.length && !last) return [-1, s.length - j]
      const n = k - j
      if (m.fence > 0) {
        if (!m.mid && n >= m.fence) m.fence = 0
      } else if (m.span > 0) {
        if (n === m.span) m.span = 0
      } else if (!m.mid && n >= 3) m.fence = n
      else m.span = n
      m.mid = true
      j = k
    } else if (c === "\n") {
      m.span = 0
      m.mid = false
      j++
    } else if (c === " " || c === "\t") {
      j++
    } else if (c === "<" && m.span === 0 && m.fence === 0) {
      if (s.startsWith(CLOSE, j)) return [j, 0]
      if (!last && CLOSE.startsWith(s.slice(j))) return [-1, s.length - j]
      m.mid = true
      j++
    } else {
      m.mid = true
      j++
    }
  }
  return [-1, 0]
}

// strip is a stream's text, a piece at a time, without a think block at
// its start. Its state, by stream: inside the block, text held back that
// may be the start of a tag (or, inside, a run of backticks), whether the
// text has begun, and where the block is in Markdown code.
function strip(state, key) {
  const st = state[key] || (state[key] = { inside: false, carry: "", begun: false, trim: false, code: { span: 0, fence: 0, mid: false } })
  return (piece) => {
    if (st.begun) return piece
    let s = st.carry + piece
    st.carry = ""
    let out = ""
    for (;;) {
      if (st.inside) {
        const [i, hold] = findClose(st.code, s, false)
        if (i < 0) {
          st.carry = hold ? s.slice(s.length - hold) : ""
          return out
        }
        s = s.slice(i + CLOSE.length)
        st.inside = false
        st.trim = true
        continue
      }
      if (st.trim) {
        s = s.replace(/^\s+/, "")
        if (!s) return out
        st.trim = false
        st.begun = true
        return out + s
      }
      const lead = /^\s*/.exec(s)[0]
      const rest = s.slice(lead.length)
      if (rest.startsWith(OPEN)) {
        s = rest.slice(OPEN.length)
        st.inside = true
        continue
      }
      if (rest.length < OPEN.length && OPEN.startsWith(rest)) {
        // maybe the start of <think>: wait for the next piece
        st.carry = s
        return out
      }
      st.begun = true
      return out + s
    }
  }
}

// reasoningToText moves a Chat chunk's reasoning into its text, opening
// <think> on the first and closing it when the text or the end comes.
function reasoningToText(ev, state) {
  let changed = false
  for (const c of ev.choices) {
    const d = c && c.delta
    if (!d) continue
    const key = "t" + c.index
    const r = typeof d.reasoning_content === "string" ? d.reasoning_content : typeof d.reasoning === "string" ? d.reasoning : null
    let text = ""
    if (r !== null) {
      delete d.reasoning_content
      delete d.reasoning
      changed = true
      if (r) {
        if (!state[key]) {
          state[key] = "open"
          text += OPEN + "\n"
        }
        text += r
      }
    }
    const content = typeof d.content === "string" ? d.content : ""
    if (state[key] === "open" && (content || c.finish_reason)) {
      text += "\n" + CLOSE + "\n\n"
      state[key] = "closed"
    }
    if (text) {
      d.content = text + content
      changed = true
    }
  }
  return changed ? ev : undefined
}
