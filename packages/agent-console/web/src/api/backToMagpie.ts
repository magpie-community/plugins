// Self-heal after the plugin host restarts (Magpie restarts its Bun plugin host from time to time; the old host's daemon exits with it
// and the gate key / port change). This page was opened by the gate with the Magpie plugin page URL in the fragment (#t=…&b=…).
// When the daemon can't be reached for a few seconds, the page goes back to that Magpie page: boot.js reads the fresh session.js and
// opens the new gate, which starts a new daemon. Only a Magpie plugin page URL on loopback (magpie web) is ever followed (no open
// redirect), and the token is never put anywhere but this page's own fragment. Magpie's desktop window (wails://localhost,
// http://wails.localhost on Windows) is never a back target: a frame on 127.0.0.1 can't navigate there (see lib/gate.mjs
// safeBackUrl); framed by Magpie without a back URL, this page asks Magpie for its Try again card instead.

/** Same check as lib/gate.mjs safeBackUrl: http(s), loopback only, no credentials, /_magpie/plugin/<id>/[page/]index.html */
export function safeBackUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || !raw || raw.length > 2048) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  if (!loopback) return null;
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

/** Framed by Magpie with no back URL: ask the window for its Try again card ({magpie:1, method:"error"}), which replaces this
 *  frame and rebuilds it from the Magpie page. False when not framed (nothing to ask). */
export function askMagpieRetry(message: string): boolean {
  if (typeof window === "undefined" || window.parent === window) return false;
  try {
    window.parent.postMessage({ magpie: 1, method: "error", params: { message } }, "*");
    return true;
  } catch {
    return false;
  }
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

// ---- 1.3: inside the gate's wrapper page (lib/wrapper.mjs) ----
// The gate frames this page with #…&w=1. Then the wrapper owns recovery: this page tells it it is alive (while connected)
// and when the connection has been lost, and never navigates itself (that would load the Magpie page inside the child frame).

export function isWrapped(hash: string = location.hash): boolean {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  return new URLSearchParams(fragment).get("w") === "1" && typeof window !== "undefined" && window.parent !== window;
}

/** Heartbeat to the wrapper every 2 s while the WebSocket is open; "lost" once it has been down for a while */
export function startWrapperHeartbeat(ws: { getState(): string }, everyMs = 2000): () => void {
  const beat = () => {
    if (ws.getState() === "open") {
      try { window.parent.postMessage({ ac_console: "alive" }, "*"); } catch {}
    }
  };
  beat();
  const t = setInterval(beat, everyMs);
  return () => clearInterval(t);
}

export function reportLostToWrapper(): void {
  try { window.parent.postMessage({ ac_console: "lost", at: lostAt || Date.now() }, "*"); } catch {}
}
