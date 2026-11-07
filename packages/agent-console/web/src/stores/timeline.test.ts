// 1.3.7: `pending` keeps its reference across token deltas, so App's selectors don't re-render the shell per token
import { describe, it, expect, vi, beforeEach } from "vitest";

type Handler = (ch: string, d: unknown) => void;
const fake = vi.hoisted(() => ({ handlers: new Map<string, (ch: string, d: unknown) => void>() }));
vi.mock("../main", () => ({
  ws: {
    call: async (method: string) => {
      if (method === "threads.get") return { meta: { status: "running" }, events: [], queue: [], pending: [], runtimeStatus: "running" };
      return {};
    },
    subscribe: (ch: string, cb: Handler) => {
      fake.handlers.set(ch, cb);
      return () => fake.handlers.delete(ch);
    },
  },
}));

import { useTimeline, EMPTY_PENDING, samePending, stablePending, type PendingReq } from "./timeline";

const TID = "t_pending";
let seq = 0;
const push = (d: unknown) => fake.handlers.get(`thread:${TID}`)!(`thread:${TID}`, d);
const ev = (e: Record<string, unknown>) => push({ type: "event", event: { ts: Date.now(), threadId: TID, turnId: "u1", ...e } });
const delta = (text: string) => ev({ seq: -1, type: "assistant_delta", itemId: "a1", text });

async function openThread() {
  useTimeline.getState().close();
  useTimeline.getState().open(TID);
  for (let i = 0; i < 50 && !fake.handlers.has(`thread:${TID}`); i++) await new Promise((r) => setTimeout(r, 0));
  expect(fake.handlers.has(`thread:${TID}`)).toBe(true);
}

describe("useTimeline pending reference", () => {
  beforeEach(() => { seq = 0; fake.handlers.clear(); });

  it("samePending / stablePending compare id, kind and key", () => {
    const a: PendingReq[] = [{ requestId: "r1", kind: "permission", key: "k1" }];
    expect(samePending(a, [{ requestId: "r1", kind: "permission", key: "k1" }])).toBe(true);
    expect(samePending(a, [{ requestId: "r2", kind: "permission", key: "k1" }])).toBe(false);
    expect(samePending(a, [{ requestId: "r1", kind: "question", key: "k1" }])).toBe(false);
    expect(samePending(a, [{ requestId: "r1", kind: "permission", key: "k2" }])).toBe(false);
    expect(samePending(a, [])).toBe(false);
    expect(stablePending(a, [{ requestId: "r1", kind: "permission", key: "k1" }])).toBe(a);
    expect(stablePending(a, [])).toBe(EMPTY_PENDING);
  });

  it("streamed deltas keep s.pending === across updates; a permission request and its resolution change it", async () => {
    await openThread();
    const p0 = useTimeline.getState().pending;
    expect(p0).toBe(EMPTY_PENDING);
    let changes = 0;
    const unsub = useTimeline.subscribe((s, prev) => { if (s.pending !== prev.pending) changes++; });

    ev({ seq: ++seq, type: "turn_started" });
    for (let i = 0; i < 20; i++) delta(`token ${i} `);
    ev({ seq: -1, type: "reasoning_delta", itemId: "r1", text: "thinking" });
    push({ type: "status", status: "running" });
    expect(useTimeline.getState().items.length).toBeGreaterThan(0);
    expect(useTimeline.getState().pending).toBe(p0);
    expect(changes).toBe(0);

    ev({ seq: ++seq, type: "permission_request", requestId: "req1", title: "run ls", kind: "execute", options: [{ id: "allow", label: "Allow", kind: "allow_once" }] });
    const p1 = useTimeline.getState().pending;
    expect(p1).not.toBe(p0);
    expect(p1.map((p) => p.requestId)).toEqual(["req1"]);
    expect(changes).toBe(1);

    // still waiting: more deltas / a status echo / the daemon's pending list keep the same array
    for (let i = 0; i < 5; i++) delta(`more ${i}`);
    push({ type: "status", status: "running" });
    push({ type: "pending", pending: [{ requestId: "req1", kind: "permission" }] });
    expect(useTimeline.getState().pending).toBe(p1);
    expect(changes).toBe(1);

    ev({ seq: ++seq, type: "permission_resolved", requestId: "req1", optionId: "allow" });
    expect(useTimeline.getState().pending).toBe(EMPTY_PENDING);
    expect(changes).toBe(2);
    for (let i = 0; i < 5; i++) delta(`after ${i}`);
    expect(useTimeline.getState().pending).toBe(EMPTY_PENDING);
    expect(changes).toBe(2);
    unsub();
    useTimeline.getState().close();
    expect(useTimeline.getState().pending).toBe(EMPTY_PENDING);
  });
});
