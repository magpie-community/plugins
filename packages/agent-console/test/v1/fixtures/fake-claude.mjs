#!/usr/bin/env node
// A stand-in for `claude -p --input-format stream-json --output-format stream-json`, for the Claude provider tests.
// It speaks the same line-delimited JSON as the real CLI: initialize / interrupt / set_model / set_permission_mode
// control requests, can_use_tool requests back to the host, control_cancel_request, stream_event deltas, assistant,
// user tool_result and result messages. Every argv and stdin line is appended to $FAKE_CLAUDE_LOG.
// The user text picks the scenario: TOOL (ask to run Bash), CANCEL (ask, then withdraw the ask), SLOW (stream and wait
// for an interrupt); anything else is echoed with a description of the image blocks it got.
// FAKE_CLAUDE_INTERRUPT_RESULT_MS  delay (ms) between interrupt ack and ending the SLOW turn (late-result races).
// FAKE_CLAUDE_HOLD_FILE            when set, wait until this path is deleted before emitting the delayed interrupt result.
// FAKE_CLAUDE_INTERRUPT_FAIL       when set, interrupt control_response is an error (busy) — CLI must restart.
// FAKE_CLAUDE_FAIL_LINGER_RESULT_MS  with INTERRUPT_FAIL: emit a poison `result` after N ms, and delay stdin-close exit
//                                   so a replaced CLI's pump can see leftover stdout (tests this.cli !== cli guard).
// FAKE_CLAUDE_CRASH_AFTER_DELTA    when set with SLOW: after first text delta, exit(1) mid-turn.
import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const logFile = process.env.FAKE_CLAUDE_LOG;
const log = (o) => logFile && appendFileSync(logFile, JSON.stringify(o) + "\n");
log({ argv: args });
/** Poll until FAKE_CLAUDE_HOLD_FILE is gone (or unset). Deterministic release gate for tests. */
async function waitHold() {
  const f = process.env.FAKE_CLAUDE_HOLD_FILE;
  if (!f) return;
  while (existsSync(f)) await new Promise((r) => setTimeout(r, 15));
}
if (process.env.FAKE_CLAUDE_EXIT) {
  process.stderr.write("fake claude: boom\n");
  process.exit(Number(process.env.FAKE_CLAUDE_EXIT));
}
const flag = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const sid = flag("--resume") ?? "sess-new";
let model = flag("--model") ?? "default";
let mode = flag("--permission-mode") ?? "default";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const waiting = new Map(); // our can_use_tool request id → resolve
let reqSeq = 0;
let interruptTurn = null;
let msgSeq = 0;

function ask(toolName, input, toolUseId) {
  const id = `perm-${++reqSeq}`;
  out({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: toolName, input, tool_use_id: toolUseId } });
  return { id, answer: new Promise((resolve) => waiting.set(id, resolve)) };
}

function say(text) {
  const id = `msg_${++msgSeq}`;
  out({ type: "stream_event", event: { type: "message_start", message: { id } }, session_id: sid });
  out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }, session_id: sid });
  out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }, session_id: sid });
  out({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }, session_id: sid });
  out({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } }, session_id: sid });
  out({ type: "assistant", message: { id, role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text }] }, session_id: sid });
}
const done = (extra = {}) =>
  out({ type: "result", subtype: "success", is_error: false, duration_ms: 5, num_turns: 1, result: "", session_id: sid, total_cost_usd: 0.001, usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 1 }, ...extra });

