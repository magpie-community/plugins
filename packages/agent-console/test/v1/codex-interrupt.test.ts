// Codex interrupt: turn/interrupt is a JSON-RPC *request* (has a response). After interrupt the local turn
// must end so a late turn/completed cannot bind onto the next send (same class of bug as ACP/Devin).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    }
  }, 20000);

  it("Stop before turn/started still sends turn/interrupt from turn/start response id", async () => {
    // Race yetone called out: Stop before turn/started, then an immediate new message. send() clears
    // interruptWanted, so without using the turn id from turn/start's response the first Codex turn is
    // never interrupted (no turn/interrupt) and staleNextCodexTurn was a sticky guess. This test is red
    // without the response-id fix.
    const r = open({ FAKE_CODEX_SLOW_MS: "800" });
    try {
      await r.session.send({ text: "first", images: [] });
      await until(() => r.events.some((e) => e.type === "turn_started"));
      // Interrupt in the window before the delayed turn/started notification.
      await r.session.interrupt();
      await until(() => r.events.some((e) => e.type === "turn_ended" && (e as { status?: string }).status === "interrupted"));
      // Immediate resend clears interruptWanted — must NOT prevent turn/interrupt for the first turn.
      await expect(r.session.send({ text: "second", images: [] })).resolves.toBeUndefined();
      await until(() => lines(r.logFile).some((l) => l.in?.method === "turn/interrupt"), 5000);
      const hit = lines(r.logFile).find((l) => l.in?.method === "turn/interrupt");
      expect(hit.in.params.turnId).toBe("codex-turn-1");
      await until(() => r.events.filter((e) => e.type === "turn_started").length >= 2);
      await until(() => r.events.filter((e) => e.type === "turn_ended").length >= 2, 10000);
      const ends = r.events.filter((e) => e.type === "turn_ended") as { status?: string }[];
      expect(ends[0]?.status).toBe("interrupted");
      expect(ends.filter((e) => e.status === "interrupted")).toHaveLength(1);
      expect(ends[ends.length - 1]?.status).toBe("completed");
      const starts = lines(r.logFile).filter((l) => l.in?.method === "turn/start");
      expect(starts.length).toBeGreaterThanOrEqual(2);
    } finally {
      await r.session.close();
      await r.done;
      delete process.env.FAKE_CODEX_SLOW_MS;
      delete process.env.FAKE_CODEX_LOG;
      delete process.env.FAKE_CODEX_IGNORE_INTERRUPT;
    }
  }, 20000);
});
