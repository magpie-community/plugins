import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KimiAdapter } from './adapter.mjs';
import { isMenuAlias, normalizeModels } from './catalog.mjs';
import { inspectModelPool, patchModelPool } from './model-pool-config.mjs';
import { nativeRolePluginPeer } from './test-fixtures/control-peer.mjs';

const official = 'https://agent-gw.kimi.com/coding/v1';
const primaryID = 'synthetic/main', secondaryID = 'synthetic/secondary', thirdID = 'synthetic/third';
const canary = 'synthetic-credential-not-for-state';
const payload = { data: [primaryID, secondaryID, thirdID].map(id => ({ id,
  context_window: 131072, reasoning: true, supported_reasoning_levels: [{ effort: 'max' }] })) };
const aliases = new Map(normalizeModels(payload).map(row => [row.id, row.alias]));
const oldAlias = id => aliases.get(id).replace('local-model-', 'magpie-local-');
const baseline = { models: { native: 'Native choice' }, defaultModel: 'native',
  hasSecondaryTable: true, hasModelsTable: true };
const emptyPool = { models: null, defaultModel: null, hasSecondaryTable: false, hasModelsTable: false };
const oldPool = { models: { [oldAlias(primaryID)]: 'Primary model', [oldAlias(secondaryID)]: 'Secondary model' },
  defaultModel: oldAlias(secondaryID), hasSecondaryTable: true, hasModelsTable: true };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
const batches = calls => calls.filter(call => call.method === 'kimiPlugin.reloadActiveSessions' && call.runtime === 'v2-restore');
const targeted = calls => calls.filter(call => call.method === 'kimiPlugin.ReloadSession' && call.runtime === 'v2-restore');
const roleReloads = calls => calls.filter(call => call.method === 'kimiPlugin.reloadActiveSessions' && call.runtime === 'role-profiles');
const mutatingCalls = calls => calls.filter(call => call.method !== 'kimiPlugin.getPluginInfo');

