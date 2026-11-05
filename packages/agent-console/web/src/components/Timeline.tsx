// Timeline item components (§8.6): user bubble, body, thinking, tool group, plan, todo, permission, question, error, turn end.
import { useEffect, useMemo, useRef, useState } from "react";
import type { DisplayItem, ToolStep } from "../timeline/reducer";
import { Markdown, copyText } from "./Markdown";
import { Reveal } from "../timeline/reveal";
import { Icon } from "./Icons";
import { ws } from "../main";
import { getToken } from "../api/token";
import { normalizeHunks } from "../timeline/diffHunks";
import { activeStep, stepCategory, stepDiffStat, stepTarget, summarize, todoProgress, toolStepCount, TOOL_COLLAPSE_AT } from "../timeline/fold";
import { useData } from "../stores/data";
import { fmtDur, fmtTokens, fmtCost } from "../util/format";
import { useUi } from "../stores/ui";
import { localizeDaemonMessage, t, tf } from "../i18n/index.js";
import { toast } from "./Toast";
import { splitLocalLinks } from "../util/localLinks";
import { onChatLinkClick, openExternal } from "../preview/open";
import { splitQuotes } from "../composer/quotes";
import { localClientIds, useTimeline } from "../stores/timeline";
import { AUTO_UPGRADE_CODES, AutoApprovedItem, AutoUpgradeNotice } from "./AutoApproved";

export const GIT_FOR_WINDOWS_URL = "https://git-scm.com/download/win";

const token = () => getToken();

export function attachmentUrl(id: string): string {
  return `/attachments/${id}?t=${token()}`;
}

/** Plain text with local addresses as Preview links (tool output; React nodes, no innerHTML) */
export function LinkifiedText({ text }: { text: string }) {
  const parts = useMemo(() => splitLocalLinks(text), [text]);
  if (parts.length === 1 && typeof parts[0] === "string") return <>{text}</>;
  return (
    <>
      {parts.map((p, i) =>
        typeof p === "string" ? p : (
          <a key={i} href={p.url} data-ac-local={p.url} className="ac-local" title={t("links.openPreviewTitle")}>{p.text}</a>
        ),
      )}
    </>
  );
}

const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

/** A path chip (composer, user bubble): icon + name (folders end with /), full path on hover */
const isImageMime = (m: string | undefined): boolean => !m || m.startsWith("image/");

export function MentionChip({ path, isDir, onRemove }: { path: string; isDir: boolean; onRemove?: () => void }) {
  return (
    <span className="mention" title={path}>
      <Icon name={isDir ? "files" : "file"} size={12} />
      <span className="mention-name">{baseName(path)}{isDir ? "/" : ""}</span>
      {onRemove && <button type="button" className="att-x" aria-label={t("mention.remove")} onClick={onRemove}>×</button>}
    </span>
  );
}

// ---------- user message ----------
/** A copy button's "copied" check for 1.5 s */
function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);
  return [copied, (text: string) => void copyText(text).then(() => setCopied(true))];
}

