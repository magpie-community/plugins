// Settings dialog (§8.6): fields = §5.6; saved on change; version/data directory/PID at the bottom.
import { useEffect, useState } from "react";
import { Dialog } from "./Dialog";
import { SelectMenu } from "./SelectMenu";
import { ws } from "../main";
import { toast } from "./Toast";
import { permissionModes } from "../i18n/modes.js";
import { errMsg, t, tf } from "../i18n/index.js";
import type { ProviderInfo } from "../types/models.js";
import { useData } from "../stores/data.js";
import { IDLE_MAX, IDLE_MIN, parseArgsDraft, parseIdleDraft } from "./settingsFields.js";
import { applyTheme, embeddedInMagpie, normalizeThemeSetting } from "../layout/theme.js";

type Settings = {
  defaultProvider?: string; defaultMode?: string;
  sendKey?: string; runningSend?: string; showThinking?: boolean;
  theme?: string; idleCloseMinutes?: number;
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

/** Refresh the provider list in the background (no forced re-detect of every agent) */
function refreshProviders(): void {
  void ws.call("providers.list").then((list) => {
    useData.setState({ providers: list as ProviderInfo[] });
  }).catch(() => {});
}

export function SettingsDialog({ onClose, providers }: { onClose: () => void; providers: ProviderInfo[] }) {
  const [s, setS] = useState<Settings | null>(null);
  const [info, setInfo] = useState<{ version?: string; dataDir?: string; pid?: number }>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  // Optimistic on/off per agent until providers.list catches up (B2)
  const [enabledDraft, setEnabledDraft] = useState<Record<string, boolean>>({});
  // Text drafts for the launch fields and the idle minutes, committed on blur / Enter (B5, B6)
  const [exeDraft, setExeDraft] = useState<Record<string, string>>({});
  const [argsDraft, setArgsDraft] = useState<Record<string, string>>({});
  const [argsErr, setArgsErr] = useState<Record<string, boolean>>({});
  const [idleDraft, setIdleDraft] = useState<string | null>(null);
  const modes = permissionModes();

  useEffect(() => {
    void ws.call("settings.get").then((v) => setS(v as Settings));
    void ws.call("app.info").then((v) => setInfo(v as typeof info)).catch(() => {});
  }, []);

  const set = async (patch: Partial<Settings>): Promise<boolean> => {
    const prev = s;
    const next = { ...s, ...patch } as Settings;
    setS(next);
    if (patch.theme) applyTheme(patch.theme);
    try {
      await ws.call("settings.set", { patch });
      window.dispatchEvent(new CustomEvent("settings-changed", { detail: next }));
      return true;
    } catch (e) {
      setS(prev);
      if (patch.theme) applyTheme(prev?.theme);
      toast(t("settings.failSave") + errMsg(e), true);
      return false;
    }
  };

  const toggleProvider = async (id: string, on: boolean) => {
    setEnabledDraft((d) => ({ ...d, [id]: on }));
    const cur = s?.providerEnabled ?? {};
    const prev = s;
    const next = { ...s, providerEnabled: { ...cur, [id]: on } } as Settings;
    setS(next);
    try {
      await ws.call("settings.set", { patch: { providerEnabled: next.providerEnabled } });
      window.dispatchEvent(new CustomEvent("settings-changed", { detail: next }));
      // Only this change is reflected locally; the list refreshes quietly (newly enabled agents get detected then)
      if (!on) useData.setState((st) => ({ providers: st.providers.map((p) => (p.id === id ? { ...p, enabled: false } : p)) }));
      refreshProviders();
    } catch (e) {
      setS(prev);
      toast(t("settings.providerToggleFailed") + errMsg(e), true);
    } finally {
      setEnabledDraft((d) => { const n = { ...d }; delete n[id]; return n; });
    }
  };

  const redetect = () => {
    void ws.call("providers.list", { refresh: true }).then((list) => {
      useData.setState({ providers: list as ProviderInfo[] });
      toast(t("settings.providerRedetect") + " ✓");
    }).catch((e) => toast(errMsg(e), true));
  };

  const setLaunch = async (id: string, patch: { executable?: string; args?: string[] }) => {
    const cur = { ...(s?.providerCommand ?? {}) };
    const merged = { ...cur[id], ...patch };
    if (!merged.executable) delete merged.executable;
    if (!merged.args || merged.args.length === 0) delete merged.args;
    const same = JSON.stringify(cur[id] ?? {}) === JSON.stringify(merged);
    if (same) return;
    cur[id] = merged;
    if (await set({ providerCommand: cur })) refreshProviders();
  };

  const commitExe = (id: string) => {
    const v = exeDraft[id];
    if (v === undefined) return;
    void setLaunch(id, { executable: v.trim() || undefined });
    setExeDraft((d) => { const n = { ...d }; delete n[id]; return n; });
  };

  const commitArgs = (id: string) => {
    const v = argsDraft[id];
    if (v === undefined) return;
    const parsed = parseArgsDraft(v);
    if (parsed === null) { setArgsErr((e) => ({ ...e, [id]: true })); return; }
    setArgsErr((e) => ({ ...e, [id]: false }));
    void setLaunch(id, { args: parsed });
    setArgsDraft((d) => { const n = { ...d }; delete n[id]; return n; });
  };

  const commitIdle = () => {
    if (idleDraft === null) return;
    const n = parseIdleDraft(idleDraft);
    if (n === null) return; // stays in the field with the error shown
    setIdleDraft(null);
    if (n !== s?.idleCloseMinutes) void set({ idleCloseMinutes: n });
  };

  const providerStatus = (p: ProviderInfo, on: boolean) => {
    if (!on) return { dot: "off", text: t("settings.providerOff") };
    if (p.enabled === false) return { dot: "pending", text: t("settings.providerPending") };
    if (!p.available) return { dot: "off", text: p.reason ?? t("common.notDetected") };
    const n = p.models?.length ?? 0;
    const base = statusLabel(p);
    const extra = n > 0 ? ` · ${tf("settings.providerModels", { n: String(n) })}` : "";
    return { dot: p.status === "verified" ? "on" : "pending", text: base + extra };
  };

  if (!s) return <Dialog title={t("settings.title")} onClose={onClose}><div className="dlg-hint">{t("common.loading")}</div></Dialog>;

  const row = (label: string, el: React.ReactNode, hint?: string) => (
    <div className="dlg-row"><label>{label}</label>{el}{hint && <div className="dlg-hint" style={{ marginTop: 4 }}>{hint}</div>}</div>
  );
  const idleBad = idleDraft !== null && parseIdleDraft(idleDraft) === null;
  const enterCommits = (fn: () => void) => (e: React.KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); fn(); } };

  return (
    <Dialog title={t("settings.title")} onClose={onClose} wide
      footer={<button className="btn primary" onClick={onClose}>{t("common.done")}</button>}>
      {row(t("settings.defaultAgent"), (
        <SelectMenu className="tinput sm-field" matchWidth ariaLabel={t("settings.defaultAgent")}
          value={s.defaultProvider ?? "claude"} onChange={(v) => void set({ defaultProvider: v })}
          options={providers.map((p) => ({ value: p.id, label: p.name + (!providerUsable(p) ? t("common.notInstalled") : ""), disabled: !providerUsable(p) }))} />
      ))}
      <div className="dlg-row dlg-row-top">
        <label>{t("settings.providers")}</label>
        <div className="provider-list">
          <button type="button" className="btn sm provider-redetect" onClick={redetect}>{t("settings.providerRedetect")}</button>
          {providers.map((p) => {
            const on = enabledDraft[p.id] ?? (s.providerEnabled?.[p.id] ?? p.enabled !== false);
            const st = providerStatus(p, on);
            const open = expanded === p.id;
            const cmd = s.providerCommand?.[p.id];
            const argsText = argsDraft[p.id] ?? (cmd?.args?.length ? JSON.stringify(cmd.args) : "");
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
                  <input type="checkbox" checked={on} disabled={enabledDraft[p.id] !== undefined}
                    onChange={(e) => void toggleProvider(p.id, e.target.checked)} />
                </label>
                {open && (
                  <div className="provider-detail">
                    {p.bin && <div className="dlg-hint">{p.bin}{p.version ? ` · ${p.version}` : ""}</div>}
                    {p.installHint && (
                      <div className="provider-hint-row">
                        <code className="dlg-hint">{p.installHint}</code>
                        <button type="button" className="te-files" onClick={() => void navigator.clipboard?.writeText(p.installHint ?? "").then(() => toast(t("common.copied")))}>{t("settings.providerCopyHint")}</button>
                      </div>
                    )}
                    <div className="dlg-hint">{t("settings.providerLaunchCmd")}</div>
                    <input className="tinput" placeholder={t("settings.providerLaunchExe")} aria-label={t("settings.providerLaunchExe")}
                      value={exeDraft[p.id] ?? cmd?.executable ?? ""}
                      onChange={(e) => { const v = e.target.value; setExeDraft((d) => ({ ...d, [p.id]: v })); }}
                      onBlur={() => commitExe(p.id)} onKeyDown={enterCommits(() => commitExe(p.id))} />
                    <input className={`tinput${argsErr[p.id] ? " err" : ""}`} placeholder='["--foo"]' aria-label={t("settings.providerLaunchArgs")}
                      value={argsText}
                      onChange={(e) => { const v = e.target.value; setArgsDraft((d) => ({ ...d, [p.id]: v })); if (argsErr[p.id]) setArgsErr((x) => ({ ...x, [p.id]: parseArgsDraft(v) === null })); }}
                      onBlur={() => commitArgs(p.id)} onKeyDown={enterCommits(() => commitArgs(p.id))} />
                    <div className={`dlg-hint${argsErr[p.id] ? " err" : ""}`}>
                      {argsErr[p.id] ? t("settings.providerArgsInvalid") : t("settings.providerLaunchArgsHint")}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {row(t("settings.defaultMode"), (
        <SelectMenu className="tinput sm-field" matchWidth ariaLabel={t("settings.defaultMode")}
          value={s.defaultMode ?? "default"} onChange={(v) => void set({ defaultMode: v })}
          options={modes.map((m) => ({ value: m.id, label: m.label, hint: m.desc }))}>
          <span className="sm-val">{(() => { const m = modes.find((x) => x.id === (s.defaultMode ?? "default")); return m ? `${m.label} — ${m.desc}` : ""; })()}</span>
        </SelectMenu>
      ), t("settings.defaultModeHint"))}
      {row(t("settings.theme"), (
        <SelectMenu className="tinput sm-field" matchWidth ariaLabel={t("settings.theme")}
          value={normalizeThemeSetting(s.theme)} onChange={(v) => void set({ theme: v })}
          options={[
            { value: "auto", label: embeddedInMagpie() ? t("settings.themeMagpie") : t("settings.themeAuto") },
            { value: "light", label: t("settings.themeLight") },
            { value: "dark", label: t("settings.themeDark") },
          ]} />
      ))}
      {row(t("settings.sendKey"), (
        <SelectMenu className="tinput sm-field" matchWidth ariaLabel={t("settings.sendKey")}
          value={s.sendKey ?? "enter"} onChange={(v) => void set({ sendKey: v })}
          options={[{ value: "enter", label: t("settings.sendEnter") }, { value: "ctrlEnter", label: t("settings.sendCtrl") }]} />
      ))}
      {row(t("settings.runningSend"), (
        <SelectMenu className="tinput sm-field" matchWidth ariaLabel={t("settings.runningSend")}
          value={s.runningSend ?? "queue"} onChange={(v) => void set({ runningSend: v })}
          options={[{ value: "queue", label: t("settings.queue") }, { value: "steer", label: t("settings.steer") }]} />
      ), t("settings.steerHint"))}
      {row(t("settings.thinking"), (
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: "var(--fs-m)", color: "var(--fg)" }}>
          <input type="checkbox" checked={s.showThinking !== false} onChange={(e) => void set({ showThinking: e.target.checked })} />
          {t("settings.showThinking")}
        </label>
      ))}
      {row(t("settings.idleClose"), (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input className={`tinput${idleBad ? " err" : ""}`} type="number" min={IDLE_MIN} max={IDLE_MAX} step={1} style={{ width: 90, flex: "none" }}
            aria-label={t("settings.idleClose")}
            value={idleDraft ?? String(s.idleCloseMinutes ?? 30)}
            onChange={(e) => setIdleDraft(e.target.value)}
            onBlur={commitIdle} onKeyDown={enterCommits(commitIdle)} />
          <span className="dlg-hint">{t("settings.idleMinutes")}</span>
        </div>
      ), idleBad ? t("settings.idleInvalid") : undefined)}
      <div className="msep" />
      <div className="dlg-hint">
        {tf("settings.versionLine", { ver: info.version ?? "?", pid: info.pid ?? "?" })}<br />
        {t("settings.dataDir")}{info.dataDir ?? "?"} <button className="te-files" onClick={() => void navigator.clipboard?.writeText(info.dataDir ?? "").catch(() => {})}>{t("common.copy")}</button>
      </div>
    </Dialog>
  );
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