async function fixture({ secondaryModel = secondaryID, nativePool = emptyPool, regenerate = true,
  legacyBaseline = false, batch, targetedReload } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-bridge-migration-'));
  const kimiDir = path.join(directory, 'kimi'), stateDir = path.join(directory, 'state');
  const legacyFile = path.join(kimiDir, 'runtime/kimi-code/config.toml');
  const convertedFile = path.join(kimiDir, 'runtime/kimi-code/home/config.toml');
  const calls = [], upstream = [], catalog = structuredClone(payload);
  const plugins = nativeRolePluginPeer(path.dirname(convertedFile));
  let runtimeModels = ['native', 'native-alt'].map(model => ({ model, maxContextSize: 131072, capabilities: [] }));
  let controller;
  const behavior = {
    batch: batch || (() => ({ sessions: [{ kernelSessionId: 'loaded-idle', status: 'reloaded' }] })),
    targeted: targetedReload || (() => ({ status: 'reloaded' })),
    roleBatch: () => ({ sessions: [{ kernelSessionId: 'role-idle', status: 'reloaded' }] }),
    roleTargeted: () => ({ status: 'reloaded' }),
  };
  const nativeDoc = () => ({ default_model: 'native', thinking: { enabled: true, effort: 'max', keep: 'all' },
    providers: { 'daimon-kimi-code': { type: 'kimi', api_key: canary,
      base_url: controller && fs.existsSync(controller.configFile)
        ? read(controller.configFile).model.providers['daimon-kimi-code'].baseUrl : official } },
    models: Object.fromEntries(runtimeModels.map(row => [row.model, { provider: 'daimon-kimi-code', model: row.model,
      max_context_size: row.maxContextSize, capabilities: ['tool_use'], api_key: canary }])) });
  const writeText = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { mode: 0o600 });
  };
  const regenerateNative = () => {
    // Daimon's normal projection has no secondary fields or extra definitions.
    writeText(legacyFile, Bun.TOML.stringify(nativeDoc()));
    writeText(convertedFile, Bun.TOML.stringify(nativeDoc()));
  };
  const rpcCall = async (_runner, method, params) => {
    const call = { method, params }; calls.push(call);
    if (plugins.handles(method)) return plugins.call(method, params);
    switch (method) {
      case 'models.current': return { current: read(controller.configFile).model.current };
      case 'conversations.getKimiModelList': return { models: runtimeModels };
      case 'conversations.setModel': {
        const current = read(controller.configFile); current.model.current = params.modelAlias;
        write(controller.configFile, current);
        if (regenerate) regenerateNative();
        return { current: params.modelAlias };
      }
      case 'conversations.updateKimiModelList': {
        runtimeModels = params.models;
        const current = read(controller.configFile);
        current.model.models = Object.fromEntries(runtimeModels.map(row => [row.model,
          { model: row.model, provider: 'daimon-kimi-code' }]));
        write(controller.configFile, current);
        if (regenerate) regenerateNative();
        return { ok: true };
      }
      case 'kimiPlugin.reloadActiveSessions':
        call.runtime = controller.secondaryReloadRuntime;
        call.pool = inspectModelPool(fs.readFileSync(convertedFile, 'utf8'));
        call.legacy = Bun.TOML.parse(fs.readFileSync(legacyFile, 'utf8'));
        return call.runtime === 'role-profiles' ? behavior.roleBatch() : behavior.batch();
      case 'kimiPlugin.ReloadSession':
        call.runtime = controller.secondaryReloadRuntime;
        return call.runtime === 'role-profiles' ? behavior.roleTargeted(params) : behavior.targeted(params);
      default: throw Error('unexpected synthetic control call');
    }
  };
  const fetchImpl = async (url, options) => {
    if (String(url).endsWith('/models')) return new Response(JSON.stringify(catalog));
    upstream.push(JSON.parse(options.body));
    return new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const make = () => new KimiAdapter({ home: directory, stateDir, kimiDir,
    stabilityMs: 0, intervalMs: 100000, rpcCall, fetchImpl });
  controller = make();
  write(controller.configFile, { credentials: { kimiCode: { apiKey: canary } },
    model: { current: 'native', providers: { 'daimon-kimi-code': { type: 'kimi', baseUrl: official } },
      models: Object.fromEntries(runtimeModels.map(row => [row.model, { model: row.model, provider: 'daimon-kimi-code' }])) } });
  const runner = { lifecycleStatus: 'running', daemonGeneration: 'synthetic-generation',
    kernel: { agentKernel: 'kimi-code-v2' }, activeKernelTurns: 0, activeKernelToolCalls: 0,
    control: { endpoint: { url: 'ws://127.0.0.1:3072/control', pid: 42, startedAt: 1 } } };
  write(controller.runnerFile, runner);
  regenerateNative();
  writeText(convertedFile, patchModelPool(fs.readFileSync(convertedFile, 'utf8'), nativePool));
  if (legacyBaseline) {
    const legacy = nativeDoc();
    legacy.secondary_model = { model: 'native/old-secondary' };
    legacy.experimental = { 'secondary-model': false };
    writeText(legacyFile, Bun.TOML.stringify(legacy));
  }
  controller.bootstrap();
  const connection = { schemaVersion: 1, enabled: true, model: primaryID, secondaryModel,
    gateway: { url: 'http://127.0.0.1:3425/v1', key: 'synthetic-gateway' } };
  write(controller.connectionFile, connection);
  const pool = () => inspectModelPool(fs.readFileSync(convertedFile, 'utf8'));
  const patchPool = value => writeText(convertedFile, patchModelPool(fs.readFileSync(convertedFile, 'utf8'), value));
  const saveOwned = () => { write(controller.stateFile, controller.state); };
  return {
    get controller() { return controller; }, directory, legacyFile, convertedFile, calls, upstream, plugins,
    get runtimeModels() { return runtimeModels; }, runner, connection, catalog, behavior, writeText, pool, patchPool,
    text: () => fs.readFileSync(convertedFile, 'utf8'),
    complete: () => { controller.retryAfter = 0; controller.catalogAfter = 0; controller.secondaryAfter = 0; },
    regenerateHome: () => writeText(convertedFile, Bun.TOML.stringify(nativeDoc())),
    seedOwnedPool({ written = oldPool, previousWritten, current = written, original = baseline } = {}) {
      controller.state ||= { active: false };
      controller.state.secondaryPool = { baseline: structuredClone(original), written: structuredClone(written),
        ...(previousWritten ? { previousWritten: structuredClone(previousWritten) } : {}), selection: 'old-selection' };
      controller.state.secondaryPoolModel = secondaryID;
      patchPool(current); saveOwned();
    },
    seedOwnedLegacy() {
      controller.state ||= { active: false };
      controller.state.secondary = { baseline: { model: 'native/old-secondary', enabled: false,
        hasSecondaryTable: true, hasExperimentalTable: true }, alias: oldAlias(secondaryID) };
      controller.state.secondaryModel = secondaryID;
      const legacy = Bun.TOML.parse(fs.readFileSync(legacyFile, 'utf8'));
      legacy.secondary_model = { model: oldAlias(secondaryID) };
      legacy.experimental = { 'secondary-model': true };
      writeText(legacyFile, Bun.TOML.stringify(legacy)); saveOwned();
    },
    seedMenuAlias() {
      const alias = oldAlias(secondaryID);
      runtimeModels = [...runtimeModels, { model: alias, maxContextSize: 131072, capabilities: [] }];
      const doc = read(controller.configFile); doc.model.current = alias;
      doc.model.models[alias] = { model: alias, provider: 'daimon-kimi-code' };
      write(controller.configFile, doc); write(controller.modelBackupFile, { current: 'native' });
      return alias;
    },
    restart: async () => { await controller.stop(); controller = make(); controller.bootstrap(); },
    crash: async () => {
      controller.stopping = true; controller.releaseLock();
      if (controller.server) {
        controller.server.closeAllConnections?.();
        await new Promise(resolve => controller.server.close(resolve));
      }
      controller = make(); controller.bootstrap();
    },
    cleanup: async () => { await controller.stop(); fs.rmSync(directory, { recursive: true, force: true }); },
  };
}

