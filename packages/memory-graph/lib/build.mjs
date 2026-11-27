// Graph builder orchestrator: scans memory directory, loads local MEV1 vectors,
// computes cosine/lexical similarity asynchronously, and persists derived cache.

import {
  computeSimilarityEdges,
  findVectorsFile,
  loadVectors,
} from "./similarity.mjs";
import { SCHEMA, loadCache, saveCache } from "./cache.mjs";
import { buildPayload } from "./graph.mjs";
import { scanMemories } from "./scan.mjs";

const EDGE_FLOOR = 0.35;

export function createBuilder({ dir, memoryDir, vectorsPath, options = {} }) {
  let cache = { v: SCHEMA, nodes: {}, edges: [], vectorInfo: null, builtAt: null };
  let nodes = {};
  let loaded = false;
  let running = null;
  let lastCheck = 0;
  let sleeping = false;
  let persistChain = Promise.resolve();

  let state = {
    phase: "idle",
    startedAt: 0,
    lastBuiltAt: 0,
    lastError: "",
    complete: true,
    warnings: [],
  };

  async function load() {
    if (loaded) return;
    const loadedCache = await loadCache(dir);
    if (sleeping) return;
    let nextNodes = loadedCache.nodes || {};
    const needsBody = Object.values(nextNodes).some((node) => node && node.body === undefined);
    if (needsBody && memoryDir) {
      try {
        const concurrency = Math.max(1, Math.min(12, Number(options.concurrency) || 8));
        const scan = await scanMemories(memoryDir, { cacheNodes: nextNodes, concurrency });
        if (sleeping) return;
        nextNodes = Object.fromEntries(scan.nodes);
      } catch {
        /* Keep cached metadata if memory directory is unreadable */
      }
    }
    if (sleeping) return;
    cache = loadedCache;
    nodes = nextNodes;
    loaded = true;
  }

  function persist(edges, vectorInfo) {
    const task = persistChain.then(async () => {
      const payload = {
        builtAt: new Date().toISOString(),
        nodes,
        edges,
        vectorInfo,
      };
      try {
        await saveCache(dir, payload);
        cache = { ...payload, v: SCHEMA };
        return true;
      } catch (error) {
        state.lastError = `Failed to write cache: ${error?.message || error}`;
        return false;
      }
    });
    persistChain = task.catch(() => {});
    return task;
  }

  function run() {
    if (running) return { started: false, phase: state.phase };
    sleeping = false;

    state = {
      ...state,
      phase: "scanning",
      startedAt: Date.now(),
      lastError: "",
      complete: true,
      warnings: [],
    };

    running = (async () => {
      await load();

      const concurrency = Math.max(1, Math.min(12, Number(options.concurrency) || 8));
      const scan = await scanMemories(memoryDir, { cacheNodes: nodes, concurrency });
      nodes = Object.fromEntries(scan.nodes);
      if (scan.warnings?.length) state.warnings.push(...scan.warnings);

      state.phase = "computing";
      let vectorMap = new Map();
      let vectorFile = null;
      let dim = 0;
      let totalVectors = 0;

      try {
        vectorFile = await findVectorsFile(vectorsPath);
        if (vectorFile) {
          const loadedVec = await loadVectors(vectorFile.path);
          vectorMap = loadedVec.vectors;
          dim = loadedVec.dim;
          totalVectors = loadedVec.count;
        }
      } catch (error) {
        state.warnings.push({
          level: "warn",
          text: `Failed to read local vectors, fell back to lexical + tag similarity: ${error?.message || error}`,
        });
      }

      const computed = await computeSimilarityEdges(nodes, vectorMap, {
        floor: EDGE_FLOOR,
        maxNodes: options.maxNodes,
        maxEdgesPerNode: 12,
      });
      const vectorInfo = {
        path: vectorFile?.path || "",
        mtimeMs: vectorFile?.mtimeMs || 0,
        dim,
        totalVectors,
        matched: computed.vectorMatched,
        totalVisible: computed.totalVisible,
      };

      state.phase = "writing";

      const persisted = await persist(computed.edges, vectorInfo);
      state.phase = "idle";
      state.lastBuiltAt = Date.now();
      state.complete = persisted;
    })()
      .catch((error) => {
        state.phase = "error";
        state.lastError = String(error?.message || error);
        state.complete = false;
      })
      .finally(() => {
        running = null;
      });

    return { started: true, phase: "scanning" };
  }

  async function checkChanged() {
    let diskChanged = false;
    if (memoryDir) {
      try {
        const concurrency = Math.max(1, Math.min(12, Number(options.concurrency) || 8));
        const scan = await scanMemories(memoryDir, { cacheNodes: nodes, concurrency });
        diskChanged = Boolean(scan.added.length || scan.changed.length || scan.removed.length);
      } catch {
        diskChanged = false;
      }
    }

    let vectorsChanged = false;
    try {
      const vecFile = await findVectorsFile(vectorsPath);
      const prevMtime = cache.vectorInfo?.mtimeMs || 0;
      const prevPath = cache.vectorInfo?.path || "";
      if ((vecFile?.path || "") !== prevPath || (vecFile?.mtimeMs || 0) !== prevMtime) {
        vectorsChanged = true;
      }
    } catch {
      vectorsChanged = false;
    }

    return diskChanged || vectorsChanged;
  }

  async function maybeRefresh() {
    await load();
    if (running) return false;

    const now = Date.now();
    const throttleMs = Number.isFinite(Number(options.refreshThrottleMs))
      ? Number(options.refreshThrottleMs)
      : 15000;
    if (now - lastCheck < throttleMs) return false;
    lastCheck = now;

    const changed = await checkChanged();
    if (!cache.builtAt || changed) {
      run();
      return true;
    }
    return false;
  }

  async function ensureFresh({ force = false } = {}) {
    if (sleeping) wake();
    await load();
    if (running) {
      await running;
      if (sleeping) wake();
      if (!force) return false;
    }

    const needsBuild = force || !cache.builtAt || (await checkChanged());
    lastCheck = Date.now();
    if (needsBuild) {
      run();
      if (running) await running;
      if (sleeping) wake();
      return true;
    }
    if (sleeping) wake();
    return false;
  }

  function sleep() {
    if (running || sleeping) return false;
    nodes = {};
    cache = { v: SCHEMA, nodes: {}, edges: [], vectorInfo: null, builtAt: cache.builtAt };
    loaded = false;
    sleeping = true;
    state.phase = "asleep";
    return true;
  }

  function wake() {
    if (!sleeping) return false;
    sleeping = false;
    if (state.phase === "asleep") state.phase = "idle";
    return true;
  }

  async function getGraph({ minSimilarity } = {}) {
    if (sleeping) wake();
    await load();
    const effectiveOptions =
      minSimilarity !== undefined ? { ...options, minSimilarity } : options;
    return buildPayload({
      nodes,
      edges: cache.edges,
      vectorInfo: cache.vectorInfo,
      builtAt: cache.builtAt,
      options: effectiveOptions,
      state,
    });
  }

  async function getInlineGraph({ minSimilarity } = {}) {
    const payload = await getGraph({ minSimilarity });
    const keptIds = new Set(payload.nodes.map((n) => n.id));
    const allEdges = (cache.edges || []).filter((e) => keptIds.has(e.a) && keptIds.has(e.b));
    return {
      ...payload,
      allEdges,
    };
  }

  function getStatus() {
    return {
      ok: true,
      engine: "similarity",
      phase: state.phase,
      asleep: sleeping,
      startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null,
      lastBuiltAt: cache.builtAt,
      lastError: state.lastError,
      complete: state.complete,
      vectorInfo: cache.vectorInfo,
      cached: Boolean(cache.builtAt),
      memoryDir,
      dataDir: dir,
      warnings: state.warnings.slice(-3),
    };
  }

  return { run, maybeRefresh, ensureFresh, getGraph, getInlineGraph, getStatus, sleep, wake };
}
