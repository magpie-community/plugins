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
  it("an Agent's own name for full-auto goes to the hint, the label stays 全部自动同意", () => {
    const m = composerModeOptions("codex", ["default", "acceptEdits", "bypassPermissions"], { default: "Read Only", acceptEdits: "Auto", bypassPermissions: "Full Access" });
    const auto = m.find((x) => x.id === "bypassPermissions")!;
    expect(auto.label).toBe("全部自动同意");
    expect(auto.desc).toContain("完全访问");
    expect(m.find((x) => x.id === "default")?.label).toBe("只读");
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
