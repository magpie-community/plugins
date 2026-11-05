// Timeline reducer (§8.4): snapshot + incremental events -> display items.
// Rules: dedup by seq; deltas merge by itemId, complete events replace them and set streaming=false;
// consecutive tool_calls go into one ToolGroupItem (interrupted by text/plan/permission etc. -> new group);
// a permission shows "cancelled" when runtimeStatus is not running and it is unresolved.
import type { TimelineEvent } from "./types.js";
import { userKey } from "./outbox.js";

export type ToolStep = {
  itemId: string; kind: string; title: string;
  status: "running" | "ok" | "failed";
  input?: unknown; detail?: unknown; output?: string;
  exitCode?: number; durationMs?: number;
  /** 1.3: a short "thinking" folded into the tool summary (display only, see fold.ts) */
  think?: { text: string; streaming: boolean };
};

export type DisplayItem =
  | { kind: "user"; key: string; text: string; attachments?: { id: string; name: string; mime: string }[]; mentions?: { path: string; isDir: boolean }[]; steered?: boolean; ts: number;
      /** 1.3: the page's id for the send (optimistic bubble ↔ echoed user_message) */
      clientId?: string;
      /** 1.3: only on optimistic bubbles: still on its way, or the send failed */
      sendState?: "sending" | "failed"; sendError?: string }
  | { kind: "assistant"; key: string; itemId: string; text: string; streaming: boolean }
  | { kind: "reasoning"; key: string; itemId: string; text: string; streaming: boolean }
  | { kind: "toolgroup"; key: string; steps: ToolStep[] }
  | { kind: "plan"; key: string; itemId: string; markdown: string }
  | { kind: "todo"; key: string; items: { text: string; status: string }[] }
  | { kind: "permission"; key: string; requestId: string; title: string; kindStr: string; detail?: unknown; options: { id: string; label: string; kind: string }[]; status: "pending" | "resolved" | "cancelled"; choice?: string; auto?: boolean }
  | { kind: "question"; key: string; requestId: string; questions: unknown[]; answers?: Record<string, string>; status: "pending" | "answered" | "cancelled" }
  | { kind: "notice"; key: string; level: string; message: string; code?: string }
  /** 1.3 全部自动同意: the approvals the daemon gave in one run of tool calls, as one quiet foldable row (autoApproved.ts) */
  | { kind: "autoperm"; key: string; items: Extract<DisplayItem, { kind: "permission" }>[] }
  | { kind: "gone"; key: string } // placeholder: duplicate delta items cleared by sweepSiblings; skipped when rendering
  | { kind: "turnend"; key: string; status: string; durationMs?: number; error?: string; filesChanged?: number; usage?: TurnUsage;
      /** 1.3: the model the turn ran on (turn_started; null = the Agent's default) and when it ended, for the reply footer */
      model?: string | null; ts?: number };

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
  // turnId -> turn_started ts (fallback duration for agents that don't report one, e.g. ACP)
  turnStart: Map<string, number>;
  // turnId -> the model turn_started reported (1.3 reply footer)
  turnModel: Map<string, string | null>;
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
    turnStart: new Map(),
    turnModel: new Map(),
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
      st.items.push({ kind: "user", key: userKey(ev.seq, ev.clientId), text: ev.text, attachments: ev.attachments, ...(ev.mentions?.length ? { mentions: ev.mentions } : {}), steered: ev.steered, ts: ev.ts, ...(ev.clientId ? { clientId: ev.clientId } : {}) });
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
      // 1.3: an ACP plan is the Agent's step list (entries with pending / in_progress / completed): a checklist like
      // Claude's TodoWrite and Codex's turn/plan/updated. A plan without entries (Claude / Codex plan text) stays a card.
      if (ev.entries?.length) {
        st.items.push({ kind: "todo", key: `todo:${ev.seq}`, items: ev.entries.map((e) => ({ text: e.step, status: e.status === "completed" ? "done" : e.status || "pending" })) });
        return;
      }
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
        // 1.3 全部自动同意: the daemon answered it itself (never a card with buttons; see timeline/autoApproved.ts)
        ...(ev.auto ? { auto: true } : {}),
      });
      return;
    case "permission_resolved": {
      const idx = st.reqLoc.get(ev.requestId);
      const it = idx != null ? st.items[idx] : null;
      if (it?.kind === "permission") {
        it.status = ev.cancelled ? "cancelled" : "resolved";
        it.choice = ev.optionId;
        if (ev.auto) it.auto = true;
      } else if (it?.kind === "question" && ev.cancelled && it.status === "pending") {
        it.status = "cancelled"; // the daemon cancels open questions with permission_resolved{cancelled} too
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
      st.items.push({ kind: "notice", key: `n:${ev.seq}`, level: ev.level, message: ev.message, ...(ev.code ? { code: ev.code } : {}) });
      return;
    case "turn_ended":
      breakGroup(st);
      // A request still open when its turn ends can't be answered any more: the Agent moved on. Daemons before the fix
      // left such a request open in the timeline (Cursor 1.2.0: "[canceled] http/2 stream closed" right after asking),
      // and the page kept "等待授权" for a card showing 已取消. Close it here so replayed history never waits on it.
      closeOpenRequests(st);
      st.items.push({
        kind: "turnend", key: `te:${ev.seq}`, status: ev.status,
        durationMs: ev.durationMs ?? (st.turnStart.has(ev.turnId) ? Math.max(0, ev.ts - st.turnStart.get(ev.turnId)!) : undefined),
        error: ev.error, filesChanged: ev.filesChanged,
        usage: st.turnUsage.get(ev.turnId),
        ...(st.turnModel.has(ev.turnId) ? { model: st.turnModel.get(ev.turnId) } : {}),
        ts: ev.ts,
      });
      return;
    case "turn_started":
      // not shown as an item; the status pill uses status events / runtime
      st.turnStart.set(ev.turnId, ev.ts);
      st.turnModel.set(ev.turnId, ev.model ?? null);
      return;
    case "status":
      return;
    default:
      return;
  }
}

/** Requests still waiting for the user are always ones whose turn is still running (see turn_ended) */
function closeOpenRequests(st: State): void {
  for (const idx of st.reqLoc.values()) {
    const it = st.items[idx];
    if ((it?.kind === "permission" || it?.kind === "question") && it.status === "pending") it.status = "cancelled";
  }
}

export type PendingRequest = { requestId: string; kind: "permission" | "question"; key: string };

/** The requests the page waits on (top bar 等待授权, composer locked): exactly the cards that show buttons, so the
 *  page never waits on a request it has no card for (the daemon's own list may hold one the timeline already closed) */
export function pendingRequests(items: DisplayItem[]): PendingRequest[] {
  const out: PendingRequest[] = [];
  for (const it of items) {
    if ((it.kind === "permission" || it.kind === "question") && it.status === "pending") {
      out.push({ requestId: it.requestId, kind: it.kind, key: it.key });
    }
  }
  return out;
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
