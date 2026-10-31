// Settings dialog (§8.6): fields = §5.6; saved on change; version/data directory/PID at the bottom.
import { useEffect, useState } from "react";
import { Dialog } from "./Dialog";
import { ws } from "../main";
import { toast } from "./Toast";
import { permissionModes } from "../i18n/modes.js";
import { errMsg, t, tf } from "../i18n/index.js";
import type { ProviderInfo } from "../types/models.js";
import { useData } from "../stores/data.js";

type Settings = {
  defaultProvider?: string; defaultMode?: string; defaultEffort?: string | null;
  sendKey?: string; runningSend?: string; showThinking?: boolean; density?: string;
  theme?: string; idleCloseMinutes?: number; idleExitMinutes?: number;
  providerEnabled?: Record<string, boolean>;
  providerCommand?: Record<string, { executable?: string; args?: string[] }>;
  [k: string]: unknown;
};

function providerUsable(p: ProviderInfo): boolean {
  if (p.enabled === false || !p.available) return false;
  if (p.status === "planned") return false;
  return true;
}

function statusLabel(p: ProviderInfo): string {
  if (p.status === "verified") return t("settings.providerVerified");
  if (p.status === "experimental") return t("settings.providerExperimental");
  if (p.status === "planned") return t("settings.providerPlanned");
  return t("settings.providerPending");
}

