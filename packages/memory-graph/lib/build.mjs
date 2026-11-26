// 本文由AI自动生成
// 建图编排：扫描记忆目录 → 读取 magpie 本地 MEV1 向量库 → 毫秒级计算余弦/词法相似度 → 落派生缓存。
//
// 纯本地只读计算，不调用外部 API，不依赖 memory_search MCP。

import {
  AI_computeSimilarityEdges,
  AI_findVectorsFile,
  AI_loadVectors,
} from "./AI_similarity.mjs";
import { SCHEMA, loadCache, saveCache } from "./cache.mjs";
import { buildPayload } from "./graph.mjs";
import { scanMemories } from "./scan.mjs";

const EDGE_FLOOR = 0.35;

function countNodes(nodes, vectorInfo) {
  const all = Object.values(nodes || {});
  return {
    total: all.length,
    active: all.filter((node) => node.status === "active").length,
    superseded: all.filter((node) => node.status === "superseded").length,
    candidate: all.filter((node) => node.status === "candidate").length,
    archived: all.filter((node) => node.status === "archived").length,
    vectorized: vectorInfo?.matched || 0,
  };
}

export function createBuilder({ dir, memoryDir, vectorsPath, options = {} }) {
  let cache = { v: SCHEMA, nodes: {}, edges: [], vectorInfo: null, stats: {}, builtAt: null };
  let nodes = {};
  let loaded = false;
  let running = null;
  let lastCheck = 0;
  let sleeping = false;
  let persistChain = Promise.resolve();

  let state = {
    phase: "idle",
    done: 0,
    total: 0,
    startedAt: 0,
    lastBuiltAt: 0,
    lastError: "",
    complete: true,
    warnings: [],
  };

  async function load() {
    if (loaded) return;
    cache = await loadCache(dir);
    nodes = cache.nodes || {};
    const needsBody = Object.values(nodes).some((node) => node && node.body === undefined);
    if (needsBody && memoryDir) {
      try {
        const concurrency = Math.max(1, Math.min(12, Number(options.concurrency) || 8));
        const scan = await scanMemories(memoryDir, { cacheNodes: nodes, concurrency });
        nodes = Object.fromEntries(scan.nodes);
      } catch {
        /* 记忆目录不可读时保留缓存元数据 */
      }
    }
    loaded = true;
  }

  function counts() {
    return countNodes(nodes, cache.vectorInfo);
  }

  function persist(edges, vectorInfo, final) {
    const task = persistChain.then(async () => {
      const payload = {
        builtAt: new Date().toISOString(),
        nodes,
        edges,
        vectorInfo,
        stats: countNodes(nodes, vectorInfo),
      };
      try {
        await saveCache(dir, payload);
        cache = { ...payload, v: SCHEMA };
      } catch (error) {
        state.lastError = `Failed to write cache: ${error?.message || error}`;
        if (final) state.complete = false;
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
      done: 0,
      total: 0,
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
        vectorFile = await AI_findVectorsFile(vectorsPath);
        if (vectorFile) {
          const loadedVec = await AI_loadVectors(vectorFile.path);
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

      const computed = AI_computeSimilarityEdges(nodes, vectorMap, { floor: EDGE_FLOOR });
      const vectorInfo = {
        path: vectorFile?.path || "",
        mtimeMs: vectorFile?.mtimeMs || 0,
        dim,
        totalVectors,
        matched: computed.vectorMatched,
        totalVisible: computed.totalVisible,
      };

      state.total = computed.totalVisible;
      state.done = computed.totalVisible;
      state.phase = "writing";

      await persist(computed.edges, vectorInfo, true);
      state.phase = "idle";
      state.lastBuiltAt = Date.now();
      state.complete = true;
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
        nodes = Object.fromEntries(scan.nodes);
      } catch {
        diskChanged = false;
      }
    }

    let vectorsChanged = false;
    try {
      const vecFile = await AI_findVectorsFile(vectorsPath);
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
    if (now - lastCheck < 15000) return false;
    lastCheck = now;

    const changed = await checkChanged();
    if (!cache.builtAt || changed) {
      run();
      return true;
    }
    return false;
  }

  async function ensureFresh({ force = false } = {}) {
    await load();
    if (running) {
      await running;
      if (!force) return false;
    }

    const needsBuild = force || !cache.builtAt || (await checkChanged());
    lastCheck = Date.now();
    if (needsBuild) {
      run();
      if (running) await running;
      return true;
    }
    return false;
  }

  function sleep() {
    if (running || sleeping) return false;
    nodes = {};
    cache = { v: SCHEMA, nodes: {}, edges: [], vectorInfo: null, stats: {}, builtAt: cache.builtAt };
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
    await load();
    const effectiveOptions =
      minSimilarity !== undefined ? { ...options, minSimilarity } : options;
    return buildPayload({
      nodes,
      edges: cache.edges,
      vectorInfo: cache.vectorInfo,
      stats: cache.stats,
      builtAt: cache.builtAt,
      options: effectiveOptions,
      state,
      memoryDir,
    });
  }

  async function getInlineGraph({ minSimilarity } = {}) {
    const payload = await getGraph({ minSimilarity });
    return {
      ...payload,
      allEdges: cache.edges || [],
    };
  }

  function getStatus() {
    const totals = counts();
    return {
      ok: true,
      engine: "similarity",
      phase: state.phase,
      asleep: sleeping,
      done: state.done,
      total: state.total,
      startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null,
      lastBuiltAt: cache.builtAt,
      lastError: state.lastError,
      complete: state.complete,
      counts: totals,
      vectorInfo: cache.vectorInfo,
      cached: Boolean(cache.builtAt),
      memoryDir,
      dataDir: dir,
      warnings: state.warnings.slice(-3),
    };
  }

  return { run, maybeRefresh, ensureFresh, getGraph, getInlineGraph, getStatus, sleep, wake };
}
