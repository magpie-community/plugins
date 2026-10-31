// Sidebar (§8.6): new project / search box / project groups / conversation rows / menus.
import { useEffect, useMemo, useRef, useState } from "react";
import { isImeComposing } from "../composer/ime";
import { useData, pickDefaultProvider } from "../stores/data";
import { useUi } from "../stores/ui";
import { ws } from "../main";
import type { Project, ThreadMeta } from "../types/models";
import { relTime } from "../util/format";
import { Menu, useMenu, type MenuItem } from "./Menu";
import { Dialog, ConfirmDialog } from "./Dialog";
import { Icon } from "./Icons";
import { toast } from "./Toast";
import { displayThreadTitle, errMsg, t as tr, tf } from "../i18n/index.js";

const THREAD_PAGE = 10;

function dotClass(t: ThreadMeta, pendingIds: Set<string>): string {
  if (pendingIds.has(t.id)) return "dot wait";
  if (t.status === "running" || t.status === "initializing") return "dot run";
  if (t.status === "error" || t.lastTurnStatus === "failed") return "dot err";
  return "dot";
}

export function Sidebar({ pendingByThread }: { pendingByThread: Set<string> }) {
  const { projects, threads } = useData();
  const ui = useUi();
  const [filter, setFilter] = useState("");
  const [showArchived, setShowArchived] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [newProjOpen, setNewProjOpen] = useState(false);
  const [importFor, setImportFor] = useState<Project | null>(null);
  const [confirm, setConfirm] = useState<null | { title: string; body: string; onOk: () => void }>(null);
  const [renameProj, setRenameProj] = useState<Project | null>(null);
  const [pmPos, openPm, closePm] = useMenu();
  const [tmPos, openTm, closeTm] = useMenu();
  const menuRef = useRef<{ project?: Project; thread?: ThreadMeta }>({});
  const filterRef = useRef<HTMLInputElement>(null);

  // The command palette's "Import existing conversations…" action opens the import dialog through an event
  useEffect(() => {
    const onOpen = (e: Event) => {
      const pid = (e as CustomEvent).detail?.projectId as string | undefined;
      const p = projects.find((x) => x.id === pid) ?? projects[0];
      if (p) setImportFor(p);
    };
    const onNewProject = () => setNewProjOpen(true);
    window.addEventListener("open-import", onOpen);
    window.addEventListener("open-new-project", onNewProject);
    return () => {
      window.removeEventListener("open-import", onOpen);
      window.removeEventListener("open-new-project", onNewProject);
    };
  }, [projects]);

  // Ctrl+K command palette (handled by P2-6); the sidebar search only filters titles
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return threads;
    return threads.filter((t) => t.title.toLowerCase().includes(q));
  }, [threads, filter]);

  const byProject = useMemo(() => {
    const m = new Map<string, ThreadMeta[]>();
    for (const t of filtered) {
      if (!t.archived || showArchived[t.projectId]) {
        (m.get(t.projectId) ?? m.set(t.projectId, []).get(t.projectId)!).push(t);
      }
    }
    for (const list of m.values()) {
      list.sort((a, b) => Number(a.archived) - Number(b.archived) || Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
    }
    return m;
  }, [filtered, showArchived]);

  const archivedCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of filtered) {
      if (t.archived) m.set(t.projectId, (m.get(t.projectId) ?? 0) + 1);
    }
    return m;
  }, [filtered]);

  async function createThread(projectId: string) {
    try {
      const s = await getSettings();
      const provider = await pickDefaultProvider();
      const t = (await ws.call("threads.create", {
        projectId,
        provider,
        model: null,
        mode: (s.defaultMode as string) ?? "default",
        effort: (s.defaultEffort as string | null) ?? null,
      })) as ThreadMeta;
      ui.select(projectId, t.id);
    } catch (e) {
      toast(tr("sidebar.failNewThread") + errMsg(e), true);
    }
  }

  function threadMenuItems(t: ThreadMeta): MenuItem[] {
    return [
      { kind: "item", label: tr("common.rename"), onClick: () => { setRenaming(t.id); setRenameVal(t.title); } },
      { kind: "item", label: t.pinned ? tr("sidebar.unpin") : tr("sidebar.pin"), onClick: () => void ws.call("threads.update", { id: t.id, pinned: !t.pinned }) },
      { kind: "item", label: t.archived ? tr("sidebar.unarchive") : tr("sidebar.archive"), onClick: () => void toggleArchive(t) },
      { kind: "item", label: tr("sidebar.exportMd"), onClick: () => void exportThread(t) },
      { kind: "sep" },
      {
        kind: "item", label: tr("common.delete"), danger: true,
        onClick: () => setConfirm({
          title: tr("sidebar.deleteThread"),
          body: tf("sidebar.deleteThreadBody", { title: t.title }),
          onOk: () => void ws.call("threads.delete", { id: t.id }),
        }),
      },
    ];
  }

  async function toggleArchive(t: ThreadMeta) {
    try {
      await ws.call("threads.update", { id: t.id, archived: !t.archived });
      if (!t.archived) {
        setShowArchived((s) => ({ ...s, [t.projectId]: true }));
        toast(tr("sidebar.archivedHint"));
      } else {
        toast(tr("sidebar.unarchived"));
      }
    } catch (e) {
      toast(errMsg(e), true);
    }
  }

  function projectMenuItems(p: Project): MenuItem[] {
    return [
      { kind: "item", label: tr("sidebar.newThread"), onClick: () => void createThread(p.id) },
      { kind: "item", label: tr("sidebar.importHist"), onClick: () => setImportFor(p) },
      { kind: "item", label: tr("common.rename"), onClick: () => setRenameProj(p) },
      { kind: "item", label: tr("sidebar.openExplorer"), onClick: () => void ws.call("projects.open", { id: p.id }) },
      { kind: "sep" },
      { kind: "item", label: showArchived[p.id] ? tr("sidebar.hideArchived") : tr("sidebar.showArchived"), onClick: () => setShowArchived((s) => ({ ...s, [p.id]: !s[p.id] })) },
      { kind: "sep" },
      {
        kind: "item", label: tr("sidebar.removeProject"), danger: true,
        onClick: () => setConfirm({
          title: tr("sidebar.removeProject"),
          body: tf("sidebar.removeProjectBody", { name: p.name }),
          onOk: () => void ws.call("projects.remove", { id: p.id }),
        }),
      },
    ];
  }

  return (
    <>
      <div className="sb-row">
        <button className="sb-new" onClick={() => setNewProjOpen(true)}>
          <Icon name="plus" /> {tr("sidebar.newProject")}
        </button>
        <button className="ibtn" title={tr("common.settings")} onClick={() => window.dispatchEvent(new CustomEvent("open-settings"))}>
          <Icon name="settings" />
        </button>
        <button className="ibtn" title={tr("sidebar.searchTitle")} onClick={() => filterRef.current?.focus()}>
          <Icon name="search" />
        </button>
      </div>
      <div className="sb-row" style={{ height: 32, paddingTop: 0 }}>
        <div className="sb-search">
          <input
            ref={filterRef}
            placeholder={tr("sidebar.filterPlaceholder")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setFilter(""); }}
          />
        </div>
      </div>
      <div className="sb-list">
        {projects.length === 0 && (
          <div className="sb-start">
            <div className="sb-start-t">{tr("sidebar.noProjectsTitle")}</div>
            <div className="sb-start-s">{tr("sidebar.noProjectsSub")}</div>
            <button className="btn primary" onClick={() => setNewProjOpen(true)}>{tr("sidebar.newProject")}</button>
          </div>
        )}
        {projects.map((p) => {
          const list = byProject.get(p.id) ?? [];
          const collapsed = ui.collapsed[p.id];
          const nArchived = archivedCount.get(p.id) ?? 0;
          const shown = showAll[p.id] ? list : list.slice(0, THREAD_PAGE);
          return (
            <div className="pj-group" key={p.id}>
              <div
                className="pj"
                onContextMenu={(e) => { menuRef.current.project = p; openPm(e); }}
              >
                <button className="pj-toggle" onClick={() => ui.toggleCollapsed(p.id)}>
                  <span className={`pj-caret${collapsed ? "" : " open"}`}><Icon name="caret" /></span>
                  <span className="pj-badge">{p.name.slice(0, 1)}</span>
                  <span className="pj-name">{p.name}</span>
                </button>
                <span className="pj-count">{list.length || ""}</span>
                <button className="pj-act" title={tr("sidebar.newThread")} onClick={() => void createThread(p.id)}>
                  <Icon name="plus" />
                </button>
                <button className="pj-act" title={tr("sidebar.projectMenu")} onClick={(e) => { menuRef.current.project = p; openPm(e); }}>
                  <Icon name="dots" />
                </button>
              </div>
              {!collapsed && (
                <div className="pj-sessions">
                  {shown.map((t) =>
                    renaming === t.id ? (
                      <div className="t-item" key={t.id}>
                        <input
                          className="t-rename"
                          autoFocus
                          value={renameVal}
                          onChange={(e) => setRenameVal(e.target.value)}
                          onBlur={() => setRenaming(null)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !isImeComposing(e.nativeEvent) && renameVal.trim()) {
                              void ws.call("threads.update", { id: t.id, title: renameVal.trim() });
                              setRenaming(null);
                            } else if (e.key === "Escape") setRenaming(null);
                          }}
                        />
                      </div>
                    ) : (
                      <button
                        key={t.id}
                        className={`t-item${ui.currentThreadId === t.id ? " on" : ""}${t.archived ? " archived" : ""}`}
                        onClick={() => ui.select(p.id, t.id)}
                        onContextMenu={(e) => { menuRef.current.thread = t; openTm(e); }}
                      >
                        <span className={dotClass(t, pendingByThread)} />
                        {t.pinned && <span className="t-pin"><Icon name="pin" /></span>}
                        <span className="t-title">{displayThreadTitle(t.title, t.titleAuto)}</span>
                        <span className="t-time">{relTime(t.updatedAt)}</span>
                        <span
                          className="t-more"
                          role="button"
                          onClick={(e) => { e.stopPropagation(); menuRef.current.thread = t; openTm(e); }}
                        >
                          <Icon name="dots" />
                        </span>
                      </button>
                    ),
                  )}
                  {list.length > THREAD_PAGE && !showAll[p.id] && (
                    <button className="pj-more" onClick={() => setShowAll((s) => ({ ...s, [p.id]: true }))}>
                      {tf("sidebar.showAll", { n: list.length })}
                    </button>
                  )}
                  {nArchived > 0 && (
                    <button className="pj-more" onClick={() => setShowArchived((s) => ({ ...s, [p.id]: !s[p.id] }))}>
                      {showArchived[p.id] ? tr("sidebar.hideArchived") : tf("sidebar.archivedN", { n: nArchived })}
                    </button>
                  )}
                  {list.length === 0 && nArchived === 0 && <div className="pj-empty">{tr("sidebar.noThreads")}</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {pmPos && menuRef.current.project && (
        <Menu x={pmPos.x} y={pmPos.y} items={projectMenuItems(menuRef.current.project)} onClose={closePm} />
      )}
      {tmPos && menuRef.current.thread && (
        <Menu x={tmPos.x} y={tmPos.y} items={threadMenuItems(menuRef.current.thread)} onClose={closeTm} />
      )}
      {newProjOpen && <NewProjectDialog onClose={() => setNewProjOpen(false)} />}
      {importFor && <ImportDialog project={importFor} onClose={() => setImportFor(null)} />}
      {confirm && (
        <ConfirmDialog title={confirm.title} body={confirm.body} danger onOk={confirm.onOk} onClose={() => setConfirm(null)} />
      )}
      {renameProj && <RenameProjectDialog project={renameProj} onClose={() => setRenameProj(null)} />}
    </>
  );
}

function RenameProjectDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [name, setName] = useState(project.name);
  const ok = name.trim().length > 0 && name.trim() !== project.name;
  const save = () => {
    if (!ok) return;
    ws.call("projects.rename", { id: project.id, name: name.trim() })
      .then(onClose)
      .catch((e) => toast(tr("sidebar.failRename") + errMsg(e), true));
  };
  return (
    <Dialog
      title={tr("sidebar.renameProject")}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>{tr("common.cancel")}</button>
          <button className="btn primary" disabled={!ok} onClick={save}>{tr("common.save")}</button>
        </>
      }
    >
      <div className="dlg-row">
        <label>{tr("sidebar.projectName")}</label>
        <input
          className="tinput"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !isImeComposing(e.nativeEvent)) save(); }}
        />
      </div>
    </Dialog>
  );
}

