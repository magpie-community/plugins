// Discover every account / key a magpie provider has, so each one can be
// given a node of its own through providers.json's `accountProxies`.
//
// Fast path (default): read magpie's own files — no process, works inside
// magpie's Bun plugin host without spawning a second host. `logins.json`
// lists every signed-in subscription account, `providers.json` holds the
// keys already assigned. `useCli: true` adds `magpie accounts --json` for
// its `active` flags (only from a normal CLI, never from inside the host).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { magpieDir, readProviders } from './magpie.mjs';

const CLI_CANDIDATES = [
  process.env.MAGPIE_CLI,
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'magpie', 'magpie.com'),
  '/usr/local/bin/magpie', '/opt/homebrew/bin/magpie',
].filter(Boolean);

export function findCli() {
  for (const p of CLI_CANDIDATES) {
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return 'magpie';
}

export function accountKey(user) {
  return String(user || '').trim().toLowerCase();
}

/** "2134502641@qq.com (z6tldk)" and "2134502641@qq.com" are one identity. */
export function baseAccountKey(user) {
  return accountKey(String(user || '').replace(/\s*\([^()]*\)\s*$/, ''));
}

/** Parse `magpie accounts --json` output, tolerating log lines before the array. */
export function parseAccounts(text) {
  const s = text.indexOf('[');
  const e = text.lastIndexOf(']');
  if (s < 0 || e <= s) return [];
  try {
    const rows = JSON.parse(text.slice(s, e + 1));
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

export function loginsPath() { return path.join(magpieDir(), 'logins.json'); }

/**
 * magpie sometimes keeps a placeholder "account" whose user is just the
 * provider's own name (ZCode writes one with home "zcode" and user "ZCode").
 * It is not a real sign-in and must not appear as an assignable account.
 */
export function isPhantomAccount(providerId, user, providerNames = {}) {
  const u = String(user || '').trim();
  if (!u) return true;
  const norm = (s) => String(s || '').toLowerCase().replace(/[\s_\-.]/g, '');
  const nu = norm(u);
  if (nu === norm(providerId)) return true;
  const display = providerNames[providerId];
  if (display && nu === norm(display)) return true;
  // "API key" / "API Key" placeholders are real key accounts only when a key
  // is present; callers decide that, so leave them here.
  return false;
}

/**
 * All assignable identities.
 * @returns {{providerId, key, label, kind:'account'|'key', active, on, source}[]}
 */
export function listAccounts(opts = {}) {
  const data = readProviders();
  const out = [];
  const seen = new Set();
  const providerNames = {};
  for (const p of data.providers) providerNames[p.id] = p.name || '';

  const add = (providerId, key, label, kind, extra = {}) => {
    const k = accountKey(key);
    if (!providerId || !k) return false;
    if (isPhantomAccount(providerId, key, providerNames)) return false;
    const id = `${providerId}\u0000${k}`;
    if (seen.has(id)) return false;
    seen.add(id);
    out.push({ providerId, key: k, label: label || key, kind, active: false, on: true, ...extra });
    return true;
  };
  const enrich = (providerId, key, extra) => {
    const a = out.find((x) => x.providerId === providerId && x.key === accountKey(key));
    if (a) Object.assign(a, extra);
  };

  // 1. magpie's own account list (optional; never from inside the plugin host).
  const cliBases = new Set();
  if (opts.useCli) {
    try {
      const r = spawnSync(opts.cli || findCli(), ['accounts', '--json'], {
        encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
        timeout: opts.timeout || 45000, windowsHide: true,
      });
      for (const a of parseAccounts(r.stdout || '')) {
        const providerId = a.agent || a.provider || '';
        const user = a.user || a.email || a.name || '';
        if (add(providerId, user, user, 'account', {
          active: !!a.active, on: a.on !== false, plan: a.plan || '', source: 'cli',
        })) cliBases.add(`${providerId}\u0000${baseAccountKey(user)}`);
      }
    } catch { /* fall through to files */ }
  }

  // 2. Every signed-in subscription account, straight from logins.json — but
  // only when the CLI list (richer: it knows slots and active flags) does not
  // already carry the same identity.
  const logins = readJson(loginsPath());
  if (Array.isArray(logins)) {
    for (const l of logins) {
      const providerId = String(l.home || l.agent || '').replace(/^plugin:/, '').split('#')[0];
      const user = l.user || l.email || l.name || '';
      if (cliBases.has(`${providerId}\u0000${baseAccountKey(user)}`)) continue;
      const added = add(providerId, user, user, 'account', {
        on: l.on !== false, plan: l.plan || '', source: 'logins',
      });
      if (!added) enrich(providerId, user, { on: l.on !== false, plan: l.plan || '' });
    }
  }

  // 3. Accounts already in accountProxies, and multiple API keys.
  for (const p of data.providers) {
    for (const k of Object.keys(p.accountProxies || {})) add(p.id, k, k, 'account', { source: 'stored' });
    for (const k of (p.keys || [])) {
      if (k && typeof k === 'object' && k.id) add(p.id, k.id, k.name || k.id, 'key', { source: 'keys' });
      else if (typeof k === 'string') add(p.id, k, k, 'key', { source: 'keys' });
    }
  }

  const ids = new Set(data.providers.map((p) => p.id));
  return out.filter((a) => ids.has(a.providerId) || a.source === 'stored');
}

/** Cache of the CLI's account list, for a host that shouldn't spawn magpie. */
export function accountCachePath() { return path.join(magpieDir(), 'clash-nodes', 'accounts.json'); }
export function readAccountCache(maxAgeMs = 60 * 60 * 1000) {
  try {
    const f = accountCachePath();
    const s = fs.statSync(f);
    if (Date.now() - s.mtimeMs > maxAgeMs) return null;
    const j = readJson(f);
    const list = Array.isArray(j?.accounts) ? j.accounts : null;
    if (!list) return null;
    // an old cache may still carry the provider-name placeholder
    const data = readProviders();
    const names = {};
    for (const p of data.providers) names[p.id] = p.name || '';
    return list.filter((a) => !isPhantomAccount(a.providerId, a.key, names));
  } catch { return null; }
}
export function writeAccountCache(accounts) {
  const f = accountCachePath();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ at: Date.now(), accounts }, null, 2));
}

