import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { Collector, REFRESH_STRATEGIES } from '../lib/collector.mjs';
import { cleanup, startGateway, tempDir } from './helpers.mjs';

const quotaRow = (provider, user, extra = {}) => ({
  provider,
  user,
  readAt: '2026-11-13T12:00:00.000Z',
  windows: [{ name: '5h', used: 12, remaining: 88, resetsAt: '2026-11-13T17:00:00.000Z' }],
  ...extra,
});

const quotaAnswer = (rows) => ({ data: rows });

const todayAnswer = {
  calls: 100,
  input: 1000,
  output: 500,
  cache_read: 2000,
  cache_write: 0,
  reasoning: 10,
  errors: 0,
  providerKeys: [
    { id: 'minimax-cn#key', provider: 'minimax-cn', calls: 60, input: 600, output: 300, cache_read: 0, cache_write: 0, errors: 0, reasoning: 0, cost: 1.5 },
  ],
  accounts: [
    { id: 'codex@alpha@example.com', provider: 'codex', account: 'alpha@example.com', calls: 40, input: 400, output: 200, cache_read: 0, cache_write: 0, errors: 0, reasoning: 0, cost: 2 },
  ],
  series: [
    { label: '00', time: '2026-11-13T00:00:00+08:00', calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0 },
    { label: '01', time: '2026-11-13T01:00:00+08:00', calls: 20, input: 200, output: 100, cache_read: 0, cache_write: 0 },
  ],
};

const weekAnswer = {
  calls: 700,
  input: 7000,
  output: 3500,
  cache_read: 0,
  cache_write: 0,
  by: {
    model: [{ id: 'codex/gpt-5', calls: 400, input: 4000, output: 2000, cache_read: 0, cache_write: 0 }],
    provider: [{ id: 'codex', calls: 400, input: 4000, output: 2000, cache_read: 0, cache_write: 0 }],
    agent: [{ id: 'claude', calls: 300, input: 3000, output: 1500, cache_read: 0, cache_write: 0 }],
  },
  series: [
    { label: 'Nov 7', time: '2026-11-07T00:00:00+08:00', calls: 100, input: 1000, output: 500, cache_read: 0, cache_write: 0 },
  ],
};

const collectorFor = (gateway, dir, options = {}) => new Collector({
  upstream: gateway.url,
  magpieDir: dir,
  snapshotFile: path.join(dir, 'snapshot.json'),
  clock: () => Date.now(),
  ...options,
});

let dir;
after(async () => {
  await cleanup(dir);
});

before(async () => {
  dir = await tempDir();
});

test('the kept answer of the quota is used and the plain one is not', async () => {
  const gateway = await startGateway({
    '/v1/magpie/quotas?kept=1': quotaAnswer([quotaRow('codex', 'alpha@example.com')]),
    '/v1/magpie/usage?period=today': todayAnswer,
    '/v1/magpie/usage/requests?period=7d&limit=1': weekAnswer,
  });
  try {
    const collector = collectorFor(gateway, dir);
    await collector.refresh();
    const overview = collector.overview();
    assert.equal(overview.sources.quotas.state, 'ok');
    assert.equal(overview.sources.today.state, 'ok');
    assert.equal(overview.sources.week.state, 'ok');
    assert.equal(gateway.calls.includes('/v1/magpie/quotas'), false);
    assert.equal(gateway.calls.includes('/v1/magpie/usage?period=today'), true);
    // The reading of today is one answer, not one answer per account.
    assert.equal(gateway.calls.some(call => call.includes('period=today&limit=1')), false);
    assert.equal(gateway.calls.some(call => call.includes('account=')), false);
    // The week keeps the answer of the requests, because it is the one that
    // carries the models and the agents.
    assert.equal(gateway.calls.includes('/v1/magpie/usage/requests?period=7d&limit=1'), true);
    assert.equal(overview.usage.week.requests, 700);
    assert.equal(overview.rankings.models[0].id, 'model-1');
    assert.equal(overview.rankings.models[0].totalTokens, 6000);
  } finally {
    await gateway.close();
  }
});

