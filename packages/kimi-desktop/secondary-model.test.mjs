// Synthetic behaviour tests for the primary/secondary model integration.
// Every file here is temporary: no real Kimi profile, no real RPC, no gateway.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { KimiAdapter } from './adapter.mjs';
import { normalizeModels } from './catalog.mjs';
import { startSettingsServer, TOKEN_HEADER } from './settings.mjs';

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
const reloadCalls = calls => calls.filter(call => call.method === 'kimiPlugin.reloadActiveSessions');
const sessionCalls = calls => calls.filter(call => call.method === 'kimiPlugin.ReloadSession');

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

async function fixture({ secondaryModel = '', native, regenerate = true, script = {} } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-kimi-secondary-'));
  const kimiDir = path.join(directory, 'kimi');
  const nativeFile = path.join(kimiDir, 'runtime', 'kimi-code', 'config.toml');
  const calls = [], upstream = [];
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
      calls.push({ method, params });
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
        case 'kimiPlugin.reloadActiveSessions': return behavior.reload();
        case 'kimiPlugin.ReloadSession': return behavior.reloadSession(params);
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
  const runner = { lifecycleStatus: 'running', daemonGeneration: 'synthetic-generation-1',
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
    controller, connection, runner, calls, upstream, nativeFile, catalog, doc,
    get runtimeModels() { return runtimeModels; },
    nativeText, writeNative,
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

test('disconnect reloads the baseline after control calls even when its bytes were already restored externally', async () => {
  const baseline = runtimeToml({ secondaryModel: 'native/first', flag: false });
  const f = await fixture({ secondaryModel: secondaryID, native: baseline, regenerate: false });
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    f.writeNative(baseline);
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('kimi_config_changed');
    expect(read(f.controller.stateFile).secondaryModel).toBe('');
    expect(f.controller.secondaryReloadPending).toBe(false);
    const before = f.calls.length;
    const reloads = reloadCalls(f.calls).length;
    write(f.controller.connectionFile, { ...f.connection, enabled: false });
    f.complete();
    await f.controller.tick();
    const methods = f.calls.slice(before).map(call => call.method);
    expect(methods).toContain('conversations.updateKimiModelList');
    expect(methods).toContain('conversations.setModel');
    expect(methods.at(-1)).toBe('kimiPlugin.reloadActiveSessions');
    expect(reloadCalls(f.calls)).toHaveLength(reloads + 1);
    expect(f.nativeText()).toBe(baseline);
    expect(f.controller.status.code).toBe('disconnected');
    expect(read(f.controller.stateFile).secondary).toBeUndefined();
  } finally { await f.cleanup(); }
});

test('disconnect restores the native baseline despite a failing pending reload from the old preference', async () => {
  const f = await fixture({
    secondaryModel: secondaryID, regenerate: false,
    native: runtimeToml({ secondaryModel: 'native/first', flag: false }),
    script: {
      reload: () => ({ sessions: [{ kernelSessionId: 'old-preference-session', status: 'skipped-active-turn' }] }),
      reloadSession: () => { throw Error('synthetic reload failure'); },
    },
  });
  try {
    await f.controller.tick();
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_model_reload_failed');
    const attempted = sessionCalls(f.calls).length;
    write(f.controller.connectionFile, { ...f.connection, enabled: false });
    f.complete();
    await f.controller.tick();
    const native = Bun.TOML.parse(f.nativeText());
    expect(native.secondary_model.model).toBe('native/first');
    expect(native.experimental['secondary-model']).toBe(false);
    expect(read(f.controller.configFile).model.providers['daimon-kimi-code'].baseUrl).toBe(official);
    expect(sessionCalls(f.calls)).toHaveLength(attempted);
    expect(f.controller.status.code).not.toBe('connected');
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBeUndefined();
  } finally { await f.cleanup(); }
});

test('a missing optional secondary TOML does not block the primary bridge route', async () => {
  const f = await fixture({ secondaryModel: secondaryID, regenerate: false });
  try {
    fs.unlinkSync(f.nativeFile);
    await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_model_unavailable');
    expect(read(f.controller.configFile).model.providers['daimon-kimi-code'].baseUrl).toBe(f.controller.bridgeURL);
    const response = await fetch(f.controller.bridgeURL + '/chat/completions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + f.doc.credentials.kimiCode.apiKey },
      body: JSON.stringify({ model: 'k2d8-preview', messages: [] }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(f.upstream.at(-1).body.model).toBe(primaryID);
    expect(f.controller.state.secondary).toBeUndefined();
  } finally { await f.cleanup(); }
});

test('an unsupported optional secondary TOML does not block the primary bridge route', async () => {
  const f = await fixture({ secondaryModel: secondaryID, regenerate: false,
    native: 'secondary_model = "native/first"\n' + runtimeToml() });
  try {
    const before = f.nativeText();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_config_unsupported');
    expect(f.nativeText()).toBe(before);
    expect(f.controller.state.secondary).toBeUndefined();
    expect(f.controller.state.secondaryModel).toBeUndefined();
    expect(read(f.controller.configFile).model.providers['daimon-kimi-code'].baseUrl).toBe(f.controller.bridgeURL);
    const response = await fetch(f.controller.bridgeURL + '/chat/completions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + f.doc.credentials.kimiCode.apiKey },
      body: JSON.stringify({ model: 'k2d8-preview', messages: [] }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(f.upstream.at(-1).body.model).toBe(primaryID);
  } finally { await f.cleanup(); }
});

test('an unrecognized converted layout rejects secondary application while the primary still routes', async () => {
  const f = await fixture({ secondaryModel: secondaryID, regenerate: false });
  const convertedFile = path.join(path.dirname(f.nativeFile), 'home', 'config.toml');
  const converted = 'default_model = "converted-native"\n';
  try {
    fs.mkdirSync(path.dirname(convertedFile), { recursive: true });
    fs.writeFileSync(convertedFile, converted);
    const legacy = f.nativeText();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_model_unsupported_runtime');
    expect(f.nativeText()).toBe(legacy);
    expect(fs.readFileSync(convertedFile, 'utf8')).toBe(converted);
    expect(reloadCalls(f.calls)).toHaveLength(0);
    expect(f.controller.state.secondary).toBeUndefined();
    const settings = await f.controller.readSettings();
    expect(settings.status).toBe('secondary_model_unsupported_runtime');
    expect(settings.appliedPrimaryModel).toBe(primaryID);
    expect(settings.appliedSecondaryModel).toBeUndefined();
    const response = await fetch(f.controller.bridgeURL + '/chat/completions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + read(f.controller.configFile).credentials.kimiCode.apiKey },
      body: JSON.stringify({ model: 'k2d8-preview', messages: [] }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(f.upstream.at(-1).body.model).toBe(primaryID);
  } finally { await f.cleanup(); }
});

for (const cleanup of ['disconnect', 'stop']) {
  test(`an unrecognized converted layout invalidates legacy confirmation but ${cleanup} still restores legacy ownership`, async () => {
    const baseline = runtimeToml({ secondaryModel: 'native/first', flag: false });
    const f = await fixture({ secondaryModel: secondaryID, native: baseline, regenerate: false });
    const convertedFile = path.join(path.dirname(f.nativeFile), 'home', 'config.toml');
    const converted = 'default_model = "converted-native"\n';
    try {
      await f.controller.tick();
      expect(f.controller.status.code).toBe('connected');
      expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(secondaryID);
      const owned = read(f.controller.stateFile).secondary;
      const legacy = f.nativeText();
      const reloads = reloadCalls(f.calls).length;
      fs.mkdirSync(path.dirname(convertedFile), { recursive: true });
      fs.writeFileSync(convertedFile, converted);
      // A stale acknowledgement must disappear even before the next tick.
      expect((await f.controller.readSettings()).appliedSecondaryModel).toBeUndefined();
      f.complete();
      await f.controller.tick();
      expect(f.controller.status.code).toBe('secondary_model_unsupported_runtime');
      expect(read(f.controller.stateFile).secondaryModel).toBe('');
      expect(read(f.controller.stateFile).secondary).toEqual(owned);
      expect(f.nativeText()).toBe(legacy);
      expect(reloadCalls(f.calls)).toHaveLength(reloads);
      const settings = await f.controller.readSettings();
      expect(settings.appliedPrimaryModel).toBe(primaryID);
      expect(settings.appliedSecondaryModel).toBeUndefined();
      if (cleanup === 'disconnect') {
        write(f.controller.connectionFile, { ...f.connection, enabled: false });
        f.complete();
        await f.controller.tick();
        expect(read(f.controller.stateFile).secondary).toBeUndefined();
        expect(reloadCalls(f.calls)).toHaveLength(reloads + 1);
      } else {
        const calls = f.calls.length;
        await f.controller.stop();
        expect(reloadCalls(f.calls.slice(calls))).toHaveLength(0);
        expect(sessionCalls(f.calls.slice(calls))).toHaveLength(0);
        expect(read(f.controller.stateFile).secondary.restored).toBe(true);
      }
      expect(f.controller.status.code).toBe('disconnected');
      const restored = Bun.TOML.parse(f.nativeText());
      expect(restored.secondary_model.model).toBe('native/first');
      expect(restored.experimental['secondary-model']).toBe(false);
      expect(fs.readFileSync(convertedFile, 'utf8')).toBe(converted);
    } finally { await f.cleanup(); }
  });
}

test('the chosen secondary model is written as its catalog alias and both roles keep their alias route', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    const toml = Bun.TOML.parse(f.nativeText());
    expect(toml.secondary_model.model).toBe(alias.get(secondaryID));
    expect(toml.experimental['secondary-model']).toBe(true);
    expect(f.nativeText()).not.toContain('__secondary__');
    expect(fs.statSync(f.nativeFile).mode & 0o777).toBe(0o600);
    expect(read(f.controller.stateFile).secondaryModel).toBe(secondaryID);
    expect(read(f.controller.stateFile).secondary.baseline).toEqual({
      model: null, enabled: null, hasSecondaryTable: false, hasExperimentalTable: false,
    });
    // The state file keeps model names, never the runtime TOML or credentials.
    const state = fs.readFileSync(f.controller.stateFile, 'utf8');
    expect(state).not.toContain('default_model');
    expect(state).not.toContain('synthetic-kimi-key');
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(secondaryID);
    // Both roles route through the aliases already registered in Kimi.
    for (const [modelAlias, id] of [[alias.get(primaryID), primaryID], [alias.get(secondaryID), secondaryID]]) {
      const response = await fetch(f.controller.bridgeURL + '/chat/completions', {
        method: 'POST', headers: { Authorization: 'Bearer kbemfhpmb-kimi-key' },
        body: JSON.stringify({ model: modelAlias, messages: [] }),
      });
      // A wrong Kimi credential is refused before any upstream call.
      expect(response.status).toBe(401);
      await response.text();
    }
    for (const [modelAlias, id] of [[alias.get(primaryID), primaryID], [alias.get(secondaryID), secondaryID]]) {
      const response = await fetch(f.controller.bridgeURL + '/chat/completions', {
        method: 'POST', headers: { Authorization: 'Bearer synthetic-kimi-key' },
        body: JSON.stringify({ model: modelAlias, messages: [] }),
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(f.upstream.at(-1).body.model).toBe(id);
    }
  } finally { await f.cleanup(); }
});

test('a regenerated runtime TOML is repaired after the connection pass and only while idle', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(reloadCalls(f.calls)).toHaveLength(1);

    f.regenerate();
    expect(f.nativeText()).not.toContain('[secondary_model]');

    // Mid-turn: neither the TOML nor the runtime may change, and the adapter
    // must not report the preference as applied.
    write(f.controller.runnerFile, { ...f.runner, activeKernelTurns: 1 });
    f.complete();
    const before = f.calls.length;
    await f.controller.tick();
    expect(f.controller.status.code).toBe('waiting_kimi_idle');
    expect(f.nativeText()).not.toContain('[secondary_model]');
    expect(f.calls.length).toBe(before);

    // Idle: the lost scalars are reapplied from the original baseline record.
    write(f.controller.runnerFile, f.runner);
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    const toml = Bun.TOML.parse(f.nativeText());
    expect(toml.secondary_model.model).toBe(alias.get(secondaryID));
    expect(toml.experimental['secondary-model']).toBe(true);
    expect(read(f.controller.stateFile).secondary.baseline.model).toBeNull();
    expect(reloadCalls(f.calls)).toHaveLength(2);
  } finally { await f.cleanup(); }
});

test('a session skipped mid-turn is retried by id without reloading the others again', async () => {
  const f = await fixture({
    secondaryModel: secondaryID,
    script: { reload: () => ({ sessions: [
      { kernelSessionId: 'synthetic-session-a', status: 'reloaded' },
      { kernelSessionId: 'synthetic-session-b', status: 'skipped-active-turn' },
    ] }) },
  });
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('waiting_kimi_idle');
    expect(read(f.controller.stateFile).secondaryModel).toBeUndefined();
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBeUndefined();

    // Busy runtime: the targeted retry waits.
    write(f.controller.runnerFile, { ...f.runner, activeKernelTurns: ['synthetic-turn'] });
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('waiting_kimi_idle');
    expect(sessionCalls(f.calls)).toHaveLength(0);

    write(f.controller.runnerFile, f.runner);
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(sessionCalls(f.calls).map(call => call.params)).toEqual([{ kernelSessionId: 'synthetic-session-b' }]);
    // The sessions that were already reloaded are not touched again.
    expect(reloadCalls(f.calls)).toHaveLength(1);
    expect(read(f.controller.stateFile).secondaryModel).toBe(secondaryID);
  } finally { await f.cleanup(); }
});

test('clearing the preference follows primary and keeps the original scalars for disconnect', async () => {
  const f = await fixture({
    secondaryModel: secondaryID,
    regenerate: false,
    native: runtimeToml({ secondaryModel: 'native/first', secondaryExtra: 'default_effort = "max"',
      flag: false, experimentalExtra: 'other-flag = true' }),
  });
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    let toml = Bun.TOML.parse(f.nativeText());
    expect(toml.secondary_model.model).toBe(alias.get(secondaryID));
    expect(toml.experimental['secondary-model']).toBe(true);
    expect(toml.secondary_model.default_effort).toBe('max');
    expect(toml.experimental['other-flag']).toBe(true);

    // A new selection changes the secondary alias without rebuilding the bridge.
    write(f.controller.connectionFile, { ...f.connection, secondaryModel: primaryID });
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    toml = Bun.TOML.parse(f.nativeText());
    expect(toml.secondary_model.model).toBe(alias.get(primaryID));
    expect(read(f.controller.stateFile).secondaryModel).toBe(primaryID);

    // Clearing follows the current primary; Disconnect still owns the baseline.
    write(f.controller.connectionFile, { ...f.connection, secondaryModel: '' });
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    toml = Bun.TOML.parse(f.nativeText());
    expect(toml.secondary_model.model).toBe(alias.get(primaryID));
    expect(toml.experimental['secondary-model']).toBe(true);
    expect(toml.secondary_model.default_effort).toBe('max');
    expect(toml.experimental['other-flag']).toBe(true);
    expect(read(f.controller.stateFile).secondary.baseline).toEqual({
      model: 'native/first', enabled: false,
      hasSecondaryTable: true, hasExperimentalTable: true,
    });
    expect(read(f.controller.stateFile).secondaryModel).toBe(primaryID);
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(primaryID);
  } finally { await f.cleanup(); }
});

test('inherit follows the primary route while an enabled secondary baseline remains recoverable', async () => {
  const baseline = runtimeToml({ secondaryModel: alias.get(secondaryID), flag: true });
  const f = await fixture({ secondaryModel: primaryID, native: baseline });
  const assertInherited = async model => {
    const current = Bun.TOML.parse(f.nativeText());
    const settings = await f.controller.readSettings();
    expect(settings.secondaryModel).toBe('');
    expect(settings.appliedSecondaryModel).toBe(model);
    const response = await fetch(f.controller.bridgeURL + '/chat/completions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + f.doc.credentials.kimiCode.apiKey },
      body: JSON.stringify({ model: current.secondary_model.model, messages: [] }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(f.upstream.at(-1).body.model).toBe(model);
    expect(current.secondary_model.model).toBe(alias.get(model));
    expect(current.experimental['secondary-model']).toBe(true);
  };
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    write(f.controller.connectionFile, { ...f.connection, secondaryModel: '' });
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    await assertInherited(primaryID);
    expect(read(f.controller.stateFile).secondary.baseline).toEqual({
      model: alias.get(secondaryID), enabled: true,
      hasSecondaryTable: true, hasExperimentalTable: true,
    });

    const reloaded = reloadCalls(f.calls).length;
    f.complete();
    await f.controller.tick();
    expect(reloadCalls(f.calls)).toHaveLength(reloaded);

    write(f.controller.connectionFile, { ...f.connection, model: secondaryID, secondaryModel: '' });
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    await assertInherited(secondaryID);

    write(f.controller.connectionFile, { ...f.connection, model: secondaryID, secondaryModel: '', enabled: false });
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('disconnected');
    const restored = Bun.TOML.parse(f.nativeText());
    expect(restored.secondary_model).toEqual(Bun.TOML.parse(baseline).secondary_model);
    expect(restored.experimental).toEqual(Bun.TOML.parse(baseline).experimental);
    expect(read(f.controller.stateFile).secondary).toBeUndefined();
  } finally { await f.cleanup(); }
});

test('disconnect restores the baseline after the last control call and keeps credentials and models', async () => {
  const f = await fixture({
    secondaryModel: secondaryID,
    native: runtimeToml({ secondaryModel: 'native/first', flag: false }),
  });
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(Bun.TOML.parse(f.nativeText()).secondary_model.model).toBe(alias.get(secondaryID));
    write(f.controller.connectionFile, { ...f.connection, enabled: false });
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('disconnected');
    const toml = Bun.TOML.parse(f.nativeText());
    // Daimon regenerated the file during that restore pass; both scalars are
    // written back afterwards, and nothing else is invented.
    expect(toml.secondary_model.model).toBe('native/first');
    expect(toml.experimental['secondary-model']).toBe(false);
    expect(toml.models['k2d8-preview']).toBeDefined();
    expect(read(f.controller.configFile).credentials).toEqual(f.doc.credentials);
    expect(read(f.controller.configFile).unrelated).toEqual(f.doc.unrelated);
    expect(read(f.controller.configFile).model.providers['daimon-kimi-code'].baseUrl).toBe(official);
    expect(read(f.controller.stateFile).secondary).toBeUndefined();
  } finally { await f.cleanup(); }
});

test('a value another writer installed is never restored over', async () => {
  const f = await fixture({
    secondaryModel: secondaryID,
    regenerate: false,
    native: runtimeToml({ secondaryModel: 'native/first', flag: false }),
  });
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    // Hand-edited while connected: no longer ours.
    f.writeNative(runtimeToml({ secondaryModel: 'third-party/手动', flag: false }));
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('kimi_config_changed');
    expect(Bun.TOML.parse(f.nativeText()).secondary_model.model).toBe('third-party/手动');
    // Not applied, so nothing is claimed for the saved preference.
    expect(read(f.controller.stateFile).secondaryModel).toBe('');

    write(f.controller.connectionFile, { ...f.connection, enabled: false });
    f.complete();
    await f.controller.tick();
    const toml = Bun.TOML.parse(f.nativeText());
    expect(toml.secondary_model.model).toBe('third-party/手动');
    expect(toml.experimental['secondary-model']).toBe(false);
  } finally { await f.cleanup(); }
});

test('a pending reload waits for an idle runtime instead of reloading it', async () => {
  let reloads = 0;
  const f = await fixture({
    secondaryModel: secondaryID,
    script: {
      reload: () => {
        reloads += 1;
        return reloads === 2 ? { sessions: [{ kernelSessionId: 'synthetic-session-d', status: 'failed' }] } : { sessions: [] };
      },
    },
  });
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    // A regeneration is repaired on disk, but its reload fails.
    f.regenerate();
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_model_reload_failed');
    expect(reloadCalls(f.calls)).toHaveLength(2);
    expect(f.controller.secondaryReloadPending).toBe(true);

    // The written file is left alone and no new reload is attempted mid-turn.
    write(f.controller.runnerFile, { ...f.runner, activeKernelTurns: 1 });
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('waiting_kimi_idle');
    expect(reloadCalls(f.calls)).toHaveLength(2);

    // Idle again: only the unconfirmed session is retried, and only then is
    // the preference reported as applied.
    write(f.controller.runnerFile, f.runner);
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(reloadCalls(f.calls)).toHaveLength(2);
    expect(sessionCalls(f.calls).map(call => call.params)).toEqual([{ kernelSessionId: 'synthetic-session-d' }]);
    expect(read(f.controller.stateFile).secondaryModel).toBe(secondaryID);
  } finally { await f.cleanup(); }
});

test('a targeted reload without an explicit acknowledgement is a failure, not an application', async () => {
  const f = await fixture({
    secondaryModel: secondaryID,
    script: {
      reload: () => ({ sessions: [{ kernelSessionId: 'synthetic-session-e', status: 'skipped-active-turn' }] }),
      reloadSession: () => ({}),
    },
  });
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('waiting_kimi_idle');
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_model_reload_failed');
    expect(read(f.controller.stateFile).secondaryModel).toBeUndefined();
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBeUndefined();
  } finally { await f.cleanup(); }
});