export function UserItem({ it, onRetry }: { it: Extract<DisplayItem, { kind: "user" }>; onRetry?: (text: string, mentions?: { path: string; isDir: boolean }[]) => void }) {
  // 1.3: the actions sit right under the bubble, inside the row that is the hover target (1.2 floated them 12px to the
  // bubble's left, outside it, so they vanished on the way there), and stay reachable from the keyboard
  const [copied, copy] = useCopied();
  // 1.3: quotes added with "添加到对话" were sent as leading "> " blocks: show them as quotes
  const parsed = useMemo(() => splitQuotes(it.text), [it.text]);
  const edit = () => window.dispatchEvent(new CustomEvent("ac-composer-fill", { detail: { text: it.text, mentions: it.mentions ?? [] } }));
  // 1.3: a bubble sent from this page fades in once; the echo keeps the same key and class, so nothing replays or jumps
  const fresh = !!it.clientId && localClientIds.has(it.clientId);
  const failed = it.sendState === "failed";
  return (
    <div className={`um-row${fresh ? " fresh" : ""}${it.sendState ? ` ${it.sendState}` : ""}`} data-client-id={it.clientId}>
      <div className="um">
        {it.attachments?.filter((a) => isImageMime(a.mime)).map((a) => (
          <img key={a.id} className="um-img" src={`/attachments/${a.id}?t=${token()}`} alt={a.name} />
        ))}
        {/* text / PDF / other files: a name chip (they used to render as a broken <img>) */}
        {it.attachments?.some((a) => !isImageMime(a.mime)) && (
          <span className="um-mentions">
            {it.attachments.filter((a) => !isImageMime(a.mime)).map((a) => (
              <span key={a.id} className="mention" title={a.name}><Icon name="file" size={12} /><span className="mention-name">{a.name}</span></span>
            ))}
          </span>
        )}
        {it.mentions && it.mentions.length > 0 && (
          <span className="um-mentions">{it.mentions.map((m) => <MentionChip key={m.path} path={m.path} isDir={m.isDir} />)}</span>
        )}
        {parsed.quotes.map((q, i) => <span key={i} className="um-quote">{q}</span>)}
        <span className="um-text">{parsed.rest}</span>
      </div>
      {it.steered && <div className="um-tag">{t("timeline.steer")}</div>}
      {failed && it.clientId && (
        <div className="um-fail" role="alert">
          <span className="um-fail-t" title={it.sendError ? localizeDaemonMessage(it.sendError) : undefined}>
            <Icon name="x" size={12} />{t("timeline.sendFailed")}
          </span>
          <button type="button" className="um-fail-b" title={t("timeline.sendRetry")} onClick={() => useTimeline.getState().retry(it.clientId!)}>
            <Icon name="refresh" size={12} /><span>{t("common.retry")}</span>
          </button>
          <button type="button" className="um-fail-b" title={t("timeline.sendDismiss")} aria-label={t("timeline.sendDismiss")} onClick={() => useTimeline.getState().dismiss(it.clientId!)}>
            <span>{t("common.remove")}</span>
          </button>
        </div>
      )}
      <div className="um-act" role="toolbar" aria-label={t("timeline.msgActions")}>
        <button type="button" className={`ibtn${copied ? " done" : ""}`} title={copied ? t("common.copied") : t("common.copy")}
          aria-label={copied ? t("common.copied") : t("common.copy")} onClick={() => copy(it.text)}>
          <Icon name={copied ? "check" : "copy"} size={13} />
        </button>
        <button type="button" className="ibtn" title={t("timeline.editMsg")} aria-label={t("timeline.editMsg")} onClick={edit}>
          <Icon name="pencil" size={13} />
        </button>
        {onRetry && !it.sendState && (
          <button type="button" className="ibtn" title={t("timeline.resend")} aria-label={t("timeline.resend")} onClick={() => onRetry(it.text, it.mentions)}>
            <Icon name="refresh" size={13} />
          </button>
        )}
      </div>
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
        <span className={`caret${open ? " open" : ""}`}>›</span> {it.streaming ? t("timeline.nowThinking") : tf("timeline.thinking", { s: secs })}
      </button>
      {open && <div className="rs-body">{it.text}</div>}
    </div>
  );
}

/** 1.3: Windows without Git Bash (Claude Code / Pi / dsh need it): link to Git for Windows and to the manual setting */
function BashMissingNotice({ it }: { it: Extract<DisplayItem, { kind: "notice" }> }) {
  return (
    <div className={`nt ${it.level} nt-bash`}>
      <div>{t("timeline.bashMissing")}</div>
      <div className="nt-actions">
        <button type="button" className="btn" onClick={() => void openExternal(GIT_FOR_WINDOWS_URL)}>{t("timeline.bashDownload")}</button>
        <button type="button" className="btn" onClick={() => window.dispatchEvent(new Event("open-settings"))}>{t("timeline.bashSetting")}</button>
      </div>
    </div>
  );
}

// ---------- tool group ----------
function toolKind(k: string): string {
  const key = `timeline.tool.${k}` as const;
  const v = t(key);
  return v.startsWith("timeline.tool.") ? t("timeline.tool.other") : v;
}

