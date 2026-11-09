// Behaviour is judged from the outside: Magpie's control files in, the native
// nanobot configuration out. Every test gets its own temporary home, so the
// real ~/.nanobot and ~/.config/magpie-nanobot are never read or written.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PROVIDER, inspect, pathsFor, reconcile } from './bridge.mjs';
import { startRuntime } from './runtime.mjs';
import { agent, connect as connectAgent } from './nanobot.agent.js';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function sandbox(baseline = {}, linkedParent) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanobot-bridge-'));
  roots.push(root);
  let home = root;
  if (linkedParent) {
    const target = path.join(root, 'real-parent');
    const link = path.join(root, linkedParent);
    fs.mkdirSync(target);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, 'junction');
    if (linkedParent === 'home') home = link;
  }
  const paths = pathsFor({ home });
  fs.mkdirSync(path.dirname(paths.config), { recursive: true });
  fs.mkdirSync(paths.directory, { recursive: true });
  fs.writeFileSync(paths.config, `${JSON.stringify(baseline, null, 2)}\n`);
  return { root, paths, baseline };
}
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const control = (values = {}) => ({ model: 'deepseek/deepseek-flash', baseURL: 'https://gateway.example/v1', gatewayKey: 'test-key', ...values });
function applyModel(paths, values = {}) {
  write(paths.control, control(values));
  return reconcile(paths);
}

test.each(['home', '.nanobot', '.config', '.config/magpie-nanobot'])('applies and restores through a symlinked %s directory', linkedParent => {
  const { paths, baseline } = sandbox({ userSetting: 'keep' }, linkedParent);
  write(paths.control, control());
  write(paths.mcp, { mcpServers: { probe: { type: 'http', url: 'http://127.0.0.1:7345/mcp' } } });
  const { handle, statuses } = runtimeFor(paths);
  try {
    handle.tick(); handle.tick();
    expect(statuses.at(-1).state).toBe('file-applied');
    expect(readJson(paths.config).modelPresets[PROVIDER].model).toBe('deepseek/deepseek-flash');
    expect(readJson(paths.config).tools.ssrfWhitelist).toEqual(['127.0.0.1/32']);
    expect(inspect(paths).state).toBe('file-applied');
    expect(handle.stop({ restore: true }).state).toBe('disconnected');
    expect(readJson(paths.config)).toEqual(baseline);
    expect(fs.existsSync(paths.state)).toBe(false);
    expect(fs.existsSync(paths.pending)).toBe(false);
    expect(fs.existsSync(paths.lock)).toBe(false);
    expect(fs.existsSync(runtimeLock(paths))).toBe(false);
  } finally { handle.stop(); }
});

test.each(['config', 'control', 'mcp', 'state', 'pending', 'lock', 'pause', 'status'])('still refuses a symlinked %s file under a symlinked parent', key => {
  for (const dangling of [false, true]) {
    const { root, paths } = sandbox({}, 'home');
    write(paths.control, control());
    const target = path.join(root, dangling ? 'missing-target.json' : 'target.json');
    if (!dangling) write(target, { untouched: true });
    // Use a new leaf so no fixture file needs to be removed or replaced.
    paths[key] = path.join(path.dirname(paths[key]), `linked-${path.basename(paths[key])}`);
    fs.symlinkSync(target, paths[key], 'file');
    expect(reconcile(paths)).toMatchObject({ state: 'conflict', code: 'symlink_refused' });
    expect(fs.lstatSync(paths[key]).isSymbolicLink()).toBe(true);
    if (dangling) expect(fs.existsSync(target)).toBe(false);
    else expect(readJson(target)).toEqual({ untouched: true });
    if (key !== 'config') expect(readJson(paths.config)).toEqual({});
  }
});

