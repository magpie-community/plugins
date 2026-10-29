// What each agent is really doing, read from the session files the agents
// themselves write, as they write them: Claude Code's, Codex's, DeepSeek
// Harness's, Gemini CLI's, Qwen Code's, Pi's and omp's, and any agent that
// keeps Claude Code's format (Qoder, WorkBuddy, CodeBuddy). Every agent's
// own record, whatever model it talks to: one that never passes magpie's
// gateway is seen as well as one that does.
//
// Pure: a reader takes a file's text (its tail) and gives a session's facts.
// No clock of its own, no I/O; lib/scan.mjs finds and reads the files.
//
// A session's facts: { agent, id, cwd, title, query, model, started, updated,
//   phase, step, reply, pending, error, turns }
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
    phase: "", step: "", reply: "", pending: [], error: "", turns: 0 }
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
  s.phase = "thinking"
  s.reply = ""
  s.error = ""
  s.pending = []
  touch(s, t)
  return true
}

function called(s, id, name, args, t) {
  const line = toolLine(name, args)
  s.pending.push({ id: String(id || line), name: String(name), line, at: t })
  s.step = line
  s.phase = ASK_TOOLS.test(name) ? "ask" : "tool"
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
export function readClaude(text, agent = "claude", id = "") {
  const s = fresh(agent, id)
  for (const d of lines(text)) {
    const t = ms(d.timestamp)
    if (d.sessionId && !s.id) s.id = d.sessionId
    if (d.cwd) { s.cwd = d.cwd; s.project = base(d.cwd) }
    if (d.type === "custom-title" && d.customTitle) { s.title = clip(d.customTitle, TITLE_MAX); s.named = true }
    else if (d.type === "ai-title" && d.aiTitle && !s.named) s.title = clip(d.aiTitle, TITLE_MAX)
    if (d.isSidechain) continue
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
      const blocks = Array.isArray(m.content) ? m.content : []
      const txt = blocks.filter((b) => b?.type === "text").map((b) => b.text).join("\n").trim()
      if (txt) s.reply = clip(txt, TEXT_MAX)
      for (const b of blocks) if (b?.type === "tool_use") called(s, b.id, b.name, b.input, t)
      if (d.isApiErrorMessage) { s.phase = "error"; s.error = clip(txt, 160); s.pending = [] }
      else if (m.stop_reason === "end_turn" || m.stop_reason === "stop_sequence") { s.phase = "done"; s.pending = [] }
      else if (!blocks.some((b) => b?.type === "tool_use") && s.phase !== "tool") s.phase = "thinking"
      touch(s, t)
    }
  }
  return s
}

// ---- Codex ----------------------------------------------------------------
// ~/.codex/sessions/YYYY/MM/DD/rollout-…-<thread>.jsonl: session_meta, then
// response_items (messages, function_call / custom_tool_call and their
// outputs) and event_msgs (task_started, task_complete, turn_aborted,
// *_approval_request, error).
export function readCodex(text, id = "") {
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
          s.step = p.command ? toolLine("shell", { command: p.command }) : p.type === "apply_patch_approval_request" ? "apply_patch" : s.step
          touch(s, t)
          break
        case "request_user_input": s.phase = "ask"; touch(s, t); break
        case "agent_message": if (p.message) s.reply = clip(p.message, TEXT_MAX); touch(s, t); break
        case "task_complete":
          s.phase = "done"; s.pending = []
          if (p.last_agent_message) s.reply = clip(p.last_agent_message, TEXT_MAX)
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
          if (p.role === "assistant") { const x = textOf(p.content).trim(); if (x) s.reply = clip(x, TEXT_MAX) }
          touch(s, t)
          break
        case "reasoning": if (s.phase !== "tool" && s.phase !== "approval") s.phase = s.phase === "done" ? "done" : "thinking"; touch(s, t); break
      }
    }
  }
  return s
}

// ---- DeepSeek Harness -----------------------------------------------------
// ~/.dsh/sessions/<folder>/<session>/session.v4.jsonl.zstd: typed events —
// session, turn/start, tool/call, approval/asked, approval/decided,
// tool/result, assistant/message, turn/end {reason: completed|aborted|error}.
export function readDsh(text, id = "") {
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
        if (txt) s.reply = clip(txt, TEXT_MAX)
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
  return s
}

// ---- Gemini CLI / Qwen Code -----------------------------------------------
// ~/.gemini/tmp/<project>/chats/session-*.json(l): messages, the model's
// with toolCalls each carrying a status (scheduled, awaiting_approval,
// executing, success, error, cancelled).
export function readGemini(text, agent = "gemini", id = "") {
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
      if (txt.trim()) s.reply = clip(txt, TEXT_MAX)
      const calls = Array.isArray(m.toolCalls) ? m.toolCalls : []
      s.pending = []
      for (const c of calls) {
        const st = String(c.status || "").toLowerCase()
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
  return s
}

// ---- Pi / omp ----------------------------------------------------------------
// ~/.pi/agent/sessions/<folder>/<time>_<id>.jsonl: a session header, then
// message lines whose message has a role (user, assistant, toolResult) and,
// for the assistant, a stopReason (stop, toolUse, aborted, error).
export function readPi(text, agent = "pi", id = "") {
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
      if (txt) s.reply = clip(txt, TEXT_MAX)
      for (const p of parts) if (p?.type === "toolCall") called(s, p.id, p.name, p.arguments, t)
      if (m.stopReason === "stop" || m.stopReason === "length") { s.phase = "done"; s.pending = [] }
      else if (m.stopReason === "aborted") { s.phase = "aborted"; s.pending = [] }
      else if (m.stopReason === "error") { s.phase = "error"; s.error = clip(m.errorMessage, 160); s.pending = [] }
      touch(s, t)
    }
  }
  return s
}

export const READERS = { claude: readClaude, codex: readCodex, dsh: readDsh, gemini: readGemini, pi: readPi }
