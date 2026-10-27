import {test, expect} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {_internal as I} from './index.mjs';

const session = {uid: 'synthetic-account', workToken: 'synthetic-work-token', webToken: 'synthetic-web-token'};
const auth = {source: 'kimi-work-desktop', uid: session.uid};
const models = {data: [{id: 'k3-agent', display_name: 'K3', context_length: 1000000,
  supports_image_in: true, supports_reasoning: true, reasoningEffortOptions: [{effort: 'REASONING_EFFORT_LOW'}, {effort: 'REASONING_EFFORT_MAX'}]}]};

test('sign-in saves an account reference and dynamic models/usage retain Work accounting', async () => {
  const calls = [];
  const p = I.createPlugin({readSession: () => session, fetchImpl: async (url, init) => {
    calls.push({url, init});
    return Response.json(url.endsWith('/models') ? models : {subscriptionBalance: {amountUsedRatio: 0.42}, ratelimitCode5h: {ratio: 1}});
  }});
  const result = await (await p.auth.methods[0].authorize()).callback();
  expect(result).toMatchObject({type: 'success', source: auth.source, uid: auth.uid});
  expect(JSON.stringify(result)).not.toContain(session.workToken);
  const catalog = await p.provider.models({models: {}}, {auth});
  expect(catalog['k3-agent'].limit.context).toBe(262144);
  expect(Object.keys(catalog['k3-agent'].variants)).toEqual(['low', 'max']);
  expect((await p.auth.usage(async () => auth)).windows).toEqual([{name: '会员共享额度', used: 42}]);
  expect(calls.at(-1).init.headers.Authorization).toBe('Bearer ' + session.webToken);
});

test('requests preserve prompts, tools, streaming and cancellation while rotating only Work credentials', async () => {
  let live = {...session}; const calls = [];
  const p = I.createPlugin({readSession: () => live, fetchImpl: async (url, init) => {
    calls.push({url, init}); return new Response('data: [DONE]\n\n', {headers: {'Content-Type': 'text/event-stream'}});
  }});
  const loader = await p.auth.loader(async () => auth);
  const body = JSON.stringify({model: 'k3-agent', messages: [{role: 'system', content: 'synthetic shared instruction'}],
    tools: [{type: 'function', function: {name: 'Read', parameters: {type: 'object'}}}], stream: true});
  const signal = new AbortController().signal;
  const request = new Request(I.BASE + '/chat/completions', {method: 'POST', body, signal,
    headers: {Authorization: 'Bearer synthetic-code-token', Cookie: 'synthetic-cookie'}});
  expect(await (await loader.fetch(request)).text()).toBe('data: [DONE]\n\n');
  expect(await new Response(calls[0].init.body).text()).toBe(body);
  expect(calls[0].init.headers.get('authorization')).toBe('Bearer ' + session.workToken);
  expect(calls[0].init.headers.get('cookie')).toBeNull();
  expect(calls[0].init.signal.aborted).toBe(false);
  live.workToken = 'synthetic-rotated';
  await loader.fetch(I.BASE + '/chat/completions', {method: 'POST', body, signal});
  expect(calls[1].init.headers.get('authorization')).toBe('Bearer synthetic-rotated');
  live.uid = 'different-account';
  await expect(loader.fetch(I.BASE + '/chat/completions', {method: 'POST', body})).rejects.toMatchObject({signIn: 'expired'});
  expect(calls).toHaveLength(2);
});

test('a rejected desktop token requires reconnecting the provider', async () => {
  const p = I.createPlugin({readSession: () => session, fetchImpl: async () => new Response('{}', {status: 401})});
  const loader = await p.auth.loader(async () => auth);
  await expect(loader.fetch(I.BASE + '/chat/completions', {method: 'POST'}))
    .rejects.toMatchObject({signIn: 'expired', code: 'kimi_work_login_expired'});
});

