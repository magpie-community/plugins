// Review fixtures for the lifecycle contract of the optional secondary model.
// Everything here is synthetic: a temporary Kimi directory, a loopback HTTP
// gateway, a temporary state directory and the public native plugin peer.
// No desktop profile, real credential, real app or real home directory is used.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { KimiAdapter } from './adapter.mjs';
import { AgentModelRouter } from './agent-routing.mjs';
import { normalizeModels } from './catalog.mjs';
import { nativeRolePluginPeer } from './test-fixtures/control-peer.mjs';

const official = 'https://agent-gw.kimi.com/coding/v1';
const primaryID = 'synthetic/main';
const secondaryID = 'synthetic/secondary';
const thirdID = 'synthetic/third';
const canary = 'synthetic-credential-not-for-state';
const catalogPayload = { data: [primaryID, secondaryID, thirdID].map(id => ({ id,
  context_window: 131072, reasoning: true, supported_reasoning_levels: [{ effort: 'max' }] })) };
const aliasOf = id => normalizeModels(catalogPayload).find(row => row.id === id).alias;

const agentTool = { type: 'function', function: { name: 'Agent', description: 'Create a new task.',
  parameters: { type: 'object', properties: {
    prompt: { type: 'string' }, description: { type: 'string' },
  }, required: ['prompt', 'description'] } } };

