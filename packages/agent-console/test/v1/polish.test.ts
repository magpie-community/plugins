// Small functional fixes: file preview decoding, attachment MIME / caching, file tree .gitignore invalidation.
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeText, FileService } from "../../daemon/src/files/service.js";
import { AttachmentStore } from "../../daemon/src/store/attachments.js";

describe("decodeText", () => {
  it("UTF-8 (BOM stripped)", () => {
    expect(decodeText(Buffer.from("\ufeff中文", "utf8"))).toEqual({ text: "中文", encoding: "utf8" });
  });
  it("invalid UTF-8 is decoded as GBK (old files on Chinese Windows)", () => {
    expect(decodeText(Buffer.from("d6d0cec4", "hex"))).toEqual({ text: "中文", encoding: "gbk" });
  });
});

describe("FileService", () => {
  it("editing .gitignore takes effect in the file tree immediately; GBK files read without garbling", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-files-"));
    try {
      mkdirSync(join(dir, "build"));
      writeFileSync(join(dir, "a.txt"), Buffer.from("d6d0cec4", "hex"));
      writeFileSync(join(dir, ".gitignore"), "");
      const fs = new FileService();
      let names = (await fs.tree(dir, ".")).entries!.map((e) => e.name);
      expect(names).toContain("build");
      writeFileSync(join(dir, ".gitignore"), "build/\n");
      const later = new Date(Date.now() + 5000);
      utimesSync(join(dir, ".gitignore"), later, later);
      names = (await fs.tree(dir, ".")).entries!.map((e) => e.name);
      expect(names).not.toContain("build");
      expect(names[0]).toBe(".gitignore");
      const r = await fs.read(dir, "a.txt");
      expect(r).toMatchObject({ text: "中文", encoding: "gbk" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("AttachmentStore", () => {
  it("text attachments carry charset=utf-8; looking up an attachment by id does not depend on a directory scan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-att-"));
    try {
      const store = new AttachmentStore(dir);
      const a = await store.save("说明.md", Buffer.from("中文"));
      expect(a.mime).toBe("text/plain; charset=utf-8");
      expect((await store.get(a.id))?.size).toBe(6);
      const fresh = new AttachmentStore(dir);
      expect((await fresh.get(a.id))?.mime).toBe("text/plain; charset=utf-8");
      rmSync(a.path);
      expect(await store.get(a.id)).toBeNull();
      const img = await store.save("x.png", Buffer.from([1, 2, 3]));
      expect(img.mime).toBe("image/png");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
