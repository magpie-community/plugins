// Attachments: write uploaded files to disk, look up paths by id.
import { writeFile, mkdir, stat, readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { randomBytes } from "node:crypto";
import { validId } from "../util/paths.js";

const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const TEXT_EXT = new Set([".txt", ".md", ".log", ".json", ".csv", ".xml", ".yaml", ".yml", ".html", ".css", ".js", ".ts", ".py", ".toml", ".ini", ".conf"]);
const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export type Attachment = { id: string; name: string; mime: string; size: number; path: string };

// Text attachments are declared UTF-8 so Chinese text isn't garbled when opened in a browser (nosniff + text/plain, so HTML is never executed)
const TEXT_MIME = "text/plain; charset=utf-8";

export class AttachmentStore {
  // id → file name: avoids a readdir of the whole directory on every lookup (slow with many attachments)
  private files = new Map<string, string>();
  constructor(private dir: string) {}

  private safeExt(name: string): string | null {
    const ext = extname(name).toLowerCase();
    if (IMG_EXT.has(ext) || TEXT_EXT.has(ext)) return ext;
    if (!ext) return ".txt";
    return null;
  }

  allowedExt(name: string): boolean {
    return this.safeExt(name) !== null;
  }

  async save(name: string, data: Buffer): Promise<Attachment> {
    const ext = this.safeExt(name);
    if (!ext) throw new Error("不支持的文件类型");
    const id = "a_" + Date.now().toString(36) + randomBytes(3).toString("hex");
    await mkdir(this.dir, { recursive: true });
    const file = join(this.dir, id + ext);
    await writeFile(file, data);
    this.files.set(id, id + ext);
    const mime = MIME[ext] ?? TEXT_MIME;
    return { id, name: name || "未命名" + ext, mime, size: data.length, path: file };
  }

  async get(id: string): Promise<Attachment | null> {
    if (!validId(id)) return null;
    const known = this.files.get(id);
    if (known) {
      const hit = await this.describe(id, known);
      if (hit) return hit;
      this.files.delete(id);
    }
    const { readdir } = await import("node:fs/promises");
    try {
      for (const f of await readdir(this.dir)) {
        if (f.startsWith(id + ".")) {
          this.files.set(id, f);
          return await this.describe(id, f);
        }
      }
    } catch {}
    return null;
  }

  private async describe(id: string, f: string): Promise<Attachment | null> {
    const p = join(this.dir, f);
    const s = await stat(p).catch(() => null);
    if (!s?.isFile()) return null;
    const ext = extname(f).toLowerCase();
    return { id, name: f.slice(id.length + 1) || f, mime: MIME[ext] ?? TEXT_MIME, size: s.size, path: p };
  }

  async read(id: string): Promise<Buffer | null> {
    const a = await this.get(id);
    if (!a) return null;
    return readFile(a.path);
  }
}