test('failures are reported as not applied instead of connected', async () => {
  // A reload that reports a failed session.
  const failed = await fixture({
    secondaryModel: secondaryID,
    script: { reload: () => ({ sessions: [{ kernelSessionId: 'synthetic-session-c', status: 'failed' }] }) },
  });
  try {
    await failed.controller.tick();
    expect(failed.controller.status.code).toBe('secondary_model_reload_failed');
    expect((await failed.controller.readSettings()).appliedSecondaryModel).toBeUndefined();
    expect(read(failed.controller.stateFile).secondaryModel).toBeUndefined();
  } finally { await failed.cleanup(); }

  // A saved model that the gateway catalog no longer exposes.
  const unavailable = await fixture({ secondaryModel: 'hidden-provider/hidden-model', regenerate: false });
  try {
    const before = unavailable.nativeText();
    await unavailable.controller.tick();
    expect(unavailable.controller.status.code).toBe('secondary_model_unavailable');
    expect(unavailable.nativeText()).toBe(before);
    expect(unavailable.controller.state.secondaryModel).toBeUndefined();
  } finally { await unavailable.cleanup(); }

  // A malformed preference fails the connection validation, before any write.
  const malformed = await fixture({ regenerate: false });
  try {
    const before = malformed.nativeText();
    write(malformed.controller.connectionFile, { ...malformed.connection, secondaryModel: 'no-slash' });
    await malformed.controller.tick();
    expect(malformed.controller.status.code).toBe('invalid_connection');
    expect(malformed.nativeText()).toBe(before);
    expect(malformed.controller.state.secondary).toBeUndefined();
  } finally { await malformed.cleanup(); }
});