test('a cold start asks the plain answer once', async () => {
  const gateway = await startGateway({
    '/v1/magpie/quotas?kept=1': quotaAnswer([]),
    '/v1/magpie/quotas': quotaAnswer([quotaRow('zhipu', 'beta@example.com')]),
    '/v1/magpie/usage?period=today': todayAnswer,
    '/v1/magpie/usage/requests?period=7d&limit=1': weekAnswer,
  });
  const local = await tempDir();
  try {
    const collector = collectorFor(gateway, local);
    await collector.refresh();
    assert.equal(gateway.calls.filter(call => call === '/v1/magpie/quotas').length, 1);
    const overview = collector.overview();
    assert.equal(overview.sources.quotas.state, 'ok');
    assert.equal(overview.subscriptions.length, 1);
  } finally {
    await gateway.close();
    await cleanup(local);
  }
});

test('the plain answer is asked at most once every half a minute', async () => {
  const gateway = await startGateway({
    '/v1/magpie/quotas?kept=1': quotaAnswer([]),
    '/v1/magpie/quotas': 'broken',
    '/v1/magpie/usage?period=today': todayAnswer,
    '/v1/magpie/usage/requests?period=7d&limit=1': weekAnswer,
  });
  const local = await tempDir();
  try {
    let now = Date.now();
    const collector = collectorFor(gateway, local, { clock: () => now });
    await collector.refresh();
    assert.equal(gateway.calls.filter(call => call === '/v1/magpie/quotas').length, 1);
    // Ten seconds later the plain answer is not asked again.
    now += 10_000;
    await collector.refresh();
    assert.equal(gateway.calls.filter(call => call === '/v1/magpie/quotas').length, 1);
    // Half a minute later it is asked again.
    now += 25_000;
    await collector.refresh();
    assert.equal(gateway.calls.filter(call => call === '/v1/magpie/quotas').length, 2);
  } finally {
    await gateway.close();
    await cleanup(local);
  }
});

test('the plain answer is only a fallback for a cold start', async () => {
  const gateway = await startGateway({
    '/v1/magpie/quotas?kept=1': quotaAnswer([]),
    '/v1/magpie/quotas': quotaAnswer([quotaRow('zhipu', 'beta@example.com')]),
    '/v1/magpie/usage?period=today': todayAnswer,
    '/v1/magpie/usage/requests?period=7d&limit=1': weekAnswer,
  });
  const local = await tempDir();
  try {
    const collector = collectorFor(gateway, local);
    await collector.refresh();
    assert.equal(gateway.calls.filter(call => call === '/v1/magpie/quotas').length, 1);
    // Now that there are numbers of their own, the plain answer is not asked
    // for any more.
    await collector.refresh();
    await collector.refresh();
    assert.equal(gateway.calls.filter(call => call === '/v1/magpie/quotas').length, 1);
  } finally {
    await gateway.close();
    await cleanup(local);
  }
});

test('the usage of an account belongs to that account', async () => {
  const gateway = await startGateway({
    '/v1/magpie/quotas?kept=1': quotaAnswer([
      quotaRow('codex', 'alpha@example.com'),
      quotaRow('codex', 'beta@example.com'),
    ]),
    '/v1/magpie/usage?period=today': todayAnswer,
    '/v1/magpie/usage/requests?period=7d&limit=1': weekAnswer,
  });
  const local = await tempDir();
  try {
    const collector = collectorFor(gateway, local);
    await collector.refresh();
    const cards = collector.overview().subscriptions;
    const first = cards.find(card => card.id === 'codex@alpha');
    const second = cards.find(card => card.id === 'codex@beta');
    assert.ok(first);
    assert.ok(second);
    assert.equal(first.accountUsage.today.requests, 40);
    assert.equal(second.accountUsage, null);
  } finally {
    await gateway.close();
    await cleanup(local);
  }
});