async function route(f, { model = 'native', tools } = {}) {
  const response = await fetch(f.controller.bridgeURL + '/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + canary },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Synthetic task' }], ...(tools ? { tools } : {}) }),
  });
  expect(response.status).toBe(200); await response.text();
  return f.upstream.at(-1);
}

const agentTool = { type: 'function', function: { name: 'Agent', description: 'Create a new task.',
  parameters: { type: 'object', properties: { prompt: { type: 'string' }, description: { type: 'string' } }, required: ['prompt', 'description'] } } };

test('the public installer copies declared Agent profiles into the active V2 home before role application', async () => {
  const f = await fixture({ regenerate: false });
  try {
    await f.controller.tick();
    const saved = read(f.controller.stateFile).agentPlugin;
    expect(saved.phase).toBe('ready');
    expect(saved.id).toMatch(/^local-work-model-roles-[a-f0-9]{12}$/);
    const source = path.join(f.controller.stateDir, 'native-model-roles');
    expect(f.plugins.calls.map(call => call.method)).toEqual([
      'kimiPlugin.installPlugin', 'kimiPlugin.getPluginInfo', 'kimiPlugin.setPluginEnabled',
    ]);
    expect(f.plugins.calls[0].params).toEqual({ source });
    expect(read(path.join(source, 'kimi.plugin.json')).agents).toEqual(['./agents']);
    expect(Object.keys(saved.files)).toHaveLength(3);
    for (const relative of Object.keys(saved.files)) {
      expect(fs.readFileSync(path.join(f.plugins.installed(saved.id), relative)))
        .toEqual(fs.readFileSync(path.join(source, relative)));
    }
    expect(roleReloads(f.calls)).toHaveLength(1);
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(secondaryID);
  } finally { await f.cleanup(); }
});

test('the same confirmed selection makes no new public install, update, enable or reload', async () => {
  const f = await fixture();
  try {
    await f.controller.tick();
    const before = mutatingCalls(f.calls).length;
    const saved = read(f.controller.stateFile).agentPlugin;
    f.complete(); await f.controller.tick();
    expect(mutatingCalls(f.calls)).toHaveLength(before);
    expect(read(f.controller.stateFile).agentPlugin).toEqual(saved);
    expect(roleReloads(f.calls)).toHaveLength(1);
  } finally { await f.cleanup(); }
});

test('a new secondary adds a source profile, updates the public plugin once and retains older profiles', async () => {
  const f = await fixture();
  try {
    await f.controller.tick();
    const first = read(f.controller.stateFile).agentPlugin;
    const oldProfile = 'agents/' + f.controller.agentRouter.profileName(secondaryID) + '.md';
    const oldText = fs.readFileSync(path.join(f.plugins.installed(first.id), oldProfile), 'utf8');
    await f.controller.saveSettings({ secondaryModel: thirdID });
    f.complete(); await f.controller.tick();
    const saved = read(f.controller.stateFile).agentPlugin;
    expect(saved.id).toBe(first.id);
    expect(saved.phase).toBe('ready');
    expect(Object.keys(saved.files)).toHaveLength(4);
    expect(f.plugins.calls.filter(call => call.method === 'kimiPlugin.installPlugin')).toHaveLength(1);
    expect(f.plugins.calls.filter(call => call.method === 'kimiPlugin.updatePlugin')).toHaveLength(1);
    expect(fs.readFileSync(path.join(f.plugins.installed(saved.id), oldProfile), 'utf8')).toBe(oldText);
    expect(roleReloads(f.calls)).toHaveLength(2);
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(thirdID);
  } finally { await f.cleanup(); }
});

test('an installed profile edit is preserved and hides role confirmation without a public overwrite', async () => {
  const f = await fixture();
  try {
    await f.controller.tick();
    const saved = read(f.controller.stateFile).agentPlugin;
    const file = path.join(f.plugins.installed(saved.id), 'agents', f.controller.agentRouter.profileName(secondaryID) + '.md');
    fs.writeFileSync(file, 'An external edit to the installed profile.');
    const calls = f.plugins.calls.length;
    f.complete(); await f.controller.tick();
    expect(fs.readFileSync(file, 'utf8')).toBe('An external edit to the installed profile.');
    expect(f.plugins.calls.slice(calls).some(call => call.method === 'kimiPlugin.updatePlugin')).toBe(false);
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBeUndefined();
    expect(f.controller.status.code).toBe('agent_profile_conflict');
  } finally { await f.cleanup(); }
});