test.each(['control', 'mcp', 'state', 'pending', 'lock', 'pause', 'status', 'reclaim'])('rejects a config alias of the reserved %s file without changing it', key => {
  const { root, paths } = sandbox({}, '.config');
  const reserved = key === 'reclaim' ? `${paths.lock}.reclaim` : paths[key];
  write(reserved, { untouched: true });
  const before = fs.readFileSync(reserved, 'utf8');
  paths.config = path.join(root, 'real-parent', 'magpie-nanobot', path.basename(reserved));
  expect(reconcile(paths)).toMatchObject({ state: 'conflict', code: 'reserved_config_path' });
  expect(fs.readFileSync(reserved, 'utf8')).toBe(before);
});

test('creates a missing state directory beneath a symlinked config directory', () => {
  const { root } = sandbox({}, '.config');
  const paths = pathsFor({ home: root, stateDir: path.join(root, '.config', 'new-adapter', 'state') });
  expect(reconcile(paths).state).toBe('disconnected');
  expect(fs.statSync(paths.directory).isDirectory()).toBe(true);
  expect(inspect(paths).state).toBe('disconnected');
  expect(applyModel(paths).state).toBe('file-applied');
  expect(reconcile(paths, { restore: true }).state).toBe('disconnected');
  expect(readJson(paths.config)).toEqual({});
});

test('replays an interrupted transaction through a symlinked home', () => {
  const { paths, baseline } = sandbox({}, 'home');
  write(paths.control, control());
  paths.__fault = point => { if (point === 'before-config') crash(point); };
  expect(() => reconcile(paths)).toThrow('injected at before-config');
  expect(inspect(paths).state).toBe('recovery-pending');
  expect(readJson(paths.config)).toEqual(baseline);
  delete paths.__fault;
  expect(reconcile(paths).state).toBe('file-applied');
  expect(fs.existsSync(paths.pending)).toBe(false);
  expect(reconcile(paths, { restore: true }).state).toBe('disconnected');
  expect(readJson(paths.config)).toEqual(baseline);
});

// The invariant PiG 0.1.1 added a test for: the provider ID a descriptor writes
// must be the same one everything else derives from. Here one constant feeds
// the provider path, the preset's provider field, the selector value and every
// reference check; a drift between them would write a provider that restore
// cannot find again.
test('one provider name drives the path, the preset, the selector and the records', () => {
  const { paths } = sandbox();
  const result = applyModel(paths);
  expect(result.state).toBe('file-applied');
  const config = readJson(paths.config);
  expect(Object.keys(config.providers)).toEqual([PROVIDER]);
  expect(Object.keys(config.modelPresets)).toEqual([PROVIDER]);
  expect(config.modelPresets[PROVIDER].provider).toBe(PROVIDER);
  expect(config.agents.defaults.modelPreset).toBe(PROVIDER);
  expect(readJson(paths.state).records.map(r => r.id).sort()).toEqual(['preset', 'provider', 'selector']);
  expect(readJson(paths.state).configPath).toBe(path.resolve(paths.config));
});

test('the row model reaches the preset nanobot starts a session from', () => {
  const { paths } = sandbox();
  applyModel(paths, { modelInfo: { context: 1_048_576, output: 393_216 } });
  const preset = readJson(paths.config).modelPresets[PROVIDER];
  expect(preset.model).toBe('deepseek/deepseek-flash');
  expect(preset.provider).toBe(PROVIDER);
  expect(preset.contextWindowTokens).toBe(1_048_576);
  expect(preset.maxTokens).toBe(393_216);
});

test('a raw model id that already starts with the provider name is escaped once', () => {
  const { paths } = sandbox();
  applyModel(paths, { model: `${PROVIDER}/deepseek/deepseek-flash` });
  // nanobot strips a leading provider prefix of its own; doubling keeps the
  // gateway ID intact instead of collapsing it to deepseek/deepseek-flash.
  expect(readJson(paths.config).modelPresets[PROVIDER].model).toBe(`${PROVIDER}/${PROVIDER}/deepseek/deepseek-flash`);
});

