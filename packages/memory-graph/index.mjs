// Plugin host entry: binds a loopback-only HTTP server on 127.0.0.1 for the memory graph UI.

import { request as httpRequest } from "node:http";
import { mkdir } from "node:fs/promises";

import { createBuilder } from "./lib/build.mjs";
import { cleanupTempFiles, serviceToken } from "./lib/cache.mjs";
import {
  dataDir as defaultDataDir,
  memoryDir as defaultMemoryDir,
  vectorsDir as defaultVectorsDir,
} from "./lib/paths.mjs";
import { listenLoopback } from "./lib/server.mjs";

const PLUGIN_ID = "memory-graph";
const DEFAULT_PORT = 3491;
const DEFAULT_IDLE_MS = 5 * 60 * 1000;

let TOKEN = "";
let BUILDER = null;
let SERVER_HANDLE = null;
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
let STOPPED = false;
let BOOT_EPOCH = 0;
let SLEEP_CANCEL = null;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const number = (value, fallback) => {
  if (value === null || value === undefined || typeof value === "boolean") return fallback;
  if (typeof value === "string" && !value.trim()) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

function abortableSleep(ms, epoch) {
  if (STOPPED || epoch !== BOOT_EPOCH) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (SLEEP_CANCEL === cancel) SLEEP_CANCEL = null;
      resolve(ok);
    };
    const cancel = () => finish(false);
    const timer = setTimeout(() => finish(!STOPPED && epoch === BOOT_EPOCH), ms);
    timer.unref?.();
    SLEEP_CANCEL = cancel;
  });
}

// Only 2xx/3xx traffic keeps the service awake; stale pages hitting 401 should not reset idle timer.
function touch(status) {
  if (status >= 400) return;
  LAST_ACTIVE = Date.now();
  if (!ASLEEP) return;
  ASLEEP = false;
  BUILDER?.wake();
  console.log("[memory-graph] request received, woken up");
}

function buildCtx() {
  return {
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
        const chunks = [];
        let bytes = 0;
        const maxBytes = 64 * 1024;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            response.destroy();
            finish(null);
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            finish(JSON.parse(Buffer.concat(chunks).toString("utf8")));
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

function startReconcile(port, epoch) {
  if (RECONCILE || STOPPED || epoch !== BOOT_EPOCH) return;
  RECONCILE = setInterval(async () => {
    if (STOPPED || epoch !== BOOT_EPOCH || !ATTACHED) return;
    const health = await probeHealth(port);
    if (STOPPED || epoch !== BOOT_EPOCH) return;
    if (health?.plugin === PLUGIN_ID) return;
    clearInterval(RECONCILE);
    RECONCILE = null;
    try {
      const handle = await listenLoopback(port, buildCtx());
      if (STOPPED || epoch !== BOOT_EPOCH) {
        await handle.close().catch(() => {});
        return;
      }
      SERVER_HANDLE = handle;
      ATTACHED = false;
      SERVER_STARTED(port);
    } catch {
      if (STOPPED || epoch !== BOOT_EPOCH) return;
      ATTACHED = true;
      startReconcile(port, epoch);
    }
  }, 15000);
  RECONCILE.unref?.();
}

function SERVER_STARTED(port) {
  STARTED_AT = Date.now();
  LAST_ACTIVE = Date.now();
  console.log(`[memory-graph] listening on http://127.0.0.1:${port}`);
  startSweeper();
}

async function claim(port, epoch) {
  let delay = 500;
  const deadline = Date.now() + 60000;
  for (;;) {
    if (STOPPED || epoch !== BOOT_EPOCH) return { handle: null, attached: false };
    try {
      const handle = await listenLoopback(port, buildCtx());
      if (STOPPED || epoch !== BOOT_EPOCH) {
        await handle.close().catch(() => {});
        return { handle: null, attached: false };
      }
      return { handle, attached: false };
    } catch (error) {
      if (STOPPED || epoch !== BOOT_EPOCH) return { handle: null, attached: false };
      if (error?.code !== "EADDRINUSE") throw error;
      const health = await probeHealth(port);
      if (STOPPED || epoch !== BOOT_EPOCH) return { handle: null, attached: false };
      if (health?.plugin === PLUGIN_ID) {
        console.log(
          `[memory-graph] port ${port} already owned by another memory-graph instance, attaching`,
        );
        startReconcile(port, epoch);
        return { handle: null, attached: true };
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Port ${port} is occupied by another process (health check did not match memory-graph) after 60s; configure a different port in plugin options`,
        );
      }
      const awake = await abortableSleep(delay, epoch);
      if (!awake) return { handle: null, attached: false };
      delay = Math.min(delay * 2, 4000);
    }
  }
}

function boot(port, settings) {
  if (BOOTED) return BOOTED;
  const epoch = BOOT_EPOCH;

  BOOTED = (async () => {
    SETTINGS = settings;
    IDLE_MS = settings.idleMs;
    await mkdir(settings.dataDir, { recursive: true });
    await cleanupTempFiles(settings.dataDir);
    TOKEN = await serviceToken(settings.dataDir);
    if (STOPPED || epoch !== BOOT_EPOCH) return null;

    const bound = await claim(port, epoch);
    if (STOPPED || epoch !== BOOT_EPOCH) {
      if (bound.handle) await bound.handle.close().catch(() => {});
      return null;
    }
    ATTACHED = bound.attached;
    if (!ATTACHED && bound.handle) {
      SERVER_HANDLE = bound.handle;
      SERVER_STARTED(port);
    }
    return bound;
  })().catch((error) => {
    console.error("[memory-graph] boot failed:", error?.message || error);
    BOOTED = null;
    throw error;
  });

  return BOOTED;
}

async function stop() {
  STOPPED = true;
  BOOT_EPOCH += 1;
  SLEEP_CANCEL?.();
  SLEEP_CANCEL = null;
  clearInterval(SWEEPER);
  clearInterval(RECONCILE);
  SWEEPER = null;
  RECONCILE = null;
  if (SERVER_HANDLE) {
    await SERVER_HANDLE.close();
    SERVER_HANDLE = null;
  }
  BUILDER = null;
  INIT = null;
  BOOTED = null;
  ATTACHED = false;
  ASLEEP = false;
}

export default {
  id: "magpie-memory-graph",
  server: async (_input, options = {}) => {
    STOPPED = false;
    INIT_ERROR = "";
    ATTACHED = false;
    ASLEEP = false;
    const candidate = number(options?.port, DEFAULT_PORT);
    const port =
      Number.isInteger(candidate) && candidate >= 1 && candidate <= 65535 ? candidate : DEFAULT_PORT;

    const rawMaxNodes = number(options?.maxNodes, 1000);
    const settings = {
      port,
      minSimilarity: clamp(number(options?.minSimilarity, 0.6), 0.35, 0.9),
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

    await boot(port, settings);
    return {};
  },
  stop,
};
