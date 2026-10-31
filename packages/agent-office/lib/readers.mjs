// What each agent is really doing, read from the session files the agents
// themselves write, as they write them: Claude Code's, Codex's, DeepSeek
// Harness's, Gemini CLI's, Qwen Code's, Pi's and omp's, GitHub Copilot CLI's,
// Kimi Code's, Grok Build's, and any agent that keeps Claude Code's format
// (Qoder, WorkBuddy, CodeBuddy). Every agent's own record, whatever model it
// talks to: one that never passes magpie's gateway is seen as well as one
// that does.
//
// Pure: a reader takes a file's text or JSONL line iterator and gives a session's facts.
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

function* lines(text) {
  // The scanner supplies complete appended JSONL lines. Consume each batch
  // immediately without retaining raw text or parsed events between updates.
  const input = typeof text === "string" ? text.split("\n") : text || []
  for (const l of input) {
    const line = typeof l === "string" ? l.trimStart() : ""
    if (!line || line[0] !== "{") continue
    try { yield JSON.parse(line) } catch {}
  }
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
function adjustTokens(s, t, n) {
  if (!Number.isFinite(n) || n === 0) return
  const b = bucket(s, t)
  if (b) b.tokens += n
}
function addTokens(s, t, n) {
  if (!Number.isFinite(n) || n <= 0) return
  const b = bucket(s, t)
  if (b) b.tokens += n
}
export function finalizeUsage(s, now) {
  const b = BUCKETS.get(s)?.get(dayKey(now))
  s.tokensToday = b ? Math.round(b.tokens) : 0
  s.turnsToday = b ? b.turns : 0
}

// Preserve a trailing separator until the next chunk, but normalize runs so
// whitespace-only chunks cannot consume the whole bounded text buffer.
function appendChunk(text, chunk, max) {
  return (text + String(chunk ?? "")).replace(/\s+/g, " ").trimStart().slice(0, max + 2)
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
  // Keep raw, bounded text between chunks; clip only the displayed value.
  // Trimming each chunk turns ["hello ", "world"] into "helloworld".
  st.text = appendChunk(st.text, chunk, MESSAGE_TEXT_MAX)
  st.msg.text = clip(st.text, MESSAGE_TEXT_MAX)
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
function claudeEvents(s, opts) {
  if (opts.subagent) s.subagent = true
  const responseUsage = new Map()
  return (d) => {
    const t = ms(d.timestamp)
    if (d.sessionId && !s.id) s.id = d.sessionId
    if (d.cwd) { s.cwd = d.cwd; s.project = base(d.cwd) }
    if (d.type === "custom-title" && d.customTitle) { s.title = clip(d.customTitle, TITLE_MAX); s.named = true }
    else if (d.type === "ai-title" && d.aiTitle && !s.named) s.title = clip(d.aiTitle, TITLE_MAX)
    if (d.isSidechain && !s.subagent) return
    const m = d.message
    if (!m) return
    if (d.type === "user" && m.role === "user") {
      if (Array.isArray(m.content)) {
        let results = 0
        for (const b of m.content) if (b?.type === "tool_result") { answered(s, b.tool_use_id, t); results++ }
        if (results) return
        const txt = textOf(m.content)
        if (/^\[Request interrupted/.test(txt.trim())) { s.phase = "aborted"; s.pending = []; touch(s, t); return }
        if (!d.isMeta) prompted(s, txt, t)
      } else if (!d.isMeta) {
        if (/^\[Request interrupted/.test(String(m.content).trim())) { s.phase = "aborted"; s.pending = []; touch(s, t); return }
        prompted(s, m.content, t)
      }
      return
    }
    if (d.type === "assistant" && m.role === "assistant") {
      if (m.model && m.model !== "<synthetic>") s.model = m.model
      // A response can appear once per content block, with a later block
      // updating its output usage. Count its final record once, even if other
      // responses were interleaved between its blocks.
      const u = m.usage
      if (u && typeof u === "object") {
        const n = (k) => (Number.isFinite(u[k]) ? u[k] : 0)
        const prompt = n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens")
        const out = n("output_tokens")
        if (prompt + out > 0) {
          s.context = prompt + out
          // A prompt past 200k is the long-context window; Claude does not
          // record the window itself.
          s.contextWindow = s.context > 200_000 ? 1_000_000 : 200_000
        }
        const tokens = n("input_tokens") + n("cache_creation_input_tokens") + out
        if (m.id != null) {
          const old = responseUsage.get(m.id)
          if (old) adjustTokens(s, old.t, -old.tokens)
          responseUsage.set(m.id, { t, tokens })
          addTokens(s, t, tokens)
        }
        else addTokens(s, t, tokens)
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
}

// ---- Codex ----------------------------------------------------------------
// ~/.codex/sessions/YYYY/MM/DD/rollout-…-<thread>.jsonl: session_meta, then
// response_items (messages, function_call / custom_tool_call and their
// outputs) and event_msgs (task_started, task_complete, turn_aborted,
// *_approval_request, error).
function codexEvents(s, opts) {
  return (d) => {
    const t = ms(d.timestamp)
    const p = d.payload || {}
    if (d.type === "session_meta") {
      s.id = p.id || p.session_id || s.id
      if (p.cwd) { s.cwd = p.cwd; s.project = base(p.cwd) }
      touch(s, ms(p.timestamp) || t)
      return
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
      return
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
}

// ---- DeepSeek Harness -----------------------------------------------------
// ~/.dsh/sessions/<folder>/<session>/session.v4.jsonl.zstd: typed events —
// session, turn/start, tool/call, approval/asked, approval/decided,
// tool/result, assistant/message, turn/end {reason: completed|aborted|error}.
function dshEvents(s, opts) {
  return (d) => {
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
}

// ---- Gemini CLI / Qwen Code -----------------------------------------------
// ~/.gemini/tmp/<project>/chats/session-*.json(l): messages, the model's
// with toolCalls each carrying a status (scheduled, awaiting_approval,
// executing, success, error, cancelled).
function geminiEvents(s, opts) {
  const seenTools = new Set()
  return (m) => {
    const t = ms(m.timestamp)
    if (m.type === "user") {
      const txt = typeof m.content === "string" ? m.content : textOf(m.content)
      if (!/functionResponse/.test(JSON.stringify(m.content || ""))) prompted(s, txt, t)
      return
    }
    if (m.type === "gemini" || m.type === "model" || m.type === "assistant") {
      if (m.model) s.model = m.model
      const txt = typeof m.content === "string" ? m.content : textOf(m.content)
      if (txt.trim()) { s.reply = clip(txt, TEXT_MAX); message(s, "assistant", txt, t) }
      const calls = Array.isArray(m.toolCalls) ? m.toolCalls : []
      s.pending = []
      s.phase = "thinking"
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
}

// ---- Pi / omp ----------------------------------------------------------------
// ~/.pi/agent/sessions/<folder>/<time>_<id>.jsonl: a session header, then
// message lines whose message has a role (user, assistant, toolResult) and,
// for the assistant, a stopReason (stop, toolUse, aborted, error).
function piEvents(s, opts) {
  return (d) => {
    const t = ms(d.timestamp)
    if (d.type === "session") { s.id = d.id || s.id; if (d.cwd) { s.cwd = d.cwd; s.project = base(d.cwd) } touch(s, t); return }
    if (d.type === "session_info" && d.name) s.title = clip(d.name, TITLE_MAX)
    if (d.type === "title_change" && d.title) s.title = clip(d.title, TITLE_MAX)
    if (d.type === "model_change") s.model = d.modelId || d.model || s.model
    const m = d.message
    if (d.type !== "message" || !m) return
    if (m.role === "user") { prompted(s, textOf(m.content), t); return }
    if (m.role === "toolResult") { answered(s, m.toolCallId, t); return }
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

function copilotEvents(s, opts) {
  return (d) => {
    if (!d || typeof d !== "object") return
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
}

// ---- Kimi Code --------------------------------------------------------------
// ~/.kimi-code/sessions/<project>/<session>/agents/<agent>/wire.jsonl, with
// <session>/state.json for cwd/title. A child agent is a session of its own:
// id "<session>/<agent>", parent "<session>". Event names and shapes follow
// whatsmyagentdoing's Kimi reader (MIT).
function kimiEvents(s, opts) {
  const rawId = String(s.id || "")
  if (rawId.includes("/")) { s.subagent = true; s.parent = rawId.slice(0, rawId.lastIndexOf("/")) }
  const approvals = new Map() // id -> "approval" | "ask"
  const sync = () => {
    if (approvals.size) { s.phase = approvals.values().next().value; return }
    s.phase = s.pending.length ? "tool" : "thinking"
  }
  const ended = (reason, t, err) => {
    endStream(s)
    s.pending = []; approvals.clear()
    const k = String(reason || "").toLowerCase()
    if (["cancelled", "canceled", "aborted", "interrupted", "max-tokens", "max_tokens"].includes(k)) s.phase = "aborted"
    else if (["error", "failed", "failure"].includes(k)) { s.phase = "error"; s.error = clip(err || "Turn failed", 160) }
    else s.phase = "done"
    touch(s, t)
  }
  return (d) => {
    const t = ms(d.time)
    const e = d.event || {}
    switch (d.type) {
      case "profile.bind":
        if (d.modelAlias) s.model = d.modelAlias
        if (d.environmentDisclosure?.cwd) { s.cwd = d.environmentDisclosure.cwd; s.project = base(s.cwd) }
        break
      case "turn.prompt":
        endStream(s)
        s.pending = []; approvals.clear()
        if (!prompted(s, textOf(d.input), t)) { s.phase = "thinking"; s.reply = ""; touch(s, t) }
        break
      case "agent.turn.started":
        endStream(s)
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
        endStream(s)
        s.pending = []; approvals.clear(); s.reply = ""; s.query = ""; s.phase = "thinking"; touch(s, t)
        break
      case "context.append_loop_event":
        switch (e.type) {
          case "step.begin": s.reply = ""; endStream(s); sync(); touch(s, t); break
          case "tool.call": called(s, e.toolCallId, e.name, e.arguments || e.args, t); if (approvals.size) sync(); break
          case "tool.result": answered(s, e.toolCallId, t); if (approvals.size) sync(); break
          case "content.part":
            if (e.part?.type === "text" && e.part.text) {
              message(s, "assistant", e.part.text, t, undefined, true)
              s.reply = clip(STREAMS.get(s).text, TEXT_MAX)
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
}

// ---- Grok Build -------------------------------------------------------------
// ~/.grok/sessions/<project>/<session>/updates.jsonl, with summary.json for
// cwd/title/model and an explicit subagent kind. Each line is
// { timestamp (seconds), params: { update: { sessionUpdate, ... } } }; ACP
// chunk types follow whatsmyagentdoing's Grok reader (MIT).
function grokEvents(s, opts) {
  let previous = ""
  let userBuf = ""
  let userTurn = null
  let userPrompted = false
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
  return (d) => {
    const p = d.params || {}
    const e = p.update || {}
    const type = e.sessionUpdate
    const t = ms(d.timestamp)
    const tm = p._meta || {}
    const start = Number.isFinite(tm.turnStartMs) ? tm.turnStartMs : t
    switch (type) {
      case "user_message_chunk": {
        if (previous !== type || (Number.isFinite(tm.turnStartMs) && tm.turnStartMs !== userTurn)) {
          endStream(s)
          replyStream = null
          replyBuf = ""
          userBuf = ""
          userPrompted = false
          userTurn = start
        }
        userBuf = appendChunk(userBuf, e.content?.text, MESSAGE_TEXT_MAX)
        if (!userPrompted) userPrompted = prompted(s, userBuf, start)
        if (userPrompted) {
          s.query = clip(userBuf, QUERY_MAX)
          if (s.turns === 1) s.title = clip(userBuf, TITLE_MAX)
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
        replyBuf = appendChunk(replyBuf, e.content?.text, TEXT_MAX)
        if (replyBuf) s.reply = clip(replyBuf, TEXT_MAX)
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
}

// A reader owns only its live parsing state, bounded text, and usage/dedupe
// indexes. update receives newly appended complete lines, never a replay.
const PROCESSORS = { claude: claudeEvents, codex: codexEvents, dsh: dshEvents,
  gemini: geminiEvents, pi: piEvents, copilot: copilotEvents, kimi: kimiEvents, grok: grokEvents }

function refreshMetadata(s, kind, meta) {
  if (!meta || typeof meta !== "object") return
  if (kind === "kimi") {
    const cwd = typeof meta.cwd === "string" && meta.cwd ? meta.cwd : meta.workDir
    if (!s.cwd && typeof cwd === "string" && cwd) { s.cwd = cwd; s.project = base(cwd) }
    const title = typeof meta.title === "string" && meta.title ? meta.title : meta.customTitle
    if (typeof title === "string" && title) s.title = clip(title, TITLE_MAX)
    const model = typeof meta.model === "string" && meta.model ? meta.model : meta.modelAlias
    if (!s.model && typeof model === "string" && model) s.model = model
    touch(s, ms(meta.createdAt))
  } else if (kind === "grok") {
    const cwd = meta.info?.cwd
    if (!s.cwd && typeof cwd === "string" && cwd) { s.cwd = cwd; s.project = base(cwd) }
    const title = meta.generated_title || meta.session_summary || meta.title
    if (typeof title === "string" && title) s.title = clip(title, TITLE_MAX)
    if (!s.model && typeof meta.current_model_id === "string" && meta.current_model_id) s.model = meta.current_model_id
    touch(s, ms(meta.created_at))
    if (typeof meta.session_kind === "string") {
      s.subagent = meta.session_kind.startsWith("subagent")
      s.parent = s.subagent && meta.parent_session_id ? String(meta.parent_session_id) : ""
    }
  }
}

export function createSessionReader(kind, agent = kind, id = "", opts = {}) {
  const processor = PROCESSORS[kind]
  if (!processor) throw new TypeError(`Unknown session reader: ${kind}`)
  const session = fresh(agent, id)
  // Sidecars describe the current snapshot, not events. Keep their values out
  // of parser state so removing them restores facts already read from the log.
  const exposed = kind === "kimi" || kind === "grok" ? fresh(agent, id) : session
  const days = new Map()
  BUCKETS.set(session, days)
  BUCKETS.set(exposed, days) // cached scans finalize usage on the exposed object
  let metadata = opts.meta
  const defaultNow = opts.now
  const state = { subagent: opts.subagent }
  const consume = processor(session, state)
  const publish = (now) => {
    if (exposed !== session) {
      Object.assign(exposed, session)
      refreshMetadata(exposed, kind, metadata)
    }
    finalizeUsage(exposed, now)
    return exposed
  }
  let usageDays = new Map()
  // Grok's usage sidecar is a replacement snapshot. Keep only totals per
  // calendar day so corrections and removal never double count prior usage.
  // Its session total and modelUsage repeat turn deltas, not extra charges.
  const refreshUsage = (usage) => {
    const next = new Map()
    for (const turn of Array.isArray(usage?.turns) ? usage.turns : []) {
      if (!turn || typeof turn !== "object") continue
      const t = ms(turn.endedAt)
      if (!t) continue
      const n = (k) => Number.isFinite(turn[k]) && turn[k] > 0 ? turn[k] : 0
      const key = dayKey(t)
      const day = next.get(key) || { t, tokens: 0 }
      day.tokens += Math.max(0, n("inputTokens") - n("cachedReadTokens")) + n("outputTokens")
      next.set(key, day)
    }
    for (const day of usageDays.values()) adjustTokens(session, day.t, -day.tokens)
    for (const day of next.values()) addTokens(session, day.t, day.tokens)
    usageDays = next
  }
  if (kind === "grok" && opts.usage !== undefined) refreshUsage(opts.usage)
  function update(input, changes = {}) {
    const { usage, now } = changes
    if (Object.hasOwn(changes, "meta")) metadata = changes.meta
    for (const d of lines(input)) {
      if (kind === "gemini") {
        if (d.sessionId && !session.id) session.id = d.sessionId
        if (d.startTime) touch(session, ms(d.startTime))
        if (Array.isArray(d.messages)) { for (const m of d.messages) consume(m) }
        else if (d.type) consume(d)
      } else consume(d)
    }
    if (kind === "grok" && usage !== undefined) refreshUsage(usage)
    return publish(now ?? defaultNow ?? Date.now())
  }
  publish(opts.now ?? Date.now())
  return { session: exposed, update }
}

export function readClaude(text, agent = "claude", id = "", opts = {}) {
  return createSessionReader("claude", agent, id, opts).update(text)
}
export function readCodex(text, id = "", opts = {}) {
  return createSessionReader("codex", "codex", id, opts).update(text)
}
export function readDsh(text, id = "", opts = {}) {
  return createSessionReader("dsh", "dsh", id, opts).update(text)
}
export function readGemini(text, agent = "gemini", id = "", opts = {}) {
  // Gemini also writes a whole JSON document rather than JSONL.
  if (typeof text === "string") {
    try {
      const document = JSON.parse(text)
      if (document && Array.isArray(document.messages)) {
        id = document.sessionId || id
        text = [JSON.stringify(document)]
      }
    } catch {}
  }
  return createSessionReader("gemini", agent, id, opts).update(text)
}
export function readPi(text, agent = "pi", id = "", opts = {}) {
  return createSessionReader("pi", agent, id, opts).update(text)
}
export function readCopilot(text, id = "", opts = {}) {
  return createSessionReader("copilot", "copilot", id, opts).update(text)
}
export function readKimi(text, id = "", meta = {}, opts = {}) {
  return createSessionReader("kimi", "kimi", id, { ...opts, meta }).update(text)
}
export function readGrok(text, id = "", meta = {}, opts = {}) {
  return createSessionReader("grok", "grok", id, { ...opts, meta }).update(text)
}

export const READERS = { claude: readClaude, codex: readCodex, dsh: readDsh, gemini: readGemini, pi: readPi,
  copilot: readCopilot, kimi: readKimi, grok: readGrok }
