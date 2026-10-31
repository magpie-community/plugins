// What each agent is really doing, read from the session files the agents
// themselves write, as they write them: Claude Code's, Codex's, DeepSeek
// Harness's, Gemini CLI's, Qwen Code's, Pi's and omp's, GitHub Copilot CLI's,
// Kimi Code's, Grok Build's, and any agent that keeps Claude Code's format
// (Qoder, WorkBuddy, CodeBuddy). Every agent's own record, whatever model it
// talks to: one that never passes magpie's gateway is seen as well as one
// that does.
//
// Pure: a reader takes a file's text (its tail) and gives a session's facts.
// No I/O of its own; lib/scan.mjs finds and reads the files and knows today.
//
// A session's facts: { agent, id, cwd, title, query, model, started, updated,
//   phase, step, reply, pending, error, turns,
//   messages, tokensToday, turnsToday, context, contextWindow,
//   subagent, parent, profile }
// messages: the last MESSAGES_MAX things said or done, oldest first, each
//   { role: "user"|"assistant"|"tool", text, name?, at }. A tool entry's text
//   is only the tool's name: its arguments may carry secrets.
// tokensToday/turnsToday: local-calendar-day counts from what the file records.
// context/contextWindow: the latest prompt's size and its model window, 0 when
//   the agent's file does not say.
// subagent/parent/profile: a child session and the session (or agent profile)
//   it belongs to.
//
// The Kimi, Grok and Copilot readers adapt the file formats described by
// whatsmyagentdoing (https://github.com/Charonyuu/whatsmyagentdoing, MIT);
// its parser is the reference for their event shapes.
// phase is what its own record last said:
//   "thinking"  a turn is under way, the model has the word
//   "tool"      a tool call it made has no result yet
//   "approval"  it asked to run something and waits for the user's yes
//   "ask"       it asked the user a question and waits for the answer
//   "done"      its turn ended
//   "aborted"   the user stopped it
//   "error"     its turn ended on an error

export const TEXT_MAX = 280
export const QUERY_MAX = 200
export const TITLE_MAX = 48
export const MESSAGES_MAX = 8
export const MESSAGE_TEXT_MAX = 500

export function clip(s, n) {
  s = String(s ?? "").replace(/\s+/g, " ").trim()
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s
}

const ASK_TOOLS = /^(?:askuserquestion|ask_?user(?:_?question)?|request_?user_?input|ask_?followup_?question|ask_?human|exitplanmode|exit_plan_mode|user_?input|ask_user_question)$/i

function parseArgs(a) {
  if (a && typeof a === "object") return a
  try { return JSON.parse(a) } catch { return typeof a === "string" ? { input: a } : {} }
}

// a tool call as a person reads it: "Bash · npm test"
export function toolLine(name, args) {
  const a = parseArgs(args)
  const cmd = Array.isArray(a.command) ? a.command.join(" ") : a.command ?? a.cmd
  let what = cmd ?? a.file_path ?? a.path ?? a.filePath ?? a.pattern ?? a.query ?? a.url ?? a.description ?? a.title ?? a.prompt ?? a.code ?? a.input ?? ""
  if (typeof what !== "string") what = JSON.stringify(what)
  // Codex's code mode wraps a command in JS: show the command
  const inner = /exec_command\(\{\s*cmd:\s*"((?:[^"\\]|\\.)*)"/.exec(what)
  if (inner) what = inner[1].replace(/\\"/g, '"')
  const s = clip(what, 90)
  return s ? `${name} · ${s}` : String(name)
}

function lines(text) {
  const out = []
  for (const l of String(text).split("\n")) {
    if (!l || l[0] !== "{") continue
    try { out.push(JSON.parse(l)) } catch {}
  }
  return out
}

function ms(t) {
  if (typeof t === "number") return t < 1e12 ? t * 1000 : t
  const n = Date.parse(t)
  return Number.isFinite(n) ? n : 0
}

