// Conversation area (§8.6): virtual list, stick-to-bottom, empty state, queue list, Composer.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isImeComposing } from "../composer/ime";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useUi } from "../stores/ui";
import { useData, pickDefaultProvider } from "../stores/data";
import { useTimeline } from "../stores/timeline";
import { TimelineRow } from "./Timeline";
import { foldTimeline } from "../timeline/fold";
import { Composer } from "./Composer";
import { QuoteSelect } from "./QuoteSelect";
import { Icon } from "./Icons";
import { ws } from "../main";
import { toast } from "./Toast";
import { relFromAbs } from "../composer/mentions";
import { useLiveSettings } from "./Settings";
import { errMsg, localizeDaemonMessage, t as tr, tf } from "../i18n/index.js";

export function Chat() {
  const ui = useUi();
  const { projects, threads } = useData();
  const tl = useTimeline();
  const prefs = useLiveSettings();
  // 1.3: runs of tool calls (and short thinking between them) fold into one summary row
  // (tl.items is a fresh array after every timeline change, so the memo follows the stream)
  const items = useMemo(() => foldTimeline(tl.items, { showThinking: prefs.showThinking }), [tl.items, prefs.showThinking]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const [hasNew, setHasNew] = useState(false);

  const project = projects.find((p) => p.id === ui.currentProjectId) ?? null;
  const threadId = ui.currentThreadId;
  const thread = threadId ? threads.find((th) => th.id === threadId) ?? null : null;
  const activeThreadId =
    project && thread && thread.projectId === project.id ? thread.id : null;

  useEffect(() => {
    if (activeThreadId) tl.open(activeThreadId);
    else tl.close();
    setStick(true);
    setHasNew(false);
  }, [activeThreadId]); // eslint-disable-line react-hooks/exhaustive-deps

  const est = useCallback((i: number) => {
    const it = items[i];
    if (!it) return 80;
    switch (it.kind) {
      case "user": return 60;
      case "assistant": case "reasoning": return 120;
      case "toolgroup": return 34; // collapsed by default
      case "plan": return 200;
      case "permission": case "question": return 120;
      case "todo": return 30;
      case "turnend": case "notice": return 30;
      default: return 60;
    }
  }, [items]);

  const virt = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: est,
    getItemKey: (i) => items[i]?.key ?? i,
    overscan: 8,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  const count = items.length;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stick) el.scrollTop = el.scrollHeight;
    else setHasNew(true);
  }, [count, stick]);

  // 1.3: a send always lands at the bottom, at once (and again after the new row is measured)
  useEffect(() => {
    if (!tl.sentAt) return;
    setStick(true);
    setHasNew(false);
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    const raf = requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    return () => cancelAnimationFrame(raf);
  }, [tl.sentAt]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setStick(nearBottom);
    if (nearBottom) setHasNew(false);
  };

  const jump = () => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    setStick(true);
    setHasNew(false);
  };

  const resend = (text: string, mentions?: { path: string; isDir: boolean }[]) => {
    if (!activeThreadId) return;
    // chips go along again (as project-relative paths; the daemon re-checks them)
    const root = project?.path;
    const rels = root && mentions?.length
      ? mentions.map((m) => ({ rel: relFromAbs(root, m.path), isDir: m.isDir })).filter((m): m is { rel: string; isDir: boolean } => !!m.rel)
      : [];
    const busy = tl.status === "running" || tl.status === "initializing";
    // 1.3: optimistic like the composer (shows now, failure keeps a 重试 bubble); behind a running turn it queues
    void tl.send(activeThreadId, { text, ...(rels.length ? { mentions: rels } : {}) }, mentions?.length ? { mentions } : {}, { optimistic: !busy })
      .catch((e) => toast(tr("composer.failSend") + errMsg(e), true));
  };
  const retryLast = () => {
    if (tl.lastUserText) resend(tl.lastUserText);
  };

  if (projects.length === 0) {
    return (
      <div className="scroll" ref={scrollRef}>
        <WorkspaceEmpty kind="no-projects" />
      </div>
    );
  }

  if (!activeThreadId) {
    return (
      <div className="scroll" ref={scrollRef}>
        {project ? (
          <div className="empty-wrap">
            <div className="cp-hero-t">{tf("chat.newInProject", { name: project.name })}</div>
            <EmptyComposer projectId={project.id} />
          </div>
        ) : (
          // Projects exist but none is selected (B12): don't claim there are no projects
          <WorkspaceEmpty kind="pick-project" />
        )}
      </div>
    );
  }

  let lastTurnEnd = -1;
  for (let i = items.length - 1; i >= 0; i--) if (items[i]!.kind === "turnend") { lastTurnEnd = i; break; }

  /** Text of the reply a turn-end row belongs to (for its copy button) */
  const replyTextBefore = (idx: number): string => {
    const parts: string[] = [];
    for (let i = idx - 1; i >= 0; i--) {
      const it = items[i]!;
      if (it.kind === "user" || it.kind === "turnend") break;
      if (it.kind === "assistant") parts.unshift(it.text);
    }
    return parts.join("\n\n");
  };

  return (
    <>
      <div className="scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="tl-wrap" data-quote-root="chat">
          <div style={{ height: virt.getTotalSize(), position: "relative" }}>
            {virt.getVirtualItems().map((v) => {
              const it = items[v.index];
              if (!it) return null;
              return (
                <div
                  key={v.key}
                  data-index={v.index}
                  ref={virt.measureElement}
                  style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${v.start}px)` }}
                >
                  <TimelineRow it={it} threadId={activeThreadId} onEditResend={resend}
                    onRetryLast={v.index === lastTurnEnd ? retryLast : undefined}
                    replyText={it.kind === "turnend" ? replyTextBefore(v.index) : undefined} />
                </div>
              );
            })}
          </div>
          {tl.items.length === 0 && !tl.error && (
            <div className="sb-empty">{tr("chat.emptyHint")}</div>
          )}
          {tl.error && <div className="nt error">{localizeDaemonMessage(tl.error)}</div>}
        </div>
      </div>
      {!stick && (
        <button className="jump" onClick={jump} title={tr("chat.jumpBottom")}>
          <Icon name="caret" />
          {hasNew && <span className="jd" />}
        </button>
      )}
      <Composer />
      <QuoteSelect />
    </>
  );
}

/** No project / nothing selected: centered onboarding matching the sidebar's empty state, no Composer at the bottom */
function WorkspaceEmpty({ kind }: { kind: "no-projects" | "pick-project" }) {
  const pick = kind === "pick-project";
  return (
    <div className="empty-wrap workspace-empty">
      <div className="cp-hero-t">{tr(pick ? "chat.pickProjectTitle" : "sidebar.noProjectsTitle")}</div>
      <div className="cp-hero-s">{tr(pick ? "chat.pickProjectSub" : "sidebar.noProjectsSub")}</div>
      <div className="empty-actions">
        <button type="button" className="btn primary" onClick={() => window.dispatchEvent(new CustomEvent("open-new-project"))}>
          {tr("sidebar.newProject")}
        </button>
      </div>
    </div>
  );
}

function EmptyComposer({ projectId }: { projectId: string }) {
  const ui = useUi();
  const prefs = useLiveSettings();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const provider = await pickDefaultProvider();
      const s = (await ws.call("settings.get")) as { defaultMode?: string };
      const created = (await ws.call("threads.create", {
        projectId, provider, model: null,
        mode: s.defaultMode ?? "default",
      })) as { id: string };
      ui.select(projectId, created.id);
      // 1.3: the new conversation opens with the bubble already in it (a failure stays there with 重试)
      await useTimeline.getState().send(created.id, { text: text.trim() });
    } catch (e) {
      toast(tr("chat.failSend") + errMsg(e), true);
      setBusy(false);
    }
  };

  return (
    <div className="cp-card" style={{ marginTop: 18 }}>
      <textarea
        className="cp-ta"
        rows={3}
        placeholder={tr("chat.emptyPlaceholder")}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (isImeComposing(e.nativeEvent)) return;
          const ctrl = e.ctrlKey || e.metaKey;
          const sendCombo = prefs.sendKey === "ctrlEnter"
            ? e.key === "Enter" && ctrl
            : e.key === "Enter" && !e.shiftKey && !ctrl;
          if (sendCombo) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="cp-bar">
        <span className="dlg-hint">{tr("chat.autoNewThread")}</span>
        <div className="cp-right">
          <button className="cp-send" disabled={!text.trim() || busy} onClick={() => void send()} title={tr("common.send")}>
            <Icon name="send" />
          </button>
        </div>
      </div>
    </div>
  );
}
