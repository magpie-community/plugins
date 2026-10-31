import { describe, expect, it } from "vitest";
import {
  applySlashPick,
  clampSlashIndex,
  filterSlashCommands,
  selectableSlashRows,
  slashMenuRows,
  slashMenuState,
  type SlashCommand,
} from "./slashMenu";

const sample: SlashCommand[] = [
  { name: "compact", description: "Compact context", kind: "command" },
  { name: "review", description: "Review skill", kind: "skill", argumentHint: "<path>" },
  { name: "clear", description: "Clear", kind: "command" },
];

describe("slashMenuState", () => {
  it("opens on leading slash without args", () => {
    expect(slashMenuState("/comp")).toEqual({ open: true, query: "comp" });
    expect(slashMenuState("/")).toEqual({ open: true, query: "" });
  });
  it("closes after space or newline", () => {
    expect(slashMenuState("/compact x")).toEqual({ open: false, query: "" });
    expect(slashMenuState("/a\nb")).toEqual({ open: false, query: "" });
  });
  it("respects suppress flag", () => {
    expect(slashMenuState("/x", true)).toEqual({ open: false, query: "" });
  });
});

describe("filterSlashCommands", () => {
  it("filters by name and description", () => {
    expect(filterSlashCommands(sample, "comp").map((c) => c.name)).toEqual(["compact"]);
    expect(filterSlashCommands(sample, "review").map((c) => c.name)).toEqual(["review"]);
  });
});

describe("slashMenuRows", () => {
  it("groups commands before skills", () => {
    const rows = slashMenuRows(sample);
    expect(rows[0]).toMatchObject({ type: "heading", labelKey: "slashGroupCommand" });
    const items = selectableSlashRows(rows);
    expect(items.map((c) => c.name)).toEqual(["compact", "clear", "review"]);
  });
});

describe("applySlashPick", () => {
  it("inserts trailing space", () => {
    expect(applySlashPick("compact")).toBe("/compact ");
  });
});

describe("clampSlashIndex", () => {
  it("wraps selection", () => {
    expect(clampSlashIndex(-1, 3)).toBe(2);
    expect(clampSlashIndex(3, 3)).toBe(0);
  });
});

describe("slashEnterSends", () => {
  it("sends when the text already is the full command", async () => {
    const { slashEnterSends } = await import("./slashMenu");
    expect(slashEnterSends("/slow", "slow")).toBe(true);
    expect(slashEnterSends("/sl", "slow")).toBe(false);
    expect(slashEnterSends("/slow", undefined)).toBe(false);
  });
});
