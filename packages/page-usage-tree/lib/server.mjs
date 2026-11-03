import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { displaySettings, loadUsageData, servicePidFile } from "./data.mjs";
import { PERIODS } from "./usage.mjs";

const UI_DIR = fileURLToPath(new URL("../ui/", import.meta.url));
const CACHE_MS = 25_000;
export const PLUGIN_NAME = "magpie-usage-tree";

// The build's own version, so an older service on the port is told apart
// from this one.
export function version() {
  try {
    const raw = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    );
    return typeof raw.version === "string" ? raw.version : "0";
  } catch {
    return "0";
  }
}

const STATIC = new Map([
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/view.js", ["view.js", "text/javascript; charset=utf-8"]],
  ["/i18n.js", ["i18n.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  // The page's own icon lives beside the launcher, not in ui/.
  ["/icon.svg", ["../page/icon.svg", "image/svg+xml"]],
]);

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function allowedOrigin(origin, port) {
  if (!origin || origin === "null") return true;
  return (
    origin === `http://127.0.0.1:${port}` ||
    origin === `http://localhost:${port}` ||
    origin === `http://[::1]:${port}`
  );
}

// A plugin page is a sandboxed frame, so it reaches this service with an
// opaque origin ("null"). Its own token still guards the data; these
// headers only let that frame read the answer it asked for.
function allowNullOrigin(req, res) {
  if (req.headers.origin === "null") {
    res.setHeader("Access-Control-Allow-Origin", "null");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "x-usage-tree-token");
    res.setHeader("Vary", "Origin");
  }
}

function allowedHost(host, port) {
  const value = String(host || "").toLowerCase();
  return (
    value === `127.0.0.1:${port}` ||
    value === `localhost:${port}` ||
    value === `[::1]:${port}`
  );
}

function escHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function parseTokens(raw) {
  if (!raw) return {};
  try {
    const value = JSON.parse(Buffer.from(String(raw), "base64").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (/^[a-z0-9-]{1,40}$/i.test(key) && typeof item === "string" && item.length <= 160) {
        out[key] = item;
      }
    }
    return out;
  } catch {
    return {};
  }
}

// probeService asks an already running copy of this page's service whether
// it is up, and the token its page was given. Both the app's plugin host and
// the host a `magpie plugin` command starts load this plugin, so one of them
// wins the port; the other must treat that as success, not a failure.
async function probeService(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(1200),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body || body.name !== PLUGIN_NAME) return null;
    // The token stays with the copy that owns the port; a page is always
    // served by that copy, so the second host needs nothing from it.
    return { reused: true, version: body.version || "" };
  } catch {
    return null;
  }
}

