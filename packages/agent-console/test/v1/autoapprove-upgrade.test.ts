// 1.3 全部自动同意 upgrade (#727 review 3): a 1.2 全部放行 never becomes real auto-approval silently for the Agents it
// did nothing for in 1.2 (Cursor / OpenCode / dsh); Claude / Codex keep it (it meant the same there).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadsStore } from "../../daemon/src/store/threads.js";
import { SettingsStore, parseSettingsPatch } from "../../daemon/src/store/settings.js";
import {
  migrateAutoApprove13, guardLegacyMode, endLegacyDefault, LEGACY_NO_AUTO, MIGRATED_NOTICE_CODE, upgradeNotice, UPGRADE_NOTICE_CODE,
} from "../../daemon/src/migrate/autoApprove13.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ac-up-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

const stores = () => ({ settings: new SettingsStore(dir), threads: new ThreadsStore(dir) });

describe("migrateAutoApprove13", () => {
  it("an upgraded 1.2 user: Cursor/OpenCode/dsh conversations in bypass go back to 每次询问 with a notice; others keep it", async () => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultMode: "bypassPermissions", v1Migrated: true }));
    const s = stores();
    const mk = (provider: string, mode: "bypassPermissions" | "default") => s.threads.create({ projectId: "p", provider, mode });
    const cur = await mk("cursor", "bypassPermissions");
    const oc = await mk("opencode", "bypassPermissions");
    const dsh = await mk("dsh", "bypassPermissions");
    const cl = await mk("claude", "bypassPermissions");
    const cx = await mk("codex", "bypassPermissions");
    const curDef = await mk("cursor", "default");
    const r = await migrateAutoApprove13(s);
    expect(r.skipped).toBe(false);
    expect(r.legacyDefault).toBe(true);
    expect(r.threads.sort()).toEqual([cur.id, oc.id, dsh.id].sort());
    for (const t of [cur, oc, dsh]) {
      expect((await s.threads.get(t.id))?.mode).toBe("default");
      const evs = await s.threads.readEvents(t.id, 0, 10);
      expect(evs.map((e) => (e as { code?: string }).code)).toEqual([MIGRATED_NOTICE_CODE]);
    }
    for (const t of [cl, cx]) expect((await s.threads.get(t.id))?.mode).toBe("bypassPermissions");
    expect((await s.threads.readEvents(curDef.id, 0, 10)).length).toBe(0);
    // runs once
    const again = await migrateAutoApprove13(stores());
    expect(again.skipped).toBe(true);
  });

  it("a fresh install (or a default that is not 全部放行) has nothing to guard", async () => {
    const s = stores();
    const r = await migrateAutoApprove13(s);
    expect(r.legacyDefault).toBe(false);
    expect(await guardLegacyMode(s.settings, "cursor", "bypassPermissions")).toEqual({ mode: "bypassPermissions", notice: false });
  });
});

describe("guardLegacyMode", () => {
  it("new Cursor/OpenCode/dsh conversations from a 1.2 全部放行 default start in 每次询问; told once; Claude unaffected", async () => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultMode: "bypassPermissions" }));
    const s = stores();
    await migrateAutoApprove13(s);
    expect(await guardLegacyMode(s.settings, "claude", "bypassPermissions")).toEqual({ mode: "bypassPermissions", notice: false });
    expect(await guardLegacyMode(s.settings, "codex", "bypassPermissions")).toEqual({ mode: "bypassPermissions", notice: false });
    expect(await guardLegacyMode(s.settings, "cursor", "bypassPermissions")).toEqual({ mode: "default", notice: true });
    expect(await guardLegacyMode(s.settings, "opencode", "bypassPermissions")).toEqual({ mode: "default", notice: false });
    expect(await guardLegacyMode(s.settings, "dsh", "bypassPermissions")).toEqual({ mode: "default", notice: false });
    expect(await guardLegacyMode(s.settings, "cursor", "plan")).toEqual({ mode: "plan", notice: false });
    // survives a daemon restart
    expect(await guardLegacyMode(new SettingsStore(dir), "cursor", "bypassPermissions")).toEqual({ mode: "default", notice: false });
    // the user picks the default again in Settings (a 1.3 decision): from then on it is honoured
    await endLegacyDefault(s.settings);
    expect(await guardLegacyMode(s.settings, "cursor", "bypassPermissions")).toEqual({ mode: "bypassPermissions", notice: false });
  });

  it("the guard state can't be set from the page, and the notice has its code", () => {
    expect(parseSettingsPatch({ autoApproveUpgrade: { done: true, legacyDefault: false, noticed: true } }).ok).toBe(false);
    expect(upgradeNotice().code).toBe(UPGRADE_NOTICE_CODE);
    expect([...LEGACY_NO_AUTO].sort()).toEqual(["cursor", "dsh", "opencode"]);
  });
});