for (const {name, status, body, type} of [
  {name: 'concurrency 429 retains rate-limit wording without adding quota wording', status: 429,
    body: JSON.stringify({error: {type: 'rate_limit_error', code: 'concurrency_limit', message: 'Too many requests'}}), type: 'application/json'},
  {name: 'quota 429 retains the upstream allowance and reset details', status: 429,
    body: JSON.stringify({error: {type: 'quota_exceeded', message: 'Plan quota exhausted', resetsAt: '2030-01-01T00:00:00Z'}}), type: 'application/json'},
  {name: '5xx retains even a non-JSON upstream failure', status: 502, body: 'Bad gateway: upstream unavailable', type: 'text/plain'},
]) test(name, async () => {
  const upstream = new Response(body, {status, statusText: 'Upstream failure', headers: {'Retry-After': '30', 'Content-Type': type}});
  const p = I.createPlugin({readSession: () => session, fetchImpl: async () => upstream});
  const loader = await p.auth.loader(async () => auth);
  const response = await loader.fetch(I.BASE + '/chat/completions', {method: 'POST', body: '{}'});
  expect(response).toBe(upstream);
  expect(response.status).toBe(status);
  expect(response.headers.get('retry-after')).toBe('30');
  expect(response.headers.get('content-type')).toBe(type);
  expect(await response.text()).toBe(body);
});

test('network failures keep diagnostic causes and ordinary fetch messages', async () => {
  for (const error of [Error('fetch failed', {cause: {code: 'ENOTFOUND'}}), Error('proxy connection refused')]) {
    const p = I.createPlugin({readSession: () => session, fetchImpl: async () => {throw error;}});
    const loader = await p.auth.loader(async () => auth);
    await expect(loader.fetch(I.BASE + '/chat/completions', {method: 'POST'})).rejects.toMatchObject({
      code: 'kimi_work_connection_failed', cause: error,
      message: 'Kimi Work 连接失败：' + (error.cause?.code || error.message),
    });
  }
});

test('cancellation keeps the original abort error', async () => {
  const controller = new AbortController(), error = new DOMException('Cancelled', 'AbortError');
  const p = I.createPlugin({readSession: () => session, fetchImpl: async () => {controller.abort(); throw error;}});
  const loader = await p.auth.loader(async () => auth);
  await expect(loader.fetch(I.BASE + '/chat/completions', {method: 'POST', signal: controller.signal})).rejects.toBe(error);
});

test('desktop import is read-only and never substitutes a Code endpoint', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-provider-fixture-'));
  const file = path.join(dir, 'config.json');
  const doc = {credentials: {kimiCode: {apiKey: session.workToken, baseUrl: I.BASE},
    kimiWeb: {accessToken: session.webToken, userId: 'synthetic-user'}}};
  try {
    fs.writeFileSync(file, JSON.stringify(doc)); const before = fs.readFileSync(file);
    expect(I.readDesktop(file).workToken).toBe(session.workToken);
    expect(fs.readFileSync(file)).toEqual(before);
    doc.credentials.kimiCode.baseUrl = 'https://api.kimi.com/coding/v1'; fs.writeFileSync(file, JSON.stringify(doc));
    expect(() => I.readDesktop(file)).toThrow();
  } finally {fs.rmSync(dir, {recursive: true, force: true});}
});

test('the Work token goes only to the official Work chat endpoint', async () => {
  let called = 0;
  const p = I.createPlugin({readSession: () => session, fetchImpl: async () => {called++; return new Response('{}');}});
  const loader = await p.auth.loader(async () => auth);
  for (const url of ['https://example.invalid/coding/v1/chat/completions', I.BASE + '/models',
    I.BASE + '/chat/completions?x=1', 'https://user:pw@agent-gw.kimi.com/coding/v1/chat/completions']) {
    await expect(loader.fetch(url, {method: 'POST', body: '{}'})).rejects.toThrow('仅接受官方');
  }
  await expect(loader.fetch(I.BASE + '/chat/completions', {method: 'GET'})).rejects.toThrow('仅接受官方');
  expect(called).toBe(0);
});