// One native Agent call stream, repeated verbatim so a pass-through can be
// compared byte for byte with the synthetic supplier response.
const upstreamFragments = [
  { choices: [{ index: 0, delta: { tool_calls: [{
    index: 0, id: 'call_plain', type: 'function',
    function: { name: 'Agent', arguments: JSON.stringify({ prompt: 'synthetic prompt', description: 'synthetic description' }) },
  } ] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
];
const upstreamSSE = upstreamFragments.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('')
  + 'data: [DONE]\n\n';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
const writeText = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o600 });
};

async function fixture({ secondaryModel, legacyModel = null, seedOwnedLegacy = false, regenerate = null } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-lifecycle-'));
  const kimiDir = path.join(directory, 'kimi');
  const stateDir = path.join(directory, 'state');
  const legacyFile = path.join(kimiDir, 'runtime/kimi-code/config.toml');
  const convertedFile = path.join(kimiDir, 'runtime/kimi-code/home/config.toml');
  const plugins = nativeRolePluginPeer(path.dirname(convertedFile));
  const calls = [], requests = [];
  let gatewayCatalog = catalogPayload;
  const nativeModels = ['native', 'native-alt'];
  const runtimeModels = nativeModels.map(model => ({ model, maxContextSize: 131072, capabilities: [] }));
  let controller;

  // Loopback supplier stand-in. /models is the Magpie catalog; the chat route
  // returns one Agent tool call so response translation is observable.
  const gateway = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(gatewayCatalog));
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, body: JSON.parse(body) });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(upstreamSSE);
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));

  const rpcCall = async (_runner, method, params) => {
    const call = { method, params };
    calls.push(call);
    if (plugins.handles(method)) return plugins.call(method, params);
    switch (method) {
      case 'models.current': return { current: read(controller.configFile).model.current };
      case 'conversations.getKimiModelList': return { models: runtimeModels };
      case 'conversations.setModel': {
        const doc = read(controller.configFile);
        doc.model.current = params.modelAlias;
        write(controller.configFile, doc);
        regenerateAfterControl();
        return { current: params.modelAlias };
      }
      case 'conversations.updateKimiModelList': {
        runtimeModels.splice(0, runtimeModels.length, ...params.models);
        const doc = read(controller.configFile);
        doc.model.models = Object.fromEntries(params.models.map(row => [row.model,
          { model: row.model, provider: 'daimon-kimi-code' }]));
        write(controller.configFile, doc);
        regenerateAfterControl();
        return { ok: true };
      }
      case 'kimiPlugin.reloadActiveSessions':
        call.runtime = controller.secondaryReloadRuntime;
        return { sessions: [] };
      case 'kimiPlugin.ReloadSession':
        call.runtime = controller.secondaryReloadRuntime;
        return { status: 'reloaded' };
      default: throw Error('unexpected synthetic control call');
    }
  };
  const fetchImpl = async (url, options) => {
    if (String(url).startsWith('https://agent-gw.kimi.com/')) {
      return new Response('{"result":"synthetic official response"}', { headers: { 'Content-Type': 'application/json' } });
    }
    return fetch(url, options);
  };
  const make = () => new KimiAdapter({ home: directory, stateDir, kimiDir,
    stabilityMs: 0, intervalMs: 1000000, rpcCall, fetchImpl });
  controller = make();

  const nativeDoc = () => ({
    default_model: 'native',
    providers: { 'daimon-kimi-code': { type: 'kimi', api_key: canary, base_url: official } },
    models: Object.fromEntries(nativeModels.map(model => [model, { provider: 'daimon-kimi-code', model,
      max_context_size: 131072, capabilities: ['tool_use'], api_key: canary }])),
  });
  const regenerateNative = () => {
    writeText(legacyFile, Bun.TOML.stringify(nativeDoc()));
    writeText(convertedFile, Bun.TOML.stringify(nativeDoc()));
  };

  // Model the native generator rewriting both runtime TOMLs from its own
  // fixed key set. 'drop' erases the foreign scalar; 'replace' writes a new
  // non-empty value that a foreign writer owns.
  const regenerateAfterControl = () => {
    if (regenerate === null) return;
    const doc = nativeDoc();
    if (regenerate === 'replace') doc.secondary_model = { model: 'native/other' };
    if (regenerate === 'replace-pool') doc.secondary_model = {
      models: { 'native-alt': 'New external pool' }, default_model: 'native-alt',
    };
    writeText(legacyFile, Bun.TOML.stringify(doc));
    writeText(convertedFile, Bun.TOML.stringify(doc));
  };

  write(controller.configFile, {
    credentials: { kimiCode: { apiKey: canary } },
    model: { current: 'native', providers: { 'daimon-kimi-code': { type: 'kimi', baseUrl: official } },
      models: Object.fromEntries(nativeModels.map(model => [model, { model, provider: 'daimon-kimi-code' }])) },
    unrelated: { preserve: 'synthetic' },
  });
  const runner = { lifecycleStatus: 'running', daemonGeneration: 'synthetic-generation-1',
    kernel: { agentKernel: 'kimi-code-v2' },
    activeKernelTurns: 0, activeKernelToolCalls: 0,
    control: { endpoint: { url: 'ws://127.0.0.1:3072/control', pid: 42, startedAt: 1 } } };
  write(controller.runnerFile, runner);
  regenerateNative();
  if (legacyModel !== null) {
    const doc = Bun.TOML.parse(fs.readFileSync(legacyFile, 'utf8'));
    doc.secondary_model = { model: legacyModel };
    writeText(legacyFile, Bun.TOML.stringify(doc));
  }
  controller.bootstrap();

  let ownedAlias = null;
  if (seedOwnedLegacy) {
    ownedAlias = aliasOf(secondaryID);
    const doc = Bun.TOML.parse(fs.readFileSync(legacyFile, 'utf8'));
    doc.secondary_model = { model: ownedAlias };
    writeText(legacyFile, Bun.TOML.stringify(doc));
    write(controller.stateFile, { active: false, secondary: {
      baseline: { model: 'native/first', enabled: null, hasSecondaryTable: true, hasExperimentalTable: false },
      alias: ownedAlias,
    }, secondaryModel: secondaryID });
  }

  const connection = { schemaVersion: 1, enabled: true, model: primaryID,
    gateway: { url: 'http://127.0.0.1:' + gateway.address().port + '/v1', key: 'synthetic-gateway' } };
  if (secondaryModel !== undefined) connection.secondaryModel = secondaryModel;
  write(controller.connectionFile, connection);

  // The real adapter reads three time gates; tests that immediately re-tick
  // clear them instead of waiting for wall-clock windows.
  const complete = () => {
    controller.retryAfter = 0;
    controller.catalogAfter = 0;
    controller.secondaryAfter = 0;
  };
  const setBusy = value => write(controller.runnerFile, { ...read(controller.runnerFile),
    activeKernelTurns: value ? 1 : 0, activeKernelToolCalls: 0 });
  const configure = patch => {
    const next = { ...read(controller.connectionFile), ...patch };
    write(controller.connectionFile, next);
    return next;
  };
  const pluginState = () => read(controller.stateFile).agentPlugin;
  const pluginEnabled = id => {
    try { return plugins.call('kimiPlugin.getPluginInfo', { id }).enabled; }
    catch (error) { if (error?.message === 'kimi_plugin_not_found') return false; throw error; }
  };
  const registryFile = path.join(path.dirname(convertedFile), 'plugins', 'installed.json');
  const managedDirectory = path.join(path.dirname(convertedFile), 'plugins', 'managed');
  const sourceDirectory = path.join(stateDir, 'native-model-roles');
  const roleManifest = id => ({ name: id, version: '1.0.0', description: 'Local Work model roles', agents: ['./agents'] });
  const seedRegistration = (id, { enabled = true, source = 'local-path', originalSource = sourceDirectory,
    root = path.join(managedDirectory, id), manifest = roleManifest(id) } = {}) => {
    writeText(path.join(root, 'kimi.plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
    const document = fs.existsSync(registryFile) ? read(registryFile) : { version: 1, plugins: [] };
    document.plugins = document.plugins.filter(entry => entry?.id !== id);
    document.plugins.push({ id, root, source, originalSource, enabled, origin: 'custom', installedAt: 'synthetic' });
    write(registryFile, document);
    return { id, root };
  };
  const registryBytes = () => fs.readFileSync(registryFile);
  const methodsSince = (index, method) => calls.slice(index).filter(call => call.method === method);
  const closeServer = async instance => {
    if (!instance.server) return;
    instance.server.closeAllConnections?.();
    await new Promise(resolve => instance.server.close(resolve));
    instance.server = null;
  };
  return {
    get controller() { return controller; },
    directory, kimiDir, stateDir, legacyFile, convertedFile, connection, runner,
    calls, requests, plugins, complete, setBusy, configure, pluginState, pluginEnabled, methodsSince,
    setCatalogIDs(ids) { gatewayCatalog = { data: catalogPayload.data.filter(row => ids.includes(row.id)) }; },
    registryFile, managedDirectory, sourceDirectory, roleManifest, seedRegistration, registryBytes,
    legacyText: () => fs.readFileSync(legacyFile, 'utf8'),
    async crash() {
      controller.stopping = true;
      controller.releaseLock();
      await closeServer(controller);
      controller = make();
      controller.bootstrap();
    },
    async cleanup() {
      await controller.stop();
      gateway.closeAllConnections?.();
      await new Promise(resolve => gateway.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function chat(f, payload) {
  const response = await fetch(f.controller.bridgeURL + '/chat/completions', { method: 'POST',
    headers: { Authorization: 'Bearer ' + canary, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload) });
  const text = await response.text();
  return { status: response.status, text };
}

// ---------------------------------------------------------------------------
// B1: no secondary configured means no companion plugin at all.
// ---------------------------------------------------------------------------

test('B1 no secondary: V2 connects without installing, enabling or reloading a role plugin', async () => {
  const f = await fixture();
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(f.calls.filter(call => call.method.startsWith('kimiPlugin.'))).toEqual([]);
    expect(read(f.controller.stateFile).agentPlugin).toBeUndefined();
    expect(f.controller.rolesReady).toBe(false);
  } finally { await f.cleanup(); }
});

const plainMessages = [{ role: 'system', content: 'synthetic native system prompt' },
  { role: 'user', content: 'synthetic request' }];
const plainRequest = () => ({ model: 'native', stream: true, messages: plainMessages, tools: [agentTool] });

test('B1 no secondary: ordinary Agent tools and schemas pass through unchanged', async () => {
  const f = await fixture();
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    const result = await chat(f, plainRequest());
    expect(result.status).toBe(200);
    const sent = f.requests.at(-1).body;
    expect(sent.model).toBe(primaryID);
    expect(sent.tools).toEqual([agentTool]);
    expect(sent.tools[0].function.parameters.properties.model).toBeUndefined();
    expect(sent.messages).toEqual(plainMessages);
  } finally { await f.cleanup(); }
});

test('B1 no secondary: supplier responses pass through unchanged', async () => {
  const f = await fixture();
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    const result = await chat(f, plainRequest());
    expect(result.status).toBe(200);
    expect(result.text).toBe(upstreamSSE);
  } finally { await f.cleanup(); }
});

test('B1 no secondary: a user disconnect reports disconnected without a plugin mutation', async () => {
  const f = await fixture();
  try {
    await f.controller.tick();
    const mark = f.calls.length;
    f.configure({ enabled: false });
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('disconnected');
    expect(f.methodsSince(mark, 'kimiPlugin.setPluginEnabled')).toEqual([]);
    expect(f.methodsSince(mark, 'kimiPlugin.installPlugin')).toEqual([]);
    expect(f.methodsSince(mark, 'kimiPlugin.updatePlugin')).toEqual([]);
  } finally { await f.cleanup(); }
});

test('B1 clearing the configured secondary disables the installed role plugin and stops translation', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick();
    const id = f.pluginState().id;
    expect(f.pluginEnabled(id)).toBe(true);
    const mark = f.calls.length;
    f.configure({ secondaryModel: '' });
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    const disables = f.methodsSince(mark, 'kimiPlugin.setPluginEnabled')
      .filter(call => call.params.enabled === false);
    expect(disables).toHaveLength(1);
    expect(disables[0].params.id).toBe(id);
    expect(f.pluginEnabled(id)).toBe(false);
    expect(f.controller.rolesReady).toBe(false);
  } finally { await f.cleanup(); }
});

// ---------------------------------------------------------------------------
// B2: the owned plugin is disabled while idle, re-enabled on opt-in reconnect,
// and a busy runtime defers the disable obligation.
// ---------------------------------------------------------------------------

test('B2 an idle disconnect tick disables the owned role plugin', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick();
    const id = f.pluginState().id;
    expect(f.pluginEnabled(id)).toBe(true);
    const mark = f.calls.length;
    f.configure({ enabled: false });
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('disconnected');
    const disables = f.methodsSince(mark, 'kimiPlugin.setPluginEnabled')
      .filter(call => call.params.enabled === false);
    expect(disables).toHaveLength(1);
    expect(f.pluginEnabled(id)).toBe(false);
  } finally { await f.cleanup(); }
});