test('without a secondary preference the original path is untouched', async () => {
  const f = await fixture({ regenerate: false });
  try {
    const before = f.nativeText();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(f.nativeText()).toBe(before);
    expect(f.calls.map(call => call.method)).toEqual(['models.current', 'conversations.setModel',
      'conversations.getKimiModelList', 'conversations.updateKimiModelList']);
    expect(reloadCalls(f.calls)).toHaveLength(0);
    expect(sessionCalls(f.calls)).toHaveLength(0);
    expect(read(f.controller.stateFile).secondary).toBeUndefined();
    expect(read(f.controller.stateFile).secondaryModel).toBeUndefined();
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(primaryID);
  } finally { await f.cleanup(); }
});

test('a mixed skipped and failed reload never becomes an application', async () => {
  const f = await fixture({
    secondaryModel: secondaryID,
    script: {
      reload: () => ({ sessions: [
        { kernelSessionId: 'synthetic-mixed-a', status: 'skipped-active-turn' },
        { kernelSessionId: 'synthetic-mixed-b', status: 'failed' },
      ] }),
    },
  });
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_model_reload_failed');
    expect(read(f.controller.stateFile).secondaryModel).toBeUndefined();
    expect(f.controller.secondaryPending).toEqual(new Set(['synthetic-mixed-a', 'synthetic-mixed-b']));

    // Each id is retried once, in order: the skipped one and the failed one.
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(sessionCalls(f.calls).map(call => call.params)).toEqual([
      { kernelSessionId: 'synthetic-mixed-a' }, { kernelSessionId: 'synthetic-mixed-b' },
    ]);
    // No cached session is reloaded twice, and nothing was applied early.
    expect(reloadCalls(f.calls)).toHaveLength(1);
    expect(read(f.controller.stateFile).secondaryModel).toBe(secondaryID);
  } finally { await f.cleanup(); }
});

