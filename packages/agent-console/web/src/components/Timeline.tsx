// Timeline item components (§8.6): user bubble, body, thinking, tool group, plan, todo, permission, question, error, turn end.
import { useEffect, useMemo, useRef, useState } from "react";
import type { DisplayItem, ToolStep } from "../timeline/reducer";
import { Markdown, copyText } from "./Markdown";
import { Reveal } from "../timeline/reveal";
import { Icon } from "./Icons";
import { ws } from "../main";
import { getToken } from "../api/token";
import { normalizeHunks } from "../timeline/diffHunks";
import { fmtDur, fmtTokens, fmtCost } from "../util/format";
import { useUi } from "../stores/ui";
import { localizeDaemonMessage, t, tf } from "../i18n/index.js";
import { toast } from "./Toast";

const token = () => getToken();

export function attachmentUrl(id: string): string {
  return `/attachments/${id}?t=${token()}`;
}

// ---------- user message ----------
export function UserItem({ it, onRetry }: { it: Extract<DisplayItem, { kind: "user" }>; onRetry?: (text: string) => void }) {
  return (
    <div className="um-row">
      <div className="um">
        {it.attachments?.map((a) => (
          <img key={a.id} className="um-img" src={`/attachments/${a.id}?t=${token()}`} alt={a.name} />
        ))}
        <span className="um-text">{it.text}</span>
        <div className="um-act">
          <button className="ibtn" title={t("common.copy")} onClick={() => void copyText(it.text)}><Icon name="copy" size={13} /></button>
          {onRetry && <button className="ibtn" title={t("timeline.editResend")} onClick={() => onRetry(it.text)}><Icon name="send" size={13} /></button>}
        </div>
      </div>
      {it.steered && <div className="um-tag">{t("timeline.steer")}</div>}
    </div>
  );
}

// ---------- body (streaming reveal) ----------
export function AssistantItem({ it }: { it: Extract<DisplayItem, { kind: "assistant" }> }) {
  const [shown, setShown] = useState(it.streaming ? "" : it.text);
  const reveal = useRef<Reveal | null>(null);
  useEffect(() => {
    if (!reveal.current) reveal.current = new Reveal(setShown);
    reveal.current.push(it.text);
    if (!it.streaming) reveal.current.flush();
  }, [it.text, it.streaming]);
  useEffect(() => () => reveal.current?.stop(), []);
  return <Markdown text={shown} streaming={it.streaming} />;
}

// ---------- thinking ----------
export function ReasoningItem({ it }: { it: Extract<DisplayItem, { kind: "reasoning" }> }) {
  const [open, setOpen] = useState(false);
  const secs = Math.max(1, Math.round(it.text.length / 40));
  return (
    <div className="rs-item">
      <button className="rs-head" onClick={() => setOpen(!open)}>
        <span className={`caret${open ? " open" : ""}`}>›</span> {tf("timeline.thinking", { s: secs })}
      </button>
      {open && <div className="rs-body">{it.text}</div>}
    </div>
  );
}

// ---------- tool group ----------
function toolKind(k: string): string {
  const key = `timeline.tool.${k}` as const;
  const v = t(key);
  return v.startsWith("timeline.tool.") ? t("timeline.tool.other") : v;
}

export function ToolGroupItem({ it }: { it: Extract<DisplayItem, { kind: "toolgroup" }> }) {
  // Failed steps or steps with a diff are worth seeing directly → auto-expand (never reopened after the user collapses them)
  const hasFail = it.steps.some((s) => s.status === "failed");
  const hasDiff = it.steps.some((s) => {
    const d = s.detail as { hunks?: unknown[]; diff?: { hunks?: unknown[] } } | undefined;
    const h = d?.hunks ?? d?.diff?.hunks;
    return Array.isArray(h) && h.length > 0;
  });
  const [open, setOpen] = useState(hasFail || hasDiff);
  const userToggled = useRef(false);
  useEffect(() => {
    if (!userToggled.current && (hasFail || hasDiff)) setOpen(true);
  }, [hasFail, hasDiff]);
  const summary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of it.steps) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
    const parts = [...counts.entries()].map(([k, n]) => `${toolKind(k)} ${n}`);
    return tf("timeline.toolSummary", { n: it.steps.length, parts: parts.join(" · ") });
  }, [it.steps]);
  const runningStep = it.steps.find((s) => s.status === "running");
  return (
    <div className="tg">
      <button className="tg-head" onClick={() => { userToggled.current = true; setOpen(!open); }}>
        <span className={`caret${open ? " open" : ""}`}>›</span>
        <span>{summary}</span>
        {runningStep && <span className="tg-live">{tf("timeline.toolRunning", { kind: toolKind(runningStep.kind), title: runningStep.title })}</span>}
      </button>
      {open && (
        <div className="tg-list">
          {it.steps.map((s) => <ToolStepRow key={s.itemId} s={s} />)}
        </div>
      )}
    </div>
  );
}