/** 1.3 rows: a small line icon per tool type (grayscale) */
const KIND_ICON: Record<string, string> = {
  edit: "pencil", write: "pencil", bash: "prompt", read: "fileText", search: "search", glob: "search",
  web: "globe", task: "layers", mcp: "wrench", todo: "listChecks",
};
/** Rows whose target is a command, a path or a pattern: drawn in the code font */
const MONO_KINDS = new Set(["edit", "write", "bash", "read", "search", "glob"]);

/** The current project's folder, to show tool paths relative to it */
function useProjectRoot(): string | null {
  const pid = useUi((s) => s.currentProjectId);
  const projects = useData((s) => s.projects);
  return projects.find((p) => p.id === pid)?.path ?? null;
}

/** "D:\\proj\\src\\a.ts" under "D:\\proj" → "src\\a.ts" (case-insensitive, either slash); anything else unchanged */
export function relToRoot(target: string, root: string | null): string {
  if (!root) return target;
  const norm = (x: string) => x.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const r = norm(root);
  const tl = target.replace(/\\/g, "/").toLowerCase();
  if (r && tl.startsWith(r + "/")) return target.slice(r.length + 1);
  // a command that cds into the project first keeps its text; only whole paths are shortened
  return target;
}

export function ToolGroupItem({ it }: { it: Extract<DisplayItem, { kind: "toolgroup" }> }) {
  // 1.3 timeline polish (Better Paseo style): every step is one compact row (icon · command or path · +N -M · status).
  // Only a long run (more than TOOL_COLLAPSE_AT tool calls) folds into one summary row with counts, which expands.
  const [open, setOpen] = useState(false);
  // Not memoized on it.steps: the reducer appends steps to the same array while a turn streams
  const long = toolStepCount(it.steps) > TOOL_COLLAPSE_AT;
  if (!long) {
    return (
      <div className="tg flat">
        <div className="tg-list">
          {it.steps.map((s) => (s.kind === "think" ? <ThinkStepRow key={s.itemId} s={s} /> : <ToolStepRow key={s.itemId} s={s} />))}
        </div>
      </div>
    );
  }
  const sum = summarize(it.steps);
  const parts = sum.counts.map(([c, n]) => tf(`timeline.cat.${c}`, { n }));
  if (!parts.length && sum.thinkSecs) parts.push(tf("timeline.thinking", { s: sum.thinkSecs }));
  const active = activeStep(it.steps);
  return (
    <div className={`tg${open ? " open" : ""}`}>
      <button className="tg-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="tg-ic" aria-hidden><Icon name="layers" size={13} /></span>
        <span className="tg-sum">{parts.join(" · ")}</span>
        {sum.failed > 0 && <span className="tg-fail">{tf("timeline.failedCount", { n: sum.failed })}</span>}
        <span className={`caret${open ? " open" : ""}`} aria-hidden>›</span>
      </button>
      {!open && active && <RunningRow s={active} />}
      {open && (
        <div className="tg-list">
          {it.steps.map((s) => (s.kind === "think" ? <ThinkStepRow key={s.itemId} s={s} /> : <ToolStepRow key={s.itemId} s={s} />))}
        </div>
      )}
    </div>
  );
}

/** One line, never wrapping: "正在运行：npm test…" (the ellipsis is the CSS one when it doesn't fit) */
function RunningRow({ s }: { s: ToolStep }) {
  const cat = stepCategory(s.kind);
  const text = cat === "think" ? t("timeline.nowThinking") : tf(`timeline.now.${cat}`, { x: stepTarget(s) });
  return (
    <div className="tg-run" title={text}>
      <span className="spin" aria-hidden />
      <span className="tg-run-text">{text}</span>
    </div>
  );
}

