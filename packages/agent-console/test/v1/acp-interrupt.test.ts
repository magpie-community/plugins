// ACP session/cancel must be a notification. Devin CLI only registers CancelNotification; a request got
 // -32601 Method not found, running stayed true, and the next send failed with 当前轮次尚未结束 after Stop.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAcpProvider } from "../../daemon/src/providers/acp/provider.js";
import type { ProviderSession } from "../../daemon/src/providers/types.js";
import type { ProviderEvent } from "../../daemon/src/timeline/types.js";

const fixture = resolve(__dirname, "fixtures", "fake-acp-agent.mjs");
const launch = { cmd: process.execPath, prefixArgs: [fixture] };
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "acp-interrupt-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  delete process.env.FAKE_ACP_CANCEL_LOG;
  delete process.env.FAKE_ACP_SLOW_MS;
  delete process.env.FAKE_ACP_IGNORE_CANCEL;
  delete process.env.FAKE_ACP_CANCEL_AS_ERROR;
  delete process.env.FAKE_ACP_CANCEL_SETTLE_MS;
});

type Run = { session: ProviderSession; events: ProviderEvent[]; clog: string; done: Promise<void> };

async function open(opts: { slowMs?: number; ignoreCancel?: boolean; cancelAsError?: boolean; cancelSettleMs?: number } = {}): Promise<Run> {
  const clog = join(dir, `c-${Math.random().toString(36).slice(2)}.jsonl`);
  process.env.FAKE_ACP_CANCEL_LOG = clog;
  if (opts.slowMs != null) process.env.FAKE_ACP_SLOW_MS = String(opts.slowMs);
  else delete process.env.FAKE_ACP_SLOW_MS;
  if (opts.ignoreCancel) process.env.FAKE_ACP_IGNORE_CANCEL = "1";
  else delete process.env.FAKE_ACP_IGNORE_CANCEL;
  if (opts.cancelAsError) process.env.FAKE_ACP_CANCEL_AS_ERROR = "1";
  else delete process.env.FAKE_ACP_CANCEL_AS_ERROR;
  if (opts.cancelSettleMs != null) process.env.FAKE_ACP_CANCEL_SETTLE_MS = String(opts.cancelSettleMs);
  else delete process.env.FAKE_ACP_CANCEL_SETTLE_MS;
  const provider = createAcpProvider({ id: "fake-interrupt", name: "Fake ACP", binName: "fake-acp", acpArgs: [], installHint: "" });
  const session = await provider.createSession({
    threadId: "t1", cwd: dir, model: null, mode: "default", effort: null, resumeId: null, launch,
  });
  const events: ProviderEvent[] = [];
  const done = (async () => {
    for await (const ev of session.events) events.push(ev);
  })();
  return { session, events, clog, done };
}

