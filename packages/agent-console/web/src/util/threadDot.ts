import type { ThreadMeta } from "../types/models";

/** Sidebar status dot class. Priority: wait > run > err > ok (completed) > idle grey. */
export function threadDotClass(
  t: Pick<ThreadMeta, "id" | "status" | "lastTurnStatus">,
  pendingIds: Set<string>,
): string {
  if (pendingIds.has(t.id)) return "dot wait";
  if (t.status === "running" || t.status === "initializing") return "dot run";
  if (t.status === "error" || t.lastTurnStatus === "failed") return "dot err";
  if (t.lastTurnStatus === "completed") return "dot ok";
  return "dot";
}
