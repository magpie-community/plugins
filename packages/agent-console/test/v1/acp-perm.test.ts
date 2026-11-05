// ACP permission requests that outlive their turn (Nolan's Cursor thread, 1.2.0: 等待授权 in the top bar, no card to click).
// Cursor asked session/request_permission, then its model stream died ("[canceled] http/2 stream closed … CANCEL") and
// the turn ended without the request being answered or withdrawn. The request must be closed as cancelled before the
// turn end, and a request the Agent withdraws ($/cancel_request) must close too.
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

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "acp-perm-")); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => { delete process.env.FAKE_ACP_PERM; delete process.env.FAKE_ACP_PERM_LOG; });

type Run = { session: ProviderSession; events: ProviderEvent[]; plog: string; done: Promise<void> };

async function open(mode: string): Promise<Run> {
  const plog = join(dir, `p-${Math.random().toString(36).slice(2)}.jsonl`);
  process.env.FAKE_ACP_PERM = mode;
  process.env.FAKE_ACP_PERM_LOG = plog;
  const provider = createAcpProvider({ id: "fake-perm", name: "Fake ACP", binName: "fake-acp", acpArgs: [], installHint: "" });
  const session = await provider.createSession({ threadId: "t1", cwd: dir, model: null, mode: "default", effort: null, resumeId: null, launch });
  const events: ProviderEvent[] = [];
  const done = (async () => { for await (const ev of session.events) events.push(ev); })();
  return { session, events, plog, done };
}
async function until(check: () => boolean, ms = 10000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
const answers = (r: Run) => existsSync(r.plog) ? readFileSync(r.plog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const idx = (r: Run, type: string) => r.events.findIndex((e) => e.type === type);
type Req = Extract<ProviderEvent, { type: "permission_request" }>;
type Res = Extract<ProviderEvent, { type: "permission_resolved" }>;

describe("ACP permission requests and the end of a turn", () => {
  it("a turn that ends with the request unanswered closes it as cancelled, before turn_ended", async () => {
    const r = await open("abandon");
    try {
      await r.session.send({ text: "status", images: [] });
      await until(() => idx(r, "turn_ended") >= 0);
      const req = r.events.find((e) => e.type === "permission_request") as Req;
      const res = r.events.find((e) => e.type === "permission_resolved") as Res | undefined;
      expect(res).toMatchObject({ requestId: req.requestId, cancelled: true });
      expect(idx(r, "permission_resolved")).toBeLessThan(idx(r, "turn_ended"));
      // The Agent's request got its answer (cancelled) instead of hanging
      await until(() => answers(r).length === 1);
      expect(answers(r)[0].result).toEqual({ outcome: { outcome: "cancelled" } });
      // Answering it now is a no-op (no second resolved event)
      r.session.respond(req.requestId, { optionId: "allow-once" });
      expect(r.events.filter((e) => e.type === "permission_resolved")).toHaveLength(1);
    } finally {
      await r.session.close();
      await r.done;
    }
  }, 20000);

  it("a request the Agent withdraws ($/cancel_request) closes as cancelled", async () => {
    const r = await open("withdraw");
    try {
      await r.session.send({ text: "status", images: [] });
      await until(() => idx(r, "turn_ended") >= 0);
      const req = r.events.find((e) => e.type === "permission_request") as Req;
      expect(r.events.find((e) => e.type === "permission_resolved")).toMatchObject({ requestId: req.requestId, cancelled: true });
      expect(idx(r, "permission_resolved")).toBeLessThan(idx(r, "turn_ended"));
    } finally {
      await r.session.close();
      await r.done;
    }
  }, 20000);

  it("answering passes the chosen optionId through (allow-always reaches Cursor as allow-always)", async () => {
    const r = await open("answer");
    try {
      await r.session.send({ text: "status", images: [] });
      await until(() => idx(r, "permission_request") >= 0);
      const req = r.events.find((e) => e.type === "permission_request") as Req;
      r.session.respond(req.requestId, { optionId: "allow-always" });
      await until(() => idx(r, "turn_ended") >= 0);
      expect(answers(r)[0].result).toEqual({ outcome: { outcome: "selected", optionId: "allow-always" } });
      expect(r.events.filter((e) => e.type === "permission_resolved")).toEqual([
        expect.objectContaining({ requestId: req.requestId, optionId: "allow-always" }),
      ]);
    } finally {
      await r.session.close();
      await r.done;
    }
  }, 20000);
});
