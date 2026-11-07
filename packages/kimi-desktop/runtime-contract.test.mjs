import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KimiAdapter } from './adapter.mjs';
import { normalizeModels } from './catalog.mjs';
import { nativeRolePluginPeer } from './test-fixtures/control-peer.mjs';

const rows = normalizeModels({ data: ['synthetic/main', 'synthetic/secondary'].map(id => ({ id })) });
const [primary, secondary] = rows;
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-bridge-contract-'));
  const adapter = new KimiAdapter({ home: directory, kimiDir: path.join(directory, 'kimi'), stateDir: path.join(directory, 'state') });
  adapter.state = { active: true, model: primary.id };
  adapter.live = { model: primary.id };
  adapter.catalog = rows;
  write(adapter.connectionFile, JSON.stringify({ enabled: true, model: primary.id,
    secondaryModel: secondary.id, gateway: { key: '' } }));
  const runner = { lifecycleStatus: 'running', kernel: { agentKernel: 'kimi-code-v2' }, activeKernelTurns: 0, activeKernelToolCalls: 0 };
  const plugins = nativeRolePluginPeer(path.dirname(adapter.convertedNativeConfigFile));
  const calls = [];
  adapter.rpcCall = async (_runner, method, params) => {
    calls.push({ method, params });
    if (plugins.handles(method)) return plugins.call(method, params);
    if (method === 'kimiPlugin.reloadActiveSessions') return { sessions: [] };
    if (method === 'kimiPlugin.ReloadSession') return { status: 'reloaded' };
    throw Error('unexpected public RPC');
  };
  return { adapter, runner, plugins, calls, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test('V2 installs declared Agent profiles without depending on converted model definitions', async () => {
  const f = fixture();
  try {
    let writes = 0;
    f.adapter.commitNativeSecondary = () => { writes++; throw Error('unexpected-native-write'); };
    expect(await f.adapter.reconcileSecondary(f.runner, secondary.id, { inheritModel: primary.id })).toEqual({ applied: true });
    expect((await f.adapter.readSettings()).appliedSecondaryModel).toBe(secondary.id);
    expect(f.plugins.calls.map(call => call.method)).toEqual([
      'kimiPlugin.installPlugin', 'kimiPlugin.getPluginInfo', 'kimiPlugin.setPluginEnabled',
    ]);
    expect(f.calls.at(-1).method).toBe('kimiPlugin.reloadActiveSessions');
    expect(writes).toBe(0);
    expect(fs.existsSync(f.adapter.nativeConfigFile)).toBe(false);
    expect(fs.existsSync(f.adapter.convertedNativeConfigFile)).toBe(false);
  } finally { f.cleanup(); }
});

for (const family of ['kimi-code', 'future-kernel', undefined]) {
  test(`an explicit secondary remains unsupported on a non-V2 kernel (${family ?? 'missing metadata'})`, async () => {
    const f = fixture();
    try {
      if (family) f.runner.kernel.agentKernel = family; else delete f.runner.kernel;
      await expect(f.adapter.reconcileSecondary(f.runner, secondary.id, { inheritModel: primary.id }))
        .rejects.toThrow('secondary_model_unsupported_runtime');
      expect((await f.adapter.readSettings()).appliedSecondaryModel).toBeUndefined();
      expect(f.plugins.calls).toHaveLength(0);
      expect(f.calls).toHaveLength(0);
      expect(f.adapter.rolesReady).toBe(false);
      expect(await f.adapter.reconcileSecondary(f.runner, '', { inheritModel: primary.id })).toEqual({ applied: true });
      expect(f.adapter.bridgeSecondaryModel).toBe(primary.id);
      expect((await f.adapter.readSettings()).appliedSecondaryModel).toBeUndefined();
    } finally { f.cleanup(); }
  });
}

test('native model document rewrites do not replace the confirmed public role plugin', async () => {
  const f = fixture();
  try {
    await f.adapter.reconcileSecondary(f.runner, secondary.id, { inheritModel: primary.id });
    for (const native of ['', 'not a TOML document [', 'default_model = "native"\n[models.native]\nprovider = "unrelated"\n']) {
      write(f.adapter.convertedNativeConfigFile, native);
      expect((await f.adapter.readSettings()).appliedSecondaryModel).toBe(secondary.id);
      await f.adapter.reconcileSecondary(f.runner, secondary.id, { inheritModel: primary.id });
      expect(fs.readFileSync(f.adapter.convertedNativeConfigFile, 'utf8')).toBe(native);
    }
  } finally { f.cleanup(); }
});

test('bridge application still rejects a model outside the gateway catalog', async () => {
  const f = fixture();
  try {
    await expect(f.adapter.reconcileSecondary(f.runner, 'hidden/model', { inheritModel: primary.id }))
      .rejects.toThrow('secondary_model_unavailable');
    expect(f.adapter.bridgeSecondaryModel).toBeUndefined();
    expect(f.adapter.state.secondary).toBeUndefined();
    expect(f.adapter.state.secondaryPool).toBeUndefined();
  } finally { f.cleanup(); }
});

test('a changed bridge selection waits for idle while the current selection remains usable', async () => {
  const f = fixture();
  try {
    await f.adapter.reconcileSecondary(f.runner, secondary.id, { inheritModel: primary.id });
    f.runner.activeKernelTurns = 1;
    expect(await f.adapter.reconcileSecondary(f.runner, '', { inheritModel: primary.id })).toEqual({ waiting: true });
    expect(f.adapter.bridgeSecondaryModel).toBe(secondary.id);
    expect(await f.adapter.reconcileSecondary(f.runner, secondary.id, { inheritModel: primary.id })).toEqual({ applied: true });
    f.runner.activeKernelTurns = 0;
    await f.adapter.reconcileSecondary(f.runner, '', { inheritModel: primary.id });
    expect(f.adapter.bridgeSecondaryModel).toBe(primary.id);
    await f.adapter.reconcileSecondary(f.runner, '');
    expect(f.adapter.bridgeSecondaryModel).toBe('');
  } finally { f.cleanup(); }
});

test('the adapter persists one routing secret across reconstruction without storing a native model snapshot', async () => {
  const f = fixture();
  try {
    await f.adapter.reconcileSecondary(f.runner, secondary.id, { inheritModel: primary.id });
    const saved = JSON.parse(fs.readFileSync(f.adapter.stateFile, 'utf8'));
    expect(saved.agentRoutingSecret).toMatch(/^[a-f0-9]{64}$/);
    expect(saved.secondaryPool).toBeUndefined();
    expect(saved.secondary).toBeUndefined();
    const reconstructed = new KimiAdapter({ stateDir: f.adapter.stateDir, kimiDir: f.adapter.kimiDir });
    reconstructed.state = saved;
    reconstructed.catalog = rows;
    reconstructed.rpcCall = f.adapter.rpcCall;
    await reconstructed.reconcileSecondary(f.runner, secondary.id, { inheritModel: primary.id });
    expect(reconstructed.agentRouterSecret).toBe(saved.agentRoutingSecret);
    expect(JSON.parse(fs.readFileSync(f.adapter.stateFile, 'utf8'))).toEqual(saved);
  } finally { f.cleanup(); }
});
