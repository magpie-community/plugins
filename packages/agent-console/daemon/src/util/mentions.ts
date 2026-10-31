// File / folder references dragged from the Files panel into the composer (1.2).
// The page sends {rel, isDir} relative to the conversation's project; the daemon resolves the absolute path itself and
// checks (with realpath, so a symlink can't escape) that it is still inside the project. A mention only names a path:
// no file content is read, so it never widens what the Agent may read.
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep, win32, posix } from "node:path";

export type MentionRef = { rel: string; isDir?: boolean };
export type Mention = { path: string; isDir: boolean };

export const MAX_MENTIONS = 50;

/** Is child inside (or equal to) root? Case-insensitive on Windows. */
export function insideRoot(root: string, child: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = platform === "win32" ? win32 : posix;
  const norm = (s: string) => (platform === "win32" ? p.resolve(s).toLowerCase() : p.resolve(s));
  const r = p.relative(norm(root), norm(child));
  return r === "" || (!r.startsWith("..") && !p.isAbsolute(r));
}

export async function resolveMentions(projectPath: string, refs: MentionRef[]): Promise<{ mentions: Mention[]; warnings: string[] }> {
  const mentions: Mention[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let root: string;
  try {
    root = await realpath(projectPath);
  } catch {
    return { mentions, warnings: refs.map((r) => r.rel) };
  }
  for (const ref of refs.slice(0, MAX_MENTIONS)) {
    const rel = String(ref.rel ?? "").replace(/\\/g, "/");
    if (!rel || rel.includes("\0") || isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
      warnings.push(rel || "(empty)");
      continue;
    }
    const abs = resolve(root, rel === "." ? "" : rel);
    if (!insideRoot(root, abs)) {
      warnings.push(rel);
      continue;
    }
    let real: string;
    let isDir: boolean;
    try {
      real = await realpath(abs);
      isDir = (await stat(real)).isDirectory();
    } catch {
      warnings.push(rel);
      continue;
    }
    if (!insideRoot(root, real)) {
      warnings.push(rel);
      continue;
    }
    // Keep the path the user saw (inside the project), not the symlink's target
    if (seen.has(abs)) continue;
    seen.add(abs);
    mentions.push({ path: abs, isDir });
  }
  return { mentions, warnings };
}

/** Text appended to the prompt; the same for every Agent (ACP Agents also get resource_link blocks). */
export function mentionSection(mentions: Mention[]): string {
  if (!mentions.length) return "";
  const lines = mentions.map((m) => {
    const shown = m.isDir && !m.path.endsWith(sep) && !m.path.endsWith("/") ? m.path + (m.path.includes("\\") && !m.path.includes("/") ? "\\" : "/") : m.path;
    const quoted = /\s|`/.test(shown) ? "`" + shown.replace(/`/g, "'") + "`" : shown;
    return `- ${quoted}${m.isDir ? " (folder)" : ""}`;
  });
  return `Referenced files (read them as needed):\n${lines.join("\n")}`;
}

/** The prompt text an Agent receives: the user's text, then the referenced paths */
export function withMentions(text: string, mentions: Mention[]): string {
  const sec = mentionSection(mentions);
  if (!sec) return text;
  return text.trim() ? `${text}\n\n${sec}` : sec;
}

