// P1-1: projects/threads/fs methods and store behavior
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectsStore } from "../../daemon/src/store/projects.js";
import { ThreadsStore } from "../../daemon/src/store/threads.js";
import { SettingsStore } from "../../daemon/src/store/settings.js";

let dir = "";
let projDir = "";
let projects: ProjectsStore;
let threads: ThreadsStore;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ac-p1-"));
  projDir = join(dir, "proj");
  mkdirSync(projDir, { recursive: true });
  projects = new ProjectsStore(dir);
  threads = new ThreadsStore(dir);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("projects", () => {
  it("create/dup/rename/remove", async () => {
    const p = await projects.create(projDir);
    expect(p.id).toMatch(/^p_/);
    expect(p.name).toBe("proj");
    const dup = await projects.create(projDir);
    expect(dup.id).toBe(p.id); // A duplicate path returns the existing one
    const r = await projects.rename(p.id, "  新名字  ");
    expect(r.name).toBe("新名字");
    await projects.remove(p.id);
    expect(await projects.get(p.id)).toBeNull();
  });
  it("nonexistent path → bad_path", async () => {
    await expect(projects.create(join(dir, "nope"))).rejects.toThrow(/不存在/);
  });
});

describe("threads", () => {
  it("create/get/patch/append/readEvents/delete→trash", async () => {
    const p = await projects.create(projDir);
    const t = await threads.create({ projectId: p.id, provider: "mock" });
    expect(t.status).toBe("idle");
    const t2 = await threads.patch(t.id, { title: "改名", pinned: true });
    expect(t2.title).toBe("改名");
    expect(t2.titleAuto).toBe(false);
    await threads.appendEvent(t.id, { seq: 1, ts: Date.now(), threadId: t.id, type: "user_message", text: "hi" });
    await threads.appendEvent(t.id, { seq: 2, ts: Date.now(), threadId: t.id, turnId: "u_1", type: "turn_ended", status: "completed" });
    const ev = await threads.readEvents(t.id);
    expect(ev.length).toBe(2);
    expect((await threads.get(t.id))?.seq).toBe(2);
    // afterSeq filtering
    const ev2 = await threads.readEvents(t.id, 1);
    expect(ev2.length).toBe(1);
    // Delete → moved to trash
    await threads.delete(t.id);
    expect(await threads.get(t.id)).toBeNull();
    expect(existsSync(join(dir, "trash", "threads"))).toBe(true);
    await projects.remove(p.id);
  });
});

describe("settings recentDirs", () => {
  it("get/set preserves unknown fields", async () => {
    const s = new SettingsStore(dir);
    const cur = await s.get();
    expect(cur.defaultProvider).toBe("claude");
    const next = await s.set({ recentDirs: ["a", "b"], weirdField: 1 } as never);
    expect(next.recentDirs).toEqual(["a", "b"]);
    const again = await new SettingsStore(dir).get();
    expect((again as { weirdField?: number }).weirdField).toBe(1); // Unknown fields are preserved
  });
});
