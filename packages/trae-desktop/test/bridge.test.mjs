import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createBridge, startHost, LOCAL_TOKEN } from '../bridge.mjs';
import { agent, connect } from '../trae.agent.js';

async function fixture(t, respond, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-bridge-test-'));
  const file = path.join(root, 'connection.json');
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    seen.push({ headers: req.headers, body: JSON.parse(raw), url: req.url });
    if (respond) return respond(req, res, seen.at(-1));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'fixture-ok' } }] }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const baseURL = `http://127.0.0.1:${upstream.address().port}/v1`;
  const write = patch => fs.writeFileSync(file, JSON.stringify({ version: 2, baseURL, gatewayKey: 'fixture-private',
    models: [{ id: 'fixture/first', name: 'First', context: 128000 }, { id: 'fixture/second', name: 'Second' }, { id: 'group/fixture', name: 'Group' }], ...patch }));
  write();
  const bridge = createBridge({ file, port: 0, ...options });
  const address = await bridge.listen();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await bridge.close(); upstream.closeAllConnections(); await new Promise(r => upstream.close(r));
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const send = (body = {}, init = {}) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST', ...init, headers: { authorization: `Bearer ${LOCAL_TOKEN}`, 'content-type': 'application/json', ...init.headers },
    body: JSON.stringify({ model: 'fixture/first', messages: [{ role: 'user', content: 'fixture' }], ...body }),
  });
  return { root, file, upstream, seen, base, write, send };
}

test('Agent is connect-only so model selection belongs to Trae', () => {
  assert.equal(agent.id, 'trae-local'); assert.equal(agent.model, undefined); assert.equal(agent.effort, undefined);
  const out = connect({ gateway: { v1: 'http://127.0.0.1:3425/v1', key: 'fixture-key' }, models: [] });
  assert.equal(out.gatewayKey, 'fixture-key'); assert.equal(out.version, 2); assert.equal(out.model, undefined);
  assert.throws(() => connect({ gateway: {}, model: {} }));
});

test('Agent and installed plugin use the same embedded official Trae icon', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const bytes = fs.readFileSync(new URL('../assets/trae.svg', import.meta.url));
  assert.equal(agent.icon, `data:image/svg+xml;base64,${bytes.toString('base64')}`);
  assert.equal(pkg.magpie.icon, agent.icon);
});

test('preserves the model chosen in Trae, messages, images, tools and reasoning', async t => {
  const f = await fixture(t);
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'fixture' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }];
  const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }];
  const r = await f.send({ messages, tools, reasoning_effort: 'high' });
  assert.equal(r.status, 200); await r.json();
  assert.deepEqual(f.seen[0].body, { model: 'fixture/first', messages, tools, reasoning_effort: 'high' });
  assert.equal(f.seen[0].headers.authorization, 'Bearer fixture-private');
  assert.equal(f.seen[0].url, '/v1/chat/completions');
});

test('does not forward Trae cloud headers, cookies, forwarding chains or caller key', async t => {
  const f = await fixture(t);
  const r = await f.send({}, { headers: { 'x-forwarded-for': 'fc00::1', 'x-real-ip': '1.2.3.4',
    'acl-token': 'fixture-cloud', cookie: 'fixture-cookie', 'x-magpie-conversation': 'session-1' } });
  await r.text();
  for (const name of ['x-forwarded-for', 'x-real-ip', 'acl-token', 'cookie']) assert.equal(f.seen[0].headers[name], undefined);
  assert.equal(f.seen[0].headers['x-magpie-conversation'], 'session-1');
});

test('relays fragmented SSE tool arguments and usage byte for byte', async t => {
  const chunks = ['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"calc","arguments":"{\\"n\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"2}"}}]}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":3}}\n\ndata: [DONE]\n\n'];
  const f = await fixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const chunk of chunks) { res.write(chunk); await delay(5); } res.end();
  });
  const response = await f.send({ stream: true });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(await response.text(), chunks.join(''));
});

test('Trae switches models and routing groups without modifying Magpie configuration', async t => {
  const f = await fixture(t); await (await f.send()).text();
  const original = fs.readFileSync(f.file, 'utf8');
  await (await f.send({ model: 'fixture/second' })).text();
  await (await f.send({ model: 'group/fixture' })).text();
  assert.deepEqual(f.seen.map(r => r.body.model), ['fixture/first', 'fixture/second', 'group/fixture']);
  assert.equal(fs.readFileSync(f.file, 'utf8'), original);
});

test('catalog updates immediately expose additions and refuse removed models', async t => {
  const f = await fixture(t);
  f.write({ models: [{ id: 'fixture/new', name: 'New' }] });
  assert.equal((await f.send()).status, 404);
  assert.equal((await f.send({ model: 'fixture/new' })).status, 200);
});

