// Reading a request and a reply in each API's own shape (ctx.protocol:
// chat, responses, anthropic, gemini): does the request open a new turn
// (the user typed something, rather than a tool result going back), and
// does the reply end it (the model answered without asking for a tool).

const isObj = (v) => v !== null && typeof v === "object"

// tools: the request offers the model tools. Side calls an agent makes on
// its own (a title, a topic, a quota probe) usually offer none, and must
// neither open nor close a turn.
export function hasTools(body, protocol) {
  if (!isObj(body)) return false
  if (protocol === "gemini") return Array.isArray(body.tools) && body.tools.some((t) => isObj(t) && Object.keys(t).length)
  return Array.isArray(body.tools) && body.tools.length > 0
}

// opensTurn: the newest input is the user's own words, not a tool's result.
export function opensTurn(body, protocol) {
  if (!isObj(body)) return false
  switch (protocol) {
    case "responses": {
      if (typeof body.input === "string") return body.input.trim() !== ""
      if (!Array.isArray(body.input)) return false
      const last = body.input.at(-1)
      if (!isObj(last)) return false
      if (last.type != null && last.type !== "message") return false
      // Codex sends some blocks of its own as user messages (a subagent's
      // notification, the environment), and after a compaction the summary
      return last.role === "user" && !codexContext(last.content) && !holds(last.content, [CODEX_SUMMARY])
    }
    case "anthropic": {
      const last = Array.isArray(body.messages) ? body.messages.at(-1) : undefined
      if (!isObj(last) || last.role !== "user") return false
      if (notificationOnly(body, protocol)) return false
      if (typeof last.content === "string") return true
      return Array.isArray(last.content) && !last.content.some((p) => isObj(p) && p.type === "tool_result")
    }
    case "gemini": {
      const last = Array.isArray(body.contents) ? body.contents.at(-1) : undefined
      if (!isObj(last) || (last.role != null && last.role !== "user")) return false
      return Array.isArray(last.parts) && !last.parts.some((p) => isObj(p) && p.functionResponse)
    }
    default: { // chat
      const last = Array.isArray(body.messages) ? body.messages.at(-1) : undefined
      return isObj(last) && last.role === "user"
    }
  }
}

// ending: what a reply says about the turn.
//   { done: true, text }   the model answered and asks for nothing more
//   { done: false }        it asked for a tool, was cut short, or can't be read
export function ending(reply, protocol) {
  if (!isObj(reply) || reply.error) return { done: false }
  switch (protocol) {
    case "responses": {
      if (reply.status != null && reply.status !== "completed") return { done: false }
      if (!Array.isArray(reply.output)) return { done: false }
      if (reply.output.some((i) => isObj(i) && typeof i.type === "string" && i.type.endsWith("_call"))) return { done: false }
      const text = reply.output
        .filter((i) => isObj(i) && i.type === "message" && Array.isArray(i.content))
        .flatMap((i) => i.content.filter((c) => isObj(c) && typeof c.text === "string" && c.type !== "reasoning").map((c) => c.text))
        .join("\n")
      return { done: true, text }
    }
    case "anthropic": {
      if (reply.type === "error") return { done: false }
      if (reply.stop_reason != null && !["end_turn", "stop_sequence"].includes(reply.stop_reason)) return { done: false }
      const parts = Array.isArray(reply.content) ? reply.content : []
      if (parts.some((p) => isObj(p) && (p.type === "tool_use" || p.type === "server_tool_use"))) return { done: false }
      return { done: true, text: parts.filter((p) => isObj(p) && p.type === "text").map((p) => p.text).join("\n") }
    }
    case "gemini": {
      const c = Array.isArray(reply.candidates) ? reply.candidates[0] : undefined
      if (!isObj(c)) return { done: false }
      if (c.finishReason != null && c.finishReason !== "STOP") return { done: false }
      const parts = Array.isArray(c.content?.parts) ? c.content.parts : []
      if (parts.some((p) => isObj(p) && p.functionCall)) return { done: false }
      return { done: true, text: parts.filter((p) => isObj(p) && typeof p.text === "string" && p.thought !== true).map((p) => p.text).join("\n") }
    }
    default: { // chat
      const choice = Array.isArray(reply.choices) ? reply.choices[0] : undefined
      if (!isObj(choice)) return { done: false }
      if (choice.finish_reason != null && choice.finish_reason !== "stop") return { done: false }
      const m = isObj(choice.message) ? choice.message : {}
      if ((Array.isArray(m.tool_calls) && m.tool_calls.length) || m.function_call) return { done: false }
      return { done: true, text: typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p) => p?.text ?? "").join("") : "" }
    }
  }
}

