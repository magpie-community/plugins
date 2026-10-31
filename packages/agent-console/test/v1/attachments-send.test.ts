import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentStore } from "../../daemon/src/store/attachments.js";
import { resolveAttachmentRefs, resolveImagePath, bindAttachmentStore } from "../../daemon/src/util/attachmentRefs.js";

describe("resolveAttachmentRefs", () => {
  it("resolves an upload id to an absolute path under the attachments directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-att-"));
    const store = new AttachmentStore(join(dir, "attachments"));
    const saved = await store.save("x.png", Buffer.from("png"));
    const resolved = await resolveAttachmentRefs(store, [{ path: saved.id, mime: "image/png" }]);
    expect(resolved).toEqual([{ path: saved.path, mime: "image/png" }]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolveImagePath resolves an id to a path on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-att2-"));
    const store = new AttachmentStore(join(dir, "attachments"));
    bindAttachmentStore(store);
    const saved = await store.save("pic.png", Buffer.from("png"));
    const disk = await resolveImagePath(saved.id);
    expect(disk).toBe(saved.path);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a stale attachment id throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-att3-"));
    const store = new AttachmentStore(join(dir, "attachments"));
    bindAttachmentStore(store);
    await expect(resolveAttachmentRefs(store, [{ path: "a_nope", mime: "image/png" }])).rejects.toThrow(/失效/);
    rmSync(dir, { recursive: true, force: true });
  });
});
