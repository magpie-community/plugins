import { describe, it, expect } from "vitest";
import { Outbox, newClientId, userKey, withOutbox } from "./outbox";
import { applyEvent, newTimelineState } from "./reducer";
import type { TimelineEvent } from "./types";

const um = (seq: number, text: string, clientId?: string): TimelineEvent =>
  ({ seq, ts: 1000 + seq, threadId: "t1", type: "user_message", text, ...(clientId ? { clientId } : {}) }) as TimelineEvent;

describe("optimistic send outbox (1.3)", () => {
  it("shows the bubble at once, and the echo replaces it under the same key (no duplicate, no jump)", () => {
    const ob = new Outbox();
    const st = newTimelineState();
    const id = newClientId();
    ob.add({ clientId: id, threadId: "t1", payload: { text: "> 引用\n\n你好" }, display: {}, startsTurn: true });
    let view = withOutbox(st.items, ob.items("t1"));
    expect(view).toHaveLength(1);
    expect(view[0]).toMatchObject({ kind: "user", key: userKey(0, id), sendState: "sending", text: "> 引用\n\n你好" });
    expect(ob.starting("t1")).toBe(true);
    // echo arrives (before thread.send answers: the daemon pushes it before the Agent starts)
    expect(ob.echo(id)).toBe(true);
    applyEvent(st, um(5, "> 引用\n\n你好", id));
    view = withOutbox(st.items, ob.items("t1"));
    expect(view).toHaveLength(1);
    expect(view[0].key).toBe(userKey(5, id));
    expect((view[0] as { sendState?: string }).sendState).toBeUndefined();
    // a late failure (e.g. timeout while the Agent was starting) doesn't turn the real message into a failed one
    expect(ob.fail(id, "timeout")).toBe(false);
    expect(ob.items("t1")).toHaveLength(0);
    expect(ob.get(id)).toBeUndefined();
  });

  it("messages without a clientId (history, other tabs) keep the seq key", () => {
    const st = newTimelineState();
    applyEvent(st, um(3, "旧消息"));
    expect(st.items[0].key).toBe("u:3");
  });

  it("a failed send keeps its bubble, marked failed; status falls back", () => {
    const ob = new Outbox();
    ob.add({ clientId: "c1", threadId: "t1", payload: { text: "hi", mentions: [{ rel: "a.txt", isDir: false }] }, display: { mentions: [{ path: "/p/a.txt", isDir: false }] }, startsTurn: true });
    expect(ob.fail("c1", "连接已断开")).toBe(true);
    const [b] = ob.items("t1");
    expect(b).toMatchObject({ sendState: "failed", sendError: "连接已断开", mentions: [{ path: "/p/a.txt", isDir: false }] });
    expect(ob.starting("t1")).toBe(false);
    // retry has everything it needs
    expect(ob.get("c1")!.payload.mentions).toEqual([{ rel: "a.txt", isDir: false }]);
    ob.remove("c1");
    expect(ob.items("t1")).toHaveLength(0);
  });

  it("delivered=queued drops the bubble (the queue list shows it); a busy status ends the optimistic working state", () => {
    const ob = new Outbox();
    ob.add({ clientId: "c2", threadId: "t1", payload: { text: "x" }, display: {}, startsTurn: true });
    ob.ok("c2", "queued");
    expect(ob.items("t1")).toHaveLength(0);
    ob.add({ clientId: "c3", threadId: "t1", payload: { text: "y" }, display: {}, startsTurn: true });
    ob.busy("t1");
    expect(ob.starting("t1")).toBe(false);
    expect(ob.items("t1")).toHaveLength(1);
  });

  it("snapshot reconcile (reopened conversation) and per-thread isolation", () => {
    const ob = new Outbox();
    ob.add({ clientId: "c4", threadId: "t1", payload: { text: "a" }, display: {}, startsTurn: true });
    ob.add({ clientId: "c5", threadId: "t2", payload: { text: "b" }, display: {}, startsTurn: true });
    ob.reconcile("t1", ["c4", "c5"]);
    expect(ob.items("t1")).toHaveLength(0);
    expect(ob.items("t2")).toHaveLength(1);
    ob.ok("c4");
    expect(ob.get("c4")).toBeUndefined();
  });

  it("steer bubbles are tagged; client ids are unique and accepted by the daemon's schema", () => {
    const ob = new Outbox();
    ob.add({ clientId: "c6", threadId: "t1", payload: { text: "插话", behavior: "steer" }, display: {}, startsTurn: false });
    expect(ob.items("t1")[0]).toMatchObject({ steered: true });
    expect(ob.starting("t1")).toBe(false);
    const ids = new Set(Array.from({ length: 500 }, () => newClientId()));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});
