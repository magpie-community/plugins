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
//   3. The gate checks the key, starts (or reuses) the daemon and 302s to http://127.0.0.1:<daemonPort>/?<theme params>#t=<token>.
//      The token lives only in the # fragment: fragments aren't sent to servers and don't appear in Referer or daemon logs;
//      after the navigation the window belongs to the daemon's origin (opaque inside the plugin iframe), and the initiating page can't read its URL.
//
// The gate itself: every request checks Host (blocks DNS rebinding); any request with an Origin header is refused (navigations only);
// everything except GET /open is 404.
import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

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
    const location = `http://127.0.0.1:${daemon.port}/?${query}#t=${encodeURIComponent(token)}`;
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