test('reported limits are clamped, and an unstated limit is left out entirely', () => {
  const clamped = sandbox();
  applyModel(clamped.paths, { modelInfo: { context: 1000, output: 5000 } });
  const preset = readJson(clamped.paths.config).modelPresets[PROVIDER];
  expect(preset.maxTokens).toBe(1000);
  expect(preset.contextWindowTokens).toBe(1000);

  // Omission, not zero: an older Magpie that sends no modelInfo leaves nanobot
  // its own schema defaults (200000 context, 8192 output) rather than a
  // preset that claims zero room.
  const bare = sandbox();
  applyModel(bare.paths);
  const plain = readJson(bare.paths.config).modelPresets[PROVIDER];
  expect(plain.contextWindowTokens).toBeUndefined();
  expect(plain.maxTokens).toBeUndefined();
});

test('a hand-written entry with the managed name is refused, not taken over', () => {
  const { paths } = sandbox({ providers: { [PROVIDER]: { apiBase: 'https://mine.example/v1', apiKey: 'mine' } } });
  const before = fs.readFileSync(paths.config, 'utf8');
  const result = applyModel(paths);
  expect(result.state).toBe('conflict');
  expect(result.code).toBe('unowned_name_collision');
  expect(fs.readFileSync(paths.config, 'utf8')).toBe(before);
});

test('disconnecting the model returns the native config to the shape it started in', () => {
  const { paths, baseline } = sandbox();
  applyModel(paths, { modelInfo: { context: 4096, output: 1024 } });
  expect(readJson(paths.config)).not.toEqual(baseline);
  fs.rmSync(paths.control);
  const result = reconcile(paths);
  expect(result.state).toBe('disconnected');
  expect(readJson(paths.config)).toEqual(baseline);
  expect(fs.existsSync(paths.state)).toBe(false);
});

test('an explicit restore pauses the same intent instead of reapplying it', () => {
  const { paths, baseline } = sandbox();
  applyModel(paths);
  const restored = reconcile(paths, { restore: true, pause: true });
  expect(restored.state).toBe('disconnected');
  expect(readJson(paths.config)).toEqual(baseline);
  // Unchanged inputs stay paused: a live host must not reconnect what restore
  // just took out.
  expect(reconcile(paths).state).toBe('paused');
  expect(readJson(paths.config)).toEqual(baseline);
  // A new choice permits coordination again.
  expect(applyModel(paths, { model: 'codex/gpt-6.1-sol' }).state).toBe('file-applied');
  expect(readJson(paths.config).modelPresets[PROVIDER].model).toBe('codex/gpt-6.1-sol');
});

test('a managed loopback MCP server adds only its exact address and takes it back', () => {
  const { paths } = sandbox();
  write(paths.mcp, { mcpServers: { probe: { type: 'http', url: 'http://127.0.0.1:7345/mcp' } } });
  const applied = reconcile(paths);
  expect(applied.servers).toEqual(['probe']);
  // nanobot blocks loopback HTTP MCP unless the exact IP is exempt.
  expect(readJson(paths.config).tools.ssrfWhitelist).toEqual(['127.0.0.1/32']);
  expect(readJson(paths.state).addedWhitelist).toEqual(['127.0.0.1/32']);
  expect(applied.networkNotice).toContain('globally');

  write(paths.mcp, { mcpServers: {} });
  const removed = reconcile(paths);
  expect(removed.servers).toEqual([]);
  // The exemption existed only for that server, and the whole map it lived in
  // was created by this bridge, so both go away with it.
  expect(readJson(paths.config).tools).toBeUndefined();
  expect(fs.existsSync(paths.state)).toBe(false);
});

test('status never carries the gateway key or the URL', () => {
  const { paths } = sandbox();
  applyModel(paths);
  const seen = JSON.stringify([inspect(paths), readJson(paths.status)]);
  expect(seen).toContain('deepseek/deepseek-flash');
  expect(seen).not.toContain('test-key');
  expect(seen).not.toContain('gateway.example');
});

