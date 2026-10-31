// store basics: atomic writes, corrupt JSONL lines skipped, attachment save/load
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic } from "../../daemon/src/util/atomic.js";
import { readJsonl, appendJsonl } from "../../daemon/src/util/jsonl.js";
import { AttachmentStore } from "../../daemon/src/store/attachments.js";
import { validId, isInside } from "../../daemon/src/util/paths.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ac-store-"));
}

describe("util", () => {
  it("writeJsonAtomic writes and reads back", async () => {
    const d = tmp();
    const f = join(d, "a.json");
    await writeJsonAtomic(f, { x: 1 });
    expect(JSON.parse(readFileSync(f, "utf8")).x).toBe(1);
    rmSync(d, { recursive: true, force: true });
  });

  it("jsonl append + corrupt lines skipped", async () => {
    const d = tmp();
    const f = join(d, "e.jsonl");
    await appendJsonl(f, { a: 1 });
    await appendJsonl(f, { b: 2 });
    writeFileSync(f, readFileSync(f, "utf8") + "not-json{{{\n" + JSON.stringify({ c: 3 }) + "\n");
    const rows = await readJsonl<{ a?: number; b?: number; c?: number }>(f);
    expect(rows.length).toBe(3);
    expect(rows[2].c).toBe(3);
    rmSync(d, { recursive: true, force: true });
  });

  it("concurrent jsonl appends keep order and lose nothing", async () => {
    const d = tmp();
    const f = join(d, "c.jsonl");
    await Promise.all(Array.from({ length: 30 }, (_, i) => appendJsonl(f, { i })));
    const rows = await readJsonl<{ i: number }>(f);
    expect(rows.length).toBe(30);
    rmSync(d, { recursive: true, force: true });
  });

  it("validId / isInside", () => {
    expect(validId("t_abc-123")).toBe(true);
    expect(validId("../evil")).toBe(false);
    expect(validId("a".repeat(81))).toBe(false);
    expect(isInside(join("a", "b", "c.txt"), join("a", "b"))).toBe(true);
    expect(isInside(join("a", "x.txt"), join("a", "b"))).toBe(false);
  });
});

describe("attachments", () => {
  it("save/read/invalid id", async () => {
    const d = tmp();
    const s = new AttachmentStore(join(d, "att"));
    const a = await s.save("pic.png", Buffer.from([1, 2, 3]));
    expect(a.id).toMatch(/^a_/);
    expect(existsSync(a.path)).toBe(true);
    expect((await s.get(a.id))?.size).toBe(3);
    expect(await s.get("../etc")).toBeNull();
    rmSync(d, { recursive: true, force: true });
  });
});
