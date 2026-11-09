import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { KimiAdapter } from './adapter.mjs';

const primary = 'synthetic/model-a', secondary = 'synthetic/model-b', next = 'synthetic/model-c';
const gateway = { url: 'http://127.0.0.1:19000/v1', key: 'transition-only-key' };
const nativeKey = 'transition-native-key';
const official = 'https://agent-gw.kimi.com/coding/v1';
const selection = (model, reasoningEffort = '', contextTokens = null) => ({ model, reasoningEffort, contextTokens });
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const catalog = [primary, secondary, next].map(id => ({ id, menu: { displayName: id },
  options: { reasoningEfforts: ['low', 'high'], contextWindow: 8192 } }));

function fixture({ primaryOptions = selection(primary, 'low', 1024),
  secondaryOptions = selection(secondary, 'low', 1024), secondaryModel = secondary } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-role-transition-'));
  const calls = [];
  let inputTokens = 1500;
  const adapter = new KimiAdapter({ home, stateDir: path.join(home, 'state'), kimiDir: path.join(home, 'native'),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return String(url).endsWith('/messages/count_tokens') ? Response.json({ input_tokens: inputTokens })
        : Response.json({ choices: [] });
    },
  });
  const desired = { enabled: true, model: primary, secondaryModel, gateway: { ...gateway },
    modelOptions: { primary: { ...primaryOptions }, ...(secondaryModel ? { secondary: { ...secondaryOptions } } : {}) } };
  write(adapter.connectionFile, desired);
  write(adapter.configFile, { credentials: { kimiCode: { apiKey: nativeKey } },
    model: { current: 'synthetic-native', providers: { 'daimon-kimi-code': { baseUrl: official } },
      models: { 'synthetic-native': { model: 'synthetic-native', provider: 'daimon-kimi-code' } } } });
  write(adapter.runnerFile, { lifecycleStatus: 'running', daemonGeneration: 'synthetic-generation-1',
    kernel: { agentKernel: 'kimi-code-v2' }, activeKernelTurns: 0, activeKernelToolCalls: 0 });
  adapter.state = { active: true };
  adapter.live = { model: primary, gatewayURL: gateway.url, gatewayKey: gateway.key, originalBase: official,
    modelOptions: structuredClone(desired.modelOptions) };
  adapter.catalog = catalog;
  adapter.gatewayCatalog = async () => catalog;
  adapter.rolesReady = Boolean(secondaryModel);
  adapter.roleOptionsEnabled = Boolean(secondaryModel);
  adapter.bridgeSecondaryModel = secondaryModel;
  function router() {
    const result = adapter.ensureAgentRouter();
    result.registerModels([primary, secondary, next], [primary, secondary, next]);
    if (secondaryModel) result.registerRoles({ primaryModel: primary, secondaryModel }, [primary, secondary, next]);
    adapter.persistAgentBindings(result);
    return result;
  }
  async function send({ identity, prompt = 'Synthetic transition request.' } = {}) {
    const messages = [...(identity ? [{ role: 'system', content: identity }] : []), { role: 'user', content: prompt }];
    const request = Readable.from([Buffer.from(JSON.stringify({ model: 'ignored-native-choice', messages,
      reasoning_effort: 'high', thinking: { effort: 'high' }, reasoning: { effort: 'high' } }))]);
    Object.assign(request, { method: 'POST', url: '/v1/chat/completions', headers: { authorization: 'Bearer ' + nativeKey } });
    const chunks = [];
    const response = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    Object.assign(response, { headersSent: false, statusCode: 0,
      writeHead(status) { this.statusCode = status; this.headersSent = true; return this; }, flushHeaders() {},
    });
    await adapter.forward(request, response);
    return { status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  }
  return { home, adapter, desired, calls, router, send, setTokens: value => { inputTokens = value; },
    generated: () => calls.filter(call => call.url.endsWith('/chat/completions')),
    counted: () => calls.filter(call => call.url.endsWith('/messages/count_tokens')),
    close: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test('pending primary A to B keeps the old A input budget while a busy turn defers the connection', async () => {
  const f = fixture();
  try {
    write(f.adapter.connectionFile, { ...f.desired, model: next, modelOptions: {
      ...f.desired.modelOptions, primary: selection(next, 'high', 2048),
    } });
    const result = await f.send();
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('context_length_exceeded');
    expect(f.counted()).toHaveLength(1);
    expect(f.counted()[0].body.model).toBe(primary);
    expect(f.generated()).toHaveLength(0);
    expect(f.adapter.live.modelOptions.primary).toEqual(selection(primary, 'low', 1024));
  } finally { f.close(); }
});

for (const changed of ['url', 'key']) test(`a pending gateway ${changed} change never applies its new effort to the old active connection`, async () => {
  const f = fixture({ primaryOptions: selection(primary, 'low') });
  try {
    const replacement = changed === 'url' ? 'http://127.0.0.1:19001/v1' : 'transition-new-key';
    write(f.adapter.connectionFile, { ...f.desired, gateway: { ...gateway, [changed]: replacement },
      modelOptions: { ...f.desired.modelOptions, primary: selection(primary, 'high') } });
    expect((await f.send()).status).toBe(200);
    expect(f.generated()).toHaveLength(1);
    expect(f.generated()[0].url).toBe(gateway.url + '/chat/completions');
    expect(f.generated()[0].body.reasoning_effort).toBe('low');
    expect(f.adapter.live.modelOptions.primary).toEqual(selection(primary, 'low'));
  } finally { f.close(); }
});

test('an incomplete pending gateway URL keeps the active rule instead of dropping the working connection', async () => {
  const f = fixture({ primaryOptions: selection(primary, 'low') });
  try {
    write(f.adapter.connectionFile, { ...f.desired, gateway: { ...gateway, url: 'incomplete-url' },
      modelOptions: { ...f.desired.modelOptions, primary: selection(primary, 'high') } });
    expect((await f.send()).status).toBe(200);
    expect(f.generated()[0].body.reasoning_effort).toBe('low');
  } finally { f.close(); }
});

test('pending secondary B to C keeps scoped B rules while the native runner is busy', async () => {
  const f = fixture({ primaryOptions: selection(primary, 'high', 2048) });
  try {
    const r = f.router(), profile = r.profileText(secondary, 'secondary');
    write(f.adapter.connectionFile, { ...f.desired, secondaryModel: next, modelOptions: {
      ...f.desired.modelOptions, secondary: selection(next, 'high', 2048),
    } });
    expect(await f.adapter.reconcileSecondary({ activeKernelTurns: 1 }, next,
      { inheritModel: primary, roleOptionsEnabled: true })).toEqual({ waiting: true });
    expect((await f.send({ identity: profile })).status).toBe(400);
    expect(f.counted()[0].body.model).toBe(secondary);
    expect(f.generated()).toHaveLength(0);
    expect((await f.send()).status).toBe(200);
    expect(f.generated()[0].body.model).toBe(primary);
    expect(f.generated()[0].body.reasoning_effort).toBe('high');
  } finally { f.close(); }
});

test('a pending primary change also preserves the active secondary rule on that connection', async () => {
  const f = fixture();
  try {
    const r = f.router(), profile = r.profileText(secondary, 'secondary');
    write(f.adapter.connectionFile, { ...f.desired, model: next, modelOptions: {
      primary: selection(next, 'high', 2048), secondary: selection(secondary, 'high', 2048),
    } });
    expect((await f.send({ identity: profile })).status).toBe(400);
    expect(f.adapter.live.modelOptions.secondary).toEqual(selection(secondary, 'low', 1024));
  } finally { f.close(); }
});

test('a historical scoped profile for the next secondary target cannot take pending rules before confirmation', async () => {
  const f = fixture();
  try {
    const r = f.router(), profile = r.profileText(next, 'secondary');
    f.adapter.persistAgentBindings(r);
    write(f.adapter.connectionFile, { ...f.desired, secondaryModel: next, modelOptions: {
      ...f.desired.modelOptions, secondary: selection(next, 'high', 512),
    } });
    expect((await f.send({ identity: profile })).status).toBe(200);
    expect(f.generated()[0].body.model).toBe(next);
    expect(f.generated()[0].body).not.toHaveProperty('reasoning_effort');
    expect(f.counted()).toHaveLength(0);
    expect(f.adapter.live.modelOptions.secondary.model).toBe(secondary);
  } finally { f.close(); }
});

test('same-model authenticated legacy workers use defaults while parent and scoped workers keep separate rules', async () => {
  const f = fixture({ primaryOptions: selection(primary, 'high', 2048),
    secondaryOptions: selection(primary, 'low', 1024), secondaryModel: primary });
  try {
    const r = f.router(), legacy = r.profileText(primary);
    expect((await f.send({ identity: legacy })).status).toBe(200);
    const unscoped = f.generated()[0].body;
    expect(unscoped.model).toBe(primary);
    for (const field of ['reasoning_effort', 'thinking', 'reasoning']) expect(unscoped).not.toHaveProperty(field);
    expect(f.counted()).toHaveLength(0);
    expect((await f.send()).status).toBe(200);
    expect(f.generated()[1].body.reasoning_effort).toBe('high');
    expect((await f.send({ identity: r.profileText(primary, 'secondary') })).status).toBe(400);
    expect((await f.send({ identity: r.profileText(primary, 'primary') })).status).toBe(200);
    expect(f.generated()[2].body.reasoning_effort).toBe('high');
    expect(f.counted()).toHaveLength(3);
    expect(f.adapter.live.modelOptions).toEqual({ primary: selection(primary, 'high', 2048), secondary: selection(primary, 'low', 1024) });
  } finally { f.close(); }
});

for (const unconfirmed of ['rolesReady', 'roleOptionsEnabled']) test(`unconfirmed ${unconfirmed} keeps the last scoped secondary rules`, async () => {
  const f = fixture({ secondaryOptions: selection(primary, 'low', 1024), secondaryModel: primary });
  try {
    const r = f.router(), profile = r.profileText(primary, 'secondary');
    f.adapter[unconfirmed] = false;
    write(f.adapter.connectionFile, { ...f.desired, modelOptions: { ...f.desired.modelOptions,
      secondary: selection(primary, 'high', 2048) } });
    expect((await f.send({ identity: profile })).status).toBe(400);
    expect(f.generated()).toHaveLength(0);
    expect(f.adapter.live.modelOptions.secondary).toEqual(selection(primary, 'low', 1024));
  } finally { f.close(); }
});

test('a fresh applied rule updates the live snapshot before a later model change between ticks', async () => {
  const f = fixture();
  try {
    f.setTokens(400);
    write(f.adapter.connectionFile, { ...f.desired, modelOptions: { ...f.desired.modelOptions,
      primary: selection(primary, 'high', 512) } });
    expect((await f.send()).status).toBe(200);
    expect(f.generated()[0].body.reasoning_effort).toBe('high');
    expect(f.adapter.live).toHaveProperty('modelOptions.primary', selection(primary, 'high', 512));
    write(f.adapter.connectionFile, { ...f.desired, model: next, modelOptions: { ...f.desired.modelOptions,
      primary: selection(next, 'low', 2048) } });
    f.setTokens(700);
    expect((await f.send()).status).toBe(400);
    expect(f.generated()).toHaveLength(1);
  } finally { f.close(); }
});

test('clearing stored preferences clears active rules and their snapshot without restoring old limits later', async () => {
  const f = fixture({ primaryOptions: selection(primary, 'high', 512), secondaryModel: primary,
    secondaryOptions: selection(primary, 'low', 512) });
  try {
    const r = f.router();
    const cleared = { ...f.desired }; delete cleared.modelOptions;
    write(f.adapter.connectionFile, cleared);
    for (const identity of [undefined, r.profileText(primary, 'secondary')]) {
      expect((await f.send({ identity })).status).toBe(200);
      expect(f.generated().at(-1).body).not.toHaveProperty('reasoning_effort');
    }
    expect(f.counted()).toHaveLength(0);
    expect(f.adapter.live.modelOptions).toEqual({ primary: selection(primary), secondary: selection(primary) });
    write(f.adapter.connectionFile, { ...cleared, model: next });
    expect((await f.send()).status).toBe(200);
    expect(f.counted()).toHaveLength(0);
  } finally { f.close(); }
});

test('a resumed scoped profile outside both current model records uses defaults without reviving historical options', async () => {
  const f = fixture({ secondaryModel: next, secondaryOptions: selection(next, 'high', 512) });
  try {
    const r = f.router(), profile = r.profileText(secondary, 'secondary');
    f.adapter.persistAgentBindings(r);
    expect((await f.send({ identity: profile })).status).toBe(200);
    expect(f.generated()[0].body.model).toBe(secondary);
    expect(f.generated()[0].body).not.toHaveProperty('reasoning_effort');
    expect(f.counted()).toHaveLength(0);
    expect(Object.keys(f.adapter.live.modelOptions).sort()).toEqual(['primary', 'secondary']);
    expect(f.adapter.live.modelOptions.secondary.model).toBe(next);
  } finally { f.close(); }
});

function useSyntheticTick(f) {
  const a = f.adapter;
  a.bootstrap = () => true;
  a.ownLock = () => true;
  a.protectNativeSecondary = () => {};
  a.rpcCall = async () => ({});
  a.listen = async () => { a.bridgeURL = 'http://127.0.0.1:19002/v1'; };
  a.syncCatalog = async () => {};
  a.reconcileSecondary = async (_runner, wanted, { roleOptionsEnabled = false } = {}) => {
    a.bridgeSecondaryModel = wanted;
    a.rolesReady = Boolean(wanted);
    a.roleOptionsEnabled = roleOptionsEnabled;
    return { applied: true };
  };
  a.stabilityMs = 0;
  a.state = {};
  a.live = null;
}

test('successful initial, steady, and generation transitions replace only the two small live rule records', async () => {
  const f = fixture({ primaryOptions: selection(primary, 'high', 2048), secondaryOptions: selection(primary, 'low', 1024), secondaryModel: primary });
  try {
    useSyntheticTick(f);
    await f.adapter.tick();
    expect(f.adapter.status.code).toBe('connected');
    expect(f.adapter.live.modelOptions).toEqual(f.desired.modelOptions);
    const r = f.router(), profile = r.profileText(primary, 'secondary'), roles = f.adapter.state.agentRoutingRoles;
    write(f.adapter.connectionFile, { ...f.desired, modelOptions: { primary: selection(primary, 'low', 1024), secondary: selection(primary, 'high', 2048) } });
    await f.adapter.tick();
    expect(f.adapter.live.modelOptions.secondary).toEqual(selection(primary, 'high', 2048));
    const runner = read(f.adapter.runnerFile); runner.daemonGeneration = 'synthetic-generation-2'; write(f.adapter.runnerFile, runner);
    f.adapter.retryAfter = 0;
    await f.adapter.tick();
    expect(f.adapter.state.agentRoutingRoles).toEqual(roles);
    f.adapter.agentRouter = null;
    expect((await f.send({ identity: profile })).status).toBe(200);
    expect(f.generated().at(-1).body.reasoning_effort).toBe('high');
    expect(f.adapter.live.modelOptions).toEqual({ primary: selection(primary, 'low', 1024), secondary: selection(primary, 'high', 2048) });
    expect(JSON.stringify(f.adapter.state)).not.toContain('contextTokens');
    expect(JSON.stringify(f.adapter.live.modelOptions)).not.toContain(gateway.key);
    const cleared = { ...f.desired, secondaryModel: '' }; delete cleared.modelOptions;
    write(f.adapter.connectionFile, cleared);
    await f.adapter.tick();
    expect(f.adapter.live.modelOptions).toEqual({ primary: selection(primary) });
  } finally { f.close(); }
});

test('a new primary-only live snapshot contains no absent secondary record while recovery is waiting', async () => {
  const f = fixture({ secondaryModel: '' });
  try {
    useSyntheticTick(f);
    f.adapter.reconcileSecondary = async () => ({ waiting: true });
    await f.adapter.tick();
    expect(f.adapter.status.code).toBe('waiting_kimi_idle');
    expect(f.adapter.live.modelOptions).toEqual({ primary: selection(primary, 'low', 1024) });
  } finally { f.close(); }
});

test('a tick confirms its original secondary scope before adopting a newer pending scope preference', async () => {
  const f = fixture();
  try {
    const initial = { ...f.desired }; delete initial.modelOptions;
    write(f.adapter.connectionFile, initial);
    useSyntheticTick(f);
    f.adapter.syncCatalog = async () => write(f.adapter.connectionFile, { ...initial,
      modelOptions: { secondary: selection(secondary, 'high', 512) } });
    await f.adapter.tick();
    expect(f.adapter.roleOptionsEnabled).toBe(false);
    expect(f.adapter.live.modelOptions).toEqual({ primary: selection(primary), secondary: selection(secondary) });
  } finally { f.close(); }
});

test('a completed steady reconciliation keeps the confirmed secondary snapshot when a new target arrives during the tick', async () => {
  const f = fixture();
  try {
    useSyntheticTick(f);
    await f.adapter.tick();
    expect(f.adapter.live.modelOptions).toEqual(f.desired.modelOptions);
    f.adapter.syncCatalog = async () => write(f.adapter.connectionFile, { ...f.desired, secondaryModel: next,
      modelOptions: { ...f.desired.modelOptions, secondary: selection(next, 'high', 2048) } });
    await f.adapter.tick();
    expect(f.adapter.bridgeSecondaryModel).toBe(secondary);
    expect(f.adapter.live.modelOptions.secondary).toEqual(selection(secondary, 'low', 1024));
  } finally { f.close(); }
});

test('a completed reconciliation keeps the old connection snapshot when a new gateway preference arrives during the tick', async () => {
  const f = fixture();
  try {
    useSyntheticTick(f);
    await f.adapter.tick();
    f.adapter.syncCatalog = async () => write(f.adapter.connectionFile, { ...f.desired,
      gateway: { ...gateway, key: 'transition-pending-key' },
      modelOptions: { ...f.desired.modelOptions, primary: selection(primary, 'high') } });
    await f.adapter.tick();
    expect(f.adapter.live.modelOptions.primary).toEqual(selection(primary, 'low', 1024));
  } finally { f.close(); }
});

test('a newly confirmed secondary target replaces the old snapshot even if another target is already pending', async () => {
  const f = fixture();
  try {
    useSyntheticTick(f);
    await f.adapter.tick();
    write(f.adapter.connectionFile, { ...f.desired, secondaryModel: next,
      modelOptions: { ...f.desired.modelOptions, secondary: selection(next, 'high', 2048) } });
    f.adapter.syncCatalog = async () => write(f.adapter.connectionFile, { ...f.desired,
      modelOptions: { ...f.desired.modelOptions, secondary: selection(secondary, 'low', 512) } });
    await f.adapter.tick();
    expect(f.adapter.bridgeSecondaryModel).toBe(next);
    expect(f.adapter.live.modelOptions.secondary).toEqual(selection(next, 'high', 2048));
  } finally { f.close(); }
});

test('a successful first reconciliation refreshes a newer preference saved after its live connection was initialized', async () => {
  const f = fixture();
  try {
    useSyntheticTick(f);
    f.adapter.syncCatalog = async () => write(f.adapter.connectionFile, { ...f.desired,
      modelOptions: { ...f.desired.modelOptions, primary: selection(primary, 'high', 512) } });
    await f.adapter.tick();
    expect(f.adapter.live.modelOptions.primary).toEqual(selection(primary, 'high', 512));
  } finally { f.close(); }
});

test('a steady tick does not replace a newer applied rule with its earlier pre-await preference', async () => {
  const f = fixture();
  try {
    useSyntheticTick(f);
    await f.adapter.tick();
    f.adapter.syncCatalog = async () => {
      write(f.adapter.connectionFile, { ...f.desired, modelOptions: { ...f.desired.modelOptions, primary: selection(primary, 'high', 512) } });
      f.setTokens(400);
      expect((await f.send()).status).toBe(200);
      write(f.adapter.connectionFile, { ...f.desired, model: next,
        modelOptions: { ...f.desired.modelOptions, primary: selection(next, 'low', 2048) } });
    };
    await f.adapter.tick();
    expect(f.adapter.live).toHaveProperty('modelOptions.primary', selection(primary, 'high', 512));
    f.setTokens(700);
    expect((await f.send()).status).toBe(400);
    expect(f.generated()).toHaveLength(1);
  } finally { f.close(); }
});
