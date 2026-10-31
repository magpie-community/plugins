// reducer unit tests (P2-4): delta merging, tool groups, permission state, seq dedup.
import { describe, it, expect } from "vitest";
import { reduceTimeline, applyEvent, newTimelineState } from "./reducer";
import type { TimelineEvent } from "./types";

let seq = 0;
const ev = (p: Partial<TimelineEvent> & { type: TimelineEvent["type"] }): TimelineEvent =>
  ({ seq: ++seq, ts: 1000 + seq, threadId: "t1", ...p }) as TimelineEvent;

describe("reducer: delta merging", () => {
  it("assistant_delta accumulates into the same itemId; assistant_message replaces it and sets streaming=false", () => {
    const { items } = reduceTimeline([
      ev({ type: "assistant_delta", itemId: "m1:0", text: "你" }),
      ev({ type: "assistant_delta", itemId: "m1:0", text: "好" }),
      ev({ type: "assistant_message", itemId: "m1:0", text: "你好！" }),
    ], { runtimeStatus: "running" });
    expect(items).toHaveLength(1);
    const it = items[0];
    expect(it.kind).toBe("assistant");
    if (it.kind === "assistant") {
      expect(it.text).toBe("你好！");
      expect(it.streaming).toBe(false);
    }
  });

  it("reasoning_delta and assistant_delta are separate items", () => {
    const { items } = reduceTimeline([
      ev({ type: "reasoning_delta", itemId: "m1:0", text: "想" }),
      ev({ type: "assistant_delta", itemId: "m1:1", text: "答" }),
    ], { runtimeStatus: "running" });
    expect(items.map((i) => i.kind)).toEqual(["reasoning", "assistant"]);
  });

  it("while running, a delta without a complete event stays streaming; in a non-running snapshot it is set to false", () => {
    const running = reduceTimeline([ev({ type: "assistant_delta", itemId: "a", text: "hi" })], { runtimeStatus: "running" });
    const a0 = running.items[0];
    if (a0.kind === "assistant") expect(a0.streaming).toBe(true);
    const idle = reduceTimeline([ev({ type: "assistant_delta", itemId: "a", text: "hi" })], { runtimeStatus: "idle" });
    const b0 = idle.items[0];
    if (b0.kind === "assistant") expect(b0.streaming).toBe(false);
  });
});

describe("reducer: tool groups", () => {
  it("consecutive tool_calls merge into one group; body text in between starts a new group", () => {
    const { items } = reduceTimeline([
      ev({ type: "tool_call", itemId: "c1", kind: "read", title: "读 a", status: "running" }),
      ev({ type: "tool_call", itemId: "c1", kind: "read", title: "读 a", status: "ok", durationMs: 10 }),
      ev({ type: "tool_call", itemId: "c2", kind: "bash", title: "ls", status: "ok" }),
      ev({ type: "assistant_message", itemId: "m1", text: "看完了" }),
      ev({ type: "tool_call", itemId: "c3", kind: "edit", title: "改 b", status: "ok" }),
    ], { runtimeStatus: "idle" });
    expect(items.map((i) => i.kind)).toEqual(["toolgroup", "assistant", "toolgroup"]);
    const g1 = items[0];
    if (g1.kind === "toolgroup") {
      expect(g1.steps).toHaveLength(2);
      expect(g1.steps[0].status).toBe("ok");
      expect(g1.steps[0].durationMs).toBe(10);
    }
  });

  it("tool_output_delta is appended to the matching step output", () => {
    const { items } = reduceTimeline([
      ev({ type: "tool_call", itemId: "c1", kind: "bash", title: "ls", status: "running" }),
      ev({ type: "tool_output_delta", itemId: "c1", text: "a\n" }),
      ev({ type: "tool_output_delta", itemId: "c1", text: "b\n" }),
      ev({ type: "tool_call", itemId: "c1", kind: "bash", title: "ls", status: "ok" }),
    ], { runtimeStatus: "running" });
    const g = items[0];
    if (g.kind === "toolgroup") expect(g.steps[0].output).toBe("a\nb\n");
  });

  it("leftover running steps in a non-running snapshot are marked failed", () => {
    const { items } = reduceTimeline([
      ev({ type: "tool_call", itemId: "c1", kind: "bash", title: "ls", status: "running" }),
    ], { runtimeStatus: "closed" });
    const g = items[0];
    if (g.kind === "toolgroup") expect(g.steps[0].status).toBe("failed");
  });
});

describe("reducer: permissions and questions", () => {
  const perm = () => ev({ type: "permission_request", requestId: "r1", title: "运行 ls", kind: "tool", options: [{ id: "allow", label: "允许", kind: "allow_once" }] });

  it("permission_resolved updates card status and selection", () => {
    const { items } = reduceTimeline([
      perm(),
      ev({ type: "permission_resolved", requestId: "r1", optionId: "allow" }),
    ], { runtimeStatus: "running" });
    const it = items[0];
    if (it.kind === "permission") {
      expect(it.status).toBe("resolved");
      expect(it.choice).toBe("allow");
    }
  });

  it("unresolved and not running in a history snapshot -> cancelled", () => {
    const { items } = reduceTimeline([perm()], { runtimeStatus: "idle" });
    const it = items[0];
    if (it.kind === "permission") expect(it.status).toBe("cancelled");
  });

  it("unresolved while running stays pending", () => {
    const { items } = reduceTimeline([perm()], { runtimeStatus: "running" });
    const it = items[0];
    if (it.kind === "permission") expect(it.status).toBe("pending");
  });

  it("question_answered records the answer", () => {
    const { items } = reduceTimeline([
      ev({ type: "question", requestId: "q1", questions: [{ question: "选哪个？" }] }),
      ev({ type: "question_answered", requestId: "q1", answers: { "选哪个？": "A" } }),
    ], { runtimeStatus: "idle" });
    const it = items[0];
    if (it.kind === "question") {
      expect(it.status).toBe("answered");
      expect(it.answers?.["选哪个？"]).toBe("A");
    }
  });
});

describe("reducer: seq dedup and misc", () => {
  it("a duplicate seq is accepted only once", () => {
    const st = newTimelineState();
    const e = ev({ type: "notice", level: "info", message: "hi" });
    applyEvent(st, e);
    applyEvent(st, e);
    expect(st.items).toHaveLength(1);
  });

  it("usage accumulates into turn_ended", () => {
    const { items } = reduceTimeline([
      ev({ type: "usage", turnId: "t1", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, costUsd: 0.01 }),
      ev({ type: "usage", turnId: "t1", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, costUsd: 0.01 }),
      ev({ type: "turn_ended", turnId: "t1", status: "completed", durationMs: 100 }),
    ], { runtimeStatus: "idle" });
    const it = items[0];
    if (it.kind === "turnend") {
      expect(it.usage?.inputTokens).toBe(20);
      expect(it.usage?.costUsd).toBeCloseTo(0.02);
    }
  });

  it("user_message / turnend / lastUserText", () => {
    const { items, lastUserText } = reduceTimeline([
      ev({ type: "user_message", text: "第一条", turnId: "t0" }),
      ev({ type: "assistant_message", itemId: "m", text: "回" }),
      ev({ type: "turn_ended", turnId: "t0", status: "failed", error: "挂了" }),
    ], { runtimeStatus: "error" });
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "turnend"]);
    expect(lastUserText).toBe("第一条");
  });
});
