// Plugin gate: runs inside Magpie's Bun plugin host process and listens on 127.0.0.1:<port> (default 3488).
//
// Two independent secrets:
//   - gate key (key): written to page/session.js; the plugin page uses it to open the gate.
//   - daemon token (token): unlocks the daemon's API / WebSocket; it only appears in the # fragment of the gate's 302
//     and is never written to any static file.
//
// Why separate them: Magpie serves the page directory at /_magpie/plugin/<token that changes every launch>/ without checking Origin,
// Host, Sec-Fetch-* or cookies; the only protection is that the path can't be guessed. session.js is a script, and any page that knows the path
// can include it with <script src> and read its contents (classic script includes aren't subject to CORS). So session.js may only hold
// things that can't reach the daemon even if leaked: the gate key only buys one navigation to the daemon, and the token sits in the target window's
// # fragment, which cross-origin pages can't read.
//
// Token handoff:
//   1. The plugin host's server() creates the key and token; once the gate binds its port it writes page/session.js (port and key only).
//   2. The plugin page (sandbox iframe) reads session.js and navigates itself to http://127.0.0.1:<port>/open?k=<key>.
//      This is an ordinary navigation: no Origin header, and the gate returns no CORS headers, so other pages can't read the response.
//   3. The gate checks the key, starts (or reuses) the daemon and 302s to its own wrapper page
//      http://127.0.0.1:<port>/app?<theme params>#t=<token>&p=<daemonPort>, which frames http://127.0.0.1:<daemonPort>/#t=<token> (1.3).
//      The token lives only in the # fragment: fragments aren't sent to servers and don't appear in Referer or daemon logs;
//      after the navigation the window belongs to the daemon's origin (opaque inside the plugin iframe), and the initiating page can't read its URL.
//
// The gate itself: every request checks Host (blocks DNS rebinding); any request with an Origin header is refused (navigations only);
// everything except GET /open and GET /app is 404.
//
// 1.3: /open no longer sends the frame to the daemon's random port directly but to the gate's own /app page (lib/wrapper.mjs),
// which shows the daemon page in a child iframe. After sleep/wake or a daemon restart, a reload of the frame lands on this
// stable port instead of a dead one, and the wrapper sends it back through the Magpie page to a fresh daemon.
import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { parseTry, wrapperCsp, wrapperHtml } from "./wrapper.mjs";

