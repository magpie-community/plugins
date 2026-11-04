/** Magpie accent tokens (accent, accent-soft, accent-fg, and a bare --accent*) are dropped: the page's accent is monochrome on purpose. */
export function isAccentToken(key: string): boolean {
  return /^accent(-|$)/i.test(key.replace(/^--/, "").replace(/^magpie-/i, ""));
}

/** Parse the ?tokens= (base64 JSON) passed by boot.js and write --magpie-* CSS variables (neutrals, fonts, semantic colors; never the accent) */
export function applyMagpieTokensFromSearch(search: string): void {
  const raw = new URLSearchParams(search).get("tokens");
  if (!raw) return;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(decodeURIComponent(escape(atob(raw)))) as Record<string, unknown>;
  } catch {
    return;
  }
  applyMagpieTokens(obj);
}

/** Magpie token map → CSS variables name → value (accent dropped; odd names / values skipped). Pure, for tests. */
export function magpieTokenVars(obj: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== "string" && typeof v !== "number") continue;
    const s = String(v).trim();
    if (!s || s.length > 300 || /[;{}<>]/.test(s) || isAccentToken(k)) continue;
    const name = k.replace(/^--/, "").replace(/^magpie-/i, "");
    if (!/^[a-zA-Z0-9-]{1,48}$/.test(name)) continue;
    out[`--magpie-${name}`] = s;
  }
  return out;
}

/** Write Magpie's tokens as --magpie-* variables (at load from ?tokens=, and live from the bridge's theme events) */
export function applyMagpieTokens(obj: Record<string, unknown> | null | undefined): void {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(magpieTokenVars(obj))) root.style.setProperty(k, v);
}
