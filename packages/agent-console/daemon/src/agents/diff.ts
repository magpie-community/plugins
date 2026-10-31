// Line-level diff (ported from lib/diff.mjs): oldStr/newStr → { hunks, added, removed }
// hunk: { oldStart, newStart, lines: [{ t: " "|"+"|"-", s }] }
// LCS minimal edit script; keep context lines between changes and merge nearby small blocks into one hunk.

const CONTEXT = 3;
const MERGE_GAP = 6;
const MAX_LINES = 400;

export type DiffLine = { t: " " | "+" | "-"; s: string };
export type Hunk = { oldStart: number; newStart: number; lines: DiffLine[] };
export type DiffResult = { hunks: Hunk[]; added: number; removed: number; truncated?: boolean };

export function diffLines(oldStr = "", newStr = "", { context = CONTEXT } = {}): DiffResult {
  const a = splitLines(oldStr);
  const b = splitLines(newStr);
  if (a.length > MAX_LINES || b.length > MAX_LINES) return coarseDiff(a, b);
  const ops = lcsOps(a, b);
  return buildHunks(ops, context);
}

function splitLines(s: string): string[] {
  s = String(s);
  if (!s) return [];
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

type Op = { t: " " | "+" | "-"; s: string };

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * (m + 1) + j] = a[i] === b[j]
        ? dp[(i + 1) * (m + 1) + j + 1] + 1
        : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: " ", s: a[i] });
      i++; j++;
    } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) {
      ops.push({ t: "-", s: a[i] });
      i++;
    } else {
      ops.push({ t: "+", s: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ t: "-", s: a[i++] });
  while (j < m) ops.push({ t: "+", s: b[j++] });
  return ops;
}

function buildHunks(ops: Op[], context: number): DiffResult {
  const changed: number[] = [];
  ops.forEach((op, i) => {
    if (op.t !== " ") changed.push(i);
  });
  if (!changed.length) return { hunks: [], added: 0, removed: 0 };

  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.t === "+") added++;
    else if (op.t === "-") removed++;
  }

  const ranges: { s: number; e: number }[] = [];
  for (const idx of changed) {
    const s = Math.max(0, idx - context);
    const e = Math.min(ops.length, idx + context + 1);
    const last = ranges[ranges.length - 1];
    if (last && s <= last.e + MERGE_GAP) last.e = Math.max(last.e, e);
    else ranges.push({ s, e });
  }

  const hunks: Hunk[] = [];
  let oldLn = 1;
  let newLn = 1;
  const oldNos: number[] = [];
  const newNos: number[] = [];
  for (const op of ops) {
    oldNos.push(oldLn);
    newNos.push(newLn);
    if (op.t !== "+") oldLn++;
    if (op.t !== "-") newLn++;
  }
  for (const r of ranges) {
    hunks.push({
      oldStart: oldNos[r.s],
      newStart: newNos[r.s],
      lines: ops.slice(r.s, r.e).map((op) => ({ t: op.t, s: op.s })),
    });
  }
  return { hunks, added, removed };
}

function coarseDiff(a: string[], b: string[]): DiffResult {
  return {
    hunks: [
      {
        oldStart: 1,
        newStart: 1,
        lines: [...a.map((s) => ({ t: "-" as const, s })), ...b.map((s) => ({ t: "+" as const, s }))].slice(0, 2000),
      },
    ],
    added: b.length,
    removed: a.length,
    truncated: true,
  };
}

// Build the detail for Edit/MultiEdit: compute hunks from old/new or edits[]
export function editDetail(detail: Record<string, unknown> = {}) {
  if (Array.isArray(detail.edits) && detail.edits.length) {
    const hunks: Hunk[] = [];
    let added = 0;
    let removed = 0;
    for (const e of detail.edits as { old_string?: string; old?: string; new_string?: string; new?: string }[]) {
      const d = diffLines(e.old_string ?? e.old ?? "", e.new_string ?? e.new ?? "");
      for (const h of d.hunks) hunks.push(h);
      added += d.added;
      removed += d.removed;
    }
    return { path: detail.path, hunks, added, removed };
  }
  if (detail.old !== undefined || detail.new !== undefined) {
    const d = diffLines(String(detail.old ?? ""), String(detail.new ?? ""));
    return { path: detail.path, hunks: d.hunks, added: d.added, removed: d.removed };
  }
  return detail;
}
