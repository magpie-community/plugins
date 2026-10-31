// Path chips from the Files panel (1.2): drag data, de-duplication, what thread.send gets. Pure, unit tested.

/** dataTransfer type of a Files-panel row dragged into the composer */
export const MENTION_MIME = "application/x-agent-console-path";
export const MAX_MENTIONS = 50;
export type MentionDraft = { projectId: string; rel: string; isDir: boolean };

/** Absolute path of a project-relative path, with the project's own separator (Windows paths keep backslashes) */
export function joinProjectPath(root: string, rel: string): string {
  const win = /^[a-zA-Z]:[\\/]/.test(root) || root.startsWith("\\\\");
  const sep = win ? "\\" : "/";
  const r = rel === "." ? "" : win ? rel.replace(/\//g, "\\") : rel;
  return r ? root.replace(/[\\/]+$/, "") + sep + r : root;
}

/** The drag payload (any page could forge one: the daemon checks the path again) */
export function parseMentionDrag(raw: string | null | undefined): MentionDraft | null {
  if (!raw || raw.length > 10000) return null;
  try {
    const o = JSON.parse(raw) as Partial<MentionDraft>;
    if (typeof o.projectId !== "string" || typeof o.rel !== "string" || !o.rel || o.rel.length > 4096) return null;
    return { projectId: o.projectId, rel: o.rel, isDir: o.isDir === true };
  } catch {
    return null;
  }
}

export function addMention(list: MentionDraft[], m: MentionDraft): MentionDraft[] {
  if (list.some((x) => x.projectId === m.projectId && x.rel === m.rel)) return list;
  if (list.length >= MAX_MENTIONS) return list;
  return [...list, m];
}

/** thread.send's mentions field */
export function mentionsForSend(list: MentionDraft[]): { rel: string; isDir: boolean }[] {
  return list.map((m) => ({ rel: m.rel, isDir: m.isDir }));
}

/** A sent message's absolute paths → project-relative again (edit & resend); paths outside the project are dropped */
export function relFromAbs(root: string, abs: string): string | null {
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const r = norm(root);
  const a = norm(abs);
  const win = /^[a-zA-Z]:\//.test(r);
  const eq = (x: string, y: string) => (win ? x.toLowerCase() === y.toLowerCase() : x === y);
  if (eq(a, r)) return ".";
  if (a.length > r.length && eq(a.slice(0, r.length), r) && a[r.length] === "/") return a.slice(r.length + 1);
  return null;
}
