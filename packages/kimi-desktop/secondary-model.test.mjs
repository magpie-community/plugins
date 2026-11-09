// Synthetic behaviour tests for the primary/secondary model integration.
// Every file here is temporary: no real Kimi profile, no real RPC, no gateway.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { KimiAdapter } from './adapter.mjs';
import { normalizeModels } from './catalog.mjs';
import { inspectSecondary } from './secondary-config.mjs';
import { startSettingsServer, TOKEN_HEADER } from './settings.mjs';
import { nativeRolePluginPeer } from './test-fixtures/control-peer.mjs';

const official = 'https://agent-gw.kimi.com/coding/v1';
const primaryID = 'original-provider/test-model';
const secondaryID = 'other-provider/other-model';
const catalogPayload = { data: [{ id: primaryID, display_name: 'First' }, { id: secondaryID, display_name: 'Second' }] };
const alias = new Map(normalizeModels(catalogPayload).map(row => [row.id, row.alias]));

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
const reloadCalls = calls => calls.filter(call => call.method === 'kimiPlugin.reloadActiveSessions' && call.runtime === 'v2-restore');
const sessionCalls = calls => calls.filter(call => call.method === 'kimiPlugin.ReloadSession' && call.runtime === 'v2-restore');

async function settingsPost(controller, body) {
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const service = await startSettingsServer({ port,
    readSettings: () => controller.readSettings(), saveSettings: patch => controller.saveSettings(patch) });
  try {
    const base = `http://127.0.0.1:${port}`;
    const page = await (await fetch(base)).text();
    const token = /name="magpie-kimi-settings-token" content="([0-9a-f]{64})"/.exec(page)?.[1];
    const response = await fetch(base + '/api/settings', {
      method: 'POST', headers: { Origin: 'null', [TOKEN_HEADER]: token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally { await service.stop(); }
}

// The fixed key set Daimon's own generator writes. It never contains
// secondary_model or experimental, so a regeneration drops both sections.
function runtimeToml({ secondaryModel, secondaryExtra = '', flag, experimentalExtra = '' } = {}) {
  const lines = [
    'default_model = "k2d8-preview"',
    '',
    '[models]',
    '"k2d8-preview" = { model = "k2d8-preview", provider = "daimon-kimi-code" }',
    '',
    '[providers.daimon-kimi-code]',
    'type = "kimi"',
    '',
    '[thinking]',
    'enabled = true',
    '',
    '[loop_control]',
    'max_steps_per_turn = 64',
  ];
  if (secondaryModel !== undefined) {
    lines.push('', '[secondary_model]', 'model = ' + JSON.stringify(secondaryModel));
    if (secondaryExtra) lines.push(secondaryExtra);
  }
  if (flag !== undefined) {
    lines.push('', '[experimental]', '"secondary-model" = ' + String(flag));
    if (experimentalExtra) lines.push(experimentalExtra);
  }
  return lines.join('\n') + '\n';
}

async function fixture({ secondaryModel = '', native, regenerate = true, script = {}, family = 'kimi-code-v2' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-kimi-secondary-'));
  const kimiDir = path.join(directory, 'kimi');
  const nativeFile = path.join(kimiDir, 'runtime', 'kimi-code', 'config.toml');
  const calls = [], upstream = [];
  const plugins = nativeRolePluginPeer(path.join(kimiDir, 'runtime', 'kimi-code', 'home'));
  const catalog = { data: [...catalogPayload.data] };
  let runtimeModels = [{ model: 'k2d8-preview' }];
  const writeNative = text => {
    fs.mkdirSync(path.dirname(nativeFile), { recursive: true });
    fs.writeFileSync(nativeFile, text);
  };
  const behavior = { reload: () => ({ sessions: [] }), reloadSession: () => ({ status: 'reloaded' }), ...script };
  writeNative(native ?? runtimeToml());
  const controller = new KimiAdapter({
    stateDir: path.join(directory, 'state'), kimiDir, stabilityMs: 0, intervalMs: 100000,
    rpcCall: async (_runner, method, params) => {
      const call = { method, params }; calls.push(call);
      if (plugins.handles(method)) return plugins.call(method, params);
      switch (method) {
        case 'models.current': return { current: 'k2d8-preview' };
        case 'conversations.getKimiModelList': return { models: runtimeModels };
        case 'conversations.updateKimiModelList':
          runtimeModels = params.models;
          {
            const current = read(controller.configFile);
            current.model.models = Object.fromEntries(runtimeModels.map(row => [row.model,
              { model: row.model, provider: 'daimon-kimi-code' }]));
            write(controller.configFile, current);
          }
          if (regenerate) writeNative(runtimeToml());
          return { ok: true };
        case 'conversations.setModel':
          {
            const current = read(controller.configFile);
            current.model.current = params.modelAlias;
            write(controller.configFile, current);
          }
          if (regenerate) writeNative(runtimeToml());
          return { current: params.modelAlias };
        case 'kimiPlugin.reloadActiveSessions':
          call.runtime = controller.secondaryReloadRuntime;
          return call.runtime === 'role-profiles' ? { sessions: [] } : behavior.reload();
        case 'kimiPlugin.ReloadSession':
          call.runtime = controller.secondaryReloadRuntime;
          return call.runtime === 'role-profiles' ? { status: 'reloaded' } : behavior.reloadSession(params);
        default: throw Error('kimi_control_rejected');
      }
    },
    fetchImpl: async (url, options) => {
      const target = String(url);
      if (target.endsWith('/models')) {
        if (options.headers.Authorization !== 'Bearer synthetic-magpie-key') {
          return new Response('{}', { status: 403 });
        }
        return new Response(JSON.stringify(catalog), { headers: { 'Content-Type': 'application/json' } });
      }
      if (target.startsWith('https://agent-gw.kimi.com/')) {
        return new Response('{"result":"synthetic"}', { headers: { 'Content-Type': 'application/json' } });
      }
      upstream.push({ url: target, body: JSON.parse(options.body) });
      return new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  const doc = {
    credentials: { kimiCode: { apiKey: 'synthetic-kimi-key', baseUrl: official, refreshToken: 'synthetic-refresh-before' } },
    model: { current: 'k2d8-preview', providers: { 'daimon-kimi-code': { type: 'kimi', baseUrl: official } },
      models: { 'k2d8-preview': { model: 'k2d8-preview', provider: 'daimon-kimi-code' } } },
    unrelated: { preserve: ['all', 'original'] },
  };
  write(controller.configFile, doc);
  const runner = { lifecycleStatus: 'running', daemonGeneration: 'synthetic-generation-1', kernel: { agentKernel: family },
    activeKernelTurns: 0, activeKernelToolCalls: 0,
    control: { endpoint: { url: 'ws://127.0.0.1:3072/control', pid: 10, startedAt: 1 } } };
  write(controller.runnerFile, runner);
  controller.bootstrap();
  const connection = { schemaVersion: 1, enabled: true, model: primaryID,
    gateway: { url: 'http://127.0.0.1:3425/v1', key: 'synthetic-magpie-key' },
    ...(secondaryModel ? { secondaryModel } : {}) };
  write(controller.connectionFile, connection);
  const nativeText = () => fs.readFileSync(nativeFile, 'utf8');
  return {
    controller, connection, runner, calls, upstream, nativeFile, catalog, doc, behavior, plugins,
    get runtimeModels() { return runtimeModels; },
    nativeText, writeNative,
    seedOwned({ baselineText = runtimeToml({ secondaryModel: 'native/first', flag: false }), currentText } = {}) {
      controller.state ||= { active: false };
      controller.state.secondary = { baseline: inspectSecondary(baselineText), alias: alias.get(secondaryID) };
      controller.state.secondaryModel = secondaryID;
      writeNative(currentText ?? runtimeToml({ secondaryModel: alias.get(secondaryID), flag: true }));
      write(controller.stateFile, controller.state);
    },
    seedMenuAlias() {
      const old = alias.get(primaryID).replace('local-model-', 'magpie-local-');
      runtimeModels = [...runtimeModels, { model: old }];
      const current = read(controller.configFile);
      current.model.current = old;
      current.model.models[old] = { model: old, provider: 'daimon-kimi-code' };
      write(controller.configFile, current);
      write(controller.modelBackupFile, { current: 'k2d8-preview' });
      return old;
    },
    // Daimon rewriting the file from its own fixed key set, outside any adapter call.
    regenerate: (options = {}) => writeNative(runtimeToml(options)),
    complete: () => { controller.retryAfter = 0; controller.catalogAfter = 0; controller.secondaryAfter = 0; },
    cleanup: async () => {
      await controller.stop();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('a primary-only save calls the host setter, preserves secondary and applies the route only when idle', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick();
    const selected = [];
    f.controller.setPrimaryModel = async model => {
      selected.push(model);
      write(f.controller.connectionFile, { ...read(f.controller.connectionFile), model, hostOwned: 'keep' });
    };
    write(f.controller.runnerFile, { ...f.runner, activeKernelTurns: 1 });
    const saved = await f.controller.saveSettings({ primaryModel: secondaryID });
    expect(selected).toEqual([secondaryID]);
    expect(read(f.controller.connectionFile).secondaryModel).toBe(secondaryID);
    expect(read(f.controller.connectionFile).hostOwned).toBe('keep');
    expect(saved.primaryModel).toBe(secondaryID);
    expect(saved.appliedPrimaryModel).toBe(primaryID);
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('waiting_kimi_idle');
    expect(f.controller.live.model).toBe(primaryID);

    write(f.controller.runnerFile, f.runner);
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect((await f.controller.readSettings()).appliedPrimaryModel).toBe(secondaryID);
    const response = await fetch(f.controller.bridgeURL + '/chat/completions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + f.doc.credentials.kimiCode.apiKey },
      body: JSON.stringify({ model: 'k2d8-preview', messages: [] }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(f.upstream.at(-1).body.model).toBe(secondaryID);
  } finally { await f.cleanup(); }
});

test('two-model saves validate before the host call and report partial persistence without rollback', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  const selected = [];
  try {
    f.controller.setPrimaryModel = async model => {
      selected.push(model);
      write(f.controller.connectionFile, { ...read(f.controller.connectionFile), model });
    };
    await expect(f.controller.saveSettings({ primaryModel: secondaryID, secondaryModel: 'hidden/model' }))
      .rejects.toHaveProperty('code', 'model_not_enabled_for_kimi');
    expect(selected).toEqual([]);
    expect(read(f.controller.connectionFile)).toEqual(f.connection);

    f.controller.setPrimaryModel = async () => { throw Error('private CLI stderr'); };
    await expect(f.controller.saveSettings({ primaryModel: secondaryID, secondaryModel: '' }))
      .rejects.toHaveProperty('code', 'primary_model_update_failed');
    expect(read(f.controller.connectionFile)).toEqual(f.connection);

    f.controller.setPrimaryModel = async model => {
      selected.push(model);
      write(f.controller.connectionFile, { ...read(f.controller.connectionFile), model,
        gateway: { ...f.connection.gateway, key: 'synthetic-new-gateway' } });
    };
    await expect(f.controller.saveSettings({ primaryModel: secondaryID, secondaryModel: '' }))
      .rejects.toHaveProperty('code', 'settings_partially_saved');
    expect(selected).toEqual([secondaryID]);
    expect(read(f.controller.connectionFile).model).toBe(secondaryID);
    expect(read(f.controller.connectionFile).secondaryModel).toBe(secondaryID);
  } finally { await f.cleanup(); }
});

test('a catalog-hidden primary is rejected before the host setter or file writes', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  const selected = [];
  try {
    const before = [f.controller.connectionFile, f.controller.configFile, f.nativeFile]
      .map(file => fs.readFileSync(file, 'utf8'));
    const hadState = fs.existsSync(f.controller.stateFile);
    f.controller.setPrimaryModel = async model => {
      selected.push(model);
      write(f.controller.connectionFile, { ...read(f.controller.connectionFile), model });
    };
    const response = await settingsPost(f.controller, { primaryModel: 'hidden-provider/hidden-model' });
    expect(response).toEqual({ status: 400, body: { error: 'model_not_enabled_for_kimi' } });
    expect(selected).toEqual([]);
    expect([f.controller.connectionFile, f.controller.configFile, f.nativeFile]
      .map(file => fs.readFileSync(file, 'utf8'))).toEqual(before);
    expect(fs.existsSync(f.controller.stateFile)).toBe(hadState);
  } finally { await f.cleanup(); }
});

for (const includeSecondary of [false, true]) {
  test(`a ${includeSecondary ? 'two-model' : 'primary-only'} POST detects a gateway change after the primary setter`, async () => {
    const f = await fixture({ secondaryModel: secondaryID });
    const selected = [];
    let hostBytes;
    try {
      f.controller.setPrimaryModel = async model => {
        selected.push(model);
        write(f.controller.connectionFile, { ...read(f.controller.connectionFile), model,
          gateway: { ...f.connection.gateway, key: 'synthetic-new-gateway' } });
        hostBytes = fs.readFileSync(f.controller.connectionFile, 'utf8');
      };
      const response = await settingsPost(f.controller, { primaryModel: secondaryID,
        ...(includeSecondary ? { secondaryModel: '' } : {}) });
      expect(response).toEqual({ status: 409,
        body: { error: includeSecondary ? 'settings_partially_saved' : 'connection_changed' } });
      expect(selected).toEqual([secondaryID]);
      expect(fs.readFileSync(f.controller.connectionFile, 'utf8')).toBe(hostBytes);
      expect(read(f.controller.connectionFile).secondaryModel).toBe(secondaryID);
    } finally { await f.cleanup(); }
  });
}

test('a two-model POST reports partial persistence when only the secondary file save fails', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  const rename = fs.renameSync;
  const selected = [];
  let blockedWrites = 0, hostBytes;
  try {
    f.controller.setPrimaryModel = async model => {
      selected.push(model);
      write(f.controller.connectionFile, { ...read(f.controller.connectionFile), model });
      hostBytes = fs.readFileSync(f.controller.connectionFile, 'utf8');
    };
    fs.renameSync = (from, to) => {
      if (to === f.controller.connectionFile) {
        blockedWrites += 1;
        throw Object.assign(Error('synthetic secondary persistence failure'), { code: 'EACCES' });
      }
      return rename(from, to);
    };
    const response = await settingsPost(f.controller, { primaryModel: secondaryID, secondaryModel: '' });
    expect(response).toEqual({ status: 409, body: { error: 'settings_partially_saved' } });
    expect(blockedWrites).toBe(1);
    expect(selected).toEqual([secondaryID]);
    expect(fs.readFileSync(f.controller.connectionFile, 'utf8')).toBe(hostBytes);
    expect(read(f.controller.connectionFile).model).toBe(secondaryID);
    expect(read(f.controller.connectionFile).secondaryModel).toBe(secondaryID);
    expect(read(f.controller.connectionFile).gateway).toEqual(f.connection.gateway);
  } finally { fs.renameSync = rename; await f.cleanup(); }
});

test('disconnect reloads a restored legacy baseline after the last primary control call', async () => {
  const baseline = runtimeToml({ secondaryModel: 'native/first', flag: false });
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick();
    f.seedOwned({ baselineText: baseline, currentText: baseline }); f.seedMenuAlias();
    const before = f.calls.length;
    write(f.controller.connectionFile, { ...f.connection, enabled: false });
    f.complete(); await f.controller.tick();
    expect(f.calls.slice(before).map(call => call.method)).toEqual([
      'conversations.getKimiModelList', 'conversations.setModel',
      'conversations.updateKimiModelList', 'conversations.setModel', 'kimiPlugin.reloadActiveSessions',
      'kimiPlugin.setPluginEnabled', 'kimiPlugin.reloadActiveSessions',
      'kimiPlugin.removePlugin',
    ]);
    expect(inspectSecondary(f.nativeText())).toEqual(inspectSecondary(baseline));
    expect(read(f.controller.stateFile).secondary).toBeUndefined();
    expect(f.controller.status.code).toBe('disconnected');
  } finally { await f.cleanup(); }
});

test('disconnect restores legacy scalars even if a pending old session keeps failing', async () => {
  const f = await fixture({ secondaryModel: secondaryID, regenerate: false,
    script: { reload: () => ({ sessions: [{ kernelSessionId: 'old-session', status: 'skipped-active-turn' }] }),
      reloadSession: () => { throw Error('synthetic reload failure'); } } });
  try {
    f.seedOwned();
    await f.controller.tick(); f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_model_reload_failed');
    const attempts = sessionCalls(f.calls).length;
    write(f.controller.connectionFile, { ...f.connection, enabled: false });
    f.complete(); await f.controller.tick();
    expect(inspectSecondary(f.nativeText())).toMatchObject({ model: 'native/first', enabled: false });
    expect(read(f.controller.configFile).model.providers['daimon-kimi-code'].baseUrl).toBe(official);
    expect(sessionCalls(f.calls)).toHaveLength(attempts);
    expect(f.controller.status.code).not.toBe('connected');
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBeUndefined();
  } finally { await f.cleanup(); }
});

for (const malformed of [false, true]) {
  test(`an ${malformed ? 'unsupported' : 'absent'} unowned legacy file does not block bridge settings or primary routing`, async () => {
    const f = await fixture({ secondaryModel: secondaryID, regenerate: false });
    try {
      if (malformed) f.writeNative('not TOML ['); else fs.unlinkSync(f.nativeFile);
      await f.controller.tick();
      expect(f.controller.status.code).toBe('connected');
      expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(secondaryID);
      expect(read(f.controller.stateFile).secondary).toBeUndefined();
      if (malformed) expect(f.nativeText()).toBe('not TOML [');
      else expect(fs.existsSync(f.nativeFile)).toBe(false);
      const response = await fetch(f.controller.bridgeURL + '/chat/completions', { method: 'POST',
        headers: { Authorization: 'Bearer ' + f.doc.credentials.kimiCode.apiKey },
        body: JSON.stringify({ model: 'k2d8-preview', messages: [] }) });
      expect(response.status).toBe(200); await response.text();
      expect(f.upstream.at(-1).body.model).toBe(primaryID);
    } finally { await f.cleanup(); }
  });
}

test('an unrelated converted layout does not pin or invalidate a bridge selection', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick();
    fs.mkdirSync(path.dirname(f.controller.convertedNativeConfigFile), { recursive: true });
    const converted = 'future_kernel_layout = true\n';
    fs.writeFileSync(f.controller.convertedNativeConfigFile, converted);
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(secondaryID);
    expect(fs.readFileSync(f.controller.convertedNativeConfigFile, 'utf8')).toBe(converted);
  } finally { await f.cleanup(); }
});

for (const family of ['kimi-code', 'future-kernel']) {
  test(`old legacy ownership restores before an unsupported explicit secondary is reported (${family})`, async () => {
    const f = await fixture({ secondaryModel: secondaryID, family, regenerate: false });
    try {
      f.seedOwned(); await f.controller.tick();
      expect(inspectSecondary(f.nativeText())).toMatchObject({ model: 'native/first', enabled: false });
      expect(read(f.controller.stateFile).secondary).toBeUndefined();
      expect(reloadCalls(f.calls)).toHaveLength(1);
      expect(f.controller.status.code).toBe('secondary_model_unsupported_runtime');
      expect((await f.controller.readSettings()).appliedSecondaryModel).toBeUndefined();
      expect(f.plugins.calls).toHaveLength(0);
      expect(f.controller.live.model).toBe(primaryID);
      const key = read(f.controller.configFile).credentials.kimiCode.apiKey;
      const response = await fetch(f.controller.bridgeURL + '/chat/completions', { method: 'POST',
        headers: { Authorization: 'Bearer ' + key }, body: JSON.stringify({ model: 'k2d8-preview', messages: [] }) });
      expect(response.status).toBe(200); await response.text();
      expect(f.upstream.at(-1).body.model).toBe(primaryID);
    } finally { await f.cleanup(); }
  });
}

test('a new secondary preference never writes a native scalar or experiment flag', async () => {
  const f = await fixture({ secondaryModel: secondaryID, regenerate: false });
  try {
    const before = f.nativeText();
    await f.controller.tick();
    expect(f.nativeText()).toBe(before);
    expect(inspectSecondary(f.nativeText())).toMatchObject({ model: null, enabled: null });
    expect(reloadCalls(f.calls)).toHaveLength(0);
    expect(read(f.controller.stateFile).secondary).toBeUndefined();
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(secondaryID);
    await f.controller.saveSettings({ secondaryModel: '' });
    f.complete(); await f.controller.tick();
    expect(f.nativeText()).toBe(before);
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBeUndefined();
    expect(f.controller.rolesReady).toBe(false);
  } finally { await f.cleanup(); }
});

test('normal generator rewrites are not repaired with an old secondary alias', async () => {
  const f = await fixture({ secondaryModel: secondaryID,
    native: runtimeToml({ secondaryModel: 'native/first', flag: false }) });
  try {
    await f.controller.tick();
    // The unowned legacy scalar is put back after the control rewrite from a
    // transient memory snapshot, without ownership or a restore reload.
    expect(inspectSecondary(f.nativeText())).toMatchObject({ model: 'native/first', enabled: false });
    expect(read(f.controller.stateFile).secondary).toBeUndefined();
    const calls = f.calls.length;
    f.regenerate(); const regenerated = f.nativeText();
    f.complete(); await f.controller.tick();
    expect(f.nativeText()).toBe(regenerated);
    expect(f.calls.slice(calls).every(call => call.method === 'kimiPlugin.getPluginInfo')).toBe(true);
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(secondaryID);
  } finally { await f.cleanup(); }
});

test('old scalar restoration is deferred while busy and uses only its narrow persisted baseline', async () => {
  const f = await fixture({ secondaryModel: secondaryID, regenerate: false });
  try {
    await f.controller.tick(); f.seedOwned();
    expect(Object.keys(read(f.controller.stateFile).secondary.baseline).sort())
      .toEqual(['enabled', 'hasExperimentalTable', 'hasSecondaryTable', 'model']);
    expect(JSON.stringify(read(f.controller.stateFile).secondary)).not.toContain(f.doc.credentials.kimiCode.apiKey);
    write(f.controller.runnerFile, { ...f.runner, activeKernelTurns: 1 });
    const before = f.nativeText(), calls = f.calls.length;
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('waiting_kimi_idle');
    expect(f.nativeText()).toBe(before);
    expect(f.calls).toHaveLength(calls);
    write(f.controller.runnerFile, f.runner);
    f.complete(); await f.controller.tick();
    expect(inspectSecondary(f.nativeText())).toMatchObject({ model: 'native/first', enabled: false });
    expect(read(f.controller.stateFile).secondary).toBeUndefined();
    expect(reloadCalls(f.calls)).toHaveLength(1);
  } finally { await f.cleanup(); }
});

test('old skipped sessions are retried individually without repeating acknowledged baseline reloads', async () => {
  const f = await fixture({ secondaryModel: secondaryID, regenerate: false,
    script: { reload: () => ({ sessions: [{ kernelSessionId: 'idle', status: 'reloaded' },
      { kernelSessionId: 'busy', status: 'skipped-active-turn' }] }) } });
  try {
    f.seedOwned(); await f.controller.tick();
    expect(f.controller.status.code).toBe('waiting_kimi_idle');
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBeUndefined();
    f.complete(); await f.controller.tick();
    expect(sessionCalls(f.calls).map(call => call.params)).toEqual([{ kernelSessionId: 'busy' }]);
    expect(reloadCalls(f.calls)).toHaveLength(1);
    expect(read(f.controller.stateFile).secondary).toBeUndefined();
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(secondaryID);
  } finally { await f.cleanup(); }
});

test('an unacknowledged old targeted restore remains pending until the explicit reloaded result', async () => {
  const f = await fixture({ secondaryModel: secondaryID, regenerate: false,
    script: { reload: () => ({ sessions: [{ kernelSessionId: 'busy', status: 'skipped-active-turn' }] }),
      reloadSession: () => ({}) } });
  try {
    f.seedOwned(); await f.controller.tick();
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_model_reload_failed');
    expect(read(f.controller.stateFile).secondary).toBeDefined();
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBeUndefined();
    f.behavior.reloadSession = () => ({ status: 'reloaded' });
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(read(f.controller.stateFile).secondary).toBeUndefined();
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(secondaryID);
  } finally { await f.cleanup(); }
});

test('a mixed skipped and failed legacy restoration retries every identified session', async () => {
  const f = await fixture({ secondaryModel: secondaryID, regenerate: false,
    script: { reload: () => ({ sessions: [
      { kernelSessionId: 'mixed-a', status: 'skipped-active-turn' }, { kernelSessionId: 'mixed-b', status: 'failed' },
    ] }) } });
  try {
    f.seedOwned(); await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_model_reload_failed');
    expect(read(f.controller.stateFile).secondary).toBeDefined();
    f.complete(); await f.controller.tick();
    expect(sessionCalls(f.calls).map(call => call.params)).toEqual([
      { kernelSessionId: 'mixed-a' }, { kernelSessionId: 'mixed-b' },
    ]);
    expect(reloadCalls(f.calls)).toHaveLength(1);
    expect(read(f.controller.stateFile).secondary).toBeUndefined();
  } finally { await f.cleanup(); }
});

test('an unattributed legacy reload row requires a complete later pass before dropping ownership', async () => {
  let passes = 0;
  const f = await fixture({ secondaryModel: secondaryID, regenerate: false,
    script: { reload: () => ++passes === 1 ? { sessions: [
      { kernelSessionId: 'known', status: 'skipped-active-turn' }, { status: 'skipped-active-turn' },
    ] } : { sessions: [] } } });
  try {
    f.seedOwned(); await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_model_reload_failed');
    f.complete(); await f.controller.tick();
    expect(read(f.controller.stateFile).secondary).toBeDefined();
    expect(f.controller.status.code).toBe('waiting_kimi_idle');
    f.complete(); await f.controller.tick();
    expect(reloadCalls(f.calls)).toHaveLength(2);
    expect(read(f.controller.stateFile).secondary).toBeUndefined();
    expect(f.controller.status.code).toBe('connected');
  } finally { await f.cleanup(); }
});

test('a foreign legacy edit survives restoration, regeneration and disconnect', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick(); f.seedOwned();
    f.regenerate({ secondaryModel: 'third-party/手动', flag: false,
      secondaryExtra: 'unrelated = "keep"', experimentalExtra: 'other = true' });
    write(f.controller.connectionFile, { ...f.connection, enabled: false });
    await f.controller.tick();
    expect(inspectSecondary(f.nativeText())).toMatchObject({ model: 'third-party/手动', enabled: false });
    expect(read(f.controller.configFile).credentials).toEqual(f.doc.credentials);
    expect(read(f.controller.stateFile).secondary).toBeUndefined();
    expect(f.controller.status.code).toBe('disconnected');
  } finally { await f.cleanup(); }
});

test('stop restores legacy current/menu and scalars without starting secondary-session reloads', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick(); f.seedOwned(); f.seedMenuAlias();
    const before = f.calls.length;
    await f.controller.stop();
    expect(read(f.controller.configFile).model.current).toBe('k2d8-preview');
    expect(f.runtimeModels.map(row => row.model)).toEqual(['k2d8-preview']);
    expect(Object.keys(read(f.controller.configFile).model.models)).toEqual(['k2d8-preview']);
    expect(f.calls.slice(before).map(call => call.method)).toEqual([
      'conversations.getKimiModelList', 'conversations.setModel',
      'conversations.updateKimiModelList', 'conversations.setModel',
      'kimiPlugin.setPluginEnabled', 'kimiPlugin.reloadActiveSessions',
      'kimiPlugin.removePlugin',
    ]);
    expect(inspectSecondary(f.nativeText())).toMatchObject({ model: 'native/first', enabled: false });
    expect(fs.existsSync(f.controller.modelBackupFile)).toBe(false);
    expect(read(f.controller.stateFile).secondary.restored).toBe(true);
    expect(read(f.controller.stateFile).active).toBe(false);
  } finally { await f.cleanup(); }
});

test('synchronous exit restores old scalars without RPC and a new adapter completes their migration', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  let restarted;
  try {
    await f.controller.tick(); f.seedOwned();
    const before = f.calls.length;
    f.controller.restoreFileOnExit();
    expect(inspectSecondary(f.nativeText())).toMatchObject({ model: 'native/first', enabled: false });
    expect(f.calls).toHaveLength(before);
    expect(read(f.controller.stateFile).secondary).toBeDefined();
    await f.controller.stop();
    restarted = new KimiAdapter({ stateDir: f.controller.stateDir, kimiDir: f.controller.kimiDir,
      stabilityMs: 0, rpcCall: f.controller.rpcCall, fetchImpl: f.controller.fetchImpl });
    await restarted.tick();
    expect(restarted.status.code).toBe('connected');
    expect(inspectSecondary(f.nativeText())).toMatchObject({ model: 'native/first', enabled: false });
    expect(read(restarted.stateFile).secondary).toBeUndefined();
    expect((await restarted.readSettings()).appliedSecondaryModel).toBe(secondaryID);
  } finally { await restarted?.stop(); await f.cleanup(); }
});

