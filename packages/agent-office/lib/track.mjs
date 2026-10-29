// What each agent session is doing, worked out from the requests and replies
// magpie's gateway sees: the gateway hook (office.hooks.mjs) hands every
// request and every finished reply here, and the page draws what this
// remembers. Pure: no file, no clock of its own (now is passed in), so a
// test drives it.
//
// It keeps facts, not a status: whether a request is out, what the request
// answered (the user, or a tool's result), and how the last reply ended
// (with tool calls, a question, plain text, or an error). The page turns
// them into a status against its own clock (page/model.js), so a session
// whose tools have run for minutes reads as waiting for you without the
// hook writing anything.

const TEXT_MAX = 280
const QUERY_MAX = 200
const TITLE_MAX = 48
const SESSIONS_MAX = 60
// a request with no answer this long is lost (the host keeps a run 15 min)
const LOST_MS = 15 * 60 * 1000

// tools whose call is the agent asking the user something
const ASK_TOOLS = /^(?:askuserquestion|ask_?user(?:_?question)?|request_?user_?input|ask_?followup_?question|ask_?human|exitplanmode|exit_plan_mode|user_?input)$/i

export function clip(s, n) {
  s = String(s ?? "").replace(/\s+/g, " ").trim()
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s
}

function textOf(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((p) => (typeof p === "string" ? p : p && (p.type === "text" || p.type === "output_text" || p.type === "input_text" || (p.text && !p.type)) ? p.text ?? "" : ""))
    .filter(Boolean)
    .join("\n")
}

// what the request answers: "tool" when its last turn is a tool's result,
// else "user"
export function turnOf(body, protocol) {
  if (!body || typeof body !== "object") return "user"
  if (protocol === "responses") {
    const input = body.input
    if (!Array.isArray(input) || !input.length) return "user"
    const last = input[input.length - 1]
    return /_output$/.test(String(last?.type ?? "")) ? "tool" : "user"
  }
  if (protocol === "gemini") {
    const c = Array.isArray(body.contents) ? body.contents[body.contents.length - 1] : null
    return (c?.parts ?? []).some((p) => p?.functionResponse) ? "tool" : "user"
  }
  const msgs = Array.isArray(body.messages) ? body.messages : []
  const last = msgs[msgs.length - 1]
  if (!last) return "user"
  if (last.role === "tool" || last.role === "function") return "tool"
  if (Array.isArray(last.content) && last.content.some((b) => b?.type === "tool_result")) return "tool"
  return "user"
}

export function hasTools(body) {
  if (!body || typeof body !== "object") return false
  if (Array.isArray(body.tools) && body.tools.length) return true
  if (Array.isArray(body.functions) && body.functions.length) return true
  return Array.isArray(body.config?.tools) && body.config.tools.length > 0
}

function parseArgs(a) {
  if (a && typeof a === "object") return a
  try { return JSON.parse(a) } catch { return typeof a === "string" ? { input: a } : {} }
}

// a tool call as a line a person reads: "Bash · npm test"
export function toolLine(name, args) {
  const a = parseArgs(args)
  const cmd = Array.isArray(a.command) ? a.command.join(" ") : a.command ?? a.cmd
  const what = cmd ?? a.file_path ?? a.path ?? a.filePath ?? a.pattern ?? a.query ?? a.url ?? a.description ?? a.prompt ?? a.input ?? ""
  const s = clip(typeof what === "string" ? what : JSON.stringify(what), 80)
  return s ? `${name} · ${s}` : String(name)
}

// how a reply ended: { text, tools: [{ name, line }] }
export function replyOf(reply, protocol) {
  const out = { text: "", tools: [] }
  if (!reply || typeof reply !== "object") return out
  const add = (name, args) => { if (name) out.tools.push({ name: String(name), line: toolLine(name, args) }) }
  if (protocol === "responses") {
    const r = reply.response && Array.isArray(reply.response.output) ? reply.response : reply
    const texts = []
    for (const it of Array.isArray(r.output) ? r.output : []) {
      if (it?.type === "message") texts.push(textOf(it.content))
      else if (it?.type === "function_call") add(it.name, it.arguments)
      else if (it?.type === "custom_tool_call") add(it.name, it.input)
      else if (it?.type === "local_shell_call") add("shell", { command: it.action?.command })
      else if (it?.type === "web_search_call") add("web_search", { query: it.action?.query })
    }
    out.text = texts.join("\n")
    return out
  }
  if (protocol === "gemini") {
    const parts = reply.candidates?.[0]?.content?.parts ?? []
    out.text = parts.filter((p) => typeof p?.text === "string" && !p.thought).map((p) => p.text).join("")
    for (const p of parts) if (p?.functionCall) add(p.functionCall.name, p.functionCall.args)
    return out
  }
  if (Array.isArray(reply.choices)) {
    const m = reply.choices[0]?.message ?? {}
    out.text = textOf(m.content)
    for (const c of Array.isArray(m.tool_calls) ? m.tool_calls : []) add(c.function?.name, c.function?.arguments)
    if (m.function_call) add(m.function_call.name, m.function_call.arguments)
    return out
  }
  // Anthropic Messages
  const blocks = Array.isArray(reply.content) ? reply.content : []
  out.text = blocks.filter((b) => b?.type === "text").map((b) => b.text).join("\n")
  for (const b of blocks) if (b?.type === "tool_use" || b?.type === "server_tool_use") add(b.name, b.input)
  return out
}

