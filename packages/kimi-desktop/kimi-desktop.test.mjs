import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KimiAdapter } from './adapter.mjs';
import { controlEndpoint } from './rpc.mjs';
import { agent, connect } from './kimi-desktop.agent.js';
import { applyInstructions } from './library.mjs';

const official = 'https://agent-gw.kimi.com/coding/v1';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };

test('Library uses ordinary Kimi native resources while keeping prior MCP and skills', async () => {
  const f = await fixture();
  try {
    const native = path.join(f.kimiDir || f.controller.kimiDir, 'runtime/kimi-code/home');
    const mcp = {mcpServers: {existing: {url: 'https://example.invalid/mcp'}}};
    write(path.join(native, 'mcp.json'), mcp);
    const skill = path.join(f.controller.kimiDir, 'skills/existing/SKILL.md');
    fs.mkdirSync(path.dirname(skill), {recursive: true});
    fs.writeFileSync(skill, 'synthetic existing skill');
    f.controller.bootstrap();
    expect(read(path.join(f.controller.stateDir, 'library-native/mcp.json'))).toEqual(mcp);
    expect(fs.readFileSync(path.join(f.controller.stateDir, 'library-skills/existing/SKILL.md'), 'utf8')).toBe('synthetic existing skill');
    expect(agent.library.mcpFormat).toBe('kimi');
    expect(agent.library.instructions).toEndWith('/AGENTS.md');
    fs.unlinkSync(path.join(f.controller.stateDir, 'library-native'));
    fs.mkdirSync(path.join(f.controller.stateDir, 'library-native'));
    expect(() => f.controller.bootstrap()).toThrow('library_path_conflict');
    expect(read(path.join(native, 'mcp.json'))).toEqual(mcp);
  } finally { await f.cleanup(); }
});

