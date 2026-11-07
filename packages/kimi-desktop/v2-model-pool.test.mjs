import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KimiAdapter } from './adapter.mjs';
import { normalizeModels } from './catalog.mjs';
import { inspectModelPool, patchModelPool } from './model-pool-config.mjs';

const official = 'https://agent-gw.kimi.com/coding/v1';
const primaryID = 'synthetic/main', secondaryID = 'synthetic/secondary', thirdID = 'synthetic/third';
const canary = 'synthetic-credential-not-for-state';
const payload = { data: [primaryID, secondaryID, thirdID].map(id => ({ id,
  context_window: 131072, max_output_tokens: 8192, reasoning: true,
  supported_reasoning_levels: [{ effort: 'high' }, { effort: 'max' }] })) };
const aliases = new Map(normalizeModels(payload).map(row => [row.id, row.alias]));
const baseline = { models: { native: 'Native choice' }, defaultModel: 'native',
  hasSecondaryTable: true, hasModelsTable: true };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
const batches = calls => calls.filter(call => call.method === 'kimiPlugin.reloadActiveSessions');

async function fixture({ secondaryModel = secondaryID, converted = true, nativePool = baseline,
  regenerate = true, legacyBaseline = false, batch, targeted } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-kimi-v2-'));
  const kimiDir = path.join(directory, 'kimi');
  const stateDir = path.join(directory, 'state');
  const legacyFile = path.join(kimiDir, 'runtime/kimi-code/config.toml');
  const convertedFile = path.join(kimiDir, 'runtime/kimi-code/home/config.toml');
  const calls = [], upstream = [];
  const catalog = structuredClone(payload);
  let runtimeModels = [{ model: 'native', maxContextSize: 131072, capabilities: [] }];
  let hasConverted = converted;
  let controller;
  const behavior = {
    batch: batch || (() => ({ sessions: [{ kernelSessionId: 'loaded-idle', status: 'reloaded' }] })),
    targeted: targeted || (() => ({ status: 'reloaded' })),
  };
  const nativeDoc = (v2, rows = runtimeModels) => ({
    default_model: 'native', thinking: { enabled: true, effort: 'max', keep: 'all' },
    loop_control: { max_steps_per_turn: 64, [v2 ? 'max_attempts_per_step' : 'max_retries_per_step']: 3 },
    mcp: { default_deferred: true },
    providers: { 'daimon-kimi-code': { type: 'kimi', api_key: canary,
      base_url: controller && fs.existsSync(controller.configFile)
        ? read(controller.configFile).model.providers['daimon-kimi-code'].baseUrl : official } },
    models: Object.fromEntries(rows.map(row => [row.model, { provider: 'daimon-kimi-code', model: row.model,
      max_context_size: row.maxContextSize || 131072,
      ...(row.maxOutputSize ? { max_output_size: row.maxOutputSize } : {}),
      capabilities: [...new Set([...(row.capabilities || []), 'tool_use'])],
      ...(row.supportEfforts ? { support_efforts: row.supportEfforts, default_effort: row.defaultEffort } : {}),
      ...(row.model === 'native' ? { api_key: canary } : {}) }]))
  });
  const writeText = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { mode: 0o600 });
  };
  const regenerateNative = () => {
    writeText(legacyFile, Bun.TOML.stringify(nativeDoc(false)));
    if (hasConverted) writeText(convertedFile, Bun.TOML.stringify(nativeDoc(true)));
  };
  const rpcCall = async (_runner, method, params) => {
    calls.push({ method, params });
    switch (method) {
      case 'models.current': return { current: 'native' };
      case 'conversations.getKimiModelList': return { models: runtimeModels };
      case 'conversations.setModel':
        {
          const current = read(controller.configFile);
          current.model.current = params.modelAlias;
          write(controller.configFile, current);
        }
        if (regenerate) regenerateNative();
        return { current: params.modelAlias };
      case 'conversations.updateKimiModelList':
        runtimeModels = params.models;
        {
          const current = read(controller.configFile);
          current.model.models = Object.fromEntries(runtimeModels.map(row => [row.model,
            { model: row.model, provider: 'daimon-kimi-code' }]));
          write(controller.configFile, current);
        }
        if (regenerate) regenerateNative();
        return { ok: true };
      case 'kimiPlugin.reloadActiveSessions':
        calls.at(-1).pool = hasConverted ? inspectModelPool(fs.readFileSync(convertedFile, 'utf8')) : null;
        return behavior.batch();
      case 'kimiPlugin.ReloadSession': return behavior.targeted(params);
      default: throw Error('unexpected synthetic control call');
    }
  };
  const fetchImpl = async (url, options) => {
    if (String(url).endsWith('/models')) return new Response(JSON.stringify(catalog));
    upstream.push(JSON.parse(options.body));
    return new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const makeController = () => new KimiAdapter({ home: directory, stateDir, kimiDir,
    stabilityMs: 0, intervalMs: 100000, rpcCall, fetchImpl });
  controller = makeController();
  const config = { credentials: { kimiCode: { apiKey: canary, baseUrl: official } },
    model: { current: 'native', providers: { 'daimon-kimi-code': { type: 'kimi', baseUrl: official } },
      models: { native: { model: 'native', provider: 'daimon-kimi-code' } } } };
  write(controller.configFile, config);
  const runner = { lifecycleStatus: 'running', daemonGeneration: 'synthetic-v2-generation',
    activeKernelTurns: 0, activeKernelToolCalls: 0,
    control: { endpoint: { url: 'ws://127.0.0.1:3072/control', pid: 42, startedAt: 1 } } };
  write(controller.runnerFile, runner);
  regenerateNative();
  if (legacyBaseline) {
    const legacy = nativeDoc(false);
    legacy.secondary_model = { model: 'native/old-secondary' };
    legacy.experimental = { 'secondary-model': false };
    writeText(legacyFile, Bun.TOML.stringify(legacy));
  }
  // Existing converted definitions are generated by Daimon, never copied by the adapter.
  if (hasConverted) {
    const text = Bun.TOML.stringify(nativeDoc(true, [...runtimeModels, ...normalizeModels(catalog).map(row => row.runtime)]));
    writeText(convertedFile, patchModelPool(text, nativePool));
  }
  controller.bootstrap();
  const connection = { schemaVersion: 1, enabled: true, model: primaryID, secondaryModel,
    gateway: { url: 'http://127.0.0.1:3425/v1', key: 'synthetic-gateway' } };
  write(controller.connectionFile, connection);
  return {
    get controller() { return controller; }, directory, legacyFile, convertedFile, calls, upstream,
    get runtimeModels() { return runtimeModels; },
    runner, connection, catalog, behavior, writeText,
    text: () => fs.readFileSync(convertedFile, 'utf8'),
    pool: () => inspectModelPool(fs.readFileSync(convertedFile, 'utf8')),
    patchPool: pool => writeText(convertedFile, patchModelPool(fs.readFileSync(convertedFile, 'utf8'), pool)),
    complete: () => { controller.retryAfter = 0; controller.catalogAfter = 0; controller.secondaryAfter = 0; },
    regenerateHome: () => writeText(convertedFile, Bun.TOML.stringify(nativeDoc(true))),
    upgrade: () => {
      hasConverted = true;
      writeText(convertedFile, patchModelPool(Bun.TOML.stringify(nativeDoc(true)), nativePool));
    },
    restart: async () => { await controller.stop(); controller = makeController(); controller.bootstrap(); },
    cleanup: async () => { await controller.stop(); fs.rmSync(directory, { recursive: true, force: true }); },
  };
}

