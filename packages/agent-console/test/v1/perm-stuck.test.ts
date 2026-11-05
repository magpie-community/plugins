// Nolan, Cursor on 1.2.0: the top bar said 等待授权 and the composer was locked ("等待你确认上面的授权请求"), but no card
// in the timeline had buttons. His timeline had one permission_request (seq 501) with no permission_resolved: Cursor's
// stream died ("[canceled] http/2 stream closed … CANCEL") right after asking and the turn ended "completed"; the daemon
// kept the request in its pending list, threads.get handed it to the page, and the card (thread idle) showed 已取消.
import { describe, it, expect } from "vitest";
import { applyEvent, newTimelineState, pendingRequests, reduceTimeline, type DisplayItem } from "../../web/src/timeline/reducer.js";
import { foldTimeline, TOOL_COLLAPSE_AT } from "../../web/src/timeline/fold.js";

type Ev = Record<string, unknown>;
let seq = 0;
const tl = (evs: Ev[]) => evs.map((e) => ({ seq: ++seq, ts: seq, threadId: "t", ...e })) as never[];
const tool = (itemId: string, extra: Ev = {}): Ev => ({ type: "tool_call", itemId, kind: "search", title: `search ${itemId}`, status: "ok", ...extra });
const perm = (requestId: string): Ev => ({
  type: "permission_request", requestId, title: "`git status -sb; git diff --stat`", kind: "execute",
  options: [{ id: "allow-once", label: "Allow", kind: "allow_once" }, { id: "allow-always", label: "Always", kind: "allow_always" }, { id: "reject-once", label: "Reject", kind: "reject_once" }],
});
const permItem = (items: DisplayItem[], id: string) =>
  items.find((i) => i.kind === "permission" && i.requestId === id) as Extract<DisplayItem, { kind: "permission" }> | undefined;

// The shape of Nolan's thread t_mw1ubvax40e6cd around seq 501, then later turns that ran normally
const nolan = () => tl([
  { type: "user_message", text: "看下状态" },
  { type: "turn_started", turnId: "u_1" },
  tool("a"),
  perm("pmp09ibgx"),
  { type: "assistant_message", itemId: "m1", text: "Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)" },
  { type: "turn_ended", turnId: "u_1", status: "completed" },
  { type: "user_message", text: "继续" },
  { type: "turn_started", turnId: "u_2" },
  perm("pjhfg5zac"),
  { type: "permission_resolved", requestId: "pjhfg5zac", optionId: "allow-always" },
  tool("b"),
  { type: "turn_ended", turnId: "u_2", status: "completed" },
]);

describe("a permission request left open by an ended turn (等待授权 with no card)", () => {
  it("replaying 1.2 history: the orphan closes at its turn end, so nothing waits — even while a later turn runs", () => {
    for (const runtimeStatus of ["idle", "running"]) {
      const { items } = reduceTimeline(nolan(), { runtimeStatus });
      expect(permItem(items, "pmp09ibgx")?.status).toBe("cancelled");
      expect(permItem(items, "pjhfg5zac")?.status).toBe("resolved");
      expect(pendingRequests(items)).toEqual([]);
    }
  });

  it("live: the turn_ended event alone closes it (before the idle status arrives)", () => {
    const st = newTimelineState();
    const evs = nolan();
    for (const e of evs.slice(0, 4)) applyEvent(st, e);
    expect(pendingRequests(st.items).map((p) => p.requestId)).toEqual(["pmp09ibgx"]);
    for (const e of evs.slice(4, 6)) applyEvent(st, e);
    expect(pendingRequests(st.items)).toEqual([]);
  });

  it("a request of the running turn still waits, and its card has the key the top bar scrolls to", () => {
    const { items } = reduceTimeline(tl([
      { type: "user_message", text: "x" }, { type: "turn_started", turnId: "u_3" }, tool("c"), perm("live1"),
    ]), { runtimeStatus: "running" });
    expect(pendingRequests(items)).toEqual([{ requestId: "live1", kind: "permission", key: "perm:live1" }]);
    expect(items.some((i) => i.key === "perm:live1")).toBe(true);
  });

  it("a cancelled question closes too (the daemon cancels questions with permission_resolved{cancelled})", () => {
    const { items } = reduceTimeline(tl([
      { type: "turn_started", turnId: "u_4" },
      { type: "question", requestId: "q1", questions: [{ id: "a", question: "?" }] },
      { type: "permission_resolved", requestId: "q1", cancelled: true },
    ]), { runtimeStatus: "running" });
    expect(pendingRequests(items)).toEqual([]);
  });

  it("a pending card is never folded into a tool run, however long the run", () => {
    const run = (p: string, n: number) => Array.from({ length: n }, (_, i) => tool(`${p}${i}`));
    const { items } = reduceTimeline(tl([
      { type: "turn_started", turnId: "u_5" },
      ...run("x", TOOL_COLLAPSE_AT + 3),
      { type: "reasoning", itemId: "r", text: "短" },
      perm("mid"),
      { type: "reasoning", itemId: "r2", text: "短" },
      ...run("y", TOOL_COLLAPSE_AT + 3),
    ]), { runtimeStatus: "running" });
    const folded = foldTimeline(items);
    const top = folded.filter((i) => i.kind === "permission");
    expect(top.map((i) => (i as { requestId: string }).requestId)).toEqual(["mid"]);
    expect(folded.filter((i) => i.kind === "toolgroup")).toHaveLength(2);
    expect(pendingRequests(folded).map((p) => p.requestId)).toEqual(["mid"]);
  });
});