test('shared instructions hot-update in existing conversations without replacing Kimi prompts or tools', async () => {
  const f = await fixture();
  try {
    await f.controller.tick();
    const original = {model: 'k2d8-preview', messages: [
      {role: 'system', content: 'Kimi native system prompt'},
      {role: 'user', content: [{type: 'text', text: 'synthetic history'}]},
      {role: 'assistant', tool_calls: [{id: 'synthetic-call', type: 'function', function: {name: 'Read', arguments: '{}'}}]},
      {role: 'tool', tool_call_id: 'synthetic-call', content: 'synthetic tool result'},
    ]};
    for (const text of ['synthetic rule one', 'synthetic rule two', '']) {
      fs.writeFileSync(f.controller.instructionsFile, text);
      const response = await fetch(f.controller.bridgeURL + '/chat/completions', {method: 'POST',
        headers: {Authorization: 'Bearer synthetic-kimi-key'}, body: JSON.stringify(original)});
      expect(response.status).toBe(200); await response.text();
      const messages = f.requests.at(-1).body.messages;
      expect(messages[0]).toEqual(original.messages[0]);
      expect(messages.slice(text ? 2 : 1)).toEqual(original.messages.slice(1));
      expect(messages.filter(x => x.role === 'system')).toHaveLength(text ? 2 : 1);
      if (text) expect(messages[1].content).toContain(text);
    }
    fs.writeFileSync(f.controller.instructionsFile, 'synthetic active rule');
    const once = applyInstructions(original, f.controller.instructionsFile);
    expect(applyInstructions(once, f.controller.instructionsFile)).toEqual(once);
    fs.writeFileSync(f.controller.instructionsFile, Buffer.from([0xff]));
    const failed = await fetch(f.controller.bridgeURL + '/chat/completions', {method: 'POST',
      headers: {Authorization: 'Bearer synthetic-kimi-key'}, body: JSON.stringify(original)});
    expect(failed.status).toBe(503);
    expect((await failed.json()).error.code).toBe('instructions_unavailable');
    expect(f.requests).toHaveLength(3);
  } finally { await f.cleanup(); }
});

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-kimi-fixture-'));
  const kimiDir = path.join(directory, 'kimi');
  const requests = [], tools = [], calls = [];
  const models = [{id:'original-provider/test-model',display_name:'First'}, {id:'other-provider/other-model',display_name:'Second'}];
  const gateway = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      if (req.headers.authorization !== 'Bearer synthetic-magpie-key' || req.headers['user-agent'] !== 'Desktop Kimi Work') {
        res.writeHead(403); res.end(); return;
      }
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({data:models})); return;
    }
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_read","type":"function","function":{"name":"Read","arguments":"{}"}}]}}]}\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const controller = new KimiAdapter({ stateDir: path.join(directory, 'state'), kimiDir,
    stabilityMs: 0, intervalMs: 100000,
    rpcCall: async (_runner, method, params) => { calls.push({ method, params });
      if (method === 'conversations.getKimiModelList') return {models:[{model:'k2d8-preview'}]};
      return { current: 'k2d8-preview' }; },
    fetchImpl: async (url, options) => {
      if (String(url).startsWith('https://agent-gw.kimi.com/')) {
        tools.push({ url: String(url), authorization: options.headers.Authorization, body: JSON.parse(options.body) });
        return new Response('{"result":"official tool response"}', { headers: { 'Content-Type': 'application/json' } });
      }
      return fetch(url, options);
    },
  });
  const doc = { credentials: { kimiCode: { apiKey: 'synthetic-kimi-key', baseUrl: official, refreshToken: 'synthetic-refresh-before' } },
    model: { current: 'k2d8-preview', providers: { 'daimon-kimi-code': { type: 'kimi', baseUrl: official } },
      models: { 'k2d8-preview': { model: 'k2d8-preview', provider: 'daimon-kimi-code' } } },
    unrelated: { preserve: ['all', 'original', 'settings'] } };
  write(controller.configFile, doc);
  write(controller.runnerFile, { lifecycleStatus: 'running', daemonGeneration: 'synthetic-generation-1',
    activeKernelTurns: 0, activeKernelToolCalls: 0, control: { endpoint: { url: 'ws://127.0.0.1:3072/control', pid: 10, startedAt: 1 } } });
  controller.bootstrap();
  const connection = { schemaVersion: 1, enabled: true, model: 'original-provider/test-model',
    gateway: { url: 'http://127.0.0.1:' + gateway.address().port + '/v1', key: 'synthetic-magpie-key' }, requestId: 1 };
  write(controller.connectionFile, connection);
  return { directory, controller, doc, connection, requests, tools, calls, models,
    cleanup: async () => { await controller.stop(); gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('Work inference uses selected model and gateway auth; SSE tools survive; official fetch/search keep Kimi auth', async () => {
  const f = await fixture();
  try {
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    const payload = { model: 'k2d8-preview', stream: true,
      messages: [{ role: 'system', content: 'synthetic original instruction' }, { role: 'user', content: 'synthetic request' }],
      tools: [{ type: 'function', function: { name: 'Read', parameters: { type: 'object' } } }] };
    const response = await fetch(f.controller.bridgeURL + '/chat/completions', { method: 'POST',
      headers: { Authorization: 'Bearer synthetic-kimi-key', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(await response.text()).toContain('"name":"Read"');
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].authorization).toBe('Bearer synthetic-magpie-key');
    expect(f.requests[0].body).toEqual({ ...payload, model: 'original-provider/test-model' });
    for (const tool of ['fetch', 'search']) {
      const response = await fetch(f.controller.bridgeURL + '/' + tool, { method: 'POST', headers: {
        Authorization: 'Bearer synthetic-kimi-key', 'Content-Type': 'application/json' }, body: '{"query":"synthetic"}' });
      expect(response.status).toBe(200); await response.text();
    }
    expect(f.tools.map(x => x.url)).toEqual(['https://agent-gw.kimi.com/coding/v1/fetch', 'https://agent-gw.kimi.com/coding/v1/search']);
    expect(f.tools.every(x => x.authorization === 'Bearer synthetic-kimi-key')).toBe(true);
    const current = read(f.controller.configFile);
    expect(current.credentials).toEqual(f.doc.credentials);
    expect(current.model.current).toBe('k2d8-preview');
    expect(current.unrelated).toEqual(f.doc.unrelated);
    expect(f.calls.map(x => x.method)).toEqual(['models.current', 'conversations.setModel', 'conversations.getKimiModelList', 'conversations.updateKimiModelList']);
  } finally { await f.cleanup(); }
});

test('thinking controls and complete tool histories survive the desktop bridge with and without Library instructions', async () => {
  const f = await fixture();
  try {
    await f.controller.tick();
    for (const shared of [false, true]) for (const controls of [
      {}, {thinking: {type: 'disabled'}, reasoning_effort: 'none'},
      {thinking: {type: 'enabled', effort: 'max', keep: 'all'}, reasoning_effort: 'max'},
      {thinking: {type: 'adaptive', budget_tokens: 16384}, reasoning: {effort: 'high', summary: 'auto'}},
      {thinking: null, reasoning_effort: null, reasoning: null},
    ]) {
      fs.writeFileSync(f.controller.instructionsFile, shared ? 'synthetic shared instruction' : '');
      const original = {model: 'k2d8-preview', stream: true, tools: [
        {type: 'function', function: {name: 'Read', description: 'synthetic', parameters: {
          type: 'object', properties: {path: {type: 'string'}}, required: ['path']}}},
      ], messages: [
        {role: 'system', content: 'synthetic native instruction'},
        {role: 'developer', content: 'synthetic developer instruction'},
        {role: 'user', content: [{type: 'text', text: 'synthetic 中文'},
          {type: 'image_url', image_url: {url: 'data:image/png;base64,AAAA'}}]},
        {role: 'assistant', content: 'synthetic progress', reasoning_content: 'synthetic reasoning',
          tool_calls: [{id: 'call_read', type: 'function', function: {name: 'Read', arguments: '{}'}}]},
        {role: 'tool', tool_call_id: 'call_read', content: 'synthetic tool result'},
        {role: 'user', content: 'synthetic continuation'},
      ], ...controls};
      const expected = structuredClone(original);
      expected.model = 'original-provider/test-model';
      if (shared) expected.messages.splice(2, 0, {role: 'system',
        content: '<shared-instructions>\nsynthetic shared instruction\n</shared-instructions>'});
      const response = await fetch(f.controller.bridgeURL + '/chat/completions', {method: 'POST',
        headers: {Authorization: 'Bearer synthetic-kimi-key'}, body: JSON.stringify(original)});
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('"name":"Read"');
      expect(f.requests.at(-1).body).toEqual(expected);
    }
  } finally {await f.cleanup();}
});

test('Kimi menu aliases route independently and removed models fail closed', async () => {
  const f = await fixture();
  try {
    await f.controller.tick();
    expect(f.controller.catalog.length).toBe(2);
    const menu = read(f.controller.catalogFile);
    expect(menu.models[0].displayName).toBe('First · Magpie');
    expect(f.calls.find(x => x.method === 'conversations.updateKimiModelList').params.models[0].model).toBe('k2d8-preview');
    const chosen = f.controller.catalog.find(x => x.id === 'other-provider/other-model');
    const response = await fetch(f.controller.bridgeURL + '/chat/completions', {method:'POST', headers:{Authorization:'Bearer synthetic-kimi-key'},
      body:JSON.stringify({model:chosen.alias,messages:[{role:'user',content:'synthetic'}]})});
    await response.text();
    expect(f.requests[0].body.model).toBe('other-provider/other-model');
    expect(f.requests[0].authorization).toBe('Bearer synthetic-magpie-key');
    f.controller.catalog = f.controller.catalog.filter(x => x.alias !== chosen.alias);
    const refused = await fetch(f.controller.bridgeURL + '/chat/completions', {method:'POST',headers:{Authorization:'Bearer synthetic-kimi-key'},
      body:JSON.stringify({model:chosen.alias,messages:[]})});
    expect(refused.status).toBe(409);
    expect(f.requests.length).toBe(1);
  } finally {await f.cleanup();}
});

test('rate-limit responses retain Retry-After, status and body without forwarding credentials', async () => {
  const f = await fixture();
  try {
    await f.controller.tick();
    const original = f.controller.fetchImpl;
    for (const [status, retry] of [[429, '17'], [503, 'Wed, 21 Oct 2037 07:28:00 GMT']]) {
      const body = JSON.stringify({error: {type: 'rate_limit_error', message: 'Synthetic upstream failure'}});
      f.controller.fetchImpl = async (url, options) => String(url).endsWith('/models')
        ? original(url, options) : new Response(body, {status, headers: {
          'Content-Type': 'application/json', 'Retry-After': retry,
          'Set-Cookie': 'synthetic-cookie', Authorization: 'Bearer synthetic-secret',
        }});
      const response = await fetch(f.controller.bridgeURL + '/chat/completions', {method: 'POST',
        headers: {Authorization: 'Bearer synthetic-kimi-key'}, body: JSON.stringify({model: 'k2d8-preview', messages: []})});
      expect(response.status).toBe(status);
      expect(response.headers.get('retry-after')).toBe(retry);
      expect(await response.text()).toBe(body);
      expect(response.headers.get('authorization')).toBeNull();
      expect(response.headers.get('set-cookie')).toBeNull();
    }
  } finally { await f.cleanup(); }
});

test('malformed owner records report a fixed error without taking an unknown lock', async () => {
  for (const contents of ['', '{"pid":', '{}', '{"pid":0,"ownerID":"synthetic"}', '{"pid":1}']) {
    const f = await fixture();
    try {
      fs.writeFileSync(f.controller.lockFile, contents);
      const logs = [];
      f.controller.log = code => logs.push(code);
      await f.controller.tick();
      await f.controller.tick();
      expect(f.controller.status.code).toBe('adapter_lock_invalid');
      expect(read(f.controller.statusFile).code).toBe('adapter_lock_invalid');
      expect(logs).toEqual(['adapter_lock_invalid']);
      expect(fs.readFileSync(f.controller.lockFile, 'utf8')).toBe(contents);
      expect(read(f.controller.configFile)).toEqual(f.doc);
      expect(f.controller.live).toBeNull();
    } finally { await f.cleanup(); }
  }
});

test('owner records are fully written before exclusive atomic publication', async () => {
  const f = await fixture();
  const link = fs.linkSync;
  let published = false;
  try {
    fs.linkSync = (source, target) => {
      if (target === f.controller.lockFile) {
        expect(read(source)).toEqual({pid: process.pid, ownerID: f.controller.ownerID});
        expect(fs.existsSync(target)).toBe(false);
        published = true;
      }
      return link(source, target);
    };
    await f.controller.tick();
    expect(published).toBe(true);
    expect(f.controller.status.code).toBe('connected');
    expect(fs.readdirSync(f.controller.stateDir).filter(x => x.endsWith('.tmp'))).toEqual([]);
  } finally { fs.linkSync = link; await f.cleanup(); }
});

test('failed owner publication leaves no partial lock or staged file', async () => {
  for (const phase of ['write', 'link']) {
    const f = await fixture();
    const link = fs.linkSync, writeFile = fs.writeFileSync;
    try {
      fs.writeFileSync = (file, data, options) => {
        if (phase === 'write' && String(file).startsWith(f.controller.lockFile + '.') && String(file).endsWith('.tmp')) {
          writeFile(file, '{"pid":', options);
          throw Object.assign(Error('synthetic interrupted staging write'), {code: 'EIO'});
        }
        return writeFile(file, data, options);
      };
      fs.linkSync = (source, target) => {
        if (phase === 'link' && target === f.controller.lockFile) throw Object.assign(Error('synthetic publication failure'), {code: 'EIO'});
        return link(source, target);
      };
      await f.controller.tick();
      expect(f.controller.status.code).toBe('adapter_lock_unavailable');
      expect(fs.existsSync(f.controller.lockFile)).toBe(false);
      expect(fs.readdirSync(f.controller.stateDir).filter(x => x.endsWith('.tmp'))).toEqual([]);
      expect(read(f.controller.configFile)).toEqual(f.doc);
    } finally { fs.linkSync = link; fs.writeFileSync = writeFile; await f.cleanup(); }
  }
});

test('a competing exclusive publication keeps its complete owner record', async () => {
  const f = await fixture();
  const link = fs.linkSync;
  const other = {pid: process.pid, ownerID: 'synthetic-other-owner'};
  try {
    fs.linkSync = (source, target) => {
      if (target === f.controller.lockFile) write(target, other);
      return link(source, target);
    };
    await f.controller.tick();
    expect(read(f.controller.lockFile)).toEqual(other);
    expect(f.controller.locked).not.toBe(true);
    expect(f.controller.live).toBeNull();
    expect(fs.readdirSync(f.controller.stateDir).filter(x => x.endsWith('.tmp'))).toEqual([]);
    expect(read(f.controller.configFile)).toEqual(f.doc);
  } finally { fs.linkSync = link; await f.cleanup(); }
});

test('a complete record belonging to an exited owner can still be reclaimed', async () => {
  const f = await fixture();
  const kill = process.kill;
  try {
    write(f.controller.lockFile, {pid: 2147483647, ownerID: 'synthetic-exited-owner'});
    process.kill = (pid, signal) => {
      if (pid === 2147483647 && signal === 0) throw Object.assign(Error('synthetic exited process'), {code: 'ESRCH'});
      return kill(pid, signal);
    };
    await f.controller.tick();
    expect(read(f.controller.lockFile)).toEqual({pid: process.pid, ownerID: f.controller.ownerID});
    expect(f.controller.status.code).toBe('connected');
  } finally { process.kill = kill; await f.cleanup(); }
});

test('another adapter never replaces a valid live owner record', async () => {
  const f = await fixture();
  let second;
  try {
    await f.controller.tick();
    const before = fs.readFileSync(f.controller.lockFile);
    second = new KimiAdapter({stateDir: f.controller.stateDir, kimiDir: f.controller.kimiDir, stabilityMs: 0});
    await second.tick();
    expect(fs.readFileSync(f.controller.lockFile)).toEqual(before);
    expect(second.locked).not.toBe(true);
    expect(second.live).toBeNull();
    expect(f.controller.live).not.toBeNull();
  } finally { await second?.stop(); await f.cleanup(); }
});

test('disconnect restores one address while retaining refreshed credentials and unrelated changes', async () => {
  const f = await fixture();
  try {
    await f.controller.tick();
    const doc = read(f.controller.configFile);
    doc.credentials.kimiCode.refreshToken = 'synthetic-refresh-rotated';
    doc.unrelated.newSetting = 'preserved';
    write(f.controller.configFile, doc);
    write(f.controller.connectionFile, { ...f.connection, enabled: false });
    await f.controller.tick();
    expect(f.controller.status.code).toBe('disconnected');
    const after = read(f.controller.configFile);
    expect(after.model.providers['daimon-kimi-code'].baseUrl).toBe(official);
    expect(after.credentials.kimiCode.refreshToken).toBe('synthetic-refresh-rotated');
    expect(after.unrelated.newSetting).toBe('preserved');
    expect(f.calls.at(-1).method).toBe('conversations.setModel');
    expect(fs.existsSync(f.controller.modelBackupFile)).toBe(false);
    expect(fs.existsSync(path.join(f.controller.stateDir, 'backups'))).toBe(false);
  } finally { await f.cleanup(); }
});

test('disconnect returns a selected menu alias to the original model without losing native entries', async () => {
  const f=await fixture();
  try {
    await f.controller.tick();
    let models=f.calls.find(x=>x.method==='conversations.updateKimiModelList').params.models;
    const base=f.controller.rpcCall;
    f.controller.rpcCall=async(runner,method,params)=>{
      if(method==='conversations.getKimiModelList')return {models};
      if(method==='conversations.updateKimiModelList')models=params.models;
      if(method==='conversations.setModel'){
        const doc=read(f.controller.configFile);doc.model.current=params.modelAlias;write(f.controller.configFile,doc);
      }
      return base(runner,method,params);
    };
    const doc=read(f.controller.configFile);doc.model.current=f.controller.catalog[1].alias;write(f.controller.configFile,doc);
    write(f.controller.connectionFile,{...f.connection,enabled:false});
    await f.controller.tick();
    expect(read(f.controller.configFile).model.current).toBe('k2d8-preview');
    expect(models).toEqual([{model:'k2d8-preview'}]);
    expect(read(f.controller.configFile).credentials).toEqual(f.doc.credentials);
    expect(read(f.controller.catalogFile).enabled).toBe(false);
  }finally{await f.cleanup();}
});

test('long Work turns keep the native menu alive without reloading the busy runtime', async () => {
  const f=await fixture();
  try {
    await f.controller.tick();
    const calls=f.calls.length;
    const catalog=read(f.controller.catalogFile);
    write(f.controller.catalogFile,{...catalog,updatedAt:'2000-01-01T00:00:00Z'});
    write(f.controller.runnerFile,{...read(f.controller.runnerFile),activeKernelTurns:1});
    f.controller.catalogAfter=0;
    await f.controller.tick();
    expect(Date.now()-Date.parse(read(f.controller.catalogFile).updatedAt)).toBeLessThan(5000);
    expect(read(f.controller.catalogFile).models).toEqual(catalog.models);
    expect(f.calls.length).toBe(calls);
  }finally{await f.cleanup();}
});

test('requests without Kimi auth, browser requests and unknown paths never reach a supplier', async () => {
  const f = await fixture();
  try {
    await f.controller.tick();
    for (const [suffix, headers, status] of [
      ['/chat/completions', {}, 401],
      ['/chat/completions', { Authorization: 'Bearer synthetic-kimi-key', Origin: 'https://example.invalid' }, 403],
      ['/unknown', { Authorization: 'Bearer synthetic-kimi-key' }, 404],
    ]) {
      const response = await fetch(f.controller.bridgeURL + suffix, { method: 'POST', headers, body: '{}' });
      expect(response.status).toBe(status); await response.text();
    }
    expect(f.requests).toHaveLength(0);
    expect(f.tools).toHaveLength(0);
  } finally { await f.cleanup(); }
});

test('waits for active Work tasks; pauses on outside config changes; explicit reconnect recovers', async () => {
  const f = await fixture();
  try {
    const runner = read(f.controller.runnerFile);
    write(f.controller.runnerFile, { ...runner, activeKernelTurns: 1 });
    await f.controller.tick();
    expect(f.controller.status.code).toBe('waiting_kimi_idle');
    expect(f.calls).toHaveLength(0);
    write(f.controller.runnerFile, runner);
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
    const doc = read(f.controller.configFile);
    doc.model.providers['daimon-kimi-code'].baseUrl = official;
    write(f.controller.configFile, doc);
    await f.controller.tick();
    expect(f.controller.status.code).toBe('kimi_config_changed');
    await f.controller.tick();
    expect(read(f.controller.configFile).model.providers['daimon-kimi-code'].baseUrl).toBe(official);
    write(f.controller.connectionFile, { ...f.connection, enabled: false });
    await f.controller.tick();
    write(f.controller.connectionFile, f.connection);
    await f.controller.tick();
    expect(f.controller.status.code).toBe('connected');
  } finally { await f.cleanup(); }
});

test('rejects remote gateway and control endpoints before changing Kimi', async () => {
  const f = await fixture();
  try {
    write(f.controller.connectionFile, { ...f.connection, gateway: { url: 'http://example.invalid/v1', key: 'synthetic' } });
    await f.controller.tick();
    expect(f.controller.status.code).toBe('invalid_gateway');
    expect(read(f.controller.configFile)).toEqual(f.doc);
    expect(() => controlEndpoint({ control: { endpoint: { url: 'ws://example.invalid/control', auth: { token: 'synthetic' } } } })).toThrow();
    expect(agent.id).toBe('kimi-desktop');
    expect(connect({ gateway: { v1: 'http://127.0.0.1:3425/v1', key: 'synthetic' } })['gateway.key']).toBe('synthetic');
  } finally { await f.cleanup(); }
});

test('the identified gateway catalog updates visibility without opening Magpie files, even during an active turn',async()=>{
  const f=await fixture();
  try{
    await f.controller.tick();
    const removed=f.controller.catalog.find(x=>x.id==='other-provider/other-model');
    const magpieDir = path.join(f.directory, 'magpie');
    fs.mkdirSync(magpieDir);
    fs.writeFileSync(path.join(magpieDir, 'providers.json'), 'not JSON: must never be opened');
    fs.writeFileSync(path.join(magpieDir, 'settings.json'), 'not JSON: policy belongs to gateway');
    f.models.splice(1);
    const response=await fetch(f.controller.bridgeURL+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer synthetic-kimi-key'},
      body:JSON.stringify({model:removed.alias,messages:[]})});
    expect(response.status).toBe(409);expect(f.requests).toHaveLength(0);
    const runner=read(f.controller.runnerFile);runner.activeKernelTurns=['synthetic-turn'];write(f.controller.runnerFile,runner);
    f.controller.catalogAfter=0;await f.controller.tick();
    expect(f.controller.catalog.map(x=>x.id)).toEqual(['original-provider/test-model']);
    expect(read(f.controller.catalogFile)).toMatchObject({exclusive:true,enabled:true});
    expect(read(f.controller.catalogFile).models).toHaveLength(1);
  }finally{await f.cleanup();}
});

test('reconnects retain only changed model fields, never a full credential backup', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 2; i++) {
      write(f.controller.connectionFile, f.connection);
      f.controller.catalogAfter = 0;
      await f.controller.tick();
      expect(f.controller.status.code).toBe('connected');
      const saved = fs.readdirSync(f.controller.stateDir).filter(name => fs.lstatSync(path.join(f.controller.stateDir, name)).isFile())
        .map(name => fs.readFileSync(path.join(f.controller.stateDir, name), 'utf8')).join('\n');
      expect(saved).not.toContain('synthetic-kimi-key');
      expect(saved).not.toContain('synthetic-refresh-before');
      write(f.controller.connectionFile, {...f.connection, enabled: false});
      await f.controller.tick();
      expect(fs.existsSync(f.controller.modelBackupFile)).toBe(false);
    }
  } finally { await f.cleanup(); }
});