export function SettingsDialog({ onClose, providers }: { onClose: () => void; providers: ProviderInfo[] }) {
  const wsClient = useData((s) => s.ws);
  const [s, setS] = useState<Settings | null>(null);
  const [info, setInfo] = useState<{ version?: string; dataDir?: string; pid?: number }>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const modes = permissionModes();

  useEffect(() => {
    void ws.call("settings.get").then((v) => setS(v as Settings));
    void ws.call("app.info").then((v) => setInfo(v as typeof info)).catch(() => {});
  }, []);

  const set = async (patch: Partial<Settings>) => {
    const next = { ...s, ...patch } as Settings;
    setS(next);
    try {
      await ws.call("settings.set", { patch });
      window.dispatchEvent(new CustomEvent("settings-changed", { detail: next }));
      if (patch.theme) applyTheme(patch.theme as string);
      if (patch.providerEnabled && wsClient) {
        void ws.call("providers.list", { refresh: true }).then((list) => {
          useData.setState({ providers: list as ProviderInfo[] });
        });
      }
    } catch (e) {
      toast(t("settings.failSave") + errMsg(e), true);
    }
  };

  const toggleProvider = (id: string, on: boolean) => {
    const cur = s?.providerEnabled ?? {};
    void set({ providerEnabled: { ...cur, [id]: on } });
  };

  const redetect = () => {
    void ws.call("providers.list", { refresh: true }).then((list) => {
      useData.setState({ providers: list as ProviderInfo[] });
      toast(t("settings.providerRedetect") + " ✓");
    }).catch((e) => toast(errMsg(e), true));
  };

  const setLaunch = (id: string, patch: { executable?: string; args?: string[] }) => {
    const cur = { ...(s?.providerCommand ?? {}) };
    cur[id] = { ...cur[id], ...patch };
    void set({ providerCommand: cur });
  };

  const providerStatus = (p: ProviderInfo) => {
    if (p.enabled === false) return { dot: "off", text: t("settings.providerOff") };
    if (!p.available) return { dot: "off", text: p.reason ?? t("common.notDetected") };
    const n = p.models?.length ?? 0;
    const base = statusLabel(p);
    const extra = n > 0 ? ` · ${tf("settings.providerModels", { n: String(n) })}` : "";
    return { dot: p.status === "verified" ? "on" : "pending", text: base + extra };
  };

  if (!s) return <Dialog title={t("settings.title")} onClose={onClose}><div className="dlg-hint">{t("common.loading")}</div></Dialog>;

  const row = (label: string, el: React.ReactNode) => (
    <div className="dlg-row"><label>{label}</label>{el}</div>
  );

  return (
    <Dialog title={t("settings.title")} onClose={onClose} wide
      footer={<button className="btn primary" onClick={onClose}>{t("common.done")}</button>}>
      {row(t("settings.defaultAgent"), (
        <select className="tinput" value={s.defaultProvider ?? "claude"} onChange={(e) => void set({ defaultProvider: e.target.value })}>
          {providers.map((p) => <option key={p.id} value={p.id} disabled={!providerUsable(p)}>{p.name}{!providerUsable(p) ? t("common.notInstalled") : ""}</option>)}
        </select>
      ))}
      <div className="dlg-row dlg-row-top">
        <label>{t("settings.providers")}</label>
        <div className="provider-list">
          <button type="button" className="btn sm provider-redetect" onClick={redetect}>{t("settings.providerRedetect")}</button>
          {providers.map((p) => {
            const st = providerStatus(p);
            const on = p.enabled !== false;
            const open = expanded === p.id;
            const cmd = s.providerCommand?.[p.id];
            return (
              <div key={p.id} className={`provider-row${open ? " open" : ""}`}>
                <button type="button" className="provider-head" onClick={() => setExpanded(open ? null : p.id)}>
                  <span className={`provider-dot provider-dot-${st.dot}`} aria-hidden />
                  <div className="provider-meta">
                    <span className="provider-name">{p.name}</span>
                    <span className="dlg-hint">{st.text}</span>
                  </div>
                  <span className="mi-caret">{open ? "▾" : "▸"}</span>
                </button>
                <label className="provider-switch" title={p.name}>
                  <input type="checkbox" checked={on} onChange={(e) => toggleProvider(p.id, e.target.checked)} />
                </label>
                {open && (
                  <div className="provider-detail">
                    {p.bin && <div className="dlg-hint">{p.bin}{p.version ? ` · ${p.version}` : ""}</div>}
                    {p.installHint && (
                      <div className="provider-hint-row">
                        <span className="dlg-hint">{p.installHint}</span>
                        <button type="button" className="te-files" onClick={() => void navigator.clipboard?.writeText(p.installHint ?? "").then(() => toast(t("common.copied")))}>{t("settings.providerCopyHint")}</button>
                      </div>
                    )}
                    <div className="dlg-hint">{t("settings.providerLaunchCmd")}</div>
                    <input className="tinput" placeholder={t("settings.providerLaunchExe")} value={cmd?.executable ?? ""}
                      onChange={(e) => setLaunch(p.id, { executable: e.target.value || undefined })} />
                    <input className="tinput" placeholder='["--acp"]' value={cmd?.args ? JSON.stringify(cmd.args) : ""}
                      onChange={(e) => {
                        try {
                          const v = e.target.value.trim();
                          setLaunch(p.id, { args: v ? (JSON.parse(v) as string[]) : undefined });
                        } catch { /* typing */ }
                      }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {row(t("settings.defaultMode"), (
        <select className="tinput" value={s.defaultMode ?? "default"} onChange={(e) => void set({ defaultMode: e.target.value })}>
          {modes.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      ))}
      {row(t("settings.theme"), (
        <select className="tinput" value={s.theme ?? "auto"} onChange={(e) => void set({ theme: e.target.value })}>
          <option value="auto">{t("settings.themeAuto")}</option>
          <option value="light">{t("settings.themeLight")}</option>
          <option value="dark">{t("settings.themeDark")}</option>
        </select>
      ))}
      {row(t("settings.sendKey"), (
        <select className="tinput" value={s.sendKey ?? "enter"} onChange={(e) => void set({ sendKey: e.target.value })}>
          <option value="enter">{t("settings.sendEnter")}</option>
          <option value="ctrlEnter">{t("settings.sendCtrl")}</option>
        </select>
      ))}
      {row(t("settings.runningSend"), (
        <select className="tinput" value={s.runningSend ?? "queue"} onChange={(e) => void set({ runningSend: e.target.value })}>
          <option value="queue">{t("settings.queue")}</option>
          <option value="steer">{t("settings.steer")}</option>
        </select>
      ))}
      {row(t("settings.thinking"), (
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: "var(--fs-m)", color: "var(--fg)" }}>
          <input type="checkbox" checked={s.showThinking !== false} onChange={(e) => void set({ showThinking: e.target.checked })} />
          {t("settings.showThinking")}
        </label>
      ))}
      {row(t("settings.idleClose"), (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input className="tinput" type="number" min={5} max={240} style={{ width: 90 }}
            value={s.idleCloseMinutes ?? 30}
            onChange={(e) => void set({ idleCloseMinutes: Math.max(5, Number(e.target.value) || 30) })} />
          <span className="dlg-hint">{t("settings.idleMinutes")}</span>
        </div>
      ))}
      <div className="msep" />
      <div className="dlg-hint">
        {tf("settings.versionLine", { ver: info.version ?? "?", pid: info.pid ?? "?" })}<br />
        {t("settings.dataDir")}{info.dataDir ?? "?"} <button className="te-files" onClick={() => void navigator.clipboard?.writeText(info.dataDir ?? "").catch(() => {})}>{t("common.copy")}</button>
      </div>
    </Dialog>
  );
}

export function applyTheme(theme: string) {
  const preferDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme =
    theme === "light" || theme === "dark" ? theme : preferDark ? "dark" : "light";
}

export type LiveSettings = {
  sendKey: "enter" | "ctrlEnter";
  runningSend: "queue" | "steer";
  showThinking: boolean;
};

const LIVE_DEFAULTS: LiveSettings = { sendKey: "enter", runningSend: "queue", showThinking: true };

function liveFrom(v: Record<string, unknown> | undefined): LiveSettings {
  return {
    sendKey: v?.sendKey === "ctrlEnter" ? "ctrlEnter" : "enter",
    runningSend: v?.runningSend === "steer" ? "steer" : "queue",
    showThinking: v?.showThinking !== false,
  };
}

/** The settings the composer/timeline read: fetched once at startup, updated as soon as the settings page changes them. */
export function useLiveSettings(): LiveSettings {
  const [s, setS] = useState<LiveSettings>(LIVE_DEFAULTS);
  useEffect(() => {
    void ws.call("settings.get").then((v) => setS(liveFrom(v as Record<string, unknown>))).catch(() => {});
    const on = (e: Event) => setS(liveFrom((e as CustomEvent).detail as Record<string, unknown> | undefined));
    window.addEventListener("settings-changed", on);
    return () => window.removeEventListener("settings-changed", on);
  }, []);
  return s;
}
