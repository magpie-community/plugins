// 1.3 display pass over the reduced timeline, like the Claude Code desktop app:
// - consecutive tool groups merge into one foldable summary ("改动 1 · 运行 3 · 读取 2 · 1 失败");
// - short or empty thinking next to tool calls folds into that summary as a step instead of its own "思考 Xs" row;
// - a lone, finished, empty thinking row is dropped (nothing to open).
// Long thinking, text, plans, permissions, notices and turn ends still break a run. Pure: the reducer's items are not changed.
// 1.3 timeline polish: a run shows its steps as flat one-line rows; only a run of more than TOOL_COLLAPSE_AT tool calls folds
// into the summary. Within one user turn only the newest checklist (todo) is kept, where it was last updated, and Claude's
// TodoWrite step is dropped from the rows (the checklist shows it).
import type { DisplayItem, ToolStep } from "./reducer.js";

/** Thinking up to this many characters (≈5 s at the "思考 Xs" rate) counts as short */
export const SHORT_THINK_CHARS = 200;

type Reasoning = Extract<DisplayItem, { kind: "reasoning" }>;
type Group = Extract<DisplayItem, { kind: "toolgroup" }>;

export function isShortThinking(it: DisplayItem): it is Reasoning {
  return it.kind === "reasoning" && it.text.trim().length <= SHORT_THINK_CHARS;
}

function thinkStep(r: Reasoning): ToolStep {
  return {
    itemId: `think:${r.itemId}`, kind: "think", title: "",
    status: r.streaming ? "running" : "ok",
    think: { text: r.text, streaming: r.streaming },
  };
}

/** A run of more tool calls than this folds into one summary row (expandable); shorter runs show every row */
export const TOOL_COLLAPSE_AT = 6;

type Todo = Extract<DisplayItem, { kind: "todo" }>;

/** Checklists replaced by a newer one in the same user turn */
function supersededTodos(items: DisplayItem[]): Set<DisplayItem> {
  const out = new Set<DisplayItem>();
  let last: DisplayItem | null = null;
  for (const it of items) {
    if (it.kind === "user") last = null;
    else if (it.kind === "todo") {
      if (last) out.add(last);
      last = it;
    }
  }
  return out;
}

export function foldTimeline(items: DisplayItem[], opts: { showThinking?: boolean } = {}): DisplayItem[] {
  const showThinking = opts.showThinking !== false;
  const stale = supersededTodos(items);
  const out: DisplayItem[] = [];
  let group: Group | null = null;
  let held: Reasoning[] = [];
  const flushHeld = () => {
    for (const r of held) if (r.streaming || r.text.trim()) out.push(r);
    held = [];
  };
  for (const it of items) {
    if (it.kind === "gone" || stale.has(it)) continue;
    if (it.kind === "toolgroup") {
      const steps = it.steps.filter((s) => s.kind !== "todo");
      if (!steps.length) continue;
      if (group) {
        group.steps.push(...steps);
      } else {
        group = { kind: "toolgroup", key: it.key, steps: [...(showThinking ? held.map(thinkStep) : []), ...steps] };
        held = [];
        out.push(group);
      }
      continue;
    }
    if (it.kind === "reasoning") {
      if (!showThinking) continue;
      if (isShortThinking(it)) {
        if (!it.streaming && !it.text.trim()) continue; // finished and empty: nothing to show, and it doesn't split a run
        if (group) group.steps.push(thinkStep(it));
        else held.push(it);
        continue;
      }
    }
    flushHeld();
    group = null;
    out.push(it);
  }
  flushHeld();
  return out;
}

// ---- summary helpers (shared by the component and tests) ----
export type StepCategory = "edit" | "run" | "read" | "search" | "other";
export const CATEGORY_ORDER: StepCategory[] = ["edit", "run", "read", "search", "other"];

export function stepCategory(kind: string): StepCategory | "think" {
  switch (kind) {
    case "think": return "think";
    case "edit": case "write": return "edit";
    case "bash": return "run";
    case "read": return "read";
    case "search": case "glob": case "web": return "search";
    default: return "other";
  }
}

export type GroupSummary = { counts: [StepCategory, number][]; failed: number; thinkSecs: number };

export function summarize(steps: ToolStep[]): GroupSummary {
  const m = new Map<StepCategory, number>();
  let failed = 0;
  let thinkChars = 0;
  for (const s of steps) {
    const c = stepCategory(s.kind);
    if (c === "think") { thinkChars += s.think?.text.length ?? 0; continue; }
    m.set(c, (m.get(c) ?? 0) + 1);
    if (s.status === "failed") failed++;
  }
  return {
    counts: CATEGORY_ORDER.filter((c) => m.has(c)).map((c) => [c, m.get(c)!]),
    failed,
    thinkSecs: thinkChars ? Math.max(1, Math.round(thinkChars / 40)) : 0,
  };
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");

/** What a running step works on: the command, the file, the pattern… (falls back to its title) */
export function stepTarget(s: ToolStep): string {
  const i = (s.input ?? {}) as Record<string, unknown>;
  const d = (s.detail ?? {}) as Record<string, unknown>;
  const v =
    str(d.command) || str(i.command) || str(i.cmd) ||
    str(i.file_path) || str(i.path) || str(d.path) || str(i.filePath) ||
    str(i.pattern) || str(i.query) || str(i.url) ||
    str(s.title);
  return v.replace(/\s+/g, " ");
}

/** The step to show in the one-line "正在…" row: the last running tool, else a thinking step still streaming at the end */
export function activeStep(steps: ToolStep[]): ToolStep | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.status === "running" && s.kind !== "think") return s;
  }
  const last = steps[steps.length - 1];
  return last && last.kind === "think" && last.think?.streaming ? last : null;
}

/** Tool calls in a run (short thinking folded into it doesn't count) */
export function toolStepCount(steps: ToolStep[]): number {
  let n = 0;
  for (const s of steps) if (s.kind !== "think") n++;
  return n;
}

/** Lines added / removed by an edit step: the daemon's counts, else counted from its hunks; null when it has no diff */
export function stepDiffStat(s: ToolStep): { added: number; removed: number } | null {
  const d = (s.detail ?? null) as { added?: unknown; removed?: unknown; hunks?: unknown; diff?: { hunks?: unknown } } | null;
  if (!d || typeof d !== "object") return null;
  if (typeof d.added === "number" && typeof d.removed === "number") return { added: d.added, removed: d.removed };
  const hunks = Array.isArray(d.hunks) ? d.hunks : Array.isArray(d.diff?.hunks) ? d.diff!.hunks as unknown[] : null;
  if (!hunks) return null;
  let added = 0, removed = 0;
  for (const h of hunks) {
    for (const l of ((h as { lines?: unknown }).lines ?? []) as { t?: unknown }[]) {
      if (l?.t === "+") added++;
      else if (l?.t === "-") removed++;
    }
  }
  return { added, removed };
}

/** A checklist's progress */
export function todoProgress(items: { status: string }[]): { done: number; total: number } {
  return { done: items.filter((i) => i.status === "done" || i.status === "completed").length, total: items.length };
}

/** The unfinished checklist of the latest user turn (for the "N/M tasks" pill above the composer), or null */
export function currentChecklist(items: DisplayItem[]): Todo | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    // A finished list needs no reminder: the pill shows while something is still open
    if (it.kind === "todo") return it.items.some((x) => x.status !== "done") ? it : null;
    if (it.kind === "user") return null;
  }
  return null;
}
