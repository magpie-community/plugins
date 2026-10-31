// Legacy migration unit test (§10.1): build an old layout → migrateLegacy → check the new threads/projects/settings.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacy } from "../../daemon/src/migrate/legacy.js";
import { SettingsStore } from "../../daemon/src/store/settings.js";
import { ProjectsStore } from "../../daemon/src/store/projects.js";
import { ThreadsStore } from "../../daemon/src/store/threads.js";

let dir: string;
let realCwd: string;

async function seed() {
  dir = await mkdtemp(join(tmpdir(), "ac-migrate-"));
  realCwd = join(dir, "proj-a");
  await mkdir(realCwd, { recursive: true });
  // Old settings.json (with a projects list and UI preferences)
  await writeFile(join(dir, "settings.json"), JSON.stringify({
    defaultAgent: "codex", defaultPermission: "auto", sendKey: "ctrlEnter", showThinking: false, theme: "dark",
    projects: [{ name: "A 项目", path: realCwd }],
  }));
  const sdir = join(dir, "sessions");
  // Session 1: normal (tool.call+result, text, run.end)
  await mkdir(join(sdir, "s_aaa"), { recursive: true });
  await writeFile(join(sdir, "s_aaa", "meta.json"), JSON.stringify({
    id: "s_aaa", agent: "claude", cwd: realCwd, model: "sonnet", permission: "default",
    title: "正常会话", titleAuto: false, pinned: true, cliSessionId: "cli-123",
    created: 1700000000000, updated: 1700000100000, lastStatus: "ok",
    totalCost: 0.12, totalUsage: { inputTokens: 100, outputTokens: 50 },
  }));
  await writeFile(join(sdir, "s_aaa", "events.jsonl"), [
    JSON.stringify({ type: "user", text: "看下代码" }),
    JSON.stringify({ type: "text", text: "好的" }),
    JSON.stringify({ type: "thinking", text: "先读文件" }),
    JSON.stringify({ type: "tool.call", itemId: "c1", kind: "read", title: "读 a.ts" }),
    JSON.stringify({ type: "tool.result", itemId: "c1", ok: true, output: "content" }),
    JSON.stringify({ type: "todo", items: [{ text: "改", status: "done" }, { text: "测", status: "pending" }] }),
    JSON.stringify({ type: "run.end", status: "ok", ms: 5000, usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.01 }),
    "坏行{",
  ].join("\n"));
  // Session 2: test title → archived; orphan cwd (nonexistent directory → no project added → skipped)
  await mkdir(join(sdir, "s_bbb"), { recursive: true });
  await writeFile(join(sdir, "s_bbb", "meta.json"), JSON.stringify({
    id: "s_bbb", agent: "claude", cwd: join(dir, "gone-dir"), permission: "default",
    title: "/slow 测试", titleAuto: true, pinned: false, cliSessionId: null,
    created: 1, updated: 2,
  }));
  await writeFile(join(sdir, "s_bbb", "events.jsonl"), JSON.stringify({ type: "user", text: "x" }));
  // Session 3: orphan cwd = a project subdirectory → folded into the parent project
  await mkdir(join(realCwd, "sub"), { recursive: true });
  await mkdir(join(sdir, "s_ccc"), { recursive: true });
  await writeFile(join(sdir, "s_ccc", "meta.json"), JSON.stringify({
    id: "s_ccc", agent: "unknown-agent", cwd: join(realCwd, "sub"), permission: "full",
    title: "子目录会话", titleAuto: true, pinned: false, cliSessionId: "zzz",
    created: 3, updated: 4,
  }));
  await writeFile(join(sdir, "s_ccc", "events.jsonl"), JSON.stringify({ type: "text", text: "hi" }));
  return dir;
}

beforeEach(async () => { await seed(); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("migrateLegacy", () => {
  it("migrates sessions/projects/settings, backs up the old directory, sets v1Migrated", async () => {
    const stores = { settings: new SettingsStore(dir), projects: new ProjectsStore(dir), threads: new ThreadsStore(dir) };
    const r = await migrateLegacy(dir, stores);
    expect(r.migrated).toBe(2); // s_aaa + s_ccc (s_bbb's cwd doesn't exist and is skipped)

    const projs = await stores.projects.list();
    expect(projs).toHaveLength(1);
    expect(projs[0].name).toBe("A 项目");

    const threads = await stores.threads.list();
    expect(threads).toHaveLength(2);
    const t1 = threads.find((t) => t.title === "正常会话")!;
    expect(t1.provider).toBe("claude");
    expect(t1.providerSessionId).toBe("cli-123");
    expect(t1.status).toBe("closed");
    expect(t1.pinned).toBe(true);
    expect(t1.archived).toBe(false);
    expect(t1.mode).toBe("default");
    expect(t1.usage.costUsd).toBeCloseTo(0.12);
    expect(t1.importedFrom).toEqual({ provider: "claude", sessionId: "cli-123" });

    const evs = await stores.threads.readEvents(t1.id);
    const types = evs.map((e) => e.type);
    expect(types).toEqual(["user_message", "assistant_message", "reasoning", "tool_call", "tool_call", "todo", "usage", "turn_ended"]);
    const calls = evs.filter((e) => e.type === "tool_call");
    expect((calls[0] as { status: string }).status).toBe("running");
    expect((calls[1] as { status: string }).status).toBe("ok");
    expect((calls[1] as { output?: string }).output).toBe("content");
    const end = evs.find((e) => e.type === "turn_ended") as { status: string; durationMs?: number };
    expect(end.status).toBe("completed");
    expect(end.durationMs).toBe(5000);
    const seqs = evs.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs); // Strictly increasing

    const t3 = threads.find((t) => t.title === "子目录会话")!;
    expect(t3.provider).toBe("mock"); // Unknown agent
    expect(t3.archived).toBe(true);
    expect(t3.mode).toBe("bypassPermissions"); // full mapping
    expect(t3.projectId).toBe(projs[0].id); // Subdirectory folded into its parent

    const s = await stores.settings.get();
    expect(s.v1Migrated).toBe(true);
    expect(s.theme).toBe("dark");
    expect(s.sendKey).toBe("ctrlEnter");
    expect(s.showThinking).toBe(false);
    expect(s.defaultProvider).toBe("codex");
    expect(s.defaultMode).toBe("acceptEdits"); // auto mapping

    // Backup exists, old files untouched
    const trash = join(dir, "trash");
    expect(existsSync(trash)).toBe(true);
    expect(existsSync(join(dir, "sessions", "s_aaa", "meta.json"))).toBe(true);
  });

  it("runs again: skipped after v1Migrated", async () => {
    const stores = { settings: new SettingsStore(dir), projects: new ProjectsStore(dir), threads: new ThreadsStore(dir) };
    await migrateLegacy(dir, stores);
    const r2 = await migrateLegacy(dir, stores);
    expect(r2.skipped).toBe(true);
    expect(r2.migrated).toBe(0);
    expect(await stores.threads.list()).toHaveLength(2);
  });

  it("empty data directory: sets v1Migrated and returns skipped", async () => {
    const empty = await mkdtemp(join(tmpdir(), "ac-mig-empty-"));
    try {
      const stores = { settings: new SettingsStore(empty), projects: new ProjectsStore(empty), threads: new ThreadsStore(empty) };
      const r = await migrateLegacy(empty, stores);
      expect(r).toEqual({ migrated: 0, skipped: true });
      expect((await stores.settings.get()).v1Migrated).toBe(true);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