test('two accounts that share a name are never mixed up', async () => {
  const gateway = await startGateway({
    '/v1/magpie/quotas?kept=1': quotaAnswer([
      quotaRow('codex', 'same@one.com'),
      quotaRow('codex', 'same@two.com'),
    ]),
    '/v1/magpie/usage?period=today': {
      ...todayAnswer,
      accounts: [
        { id: 'codex@same@one.com', provider: 'codex', account: 'same@one.com', calls: 40, input: 400, output: 200, cache_read: 0, cache_write: 0 },
      ],
    },
    '/v1/magpie/usage/requests?period=7d&limit=1': weekAnswer,
  });
  const local = await tempDir();
  try {
    const collector = collectorFor(gateway, local);
    await collector.refresh();
    const cards = collector.overview().subscriptions;
    const codex = cards.filter(card => card.provider === 'codex');
    // Two accounts stay two accounts.
    assert.equal(codex.length, 2);
    // And neither of them takes the numbers of the other.
    for (const card of codex) assert.equal(card.accountUsage, null);
  } finally {
    await gateway.close();
    await cleanup(local);
  }
});

test('a broken quota does not touch the reading of today', async () => {
  const gateway = await startGateway({
    '/v1/magpie/quotas?kept=1': 'broken',
    '/v1/magpie/usage?period=today': todayAnswer,
    '/v1/magpie/usage/requests?period=7d&limit=1': weekAnswer,
  });
  const local = await tempDir();
  try {
    const collector = collectorFor(gateway, local);
    await collector.refresh();
    const overview = collector.overview();
    // The quota was never read, so it is not there yet. The reading of today
    // and the week are untouched by it.
    assert.equal(overview.sources.quotas.state, 'unavailable');
    assert.equal(overview.sources.today.state, 'ok');
    assert.equal(overview.sources.week.state, 'ok');
    assert.equal(overview.usage.today.requests, 100);
  } finally {
    await gateway.close();
    await cleanup(local);
  }
});

test('a broken day does not touch the week', async () => {
  const gateway = await startGateway({
    '/v1/magpie/quotas?kept=1': quotaAnswer([quotaRow('codex', 'alpha@example.com')]),
    '/v1/magpie/usage?period=today': 'broken',
    '/v1/magpie/usage/requests?period=7d&limit=1': weekAnswer,
  });
  const local = await tempDir();
  try {
    const collector = collectorFor(gateway, local);
    await collector.refresh();
    const overview = collector.overview();
    assert.equal(overview.sources.today.state, 'unavailable');
    assert.equal(overview.sources.week.state, 'ok');
    assert.equal(overview.sources.quotas.state, 'ok');
  } finally {
    await gateway.close();
    await cleanup(local);
  }
});

test('the numbers of the last good reading stay when the reading fails', async () => {
  let broken = false;
  const gateway = await startGateway({
    '/v1/magpie/quotas?kept=1': () => (broken ? 'broken' : quotaAnswer([quotaRow('codex', 'alpha@example.com')])),
    '/v1/magpie/usage?period=today': todayAnswer,
    '/v1/magpie/usage/requests?period=7d&limit=1': weekAnswer,
  });
  const local = await tempDir();
  try {
    const collector = collectorFor(gateway, local);
    await collector.refresh();
    const first = collector.overview();
    assert.equal(first.subscriptions.length, 1);
    broken = true;
    await collector.refresh();
    const second = collector.overview();
    // The card of the last good reading is still there, marked as old.
    assert.equal(second.subscriptions.length, 1);
    assert.equal(second.sources.quotas.state, 'stale');
  } finally {
    await gateway.close();
    await cleanup(local);
  }
});

test('an old snapshot comes back when the reading takes too long', async () => {
  let broken = false;
  const gateway = await startGateway({
    '/v1/magpie/quotas?kept=1': () => (broken ? 'hang' : quotaAnswer([quotaRow('codex', 'alpha@example.com')])),
    '/v1/magpie/usage?period=today': () => (broken ? 'hang' : todayAnswer),
    '/v1/magpie/usage/requests?period=7d&limit=1': () => (broken ? 'hang' : weekAnswer),
  });
  const local = await tempDir();
  try {
    const collector = collectorFor(gateway, local, { maxWaitMs: 150, ttlMs: 0, requestTimeoutMs: 400 });
    await collector.refresh();
    assert.equal(collector.overview().sources.quotas.state, 'ok');
    broken = true;
    const started = Date.now();
    const overview = await collector.ensureFresh();
    const waited = Date.now() - started;
    // The reader waits a moment, but not for ever.
    assert.ok(waited < 2000, 'the reader must not wait for ever');
    // The numbers of the last good reading come back, marked as old.
    assert.equal(overview.sources.quotas.state, 'stale');
    assert.equal(overview.subscriptions.length, 1);
  } finally {
    await gateway.close();
    await cleanup(local);
  }
});