// Sidebar-related fields from settings.get: fetched once and cached (module level, avoids setState during render)
function getSettings(): Promise<Record<string, unknown>> {
  // No cache: the Settings dialog / e2e may have just changed it, always get the latest
  return ws.call("settings.get").then((v) => v as Record<string, unknown>).catch(() => ({}));
}

// ---- new project dialog: path + fs.check + recent directories ----
function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const [path, setPath] = useState("");
  const [state, setState] = useState<null | { exists: boolean; isDir: boolean }>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const ui = useUi();

  useEffect(() => {
    void ws.call("fs.recentDirs").then((d) => setRecent(d as string[])).catch(() => {});
  }, []);

  useEffect(() => {
    const p = path.trim();
    if (!p) { setState(null); return; }
    const t = setTimeout(() => {
      void ws.call("fs.check", { path: p }).then((r) => setState(r as { exists: boolean; isDir: boolean })).catch(() => setState(null));
    }, 200);
    return () => clearTimeout(t);
  }, [path]);

  const ok = state?.exists && state.isDir;
  async function add() {
    if (!ok || busy) return;
    setBusy(true);
    try {
      const p = (await ws.call("projects.create", { path: path.trim() })) as Project;
      ui.select(p.id, null);
      onClose();
    } catch (e) {
      toast(tr("sidebar.failAddProject") + errMsg(e), true);
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={tr("sidebar.newProjectDlg")}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>{tr("common.cancel")}</button>
          <button className="btn primary" disabled={!ok || busy} onClick={() => void add()}>{tr("common.add")}</button>
        </>
      }
    >
      <div className="dlg-row">
        <label>{tr("sidebar.dirLabel")}</label>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            className={`tinput${state && !ok ? " err" : ""}`}
            style={{ flex: 1 }}
            autoFocus
            placeholder="D:\\path\\to\\project"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !isImeComposing(e.nativeEvent)) void add(); }}
          />
          <button
            className="btn"
            style={{ flex: "none", whiteSpace: "nowrap" }}
            onClick={() => {
              void ws.call("fs.pickFolder", { initial: path.trim() || undefined }).then((r) => {
                const res = r as { available: boolean; path: string | null };
                if (res?.path) setPath(res.path);
                else if (res && !res.available) toast(tr("sidebar.pickFolderUnsupported"));
              }).catch(() => toast(tr("sidebar.pickFolderFailed")));
            }}
          >{tr("common.browse")}</button>
        </div>
        {state && !state.exists && <div className="dlg-hint err">{tr("sidebar.dirMissing")}</div>}
        {state && state.exists && !state.isDir && <div className="dlg-hint err">{tr("sidebar.notDir")}</div>}
        {ok && <div className="dlg-hint">{tr("sidebar.dirOk")}</div>}
      </div>
      {recent.length > 0 && (
        <div className="dlg-row">
          <label>{tr("sidebar.recent")}</label>
          {recent.map((r) => (
            <button key={r} className="mi" style={{ height: 26 }} onClick={() => setPath(r)}>{r}</button>
          ))}
        </div>
      )}
    </Dialog>
  );
}

