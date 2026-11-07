// Current conversation timeline: threads.get snapshot + thread:<id> channel increments → DisplayItem[].
import { create } from "zustand";
import type { TimelineEvent } from "../timeline/types";
import { applyEvent, newTimelineState, pendingRequests, reduceTimeline, type DisplayItem } from "../timeline/reducer";
import { ws } from "../main";
import type { SlashCommand } from "../composer/slashMenu";
import { Outbox, newClientId, withOutbox, type SendDisplay, type SendPayload } from "../timeline/outbox";

export type QueueItem = { id: string; text: string; attachments?: { path: string; mime: string }[] };
export type PendingReq = { requestId: string; kind: "permission" | "question"; key?: string };

/** Shared empty list: "nothing waiting" is always the same reference, so selectors on `pending` don't fire */
export const EMPTY_PENDING: PendingReq[] = [];

/** Same waiting requests (same order, ids, kinds and keys) */
export function samePending(a: readonly PendingReq[], b: readonly PendingReq[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!;
    if (x.requestId !== y.requestId || x.kind !== y.kind || x.key !== y.key) return false;
  }
  return true;
}

/** Keep the previous reference when nothing changed: a token delta must not hand App a new `pending` array
 *  (that re-rendered the whole three-column shell on every delta) */
export function stablePending(prev: PendingReq[], next: PendingReq[]): PendingReq[] {
  if (next.length === 0) return EMPTY_PENDING;
  return samePending(prev, next) ? prev : next;
}

type TlStore = {
  threadId: string | null;
  status: string;
  items: DisplayItem[];
  queue: QueueItem[];
  pending: PendingReq[];
  lastUserText: string | null;
  error: string | null;
  slashCommands: SlashCommand[];

  /** 1.3: bumped on every optimistic send (the chat jumps to the bottom) */
  sentAt: number;

  open(threadId: string): void;
  close(): void;
  /** 1.3 optimistic send: the bubble shows now, the echo replaces it, a failure marks it (see timeline/outbox.ts).
   *  optimistic=false (queued behind a running turn): nothing is drawn, the queue list shows it. Throws on failure. */
  send(threadId: string, payload: SendPayload, display?: SendDisplay, opts?: { optimistic?: boolean }): Promise<{ delivered?: "started" | "steered" | "queued" } | undefined>;
  /** Send a failed bubble again (same text, attachments and chips) */
  retry(clientId: string): void;
  /** Drop a failed bubble */
  dismiss(clientId: string): void;
};

/** Sends waiting for their echo, per thread (kept across thread switches so a failed bubble isn't lost) */
const outbox = new Outbox();
/** clientIds sent from this page: their bubbles fade in once (history and other tabs' messages don't) */
export const localClientIds = new Set<string>();
const busyStatus = (s: string) => s === "running" || s === "initializing";

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
  /** Timeline items + optimistic bubbles, and the status the composer sees ("initializing" right after a send) */
  const view = (threadId: string) => ({
    items: withOutbox(st.items.slice(), outbox.items(threadId)),
    status: !busyStatus(runtimeStatus) && outbox.starting(threadId) ? "initializing" : runtimeStatus,
  });
  const refresh = (threadId: string) => {
    if (get().threadId === threadId) set(view(threadId));
  };

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
        if (ev.type === "user_message") {
          set({ lastUserText: ev.text });
          outbox.echo(ev.clientId);
        }
        applyEvent(st, ev);
        // pending is derived from timeline items (pending permission/question → composer waiting state)
        set({ ...view(threadId), pending: stablePending(get().pending, pendingRequests(st.items)) });
        return;
      }
      if (data.type === "status" && data.status) {
        runtimeStatus = data.status;
        if (busyStatus(runtimeStatus) || runtimeStatus === "error" || runtimeStatus === "closed") outbox.busy(threadId);
        syncRuntimeFlags();
        // Going idle closes the open cards (syncRuntimeFlags): the waiting state follows them, or the top bar would
        // keep 等待授权 with no card to click
        set({ ...view(threadId), pending: stablePending(get().pending, pendingRequests(st.items)) });
        return;
      }
      if (data.type === "queue" && data.queue) {
        set({ queue: data.queue });
        return;
      }
      if (data.type === "pending" && data.pending) {
        // Only requests the timeline shows a live card for
        const next = pendingRequests(st.items).filter((p) => data.pending!.some((d) => d.requestId === p.requestId));
        set({ pending: stablePending(get().pending, next) });
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
    pending: EMPTY_PENDING,
    lastUserText: null,
    error: null,
    slashCommands: [],
    sentAt: 0,

    open: (threadId) => {
      if (get().threadId === threadId) return;
      get().close();
      set({ threadId, status: "initializing", items: outbox.items(threadId), queue: [], pending: EMPTY_PENDING, lastUserText: null, error: null, slashCommands: [] });
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
          outbox.reconcile(threadId, g.events.flatMap((e) => (e.type === "user_message" && e.clientId ? [e.clientId] : [])));
          syncRuntimeFlags();
          set({
            ...view(threadId),
            // Not g.pending: the daemon's list could hold a request the timeline already closed (a 1.2 daemon kept
            // one whose turn had ended). Waiting follows the cards that show buttons.
            queue: g.queue ?? [], pending: stablePending(get().pending, pendingRequests(st.items)), lastUserText: r.lastUserText,
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
      set({ threadId: null, items: [], queue: [], pending: EMPTY_PENDING, lastUserText: null, error: null, status: "idle", slashCommands: [] });
    },

    send: async (threadId, payload, display = {}, opts = {}) => {
      const clientId = newClientId();
      const optimistic = opts.optimistic !== false;
      if (optimistic) {
        const cur = get().threadId === threadId ? get().status : "idle";
        outbox.add({ clientId, threadId, payload, display, startsTurn: !busyStatus(cur) && payload.behavior !== "steer" });
        localClientIds.add(clientId);
        if (get().threadId === threadId) set({ ...view(threadId), sentAt: Date.now() });
      }
      try {
        const r = (await ws.call("thread.send", {
          id: threadId, text: payload.text,
          ...(payload.attachments?.length ? { attachments: payload.attachments } : {}),
          ...(payload.mentions?.length ? { mentions: payload.mentions } : {}),
          ...(payload.behavior ? { behavior: payload.behavior } : {}),
          clientId,
        })) as { delivered?: "started" | "steered" | "queued" } | undefined;
        outbox.ok(clientId, r?.delivered);
        refresh(threadId);
        return r;
      } catch (e) {
        outbox.fail(clientId, String((e as Error)?.message ?? e));
        refresh(threadId);
        throw e;
      }
    },

    retry: (clientId) => {
      const e = outbox.get(clientId);
      if (!e || e.state !== "failed") return;
      outbox.remove(clientId);
      void get().send(e.threadId, e.payload, e.display).catch(() => {});
    },

    dismiss: (clientId) => {
      const e = outbox.get(clientId);
      if (!e || e.state !== "failed") return;
      outbox.remove(clientId);
      refresh(e.threadId);
    },
  };
});
