// Path utilities: normalization, samePath, isInside (decided after resolving realpath).
import { realpathSync, existsSync } from "node:fs";
import { posix, sep, win32 } from "node:path";

// Normalization: realpath (when it exists) + unified separators + case-insensitive on Windows/macOS (NTFS and APFS are case-insensitive by default).
// Only for comparison/dedupe, never for display or storage.
export function normPath(p: string, platform: NodeJS.Platform = process.platform): string {
  // Resolve with the target platform's rules: normalizing a macOS/Linux path on Windows must not prepend the host drive (D:\…)
  let r = (platform === "win32" ? win32 : posix).resolve(p);
  try {
    // native restores 8.3 short names (C:\PROGRA~1), subst drives and letter case to what's on disk; fall back to the JS implementation on failure
    r = realpathSync.native(r);
  } catch {
    try {
      r = realpathSync(r);
    } catch {}
  }
  if (platform === "win32") {
    // Strip the \\?\ long-path prefix; UNC stays \\server\share
    r = r.replace(/\//g, "\\").replace(/^\\\\\?\\(?!UNC\\)/i, "").replace(/^\\\\\?\\UNC\\/i, "\\\\").toLowerCase();
  } else {
    r = r.replace(/\\/g, "/");
    if (platform === "darwin") r = r.normalize("NFC").toLowerCase();
  }
  // Strip trailing separators (except for the root)
  while (r.length > 3 && (r.endsWith("/") || r.endsWith("\\"))) r = r.slice(0, -1);
  return r;
}

export function samePath(a: string, b: string): boolean {
  return normPath(a) === normPath(b);
}

// Whether child is inside the parent directory (including equal).
export function isInside(child: string, parent: string): boolean {
  const c = normPath(child);
  const p = normPath(parent);
  if (c === p) return true;
  return c.startsWith(p + sep) || c.startsWith(p + "/") || c.startsWith(p + "\\");
}

// id check: only safe characters, prevents path traversal.
const ID_RE = /^[\w-]{1,80}$/;
export function validId(id: unknown): id is string {
  return typeof id === "string" && ID_RE.test(id);
}

export function pathExists(p: string): boolean {
  return existsSync(p);
}