test('B2 an idle stop disables the owned role plugin', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick();
    const id = f.pluginState().id;
    const mark = f.calls.length;
    await f.controller.stop();
    expect(f.controller.status.code).toBe('disconnected');
    const disables = f.methodsSince(mark, 'kimiPlugin.setPluginEnabled')
      .filter(call => call.params.enabled === false);
    expect(disables).toHaveLength(1);
    expect(f.pluginEnabled(id)).toBe(false);
  } finally { await f.cleanup(); }
});

test('B2 a reconnect after an idle opt-out re-enables the role plugin', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick();
    const id = f.pluginState().id;
    // The user turns the connection off and the idle tick retires the plugin.
    f.configure({ enabled: false });
    f.complete();
    await f.controller.tick();
    // The user opts back in; the same owned plugin has to be enabled again.
    f.configure({ enabled: true });
    const mark = f.calls.length;
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    const enables = f.methodsSince(mark, 'kimiPlugin.setPluginEnabled')
      .filter(call => call.params.enabled === true);
    expect(enables).toHaveLength(1);
    expect(enables[0].params.id).toBe(id);
    expect(f.pluginEnabled(id)).toBe(true);
    expect(f.controller.rolesReady).toBe(true);
  } finally { await f.cleanup(); }
});

test('B2 a busy runtime defers the disable obligation to a later idle tick', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick();
    const id = f.pluginState().id;
    f.setBusy(true);
    f.configure({ enabled: false });
    f.complete();
    await f.controller.tick();
    expect(f.calls.filter(call => call.method === 'kimiPlugin.setPluginEnabled'
      && call.params.enabled === false)).toEqual([]);
    expect(f.pluginEnabled(id)).toBe(true);
    // The obligation is durable across the busy turn, not just memory.
    expect(read(f.controller.stateFile).agentPlugin.phase).toBe('disabling');
    f.setBusy(false);
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('disconnected');
    const disables = f.methodsSince(0, 'kimiPlugin.setPluginEnabled')
      .filter(call => call.params.enabled === false);
    expect(disables).toHaveLength(1);
    expect(f.pluginEnabled(id)).toBe(false);
  } finally { await f.cleanup(); }
});

test('B2 a disconnected start disables an already-owned role plugin', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick();
    const id = f.pluginState().id;
    expect(f.pluginEnabled(id)).toBe(true);
    await f.crash();
    f.configure({ enabled: false });
    const mark = f.calls.length;
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('disconnected');
    const disables = f.methodsSince(mark, 'kimiPlugin.setPluginEnabled')
      .filter(call => call.params.enabled === false);
    expect(disables).toHaveLength(1);
    expect(f.pluginEnabled(id)).toBe(false);
  } finally { await f.cleanup(); }
});

// ---------------------------------------------------------------------------
// B3: a stable opt-in connection confirms health at most once per 30 seconds,
// performs no polling while busy, and tolerates one lost getPluginInfo reply.
// ---------------------------------------------------------------------------

test('B3 a stable opt-in connection polls getPluginInfo at most once per 30 seconds', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  const realNow = Date.now;
  let now = realNow.call(Date);
  Date.now = () => now;
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    const infos = () => f.calls.filter(call => call.method === 'kimiPlugin.getPluginInfo');
    expect(infos()).toHaveLength(1);
    for (let second = 0; second < 5; second++) {
      now += 1000;
      f.complete();
      await f.controller.tick();
      expect(f.controller.status.code).toBe('connected');
    }
    expect(infos()).toHaveLength(1);
  } finally {
    Date.now = realNow;
    await f.cleanup();
  }
});

test('B3 a busy runtime performs no getPluginInfo polling', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  const realNow = Date.now;
  let now = realNow.call(Date);
  Date.now = () => now;
  try {
    await f.controller.tick();
    const infos = () => f.calls.filter(call => call.method === 'kimiPlugin.getPluginInfo');
    expect(infos()).toHaveLength(1);
    f.setBusy(true);
    for (let second = 0; second < 3; second++) {
      now += 31000;
      f.complete();
      await f.controller.tick();
      expect(f.controller.status.code).toBe('connected');
    }
    expect(infos()).toHaveLength(1);
  } finally {
    Date.now = realNow;
    await f.cleanup();
  }
});

test('B3 one getPluginInfo transport failure keeps rolesReady and Agent schema translation', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  const realNow = Date.now;
  let now = realNow.call(Date);
  Date.now = () => now;
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    now += 31000;
    f.plugins.fail('kimiPlugin.getPluginInfo');
    f.complete();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(f.controller.rolesReady).toBe(true);
    const result = await chat(f, { model: 'native', stream: true,
      messages: [{ role: 'user', content: 'synthetic request' }], tools: [agentTool] });
    expect(result.status).toBe(200);
    const sent = f.requests.at(-1).body;
    expect(sent.tools[0].function.parameters.properties.model.enum)
      .toEqual(['primary', 'secondary', 'native']);
  } finally {
    Date.now = realNow;
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S2: an unowned legacy scalar is observation only. Only ownership persisted
// by an earlier adapter may restore and reload.
// ---------------------------------------------------------------------------

test('S2 an unowned legacy secondary scalar creates no ownership and no restore reload', async () => {
  const f = await fixture({ legacyModel: 'native/first' });
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(read(f.controller.stateFile).secondary).toBeUndefined();
    const restoreReloads = f.calls.filter(call => call.method === 'kimiPlugin.reloadActiveSessions'
      && call.runtime === 'v2-restore');
    expect(restoreReloads).toHaveLength(0);
    expect(f.calls.filter(call => call.method === 'kimiPlugin.ReloadSession'
      && call.runtime === 'v2-restore')).toHaveLength(0);
    expect(Bun.TOML.parse(f.legacyText()).secondary_model.model).toBe('native/first');
  } finally { await f.cleanup(); }
});

test('S2 guard: ownership saved by an earlier adapter still restores its baseline', async () => {
  const f = await fixture({ secondaryModel: secondaryID, seedOwnedLegacy: true });
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(Bun.TOML.parse(f.legacyText()).secondary_model.model).toBe('native/first');
    expect(read(f.controller.stateFile).secondary).toBeUndefined();
    expect(f.calls.some(call => call.method === 'kimiPlugin.reloadActiveSessions'
      && call.runtime === 'v2-restore')).toBe(true);
  } finally { await f.cleanup(); }
});

test('S2 an unowned foreign scalar is restored in memory across our own control rewrite', async () => {
  const f = await fixture({ secondaryModel: secondaryID, legacyModel: 'native/first', regenerate: 'drop' });
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(Bun.TOML.parse(f.legacyText()).secondary_model.model).toBe('native/first');
    expect(read(f.controller.stateFile).secondary).toBeUndefined();
    expect(f.calls.filter(call => call.method === 'kimiPlugin.reloadActiveSessions'
      && call.runtime === 'v2-restore')).toHaveLength(0);
    // A stable tick neither re-owns nor rewrites the preserved value.
    const commit = f.controller.commitNativeSecondary.bind(f.controller);
    let writes = 0;
    f.controller.commitNativeSecondary = (...args) => { writes += 1; return commit(...args); };
    f.complete();
    await f.controller.tick();
    expect(writes).toBe(0);
    expect(Bun.TOML.parse(f.legacyText()).secondary_model.model).toBe('native/first');
    expect(read(f.controller.stateFile).secondary).toBeUndefined();
  } finally { await f.cleanup(); }
});