async function route(f, model, expected) {
  const response = await fetch(f.controller.bridgeURL + '/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + read(f.controller.configFile).credentials.kimiCode.apiKey },
    body: JSON.stringify({ model, messages: [] }),
  });
  expect(response.status).toBe(200);
  await response.text();
  expect(f.upstream.at(-1).model).toBe(expected);
}

test('V2 writes only the native pool, defaults to secondary and routes both existing aliases', async () => {
  const f = await fixture();
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(Object.keys(f.pool().models).sort()).toEqual([aliases.get(primaryID), aliases.get(secondaryID)].sort());
    expect(f.pool().defaultModel).toBe(aliases.get(secondaryID));
    expect(f.pool().models[aliases.get(primaryID)]).toContain('Primary');
    expect(f.pool().models[aliases.get(secondaryID)]).toContain('Secondary');
    await route(f, aliases.get(primaryID), primaryID);
    await route(f, aliases.get(secondaryID), secondaryID);
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(secondaryID);
    const state = fs.readFileSync(f.controller.stateFile, 'utf8');
    expect(state).not.toContain(canary);
    expect(state).not.toContain('max_context_size');
    expect(state).not.toContain('providers');
    expect(read(f.controller.stateFile).secondaryPool.baseline).toEqual(baseline);
    const home = Bun.TOML.parse(f.text());
    expect(home.providers['daimon-kimi-code'].api_key).toBe(canary);
    expect(home.models.native.api_key).toBe(canary);
    expect(home.experimental).toBeUndefined();
    expect(Bun.TOML.parse(fs.readFileSync(f.legacyFile, 'utf8')).secondary_model).toBeUndefined();
  } finally { await f.cleanup(); }
});

