import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { KimiAdapter } from './adapter.mjs';
import { startSettingsServer, TOKEN_HEADER } from './settings.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-option-settings-'));
  const catalog = [
    { id: 'example/main', display_name: 'Main', reasoning: true,
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }], context_window: 131072 },
    { id: 'example/other', display_name: 'Other', reasoning: false, context_window: 65536 },
    { id: 'example/unknown', display_name: 'Unknown' },
  ];
  const adapter = new KimiAdapter({ home, stateDir: path.join(home, 'state'), kimiDir: path.join(home, 'native'),
    fetchImpl: async () => Response.json({ data: catalog }),
  });
  const connection = { enabled: true, model: 'example/main', secondaryModel: 'example/main',
    gateway: { url: 'http://127.0.0.1:34567/v1', key: 'synthetic-only-key' }, preserve: { value: 7 } };
  write(adapter.connectionFile, connection);
  return { home, adapter, catalog, connection, close: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test('settings advertise only known external effort and context capabilities', async () => {
  const f = fixture();
  try {
    const view = await f.adapter.readSettings();
    expect(view.models[0]).toEqual({ id: 'example/main', name: 'Main · External',
      reasoningEfforts: ['low', 'high'], contextWindow: 131072 });
    expect(view.models[2].contextWindow).toBeNull();
    expect(view.models[2].reasoningEfforts).toEqual([]);
    expect(view).not.toHaveProperty('gateway');
  } finally { f.close(); }
});

test('same-model primary and secondary preferences persist independently and bind to their selected model', async () => {
  const f = fixture();
  try {
    const view = await f.adapter.saveSettings({ primaryReasoningEffort: 'high', secondaryReasoningEffort: 'low' });
    expect(view.primaryReasoningEffort).toBe('high');
    expect(view.secondaryReasoningEffort).toBe('low');
    const saved = read(f.adapter.connectionFile);
    expect(saved.modelOptions).toEqual({
      primary: { model: 'example/main', reasoningEffort: 'high', contextTokens: null },
      secondary: { model: 'example/main', reasoningEffort: 'low', contextTokens: null },
    });
    expect(saved.gateway).toEqual(f.connection.gateway);
    expect(saved.preserve).toEqual({ value: 7 });
    expect(view.primaryOptionsStatus).not.toBe('applied');
  } finally { f.close(); }
});

test('unsupported effort is rejected before the official primary selector or any preference write', async () => {
  const f = fixture();
  let primaryCalls = 0;
  f.adapter.setPrimaryModel = async () => { primaryCalls++; };
  try {
    const bytes = fs.readFileSync(f.adapter.connectionFile);
    await expect(f.adapter.saveSettings({ primaryModel: 'example/other', primaryReasoningEffort: 'high' }))
      .rejects.toHaveProperty('code', 'unsupported_reasoning_effort');
    expect(primaryCalls).toBe(0);
    expect(fs.readFileSync(f.adapter.connectionFile).equals(bytes)).toBe(true);
  } finally { f.close(); }
});

test('context above an advertised limit or with unknown capacity is rejected before saving', async () => {
  const f = fixture();
  try {
    const before = fs.readFileSync(f.adapter.connectionFile);
    for (const patch of [
      { primaryContextTokens: 131073 },
      { primaryModel: 'example/unknown', primaryContextTokens: 10000 },
      { secondaryContextTokens: 0 }, { primaryContextTokens: 0.5 },
    ]) await expect(f.adapter.saveSettings(patch)).rejects.toHaveProperty('code');
    expect(fs.readFileSync(f.adapter.connectionFile).equals(before)).toBe(true);
  } finally { f.close(); }
});

test('a supported positive input budget is saved and remains pending until the bridge is connected', async () => {
  const f = fixture();
  try {
    let view, code;
    try { view = await f.adapter.saveSettings({ primaryContextTokens: 65536 }); }
    catch (error) { code = error.code; }
    expect(code).toBeUndefined();
    expect(view.primaryContextTokens).toBe(65536);
    expect(view.primaryOptionsStatus).toBe('pending');
    expect(read(f.adapter.connectionFile).modelOptions.primary.contextTokens).toBe(65536);
  } finally { f.close(); }
});

test('option failure after the official primary change reports a partial save and preserves the new connection', async () => {
  const f = fixture();
  f.adapter.setPrimaryModel = async model => write(f.adapter.connectionFile, {
    ...read(f.adapter.connectionFile), model, gateway: { url: f.connection.gateway.url, key: 'synthetic-new-key' },
  });
  try {
    await expect(f.adapter.saveSettings({ primaryModel: 'example/other', primaryReasoningEffort: '' }))
      .rejects.toHaveProperty('code', 'settings_partially_saved');
    const saved = read(f.adapter.connectionFile);
    expect(saved.model).toBe('example/other');
    expect(saved.gateway.key).toBe('synthetic-new-key');
    expect(saved).not.toHaveProperty('modelOptions');
  } finally { f.close(); }
});

test('a host-side model change never silently applies preferences bound to the previous model', async () => {
  const f = fixture();
  try {
    write(f.adapter.connectionFile, { ...f.connection, model: 'example/other', modelOptions: {
      primary: { model: 'example/main', reasoningEffort: 'high', contextTokens: 100000 },
    } });
    const before = fs.readFileSync(f.adapter.connectionFile);
    const view = await f.adapter.readSettings();
    expect(view.primaryReasoningEffort).toBe('');
    expect(view.primaryContextTokens).toBeNull();
    expect(view.primaryOptionsStatus).toBe('not_configured');
    expect(fs.readFileSync(f.adapter.connectionFile).equals(before)).toBe(true);
  } finally { f.close(); }
});

test('saved preferences remain visible when a model disappears or its capabilities shrink', async () => {
  const f = fixture();
  try {
    write(f.adapter.connectionFile, { ...f.connection, modelOptions: {
      primary: { model: 'example/main', reasoningEffort: 'high', contextTokens: 100000 },
    } });
    for (const catalog of [[], [{ id: 'example/main', reasoning: false, context_window: 65536 }]]) {
      f.adapter.fetchImpl = async () => Response.json({ data: catalog });
      const view = await f.adapter.readSettings();
      expect(view.primaryReasoningEffort).toBe('high');
      expect(view.primaryContextTokens).toBe(100000);
      expect(view.primaryOptionsStatus).toBe('unavailable');
    }
  } finally { f.close(); }
});

test('malformed saved option scalars are safely displayed as unavailable defaults that can be explicitly reset', async () => {
  const f = fixture();
  try {
    for (const contextTokens of [-1, 0, 0.5, '8192', Number.MAX_SAFE_INTEGER + 1]) {
      write(f.adapter.connectionFile, { ...f.connection, modelOptions: {
        primary: { model: 'example/main', reasoningEffort: { privateValue: 'test-only-private-marker' }, contextTokens },
      } });
      const view = await f.adapter.readSettings();
      expect(view.primaryReasoningEffort).toBe('');
      expect(view.primaryContextTokens).toBeNull();
      expect(view.primaryOptionsStatus).toBe('unavailable');
      expect(JSON.stringify(view)).not.toContain('test-only-private-marker');
    }
    await f.adapter.saveSettings({ primaryReasoningEffort: '', primaryContextTokens: null });
    expect(read(f.adapter.connectionFile).modelOptions.primary).toEqual({ model: 'example/main', reasoningEffort: '', contextTokens: null });
  } finally { f.close(); }
});

test('the official primary change happens first and options merge into the newest host document', async () => {
  const f = fixture();
  const calls = [];
  f.adapter.setPrimaryModel = async model => {
    calls.push(model);
    write(f.adapter.connectionFile, { ...read(f.adapter.connectionFile), model, hostRevision: 19 });
  };
  try {
    const view = await f.adapter.saveSettings({ primaryModel: 'example/other', primaryReasoningEffort: '',
      secondaryReasoningEffort: 'high' });
    expect(calls).toEqual(['example/other']);
    const saved = read(f.adapter.connectionFile);
    expect(saved.hostRevision).toBe(19);
    expect(saved.modelOptions.primary).toEqual({ model: 'example/other', reasoningEffort: '', contextTokens: null });
    expect(saved.modelOptions.secondary.reasoningEffort).toBe('high');
    expect(view.primaryModel).toBe('example/other');
  } finally { f.close(); }
});

test('concurrent primary replacement during catalog validation never retargets a role option', async () => {
  const f = fixture();
  f.adapter.fetchImpl = async () => {
    write(f.adapter.connectionFile, { ...read(f.adapter.connectionFile), model: 'example/other' });
    return Response.json({ data: f.catalog });
  };
  try {
    await expect(f.adapter.saveSettings({ primaryReasoningEffort: 'high' }))
      .rejects.toHaveProperty('code', 'connection_changed');
    expect(read(f.adapter.connectionFile)).not.toHaveProperty('modelOptions');
  } finally { f.close(); }
});

test('concurrent role selection changes are caught before the official primary selector runs', async () => {
  const f = fixture();
  let calls = 0;
  f.adapter.setPrimaryModel = async model => {
    calls++;
    write(f.adapter.connectionFile, { ...read(f.adapter.connectionFile), model });
  };
  f.adapter.fetchImpl = async () => {
    write(f.adapter.connectionFile, { ...read(f.adapter.connectionFile), model: 'example/unknown' });
    return Response.json({ data: f.catalog });
  };
  try {
    await expect(f.adapter.saveSettings({ primaryModel: 'example/other', primaryReasoningEffort: '' }))
      .rejects.toHaveProperty('code', 'connection_changed');
    expect(calls).toBe(0);
    expect(read(f.adapter.connectionFile).model).toBe('example/unknown');
  } finally { f.close(); }
});

test('a concurrent secondary replacement during the primary CLI is preserved and reports partial save', async () => {
  const f = fixture();
  f.adapter.setPrimaryModel = async model => write(f.adapter.connectionFile, {
    ...read(f.adapter.connectionFile), model, secondaryModel: 'example/other',
  });
  try {
    await expect(f.adapter.saveSettings({ primaryModel: 'example/other', secondaryReasoningEffort: 'high' }))
      .rejects.toHaveProperty('code', 'settings_partially_saved');
    const saved = read(f.adapter.connectionFile);
    expect(saved.model).toBe('example/other');
    expect(saved.secondaryModel).toBe('example/other');
    expect(saved).not.toHaveProperty('modelOptions');
  } finally { f.close(); }
});

test('a partial option patch keeps a concurrent update to the other option field', async () => {
  const f = fixture();
  let updated = false;
  write(f.adapter.connectionFile, { ...f.connection, modelOptions: {
    primary: { model: 'example/main', reasoningEffort: 'high', contextTokens: null },
  } });
  f.adapter.fetchImpl = async () => {
    if (!updated) {
      updated = true;
      const fresh = read(f.adapter.connectionFile);
      fresh.modelOptions.primary.reasoningEffort = 'low';
      write(f.adapter.connectionFile, fresh);
    }
    return Response.json({ data: f.catalog });
  };
  try {
    await f.adapter.saveSettings({ primaryContextTokens: null });
    expect(read(f.adapter.connectionFile).modelOptions.primary.reasoningEffort).toBe('low');
  } finally { f.close(); }
});

test('clearing the secondary also clears its stored parameter binding without touching primary preferences', async () => {
  const f = fixture();
  try {
    const primary = { model: 'example/main', reasoningEffort: 'high', contextTokens: null };
    write(f.adapter.connectionFile, { ...f.connection, modelOptions: {
      primary, secondary: { model: 'example/main', reasoningEffort: 'low', contextTokens: null },
    } });
    await f.adapter.saveSettings({ secondaryModel: '' });
    const saved = read(f.adapter.connectionFile);
    expect(saved.modelOptions).toEqual({ primary });
    expect(saved.secondaryModel).toBe('');
  } finally { f.close(); }
});

test('disconnected settings cannot activate new inference options', async () => {
  const f = fixture();
  try {
    write(f.adapter.connectionFile, { ...f.connection, enabled: false });
    await expect(f.adapter.saveSettings({ primaryReasoningEffort: 'high' }))
      .rejects.toHaveProperty('code', 'connect_kimi_first');
    expect(read(f.adapter.connectionFile)).not.toHaveProperty('modelOptions');
  } finally { f.close(); }
});

test('a pending secondary model never reports its new parameters applied to the old active role', async () => {
  const f = fixture();
  try {
    write(f.adapter.connectionFile, { ...f.connection, secondaryModel: 'example/other', modelOptions: {
      secondary: { model: 'example/other', reasoningEffort: '', contextTokens: null },
    } });
    Object.assign(f.adapter, { live: { model: 'example/main', gatewayURL: f.connection.gateway.url,
      gatewayKey: f.connection.gateway.key }, state: { active: true },
      rolesReady: true, roleOptionsEnabled: true, bridgeSecondaryModel: 'example/main' });
    const view = await f.adapter.readSettings();
    expect(view.appliedSecondaryModel).toBe('example/main');
    expect(view.secondaryOptionsStatus).toBe('pending');
  } finally { f.close(); }
});

test('same model IDs on a pending gateway or key never report their options applied to the old connection', async () => {
  const f = fixture();
  try {
    write(f.adapter.connectionFile, { ...f.connection, modelOptions: {
      primary: { model: 'example/main', reasoningEffort: 'high', contextTokens: null },
    } });
    for (const live of [
      { model: 'example/main', gatewayURL: 'http://127.0.0.1:23456/v1', gatewayKey: f.connection.gateway.key },
      { model: 'example/main', gatewayURL: f.connection.gateway.url, gatewayKey: 'test-only-old-connection' },
    ]) {
      Object.assign(f.adapter, { live, state: { active: true } });
      expect((await f.adapter.readSettings()).primaryOptionsStatus).toBe('pending');
    }
  } finally { f.close(); }
});

test('option application status requires an active primary and confirmed matching secondary role', async () => {
  const f = fixture();
  try {
    write(f.adapter.connectionFile, { ...f.connection, modelOptions: {
      primary: { model: 'example/main', reasoningEffort: 'high', contextTokens: null },
      secondary: { model: 'example/main', reasoningEffort: 'low', contextTokens: null },
    } });
    const live = { model: 'example/main', gatewayURL: f.connection.gateway.url, gatewayKey: f.connection.gateway.key };
    Object.assign(f.adapter, { live, state: { active: true }, rolesReady: true, roleOptionsEnabled: true,
      bridgeSecondaryModel: 'example/main' });
    let view = await f.adapter.readSettings();
    expect(view.primaryOptionsStatus).toBe('applied');
    expect(view.secondaryOptionsStatus).toBe('applied');
    f.adapter.state.active = false;
    expect((await f.adapter.readSettings()).primaryOptionsStatus).toBe('pending');
    f.adapter.state.active = true;
    f.adapter.live.model = 'example/other';
    expect((await f.adapter.readSettings()).primaryOptionsStatus).toBe('pending');
    f.adapter.live.model = 'example/main';
    for (const gate of ['rolesReady', 'roleOptionsEnabled']) {
      f.adapter[gate] = false;
      view = await f.adapter.readSettings();
      expect(view.primaryOptionsStatus).toBe('applied');
      expect(view.secondaryOptionsStatus).toBe('pending');
      f.adapter[gate] = true;
    }
  } finally { f.close(); }
});

async function apiFixture(transform = value => value, saveOverride) {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const patches = [];
  const view = { enabled: true, primaryModel: 'example/main', secondaryModel: 'example/main', status: 'connected',
    primaryReasoningEffort: 'high', secondaryReasoningEffort: 'low', primaryContextTokens: null, secondaryContextTokens: null,
    primaryOptionsStatus: 'pending', secondaryOptionsStatus: 'pending',
    models: [{ id: 'example/main', name: 'Main', reasoningEfforts: ['low', 'high'], contextWindow: 131072,
      secret: 'must-not-leave' }], gateway: { key: 'must-not-leave' } };
  const server = await startSettingsServer({ port, readSettings: () => transform(view), saveSettings: patch => {
    if (saveOverride) return saveOverride(patch, view);
    patches.push(patch); return { ...view, ...patch };
  } });
  const url = `http://127.0.0.1:${port}`;
  const html = await (await fetch(url)).text();
  const token = /name="magpie-kimi-settings-token" content="([a-f0-9]+)"/.exec(html)[1];
  const headers = { [TOKEN_HEADER]: token, 'content-type': 'application/json' };
  return { server, url, headers, patches };
}

test('existing settings endpoint accepts the four option fields and projects capabilities without private fields', async () => {
  const f = await apiFixture();
  try {
    const patch = { primaryReasoningEffort: 'high', secondaryReasoningEffort: 'low',
      primaryContextTokens: 65536, secondaryContextTokens: null };
    const response = await fetch(f.url + '/api/settings', { method: 'POST', headers: f.headers, body: JSON.stringify(patch) });
    expect(response.status).toBe(200);
    expect(f.patches).toEqual([patch]);
    const view = await response.json();
    expect(view.primaryReasoningEffort).toBe('high');
    expect(view.secondaryReasoningEffort).toBe('low');
    expect(view.primaryContextTokens).toBe(65536);
    expect(view.secondaryContextTokens).toBeNull();
    expect(view.models[0]).toEqual({ id: 'example/main', name: 'Main', reasoningEfforts: ['low', 'high'], contextWindow: 131072 });
    expect(JSON.stringify(view)).not.toContain('must-not-leave');
    expect(view.primaryOptionsStatus).toBe('pending');
    expect(view.secondaryOptionsStatus).toBe('pending');
  } finally { await f.server.stop(); }
});

test('each fixed option status is projected and each fixed save failure preserves its HTTP contract', async () => {
  let status = 'not_configured', failure = 'invalid_model_options';
  const f = await apiFixture(view => ({ ...view, primaryOptionsStatus: status }), () => {
    throw Object.assign(Error('test-only-private-error'), { code: failure });
  });
  try {
    for (status of ['not_configured', 'pending', 'applied', 'context_unavailable', 'unavailable']) {
      const response = await fetch(f.url + '/api/settings', { headers: f.headers });
      expect(response.status).toBe(200);
      expect((await response.json()).primaryOptionsStatus).toBe(status);
    }
    for (const [code, http] of [['invalid_model_options', 400], ['unsupported_reasoning_effort', 400],
      ['unsupported_context_length', 400], ['context_control_unavailable', 503]]) {
      failure = code;
      const response = await fetch(f.url + '/api/settings', { method: 'POST', headers: f.headers,
        body: JSON.stringify({ primaryReasoningEffort: '' }) });
      expect(response.status).toBe(http);
      expect(await response.json()).toEqual({ error: code });
    }
  } finally { await f.server.stop(); }
});

test('the settings projection treats malformed or future capability values as unknown without leaking metadata', async () => {
  const f = await apiFixture(view => ({ ...view, primaryOptionsStatus: 'constructor',
    primaryReasoningEffort: { credential: 'synthetic-private-value' }, primaryContextTokens: -1,
    models: [{ ...view.models[0], reasoningEfforts: ['high', { credential: 'synthetic-private-value' }, 'future'],
      contextWindow: '8192' }] }));
  try {
    const response = await fetch(f.url + '/api/settings', { headers: f.headers });
    expect(response.status).toBe(200);
    const view = await response.json();
    expect(view.models[0].reasoningEfforts).toEqual(['high']);
    expect(view.models[0].contextWindow).toBeNull();
    for (const key of ['primaryOptionsStatus', 'primaryReasoningEffort', 'primaryContextTokens']) expect(view).not.toHaveProperty(key);
    expect(JSON.stringify(view)).not.toContain('synthetic-private-value');
  } finally { await f.server.stop(); }
});

test('the options API rejects wrong primitive types, nonintegers, writable statuses and unknown fields', async () => {
  const f = await apiFixture();
  try {
    for (const patch of [
      { primaryReasoningEffort: null }, { secondaryReasoningEffort: {} },
      { primaryContextTokens: '64000' }, { secondaryContextTokens: -1 }, { primaryContextTokens: 0.5 },
      { primaryContextTokens: Number.MAX_SAFE_INTEGER + 1 }, { primaryOptionsStatus: 'applied' },
      { primaryReasoningEffort: 'high', gateway: { key: 'injected' } },
    ]) {
      const response = await fetch(f.url + '/api/settings', { method: 'POST', headers: f.headers, body: JSON.stringify(patch) });
      expect(response.status).toBe(400);
      await response.text();
    }
    expect(f.patches).toHaveLength(0);
    expect((await fetch(f.url + '/api/anything')).status).toBe(404);
  } finally { await f.server.stop(); }
});