function ToolStepRow({ s }: { s: ToolStep }) {
  // Failed steps and steps with a diff expand their details by default (the diff is what the user wants to see)
  const detail = s.detail as { hunks?: unknown[] } | undefined;
  const [open, setOpen] = useState(s.status === "failed" || (Array.isArray(detail?.hunks) && detail.hunks.length > 0));
  const icon = s.status === "running" ? "…" : s.status === "ok" ? "✓" : "✗";
  const cls = s.status === "running" ? "run" : s.status === "ok" ? "ok" : "fail";
  const hasDetail = s.output || s.detail;
  return (
    <div className="ts">
      <button className="ts-head" onClick={() => hasDetail && setOpen(!open)}>
        <span className={`ts-ic ${cls}`}>{icon}</span>
        <span className="ts-title">{s.title || toolKind(s.kind)}</span>
        {s.durationMs != null && <span className="ts-meta">{fmtDur(s.durationMs)}</span>}
        {s.exitCode != null && s.exitCode !== 0 && <span className="ts-meta err">exit {s.exitCode}</span>}
      </button>
      {open && <ToolDetail s={s} />}
    </div>
  );
}

function ToolDetail({ s }: { s: ToolStep }) {
  const [full, setFull] = useState(false);
  // editDetail outputs {path, hunks, added, removed}; the {diff:{hunks}} shape is also accepted
  const detail = s.detail as { hunks?: unknown; diff?: { path?: string; hunks?: unknown }; path?: string } | undefined;
  const rawHunks = detail?.hunks ?? detail?.diff?.hunks;
  if (rawHunks) {
    return <DiffView hunks={normalizeHunks(rawHunks)} path={detail?.diff?.path ?? detail?.path} />;
  }
  if (s.output != null) {
    const lines = s.output.split("\n");
    const tail = lines.length > 50 && !full;
    const text = tail ? lines.slice(-50).join("\n") : s.output;
    return (
      <div className="ts-out">
        {tail && <button className="ts-more" onClick={() => setFull(true)}>{tf("timeline.showAllLines", { n: lines.length })}</button>}
        <pre>{text}</pre>
      </div>
    );
  }
  if (s.input != null) {
    return <pre className="ts-out">{JSON.stringify(s.input, null, 2).slice(0, 4000)}</pre>;
  }
  return null;
}

// ---------- line-level diff (unified view) ----------
export type DiffHunk = { head?: string; lines: { t: "+" | "-" | " "; text: string }[] };

export function DiffView({ hunks, path, max = 3000 }: { hunks: DiffHunk[]; path?: string; max?: number }) {
  let shown = 0;
  let clipped = false;
  return (
    <div className="diff">
      {path && <div className="diff-path">{path}</div>}
      <pre className="diff-pre">
        {hunks.map((h, hi) => (
          <span key={hi} className="dh">
            <span className="dh-head">{h.head ?? "@@"}</span>
            {h.lines.map((l, li) => {
              shown++;
              if (shown > max) { clipped = true; return null; }
              return <span key={li} className={`dl ${l.t === "+" ? "add" : l.t === "-" ? "del" : ""}`}>{l.t} {l.text}{"\n"}</span>;
            })}
          </span>
        ))}
      </pre>
      {clipped && <div className="dlg-hint">{tf("timeline.diffClip", { n: max })}</div>}
    </div>
  );
}