test('a reload row that cannot be retried by id keeps the preference unapplied until a full pass', async () => {
  let reloads = 0;
  const f = await fixture({
    secondaryModel: secondaryID,
    script: {
      reload: () => {
        reloads += 1;
        return reloads === 1
          ? { sessions: [{ kernelSessionId: 'synthetic-unattributed-a', status: 'skipped-active-turn' },
            { status: 'skipped-active-turn' }] }
          : { sessions: [] };
      },
    },
  });
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_model_reload_failed');
    expect(read(f.controller.stateFile).secondaryModel).toBeUndefined();

    // The tracked id is retried, but the unattributed row still needs a pass.
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('waiting_kimi_idle');
    expect(read(f.controller.stateFile).secondaryModel).toBeUndefined();

    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(reloadCalls(f.calls)).toHaveLength(2);
    expect(read(f.controller.stateFile).secondaryModel).toBe(secondaryID);
  } finally { await f.cleanup(); }
});

test('legacy stop restores native current and menu without secondary session RPCs', async () => {
  const f = await fixture({
    secondaryModel: secondaryID,
    native: runtimeToml({ secondaryModel: 'native/first', flag: false }),
  });
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(Bun.TOML.parse(f.nativeText()).secondary_model.model).toBe(alias.get(secondaryID));
    const current = read(f.controller.configFile);
    current.model.current = alias.get(primaryID);
    write(f.controller.configFile, current);
    expect(f.runtimeModels.some(row => row.model === alias.get(primaryID))).toBe(true);
    expect(fs.existsSync(f.controller.modelBackupFile)).toBe(true);
    const calls = f.calls.length;
    await f.controller.stop();
    expect(read(f.controller.configFile).model.current).toBe('k2d8-preview');
    expect(f.runtimeModels.map(row => row.model)).toEqual(['k2d8-preview']);
    expect(Object.keys(read(f.controller.configFile).model.models)).toEqual(['k2d8-preview']);
    expect(f.calls.slice(calls).map(call => call.method)).toEqual([
      'conversations.getKimiModelList', 'conversations.setModel',
      'conversations.updateKimiModelList', 'conversations.setModel',
    ]);
    expect(fs.existsSync(f.controller.modelBackupFile)).toBe(false);
    // Still checked before the temporary directory is removed.
    const toml = Bun.TOML.parse(f.nativeText());
    expect(toml.secondary_model.model).toBe('native/first');
    expect(toml.experimental['secondary-model']).toBe(false);
    expect(toml.models['k2d8-preview']).toBeDefined();
    expect(fs.readFileSync(f.controller.configFile, 'utf8')).toContain(official);
    expect(reloadCalls(f.calls.slice(calls))).toHaveLength(0);
    expect(sessionCalls(f.calls.slice(calls))).toHaveLength(0);
    expect(read(f.controller.stateFile).secondary.restored).toBe(true);
    expect(read(f.controller.stateFile).active).toBe(false);
    expect(f.controller.status.code).toBe('disconnected');
  } finally { await f.cleanup(); }
});

