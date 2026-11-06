// 1.3 全部自动同意 (#727 review item 2): auto-approvals are in the timeline and shown as one quiet foldable row per run
import { describe, it, expect } from "vitest";
import { foldTimeline } from "../../web/src/timeline/fold.js";
import { collectAutoApproved, approvalTarget, approvalChoice } from "../../web/src/timeline/autoApproved.js";
import { reduceTimeline, type DisplayItem } from "../../web/src/timeline/reducer.js";

type Ev = Record<string, unknown>;
let seq = 0;
const tl = (evs: Ev[]) => evs.map((e) => ({ seq: ++seq, ts: 0, threadId: "t", turnId: "u1", ...e })) as never[];
const tool = (itemId: string, kind: string, status: string): Ev => ({ type: "tool_call", itemId, kind, title: `${kind} ${itemId}`, status });
const opts = [{ id: "once", label: "允许一次", kind: "allow_once" }, { id: "always", label: "总是允许", kind: "allow_always" }, { id: "no", label: "拒绝", kind: "reject_once" }];
const autoReq = (id: string, command: string): Ev[] => [
  { type: "permission_request", requestId: id, title: `运行 ${command}`, kind: "tool", detail: { command }, options: opts, auto: true },
  { type: "permission_resolved", requestId: id, optionId: "once", auto: true },
];
const show = (evs: Ev[], status = "idle") => foldTimeline(collectAutoApproved(reduceTimeline(tl(evs), { runtimeStatus: status }).items));
const kinds = (items: DisplayItem[]) => items.map((i) => i.kind);

describe("auto-approved trace", () => {
  it("a run's auto approvals become one row after the run, and don't break the tool summary", () => {
    const items = show([
      { type: "user_message", text: "跑测试" },
      tool("a", "bash", "running"), ...autoReq("r1", "npm test"), tool("a", "bash", "ok"),
      tool("b", "bash", "running"), ...autoReq("r2", "git status"), tool("b", "bash", "ok"),
      { type: "assistant_message", itemId: "m", text: "好了" },
    ]);
    expect(kinds(items)).toEqual(["user", "toolgroup", "autoperm", "assistant"]);
    const g = items[1] as Extract<DisplayItem, { kind: "toolgroup" }>;
    expect(g.steps.map((s) => s.itemId)).toEqual(["a", "b"]);
    const a = items[2] as Extract<DisplayItem, { kind: "autoperm" }>;
    expect(a.items.map(approvalTarget)).toEqual(["npm test", "git status"]);
    expect(a.items.map(approvalChoice)).toEqual(["允许一次", "允许一次"]);
    expect(a.items.every((p) => p.status === "resolved" && p.auto)).toBe(true);
  });

  it("a card the user answered stays a normal card; a card approved when the mode was switched on joins the row", () => {
    const items = show([
      tool("a", "bash", "running"),
      { type: "permission_request", requestId: "u1", title: "运行 rm x", kind: "tool", detail: { command: "rm x" }, options: opts },
      { type: "permission_resolved", requestId: "u1", optionId: "once" },
      tool("b", "bash", "running"),
      { type: "permission_request", requestId: "w1", title: "运行 ls", kind: "tool", detail: { command: "ls" }, options: opts },
      { type: "permission_resolved", requestId: "w1", optionId: "once", auto: true },
    ]);
    expect(kinds(items)).toEqual(["toolgroup", "permission", "toolgroup", "autoperm"]);
    expect((items[3] as Extract<DisplayItem, { kind: "autoperm" }>).items[0]!.requestId).toBe("w1");
  });

  it("an auto request is never a pending card with buttons, even before its answer arrives", () => {
    const items = show([tool("a", "bash", "running"), autoReq("r1", "make")[0]!], "running");
    expect(kinds(items)).toEqual(["toolgroup", "autoperm"]);
  });

  it("nothing auto: the items are passed through untouched", () => {
    const base = reduceTimeline(tl([{ type: "user_message", text: "x" }, tool("a", "read", "ok")]), { runtimeStatus: "idle" }).items;
    expect(collectAutoApproved(base)).toBe(base);
  });
});