test('a reading that is exactly at the edge of its life is already old', async () => {
  // The edge of the life of a reading must not depend on the resolution of
  // the clock: with a ttl of zero the reading is old at once, in the same
  // millisecond as the reading itself.
  const gateway = await startGateway({
    '/v1/magpie/quotas?kept=1': quotaAnswer([quotaRow('codex', 'alpha@example.com')]),
    '/v1/magpie/usage?period=today': todayAnswer,
    '/v1/magpie/usage/requests?period=7d&limit=1': weekAnswer,
  });
  const local = await tempDir();
  try {
    const collector = collectorFor(gateway, local, { ttlMs: 0 });
    await collector.refresh();
    assert.equal(collector.fresh(), false, 'a ttl of zero means: old right away');
    const withLife = collectorFor(gateway, local, { ttlMs: 60_000 });
    await withLife.refresh();
    assert.equal(withLife.fresh(), true, 'a reading inside its life is fresh');
  } finally {
    await gateway.close();
    await cleanup(local);
  }
});

test('many readers share one reading', async () => {
  const gateway = await startGateway({
    '/v1/magpie/quotas?kept=1': quotaAnswer([quotaRow('codex', 'alpha@example.com')]),
    '/v1/magpie/usage?period=today': todayAnswer,
    '/v1/magpie/usage/requests?period=7d&limit=1': weekAnswer,
  });
  const local = await tempDir();
  try {
    const collector = collectorFor(gateway, local);
    await Promise.all([collector.refresh(), collector.refresh(), collector.refresh(), collector.refresh()]);
    assert.equal(gateway.calls.filter(call => call === '/v1/magpie/usage?period=today').length, 1);
    assert.equal(gateway.calls.filter(call => call === '/v1/magpie/quotas?kept=1').length, 1);
  } finally {
    await gateway.close();
    await cleanup(local);
  }
});

test('the service slows down when nobody is watching', async () => {
  const now = Date.now();
  const collector = new Collector({ upstream: 'http://127.0.0.1:1', magpieDir: dir, snapshotFile: path.join(dir, 's.json'), clock: () => now });
  // While somebody is watching it reads every minute.
  collector.lastRequestAt = now;
  assert.equal(collector.nextDelay(), REFRESH_STRATEGIES.smart.intervalMs);
  // After ten quiet minutes it reads every five minutes.
  collector.lastRequestAt = now - 11 * 60_000;
  assert.equal(collector.nextDelay(), REFRESH_STRATEGIES.smart.idleIntervalMs);
  // After half an hour of quiet it only looks now and then.
  collector.lastRequestAt = now - 31 * 60_000;
  assert.equal(collector.nextDelay(), REFRESH_STRATEGIES.smart.checkMs);
  // A fixed rhythm does not care about the quiet.
  collector.setStrategy('5m');
  collector.lastRequestAt = now - 31 * 60_000;
  assert.equal(collector.nextDelay(), REFRESH_STRATEGIES['5m'].intervalMs);
  // A rhythm the service does not know falls back to the smart one.
  collector.setStrategy('every day');
  assert.equal(collector.strategy, 'smart');
});

