// Exercise the real control WebSocket transport against a temporary Kimi peer.
// No desktop profile, application or external model is used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KimiAdapter } from '../adapter.mjs';
import { isMenuAlias } from '../catalog.mjs';

const official = 'https://agent-gw.kimi.com/coding/v1';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};

// Model the public native plugin API: install/update copy the declared source
// into the active V2 home's managed directory; enablement belongs to the host.
export function nativeRolePluginPeer(homeDirectory) {
  const enabled = new Map(), calls = [];
  let fault = null;
  const methods = new Set(['kimiPlugin.installPlugin', 'kimiPlugin.updatePlugin',
    'kimiPlugin.getPluginInfo', 'kimiPlugin.setPluginEnabled']);
  const installed = id => path.join(homeDirectory, 'plugins', 'managed', id);
  return {
    calls, installed,
    handles: method => methods.has(method),
    setEnabled(id, value) { enabled.set(id, value); },
    fail(method, { after = false, once = true } = {}) { fault = { method, after, once }; },
    clearFault() { fault = null; },
    call(method, params) {
      calls.push({ method, params });
      const activeFault = fault?.method === method ? fault : null;
      if (activeFault?.once) fault = null;
      if (activeFault && !activeFault.after) throw Error('synthetic public plugin RPC failure');
      let result;
      if (method === 'kimiPlugin.installPlugin' || method === 'kimiPlugin.updatePlugin') {
        if (typeof params?.source !== 'string') throw Error('plugin source required');
        const manifest = read(path.join(params.source, 'kimi.plugin.json'));
        if (!manifest.name || JSON.stringify(manifest.agents) !== JSON.stringify(['./agents'])) throw Error('invalid plugin manifest');
        const destination = installed(manifest.name);
        if (method === 'kimiPlugin.installPlugin' && fs.existsSync(destination)) throw Error('plugin already installed');
        fs.rmSync(destination, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.cpSync(params.source, destination, { recursive: true });
        if (!enabled.has(manifest.name)) enabled.set(manifest.name, false);
        result = { id: manifest.name, enabled: enabled.get(manifest.name) };
      } else if (method === 'kimiPlugin.getPluginInfo') {
        if (!fs.existsSync(path.join(installed(params.id), 'kimi.plugin.json'))) throw Error('plugin not found');
        result = { id: params.id, enabled: enabled.get(params.id) === true };
      } else if (method === 'kimiPlugin.setPluginEnabled') {
        if (!fs.existsSync(path.join(installed(params.id), 'kimi.plugin.json'))) throw Error('plugin not found');
        enabled.set(params.id, params.enabled);
        result = { id: params.id, enabled: params.enabled };
      } else throw Error('unexpected plugin method');
      if (activeFault?.after) throw Error('synthetic lost public plugin reply');
      return result;
    },
  };
}

export function recoveryPeer() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-restore-peer-'));
  const kimiDir = path.join(home, 'kimi');
  const stateDir = path.join(home, 'state');
  let menu = [{ model: 'native', maxContextSize: 131072, capabilities: [] }];
  let runtimeBase = official;
  let fault = null;
  let controller;
  const plugins = nativeRolePluginPeer(path.join(kimiDir, 'runtime', 'kimi-code', 'home'));
  const calls = [], requests = [];
  const service = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(request, server) {
      if (request.headers.get('authorization') !== 'Bearer synthetic-control') return new Response('', { status: 401 });
      if (server.upgrade(request)) return;
      return new Response('', { status: 400 });
    },
    websocket: { message(socket, input) {
      const { id, method, params } = JSON.parse(String(input));
      const doc = read(controller.configFile);
      const point = method === 'conversations.getKimiModelList' ? 'list'
        : method === 'conversations.updateKimiModelList' ? 'menu'
        : method === 'conversations.setModel' ? (doc.model.providers['daimon-kimi-code'].baseUrl === official ? 'reload' : 'select')
        : 'probe';
      calls.push({ method, point, params });
      const fail = fault?.point === point;
      const respond = value => socket.send(JSON.stringify({ jsonrpc: '2.0', id,
        ...(value ? { error: { code: -32000, message: 'synthetic unavailable' } } : { result }) }));
      let result;
      if (fail && !fault.after) { respond(true); return; }
      if (plugins.handles(method)) result = plugins.call(method, params);
      else if (method === 'kimiPlugin.reloadActiveSessions') result = { sessions: [] };
      else if (method === 'kimiPlugin.ReloadSession') result = { status: 'reloaded' };
      else if (method === 'models.current') result = { current: doc.model.current };
      else if (method === 'conversations.getKimiModelList') result = { models: menu };
      else if (method === 'conversations.updateKimiModelList') {
        menu = params.models;
        if (!menu.some(row => row.model === doc.model.current)) doc.model.current = menu[0].model;
        doc.model.models = Object.fromEntries(menu.map(row => [row.model, { model: row.model, provider: 'daimon-kimi-code' }]));
        write(controller.configFile, doc);
        runtimeBase = doc.model.providers['daimon-kimi-code'].baseUrl;
        result = { ok: true };
      } else if (method === 'conversations.setModel') {
        doc.model.current = params.modelAlias;
        write(controller.configFile, doc);
        runtimeBase = doc.model.providers['daimon-kimi-code'].baseUrl;
        result = { current: params.modelAlias };
      } else throw Error('unexpected control method');
      respond(fail);
    } },
  });
  const make = () => new KimiAdapter({ home, stateDir, kimiDir, stabilityMs: 0,
    fetchImpl: async (url, options) => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'provider/main' }, { id: 'provider/secondary' }] }));
      requests.push({ url: String(url), body: JSON.parse(options.body) });
      return new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    } });
  controller = make();
  write(controller.configFile, { model: { current: 'native', models: { native: { model: 'native', provider: 'daimon-kimi-code' } },
    providers: { 'daimon-kimi-code': { type: 'kimi', baseUrl: official } } },
    credentials: { kimiCode: { apiKey: 'synthetic-kimi-key' } }, unrelated: 'keep' });
  write(controller.runnerFile, { lifecycleStatus: 'running', daemonGeneration: 'synthetic-one', kernel: { agentKernel: 'kimi-code-v2' },
    control: { endpoint: { url: `ws://127.0.0.1:${service.port}/control`, auth: { token: 'synthetic-control' } } } });
  controller.bootstrap();
  write(controller.connectionFile, { enabled: true, model: 'provider/main',
    gateway: { url: 'http://127.0.0.1:3425/v1', key: 'synthetic-gateway' } });
  return {
    get controller() { return controller; }, get menu() { return menu; }, get runtimeBase() { return runtimeBase; }, calls, requests, plugins,
    selectAlias({ legacy = true } = {}) {
      // New connections do not install native aliases. Explicitly reproduce
      // the narrow menu/config/backup state left by an earlier plugin version.
      const doc = read(controller.configFile);
      const native = menu.find(row => !isMenuAlias(row.model));
      if (!fs.existsSync(controller.modelBackupFile)) write(controller.modelBackupFile, { current: native.model });
      const row = controller.catalog.find(row => row.id === 'provider/main');
      const alias = legacy ? row.alias.replace('local-model-', 'magpie-local-') : row.alias;
      if (!menu.some(row => row.model === alias)) menu = [...menu, { ...row.runtime, model: alias }];
      doc.model.models[alias] = { model: alias, provider: 'daimon-kimi-code' };
      doc.model.current = alias;
      write(controller.configFile, doc);
      return alias;
    },
    fail(point, after = false) { fault = { point, after }; },
    clearFault() { fault = null; },
    disable() { write(controller.connectionFile, { ...read(controller.connectionFile), enabled: false }); },
    recover() { fault = null; controller = make(); },
    async cleanup() {
      fault = null;
      await controller.stop();
      service.stop(true);
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}