test('the synchronous exit path restores only the two scalars and keeps ownership', async () => {
  const f = await fixture({
    secondaryModel: secondaryID,
    native: runtimeToml({ secondaryModel: 'native/first', flag: false }),
  });
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    const calls = f.calls.length;
    f.controller.restoreFileOnExit();
    const toml = Bun.TOML.parse(f.nativeText());
    expect(toml.secondary_model.model).toBe('native/first');
    expect(toml.experimental['secondary-model']).toBe(false);
    // No reload and no other control call happens on this path.
    expect(f.calls.length).toBe(calls);
    // Ownership stays for the next start to finish the job.
    expect(read(f.controller.stateFile).secondary).toBeDefined();
  } finally { await f.cleanup(); }
});

test('clearing the preference keeps a third-party value that a catalog regeneration dropped', async () => {
  const f = await fixture({
    secondaryModel: secondaryID,
    native: runtimeToml({ secondaryModel: 'native/first', flag: false }),
  });
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(read(f.controller.stateFile).secondary.baseline.model).toBe('native/first');
    // Hand-edited while connected, then Daimon rewrites the whole file.
    f.writeNative(runtimeToml({ secondaryModel: 'third-party/手动', flag: false }));
    f.catalog.data.push({ id: 'third-provider/third-model', display_name: 'Third' });
    write(f.controller.connectionFile, { ...f.connection, secondaryModel: '' });
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('kimi_config_changed');
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBeUndefined();
    const toml = Bun.TOML.parse(f.nativeText());
    expect(toml.secondary_model.model).toBe('third-party/手动');
    expect(toml.experimental['secondary-model']).toBe(false);
    expect(f.nativeText()).not.toContain(alias.get(secondaryID));
    expect(read(f.controller.stateFile).secondary.baseline.model).toBe('native/first');
  } finally { await f.cleanup(); }
});

