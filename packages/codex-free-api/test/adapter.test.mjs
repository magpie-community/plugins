import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createCleanFetch, discoverModels, providerConfig } from '../lib/adapter.mjs';
import { CodexFreeApiPlugin } from '../index.mjs';

const auth = { type: 'api', key: 'test-api-key', metadata: { organization: 'org-test', project: 'proj_test' } };
const known = JSON.parse(readFileSync(new URL('../models.json', import.meta.url), 'utf8'));
const request = body => ({ method: 'POST', headers: { 'content-type': 'application/json', 'x-codex-originator': 'codex', authorization: 'Bearer client-key', cookie: 'private' }, body: JSON.stringify(body) });

test('registers a separate provider and native API-key prompts without touching other providers', async () => {
  const plugin = await CodexFreeApiPlugin({});
  const cfg = { provider: { openai: { name: 'Existing OpenAI' } } };
  await plugin.config(cfg);
  assert.deepEqual(cfg.provider.openai, { name: 'Existing OpenAI' });
  assert.equal(cfg.provider['codex-free-api-quota'].npm, '@ai-sdk/openai');
  assert.equal(cfg.provider['codex-free-api-quota'].name, 'Codex-free-api');
  assert.equal(plugin.auth.methods[0].type, 'api');
  assert.deepEqual(plugin.auth.methods[0].prompts.map(prompt => prompt.key), ['email', 'organization', 'project']);
  assert.ok(plugin.auth.methods[0].prompts.every(prompt => prompt.required === false));
  assert.deepEqual(await plugin.provider.models({ models: known }, {}), {});
  assert.deepEqual(await plugin.auth.loader(async () => null), {});
});

test('cleans top-level attribution, rebuilds headers and preserves prompt and tool content', async () => {
  let seen;
  const output = new Response('{"id":"resp_test"}', { headers: { 'content-type': 'application/json' } });
  const send = createCleanFetch(async () => auth, {}, async (url, init) => { seen = { url, init }; return output; });
  const input = [{ role: 'user', content: 'Preserve codex and session_id in this message.' }];
  const tools = [{ type: 'function', name: 'get_session_id', parameters: { properties: { session_id: { type: 'string' } } } }];
  const response = await send('https://api.openai.com/v1/responses?trace_id=private&include=reasoning.encrypted_content', request({
    model: 'gpt-4o-mini', input, tools, reasoning: { effort: 'high' }, metadata: { hidden: true }, user: 'private',
    prompt_cache_key: 'private', safety_identifier: 'private', client_metadata: {}, session_id: 'private', Originator: 'codex',
  }));
  assert.equal(response, output);
  assert.deepEqual(JSON.parse(seen.init.body), { model: 'gpt-4o-mini', input, tools, reasoning: { effort: 'high' } });
  assert.deepEqual(Object.keys(seen.init.headers).sort(), ['accept', 'accept-encoding', 'authorization', 'content-type', 'openai-organization', 'openai-project', 'user-agent']);
  assert.equal(seen.init.headers.authorization, 'Bearer test-api-key');
  assert.equal(seen.init.headers['user-agent'], 'local-agent-harness/1.0');
  assert.equal(seen.url.searchParams.has('trace_id'), false);
  assert.equal(seen.url.searchParams.get('include'), 'reasoning.encrypted_content');
});

test('streams original SSE bytes with tool events and completion untouched', async () => {
  const data = 'event: response.function_call_arguments.delta\ndata: {"delta":"x"}\n\nevent: response.completed\ndata: {"id":"resp_test"}\n\n';
  let seen;
  const upstream = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(data)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
  const send = createCleanFetch(async () => auth, {}, async (_url, init) => { seen = init; return upstream; });
  const response = await send('https://api.openai.com/v1/responses', request({ model: 'gpt-4o-mini', input: 'test', stream: true }));
  assert.equal(response, upstream);
  assert.equal(seen.headers.accept, 'text/event-stream');
  assert.equal(await response.text(), data);
});

test('uses the current account key for every request', async () => {
  let key = 'first-key';
  const sent = [];
  const send = createCleanFetch(async () => ({ type: 'api', key }), {}, async (_url, init) => { sent.push(init.headers.authorization); return new Response('{}'); });
  await send('https://api.openai.com/v1/models');
  key = 'second-key';
  await send('https://api.openai.com/v1/models');
  assert.deepEqual(sent, ['Bearer first-key', 'Bearer second-key']);
});

test('does not send credentials to an arbitrary destination or redirect', async () => {
  let calls = 0;
  const send = createCleanFetch(async () => auth, {}, async () => { calls++; return new Response('', { status: 302, headers: { location: 'https://example.com' } }); });
  assert.equal((await send('https://example.com/v1/models')).status, 400);
  assert.equal((await send('https://api.openai.com/v1/files')).status, 400);
  assert.equal(calls, 0);
  assert.equal((await send('https://api.openai.com/v1/models')).status, 502);
  assert.equal(calls, 1);
});