test('a lost legacy restoration acknowledgement retains ownership through a new adapter instance', async () => {
  const f = await fixture({ secondaryModel: secondaryID, regenerate: false,
    script: { reload: () => { throw Error('synthetic lost reply'); } } });
  let restarted;
  try {
    f.seedOwned(); await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_model_reload_failed');
    expect(inspectSecondary(f.nativeText())).toMatchObject({ model: 'native/first', enabled: false });
    expect(read(f.controller.stateFile).secondary).toBeDefined();
    await f.controller.stop();
    f.behavior.reload = () => ({ sessions: [] });
    restarted = new KimiAdapter({ stateDir: f.controller.stateDir, kimiDir: f.controller.kimiDir,
      stabilityMs: 0, rpcCall: f.controller.rpcCall, fetchImpl: f.controller.fetchImpl });
    await restarted.tick();
    expect(restarted.status.code).toBe('connected');
    expect(read(restarted.stateFile).secondary).toBeUndefined();
    expect((await restarted.readSettings()).appliedSecondaryModel).toBe(secondaryID);
  } finally { await restarted?.stop(); await f.cleanup(); }
});

test('an unsupported owned legacy file is reported and left intact while the primary route stays available', async () => {
  const f = await fixture({ secondaryModel: secondaryID, regenerate: false });
  try {
    f.seedOwned({ currentText: 'secondary_model = "unknown-shape"\n' });
    const before = f.nativeText();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_config_unsupported');
    expect(f.nativeText()).toBe(before);
    expect(read(f.controller.stateFile).secondary).toBeDefined();
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBeUndefined();
    const response = await fetch(f.controller.bridgeURL + '/chat/completions', { method: 'POST',
      headers: { Authorization: 'Bearer ' + f.doc.credentials.kimiCode.apiKey },
      body: JSON.stringify({ model: 'k2d8-preview', messages: [] }) });
    expect(response.status).toBe(200); await response.text();
    expect(f.upstream.at(-1).body.model).toBe(primaryID);
  } finally { await f.cleanup(); }
});