test('the descriptor declares the fields this adapter relies on, and no startup block', () => {  expect(agent).toMatchObject({
    id: 'nanobot', bin: 'nanobot', dir: '~/.nanobot',
    config: '~/.config/magpie-nanobot/connection.json', format: 'json', model: 'model',
  });
  expect(agent.library).toEqual({ mcp: '~/.config/magpie-nanobot/mcp.json', mcpFormat: 'claude', skills: '~/.nanobot/workspace/skills' });
  // Deliberately absent: PiG 0.1.1 uses `startup` to have Magpie write its
  // native settings.json. nanobot's startup state is a nested preset object
  // that this bridge owns as one writer; a second writer would race it.
  expect(agent.startup).toBeUndefined();
});

test('the descriptor clamps its output limit to the context it reports', () => {
  const out = connectAgent({ gateway: { v1: 'https://gw.example/v1', key: 'k' }, model: { id: 'deepseek/deepseek-flash', context: 1000, output: 5000, images: true } });
  expect(out).toEqual({ baseURL: 'https://gw.example/v1', gatewayKey: 'k', modelInfo: { context: 1000, output: 1000, images: true } });
  expect(() => connectAgent({ gateway: {}, model: { id: 'x' } })).toThrow();
});

test('declares the standard community Agent entry and ships every module it loads', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  expect(pkg.name).toBe('@magpie-community/agent-nanobot');
  expect(pkg.type).toBe('module');
  expect(pkg.magpie.agent).toBe('./nanobot.agent.js');
  expect(pkg.magpie.icon).toBe(agent.icon);
  expect(pkg.dependencies).toBeUndefined();
  expect(pkg.scripts?.preinstall).toBeUndefined();
  expect(pkg.scripts?.postinstall).toBeUndefined();
  // A runtime module is allowed for an agent (kimi-desktop and reasonix-desktop
  // ship one). npm packs by files[], so every file listed must exist and every
  // module the main loads must be listed, or the published package is broken.
  expect(pkg.main).toBe('./index.mjs');
  const shipped = new Set(pkg.files);
  expect([...shipped].every(file => fs.existsSync(path.join(dir, file)))).toBe(true);
  expect(shipped.has('nanobot.agent.js')).toBe(true);
  // The helper is a one-shot fallback, as reasonix-desktop's is: the bin it
  // declares must therefore be in the published package too.
  expect(pkg.bin).toEqual({ 'magpie-nanobot': './cli.mjs' });
  expect(shipped.has('cli.mjs')).toBe(true);
  const loaded = new Set();
  for (const file of ['index.mjs', 'runtime.mjs', 'bridge.mjs', 'cli.mjs']) {
    if (!shipped.has(file)) continue;
    for (const match of fs.readFileSync(path.join(dir, file), 'utf8').matchAll(/from\s+["'](\.\/[^"']+)["']/g)) loaded.add(match[1].slice(2));
  }
  expect([...loaded].sort()).toEqual(['bridge.mjs', 'runtime.mjs']);
  expect([...loaded].every(file => shipped.has(file))).toBe(true);
  // Tests are development artifacts and are not published.
  expect(shipped.has('nanobot.test.mjs')).toBe(false);
});

// ---------------------------------------------------------------------------
// Recovery: a journal that outlives a crash, and a lock that outlives a host.
// The writer is expected to lose power; the contract is that the next pass can
// tell what was written without reading the half-done state and guessing.
// ---------------------------------------------------------------------------

const crash = point => { throw Object.assign(new Error(`injected at ${point}`), { __bridgeFault: true }); };

function deadPid() {
  // A pid the OS itself reports as gone. Probed rather than hard-coded, so the
  // test does not depend on a magic number being dead on this machine.
  for (let pid = 2_000_000_000; pid > 1_999_999_000; pid--) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return pid; }
  }
  throw new Error('no dead pid available on this machine');
}