test('disconnecting keeps a third-party scalar that Daimon rewrote away', async () => {
  const f = await fixture({
    secondaryModel: secondaryID,
    native: runtimeToml({ secondaryModel: 'native/first', flag: false }),
  });
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    f.writeNative(runtimeToml({ secondaryModel: 'third-party/手动', flag: false }));
    write(f.controller.connectionFile, { ...f.connection, enabled: false });
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('disconnected');
    const toml = Bun.TOML.parse(f.nativeText());
    expect(toml.secondary_model.model).toBe('third-party/手动');
    expect(toml.experimental['secondary-model']).toBe(false);
    expect(read(f.controller.configFile).credentials).toEqual(f.doc.credentials);
    expect(read(f.controller.stateFile).secondary).toBeUndefined();
  } finally { await f.cleanup(); }
});

test('switching the secondary model keeps the last applied marker until the new one is confirmed', async () => {
  let reloads = 0;
  const f = await fixture({
    secondaryModel: secondaryID,
    script: {
      reload: () => {
        reloads += 1;
        return reloads === 2
          ? { sessions: [{ kernelSessionId: 'synthetic-session-switch', status: 'failed' }] }
          : { sessions: [] };
      },
    },
  });
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(secondaryID);
    const setModels = f.calls.filter(call => call.method === 'conversations.setModel').length;

    // Only the preference changes: no new bridge connection is made.
    write(f.controller.connectionFile, { ...f.connection, secondaryModel: primaryID });
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_model_reload_failed');
    expect(f.calls.filter(call => call.method === 'conversations.setModel').length).toBe(setModels);
    // The marker still names what was really applied, not the new preference.
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(secondaryID);

    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect((await f.controller.readSettings()).appliedSecondaryModel).toBe(primaryID);
    expect(Bun.TOML.parse(f.nativeText()).secondary_model.model).toBe(alias.get(primaryID));
  } finally { await f.cleanup(); }
});


