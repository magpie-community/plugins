/**
 * magpie plugin host for the Clash nodes page/panel.
 *
 * The page and the provider panel run in magpie's sandboxed iframes: no fetch,
 * no inline scripts, no frames of their own. Their only channel to us is
 * `magpie.options.set()` (which reloads this host). So:
 *
 *   page  --options.set({cmd, cmdId})-->  magpie  -->  this host restarts
 *   host  --executes cmd, rewrites page/state.js-->  page
 *   page  --<script src="state.js?v=…">-->  fresh state
 *
 * `cmdId` is deduplicated by plugin-last-cmd.json, so a reload never repeats
 * a command. All the real work (mihomo named-pipe controller, per-node
 * listeners, providers.json) lives in ./lib — the same zero-dependency code
 * the standalone clash-nodes CLI uses. Bun supports node:net pipes here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createController } from './lib/controller.mjs';
import * as router from './lib/router.mjs';
import * as magpie from './lib/magpie.mjs';
import * as accountsLib from './lib/accounts.mjs';
import * as profiles from './lib/profiles.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(magpie.magpieDir(), 'clash-nodes');
const STATE_JSON = path.join(DIR, 'plugin-state.json');
const LAST_CMD = path.join(DIR, 'plugin-last-cmd.json');
const STATE_FILES = [path.join(HERE, 'page', 'state.js')];
const PROFILES_FILE = path.join(DIR, 'profiles.json');
const DELAYS_FILE = path.join(DIR, 'delays.json');
const PORTS_MIGRATED = path.join(DIR, 'ports-v2.flag');

const now = () => new Date().toISOString();

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
function writeStateJs(state, opts = {}) {
  const text = `window.__CLASH_NODES_STATE__ = ${JSON.stringify(state)};\n`;
  for (const file of STATE_FILES) {
    // magpie reloads the page when a file in the plugin directory changes, and
    // that reload runs collect() again. Writing an identical state would loop
    // the host at about once a second, so an auto-start run leaves the file
    // alone unless the rest of the state changed. A command still forces the
    // write: the page watches generatedAt to know its request landed.
    let prev = '';
    try { prev = fs.readFileSync(file, 'utf8'); } catch { /* first write */ }
    if (!opts.force && sameStateText(prev, text)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

function sameStateText(prev, next) {
  if (!prev) return false;
  if (prev === next) return true;
  try {
    const a = JSON.parse(prev.replace(/^window\.__CLASH_NODES_STATE__ = /, '').replace(/;\s*$/, ''));
    const b = JSON.parse(next.replace(/^window\.__CLASH_NODES_STATE__ = /, '').replace(/;\s*$/, ''));
    delete a.generatedAt;
    delete b.generatedAt;
    if (a.last) delete a.last.at;
    if (b.last) delete b.last.at;
    return JSON.stringify(a) === JSON.stringify(b);
  } catch { return false; }
}

// The user's usable-node pool, kept across restarts.
// `mode: "selected"` is a strict whitelist: only `nodes` get local ports and
// an empty list means no node at all. `mode: "all"` is only set by an explicit
// "全部节点" action, never as the silent meaning of an empty selection.
const POOL_FILE = path.join(DIR, 'pool.json');
function readPoolState() {
  const j = readJson(POOL_FILE, null);
  if (!j || typeof j !== 'object' || !Array.isArray(j.nodes)) {
    return { mode: 'selected', nodes: [], initialized: false, auto: false };
  }
  const nodes = j.nodes.filter((n) => typeof n === 'string' && n);
  // Legacy format: { nodes: [] } meant "all" (the old code's empty sentinel).
  // Treat it as not initialized so the first run materialises a concrete
  // default list instead of silently opening hundreds of ports.
  const initialized = j.mode === 'all' || j.mode === 'selected' || nodes.length > 0;
  const mode = j.mode === 'all' ? 'all' : 'selected';
  return { mode, nodes, initialized, auto: !!j.auto, at: j.at || 0 };
}
function writePoolState(state) {
  writeJson(POOL_FILE, {
    mode: state.mode === 'all' ? 'all' : 'selected',
    nodes: state.nodes,
    auto: !!state.auto,
    at: Date.now(),
  });
}

// Default first-run whitelist. A 700-node subscription must not open 700
// listeners, so pick a balanced sample across subscriptions and show it as
// explicitly checked; the user can then add or remove individual nodes.
const MAX_DEFAULT_LISTENERS = 120;
function balancedDefault(nodes) {
  const list = (nodes || []).map((x) => (typeof x === 'string' ? { name: x, profile: '' } : x));
  if (list.length <= MAX_DEFAULT_LISTENERS) return list.map((x) => x.name);
  const groups = new Map();
  for (const n of list) {
    const k = n.profile || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(n.name);
  }
  const out = [];
  for (let i = 0; out.length < MAX_DEFAULT_LISTENERS; i++) {
    let added = false;
    for (const arr of groups.values()) {
      if (i < arr.length) {
        out.push(arr[i]);
        added = true;
        if (out.length >= MAX_DEFAULT_LISTENERS) break;
      }
    }
    if (!added) break;
  }
  return out;
}
function ensurePool(nodes) {
  const p = readPoolState();
  if (p.initialized) return p;
  const names = (nodes || []).map((x) => (typeof x === 'string' ? x : x.name));
  if (!names.length) return p;
  const picked = balancedDefault(nodes);
  const next = { mode: 'selected', nodes: picked, initialized: true, auto: names.length > MAX_DEFAULT_LISTENERS };
  writePoolState(next);
  return next;
}

// Which Clash Party subscriptions take part. Missing file = only the active one.
function readSelectedProfiles() {
  const j = readJson(PROFILES_FILE, null);
  if (j && Array.isArray(j.profiles)) return j.profiles.filter((x) => typeof x === 'string');
  const all = profiles.listProfiles();
  const act = all.find((p) => p.active);
  if (!act) return [];
  // Freeze the first choice: a later change of Clash's active profile must not
  // silently move which subscription this plugin serves.
  writeSelectedProfiles([act.id]);
  return [act.id];
}
function writeSelectedProfiles(ids) { writeJson(PROFILES_FILE, { profiles: ids, at: Date.now() }); }

// Older versions used bare node names; multi-subscription names are prefixed
// ("一元机场 · 香港01"). Carry the old port and pool choices over so saved
// account proxies keep pointing at the same physical node.
function migrateLegacyNames(cat) {
  try {
    const active = (cat.profiles.find((p) => p.active) || {}).id || '';
    const byOrig = new Map();
    for (const n of cat.nodes) {
      const cur = byOrig.get(n.originalName);
      if (!cur || n.profileId === active) byOrig.set(n.originalName, n.name);
    }
    const pf = router.portsPath();
    const ports = readJson(pf, {});
    let changed = false;
    for (const n of cat.nodes) {
      if (ports[n.name] === undefined && ports[n.originalName] !== undefined) {
        ports[n.name] = ports[n.originalName];
        changed = true;
      }
    }
    if (changed) writeJson(pf, ports);
    const pool = readPoolState();
    if (pool.nodes.length) {
      const next = pool.nodes.map((x) => byOrig.get(x) || x);
      if (next.join('\u0000') !== pool.nodes.join('\u0000')) writePoolState({ ...pool, nodes: next });
    }
  } catch { /* migration is best effort */ }
}

// One-time repair of ports.json. Older versions stored bare node names; the
// first multi-subscription attempt also allocated prefixed names on top of
// them. Keep only the legacy port each active-subscription node had, so the
// URLs already written into magpie's accountProxies still reach that node.
function ensurePortsMigrated(cat) {  if (fs.existsSync(PORTS_MIGRATED)) return;
  try {
    const pf = router.portsPath();
    const ports = readJson(pf, {});
    const legacy = {};
    for (const [k, v] of Object.entries(ports)) if (!k.includes('·')) legacy[k] = v;
    if (Object.keys(legacy).length) {
      const active = (cat.profiles.find((p) => p.active) || {}).id || '';
      const next = {};
      for (const n of cat.nodes) {
        if (n.profileId === active && legacy[n.originalName] !== undefined) next[n.name] = legacy[n.originalName];
      }
      writeJson(pf, next);
    }
    fs.writeFileSync(PORTS_MIGRATED, new Date().toISOString());
  } catch { /* best effort */ }
}

function loadCatalogue() {
  let cat;
  try { cat = profiles.loadCatalogue(readSelectedProfiles()); }
  catch { cat = { profiles: [], chosen: [], nodes: [], blocks: [] }; }
  if (cat.nodes.length) { ensurePortsMigrated(cat); migrateLegacyNames(cat); }
  return cat;
}
function readDelays() { return readJson(DELAYS_FILE, {}); }
function writeDelays(map) { writeJson(DELAYS_FILE, map); }

function effectivePool(pool, nodes) {
  const list = (nodes || []).map((x) => (typeof x === 'string' ? { name: x } : x));
  const names = list.map((x) => x.name);
  if (pool.mode === 'all') return names;
  const present = new Set(names);
  return pool.nodes.filter((n) => present.has(n));
}

async function collect(c, error) {
  let st = null;
  try { st = await c.state(); } catch (e) { if (!error) error = e?.message || String(e); }
  let r = router.routerStatus();
  if (r.running && !(await router.instanceAlive())) {
    // never report a dead instance as ready — clear the stale state file
    await router.stopRouter({ quiet: true }).catch(() => {});
    r = router.routerStatus();
  }
  const cat = loadCatalogue();
  const useProfiles = cat.nodes.length > 0;
  const delayMap = readDelays();
  const nodes = useProfiles
    ? cat.nodes.map((n) => ({
        name: n.name, originalName: n.originalName, type: n.type, region: n.region, alive: true,
        delay: typeof delayMap[n.name] === 'number' ? delayMap[n.name] : null,
        profile: n.profileName, profileId: n.profileId,
      }))
    : (st ? st.nodes : []);
  const pool = ensurePool(nodes);
  const currentNames = nodes.map((n) => n.name);
  const eff = effectivePool(pool, nodes);
  const poolTruncated = !!pool.auto && nodes.length > MAX_DEFAULT_LISTENERS;
  const drift = pool.mode === 'selected' ? {
    missing: pool.nodes.filter((n) => !currentNames.includes(n)),
    added: currentNames.filter((n) => !pool.nodes.includes(n)),
  } : { missing: [], added: [] };
  const staleInstance = r.running &&
    JSON.stringify(Object.keys(r.mapping || {}).sort()) !== JSON.stringify(eff.slice().sort());
  let providers = [];
  try { providers = magpie.describe(magpie.readProviders(), r.mapping || {}); } catch { /* magpie absent */ }
  let accounts = [];
  try {
    // currentAccounts reads logins.json + providers.json fresh every render, so
    // an account added/removed in magpie shows up on the next paint; the cache
    // is only a fallback when that read throws.
    accounts = accountsLib.describeAccounts(accountsLib.currentAccounts(), r.mapping || {});
  } catch { /* no accounts */ }
  return {
    generatedAt: now(),
    // the page never reads this; pipe targets carry the controller secret
    // (read from the user's config.yaml) — keep it out of state.js
    controller: null,
    version: await c.version().catch(() => ''),
    mainGroup: st ? st.mainGroup : '',
    current: st ? (st.groups.find((g) => g.name === st.mainGroup)?.now || '') : '',
    groups: st ? st.groups.map((g) => ({ name: g.name, type: g.type, now: g.now, nodes: g.nodes })) : [],
    profiles: cat.profiles.map((p) => ({ id: p.id, label: p.label, active: p.active, updatedAt: p.updatedAt || 0 })),
    profileCounts: cat.counts || {},
    profileChosen: cat.chosen,
    multiProfile: useProfiles,
    nodes,
    pool: pool.nodes,
    poolMode: pool.mode,
    poolEffective: eff,
    poolTruncated,
    drift,
    staleInstance,
    router: r,
    starting: startInFlight(),
    providers,
    accounts,
    error: error || null,
  };
}

/** Node ports must exist, be alive, and match the pool before an assignment lands. */
/** Running instance already serves exactly these names on their saved ports? */
function mappingMatches(r, names) {
  if (!r.running) return false;
  const map = r.mapping || {};
  if (JSON.stringify(Object.keys(map).sort()) !== JSON.stringify(names.slice().sort())) return false;
  const desired = readJson(router.portsPath(), {});
  return names.every((n) => desired[n] === undefined || map[n] === desired[n]);
}

async function ensureRouter(c) {
  const cat = loadCatalogue();
  let sourceNodes;
  let blockMap = null;
  if (cat.nodes.length) {
    sourceNodes = cat.nodes;
    blockMap = Object.fromEntries(cat.nodes.map((n) => [n.name, n.raw]));
  } else {
    const st = await c.state();
    sourceNodes = st.nodes;
  }
  const pool = ensurePool(sourceNodes);
  const eff = effectivePool(pool, sourceNodes);
  const r = router.routerStatus();
  if (r.running && !(await router.instanceAlive())) {
    // state file says running but the mihomo died: clear the lie, respawn
    await router.stopRouter({ quiet: true }).catch(() => {});
  } else if (!eff.length) {
    // Strict whitelist: an empty pool really means no node ports at all.
    if (r.running) await router.stopRouter({ quiet: true }).catch(() => {});
    return router.routerStatus();
  } else if (mappingMatches(r, eff)) {
    return r;
  } else if (r.running) {
    await router.stopRouter({ quiet: true }).catch(() => {});
  }
  const proxyBlocks = blockMap ? eff.map((n) => blockMap[n]).filter(Boolean) : undefined;
  return await router.startRouter(eff, { proxyBlocks });
}

async function execute(cmd, c) {
  let r = router.routerStatus();
  if (r.running && !(await router.instanceAlive())) {
    await router.stopRouter({ quiet: true }).catch(() => {});
    r = router.routerStatus();
  }
  switch (cmd.do) {
    case 'refresh':
      return { ok: true, message: '已刷新', at: now() };

    case 'select': {
      const group = await c.selectMain(cmd.node, cmd.group);
      if (cmd.drop) await c.dropConnections();
      return { ok: true, message: `已切换 ${group} → ${cmd.node}`, at: now() };
    }

    case 'test': {
      const rr = await ensureRouter(c);
      if (!rr.running) throw new Error('节点池为空，请先勾选节点并保存');
      const names = Object.keys(rr.mapping || {});
      const delays = await router.testDelays(names, { controllerPort: rr.controllerPort, concurrency: 8 });
      writeDelays({ ...readDelays(), ...delays });
      const ok = Object.values(delays).filter((v) => typeof v === 'number').length;
      return { ok: true, message: `测速完成：${ok}/${names.length} 个节点可用`, at: now() };
    }

    case 'start': {
      const cat = loadCatalogue();
      const sourceNodes = cat.nodes.length ? cat.nodes : (await c.state()).nodes;
      const currentNames = sourceNodes.map((n) => n.name);
      const pool = ensurePool(sourceNodes);
      const names = cmd.nodes?.length
        ? cmd.nodes.filter((n) => currentNames.includes(n))
        : effectivePool(pool, sourceNodes);
      if (!names.length) throw new Error('节点池为空，请先勾选节点并保存');
      const blockMap = Object.fromEntries(cat.nodes.map((n) => [n.name, n.raw]));
      const proxyBlocks = cat.nodes.length ? names.map((n) => blockMap[n]).filter(Boolean) : undefined;
      // An explicit node list comes from the CLI, which has no load budget and
      // can wait. The bare `start` button uses the saved pool, so it can be
      // rebuilt in the background and polled from the page.
      if (cmd.nodes?.length) {
        const s = await router.startRouter(names, {
          basePort: cmd.basePort, controllerPort: cmd.controllerPort, proxyBlocks,
        });
        return { ok: true, message: `已就绪 ${names.length} 个节点端口（pid ${s.pid}）`, at: now() };
      }
      startNodePorts(c);
      return { ok: true, message: `正在启动 ${names.length} 个节点端口…`, at: now() };
    }

    case 'setPool': {
      const cat = loadCatalogue();
      const sourceNodes = cat.nodes.length ? cat.nodes : (await c.state()).nodes;
      const currentNames = sourceNodes.map((n) => n.name);
      const mode = cmd.mode === 'all' ? 'all' : 'selected';
      const names = mode === 'all'
        ? currentNames
        : (cmd.nodes || []).filter((n) => currentNames.includes(n));
      writePoolState({ mode, nodes: names, auto: false });
      const eff = effectivePool({ mode, nodes: names }, sourceNodes);
      const prev = router.routerStatus();
      if (!eff.length) {
        await router.stopRouter({ quiet: true }).catch(() => {});
      } else if (!mappingMatches(prev, eff)) {
        startNodePorts(c);
      }
      return {
        ok: true,
        message: mode === 'all'
          ? `节点池已设为全部 ${eff.length} 个节点`
          : (eff.length ? `节点池已保存：${eff.length} 个节点可用` : '节点池已清空：现在没有可用节点'),
        at: now(),
      };
    }

    case 'setProfiles': {
      const ids = (cmd.profiles || []).filter((x) => typeof x === 'string');
      writeSelectedProfiles(ids);
      const cat = loadCatalogue();
      const pool = ensurePool(cat.nodes);
      const names = effectivePool(pool, cat.nodes);
      const blockMap = Object.fromEntries(cat.nodes.map((n) => [n.name, n.raw]));
      const proxyBlocks = names.map((n) => blockMap[n]).filter(Boolean);
      if (!names.length) {
        await router.stopRouter({ quiet: true }).catch(() => {});
      } else {
        await router.startRouter(names, { proxyBlocks });
      }
      return {
        ok: true,
        message: ids.length
          ? `已启用 ${ids.length} 个订阅：${cat.nodes.length} 个节点${names.length ? '' : '（节点池里没有属于这些订阅的节点，请重新勾选）'}`
          : `已启用全部 ${cat.profiles.length} 个订阅：${cat.nodes.length} 个节点${names.length ? '' : '（节点池为空，请勾选节点）'}`,
        at: now(),
      };
    }

    case 'stop':
      await router.stopRouter({ quiet: true });
      return { ok: true, message: '已停止节点实例', at: now() };

    case 'assign': {
      const rr = await ensureRouter(c);
      const delays = readDelays();
      let providers = magpie.listProviders();
      if (cmd.providerIds?.length) providers = providers.filter((p) => cmd.providerIds.includes(p.id));
      const plan = magpie.buildPlan({
        providers, mapping: rr.mapping, delays,
        strategy: cmd.strategy || 'spread', selectedNodes: cmd.nodes || [],
      });
      const out = magpie.applyPlan(plan);
      return { ok: true, message: `已分配 ${out.applied.length} 个供应商`, at: now() };
    }

    case 'assignProvider': {
      await ensureRouter(c);
      magpie.applyPlan({ [cmd.id]: cmd.proxy ?? '' });
      return { ok: true, message: `${cmd.id} → ${cmd.proxy || '跟随全局'}`, at: now() };
    }

    case 'assignAccount': {
      await ensureRouter(c);
      magpie.applyAccountPlans({ [cmd.id]: { [cmd.account]: cmd.proxy ?? '' } });
      return { ok: true, message: `${cmd.id} / ${cmd.account} → ${cmd.proxy || '跟随供应商'}`, at: now() };
    }

    case 'assignAccountPlans': {
      await ensureRouter(c);
      const plans = cmd.plans || {};
      const count = Object.values(plans).reduce((n, m) => n + Object.keys(m || {}).length, 0);
      magpie.applyAccountPlans(plans);
      return { ok: true, message: `已为 ${count} 个账号指定节点`, at: now() };
    }

    case 'assignAccounts': {
      const rr = await ensureRouter(c);
      const list = accountsLib.currentAccounts();
      const delays = readDelays();
      const plan = accountsLib.buildAccountPlan({
        accounts: list, mapping: rr.mapping, delays,
        strategy: cmd.strategy || 'spread',
        selectedNodes: cmd.nodes || [],
        providerIds: cmd.providerIds || [],
        only: cmd.only || [],
      });
      const count = Object.values(plan).reduce((n, m) => n + Object.keys(m).length, 0);
      magpie.applyAccountPlans(plan);
      return { ok: true, message: `已为 ${count} 个账号分配节点`, at: now() };
    }

    case 'restore': {
      const out = magpie.restore();
      return { ok: true, message: `已还原 ${out.restored.length} 个供应商`, at: now() };
    }

    default:
      throw new Error(`未知命令: ${cmd.do}`);
  }
}

// magpie gives a plugin 20s to load, and 30 other plugins share that budget.
// Starting the node ports costs 6-14s here, which is why the install timed out
// and the host kept reloading. So a start runs in the background and the page
// polls `router.starting` until the fresh state lands.
const STARTING_FILE = path.join(router.stateDir(), 'starting.json');
let startingAt = 0;
let lastCommand = null;

function startInFlight() {
  if (startingAt) return true;
  const lock = readJson(STARTING_FILE, null);
  return !!lock && Date.now() - (lock.at || 0) < 120000;
}

/** Only providers pointed at 127.0.0.1:180xx need the ports kept alive. */
function portsReferenced() {
  try {
    const ours = (v) => typeof v === 'string' && /^http:\/\/127\.0\.0\.1:18\d{3}$/.test(v);
    return magpie.readProviders().providers.some(
      (p) => ours(p.proxy) || Object.values(p.accountProxies || {}).some(ours),
    );
  } catch { return false; }
}

function startNodePorts(c) {
  if (startInFlight()) return false;
  startingAt = Date.now();
  writeJson(STARTING_FILE, { at: startingAt, pid: process.pid });
  (async () => {
    let err = null;
    try {
      const rr = await ensureRouter(c);
      const n = Object.keys((rr && rr.mapping) || {}).length;
      lastCommand = {
        ok: true,
        message: n ? `已就绪 ${n} 个节点端口` : '节点池为空，没有启动端口',
        at: now(),
      };
    } catch (e) {
      err = e?.message || String(e);
      lastCommand = { ok: false, message: err, at: now() };
    }
    startingAt = 0;
    try { fs.unlinkSync(STARTING_FILE); } catch {}
    try {
      const st = await collect(c, err);
      st.last = lastCommand;
      writeJson(STATE_JSON, st);
      writeStateJs(st);
    } catch { /* the next load retries */ }
  })();
  return true;
}

async function run(options) {
  const prev = readJson(STATE_JSON, {});
  let error = null;
  // A message from an earlier session is not news: show one only when this
  // run actually executed a command.
  let last = null;
  const c = createController({ group: options.group || '' });

  // magpie keeps the last options.set() in plugins.json and reloads the host
  // with them. Without a freshness check an old command would replay on every
  // restart (e.g. re-enabling a subscription the user had turned off). Page
  // commands carry a Date.now() prefix; manual CLI commands (no timestamp)
  // are trusted as-is.
  const cmdTs = Number(String(options.cmdId || '').split('-')[0]);
  const commandFresh = !Number.isFinite(cmdTs) || cmdTs < 1e12 ? true : (Date.now() - cmdTs < 120000);

  try {
    const cmd = options.cmd;
    const done = readJson(LAST_CMD, {});
    if (cmd && options.cmdId && done.id !== options.cmdId && commandFresh) {
      try { last = await execute(cmd, c); }
      catch (e) { error = e?.message || String(e); last = { ok: false, message: error, at: now() }; }
      writeJson(LAST_CMD, { id: options.cmdId, at: Date.now() });
    }
  } catch (e) { error = e?.message || String(e); }

  lastCommand = last;

  // Keep the per-node ports alive across magpie restarts: assignments in
  // providers.json point at them, so a dead instance means broken providers.
  // Never awaited — see STARTING_FILE above.
  if (options.autoStart !== false && (router.routerStatus().running || portsReferenced())) {
    startNodePorts(c);
  }

  let state;
  try { state = await collect(c, error); }
  catch (e) {
    state = { ...prev, generatedAt: now(), error: e?.message || String(e) };
  }
  // Keep the previous message on an auto-start run: a fresh `last` object on
  // every host start is exactly what used to rewrite state.js in a loop.
  state.last = last || prev.last || null;
  writeJson(STATE_JSON, state);
  writeStateJs(state, { force: !!last });
  return state;
}

// The page's provider/account requests go straight to 127.0.0.1:180xx, so a
// dead router must be repaired even when nobody is looking at the plugin page.
// Every plugin-host generation keeps one lightweight timer; `unref` lets the
// host exit normally when magpie closes.
let watchdogTimer = null;
let staleLockChecked = 0;
function startWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(async () => {
    if (startInFlight()) {
      // A host killed mid-start leaves its lock behind: nobody clears it and
      // the providers keep aiming at dead ports for two minutes. Clear it as
      // soon as the recorded owner is provably gone.
      const lock = readJson(STARTING_FILE, null);
      if (lock && lock.pid && lock.pid !== process.pid && lock.at !== staleLockChecked
        && Date.now() - (lock.at || 0) > 20000 && !(await router.pidAlive(lock.pid))) {
        staleLockChecked = lock.at;
        try { fs.unlinkSync(STARTING_FILE); } catch {}
      }
      return;
    }
    const r = router.routerStatus();
    if (r.running && await router.instanceAlive().catch(() => false)) return;
    if (!r.running && !portsReferenced()) return;
    startNodePorts(createController({}));
  }, 15000);
  if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref();
}