// Codex's own blocks, sent with role "user" (from the codex binary). Its
// first user message is always <environment_context>, the same for every
// conversation in a folder, a subagent's too.
const CODEX_CONTEXT = ["<environment_context>", "<user_instructions>", "# AGENTS.md instructions", "<INSTRUCTIONS>", "<subagent_notification>",
  "<turn_aborted>", "<user_shell_command>", "<skill>", "<model_switch>", "<personality_spec>", "<collaboration_mode>", "<apps_instructions>"]
const codexContext = (c) => { const t = texts(c); return t.length > 0 && t.every((x) => CODEX_CONTEXT.some((p) => x.trimStart().startsWith(p))) }
const codexMeta = (body) => isObj(body?.client_metadata) ? body.client_metadata : {}

// firstWords: what tells two conversations in one session apart (an agent
// and the subagents it starts), and stays the same on every request of one
// conversation: Codex's thread id (client_metadata.thread_id) when it sends
// one, else the text of the conversation's first user message (for Codex,
// the first one that isn't its own block). Only text is read: cache markers
// and other per-request fields move around. "" when there is nothing.
export function firstWords(body, protocol) {
  if (!isObj(body)) return ""
  const text = (c) => typeof c === "string" ? c
    : Array.isArray(c) ? c.map((p) => typeof p === "string" ? p : isObj(p) && typeof p.text === "string" && p.type !== "tool_result" ? p.text : "").join("\n")
    : ""
  switch (protocol) {
    case "responses": {
      const thread = codexMeta(body).thread_id
      if (typeof thread === "string" && thread) return `codex thread ${thread}`
      if (typeof body.input === "string") return body.input
      if (!Array.isArray(body.input)) return ""
      const first = body.input.find((i) => isObj(i) && (i.type == null || i.type === "message") && i.role === "user" && !codexContext(i.content))
      return first ? text(first.content) : ""
    }
    case "gemini": {
      const first = Array.isArray(body.contents) ? body.contents.find((c) => isObj(c) && (c.role == null || c.role === "user")) : undefined
      return first && Array.isArray(first.parts) ? first.parts.map((p) => isObj(p) && typeof p.text === "string" ? p.text : "").join("\n") : ""
    }
    default: { // anthropic and chat
      const first = Array.isArray(body.messages) ? body.messages.find((m) => isObj(m) && m.role === "user") : undefined
      return first ? text(first.content) : ""
    }
  }
}

// Compaction. When an agent runs out of context it asks the model for a
// summary, then goes on in a conversation that starts from that summary.
// Both requests were captured from the real claude 2.1.316 (the fixtures in
// fixtures/), which is why these look inside every text part rather than at
// the start of one:
//   Claude Code: the conversation's own messages and tools, and a last user
//     message whose text holds the summary instructions after a
//     "CRITICAL: Respond with TEXT ONLY…" preamble (merged into the last
//     tool_result's message when compaction is automatic). The binary carries
//     several wordings, picked by a server flag: CLAUDE_COMPACT. The reply is
//     plain text and end_turn, which reads like a finished turn. It then goes
//     on with a first user message that holds CLAUDE_CONTINUED, either as the
//     whole string or as one text part after <system-reminder> blocks.
//   Codex: local compaction sends no tools; remote compaction ends its input
//     with a compaction_trigger item. Either asks with CODEX_COMPACT. It goes
//     on with a compaction item in its input, or a user message holding
//     CODEX_SUMMARY. (From openai/codex's source; not captured.)
const CLAUDE_COMPACT = [
  "Your task is to create a detailed summary of the conversation so far",
  "Your task is to create a detailed summary of the RECENT portion of the conversation",
  "Your task is to create a detailed summary of this conversation",
  "Summarize the transcript inside <summary></summary> tags",
]
const CLAUDE_CONTINUED = "This session is being continued from a previous conversation"
const CODEX_COMPACT = ["You are performing a CONTEXT CHECKPOINT COMPACTION"]
const CODEX_SUMMARY = "Another language model started to solve this problem"