for (const restart of [false, true]) {
  test(`a user-disabled confirmed plugin stays unavailable without being re-enabled (${restart ? 'restart' : 'same process'})`, async () => {
    const f = await fixture();
    try {
      await f.controller.tick();
      const saved = read(f.controller.stateFile).agentPlugin;
      f.plugins.setEnabled(saved.id, false);
      const enabledCalls = f.plugins.calls.filter(call => call.method === 'kimiPlugin.setPluginEnabled').length;
      if (restart) await f.crash();
      // The confirmed health read is throttled to 30s; this consumer checks
      // the explicit idle confirmation rather than the throttle window.
      f.controller.agentPluginNextCheck = 0;
      f.complete(); await f.controller.tick();
      expect(f.controller.status.code).toBe('secondary_model_unavailable');
      expect((await f.controller.readSettings()).appliedSecondaryModel).toBeUndefined();
      expect(f.plugins.calls.filter(call => call.method === 'kimiPlugin.setPluginEnabled')).toHaveLength(enabledCalls);
    } finally { await f.cleanup(); }
  });
}

test('a lost install acknowledgement is recovered from the native managed copy without installing twice', async () => {
  const f = await fixture();
  try {
    f.plugins.fail('kimiPlugin.installPlugin', { after: true });
    await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_model_reload_failed');
    expect(read(f.controller.stateFile).agentPlugin.phase).toBe('installing');
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBeUndefined();
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(read(f.controller.stateFile).agentPlugin.phase).toBe('ready');
    expect(f.plugins.calls.filter(call => call.method === 'kimiPlugin.installPlugin')).toHaveLength(1);
    expect(f.plugins.calls.filter(call => call.method === 'kimiPlugin.updatePlugin')).toHaveLength(0);
  } finally { await f.cleanup(); }
});

test('a lost update acknowledgement retries confirmation of the copied profiles without updating twice', async () => {
  const f = await fixture();
  try {
    await f.controller.tick();
    await f.controller.saveSettings({ secondaryModel: thirdID });
    f.plugins.fail('kimiPlugin.updatePlugin', { after: true });
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_model_reload_failed');
    expect(read(f.controller.stateFile).agentPlugin.phase).toBe('installing');
    expect((await f.controller.readSettings()).appliedSecondaryModel).not.toBe(thirdID);
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(f.plugins.calls.filter(call => call.method === 'kimiPlugin.updatePlugin')).toHaveLength(1);
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(thirdID);
  } finally { await f.cleanup(); }
});

test('a lost role-profile reload acknowledgement does not confirm application or repeat installation', async () => {
  const f = await fixture();
  try {
    f.behavior.roleBatch = () => { throw Error('synthetic lost role reload reply'); };
    await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_model_reload_failed');
    expect(read(f.controller.stateFile).agentPlugin.phase).toBe('reloading');
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBeUndefined();
    f.behavior.roleBatch = () => ({ sessions: [] });
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(roleReloads(f.calls)).toHaveLength(2);
    expect(f.plugins.calls.filter(call => call.method === 'kimiPlugin.installPlugin')).toHaveLength(1);
  } finally { await f.cleanup(); }
});

test('a lost enable acknowledgement retains install intent and confirms the enabled native copy on retry', async () => {
  const f = await fixture();
  try {
    f.plugins.fail('kimiPlugin.setPluginEnabled', { after: true });
    await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_model_reload_failed');
    expect(read(f.controller.stateFile).agentPlugin.phase).toBe('installing');
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBeUndefined();
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(f.plugins.calls.filter(call => call.method === 'kimiPlugin.installPlugin')).toHaveLength(1);
    expect(f.plugins.calls.filter(call => call.method === 'kimiPlugin.setPluginEnabled')).toHaveLength(1);
    expect(roleReloads(f.calls)).toHaveLength(1);
    expect(read(f.controller.stateFile).agentPlugin.phase).toBe('ready');
  } finally { await f.cleanup(); }
});

for (const missing of ['kimi.plugin.json', 'agents']) {
  test(`an incomplete managed copy is reported instead of reinstalled over (${missing})`, async () => {
    const f = await fixture();
    try {
      await f.controller.tick();
      const saved = read(f.controller.stateFile).agentPlugin;
      const entry = path.join(f.plugins.installed(saved.id), missing);
      fs.rmSync(entry, { recursive: true });
      const calls = f.plugins.calls.length;
      f.complete(); await f.controller.tick();
      expect(f.controller.status.code).toBe('agent_profile_conflict');
      expect((await f.controller.readSettings()).appliedSecondaryModel).toBeUndefined();
      expect(fs.existsSync(entry)).toBe(false);
      expect(f.plugins.calls.slice(calls).some(call => ['kimiPlugin.installPlugin', 'kimiPlugin.updatePlugin'].includes(call.method))).toBe(false);
    } finally { await f.cleanup(); }
  });
}

test('a new daemon generation discards old role-profile retry ids and confirms its own sessions', async () => {
  const f = await fixture();
  try {
    f.behavior.roleBatch = () => ({ sessions: [{ kernelSessionId: 'old-role-session', status: 'skipped-active-turn' }] });
    await f.controller.tick();
    expect(f.controller.status.code).toBe('waiting_kimi_idle');
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBeUndefined();
    write(f.controller.runnerFile, { ...f.runner, daemonGeneration: 'new-role-generation' });
    f.behavior.roleBatch = () => ({ sessions: [{ kernelSessionId: 'new-role-session', status: 'reloaded' }] });
    f.complete(); await f.controller.tick();
    expect(f.calls.filter(call => call.method === 'kimiPlugin.ReloadSession')).toHaveLength(0);
    expect(roleReloads(f.calls)).toHaveLength(2);
    expect(f.plugins.calls.filter(call => call.method === 'kimiPlugin.installPlugin')).toHaveLength(1);
    expect(f.controller.status.code).toBe('connected');
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(secondaryID);
  } finally { await f.cleanup(); }
});

