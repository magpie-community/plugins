// Timeline reducer (§8.4): snapshot + incremental events -> display items.
// Rules: dedup by seq; deltas merge by itemId, complete events replace them and set streaming=false;
// consecutive tool_calls go into one ToolGroupItem (interrupted by text/plan/permission etc. -> new group);
// a permission shows "cancelled" when runtimeStatus is not running and it is unresolved.
import type { TimelineEvent } from "./types";

export type ToolStep = {
  itemId: string; kind: string; title: string;
  status: "running" | "ok" | "failed";
  input?: unknown; detail?: unknown; output?: string;
  exitCode?: number; durationMs?: number;
};

export type DisplayItem =
  | { kind: "user"; key: string; text: string; attachments?: { id: string; name: string; mime: string }[]; steered?: boolean; ts: number }
  | { kind: "assistant"; key: string; itemId: string; text: string; streaming: boolean }
  | { kind: "reasoning"; key: string; itemId: string; text: string; streaming: boolean }
  | { kind: "toolgroup"; key: string; steps: ToolStep[] }
  | { kind: "plan"; key: string; itemId: string; markdown: string }
  | { kind: "todo"; key: string; items: { text: string; status: string }[] }
  | { kind: "permission"; key: string; requestId: string; title: string; kindStr: string; detail?: unknown; options: { id: string; label: string; kind: string }[]; status: "pending" | "resolved" | "cancelled"; choice?: string }
  | { kind: "question"; key: string; requestId: string; questions: unknown[]; answers?: Record<string, string>; status: "pending" | "answered" | "cancelled" }
  | { kind: "notice"; key: string; level: string; message: string }
  | { kind: "gone"; key: string } // placeholder: duplicate delta items cleared by sweepSiblings; skipped when rendering
  | { kind: "turnend"; key: string; status: string; durationMs?: number; error?: string; filesChanged?: number; usage?: TurnUsage };

export type TurnUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number };

type State = {
  items: DisplayItem[];
  seenSeq: Set<number>;
  // itemId -> item index and accumulated text (for deltas)
  byItemId: Map<string, { idx: number; field: "assistant" | "reasoning" }>;
  // tool itemId -> group index + step index
  toolLoc: Map<string, { group: number; step: number }>;
  // index of the currently open tool group (only consecutive tool_calls merge)
  openGroup: number | null;
  // requestId -> permission/question item index
  reqLoc: Map<string, number>;
  // turnId -> accumulated usage for that turn (shown in turnend)
  turnUsage: Map<string, TurnUsage>;
  // turnId -> index of the last user message (for the error card's "Retry")
  lastUserIdx: Map<string, number>;
};

export function newTimelineState(): State {
  return {
    items: [],
    seenSeq: new Set(),
    byItemId: new Map(),
    toolLoc: new Map(),
    openGroup: null,
    reqLoc: new Map(),
    turnUsage: new Map(),
    lastUserIdx: new Map(),
  };
}

function breakGroup(st: State): void {
  st.openGroup = null;
}

function applyDelta(st: State, itemId: string, field: "assistant" | "reasoning", text: string): void {
  const loc = st.byItemId.get(itemId);
  if (loc) {
    const it = st.items[loc.idx] as { text: string; streaming: boolean };
    it.text += text;
    it.streaming = true;
    return;
  }
  breakGroup(st);
  const key = `${field}:${itemId}`;
  const item: DisplayItem =
    field === "assistant"
      ? { kind: "assistant", key, itemId, text, streaming: true }
      : { kind: "reasoning", key, itemId, text, streaming: true };
  st.byItemId.set(itemId, { idx: st.items.length, field });
  st.items.push(item);
}

