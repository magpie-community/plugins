// Session files as each agent writes them, cut to the lines that matter and
// with private text replaced. Taken from real Claude Code 2.1, Codex 0.x
// (ChatGPT app), DeepSeek Harness v4, Gemini CLI and Pi files.
const j = (o) => JSON.stringify(o)
const T = (s) => `2026-10-28T10:${String(s).padStart(2, "0")}:00.000Z`

// Claude Code: a prompt, a tool call answered, a second tool call still out
export const claudeRunning = [
  j({ type: "user", sessionId: "c1", cwd: "/Users/me/app", timestamp: T(1), message: { role: "user", content: "fix the failing test" } }),
  j({ type: "assistant", sessionId: "c1", timestamp: T(2), message: { role: "assistant", model: "claude-opus-5", stop_reason: "tool_use", content: [{ type: "text", text: "Running the tests." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "bun test" } }] } }),
  j({ type: "user", sessionId: "c1", timestamp: T(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "1 fail" }] } }),
  j({ type: "assistant", sessionId: "c1", timestamp: T(4), message: { role: "assistant", model: "claude-opus-5", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/Users/me/app/a.ts" } }] } }),
  j({ type: "ai-title", sessionId: "c1", aiTitle: "Fix failing test" }),
].join("\n")
export const claudeDone = claudeRunning + "\n" + [
  j({ type: "user", sessionId: "c1", timestamp: T(5), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] } }),
  j({ type: "assistant", sessionId: "c1", timestamp: T(6), message: { role: "assistant", model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text: "Fixed: the date was parsed in UTC." }] } }),
].join("\n")
export const claudeAsks = claudeRunning.split("\n").slice(0, 3).join("\n") + "\n" +
  j({ type: "assistant", sessionId: "c1", timestamp: T(4), message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t3", name: "AskUserQuestion", input: { question: "Keep the old API?" } }] } })
export const claudeInterrupted = claudeRunning + "\n" +
  j({ type: "user", sessionId: "c1", timestamp: T(5), message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } })

// Codex: session_meta, a turn, a custom tool call with no output yet
export const codexRunning = [
  j({ timestamp: T(1), type: "session_meta", payload: { id: "019a-x", cwd: "/Users/me/blog", timestamp: T(1) } }),
  j({ timestamp: T(1), type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { model: "gpt-6.1-terra" } } }),
  j({ timestamp: T(2), type: "event_msg", payload: { type: "task_started", turn_id: "u1" } }),
  j({ timestamp: T(2), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>…</environment_context>" }] } }),
  j({ timestamp: T(2), type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "export the doc as markdown" }] } } }),
  j({ timestamp: T(3), type: "response_item", payload: { type: "custom_tool_call", call_id: "k1", name: "exec", input: 'text(await tools.exec_command({cmd:"pandoc in.docx -o out.md"}))' } }),
].join("\n")
export const codexApproval = codexRunning + "\n" + j({ timestamp: T(4), type: "event_msg", payload: { type: "exec_approval_request", command: ["rm", "-rf", "dist"] } })
export const codexDone = codexRunning + "\n" + [
  j({ timestamp: T(4), type: "response_item", payload: { type: "custom_tool_call_output", call_id: "k1", output: "ok" } }),
  j({ timestamp: T(5), type: "event_msg", payload: { type: "task_complete", last_agent_message: "Exported to out.md.", completed_at: 1793196300 } }),
].join("\n")
export const codexAborted = codexRunning + "\n" + j({ timestamp: T(4), type: "event_msg", payload: { type: "turn_aborted", reason: "interrupted" } })

// DeepSeek Harness v4: typed events
const D = (seq, type, data, extra = {}) => j({ type, seq, time: 1793196000000 + seq * 1000, data, ...extra })
export const dshApproval = [
  j({ type: "session", version: 4, id: "session-d1", createdAt: 1793196000000, cwd: "/Users/me/site" }),
  D(1, "session/title", { title: "Deploy the site" }),
  D(2, "model/selection", { provider: "magpie", model: "deepseek-flash" }),
  D(3, "user/message", { content: [{ type: "text", text: "Time sampled while preparing…" }], source: { kind: "time-context" } }),
  D(4, "user/message", { content: [{ type: "text", text: "deploy to cloudflare" }], source: { kind: "user" } }),
  D(5, "turn/start", { turn: 1 }),
  D(6, "tool/call", { callId: "b1", name: "bash", arguments: JSON.stringify({ command: "wrangler pages deploy ./dist" }) }),
  D(7, "approval/asked", { id: "a1", toolName: "bash", callId: "b1" }),
].join("\n")
export const dshError = dshApproval + "\n" + [
  D(8, "approval/decided", { id: "a1", outcome: "allowed-once" }),
  D(9, "tool/result", { message: { toolCallId: "b1", content: [{ type: "text", text: "ok" }] } }),
  D(10, "turn/end", { turn: 1, reason: { kind: "error", error: { message: "429: usage limit reached" } } }),
].join("\n")

// Gemini CLI: one JSON document, a tool awaiting approval
export const geminiApproval = j({ sessionId: "g1", startTime: T(1), messages: [
  { id: "1", type: "user", timestamp: T(1), content: "align the chorus to 120 BPM" },
  { id: "2", type: "gemini", timestamp: T(2), model: "gemini-3-pro", content: "", toolCalls: [{ id: "x", name: "run_shell_command", status: "awaiting_approval", args: { command: "ffmpeg -i a.wav" } }] },
] })

// Pi: header, prompt, a tool call and its result, then a final stop
export const piDone = [
  j({ type: "session", id: "p1", cwd: "/Users/me/notes", timestamp: T(1) }),
  j({ type: "message", timestamp: T(2), message: { role: "user", content: [{ type: "text", text: "tidy my notes" }] } }),
  j({ type: "message", timestamp: T(3), message: { role: "assistant", model: "qwen3", content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "a.md" } }], stopReason: "toolUse" } }),
  j({ type: "message", timestamp: T(4), message: { role: "toolResult", toolCallId: "r1", content: [] } }),
  j({ type: "message", timestamp: T(5), message: { role: "assistant", content: [{ type: "text", text: "Done: 12 tools, 5 ideas." }], stopReason: "stop" } }),
].join("\n")