test('a transaction interrupted before the target write is replayed from its journal', () => {
  const { paths, baseline } = sandbox();
  write(paths.control, control());
  paths.__fault = point => { if (point === 'before-config') crash(point); };
  expect(() => reconcile(paths)).toThrow('injected at before-config');
  // The journal is the durable record; the native file was never touched.
  expect(fs.existsSync(paths.pending)).toBe(true);
  expect(readJson(paths.config)).toEqual(baseline);
  expect(inspect(paths).state).toBe('recovery-pending');
  delete paths.__fault;
  expect(reconcile(paths).state).toBe('file-applied');
  expect(fs.existsSync(paths.pending)).toBe(false);
  expect(readJson(paths.config).modelPresets[PROVIDER].model).toBe('deepseek/deepseek-flash');
});

test('a replay after the target write completes the ownership record instead of rewriting it', () => {
  const { paths } = sandbox();
  write(paths.control, control());
  paths.__fault = point => { if (point === 'after-config') crash(point); };
  expect(() => reconcile(paths)).toThrow('injected at after-config');
  // Config written, records not: without the replay nothing would own the keys.
  expect(fs.existsSync(paths.pending)).toBe(true);
  expect(fs.existsSync(paths.state)).toBe(false);
  delete paths.__fault;
  expect(reconcile(paths).state).toBe('file-applied');
  expect(fs.existsSync(paths.pending)).toBe(false);
  expect(readJson(paths.state).records.map(r => r.id).sort()).toEqual(['preset', 'provider', 'selector']);
});

test('a journal whose target changed underneath is kept, not forced over it', () => {
  const { paths } = sandbox();
  write(paths.control, control());
  paths.__fault = point => { if (point === 'before-config') crash(point); };
  expect(() => reconcile(paths)).toThrow();
  delete paths.__fault;
  // Something else claimed the same managed name while the journal waited.
  write(paths.config, { providers: { [PROVIDER]: { apiBase: 'https://someone-else.example/v1' } } });
  const result = reconcile(paths);
  expect(result.state).toBe('conflict');
  expect(result.code).toBe('pending_patch_conflict');
  expect(result.recoveryPending).toBe(true);
  expect(fs.existsSync(paths.pending)).toBe(true);
  expect(readJson(paths.config).providers[PROVIDER].apiBase).toBe('https://someone-else.example/v1');
});

test('a lock held by a live writer is refused and left in place', () => {
  const { paths } = sandbox();
  write(paths.control, control());
  write(paths.lock, { pid: process.pid, token: 'other-owner' });
  const result = reconcile(paths);
  expect(result.state).toBe('conflict');
  expect(result.code).toBe('writer_locked');
  // Someone is writing: the lock is theirs to drop, not ours to reclaim.
  expect(readJson(paths.lock).token).toBe('other-owner');
  expect(readJson(paths.config)).toEqual({});
});

test('a lock left by a dead writer is reclaimed without leaving a second lock', () => {
  const { paths } = sandbox();
  write(paths.control, control());
  write(paths.lock, { pid: deadPid(), token: 'stale' });
  expect(reconcile(paths).state).toBe('file-applied');
  expect(fs.existsSync(paths.lock)).toBe(false);
  expect(fs.existsSync(`${paths.lock}.reclaim`)).toBe(false);
});

test('a leftover reclaim guard fails closed rather than guessing', () => {
  const { paths } = sandbox();
  write(paths.control, control());
  write(paths.lock, { pid: deadPid(), token: 'stale' });
  write(`${paths.lock}.reclaim`, { pid: 1, token: 'abandoned' });
  const result = reconcile(paths);
  expect(result.state).toBe('conflict');
  expect(result.code).toBe('lock_reclaim_in_progress');
  // A reclaimer may be mid-flight: nothing is deleted while that is unknown.
  expect(readJson(paths.lock).token).toBe('stale');
  expect(fs.existsSync(`${paths.lock}.reclaim`)).toBe(true);
});

