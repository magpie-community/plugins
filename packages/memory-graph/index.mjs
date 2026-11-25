// 本文由AI自动生成
// 插件宿主入口：起一个只监听 127.0.0.1 的服务，页面导航到这里看图谱。
//
// 只读声明：本服务只读 ~/.config/magpie/memory/*.md 和 gateway.json，
// 只调用 memory_search，不写记忆、不读任何凭证文件。
//
// 启动顺序很关键：先 listen 再做重活。宿主一启动就会调一次 server()，
// 而页面导航可能比初始化更快到；先占住端口，带路页就不会扑空。
// 端口被占时先问一句 /api/health：是自己的旧实例就 attach，是别的程序才退避重试。
//
// 空闲：5 分钟没有 2xx 请求就休眠（丢掉内存里的图、断开 MCP 会话），
// 但 listener 保留——宿主是共享进程，退出会连带打断别的插件和正在跑的 magpie 命令。

import { createServer, request as httpRequest } from "node:http";
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
const PLUGIN_ID = "memory-graph";
const VERSION = "0.1.0";
const DEFAULT_PORT = 3491;
const DEFAULT_IDLE_MS = 5 * 60 * 1000;

let TOKEN = "";
let BUILDER = null;
let MCP = null;
let SERVER = null;
let SETTINGS = null;
let INIT = null;
let INIT_ERROR = "";
let BOOTED = null;
let ATTACHED = false;
let ASLEEP = false;
let IDLE_MS = DEFAULT_IDLE_MS;
let LAST_ACTIVE = Date.now();
let STARTED_AT = Date.now();
let SWEEPER = null;
let RECONCILE = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

function json(req, res, port, status, value) {
  send(req, res, port, status, JSON.stringify(value));
}

// 只看 2xx：过期页面拿着旧口令刷 401 时，不该把服务一直叫醒。
function touch(status) {
  if (status >= 400) return;
  LAST_ACTIVE = Date.now();
  if (!ASLEEP) return;
  ASLEEP = false;
  BUILDER?.wake();
  console.log("[memory-graph] 收到请求，已唤醒");
}