test('a new bridge selection leaves native pools and definitions untouched', async () => {
  const f = await fixture({ regenerate: false });
  try {
    const before = f.text(), legacy = fs.readFileSync(f.legacyFile, 'utf8');
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(f.text()).toBe(before);
    expect(fs.readFileSync(f.legacyFile, 'utf8')).toBe(legacy);
    expect(Object.keys(read(f.controller.configFile).model.models)).toEqual(['native', 'native-alt']);
    expect(f.runtimeModels.some(row => isMenuAlias(row.model))).toBe(false);
    expect(batches(f.calls)).toHaveLength(0);
    expect(read(f.controller.stateFile).secondaryPool).toBeUndefined();
    expect(read(f.controller.stateFile).secondary).toBeUndefined();
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(secondaryID);
    expect((await route(f)).model).toBe(primaryID);
  } finally { await f.cleanup(); }
});

test('secondary changes update public role profiles and clearing retires them without native writes', async () => {
  const f = await fixture({ regenerate: false });
  try {
    await f.controller.tick();
    const before = f.text(), calls = f.calls.length;
    await f.controller.saveSettings({ secondaryModel: thirdID });
    f.complete(); await f.controller.tick();
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(thirdID);
    expect(f.text()).toBe(before);
    expect(read(f.controller.configFile).model.current).toBe('native');
    const id = read(f.controller.stateFile).agentPlugin.id;
    await f.controller.saveSettings({ secondaryModel: '' });
    f.complete(); await f.controller.tick();
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBeUndefined();
    expect(read(f.controller.stateFile).agentPlugin.phase).toBe('disabled');
    const registryFile = path.join(path.dirname(f.convertedFile), 'plugins', 'installed.json');
    expect(read(registryFile).plugins.some(entry => entry.id === id)).toBe(false);
    expect(f.text()).toBe(before);
    expect(read(f.controller.configFile).model.current).toBe('native');
    expect(f.calls.slice(calls).some(call => call.method.startsWith('conversations.'))).toBe(false);
    expect(f.plugins.calls.filter(call => call.method === 'kimiPlugin.updatePlugin')).toHaveLength(1);
    expect(batches(f.calls)).toHaveLength(0);
    expect(f.controller.bridgeSecondaryModel).toBe('');
  } finally { await f.cleanup(); }
});

test('an unowned legacy secondary and pool survive a control rewrite without ownership or reload', async () => {
  const f = await fixture({ nativePool: baseline, legacyBaseline: true });
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    // The generator's rewrite drops both foreign values, and the transient
    // memory snapshot puts the narrow fields back without owning them.
    expect(f.pool()).toEqual(baseline);
    const legacy = Bun.TOML.parse(fs.readFileSync(f.legacyFile, 'utf8'));
    expect(legacy.secondary_model.model).toBe('native/old-secondary');
    expect(legacy.experimental['secondary-model']).toBe(false);
    expect(batches(f.calls)).toHaveLength(0);
    expect(read(f.controller.stateFile).secondaryPool).toBeUndefined();
    expect(read(f.controller.stateFile).secondary).toBeUndefined();
    expect(JSON.stringify(read(f.controller.stateFile))).not.toContain(canary);
  } finally { await f.cleanup(); }
});

test('an ordinary native regeneration is not repaired with a plugin pool', async () => {
  const f = await fixture({ nativePool: baseline });
  try {
    await f.controller.tick();
    f.regenerateHome();
    const regenerated = f.text(), reloads = batches(f.calls).length;
    f.complete(); await f.controller.tick();
    expect(f.text()).toBe(regenerated);
    expect(f.pool()).toEqual(emptyPool);
    expect(batches(f.calls)).toHaveLength(reloads);
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(secondaryID);
    const sent = await route(f, { tools: [agentTool] });
    expect(sent.tools[0].function.parameters.properties.model.enum).toEqual(['primary', 'secondary', 'native']);
    expect(sent.model).toBe(primaryID);
    expect(f.text()).toBe(regenerated);
  } finally { await f.cleanup(); }
});

