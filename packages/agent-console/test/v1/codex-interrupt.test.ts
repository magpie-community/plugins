// Codex interrupt: turn/interrupt is a JSON-RPC *request* (has a response). After interrupt the local turn
// must end so a late turn/completed cannot bind onto the next send (same class of bug as ACP/Devin).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexSession } from "../../daemon/src/providers/codex/session.js";
import type { ProviderEvent } from "../../daemon/src/timeline/types.js";

const fixture = resolve(__dirname, "fixtures", "fake-codex-app-server.mjs");
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "codex-interrupt-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Run = { session: CodexSession; events: ProviderEvent[]; logFile: string; done: Promise<void> };

function open(env: Record<string, string> = {}): Run {
  const logFile = join(dir, `c-${Math.random().toString(36).slice(2)}.jsonl`);
  const session = new CodexSession({
    threadId: "t1",
    cwd: dir,
    model: null,
    mode: "default",
    effort: null,
    resumeId: null,
    binCmd: process.execPath,
    binPrefixArgs: [],
    version: "test",
    launch: { cmd: process.execPath, prefixArgs: [fixture] },
  });
  // Inject env for the child via process.env (CodexRpc inherits process.env)
  for (const [k, v] of Object.entries({ FAKE_CODEX_LOG: logFile, ...env })) process.env[k] = v;
  const events: ProviderEvent[] = [];
  const done = (async () => {
    for await (const ev of session.events) events.push(ev);
  })();
  return { session, events, logFile, done };
}

