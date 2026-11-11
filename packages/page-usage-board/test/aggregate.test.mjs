import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateAttribution } from '../server.mjs';

const now = new Date();
const iso = (msAgo) => new Date(now.getTime() - msAgo).toISOString();

test('filters attribution by caller but keeps the caller breakdown', async () => {
  const rows = [
    { t: iso(0), callerKeyName: 'cloud', provider: 'codearts', providerAccount: 'a', in: 10, out: 5, cache_read: 1, status: 200, ttft_ms: 100, ms: 200 },
    { t: iso(2 * 3600e3), callerKeyName: 'Magpie', provider: 'trae-cn', providerAccount: 'b', in: 20, out: 10, status: 500, ttft_ms: 0, ms: 0 },
    { t: iso(0), callerKeyName: 'hermes', provider: 'nvidia', providerAccount: 'c', in: 1, out: 1, status: 200, ttft_ms: 50, ms: 60 },
    { t: iso(10 * 86400e3), callerKeyName: 'cloud', provider: 'old-provider', providerAccount: 'd', in: 1, out: 1, status: 200, ttft_ms: 10, ms: 10 },
  ];
  const d = await aggregateAttribution(rows, { period: '7d', days: 7, callers: ['cloud', 'Magpie'], source: 'remote' });

  assert.equal(d.source, 'remote');
  assert.deepEqual(d.callers, ['cloud', 'Magpie']);
  assert.equal(d.totals.calls, 2);
  assert.equal(d.totals.errors, 1);
  assert.equal(d.totals.input, 30);
  assert.equal(d.totals.output, 15);
  assert.deepEqual(d.providers.map((p) => p.provider).sort(), ['codearts', 'trae-cn']);
  assert.deepEqual(d.accounts.map((a) => a.account).sort(), ['a', 'b']);
  // hermes is excluded from the device's charts but still shown in the caller breakdown
  assert.deepEqual(d.callerBreakdown.map((c) => c.name).sort(), ['Magpie', 'cloud', 'hermes']);
  assert.equal(d.callerBreakdown.find((c) => c.name === 'hermes').calls, 1);
  // 10 days old is outside a 7-day window
  assert.equal(d.providers.some((p) => p.provider === 'old-provider'), false);
  // hourly is caller-filtered too (2 calls: cloud + Magpie, not hermes); rows are {hour, r:{...}}
  assert.equal(d.hourly.reduce((s, h) => s + h.r.calls, 0), 2);
  assert.ok(d.days.length >= 1);
});

test('local source is marked so the page can hide remote cards', async () => {
  const d = await aggregateAttribution([], { period: '7d', days: 7, callers: [], source: 'local' });
  assert.equal(d.source, 'local');
  assert.equal(d.totals.calls, 0);
});
