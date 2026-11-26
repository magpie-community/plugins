// 本文由AI自动生成
// HTTP request handler and zero-side-effect app server factory for memory-graph.

import { randomBytes } from "node:crypto";
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
  injectInitialGraph,
  injectToken,
  isCorsRequest,
  originAllowed,
  send,
  tokenOK,
} from "./http.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN_ID = "memory-graph";
const VERSION = "0.2.0";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

export function json(req, res, port, status, value) {
  send(req, res, port, status, JSON.stringify(value), "application/json; charset=utf-8");
}

function parseMinSim(url) {
  const rawSim = url.searchParams.get("minSim");
  return rawSim !== null && Number.isFinite(Number(rawSim))
    ? clamp(Number(rawSim), 0.35, 0.95)
    : undefined;
}

export async function handleRequest(req, res, ctx) {
  const started = Date.now();
  const port = ctx.getPort();
  const token = ctx.getToken();
  const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
  const done = (status) => {
    ctx.onTouch?.(status);
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
      done(200);
      return;
    }
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
  if (isHtml && isCorsRequest(req)) {
    json(req, res, port, 403, { error: "Forbidden: cross-origin static HTML request rejected" });
    done(403);
    return;
  }

  if (isHtml) {
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
    const body = await readFile(join(ROOT, hit.file));
    if (isHtml) {
      const builder = ctx.getBuilder();
      await builder.ensureFresh({ force: url.searchParams.get("refresh") === "1" });
      const minSimilarity = parseMinSim(url);
      const inlineData = await builder.getInlineGraph({ minSimilarity });
      let html = injectToken(body.toString("utf8"), token);
      html = injectInitialGraph(html, inlineData);
      res.writeHead(200, {
        "content-type": hit.type,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(html);
    } else {
      res.writeHead(200, {
        "content-type": hit.type,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...corsHeaders(req, port),
      });
      res.end(body);
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

export async function createAppServer({
  port = 0,
  memoryDir,
  dataDir,
  vectorsPath,
  minSimilarity = 0.6,
  maxNodes = 1000,
  token,
} = {}) {
  if (dataDir) {
    await mkdir(dataDir, { recursive: true });
  }
  const resolvedToken = token || randomBytes(24).toString("hex");
  const builder = createBuilder({
    dir: dataDir,
    memoryDir,
    vectorsPath,
    options: {
      minSimilarity: clamp(number(minSimilarity, 0.6), 0.35, 0.95),
      maxNodes: maxNodes === 0 ? 0 : clamp(number(maxNodes, 1000), 20, 5000),
    },
  });

  let boundPort = port;
  const startedAt = Date.now();
  const ctx = {
    getPort: () => boundPort,
    getToken: () => resolvedToken,
    getBuilder: () => builder,
    ensureInit: () => Promise.resolve(),
    getStatusExtra: () => ({ attached: false, asleep: false, startedAt, idleMs: 0, initError: "" }),
    log: false,
  };

  const server = createServer((req, res) => {
    handleRequest(req, res, ctx).catch((error) => {
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
      server.close(() => resolve());
    });

  return { server, port: boundPort, token: resolvedToken, builder, close };
}