// Local calendar day, like the wall clock a person reading the dashboard sees.
function dayKey(t) {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

// Per-day usage lives off the session object: it never travels to the page.
const BUCKETS = new WeakMap() // session -> Map(day -> { turns, tokens })
function bucket(s, t) {
  if (!t) return null
  let days = BUCKETS.get(s)
  if (!days) BUCKETS.set(s, (days = new Map()))
  const k = dayKey(t)
  let b = days.get(k)
  if (!b) days.set(k, (b = { turns: 0, tokens: 0 }))
  return b
}
function countTurn(s, t) {
  const b = bucket(s, t)
  if (b) b.turns++
}
function addTokens(s, t, n) {
  if (!Number.isFinite(n) || n <= 0) return
  const b = bucket(s, t)
  if (b) b.tokens += n
}
function finalizeUsage(s, now) {
  const b = BUCKETS.get(s)?.get(dayKey(now))
  s.tokensToday = b ? Math.round(b.tokens) : 0
  s.turnsToday = b ? b.turns : 0
}

// A tool's arguments can hold secrets; a message keeps only its name.
const STREAMS = new WeakMap() // session -> { role, text, msg }
function streamMsg(s, role, chunk, t) {
  let st = STREAMS.get(s)
  if (!st && !chunk) return
  if (!st || st.role !== role) {
    st = { role, text: "", msg: { role, text: "", at: t || 0 } }
    s.messages.push(st.msg)
    STREAMS.set(s, st)
    while (s.messages.length > MESSAGES_MAX) s.messages.shift()
  }
  st.text = clip(st.text + String(chunk ?? ""), MESSAGE_TEXT_MAX)
  st.msg.text = st.text
}
function endStream(s) { STREAMS.delete(s) }

function message(s, role, text, t, name, stream = false) {
  if (!text) return
  if (stream) { streamMsg(s, role, text, t); return }
  endStream(s)
  const m = { role, text: clip(text, MESSAGE_TEXT_MAX), at: t || 0 }
  if (name) m.name = String(name)
  s.messages.push(m)
  while (s.messages.length > MESSAGES_MAX) s.messages.shift()
}

function textOf(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((c) => (typeof c === "string" ? c : c && (c.type === "text" || c.type === "input_text" || c.type === "output_text") ? c.text || "" : "")).filter(Boolean).join("\n")
}

// what a person typed, not what the agent's harness wraps around it
function realPrompt(t) {
  t = String(t ?? "").trim()
  if (!t) return ""
  // what the agent put in itself: the environment, instructions, AGENTS.md
  if (t.startsWith("<") || t.startsWith("# AGENTS.md") || t.startsWith("# Files mentioned by the user")) return ""
  if (/^\[Request interrupted/.test(t)) return ""
  if (/^Caveat: The messages below/.test(t)) return ""
  return t
}

function base(p) {
  const s = String(p ?? "").replace(/[\\/]+$/, "")
  return s.slice(Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\")) + 1)
}

function fresh(agent, id) {
  return { agent, id, cwd: "", project: "", title: "", query: "", model: "", started: 0, updated: 0,
    phase: "", step: "", stepName: "", reply: "", pending: [], error: "", turns: 0,
    messages: [], tokensToday: 0, turnsToday: 0, context: 0, contextWindow: 0,
    subagent: false, parent: "", profile: "" }
}

function touch(s, t) {
  if (!t) return
  if (!s.started || t < s.started) s.started = t
  if (t > s.updated) s.updated = t
}

function prompted(s, text, t) {
  const q = realPrompt(text)
  if (!q) return false
  s.query = clip(q, QUERY_MAX)
  if (!s.title) s.title = clip(q, TITLE_MAX)
  s.turns++
  countTurn(s, t)
  s.phase = "thinking"
  s.reply = ""
  s.error = ""
  s.pending = []
  message(s, "user", q, t)
  touch(s, t)
  return true
}

function called(s, id, name, args, t) {
  const line = toolLine(name, args)
  s.pending.push({ id: String(id || line), name: String(name), line, at: t })
  s.step = line
  s.stepName = String(name)
  s.phase = ASK_TOOLS.test(name) ? "ask" : "tool"
  message(s, "tool", String(name || "tool"), t, String(name || "tool"))
  touch(s, t)
}

function answered(s, id, t) {
  const i = s.pending.findIndex((p) => p.id === String(id))
  if (i >= 0) s.pending.splice(i, 1)
  else if (!id) s.pending.shift()
  if (!s.pending.length && (s.phase === "tool" || s.phase === "approval" || s.phase === "ask")) s.phase = "thinking"
  touch(s, t)
}

// ---- Claude Code (and the agents that keep its format) ---------------------
// ~/.claude/projects/<folder>/<session>.jsonl: one line per message; an
// assistant message with tool_use blocks, then a user message whose
// tool_result blocks answer them; stop_reason "end_turn" ends the turn.
export function readClaude(text, agent = "claude", id = "", opts = {}) {
  const s = fresh(agent, id)
  if (opts.subagent) s.subagent = true
  let usageId = null
  for (const d of lines(text)) {
    const t = ms(d.timestamp)
    if (d.sessionId && !s.id) s.id = d.sessionId
    if (d.cwd) { s.cwd = d.cwd; s.project = base(d.cwd) }
    if (d.type === "custom-title" && d.customTitle) { s.title = clip(d.customTitle, TITLE_MAX); s.named = true }
    else if (d.type === "ai-title" && d.aiTitle && !s.named) s.title = clip(d.aiTitle, TITLE_MAX)
    if (d.isSidechain && !s.subagent) continue
    const m = d.message
    if (!m) continue
    if (d.type === "user" && m.role === "user") {
      if (Array.isArray(m.content)) {
        let results = 0
        for (const b of m.content) if (b?.type === "tool_result") { answered(s, b.tool_use_id, t); results++ }
        if (results) continue
        const txt = textOf(m.content)
        if (/^\[Request interrupted/.test(txt.trim())) { s.phase = "aborted"; s.pending = []; touch(s, t); continue }
        if (!d.isMeta) prompted(s, txt, t)
      } else if (!d.isMeta) {
        if (/^\[Request interrupted/.test(String(m.content).trim())) { s.phase = "aborted"; s.pending = []; touch(s, t); continue }
        prompted(s, m.content, t)
      }
      continue
    }
    if (d.type === "assistant" && m.role === "assistant") {
      if (m.model && m.model !== "<synthetic>") s.model = m.model
      // One response is logged once per content block with the same usage.
      const u = m.usage
      if (u && typeof u === "object" && (m.id == null || m.id !== usageId)) {
        if (m.id != null) usageId = m.id
        const n = (k) => (Number.isFinite(u[k]) ? u[k] : 0)
        const prompt = n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens")
        const out = n("output_tokens")
        if (prompt + out > 0) {
          s.context = prompt + out
          // A prompt past 200k is the long-context window; Claude does not
          // record the window itself.
          s.contextWindow = s.context > 200_000 ? 1_000_000 : 200_000
        }
        addTokens(s, t, n("input_tokens") + n("cache_creation_input_tokens") + out)
      }
      const blocks = Array.isArray(m.content) ? m.content : []
      const txt = blocks.filter((b) => b?.type === "text").map((b) => b.text).join("\n").trim()
      if (txt) { s.reply = clip(txt, TEXT_MAX); message(s, "assistant", txt, t) }
      for (const b of blocks) if (b?.type === "tool_use") called(s, b.id, b.name, b.input, t)
      if (d.isApiErrorMessage) { s.phase = "error"; s.error = clip(txt, 160); s.pending = [] }
      else if (m.stop_reason === "end_turn" || m.stop_reason === "stop_sequence") { s.phase = "done"; s.pending = [] }
      else if (!blocks.some((b) => b?.type === "tool_use") && s.phase !== "tool") s.phase = "thinking"
      touch(s, t)
    }
  }
  finalizeUsage(s, opts.now ?? Date.now())
  return s
}

// ---- Codex ----------------------------------------------------------------
// ~/.codex/sessions/YYYY/MM/DD/rollout-…-<thread>.jsonl: session_meta, then
// response_items (messages, function_call / custom_tool_call and their
// outputs) and event_msgs (task_started, task_complete, turn_aborted,
// *_approval_request, error).
export function readCodex(text, id = "", opts = {}) {
  const s = fresh("codex", id)
  for (const d of lines(text)) {
    const t = ms(d.timestamp)
    const p = d.payload || {}
    if (d.type === "session_meta") {
      s.id = p.id || p.session_id || s.id
      if (p.cwd) { s.cwd = p.cwd; s.project = base(p.cwd) }
      touch(s, ms(p.timestamp) || t)
      continue
    }
    if (d.type === "turn_context" && p.cwd) { s.cwd = p.cwd; s.project = base(p.cwd); if (p.model) s.model = p.model }
    if (d.type === "event_msg") {
      switch (p.type) {
        case "thread_settings_applied": if (p.thread_settings?.model) s.model = p.thread_settings.model; break
        case "thread_name_updated": if (p.thread_name) s.title = clip(p.thread_name, TITLE_MAX); break
        case "task_started": s.phase = "thinking"; s.pending = []; s.error = ""; touch(s, t); break
        case "user_message": prompted(s, p.message, t); break
        case "item_completed":
          if (p.item?.type === "UserMessage") prompted(s, textOf(p.item.content), t)
          break
        case "exec_approval_request": case "apply_patch_approval_request": case "request_permissions":
          s.phase = "approval"
          s.stepName = p.command ? "shell" : p.type === "apply_patch_approval_request" ? "apply_patch" : "request_permissions"
          s.step = p.command ? toolLine("shell", { command: p.command }) : s.stepName
          touch(s, t)
          break
        case "request_user_input": s.phase = "ask"; touch(s, t); break
        case "token_count": {
          const last = p.info?.last_token_usage
          if (last && typeof last === "object") {
            const n = (k) => (Number.isFinite(last[k]) ? last[k] : 0)
            s.context = n("input_tokens") + n("output_tokens")
            if (Number.isFinite(p.info?.model_context_window) && p.info.model_context_window > 0) s.contextWindow = p.info.model_context_window
            addTokens(s, t, n("input_tokens") - n("cached_input_tokens") + n("output_tokens"))
          }
          break
        }
        case "agent_message": if (p.message) { s.reply = clip(p.message, TEXT_MAX); message(s, "assistant", p.message, t) } touch(s, t); break
        case "task_complete":
          s.phase = "done"; s.pending = []
          if (p.last_agent_message) { s.reply = clip(p.last_agent_message, TEXT_MAX); message(s, "assistant", p.last_agent_message, ms(p.completed_at) || t) }
          touch(s, ms(p.completed_at) || t)
          break
        case "turn_aborted": s.phase = "aborted"; s.pending = []; touch(s, ms(p.completed_at) || t); break
        case "error": s.phase = "error"; s.error = clip(p.message, 160); s.pending = []; touch(s, t); break
      }
      continue
    }
    if (d.type === "response_item") {
      switch (p.type) {
        case "function_call": called(s, p.call_id, p.name, p.arguments, t); break
        case "custom_tool_call": called(s, p.call_id, p.name, p.input, t); break
        case "local_shell_call": called(s, p.call_id, "shell", { command: p.action?.command }, t); break
        case "function_call_output": case "custom_tool_call_output": case "local_shell_call_output": answered(s, p.call_id, t); break
        case "message":
          if (p.role === "assistant") { const x = textOf(p.content).trim(); if (x) { s.reply = clip(x, TEXT_MAX); message(s, "assistant", x, t) } }
          touch(s, t)
          break
        case "reasoning": if (s.phase !== "tool" && s.phase !== "approval") s.phase = s.phase === "done" ? "done" : "thinking"; touch(s, t); break
      }
    }
  }
  finalizeUsage(s, opts.now ?? Date.now())
  return s
}

// ---- DeepSeek Harness -----------------------------------------------------
// ~/.dsh/sessions/<folder>/<session>/session.v4.jsonl.zstd: typed events —
// session, turn/start, tool/call, approval/asked, approval/decided,
// tool/result, assistant/message, turn/end {reason: completed|aborted|error}.
export function readDsh(text, id = "", opts = {}) {
  const s = fresh("dsh", id)
  for (const d of lines(text)) {
    const t = ms(d.time || d.createdAt)
    const x = d.data || {}
    switch (d.type) {
      case "session": s.id = d.id || s.id; if (d.cwd) { s.cwd = d.cwd; s.project = base(d.cwd) } touch(s, ms(d.createdAt)); break
      case "session/title": if (x.title) s.title = clip(x.title, TITLE_MAX); break
      case "working-directory/change": if (x.cwd || x.to) { s.cwd = x.cwd || x.to; s.project = base(s.cwd) } break
      case "model/selection": if (x.model) s.model = x.model; break
      case "user/message": if (x.source?.kind === "user") prompted(s, textOf(x.content), t); break
      case "turn/start": s.phase = "thinking"; s.pending = []; s.error = ""; touch(s, t); break
      case "tool/call": called(s, x.callId, x.name, x.arguments, t); break
      case "approval/asked": s.phase = "approval"; touch(s, t); break
      case "approval/decided": if (s.phase === "approval") s.phase = s.pending.length ? "tool" : "thinking"; touch(s, t); break
      case "tool/result": answered(s, x.message?.toolCallId || x.message?.source?.callId, t); break
      case "assistant/message": {
        const c = x.message?.content
        const txt = Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text).join("\n").trim() : ""
        if (txt) { s.reply = clip(txt, TEXT_MAX); message(s, "assistant", txt, t) }
        touch(s, t)
        break
      }
      case "turn/end": {
        const k = x.reason?.kind
        s.pending = []
        if (k === "aborted") s.phase = "aborted"
        else if (k === "error") { s.phase = "error"; s.error = clip(x.reason?.error?.message, 160) }
        else s.phase = "done"
        touch(s, t)
        break
      }
    }
  }
  finalizeUsage(s, opts.now ?? Date.now())
  return s
}

// ---- Gemini CLI / Qwen Code -----------------------------------------------
// ~/.gemini/tmp/<project>/chats/session-*.json(l): messages, the model's
// with toolCalls each carrying a status (scheduled, awaiting_approval,
// executing, success, error, cancelled).
export function readGemini(text, agent = "gemini", id = "", opts = {}) {
  const s = fresh(agent, id)
  let msgs = []
  const trimmed = String(text).trim()
  if (trimmed.startsWith("{") && !trimmed.includes("\n{")) {
    try { const j = JSON.parse(trimmed); msgs = j.messages || []; s.id = j.sessionId || id; touch(s, ms(j.startTime)) } catch {}
  } else {
    for (const d of lines(text)) {
      if (d.sessionId && !s.id) s.id = d.sessionId
      if (Array.isArray(d.messages)) msgs.push(...d.messages)
      else if (d.type) msgs.push(d)
    }
  }
  const seenTools = new Set()
  for (const m of msgs) {
    const t = ms(m.timestamp)
    if (m.type === "user") {
      const txt = typeof m.content === "string" ? m.content : textOf(m.content)
      if (!/functionResponse/.test(JSON.stringify(m.content || ""))) prompted(s, txt, t)
      continue
    }
    if (m.type === "gemini" || m.type === "model" || m.type === "assistant") {
      if (m.model) s.model = m.model
      const txt = typeof m.content === "string" ? m.content : textOf(m.content)
      if (txt.trim()) { s.reply = clip(txt, TEXT_MAX); message(s, "assistant", txt, t) }
      const calls = Array.isArray(m.toolCalls) ? m.toolCalls : []
      s.pending = []
      for (const c of calls) {
        const st = String(c.status || "").toLowerCase()
        if (c.name) s.stepName = String(c.name)
        if (c.name && !seenTools.has(c.id || c.name)) { seenTools.add(c.id || c.name); message(s, "tool", String(c.name), t, String(c.name)) }
        if (st === "awaiting_approval") { s.phase = "approval"; s.step = toolLine(c.name, c.args) }
        else if (st === "scheduled" || st === "executing" || st === "validating") { s.pending.push({ id: c.id, name: c.name, line: toolLine(c.name, c.args), at: t }); s.step = toolLine(c.name, c.args) }
        else if (c.name) s.step = toolLine(c.name, c.args)
      }
      if (s.phase !== "approval") s.phase = s.pending.length ? "tool" : calls.length ? "thinking" : "done"
      touch(s, t)
    }
    if (m.type === "error") { s.phase = "error"; s.error = clip(m.content, 160); touch(s, t) }
    if (m.type === "info" && /cancel/i.test(String(m.content))) { s.phase = "aborted"; touch(s, t) }
  }
  finalizeUsage(s, opts.now ?? Date.now())
  return s
}

// ---- Pi / omp ----------------------------------------------------------------
// ~/.pi/agent/sessions/<folder>/<time>_<id>.jsonl: a session header, then
// message lines whose message has a role (user, assistant, toolResult) and,
// for the assistant, a stopReason (stop, toolUse, aborted, error).
export function readPi(text, agent = "pi", id = "", opts = {}) {
  const s = fresh(agent, id)
  for (const d of lines(text)) {
    const t = ms(d.timestamp)
    if (d.type === "session") { s.id = d.id || s.id; if (d.cwd) { s.cwd = d.cwd; s.project = base(d.cwd) } touch(s, t); continue }
    if (d.type === "session_info" && d.name) s.title = clip(d.name, TITLE_MAX)
    if (d.type === "title_change" && d.title) s.title = clip(d.title, TITLE_MAX)
    if (d.type === "model_change") s.model = d.modelId || d.model || s.model
    const m = d.message
    if (d.type !== "message" || !m) continue
    if (m.role === "user") { prompted(s, textOf(m.content), t); continue }
    if (m.role === "toolResult") { answered(s, m.toolCallId, t); continue }
    if (m.role === "assistant") {
      if (m.model) s.model = m.model
      const parts = Array.isArray(m.content) ? m.content : []
      const txt = parts.filter((p) => p?.type === "text").map((p) => p.text).join("\n").trim()
      if (txt) { s.reply = clip(txt, TEXT_MAX); message(s, "assistant", txt, t) }
      for (const p of parts) if (p?.type === "toolCall") called(s, p.id, p.name, p.arguments, t)
      if (m.stopReason === "stop" || m.stopReason === "length") { s.phase = "done"; s.pending = [] }
      else if (m.stopReason === "aborted") { s.phase = "aborted"; s.pending = [] }
      else if (m.stopReason === "error") { s.phase = "error"; s.error = clip(m.errorMessage, 160); s.pending = [] }
      touch(s, t)
    }
  }
  finalizeUsage(s, opts.now ?? Date.now())
  return s
}

// ---- GitHub Copilot CLI ----------------------------------------------------
// ~/.copilot/session-state/<session>/events.jsonl: session.start, user.message,
// assistant.message, tool.execution_start / _complete / _error, session.end.
// The event shapes follow whatsmyagentdoing's Copilot parser (MIT).
function extractCopilotText(value, depth = 0) {
  if (value == null || depth > 4) return ""
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map((v) => extractCopilotText(v, depth + 1)).join("\n")
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text
    if (typeof value.content === "string") return value.content
    if (Array.isArray(value.content)) return extractCopilotText(value.content, depth + 1)
    if (typeof value.message === "string") return value.message
  }
  return ""
}

export function readCopilot(text, id = "", opts = {}) {
  const s = fresh("copilot", id)
  for (const d of lines(text)) {
    if (!d || typeof d !== "object") continue
    const data = d.data || d
    const t = ms(d.timestamp) || ms(data.startTime) || ms(data.timestamp)
    switch (d.type) {
      case "session.start":
        if (data.context?.cwd) { s.cwd = data.context.cwd; s.project = base(s.cwd) }
        else if (data.context?.gitRoot) { s.cwd = data.context.gitRoot; s.project = base(s.cwd) }
        if (data.selectedModel) s.model = data.selectedModel
        touch(s, ms(data.startTime) || t)
        break
      case "user.message":
        prompted(s, extractCopilotText(data.content ?? data.transformedContent ?? data.prompt), t)
        break
      case "assistant.message": {
        const txt = extractCopilotText(data.content ?? data.message)
        if (txt) { s.reply = clip(txt, TEXT_MAX); message(s, "assistant", txt, t) }
        if (data.model) s.model = data.model
        if (s.phase !== "tool" && s.phase !== "approval" && s.phase !== "ask") s.phase = "thinking"
        touch(s, t)
        break
      }
      case "tool.execution_start": {
        const name = data.toolName || data.tool_name || "tool"
        const callId = data.toolCallId || data.callId || data.id
        // The message keeps the name only; arguments may hold secrets.
        called(s, callId, name, {}, t)
        break
      }
      case "tool.execution_complete":
        answered(s, data.toolCallId || data.callId || data.id, t)
        if (data.model) s.model = data.model
        break
      case "tool.execution_error":
        s.phase = "error"; s.error = clip(data.message || "Tool error", 160); touch(s, t)
        break
      case "session.end": s.phase = "done"; s.pending = []; touch(s, t); break
      case "session.error": s.phase = "error"; s.error = clip(data.message || data.error, 160); touch(s, t); break
    }
  }
  finalizeUsage(s, opts.now ?? Date.now())
  return s
}

// ---- Kimi Code --------------------------------------------------------------
// ~/.kimi-code/sessions/<project>/<session>/agents/<agent>/wire.jsonl, with
// <session>/state.json for cwd/title. A child agent is a session of its own:
// id "<session>/<agent>", parent "<session>". Event names and shapes follow
// whatsmyagentdoing's Kimi reader (MIT).
export function readKimi(text, id = "", meta = {}, opts = {}) {
  const s = fresh("kimi", id)
  const rawId = String(id || "")
  if (rawId.includes("/")) { s.subagent = true; s.parent = rawId.slice(0, rawId.lastIndexOf("/")) }
  if (meta && typeof meta === "object") {
    if (typeof meta.cwd === "string" && meta.cwd) { s.cwd = meta.cwd; s.project = base(s.cwd) }
    else if (typeof meta.workDir === "string" && meta.workDir) { s.cwd = meta.workDir; s.project = base(s.cwd) }
    if (typeof meta.title === "string" && meta.title) s.title = clip(meta.title, TITLE_MAX)
    else if (typeof meta.customTitle === "string" && meta.customTitle) s.title = clip(meta.customTitle, TITLE_MAX)
    if (typeof meta.model === "string" && meta.model) s.model = meta.model
    else if (typeof meta.modelAlias === "string" && meta.modelAlias) s.model = meta.modelAlias
    touch(s, ms(meta.createdAt))
  }
  const approvals = new Map() // id -> "approval" | "ask"
  const sync = () => {
    if (approvals.size) { s.phase = approvals.values().next().value; return }
    s.phase = s.pending.length ? "tool" : "thinking"
  }
  const ended = (reason, t, err) => {
    s.pending = []; approvals.clear()
    const k = String(reason || "").toLowerCase()
    if (["cancelled", "canceled", "aborted", "interrupted", "max-tokens", "max_tokens"].includes(k)) s.phase = "aborted"
    else if (["error", "failed", "failure"].includes(k)) { s.phase = "error"; s.error = clip(err || "Turn failed", 160) }
    else s.phase = "done"
    touch(s, t)
  }
  for (const d of lines(text)) {
    const t = ms(d.time)
    const e = d.event || {}
    switch (d.type) {
      case "profile.bind":
        if (d.modelAlias) s.model = d.modelAlias
        if (d.environmentDisclosure?.cwd) { s.cwd = d.environmentDisclosure.cwd; s.project = base(s.cwd) }
        break
      case "turn.prompt":
        s.pending = []; approvals.clear()
        if (!prompted(s, textOf(d.input), t)) { s.phase = "thinking"; s.reply = ""; touch(s, t) }
        break
      case "agent.turn.started":
        s.pending = []; approvals.clear(); s.reply = ""; s.phase = "thinking"; s.error = ""
        touch(s, t)
        break
      case "llm.request":
        if (d.modelAlias || d.model) s.model = d.modelAlias || d.model
        if (s.phase !== "tool" && s.phase !== "approval" && s.phase !== "ask") s.phase = "thinking"
        break
      case "interaction.request":
        approvals.set(String(d.id || ""), d.kind === "question" ? "ask" : "approval")
        s.stepName = d.kind === "question" ? "Question" : "Approval"
        s.step = s.stepName
        s.phase = approvals.get(String(d.id || ""))
        touch(s, t)
        break
      case "interaction.resolved":
        approvals.delete(String(d.id || "")); sync(); touch(s, t)
        break
      case "turn.cancel": case "prompt.aborted":
        ended("cancelled", t)
        break
      case "turn.ended":
        ended(d.reason, t, d.error?.message || d.error)
        break
      case "agent.turn.ended":
        ended(d.outcome, t, d.error?.message || d.error)
        break
      case "forked":
        s.pending = []; approvals.clear(); s.reply = ""; s.query = ""; s.phase = "thinking"; touch(s, t)
        break
      case "context.append_loop_event":
        switch (e.type) {
          case "step.begin": s.reply = ""; endStream(s); sync(); touch(s, t); break
          case "tool.call": called(s, e.toolCallId, e.name, e.arguments || e.args, t); if (approvals.size) sync(); break
          case "tool.result": answered(s, e.toolCallId, t); if (approvals.size) sync(); break
          case "content.part":
            if (e.part?.type === "text" && e.part.text) {
              s.reply = clip((s.reply || "") + e.part.text, TEXT_MAX)
              message(s, "assistant", e.part.text, t, undefined, true)
              if (s.phase !== "tool" && s.phase !== "approval" && s.phase !== "ask") s.phase = "thinking"
              touch(s, t)
            } else if (e.part?.type === "think") {
              if (s.phase !== "tool" && s.phase !== "approval" && s.phase !== "ask") s.phase = "thinking"
            }
            break
          // step.end and usage.record end a model call, not the turn
        }
        break
      case "usage.record": {
        const u = d.usage || d.data?.usage || e.usage
        if (u && typeof u === "object") {
          const n = (k) => (Number.isFinite(u[k]) ? u[k] : 0)
          const add = n("inputTokens") + n("outputTokens") || n("input_tokens") + n("output_tokens")
          addTokens(s, t, add)
        }
        break
      }
    }
  }
  finalizeUsage(s, opts.now ?? Date.now())
  return s
}

// ---- Grok Build -------------------------------------------------------------
// ~/.grok/sessions/<project>/<session>/updates.jsonl, with summary.json for
// cwd/title/model and an explicit subagent kind. Each line is
// { timestamp (seconds), params: { update: { sessionUpdate, ... } } }; ACP
// chunk types follow whatsmyagentdoing's Grok reader (MIT).
export function readGrok(text, id = "", meta = {}, opts = {}) {
  const s = fresh("grok", id)
  if (meta && typeof meta === "object") {
    const info = meta.info || {}
    if (typeof info.cwd === "string" && info.cwd) { s.cwd = info.cwd; s.project = base(s.cwd) }
    const title = meta.generated_title || meta.session_summary || meta.title
    if (typeof title === "string" && title) s.title = clip(title, TITLE_MAX)
    if (typeof meta.current_model_id === "string" && meta.current_model_id) s.model = meta.current_model_id
    touch(s, ms(meta.created_at))
    // A fork is a separate main session; only an explicit subagent kind is a child.
    if (typeof meta.session_kind === "string" && meta.session_kind.startsWith("subagent")) {
      s.subagent = true
      if (meta.parent_session_id) s.parent = String(meta.parent_session_id)
    }
  }
  let previous = ""
  let userBuf = ""
  let replyStream = null
  let replyBuf = ""
  const completeTool = (callId, title) => {
    const i = s.pending.findIndex((p) => p.id === String(callId))
    if (i >= 0) {
      if (title) { s.pending[i].name = String(title); s.pending[i].line = String(title) }
      s.pending.splice(i, 1)
    }
    if (!s.pending.length && s.phase === "tool") s.phase = "thinking"
  }
  for (const d of lines(text)) {
    const p = d.params || {}
    const e = p.update || {}
    const type = e.sessionUpdate
    const t = ms(d.timestamp)
    const tm = p._meta || {}
    const start = Number.isFinite(tm.turnStartMs) ? tm.turnStartMs : t
    switch (type) {
      case "user_message_chunk": {
        if (previous !== type) {
          userBuf = ""
          prompted(s, e.content?.text || "", start)
        }
        userBuf = clip(userBuf + (e.content?.text || ""), QUERY_MAX)
        if (userBuf) {
          s.query = userBuf
          const last = s.messages[s.messages.length - 1]
          if (last?.role === "user") last.text = clip(userBuf, MESSAGE_TEXT_MAX)
        }
        if (e._meta?.modelId || tm.modelId) s.model = e._meta?.modelId || tm.modelId
        if (s.phase !== "tool" && s.phase !== "approval" && s.phase !== "ask") s.phase = "thinking"
        touch(s, start)
        break
      }
      case "agent_thought_chunk":
        if (s.phase !== "tool" && s.phase !== "approval" && s.phase !== "ask") s.phase = "thinking"
        touch(s, t)
        break
      case "agent_message_chunk": {
        const streamStart = tm.streamStartMs
        if ((streamStart != null && streamStart !== replyStream) || (streamStart == null && previous !== type)) {
          replyStream = streamStart ?? null
          replyBuf = ""
          endStream(s)
        }
        replyBuf = clip(replyBuf + (e.content?.text || ""), TEXT_MAX)
        if (replyBuf) s.reply = replyBuf
        message(s, "assistant", e.content?.text || "", t, undefined, true)
        if (s.phase !== "tool" && s.phase !== "approval" && s.phase !== "ask") s.phase = "thinking"
        touch(s, t)
        break
      }
      case "tool_call":
      case "tool_call_update": {
        const callId = e.toolCallId || e.id
        const title = e.title || e._meta?.["x.ai/tool"]?.name || tm?.updateParams?.title
        const status = String(e.status || tm.updateParams?.status || "").toLowerCase()
        const done = ["completed", "complete", "failed"].includes(status)
        if (done) completeTool(callId, title)
        else if (callId) {
          const existing = s.pending.find((x) => x.id === String(callId))
          if (existing) {
            if (title) { existing.name = String(title); existing.line = String(title); s.stepName = String(title); s.step = String(title) }
          } else {
            called(s, callId, title || "Tool", {}, t)
          }
          if (s.phase !== "approval" && s.phase !== "ask") s.phase = "tool"
        }
        touch(s, t)
        break
      }
      case "turn_completed": {
        s.pending = []
        const reason = String(e.stop_reason || "").toLowerCase()
        if (reason === "rate_limit") { s.phase = "error"; s.error = "Rate limited" }
        else if (["max_tokens", "refusal", "cancelled", "canceled", "interrupted", "aborted"].includes(reason)) s.phase = "aborted"
        else if (["error", "failed"].includes(reason)) { s.phase = "error"; s.error = "Turn failed" }
        else s.phase = "done"
        touch(s, t)
        break
      }
      case "retry_state":
        if (s.phase !== "tool" && s.phase !== "approval" && s.phase !== "ask") s.phase = "thinking"
        break
    }
    if (type) previous = type
  }
  finalizeUsage(s, opts.now ?? Date.now())
  return s
}

export const READERS = { claude: readClaude, codex: readCodex, dsh: readDsh, gemini: readGemini, pi: readPi,
  copilot: readCopilot, kimi: readKimi, grok: readGrok }