// ---- import existing conversations dialog (P4-1): list sessions in ~/.claude/projects matching the project directory, tick to import ----
type HistItem = { provider: string; sessionId: string; title: string; updatedAt: number; messageCount: number; imported: boolean };

function ImportDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [items, setItems] = useState<HistItem[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const ui = useUi();

  useEffect(() => {
    void ws.call("history.list", { projectId: project.id })
      .then((r) => setItems(r as HistItem[]))
      .catch((e) => { toast(tr("sidebar.failImportList") + errMsg(e), true); setItems([]); });
  }, [project.id]);

  const toggle = (sid: string) => {
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(sid)) n.delete(sid); else n.add(sid);
      return n;
    });
  };

  async function doImport() {
    if (busy || checked.size === 0 || !items) return;
    setBusy(true);
    try {
      const list = items.filter((i) => checked.has(i.sessionId) && !i.imported);
      const created = (await ws.call("history.import", {
        projectId: project.id,
        items: list.map((i) => ({ provider: i.provider, sessionId: i.sessionId, title: i.title })),
      })) as ThreadMeta[];
      toast(tf("sidebar.importedN", { n: created.length }));
      if (created.length > 0) ui.select(project.id, (created[created.length - 1] as ThreadMeta).id);
      onClose();
    } catch (e) {
      toast(tr("sidebar.failImport") + errMsg(e), true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={tf("sidebar.importTitle", { name: project.name })}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>{tr("common.cancel")}</button>
          <button className="btn primary" disabled={busy || checked.size === 0} onClick={() => void doImport()}>
            {busy ? tr("sidebar.importing") : tf("sidebar.importN", { n: checked.size || 0 })}
          </button>
        </>
      }
    >
      {items === null && <div className="dlg-hint">{tr("sidebar.scanning")}</div>}
      {items !== null && items.length === 0 && (
        <div className="dlg-hint">{tr("sidebar.importEmpty")}</div>
      )}
      {items !== null && items.length > 0 && (
        <div className="imp-list">
          {items.map((i) => (
            <label key={i.sessionId} className={`imp-row${i.imported ? " done" : ""}`}>
              <input
                type="checkbox"
                disabled={i.imported}
                checked={checked.has(i.sessionId)}
                onChange={() => toggle(i.sessionId)}
              />
              <span className="imp-title">{i.title}</span>
              <span className="imp-meta">
                {i.provider} · {i.messageCount}{tr("common.messages")} · {relTime(i.updatedAt)}{i.imported ? tr("common.imported") : ""}
              </span>
            </label>
          ))}
        </div>
      )}
    </Dialog>
  );
}

// Export: the daemon writes to the local Downloads folder and selects it in the file manager (a.download is blocked inside Magpie).
async function exportThread(t: ThreadMeta) {
  try {
    const r = (await ws.call("thread.exportMarkdown", { id: t.id })) as { markdown: string; filename: string; path?: string };
    if (r.path) {
      toast(tf("sidebar.exportSaved", { path: r.path }));
      return;
    }
    const blob = new Blob([r.markdown], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = r.filename || `${t.title}.md`;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 5000);
  } catch (e) {
    toast(tr("sidebar.failExport") + errMsg(e), true);
  }
}
