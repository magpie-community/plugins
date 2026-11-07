// Conversation area (§8.6): virtual list, stick-to-bottom, empty state, queue list, Composer.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isImeComposing } from "../composer/ime";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useUi } from "../stores/ui";
import { useData, pickDefaultProvider } from "../stores/data";
import { useTimeline } from "../stores/timeline";
import { TimelineRow } from "./Timeline";
import { foldTimeline, TOOL_COLLAPSE_AT } from "../timeline/fold";
import { collectAutoApproved } from "../timeline/autoApproved";
import { decideOnScroll, newTracker, SCROLL_UP_KEYS } from "../timeline/stick";
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
  // 1.3 全部自动同意: the daemon's own approvals become one quiet row after their run (collectAutoApproved)
  const items = useMemo(() => foldTimeline(collectAutoApproved(tl.items), { showThinking: prefs.showThinking }), [tl.items, prefs.showThinking]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stick, setStickState] = useState(true);
  const [hasNew, setHasNew] = useState(false);
  // 1.3.6: the live stick flag (effects/observers read it synchronously; state only drives the 回到底部 button)
  const track = useRef(newTracker());
  const setStick = useCallback((v: boolean) => { track.current.stick = v; setStickState(v); }, []);
  /** Snap to the real bottom (scrollHeight, which follows the measured rows) */
  const toBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    track.current.lastTop = el.scrollTop;
  }, []);

  const project = projects.find((p) => p.id === ui.currentProjectId) ?? null;
  const threadId = ui.currentThreadId;
  const thread = threadId ? threads.find((th) => th.id === threadId) ?? null : null;
  const activeThreadId =
    project && thread && thread.projectId === project.id ? thread.id : null;
  const hasProjects = projects.length > 0;

  useEffect(() => {
    if (activeThreadId) tl.open(activeThreadId);
    else tl.close();
    setStick(true);
    setHasNew(false);
    track.current.pointerDown = false;
    track.current.intentAt = -Infinity;
  }, [activeThreadId, setStick]); // eslint-disable-line react-hooks/exhaustive-deps

  const est = useCallback((i: number) => {
    const it = items[i];
    if (!it) return 80;
    switch (it.kind) {
      case "user": return 60;
      case "assistant": case "reasoning": return 120;
      // 1.3: short runs are flat rows (26px each), long ones one summary row
      case "toolgroup": return it.steps.length > TOOL_COLLAPSE_AT ? 34 : 8 + 26 * it.steps.length;
      case "plan": return 200;
      case "permission": case "question": return 120;
      case "todo": return 34 + 24 * it.items.length;
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
  // 1.3.6: while stuck to the bottom, suppress virtual-core's top-anchor clamped scroll adjustments
  // so measuring tall rows near the bottom never yanks scrollTop back into the middle of the conversation
  virt.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, inst) =>
    !track.current.stick && item.end <= (inst.scrollOffset ?? 0) && inst.scrollDirection !== "backward";

  // 1.3: the composer's "N/M tasks" pill brings its checklist into view
  useEffect(() => {
    const on = (e: Event) => {
      const key = (e as CustomEvent).detail?.key as string | undefined;
      const idx = key ? items.findIndex((x) => x.key === key) : -1;
      if (idx < 0) return;
      setStick(false);
      virt.scrollToIndex(idx, { align: "center" });
      requestAnimationFrame(() => {
        const el = scrollRef.current?.querySelector(`[data-todo-key="${CSS.escape(key!)}"]`);
        el?.classList.remove("flash");
        void (el as HTMLElement | null)?.offsetWidth;
        el?.classList.add("flash");
      });
    };
    window.addEventListener("ac-show-item", on);
    return () => window.removeEventListener("ac-show-item", on);
  }, [items, virt, setStick]);

  const count = items.length;
  // New rows: follow them when stuck; otherwise light the dot — but not for the snapshot of a just-opened conversation
  const seen = useRef<{ thread: string | null; n: number }>({ thread: null, n: 0 });
  useEffect(() => {
    const prev = seen.current;
    const grew = prev.thread === activeThreadId && prev.n > 0 && count > prev.n;
    seen.current = { thread: activeThreadId, n: count };
    if (track.current.stick) toBottom();
    else if (grew) setHasNew(true);
  }, [count, activeThreadId, toBottom]);

  // 1.3.6: rows are estimated (120px for a reply) and grow when measured or while streaming, with the row
  // count unchanged — after every render that may have changed the total size, stay on the real bottom
  const totalSize = virt.getTotalSize();
  useLayoutEffect(() => {
    if (track.current.stick) toBottom();
  });
  // …and when the content, a row, or the scroller itself resizes (code blocks laid out, a hidden plugin view
  // becoming visible, a streaming row growing before the virtualizer re-renders, window/panel/composer resize)
  const ro = useRef<ResizeObserver | null>(null);
  if (!ro.current && typeof ResizeObserver !== "undefined") {
    ro.current = new ResizeObserver(() => { if (track.current.stick) toBottom(); });
  }
  useEffect(() => () => ro.current?.disconnect(), []);
  useEffect(() => {
    const el = scrollRef.current;
    const obs = ro.current;
    if (!el || !obs) return;
    obs.observe(el);
    const wrap = el.querySelector(".tl-wrap");
    if (wrap) obs.observe(wrap);
    return () => { obs.unobserve(el); if (wrap) obs.unobserve(wrap); };
  }, [activeThreadId, hasProjects]);
  const rowRef = useCallback((node: HTMLDivElement | null) => {
    virt.measureElement(node);
    if (node) ro.current?.observe(node); // detached rows drop out of the observer with their node
  }, [virt]);

  // 1.3: a send always lands at the bottom, at once (and again after the new row is measured)
  useEffect(() => {
    if (!tl.sentAt) return;
    setStick(true);
    setHasNew(false);
    toBottom();
    const raf = requestAnimationFrame(toBottom);
    return () => cancelAnimationFrame(raf);
  }, [tl.sentAt, setStick, toBottom]);

  // 1.3.6: only a user gesture may leave the bottom (layout growth fires scroll events too)
  const intent = () => { track.current.intentAt = performance.now(); };
  const onWheel = (e: React.WheelEvent) => {
    intent();
    const el = scrollRef.current;
    // upward wheel on an overflowing list: leave at once, before the next growth snaps it back
    if (e.deltaY < 0 && el && el.scrollHeight > el.clientHeight && track.current.stick) setStick(false);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (SCROLL_UP_KEYS.has(e.key) || (e.key === " " && e.shiftKey)) intent();
  };
  const onPointerDown = () => { track.current.pointerDown = true; intent(); };
  useEffect(() => {
    const up = () => { if (track.current.pointerDown) { track.current.pointerDown = false; intent(); } };
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => { window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up); };
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const was = track.current.stick;
    const now = decideOnScroll(track.current, el, performance.now());
    if (now !== was || now !== stick) setStick(now);
    if (now) {
      setHasNew(false);
      // growth/programmatic move while stuck: back onto the real bottom
      if (el.scrollHeight - el.scrollTop - el.clientHeight > 1) toBottom();
    }
  };

  // 1.3.6: rows near the bottom may still be unmeasured — jump instantly and keep following as they measure
  // (a smooth scroll aimed at today's scrollHeight stopped halfway once those rows grew)
  const jump = () => {
    setStick(true);
    setHasNew(false);
    if (items.length > 0) virt.scrollToIndex(items.length - 1, { align: "end" });
    toBottom();
    let n = 0;
    const again = () => { if (!track.current.stick) return; toBottom(); if (++n < 6) requestAnimationFrame(again); };
    requestAnimationFrame(again);
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

  if (!hasProjects) {
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
      <div className="scroll" ref={scrollRef} onScroll={onScroll} onWheel={onWheel} onKeyDown={onKeyDown}
        onPointerDown={onPointerDown} onTouchStart={intent} onTouchMove={intent}>
        <div className="tl-wrap" data-quote-root="chat">
          <div style={{ height: totalSize, position: "relative" }}>
            {virt.getVirtualItems().map((v) => {
              const it = items[v.index];
              if (!it) return null;
              return (
                <div
                  key={v.key}
                  data-index={v.index}
                  ref={rowRef}
                  style={{
                    position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${v.start}px)`,
                    // 1.3.7: the list's bottom gap lives inside the last row's measured height (see .tl-wrap in layout.css)
                    ...(!tl.error && v.index === items.length - 1 ? { paddingBottom: "var(--tl-pad-b)" } : {}),
                  }}
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
