// 1.3: the permission chip's options per Agent: 全部自动同意 everywhere, one name, the Agent's own name in the hint.
import { describe, it, expect, beforeEach } from "vitest";
import { setLocale } from "./index.js";
import { composerModeOptions, permissionModes } from "./modes.js";

describe("composerModeOptions", () => {
  beforeEach(() => { setLocale("zh"); });
  it("keeps 每次询问 and adds 全部自动同意 with the shield flag", () => {
    const all = permissionModes();
    expect(all.find((m) => m.id === "default")?.label).toBe("每次询问");
    const auto = all.find((m) => m.id === "bypassPermissions")!;
    expect(auto.label).toBe("全部自动同意");
    expect(auto.auto).toBe(true);
    expect(auto.danger).toBeFalsy(); // grayscale, not the red danger style
  });
  it("Cursor: Agent, 全部自动同意, 规划, 问答", () => {
    const m = composerModeOptions("cursor", ["default", "bypassPermissions", "plan", "ask"]);
    expect(m.map((x) => x.label)).toEqual(["Agent", "全部自动同意", "规划", "问答"]);
  });
  it("the hint says plainly what full-auto does for the Agent (#727 review 1); the label stays 全部自动同意", () => {
    const m = composerModeOptions("codex", ["default", "acceptEdits", "bypassPermissions"], { default: "Read Only", acceptEdits: "Auto", bypassPermissions: "Full Access" });
    const auto = m.find((x) => x.id === "bypassPermissions")!;
    expect(auto.label).toBe("全部自动同意");
    expect(auto.desc).toContain("沙箱关闭");
    expect(auto.desc).toContain("danger-full-access");
    expect(m.find((x) => x.id === "default")?.label).toBe("只读");
    const claude = composerModeOptions("claude", ["plan", "default", "acceptEdits", "bypassPermissions"]).find((x) => x.auto)!;
    expect(claude.desc).toContain("跳过所有权限检查");
    for (const p of ["cursor", "opencode", "dsh", "mock"]) {
      expect(composerModeOptions(p, ["default", "bypassPermissions"]).find((x) => x.auto)!.desc).toContain("允许一次");
    }
    setLocale("en");
    expect(composerModeOptions("codex", ["bypassPermissions"])[0]!.desc).toMatch(/sandbox off/i);
    expect(composerModeOptions("claude", ["bypassPermissions"])[0]!.desc).toMatch(/skips all permission checks/i);
  });
  it("Pi: one read-only mode with its own hint", () => {
    const m = composerModeOptions("pi", ["bypassPermissions"]);
    expect(m).toHaveLength(1);
    expect(m[0]!.desc).toContain("Pi");
  });
  it("English", () => {
    setLocale("en");
    expect(permissionModes().find((m) => m.id === "bypassPermissions")?.label).toBe("Auto-approve all");
  });
});