test('refuses invalid JSON, non-object bodies, compression and oversized bodies before forwarding', async () => {
  let calls = 0;
  const send = createCleanFetch(async () => auth, { maxBodyMB: 1 }, async () => { calls++; return new Response('{}'); });
  assert.equal((await send('https://api.openai.com/v1/responses', { ...request({}), body: '{' })).status, 400);
  assert.equal((await send('https://api.openai.com/v1/responses', request([]))).status, 400);
  assert.equal((await send('https://api.openai.com/v1/responses', { ...request({}), headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await send('https://api.openai.com/v1/responses', { ...request({}), headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } })).status, 415);
  assert.equal((await send('https://api.openai.com/v1/responses', request({ input: 'x'.repeat(1048576) }))).status, 413);
  assert.equal(calls, 0);
});

test('passes upstream errors unchanged and redacts transport error details', async () => {
  const upstream = Response.json({ error: { type: 'insufficient_quota' } }, { status: 429 });
  const send = createCleanFetch(async () => auth, {}, async () => upstream);
  assert.equal(await send('https://api.openai.com/v1/models'), upstream);
  const failed = createCleanFetch(async () => auth, {}, async () => { throw new Error('proxy credential must never be shown'); });
  const response = await failed('https://api.openai.com/v1/models');
  assert.equal(response.status, 502);
  assert.equal((await response.text()).includes('credential'), false);
});

test('honors caller cancellation before dispatch', async () => {
  let calls = 0;
  const send = createCleanFetch(async () => auth, {}, async () => { calls++; return new Response('{}'); });
  const signal = AbortSignal.abort();
  await assert.rejects(send('https://api.openai.com/v1/models', { signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('discovers only account-visible compatible models and keeps dated snapshots', async () => {
  const found = await discoverModels({ models: {} }, auth, known, {}, async () => Response.json({ data: [
    { id: 'gpt-4o-mini' }, { id: 'gpt-4o-mini-2024-07-18' }, { id: 'text-embedding-3-large' }, { id: 'unknown-model' },
  ] }));
  assert.deepEqual(Object.keys(found), ['gpt-4o-mini', 'gpt-4o-mini-2024-07-18']);
  assert.equal(found['gpt-4o-mini'].api.npm, '@ai-sdk/openai');
  assert.equal(found['gpt-4o-mini-2024-07-18'].api.id, 'gpt-4o-mini-2024-07-18');
  assert.equal(Object.values(found).some(model => model.free === true), false);
});

test('reports invalid credentials and model-list failures without inventing access', async () => {
  await assert.rejects(discoverModels({ models: known }, auth, known, {}, async () => new Response('', { status: 401 })), error => error.signIn === 'expired');
  await assert.rejects(discoverModels({ models: known }, auth, known, {}, async () => Response.json({ data: [{ id: 7 }] })), /无效/);
  const config = providerConfig(known);
  assert.equal(config.searches, true);
  assert.ok(Object.keys(config.models).length > 0);
});

test('bounds streamed Request bodies before they reach the network', async () => {
  let calls = 0;
  const send = createCleanFetch(async () => auth, { maxBodyMB: 1 }, async () => { calls++; return new Response('{}'); });
  const req = new Request('https://api.openai.com/v1/responses', request({ input: 'x'.repeat(1048576) }));
  assert.equal((await send(req)).status, 413);
  assert.equal(calls, 0);
});

test('model discovery rejects oversized or malformed payloads and hides transport secrets', async () => {
  const provider = { models: {} };
  await assert.rejects(discoverModels(provider, auth, known, {}, async () => { throw new Error('proxy-password-secret'); }), error => !error.message.includes('proxy-password-secret') && error.message.includes('无法连接'));
  await assert.rejects(discoverModels(provider, auth, known, {}, async () => new Response('x'.repeat(4 * 1024 * 1024 + 1))), /4 MiB/);
  await assert.rejects(discoverModels(provider, auth, known, {}, async () => new Response('{private-invalid-json')), error => !error.message.includes('private-invalid-json'));
  assert.deepEqual(await discoverModels(provider, auth, known, {}, async () => Response.json({ data: [{ id: 'constructor' }, { id: '__proto__' }, { id: 'toString' }] })), {});
});

test('does not expose errors from the host account reader', async () => {
  const send = createCleanFetch(async () => { throw new Error('host-account-secret'); });
  const result = await send('https://api.openai.com/v1/models');
  assert.equal(result.status, 401);
  assert.equal((await result.text()).includes('host-account-secret'), false);
});