// itemId looks like <msgId>:<kind><n> (the claude map builds it from type + per-type ordinal).
// The SDK occasionally reorders/merges streamed block indexes vs the final content array (e.g. two text blocks streamed,
// only one returned at the end); leftover uncovered delta items then show up as a duplicated reply.
// When a complete event arrives, also clear other items with the same msgId prefix and the same field.
function sweepSiblings(st: State, itemId: string, field: "assistant" | "reasoning"): void {
  const m = /^(.*):[ktx]\d+$/.exec(itemId);
  if (!m) return;
  const prefix = m[1] + ":";
  for (const [id, loc] of [...st.byItemId]) {
    if (loc.field === field && id.startsWith(prefix) && id !== itemId) {
      // placeholder tombstone: indexes must not move (byItemId/toolLoc/reqLoc/lastUserIdx all store idx); the render layer skips "gone"
      st.items[loc.idx] = { kind: "gone", key: `gone:${id}` } as DisplayItem;
      st.byItemId.delete(id);
    }
  }
}

function applyFull(st: State, itemId: string, field: "assistant" | "reasoning", text: string): void {
  sweepSiblings(st, itemId, field);
  const loc = st.byItemId.get(itemId);
  if (loc) {
    const it = st.items[loc.idx] as { text: string; streaming: boolean };
    it.text = text;
    it.streaming = false;
    return;
  }
  breakGroup(st);
  const key = `${field}:${itemId}`;
  const item: DisplayItem =
    field === "assistant"
      ? { kind: "assistant", key, itemId, text, streaming: false }
      : { kind: "reasoning", key, itemId, text, streaming: false };
  st.byItemId.set(itemId, { idx: st.items.length, field });
  st.items.push(item);
}

function applyTool(st: State, ev: Extract<TimelineEvent, { type: "tool_call" }>): void {
  const loc = st.toolLoc.get(ev.itemId);
  if (loc) {
    // an end event for the same itemId updates the original step (kind/title take the latest, detail/output are merged)
    const g = st.items[loc.group];
    if (g?.kind === "toolgroup") {
      const prev = g.steps[loc.step];
      g.steps[loc.step] = {
        ...prev,
        kind: ev.kind === "other" && prev.kind !== "other" ? prev.kind : ev.kind,
        title: ev.title || prev.title,
        status: ev.status,
        input: ev.input ?? prev.input,
        detail: ev.detail ?? prev.detail,
        output: ev.output ?? prev.output,
        exitCode: ev.exitCode ?? prev.exitCode,
        durationMs: ev.durationMs ?? prev.durationMs,
      };
    }
    return;
  }
  // a new step: append to the open group, or start a new one
  const step: ToolStep = {
    itemId: ev.itemId, kind: ev.kind, title: ev.title, status: ev.status,
    input: ev.input, detail: ev.detail, output: ev.output, exitCode: ev.exitCode, durationMs: ev.durationMs,
  };
  let groupIdx = st.openGroup;
  if (groupIdx == null || st.items[groupIdx]?.kind !== "toolgroup") {
    groupIdx = st.items.length;
    st.items.push({ kind: "toolgroup", key: `tg:${ev.itemId}`, steps: [] });
    st.openGroup = groupIdx;
  }
  const g = st.items[groupIdx] as { kind: "toolgroup"; steps: ToolStep[] };
  st.toolLoc.set(ev.itemId, { group: groupIdx, step: g.steps.length });
  g.steps.push(step);
}

