// Rejects requests that contain text you list, before they reach a model:
// a request with one of your words or patterns in it is turned away with a
// 400 naming what matched, and everything else is sent on untouched.
//
//   {"patterns": ["\\b\\d{3}-\\d{4}\\b"], "words": ["sk-live"],
//    "system": true, "message": ""}
//
// Every content shape an agent sends is read: plain strings, text and
// input_text blocks, Responses input items, and Gemini parts, in all four
// APIs magpie serves. Every user turn is scanned, not just the last one, so
// a pattern earlier in the conversation is caught too.
//
// "system": true (the default) also reads the system prompt wherever the API
// keeps it — an Anthropic top-level `system` (string or text blocks), a
// system or developer message, the Responses `instructions`, and a Gemini
// `systemInstruction` (its object or string form, either spelling). Set it to
// false to leave them all out. Tool calls, tool results and tool
// descriptions are never read, in any setting.
//
// A pattern that is not a valid regular expression is ignored rather than
// thrown, so one bad entry in the options cannot turn away every request.
// See the README's "If a pattern does not compile".
//
// Words are matched anywhere in the text, ignoring case, as plain
// substrings. This is literal matching, not a safety classifier: it does
// not understand what a request means, and a synonym or an obfuscated
// spelling passes it. It is a way to keep listed text out of what your
// gateway sends, nothing more.

export function onRequest(body, ctx) {
  const o = ctx.options
  if (!o || typeof o !== "object") return
  const re = matcher(o)
  if (!re) return

  let hit = null
  scan(body, ctx.protocol, o.system !== false, (t) => {
    if (hit !== null) return
    re.lastIndex = 0
    const m = re.exec(t)
    if (m) hit = m[0]
  })
  if (hit === null) return
  ctx.reject(
    400,
    typeof o.message === "string" && o.message
      ? o.message
      : `this request has "${hit}", which this gateway doesn't send`,
  )
}

// matcher is one expression for every word and pattern; null for none.
// A runtime is kept for a request's hooks, so it is built once a request.
// A pattern that will not compile is left out rather than thrown, so one bad
// entry in the options cannot turn away every request the gateway sees.
let cached = null
function matcher(o) {
  if (!o || typeof o !== "object") return null
  const key = JSON.stringify([o.words, o.patterns])
  if (cached && cached.key === key) return cached.re
  const parts = []
  for (const w of Array.isArray(o.words) ? o.words : [])
    if (typeof w === "string" && w.trim())
      parts.push(w.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  for (const p of Array.isArray(o.patterns) ? o.patterns : []) {
    if (typeof p !== "string" || !p) continue
    try {
      // Compiled on its own first, so a pattern is either wholly in the
      // matcher or wholly left out, never half-matched.
      new RegExp(p)
      parts.push("(?:" + p + ")")
    } catch {
      // An invalid pattern is ignored. See the README's "If a pattern does
      // not compile".
    }
  }
  if (!parts.length) {
    cached = { key, re: null }
    return null
  }
  try {
    const re = new RegExp(parts.join("|"), "gi")
    cached = { key, re }
    return re
  } catch {
    // Not reachable in practice: every part compiled on its own above, and an
    // alternation of valid patterns is valid. Kept so that a gateway-wide
    // setting can never be the reason a request is turned away.
    cached = { key, re: null }
    return null
  }
}

// scan calls fn on each piece of text an agent sent: every user turn, in
// whichever shape its API carries text, plus the system prompt when
// withSystem is set. Tool calls and tool results are left out.
function scan(body, protocol, withSystem, fn) {
  if (!body || typeof body !== "object") return

  if (protocol === "gemini") {
    const contents = Array.isArray(body.contents) ? body.contents : []
    for (const m of contents) {
      if (!m || typeof m !== "object") continue
      // Gemini has no system role: its systemInstruction carries the
      // system prompt, read below.
      if (m.role !== undefined && m.role !== "user") continue
      if (!Array.isArray(m.parts)) continue
      // A part flagged as a thought is the model's own, not the user's.
      for (const p of m.parts) {
        if (p && typeof p.text === "string" && !p.thought) fn(p.text)
      }
    }
    if (withSystem) {
      // systemInstruction is documented as a Content: either the bare
      // { parts } object or a plain string, and clients have been seen
      // sending it as system_instruction. All three are read.
      if (body.systemInstruction) systemTexts(body.systemInstruction, fn)
      if (body.system_instruction) systemTexts(body.system_instruction, fn)
    }
    return
  }

  if (protocol === "responses") {
    if (withSystem) {
      if (typeof body.instructions === "string") fn(body.instructions)
      for (const m of Array.isArray(body.messages) ? body.messages : [])
        if (m && (m.role === "system" || m.role === "developer")) texts(m.content, fn)
    }
    if (typeof body.input === "string") {
      fn(body.input)
      return
    }
    for (const m of Array.isArray(body.input) ? body.input : []) {
      if (!m || typeof m !== "object") continue
      // developer is the Responses spelling of a system turn, and is read on
      // the same terms as one. (Chat Completions has its own developer role;
      // the two are read alike.)
      if (m.role === "system" || m.role === "developer") {
        if (withSystem) texts(m.content, fn)
        continue
      }
      // An item with no role is function output, which is left alone.
      if (m.role !== undefined && m.role !== "user") continue
      texts(m.content, fn)
    }
    return
  }

  // Anthropic and Chat Completions both carry messages[].
  //
  // Anthropic keeps the system prompt out of messages: it is a top-level
  // `system` field, a string or — for Claude Code and the current API — an
  // array of text blocks. Only the Chat branch below sees it as a message.
  if (withSystem && protocol === "anthropic" && body.system) {
    texts(body.system, fn)
  }
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!m || typeof m !== "object") continue
    if (m.role === "system" || m.role === "developer") {
      if (withSystem) texts(m.content, fn)
      continue
    }
    if (m.role !== "user") continue
    texts(m.content, fn)
  }
}

// systemTexts reads a Gemini system instruction, which is a Content: a bare
// { parts } object, or a plain string.
function systemTexts(si, fn) {
  if (typeof si === "string") {
    fn(si)
    return
  }
  if (!si || typeof si !== "object" || !Array.isArray(si.parts)) return
  for (const p of si.parts) {
    if (p && typeof p.text === "string" && !p.thought) fn(p.text)
  }
}

// texts calls fn on every text a message's content holds: it as a plain
// string, or in its text / input_text blocks. Tool use, tool results and
// images are passed over.
function texts(content, fn) {
  if (typeof content === "string") {
    fn(content)
    return
  }
  if (!Array.isArray(content)) return
  for (const p of content) {
    if (!p || typeof p !== "object") continue
    if (p.type === "text" || p.type === "input_text" || p.type === "output_text") {
      if (typeof p.text === "string") fn(p.text)
    }
  }
}