export function groupAccounts(accounts) {
  const m = new Map();
  for (const a of accounts) {
    if (!m.has(a.providerId)) m.set(a.providerId, []);
    m.get(a.providerId).push(a);
  }
  return m;
}

/** Build `{ providerId: { accountKey: proxyUrl } }` from a node->port map. */
export function buildAccountPlan({ accounts, mapping, delays = {}, strategy = 'spread', selectedNodes = [], only = [], providerIds = [] }) {
  const urls = Object.entries(mapping || {}).map(([node, port]) => ({ node, url: `http://127.0.0.1:${port}` }));
  if (urls.length === 0) throw new Error('没有可用的节点端口，先启动节点实例');
  const pool = (selectedNodes.length ? urls.filter((u) => selectedNodes.includes(u.node)) : urls);
  const usable = pool.length ? pool : urls;
  const sorted = strategy === 'fastest'
    ? [...usable].sort((a, b) => (delays[a.node] ?? 1e9) - (delays[b.node] ?? 1e9))
    : usable;
  const want = accounts.filter((a) =>
    (!providerIds.length || providerIds.includes(a.providerId)) &&
    (!only.length || only.includes(`${a.providerId}\u0000${a.key}`) || only.includes(a.key)),
  );

  const plan = {};
  let i = 0;
  for (const a of want) {
    if (!plan[a.providerId]) plan[a.providerId] = {};
    if (strategy === 'none' || strategy === 'clear') { plan[a.providerId][a.key] = ''; continue; }
    const u = strategy === 'fastest' ? sorted[0] : sorted[i % sorted.length];
    plan[a.providerId][a.key] = u.url;
    i++;
  }
  return plan;
}

/** Where each account currently goes, for display. `mapping` is node->port. */
export function describeAccounts(accounts, mapping = {}) {
  const data = readProviders();
  const reverse = Object.fromEntries(Object.entries(mapping).map(([n, p]) => [`http://127.0.0.1:${p}`, n]));
  const byId = new Map(data.providers.map((p) => [p.id, p]));
  return accounts.map((a) => {
    const p = byId.get(a.providerId);
    const raw = p?.accountProxies?.[a.key] || '';
    return {
      ...a,
      proxy: raw,
      node: raw === 'direct' ? '直连' : raw ? (reverse[raw] || raw) : (p?.proxy ? (reverse[p.proxy] || '跟随供应商') : '跟随供应商'),
      // a saved proxy whose node/port is gone from the running instance
      stale: !!raw && raw !== 'direct' && !reverse[raw],
    };
  });
}

export { magpieDir };