test('old owned pools are deferred while busy and restored before bridge confirmation', async () => {
  const f = await fixture({ regenerate: false });
  try {
    await f.controller.tick(); f.seedOwnedPool();
    write(f.controller.connectionFile, { ...f.connection, secondaryModel: thirdID });
    const calls = f.calls.length;
    write(f.controller.runnerFile, { ...f.runner, activeKernelTurns: 1 });
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('waiting_kimi_idle');
    expect(f.pool()).toEqual(oldPool);
    expect(f.calls).toHaveLength(calls);
    expect(f.controller.bridgeSecondaryModel).toBe(secondaryID);
    write(f.controller.runnerFile, f.runner);
    f.complete(); await f.controller.tick();
    expect(f.pool()).toEqual(baseline);
    expect(batches(f.calls).at(-1).pool).toEqual(baseline);
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(thirdID);
    expect(read(f.controller.stateFile).secondaryPool).toBeUndefined();
  } finally { await f.cleanup(); }
});

test('old pool restoration retries only skipped sessions and requires an explicit targeted acknowledgement', async () => {
  const f = await fixture({ regenerate: false,
    batch: () => ({ sessions: [{ kernelSessionId: 'busy-old', status: 'skipped-active-turn' }] }),
    targetedReload: () => ({ status: 'skipped-active-turn' }) });
  try {
    await f.controller.tick(); f.seedOwnedPool();
    write(f.controller.connectionFile, { ...f.connection, secondaryModel: thirdID });
    f.complete(); await f.controller.tick();
    expect(f.pool()).toEqual(baseline);
    expect(f.controller.status.code).toBe('waiting_kimi_idle');
    f.complete(); await f.controller.tick();
    expect(targeted(f.calls).at(-1).params).toEqual({ kernelSessionId: 'busy-old' });
    expect(f.controller.bridgeSecondaryModel).toBe(secondaryID);
    f.behavior.targeted = () => ({});
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_model_reload_failed');
    expect(read(f.controller.stateFile).secondaryPool).toBeDefined();
    f.behavior.targeted = () => ({ status: 'reloaded' });
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(thirdID);
    expect(read(f.controller.stateFile).secondaryPool).toBeUndefined();
    expect(batches(f.calls)).toHaveLength(1);
  } finally { await f.cleanup(); }
});

test('a lost baseline reload acknowledgement retains ownership until a later acknowledged batch', async () => {
  const f = await fixture({ regenerate: false });
  try {
    await f.controller.tick(); f.seedOwnedPool();
    f.behavior.batch = () => { throw Error('synthetic lost reply after reload'); };
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_model_reload_failed');
    expect(f.pool()).toEqual(baseline);
    expect(read(f.controller.stateFile).secondaryPool.restored).toBe(true);
    f.behavior.batch = () => ({ sessions: [{ kernelSessionId: 'loaded-idle', status: 'reloaded' }] });
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(read(f.controller.stateFile).secondaryPool).toBeUndefined();
    expect(batches(f.calls)).toHaveLength(2);
  } finally { await f.cleanup(); }
});

test('a daemon generation change discards obsolete retry ids and acknowledges restoration in the new runtime', async () => {
  const f = await fixture({ regenerate: false,
    batch: () => ({ sessions: [{ kernelSessionId: 'old-busy-session', status: 'skipped-active-turn' }] }) });
  try {
    await f.controller.tick(); f.seedOwnedPool();
    f.complete(); await f.controller.tick();
    expect(f.controller.secondaryPending.has('old-busy-session')).toBe(true);
    f.behavior.batch = () => ({ sessions: [{ kernelSessionId: 'new-idle-session', status: 'reloaded' }] });
    write(f.controller.runnerFile, { ...f.runner, daemonGeneration: 'new-generation' });
    f.complete(); await f.controller.tick();
    expect(targeted(f.calls)).toHaveLength(0);
    expect(batches(f.calls)).toHaveLength(2);
    expect(batches(f.calls).at(-1).pool).toEqual(baseline);
    expect(f.controller.secondaryPending.size).toBe(0);
    expect(read(f.controller.stateFile).secondaryPool).toBeUndefined();
    expect(f.controller.status.code).toBe('connected');
  } finally { await f.cleanup(); }
});

test('restart finishes an interrupted old-pool restoration and retains the routing secret', async () => {
  const f = await fixture({ regenerate: false });
  try {
    await f.controller.tick(); const secret = read(f.controller.stateFile).agentRoutingSecret;
    f.seedOwnedPool();
    f.behavior.batch = () => { throw Error('synthetic lost acknowledgement'); };
    f.complete(); await f.controller.tick();
    await f.crash();
    f.behavior.batch = () => ({ sessions: [{ kernelSessionId: 'new-idle', status: 'reloaded' }] });
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(f.pool()).toEqual(baseline);
    expect(read(f.controller.stateFile).secondaryPool).toBeUndefined();
    expect(read(f.controller.stateFile).agentRoutingSecret).toBe(secret);
    expect((await route(f)).model).toBe(primaryID);
  } finally { await f.cleanup(); }
});

test('a previous uncommitted old binding is still owned and restores the original baseline', async () => {
  const f = await fixture({ regenerate: false });
  try {
    await f.controller.tick();
    const later = { ...oldPool, defaultModel: oldAlias(thirdID), models: { [oldAlias(thirdID)]: 'Pending choice' } };
    f.seedOwnedPool({ written: later, previousWritten: oldPool, current: oldPool });
    f.complete(); await f.controller.tick();
    expect(f.pool()).toEqual(baseline);
    expect(read(f.controller.stateFile).secondaryPool).toBeUndefined();
  } finally { await f.cleanup(); }
});

