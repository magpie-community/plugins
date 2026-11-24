// 本文由AI自动生成
// 插件宿主入口：起一个只监听 127.0.0.1 的服务，页面导航到这里看图谱。
//
// 只读声明：本服务只读 ~/.config/magpie/memory/*.md 和 gateway.json，
// 只调用 memory_search，不写记忆、不读任何凭证文件。

import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createBuilder } from "./lib/build.mjs";
import { serviceToken } from "./lib/cache.mjs";
import {
  STATIC,
  corsHeaders,
  hostAllowed,
  injectToken,
  originAllowed,
  readBody,
  send,
  tokenOK,
} from "./lib/http.mjs";
import { MemoryMcp } from "./lib/mcp.mjs";
import {
  dataDir as defaultDataDir,
  gatewayBase,
  mcpUrl,
  memoryDir as defaultMemoryDir,
} from "./lib/paths.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_PORT = 3491;
const STARTED_AT = Date.now();

let TOKEN = "";
let BUILDER = null;
let BOOTED = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

function json(req, res, port, status, value) {
  send(req, res, port, status, JSON.stringify(value));
}

async function handle(req, res, port) {
  const started = Date.now();
  const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
  const done = (status) =>
    console.log(
      `[memory-graph] ${req.method} ${url.pathname} host=${req.headers.host || "-"} origin=${
        req.headers.origin ?? "-"
      } → ${status} ${Date.now() - started}ms`,
    );

  if (!hostAllowed(req, port) || !originAllowed(req, port)) {
    json(req, res, port, 403, { error: "只接受本机回环、且来自本插件页面或同源的请求" });
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
    const status = BUILDER ? BUILDER.getStatus() : null;
    json(req, res, port, 200, {
      ok: true,
      uptimeMs: Date.now() - STARTED_AT,
      port,
      version: "0.1.0",
      tokenPresent: Boolean(TOKEN),
      phase: status?.phase || "booting",
    });
    done(200);
    return;
  }

  if (url.pathname === "/api/graph" || url.pathname === "/api/status" || url.pathname === "/api/rebuild") {
    if (!BUILDER) {
      json(req, res, port, 503, { error: "本地服务还在启动，稍后再试" });
      done(503);
      return;
    }
    if (!tokenOK(req, TOKEN)) {
      json(req, res, port, 401, { error: "缺口令：请从这个插件的页面里打开，别直接敲地址" });
      done(401);
      return;
    }
  }

  if (url.pathname === "/api/graph") {
    if (req.method !== "GET") {
      json(req, res, port, 405, { error: "需要 GET" });
      done(405);
      return;
    }
    try {
      BUILDER.maybeRefresh().catch(() => {});
      const data = await BUILDER.getGraph();
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
      json(req, res, port, 405, { error: "需要 GET" });
      done(405);
      return;
    }
    json(req, res, port, 200, BUILDER.getStatus());
    done(200);
    return;
  }

  if (url.pathname === "/api/rebuild") {
    if (req.method !== "POST") {
      json(req, res, port, 405, { error: "需要 POST" });
      done(405);
      return;
    }
    if (!/application\/json/i.test(String(req.headers["content-type"] || ""))) {
      json(req, res, port, 415, { error: "需要 application/json" });
      done(415);
      return;
    }
    try {
      const body = await readBody(req);
      let mode = "incremental";
      try {
        mode = JSON.parse(body || "{}").mode === "all" ? "all" : "incremental";
      } catch {
        mode = "incremental";
      }
      const result = BUILDER.run(mode);
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

  try {
    let body = await readFile(join(ROOT, hit.file));
    if (hit.type.startsWith("text/html")) body = injectToken(body.toString("utf8"), TOKEN);
    res.writeHead(200, {
      "content-type": hit.type,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...corsHeaders(req, port),
    });
    res.end(body);
    done(200);
  } catch {
    send(req, res, port, 500, `missing ${hit.file}`, "text/plain; charset=utf-8");
    done(500);
  }
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      handle(req, res, port).catch((error) => {
        try {
          json(req, res, port, 500, { error: String(error?.message || error) });
        } catch {
          /* 响应已经发出去 */
        }
      });
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve({ server, port });
    });
  });
}

function boot(port, options) {
  if (BOOTED) return BOOTED;

  BOOTED = (async () => {
    const dir = options.dataDir || defaultDataDir();
    await mkdir(dir, { recursive: true });
    TOKEN = await serviceToken(dir);

    const base = options.gateway || (await gatewayBase());
    const mcp = new MemoryMcp({
      url: mcpUrl(base),
      timeoutMs: clamp(number(options.timeoutMs, 15000), 3000, 60000),
    });
    BUILDER = createBuilder({
      dir,
      memoryDir: options.memoryDir || defaultMemoryDir(),
      options,
      mcp,
    });

    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const { port: actual } = await listen(port);
        console.log(`[memory-graph] listening on http://127.0.0.1:${actual}`);
        BUILDER.run("incremental");
        return actual;
      } catch (error) {
        if (error?.code !== "EADDRINUSE") throw error;
        await sleep(1500);
      }
    }
    throw new Error(`端口 ${port} 一直被占用`);
  })().catch((error) => {
    console.error("[memory-graph] 启动失败:", error?.message || error);
    return null;
  });

  return BOOTED;
}

export default {
  id: "magpie-memory-graph",
  server: async (_input, options = {}) => {
    const candidate = Number(options?.port);
    const port = Number.isFinite(candidate) && candidate > 0 && candidate < 65536 ? candidate : DEFAULT_PORT;

    const settings = {
      port,
      topK: clamp(number(options?.topK, 8), 1, 20),
      concurrency: clamp(number(options?.concurrency, 8), 1, 12),
      maxNodes: clamp(number(options?.maxNodes, 200), 20, 1000),
      queryChars: clamp(number(options?.queryChars, 500), 100, 2000),
      buildTimeoutMs: clamp(number(options?.buildTimeoutMs, 300000), 30000, 1800000),
      timeoutMs: clamp(number(options?.timeoutMs, 15000), 3000, 60000),
      gateway: typeof options?.gateway === "string" ? options.gateway.trim() : "",
      dataDir: typeof options?.dataDir === "string" ? options.dataDir.trim() : "",
      memoryDir: typeof options?.memoryDir === "string" ? options.memoryDir.trim() : "",
    };

    boot(port, settings);
    return {};
  },
};