test('S2 a non-empty foreign value written during our control call wins over the snapshot', async () => {
  const f = await fixture({ secondaryModel: secondaryID, legacyModel: 'native/first', regenerate: 'replace' });
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(Bun.TOML.parse(f.legacyText()).secondary_model.model).toBe('native/other');
    expect(read(f.controller.stateFile).secondary).toBeUndefined();
    expect(f.calls.filter(call => call.method === 'kimiPlugin.reloadActiveSessions'
      && call.runtime === 'v2-restore')).toHaveLength(0);
  } finally { await f.cleanup(); }
});

// ---------------------------------------------------------------------------
// B2 pre-flight: another role-plugin registration/key blocks install/enable.
// ---------------------------------------------------------------------------

test('B2 another owned role-plugin id blocks a new install before any write or RPC', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    const oldId = 'local-work-model-roles-aaaaaaaaaaaa';
    f.seedRegistration(oldId, { enabled: true });
    const beforeRegistry = f.registryBytes();
    const beforeCalls = f.calls.length;
    await f.controller.tick();
    expect(f.controller.status.code).toBe('agent_profile_conflict');
    expect(f.calls.slice(beforeCalls).filter(call => call.method.startsWith('kimiPlugin.'))).toEqual([]);
    expect(f.registryBytes()).toEqual(beforeRegistry);
    expect(fs.existsSync(f.sourceDirectory)).toBe(false);
    expect(read(f.registryFile).plugins.find(entry => entry.id === oldId).enabled).toBe(true);
  } finally { await f.cleanup(); }
});

test('B2 a foreign role-plugin registration blocks install without touching the registry', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    const foreignId = 'local-work-model-roles-bbbbbbbbbbbb';
    f.seedRegistration(foreignId, { enabled: true, originalSource: '/synthetic/other-source' });
    const beforeRegistry = f.registryBytes();
    const beforeCalls = f.calls.length;
    await f.controller.tick();
    expect(f.controller.status.code).toBe('agent_profile_conflict');
    expect(f.calls.slice(beforeCalls).filter(call => call.method.startsWith('kimiPlugin.'))).toEqual([]);
    expect(f.registryBytes()).toEqual(beforeRegistry);
    expect(fs.existsSync(f.sourceDirectory)).toBe(false);
  } finally { await f.cleanup(); }
});

// ---------------------------------------------------------------------------
// B2 synchronous exit: helper failure still owes the pending disable/reload.
// ---------------------------------------------------------------------------

test('B2 a helper failure on synchronous exit keeps the disable debt and restores the address', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    fs.mkdirSync(path.dirname(f.registryFile), { recursive: true });
    fs.writeFileSync(f.registryFile, 'not a registry [');
    const calls = f.calls.length;
    f.controller.restoreFileOnExit();
    expect(read(f.controller.configFile).model.providers['daimon-kimi-code'].baseUrl).toBe(official);
    expect(read(f.controller.configFile).model.current).toBe('native');
    expect(read(f.controller.stateFile).agentPlugin.phase).toBe('disabling');
    expect(f.calls).toHaveLength(calls);
    expect(fs.readFileSync(f.registryFile, 'utf8')).toBe('not a registry [');
  } finally { await f.cleanup(); }
});

test('B2 an already-false registration on synchronous exit does not clear the debt', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick();
    const id = f.pluginState().id;
    f.seedRegistration(id, { enabled: false });
    f.controller.state.agentPlugin = { ...f.controller.state.agentPlugin, phase: 'disabling' };
    f.controller.saveState();
    const beforeRegistry = f.registryBytes();
    f.controller.restoreFileOnExit();
    expect(read(f.controller.configFile).model.providers['daimon-kimi-code'].baseUrl).toBe(official);
    expect(read(f.controller.stateFile).agentPlugin.phase).toBe('disabling');
    expect(f.registryBytes()).toEqual(beforeRegistry);
  } finally { await f.cleanup(); }
});

// ---------------------------------------------------------------------------
// S2 stable ticks never repair a value erased concurrently outside our RPCs.
// ---------------------------------------------------------------------------

test('S2 a stable-tick external deletion is not repaired by the foreign snapshot', async () => {
  const f = await fixture({ secondaryModel: secondaryID, legacyModel: 'native/first' });
  const realNow = Date.now;
  let now = realNow.call(Date);
  Date.now = () => now;
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(Bun.TOML.parse(f.legacyText()).secondary_model.model).toBe('native/first');
    now += 31000; // let the non-primary health read run on the stable tick
    f.complete();
    const peerCall = f.plugins.call.bind(f.plugins);
    f.plugins.call = (method, params) => {
      if (method === 'kimiPlugin.getPluginInfo') {
        const doc = Bun.TOML.parse(fs.readFileSync(f.legacyFile, 'utf8'));
        delete doc.secondary_model;
        writeText(f.legacyFile, Bun.TOML.stringify(doc));
      }
      return peerCall(method, params);
    };
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    // The external delete happened outside our primary/menu RPC boundary.
    expect(Bun.TOML.parse(f.legacyText()).secondary_model).toBeUndefined();
    expect(read(f.controller.stateFile).secondary).toBeUndefined();
    expect(f.calls.filter(call => call.method === 'kimiPlugin.reloadActiveSessions'
      && call.runtime === 'v2-restore')).toHaveLength(0);
  } finally {
    Date.now = realNow;
    await f.cleanup();
  }
});

test('review guard: a bridge with rolesReady=false keeps native Agent tools and responses', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick();
    expect(f.controller.rolesReady).toBe(true);
    expect(f.controller.bridgeSecondaryModel).toBe(secondaryID);
    f.controller.rolesReady = false;
    const result = await chat(f, plainRequest());
    expect(result.status).toBe(200);
    expect(f.requests.at(-1).body.tools).toEqual([agentTool]);
    expect(f.requests.at(-1).body.messages).toEqual(plainMessages);
    expect(result.text).toBe(upstreamSSE);
  } finally { await f.cleanup(); }
});

for (const operation of ['install', 'update']) {
  test('review guard: a busy runner waits before role-plugin ' + operation + ' without plugin RPC', async () => {
    const f = await fixture({ secondaryModel: secondaryID });
    try {
      if (operation === 'update') await f.controller.tick();
      else {
        expect(f.controller.ownLock()).toBe(true);
        f.controller.catalog = normalizeModels(catalogPayload);
      }
      f.setBusy(true);
      const before = f.calls.length;
      const result = await f.controller.syncRolePlugin(read(f.controller.runnerFile),
        [primaryID, operation === 'update' ? thirdID : secondaryID]);
      expect(result).toEqual({ waiting: true });
      expect(f.calls.slice(before).filter(call => call.method.startsWith('kimiPlugin.'))).toEqual([]);
    } finally { f.setBusy(false); await f.cleanup(); }
  });
}

test('B1 a never-opted-in bridge does not create routing ownership on inference', async () => {
  const f = await fixture();
  try {
    await f.controller.tick();
    expect(read(f.controller.stateFile).agentRoutingSecret).toBeUndefined();
    const result = await chat(f, plainRequest());
    expect(result.status).toBe(200);
    expect(result.text).toBe(upstreamSSE);
    expect(read(f.controller.stateFile).agentRoutingSecret).toBeUndefined();
    expect(read(f.controller.stateFile).agentRoutingBindings).toBeUndefined();
  } finally { await f.cleanup(); }
});

