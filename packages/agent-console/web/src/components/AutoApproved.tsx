// 1.3 全部自动同意 (#727 review): the approvals the daemon gave by itself, one quiet row per run of tool calls.
// Collapsed: "已自动同意 3 项 · npm test · git status …"; expanded: each request's title, command / file and the answer.
import { useState } from "react";
import type { DisplayItem } from "../timeline/reducer";
import { approvalChoice, approvalTarget } from "../timeline/autoApproved";
import { Icon } from "./Icons";
import { t, tf } from "../i18n/index.js";
import { ws } from "../main";

export function AutoApprovedItem({ it }: { it: Extract<DisplayItem, { kind: "autoperm" }> }) {
  // Same flat one-line rows as the 1.3 tool steps: icon slot · text · right-edge meta; the shield keeps the amber of the
  // 全部自动同意 chip so the row reads "approved for you", not "you approved"
  const [open, setOpen] = useState(false);
  const peek = it.items.map(approvalTarget).filter(Boolean).join(" · ");
  return (
    <div className={`apv${open ? " open" : ""}`} data-testid="auto-approved">
      <button className="apv-head" aria-expanded={open} onClick={() => setOpen(!open)}
        title={t("timeline.autoApproved.title")}>
        <span className="apv-ic" aria-hidden><Icon name="shieldCheck" size={13} /></span>
        <span className="apv-n">{tf("timeline.autoApproved.count", { n: it.items.length })}</span>
        {!open && peek && <span className="apv-peek">{peek}</span>}
        <span className={`caret${open ? " open" : ""}`} aria-hidden>›</span>
      </button>
      {open && (
        <div className="apv-list">
          {it.items.map((p) => {
            const d = (p.detail ?? {}) as { command?: unknown; path?: unknown };
            const choice = approvalChoice(p);
            const cmd = typeof d.command === "string" && d.command.trim() ? d.command.trim() : "";
            const path = !cmd && typeof d.path === "string" && d.path.trim() ? d.path.trim() : "";
            const answer = p.status === "pending"
              ? t("timeline.autoApproved.pending")
              : tf("timeline.autoApproved.answer", { opt: choice ?? t("timeline.permAllowed") });
            return (
              <div key={p.requestId} className="apv-row" title={[p.title, cmd || path, answer].filter(Boolean).join("\n")}>
                <span className="ts-ic" aria-hidden><Icon name={p.status === "pending" ? "hourglass" : "check"} size={13} /></span>
                {cmd ? <span className="apv-cmd">{cmd}</span>
                  : path ? <span className="apv-path">{path}</span>
                  : <span className="apv-title">{p.title}</span>}
                <span className="apv-meta">{answer}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** 1.3 upgrade (#727 review 3): a 1.2 全部放行 that did nothing for this Agent was not turned into real auto-approval */
export const AUTO_UPGRADE_CODES = new Set(["auto_approve_upgrade", "auto_approve_migrated"]);

export function AutoUpgradeNotice({ it, threadId }: { it: Extract<DisplayItem, { kind: "notice" }>; threadId: string }) {
  const [busy, setBusy] = useState(false);
  const migrated = it.code === "auto_approve_migrated";
  const turnOn = () => {
    setBusy(true);
    void ws.call("thread.setMode", { id: threadId, mode: "bypassPermissions" }).catch(() => {}).finally(() => setBusy(false));
  };
  return (
    <div className="nt nt-auto" data-testid="auto-upgrade-notice" role="note">
      <div className="nt-auto-h">
        <span className="apv-ic"><Icon name="shieldCheck" size={14} /></span>
        <b>{t("timeline.autoUpgrade.title")}</b>
      </div>
      <div>{t(migrated ? "timeline.autoUpgrade.migrated" : "timeline.autoUpgrade.body")}</div>
      <div className="nt-actions">
        <button type="button" className="btn" disabled={busy} onClick={turnOn}>{t("timeline.autoUpgrade.turnOn")}</button>
        <button type="button" className="btn" onClick={() => window.dispatchEvent(new Event("open-settings"))}>{t("timeline.autoUpgrade.settings")}</button>
      </div>
    </div>
  );
}
