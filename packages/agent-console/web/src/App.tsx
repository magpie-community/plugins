// App shell: connection state → three-column layout. Each area is filled in by P2-2..P2-6.
import { useConnection } from "./stores/connection";
import { Layout } from "./components/Layout";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { Chat } from "./components/Chat";
import { useTimeline } from "./stores/timeline";
import { useData } from "./stores/data";
import { useEffect, useMemo, useState } from "react";
import { CommandPalette } from "./components/CommandPalette";
import { Panel } from "./components/Panel";
import { SettingsDialog } from "./components/Settings";
import { Toasts } from "./components/Toast";
import { t } from "./i18n/index.js";
import { goBackToMagpie, isWrapped, reportLostToWrapper } from "./api/backToMagpie.js";

/** No thread waiting: one shared Set, so Sidebar's prop stays the same reference */
const NO_PENDING_THREADS: Set<string> = new Set<string>();

export function App() {
  const { state, version } = useConnection();
  // Field-level selectors: a token delta (assistant/reasoning/tool output) changes none of these, so the shell
  // (Layout, Sidebar, Topbar, Panel) doesn't re-render while a reply streams
  const pendingCount = useTimeline((s) => s.pending.length);
  const pendingKey = useTimeline((s) => s.pending[0]?.key);
  const pendingThreadId = useTimeline((s) => (s.pending.length > 0 ? s.threadId : null));
  const pendingByThread = useMemo<Set<string>>(
    () => (pendingThreadId ? new Set([pendingThreadId]) : NO_PENDING_THREADS),
    [pendingThreadId],
  );
  const providers = useData((s) => s.providers);
  const [palette, setPalette] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Ctrl+K command palette; open-settings custom event; Esc closes panels
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    const onSettings = () => setSettingsOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("open-settings", onSettings);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("open-settings", onSettings);
    };
  }, []);

  if (state === "down") {
    return (
      <div className="boot-screen">
        <div className="boot-wrap">
          <span>{t("boot.serviceDown")}</span>
          <button className="btn primary" onClick={() => { if (isWrapped()) reportLostToWrapper(); else if (!goBackToMagpie()) location.reload(); }}>{t("boot.retry")}</button>
        </div>
      </div>
    );
  }
  if (state === "connecting" && !version) {
    return (
      <div className="boot-screen">
        <div className="boot-dot" data-state={state} />
        <span className="boot-label">{t("boot.connecting")}</span>
      </div>
    );
  }

  return (
    <Layout
      sidebar={<Sidebar pendingByThread={pendingByThread} />}
      topbar={<Topbar pendingCount={pendingCount} pendingKey={pendingKey} />}
      panel={<Panel />}
    >
      {state === "reconnecting" && <div className="connbar">{t("boot.reconnecting")}</div>}
      <Chat />
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} providers={providers} />}
      <Toasts />
    </Layout>
  );
}