test('an older Magpie is still read', async () => {
  const gateway = await startGateway({
    '/v1/magpie/quotas?kept=1': quotaAnswer([
      quotaRow('codex', 'alpha@example.com'),
      quotaRow('codex', 'beta@example.com'),
    ]),
    // The newer answer is not there.
    '/v1/magpie/usage?period=today': { httpStatus: 404, body: { error: 'not found' } },
    '/v1/magpie/usage/requests?period=today&limit=1': {
      calls: 100,
      input: 1000,
      output: 500,
      cache_read: 2000,
      cache_write: 0,
      by: {
        provider: [{ id: 'codex', calls: 100, input: 1000, output: 500, cache_read: 2000, cache_write: 0 }],
      },
      series: [
        { label: '00', time: '2026-11-13T00:00:00+08:00', calls: 100, input: 1000, output: 500, cache_read: 2000, cache_write: 0 },
      ],
    },
    '/v1/magpie/usage/requests?period=today&limit=1&account=alpha%40example.com': {
      calls: 40, input: 400, output: 200, cache_read: 0, cache_write: 0,
    },
    // The second account is not answered by this older Magpie; it must not
    // take the numbers of the first one with it.
    '/v1/magpie/usage/requests?period=today&limit=1&account=beta%40example.com': 'broken',
    '/v1/magpie/usage/requests?period=7d&limit=1': weekAnswer,
  });
  const local = await tempDir();
  try {
    const collector = collectorFor(gateway, local);
    await collector.refresh();
    const overview = collector.overview();
    // The day is read the old way, and it is read.
    assert.equal(overview.sources.today.state, 'ok');
    assert.equal(overview.usage.today.requests, 100);
    // And every account keeps its own numbers.
    const first = overview.subscriptions.find(card => card.id === 'codex@alpha');
    const second = overview.subscriptions.find(card => card.id === 'codex@beta');
    assert.equal(first.accountUsage.today.requests, 40);
    assert.equal(second.accountUsage, null);
  } finally {
    await gateway.close();
    await cleanup(local);
  }
});

test('the snapshot is written and read back', async () => {
  const gateway = await startGateway({
    '/v1/magpie/quotas?kept=1': quotaAnswer([quotaRow('codex', 'alpha@example.com')]),
    '/v1/magpie/usage?period=today': todayAnswer,
    '/v1/magpie/usage/requests?period=7d&limit=1': weekAnswer,
  });
  const local = await tempDir();
  try {
    const collector = collectorFor(gateway, local);
    await collector.refresh();
    const second = collectorFor(gateway, local);
    await second.load();
    // What was written is read back, and it is marked as old until a fresh
    // reading replaces it.
    assert.equal(second.overview().sources.quotas.state, 'stale');
    assert.equal(second.overview().subscriptions.length, 1);
  } finally {
    await gateway.close();
    await cleanup(local);
  }
});

test('a broken week does not touch the reading of today', async () => {
  const gateway = await startGateway({
    '/v1/magpie/quotas?kept=1': quotaAnswer([quotaRow('codex', 'alpha@example.com')]),
    '/v1/magpie/usage?period=today': todayAnswer,
    '/v1/magpie/usage/requests?period=7d&limit=1': 'broken',
  });
  const local = await tempDir();
  try {
    const collector = collectorFor(gateway, local);
    await collector.refresh();
    const overview = collector.overview();
    assert.equal(overview.sources.week.state, 'unavailable');
    assert.equal(overview.sources.today.state, 'ok');
    assert.equal(overview.sources.quotas.state, 'ok');
  } finally {
    await gateway.close();
    await cleanup(local);
  }
});

test('the whole address of an account never reaches the disk', async () => {
  const gateway = await startGateway({
    '/v1/magpie/quotas?kept=1': quotaAnswer([quotaRow('codex', 'alpha@example.com')]),
    '/v1/magpie/usage?period=today': todayAnswer,
    '/v1/magpie/usage/requests?period=7d&limit=1': weekAnswer,
  });
  const local = await tempDir();
  try {
    const collector = collectorFor(gateway, local);
    await collector.refresh();
    const written = await readFile(path.join(local, 'snapshot.json'), 'utf8');
    assert.equal(written.includes('alpha@example.com'), false);
    // The name of the account is there: the console shows it anyway.
    assert.ok(written.includes('alpha'));
  } finally {
    await gateway.close();
    await cleanup(local);
  }
});

test('the console of the computer counts as activity', async () => {
  // A computer without a phone must not stop reading: the console of the
  // computer is somebody watching the numbers.
  const gateway = await startGateway({
    '/v1/magpie/quotas?kept=1': quotaAnswer([quotaRow('codex', 'alpha@example.com')]),
    '/v1/magpie/usage?period=today': todayAnswer,
    '/v1/magpie/usage/requests?period=7d&limit=1': weekAnswer,
  });
  const local = await tempDir();
  try {
    const collector = collectorFor(gateway, local);
    await collector.refresh();
    // Nobody has asked for anything yet: the service is quiet.
    assert.ok(collector.nextDelay() > 60_000);
    collector.noteActivity();
    assert.equal(collector.nextDelay(), 60_000);
  } finally {
    await gateway.close();
    await cleanup(local);
  }
});