async function until(check: () => boolean, ms = 10000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const lines = (f: string) =>
  existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

describe("Codex interrupt", () => {
  it("interrupt sends turn/interrupt as a JSON-RPC request (with id), not a notification", async () => {
    const r = open({ FAKE_CODEX_SLOW_MS: "5000" });
    try {
      await r.session.send({ text: "slow", images: [] });
      await until(() => r.events.some((e) => e.type === "turn_started"));
      // Wait until fake has emitted turn/started (Codex turn id known)
      await until(() => lines(r.logFile).some((l) => l.in?.method === "turn/start"));
      await until(() => r.events.some((e) => e.type === "assistant_delta") || lines(r.logFile).length > 3);
      await new Promise((x) => setTimeout(x, 80)); // allow turn/started notification to arrive
      await r.session.interrupt();
      await until(() => lines(r.logFile).some((l) => l.in?.method === "turn/interrupt"));
      const hit = lines(r.logFile).find((l) => l.in?.method === "turn/interrupt");
      expect(hit.in.id).toEqual(expect.any(Number));
      await until(() => r.events.some((e) => e.type === "turn_ended"));
      expect((r.events.find((e) => e.type === "turn_ended") as { status?: string }).status).toBe("interrupted");
    } finally {
      await r.session.close();
      await r.done;
      delete process.env.FAKE_CODEX_SLOW_MS;
      delete process.env.FAKE_CODEX_LOG;
      delete process.env.FAKE_CODEX_IGNORE_INTERRUPT;
      delete process.env.FAKE_CODEX_START_DELAY_MS;
      delete process.env.FAKE_CODEX_STARTED_DELAY_MS;
      delete process.env.FAKE_CODEX_RESPONSE_HOLD_FILE;
      delete process.env.FAKE_CODEX_STARTED_HOLD_FILE;
    }
  }, 20000);

  it("after interrupt, send() works again; late turn/completed does not end the new turn", async () => {
    const r = open({ FAKE_CODEX_SLOW_MS: "600", FAKE_CODEX_IGNORE_INTERRUPT: "1" });
    try {
      await r.session.send({ text: "first", images: [] });
      await until(() => r.events.some((e) => e.type === "turn_started"));
      await new Promise((x) => setTimeout(x, 80));
      await r.session.interrupt();
      await until(() => r.events.some((e) => e.type === "turn_ended" && (e as { status?: string }).status === "interrupted"));
      await expect(r.session.send({ text: "second", images: [] })).resolves.toBeUndefined();
      await until(() => r.events.filter((e) => e.type === "turn_started").length >= 2);
      await new Promise((x) => setTimeout(x, 800)); // past first turn's slow timeout
      const ends = r.events.filter((e) => e.type === "turn_ended") as { status?: string }[];
      expect(ends[0]?.status).toBe("interrupted");
      expect(ends.filter((e) => e.status === "interrupted")).toHaveLength(1);
    } finally {
      await r.session.close();
      await r.done;
      delete process.env.FAKE_CODEX_SLOW_MS;
      delete process.env.FAKE_CODEX_LOG;
      delete process.env.FAKE_CODEX_IGNORE_INTERRUPT;
      delete process.env.FAKE_CODEX_START_DELAY_MS;
      delete process.env.FAKE_CODEX_STARTED_DELAY_MS;
      delete process.env.FAKE_CODEX_RESPONSE_HOLD_FILE;
      delete process.env.FAKE_CODEX_STARTED_HOLD_FILE;
    }
  }, 20000);

  it("interrupt before turn/started still ends locally and does not poison the next send", async () => {
    const r = open({ FAKE_CODEX_SLOW_MS: "400" });
    try {
      const sendP = r.session.send({ text: "first", images: [] });
      await until(() => r.events.some((e) => e.type === "turn_started"));
      // Interrupt immediately — may race before fake's delayed turn/started
      await r.session.interrupt();
      await sendP.catch(() => {});
      await until(() => r.events.some((e) => e.type === "turn_ended"));
      await expect(r.session.send({ text: "second", images: [] })).resolves.toBeUndefined();
      await until(() => r.events.filter((e) => e.type === "turn_started").length >= 2);
      await until(() => r.events.filter((e) => e.type === "turn_ended").length >= 2, 10000);
      const ends = r.events.filter((e) => e.type === "turn_ended") as { status?: string }[];
      expect(ends.some((e) => e.status === "interrupted")).toBe(true);
    } finally {
      await r.session.close();
      await r.done;
      delete process.env.FAKE_CODEX_SLOW_MS;
      delete process.env.FAKE_CODEX_LOG;
      delete process.env.FAKE_CODEX_IGNORE_INTERRUPT;
      delete process.env.FAKE_CODEX_START_DELAY_MS;
      delete process.env.FAKE_CODEX_STARTED_DELAY_MS;
      delete process.env.FAKE_CODEX_RESPONSE_HOLD_FILE;
      delete process.env.FAKE_CODEX_STARTED_HOLD_FILE;
    }
  }, 20000);

  it("Stop after turn/start response, before turn/started, then immediate resend", async () => {
    // Hold turn/started until release: interrupted + send(second) must both happen while hold exists
    // (order, not wall clock — red on main which waited for turn/started / completion).
    const hold = join(dir, `hold-started-${Math.random().toString(36).slice(2)}`);
    writeFileSync(hold, "");
    const r = open({ FAKE_CODEX_SLOW_MS: "1500", FAKE_CODEX_STARTED_DELAY_MS: "0", FAKE_CODEX_STARTED_HOLD_FILE: hold });
    try {
      await r.session.send({ text: "first", images: [] });
      await until(() => r.events.some((e) => e.type === "turn_started"));
      // Response is not held — wait until send() returns (currentTurnId set) then Stop before started
      await r.session.interrupt();
      await until(() => r.events.some((e) => e.type === "turn_ended" && (e as { status?: string }).status === "interrupted"));
      await expect(r.session.send({ text: "second", images: [] })).resolves.toBeUndefined();
      await until(() => r.events.filter((e) => e.type === "turn_started").length >= 2);
      expect(existsSync(hold)).toBe(true); // fake has not emitted turn/started for turn 1 yet
      unlinkSync(hold);
      await until(() => lines(r.logFile).some((l) => l.in?.method === "turn/interrupt"), 5000);
      expect(lines(r.logFile).find((l) => l.in?.method === "turn/interrupt").in.params.turnId).toBe("codex-turn-1");
      await until(() => r.events.filter((e) => e.type === "turn_ended").length >= 2, 10000);
      const ends = r.events.filter((e) => e.type === "turn_ended") as { status?: string; turnId?: string }[];
      expect(ends.map((e) => e.status)).toEqual(["interrupted", "completed"]);
      expect(ends[1]?.turnId?.startsWith("u_")).toBe(true);
    } finally {
      try { unlinkSync(hold); } catch { /* already gone */ }
      await r.session.close();
      await r.done;
      delete process.env.FAKE_CODEX_SLOW_MS;
      delete process.env.FAKE_CODEX_LOG;
      delete process.env.FAKE_CODEX_IGNORE_INTERRUPT;
      delete process.env.FAKE_CODEX_START_DELAY_MS;
      delete process.env.FAKE_CODEX_STARTED_DELAY_MS;
      delete process.env.FAKE_CODEX_RESPONSE_HOLD_FILE;
      delete process.env.FAKE_CODEX_STARTED_HOLD_FILE;
    }
  }, 20000);

  it("Stop while turn/start is in flight, then immediate resend interrupts codex-turn-1", async () => {
    // Hold the first turn/start response: interrupt + send(second) must both happen while hold exists.
    // ourTurnId !== turnId alone covers this (cancelledLocalTurns removed as redundant). Red on main.
    const hold = join(dir, `hold-response-${Math.random().toString(36).slice(2)}`);
    writeFileSync(hold, "");
    const r = open({ FAKE_CODEX_SLOW_MS: "1500", FAKE_CODEX_RESPONSE_HOLD_FILE: hold });
    try {
      const send1 = r.session.send({ text: "first", images: [] });
      await until(() => r.events.some((e) => e.type === "turn_started"));
      await r.session.interrupt();
      await until(() => r.events.some((e) => e.type === "turn_ended" && (e as { status?: string }).status === "interrupted"));
      // Do not await send(second) until the hold is released — its turn/start response is also gated.
      const send2 = r.session.send({ text: "second", images: [] });
      await until(() => r.events.filter((e) => e.type === "turn_started").length >= 2);
      expect(existsSync(hold)).toBe(true); // turn/start response for turn 1 still held
      unlinkSync(hold);
      await send1.catch(() => {});
      await send2;
      await until(() => lines(r.logFile).some((l) => l.in?.method === "turn/interrupt"), 5000);
      const interrupts = lines(r.logFile).filter((l) => l.in?.method === "turn/interrupt").map((l) => l.in.params.turnId);
      expect(interrupts).toContain("codex-turn-1");
      await until(() => r.events.filter((e) => e.type === "turn_ended").length >= 2, 10000);
      await new Promise((x) => setTimeout(x, 300));
      const ends = r.events.filter((e) => e.type === "turn_ended") as { status?: string; turnId?: string }[];
      expect(ends).toHaveLength(2);
      expect(ends.map((e) => e.status)).toEqual(["interrupted", "completed"]);
      expect(ends.every((e) => e.turnId && e.turnId.startsWith("u_"))).toBe(true);
    } finally {
      try { unlinkSync(hold); } catch { /* already gone */ }
      await r.session.close();
      await r.done;
      delete process.env.FAKE_CODEX_SLOW_MS;
      delete process.env.FAKE_CODEX_LOG;
      delete process.env.FAKE_CODEX_IGNORE_INTERRUPT;
      delete process.env.FAKE_CODEX_START_DELAY_MS;
      delete process.env.FAKE_CODEX_STARTED_DELAY_MS;
      delete process.env.FAKE_CODEX_RESPONSE_HOLD_FILE;
      delete process.env.FAKE_CODEX_STARTED_HOLD_FILE;
    }
  }, 20000);
});
