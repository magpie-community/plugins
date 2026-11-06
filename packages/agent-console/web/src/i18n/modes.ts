import type { Mode } from "../types/models.js";
import { t } from "./index.js";

/** auto: 全部自动同意 (bypassPermissions), drawn with the shield-check in the warning colour (#727 review 1) */
export type PermissionModeOption = { id: Mode; label: string; desc: string; danger?: boolean; auto?: boolean };

const AUTO_DESC_IDS = new Set(["claude", "codex", "copilot", "devin", "cursor", "opencode", "pi"]);
const PER_REQUEST_AUTO_IDS = new Set(["cursor", "opencode", "dsh"]);

/** What 全部自动同意 really does for this Agent: sandbox off / skips all permission checks / the console answers allow-once */
export function autoModeDesc(providerId: string | undefined): string {
  return t(`composer.autoDesc.${providerId && AUTO_DESC_IDS.has(providerId) ? providerId : "generic"}`);
}

export function autoApproveBannerDesc(providerId: string | undefined): string {
  const desc = autoModeDesc(providerId);
  return !providerId || !AUTO_DESC_IDS.has(providerId) || PER_REQUEST_AUTO_IDS.has(providerId)
    ? `${desc}\n${t("composer.autoOn.keeps")}`
    : desc;
}

export const FULL_AUTO: Mode = "bypassPermissions";

export function permissionModes(): PermissionModeOption[] {
  return [
    { id: "plan", label: t("composer.mode.plan.label"), desc: t("composer.mode.plan.desc") },
    { id: "default", label: t("composer.mode.default.label"), desc: t("composer.mode.default.desc") },
    { id: "acceptEdits", label: t("composer.mode.acceptEdits.label"), desc: t("composer.mode.acceptEdits.desc") },
    { id: "bypassPermissions", label: t("composer.mode.bypass.label"), desc: t("composer.mode.bypass.desc"), auto: true },
  ];
}

/** Cursor Agent CLI: Agent / Plan / Ask (maps to --mode and the ACP session mode) */
export function cursorExecutionModes(): PermissionModeOption[] {
  return [
    { id: "default", label: t("composer.mode.cursorAgent.label"), desc: t("composer.mode.cursorAgent.desc") },
    { id: "bypassPermissions", label: t("composer.mode.cursorBypass.label"), desc: t("composer.mode.cursorBypass.desc"), auto: true },
    { id: "plan", label: t("composer.mode.cursorPlan.label"), desc: t("composer.mode.cursorPlan.desc") },
    { id: "ask", label: t("composer.mode.cursorAsk.label"), desc: t("composer.mode.cursorAsk.desc") },
  ];
}

export function composerModeOptions(
  providerId: string | undefined,
  allowed: Mode[],
  labels?: Partial<Record<Mode, string>>,
): PermissionModeOption[] {
  const base = providerId === "cursor" ? cursorExecutionModes() : permissionModes();
  // As in Paseo: when an Agent has its own mode names, use them (Copilot shows Agent rather than Always Ask).
  // 1.3: 全部自动同意 keeps one name for every Agent; the description says what it does for that Agent.
  return base
    .filter((m) => allowed.includes(m.id))
    .map((m) => {
      // Pi still runs without tool approvals, but its persisted id stays default so it cannot arm another Agent.
      if (providerId === "pi" && m.id === "default") {
        return { ...m, label: t("composer.mode.pi.label"), desc: t("composer.mode.pi.desc"), auto: true };
      }
      // #727 review 1: the hint says plainly what the Agent's own switch does (Codex: sandbox off; Claude: skips all checks)
      if (m.id === FULL_AUTO) return { ...m, desc: autoModeDesc(providerId) };
      return labels?.[m.id] ? { ...m, label: agentModeLabel(labels[m.id]!) } : m;
    });
}

/** An Agent's own mode name (from the daemon, English) in the UI language when we know it */
export function agentModeLabel(name: string): string {
  const v = t(`composer.agentMode.${name}`);
  return v.startsWith("composer.agentMode.") ? name : v;
}

/** Reasoning effort id → short label in the UI language (unknown ids are shown as given) */
export function effortLabel(id: string, fallback?: string): string {
  const v = t(`composer.effort.${id}`);
  return v.startsWith("composer.effort.") ? fallback ?? id : v;
}