// A service of an older build still holding the port is replaced: the pid
// that owns it is in our own cache, and the port answers as this plugin.
async function stopOlderService(port) {
  const info = await probeService(port);
  if (!info || info.version === version()) return false;
  let pid = 0;
  let recorded = "";
  try {
    const [rawPid, rawVersion] = readFileSync(servicePidFile(port), "utf8").trim().split(/\s+/);
    pid = Number(rawPid);
    recorded = rawVersion || "";
  } catch {
    return false;
  }
  // a pid written by this build is never killed: only an older one's is
  if (!recorded || recorded === version()) return false;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid);
  } catch {
    return false;
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!(await probeService(port))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

export async function startServer(options = {}) {
  const port = Number(options.port);
  const requestedPort = Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 3494;
  const token = randomBytes(24).toString("base64url");
  const loader = options.load || loadUsageData;
  const cache = new Map();
  let boundPort = requestedPort;

  async function dataFor(period, options = {}) {
    const wanted = PERIODS.has(period) ? period : "7d";
    const hit = cache.get(wanted);
    const now = Date.now();

    // What was read last is shown at once, whatever its age; a new read
    // never stands between the reader and the numbers they had a moment
    // ago. Only a first read waits, as there is nothing to show yet.
    if (!options.fresh && hit?.data) {
      if (now - hit.at >= (hit.ttl ?? CACHE_MS)) void refreshInBackground(wanted);
      return { data: hit.data, cache: hit.data?.stale ? "stale" : "fresh" };
    }
    // A read is already running behind the page: what was read last is
    // still the best answer to give now.
    if (hit?.pending) {
      if (hit.data) return { data: hit.data, cache: hit.data?.stale ? "stale" : "fresh" };
      return { data: await hit.pending, cache: "shared" };
    }

    const loaded = await refreshInBackground(wanted, { wait: true, fresh: options.fresh });
    return { data: loaded, cache: "miss" };
  }

  function refreshInBackground(wanted, options = {}) {
    const hit = cache.get(wanted);
    if (hit?.pending) {
      return options.wait ? hit.pending : Promise.resolve(hit.data);
    }

    const pending = loader(wanted, { fresh: Boolean(options.fresh) })
      .then((data) => {
        cache.set(wanted, { at: Date.now(), data, ttl: CACHE_MS });
        return data;
      })
      .catch((error) => {
        if (hit?.data) {
          hit.error = error;
          return hit.data;
        }
        throw error;
      })
      .finally(() => {
        const current = cache.get(wanted);
        if (current?.pending === pending) current.pending = null;
      });

    cache.set(wanted, { at: hit?.at || 0, data: hit?.data, pending });
    if (!options.wait) {
      void pending.catch(() => {});
      return Promise.resolve(hit?.data);
    }
    return pending;
  }

  const handler = async (req, res) => {
    try {
      const host = req.headers.host || "";
      if (!allowedHost(host, boundPort)) {
        json(res, 403, { error: "invalid host" });
        return;
      }

      const url = new URL(req.url || "/", `http://${host}`);
      if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
        json(res, 405, { error: "method not allowed" });
        return;
      }

      if (url.pathname === "/healthz") {
        json(res, 200, { ok: true, name: PLUGIN_NAME, version: version() });
        return;
      }

      if (req.method === "OPTIONS" && url.pathname === "/api/tree") {
        allowNullOrigin(req, res);
        res.writeHead(204, {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        res.end();
        return;
      }

      if (url.pathname === "/") {
        if (!allowedOrigin(req.headers.origin, boundPort)) {
          json(res, 403, { error: "invalid origin" });
          return;
        }
        const template = await readFile(join(UI_DIR, "app.html"), "utf8");
        const boot = {
          theme: url.searchParams.get("theme") === "dark" ? "dark" : "light",
          tokens: parseTokens(url.searchParams.get("tokens")),
          ...displaySettings(),
        };
        const lang = String(url.searchParams.get("lang") || boot.lang).slice(0, 12);
        const html = template
          .replaceAll("__USAGE_TREE_TOKEN__", escHTML(token))
          .replaceAll("__USAGE_TREE_THEME__", escHTML(boot.theme))
          .replaceAll("__USAGE_TREE_LANG__", escHTML(lang))
          .replaceAll("__USAGE_TREE_TOKENS__", escHTML(JSON.stringify(boot.tokens)))
          .replaceAll("__USAGE_TREE_CURRENCY__", escHTML(boot.currency))
          .replaceAll("__USAGE_TREE_USD_CNY__", escHTML(String(boot.usdCny)))
          .replaceAll("__USAGE_TREE_CHINESE_UNITS__", String(boot.chineseUnits))
          .replaceAll(
            "__USAGE_TREE_TITLE__",
            escHTML(lang.startsWith("en") ? "Account usage" : "账号用量"),
          );
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy":
            `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' http://127.0.0.1:${boundPort} http://localhost:${boundPort}; base-uri 'none'; form-action 'none'`,
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
        });
        res.end(req.method === "HEAD" ? undefined : html);
        return;
      }

      if (url.pathname === "/api/tree") {
        allowNullOrigin(req, res);
        if (!allowedOrigin(req.headers.origin, boundPort)) {
          json(res, 403, { error: "invalid origin" });
          return;
        }
        if (req.headers["x-usage-tree-token"] !== token) {
          json(res, 401, { error: "missing or invalid token" });
          return;
        }
        const period = url.searchParams.get("period") || "7d";
        if (!PERIODS.has(period)) {
          json(res, 400, { error: "period must be today, 7d, 30d or all" });
          return;
        }
        const loaded = await dataFor(period, { fresh: url.searchParams.get("fresh") === "1" });
        res.setHeader("X-Usage-Tree-Cache", loaded.cache);
        json(res, 200, { ...loaded.data, display: displaySettings() });
        return;
      }

      if (url.pathname === "/api/settings") {
        allowNullOrigin(req, res);
        if (!allowedOrigin(req.headers.origin, boundPort)) {
          json(res, 403, { error: "invalid origin" });
          return;
        }
        if (req.headers["x-usage-tree-token"] !== token) {
          json(res, 401, { error: "missing or invalid token" });
          return;
        }
        json(res, 200, displaySettings());
        return;
      }

      const item = STATIC.get(url.pathname);
      if (item) {
        const body = await readFile(join(UI_DIR, item[0]));
        res.writeHead(200, {
          "Content-Type": item[1],
          "Content-Length": body.length,
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(req.method === "HEAD" ? undefined : body);
        return;
      }

      json(res, 404, { error: "not found" });
    } catch (error) {
      json(res, 500, { error: error?.message || "usage tree failed" });
    }
  };

  // A restarted plugin host can overlap the one it replaces for a moment.
  // Bind first, and only after the port stays busy for a while accept that
  // another live host already serves this plugin; a dying host releases the
  // port and the retry then takes it.
  let server = null;
  const bind = () =>
    new Promise((resolve, reject) => {
      const instance = createServer(handler);
      const onError = (error) => {
        instance.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        instance.off("error", onError);
        resolve(instance);
      };
      instance.once("error", onError);
      instance.once("listening", onListening);
      instance.listen(requestedPort, "127.0.0.1");
    });

  if (requestedPort === 0) {
    server = await bind();
  } else {
    let bound = false;
    // A host that is on its way out keeps the port for a moment: the new
    // build waits for it, and takes the port when it is free.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        server = await bind();
        bound = true;
        break;
      } catch (error) {
        if (error?.code !== "EADDRINUSE") throw error;
        await stopOlderService(requestedPort);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (!bound) {
      const running = await probeService(requestedPort);
      if (running && running.version === version()) {
        return {
          port: requestedPort,
          token: "",
          server: null,
          reused: true,
          close: async () => {},
        };
      }
      throw new Error(
        running
          ? `port ${requestedPort} is held by an older build of this plugin`
          : `port ${requestedPort} is in use and not by this plugin`,
      );
    }
  }

  boundPort = server.address().port;
  // the pid that owns the port, so a newer build can replace this one
  const pidFile = servicePidFile(boundPort);
  try {
    mkdirSync(dirname(pidFile), { recursive: true });
    writeFileSync(pidFile, `${process.pid} ${version()}`, "utf8");
  } catch {
    // Without the pid file an older build cannot be replaced; nothing else.
  }
  // Warm the period the page asks for first, so the first read does not
  // wait for magpie to read the whole log.
  void dataFor("today").catch(() => {});
  return {
    port: boundPort,
    token,
    server,
    close: () =>
      new Promise((resolve) => {
        try {
          unlinkSync(pidFile);
        } catch {
          // The file is gone already, or another build owns the port.
        }
        server.close(resolve);
      }),
  };
}