export function applyEvent(st: State, ev: TimelineEvent): void {
  // persisted events (seq>0) are deduped; non-persisted ones like deltas (seq=-1) aren't tracked (otherwise they'd drop each other)
  if (ev.seq != null && ev.seq > 0) {
    if (st.seenSeq.has(ev.seq)) return;
    st.seenSeq.add(ev.seq);
  }
  switch (ev.type) {
    case "user_message":
      breakGroup(st);
      st.lastUserIdx.set(ev.turnId ?? "", st.items.length);
      st.items.push({ kind: "user", key: `u:${ev.seq}`, text: ev.text, attachments: ev.attachments, steered: ev.steered, ts: ev.ts });
      return;
    case "assistant_delta":
      applyDelta(st, ev.itemId, "assistant", ev.text);
      return;
    case "reasoning_delta":
      applyDelta(st, ev.itemId, "reasoning", ev.text);
      return;
    case "assistant_message":
      applyFull(st, ev.itemId, "assistant", ev.text);
      return;
    case "reasoning":
      applyFull(st, ev.itemId, "reasoning", ev.text);
      return;
    case "tool_output_delta": {
      const loc = st.toolLoc.get(ev.itemId);
      if (loc) {
        const g = st.items[loc.group];
        if (g?.kind === "toolgroup") {
          const s = g.steps[loc.step];
          s.output = (s.output ?? "") + ev.text;
        }
      }
      return;
    }
    case "tool_call":
      applyTool(st, ev);
      return;
    case "plan":
      breakGroup(st);
      st.items.push({ kind: "plan", key: `plan:${ev.itemId}`, itemId: ev.itemId, markdown: ev.markdown });
      return;
    case "todo":
      breakGroup(st);
      st.items.push({ kind: "todo", key: `todo:${ev.seq}`, items: ev.items });
      return;
    case "permission_request":
      breakGroup(st);
      st.reqLoc.set(ev.requestId, st.items.length);
      st.items.push({
        kind: "permission", key: `perm:${ev.requestId}`, requestId: ev.requestId,
        title: ev.title, kindStr: ev.kind, detail: ev.detail, options: ev.options, status: "pending",
      });
      return;
    case "permission_resolved": {
      const idx = st.reqLoc.get(ev.requestId);
      const it = idx != null ? st.items[idx] : null;
      if (it?.kind === "permission") {
        it.status = ev.cancelled ? "cancelled" : "resolved";
        it.choice = ev.optionId;
      }
      return;
    }
    case "question":
      breakGroup(st);
      st.reqLoc.set(ev.requestId, st.items.length);
      st.items.push({ kind: "question", key: `q:${ev.requestId}`, requestId: ev.requestId, questions: ev.questions, status: "pending" });
      return;
    case "question_answered": {
      const idx = st.reqLoc.get(ev.requestId);
      const it = idx != null ? st.items[idx] : null;
      if (it?.kind === "question") {
        it.status = "answered";
        it.answers = ev.answers;
      }
      return;
    }
    case "usage": {
      const t = ev.turnId ?? "";
      const cur = st.turnUsage.get(t) ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
      cur.inputTokens += ev.inputTokens;
      cur.outputTokens += ev.outputTokens;
      cur.cacheReadTokens += ev.cacheReadTokens;
      cur.costUsd += ev.costUsd;
      st.turnUsage.set(t, cur);
      return;
    }
    case "notice":
      breakGroup(st);
      st.items.push({ kind: "notice", key: `n:${ev.seq}`, level: ev.level, message: ev.message });
      return;
    case "turn_ended":
      breakGroup(st);
      st.items.push({
        kind: "turnend", key: `te:${ev.seq}`, status: ev.status,
        durationMs: ev.durationMs, error: ev.error, filesChanged: ev.filesChanged,
        usage: st.turnUsage.get(ev.turnId),
      });
      return;
    case "turn_started":
      // not shown as an item; the status pill uses status events / runtime
      return;
    case "status":
      return;
    default:
      return;
  }
}

// snapshot + live events -> display items. When runtimeStatus is not running, unresolved permissions/questions are marked cancelled.
export function reduceTimeline(
  events: TimelineEvent[],
  opts: { runtimeStatus?: string } = {},
): { items: DisplayItem[]; lastUserText: string | null } {
  const st = newTimelineState();
  for (const ev of events) applyEvent(st, ev);
  const idle = opts.runtimeStatus !== "running" && opts.runtimeStatus !== "initializing";
  let lastUserText: string | null = null;
  for (const it of st.items) {
    if (it.kind === "user") lastUserText = it.text;
    if (idle && it.kind === "permission" && it.status === "pending") it.status = "cancelled";
    if (idle && it.kind === "question" && it.status === "pending") it.status = "cancelled";
    // clear leftover "running" in the open tool group (after a daemon restart/crash)
    if (idle && it.kind === "toolgroup") {
      for (const s of it.steps) if (s.status === "running") s.status = "failed";
    }
    if (it.kind === "assistant" || it.kind === "reasoning") {
      if (idle && it.streaming) it.streaming = false;
    }
  }
  return { items: st.items, lastUserText };
}
