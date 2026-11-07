// A minimal ACP agent over stdio (newline-delimited JSON-RPC), for tests. It signs in to nothing and calls no model.
//   FAKE_ACP_PROMPT_CAPS   JSON for agentCapabilities.promptCapabilities (default: none, the ACP baseline)
//   FAKE_ACP_SESSION       JSON { loadSession?: boolean, resume?: boolean } — which reopen methods initialize advertises
//                          (default: neither; matches the ACP baseline until an Agent opts in)
//   FAKE_ACP_LOG           file each received session/prompt is appended to, one JSON line per prompt
//   FAKE_ACP_SESSION_LOG   file each session/new|load|resume is appended to, one JSON line { method, sessionId }
//   FAKE_ACP_PERM          "abandon": each prompt asks session/request_permission, then ends the turn at once without
//                          waiting (Cursor when its model stream dies: "[canceled] http/2 stream closed … CANCEL");
//                          "withdraw": asks, then sends $/cancel_request for it and ends the turn once the client answers
//                          "answer": asks and ends the turn once the client answers (the normal path)
//   FAKE_ACP_PERM_LOG      file each answer to session/request_permission is appended to, one JSON line
//   FAKE_ACP_CANCEL_LOG    file each session/cancel is appended to, one JSON line { notification, hasId, sessionId }
//   FAKE_ACP_SLOW_MS       hold each session/prompt open this many ms (or until session/cancel); cancel ends with
//                          stopReason cancelled. Used to test interrupt while a turn is in flight.
//   FAKE_ACP_IGNORE_CANCEL when set with FAKE_ACP_SLOW_MS: cancel is logged but does not end the prompt (Devin-like
//                          "cancel was a no-op / never acknowledged" — the client must clear its own running flag)
//   FAKE_ACP_CANCEL_AS_ERROR when set with FAKE_ACP_SLOW_MS: cancel answers the in-flight session/prompt with
//                          JSON-RPC error -32603 (no stopReason) — leftover pendingCancelStops counters used to
//                          swallow the next turn's stop after this.
//   FAKE_ACP_CANCEL_SETTLE_MS  Devin-like: after session/cancel, wait this many ms (emit STALE_FROM_TURN_1 chunk)
//                          before settling cancelled. A new session/prompt that arrives while cancelling is
//                          itself answered stopReason cancelled (0ms-resend race).
//   FAKE_ACP_CONFIG_OPTIONS JSON session/new config snapshot; FAKE_ACP_CONFIG_LOG logs set_config_option params
// Every prompt is answered with one agent_message_chunk ("ok: <n> blocks") and stopReason end_turn.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const caps = process.env.FAKE_ACP_PROMPT_CAPS ? JSON.parse(process.env.FAKE_ACP_PROMPT_CAPS) : undefined;
const session = process.env.FAKE_ACP_SESSION ? JSON.parse(process.env.FAKE_ACP_SESSION) : {};
const logFile = process.env.FAKE_ACP_LOG;
const sessionLog = process.env.FAKE_ACP_SESSION_LOG;
const configOptions = JSON.parse(process.env.FAKE_ACP_CONFIG_OPTIONS || "[]");
const configLog = process.env.FAKE_ACP_CONFIG_LOG;
const cancelLog = process.env.FAKE_ACP_CANCEL_LOG;
const permMode = process.env.FAKE_ACP_PERM;
const permLog = process.env.FAKE_ACP_PERM_LOG;
const slowMs = process.env.FAKE_ACP_SLOW_MS ? Number(process.env.FAKE_ACP_SLOW_MS) : 0;
const ignoreCancel = !!process.env.FAKE_ACP_IGNORE_CANCEL;
const cancelAsError = !!process.env.FAKE_ACP_CANCEL_AS_ERROR;
const cancelSettleMs = process.env.FAKE_ACP_CANCEL_SETTLE_MS ? Number(process.env.FAKE_ACP_CANCEL_SETTLE_MS) : 0;
let nextOwnId = 9000;
const waiting = new Map(); // our request id -> callback(response)
/** @type {Map<string, { timer: NodeJS.Timeout | null, finish: (reason: string) => void, fail: (code: number, message: string) => void, cancelling?: boolean }>} */
const openPrompts = new Map(); // sessionId -> in-flight slow prompt
const out = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const answer = (id, result) => out({ id, result });
const logSession = (method, sessionId) => {
  if (sessionLog) appendFileSync(sessionLog, JSON.stringify({ method, sessionId }) + "\n");
};

const agentCapabilities = {
  loadSession: session.loadSession === true,
  ...(session.resume === true ? { sessionCapabilities: { resume: {} } } : {}),
  ...(caps ? { promptCapabilities: caps } : {}),
};

createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (!m.method) {
    // A response to our own request (session/request_permission)
    if (permLog && waiting.has(m.id)) appendFileSync(permLog, JSON.stringify({ result: m.result, error: m.error }) + "\n");
    const cb = waiting.get(m.id);
    waiting.delete(m.id);
    cb?.(m);
    return;
  }
  const p = m.params ?? {};
  switch (m.method) {
    case "initialize":
      return answer(m.id, {
        protocolVersion: 1,
        agentCapabilities,
        authMethods: [],
        agentInfo: { name: "fake-acp-agent", version: "0.0.0" },
      });
    case "session/new": {
      const sessionId = "fake-session-1";
      logSession("session/new", sessionId);
      return answer(m.id, { sessionId, configOptions });
    }
    case "session/load": {
      if (!agentCapabilities.loadSession) {
        return out({ id: m.id, error: { code: -32601, message: '"Method not found": session/load' } });
      }
      logSession("session/load", p.sessionId);
      return answer(m.id, { modes: null, configOptions: [] });
    }
    case "session/resume": {
      if (!agentCapabilities.sessionCapabilities?.resume) {
        return out({ id: m.id, error: { code: -32601, message: '"Method not found": session/resume' } });
      }
      logSession("session/resume", p.sessionId);
      return answer(m.id, { modes: null, configOptions: [] });
    }
    case "session/set_mode":
      return answer(m.id, {});
    case "session/set_config_option":
      if (configLog) appendFileSync(configLog, JSON.stringify(p) + "\n");
      return answer(m.id, { configOptions });
    case "session/prompt": {
      if (logFile) appendFileSync(logFile, JSON.stringify(p.prompt) + "\n");
      out({
        method: "session/update",
        params: {
          sessionId: p.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `ok: ${p.prompt.length} blocks` } },
        },
      });
      if (permMode) {
        const ask = nextOwnId++;
        const done = () => answer(m.id, { stopReason: "end_turn" });
        waiting.set(ask, permMode === "abandon" ? () => {} : done);
        out({
          id: ask,
          method: "session/request_permission",
          params: {
            sessionId: p.sessionId,
            toolCall: { toolCallId: "tc-" + ask, title: "`git status`", kind: "execute", rawInput: {} },
            options: [
              { optionId: "allow-once", name: "Allow", kind: "allow_once" },
              { optionId: "allow-always", name: "Always", kind: "allow_always" },
              { optionId: "reject-once", name: "Reject", kind: "reject_once" },
            ],
          },
        });
        if (permMode === "abandon") {
          out({
            method: "session/update",
            params: { sessionId: p.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)" } } },
          });
          setTimeout(done, 50);
        } else if (permMode === "withdraw") {
          setTimeout(() => out({ method: "$/cancel_request", params: { requestId: ask } }), 100);
        }
        return;
      }
      if (slowMs > 0) {
        const prior = openPrompts.get(p.sessionId);
        // Devin race: a new prompt while the previous is still cancelling → cancel the new one too
        if (prior?.cancelling) {
          return answer(m.id, { stopReason: "cancelled" });
        }
        if (prior) prior.finish("cancelled");
        const finish = (reason) => {
          const open = openPrompts.get(p.sessionId);
          if (!open || open.finish !== finish) return;
          if (open.timer) clearTimeout(open.timer);
          openPrompts.delete(p.sessionId);
          answer(m.id, { stopReason: reason });
        };
        const fail = (code, message) => {
          const open = openPrompts.get(p.sessionId);
          if (!open || open.fail !== fail) return;
          if (open.timer) clearTimeout(open.timer);
          openPrompts.delete(p.sessionId);
          out({ id: m.id, error: { code, message } });
        };
        const timer = setTimeout(() => finish("end_turn"), slowMs);
        openPrompts.set(p.sessionId, { timer, finish, fail, cancelling: false });
        return;
      }
      return answer(m.id, { stopReason: "end_turn" });
    }
    case "session/cancel": {
      // ACP cancel is a notification (no JSON-RPC id). If a client wrongly sends it as a request, answer
      // Method not found like Devin CLI (which only registers the notification handler).
      if (cancelLog) {
        appendFileSync(
          cancelLog,
          JSON.stringify({ notification: m.id === undefined, hasId: m.id !== undefined, sessionId: p.sessionId }) + "\n",
        );
      }
      if (m.id !== undefined) {
        return out({ id: m.id, error: { code: -32601, message: "Method not found" } });
      }
      const open = openPrompts.get(p.sessionId);
      if (open && !ignoreCancel) {
        if (cancelAsError) open.fail(-32603, "Internal error");
        else if (cancelSettleMs > 0) {
          // Devin-like delayed cancel settle + trailing stale chunk
          open.cancelling = true;
          if (open.timer) clearTimeout(open.timer);
          open.timer = setTimeout(() => {
            out({
              method: "session/update",
              params: {
                sessionId: p.sessionId,
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "STALE_FROM_TURN_1" } },
              },
            });
            open.finish("cancelled");
          }, cancelSettleMs);
        } else open.finish("cancelled");
      }
      return;
    }
    default:
      if (m.id !== undefined) out({ id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
  }
});
