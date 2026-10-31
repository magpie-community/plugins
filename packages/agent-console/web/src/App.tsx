// App shell: connection state → three-column layout. Each area is filled in by P2-2..P2-6.
import { useConnection } from "./stores/connection";
import { Layout } from "./components/Layout";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { Chat } from "./components/Chat";
import { useTimeline } from "./stores/timeline";
import { useData } from "./stores/data";
import { useEffect, useState } from "react";
import { CommandPalette } from "./components/CommandPalette";
import { Panel } from "./components/Panel";
import { SettingsDialog } from "./components/Settings";
import { Toasts } from "./components/Toast";
import { t } from "./i18n/index.js";
import { goBackToMagpie } from "./api/backToMagpie.js";

export function App() {
  const { state, version } = useConnection();
  const pending = useTimeline((s) => s.pending);
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
          <button className="btn primary" onClick={() => { if (!goBackToMagpie()) location.reload(); }}>{t("boot.retry")}</button>
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
      sidebar={<Sidebar pendingByThread={new Set(pending.map((p) => useTimeline.getState().threadId!).filter(Boolean))} />}
      topbar={<Topbar pendingCount={pending.length} />}
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
