// 1.3 item 2: Claude-desktop-style folding of tool calls and short thinking
import { describe, it, expect } from "vitest";
import { foldTimeline, summarize, stepTarget, activeStep, SHORT_THINK_CHARS } from "../../web/src/timeline/fold.js";
import { reduceTimeline, type DisplayItem, type ToolStep } from "../../web/src/timeline/reducer.js";
import { mapSdkMessage, newMapState } from "../../daemon/src/providers/claude/map.js";

type Ev = Record<string, unknown>;
let seq = 0;
const tl = (evs: Ev[]) => evs.map((e) => ({ seq: ++seq, ts: 0, threadId: "t", turnId: "u1", ...e })) as never[];
const tool = (itemId: string, kind: string, status: string, extra: Ev = {}): Ev => ({ type: "tool_call", itemId, kind, title: `${kind} ${itemId}`, status, ...extra });
const kinds = (items: DisplayItem[]) => items.map((i) => i.kind);
const group = (items: DisplayItem[], n = 0) => items.filter((i) => i.kind === "toolgroup")[n] as Extract<DisplayItem, { kind: "toolgroup" }>;

describe("foldTimeline", () => {
  it("merges tool runs split by short thinking into one group; long thinking and text still break it", () => {
    const { items } = reduceTimeline(tl([
      { type: "user_message", text: "hi" },
      { type: "reasoning", itemId: "r0", text: "先看看" },
      tool("a", "read", "ok"),
      { type: "reasoning", itemId: "r1", text: "" },
      tool("b", "bash", "ok"),
      { type: "reasoning", itemId: "r2", text: "嗯".repeat(20) },
      tool("c", "edit", "ok"),
      { type: "reasoning", itemId: "r3", text: "长".repeat(SHORT_THINK_CHARS + 1) },
      tool("d", "search", "ok"),
      { type: "assistant_message", itemId: "m", text: "完成" },
      tool("e", "read", "ok"),
    ]), { runtimeStatus: "idle" });
    // the reducer alone makes 5 groups; folded: [user, group(r0,a,r1,b,r2,c), long reasoning, group(d), assistant, group(e)]
    expect(items.filter((i) => i.kind === "toolgroup")).toHaveLength(5);
    const f = foldTimeline(items);
    expect(kinds(f)).toEqual(["user", "toolgroup", "reasoning", "toolgroup", "assistant", "toolgroup"]);
    // the empty finished thinking (r1) is dropped, the short ones become steps
    expect(group(f).steps.map((s) => s.kind)).toEqual(["think", "read", "bash", "think", "edit"]);
    expect(summarize(group(f).steps).counts).toEqual([["edit", 1], ["run", 1], ["read", 1]]);
  });

  it("does not mutate the reducer's items", () => {
    const { items } = reduceTimeline(tl([tool("a", "read", "ok"), { type: "reasoning", itemId: "r", text: "x" }, tool("b", "read", "ok")]), {});
    const before = JSON.stringify(items);
    foldTimeline(items);
    foldTimeline(items);
    expect(JSON.stringify(items)).toBe(before);
  });

  it("drops a lone finished empty thinking row, keeps short thinking that has no tools next to it", () => {
    const { items } = reduceTimeline(tl([
      { type: "reasoning", itemId: "r0", text: "" },
      { type: "assistant_message", itemId: "m", text: "a" },
      { type: "reasoning", itemId: "r1", text: "短" },
      { type: "assistant_message", itemId: "m2", text: "b" },
    ]), { runtimeStatus: "idle" });
    expect(kinds(foldTimeline(items))).toEqual(["assistant", "reasoning", "assistant"]);
  });

  it("showThinking off hides thinking everywhere, also inside groups", () => {
    const { items } = reduceTimeline(tl([{ type: "reasoning", itemId: "r0", text: "x" }, tool("a", "read", "ok"), { type: "reasoning", itemId: "r1", text: "y".repeat(500) }]), {});
    const f = foldTimeline(items, { showThinking: false });
    expect(kinds(f)).toEqual(["toolgroup"]);
    expect(group(f).steps.map((s) => s.kind)).toEqual(["read"]);
  });

  it("gone items are transparent (a hidden row doesn't split a run)", () => {
    const items = [
      { kind: "toolgroup", key: "g1", steps: [{ itemId: "a", kind: "read", title: "", status: "ok" }] },
      { kind: "gone", key: "x" },
      { kind: "toolgroup", key: "g2", steps: [{ itemId: "b", kind: "glob", title: "", status: "ok" }] },
    ] as DisplayItem[];
    const f = foldTimeline(items);
    expect(f).toHaveLength(1);
    expect(f[0]!.key).toBe("g1");
  });
});

