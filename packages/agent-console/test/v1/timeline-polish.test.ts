// 1.3 timeline polish: compact tool rows (+N -M), checklists from every provider's step list, the tasks pill,
// and the reply footer's model / time
import { describe, it, expect } from "vitest";
import { foldTimeline, toolStepCount, stepDiffStat, todoProgress, currentChecklist, TOOL_COLLAPSE_AT } from "../../web/src/timeline/fold.js";
import { reduceTimeline, type DisplayItem, type ToolStep } from "../../web/src/timeline/reducer.js";
import { editDetail } from "../../daemon/src/agents/diff.js";

type Ev = Record<string, unknown>;
let seq = 0;
const tl = (evs: Ev[]) => evs.map((e) => ({ seq: ++seq, ts: 1000 + seq, threadId: "t", turnId: "u1", ...e })) as never[];
const tool = (itemId: string, kind: string, status: string, extra: Ev = {}): Ev => ({ type: "tool_call", itemId, kind, title: `${kind} ${itemId}`, status, ...extra });
const step = (kind: string, detail?: unknown): ToolStep => ({ itemId: kind, kind, title: kind, status: "ok", detail } as ToolStep);
const todos = (items: DisplayItem[]) => items.filter((i): i is Extract<DisplayItem, { kind: "todo" }> => i.kind === "todo");

describe("checklists", () => {
  it("an ACP plan with entries is a checklist (completed → done); a plan without entries stays a plan card", () => {
    const { items } = reduceTimeline(tl([
      { type: "plan", itemId: "p", markdown: "- a\n- b", entries: [{ step: "a", status: "completed" }, { step: "b", status: "in_progress" }, { step: "c", status: "pending" }] },
      { type: "plan", itemId: "q", markdown: "## 计划\n1. x" },
    ]), {});
    expect(todos(items)[0]!.items).toEqual([{ text: "a", status: "done" }, { text: "b", status: "in_progress" }, { text: "c", status: "pending" }]);
    expect(items.some((i) => i.kind === "plan")).toBe(true);
  });

  it("only the latest list of a user turn is shown; Claude's TodoWrite tool row is not repeated as a step", () => {
    const { items } = reduceTimeline(tl([
      { type: "user_message", text: "1" },
      { type: "todo", items: [{ text: "a", status: "pending" }] },
      tool("w", "todo", "ok"),
      tool("r", "read", "ok"),
      { type: "todo", items: [{ text: "a", status: "done" }] },
      { type: "user_message", text: "2" },
      { type: "todo", items: [{ text: "b", status: "pending" }] },
    ]), {});
    const f = foldTimeline(items);
    expect(todos(f).map((t) => t.items[0]!.text + t.items[0]!.status)).toEqual(["adone", "bpending"]);
    const g = f.find((i) => i.kind === "toolgroup") as Extract<DisplayItem, { kind: "toolgroup" }>;
    expect(g.steps.map((s) => s.kind)).toEqual(["read"]);
  });

  it("the pill shows the latest turn's list while something is open, not a finished one or an older turn's", () => {
    const run = (evs: Ev[]) => currentChecklist(foldTimeline(reduceTimeline(tl(evs), {}).items));
    expect(run([{ type: "user_message", text: "1" }, { type: "todo", items: [{ text: "a", status: "done" }, { text: "b", status: "pending" }] }])?.items).toHaveLength(2);
    expect(run([{ type: "user_message", text: "1" }, { type: "todo", items: [{ text: "a", status: "done" }] }])).toBeNull();
    expect(run([{ type: "todo", items: [{ text: "a", status: "pending" }] }, { type: "user_message", text: "2" }])).toBeNull();
    expect(todoProgress([{ status: "done" }, { status: "completed" }, { status: "in_progress" }])).toEqual({ done: 2, total: 3 });
  });
});

describe("tool rows", () => {
  it("counts tool calls (not thinking) against the collapse threshold", () => {
    expect(TOOL_COLLAPSE_AT).toBe(6);
    expect(toolStepCount([step("think"), step("read"), step("bash"), step("think")])).toBe(2);
  });

  it("+N -M from the daemon's counts, else from the hunks; null without a diff", () => {
    const d = editDetail({ path: "a.ts", old: "x\ny\n", new: "x\nz\nw\n" });
    expect(stepDiffStat(step("edit", d))).toEqual({ added: 2, removed: 1 });
    expect(stepDiffStat(step("edit", { hunks: d.hunks }))).toEqual({ added: 2, removed: 1 });
    expect(stepDiffStat(step("edit"))).toBeNull();
    expect(stepDiffStat(step("bash", "text"))).toBeNull();
  });
});

describe("reply footer", () => {
  it("the turn end carries the turn's model and end time", () => {
    const { items } = reduceTimeline(tl([
      { type: "turn_started", model: "gpt-5.5" },
      { type: "assistant_message", itemId: "m", text: "ok" },
      { type: "turn_ended", status: "completed" },
    ]), {});
    const te = items.find((i) => i.kind === "turnend") as Extract<DisplayItem, { kind: "turnend" }>;
    expect(te.model).toBe("gpt-5.5");
    expect(typeof te.ts).toBe("number");
    expect(te.durationMs).toBeGreaterThanOrEqual(0);
  });
});