// Constant-time compare against timing attacks; hash to the same length first.
function tokenEqual(a, b) {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

const SAFE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function respond(res, status, body) {
  res.writeHead(status, { ...SAFE_HEADERS, "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** 503 page: show only a userMessage that ensureDaemon explicitly provides (e.g. "Node.js not found"); other error details go to the log only. */
export function failureHtml(error) {
  const hint = typeof error?.userMessage === "string" && error.userMessage ? error.userMessage : "";
  return (
    "<!doctype html><meta charset=utf-8><p>Agent Console: 本地服务启动失败 / local service failed to start</p>" +
    (hint ? `<p>${escapeHtml(hint)}</p>` : "") +
    "<p>日志 / log: ~/.config/magpie/agent-console/logs/daemon-spawn.log</p>"
  );
}

/**
 * The Magpie plugin page boot.js came from (?back=), so the daemon page can go back through it after the plugin host restarts
 * (fresh session.js → new gate → new daemon). Only a Magpie plugin page on loopback (`magpie web`: 127.0.0.1, localhost,
 * [::1]) is accepted, so the daemon page can't be turned into an open redirect; it travels in the 302's # fragment next to
 * the token and never reaches a server.
 * Magpie's desktop window is never a back target, on any OS: wails://localhost (macOS / Linux) can't be navigated to from
 * this http page at all, and http://wails.localhost (Windows) only exists inside WebView2's request interception, which
 * Wails sets up with the plain AddWebResourceRequestedFilter (no request source kinds): it doesn't see requests from the
 * sandboxed plugin frame once that frame is on 127.0.0.1 (an out-of-process iframe), so the navigation goes to the real
 * network, fails, and leaves WebView2's own gray error page in the frame with none of our script to recover (1.3.5/1.3.6).
 * Without a back URL the wrapper asks Magpie to show its Try again card instead, which rebuilds the frame from the window.
 * Keep in sync with web/src/api/backToMagpie.ts and lib/wrapper.mjs SAFE_BACK_SRC.
 */
export function safeBackUrl(raw) {
  if (typeof raw !== "string" || !raw || raw.length > 2048) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  const hostname = u.hostname.toLowerCase();
  // Exact loopback hosts only: never 127.0.0.1.evil… / wails.localhost (see above)
  const loopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  if (!loopback) return null;
  if (!/^\/_magpie\/plugin\/[A-Za-z0-9_-]{1,128}\/(?:page\/)?index\.html$/.test(u.pathname)) return null;
  return `${u.protocol}//${u.host}${u.pathname}${u.search}`;
}

const REOPEN_HTML =
  "<!doctype html><meta charset=utf-8><p>Agent Console: 链接已失效，请在 Magpie 里重新打开插件页。" +
  "<br>The link is no longer valid. Please reopen the Agent Console page in Magpie.</p>";

/**
 * @param {object} options
 * @param {number} options.port gate port
 * @param {string} options.key gate key (the one in session.js), only used to open /open
 * @param {string} options.token daemon token, only placed in the 302's # fragment
 * @param {() => Promise<{ port: number }>} options.ensureDaemon starts or reuses the daemon and returns its actual port
 * @param {string} [options.host] listen address, default 127.0.0.1
 */
export function createGate({ port, key, token, ensureDaemon, host = "127.0.0.1" }) {
  if (typeof key !== "string" || key.length < 32 || typeof token !== "string" || token.length < 32 || key === token) {
    throw new Error("gate: key and token must be two different secrets");
  }
  let server = null;
  // Concurrent /open calls share one ensureDaemon so two daemons are never started
  let opening = null;

  async function handle(req, res) {
    const expectedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!expectedHosts.includes(String(req.headers.host ?? "").toLowerCase())) {
      respond(res, 421, "Bad Host");
      return;
    }
    // The gate only accepts top-level navigations of the plugin page, which carry no Origin. Anything with an Origin (including null) is a script request.
    if (req.headers.origin !== undefined) {
      respond(res, 403, "Origin not allowed");
      return;
    }
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    if (url.pathname === "/app" && req.method === "GET") {
      // Static: no secret in it; the token reaches it only in the # fragment
      const nonce = randomBytes(16).toString("base64");
      res.writeHead(200, {
        ...SAFE_HEADERS,
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": wrapperCsp(nonce),
      });
      res.end(wrapperHtml(nonce));
      return;
    }
    if (url.pathname !== "/open" || req.method !== "GET") {
      respond(res, 404, "Not found");
      return;
    }
    if (!tokenEqual(url.searchParams.get("k") ?? "", key)) {
      respond(res, 403, REOPEN_HTML);
      return;
    }

    if (!opening) {
      opening = Promise.resolve()
        .then(() => ensureDaemon())
        .finally(() => {
          opening = null;
        });
    }
    let daemon;
    try {
      daemon = await opening;
    } catch (error) {
      respond(res, 503, failureHtml(error));
      return;
    }

    // Theme, language and color tokens are forwarded to the daemon page as-is; the daemon token goes only into the # fragment
    const query = new URLSearchParams();
    for (const name of ["theme", "lang", "tokens"]) {
      if (url.searchParams.has(name)) query.set(name, url.searchParams.get(name));
    }
    // The wrapper's retry counter (see lib/wrapper.mjs), only in its exact shape
    const tries = url.searchParams.get("ac_try");
    if (parseTry(tries)) query.set("ac_try", tries);
    const back = safeBackUrl(url.searchParams.get("back"));
    const fragment = `t=${encodeURIComponent(token)}&p=${daemon.port}` + (back ? `&b=${encodeURIComponent(back)}` : "");
    const location = `http://127.0.0.1:${port}/app?${query}#${fragment}`;
    res.writeHead(302, { ...SAFE_HEADERS, location });
    res.end();
  }

  function listen() {
    return new Promise((resolve, reject) => {
      const candidate = http.createServer((req, res) => {
        handle(req, res).catch(() => {
          if (!res.headersSent) respond(res, 500, "Internal error");
          else res.end();
        });
      });
      candidate.once("error", reject);
      candidate.listen(port, host, () => {
        candidate.off("error", reject);
        server = candidate;
        resolve(candidate);
      });
    });
  }

  function close() {
    return new Promise((resolve) => {
      const current = server;
      server = null;
      if (!current) {
        resolve();
        return;
      }
      current.close(() => resolve());
      // Don't wait for keep-alive connections to close by themselves; free the port immediately
      current.closeAllConnections?.();
    });
  }

  return { listen, close };
}
