import type { Mode } from "../types/models.js";
import { t } from "./index.js";

/** auto: 全部自动同意 (bypassPermissions), drawn with the grayscale shield-check */
export type PermissionModeOption = { id: Mode; label: string; desc: string; danger?: boolean; auto?: boolean };

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
  // 1.3: 全部自动同意 keeps one name for every Agent; the Agent's own name for it goes into the description.
  return base
    .filter((m) => allowed.includes(m.id))
    .map((m) => {
      if (m.id === FULL_AUTO) {
        if (providerId === "pi") return { ...m, desc: t("composer.mode.piBypass.desc") };
        const own = labels?.[m.id];
        return own ? { ...m, desc: `${m.desc} · ${agentModeLabel(own)}` } : m;
      }
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