test('disconnect, missing control and corrupt control stop requests without fallback', async t => {
  const f = await fixture(t);
  for (const value of ['{}', '{broken', null]) {
    if (value === null) fs.unlinkSync(f.file); else fs.writeFileSync(f.file, value);
    assert.equal((await f.send()).status, 503);
  }
  assert.equal(f.seen.length, 0);
  f.write(); assert.equal((await f.send()).status, 200);
});

test('refuses a remote or recursive gateway before transmitting its credential', async t => {
  const f = await fixture(t);
  for (const baseURL of ['https://example.com/v1', `${f.base}/v1`, 'http://127.0.0.1:3425/other', 'http://user:pass@127.0.0.1:3425/v1']) {
    f.write({ baseURL }); assert.equal((await f.send()).status, 503);
  }
  assert.equal(f.seen.length, 0);
});

test('browser origins, wrong local token and rebound hosts cannot invoke models', async t => {
  const f = await fixture(t);
  assert.equal((await f.send({}, { headers: { origin: 'https://example.com' } })).status, 403);
  assert.equal((await f.send({}, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  // fetch normalizes Host; use the actual HTTP transport to exercise rebinding.
  const rebound = await new Promise((resolve, reject) => {
    const request = http.request(`${f.base}/v1/chat/completions`, { method: 'POST',
      headers: { host: 'example.com:1234', authorization: `Bearer ${LOCAL_TOKEN}` } }, res => { res.resume(); resolve(res.statusCode); });
    request.on('error', reject); request.end('{}');
  });
  assert.equal(rebound, 403);
  assert.equal(f.seen.length, 0);
});

test('health and complete catalog expose model metadata without gateway credentials', async t => {
  const f = await fixture(t);
  await (await f.send()).text();
  const health = await (await fetch(`${f.base}/health`)).json();
  assert.equal(health.connected, true); assert.equal(health.models.length, 3); assert.equal(health.requests, 1);
  assert.ok(!JSON.stringify(health).includes('fixture-private'));
  const catalog = await (await fetch(`${f.base}/v1/models`, { headers: { authorization: `Bearer ${LOCAL_TOKEN}` } })).json();
  assert.equal(catalog.data[0].id, 'fixture/first'); assert.equal(catalog.data[0].context_length, 128000);
  assert.equal(catalog.data.length, 3);
});

test('preserves upstream error status and content', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' }); res.end('{"error":{"message":"fixture quota"}}'); });
  const r = await f.send(); assert.equal(r.status, 429); assert.equal(r.headers.get('retry-after'), '3');
  assert.equal((await r.json()).error.message, 'fixture quota');
});

test('invalid JSON, unexpected model and oversized body never reach Magpie', async t => {
  const f = await fixture(t, undefined, { maxBodyBytes: 300 });
  assert.equal((await f.send({ model: 'other' })).status, 404);
  assert.equal((await f.send({ messages: 'bad' })).status, 400);
  assert.equal((await f.send({ extra: 'x'.repeat(400) })).status, 413);
  const r = await fetch(`${f.base}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${LOCAL_TOKEN}` }, body: '{bad' });
  assert.equal(r.status, 400); assert.equal(f.seen.length, 0);
});

test('unknown endpoints and unsupported methods are refused', async t => {
  const f = await fixture(t);
  const headers = { authorization: `Bearer ${LOCAL_TOKEN}` };
  assert.equal((await fetch(`${f.base}/v1/unknown`, { headers })).status, 404);
  assert.equal((await fetch(`${f.base}/v1/chat/completions`, { headers })).status, 405);
});

test('invalid credential bytes fail before creating an upstream request', async t => {
  const f = await fixture(t);
  f.write({ gatewayKey: 'bad\u0000key' });
  assert.equal((await f.send()).status, 503);
  assert.equal(f.seen.length, 0);
});

test('unavailable gateway returns a bounded error', async t => {
  const f = await fixture(t);
  await new Promise(r => f.upstream.close(r));
  const r = await f.send(); assert.equal(r.status, 502); assert.match((await r.json()).error.message, /Magpie/);
});

test('client cancellation closes its upstream stream', async t => {
  let closed; const cancelled = new Promise(resolve => { closed = resolve; });
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"fixture":1}\n\n'); res.on('close', closed);
  });
  const control = new AbortController();
  const r = await f.send({ stream: true }, { signal: control.signal });
  await r.body.getReader().read(); control.abort();
  await Promise.race([cancelled, delay(1000).then(() => { throw new Error('Upstream stream was not cancelled'); })]);
});

test('a resident host retries when a short-lived CLI host holds the port', async t => {
  const f = await fixture(t);
  const blocker = http.createServer(); blocker.listen(0, '127.0.0.1'); await once(blocker, 'listening');
  const port = blocker.address().port;
  const host = startHost({ file: f.file, port, retryMs: 20 }); await host.ready;
  t.after(() => host.stop());
  await new Promise(r => blocker.close(r));
  let status;
  for (let i = 0; i < 30; i++) {
    try { status = await (await fetch(`http://127.0.0.1:${port}/health`)).json(); break; } catch { await delay(20); }
  }
  assert.equal(status?.name, 'magpie-trae');
});
