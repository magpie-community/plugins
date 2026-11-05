#!/usr/bin/env node
// Minimal `codex app-server` stand-in for interrupt tests. No network, no model.
// Env:
//   FAKE_CODEX_LOG           append every client JSON-RPC line
//   FAKE_CODEX_SLOW_MS       delay before turn/started + turn/completed (default 0)
//   FAKE_CODEX_IGNORE_INTERRUPT  when set, turn/interrupt is answered but turn is not ended
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const logFile = process.env.FAKE_CODEX_LOG;
const slowMs = Number(process.env.FAKE_CODEX_SLOW_MS || 0);
const ignoreInterrupt = !!process.env.FAKE_CODEX_IGNORE_INTERRUPT;
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
      out({ id, result: { turn: { id: turnId } } });
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
      if (slowMs > 0) setTimeout(start, 30); // leave a window where interrupt can race before turn/started
      else start();
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