test('V2 same-ID selection has one combined key; clearing an owned pool follows every primary change', async () => {
  const f = await fixture({ secondaryModel: primaryID });
  try {
    await f.controller.tick();
    expect(Object.keys(f.pool().models)).toEqual([aliases.get(primaryID)]);
    expect(f.pool().models[aliases.get(primaryID)]).toContain('Primary and secondary');
    write(f.controller.connectionFile, { ...f.connection, secondaryModel: '' });
    f.complete(); await f.controller.tick();
    expect(f.pool().defaultModel).toBe(aliases.get(primaryID));
    write(f.controller.connectionFile, { ...f.connection, secondaryModel: '', model: thirdID });
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(f.pool().models).toEqual({ [aliases.get(thirdID)]: 'Primary and secondary model / 主模型与副模型' });
    expect(f.pool().defaultModel).toBe(aliases.get(thirdID));
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(thirdID);
    await route(f, aliases.get(thirdID), thirdID);
    expect(read(f.controller.stateFile).secondaryPool.baseline).toEqual(baseline);
  } finally { await f.cleanup(); }
});

test('changing only V2 secondary selection keeps the primary bridge and clearing it pins primary', async () => {
  const f = await fixture();
  try {
    await f.controller.tick();
    const setModels = f.calls.filter(call => call.method === 'conversations.setModel').length;
    write(f.controller.connectionFile, { ...f.connection, secondaryModel: thirdID });
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(f.pool().defaultModel).toBe(aliases.get(thirdID));
    expect(f.calls.filter(call => call.method === 'conversations.setModel')).toHaveLength(setModels);
    await route(f, 'native', primaryID);
    await route(f, aliases.get(thirdID), thirdID);
    write(f.controller.connectionFile, { ...f.connection, secondaryModel: '' });
    f.complete(); await f.controller.tick();
    expect(Object.keys(f.pool().models)).toEqual([aliases.get(primaryID)]);
    expect(f.pool().defaultModel).toBe(aliases.get(primaryID));
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(primaryID);
  } finally { await f.cleanup(); }
});

test('V2 with no secondary preference or ownership leaves an existing native pool untouched', async () => {
  const f = await fixture({ secondaryModel: '', regenerate: false });
  try {
    const before = f.text();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(f.text()).toBe(before);
    expect(batches(f.calls)).toHaveLength(0);
    expect(read(f.controller.stateFile).secondaryPool).toBeUndefined();
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBeUndefined();
  } finally { await f.cleanup(); }
});

test('V2 repairs a home-only regeneration and waits to mutate or reload until idle', async () => {
  const f = await fixture();
  try {
    await f.controller.tick();
    const legacy = fs.readFileSync(f.legacyFile, 'utf8');
    const reloads = batches(f.calls).length;
    f.regenerateHome();
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBeUndefined();
    write(f.controller.runnerFile, { ...f.runner, activeKernelTurns: 1 });
    const bare = f.text();
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('waiting_kimi_idle');
    expect(f.text()).toBe(bare);
    expect(batches(f.calls)).toHaveLength(reloads);
    write(f.controller.runnerFile, f.runner);
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(f.pool().defaultModel).toBe(aliases.get(secondaryID));
    expect(batches(f.calls)).toHaveLength(reloads + 1);
    expect(fs.readFileSync(f.legacyFile, 'utf8')).toBe(legacy);
  } finally { await f.cleanup(); }
});

