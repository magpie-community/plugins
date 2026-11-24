// High-level mihomo controller operations.
import { connect } from './pipe.mjs';
import { catalogue, pickMainGroup, delayOf } from './nodes.mjs';

const DEFAULT_TEST_URL = 'http://www.gstatic.com/generate_204';

export function createController(opts = {}) {
  let client = null;
  const get = async () => {
    if (!client) client = await connect(opts);
    return client;
  };

  return {
    async target() { return (await get()).target; },
    async version() {
      const c = await get();
      const r = await c.get('/version');
      return r.json?.version || r.text.trim();
    },
    async configs() {
      const c = await get();
      const r = await c.get('/configs');
      return r.json || {};
    },

    /** Everything: groups, nodes, current picks, delays. */
    async state() {
      const c = await get();
      const r = await c.get('/proxies');
      if (r.status !== 200 || !r.json?.proxies) throw new Error(`GET /proxies -> ${r.status}`);
      const cat = catalogue(r.json.proxies);
      return {
        ...cat,
        groups: cat.groups.map((g) => ({
          ...g,
          nodes: g.all.filter((n) => cat.nodes.some((x) => x.name === n)),
        })),
        mainGroup: pickMainGroup(cat.groups, opts.group || '')?.name || '',
      };
    },

    /** Switch one selector group to a node. Returns mihomo's response. */
    async select(group, node) {
      const c = await get();
      const r = await c.put(`/proxies/${encodeURIComponent(group)}`, { name: node });
      if (r.status !== 204 && r.status !== 200) {
        throw new Error(`切换 ${group} -> ${node} 失败: HTTP ${r.status} ${r.text.slice(0, 200)}`);
      }
      return r;
    },

    /** Convenience: switch the main selector group (the one the tray uses). */
    async selectMain(node, group) {
      const st = await this.state();
      const g = group || st.mainGroup;
      if (!g) throw new Error('没有可用的选择器分组');
      await this.select(g, node);
      return g;
    },

    /** Test one node's latency. */
    async delay(node, url = DEFAULT_TEST_URL, timeout = 5000) {
      const c = await get();
      const q = `timeout=${timeout}&url=${encodeURIComponent(url)}`;
      const r = await c.get(`/proxies/${encodeURIComponent(node)}/delay?${q}`, { timeout: timeout + 4000 });
      if (r.status !== 200 || typeof r.json?.delay !== 'number') return null;
      return r.json.delay;
    },

    /** Test a group quickly (mihomo's own group delay endpoint). */
    async groupDelay(group, url = DEFAULT_TEST_URL, timeout = 5000) {
      const c = await get();
      const q = `timeout=${timeout}&url=${encodeURIComponent(url)}`;
      const r = await c.get(`/group/${encodeURIComponent(group)}/delay?${q}`, { timeout: timeout + 10000 });
      return r.json || {};
    },

    /** Test many nodes with bounded concurrency; returns {name: ms|null}. */
    async delays(nodes, { concurrency = 8, url = DEFAULT_TEST_URL, timeout = 5000 } = {}) {
      const out = {};
      let i = 0;
      const workers = Array.from({ length: Math.min(concurrency, nodes.length) }, async () => {
        for (;;) {
          const idx = i++;
          if (idx >= nodes.length) return;
          const n = nodes[idx];
          out[n] = await this.delay(n, url, timeout);
        }
      });
      await Promise.all(workers);
      return out;
    },

    /** Refresh delays in a state object (mutates nodes by name). */
    async withDelays(state, opts) {
      const names = state.nodes.map((n) => n.name);
      const ds = await this.delays(names, opts);
      for (const n of state.nodes) n.delay = ds[n.name] ?? n.delay;
      return state;
    },

    /** Drop existing connections so new ones use the freshly selected node. */
    async dropConnections() {
      const c = await get();
      try { await c.del('/connections'); } catch { /* mihomo may close before replying */ }
    },

    /** Live connections (for observability). */
    async connections() {
      const c = await get();
      const r = await c.get('/connections');
      return r.json || {};
    },
  };
}

export { delayOf };