test('B2 profile token bindings are durable before profile publication and plugin RPC', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  const link = fs.linkSync;
  const peer = f.plugins.call.bind(f.plugins);
  let publications = 0, installs = 0;
  const durable = token => {
    const bindings = read(f.controller.stateFile).agentRoutingBindings;
    expect(bindings && typeof bindings).toBe('object');
    expect(Object.values(bindings).sort()).toEqual([primaryID, secondaryID].sort());
    if (token) expect(bindings[token]).toBeDefined();
  };
  fs.linkSync = (staged, file) => {
    if (typeof file === 'string' && file.startsWith(path.join(f.sourceDirectory, 'agents') + path.sep)) {
      const token = /\[agent-profile-route:v1\]\n([^:\n]+):/.exec(fs.readFileSync(staged, 'utf8'))?.[1];
      expect(token).toBeDefined();
      durable(token);
      publications += 1;
    }
    return link(staged, file);
  };
  f.plugins.call = (method, params) => {
    if (method === 'kimiPlugin.installPlugin') { durable(); installs += 1; }
    return peer(method, params);
  };
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(publications).toBe(2);
    expect(installs).toBe(1);
    const state = read(f.controller.stateFile);
    await f.crash();
    expect(f.controller.ownLock()).toBe(true);
    expect(f.controller.ensureAgentRouter().bindings).toEqual(state.agentRoutingBindings);
  } finally { fs.linkSync = link; await f.cleanup(); }
});

test('B2 an existing router refreshes durable bindings even when its key is unchanged', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick();
    const state = read(f.controller.stateFile);
    const extended = new AgentModelRouter({ secret: state.agentRoutingSecret, bindings: state.agentRoutingBindings });
    extended.registerModels([thirdID], [primaryID, secondaryID, thirdID]);
    f.controller.state.agentRoutingBindings = extended.bindings;
    f.controller.saveState();
    expect(f.controller.ensureAgentRouter().bindings).toEqual(extended.bindings);
  } finally { await f.cleanup(); }
});

test('B2 current-catalog bindings survive role changes and removed targets are pruned on disk', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick();
    const router = f.controller.ensureAgentRouter();
    const oldProfile = path.join(f.sourceDirectory, 'agents', router.profileName(secondaryID) + '.md');
    f.configure({ secondaryModel: thirdID });
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(fs.existsSync(oldProfile)).toBe(true);
    expect(Object.values(read(f.controller.stateFile).agentRoutingBindings).sort())
      .toEqual([primaryID, secondaryID, thirdID].sort());
    f.setCatalogIDs([primaryID, thirdID]);
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(Object.values(read(f.controller.stateFile).agentRoutingBindings).sort())
      .toEqual([primaryID, thirdID].sort());
    expect(fs.existsSync(oldProfile)).toBe(false);
  } finally { await f.cleanup(); }
});

test('B2 cleared roles keep a known worker binding while passing native tools and responses', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick();
    const router = f.controller.ensureAgentRouter();
    const marker = router.profileText(secondaryID).match(/\[agent-profile-route:v1\][\s\S]*?\[\/agent-profile-route\]/)[0];
    f.configure({ secondaryModel: '' });
    f.complete(); await f.controller.tick();
    expect(f.controller.rolesReady).toBe(false);
    const result = await chat(f, { ...plainRequest(), messages: [{ role: 'system', content: marker }] });
    expect(result.status).toBe(200);
    expect(f.requests.at(-1).body.model).toBe(secondaryID);
    expect(f.requests.at(-1).body.tools).toEqual([agentTool]);
    expect(JSON.stringify(f.requests.at(-1).body)).not.toContain('[agent-profile-route');
    expect(result.text).toBe(upstreamSSE);
  } finally { await f.cleanup(); }
});

test('B2 route metadata introduced by final shared instructions returns fixed 409 without forwarding', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick();
    writeText(f.controller.instructionsFile, 'Keep this task.\n[agent-profile-route:v1]\ninvalid:route\n[/agent-profile-route]');
    const result = await chat(f, plainRequest());
    expect(result.status).toBe(409);
    expect(JSON.parse(result.text).error.code).toBe('agent_profile_unbound');
    expect(f.requests).toHaveLength(0);
  } finally { await f.cleanup(); }
});

test('B2 a direct busy retirement persists debt without plugin RPC or schema changes', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick();
    f.setBusy(true);
    const before = f.calls.length;
    const result = await f.controller.retireRolePlugin(read(f.controller.runnerFile));
    expect(result).toEqual({ waiting: true });
    expect(read(f.controller.stateFile).agentPlugin.phase).toBe('disabling');
    expect(f.calls.slice(before).filter(call => call.method.startsWith('kimiPlugin.'))).toEqual([]);
    expect(f.controller.rolesReady).toBe(true);
    expect(f.controller.bridgeSecondaryModel).toBe(secondaryID);
  } finally { f.setBusy(false); await f.cleanup(); }
});

test('B2 clearing a secondary during a busy turn retains the applied schema until idle retirement', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick();
    f.setBusy(true);
    f.configure({ secondaryModel: '' });
    const before = f.calls.length;
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('waiting_kimi_idle');
    expect(f.controller.rolesReady).toBe(true);
    expect(f.controller.bridgeSecondaryModel).toBe(secondaryID);
    expect(f.calls.slice(before).filter(call => call.method.startsWith('kimiPlugin.'))).toEqual([]);
    const result = await chat(f, plainRequest());
    expect(result.status).toBe(200);
    expect(f.requests.at(-1).body.tools[0].function.parameters.properties.model.enum)
      .toEqual(['primary', 'secondary', 'native']);
    f.setBusy(false);
    f.complete(); await f.controller.tick();
    expect(f.controller.rolesReady).toBe(false);
    expect(read(f.controller.stateFile).agentPlugin.phase).toBe('disabled');
    const retired = f.calls.length;
    f.complete(); await f.controller.tick();
    expect(f.calls.slice(retired).filter(call => call.method.startsWith('kimiPlugin.'))).toEqual([]);
  } finally { f.setBusy(false); await f.cleanup(); }
});

test('B2 a lost disable reload acknowledgement keeps debt until explicit retry acknowledgement', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick();
    const control = f.controller.rpcCall;
    let fail = true;
    f.controller.rpcCall = async (runner, method, params, options) => {
      if (method === 'kimiPlugin.reloadActiveSessions' && f.controller.secondaryReloadRuntime === 'role-disable' && fail) {
        fail = false;
        f.calls.push({ method, params, runtime: 'role-disable', failed: true });
        throw Error('kimi_control_timeout');
      }
      return control(runner, method, params, options);
    };
    f.configure({ enabled: false });
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_model_reload_failed');
    expect(read(f.controller.stateFile).agentPlugin.phase).toBe('disabling');
    const before = f.calls.length;
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('disconnected');
    expect(f.calls.slice(before).filter(call => call.method === 'kimiPlugin.setPluginEnabled'
      && call.params.enabled === false)).toHaveLength(1);
    expect(f.calls.slice(before).filter(call => call.method === 'kimiPlugin.reloadActiveSessions'
      && call.runtime === 'role-disable')).toHaveLength(1);
    expect(read(f.controller.stateFile).agentPlugin.phase).toBe('disabled');
  } finally { await f.cleanup(); }
});