const texts = (c) => typeof c === "string" ? [c]
  : Array.isArray(c) ? c.flatMap((p) => typeof p === "string" ? [p] : isObj(p) && typeof p.text === "string" && p.type !== "tool_result" ? [p.text] : [])
  : []
const holds = (c, needles) => texts(c).some((t) => needles.some((n) => t.includes(n)))

// compacting: the request asks for the summary; it neither opens nor closes a turn
export function compacting(body, protocol) {
  if (!isObj(body)) return false
  if (protocol === "responses") {
    if (!Array.isArray(body.input)) return false
    const last = body.input.at(-1)
    if (isObj(last) && last.type === "compaction_trigger") return true
    const user = body.input.findLast((i) => isObj(i) && (i.type == null || i.type === "message") && i.role === "user")
    return !!user && holds(user.content, CODEX_COMPACT)
  }
  if (protocol === "gemini") return false
  const user = Array.isArray(body.messages) ? body.messages.findLast((m) => isObj(m) && m.role === "user") : undefined
  return !!user && holds(user.content, CLAUDE_COMPACT)
}

// continued: the conversation starts from a compaction summary
export function continued(body, protocol) {
  if (!isObj(body)) return false
  if (protocol === "responses") {
    if (!Array.isArray(body.input)) return false
    return body.input.some((i) => isObj(i) && (i.type === "compaction" || i.type === "compaction_summary"
      || ((i.type == null || i.type === "message") && i.role === "user" && holds(i.content, [CODEX_SUMMARY]))))
  }
  if (protocol === "gemini") return false
  const first = Array.isArray(body.messages) ? body.messages.find((m) => isObj(m) && m.role === "user") : undefined
  return !!first && holds(first.content, [CLAUDE_CONTINUED])
}

// Claude Code's background agents. The Agent tool can return at once ("Async
// agent launched successfully"), and the Workflow tool always does ("Workflow
// launched in background"): LAUNCHED, by the tool that answers so. SendMessage
// to an agent that has stopped resumes it in the background: its result is
// JSON with "resumedAgentId" (RESUMED; left out when the call waits for the
// agent and its report comes back in the result instead). The main
// conversation may then end its turn while the agents work. When one stops,
// Claude Code resumes the main conversation with a user message that is only
// a notification (NOTIFICATION, wrapping a <task-notification>), not the
// user's words. Background Bash commands notify the same way but don't hold
// the turn: a dev server never stops.
const LAUNCHED = { Agent: "Async agent launched successfully", Task: "Async agent launched successfully", Workflow: "Workflow launched in background" }
const NOTIFICATION = "[SYSTEM NOTIFICATION - NOT USER INPUT]"
const RESUMED = /"resumedAgentId"\s*:\s*"([^"\\]+)"/
const AGENT_ID = /^agentId:\s*([\w-]+)/m
// A "completed" notification that says the agent will notify again (from the
// claude binary, both captured): it stopped with background work of its own
// still running, or messages sent to it came too late and it is being resumed
// with them. Either way the turn isn't over yet.
const INTERIM = [
  "This agent stopped with background work of its own still running",
  "The agent is being resumed with them and will notify again",
]

const lastUser = (body) => Array.isArray(body?.messages) ? body.messages.at(-1) : undefined
const resultTexts = (c) => Array.isArray(c) ? c.flatMap((p) => isObj(p) && p.type === "tool_result" ? texts(p.content) : []) : []

