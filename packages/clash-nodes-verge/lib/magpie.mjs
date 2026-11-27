// Read/write magpie's per-provider proxy choices.
// magpie >= 0.1.418 honours, for each provider and each signed-in account:
//   ""             -> follow the global proxy (the tray's own setting)
//   "direct"       -> no proxy at all
//   "http://…"     -> a custom HTTP / HTTPS / SOCKS5 proxy
// Its providers.json is re-read on demand, so edits take effect without a
// restart. We keep a snapshot so "restore" puts everything back exactly.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function magpieDir() {
  return process.env.MAGPIE_CONFIG_DIR || path.join(os.homedir(), '.config', 'magpie');
}
export function providersPath() { return path.join(magpieDir(), 'providers.json'); }
export function stateFile() { return path.join(magpieDir(), 'clash-nodes', 'magpie-state.json'); }

export function readProviders() {
  const p = providersPath();
  const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  const data = JSON.parse(raw);
  if (!Array.isArray(data.providers)) throw new Error(`${p} 里没有 providers 数组`);
  return data;
}

function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function writeProviders(data) {
  const p = providersPath();
  try { fs.copyFileSync(p, `${p}.clash-nodes.bak`); } catch {}
  atomicWrite(p, JSON.stringify(data, null, 2) + '\n');
}

export function listProviders(data = readProviders()) {
  return data.providers.map((p) => ({
    id: p.id,
    name: p.name || p.id,
    proxy: p.proxy || '',
    accountProxies: p.accountProxies || {},
    off: !!p.off,
    keyCount: (p.keys || []).length || (p.key ? 1 : 0),
    accounts: Object.keys(p.accountProxies || {}),
  }));
}

function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return { before: {}, appliedAt: null }; }
}
function saveState(s) {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  atomicWrite(stateFile(), JSON.stringify(s, null, 2) + '\n');
}

/**
 * Apply a plan. `plan` maps provider id -> proxy address, or
 * provider id -> { proxy, accountProxies: { user: address } }.
 */
export function applyPlan(plan, opts = {}) {
  const data = readProviders();
  const state = readState();
  const before = { ...(state.before || {}) };
  const applied = [];

  for (const [id, choice] of Object.entries(plan)) {
    const p = data.providers.find((x) => x.id === id);
    if (!p) throw new Error(`magpie 里没有这个供应商: ${id}`);
    if (!(id in before)) {
      before[id] = {
        proxy: p.proxy,
        accountProxies: p.accountProxies ? { ...p.accountProxies } : undefined,
        hadProxy: Object.prototype.hasOwnProperty.call(p, 'proxy'),
        hadAccountProxies: Object.prototype.hasOwnProperty.call(p, 'accountProxies'),
      };
    }
    const c = typeof choice === 'string' ? { proxy: choice } : choice;
    if (c.proxy !== undefined) p.proxy = c.proxy;
    if (c.accountProxies) {
      const merged = { ...(p.accountProxies || {}) };
      for (const [k, v] of Object.entries(c.accountProxies)) {
        const key = String(k).trim().toLowerCase();
        if (v === '' || v == null) delete merged[key];   // "" means "follow the provider"
        else merged[key] = v;
      }
      p.accountProxies = merged;
      if (Object.keys(merged).length === 0 && !before[id].hadAccountProxies) delete p.accountProxies;
    }
    applied.push({ id, proxy: p.proxy || '', accountProxies: p.accountProxies || {} });
  }

  if (!opts.dryRun) {
    writeProviders(data);
    saveState({ ...state, before, appliedAt: new Date().toISOString(), applied });
  }
  return { applied, before };
}

/** Convenience: assign per-account proxies. `plans` maps provider -> {account: url}. */
export function applyAccountPlans(plans, opts = {}) {
  const plan = {};
  for (const [id, m] of Object.entries(plans)) plan[id] = { accountProxies: m || {} };
  return applyPlan(plan, opts);
}

/** Put every provider/account proxy choice back the way it was. */
export function restore(opts = {}) {
  const state = readState();
  const before = state.before || {};
  if (Object.keys(before).length === 0) return { restored: [] };
  const data = readProviders();
  const restored = [];
  for (const p of data.providers) {
    const b = before[p.id];
    if (!b) continue;
    if (b.hadProxy) p.proxy = b.proxy; else delete p.proxy;
    if (b.hadAccountProxies) p.accountProxies = b.accountProxies; else delete p.accountProxies;
    restored.push(p.id);
  }
  if (!opts.dryRun) {
    writeProviders(data);
    saveState({ before: {}, appliedAt: null, applied: [] });
  }
  return { restored };
}

/**
 * Build a plan from a node->port map.
 * strategies: 'round-robin' | 'fastest' | 'spread' | 'none'
 */
export function buildPlan({ providers, mapping, delays = {}, strategy = 'spread', selectedNodes = [] }) {
  const urls = Object.entries(mapping).map(([node, port]) => ({ node, url: `http://127.0.0.1:${port}` }));
  if (urls.length === 0) throw new Error('没有可用的节点端口，先启动节点实例');
  const plan = {};

  if (strategy === 'fastest') {
    const best = [...urls].sort((a, b) => (delays[a.node] ?? 1e9) - (delays[b.node] ?? 1e9))[0];
    for (const p of providers) plan[p.id] = best.url;
    return plan;
  }
  if (strategy === 'round-robin' || strategy === 'spread') {
    const usable = selectedNodes.length
      ? urls.filter((u) => selectedNodes.includes(u.node))
      : urls;
    const pool = usable.length ? usable : urls;
    // Spread: one node per provider, cycling; round-robin: same but starts at 0.
    providers.forEach((p, i) => { plan[p.id] = pool[i % pool.length].url; });
    return plan;
  }
  if (strategy === 'none') {
    for (const p of providers) plan[p.id] = '';
    return plan;
  }
  throw new Error(`未知策略: ${strategy}`);
}

/** Which node a provider currently goes through. */
export function describe(providersData = readProviders(), mapping = {}) {
  const reverse = Object.fromEntries(Object.entries(mapping).map(([n, p]) => [`http://127.0.0.1:${p}`, n]));
  return listProviders(providersData).map((p) => ({
    ...p,
    node: reverse[p.proxy] || (p.proxy === '' ? '全局代理' : p.proxy === 'direct' ? '直连' : p.proxy),
    // a saved proxy whose node/port is no longer among the running instance
    stale: !!p.proxy && p.proxy !== 'direct' && !reverse[p.proxy],
    accountNodes: Object.fromEntries(Object.entries(p.accountProxies || {}).map(([u, v]) => [u, reverse[v] || v])),
  }));
}
