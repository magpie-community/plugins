// 本文由AI自动生成
// 建图编排：扫描 → 找出新增/变化 → 并发查询 memory_search → 落派生缓存。
//
// 单飞：同一时间只允许一个构建。页面打开时只补新增/变化的记忆；
// 「重建全部」清空 hits 后重跑。每 20 条落盘一次，构建中也能先看图。

import { loadCache, saveCache } from "./cache.mjs";
import { buildPayload } from "./graph.mjs";
import { parseIds } from "./mcp.mjs";
import { queryText } from "./rank.mjs";
import { scanMemories } from "./scan.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function countNodes(nodes, hits) {
  const all = Object.values(nodes || {});
  return {
    total: all.length,
    active: all.filter((node) => node.status === "active").length,
    superseded: all.filter((node) => node.status === "superseded").length,
    candidate: all.filter((node) => node.status === "candidate").length,
    archived: all.filter((node) => node.status === "archived").length,
    queried: Object.keys(hits || {}).length,
  };
}

export function createBuilder({ dir, memoryDir, options = {}, mcp }) {
  let cache = { nodes: {}, hits: {}, stats: {}, builtAt: null };
  let nodes = {};
  let loaded = false;
  let running = null;
  let lastCheck = 0;
  let currentHits = null;

  let state = {
    phase: "idle",
    done: 0,
    total: 0,
    startedAt: 0,
    lastBuiltAt: 0,
    lastError: "",
    complete: true,
    warnings: [],
    failures: 0,
  };

  async function load() {
    if (loaded) return;
    cache = await loadCache(dir);
    nodes = cache.nodes || {};
    loaded = true;
  }

  function counts() {
    return countNodes(nodes, cache.hits);
  }

  async function persist(hits, final) {
    const payload = {
      builtAt: new Date().toISOString(),
      nodes,
      hits,
      stats: countNodes(nodes, hits),
    };
    try {
      await saveCache(dir, payload);
      cache = { ...payload, v: 1 };
    } catch (error) {
      state.lastError = `缓存写失败：${error?.message || error}`;
      if (final) state.complete = false;
    }
  }

  function run(mode = "incremental") {
    if (running) return { started: false, phase: state.phase };
    currentHits = null;

    state = {
      ...state,
      phase: "scanning",
      done: 0,
      total: 0,
      startedAt: Date.now(),
      lastError: "",
      complete: true,
      warnings: [],
      failures: 0,
    };

    running = (async () => {
      await load();

      const concurrency = Math.max(1, Math.min(12, Number(options.concurrency) || 8));
      const scan = await scanMemories(memoryDir, { cacheNodes: nodes, concurrency });
      nodes = Object.fromEntries(scan.nodes);
      if (scan.warnings?.length) state.warnings.push(...scan.warnings);

      const hits = mode === "all" ? {} : { ...(cache.hits || {}) };
      for (const id of Object.keys(hits)) {
        if (!nodes[id] || nodes[id].status !== "active") delete hits[id];
      }
      currentHits = hits;

      // 先把「有哪些节点」落盘：页面能先看到点，边随后补。
      await persist(hits, false);

      const topK = Math.max(1, Math.min(20, Number(options.topK) || 8));
      const targets = Object.values(nodes)
        .filter(
          (node) =>
            node.status === "active" &&
            (mode === "all" || !hits[node.id] || hits[node.id].hash !== node.hash),
        )
        .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));

      state.total = targets.length;

      if (targets.length) {
        state.phase = "querying";
        const startedAt = Date.now();
        const budget = Math.max(30000, Number(options.buildTimeoutMs) || 300000);
        const limit = Math.min(50, topK + 8);
        let cursor = 0;
        let failed = null;
        let sinceSave = 0;

        const workers = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
          while (!failed) {
            if (cursor >= targets.length) return;
            const node = targets[cursor++];

            if (Date.now() - startedAt > budget) {
              failed = new Error("构建超过时间预算，已保存完成的部分");
              return;
            }

            try {
              const raw = await mcp.search(queryText(node, Number(options.queryChars) || 500), {
                limit,
              });
              const ids = parseIds(raw);
              if (!ids.length) {
                state.warnings.push({
                  level: "warn",
                  text: `${node.id} 的 memory_search 没有返回可解析的 id`,
                });
              }
              hits[node.id] = { hash: node.hash, ids, at: new Date().toISOString() };
              state.failures = 0;
            } catch (error) {
              state.warnings.push({
                level: "warn",
                text: `${node.id}: ${error?.message || error}`,
              });
              state.failures = (state.failures || 0) + 1;
              if (state.failures >= 3) failed = error;
            }

            state.done++;
            if (++sinceSave >= 20) {
              sinceSave = 0;
              await persist(hits, false);
            }
          }
        });

        await Promise.all(workers);
        if (failed) throw failed;
        await sleep(0);
      }

      state.phase = "writing";
      await persist(hits, true);
      state.phase = "idle";
      state.lastBuiltAt = Date.now();
      state.complete = true;
    })()
      .catch(async (error) => {
        state.phase = "error";
        state.lastError = String(error?.message || error);
        state.complete = false;
        if (currentHits) await persist(currentHits, false);
      })
      .finally(() => {
        running = null;
      });

    return { started: true, phase: "scanning" };
  }

  async function maybeRefresh() {
    await load();
    if (running) return false;

    const now = Date.now();
    if (now - lastCheck < 30000) return false;
    lastCheck = now;

    const active = Object.values(nodes).filter((node) => node.status === "active");
    const stale =
      !cache.builtAt ||
      active.some((node) => !cache.hits?.[node.id] || cache.hits[node.id].hash !== node.hash);

    if (!stale) return false;
    run("incremental");
    return true;
  }

  async function getGraph() {
    await load();
    return buildPayload({
      nodes,
      hits: cache.hits,
      stats: cache.stats,
      builtAt: cache.builtAt,
      options,
      state,
      memoryDir,
    });
  }

  function getStatus() {
    const totals = counts();
    return {
      ok: true,
      phase: state.phase,
      done: state.done,
      total: state.total,
      concurrency: Math.max(1, Math.min(12, Number(options.concurrency) || 8)),
      queued: Math.max(0, state.total - state.done),
      startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null,
      lastBuiltAt: cache.builtAt,
      lastError: state.lastError,
      complete: state.complete,
      counts: totals,
      cached: Boolean(cache.builtAt),
      memoryDir,
      dataDir: dir,
      warnings: state.warnings.slice(-3),
    };
  }

  return { run, maybeRefresh, getGraph, getStatus };
}