test('foreign native edits survive an owned pool restoration and are not re-owned afterwards', async () => {
  const f = await fixture();
  try {
    await f.controller.tick(); f.seedOwnedPool();
    const foreign = { models: { 'native-alt': 'External native choice' }, defaultModel: 'native-alt',
      hasSecondaryTable: true, hasModelsTable: true };
    f.patchPool(foreign); f.controller.observeModelPool();
    expect(f.controller.modelPoolExternal).toEqual(foreign);
    expect(Object.keys(f.controller.modelPoolExternal).sort()).toEqual(['defaultModel', 'hasModelsTable', 'hasSecondaryTable', 'models']);
    expect(JSON.stringify(f.controller.modelPoolExternal)).not.toContain(canary);
    write(f.controller.connectionFile, { ...f.connection, model: thirdID });
    f.complete(); await f.controller.tick();
    expect(f.pool()).toEqual(foreign);
    expect(read(f.controller.stateFile).secondaryPool).toBeUndefined();
    expect(JSON.stringify(read(f.controller.stateFile))).not.toContain(canary);
    const restored = f.calls.length;
    write(f.controller.connectionFile, { ...f.connection, enabled: false });
    await f.controller.tick();
    // Ownership ended with the confirmed restoration, so the adapter neither
    // re-claims the snapshot nor reloads for it again; the transient memory
    // preservation still keeps the foreign pool through this control rewrite.
    expect(f.calls.slice(restored).some(call => call.method === 'kimiPlugin.reloadActiveSessions'
      && call.runtime === 'v2-restore')).toBe(false);
    expect(f.pool()).toEqual(foreign);
    expect(read(f.controller.stateFile).secondaryPool).toBeUndefined();
    expect(read(f.controller.configFile).model.current).toBe('native');
  } finally { await f.cleanup(); }
});

for (const action of ['disconnect', 'stop']) {
  test(`${action} preserves independent native entries from an old mixed external pool`, async () => {
    const f = await fixture();
    try {
      await f.controller.tick(); f.seedOwnedPool();
      f.patchPool({ models: { [oldAlias(secondaryID)]: 'Stale plugin choice', 'native-alt': 'External native choice' },
        defaultModel: oldAlias(secondaryID), hasSecondaryTable: true, hasModelsTable: true });
      if (action === 'stop') await f.controller.stop();
      else { write(f.controller.connectionFile, { ...f.connection, enabled: false }); await f.controller.tick(); }
      expect(f.pool()).toEqual({ models: { 'native-alt': 'External native choice' }, defaultModel: 'native-alt',
        hasSecondaryTable: true, hasModelsTable: true });
      expect(read(f.controller.configFile).model.providers['daimon-kimi-code'].baseUrl).toBe(official);
    } finally { await f.cleanup(); }
  });
}

test('stop restores old native current/menu and pool without starting secondary session reloads', async () => {
  const f = await fixture();
  try {
    await f.controller.tick(); f.seedMenuAlias(); f.seedOwnedPool();
    const calls = f.calls.length;
    await f.controller.stop();
    expect(read(f.controller.configFile).model.current).toBe('native');
    expect(Object.keys(read(f.controller.configFile).model.models)).toEqual(['native', 'native-alt']);
    expect(f.runtimeModels.some(row => isMenuAlias(row.model))).toBe(false);
    expect(f.pool()).toEqual(baseline);
    expect(read(f.controller.stateFile).secondaryPool.restored).toBe(true);
    expect(read(f.controller.stateFile).active).toBe(false);
    expect(f.calls.slice(calls).map(call => call.method)).toEqual([
      'conversations.getKimiModelList', 'conversations.setModel',
      'conversations.updateKimiModelList', 'conversations.setModel',
      'kimiPlugin.setPluginEnabled', 'kimiPlugin.reloadActiveSessions',
      'kimiPlugin.removePlugin',
    ]);
    expect(fs.existsSync(f.controller.modelBackupFile)).toBe(false);
  } finally { await f.cleanup(); }
});

test('synchronous exit restores old pool ownership without RPC and a disabled restart completes recovery', async () => {
  const f = await fixture();
  try {
    await f.controller.tick(); f.seedMenuAlias(); f.seedOwnedPool();
    const calls = f.calls.length;
    f.controller.restoreFileOnExit();
    expect(f.pool()).toEqual(baseline);
    expect(f.calls).toHaveLength(calls);
    expect(read(f.controller.stateFile).secondaryPool.restored).toBe(true);
    expect(read(f.controller.stateFile).active).toBe(true);
    expect(fs.existsSync(f.controller.modelBackupFile)).toBe(true);
    await f.restart();
    write(f.controller.connectionFile, { ...f.connection, enabled: false });
    await f.controller.tick();
    expect(f.controller.status.code).toBe('disconnected');
    expect(f.pool()).toEqual(baseline);
    expect(read(f.controller.stateFile).secondaryPool).toBeUndefined();
    expect(read(f.controller.configFile).model.current).toBe('native');
    expect(f.runtimeModels.some(row => isMenuAlias(row.model))).toBe(false);
  } finally { await f.cleanup(); }
});

