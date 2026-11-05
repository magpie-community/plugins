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
});

type Run = { session: ProviderSession; events: ProviderEvent[]; clog: string; done: Promise<void> };

async function open(opts: { slowMs?: number; ignoreCancel?: boolean } = {}): Promise<Run> {
  const clog = join(dir, `c-${Math.random().toString(36).slice(2)}.jsonl`);
  process.env.FAKE_ACP_CANCEL_LOG = clog;
  if (opts.slowMs != null) process.env.FAKE_ACP_SLOW_MS = String(opts.slowMs);
  else delete process.env.FAKE_ACP_SLOW_MS;
  if (opts.ignoreCancel) process.env.FAKE_ACP_IGNORE_CANCEL = "1";
  else delete process.env.FAKE_ACP_IGNORE_CANCEL;
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
});