test('B2 a disk-false pending retirement still sends disable and explicit reload before clearing debt', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick();
    const id = f.pluginState().id;
    f.seedRegistration(id, { enabled: false });
    f.controller.state.agentPlugin.phase = 'disabling';
    f.controller.saveState();
    const before = f.calls.length;
    f.configure({ enabled: false });
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('disconnected');
    expect(f.calls.slice(before).filter(call => call.method === 'kimiPlugin.setPluginEnabled'
      && call.params.enabled === false)).toHaveLength(1);
    expect(f.calls.slice(before).filter(call => call.method === 'kimiPlugin.reloadActiveSessions'
      && call.runtime === 'role-disable')).toHaveLength(1);
    expect(f.pluginEnabled(id)).toBe(false);
    expect(read(f.controller.stateFile).agentPlugin.phase).toBe('disabled');
  } finally { await f.cleanup(); }
});

test('B3 health confirmation waits the full 30-second minimum interval', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  const realNow = Date.now;
  let now = realNow.call(Date);
  Date.now = () => now;
  try {
    await f.controller.tick();
    const infos = () => f.calls.filter(call => call.method === 'kimiPlugin.getPluginInfo').length;
    expect(infos()).toBe(1);
    now += 29999;
    f.complete(); await f.controller.tick();
    expect(infos()).toBe(1);
    now += 1;
    f.complete(); await f.controller.tick();
    expect(infos()).toBe(2);
  } finally { Date.now = realNow; await f.cleanup(); }
});

for (const failure of ['kimi_control_timeout', 'kimi_control_unavailable', 'kimi_control_closed', 'kimi_control_rejected']) {
  test('B3 health keeps confirmed roles after an inconclusive ' + failure, async () => {
    const f = await fixture({ secondaryModel: secondaryID });
    const peer = f.plugins.call.bind(f.plugins);
    try {
      await f.controller.tick();
      f.plugins.call = (method, params) => {
        if (method === 'kimiPlugin.getPluginInfo') throw Error(failure);
        return peer(method, params);
      };
      f.controller.agentPluginNextCheck = 0;
      f.complete(); await f.controller.tick();
      expect(f.controller.status.code).toBe('connected');
      expect(f.controller.rolesReady).toBe(true);
      const result = await chat(f, plainRequest());
      expect(result.status).toBe(200);
      expect(f.requests.at(-1).body.tools[0].function.parameters.properties.model.enum)
        .toEqual(['primary', 'secondary', 'native']);
    } finally { f.plugins.call = peer; await f.cleanup(); }
  });
}

test('B3 an idle confirmed-disabled plugin stops role translation without re-enabling it', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick();
    f.plugins.setEnabled(f.pluginState().id, false);
    f.controller.agentPluginNextCheck = 0;
    const before = f.calls.length;
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_model_unavailable');
    expect(f.controller.rolesReady).toBe(false);
    expect(f.calls.slice(before).filter(call => call.method === 'kimiPlugin.setPluginEnabled')).toEqual([]);
    const result = await chat(f, plainRequest());
    expect(result.status).toBe(200);
    expect(f.requests.at(-1).body.tools).toEqual([agentTool]);
  } finally { await f.cleanup(); }
});

test('S2 an unowned foreign pool survives only our own control rewrites without ownership or reload', async () => {
  const f = await fixture({ secondaryModel: secondaryID, regenerate: 'drop' });
  const pool = { models: { native: 'External native pool' }, default_model: 'native' };
  try {
    const doc = Bun.TOML.parse(fs.readFileSync(f.convertedFile, 'utf8'));
    doc.secondary_model = pool;
    writeText(f.convertedFile, Bun.TOML.stringify(doc));
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(Bun.TOML.parse(fs.readFileSync(f.convertedFile, 'utf8')).secondary_model).toEqual(pool);
    expect(read(f.controller.stateFile).secondaryPool).toBeUndefined();
    expect(f.calls.filter(call => call.method === 'kimiPlugin.reloadActiveSessions'
      && call.runtime === 'v2-restore')).toHaveLength(0);
  } finally { await f.cleanup(); }
});

test('S2 a non-empty foreign pool written during our control call wins over the snapshot', async () => {
  const f = await fixture({ secondaryModel: secondaryID, regenerate: 'replace-pool' });
  try {
    const doc = Bun.TOML.parse(fs.readFileSync(f.convertedFile, 'utf8'));
    doc.secondary_model = { models: { native: 'External native pool' }, default_model: 'native' };
    writeText(f.convertedFile, Bun.TOML.stringify(doc));
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(Bun.TOML.parse(fs.readFileSync(f.convertedFile, 'utf8')).secondary_model)
      .toEqual({ models: { 'native-alt': 'New external pool' }, default_model: 'native-alt' });
    expect(read(f.controller.stateFile).secondaryPool).toBeUndefined();
  } finally { await f.cleanup(); }
});

test('B2 retry after a failed binding save publishes profiles only after durable recovery', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  const link = fs.linkSync;
  try {
    const save = f.controller.saveState.bind(f.controller);
    let failed = false;
    f.controller.saveState = () => {
      if (!failed && Object.keys(f.controller.state?.agentRoutingBindings || {}).length) {
        failed = true;
        throw Error('synthetic state-save failure');
      }
      return save();
    };
    await f.controller.tick();
    expect(failed).toBe(true);
    expect(read(f.controller.stateFile).agentRoutingBindings).toBeUndefined();
    const durable = [];
    fs.linkSync = (staged, file) => {
      if (typeof file === 'string' && file.startsWith(path.join(f.sourceDirectory, 'agents') + path.sep)) {
        const token = /^([A-Za-z0-9_-]{43}):[a-f0-9]{64}$/m.exec(fs.readFileSync(staged, 'utf8'))?.[1];
        durable.push(Boolean(token && Object.hasOwn(read(f.controller.stateFile).agentRoutingBindings || {}, token)));
      }
      return link(staged, file);
    };
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(durable.length).toBeGreaterThan(0);
    expect(durable.every(Boolean)).toBe(true);
  } finally { fs.linkSync = link; await f.cleanup(); }
});

test('B2 consecutive binding-save failures publish nothing and a restart recovers without profile conflict', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    const save = f.controller.saveState.bind(f.controller);
    let failures = 0;
    f.controller.saveState = () => {
      if (failures < 2 && Object.keys(f.controller.state?.agentRoutingBindings || {}).length) {
        failures += 1;
        throw Error('synthetic state-save failure');
      }
      return save();
    };
    await f.controller.tick();
    f.complete(); await f.controller.tick();
    expect(failures).toBe(2);
    expect(read(f.controller.stateFile).agentRoutingBindings).toBeUndefined();
    expect(fs.existsSync(path.join(f.sourceDirectory, 'agents'))).toBe(false);
    await f.crash();
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(Object.values(read(f.controller.stateFile).agentRoutingBindings).sort())
      .toEqual([primaryID, secondaryID].sort());
  } finally { await f.cleanup(); }
});