const runtimeLock = paths => path.join(paths.directory, 'runtime.lock');
function runtimeFor(paths) {
  const statuses = [];
  // No real timers: each test drives tick() itself, so nothing races.
  const handle = startRuntime(paths, { interval: 100, schedule: () => ({}), cancel: () => {}, onStatus: status => statuses.push(status) });
  return { handle, statuses };
}

test('a second host stays standby and never restores the resident configuration', () => {
  const { paths } = sandbox();
  applyModel(paths);
  const applied = readJson(paths.config);
  write(runtimeLock(paths), { pid: process.pid, nonce: 'resident-host' });
  const { handle, statuses } = runtimeFor(paths);
  handle.tick();
  expect(statuses.at(-1)).toMatchObject({ state: 'standby', recoveryPending: false });
  expect(readJson(runtimeLock(paths)).nonce).toBe('resident-host');
  // A standby host owns nothing, so stopping it must not put anything back.
  expect(handle.stop()).toBeUndefined();
  expect(readJson(paths.config)).toEqual(applied);
});

test('the owner applies only once the input holds still, then honors an explicit restore on stop', () => {
  const { paths, baseline } = sandbox();
  write(paths.control, control());
  const { handle, statuses } = runtimeFor(paths);
  handle.tick();
  // One full stable period is required: the first tick only records the input.
  expect(statuses).toHaveLength(0);
  expect(readJson(paths.config)).toEqual(baseline);
  handle.tick();
  expect(statuses.at(-1).state).toBe('file-applied');
  expect(readJson(paths.config).modelPresets[PROVIDER].model).toBe('deepseek/deepseek-flash');
  expect(handle.stop({ restore: true }).state).toBe('disconnected');
  expect(readJson(paths.config)).toEqual(baseline);
  expect(fs.existsSync(runtimeLock(paths))).toBe(false);
});

test('normal exit preserves model and MCP configuration and a new host resumes ownership', () => {
  const { paths } = sandbox();
  write(paths.control, control());
  write(paths.mcp, { mcpServers: {
    local: { type: 'stdio', command: 'test-mcp' },
    http: { type: 'http', url: 'http://127.0.0.1:7345/mcp' },
  } });
  const { handle } = runtimeFor(paths);
  handle.tick(); handle.tick();
  const config = fs.readFileSync(paths.config, 'utf8');
  const state = fs.readFileSync(paths.state, 'utf8');
  expect(handle.stop().state).toBe('file-applied');
  expect(fs.readFileSync(paths.config, 'utf8')).toBe(config);
  expect(fs.readFileSync(paths.state, 'utf8')).toBe(state);
  expect(fs.existsSync(runtimeLock(paths))).toBe(false);
  expect(fs.existsSync(paths.lock)).toBe(false);
  expect(handle.stop()).toBeUndefined();
  const next = runtimeFor(paths);
  try {
    next.handle.tick(); next.handle.tick();
    expect(next.statuses.at(-1).state).toBe('file-applied');
    expect(fs.readFileSync(paths.config, 'utf8')).toBe(config);
    expect(fs.readFileSync(paths.state, 'utf8')).toBe(state);
  } finally { next.handle.stop(); }
});

