// Self-heal after the plugin host restarts (Magpie restarts its Bun plugin host from time to time; the old host's daemon exits with it
// and the gate key / port change). This page was opened by the gate with the Magpie plugin page URL in the fragment (#t=…&b=…).
// When the daemon can't be reached for a few seconds, the page goes back to that Magpie page: boot.js reads the fresh session.js and
// opens the new gate, which starts a new daemon. Only a loopback Magpie plugin page URL is ever followed (no open redirect),
// and the token is never put anywhere but this page's own fragment.

/** The same check as lib/gate.mjs safeBackUrl: http(s), loopback host, no credentials, /_magpie/plugin/<id>/[page/]index.html */
export function safeBackUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || !raw || raw.length > 2048) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") return null;
  if (!/^\/_magpie\/plugin\/[A-Za-z0-9_-]{1,128}\/(?:page\/)?index\.html$/.test(u.pathname)) return null;
  return `${u.protocol}//${u.host}${u.pathname}${u.search}`;
}

export function backUrlFromHash(hash: string): string | null {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  return safeBackUrl(new URLSearchParams(fragment).get("b"));
}

let lostAt = 0;

/** The URL to go back to, with ac_lost = when the connection dropped: boot.js then ignores a session.js last refreshed before
 *  that (the killed host's) and waits for the new host's. */
export function backTarget(hash: string, lost: number): string | null {
  const b = backUrlFromHash(hash);
  if (!b) return null;
  const u = new URL(b);
  if (lost > 0) u.searchParams.set("ac_lost", String(Math.floor(lost)));
  return u.toString();
}

/** Navigate back through the Magpie plugin page; false when this page doesn't know it (opened some other way) */
export function goBackToMagpie(): boolean {
  const target = backTarget(location.hash, lostAt);
  if (!target) return false;
  location.replace(target);
  return true;
}

/** Calls onStuck once the connection has been down for `ms` without coming back */
export function watchReconnect(
  ws: { onState(fn: (s: string) => void): () => void; getState(): string },
  onStuck: () => void,
  ms = 5000,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const off = ws.onState((s) => {
    if (s === "reconnecting" || s === "down") {
      if (!lostAt) lostAt = Date.now();
      if (!timer) timer = setTimeout(() => { timer = null; if (ws.getState() !== "open") onStuck(); }, ms);
    } else if (s === "open") {
      lostAt = 0;
      if (timer) { clearTimeout(timer); timer = null; }
    }
  });
  return () => { off(); if (timer) clearTimeout(timer); };
}