async function turn(content) {
  const blocks = Array.isArray(content) ? content : [{ type: "text", text: String(content) }];
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  out({ type: "system", subtype: "init", session_id: sid, model, permissionMode: mode, cwd: process.cwd() });
  if (text.includes("TOOL") || text.includes("CANCEL")) {
    const input = { command: "echo hi", description: "say hi" };
    const { id, answer } = ask("Bash", input, "tu_1");
    if (text.includes("CANCEL")) {
      setTimeout(() => { out({ type: "control_cancel_request", request_id: id }); waiting.get(id)?.({ cancelled: true }); waiting.delete(id); }, 50);
    }
    const r = await answer;
    if (r.cancelled) return done({ subtype: "error_during_execution", is_error: true, result: "cancelled" });
    if (r.behavior === "allow") {
      out({ type: "assistant", message: { id: `msg_${++msgSeq}`, content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: r.updatedInput }] }, session_id: sid });
      out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "hi\n", is_error: false }] }, session_id: sid });
      say("ran it");
    } else say(`not run: ${r.message}`);
    return done();
  }
  if (text.includes("SLOW")) {
    say("working");
    if (process.env.FAKE_CLAUDE_CRASH_AFTER_DELTA) {
      process.stderr.write("fake claude: crash after delta\n");
      process.exit(1);
    }
    await new Promise((resolve) => (interruptTurn = resolve));
    return done({ subtype: "error_during_execution", is_error: true, result: "" });
  }
  const images = blocks.filter((b) => b.type === "image").map((b) => `${b.source?.media_type}:${b.source?.data?.length}`);
  const docs = blocks.filter((b) => b.type === "document").map((b) => b.title);
  say(`echo ${text.split("\n")[0]} | model=${model} mode=${mode} images=[${images.join(",")}] docs=[${docs.join(",")}]`);
  done();
}

// Real Claude CLI handles user turns in order: one result per user message, FIFO.
// Queue user messages so a late interrupted result cannot arrive after a newer turn's result.
const userQueue = [];
let turning = false;
async function pumpUsers() {
  if (turning) return;
  turning = true;
  while (userQueue.length) {
    const content = userQueue.shift();
    try { await turn(content); } catch (e) { console.error("fake-claude turn error", e); }
  }
  turning = false;
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  log({ in: m });
  if (m.type === "control_request") {
    const r = m.request;
    const ok = (response = {}) => out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response } });
    if (r.subtype === "initialize") return ok({ commands: [{ name: "review", description: "Review the diff", argumentHint: "[path]" }, { name: "compact", description: "Compact", argumentHint: "" }], models: [{ value: "sonnet" }] });
    if (r.subtype === "set_model") { model = r.model ?? "default"; return ok(); }
    if (r.subtype === "set_permission_mode") { mode = r.mode; return ok(); }
    if (r.subtype === "interrupt") {
      if (process.env.FAKE_CLAUDE_INTERRUPT_FAIL) {
        out({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: "busy" } });
        const linger = Number(process.env.FAKE_CLAUDE_FAIL_LINGER_RESULT_MS || 0);
        if (linger > 0) {
          setTimeout(() => {
            // Poison result for a replaced CLI's pump (must be ignored via this.cli !== cli)
            out({
              type: "result", subtype: "error_during_execution", is_error: true, result: "POISON_FROM_OLD_CLI",
              duration_ms: 1, num_turns: 1, session_id: sid, total_cost_usd: 0,
              usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
            });
          }, linger);
        }
        return;
      }
      ok();
      const resume = interruptTurn;
      interruptTurn = null;
      // Optional delay / hold-file gate before ending the turn so interrupt→resend races can be tested
      const delay = Number(process.env.FAKE_CLAUDE_INTERRUPT_RESULT_MS || 0);
      const release = async () => {
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        await waitHold();
        resume?.();
      };
      void release();
      return;
    }
    return out({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: "unknown" } });
  }
  if (m.type === "control_response") {
    const w = waiting.get(m.response.request_id);
    waiting.delete(m.response.request_id);
    return w?.(m.response.response);
  }
  if (m.type === "user") {
    userQueue.push(m.message.content);
    void pumpUsers();
  }
});
rl.on("close", () => {
  const linger = Number(process.env.FAKE_CLAUDE_FAIL_LINGER_RESULT_MS || 0);
  if (linger > 0) setTimeout(() => process.exit(0), linger + 80);
  else process.exit(0);
});