test.each(['model', 'mcp', 'both'])('exit flushes a pending %s disconnect independently', disconnected => {
  const { paths, baseline } = sandbox();
  write(paths.control, control());
  write(paths.mcp, { mcpServers: { local: { type: 'stdio', command: 'test-mcp' } } });
  const { handle } = runtimeFor(paths);
  handle.tick(); handle.tick();
  // No tick after the user's change: shutdown must flush it itself.
  if (disconnected !== 'mcp') write(paths.control, {});
  if (disconnected !== 'model') write(paths.mcp, { mcpServers: {} });
  expect(handle.stop().state).toBe(disconnected === 'both' ? 'disconnected' : 'file-applied');
  const config = readJson(paths.config);
  expect(config.modelPresets?.[PROVIDER] !== undefined).toBe(disconnected === 'mcp');
  expect(config.tools?.mcpServers?.local !== undefined).toBe(disconnected === 'model');
  if (disconnected === 'both') {
    expect(config).toEqual(baseline);
    expect(fs.existsSync(paths.state)).toBe(false);
  }
  expect(fs.existsSync(runtimeLock(paths))).toBe(false);
});

test('exit keeps an explicit restore paused instead of reconnecting it', () => {
  const { paths, baseline } = sandbox();
  write(paths.control, control());
  const { handle } = runtimeFor(paths);
  handle.tick(); handle.tick();
  expect(reconcile(paths, { restore: true, pause: true }).state).toBe('disconnected');
  expect(handle.stop().state).toBe('paused');
  expect(readJson(paths.config)).toEqual(baseline);
  expect(fs.existsSync(paths.pause)).toBe(true);
  expect(fs.existsSync(runtimeLock(paths))).toBe(false);
});

test('exit with invalid control retains configuration and recovery records and releases its lock', () => {
  const { paths } = sandbox();
  write(paths.control, control());
  const { handle } = runtimeFor(paths);
  handle.tick(); handle.tick();
  const config = fs.readFileSync(paths.config, 'utf8');
  const state = fs.readFileSync(paths.state, 'utf8');
  fs.writeFileSync(paths.control, '{');
  expect(handle.stop()).toMatchObject({ state: 'conflict', code: 'invalid_json', recoveryPending: true });
  expect(fs.readFileSync(paths.config, 'utf8')).toBe(config);
  expect(fs.readFileSync(paths.state, 'utf8')).toBe(state);
  expect(fs.existsSync(runtimeLock(paths))).toBe(false);
});

test.each(['control', 'mcp', 'config'])('invalid %s still reports existing ownership as recovery pending', key => {
  const { paths } = sandbox();
  expect(applyModel(paths).state).toBe('file-applied');
  fs.writeFileSync(paths[key], '{');
  const config = fs.readFileSync(paths.config, 'utf8');
  const state = fs.readFileSync(paths.state, 'utf8');
  expect(reconcile(paths)).toMatchObject({ state: 'conflict', code: 'invalid_json', recoveryPending: true });
  expect(inspect(paths)).toMatchObject({ state: 'conflict', code: 'invalid_json', recoveryPending: true });
  expect(fs.readFileSync(paths.config, 'utf8')).toBe(config);
  expect(fs.readFileSync(paths.state, 'utf8')).toBe(state);
});

test.each(['missing', 'invalid', 'foreign', 'empty'])('%s ownership records do not invent recovery work or mask the input error', kind => {
  const { paths } = sandbox();
  if (kind === 'invalid') fs.writeFileSync(paths.state, '{');
  if (kind === 'foreign' || kind === 'empty') {
    applyModel(paths);
    const state = readJson(paths.state);
    if (kind === 'foreign') state.configPath = path.join(path.dirname(paths.config), 'other.json');
    else state.records = [];
    write(paths.state, state);
  }
  fs.writeFileSync(paths.control, '{');
  const before = fs.existsSync(paths.state) ? fs.readFileSync(paths.state, 'utf8') : null;
  expect(reconcile(paths)).toMatchObject({ state: 'conflict', code: 'invalid_json', recoveryPending: false });
  expect(fs.existsSync(paths.state) ? fs.readFileSync(paths.state, 'utf8') : null).toBe(before);
});