async function handle(req, res, port) {
  const started = Date.now();
  const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
  const done = (status) => {
    touch(status);
    console.log(
      `[memory-graph] ${req.method} ${url.pathname} host=${req.headers.host || "-"} origin=${
        req.headers.origin ?? "-"
      } → ${status} ${Date.now() - started}ms`,
    );
  };

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
      plugin: PLUGIN_ID,
      pid: process.pid,
      attached: ATTACHED,
      asleep: ASLEEP,
      uptimeMs: Date.now() - STARTED_AT,
      idleMs: IDLE_MS,
      port,
      version: VERSION,
      tokenPresent: Boolean(TOKEN),
      phase: status?.phase || (INIT_ERROR ? "error" : "booting"),
      initError: INIT_ERROR || status?.lastError || "",
    });
    done(200);
    return;
  }

  const isApi =
    url.pathname === "/api/graph" ||
    url.pathname === "/api/status" ||
    url.pathname === "/api/rebuild";

  if (isApi) {
    try {
      await ensureInit();
    } catch (error) {
      json(req, res, port, 503, { error: `本地服务初始化失败：${String(error?.message || error)}` });
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

function probeHealth(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = httpRequest(
      { hostname: "127.0.0.1", port, path: "/api/health", method: "GET", timeout: timeoutMs },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => {
          try {
            finish(JSON.parse(text));
          } catch {
            finish(null);
          }
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", () => finish(null));
    request.end();
  });
}

async function init(settings) {
  INIT_ERROR = "";
  try {
    const base = settings.gateway || (await gatewayBase());
    MCP = new MemoryMcp({ url: mcpUrl(base), timeoutMs: settings.timeoutMs });
    BUILDER = createBuilder({
      dir: settings.dataDir,
      memoryDir: settings.memoryDir,
      options: settings,
      mcp: MCP,
    });
  } catch (error) {
    INIT_ERROR = String(error?.message || error);
    throw error;
  }
}

// 懒初始化 + 失败可重试：初始化没成也要先占住端口，别让页面扑空。
function ensureInit() {
  if (BUILDER) return Promise.resolve();
  if (!INIT) {
    INIT = init(SETTINGS).catch((error) => {
      INIT = null;
      throw error;
    });
  }
  return INIT;
}

function startSweeper() {
  if (SWEEPER) return;
  SWEEPER = setInterval(() => {
    if (IDLE_MS <= 0 || ASLEEP || ATTACHED || !BUILDER) return;
    const phase = BUILDER.getStatus().phase;
    if (phase !== "idle" && phase !== "error") return;
    if (Date.now() - LAST_ACTIVE < IDLE_MS) return;
    if (!BUILDER.sleep()) return;
    ASLEEP = true;
    MCP?.close();
    console.log(
      `[memory-graph] 空闲 ${Math.round(IDLE_MS / 60000)} 分钟，已休眠（端口 ${SETTINGS?.port} 保留）`,
    );
  }, 30000);
  SWEEPER.unref?.();
}

// attach 之后仍要盯着：占端口的实例一旦退掉，就把端口接过来自己服务。
function startReconcile(port) {
  if (RECONCILE) return;
  RECONCILE = setInterval(async () => {
    if (!ATTACHED) return;
    const health = await probeHealth(port);
    if (health?.plugin === PLUGIN_ID) return;
    clearInterval(RECONCILE);
    RECONCILE = null;
    try {
      const { server } = await listen(port);
      SERVER = server;
      ATTACHED = false;
      SERVER_STARTED(port);
    } catch {
      ATTACHED = true;
      startReconcile(port);
    }
  }, 15000);
  RECONCILE.unref?.();
}

function SERVER_STARTED(port) {
  STARTED_AT = Date.now();
  LAST_ACTIVE = Date.now();
  console.log(`[memory-graph] listening on http://127.0.0.1:${port}`);
  startSweeper();
  ensureInit()
    .then(() => BUILDER?.run("incremental"))
    .catch((error) => console.error("[memory-graph] 初始化失败:", error?.message || error));
}

async function claim(port) {
  let delay = 500;
  const deadline = Date.now() + 60000;
  for (;;) {
    try {
      const { server } = await listen(port);
      return { server, attached: false };
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
      const health = await probeHealth(port);
      if (health?.plugin === PLUGIN_ID) {
        console.log(
          `[memory-graph] 端口 ${port} 已有实例（pid ${health.pid}），attach 到它，不再重复监听`,
        );
        startReconcile(port);
        return { server: null, attached: true };
      }
      if (Date.now() > deadline) {
        throw new Error(
          `端口 ${port} 被其他程序占用（健康检查不是 memory-graph），已重试 60 秒；可在插件选项里改 port`,
        );
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 4000);
    }
  }
}

function boot(port, settings) {
  if (BOOTED) return BOOTED;

  BOOTED = (async () => {
    SETTINGS = settings;
    IDLE_MS = settings.idleMs;
    await mkdir(settings.dataDir, { recursive: true });
    TOKEN = await serviceToken(settings.dataDir);

    const bound = await claim(port);
    ATTACHED = bound.attached;
    if (!ATTACHED) {
      SERVER = bound.server;
      SERVER_STARTED(port);
    }
    // attach 时不重复建图：已有实例在跑，重复查询只会白烧 memory_search。
    return bound;
  })().catch((error) => {
    console.error("[memory-graph] 启动失败:", error?.message || error);
    INIT_ERROR = String(error?.message || error);
    return null;
  });

  return BOOTED;
}

function stop() {
  clearInterval(SWEEPER);
  clearInterval(RECONCILE);
  SWEEPER = null;
  RECONCILE = null;
  MCP?.close();
  if (SERVER) {
    SERVER.close();
    SERVER = null;
  }
  BOOTED = null;
}

export default {
  id: "magpie-memory-graph",
  server: async (_input, options = {}) => {
    const candidate = Number(options?.port);
    const port = Number.isFinite(candidate) && candidate > 0 && candidate < 65536 ? candidate : DEFAULT_PORT;

    const settings = {
      port,
      topK: clamp(number(options?.topK, 3), 1, 20),
      concurrency: clamp(number(options?.concurrency, 8), 1, 12),
      maxNodes: clamp(number(options?.maxNodes, 200), 20, 1000),
      queryChars: clamp(number(options?.queryChars, 500), 100, 2000),
      buildTimeoutMs: clamp(number(options?.buildTimeoutMs, 300000), 30000, 1800000),
      timeoutMs: clamp(number(options?.timeoutMs, 15000), 3000, 60000),
      idleMs: clamp(number(options?.idleMinutes, 5), 0, 240) * 60000,
      gateway: typeof options?.gateway === "string" ? options.gateway.trim() : "",
      dataDir: typeof options?.dataDir === "string" ? options.dataDir.trim() : "",
      memoryDir: typeof options?.memoryDir === "string" ? options.memoryDir.trim() : "",
    };
    settings.dataDir = settings.dataDir || defaultDataDir();
    settings.memoryDir = settings.memoryDir || defaultMemoryDir();

    boot(port, settings);
    return {};
  },
  stop,
};