// ---------- plan ----------
export function PlanItem({ it }: { it: Extract<DisplayItem, { kind: "plan" }> }) {
  return (
    <div className="card plan">
      <Markdown text={it.markdown} />
    </div>
  );
}

// ---------- todo ----------
export function TodoItem({ it }: { it: Extract<DisplayItem, { kind: "todo" }> }) {
  const [open, setOpen] = useState(false);
  const done = it.items.filter((i) => i.status === "done" || i.status === "completed").length;
  return (
    <div className="rs-item">
      <button className="rs-head" onClick={() => setOpen(!open)}>
        <span className={`caret${open ? " open" : ""}`}>›</span> {tf("timeline.todo", { done, total: it.items.length })}
      </button>
      {open && (
        <ul className="todo-list">
          {it.items.map((i, n) => (
            <li key={n} className={`todo ${i.status}`}>
              {i.status === "done" || i.status === "completed" ? "☑" : i.status === "in_progress" ? "◐" : "☐"} {i.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- permission ----------
export function PermissionItem({ it, threadId }: { it: Extract<DisplayItem, { kind: "permission" }>; threadId: string }) {
  const [busy, setBusy] = useState(false);
  const respond = (optionId: string) => {
    setBusy(true);
    void ws.call("thread.respond", { id: threadId, requestId: it.requestId, optionId }).catch(() => setBusy(false));
  };
  const detail = it.detail as { command?: string; path?: string; plan?: string; hunks?: DiffHunk[]; diff?: { path?: string; hunks?: DiffHunk[] } } | undefined;
  const hunks = detail?.hunks ?? detail?.diff?.hunks;
  const label = it.status === "resolved"
    ? it.choice === "allow_always" || it.choice === "acceptForSession" ? t("timeline.permAllowSession")
      : it.choice === "deny" || it.choice === "reject" || it.choice === "decline" ? t("timeline.permDenied")
        : it.choice === "implement" ? t("timeline.permAllowed") : t("timeline.permAllowed")
    : t("timeline.permCancelled");
  return (
    <div className={`card perm${it.status !== "pending" ? " done" : ""}`}>
      <div className="perm-title">{it.title}</div>
      {detail?.command && <pre className="perm-cmd">{detail.command}</pre>}
      {detail?.path && <div className="perm-path">{detail.path}</div>}
      {hunks && <DiffView hunks={hunks} path={detail?.diff?.path ?? detail?.path} max={200} />}
      {it.status === "pending" ? (
        <div className="perm-btns">
          {it.options.map((o) => (
            <button key={o.id} className={`btn ${o.kind === "allow_once" ? "primary" : o.kind === "reject_once" ? "danger" : ""}`}
              disabled={busy} onClick={() => respond(o.id)}>
              {o.label}
            </button>
          ))}
        </div>
      ) : (
        <div className="perm-done">{label}</div>
      )}
    </div>
  );
}

// ---------- question ----------
export function QuestionItem({ it, threadId }: { it: Extract<DisplayItem, { kind: "question" }>; threadId: string }) {
  const [free, setFree] = useState<Record<number, string>>({});
  const [sel, setSel] = useState<Record<number, string>>({});
  const qs = it.questions as { id?: string; question?: string; header?: string; options?: { label: string; description?: string }[] }[];
  // answers keys: the question id first (codex/mock schema), then the question text
  const qkey = (q: (typeof qs)[number], i: number) => q.id ?? q.question ?? q.header ?? `q${i}`;

  const submit = () => {
    const answers: Record<string, string> = {};
    qs.forEach((q, i) => {
      answers[qkey(q, i)] = free[i]?.trim() || sel[i] || "";
    });
    void ws.call("thread.respond", { id: threadId, requestId: it.requestId, answers });
  };

  return (
    <div className={`card ask${it.status !== "pending" ? " done" : ""}`}>
      {qs.map((q, i) => (
        <div key={i} className="ask-q">
          <div className="ask-t">{q.header ?? q.question}</div>
          {it.status === "pending" ? (
            <>
              <div className="ask-opts">
                {q.options?.map((o) => (
                  <button key={o.label} className={`btn${sel[i] === o.label ? " primary" : ""}`}
                    onClick={() => setSel((s) => ({ ...s, [i]: o.label }))}>{o.label}</button>
                ))}
              </div>
              <input className="tinput ask-free" placeholder={t("common.other")}
                value={free[i] ?? ""} onChange={(e) => setFree((f) => ({ ...f, [i]: e.target.value }))} />
            </>
          ) : (
            <div className="perm-done">
              {it.answers ? tf("timeline.submitted", { ans: Object.values(it.answers).join("、") }) : t("timeline.permCancelled")}
            </div>
          )}
        </div>
      ))}
      {it.status === "pending" && <button className="btn primary" onClick={submit}>{t("common.submit")}</button>}
    </div>
  );
}

// ---------- error / turn end ----------
export function TurnEndItem({ it, onRetry, replyText }: { it: Extract<DisplayItem, { kind: "turnend" }>; onRetry?: () => void; replyText?: string }) {
  const ui = useUi();
  const [showErr, setShowErr] = useState(false);
  if (it.status === "failed") {
    return (
      <div className="card err-card">
        <div className="err-line">{tf("timeline.turnError", { err: localizeDaemonMessage(it.error ?? t("timeline.unknownError")) })}</div>
        <div className="perm-btns">
          {onRetry && <button className="btn" onClick={onRetry}>{t("common.retry")}</button>}
          {it.error && it.error.length > 60 && (
            <button className="btn ghost" onClick={() => setShowErr(!showErr)}>{t("common.details")}</button>
          )}
        </div>
        {showErr && <pre className="perm-cmd">{localizeDaemonMessage(it.error ?? "")}</pre>}
      </div>
    );
  }
  const parts: string[] = [];
  if (it.durationMs != null) parts.push(fmtDur(it.durationMs));
  if (it.usage) {
    const tk = it.usage.inputTokens + it.usage.outputTokens;
    if (tk) parts.push(`${fmtTokens(tk)} tokens`);
    if (it.usage.costUsd) parts.push(fmtCost(it.usage.costUsd));
  }
  if (it.status === "interrupted") parts.push(t("timeline.interrupted"));
  return (
    <div className="te">
      {parts.length > 0 && <span className="te-meta">{parts.join(" · ")}</span>}
      {replyText && (
        <button className="te-act" title={t("common.copy")} onClick={() => void copyText(replyText).then(() => toast(t("common.copied")))}>
          <Icon name="copy" size={13} /><span>{t("common.copy")}</span>
        </button>
      )}
      {onRetry && (
        <button className="te-act" title={t("common.retry")} onClick={onRetry}>
          <Icon name="refresh" size={13} /><span>{t("common.retry")}</span>
        </button>
      )}
      {it.filesChanged != null && it.filesChanged > 0 && (
        <button className="te-files" onClick={() => ui.openPanel("changes")}>
          {tf("timeline.filesChanged", { n: it.filesChanged })}
        </button>
      )}
    </div>
  );
}

// ---------- dispatch ----------
export function TimelineRow({ it, threadId, onEditResend, onRetryLast, replyText }: {
  it: DisplayItem; threadId: string; replyText?: string;
  onEditResend?: (text: string) => void;
  onRetryLast?: () => void;
}) {
  switch (it.kind) {
    case "user": return <UserItem it={it} onRetry={onEditResend} />;
    case "assistant": return <div className="as"><AssistantItem it={it} /></div>;
    case "reasoning": return <ReasoningItem it={it} />;
    case "toolgroup": return <ToolGroupItem it={it} />;
    case "plan": return <PlanItem it={it} />;
    case "todo": return <TodoItem it={it} />;
    case "permission": return <PermissionItem it={it} threadId={threadId} />;
    case "question": return <QuestionItem it={it} threadId={threadId} />;
    case "notice": return <div className={`nt ${it.level}`}>{localizeDaemonMessage(it.message)}</div>;
    case "turnend": return <TurnEndItem it={it} onRetry={onRetryLast} replyText={replyText} />;
    case "gone": return null;
    default: return null;
  }
}
