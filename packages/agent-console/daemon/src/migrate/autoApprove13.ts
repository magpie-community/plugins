// 1.3 全部自动同意 upgrade safety (#727 review 3).
//
// In 1.2, "bypassPermissions" (全部放行) only did something for Agents with a native switch (Claude, Codex, Copilot,
// Devin). Cursor and OpenCode had no such mode, so a saved default of bypassPermissions was clamped to "default" for
// them, and dsh accepted the mode but still asked for every tool. In 1.3 the daemon answers those Agents' approvals
// itself, so the same saved setting would silently start approving everything for them.
//
// Choice: never escalate silently. On the first 1.3 start:
// - conversations of those Agents stored in bypassPermissions go back to "default" (每次询问), each with a notice;
// - a pre-1.3 default of bypassPermissions is remembered as "legacy": new conversations of those Agents start in
//   "default" and the first one says once that the new mode exists (the user can switch it on there, explicitly).
// Choosing a default permission mode in Settings after the upgrade is a 1.3-era decision and ends the legacy state.
// Claude / Codex / Copilot / Devin keep bypassPermissions: for them 1.2 already meant the same thing.
import type { SettingsStore } from "../store/settings.js";
import type { ThreadsStore } from "../store/threads.js";
import type { Mode } from "../timeline/types.js";
import { FULL_AUTO } from "../providers/autoApprove.js";
import { tr } from "../util/i18n.js";
import { log } from "../log.js";

/** Agents for which 1.2's bypassPermissions did not auto-approve anything */
export const LEGACY_NO_AUTO = new Set(["cursor", "opencode", "dsh"]);
export const UPGRADE_NOTICE_CODE = "auto_approve_upgrade";
export const MIGRATED_NOTICE_CODE = "auto_approve_migrated";

/** Kept in settings.json; written only by the daemon (not in settingsPatchSchema, so the page cannot set it) */
export type AutoApproveUpgradeState = { done: true; legacyDefault: boolean; noticed: boolean };
const KEY = "autoApproveUpgrade";

function state(s: Record<string, unknown>): AutoApproveUpgradeState | null {
  const v = s[KEY] as Partial<AutoApproveUpgradeState> | undefined;
  return v && typeof v === "object" && v.done === true
    ? { done: true, legacyDefault: v.legacyDefault === true, noticed: v.noticed === true }
    : null;
}

/** Runs once, on the first start of a build with this code (fresh installs: nothing to do, just marks it done) */
export async function migrateAutoApprove13(stores: { settings: SettingsStore; threads: ThreadsStore }): Promise<{ threads: string[]; legacyDefault: boolean; skipped: boolean }> {
  const s = await stores.settings.get();
  if (state(s)) return { threads: [], legacyDefault: false, skipped: true };
  const moved: string[] = [];
  for (const t of await stores.threads.list()) {
    if (t.mode !== FULL_AUTO || !LEGACY_NO_AUTO.has(t.provider)) continue;
    try {
      await stores.threads.patch(t.id, { mode: "default" });
      await stores.threads.appendEvent(t.id, { type: "notice", level: "warn", code: MIGRATED_NOTICE_CODE, message: tr("notice.autoApproveMigrated") });
      moved.push(t.id);
    } catch (e) {
      log("warn", `全部自动同意迁移：对话 ${t.id} 失败：${String(e)}`);
    }
  }
  const legacyDefault = s.defaultMode === FULL_AUTO;
  await stores.settings.set({ [KEY]: { done: true, legacyDefault, noticed: false } satisfies AutoApproveUpgradeState });
  if (moved.length || legacyDefault) log("info", `全部自动同意迁移：${moved.length} 个对话改回每次询问；旧的默认全部放行=${legacyDefault}`);
  return { threads: moved, legacyDefault, skipped: false };
}

/**
 * The mode a new (or re-pointed) conversation of this Agent really starts in. A pre-1.3 default of bypassPermissions
 * does not turn into real auto-approval for Agents where it did nothing in 1.2; the first time, a notice says so.
 */
export async function guardLegacyMode(settings: SettingsStore, providerId: string, mode: Mode): Promise<{ mode: Mode; notice: boolean }> {
  if (mode !== FULL_AUTO || !LEGACY_NO_AUTO.has(providerId)) return { mode, notice: false };
  const s = await settings.get();
  const st = state(s);
  if (!st?.legacyDefault) return { mode, notice: false };
  if (st.noticed) return { mode: "default", notice: false };
  await settings.set({ [KEY]: { ...st, noticed: true } satisfies AutoApproveUpgradeState });
  return { mode: "default", notice: true };
}

/** The user picked a default permission mode in Settings: their 1.3 choice from now on */
export async function endLegacyDefault(settings: SettingsStore): Promise<void> {
  const st = state(await settings.get());
  if (st?.legacyDefault) await settings.set({ [KEY]: { ...st, legacyDefault: false } satisfies AutoApproveUpgradeState });
}

/** The one-time notice appended to the conversation the guard kept in 每次询问 */
export function upgradeNotice(): { type: "notice"; level: "info"; code: string; message: string } {
  return { type: "notice", level: "info", code: UPGRADE_NOTICE_CODE, message: tr("notice.autoApproveUpgrade") };
}
