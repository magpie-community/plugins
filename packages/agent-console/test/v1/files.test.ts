// FileService tests (§5.9 + §11.1): tree ignore rules, directories first, read refuses binary/oversized/out-of-bounds
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileService } from "../../daemon/src/files/service.js";

let dir = "";
const svc = new FileService();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ac-files-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "junk"), { recursive: true });
  mkdirSync(join(dir, ".git"), { recursive: true });
  mkdirSync(join(dir, "ignored-dir"), { recursive: true });
  writeFileSync(join(dir, "a.ts"), "const a = 1;\n");
  writeFileSync(join(dir, "z.md"), "# hi\n");
  writeFileSync(join(dir, "src", "b.py"), "print(1)\n");
  writeFileSync(join(dir, "skipped.log"), "noise\n");
  writeFileSync(join(dir, "ignored-dir", "x.txt"), "gone\n");
  writeFileSync(join(dir, ".gitignore"), "skipped.log\nignored-dir/\n");
  // Binary (contains \0) and oversized (>1MB)
  writeFileSync(join(dir, "bin.dat"), Buffer.from([0x89, 0x50, 0, 0x47, 1, 2]));
  writeFileSync(join(dir, "big.txt"), Buffer.alloc(1024 * 1024 + 1, 65));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("files.tree", () => {
  it("one level: .git/node_modules absent, .gitignore rules apply, directories first", async () => {
    const r = await svc.tree(dir, ".");
    const names = (r.entries ?? []).map((e) => e.name);
    expect(names).not.toContain(".git");
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain("skipped.log");
    expect(names).not.toContain("ignored-dir");
    expect(names).toContain("src");
    expect(names).toContain("a.ts");
    // Directories first
    const idxDir = names.indexOf("src");
    const idxFile = names.indexOf("a.ts");
    expect(idxDir).toBeGreaterThanOrEqual(0);
    expect(idxFile).toBeGreaterThan(idxDir);
  });

  it("subdirectories load lazily: dir=src lists only one level of src", async () => {
    const r = await svc.tree(dir, "src");
    const names = (r.entries ?? []).map((e) => e.name);
    expect(names).toEqual(["b.py"]);
  });

  it("out-of-bounds path → error", async () => {
    const r = await svc.tree(dir, "../../");
    expect(r.error).toBeTruthy();
  });
});

describe("files.read", () => {
  it("text → text + language by extension", async () => {
    const r = await svc.read(dir, "a.ts");
    expect(r.text).toBe("const a = 1;\n");
    expect(r.language).toBe("typescript");
  });

  it("binary (\\\\0 in the first 8KB) → binary:true", async () => {
    const r = await svc.read(dir, "bin.dat");
    expect(r.binary).toBe(true);
    expect(r.text).toBeUndefined();
  });

  it(">1MB → tooLarge:true", async () => {
    const r = await svc.read(dir, "big.txt");
    expect(r.tooLarge).toBe(true);
  });

  it("out-of-bounds path → error", async () => {
    const r = await svc.read(dir, "../outside.txt");
    expect(r.error).toBeTruthy();
  });

  it("directory → error", async () => {
    const r = await svc.read(dir, "src");
    expect(r.error).toBeTruthy();
  });
});