test('V2 empty batches stay pending until a cached idle session actually acknowledges reload', async () => {
  const f = await fixture({ batch: () => ({ sessions: [] }) });
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_model_waiting_session');
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBeUndefined();
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_model_waiting_session');
    f.behavior.batch = () => ({ sessions: [{ status: 'reloaded' }] });
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_model_waiting_session');
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBeUndefined();
    f.behavior.batch = () => ({ sessions: [{ kernelSessionId: 'later-session', status: 'reloaded' }] });
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(secondaryID);
  } finally { await f.cleanup(); }
});

test('V2 retries only skipped sessions and never confirms a failed targeted acknowledgement', async () => {
  const f = await fixture({ batch: () => ({ sessions: [
    { kernelSessionId: 'done', status: 'reloaded' }, { kernelSessionId: 'busy', status: 'skipped-active-turn' },
  ] }), targeted: () => ({ status: 'failed' }) });
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('waiting_kimi_idle');
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_model_reload_failed');
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBeUndefined();
    f.behavior.targeted = () => ({ status: 'reloaded' });
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(batches(f.calls)).toHaveLength(1);
    expect(f.calls.filter(call => call.method === 'kimiPlugin.ReloadSession').map(call => call.params.kernelSessionId))
      .toEqual(['busy', 'busy']);
  } finally { await f.cleanup(); }
});

test('a V2 generation change discards failed old session IDs and confirms the new runtime batch', async () => {
  const f = await fixture({ regenerate: false,
    batch: () => ({ sessions: [{ kernelSessionId: 'old-generation-id', status: 'failed' }] }),
    targeted: () => ({ status: 'failed' }) });
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_model_reload_failed');
    expect(f.controller.secondaryPending).toEqual(new Set(['old-generation-id']));
    const before = f.calls.length;
    const home = f.text();
    write(f.controller.runnerFile, { ...f.runner, daemonGeneration: 'synthetic-v2-next-generation' });
    f.behavior.batch = () => ({ sessions: [{ kernelSessionId: 'new-generation-id', status: 'reloaded' }] });
    // Advance connection/catalog scheduling only: the old reload deadline is
    // still in the future and belongs to the old daemon generation.
    f.controller.retryAfter = 0;
    f.controller.catalogAfter = 0;
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(f.calls.slice(before).filter(call => call.method === 'kimiPlugin.ReloadSession')).toHaveLength(0);
    expect(batches(f.calls.slice(before))).toHaveLength(1);
    expect(f.controller.secondaryPending.size).toBe(0);
    expect(f.text()).toBe(home);
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(secondaryID);
  } finally { await f.cleanup(); }
});

for (const change of ['wire-name', 'missing-definition']) {
  test(`V2 settings immediately hide confirmation after a ${change} change`, async () => {
    const f = await fixture({ regenerate: false });
    try {
      await f.controller.tick();
      expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(secondaryID);
      const home = Bun.TOML.parse(f.text());
      if (change === 'wire-name') home.models[aliases.get(secondaryID)].name = 'different-wire-name';
      else delete home.models[aliases.get(secondaryID)];
      f.writeText(f.convertedFile, Bun.TOML.stringify(home));
      const before = f.text();
      const calls = f.calls.length;
      const settings = await f.controller.readSettings();
      expect(settings.appliedSecondaryModel).toBeUndefined();
      expect(settings.appliedPrimaryModel).toBe(primaryID);
      expect(f.text()).toBe(before);
      expect(f.calls).toHaveLength(calls);
    } finally { await f.cleanup(); }
  });
}

test('V2 preserves an external pool through regeneration and disconnect without claiming application', async () => {
  const f = await fixture();
  try {
    await f.controller.tick();
    const external = { ...baseline, models: { [aliases.get(thirdID)]: 'Externally chosen' }, defaultModel: aliases.get(thirdID) };
    f.patchPool(external);
    f.catalog.data.push({ id: 'synthetic/fourth' });
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('kimi_config_changed');
    expect(f.pool()).toEqual(external);
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBeUndefined();
    write(f.controller.connectionFile, { ...f.connection, enabled: false });
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('disconnected');
    expect(f.pool()).toEqual(external);
    expect(read(f.controller.stateFile).secondaryPool).toBeUndefined();
  } finally { await f.cleanup(); }
});

