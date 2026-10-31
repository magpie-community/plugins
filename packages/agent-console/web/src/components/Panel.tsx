// Right panel (§8.6): tab header (changes | files | terminal) + close; content comes from each panel component.
import { useCallback, useEffect, useRef, useState } from "react";
import { useUi, type PanelTab } from "../stores/ui";
import { useData } from "../stores/data";
import { useTimeline } from "../stores/timeline";
import { ws } from "../main";
import { Icon } from "./Icons";
import { DiffView, type DiffHunk } from "./Timeline";
import { ConfirmDialog } from "./Dialog";
import { toast } from "./Toast";
import { errMsg, t, tf } from "../i18n/index.js";
import { TerminalPanel } from "./TerminalPanel";
import { copyText } from "./Markdown";
import hljs from "highlight.js/lib/common";

export function Panel() {
  const ui = useUi();
  const tabs: { tab: PanelTab; label: string }[] = [
    { tab: "changes", label: t("panel.changes") },
    { tab: "files", label: t("panel.files") },
    { tab: "terminal", label: t("panel.terminal") },
  ];
  return (
    <>
      <div className="pn-head">
        <div className="pn-tabs">
          {tabs.map((t) => (
            <button
              key={t.tab}
              className={`pn-tab${ui.panelTab === t.tab ? " on" : ""}`}
              onClick={() => ui.setPanelTab(t.tab)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button className="ibtn pn-close" title={t("panel.closeTitle")} onClick={() => ui.closePanel()}>
          <Icon name="x" />
        </button>
      </div>
      <div className="pn-body">
        {ui.panelTab === "changes" && <ChangesPanel />}
        {ui.panelTab === "files" && <FilesPanel />}
        {ui.panelTab === "terminal" && <TerminalPanel />}
      </div>
    </>
  );
}

// ---------- changes panel ----------
type GitFile = { path: string; index: string; worktree: string; kind: "modified" | "added" | "deleted" | "untracked" | "renamed" };
type GitStatus = { isRepo: boolean; branch?: string; files?: GitFile[]; error?: string };

const gitKindLabel = (k: GitFile["kind"]) => t(`panel.gitKind.${k}`);

// Unified diff text → DiffHunk[] (fed to DiffView)
function parseUnified(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    if (line.startsWith("@@")) {
      cur = { head: line, lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("+")) cur.lines.push({ t: "+", text: line.slice(1) });
    else if (line.startsWith("-")) cur.lines.push({ t: "-", text: line.slice(1) });
    else if (line.startsWith("\\")) cur.lines.push({ t: " ", text: line });
    else cur.lines.push({ t: " ", text: line.startsWith(" ") ? line.slice(1) : line });
  }
  return hunks;
}

// +/- counts (rough line count of one file's diff text; untracked = all added)
function diffStats(diff: string): { add: number; del: number } {
  let add = 0, del = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) add++;
    else if (l.startsWith("-") && !l.startsWith("---")) del++;
  }
  return { add, del };
}

function ChangesPanel() {
  const { projects, threads } = useData();
  const ui = useUi();
  const tlStatus = useTimeline((s) => s.status);
  const [st, setSt] = useState<GitStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [selPath, setSelPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ hunks?: DiffHunk[]; tooLarge?: boolean; error?: string; loading?: boolean } | null>(null);
  const [confirmPath, setConfirmPath] = useState<GitFile | null>(null);
  const [stats, setStats] = useState<Record<string, { add: number; del: number }>>({});
  const prevStatus = useRef(tlStatus);
  const selPathRef = useRef<string | null>(null);
  selPathRef.current = selPath;

  const thread = threads.find((t) => t.id === ui.currentThreadId) ?? null;
  const project = thread
    ? projects.find((p) => p.id === thread.projectId)
    : projects.find((p) => p.id === ui.currentProjectId);
  const projectId = project?.id ?? null;

  const refresh = useCallback(async () => {
    if (!projectId) { setSt(null); return; }
    try {
      const r = (await ws.call("git.status", { projectId })) as GitStatus;
      setSt(r);
      // The selected file may have been discarded/restored → clear the selection (a ref keeps the interval closure from seeing a stale selPath)
      const cur = selPathRef.current;
      if (cur && !r.files?.some((f) => f.path === cur)) {
        setSelPath(null);
        setDiff(null);
      }
    } catch (e) {
      setSt({ isRepo: false, error: String((e as Error)?.message ?? e) });
    }
  }, [projectId]);

  // Initial load + refresh every 3 seconds (the component stays mounted while the panel is visible)
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [refresh]);

  // Linked to turn_ended: refresh immediately when status goes from running/initializing back to idle
  useEffect(() => {
    const was = prevStatus.current;
    prevStatus.current = tlStatus;
    if ((was === "running" || was === "initializing") && tlStatus !== "running" && tlStatus !== "initializing") {
      void refresh();
    }
  }, [tlStatus, refresh]);

  // Selected file → fetch its diff (and refresh the counts in the list)
  const openFile = useCallback(async (f: GitFile) => {
    if (!projectId) return;
    setSelPath(f.path);
    setDiff({ loading: true });
    try {
      const r = (await ws.call("git.diff", { projectId, path: f.path })) as { diff?: string; tooLarge?: boolean; error?: string };
      if (r.tooLarge) setDiff({ tooLarge: true });
      else if (r.error) setDiff({ error: r.error });
      else {
        const hunks = parseUnified(r.diff ?? "");
        setDiff({ hunks });
        setStats((s) => ({ ...s, [f.path]: diffStats(r.diff ?? "") }));
      }
    } catch (e) {
      setDiff({ error: String((e as Error)?.message ?? e) });
    }
  }, [projectId]);

  const discard = useCallback(async (f: GitFile) => {
    if (!projectId) return;
    setBusy(true);
    try {
      await ws.call("git.discard", { projectId, path: f.path });
      if (selPath === f.path) { setSelPath(null); setDiff(null); }
      await refresh();
    } catch (e) {
      toast(t("panel.failDiscard") + errMsg(e), true);
    } finally {
      setBusy(false);
    }
  }, [projectId, selPath, refresh]);

  if (!project) return <div className="pn-empty">{t("panel.pickProject")}</div>;
  if (st && !st.isRepo) {
    return (
      <div className="pn-empty">
        {t("panel.notGit")}
        {st.error && <div className="pn-empty-sub">{st.error}</div>}
      </div>
    );
  }

  return (
    <>
      <div className="chg-head">
        <span className="chg-branch" title={t("panel.branch")}><Icon name="changes" size={13} /> {st?.branch ?? "…"}</span>
        <button className="ibtn" title={t("common.refresh")} onClick={() => void refresh()}><Icon name="refresh" size={14} /></button>
      </div>
      <div className="chg-list">
        {(st?.files ?? []).length === 0 && <div className="pn-empty">{t("panel.clean")}</div>}
        {st?.files?.map((f) => {
          const s = stats[f.path];
          return (
            <div key={f.path} className={`chg-row${selPath === f.path ? " on" : ""}`} onClick={() => void openFile(f)}>
              <span className={`chg-kind k-${f.kind}`} title={f.kind}>{gitKindLabel(f.kind)}</span>
              <span className="chg-path" title={f.path}>{f.path}</span>
              {s && <span className="chg-stat"><em className="add">+{s.add}</em> <em className="del">−{s.del}</em></span>}
              <button
                className="ibtn chg-discard"
                title={t("panel.discardBtn")}
                disabled={busy}
                onClick={(e) => { e.stopPropagation(); setConfirmPath(f); }}
              >
                <Icon name="x" size={13} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="chg-diff">
        {diff?.loading && <div className="pn-empty">{t("panel.loadingDiff")}</div>}
        {diff?.tooLarge && <div className="pn-empty">{t("panel.diffTooLarge")}</div>}
        {diff?.error && <div className="pn-empty">{diff.error}</div>}
        {diff?.hunks && <DiffView hunks={diff.hunks} path={selPath ?? undefined} />}
      </div>
      {confirmPath && (
        <ConfirmDialog
          title={t("panel.discardTitle")}
          body={
            confirmPath.kind === "untracked"
              ? tf("panel.discardUntracked", { path: confirmPath.path })
              : tf("panel.discardTracked", { path: confirmPath.path })
          }
          okLabel={t("common.discard")}
          danger
          onOk={() => void discard(confirmPath)}
          onClose={() => setConfirmPath(null)}
        />
      )}
    </>
  );
}

// ---------- files panel ----------
type TreeEntry = { name: string; path: string; isDir: boolean };

function FilesPanel() {
  const { projects, threads } = useData();
  const ui = useUi();
  const thread = threads.find((t) => t.id === ui.currentThreadId) ?? null;
  const project = thread
    ? projects.find((p) => p.id === thread.projectId)
    : projects.find((p) => p.id === ui.currentProjectId);
  const projectId = project?.id ?? null;

  // expanded: dir path → entries | "loading" | error string
  const [dirs, setDirs] = useState<Record<string, TreeEntry[] | "loading" | string>>({});
  const [sel, setSel] = useState<string | null>(null);
  const [file, setFile] = useState<{ text?: string; language?: string; binary?: boolean; tooLarge?: boolean; error?: string; loading?: boolean } | null>(null);

  const loadDir = useCallback(async (dir: string) => {
    if (!projectId) return;
    setDirs((d) => ({ ...d, [dir]: "loading" }));
    try {
      const r = (await ws.call("files.tree", { projectId, dir })) as { entries?: TreeEntry[]; error?: string };
      setDirs((d) => ({ ...d, [dir]: r.error ? `err:${r.error}` : (r.entries ?? []) }));
    } catch (e) {
      setDirs((d) => ({ ...d, [dir]: `err:${String((e as Error)?.message ?? e)}` }));
    }
  }, [projectId]);

  // Project changed → reload the root
  useEffect(() => {
    setDirs({});
    setSel(null);
    setFile(null);
    if (projectId) void loadDir(".");
  }, [projectId, loadDir]);

  const toggle = (e: TreeEntry) => {
    if (!e.isDir) {
      void openFile(e.path);
      return;
    }
    const cur = dirs[e.path];
    if (cur && cur !== "loading") {
      // Expanded → collapse (remove the entries; keeping the subdirectory cache is harmless, expanding again refetches)
      setDirs((d) => { const n = { ...d }; delete n[e.path]; return n; });
    } else if (!cur) {
      void loadDir(e.path);
    }
    // Ignore clicks while "loading"
  };

  const openFile = async (path: string) => {
    if (!projectId) return;
    setSel(path);
    setFile({ loading: true });
    try {
      const r = (await ws.call("files.read", { projectId, path })) as { text?: string; language?: string; binary?: boolean; tooLarge?: boolean; error?: string };
      setFile(r);
    } catch (e) {
      setFile({ error: String((e as Error)?.message ?? e) });
    }
  };

  // Highlighting: run hljs once on the code after the preview text renders
  const preRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = preRef.current;
    if (!el || !file?.text) return;
    try { hljs.highlightElement(el); } catch {}
  }, [file?.text, file?.language]);

  if (!project) return <div className="pn-empty">{t("panel.pickProject")}</div>;

  const crumbs = sel ? sel.split("/") : [];
  const renderDir = (dir: string, depth: number) => {
    const d = dirs[dir];
    if (!d || d === "loading") return null;
    if (typeof d === "string") return <div className="ft-err" style={{ paddingLeft: 8 + depth * 14 }}>{d.slice(4)}</div>;
    return d.map((e) => (
      <div key={e.path}>
        <div
          className={`ft-row${sel === e.path ? " on" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => toggle(e)}
          title={e.path}
        >
          {e.isDir ? (
            <>
              <span className={`caret${dirs[e.path] && dirs[e.path] !== "loading" ? " open" : ""}`}>›</span>
              <Icon name="files" size={13} />
            </>
          ) : (
            <>
              <span className="caret" style={{ visibility: "hidden" }}>›</span>
              <span className="ft-dot" />
            </>
          )}
          <span className="ft-name">{e.name}</span>
        </div>
        {e.isDir && renderDir(e.path, depth + 1)}
      </div>
    ));
  };

  return (
    <>
      <div className="ft-crumbs">
        {sel ? (
          <>
            <button className="ft-crumb" onClick={() => setSel(null)} title={t("panel.closePreview")}>×</button>
            {crumbs.map((c, i) => <span key={i} className="ft-crumb-t">{i > 0 ? "/" : ""}{c}</span>)}
            <button className="ibtn" title={t("common.copyPath")} onClick={() => { void copyText(sel); toast(t("common.copiedPath")); }}>
              <Icon name="copy" size={13} />
            </button>
          </>
        ) : (
          <span className="ft-crumb-t muted">{project.name}</span>
        )}
      </div>
      <div className="ft-tree">{renderDir(".", 0)}</div>
      {sel && (
        <div className="ft-view">
          {file?.loading && <div className="pn-empty">{t("panel.reading")}</div>}
          {file?.binary && <div className="pn-empty">{t("panel.binary")}</div>}
          {file?.tooLarge && <div className="pn-empty">{t("panel.tooLarge")}</div>}
          {file?.error && <div className="pn-empty">{file.error}</div>}
          {file?.text != null && (
            <pre className="ft-pre"><code ref={preRef} className={`language-${file.language ?? "plaintext"}`}>{file.text}</code></pre>
          )}
        </div>
      )}
    </>
  );
}
