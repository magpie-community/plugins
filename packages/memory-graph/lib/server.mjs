// HTTP request handler, loopback listener, and test app server factory for memory-graph.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createBuilder } from "./build.mjs";
import {
  STATIC,
  corsHeaders,
  fetchSiteAllowed,
  hostAllowed,
  htmlDestAllowed,
  injectInitialGraph,
  injectToken,
  isCorsRequest,
  originAllowed,
  send,
  tokenMatch,
  tokenOK,
} from "./http.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN_ID = "memory-graph";
const VERSION = String(
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version || "0.0.0",
);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const number = (value, fallback) => {
  if (value === null || value === undefined || typeof value === "boolean") return fallback;
  if (typeof value === "string" && !value.trim()) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function json(req, res, port, status, value) {
  send(req, res, port, status, JSON.stringify(value), "application/json; charset=utf-8");
}

function parseMinSim(url) {
  const rawSim = url.searchParams.get("minSim");
  if (rawSim === null || !rawSim.trim()) return undefined;
  const parsed = Number(rawSim);
  return Number.isFinite(parsed) ? clamp(parsed, 0.35, 0.9) : undefined;
}

export async function handleRequest(req, res, ctx) {
  const started = Date.now();
  const port = ctx.getPort();
  const token = ctx.getToken();
  let url;
  try {
    url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
  } catch {
    json(req, res, port, 400, { error: "Bad request: malformed URL" });
    return;
  }
  const done = (status, { touch = true } = {}) => {
    if (touch) ctx.onTouch?.(status);
    if (ctx.log !== false) {
      console.log(
        `[memory-graph] ${req.method} ${url.pathname} host=${req.headers.host || "-"} origin=${
          req.headers.origin ?? "-"
        } -> ${status} ${Date.now() - started}ms`,
      );
    }
  };

  if (!hostAllowed(req, port) || !originAllowed(req, port)) {
    json(req, res, port, 403, { error: "Forbidden: loopback host and same-origin requests only" });
    done(403);
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "cache-control": "no-store", ...corsHeaders(req, port) });
    res.end();
    done(204);
    return;
  }

  if (url.pathname === "/api/health") {
    const authed = tokenOK(req, token);
    if (!authed) {
      json(req, res, port, 200, {
        ok: true,
        plugin: PLUGIN_ID,
        port,
        version: VERSION,
      });
      done(200, { touch: false });
      return;
    }
    ctx.onTouch?.(200);
    const builder = ctx.getBuilder();
    const status = builder ? builder.getStatus() : null;
    const extra = ctx.getStatusExtra?.() || {};
    json(req, res, port, 200, {
      ok: true,
      plugin: PLUGIN_ID,
      pid: process.pid,
      attached: Boolean(extra.attached),
      asleep: Boolean(extra.asleep),
      uptimeMs: Date.now() - (extra.startedAt ?? started),
      idleMs: extra.idleMs ?? 0,
      port,
      version: VERSION,
      tokenPresent: Boolean(token),
      phase: status?.phase || (extra.initError ? "error" : "booting"),
      initError: extra.initError || status?.lastError || "",
    });
    done(200);
    return;
  }

  const isApi =
    url.pathname === "/api/graph" ||
    url.pathname === "/api/status" ||
    url.pathname === "/api/rebuild";

  if (isApi) {
    if (!fetchSiteAllowed(req)) {
      json(req, res, port, 403, { error: "Forbidden: cross-site request rejected" });
      done(403);
      return;
    }
    try {
      await ctx.ensureInit();
    } catch (error) {
      json(req, res, port, 503, {
        error: `Local service initialization failed: ${String(error?.message || error)}`,
      });
      done(503);
      return;
    }
    if (!tokenOK(req, token)) {
      json(req, res, port, 401, { error: "Unauthorized: missing or invalid x-memory-graph-token" });
      done(401);
      return;
    }
  }

  if (url.pathname === "/api/graph") {
    if (req.method !== "GET") {
      json(req, res, port, 405, { error: "Method not allowed: GET required" });
      done(405);
      return;
    }
    try {
      ctx.onTouch?.(200);
      const builder = ctx.getBuilder();
      builder.maybeRefresh().catch(() => {});
      const minSimilarity = parseMinSim(url);
      const data = await builder.getGraph({ minSimilarity });
      json(req, res, port, 200, data);
      done(200);
    } catch (error) {
      json(req, res, port, 500, { error: String(error?.message || error) });
      done(500);
    }
    return;
  }

  if (url.pathname === "/api/status") {
    if (req.method !== "GET") {
      json(req, res, port, 405, { error: "Method not allowed: GET required" });
      done(405);
      return;
    }
    ctx.onTouch?.(200);
    json(req, res, port, 200, ctx.getBuilder().getStatus());
    done(200);
    return;
  }

  if (url.pathname === "/api/rebuild") {
    if (req.method !== "POST") {
      json(req, res, port, 405, { error: "Method not allowed: POST required" });
      done(405);
      return;
    }
    try {
      ctx.onTouch?.(200);
      const result = ctx.getBuilder().run();
      json(req, res, port, result.started ? 202 : 409, result);
      done(result.started ? 202 : 409);
    } catch (error) {
      json(req, res, port, 500, { error: String(error?.message || error) });
      done(500);
    }
    return;
  }

  const hit = STATIC[url.pathname];
  if (!hit) {
    send(req, res, port, 404, "not found", "text/plain; charset=utf-8");
    done(404);
    return;
  }

  const isHtml = hit.type.startsWith("text/html");
  if (req.method !== "GET" && req.method !== "HEAD") {
    json(req, res, port, 405, { error: "Method not allowed: GET or HEAD required" });
    done(405);
    return;
  }
  if (isCorsRequest(req)) {
    json(req, res, port, 403, { error: "Forbidden: CORS requests rejected" });
    done(403);
    return;
  }
  if (isHtml && !htmlDestAllowed(req)) {
    json(req, res, port, 403, { error: "Forbidden: HTML only served for document or iframe navigation" });
    done(403);
    return;
  }

  if (isHtml) {
    if (url.searchParams.get("refresh") === "1" && !tokenMatch(url.searchParams.get("t"), token)) {
      json(req, res, port, 403, { error: "Forbidden: refresh requires valid token" });
      done(403);
      return;
    }
    try {
      await ctx.ensureInit();
    } catch (error) {
      json(req, res, port, 503, {
        error: `Local service initialization failed: ${String(error?.message || error)}`,
      });
      done(503);
      return;
    }
  }

  try {
    if (isHtml) {
      ctx.onTouch?.(200);
      const builder = ctx.getBuilder();
      const force = url.searchParams.get("refresh") === "1";
      if (force) {
        await builder.ensureFresh({ force: true });
        const cleanParams = new URLSearchParams();
        for (const key of ["minSim", "theme", "lang"]) {
          const val = url.searchParams.get(key);
          if (val !== null) cleanParams.set(key, val);
        }
        const qs = cleanParams.toString();
        const location = qs ? `${url.pathname}?${qs}` : url.pathname;
        res.writeHead(303, {
          location,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        });
        res.end();
        done(303);
        return;
      }

      if (!builder.getStatus().cached) {
        await builder.ensureFresh({ force: false });
      } else {
        builder.maybeRefresh().catch(() => {});
      }

      const builtAt = builder.getStatus().lastBuiltAt || "";
      const cacheKey = `${builtAt}|${token}`;

      let html;
      if (ctx.htmlCache && ctx.htmlCache.key === cacheKey) {
        html = ctx.htmlCache.body;
      } else {
        const body = await readFile(join(ROOT, hit.file));
        const inlineData = await builder.getInlineGraph();
        html = injectToken(body.toString("utf8"), token);
        html = injectInitialGraph(html, inlineData);
        if (ctx.htmlCache) {
          ctx.htmlCache.key = cacheKey;
          ctx.htmlCache.body = html;
        }
      }

      res.writeHead(200, {
        "content-type": hit.type,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      res.end(req.method === "HEAD" ? undefined : html);
    } else {
      const body = await readFile(join(ROOT, hit.file));
      res.writeHead(200, {
        "content-type": hit.type,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...corsHeaders(req, port),
      });
      res.end(req.method === "HEAD" ? undefined : body);
    }
    done(200);
  } catch (error) {
    send(
      req,
      res,
      port,
      500,
      `Failed to serve ${hit.file}: ${String(error?.message || error)}`,
      "text/plain; charset=utf-8",
    );
    done(500);
  }
}

export async function listenLoopback(port, ctx) {
  let boundPort = port;
  const wrappedCtx = {
    ...ctx,
    htmlCache: ctx.htmlCache || { key: "", body: "" },
    getPort: () => boundPort,
  };

  const server = createServer((req, res) => {
    handleRequest(req, res, wrappedCtx).catch((error) => {
      try {
        json(req, res, boundPort, 500, { error: String(error?.message || error) });
      } catch {
        /* response already sent */
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const addr = server.address();
      if (addr && typeof addr === "object") boundPort = addr.port;
      resolve();
    });
  });

  const close = () =>
    new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });

  return { server, port: boundPort, close };
}

export async function createAppServer({
  port = 0,
  memoryDir,
  dataDir,
  vectorsPath,
  minSimilarity = 0.6,
  maxNodes = 1000,
  token,
  onTouch,
  getStatusExtra,
} = {}) {
  if (dataDir) {
    await mkdir(dataDir, { recursive: true });
  }
  const resolvedToken = token || randomBytes(24).toString("hex");
  const rawMaxNodes = number(maxNodes, 1000);
  const builder = createBuilder({
    dir: dataDir,
    memoryDir,
    vectorsPath,
    options: {
      minSimilarity: clamp(number(minSimilarity, 0.6), 0.35, 0.9),
      maxNodes: rawMaxNodes === 0 ? 0 : clamp(rawMaxNodes, 20, 5000),
    },
  });

  const startedAt = Date.now();
  const ctx = {
    getToken: () => resolvedToken,
    getBuilder: () => builder,
    ensureInit: () => Promise.resolve(),
    getStatusExtra:
      getStatusExtra || (() => ({ attached: false, asleep: false, startedAt, idleMs: 0, initError: "" })),
    onTouch,
    log: false,
  };

  const { server, port: boundPort, close } = await listenLoopback(port, ctx);
  return { server, port: boundPort, token: resolvedToken, builder, close };
}