test('legacy and V2 ownership return to their own baselines before one idle reload', async () => {
  const f = await fixture({ regenerate: false });
  try {
    await f.controller.tick(); f.seedOwnedLegacy(); f.seedOwnedPool();
    f.complete(); await f.controller.tick();
    expect(f.pool()).toEqual(baseline);
    const reloaded = batches(f.calls).at(-1);
    expect(reloaded.pool).toEqual(baseline);
    expect(reloaded.legacy.secondary_model.model).toBe('native/old-secondary');
    expect(reloaded.legacy.experimental['secondary-model']).toBe(false);
    expect(batches(f.calls)).toHaveLength(1);
    expect(read(f.controller.stateFile).secondary).toBeUndefined();
    expect(read(f.controller.stateFile).secondaryPool).toBeUndefined();
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(secondaryID);
  } finally { await f.cleanup(); }
});

for (const original of [oldPool, { models: null, defaultModel: oldAlias(secondaryID),
  hasSecondaryTable: true, hasModelsTable: false }]) {
  test(`old restoration cleans a baseline that still depends on removed plugin definitions (${original.models ? 'pool' : 'default only'})`, async () => {
    const f = await fixture({ regenerate: false });
    try {
      await f.controller.tick(); f.seedOwnedPool({ original });
      f.controller.restoreFileOnExit();
      expect(f.pool().models).toBeNull();
      expect(f.pool().defaultModel).toBeNull();
      const saved = read(f.controller.stateFile).secondaryPool;
      expect(saved.baseline.models).toBeNull();
      expect(saved.baseline.defaultModel).toBeNull();
      expect(saved.restored).toBe(true);
    } finally { await f.cleanup(); }
  });
}

test('old pool restoration retains ownership when an unowned compatibility scalar would become unresolved', async () => {
  const f = await fixture({ regenerate: false });
  try {
    await f.controller.tick(); f.seedOwnedPool({ original: emptyPool });
    const doc = Bun.TOML.parse(f.text()); doc.secondary_model.model = oldAlias(secondaryID);
    f.writeText(f.convertedFile, Bun.TOML.stringify(doc));
    const before = f.text();
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_config_unsupported');
    expect(f.text()).toBe(before);
    expect(read(f.controller.stateFile).secondaryPool).toBeDefined();
    expect(batches(f.calls)).toHaveLength(0);
    expect((await route(f)).model).toBe(primaryID);
  } finally { await f.cleanup(); }
});

test('a competing pool write during restoration is preserved and never called restored', async () => {
  const f = await fixture({ regenerate: false });
  try {
    await f.controller.tick(); f.seedOwnedPool();
    const foreign = { models: { 'native-alt': 'Raced native choice' }, defaultModel: 'native-alt',
      hasSecondaryTable: true, hasModelsTable: true };
    const commit = f.controller.commitNativeSecondary.bind(f.controller);
    f.controller.commitNativeSecondary = (bytes, text, file) => { f.patchPool(foreign); return commit(bytes, text, file); };
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('kimi_config_changed');
    expect(f.pool()).toEqual(foreign);
    expect(read(f.controller.stateFile).secondaryPool).toBeDefined();
    expect(batches(f.calls)).toHaveLength(0);
    f.controller.commitNativeSecondary = commit;
    f.complete(); await f.controller.tick();
    expect(f.pool()).toEqual(foreign);
    expect(read(f.controller.stateFile).secondaryPool).toBeUndefined();
  } finally { await f.cleanup(); }
});

const permissionTest = process.platform === 'win32' || process.getuid?.() === 0 ? test.skip : test;
permissionTest('a denied old-pool restoration retains the baseline reload obligation for retry', async () => {
  const f = await fixture({ regenerate: false });
  const directory = path.dirname(f.convertedFile);
  try {
    await f.controller.tick(); f.seedOwnedPool();
    fs.chmodSync(directory, 0o500);
    try {
      let denied;
      try { fs.writeFileSync(path.join(directory, 'permission-check'), 'must fail'); } catch (error) { denied = error; }
      expect(denied?.code).toBe('EACCES');
      f.complete(); await f.controller.tick();
      expect(f.controller.status.code).toBe('adapter_failed');
      expect(f.pool()).toEqual(oldPool);
      expect(read(f.controller.stateFile).secondaryPool).toBeDefined();
      expect(batches(f.calls)).toHaveLength(0);
    } finally { fs.chmodSync(directory, 0o700); }
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(f.pool()).toEqual(baseline);
    expect(batches(f.calls).at(-1).pool).toEqual(baseline);
    expect(read(f.controller.stateFile).secondaryPool).toBeUndefined();
  } finally { fs.chmodSync(directory, 0o700); await f.cleanup(); }
});
