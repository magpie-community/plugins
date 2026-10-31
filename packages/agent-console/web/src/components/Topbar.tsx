// Top bar (§8.6): breadcrumb, status pill, model name on the right + panel toggle + ⋯.
import { useEffect, useState } from "react";
import { isImeComposing } from "../composer/ime";
import { useData } from "../stores/data";
import { useUi, type PanelTab } from "../stores/ui";
import { useConnection } from "../stores/connection";
import { ws } from "../main";
import { Icon } from "./Icons";
import { Menu, useMenu, type MenuItem } from "./Menu";
import { Dialog } from "./Dialog";
import { copyText } from "./Markdown";
import { toast } from "./Toast";
import { fmtTokens, fmtCost } from "../util/format";
import type { Project, ThreadMeta } from "../types/models";
import { displayThreadTitle, getIntlLocale, t, tf } from "../i18n/index.js";

function useNow(running: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const t0 = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t0);
  }, [running]);
  return now;
}

export function Topbar({ pendingCount }: { pendingCount: number }) {
  const { projects, threads } = useData();
  const ui = useUi();
  const { version } = useConnection();
  const [renaming, setRenaming] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [val, setVal] = useState("");
  const [menuPos, openMenu, closeMenu] = useMenu();

  const thread = threads.find((t) => t.id === ui.currentThreadId) ?? null;
  const project = thread ? projects.find((p) => p.id === thread.projectId) : projects.find((p) => p.id === ui.currentProjectId);
  const running = thread?.status === "running" || thread?.status === "initializing";
  const now = useNow(running);
  const elapsed = running && thread ? Math.max(0, now - thread.updatedAt) : 0;

  const pill = thread
    ? pendingCount > 0
      ? { cls: "wait", text: t("topbar.waitAuth") }
      : running
        ? { cls: "run", text: tf("topbar.running", { s: Math.floor(elapsed / 1000) }) }
        : thread.status === "error"
          ? { cls: "err", text: t("topbar.error") }
          : thread.status === "closed"
            ? { cls: "", text: t("topbar.closedResume") }
            : null
    : null;

  const panelBtns: { tab: PanelTab; icon: string; title: string }[] = [
    { tab: "changes", icon: "changes", title: t("topbar.panelChanges") },
    { tab: "files", icon: "files", title: t("topbar.panelFiles") },
    { tab: "terminal", icon: "term", title: t("topbar.panelTerminal") },
  ];

  const moreItems: MenuItem[] = thread
    ? [
        { kind: "item", label: t("common.rename"), onClick: () => { setVal(thread.title); setRenaming(true); } },
        { kind: "item", label: t("topbar.threadInfo"), onClick: () => setInfoOpen(true) },
        { kind: "sep" },
        { kind: "item", label: t("common.settings"), onClick: () => window.dispatchEvent(new CustomEvent("open-settings")) },
        { kind: "label", text: version ? `v${version}` : "" },
      ]
    : [
        { kind: "item", label: t("common.settings"), onClick: () => window.dispatchEvent(new CustomEvent("open-settings")) },
        { kind: "label", text: version ? `v${version}` : "" },
      ];

  return (
    <header className="topbar">
      <button
        className="ibtn tb-menu-btn"
        title={t("topbar.sidebar")}
        onClick={() => ui.setSbOpen(!ui.sbOpen)}
      >
        <Icon name="menu" />
      </button>
      {project && <span className="tb-crumb">{project.name}</span>}
      {project && thread && <span className="tb-sep">/</span>}
      {thread ? (
        renaming ? (
          <input
            className="tb-rename"
            autoFocus
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onBlur={() => setRenaming(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isImeComposing(e.nativeEvent) && val.trim()) {
                void ws.call("threads.update", { id: thread.id, title: val.trim() });
                setRenaming(false);
              } else if (e.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <span className="tb-title" title={t("topbar.clickRename")} onClick={() => { setVal(thread.title); setRenaming(true); }}>
            {displayThreadTitle(thread.title, thread.titleAuto)}
          </span>
        )
      ) : (
        <span className="tb-title ghost">{project ? t("topbar.pickThread") : t("app.title")}</span>
      )}
      {pill && <span className={`tb-pill ${pill.cls}`}>{pill.text}</span>}
      <div className="tb-right">
        {thread?.model && <span className="tb-model">{thread.model}</span>}
        {panelBtns.map((b) => (
          <button
            key={b.tab}
            className={`ibtn${ui.panelOpen && ui.panelTab === b.tab ? " on" : ""}`}
            title={b.title}
            onClick={() => (ui.panelOpen && ui.panelTab === b.tab ? ui.closePanel() : ui.openPanel(b.tab))}
          >
            <Icon name={b.icon} />
          </button>
        ))}
        <button className="ibtn" title={t("common.more")} onClick={(e) => openMenu(e)}>
          <Icon name="dots" />
        </button>
      </div>
      {menuPos && <Menu x={menuPos.x} y={menuPos.y} items={moreItems} onClose={closeMenu} />}
      {infoOpen && thread && <ThreadInfoDialog thread={thread} project={project} onClose={() => setInfoOpen(false)} />}
    </header>
  );
}

function ThreadInfoDialog({ thread, project, onClose }: { thread: ThreadMeta; project: Project | null | undefined; onClose: () => void }) {
  const u = thread.usage;
  const loc = getIntlLocale();
  const rows: [string, string][] = [
    [t("thread.agent"), thread.provider],
    [t("thread.model"), thread.model ?? t("common.default")],
    [t("thread.mode"), thread.mode],
    [t("thread.effort"), thread.effort ?? t("common.default")],
    [t("thread.sessionId"), thread.providerSessionId ?? t("thread.sessionNone")],
    [t("thread.tokens"), tf("thread.tokensFmt", { in: fmtTokens(u.inputTokens), out: fmtTokens(u.outputTokens), cache: fmtTokens(u.cacheReadTokens) })],
    [t("thread.cost"), u.costUsd > 0 ? fmtCost(u.costUsd) : "—"],
    [t("thread.created"), new Date(thread.createdAt).toLocaleString(loc)],
    [t("thread.workdir"), project?.path ?? "—"],
  ];
  if (thread.importedFrom) rows.push([t("thread.importedFrom"), `${thread.importedFrom.provider} / ${thread.importedFrom.sessionId.slice(0, 8)}…`]);
  const copyKeys = new Set([t("thread.sessionId"), t("thread.workdir")]);
  return (
    <Dialog title={t("thread.info")} onClose={onClose}>
      <div className="info-grid">
        {rows.map(([k, v]) => (
          <div className="info-row" key={k}>
            <span className="info-k">{k}</span>
            <span className="info-v" title={v}>{v}</span>
            {copyKeys.has(k) && v !== "—" && v !== t("thread.sessionNone") && (
              <button className="ibtn" title={t("common.copy")} onClick={() => { void copyText(v); toast(t("common.copied")); }}>
                <Icon name="copy" size={12} />
              </button>
            )}
          </div>
        ))}
      </div>
    </Dialog>
  );
}