/** Short thinking between tool calls: a quiet "思考 Xs" row that opens to its text */
function ThinkStepRow({ s }: { s: ToolStep }) {
  const [open, setOpen] = useState(false);
  const text = s.think?.text ?? "";
  const secs = Math.max(1, Math.round(text.length / 40));
  const live = !!s.think?.streaming;
  return (
    <div className="ts ts-think">
      <button className="ts-head" aria-expanded={open} onClick={() => text.trim() && setOpen(!open)}>
        <span className="ts-ic" aria-hidden><Icon name="spark" size={13} /></span>
        <span className="ts-title">{live ? t("timeline.nowThinking") : tf("timeline.thinking", { s: secs })}</span>
        {live && <span className="ts-st" aria-hidden><span className="spin" /></span>}
      </button>
      {open && <div className="rs-body">{text}</div>}
    </div>
  );
}

function StatusMark({ status }: { status: ToolStep["status"] }) {
  if (status === "running") return <span className="ts-st run" aria-label="running"><span className="spin" /></span>;
  if (status === "failed") return <span className="ts-st fail" aria-label="failed"><Icon name="x" size={12} /></span>;
  return <span className="ts-st ok" aria-label="ok"><Icon name="check" size={12} /></span>;
}

function ToolStepRow({ s }: { s: ToolStep }) {
  // A failed step opens its error output (the error is the point); everything else opens on click
  const [open, setOpen] = useState(s.status === "failed");
  const failed = s.status === "failed";
  const wasFailed = useRef(failed);
  useEffect(() => {
    if (failed && !wasFailed.current) setOpen(true);
    wasFailed.current = failed;
  }, [failed]);
  const root = useProjectRoot();
  const hasDetail = !!(s.output || s.detail || s.input != null || failed);
  const target = relToRoot(stepTarget(s), root) || toolKind(s.kind);
  const diff = s.kind === "edit" || s.kind === "write" ? stepDiffStat(s) : null;
  const mono = MONO_KINDS.has(s.kind) && target !== s.title;
  const tip = `${toolKind(s.kind)} · ${s.title || target}${s.durationMs != null ? ` · ${fmtDur(s.durationMs)}` : ""}`;
  return (
    <div className={`ts${failed ? " failed" : ""}${open ? " open" : ""}`} data-kind={s.kind}>
      <button className="ts-head" title={tip} aria-expanded={hasDetail ? open : undefined} onClick={() => hasDetail && setOpen(!open)}>
        <span className="ts-ic" aria-hidden><Icon name={KIND_ICON[s.kind] ?? "wrench"} size={13} /></span>
        <span className={`ts-title${mono ? " mono" : ""}`}>{target}</span>
        {diff && (diff.added > 0 || diff.removed > 0) && (
          <span className="ts-diff"><span className="add">+{diff.added}</span><span className="del">-{diff.removed}</span></span>
        )}
        {s.exitCode != null && s.exitCode !== 0 && <span className="ts-meta err">exit {s.exitCode}</span>}
        <StatusMark status={s.status} />
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
  if (s.status === "failed" && !s.output?.trim()) {
    return (
      <div className="ts-out">
        <div className="ts-noerr">{t("timeline.noErrorOutput")}</div>
        {s.input != null && <pre>{JSON.stringify(s.input, null, 2).slice(0, 4000)}</pre>}
      </div>
    );
  }
  if (s.output != null) {
    const lines = s.output.split("\n");
    const tail = lines.length > 50 && !full;
    const text = tail ? lines.slice(-50).join("\n") : s.output;
    return (
      <div className="ts-out">
        {tail && <button className="ts-more" onClick={() => setFull(true)}>{tf("timeline.showAllLines", { n: lines.length })}</button>}
        <pre onClick={onChatLinkClick}><LinkifiedText text={text} /></pre>
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

// ---------- checklist (todo / plan entries) ----------
export function TodoItem({ it }: { it: Extract<DisplayItem, { kind: "todo" }> }) {
  // 1.3: the Agent's step list inline, like Better Paseo: "2/3" and one check row per step (the newest list of a turn only)
  const { done, total } = todoProgress(it.items);
  return (
    <div className="ck" data-todo-key={it.key}>
      <div className="ck-head"><Icon name="listChecks" size={13} /><span className="ck-n">{done}/{total}</span><span className="ck-l">{t("timeline.tasks")}</span></div>
      <ul className="ck-list">
        {it.items.map((i, n) => {
          const st = i.status === "done" || i.status === "completed" ? "done" : i.status === "in_progress" ? "doing" : "todo";
          return (
            <li key={n} className={`ck-i ${st}`}>
              <span className="ck-box" aria-hidden>
                {st === "done" ? <Icon name="check" size={12} /> : st === "doing" ? <span className="spin" /> : <Icon name="circle" size={12} />}
              </span>
              <span className="ck-t">{i.text}</span>
            </li>
          );
        })}
      </ul>
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
    ? it.auto ? t("timeline.permAutoAllowed")
    : it.choice === "allow_always" || it.choice === "acceptForSession" ? t("timeline.permAllowSession")
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
  const [copied, copy] = useCopied();
  const model = useModelName(it.model, it.model !== undefined);
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
  const usage: string[] = [];
  if (it.usage) {
    const tk = it.usage.inputTokens + it.usage.outputTokens;
    if (tk) usage.push(`${fmtTokens(tk)} tokens`);
    if (it.usage.costUsd) usage.push(fmtCost(it.usage.costUsd));
  }
  return (
    <div className="te">
      {/* 1.3 reply footer: Copy · model · time · duration (· tokens · cost), only what the turn reported */}
      {replyText && (
        <button type="button" className={`te-act te-copy${copied ? " done" : ""}`} title={copied ? t("common.copied") : t("common.copy")}
          aria-label={copied ? t("common.copied") : t("common.copy")} onClick={() => copy(replyText)}>
          <Icon name={copied ? "check" : "copy"} size={13} /><span>{copied ? t("common.copied") : t("common.copy")}</span>
        </button>
      )}
      {model && <span className="te-m" title={model}><Icon name="cpu" size={12} /><span>{model}</span></span>}
      {it.ts != null && <span className="te-m" title={new Date(it.ts).toLocaleString()}><Icon name="clock" size={12} /><span>{fmtClock(it.ts)}</span></span>}
      {it.durationMs != null && <span className="te-m"><Icon name="hourglass" size={12} /><span>{fmtDur(it.durationMs)}</span></span>}
      {usage.length > 0 && <span className="te-m te-u">{usage.join(" · ")}</span>}
      {it.status === "interrupted" && <span className="te-m">{t("timeline.interrupted")}</span>}
      {onRetry && (
        <button type="button" className="te-act" title={t("timeline.retryHint")} aria-label={t("timeline.retryHint")} onClick={onRetry}>
          <Icon name="refresh" size={13} />
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

/** 19:13 today, "11/3 19:13" on another day (the user's locale) */
function fmtClock(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** The model a turn ran on, by its display name; a turn on the Agent's default shows the default's name when known */
function useModelName(id: string | null | undefined, known: boolean): string | null {
  const threadId = useUi((s) => s.currentThreadId);
  const threads = useData((s) => s.threads);
  const providers = useData((s) => s.providers);
  if (!known) return null;
  const th = threads.find((x) => x.id === threadId);
  const models = providers.find((p) => p.id === th?.provider)?.models ?? [];
  if (id) return models.find((m) => m.id === id)?.name ?? id;
  return models.find((m) => m.isDefault)?.name ?? null;
}

// ---------- dispatch ----------
export function TimelineRow({ it, threadId, onEditResend, onRetryLast, replyText }: {
  it: DisplayItem; threadId: string; replyText?: string;
  onEditResend?: (text: string, mentions?: { path: string; isDir: boolean }[]) => void;
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
    case "autoperm": return <AutoApprovedItem it={it} />;
    case "question": return <QuestionItem it={it} threadId={threadId} />;
    case "notice":
      if (it.code === "bash_missing") return <BashMissingNotice it={it} />;
      if (it.code && AUTO_UPGRADE_CODES.has(it.code)) return <AutoUpgradeNotice it={it} threadId={threadId} />;
      return <div className={`nt ${it.level}`}>{localizeDaemonMessage(it.message)}</div>;
    case "turnend": return <TurnEndItem it={it} onRetry={onRetryLast} replyText={replyText} />;
    case "gone": return null;
    default: return null;
  }
}
