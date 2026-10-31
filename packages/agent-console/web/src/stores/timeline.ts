// Current conversation timeline: threads.get snapshot + thread:<id> channel increments → DisplayItem[].
import { create } from "zustand";
import type { TimelineEvent } from "../timeline/types";
import { applyEvent, newTimelineState, reduceTimeline, type DisplayItem } from "../timeline/reducer";
import { ws } from "../main";
import type { SlashCommand } from "../composer/slashMenu";

export type QueueItem = { id: string; text: string; attachments?: { path: string; mime: string }[] };
export type PendingReq = { requestId: string; kind: "permission" | "question" };

type TlStore = {
  threadId: string | null;
  status: string;
  items: DisplayItem[];
  queue: QueueItem[];
  pending: PendingReq[];
  lastUserText: string | null;
  error: string | null;
  slashCommands: SlashCommand[];

  open(threadId: string): void;
  close(): void;
};

// Internal: incremental events go through the same reducer state (no full recompute)
let st = newTimelineState();
let stSeqMax = 0;
let runtimeStatus = "idle";
let unsub: (() => void) | null = null;

function syncRuntimeFlags() {
  const idle = runtimeStatus !== "running" && runtimeStatus !== "initializing";
  for (const it of st.items) {
    if (idle && it.kind === "permission" && it.status === "pending") it.status = "cancelled";
    if (idle && it.kind === "question" && it.status === "pending") it.status = "cancelled";
    if (idle && (it.kind === "assistant" || it.kind === "reasoning") && it.streaming) it.streaming = false;
    if (idle && it.kind === "toolgroup") for (const s of it.steps) if (s.status === "running") s.status = "failed";
  }
}

export const useTimeline = create<TlStore>((set, get) => {
  // Subscribe to thread:<id>: the server replays missed persisted events by afterSeq (subscribing before the snapshot would lose
  // the part replayed into the old st and discarded when the snapshot rebuilds, so the order must be: snapshot → subscribe).
  const subscribeChannel = (threadId: string) => {
    unsub?.();
    unsub = ws.subscribe(`thread:${threadId}`, (_ch, d) => {
      const data = d as {
        type?: string;
        event?: TimelineEvent;
        status?: string;
        queue?: QueueItem[];
        pending?: PendingReq[];
        commands?: SlashCommand[];
      };
      if (get().threadId !== threadId) return;
      if (data.type === "event" && data.event) {
        const ev = data.event;
        // Unpersisted deltas have seq=-1 and take no part in dedupe/maxSeq
        if (ev.seq != null && ev.seq > 0) {
          if (ev.seq <= stSeqMax) return; // Dedupe reconnects/replays
          stSeqMax = Math.max(stSeqMax, ev.seq);
        }
        if (ev.type === "user_message") set({ lastUserText: ev.text });
        applyEvent(st, ev);
        // pending is derived from timeline items (pending permission/question → composer waiting state)
        const pending = st.items
          .filter((i) => (i.kind === "permission" || i.kind === "question") && i.status === "pending")
          .map((i) => ({ requestId: (i as { requestId: string }).requestId, kind: i.kind as "permission" | "question" }));
        set({ items: st.items.slice(), pending });
        return;
      }
      if (data.type === "status" && data.status) {
        runtimeStatus = data.status;
        syncRuntimeFlags();
        set({ status: runtimeStatus, items: st.items.slice() });
        return;
      }
      if (data.type === "queue" && data.queue) {
        set({ queue: data.queue });
        return;
      }
      if (data.type === "pending" && data.pending) {
        set({ pending: data.pending });
        return;
      }
      if (data.type === "commands" && data.commands) {
        set({ slashCommands: data.commands });
        return;
      }
    // afterSeq always has a number (including 0 for reconnect catch-up / the maxSeq after a snapshot): the server replays missed events from it;
    // the client dedupes by seq>0, so a duplicate replay is harmless.
    }, () => stSeqMax);
  };

  return {
    threadId: null,
    status: "idle",
    items: [],
    queue: [],
    pending: [],
    lastUserText: null,
    error: null,
    slashCommands: [],

    open: (threadId) => {
      if (get().threadId === threadId) return;
      get().close();
      set({ threadId, status: "initializing", items: [], queue: [], pending: [], lastUserText: null, error: null, slashCommands: [] });
      st = newTimelineState();
      stSeqMax = 0;
      runtimeStatus = "initializing";

      void (async () => {
        try {
          const g = (await ws.call("threads.get", { id: threadId })) as {
            meta: { status: string }; events: TimelineEvent[];
            queue: QueueItem[]; pending: PendingReq[]; runtimeStatus: string;
          };
          if (get().threadId !== threadId) return;
          runtimeStatus = g.runtimeStatus ?? g.meta.status;
          const r = reduceTimeline(g.events, { runtimeStatus });
          // Rebuild the incremental state (feed the snapshot events into st, keeping the byItemId/toolLoc maps)
          st = newTimelineState();
          for (const ev of g.events) applyEvent(st, ev);
          stSeqMax = Math.max(0, ...g.events.map((e) => e.seq ?? 0));
          syncRuntimeFlags();
          set({
            items: st.items.slice(), status: runtimeStatus,
            queue: g.queue ?? [], pending: g.pending ?? [], lastUserText: r.lastUserText,
          });
          // Subscribe only once the snapshot is ready: the server replays events after afterSeq=stSeqMax, joining the snapshot seamlessly
          if (get().threadId === threadId) subscribeChannel(threadId);
        } catch (e) {
          if (get().threadId === threadId) set({ error: String((e as Error)?.message ?? e), status: "error" });
        }
      })();
    },

    close: () => {
      unsub?.();
      unsub = null;
      st = newTimelineState();
      stSeqMax = 0;
      set({ threadId: null, items: [], queue: [], pending: [], lastUserText: null, error: null, status: "idle", slashCommands: [] });
    },
  };
});
