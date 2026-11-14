// magpie async gateway hook: every agent request magpie serves gets the
// shared memory recalled from the TDAI memory-core kernel put before the
// user's message, and each finished turn is written back to the kernel's
// L0, which its pipeline turns into L1 atoms, L2 scenes and the L3 core.
// No Memory Proxy: magpie's gateway is the only hop. Capture is off until
// the options turn it on, and only this computer's own agents are served
// until `remote` is on.
//
// Prompt caching: a turn's recall is fetched once, kept, and put into that
// same user message on every later request of the session, so the history
// an agent sends stays byte for byte what it was and its cache holds.

import { KernelError, block, capture, config, cut, hash, recall, scope } from "./lib.mjs"

const SESSIONS_MAX = 300
const TURNS_MAX = 500
const RETRY_AFTER_MS = 60_000
const sessions = new Map() // key → {entries: Map<fp, entry>, turns: Map<fp, turn>}
// the user's own requests: direct local ones, and the sharing key magpie
// writes into the agents on this computer. Other gateway keys (a friend's),
// remote requests and an origin magpie doesn't name are someone else's.
const OWN = new Set(["local", "magpie-key"])

function sessionOf(key) {
  let s = sessions.get(key)
  if (s) sessions.delete(key) // re-insert: Map order is the LRU order
  else s = { entries: new Map(), turns: new Map() }
  sessions.set(key, s)
  while (sessions.size > SESSIONS_MAX) sessions.delete(sessions.keys().next().value)
  return s
}

function trim(map) {
  while (map.size > TURNS_MAX) map.delete(map.keys().next().value)
}

export async function onRequest(body, ctx) {
  const o = config(ctx.options)
  if (!o.recall && !o.capture) return void ctx.report("skipped")
  if (!o.agents.includes(ctx.agent)) return void ctx.report("skipped")
  // someone else's requests neither read nor add to this memory unless asked for
  if (!o.remote && !OWN.has(ctx.origin)) return void ctx.report("skipped")
  // side requests (titles, summaries, classifiers) carry no tools
  if (o.requireTools && !hasTools(body)) return void ctx.report("skipped")
  const msgs = userMessages(body, ctx.protocol)
  if (!msgs.length) return void ctx.report("skipped")

  const query = String(ctx.query || "").trim()
  const probe = query.slice(0, 500)
  const target = (probe && findLast(msgs, (m) => m.text.includes(probe))) || findLast(msgs, (m) => m.text.trim() && !m.onlyTools)
  if (!target) return void ctx.report("skipped")
  const fp = hash(target.text)
  const s = sessionOf(`${ctx.agent}:${ctx.session || "-"}`)
  const sc = scope(o, ctx.agent)
  ctx.state.turn = { fp, query: query || stripReminders(target.text), sc }

  let changed = false, bytes = 0, failed = false
  if (o.recall) {
    const fps = msgs.map((m) => hash(m.text))
    // an entry whose message has left the request's history can never be
    // applied again (the agent dropped it, e.g. after a compaction): free it,
    // so the cache follows the live history and trim can only ever drop what
    // the session has abandoned
    const live = new Set(fps)
    for (const k of s.entries.keys()) if (!live.has(k)) s.entries.delete(k)

    let e = s.entries.get(fp)
    if (!e || (e.failedAt && Date.now() - e.failedAt > RETRY_AFTER_MS)) {
      e = { block: "", pending: null, failedAt: 0 }
      s.entries.set(fp, e)
      trim(s.entries)
      e.pending = recall(o, sc, ctx.state.turn.query, ctx.signal)
        .then((r) => { e.block = block(r, o.maxInjectChars); e.failedAt = 0 })
        .catch((err) => { e.failedAt = Date.now(); throw err })
        .finally(() => { e.pending = null })
    }
    if (e.pending) {
      try {
        await e.pending
      } catch (err) {
        failed = true
        ctx.report(err instanceof KernelError ? err.kind : "unavailable")
      }
    }
    // every user message whose turn had a recall gets it again, the current
    // one too; each use gives its entry a fresh LRU position, so a message a
    // session still sends never ages out while new turns keep arriving
    for (let i = 0; i < msgs.length; i++) {
      const en = s.entries.get(fps[i])
      if (!en?.block) continue
      s.entries.delete(fps[i]) // in use: not old
      s.entries.set(fps[i], en)
      msgs[i].prepend(en.block)
      changed = true
      if (msgs[i] === target) bytes = Buffer.byteLength(en.block)
    }
  }
  if (changed) {
    ctx.report("ready", bytes)
    return body
  }
  if (!failed) ctx.report("empty")
}

