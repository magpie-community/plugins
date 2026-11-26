// 本文由AI自动生成
// Plugin host entry: binds a loopback-only HTTP server on 127.0.0.1 for the memory graph UI.

import { createServer, request as httpRequest } from "node:http";
import { mkdir } from "node:fs/promises";

import { createBuilder } from "./lib/build.mjs";
import { cleanupTempFiles, serviceToken } from "./lib/cache.mjs";
import {
  dataDir as defaultDataDir,
  memoryDir as defaultMemoryDir,
  vectorsDir as defaultVectorsDir,
} from "./lib/paths.mjs";
import { handleRequest, json } from "./lib/server.mjs";

const PLUGIN_ID = "memory-graph";
const DEFAULT_PORT = 3491;
const DEFAULT_IDLE_MS = 5 * 60 * 1000;

let TOKEN = "";
let BUILDER = null;
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

// Only 2xx/3xx traffic keeps the service awake; stale pages hitting 401 should not reset idle timer.
function touch(status) {
  if (status >= 400) return;
  LAST_ACTIVE = Date.now();
  if (!ASLEEP) return;
  ASLEEP = false;
  BUILDER?.wake();
  console.log("[memory-graph] request received, woken up");
}

function listen(port) {
  const ctx = {
    getPort: () => port,
    getToken: () => TOKEN,
    getBuilder: () => BUILDER,
    ensureInit,
    getStatusExtra: () => ({
      attached: ATTACHED,
      asleep: ASLEEP,
      startedAt: STARTED_AT,
      idleMs: IDLE_MS,
      initError: INIT_ERROR,
    }),
    onTouch: touch,
  };
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      handleRequest(req, res, ctx).catch((error) => {
        try {
          json(req, res, port, 500, { error: String(error?.message || error) });
        } catch {
          /* response already sent */
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
    BUILDER = createBuilder({
      dir: settings.dataDir,
      memoryDir: settings.memoryDir,
      vectorsPath: settings.vectorsPath,
      options: settings,
    });
  } catch (error) {
    INIT_ERROR = String(error?.message || error);
    throw error;
  }
}

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
    console.log(
      `[memory-graph] idle for ${Math.round(IDLE_MS / 60000)}m, entered sleep (port ${SETTINGS?.port} kept)`,
    );
  }, 30000);
  SWEEPER.unref?.();
}

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
    .then(() => BUILDER?.run())
    .catch((error) => console.error("[memory-graph] init failed:", error?.message || error));
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
          `[memory-graph] port ${port} already owned by pid ${health.pid}, attaching`,
        );
        startReconcile(port);
        return { server: null, attached: true };
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Port ${port} is occupied by another process (health check did not match memory-graph) after 60s; configure a different port in plugin options`,
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
    await cleanupTempFiles(settings.dataDir);
    TOKEN = await serviceToken(settings.dataDir);

    const bound = await claim(port);
    ATTACHED = bound.attached;
    if (!ATTACHED) {
      SERVER = bound.server;
      SERVER_STARTED(port);
    }
    return bound;
  })().catch((error) => {
    console.error("[memory-graph] boot failed:", error?.message || error);
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

    const rawMaxNodes = number(options?.maxNodes, 1000);
    const settings = {
      port,
      minSimilarity: clamp(number(options?.minSimilarity, 0.6), 0.35, 0.95),
      concurrency: clamp(number(options?.concurrency, 8), 1, 12),
      maxNodes: rawMaxNodes === 0 ? 0 : clamp(rawMaxNodes, 20, 5000),
      idleMs: clamp(number(options?.idleMinutes, 5), 0, 240) * 60000,
      dataDir: typeof options?.dataDir === "string" ? options.dataDir.trim() : "",
      memoryDir: typeof options?.memoryDir === "string" ? options.memoryDir.trim() : "",
      vectorsPath: typeof options?.vectorsPath === "string" ? options.vectorsPath.trim() : "",
    };
    settings.dataDir = settings.dataDir || defaultDataDir();
    settings.memoryDir = settings.memoryDir || defaultMemoryDir();
    settings.vectorsPath = settings.vectorsPath || defaultVectorsDir();

    boot(port, settings);
    return {};
  },
  stop,
};
