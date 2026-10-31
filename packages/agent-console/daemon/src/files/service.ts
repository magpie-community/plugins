// FileService (§5.9): file tree (lazily, one level at a time) and file preview.
// tree: ignore .git/node_modules + the project root .gitignore (ignore library); directories first, sorted by name; ≤2000 per level.
// read: ≤1MB; a \0 in the first 8KB → {binary}; otherwise {text, language} (inferred from the extension).
import { readdir, readFile, stat } from "node:fs/promises";
import { join, normalize, sep, relative, extname } from "node:path";
import ignore from "ignore";
import { tr } from "../util/i18n.js";

export type TreeEntry = { name: string; path: string; isDir: boolean };
export type ReadResult = {
  text?: string;
  language?: string;
  encoding?: "utf8" | "gbk";
  binary?: boolean;
  tooLarge?: boolean;
  error?: string;
};

/** Text decoding: UTF-8 (BOM stripped); if it isn't valid UTF-8 try GBK once (old files on Chinese Windows), else lenient UTF-8. */
export function decodeText(buf: Buffer): { text: string; encoding: "utf8" | "gbk" } {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buf);
    return { text, encoding: "utf8" };
  } catch {}
  try {
    const text = new TextDecoder("gbk", { fatal: true }).decode(buf);
    return { text, encoding: "gbk" };
  } catch {}
  return { text: new TextDecoder("utf-8").decode(buf), encoding: "utf8" };
}

const MAX_READ = 1024 * 1024;
const MAX_PER_LEVEL = 2000;
const ALWAYS_IGNORE = new Set([".git", "node_modules"]);

const LANG: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
  ".mjs": "javascript", ".cjs": "javascript", ".json": "json", ".md": "markdown",
  ".py": "python", ".rs": "rust", ".go": "go", ".java": "java", ".c": "c", ".h": "c",
  ".cpp": "cpp", ".hpp": "cpp", ".cs": "csharp", ".css": "css", ".scss": "scss",
  ".html": "xml", ".htm": "xml", ".xml": "xml", ".svg": "xml", ".yaml": "yaml", ".yml": "yaml",
  ".toml": "ini", ".ini": "ini", ".sh": "bash", ".bash": "bash", ".ps1": "powershell",
  ".sql": "sql", ".lua": "lua", ".rb": "ruby", ".php": "php", ".swift": "swift",
  ".kt": "kotlin", ".vue": "xml", ".svelte": "xml", ".dockerfile": "dockerfile",
  ".txt": "plaintext", ".log": "plaintext",
};

function insidePath(projectPath: string, p: string): string | null {
  const rel = normalize(p || ".").replace(/\\/g, "/");
  const abs = normalize(join(projectPath, rel));
  const proj = normalize(projectPath);
  if (abs !== proj && !abs.startsWith(proj + sep)) return null;
  return rel;
}

export class FileService {
  // Cache an ignore instance per project (.gitignore changes are picked up on the next daemon restart; acceptable cost)
  // Invalidate by .gitignore mtime: an edited .gitignore takes effect the next time a directory is expanded
  private igCache = new Map<string, { mtime: number; ig: ReturnType<typeof ignore> | null }>();

  private async igFor(projectPath: string) {
    const gi = join(projectPath, ".gitignore");
    const st = await stat(gi).catch(() => null);
    const mtime = st?.isFile() ? st.mtimeMs : -1;
    const hit = this.igCache.get(projectPath);
    if (hit && hit.mtime === mtime) return hit.ig;
    let ig: ReturnType<typeof ignore> | null = null;
    if (mtime >= 0) {
      try {
        ig = ignore().add(await readFile(gi, "utf8"));
      } catch {
        ig = null;
      }
    }
    this.igCache.set(projectPath, { mtime, ig });
    return ig;
  }

  async tree(projectPath: string, dir: string): Promise<{ entries?: TreeEntry[]; error?: string }> {
    const rel = insidePath(projectPath, dir);
    if (rel === null) return { error: tr("fs.pathDenied") };
    const abs = join(projectPath, rel);
    const s = await stat(abs).catch(() => null);
    if (!s?.isDirectory()) return { error: tr("fs.dirMissing") };
    const ig = await this.igFor(projectPath);
    const dirents = await readdir(abs, { withFileTypes: true }).catch(() => null);
    if (!dirents) return { error: tr("fs.dirUnreadable") };
    const out: TreeEntry[] = [];
    for (const d of dirents) {
      if (out.length >= MAX_PER_LEVEL) break;
      const name = d.name;
      if (ALWAYS_IGNORE.has(name)) continue;
      const childRel = rel === "." ? name : `${rel}/${name}`;
      // Only symlinks / junctions get an extra stat (to see whether they point at a directory); large directories are no longer stat'ed entry by entry
      let isDir = d.isDirectory();
      if (d.isSymbolicLink()) {
        const st = await stat(join(projectPath, childRel)).catch(() => null);
        if (!st) continue;
        isDir = st.isDirectory();
      } else if (!d.isFile() && !isDir) {
        continue; // socket / fifo etc.
      }
      if (ig) {
        // The ignore library wants posix relative paths; directory rules need a trailing / to match directories
        if (ig.ignores(isDir ? childRel + "/" : childRel)) continue;
      }
      out.push({ name, path: childRel, isDir });
    }
    out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, "zh-CN") : a.isDir ? -1 : 1));
    return { entries: out };
  }

  async read(projectPath: string, p: string): Promise<ReadResult> {
    const rel = insidePath(projectPath, p);
    if (rel === null) return { error: tr("fs.pathDenied") };
    const abs = join(projectPath, rel);
    const s = await stat(abs).catch(() => null);
    if (!s) return { error: tr("fs.fileMissing") };
    if (!s.isFile()) return { error: tr("fs.notFile") };
    if (s.size > MAX_READ) return { tooLarge: true };
    const buf = await readFile(abs).catch(() => null);
    if (!buf) return { error: tr("fs.unreadable") };
    const head = buf.subarray(0, 8192);
    if (head.includes(0)) return { binary: true };
    const { text, encoding } = decodeText(buf);
    return { text, encoding, language: LANG[extname(rel).toLowerCase()] ?? "plaintext" };
  }
}
