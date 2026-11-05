// 1.3: per-Agent permission options and hints; Pi keeps the default id but clearly says it never asks.
import { describe, it, expect, beforeEach } from "vitest";
import { setLocale } from "./index.js";
import { autoApproveBannerDesc, composerModeOptions, permissionModes } from "./modes.js";

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
  it("Pi: one default-id mode labelled as never asking in both locales", () => {
    const m = composerModeOptions("pi", ["default"]);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ id: "default", label: "Pi 本身从不询问", auto: true });
    expect(m[0]!.desc).toContain("Pi 本身从不询问");
    setLocale("en");
    expect(composerModeOptions("pi", ["default"])[0]).toMatchObject({ id: "default", label: "Pi never asks", auto: true });
  });
  it("the banner's per-request explanation is limited to Agents that answer individual requests", () => {
    const phrase = "每次只同意当前这一个请求";
    for (const p of ["cursor", "opencode", "dsh", undefined, "mock"]) {
      expect(autoApproveBannerDesc(p), p).toContain(phrase);
    }
    for (const p of ["codex", "claude", "pi", "copilot", "devin"]) {
      expect(autoApproveBannerDesc(p), p).not.toContain(phrase);
    }
  });
  it("English", () => {
    setLocale("en");
    expect(permissionModes().find((m) => m.id === "bypassPermissions")?.label).toBe("Auto-approve all");
  });
});