test.each(['connected', 'disconnect'])('the actual plugin exit hook flushes %s intent and releases locks', intent => {
  const { root, paths, baseline } = sandbox();
  write(paths.control, control());
  write(paths.mcp, { mcpServers: { local: { type: 'stdio', command: 'test-mcp' } } });
  // Only the home-directory lookup is substituted. The child loads the real
  // plugin entry and runtime, then exits naturally without calling stop().
  const source = `
    import { mock } from 'bun:test';
    import os from 'node:os';
    import fs from 'node:fs';
    import assert from 'node:assert/strict';
    const root = ${JSON.stringify(root)};
    const paths = ${JSON.stringify(paths)};
    mock.module('node:os', () => ({ ...os, homedir: () => root, default: { ...os, homedir: () => root } }));
    const isolatedOS = await import('node:os');
    assert.equal(isolatedOS.homedir(), root);
    assert.equal(isolatedOS.default.homedir(), root);
    const { default: plugin } = await import(${JSON.stringify(new URL('./index.mjs', import.meta.url).href)});
    await plugin();
    const runtime = globalThis[Symbol.for('magpie.nanobot.adapter.v1')];
    runtime.tick(); runtime.tick();
    assert.equal(JSON.parse(fs.readFileSync(paths.status, 'utf8')).state, 'file-applied');
    if (${JSON.stringify(intent)} === 'disconnect') {
      fs.writeFileSync(paths.control, '{}');
      fs.writeFileSync(paths.mcp, '{"mcpServers":{}}');
    }
  `;
  const child = spawnSync(process.execPath, ['--eval', source], { encoding: 'utf8', timeout: 10_000 });
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  expect(child.stderr).toBe('');
  expect(child.status).toBe(0);
  expect(fs.existsSync(runtimeLock(paths))).toBe(false);
  expect(fs.existsSync(paths.lock)).toBe(false);
  if (intent === 'connected') {
    expect(readJson(paths.config).modelPresets[PROVIDER].model).toBe('deepseek/deepseek-flash');
    expect(readJson(paths.config).tools.mcpServers.local.command).toBe('test-mcp');
    expect(readJson(paths.state).records).toHaveLength(4);
    expect(inspect(paths).state).toBe('file-applied');
  } else {
    expect(readJson(paths.config)).toEqual(baseline);
    expect(fs.existsSync(paths.state)).toBe(false);
    expect(inspect(paths).state).toBe('disconnected');
  }
}, 15_000);

test('an owner whose runtime lock was replaced cannot flush on exit', () => {
  const { paths } = sandbox();
  write(paths.control, control());
  const { handle } = runtimeFor(paths);
  handle.tick(); handle.tick();
  const config = fs.readFileSync(paths.config, 'utf8');
  write(paths.control, {});
  write(runtimeLock(paths), { pid: process.pid, nonce: 'replacement-owner' });
  expect(handle.stop()).toBeUndefined();
  expect(fs.readFileSync(paths.config, 'utf8')).toBe(config);
  expect(readJson(runtimeLock(paths)).nonce).toBe('replacement-owner');
});

test('a changed input waits for its own full period before it is applied', () => {
  const { paths } = sandbox();
  write(paths.control, control());
  const { handle } = runtimeFor(paths);
  handle.tick(); handle.tick();
  write(paths.control, control({ model: 'codex/gpt-6.1-sol' }));
  handle.tick();
  expect(readJson(paths.config).modelPresets[PROVIDER].model).toBe('deepseek/deepseek-flash');
  handle.tick();
  expect(readJson(paths.config).modelPresets[PROVIDER].model).toBe('codex/gpt-6.1-sol');
  handle.stop();
});

test('a runtime lock left by a dead host is reclaimed', () => {
  const { paths } = sandbox();
  write(paths.control, control());
  write(runtimeLock(paths), { pid: deadPid(), nonce: 'dead-host' });
  const { handle, statuses } = runtimeFor(paths);
  handle.tick(); handle.tick();
  expect(statuses.at(-1).state).toBe('file-applied');
  expect(readJson(runtimeLock(paths)).nonce).not.toBe('dead-host');
  handle.stop();
});