// notificationOnly: the newest user message is Claude Code's notification
// that a background task stopped, with nothing the user typed. Other
// <system-reminder> blocks may ride along (a captured one carries
// <tools-used-before-summary> as a text part of its own).
const REMINDER_ONLY = /^\s*(?:<system-reminder>[\s\S]*?<\/system-reminder>\s*)+$/
const isNotification = (x) => x.includes(NOTIFICATION) || x.trimStart().startsWith("<task-notification>")
export function notificationOnly(body, protocol) {
  if (protocol !== "anthropic") return false
  const last = lastUser(body)
  if (!isObj(last) || last.role !== "user") return false
  const t = texts(last.content)
  return t.some(isNotification) && !resultTexts(last.content).length && t.every((x) => isNotification(x) || REMINDER_ONLY.test(x))
}

// background: the background agents the newest user message launched (the
// tool_use_id of each "launched" result of an Agent, Task or Workflow call,
// or "resumed" result of a SendMessage call, the previous reply made), the
// agent id each of those names (agents: tool_use_id -> agent id), and the
// ids each notification that says a task has stopped names (its <tool-use-id>
// and its <task-id>). A notification is left out while "running", or when it
// says the agent will notify again (INTERIM). Both ids matter: the
// notification of an agent that resumed on its own carries only its
// <task-id>, and one resumed by SendMessage carries that call's tool-use id
// (both captured). A notification that arrives while the main conversation is
// still working rides inside a tool_result (as captured), so tool results are
// read too. Ids, not counts: a retried request carries the same launch again,
// and the same agent may notify more than once.
export function background(body, protocol) {
  const none = { launched: [], stopped: [], agents: {} }
  if (protocol !== "anthropic" || !Array.isArray(body?.messages)) return none
  const last = body.messages.at(-1)
  if (!isObj(last) || last.role !== "user") return none
  const prev = body.messages.at(-2)
  const calls = new Map(isObj(prev) && prev.role === "assistant" && Array.isArray(prev.content)
    ? prev.content.filter((p) => isObj(p) && p.type === "tool_use" && (Object.hasOwn(LAUNCHED, p.name) || p.name === "SendMessage")).map((p) => [p.id, p.name]) : [])
  const launched = [], agents = {}
  for (const p of Array.isArray(last.content) ? last.content : []) {
    if (!isObj(p) || p.type !== "tool_result" || !calls.has(p.tool_use_id) || p.is_error) continue
    const t = texts(p.content), name = calls.get(p.tool_use_id)
    const agent = name === "SendMessage" ? t.map((x) => x.match(RESUMED)?.[1]).find(Boolean)
      : t.some((x) => x.includes(LAUNCHED[name])) ? t.map((x) => x.match(AGENT_ID)?.[1]).find(Boolean) ?? "" : undefined
    if (agent === undefined) continue
    launched.push(p.tool_use_id)
    if (agent) agents[p.tool_use_id] = agent
  }
  const stopped = [...texts(last.content), ...resultTexts(last.content)].flatMap((t) => [...t.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)].flatMap((m) => {
    const status = m[1].match(/<status>\s*(\w+)\s*<\/status>/)?.[1]
    if (!status || status === "running" || INTERIM.some((s) => m[1].includes(s))) return []
    return [m[1].match(/<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/)?.[1], m[1].match(/<task-id>\s*([^<\s]+)\s*<\/task-id>/)?.[1]].filter(Boolean)
  }))
  return { launched, stopped: [...new Set(stopped)], agents }
}

// subagent: the request says itself that a subagent sends it. Codex marks
// the threads it starts in client_metadata: x-openai-subagent names the kind
// (collab_spawn for spawn_agent, memory_consolidation, compact, review) and
// spawned ones carry parent_thread_id. These are nested even when the parent
// has already stopped, except /review, which you start and wait for.
// Claude Code says nothing of the kind; parentActive works it out.
export function subagent(body, protocol) {
  if (protocol !== "responses") return false
  const m = codexMeta(body), kind = m["x-openai-subagent"]
  return kind ? kind !== "review" : !!(m.parent_thread_id || m["x-codex-parent-thread-id"])
}
