// A minimal ACP agent over stdio (newline-delimited JSON-RPC), for tests. It signs in to nothing and calls no model.
//   FAKE_ACP_PROMPT_CAPS  JSON for agentCapabilities.promptCapabilities (default: none, the ACP baseline)
//   FAKE_ACP_LOG          file each received session/prompt is appended to, one JSON line per prompt
// Every prompt is answered with one agent_message_chunk ("ok: <n> blocks") and stopReason end_turn.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const caps = process.env.FAKE_ACP_PROMPT_CAPS ? JSON.parse(process.env.FAKE_ACP_PROMPT_CAPS) : undefined;
const logFile = process.env.FAKE_ACP_LOG;
const out = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const answer = (id, result) => out({ id, result });

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
        agentCapabilities: { loadSession: false, ...(caps ? { promptCapabilities: caps } : {}) },
        authMethods: [],
        agentInfo: { name: "fake-acp-agent", version: "0.0.0" },
      });
    case "session/new":
      return answer(m.id, { sessionId: "fake-session-1" });
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