test('V2 preserves the pool/default binding together when an external writer changes only the default', async () => {
  const f = await fixture({ regenerate: false });
  try {
    await f.controller.tick();
    const external = { ...f.pool(), defaultModel: aliases.get(primaryID) };
    f.patchPool(external);
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('kimi_config_changed');
    await f.controller.stop();
    expect(f.pool()).toEqual(external);
  } finally { await f.cleanup(); }
});

for (const action of ['disconnect', 'stop']) {
  test(`V2 ${action} restores the original native pool despite an old failed pending reload`, async () => {
    const f = await fixture({ batch: () => ({ sessions: [{ kernelSessionId: 'old', status: 'failed' }] }),
      targeted: () => ({ status: 'failed' }) });
    try {
      await f.controller.tick();
      expect(f.controller.status.code).toBe('secondary_model_reload_failed');
      const calls = f.calls.length;
      if (action === 'disconnect') {
        f.behavior.batch = () => ({ sessions: [{ kernelSessionId: 'idle', status: 'reloaded' }] });
        write(f.controller.connectionFile, { ...f.connection, enabled: false });
        f.complete(); await f.controller.tick();
        expect(batches(f.calls).at(-1).pool).toEqual(baseline);
        expect(f.calls.slice(calls).filter(call => call.method === 'kimiPlugin.ReloadSession')).toHaveLength(0);
        expect(read(f.controller.stateFile).secondaryPool).toBeUndefined();
      } else {
        await f.controller.stop();
        expect(batches(f.calls.slice(calls))).toHaveLength(0);
        expect(f.calls.slice(calls).filter(call => call.method === 'kimiPlugin.ReloadSession')).toHaveLength(0);
        expect(read(f.controller.stateFile).secondaryPool.restored).toBe(true);
      }
      expect(f.controller.status.code).toBe('disconnected');
      expect(f.pool()).toEqual(baseline);
    } finally { await f.cleanup(); }
  });
}

test('V2 stop restores native current and menu without secondary session RPCs', async () => {
  const f = await fixture();
  try {
    await f.controller.tick();
    const current = read(f.controller.configFile);
    current.model.current = aliases.get(primaryID);
    write(f.controller.configFile, current);
    expect(f.runtimeModels.some(row => row.model === aliases.get(primaryID))).toBe(true);
    expect(fs.existsSync(f.controller.modelBackupFile)).toBe(true);
    const calls = f.calls.length;
    await f.controller.stop();
    expect(read(f.controller.configFile).model.current).toBe('native');
    expect(f.runtimeModels.map(row => row.model)).toEqual(['native']);
    expect(Object.keys(read(f.controller.configFile).model.models)).toEqual(['native']);
    expect(f.calls.slice(calls).map(call => call.method)).toEqual([
      'conversations.getKimiModelList', 'conversations.setModel',
      'conversations.updateKimiModelList', 'conversations.setModel',
    ]);
    expect(fs.existsSync(f.controller.modelBackupFile)).toBe(false);
    expect(f.pool()).toEqual(baseline);
    expect(read(f.controller.stateFile).secondaryPool.restored).toBe(true);
    expect(read(f.controller.stateFile).active).toBe(false);
    expect(f.controller.status.code).toBe('disconnected');
  } finally { await f.cleanup(); }
});

test('V2 restores and reapplies the same baseline across adapter restart and primary state reconstruction', async () => {
  const f = await fixture();
  try {
    await f.controller.tick();
    await f.restart();
    expect(f.pool()).toEqual(baseline);
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(read(f.controller.stateFile).secondaryPool.baseline).toEqual(baseline);
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(secondaryID);
    write(f.controller.connectionFile, { ...f.connection, model: thirdID });
    f.complete(); await f.controller.tick();
    expect(read(f.controller.stateFile).secondaryPool.baseline).toEqual(baseline);
    expect(f.pool().models[aliases.get(thirdID)]).toContain('Primary');
  } finally { await f.cleanup(); }
});

