/** Parse the ?tokens= (base64 JSON) passed by boot.js and write --magpie-* CSS variables (accent included: the page follows Magpie's accent) */
export function applyMagpieTokensFromSearch(search: string): void {
  const raw = new URLSearchParams(search).get("tokens");
  if (!raw) return;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(decodeURIComponent(escape(atob(raw)))) as Record<string, unknown>;
  } catch {
    return;
  }
  const root = document.documentElement;
  for (const [k, v] of Object.entries(obj)) {
    const s = String(v ?? "").trim();
    if (!s) continue;
    const varName = k.startsWith("--") ? k : k.startsWith("magpie-") ? `--${k}` : `--magpie-${k}`;
    root.style.setProperty(varName, s);
  }
}