async function until(check: () => boolean, ms = 10000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const cancels = (clog: string) =>
  existsSync(clog) ? readFileSync(clog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

describe("ACP interrupt / session/cancel", () => {
  it("interrupt sends session/cancel as a notification (no JSON-RPC id), not a request", async () => {
    const r = await open({ slowMs: 5000 });
    try {
      await r.session.send({ text: "slow", images: [] });
      await until(() => r.events.some((e) => e.type === "turn_started"));
      await r.session.interrupt();
      await until(() => cancels(r.clog).length >= 1);
      expect(cancels(r.clog)[0]).toMatchObject({ notification: true, hasId: false });
      await until(() => r.events.some((e) => e.type === "turn_ended"));
      const end = r.events.find((e) => e.type === "turn_ended") as { status?: string };
      expect(end.status).toBe("interrupted");
    } finally {
      await r.session.close();
      await r.done;
    }
  }, 20000);

  it("after interrupt, send() is allowed again even when the agent ignores cancel (running cleared)", async () => {
    const r = await open({ slowMs: 8000, ignoreCancel: true });
    try {
      await r.session.send({ text: "first", images: [] });
      await until(() => r.events.some((e) => e.type === "turn_started"));
      await r.session.interrupt();
      await until(() => r.events.some((e) => e.type === "turn_ended" && (e as { status?: string }).status === "interrupted"));
      // Must not throw 当前轮次尚未结束 — the local running flag was cleared on interrupt
      await expect(r.session.send({ text: "second", images: [] })).resolves.toBeUndefined();
      await until(() => r.events.filter((e) => e.type === "turn_started").length >= 2);
      expect(r.events.filter((e) => e.type === "turn_started")).toHaveLength(2);
      // No failed turn claiming 当前轮次尚未结束
      const failed = r.events.filter((e) => e.type === "turn_ended" && (e as { status?: string }).status === "failed");
      expect(failed.map((e) => (e as { error?: string }).error ?? "")).not.toEqual(
        expect.arrayContaining([expect.stringContaining("当前轮次尚未结束")]),
      );
    } finally {
      await r.session.close();
      await r.done;
    }
  }, 20000);

  it("a late stopReason from the cancelled prompt does not end the next turn", async () => {
    // Agent will eventually end the ignored-cancel prompt; that stop must be discarded
    const r = await open({ slowMs: 300, ignoreCancel: true });
    try {
      await r.session.send({ text: "first", images: [] });
      await until(() => r.events.some((e) => e.type === "turn_started"));
      await r.session.interrupt();
      await until(() => r.events.some((e) => e.type === "turn_ended"));
      await r.session.send({ text: "second", images: [] });
      await until(() => r.events.filter((e) => e.type === "turn_started").length >= 2);
      // Wait past the first prompt's slow timeout so its stopReason arrives
      await new Promise((r) => setTimeout(r, 500));
      // Second turn should still be running (or complete on its own later) — not closed by the stale stop
      const ends = r.events.filter((e) => e.type === "turn_ended") as { status?: string; turnId?: string }[];
      // Only the interrupt end so far (second turn's prompt still open until its own 300ms, which may have fired)
      // Accept either: second still open, or second completed with end_turn — never a spurious double-interrupt.
      expect(ends[0]?.status).toBe("interrupted");
      expect(ends.filter((e) => e.status === "interrupted")).toHaveLength(1);
    } finally {
      await r.session.close();
      await r.done;
    }
  }, 20000);

  it("cancel answered with JSON-RPC error (-32603) must not swallow the next turn's stop", async () => {
    // pendingCancelStops only decremented on stop; a -32603 on the cancelled prompt left the counter at 1
    // and the next turn's stop was discarded so that turn never ended.
    const r = await open({ slowMs: 250, cancelAsError: true });
    try {
      await r.session.send({ text: "first", images: [] });
      await until(() => r.events.some((e) => e.type === "turn_started"));
      await r.session.interrupt();
      await until(() => r.events.some((e) => e.type === "turn_ended" && (e as { status?: string }).status === "interrupted"));
      await expect(r.session.send({ text: "second", images: [] })).resolves.toBeUndefined();
      await until(() => r.events.filter((e) => e.type === "turn_started").length >= 2);
      // Second turn must be able to end normally when its own stop arrives (not swallowed by a leftover counter)
      await until(() => r.events.filter((e) => e.type === "turn_ended").length >= 2, 10000);
      const ends = r.events.filter((e) => e.type === "turn_ended") as { status?: string }[];
      expect(ends[0]?.status).toBe("interrupted");
      expect(ends[ends.length - 1]?.status).toBe("completed");
    } finally {
      await r.session.close();
      await r.done;
    }
  }, 20000);

  it("0ms resend after interrupt: Devin-like cancel settle must not cancel Turn 2", async () => {
    // Real Devin cancels an overlapping session/prompt that arrives while prompt1 is still unwinding.
    // Without pendingCancelSettle, ends are [interrupted, interrupted]; with the fix [interrupted, completed].
    const r = await open({ slowMs: 5000, cancelSettleMs: 60 });
    try {
      await r.session.send({ text: "first", images: [] });
      await until(() => r.events.some((e) => e.type === "turn_started"));
      await r.session.interrupt();
      await until(() => r.events.some((e) => e.type === "turn_ended" && (e as { status?: string }).status === "interrupted"));
      // Immediate 0ms resend (AgentManager queue / instant UI send)
      await expect(r.session.send({ text: "second", images: [] })).resolves.toBeUndefined();
      await until(() => r.events.filter((e) => e.type === "turn_started").length >= 2);
      await until(() => r.events.filter((e) => e.type === "turn_ended").length >= 2, 10000);
      const ends = r.events.filter((e) => e.type === "turn_ended") as { status?: string }[];
      expect(ends.map((e) => e.status)).toEqual(["interrupted", "completed"]);
      const afterT2 = r.events.filter((e) => e.type === "turn_started").length >= 2;
      const t2StartIdx = r.events.findIndex((e, i) => e.type === "turn_started" && r.events.slice(0, i + 1).filter((x) => x.type === "turn_started").length === 2);
      const afterStart = r.events.slice(t2StartIdx + 1);
      const stale = afterStart.filter((e) => e.type === "assistant_delta" && (e as { text?: string }).text === "STALE_FROM_TURN_1");
      expect(stale).toHaveLength(0);
      const t2Text = afterStart
        .filter((e) => e.type === "assistant_delta" || e.type === "assistant_message")
        .map((e) => (e as { text?: string }).text || "")
        .join("");
      expect(t2Text.length).toBeGreaterThan(0);
      expect(t2Text).not.toContain("STALE_FROM_TURN_1");
      void afterT2;
    } finally {
      await r.session.close();
      await r.done;
    }
  }, 20000);
});
