// 1.3 全部自动同意 (#727 review): every approval the daemon answers by itself is in the timeline (permission_request +
// permission_resolved, both marked auto), so the user can always look up what was approved. Shown quietly: the auto
// approvals of one run of tool calls become one foldable row ("已自动同意 3 项") placed after that run, so they neither
// break the folded tool summary nor show up as cards with buttons. Pure: the reducer's items are not changed.
import type { DisplayItem } from "./reducer.js";
import { isShortThinking } from "./fold.js";

type Perm = Extract<DisplayItem, { kind: "permission" }>;
type AutoPerm = Extract<DisplayItem, { kind: "autoperm" }>;

export function isAutoApproved(it: DisplayItem): it is Perm {
  return it.kind === "permission" && !!it.auto && it.status !== "cancelled";
}

/** Items a tool run is made of (what foldTimeline merges); anything else ends the run */
function inRun(it: DisplayItem): boolean {
  return it.kind === "toolgroup" || it.kind === "gone" || isShortThinking(it);
}

/** Run before foldTimeline: pull auto-approved permissions out and put one "autoperm" row at the end of their run */
export function collectAutoApproved(items: DisplayItem[]): DisplayItem[] {
  if (!items.some(isAutoApproved)) return items;
  const out: DisplayItem[] = [];
  let bucket: AutoPerm | null = null;
  const flush = () => {
    if (bucket) out.push(bucket);
    bucket = null;
  };
  for (const it of items) {
    if (isAutoApproved(it)) {
      if (!bucket) bucket = { kind: "autoperm", key: `autoperm:${it.requestId}`, items: [] };
      bucket.items.push(it);
      continue;
    }
    if (bucket && !inRun(it)) flush();
    out.push(it);
  }
  flush();
  return out;
}

/** What one approval was for, on one line: the command, else the file, else the Agent's title */
export function approvalTarget(p: Perm): string {
  const d = (p.detail ?? {}) as { command?: unknown; path?: unknown; diff?: { path?: unknown } };
  const s = typeof d.command === "string" && d.command.trim() ? d.command
    : typeof d.path === "string" && d.path.trim() ? d.path
      : typeof d.diff?.path === "string" && d.diff.path.trim() ? d.diff.path
        : p.title;
  return s.replace(/\s+/g, " ").trim();
}

/** The label of the option the daemon picked ("Allow once" …), or its id */
export function approvalChoice(p: Perm): string | null {
  if (!p.choice) return null;
  return p.options.find((o) => o.id === p.choice)?.label ?? p.choice;
}
