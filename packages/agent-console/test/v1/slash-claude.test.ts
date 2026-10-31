import { describe, expect, it } from "vitest";
import { classifyClaudeSlashCommand, parseSlashInput, sortSlashCommands } from "../../daemon/src/providers/slash.js";

describe("classifyClaudeSlashCommand", () => {
  it("marks built-ins as command", () => {
    for (const n of ["clear", "compact", "context", "usage", "init", "debug"]) {
      expect(classifyClaudeSlashCommand(n)).toBe("command");
    }
  });
  it("marks other names as skill", () => {
    expect(classifyClaudeSlashCommand("review")).toBe("skill");
    expect(classifyClaudeSlashCommand("commit")).toBe("skill");
  });
});

describe("parseSlashInput", () => {
  it("parses name and args", () => {
    expect(parseSlashInput("/compact")).toEqual({ name: "compact", args: "", raw: "/compact" });
    expect(parseSlashInput("/review src/foo.ts")).toEqual({
      name: "review",
      args: "src/foo.ts",
      raw: "/review src/foo.ts",
    });
  });
});

describe("sortSlashCommands", () => {
  it("sorts commands before skills", () => {
    const sorted = sortSlashCommands([
      { name: "b", description: "", kind: "skill" },
      { name: "a", description: "", kind: "command" },
    ]);
    expect(sorted.map((c) => c.name)).toEqual(["a", "b"]);
  });
});
