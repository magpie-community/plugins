// Settings text fields (pure, unit-tested): parsed when the field is committed, not on every keystroke.
export const IDLE_MIN = 5;
export const IDLE_MAX = 240;

/** Args field (B5): a JSON array of strings, or empty = no extra args. null = invalid. */
export function parseArgsDraft(text: string): string[] | undefined | null {
  const v = text.trim();
  if (!v) return undefined;
  try {
    const arr = JSON.parse(v) as unknown;
    if (Array.isArray(arr) && arr.every((x) => typeof x === "string")) return arr as string[];
  } catch { /* fallthrough */ }
  return null;
}

/** Idle minutes field (B6): whole number 5–240, else null */
export function parseIdleDraft(text: string): number | null {
  const v = text.trim();
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n >= IDLE_MIN && n <= IDLE_MAX ? n : null;
}