// The difference between an answer that is not there and a moment of trouble.
// Only the first one starts the old way of reading, which asks one answer
// per account.

const legacyTodayAnswer = {
  calls: 100,
  input: 1000,
  output: 500,
  cache_read: 2000,
  cache_write: 0,
  by: { provider: [{ id: 'codex', calls: 100, input: 1000, output: 500, cache_read: 0, cache_write: 0, errors: 0, reasoning: 0, cost: 0 }] },
  series: [{ label: '00', time: '2026-11-13T00:00:00+08:00', calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0 }],
};

test('an answer that is not there (404) starts the old way', async () => {
  const gateway = await startGateway({
    '/v1/magpie/quotas?kept=1': quotaAnswer([quotaRow('codex', 'alpha@example.com')]),
    '/v1/magpie/usage?period=today': { httpStatus: 404, body: { error: 'not found' } },
    '/v1/magpie/usage/requests?period=today&limit=1': legacyTodayAnswer,
    '/v1/magpie/usage/requests?period=today&limit=1&account=alpha%40example.com': { calls: 40, input: 400, output: 200, cache_read: 0, cache_write: 0 },
    '/v1/magpie/usage/requests?period=7d&limit=1': weekAnswer,
  });
  const local = await tempDir();
  try {
    const collector = collectorFor(gateway, local);
    await collector.refresh();
    const overview = collector.overview();
    assert.equal(overview.sources.today.state, 'ok');
    assert.equal(overview.usage.today.requests, 100);
    // The old way was used.
    assert.equal(gateway.calls.some(call => call.includes('period=today&limit=1')), true);
    // And the missing answer is not looked for again.
    await collector.refresh();
    assert.equal(gateway.calls.filter(call => call === '/v1/magpie/usage?period=today').length, 1);
  } finally {
    await gateway.close();
    await cleanup(local);
  }
});

test('an answer that is not allowed (405) starts the old way', async () => {
  const gateway = await startGateway({
    '/v1/magpie/quotas?kept=1': quotaAnswer([quotaRow('codex', 'alpha@example.com')]),
    '/v1/magpie/usage?period=today': { httpStatus: 405, body: { error: 'method not allowed' } },
    '/v1/magpie/usage/requests?period=today&limit=1': legacyTodayAnswer,
    '/v1/magpie/usage/requests?period=7d&limit=1': weekAnswer,
  });
  const local = await tempDir();
  try {
    const collector = collectorFor(gateway, local);
    await collector.refresh();
    assert.equal(collector.overview().sources.today.state, 'ok');
    assert.equal(gateway.calls.some(call => call.includes('period=today&limit=1')), true);
  } finally {
    await gateway.close();
    await cleanup(local);
  }
});

test('a gateway with a moment of trouble does not start the old way', async () => {
  const gateway = await startGateway({
    '/v1/magpie/quotas?kept=1': quotaAnswer([quotaRow('codex', 'alpha@example.com')]),
    '/v1/magpie/usage?period=today': 'broken',
    '/v1/magpie/usage/requests?period=today&limit=1': legacyTodayAnswer,
    '/v1/magpie/usage/requests?period=7d&limit=1': weekAnswer,
  });
  const local = await tempDir();
  try {
    const collector = collectorFor(gateway, local);
    await collector.refresh();
    const overview = collector.overview();
    // The day was not read, and it is not read the old way either.
    assert.equal(overview.sources.today.state, 'unavailable');
    assert.equal(gateway.calls.some(call => call.includes('account=')), false);
    // The other parts are untouched by it.
    assert.equal(overview.sources.week.state, 'ok');
  } finally {
    await gateway.close();
    await cleanup(local);
  }
});

