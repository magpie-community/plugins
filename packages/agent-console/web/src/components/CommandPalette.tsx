// Command palette (§8.6 Ctrl+K): filter projects/conversations/actions, ↑↓ to select, Enter to run.
import { applyTheme, currentTheme } from "../layout/theme.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { isImeComposing } from "../composer/ime";
import { createPortal } from "react-dom";
import { useData, pickDefaultProvider } from "../stores/data";
import { useUi, type PanelTab } from "../stores/ui";
import { ws } from "../main";
import type { Project } from "../types/models";
import { toast } from "./Toast";
import { errMsg, t } from "../i18n/index.js";

type Cmd = { id: string; label: string; hint?: string; run: () => void };

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { projects, threads, providers } = useData();
  const ui = useUi();
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const items = useMemo<Cmd[]>(() => {
    const out: Cmd[] = [];
    const ql = q.trim().toLowerCase();
    const match = (s: string) => !ql || s.toLowerCase().includes(ql);

    const acts: [string, () => void][] = [
      [t("palette.actNewThread"), () => { const p = ui.currentProjectId ?? projects[0]?.id; if (p) void newThread(p); }],
      [t("palette.actSettings"), () => window.dispatchEvent(new CustomEvent("open-settings"))],
      [t("palette.actTheme"), () => void cycleTheme()],
      [t("palette.actChanges"), () => ui.openPanel("changes" as PanelTab)],
      [t("palette.actFiles"), () => ui.openPanel("files" as PanelTab)],
      [t("palette.actTerminal"), () => ui.openPanel("terminal" as PanelTab)],
      [t("palette.actImport"), () => {
        const p = ui.currentProjectId ?? projects[0]?.id;
        if (p) window.dispatchEvent(new CustomEvent("open-import", { detail: { projectId: p } }));
      }],
    ];
    for (const [label, run] of acts) if (match(label)) out.push({ id: `act:${label}`, label, hint: t("palette.hintAction"), run });

    for (const p of projects) {
      if (match(p.name)) out.push({ id: `p:${p.id}`, label: p.name, hint: t("palette.hintProject"), run: () => ui.select(p.id, null) });
    }
    for (const t0 of threads) {
      const proj = projects.find((p) => p.id === t0.projectId);
      const hay = `${t0.title} ${proj?.name ?? ""}`;
      if (match(hay)) out.push({ id: `t:${t0.id}`, label: t0.title, hint: proj?.name ?? t("palette.hintThread"), run: () => ui.select(t0.projectId, t0.id) });
    }
    return out.slice(0, 30);
  }, [q, projects, threads]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setIdx(0); }, [q]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(items.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter" && !isImeComposing(e.nativeEvent)) { e.preventDefault(); const it = items[idx]; if (it) { onClose(); it.run(); } }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  };

  async function newThread(projectId: string) {
    try {
      const s = (await ws.call("settings.get")) as { defaultProvider?: string; defaultMode?: string };
      const provider = await pickDefaultProvider();
      const th = (await ws.call("threads.create", { projectId, provider, mode: s.defaultMode ?? "default" })) as { id: string };
      useUi.getState().select(projectId, th.id);
    } catch (e) { toast(t("palette.failNew") + errMsg(e), true); }
  }

  return createPortal(
    <div className="dlg-scrim" style={{ alignItems: "flex-start", paddingTop: "14vh" }}
      onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dlg cpal" role="dialog" aria-label={t("palette.aria")}>
        <input ref={inputRef} className="cpal-in" placeholder={t("palette.placeholder")}
          value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} />
        <div className="cpal-list">
          {items.map((it, i) => (
            <button key={it.id} className={`cpal-item${i === idx ? " on" : ""}`}
              onMouseEnter={() => setIdx(i)}
              onClick={() => { onClose(); it.run(); }}>
              <span className="cpal-label">{it.label}</span>
              {it.hint && <span className="cpal-hint">{it.hint}</span>}
            </button>
          ))}
          {items.length === 0 && <div className="sb-empty">{t("palette.noMatch")}</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

async function cycleTheme() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  try {
    await ws.call("settings.set", { patch: { theme: next } });
  } catch {}
}