test('legacy ownership survives upgrade but only a new V2 acknowledgement confirms the pool', async () => {
  const f = await fixture({ converted: false, legacyBaseline: true });
  try {
    await f.controller.tick();
    const legacyOwner = read(f.controller.stateFile).secondary;
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(secondaryID);
    f.upgrade();
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBeUndefined();
    f.behavior.batch = () => ({ sessions: [] });
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_model_waiting_session');
    expect(read(f.controller.stateFile).secondary).toEqual(legacyOwner);
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBeUndefined();
    f.behavior.batch = () => ({ sessions: [{ kernelSessionId: 'v2-idle', status: 'reloaded' }] });
    f.complete(); await f.controller.tick();
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(secondaryID);
    write(f.controller.connectionFile, { ...f.connection, enabled: false });
    f.complete(); await f.controller.tick();
    expect(f.pool()).toEqual(baseline);
    const legacy = Bun.TOML.parse(fs.readFileSync(f.legacyFile, 'utf8'));
    expect(legacy.secondary_model.model).toBe('native/old-secondary');
    expect(legacy.experimental['secondary-model']).toBe(false);
    expect(read(f.controller.stateFile).secondary).toBeUndefined();
    expect(read(f.controller.stateFile).secondaryPool).toBeUndefined();
  } finally { await f.cleanup(); }
});

test('a missing or mismatched converted model definition refuses only V2 application', async () => {
  const f = await fixture({ regenerate: false });
  try {
    const home = Bun.TOML.parse(f.text());
    home.models[aliases.get(secondaryID)].name = 'different-wire-name';
    f.writeText(f.convertedFile, Bun.TOML.stringify(home));
    const before = f.text();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_model_unsupported_runtime');
    expect(f.text()).toBe(before);
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBeUndefined();
    await route(f, 'native', primaryID);
  } finally { await f.cleanup(); }
});

test('V2 commit compares the original home bytes before replacing them', async () => {
  const f = await fixture({ regenerate: false });
  try {
    const commit = f.controller.commitNativeSecondary.bind(f.controller);
    const external = { ...baseline, defaultModel: aliases.get(thirdID), models: { [aliases.get(thirdID)]: 'Raced writer' } };
    f.controller.commitNativeSecondary = (bytes, text, file) => {
      if (file === f.convertedFile) f.patchPool(external);
      return commit(bytes, text, file);
    };
    await f.controller.tick();
    expect(f.controller.status.code).toBe('kimi_config_changed');
    expect(f.pool()).toEqual(external);
    expect(batches(f.calls)).toHaveLength(0);
    f.controller.commitNativeSecondary = commit;
  } finally { await f.cleanup(); }
});

for (const effort of ['off', 'none']) {
  test(`V2 refuses an incompatible native default_effort=${effort} without owning that field`, async () => {
    const f = await fixture({ regenerate: false });
    try {
      const home = Bun.TOML.parse(f.text());
      home.secondary_model.default_effort = effort;
      f.writeText(f.convertedFile, Bun.TOML.stringify(home));
      const before = f.text();
      await f.controller.tick();
      expect(f.controller.status.code).toBe('secondary_config_unsupported');
      expect(f.text()).toBe(before);
      expect(batches(f.calls)).toHaveLength(0);
      expect((await f.controller.readSettings()).appliedSecondaryModel).toBeUndefined();
      expect(read(f.controller.stateFile).secondaryPool.baseline).not.toHaveProperty('default_effort');
      await route(f, 'native', primaryID);
    } finally { await f.cleanup(); }
  });
}

test('V2 preserves a supported native default_effort through apply and restore', async () => {
  const f = await fixture({ regenerate: false });
  try {
    const home = Bun.TOML.parse(f.text());
    home.secondary_model.default_effort = ' MAX ';
    f.writeText(f.convertedFile, Bun.TOML.stringify(home));
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(Bun.TOML.parse(f.text()).secondary_model.default_effort).toBe(' MAX ');
    await f.controller.stop();
    expect(f.pool()).toEqual(baseline);
    expect(Bun.TOML.parse(f.text()).secondary_model.default_effort).toBe(' MAX ');
  } finally { await f.cleanup(); }
});
