import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startServer } from '../lib/server.mjs';

test('persists explicit mappings and rejects conversion before a reference model is selected', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'magpie-credit-test-'));
  const cards = [{ provider: 'workbuddy', user: 'a', balance: '1000 credits' },
    { provider: 'raccoon', user: 'a', balance: '600 credits' }];
  const catalog = [{ id: 'workbuddy', models: [{ id: 'deepseek-v4.1-flash' }] },
    { id: 'raccoon', models: [{ id: 'custom-deepseek' }, { id: 'deepseek-v4.1-flash' }] }];
  const usage = Array.from({ length: 5 }, (_, i) => ({ provider: 'workbuddy', providerAccount: 'a',
    served: 'deepseek-v4.1-flash', t: new Date().toISOString(), status: 200, in: 1_000_000, credits: 50, rid: String(i) }));
  await writeFile(join(dir, 'gateway.json'), JSON.stringify({ addr: '127.0.0.1:3425' }));
  await writeFile(join(dir, 'usage.jsonl'), usage.map(row => JSON.stringify(row)).join('\n'));
  await writeFile(join(dir, 'plugin-providers.json'), JSON.stringify(catalog));
  const originalFetch = globalThis.fetch;
  let service;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (service) await new Promise(resolve => service.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  globalThis.fetch = async (input, init) => {
    if (String(input).includes('/v1/magpie/quotas')) return Response.json({ data: cards });
    return originalFetch(input, init);
  };
  service = await startServer({ configDir: dir, port: 0 });
  service.url = `http://127.0.0.1:${service.server.address().port}`;
  const html = await new Promise((resolve, reject) => {
    const req = request(`${service.url}/`, { headers: { 'sec-fetch-mode': 'navigate' } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve(text));
    });
    req.on('error', reject);
    req.end();
  });
  const key = html.match(/name="credit-key" content="([^"]+)"/)[1];
  const headers = { 'content-type': 'application/json', 'x-magpie-credit-key': key };
  const get = () => fetch(`${service.url}/api/report`, { headers }).then(response => response.json());
  const post = body => fetch(`${service.url}/api/preference`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await get()).providers[1].equivalent, null);
  assert.equal((await post({ kind: 'mapping', provider: 'raccoon', value: 'custom-deepseek' })).status, 400);
  assert.equal((await post({ kind: 'baseModel', value: 'deepseek-v4.1-flash' })).status, 200);
  assert.equal((await post({ kind: 'rate', provider: 'raccoon', model: 'custom-deepseek', period: 'recent', value: 100 })).status, 200);
  const mapped = await post({ kind: 'mapping', provider: 'raccoon', value: 'custom-deepseek' });
  const mapping = await mapped.json();
  assert.ok(mapped.ok, JSON.stringify(mapping));
  assert.equal(mapping.providers[1].equivalent, 300);
  assert.equal((await post({ kind: 'mapping', provider: 'raccoon', value: null })).status, 200);
  assert.equal((await get()).providers[1].equivalent, null);
  assert.equal((await post({ kind: 'mapping', provider: 'raccoon', value: 'custom-deepseek' })).status, 200);
  assert.equal((await get()).providers[1].equivalent, 300);
  assert.equal((await post({ kind: 'mapping', provider: 'raccoon', value: ['custom-deepseek'] })).status, 200);
  assert.deepEqual((await get()).providers[1].selectedBridges, ['custom-deepseek']);
  assert.equal((await post({ kind: 'mapping', provider: 'raccoon', value: ['missing-model'] })).status, 400);
  assert.equal((await post({ kind: 'mapping', provider: 'raccoon', value: [] })).status, 200);
  assert.equal((await get()).providers[1].equivalent, null);
  assert.equal((await post({ kind: 'mapping', provider: 'raccoon', value: ['custom-deepseek'] })).status, 200);
  assert.equal((await post({ kind: 'matchModels', provider: 'raccoon', value: 'deepseek-v4.1-flash' })).status, 400);
  assert.equal((await post({ kind: 'matchModels', provider: 'workbuddy', value: 'deepseek-v4.1-flash' })).status, 200);
  assert.deepEqual((await get()).providers[1].selectedBridges, ['custom-deepseek']);
  assert.equal((await post({ kind: 'mapping', provider: 'raccoon', value: null })).status, 200);
  assert.equal((await post({ kind: 'matchModels', provider: 'workbuddy', value: 'deepseek-v4.1-flash' })).status, 200);
  assert.deepEqual((await get()).providers[1].selectedBridges, ['deepseek-v4.1-flash']);
  assert.equal((await fetch(`${service.url}/api/report`)).status, 401);
  assert.equal((await get()).providers[0].spend['24h'].total, 250);
  assert.equal((await post({ kind: 'spendWindow', value: '30d' })).status, 200);
  assert.equal((await get()).spendWindow, '30d');
  assert.equal((await post({ kind: 'spendWindow', value: 'bad' })).status, 400);
  // Disabling a provider must persist as an explicit false, not revert to
  // the default-enabled state when the key is removed.
  assert.equal((await post({ kind: 'enabled', provider: 'raccoon', value: false })).status, 200);
  assert.equal((await get()).providers[1].enabled, false);
  assert.equal((await post({ kind: 'enabled', provider: 'raccoon', value: true })).status, 200);
  assert.equal((await get()).providers[1].enabled, true);
  // Token-view alias selection is keyed by the target model and an empty list
  // must persist as an explicit "none" rather than reverting to a default.
  assert.equal((await post({ kind: 'model', value: 'deepseek-v4.1-flash' })).status, 200);
  assert.equal((await post({ kind: 'tokenMapping', provider: 'raccoon', value: ['custom-deepseek'] })).status, 200);
  assert.deepEqual((await get()).providers[1].tokenBridges, ['custom-deepseek']);
  assert.equal((await post({ kind: 'tokenMapping', provider: 'raccoon', value: [] })).status, 200);
  assert.deepEqual((await get()).providers[1].tokenBridges, []);
  assert.equal((await post({ kind: 'tokenMapping', provider: 'raccoon', value: ['missing-model'] })).status, 400);
});
