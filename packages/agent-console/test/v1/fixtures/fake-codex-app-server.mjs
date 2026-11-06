#!/usr/bin/env node
// Minimal `codex app-server` stand-in for interrupt tests. No network, no model.
// Env:
//   FAKE_CODEX_LOG           append every client JSON-RPC line
//   FAKE_CODEX_SLOW_MS       delay before turn/started + turn/completed (default 0)
//   FAKE_CODEX_IGNORE_INTERRUPT  when set, turn/interrupt is answered but turn is not ended
//   FAKE_CODEX_START_DELAY_MS    delay only the first turn/start *response* (in-flight Stop race)
//   FAKE_CODEX_STARTED_DELAY_MS  delay before turn/started after the response (default derived from SLOW_MS)
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const logFile = process.env.FAKE_CODEX_LOG;
const slowMs = Number(process.env.FAKE_CODEX_SLOW_MS || 0);
const ignoreInterrupt = !!process.env.FAKE_CODEX_IGNORE_INTERRUPT;
const startDelayMs = Number(process.env.FAKE_CODEX_START_DELAY_MS || 0);
const startedDelayMs = process.env.FAKE_CODEX_STARTED_DELAY_MS != null
  ? Number(process.env.FAKE_CODEX_STARTED_DELAY_MS)
  : null;
let startCount = 0;
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const log = (o) => logFile && appendFileSync(logFile, JSON.stringify(o) + "\n");

let threadId = "thread-1";
let turnSeq = 0;
/** @type {Map<string, { timer?: NodeJS.Timeout, finish: (status: string) => void }>} */
const openTurns = new Map();

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let m;
  try { m = JSON.parse(line); } catch { return; }
  log({ in: m });
  if (!m.method) return;
  const id = m.id;
  const p = m.params ?? {};
  switch (m.method) {
    case "initialize":
      return out({ id, result: { userAgent: "fake-codex" } });
    case "initialized":
      return;
    case "thread/start":
    case "thread/resume":
      threadId = p.threadId || threadId;
      return out({ id, result: { thread: { id: threadId } } });
    case "turn/start": {
      const turnId = `codex-turn-${++turnSeq}`;
      const n = ++startCount;
      const finish = (status) => {
        const open = openTurns.get(turnId);
        if (!open || open.finish !== finish) return;
        if (open.timer) clearTimeout(open.timer);
        openTurns.delete(turnId);
        out({ method: "turn/completed", params: { turn: { id: turnId, status } } });
      };
      const start = () => {
        out({ method: "turn/started", params: { turn: { id: turnId } } });
        out({ method: "item/agentMessage/delta", params: { itemId: "m1", delta: "hi" } });
        if (slowMs > 0) {
          const timer = setTimeout(() => finish("completed"), slowMs);
          openTurns.set(turnId, { timer, finish });
        } else {
          finish("completed");
        }
      };
      const respond = () => {
        out({ id, result: { turn: { id: turnId } } });
        // Delay turn/started so tests can interrupt after turn/start's response but before the event
        const startedWait = startedDelayMs != null
          ? startedDelayMs
          : (slowMs > 0 ? Math.min(200, Math.max(80, Math.floor(slowMs / 4))) : 0);
        if (startedWait > 0) setTimeout(start, startedWait);
        else start();
      };
      // First turn/start only: delay the JSON-RPC *response* so Stop can race while in flight
      const delay = n === 1 && startDelayMs > 0 ? startDelayMs : 0;
      if (delay > 0) setTimeout(respond, delay);
      else respond();
      return;
    }
    case "turn/interrupt": {
      const turnId = p.turnId;
      out({ id, result: {} });
      const open = openTurns.get(turnId);
      if (open && !ignoreInterrupt) open.finish("interrupted");
      return;
    }
    case "turn/steer":
      return out({ id, result: {} });
    default:
      if (id !== undefined) out({ id, result: {} });
  }
});
