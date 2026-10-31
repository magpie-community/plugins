// GitService tests (§5.8 + §11.1): git init in a temp directory → status/diff/discard, untracked → trash/discarded
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { GitService } from "../../daemon/src/git/service.js";

let dir = "";
let dataDir = "";
const git = new GitService();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ac-git-"));
  dataDir = join(dir, "data");
  const g = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
  g(["init"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "line1\nline2\n");
  g(["add", "a.txt"]);
  g(["commit", "-m", "init"]);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("git.status", () => {
  it("not a repository → isRepo:false", async () => {
    const d = mkdtempSync(join(tmpdir(), "ac-nogit-"));
    try {
      const r = await git.status(d);
      expect(r.isRepo).toBe(false);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("inside a repo: clean → empty files; changes + untracked → classified correctly", async () => {
    const clean = await git.status(dir);
    expect(clean.isRepo).toBe(true);
    expect(clean.branch).toBeTruthy();
    expect(clean.files ?? []).toHaveLength(0);

    writeFileSync(join(dir, "a.txt"), "line1\nline2\nline3\n");
    writeFileSync(join(dir, "new.txt"), "brand new\n");
    const r = await git.status(dir);
    expect(r.files?.some((f) => f.path === "a.txt" && f.kind === "modified")).toBe(true);
    expect(r.files?.some((f) => f.path === "new.txt" && f.kind === "untracked")).toBe(true);
  });
});

describe("git.diff", () => {
  it("tracked change → unified diff text with +/-", async () => {
    const r = await git.diff(dir, "a.txt");
    expect(r.diff).toBeTruthy();
    expect(r.diff).toContain("+line3");
  });

  it("untracked file → untracked:true + all-added diff", async () => {
    const r = await git.diff(dir, "new.txt");
    expect(r.untracked).toBe(true);
    expect(r.diff).toContain("+brand new");
  });

  it("path outside the project → error", async () => {
    const r = await git.diff(dir, "../outside.txt");
    expect(r.error).toBeTruthy();
    expect(r.diff).toBeUndefined();
  });
});

describe("git.discard", () => {
  it("tracked → git restore brings back the original content", async () => {
    const r = await git.discard(dir, "a.txt", dataDir);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(dir, "a.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("line1\nline2\n");
    const st = await git.status(dir);
    expect(st.files?.some((f) => f.path === "a.txt")).toBe(false);
  });

  it("untracked → moved to trash/discarded/<ts>/ and gone from the project", async () => {
    const r = await git.discard(dir, "new.txt", dataDir);
    expect(r.ok).toBe(true);
    expect(r.trashedTo).toContain("trash");
    expect(r.trashedTo).toContain("discarded");
    expect(existsSync(join(dir, "new.txt"))).toBe(false);
    expect(existsSync(r.trashedTo!)).toBe(true);
    expect(readFileSync(r.trashedTo!, "utf8")).toBe("brand new\n");
  });

  it("nonexistent file → error", async () => {
    const r = await git.discard(dir, "ghost.txt", dataDir);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});
