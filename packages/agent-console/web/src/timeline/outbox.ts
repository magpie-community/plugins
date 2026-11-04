// 1.3 optimistic send: the user's bubble shows the moment 发送 is clicked, before the daemon echoes the
// user_message (which used to wait for the Agent to start: seconds on Windows). Each send gets a clientId that the
// daemon puts on its user_message; the echo replaces the optimistic bubble under the same React key (no duplicate,
// no jump). A send that fails before any echo keeps its bubble, marked failed, with 重试. Pure, unit tested.
import type { DisplayItem } from "./reducer.js";

export type SendPayload = {
  text: string;
  attachments?: { path: string; mime: string; name?: string }[];
  mentions?: { rel: string; isDir: boolean }[];
  behavior?: "queue" | "steer";
};
export type SendDisplay = {
  attachments?: { id: string; name: string; mime: string }[];
  mentions?: { path: string; isDir: boolean }[];
};
export type OutboxEntry = {
  clientId: string;
  threadId: string;
  payload: SendPayload;
  display: SendDisplay;
  ts: number;
  state: "sending" | "failed";
  error?: string;
  /** the daemon's user_message with this clientId arrived: the real bubble is in the timeline */
  echoed: boolean;
  /** thread.send answered (ok or error) */
  settled: boolean;
  /** this send starts a turn (the conversation was idle): the composer shows "working" straight away */
  startsTurn: boolean;
  /** a running/initializing status arrived after this send: the real status takes over */
  busySeen: boolean;
};

let counter = 0;
export function newClientId(now = Date.now()): string {
  counter = (counter + 1) % 1_000_000;
  return `c${now.toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Display key of a user bubble: the clientId when there is one, so optimistic and echoed share it */
export function userKey(seq: number, clientId?: string): string {
  return clientId ? `u:c:${clientId}` : `u:${seq}`;
}

export class Outbox {
  private list: OutboxEntry[] = [];

  add(e: Omit<OutboxEntry, "state" | "echoed" | "settled" | "busySeen" | "ts"> & { ts?: number }): OutboxEntry {
    const entry: OutboxEntry = { ts: Date.now(), ...e, state: "sending", echoed: false, settled: false, busySeen: false };
    this.list.push(entry);
    return entry;
  }
  get(clientId: string): OutboxEntry | undefined {
    return this.list.find((e) => e.clientId === clientId);
  }
  entries(threadId: string): OutboxEntry[] {
    return this.list.filter((e) => e.threadId === threadId);
  }
  remove(clientId: string): void {
    this.list = this.list.filter((e) => e.clientId !== clientId);
  }
  private gc(e: OutboxEntry): void {
    if (e.echoed && e.settled) this.remove(e.clientId);
  }
  /** The daemon echoed it (live event or snapshot). Returns whether it was ours. */
  echo(clientId: string | undefined): boolean {
    if (!clientId) return false;
    const e = this.get(clientId);
    if (!e) return false;
    e.echoed = true;
    // an echo after a failure (a slow daemon answered after a timeout): the message did go, so it isn't failed
    e.state = "sending";
    e.error = undefined;
    this.gc(e);
    return true;
  }
  /** thread.send answered ok. "queued" means it sits in the composer's queue list, not in the timeline yet. */
  ok(clientId: string, delivered?: string): void {
    const e = this.get(clientId);
    if (!e) return;
    if (delivered === "queued" && !e.echoed) { this.remove(clientId); return; }
    e.settled = true;
    this.gc(e);
  }
  /** thread.send failed. Echoed already → the daemon wrote its own error card; otherwise the bubble turns failed. */
  fail(clientId: string, error: string): boolean {
    const e = this.get(clientId);
    if (!e) return false;
    e.settled = true;
    if (e.echoed) { this.gc(e); return false; }
    e.state = "failed";
    e.error = error;
    return true;
  }
  /** A running/initializing status for the thread */
  busy(threadId: string): void {
    for (const e of this.list) if (e.threadId === threadId) e.busySeen = true;
  }
  /** Snapshot reconcile: drop the entries whose user_message is already in the events */
  reconcile(threadId: string, echoedIds: Iterable<string>): void {
    for (const id of echoedIds) {
      const e = this.get(id);
      if (e && e.threadId === threadId) this.echo(id);
    }
  }
  /** Bubbles still waiting for their echo (or failed), as timeline items */
  items(threadId: string): DisplayItem[] {
    return this.entries(threadId)
      .filter((e) => !e.echoed)
      .map((e) => ({
        kind: "user" as const,
        key: userKey(0, e.clientId),
        text: e.payload.text,
        ...(e.display.attachments?.length ? { attachments: e.display.attachments } : {}),
        ...(e.display.mentions?.length ? { mentions: e.display.mentions } : {}),
        ...(e.payload.behavior === "steer" ? { steered: true } : {}),
        ts: e.ts,
        clientId: e.clientId,
        sendState: e.state,
        ...(e.error ? { sendError: e.error } : {}),
      }));
  }
  /** A turn-starting send is on its way and no busy status has come yet */
  starting(threadId: string): boolean {
    return this.entries(threadId).some((e) => e.startsTurn && e.state === "sending" && !e.settled && !e.busySeen);
  }
}

/** The timeline with the optimistic bubbles at the end */
export function withOutbox(items: DisplayItem[], pending: DisplayItem[]): DisplayItem[] {
  return pending.length ? [...items, ...pending] : items;
}