test('a fresh secondary preference confirms cached sessions even when the native bytes already match', async () => {
  const f = await fixture();
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    f.writeNative(runtimeToml({ secondaryModel: alias.get(secondaryID), flag: true }));
    write(f.controller.connectionFile, { ...f.connection, secondaryModel: secondaryID });
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(reloadCalls(f.calls)).toHaveLength(1);
    expect(read(f.controller.stateFile).secondary.alias).toBe(alias.get(secondaryID));
    expect(read(f.controller.stateFile).secondaryModel).toBe(secondaryID);
  } finally { await f.cleanup(); }
});

test('a clean synchronous exit can reapply the saved secondary preference after restart', async () => {
  const f = await fixture({
    secondaryModel: secondaryID,
    native: runtimeToml({ secondaryModel: 'native/first', flag: false }),
  });
  let restarted;
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    f.controller.restoreFileOnExit();
    expect(Bun.TOML.parse(f.nativeText()).secondary_model.model).toBe('native/first');
    expect(Bun.TOML.parse(f.nativeText()).experimental['secondary-model']).toBe(false);
    await f.controller.stop();
    restarted = new KimiAdapter({
      stateDir: f.controller.stateDir, kimiDir: f.controller.kimiDir,
      stabilityMs: 0, rpcCall: f.controller.rpcCall, fetchImpl: f.controller.fetchImpl,
    });
    await restarted.tick();
    expect(restarted.status.code).toBe('connected');
    expect(Bun.TOML.parse(f.nativeText()).secondary_model.model).toBe(alias.get(secondaryID));
    expect(Bun.TOML.parse(f.nativeText()).experimental['secondary-model']).toBe(true);
    expect(read(restarted.stateFile).secondary.baseline.model).toBe('native/first');
    expect(read(restarted.stateFile).secondaryModel).toBe(secondaryID);
  } finally {
    if (restarted) await restarted.stop();
    await f.cleanup();
  }
});

test('a waiting restore keeps external secondary values until the native rewrite is repaired', async () => {
  let batches = 0, stillBusy = true;
  const f = await fixture({
    secondaryModel: secondaryID,
    native: runtimeToml({ secondaryModel: 'native/first', flag: false }),
    script: {
      // The original preference and then the restored baseline each have a
      // busy cached session; Disconnect discards the original pending batch.
      reload: () => ++batches <= 2
        ? { sessions: [{ kernelSessionId: 'waiting-session', status: 'skipped-active-turn' }] }
        : { sessions: [] },
      reloadSession: () => ({ status: stillBusy ? 'skipped-active-turn' : 'reloaded' }),
    },
  });
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('waiting_kimi_idle');
    f.writeNative(runtimeToml({ secondaryModel: 'third-party/手动', flag: false }));
    write(f.controller.connectionFile, { ...f.connection, enabled: false });
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('waiting_kimi_idle');
    stillBusy = false;
    f.complete();
    await f.controller.tick();
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('disconnected');
    const current = Bun.TOML.parse(f.nativeText());
    expect(current.secondary_model.model).toBe('third-party/手动');
    expect(current.experimental['secondary-model']).toBe(false);
  } finally { await f.cleanup(); }
});