describe("summary, failures and the running row", () => {
  it("counts by category in a fixed order and counts failures", () => {
    const steps = [
      { itemId: "1", kind: "glob", title: "", status: "ok" }, { itemId: "2", kind: "web", title: "", status: "ok" },
      { itemId: "3", kind: "bash", title: "", status: "failed" }, { itemId: "4", kind: "write", title: "", status: "ok" },
      { itemId: "5", kind: "edit", title: "", status: "failed" }, { itemId: "6", kind: "mcp", title: "", status: "ok" },
      { itemId: "7", kind: "think", title: "", status: "ok", think: { text: "x".repeat(80), streaming: false } },
    ] as ToolStep[];
    expect(summarize(steps)).toEqual({ counts: [["edit", 2], ["run", 1], ["search", 2], ["other", 1]], failed: 2, thinkSecs: 2 });
  });

  it("running row: the last running tool's command / file, else streaming thinking at the end", () => {
    const run = { itemId: "1", kind: "bash", title: "运行 npm   test", status: "running", input: { command: "npm\n  test --run" } } as ToolStep;
    expect(stepTarget(run)).toBe("npm test --run");
    expect(stepTarget({ itemId: "2", kind: "read", title: "读取 a", status: "running", input: { file_path: "src/a.ts" } })).toBe("src/a.ts");
    expect(stepTarget({ itemId: "3", kind: "other", title: "Some tool", status: "running" })).toBe("Some tool");
    expect(activeStep([run, { itemId: "x", kind: "read", title: "", status: "ok" }])).toBe(run);
    const think = { itemId: "t", kind: "think", title: "", status: "running", think: { text: "", streaming: true } } as ToolStep;
    expect(activeStep([{ itemId: "x", kind: "read", title: "", status: "ok" }, think])).toBe(think);
    expect(activeStep([{ itemId: "x", kind: "read", title: "", status: "ok" }])).toBeNull();
  });

  it("an interrupted turn: leftover running steps become failures once idle", () => {
    const { items } = reduceTimeline(tl([tool("a", "bash", "running", { input: { command: "sleep 99" } })]), { runtimeStatus: "idle" });
    const f = foldTimeline(items);
    expect(summarize(group(f).steps).failed).toBe(1);
    expect(activeStep(group(f).steps)).toBeNull();
  });
});

describe("real adapter shapes: claude stream-json", () => {
  it("thinking + Read + Bash(error) in one assistant message fold into one summary with 1 failure", () => {
    const st = newMapState();
    const raw: Ev[] = [
      ...mapSdkMessage({ type: "assistant", message: { id: "m1", content: [
        { type: "thinking", thinking: "先读文件再跑测试" },
        { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "src/a.ts" } },
        { type: "tool_use", id: "tu2", name: "Bash", input: { command: "npm test" } },
      ] } }, st, "/p") as Ev[],
      ...mapSdkMessage({ type: "user", message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "export {}" }] },
        { type: "tool_result", tool_use_id: "tu2", content: "Error: 1 test failed", is_error: true },
      ] } }, st, "/p") as Ev[],
    ];
    const { items } = reduceTimeline(tl(raw), { runtimeStatus: "idle" });
    const f = foldTimeline(items);
    expect(kinds(f)).toEqual(["toolgroup"]);
    const sum = summarize(group(f).steps);
    expect(sum.counts).toEqual([["run", 1], ["read", 1]]);
    expect(sum.failed).toBe(1);
    const failed = group(f).steps.find((s) => s.status === "failed")!;
    expect(failed.output).toContain("1 test failed");
  });
});
