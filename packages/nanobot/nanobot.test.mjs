// Behaviour is judged from the outside: Magpie's control files in, the native
// nanobot configuration out. Every test gets its own temporary home, so the
// real ~/.nanobot and ~/.config/magpie-nanobot are never read or written.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDER, inspect, pathsFor, reconcile } from './bridge.mjs';
import { startRuntime } from './runtime.mjs';
import { agent, connect as connectAgent } from './nanobot.agent.js';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function sandbox(baseline = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanobot-bridge-'));
  roots.push(root);
  const paths = pathsFor({ home: root });
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

test('the owner applies only once the input holds still, then restores on stop', () => {
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
  expect(handle.stop().state).toBe('disconnected');
  expect(readJson(paths.config)).toEqual(baseline);
  expect(fs.existsSync(runtimeLock(paths))).toBe(false);
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