test('B2 a confirmed external uninstall completes idle disconnect with reload and no missing-id setter loop', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick();
    const id = f.pluginState().id;
    f.plugins.call('kimiPlugin.removePlugin', { id }); // Native removal retains the managed cache.
    f.configure({ enabled: false });
    const before = f.calls.length;
    for (let turn = 0; turn < 3; turn++) { f.complete(); await f.controller.tick(); }
    expect(f.controller.status.code).toBe('disconnected');
    expect(f.pluginState().phase).toBe('disabled');
    expect(f.calls.slice(before).filter(call => call.method === 'kimiPlugin.setPluginEnabled')).toEqual([]);
    expect(f.calls.slice(before).filter(call => call.method === 'kimiPlugin.reloadActiveSessions'
      && call.runtime === 'role-disable')).toHaveLength(1);
  } finally { await f.cleanup(); }
});

for (const target of ['scalar', 'pool']) {
  test('S2 a real foreign ' + target + ' CAS race preserves competing bytes and reports conflict', async () => {
    const f = await fixture({ legacyModel: target === 'scalar' ? 'native/first' : null, regenerate: 'drop' });
    const file = target === 'scalar' ? f.legacyFile : f.convertedFile;
    const writeFile = fs.writeFileSync;
    try {
      if (target === 'pool') {
        const doc = Bun.TOML.parse(fs.readFileSync(file, 'utf8'));
        doc.secondary_model = { models: { native: 'External pool' }, default_model: 'native' };
        writeText(file, Bun.TOML.stringify(doc));
      }
      let raced = false;
      fs.writeFileSync = (staged, ...args) => {
        const result = writeFile(staged, ...args);
        if (!raced && typeof staged === 'string' && staged.startsWith(file + '.') && staged.endsWith('.tmp')) {
          raced = true;
          writeFile(file, fs.readFileSync(file, 'utf8') + '\n# synthetic concurrent writer\n');
        }
        return result;
      };
      await f.controller.tick();
      expect(raced).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).toContain('# synthetic concurrent writer');
      expect(f.controller.status.code).toBe('kimi_config_changed');
      f.complete(); await f.controller.tick();
      expect(f.controller.status.code).toBe('connected');
      expect(fs.readFileSync(file, 'utf8')).toContain('# synthetic concurrent writer');
    } finally { fs.writeFileSync = writeFile; await f.cleanup(); }
  });
}

for (const action of ['clear', 'disconnect', 'stop']) {
  test('B2 normal ' + action + ' removes only the verified registration after disable and reload', async () => {
    const f = await fixture({ secondaryModel: secondaryID });
    try {
      await f.controller.tick();
      const id = f.pluginState().id;
      const unrelated = { id: 'synthetic-unrelated', source: 'catalog', enabled: true, unknown: 'keep' };
      const registry = read(f.registryFile);
      registry.plugins.push(unrelated);
      write(f.registryFile, registry);
      const before = f.calls.length;
      if (action === 'stop') await f.controller.stop();
      else {
        f.configure(action === 'clear' ? { secondaryModel: '' } : { enabled: false });
        f.complete(); await f.controller.tick();
      }
      expect(f.calls.slice(before).filter(call => call.method.startsWith('kimiPlugin.'))
        .map(call => call.method)).toEqual([
        'kimiPlugin.setPluginEnabled', 'kimiPlugin.reloadActiveSessions', 'kimiPlugin.removePlugin',
      ]);
      expect(read(f.registryFile).plugins).toEqual([unrelated]);
      expect(fs.existsSync(f.plugins.installed(id))).toBe(true);
      expect(fs.existsSync(f.sourceDirectory)).toBe(true);
      expect(f.pluginState().phase).toBe('disabled');
    } finally { await f.cleanup(); }
  });
}

test('B2 reconnect reinstalls a removed registration even while its managed cache remains', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick();
    const id = f.pluginState().id;
    f.configure({ secondaryModel: '' });
    f.complete(); await f.controller.tick();
    expect(read(f.registryFile).plugins.some(row => row.id === id)).toBe(false);
    expect(fs.existsSync(f.plugins.installed(id))).toBe(true);
    const before = f.calls.length;
    f.configure({ secondaryModel: secondaryID });
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(f.calls.slice(before).filter(call => call.method === 'kimiPlugin.installPlugin')).toHaveLength(1);
    expect(f.calls.slice(before).filter(call => call.method === 'kimiPlugin.updatePlugin')).toHaveLength(0);
    expect(read(f.registryFile).plugins.find(row => row.id === id).enabled).toBe(true);
  } finally { await f.cleanup(); }
});

for (const after of [false, true]) {
  test('B2 a lost removal acknowledgement retains debt and recovers (' + (after ? 'after' : 'before') + ' effect)', async () => {
    const f = await fixture({ secondaryModel: secondaryID });
    const peer = f.plugins.call.bind(f.plugins);
    try {
      await f.controller.tick();
      let failed = false;
      f.plugins.call = (method, params) => {
        if (!failed && method === 'kimiPlugin.removePlugin') {
          failed = true;
          if (after) peer(method, params);
          throw Error('kimi_control_timeout');
        }
        return peer(method, params);
      };
      f.configure({ secondaryModel: '' });
      f.complete(); await f.controller.tick();
      expect(failed).toBe(true);
      expect(f.controller.status.code).toBe('secondary_model_reload_failed');
      expect(f.pluginState().phase).toBe('disabling');
      f.complete(); await f.controller.tick();
      expect(f.controller.status.code).toBe('connected');
      expect(f.pluginState().phase).toBe('disabled');
      expect(read(f.registryFile).plugins).toEqual([]);
    } finally { f.plugins.call = peer; await f.cleanup(); }
  });
}

test('B2 a changed registration is never disabled or removed by prefix ownership alone', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick();
    const id = f.pluginState().id;
    const registry = read(f.registryFile);
    registry.plugins.find(row => row.id === id).originalSource = '/synthetic/foreign-source';
    write(f.registryFile, registry);
    const bytes = f.registryBytes(), before = f.calls.length;
    f.configure({ secondaryModel: '' });
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('agent_profile_conflict');
    expect(f.calls.slice(before).filter(call => call.method.startsWith('kimiPlugin.'))).toEqual([]);
    expect(f.registryBytes()).toEqual(bytes);
    expect(f.pluginState().phase).toBe('disabling');
  } finally { await f.cleanup(); }
});

test('B2 deleting only the disk registration still disables and removes the loaded native plugin', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick();
    const id = f.pluginState().id;
    write(f.registryFile, { version: 1, plugins: [] });
    expect(f.pluginEnabled(id)).toBe(true); // No native registry watcher.
    const before = f.calls.length;
    f.configure({ enabled: false });
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('disconnected');
    expect(f.calls.slice(before).filter(call => call.method === 'kimiPlugin.setPluginEnabled'
      && call.params.enabled === false)).toHaveLength(1);
    expect(f.calls.slice(before).filter(call => call.method === 'kimiPlugin.removePlugin')).toHaveLength(1);
    expect(f.pluginEnabled(id)).toBe(false);
    expect(read(f.registryFile).plugins).toEqual([]);
  } finally { await f.cleanup(); }
});