export async function onResponse(reply, ctx) {
  const o = config(ctx.options)
  const t = ctx.state?.turn
  if (!o.capture || !t || !ctx.success || !reply || typeof reply !== "object") return
  const s = sessionOf(`${ctx.agent}:${ctx.session || "-"}`)
  let turn = s.turns.get(t.fp)
  if (!turn) {
    turn = { texts: [] }
    s.turns.set(t.fp, turn)
    trim(s.turns)
  }
  const { text, final } = replyText(reply, ctx.protocol)
  if (text && turn.texts[turn.texts.length - 1] !== text) turn.texts.push(text)
  if (!final || !turn.texts.length || !t.query) return
  const answer = middle(turn.texts.join("\n\n"), 7900)
  turn.texts = []
  const user = o.includeCwd && ctx.cwd ? `[${ctx.agent} · ${ctx.cwd}]\n${t.query}` : t.query
  try {
    await capture(o, t.sc, `${ctx.agent}:${ctx.session || "nosession"}`, user, answer, ctx.signal)
  } catch {
    // the hook's own outcome is the request's; a lost capture costs one turn of L0
  }
}

// ---- protocol shapes -------------------------------------------------------

function hasTools(b) {
  return (Array.isArray(b.tools) && b.tools.length > 0) || (Array.isArray(b.config?.tools) && b.config.tools.length > 0)
}

function findLast(a, f) {
  for (let i = a.length - 1; i >= 0; i--) if (f(a[i])) return a[i]
  return null
}

const TOOL_PARTS = new Set(["tool_result", "function_call_output", "functionResponse"])

// userMessages are the user's messages, each with its text (as hashed to
// know it again) and a way to put a block before it.
function userMessages(b, protocol) {
  const out = []
  const fromParts = (parts, textOf, make, isTool) => {
    const text = parts.map(textOf).filter(Boolean).join("\n")
    const onlyTools = parts.length > 0 && parts.every(isTool)
    return {
      text, onlyTools,
      prepend(x) {
        let i = 0
        while (i < parts.length && isTool(parts[i])) i++ // tool results stay first
        parts.splice(i, 0, make(x))
      },
    }
  }
  const fromString = (holder, key) => ({
    text: holder[key], onlyTools: false,
    prepend(x) { holder[key] = `${x}\n\n${holder[key]}` },
  })
  switch (protocol) {
    case "anthropic":
    case "chat":
      for (const m of Array.isArray(b.messages) ? b.messages : []) {
        if (!m || m.role !== "user") continue
        if (typeof m.content === "string") out.push(fromString(m, "content"))
        else if (Array.isArray(m.content)) out.push(fromParts(m.content, (p) => (p?.type === "text" ? p.text : ""), (x) => ({ type: "text", text: x }), (p) => TOOL_PARTS.has(p?.type)))
      }
      break
    case "responses":
      if (typeof b.input === "string") out.push(fromString(b, "input"))
      else for (const m of Array.isArray(b.input) ? b.input : []) {
        if (!m || m.role !== "user" || (m.type && m.type !== "message")) continue
        if (typeof m.content === "string") out.push(fromString(m, "content"))
        else if (Array.isArray(m.content)) out.push(fromParts(m.content, (p) => (p?.type === "input_text" ? p.text : ""), (x) => ({ type: "input_text", text: x }), () => false))
      }
      break
    case "gemini":
      for (const m of Array.isArray(b.contents) ? b.contents : []) {
        if (!m || m.role !== "user" || !Array.isArray(m.parts)) continue
        out.push(fromParts(m.parts, (p) => (typeof p?.text === "string" ? p.text : ""), (x) => ({ text: x }), (p) => !!p?.functionResponse))
      }
      break
  }
  return out
}

// replyText is a whole reply's text, and whether it ends the turn (no tool
// call is waiting on the agent).
function replyText(r, protocol) {
  switch (protocol) {
    case "anthropic": {
      const parts = Array.isArray(r.content) ? r.content : []
      return { text: parts.filter((p) => p?.type === "text").map((p) => p.text).join("\n").trim(), final: r.stop_reason === "end_turn" || r.stop_reason === "stop_sequence" }
    }
    case "chat": {
      const c = r.choices?.[0]
      const m = c?.message ?? {}
      const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p) => p?.text ?? "").join("") : ""
      return { text: text.trim(), final: c?.finish_reason === "stop" && !(m.tool_calls?.length) }
    }
    case "responses": {
      const items = Array.isArray(r.output) ? r.output : []
      const text = items.filter((i) => i?.type === "message").flatMap((i) => i.content ?? []).filter((p) => p?.type === "output_text").map((p) => p.text).join("\n")
      return { text: text.trim(), final: (r.status ?? "completed") === "completed" && !items.some((i) => /call$/.test(String(i?.type ?? ""))) }
    }
    case "gemini": {
      const c = r.candidates?.[0]
      const parts = c?.content?.parts ?? []
      return { text: parts.filter((p) => typeof p?.text === "string" && !p.thought).map((p) => p.text).join("").trim(), final: c?.finishReason === "STOP" && !parts.some((p) => p?.functionCall) }
    }
  }
  return { text: "", final: false }
}

function stripReminders(t) {
  return String(t).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim()
}

// middle keeps a long answer's start and its end, where the conclusion is
function middle(s, n) {
  if (s.length <= n) return s
  const head = Math.floor(n * 0.25)
  return s.slice(0, head) + "\n…\n" + cut(s.slice(s.length - (n - head - 3)), n - head - 3)
}