test('a gateway that does not answer at all does not start the old way', async () => {
  const gateway = await startGateway({
    '/v1/magpie/quotas?kept=1': quotaAnswer([quotaRow('codex', 'alpha@example.com')]),
    '/v1/magpie/usage?period=today': 'hang',
    '/v1/magpie/usage/requests?period=today&limit=1': legacyTodayAnswer,
    '/v1/magpie/usage/requests?period=7d&limit=1': weekAnswer,
  });
  const local = await tempDir();
  try {
    const collector = collectorFor(gateway, local, { requestTimeoutMs: 400 });
    await collector.refresh();
    const overview = collector.overview();
    assert.equal(overview.sources.today.state, 'unavailable');
    assert.equal(gateway.calls.some(call => call.includes('account=')), false);
  } finally {
    await gateway.close();
    await cleanup(local);
  }
});

test('the numbers of the last good reading stay when the gateway has a moment of trouble', async () => {
  let broken = false;
  const gateway = await startGateway({
    '/v1/magpie/quotas?kept=1': quotaAnswer([quotaRow('codex', 'alpha@example.com')]),
    '/v1/magpie/usage?period=today': () => (broken ? 'broken' : todayAnswer),
    '/v1/magpie/usage/requests?period=today&limit=1': legacyTodayAnswer,
    '/v1/magpie/usage/requests?period=7d&limit=1': weekAnswer,
  });
  const local = await tempDir();
  try {
    const collector = collectorFor(gateway, local);
    await collector.refresh();
    assert.equal(collector.overview().sources.today.state, 'ok');
    broken = true;
    await collector.refresh();
    const overview = collector.overview();
    // The numbers of the last good reading are still there, marked as old.
    assert.equal(overview.sources.today.state, 'stale');
    assert.equal(overview.usage.today.requests, 100);
    // And the old way was not started.
    assert.equal(gateway.calls.some(call => call.includes('account=')), false);
  } finally {
    await gateway.close();
    await cleanup(local);
  }
});

test('when the old way is gone as well the day is simply not read', async () => {
  const gateway = await startGateway({
    '/v1/magpie/quotas?kept=1': quotaAnswer([quotaRow('codex', 'alpha@example.com')]),
    '/v1/magpie/usage?period=today': { httpStatus: 404, body: { error: 'not found' } },
    '/v1/magpie/usage/requests?period=today&limit=1': { httpStatus: 404, body: { error: 'not found' } },
    '/v1/magpie/usage/requests?period=7d&limit=1': weekAnswer,
  });
  const local = await tempDir();
  try {
    const collector = collectorFor(gateway, local);
    await collector.refresh();
    const overview = collector.overview();
    assert.equal(overview.sources.today.state, 'unavailable');
    assert.equal(overview.sources.week.state, 'ok');
  } finally {
    await gateway.close();
    await cleanup(local);
  }
});

test('a gateway that comes back is asked the newer answer again', async () => {
  let missing = true;
  const gateway = await startGateway({
    '/v1/magpie/quotas?kept=1': quotaAnswer([quotaRow('codex', 'alpha@example.com')]),
    '/v1/magpie/usage?period=today': () => (missing ? { httpStatus: 404, body: { error: 'not found' } } : todayAnswer),
    '/v1/magpie/usage/requests?period=today&limit=1': legacyTodayAnswer,
    '/v1/magpie/usage/requests?period=7d&limit=1': weekAnswer,
  });
  const local = await tempDir();
  try {
    let now = Date.now();
    const collector = collectorFor(gateway, local, { clock: () => now });
    await collector.refresh();
    assert.equal(collector.overview().sources.today.state, 'ok');
    // The gateway is changed under the feet of the service: the newer answer
    // is there now. It is noticed after a while.
    missing = false;
    const legacyCalls = gateway.calls.filter(call => call.includes('period=today&limit=1')).length;
    now += 11 * 60_000;
    await collector.refresh();
    assert.equal(gateway.calls.filter(call => call === '/v1/magpie/usage?period=today').length, 2);
    assert.equal(gateway.calls.filter(call => call.includes('period=today&limit=1')).length, legacyCalls);
    assert.equal(collector.overview().sources.today.state, 'ok');
  } finally {
    await gateway.close();
    await cleanup(local);
  }
});
