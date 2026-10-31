// A minimal ACP agent over stdio (newline-delimited JSON-RPC), for tests. It signs in to nothing and calls no model.
//   FAKE_ACP_PROMPT_CAPS   JSON for agentCapabilities.promptCapabilities (default: none, the ACP baseline)
//   FAKE_ACP_SESSION       JSON { loadSession?: boolean, resume?: boolean } — which reopen methods initialize advertises
//                          (default: neither; matches the ACP baseline until an Agent opts in)
//   FAKE_ACP_LOG           file each received session/prompt is appended to, one JSON line per prompt
//   FAKE_ACP_SESSION_LOG   file each session/new|load|resume is appended to, one JSON line { method, sessionId }
// Every prompt is answered with one agent_message_chunk ("ok: <n> blocks") and stopReason end_turn.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const caps = process.env.FAKE_ACP_PROMPT_CAPS ? JSON.parse(process.env.FAKE_ACP_PROMPT_CAPS) : undefined;
const session = process.env.FAKE_ACP_SESSION ? JSON.parse(process.env.FAKE_ACP_SESSION) : {};
const logFile = process.env.FAKE_ACP_LOG;
const sessionLog = process.env.FAKE_ACP_SESSION_LOG;
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
  if (!m.method) return; // responses to our own (no) requests
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
      return answer(m.id, { sessionId });
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
      return answer(m.id, { configOptions: [] });
    case "session/prompt": {
      if (logFile) appendFileSync(logFile, JSON.stringify(p.prompt) + "\n");
      out({
        method: "session/update",
        params: {
          sessionId: p.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `ok: ${p.prompt.length} blocks` } },
        },
      });
      return answer(m.id, { stopReason: "end_turn" });
    }
    case "session/cancel":
      return;
    default:
      if (m.id !== undefined) out({ id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
  }
});