// whether a reply's last words ask the user something
export function asks(text) {
  const t = String(text ?? "").replace(/[\s*_`>)\]"'”’」』]+$/u, "")
  return /[?？]$/.test(t)
}

export function outcomeOf(r) {
  if (r.tools.some((t) => ASK_TOOLS.test(t.name))) return "ask"
  if (r.tools.length) return "tools"
  return asks(r.text) ? "ask" : "text"
}

function base(p) {
  const s = String(p ?? "").replace(/[\\/]+$/, "")
  return s.slice(Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\")) + 1)
}

export function keyOf(ctx) {
  const agent = ctx?.agent || "agent"
  if (ctx?.session) return `${agent}|${ctx.session}`
  if (ctx?.cwd) return `${agent}|cwd:${ctx.cwd}`
  return `${agent}|model:${ctx?.model || "?"}`
}

export function createTracker(opts = {}) {
  const o = { text: true, remote: false, ...opts }
  const sessions = new Map()

  function wanted(ctx) {
    if (!ctx) return false
    if (o.remote) return true
    // local by default: the page is this computer's; a hook on an older
    // magpie says no origin, and is taken as local
    return !ctx.origin || ctx.origin === "local"
  }

  function prune(now) {
    for (const [k, s] of sessions) if (s.inflight > 0 && now - s.inflightSince > LOST_MS) {
      s.inflight = 0
      s.last = { at: now, outcome: "error", text: "", step: "", error: "lost" }
      sessions.set(k, s)
    }
    if (sessions.size <= SESSIONS_MAX) return
    const old = [...sessions.values()].filter((s) => !s.inflight).sort((a, b) => a.updated - b.updated)
    for (const s of old.slice(0, sessions.size - SESSIONS_MAX)) sessions.delete(s.key)
  }

  // a request on its way: the session is at work
  function request(body, ctx, now) {
    if (!wanted(ctx)) return null
    const key = keyOf(ctx)
    let s = sessions.get(key)
    const tools = hasTools(body)
    // a side request (a quick topic check, a summary) of a session that
    // works with tools is not its work
    if (s && s.tools && !tools) return null
    if (!s) {
      s = { key, agent: ctx.agent || "agent", session: ctx.session || "", cwd: ctx.cwd || "", project: base(ctx.cwd),
        title: "", query: "", model: ctx.model || "", started: now, updated: now, turns: 0, steps: 0,
        tools, inflight: 0, inflightSince: 0, turn: "user", last: null }
      sessions.set(key, s)
    }
    const turn = turnOf(body, ctx.protocol)
    if (turn === "user" && ctx.query) {
      s.turns++
      if (o.text) {
        s.query = clip(ctx.query, QUERY_MAX)
        if (!s.title) s.title = clip(ctx.query, TITLE_MAX)
      }
    } else if (turn === "tool") s.steps++
    s.tools = s.tools || tools
    s.model = ctx.model || s.model
    if (ctx.cwd && !s.cwd) { s.cwd = ctx.cwd; s.project = base(ctx.cwd) }
    s.turn = turn
    if (!s.inflight) s.inflightSince = now
    s.inflight++
    s.updated = now
    prune(now)
    return key
  }

  // a reply done: how it ended
  function response(reply, ctx, now, success) {
    const key = keyOf(ctx)
    const s = sessions.get(key)
    if (!s || !s.inflight) return null
    s.inflight--
    if (!s.inflight) s.inflightSince = 0
    s.updated = now
    if (!success) {
      s.last = { at: now, outcome: "error", text: "", step: s.last?.step ?? "" }
      return key
    }
    const r = replyOf(reply, ctx?.protocol ?? ctx?.request?.protocol)
    // a reply that says nothing and calls nothing (a stream cut short) is
    // no ending of its own
    if (!r.text && !r.tools.length && s.last) return key
    const outcome = outcomeOf(r)
    s.last = {
      at: now, outcome,
      text: o.text ? clip(r.text, TEXT_MAX) : "",
      step: r.tools.length ? (o.text ? r.tools.map((t) => t.line).join("  ·  ").slice(0, 160) : r.tools.map((t) => t.name).join(", ")) : s.last?.step ?? "",
      toolNames: r.tools.map((t) => t.name).slice(0, 6),
    }
    return key
  }

  function snapshot(now) {
    prune(now)
    return { v: 1, written: now, text: o.text, sessions: [...sessions.values()].sort((a, b) => a.started - b.started) }
  }

  // after a restart of the host: what was written last, nothing in flight
  function restore(snap, now) {
    for (const s of Array.isArray(snap?.sessions) ? snap.sessions : []) {
      if (!s || typeof s.key !== "string") continue
      if (s.inflight) {
        s.inflight = 0
        s.inflightSince = 0
        if (!s.last || s.last.at < s.updated) s.last = { at: now, outcome: "error", text: "", step: s.last?.step ?? "", error: "restarted" }
      }
      sessions.set(s.key, s)
    }
  }

  return { request, response, snapshot, restore, sessions, options: o }
}
