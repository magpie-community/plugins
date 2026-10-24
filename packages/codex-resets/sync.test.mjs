import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncOnce } from './sync-core.mjs';
const now = Date.parse('2026-10-23T08:00:00Z');
const payload = () => ({ meta: { api_version: 'v1', generated_at: new Date(now).toISOString() },
  data: { scheduled_reset: null, latest_reset: null, active_watch: null } });
test('explicit sync fetches only the public endpoint and publishes into this plugin options', async () => {
  let saved, requests = [];
  const result = await syncOnce({ now, options: { custom: 'kept' },
    request: async (url, init) => { requests.push([url, init]); return new Response(JSON.stringify(payload())); },
    save: async options => { saved = options; },
  });
  assert.equal(requests[0]?.[0], 'https://codex-resets.com/api/v1/status');
  assert.equal(requests[0][1].redirect, 'error');
  assert.equal(saved?.custom, 'kept');
  assert.equal(saved?.codexResets?.version, 1);
  assert.equal(result.changed, true);
});

test('cooldown is persisted across invocations and never bypassed by Refresh page', async () => {
  let saved, calls = 0;
  const request = async () => { calls++; return new Response(JSON.stringify(payload())); };
  await syncOnce({ now, options: {}, request, save: o => { saved = o; } });
  const result = await syncOnce({ now: now + 299999, options: saved, request, save: () => assert.fail('should not write during cooldown') });
  assert.equal(result.changed, false); assert.equal(calls, 1);
});
test('HTTP failures respect Retry-After and clear unverifiable data', async () => {
  let saved;
  const r = await syncOnce({ now, options: { codexResets: { payload: payload() } },
    request: async () => new Response('rate limited', { status: 429, headers: { 'Retry-After': '3600' } }), save: o => { saved = o; } });
  assert.equal(r.nextCheckAt, now + 3600e3); assert.ok(r.error);
  assert.equal(saved.codexResets.payload, null);
});
test('malformed, oversized and stale responses cannot become current data', async () => {
  const stale = payload(); stale.meta.generated_at = '2020-01-01T00:00:00Z';
  for (const body of ['{}', 'oops', 'a'.repeat(65537), JSON.stringify(stale)]) {
    let saved;
    const r = await syncOnce({ now, options: {}, request: async () => new Response(body), save: o => { saved = o; } });
    assert.ok(r.error); assert.equal(saved.codexResets.payload, null); assert.equal(r.notice, null);
  }
});
test('network failure is visible and failed publication is not reported as a success', async () => {
  let saved;
  const r = await syncOnce({ now, options: {}, request: async () => { throw new Error('offline'); }, save: o => { saved = o; } });
  assert.ok(r.error); assert.ok(saved.codexResets.error);
  await assert.rejects(() => syncOnce({ now, request: async () => new Response(JSON.stringify(payload())), save: () => { throw new Error('cannot save'); } }), /cannot save/);
});
test('only a new explicit reset announcement produces a terminal notice; forecasts and grants do not', async () => {
  const f = payload();
  f.data.scheduled_reset = { id: '123', reset_type: 'regular', status: 'scheduled', announced_at: '2026-10-23T07:00:00Z', scheduled_for: '2026-10-23T10:00:00Z', source: { type: 'x_post', author: 'thsottiaux', url: 'https://x.com/thsottiaux/status/123' } };
  let saved;
  const request = async () => new Response(JSON.stringify(f));
  const one = await syncOnce({ now, request, save: o => { saved = o; } }); assert.equal(one.notice.id, '123');
  const two = await syncOnce({ now: now + 300001, options: saved, request, save: o => { saved = o; } }); assert.equal(two.notice, null);
  f.data.scheduled_reset.reset_type = 'banked';
  const grant = await syncOnce({ now, request, save: () => {} }); assert.equal(grant.notice, null);
  f.data.scheduled_reset.reset_type = 'regular'; f.data.scheduled_reset.scheduled_for = '2026-10-23T07:59:00Z';
  const past = await syncOnce({ now, request, save: () => {} }); assert.equal(past.notice, null);
});
test('extra response fields are not persisted', async () => {
  const f = payload(); f.unneeded = 'extra'; f.data.extra = 'extra'; let saved;
  await syncOnce({ now, request: async () => new Response(JSON.stringify(f)), save: o => { saved = o; } });
  assert.deepEqual(Object.keys(saved.codexResets.payload).sort(), ['data', 'meta']);
  assert.equal(saved.codexResets.payload.data.extra, undefined);
});
