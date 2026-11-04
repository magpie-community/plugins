import type { Mode } from "../types/models.js";
import { t } from "./index.js";

export type PermissionModeOption = { id: Mode; label: string; desc: string; danger?: boolean };

export function permissionModes(): PermissionModeOption[] {
  return [
    { id: "plan", label: t("composer.mode.plan.label"), desc: t("composer.mode.plan.desc") },
    { id: "default", label: t("composer.mode.default.label"), desc: t("composer.mode.default.desc") },
    { id: "acceptEdits", label: t("composer.mode.acceptEdits.label"), desc: t("composer.mode.acceptEdits.desc") },
    { id: "bypassPermissions", label: t("composer.mode.bypass.label"), desc: t("composer.mode.bypass.desc"), danger: true },
  ];
}

/** Cursor Agent CLI: Agent / Plan / Ask (maps to --mode and the ACP session mode) */
export function cursorExecutionModes(): PermissionModeOption[] {
  return [
    { id: "default", label: t("composer.mode.cursorAgent.label"), desc: t("composer.mode.cursorAgent.desc") },
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
  // As in Paseo: when an Agent has its own mode names, use them (Copilot shows Agent rather than Always Ask)
  return base
    .filter((m) => allowed.includes(m.id))
    .map((m) => (labels?.[m.id] ? { ...m, label: agentModeLabel(labels[m.id]!) } : m));
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