test('disconnect restores the address even when Kimi removes a private catalog method', async () => {
  const f = await fixture();
  try {
    await f.controller.tick();
    f.controller.rpcCall = async () => {throw Error('kimi_control_rejected');};
    write(f.controller.connectionFile, {...f.connection, enabled: false});
    await f.controller.tick();
    expect(read(f.controller.configFile).model.providers['daimon-kimi-code'].baseUrl).toBe(official);
    expect(read(f.controller.configFile).credentials).toEqual(f.doc.credentials);
    expect(fs.existsSync(f.controller.modelBackupFile)).toBe(true);
    expect(f.controller.state.active).toBe(false);
  } finally {await f.cleanup();}
});

test('loading an agent never installs signal handlers in the shared plugin host', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-empty-host-'));
  const entry = pathToFileURL(fileURLToPath(new URL('./index.mjs', import.meta.url))).href;
  try {
    const child = spawnSync(process.execPath, ['--eval', `
      const before = ['SIGTERM','SIGINT'].map(s => process.listenerCount(s));
      const plugin = (await import(${JSON.stringify(entry)})).default;
      await plugin({});
      if (['SIGTERM','SIGINT'].some((s,i) => process.listenerCount(s) !== before[i])) throw Error('shared signal handlers changed');
      console.log('host preserved');
    `], {env: {...process.env, HOME: home, USERPROFILE: home, APPDATA: home}, encoding: 'utf8', timeout: 10000});
    expect(child.status).toBe(0);
    expect(child.stdout).toContain('host preserved');
  } finally { fs.rmSync(home, {recursive: true, force: true}); }
});
