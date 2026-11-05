// 1.3 Settings → Bash path (Windows): shows what Git Bash detection found and takes a manual bash.exe that overrides it.
// The path is checked by the daemon (shell.check) before it is saved; an invalid one is never stored.
import { useEffect, useState } from "react";
import { ws } from "../main";
import { errMsg, t, tf } from "../i18n/index.js";
import { openExternal } from "../preview/open";
import { GIT_FOR_WINDOWS_URL } from "./Timeline";

export type ShellStatus = {
  platform: string;
  needed: boolean;
  manual: string;
  found: { path: string; source: string } | null;
  manualError?: string;
};
type Check = { ok: true; path: string } | { ok: false; reason: string };

const reasonText = (r: string) => {
  const k = `settings.bashBad.${r}`;
  const v = t(k);
  return v === k ? r : v;
};

export function BashPathSetting({ value, save }: { value: string; save: (path: string) => Promise<boolean> }) {
  const [st, setSt] = useState<ShellStatus | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => ws.call("shell.status").then((v) => setSt(v as ShellStatus)).catch(() => {});
  useEffect(() => { void load(); }, []);

  if (!st) return null;
  if (st.platform !== "win32") return <div className="dlg-hint">{t("settings.bashNotWindows")}</div>;

  const text = draft ?? value;
  const check = async (): Promise<Check | null> => {
    try { return (await ws.call("shell.check", { path: text.trim() })) as Check; }
    catch (e) { setMsg({ ok: false, text: errMsg(e) }); return null; }
  };
  const onCheck = async () => {
    if (!text.trim()) { setMsg(null); return; }
    setBusy(true);
    const c = await check();
    setBusy(false);
    if (c) setMsg(c.ok ? { ok: true, text: tf("settings.bashOk", { path: c.path }) } : { ok: false, text: reasonText(c.reason) });
  };
  const commit = async () => {
    if (draft === null || draft.trim() === value) { setDraft(null); return; }
    let next = "";
    if (draft.trim()) {
      const c = await check();
      if (!c) return;
      if (!c.ok) { setMsg({ ok: false, text: reasonText(c.reason) }); return; } // keep the draft so it can be fixed
      next = c.path;
    }
    setBusy(true);
    const saved = await save(next);
    setBusy(false);
    if (saved) { setDraft(null); setMsg(null); await load(); }
  };

  const src = st.found ? t(`settings.bashSrc.${st.found.source}`) : "";
  return (
    <div className="bash-set">
      <div className="bash-row">
        <input className={`tinput${msg && !msg.ok ? " err" : ""}`} spellCheck={false}
          aria-label={t("settings.bashPath")} placeholder="E:\Git\bin\bash.exe"
          value={text} onChange={(e) => { setDraft(e.target.value); setMsg(null); }}
          onBlur={() => void commit()} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commit(); } }} />
        <button type="button" className="btn" disabled={busy || !text.trim()} onMouseDown={(e) => e.preventDefault()} onClick={() => void onCheck()}>{t("settings.bashCheck")}</button>
      </div>
      {msg && <div className={`dlg-hint${msg.ok ? "" : " err"}`}>{msg.text}</div>}
      {!msg && st.manualError && <div className="dlg-hint err">{tf("settings.bashManualBad", { why: reasonText(st.manualError) })}</div>}
      <div className="dlg-hint">
        {st.found ? tf("settings.bashUsing", { path: st.found.path, src }) : (
          <>
            {t("settings.bashNone")}{" "}
            <button type="button" className="te-files" onClick={() => void openExternal(GIT_FOR_WINDOWS_URL)}>{t("timeline.bashDownload")}</button>
          </>
        )}
      </div>
      <div className="dlg-hint">{t("settings.bashHint")}</div>
    </div>
  );
}
