// P1-8 debug page (?debug=1): project picker, conversation list, composer, raw timeline, permission buttons.
// For integration only; the real UI is rewritten in P2.
import { useEffect, useRef, useState } from "react";
import { useConnection } from "./stores/connection";
import { ws } from "./main";

type Project = { id: string; name: string; path: string };
type ThreadMeta = {
  id: string; projectId: string; title: string; provider: string;
  status: string; archived: boolean;
};
type Ev = Record<string, unknown> & { seq?: number; type?: string };
type Pending = { requestId: string; kind: string; options?: { id: string; label: string }[] };

const call = (m: string, p?: unknown) => ws.call(m, p);

export function DebugApp() {
  const { state, version } = useConnection();
  const [projects, setProjects] = useState<Project[]>([]);
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [projectId, setProjectId] = useState<string>("");
  const [threadId, setThreadId] = useState<string>("");
  const [events, setEvents] = useState<Ev[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [queue, setQueue] = useState<unknown[]>([]);
  const [input, setInput] = useState("");
  const [err, setErr] = useState("");
  const subRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (state !== "open") return;
    void call("projects.list").then((r) => setProjects((r as Project[]) ?? []));
    void call("threads.list").then((r) => setThreads((r as ThreadMeta[]) ?? []));
  }, [state]);

  useEffect(() => {
    subRef.current?.();
    subRef.current = null;
    setEvents([]);
    setPending([]);
    setQueue([]);
    if (!threadId || state !== "open") return;
    void call("threads.get", { id: threadId }).then((r) => {
      const res = r as { events?: Ev[]; pending?: Pending[]; queue?: unknown[] };
      setEvents(res.events ?? []);
      setPending(res.pending ?? []);
      setQueue(res.queue ?? []);
    });
    subRef.current = ws.subscribe(`thread:${threadId}`, (_ch, data) => {
      const d = data as { type?: string; event?: Ev; queue?: unknown[] };
      if (d.type === "event" && d.event) {
        setEvents((evs) => [...evs, d.event!]);
        if (d.event.type === "permission_resolved" || d.event.type === "question_answered") {
          const rid = (d.event as { requestId?: string }).requestId;
          setPending((ps) => ps.filter((p) => p.requestId !== rid));
        }
      }
      if (d.type === "queue" && d.queue) setQueue(d.queue);
    });
    return () => subRef.current?.();
  }, [threadId, state]);

  // Pending changes are also filled in from timeline events (when a permission_request event arrives)
  useEffect(() => {
    const reqs = events.filter((e) => e.type === "permission_request" || e.type === "question");
    const resolved = new Set(
      events
        .filter((e) => e.type === "permission_resolved" || e.type === "question_answered")
        .map((e) => (e as { requestId?: string }).requestId),
    );
    const next = reqs
      .filter((e) => !resolved.has((e as { requestId?: string }).requestId))
      .map((e) => ({
        requestId: (e as { requestId?: string }).requestId ?? "",
        kind: e.type === "question" ? "question" : "permission",
        options: (e as { options?: { id: string; label: string }[] }).options,
      }));
    setPending((cur) => {
      const merged = new Map(cur.map((p) => [p.requestId, p]));
      for (const p of next) merged.set(p.requestId, p);
      return [...merged.values()];
    });
  }, [events]);

  const refresh = async () => {
    if (!threadId) return;
    const r = (await call("threads.get", { id: threadId }).catch(() => null)) as {
      events?: Ev[]; pending?: Pending[]; queue?: unknown[];
    } | null;
    if (r) {
      setEvents(r.events ?? []);
      setPending((cur) => {
        const merged = new Map(cur.map((p) => [p.requestId, p]));
        for (const p of r.pending ?? []) merged.set(p.requestId, p);
        return [...merged.values()];
      });
      setQueue(r.queue ?? []);
    }
  };

  const send = async (behavior?: "queue" | "steer") => {
    setErr("");
    if (!threadId || !input.trim()) return;
    const text = input;
    setInput("");
    try {
      await call("thread.send", { id: threadId, text, behavior });
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    }
    // sub.add may not have completed yet → fetch the current events once to catch up
    await refresh();
  };

  const respond = async (requestId: string, optionId?: string, answers?: Record<string, string>) => {
    await call("thread.respond", { id: threadId, requestId, optionId, answers }).catch((e) => setErr(String((e as Error)?.message ?? e)));
    setTimeout(() => void refresh(), 1500); // Let the approved tool_call ok land in the list
  };

  const createThread = async () => {
    if (!projectId) return;
    const meta = (await call("threads.create", { projectId, provider: "mock" }).catch((e) => { setErr(String((e as Error)?.message ?? e)); return null; })) as ThreadMeta | null;
    if (meta) {
      setThreads((ts) => [meta, ...ts]);
      setThreadId(meta.id);
    }
  };

  return (
    <div style={{ display: "flex", height: "100vh", font: "13px/1.5 system-ui", color: "var(--fg)" }}>
      <div style={{ width: 260, borderRight: "1px solid var(--border)", padding: 12, overflowY: "auto" }}>
        <div style={{ marginBottom: 8 }}>{state === "open" ? `已连接 · ${version ?? ""}` : "连接中…"}</div>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ width: "100%" }}>
          <option value="">选择项目</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button onClick={() => void createThread()} disabled={!projectId} style={{ width: "100%", marginTop: 8 }}>新建对话（mock）</button>
        <div style={{ marginTop: 12 }}>
          {threads.filter((t) => !projectId || t.projectId === projectId).map((t) => (
            <div
              key={t.id}
              onClick={() => setThreadId(t.id)}
              style={{
                padding: "6px 8px", cursor: "pointer", borderRadius: 4,
                background: t.id === threadId ? "var(--bg-active, #333)" : "transparent",
              }}
            >
              {t.title} <span style={{ opacity: 0.6 }}>({t.status})</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
          {events.map((e, i) => (
            <pre key={i} style={{ margin: "4px 0", fontSize: 11, whiteSpace: "pre-wrap", borderBottom: "1px solid var(--border)", paddingBottom: 4 }}>
              {(e.seq ?? "") + " " + (e.type ?? "?") + " " + JSON.stringify(e).slice(0, 400)}
            </pre>
          ))}
          {pending.map((p) => (
            <div key={p.requestId} style={{ border: "1px solid var(--warn, orange)", borderRadius: 6, padding: 8, margin: "8px 0" }}>
              <div>授权/提问 {p.requestId}</div>
              {p.options?.map((o) => (
                <button key={o.id} onClick={() => void respond(p.requestId, o.id)} style={{ marginRight: 8 }}>
                  {o.label}
                </button>
              ))}
              {p.kind === "question" && (
                <button onClick={() => void respond(p.requestId, undefined, { q1: "staging", q2: "" })}>填表提交</button>
              )}
              <button onClick={() => void respond(p.requestId, undefined, undefined)}>取消</button>
            </div>
          ))}
        </div>
        {queue.length > 0 && <div style={{ padding: "4px 12px", opacity: 0.7 }}>排队中：{queue.length} 条</div>}
        {err && <div style={{ padding: "4px 12px", color: "var(--danger, red)" }}>{err}</div>}
        <div style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid var(--border)" }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void send(); }}
            placeholder="/perm /plan /slow /exit …"
            style={{ flex: 1 }}
          />
          <button onClick={() => void send()}>发送</button>
          <button onClick={() => void send("steer")}>插话</button>
          <button onClick={() => void call("thread.interrupt", { id: threadId })}>打断</button>
        </div>
      </div>
    </div>
  );
}
