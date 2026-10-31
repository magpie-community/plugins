import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expandCodexSlash, loadCodexSlashEntries } from "../../daemon/src/providers/codex/commands.js";

describe("loadCodexSlashEntries", () => {
  it("reads project prompts and skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "ac-codex-slash-"));
    try {
    await mkdir(join(root, ".codex", "prompts"), { recursive: true });
    await mkdir(join(root, ".codex", "skills", "demo-skill"), { recursive: true });
    await writeFile(
      join(root, ".codex", "prompts", "hello.md"),
      "---\ndescription: Say hi\n---\nDo hello with $ARGUMENTS\n",
    );
    await writeFile(
      join(root, ".codex", "skills", "demo-skill", "SKILL.md"),
      "---\nname: demo-skill\ndescription: Demo skill\n---\nSkill body $ARGUMENTS\n",
    );
    const entries = await loadCodexSlashEntries(root, { skipHome: true });
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(["demo-skill", "hello"]);
    const expanded = expandCodexSlash("/hello world", entries);
    expect(expanded).toContain("Do hello with world");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
