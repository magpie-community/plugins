// Diff entries in the timeline come in two source shapes, normalized to the { head, lines: [{ t, text }] } DiffView expects:
//   - the daemon's editDetail (daemon/src/agents/diff.ts): { oldStart, newStart, lines: [{ t, s }] }
//   - already in DiffView shape: { head?, lines: [{ t, text }] }
// We used to hand the former straight to DiffView; reading l.text gave undefined, so edit-tool diffs showed only blank lines.
export type DiffLineView = { t: "+" | "-" | " "; text: string };
export type DiffHunkView = { head?: string; lines: DiffLineView[] };

type RawLine = { t?: unknown; s?: unknown; text?: unknown };
type RawHunk = { head?: unknown; oldStart?: unknown; newStart?: unknown; lines?: unknown };

function lineType(t: unknown): "+" | "-" | " " {
  return t === "+" || t === "-" ? t : " ";
}

export function normalizeHunks(raw: unknown): DiffHunkView[] {
  if (!Array.isArray(raw)) return [];
  const out: DiffHunkView[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const h = item as RawHunk;
    const lines: DiffLineView[] = [];
    for (const l of Array.isArray(h.lines) ? (h.lines as RawLine[]) : []) {
      if (!l || typeof l !== "object") continue;
      const text = typeof l.text === "string" ? l.text : typeof l.s === "string" ? l.s : "";
      lines.push({ t: lineType(l.t), text });
    }
    let head: string | undefined = typeof h.head === "string" ? h.head : undefined;
    if (head === undefined && Number.isInteger(h.oldStart) && Number.isInteger(h.newStart)) {
      head = `@@ -${h.oldStart as number} +${h.newStart as number} @@`;
    }
    out.push({ head, lines });
  }
  return out;
}