for (const location of ['source', 'managed']) {
test('B2 missing disk registration with changed ' + location + ' bytes remains an ownership conflict', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick();
    const id = f.pluginState().id;
    write(f.registryFile, { version: 1, plugins: [] });
    fs.appendFileSync(path.join(location === 'source' ? f.sourceDirectory : f.plugins.installed(id), 'kimi.plugin.json'), '\n');
    const before = f.calls.length;
    f.configure({ enabled: false });
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('agent_profile_conflict');
    expect(f.calls.slice(before).filter(call => call.method === 'kimiPlugin.setPluginEnabled'
      || call.method === 'kimiPlugin.removePlugin')).toEqual([]);
    expect(f.pluginEnabled(id)).toBe(true);
    expect(f.pluginState().phase).toBe('disabling');
  } finally { await f.cleanup(); }
});
}

test('B3 only the fixed native missing category clears confirmed roles after a failed health read', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  const peer = f.plugins.call.bind(f.plugins);
  try {
    await f.controller.tick();
    f.plugins.call = (method, params) => {
      if (method === 'kimiPlugin.getPluginInfo') throw Error('kimi_plugin_not_found');
      return peer(method, params);
    };
    f.controller.agentPluginNextCheck = 0;
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('secondary_model_unavailable');
    expect(f.controller.rolesReady).toBe(false);
  } finally { f.plugins.call = peer; await f.cleanup(); }
});

for (const reply of ['rejected', 'null', 'wrong-id', 'bad-enabled']) {
  test('B2 an inconclusive unregistered native reply retains retirement debt (' + reply + ')', async () => {
    const f = await fixture({ secondaryModel: secondaryID });
    const peer = f.plugins.call.bind(f.plugins);
    try {
      await f.controller.tick();
      write(f.registryFile, { version: 1, plugins: [] });
      f.plugins.call = (method, params) => {
        if (method !== 'kimiPlugin.getPluginInfo') return peer(method, params);
        if (reply === 'rejected') throw Error('kimi_control_rejected');
        if (reply === 'null') return null;
        if (reply === 'wrong-id') return { id: 'synthetic-other', enabled: true };
        return { id: params.id };
      };
      const before = f.calls.length;
      f.configure({ enabled: false });
      f.complete(); await f.controller.tick();
      expect(f.controller.status.code).toBe('secondary_model_reload_failed');
      expect(f.pluginState().phase).toBe('disabling');
      expect(f.calls.slice(before).filter(call => call.method === 'kimiPlugin.setPluginEnabled'
        || call.method === 'kimiPlugin.removePlugin')).toEqual([]);
    } finally { f.plugins.call = peer; await f.cleanup(); }
  });
}

test('B2 a symlinked unregistered managed cache is not followed or claimed', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick();
    const managed = f.plugins.installed(f.pluginState().id);
    fs.renameSync(managed, managed + '-target');
    fs.symlinkSync(managed + '-target', managed, 'dir');
    write(f.registryFile, { version: 1, plugins: [] });
    const before = f.calls.length;
    f.configure({ enabled: false });
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('agent_profile_conflict');
    expect(f.calls.slice(before).filter(call => call.method === 'kimiPlugin.setPluginEnabled'
      || call.method === 'kimiPlugin.removePlugin')).toEqual([]);
  } finally { await f.cleanup(); }
});

test('B2 retirement waits for a skipped session reload before removing its registration', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick();
    const control = f.controller.rpcCall;
    let skipped = false;
    f.controller.rpcCall = async (runner, method, params, options) => {
      if (!skipped && method === 'kimiPlugin.reloadActiveSessions'
          && f.controller.secondaryReloadRuntime === 'role-disable') {
        skipped = true;
        f.calls.push({ method, params, runtime: 'role-disable' });
        return { sessions: [{ kernelSessionId: 'synthetic-busy-session', status: 'skipped-active-turn' }] };
      }
      return control(runner, method, params, options);
    };
    f.configure({ secondaryModel: '' });
    const before = f.calls.length;
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('waiting_kimi_idle');
    expect(f.pluginState().phase).toBe('disabling');
    expect(f.calls.slice(before).filter(call => call.method === 'kimiPlugin.removePlugin')).toEqual([]);
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    expect(f.pluginState().phase).toBe('disabled');
    expect(read(f.registryFile).plugins).toEqual([]);
  } finally { await f.cleanup(); }
});

test('B2 provenance is rechecked after reload before removing a registration changed by another writer', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  try {
    await f.controller.tick();
    const control = f.controller.rpcCall;
    let changed;
    f.controller.rpcCall = async (runner, method, params, options) => {
      const result = await control(runner, method, params, options);
      if (method === 'kimiPlugin.reloadActiveSessions' && f.controller.secondaryReloadRuntime === 'role-disable') {
        const registry = read(f.registryFile);
        registry.plugins[0].originalSource = '/synthetic/new-owner';
        write(f.registryFile, registry);
        changed = f.registryBytes();
      }
      return result;
    };
    const before = f.calls.length;
    f.configure({ secondaryModel: '' });
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('agent_profile_conflict');
    expect(f.pluginState().phase).toBe('disabling');
    expect(f.calls.slice(before).filter(call => call.method === 'kimiPlugin.removePlugin')).toEqual([]);
    expect(f.registryBytes()).toEqual(changed);
  } finally { await f.cleanup(); }
});

test('B2 a still-loaded plugin with no registration after toggle cannot silently clear retirement debt', async () => {
  const f = await fixture({ secondaryModel: secondaryID });
  const peer = f.plugins.call.bind(f.plugins);
  try {
    await f.controller.tick();
    write(f.registryFile, { version: 1, plugins: [] });
    f.plugins.call = (method, params) => method === 'kimiPlugin.setPluginEnabled' ? { ok: true } : peer(method, params);
    f.configure({ secondaryModel: '' });
    f.complete(); await f.controller.tick();
    expect(f.controller.status.code).toBe('agent_profile_conflict');
    expect(f.pluginState().phase).toBe('disabling');
    expect(f.pluginEnabled(f.pluginState().id)).toBe(true);
  } finally { f.plugins.call = peer; await f.cleanup(); }
});

for (const staleDisk of [false, true]) {
  test('B2 native removal racing the toggle keeps disk and native confirmation distinct (' + staleDisk + ')', async () => {
    const f = await fixture({ secondaryModel: secondaryID });
    try {
      await f.controller.tick();
      const control = f.controller.rpcCall;
      const beforeRegistry = f.registryBytes();
      let raced = false;
      f.controller.rpcCall = async (runner, method, params, options) => {
        if (!raced && method === 'kimiPlugin.setPluginEnabled' && params.enabled === false) {
          raced = true;
          f.plugins.call('kimiPlugin.removePlugin', { id: params.id });
          if (staleDisk) fs.writeFileSync(f.registryFile, beforeRegistry);
          throw Error('kimi_plugin_not_found');
        }
        return control(runner, method, params, options);
      };
      f.configure({ secondaryModel: '' });
      f.complete(); await f.controller.tick();
      expect(raced).toBe(true);
      expect(f.controller.status.code).toBe(staleDisk ? 'agent_profile_conflict' : 'connected');
      expect(f.pluginState().phase).toBe(staleDisk ? 'disabling' : 'disabled');
      expect(read(f.registryFile).plugins.length).toBe(staleDisk ? 1 : 0);
    } finally { await f.cleanup(); }
  });
}