/** Only this function is exported: magpie calls every exported function as a plugin.
 *
 * The host is a page + local-state shape, not a provider: the page in ./page
 * sends commands through magpie.options.set(), this host runs them and writes
 * page/state.js for the next paint. We still return a tools hook so OpenCode
 * and magpie's plugin check see a real surface — `clash-nodes-status` lets an
 * agent ask which provider/account is routed through which node, read-only.
 *
 * Starting the host (spawning the mihomo instance, writing state) only makes
 * sense inside magpie's plugin host. OpenCode calls plugin functions with a
 * stub ctx whose `$` is undefined (scripts/check.mjs does the same); a real
 * call always carries the Bun shell there. That's the gate. */
export async function ClashNodesPlugin(input, options = {}) {
  const tools = {
    'clash-nodes-status': {
      description: 'Current Clash Verge node routing for magpie providers and accounts: which node each provider/account goes through, and which are pending. Read-only; use the plugin page to change assignments.',
      args: {},
      execute: async () => {
        try {
          const st = readJson(STATE_JSON, {});
          const providers = (st.providers || []).map((p) => ({
            provider: p.id,
            node: p.proxy || null,
            accounts: (st.accounts || []).filter((a) => a.providerId === p.id).map((a) => ({ account: a.key, node: a.proxy || null })),
          }));
          const pool = Array.isArray(st.pool) ? st.pool.length : 0;
          return { providers, pool, mode: st.poolMode || 'selected', last: st.last || null };
        } catch (e) {
          return { error: e?.message || String(e) };
        }
      },
    },
  };
  // OpenCode calls plugin functions with a stub ctx whose `$` is undefined
  // (scripts/check.mjs does the same); a real call carries the Bun shell.
  // That is the gate: in a stub environment we only describe our tools and
  // skip the host start so no mihomo is spawned and no state file written.
  if (!input || !input.$) return { tool: tools };
  try { await run(options || {}); } catch { /* never break plugin init */ }
  try { startWatchdog(); } catch { /* timer is best effort */ }
  return { tool: tools };
}
