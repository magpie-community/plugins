import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReport, cardBalance, modelId } from '../lib/report.mjs';
import { pricingRule, sampleMultiplier } from '../lib/pricing.mjs';

const now = Date.parse('2026-11-17T23:00:00+08:00');
const card = (provider, balance, user = 'account') => ({ provider, user, balance: `${balance} credits` });
const catalogEntry = (id, ...models) => ({ id, models: models.map(id => ({ id })) });
const sample = (provider, served, credits, i, t = new Date(now).toISOString()) => ({ provider, providerAccount: 'account',
  model: 'auto', served, t, status: 200, in: 300_000, out: 100_000, cache_read: 600_000, reasoning: 40_000,
  credits, rid: `${provider}/${served}/${i}` });

test('requires an exact reference model and explicit source mappings before converting balances', () => {
  const cards = [card('workbuddy', 1000), card('workbuddy-ai', 600), card('catpaw', 900), card('autoclaw', 700)];
  const catalog = [catalogEntry('workbuddy', 'deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017'),
    catalogEntry('workbuddy-ai', 'deepseek-v4.1-flash-sg'), catalogEntry('catpaw', 'glm-5.3-flash')];
  const usage = Array.from({ length: 5 }, (_, i) => [sample('workbuddy', 'deepseek-v4.1-flash', 50, i),
    sample('workbuddy-ai', 'deepseek-v4.1-flash-sg', 100, i), sample('workbuddy', 'glm-5.3-flash', 150, i)]).flat();
  usage.push({ ...usage[0], credits: 10_000 }); // replayed request id
  const preferences = { baseModel: 'deepseek-v4.1-flash',
    mappings: { workbuddy: { 'deepseek-v4.1-flash': { 'workbuddy-ai': 'deepseek-v4.1-flash' } } },
    rates: { catpaw: { 'glm-5.3-flash': { recent: 300 } } } };
  const report = buildReport({ cards, catalog, usage, preferences, now });
  assert.deepEqual(report.providers.map(p => p.equivalent), [1000, 300, null, null]);
  assert.deepEqual(report.providers.map(p => p.bridge), ['deepseek-v4.1-flash', 'deepseek-v4.1-flash', null, null]);
  assert.equal(buildReport({ cards, catalog, usage, now }).providers.every(p => p.equivalent === null), true);
  assert.equal(report.providers.reduce((sum, p) => sum + p.balance, 0), 3200);
  assert.equal(report.providers[0].models['deepseek-v4.1-flash'].tokens, 20_000_000);
});

test('lets the user confirm differently named models and keeps mappings scoped to the reference SKU', () => {
  const cards = [card('workbuddy', 1000), card('raccoon', 600)];
  const catalog = [catalogEntry('workbuddy', 'deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017'),
    catalogEntry('raccoon', 'sn-deepseek-v4-1-flash-1017', 'custom-deepseek')];
  const usage = Array.from({ length: 5 }, (_, i) => sample('workbuddy', 'deepseek-v4.1-flash', 50, i));
  const preferences = { baseModel: 'deepseek-v4.1-flash', rates: { raccoon: { 'custom-deepseek': { recent: 100 } } },
    mappings: { workbuddy: {
      'deepseek-v4.1-flash': { raccoon: 'custom-deepseek' },
      'deepseek-v4.1-flash-1017': { raccoon: 'sn-deepseek-v4-1-flash-1017' },
    } } };
  const report = buildReport({ cards, catalog, usage, preferences, now });
  assert.equal(report.providers[1].bridge, 'custom-deepseek');
  assert.equal(report.providers[1].equivalent, 300);
  assert.deepEqual(report.providers[1].shared, []);
  const other = buildReport({ cards, catalog, usage, now,
    preferences: { ...preferences, baseModel: 'deepseek-v4.1-flash-1017' } });
  assert.equal(other.providers[1].bridge, 'deepseek-v4.1-flash-1017');
  assert.equal(other.providers[1].equivalent, null);
});

test('aggregates multiple user-selected DeepSeek aliases against one provider balance', () => {
  const cards = [card('workbuddy', 1000), card('custom', 1000)];
  const catalog = [
    catalogEntry('workbuddy', 'deepseek-v4.1-flash'),
    catalogEntry('custom', 'deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017'),
  ];
  const usage = [
    ...Array.from({ length: 5 }, (_, i) => sample('workbuddy', 'deepseek-v4.1-flash', 50, i)),
    ...Array.from({ length: 3 }, (_, i) => sample('custom', 'deepseek-v4.1-flash', 30, i)),
    ...Array.from({ length: 1 }, (_, i) => sample('custom', 'deepseek-v4.1-flash-1017', 60, i)),
  ];
  const preferences = {
    baseModel: 'deepseek-v4.1-flash',
    mappings: { workbuddy: { 'deepseek-v4.1-flash': {
      custom: ['deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017'],
    } } },
    rates: { custom: {
      'deepseek-v4.1-flash': { recent: 100 },
      'deepseek-v4.1-flash-1017': { recent: 200 },
    } },
  };
  const report = buildReport({ cards, catalog, usage, preferences, now });
  const custom = report.providers[1];
  assert.deepEqual(custom.selectedBridges, ['deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017']);
  assert.equal(custom.aggregate.rate.value, 125);
  assert.equal(custom.aggregate.tokens, 8_000_000);
  assert.equal(custom.equivalent, 400);
});

test('uses recent usage weights while converting with the selected peak rate', () => {
  const cards = [card('workbuddy', 1000), card('custom', 1000)];
  const catalog = [
    catalogEntry('workbuddy', 'deepseek-v4.1-flash'),
    catalogEntry('custom', 'deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017'),
  ];
  const usage = [
    ...Array.from({ length: 5 }, (_, i) => sample('workbuddy', 'deepseek-v4.1-flash', 50, i)),
    ...Array.from({ length: 3 }, (_, i) => sample('custom', 'deepseek-v4.1-flash', 30, i)),
    ...Array.from({ length: 1 }, (_, i) => sample('custom', 'deepseek-v4.1-flash-1017', 60, i)),
  ];
  const preferences = {
    period: 'peak', baseModel: 'deepseek-v4.1-flash',
    mappings: { workbuddy: { 'deepseek-v4.1-flash': {
      custom: ['deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017'],
    } } },
    rates: { custom: {
      'deepseek-v4.1-flash': { peak: 100 },
      'deepseek-v4.1-flash-1017': { peak: 200 },
    } },
  };
  const report = buildReport({ cards, catalog, usage, preferences, now });
  const custom = report.providers[1];
  assert.equal(custom.aggregate.rate.value, 125);
  assert.equal(custom.aggregate.tokens, 8_000_000);
  assert.equal(custom.equivalent, 400);
});

test('marks a multi-model aggregate partial when a selected alias has no usable rate', () => {
  const cards = [card('workbuddy', 1000), card('custom', 1000)];
  const catalog = [
    catalogEntry('workbuddy', 'deepseek-v4.1-flash'),
    catalogEntry('custom', 'deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017'),
  ];
  const usage = Array.from({ length: 5 }, (_, i) => sample('workbuddy', 'deepseek-v4.1-flash', 50, i));
  const preferences = {
    period: 'peak',
    baseModel: 'deepseek-v4.1-flash',
    mappings: { workbuddy: { 'deepseek-v4.1-flash': {
      custom: ['deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017'],
    } } },
    rates: { custom: { 'deepseek-v4.1-flash': { peak: 100 } } },
  };
  const report = buildReport({ cards, catalog, usage, preferences, now });
  const custom = report.providers[1];
  assert.equal(custom.aggregate.tokens, 10_000_000);
  assert.equal(custom.aggregate.status, 'partial');
  assert.deepEqual(custom.aggregate.models, ['deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017']);
});

test('counts totals only once; recognizes balance-only providers, credits packs and unreadable cards', () => {
  const w = (name, limit, amount) => ({ name, limit, amount, unit: 'credits' });
  assert.equal(cardBalance({ provider: 'workbuddy', windows: [w('Credits', 500), w('Extra credits', 1200, 700),
    w('Total credits', 1700, 700)] }, now), 1000);
  assert.equal(cardBalance({ provider: 'raccoon', windows: [w('Daily pool', 100, 20), w('Credits', 500, 30)] }, now), 470);
  assert.equal(cardBalance({ provider: 'autoclaw', balance: '22,146 积分' }, now), 22146);
  assert.equal(cardBalance({ provider: 'catpaw', windows: [{ name: '可用积分', display: '328.91 credit' }] }, now), 328.91);
  assert.equal(cardBalance({ provider: 'qoder', windows: [w('act-20261111-133', 500), w('Add-on credits', 80, 10)] }, now), 570);
  assert.equal(cardBalance({ provider: 'minimax-code', error: 'expired', balance: '11 credits' }, now), null);
});

test('preserves exact model variants and confirms a missing catalog through successful served-model history', () => {
  assert.equal(modelId('raccoon', 'sn-deepseek-v4-1-flash-1017'), 'deepseek-v4.1-flash-1017');
  assert.notEqual(modelId('trae-cn', 'deepseek-v4.1-flash-max'), modelId('codearts', 'deepseek-v4.1-flash'));
  for (const id of ['explore_sub_agent_v2', 'file_search_agent', 'search_agent_qwen_fast-0710']) {
    assert.equal(modelId('trae-cn', id), '');
  }
  const report = buildReport({ cards: [card('workbuddy', 500), card('catpaw', 100)], catalog: [], now,
    usage: [sample('catpaw', 'GLM-5.3-Flash', undefined, 0), { ...sample('catpaw', 'MiniMax-M3', 1, 1), status: 429 }] });
  assert.deepEqual(report.models.map(x => x.id), ['glm-5.3-flash']);
  assert.equal(report.providers[1].models['glm-5.3-flash'].eligible, 1);
  assert.equal(report.providers[1].equivalent, null);
});

test('CodeArts manuals and TRAE weekday rules compute offpeak independently of recent averages', () => {
  const cards = [card('codearts', 1000)];
  const catalog = [catalogEntry('codearts', 'deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017')];
  const rates = { codearts: { 'deepseek-v4.1-flash': { peak: 100 }, 'deepseek-v4.1-flash-1017': { peak: 150 } } };
  const report = buildReport({ cards, catalog, now, usage: [], preferences: { period: 'offpeak', rates } });
  assert.equal(report.providers[0].models['deepseek-v4.1-flash'].tokens, 20_000_000);
  assert.equal(report.providers[0].models['deepseek-v4.1-flash-1017'].tokens, 10_000_000);
  const rule = pricingRule('trae-cn', 'deepseek-v4.1-flash');
  const at = t => sampleMultiplier(rule, Date.parse(`${t}+08:00`));
  assert.equal(at('2026-11-17T08:59:59'), 0.06);
  assert.equal(at('2026-11-17T09:00:00'), 0.12);
  assert.equal(at('2026-11-17T12:00:00'), 0.06);
  assert.equal(at('2026-11-17T14:00:00'), 0.12);
  assert.equal(at('2026-11-21T15:00:00'), 0.06);
  assert.equal(at('2026-11-16T11:00:00'), null);
});

test('uses a recent average only when the selected period has no special time rule', () => {
  const cards = [card('workbuddy', 200)];
  const catalog = [catalogEntry('workbuddy', 'kimi-k3.1-pro')];
  const usage = Array.from({ length: 5 }, (_, i) => sample('workbuddy', 'kimi-k3.1-pro', 50, i));
  const report = buildReport({ cards, catalog, usage, now, preferences: { period: 'offpeak' } });
  assert.equal(report.providers[0].models['kimi-k3.1-pro'].offpeak.tokens, 4_000_000);
});

test('uses rolling 24 hours and aligns longer windows to Beijing counter days', () => {
  const cards = [card('workbuddy', 1000), card('raccoon', 500)];
  const catalog = [catalogEntry('workbuddy', 'deepseek-v4.1-flash', 'glm-5.3-flash'),
    catalogEntry('raccoon', 'sn-qwen4-max')];
  const at = hours => new Date(now - hours * 3_600_000).toISOString();
  const row = (provider, served, credits, hours, rid, extra = {}) => ({ provider, providerAccount: 'account',
    model: 'auto', served, t: at(hours), status: 200, in: 100, out: 50, credits, rid, ...extra });
  const usage = [
    row('workbuddy', 'deepseek-v4.1-flash', 10, 1, 'w1'),
    row('workbuddy', 'deepseek-v4.1-flash', 10, 1, 'w1'),
    row('workbuddy', 'glm-5.3-flash', 5, 30, 'w2'),
    row('workbuddy', 'deepseek-v4.1-flash', 7, 24 * 6, 'w3'),
    row('workbuddy', 'deepseek-v4.1-flash', 1, 24 * 6 + 23.5, 'outside-7d'),
    row('workbuddy', 'deepseek-v4.1-flash', 9, 24 * 20, 'w4'),
    row('workbuddy', 'deepseek-v4.1-flash', 100, 24 * 31, 'w5'),
    row('workbuddy', 'deepseek-v4.1-flash', 50, 2, 'w6', { status: 429 }),
    row('workbuddy', 'deepseek-v4.1-flash', 60, 2, 'w7', { source: 'other' }),
    row('raccoon', 'sn-qwen4-max', 3, 2, 'r1'),
  ];
  const report = buildReport({ cards, catalog, usage, now, preferences: { spendWindow: '7d' } });
  const spend = report.providers[0].spend;
  assert.equal(report.spendWindow, '7d');
  assert.equal(spend['24h'].total, 10);
  assert.equal(spend['7d'].total, 22);
  assert.equal(spend['30d'].total, 32);
  assert.deepEqual(spend['24h'].models.map(({ id, name, credits }) => ({ id, name, credits })),
    [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash', credits: 10 }]);
  assert.deepEqual(spend['7d'].models.map(m => [m.id, m.credits]),
    [['deepseek-v4.1-flash', 17], ['glm-5.3-flash', 5]]);
  assert.equal(report.providers[1].spend['24h'].total, 3);
  assert.equal(report.providers[1].spend['30d'].models[0].id, 'sn-qwen4-max');
});

test('estimates only unpriced requests when a model has a mix of priced and unpriced calls', () => {
  const cards = [card('workbuddy', 1000)];
  const catalog = [{ id: 'workbuddy', models: [{ id: 'deepseek-v4.1-flash', rate: 0.11 }] }];
  const usage = [
    ...Array.from({ length: 5 }, (_, i) => sample('workbuddy', 'deepseek-v4.1-flash', 50, i)),
    sample('workbuddy', 'deepseek-v4.1-flash', undefined, 5),
  ];
  const report = buildReport({ cards, catalog, usage, now });
  const model = report.providers[0].spend['24h'].models[0];
  assert.equal(model.actual, 250);
  assert.equal(model.priced, 5);
  assert.equal(model.unpriced, 1);
  assert.ok(model.estimated > 0);
  assert.ok(report.providers[0].spend['24h'].total > model.actual);
});

test('estimates spend when Magpie omits credits and excludes disabled providers', () => {
  const cards = [card('workbuddy', 1000), card('codearts', 900)];
  const catalog = [{ id: 'workbuddy', models: [{ id: 'deepseek-v4.1-flash', rate: 0.11 }] },
    { id: 'codearts', models: [{ id: 'deepseek-v4.1-flash', rate: 0.09 }] }];
  const usage = [
    ...Array.from({ length: 5 }, (_, i) => sample('workbuddy', 'deepseek-v4.1-flash', 50, i)),
    ...Array.from({ length: 2 }, (_, i) => ({ ...sample('codearts', 'deepseek-v4.1-flash', undefined, i),
      providerAccount: 'codearts-account' })),
  ];
  cards[1].user = 'codearts-account';
  const report = buildReport({ cards, catalog, usage, now,
    preferences: { enabled: { codearts: false }, period: 'offpeak',
      rates: { codearts: { 'deepseek-v4.1-flash': { peak: 50 } } } } });
  const codearts = report.providers.find(p => p.id === 'codearts');
  assert.equal(codearts.enabled, false);
  assert.equal(codearts.spend['24h'].actual, 0);
  assert.equal(codearts.spend['24h'].estimated, 50);
  assert.equal(codearts.models['deepseek-v4.1-flash'].offpeak.tokens, 36_000_000);
});

test('counts absolute credit counters from credits-daily, deduplicating component packs', () => {
  const cards = [card('codearts', 900, 'codearts-account')];
  const catalog = [catalogEntry('codearts', 'deepseek-v4.1-flash')];
  // Real CodeArts shape: 总积分 already includes 基础/赠送 packs; days are
  // absolute per-day spend, so recharges and gifts never count as spend.
  const dailyCredits = {
    'codearts|codearts-account|总积分': { since: '2026-10-27',
      last: { used: 8967, total: 12000, at: new Date(now).toISOString() },
      days: { '2026-11-12': 842.85, '2026-11-13': 214.96, '2026-11-14': 2509.84,
        '2026-11-15': 312.24, '2026-11-16': 4801.63, '2026-11-17': 285.48 } },
    'codearts|codearts-account|基础积分包': { since: '2026-11-12',
      last: { used: 500, total: 500, at: new Date(now).toISOString() },
      days: { '2026-11-16': 500 } },
    'codearts|codearts-account|赠送积分包': { since: '2026-11-12',
      last: { used: 8467, total: 11500, at: new Date(now).toISOString() },
      days: { '2026-11-12': 842.85, '2026-11-16': 4301.63 } },
  };
  const report = buildReport({ cards, catalog, dailyCredits, now, usage: [] });
  const spend = report.providers[0].spend;
  assert.ok(Math.abs(spend['30d'].total - 8967) < 1e-6);
  assert.ok(Math.abs(spend['7d'].total - 8967) < 1e-6);
  assert.equal(spend['30d'].basis, 'counter-partial');
  assert.equal(spend['7d'].basis, 'counter');
  assert.ok(Math.abs(spend['30d'].actual - 8967) < 1e-6);
  // Today (11-17 Beijing) contributes to the rolling 24-hour floor.
  assert.ok(Math.abs(spend['24h'].total - 285.48) < 1e-6);
});

test('never reports model-estimated spend below measured counter deltas', () => {
  const cards = [card('codearts', 900, 'codearts-account')];
  const catalog = [{ id: 'codearts', models: [{ id: 'deepseek-v4.1-flash', rate: 0.09 }] }];
  const usage = Array.from({ length: 2 }, (_, i) => ({ ...sample('codearts', 'deepseek-v4.1-flash', undefined, i),
    providerAccount: 'codearts-account' }));
  const readings = { '["codearts","codearts-account"]': [
    { at: now - 4 * 3_600_000, counters: { 总积分: { used: 100, limit: 1000, reset: null } } },
    { at: now - 3 * 3_600_000, counters: { 总积分: { used: 103.12, limit: 1000, reset: null } } },
  ] };
  const report = buildReport({ cards, catalog, usage, creditReadings: readings, now,
    preferences: { period: 'peak', rates: { codearts: { 'deepseek-v4.1-flash': { peak: 0.18 } } } } });
  const bucket = report.providers[0].spend['24h'];
  // The 0.18/M peak rate becomes 0.09/M offpeak × 2M tokens = 0.18; the
  // measured 3.12 counter delta is the floor and is never reduced.
  assert.ok(Math.abs(bucket.actual - 3.12) < 1e-9);
  assert.ok(bucket.total >= bucket.actual);
  assert.ok(Math.abs(bucket.total - 3.12) < 1e-6);
  assert.ok(Math.abs(bucket.models[0].credits - 0.18) < 1e-6);
  assert.ok(Math.abs(bucket.unallocated - 2.94) < 1e-6);
  assert.equal(bucket.basis, 'snapshot');
});

test('allocates authoritative counters inside each account before blending models', () => {
  const cards = [card('custom', 1000, 'a1'), card('custom', 1000, 'a2')];
  const catalog = [{ id: 'custom', models: [
    { id: 'deepseek-v4.1-flash', rate: 1 },
    { id: 'kimi-k3.1-pro', rate: 10 },
  ] }];
  const row = (account, served, rid) => ({ provider: 'custom', providerAccount: account,
    model: 'auto', served, t: new Date(now).toISOString(), status: 200,
    in: 1_000_000, out: 0, cache_read: 0, cache_write: 0, rid });
  const usage = [
    row('a1', 'deepseek-v4.1-flash', 'a1-deep'),
    row('a1', 'kimi-k3.1-pro', 'a1-kimi-1'),
    row('a1', 'kimi-k3.1-pro', 'a1-kimi-2'),
    row('a1', 'kimi-k3.1-pro', 'a1-kimi-3'),
    row('a1', 'kimi-k3.1-pro', 'a1-kimi-4'),
    row('a1', 'kimi-k3.1-pro', 'a1-kimi-5'),
    row('a1', 'kimi-k3.1-pro', 'a1-kimi-6'),
    row('a1', 'kimi-k3.1-pro', 'a1-kimi-7'),
    row('a1', 'kimi-k3.1-pro', 'a1-kimi-8'),
    row('a1', 'kimi-k3.1-pro', 'a1-kimi-9'),
    row('a2', 'deepseek-v4.1-flash', 'a2-deep-1'),
    row('a2', 'deepseek-v4.1-flash', 'a2-deep-2'),
    row('a2', 'deepseek-v4.1-flash', 'a2-deep-3'),
    row('a2', 'deepseek-v4.1-flash', 'a2-deep-4'),
    row('a2', 'deepseek-v4.1-flash', 'a2-deep-5'),
    row('a2', 'deepseek-v4.1-flash', 'a2-deep-6'),
    row('a2', 'deepseek-v4.1-flash', 'a2-deep-7'),
    row('a2', 'deepseek-v4.1-flash', 'a2-deep-8'),
    row('a2', 'deepseek-v4.1-flash', 'a2-deep-9'),
    row('a2', 'kimi-k3.1-pro', 'a2-kimi'),
  ];
  const dailyCredits = {
    'custom|a1|总积分': { since: '2026-11-17', last: { used: 91, total: 1000, at: new Date(now).toISOString() },
      days: { '2026-11-17': 91 } },
    'custom|a2|总积分': { since: '2026-11-17', last: { used: 10, total: 1000, at: new Date(now).toISOString() },
      days: { '2026-11-17': 10 } },
  };
  const report = buildReport({ cards, catalog, usage, dailyCredits, now,
    preferences: { period: 'peak', rates: { custom: {
      'deepseek-v4.1-flash': { peak: 1 }, 'kimi-k3.1-pro': { peak: 10 },
    } } } });
  const bucket = report.providers[0].spend['24h'];
  const deep = bucket.models.find(model => model.id === 'deepseek-v4.1-flash');
  const kimi = bucket.models.find(model => model.id === 'kimi-k3.1-pro');
  assert.equal(bucket.total, 101);
  assert.equal(bucket.actual, 101);
  // a1 spends 91 on a 1:9 deep/kimi mix; a2 spends 10 on a 9:1 mix.
  assert.ok(Math.abs(deep.credits - (1 + 10 * 9 / 19)) < 1e-6);
  assert.ok(Math.abs(kimi.credits - (90 + 10 * 10 / 19)) < 1e-6);
  assert.equal(kimi.estimated, kimi.credits);
});

test('skips snapshot intervals that cross a recharge or cycle reset', () => {
  const cards = [card('codearts', 900, 'codearts-account')];
  const catalog = [catalogEntry('codearts', 'deepseek-v4.1-flash')];
  const readings = { '["codearts","codearts-account"]': [
    { at: now - 5 * 3_600_000, counters: { 总积分: { used: 100, limit: 1000, reset: null } } },
    // Recharge raises the limit: the interval must not count as spend.
    { at: now - 4 * 3_600_000, counters: { 总积分: { used: 100, limit: 2000, reset: null } } },
    { at: now - 3 * 3_600_000, counters: { 总积分: { used: 105, limit: 2000, reset: null } } },
    // Cycle reset zeroes the counter: also skipped.
    { at: now - 2 * 3_600_000, counters: { 总积分: { used: 2, limit: 2000, reset: 'later' } } },
    { at: now - 1 * 3_600_000, counters: { 总积分: { used: 6, limit: 2000, reset: 'later' } } },
  ] };
  const report = buildReport({ cards, catalog, usage: [], creditReadings: readings, now });
  assert.equal(report.providers[0].spend['24h'].actual, 9);
});

test('hides unchecked models from forecasts while keeping full spend history', () => {
  const cards = [card('workbuddy', 1000), card('codearts', 900)];
  const catalog = [catalogEntry('workbuddy', 'deepseek-v4.1-flash', 'kimi-k3.1-pro'),
    catalogEntry('codearts', 'deepseek-v4.1-flash-1017', 'kimi-k3.1-pro', 'glm-5.3-flash')];
  const usage = [
    ...Array.from({ length: 5 }, (_, i) => sample('workbuddy', 'deepseek-v4.1-flash', 50, i)),
    ...Array.from({ length: 2 }, (_, i) => sample('codearts', 'glm-5.3-flash', 3, i)),
  ];
  const checkedModels = { codearts: ['kimi-k3.1-pro', 'deepseek-v4.1-flash-1017'] };
  const report = buildReport({ cards, catalog, usage, checkedModels, now,
    preferences: { baseModel: 'deepseek-v4.1-flash', model: 'glm-5.3-flash' } });
  assert.equal(report.models.some(model => model.id === 'glm-5.3-flash'), false);
  assert.notEqual(report.selectedModel, 'glm-5.3-flash');
  const codearts = report.providers.find(provider => provider.id === 'codearts');
  assert.equal(codearts.models['glm-5.3-flash'].checked, false);
  assert.equal(codearts.models['kimi-k3.1-pro'].checked, true);
  // Spend history keeps the unchecked model's requests.
  assert.ok(codearts.spend['24h'].models.some(model => model.id === 'glm-5.3-flash'));
});

test('retains Qoder aliases and requires a local rate even when CodeArts publishes coefficients', () => {
  assert.equal(modelId('qoder', 'kmodel_latest'), 'kimi-k3.1-pro');
  assert.equal(modelId('qoder-cn', 'mmodel'), 'minimax-m3.1-flash');
  const cards = [{ provider: 'codearts', user: 'iam::acct:user:x', balance: '1000 credits' }];
  const catalog = [{ id: 'codearts',
    models: [{ id: 'kimi-k3.1-pro', name: 'Kimi-K3.1-Pro', rate: 1.63 },
      { id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek-V4.1-Flash-1017', rate: 0.12 }],
    accounts: [{ accountId: 'iam::acct:user:x', key: 'codearts',
      models: ['kimi-k3.1-pro', 'deepseek-v4.1-flash-1017'] }] }];
  const report = buildReport({ cards, catalog, usage: [], now, preferences: { period: 'peak' } });
  const codearts = report.providers[0];
  assert.equal(codearts.models['kimi-k3.1-pro'].peak.tokens, null);
  assert.equal(codearts.models['deepseek-v4.1-flash-1017'].offpeak.tokens, null);
  assert.ok(Math.abs(codearts.models['deepseek-v4.1-flash-1017'].rule.ratio - 2 / 3) < 1e-9);
});

test('converts peak and offpeak equivalents with the base rate of the same period', () => {
  const cards = [card('workbuddy', 1000), card('codearts', 900)];
  const catalog = [catalogEntry('workbuddy', 'deepseek-v4.1-flash'),
    catalogEntry('codearts', 'deepseek-v4.1-flash-1017')];
  const usage = Array.from({ length: 5 }, (_, i) => sample('workbuddy', 'deepseek-v4.1-flash', 50, i));
  const preferences = { period: 'peak', baseModel: 'deepseek-v4.1-flash',
    mappings: { workbuddy: { 'deepseek-v4.1-flash': { codearts: ['deepseek-v4.1-flash-1017'] } } },
    rates: { codearts: { 'deepseek-v4.1-flash-1017': { peak: 180 } } } };
  const report = buildReport({ cards, catalog, usage, preferences, now });
  const codearts = report.providers[1];
  // Peak: 900 credits / 180 per M = 5M tokens; base peak 50 per M → 250.
  assert.equal(codearts.equivalents.peak, 250);
  // Offpeak: rule ratio 0.12/0.18 → 120 per M → 7.5M tokens → 375.
  assert.ok(Math.abs(codearts.equivalents.offpeak - 375) < 1e-6);
  assert.equal(report.providers[0].equivalents.peak, 1000);
  assert.equal(report.providers[0].equivalents.offpeak, 1000);
});

test('token view aggregates user-selected cross-name aliases per provider, balance once', () => {
  const cards = [card('workbuddy', 1000), card('codearts', 900)];
  const catalog = [catalogEntry('workbuddy', 'deepseek-v4.1-flash'),
    catalogEntry('codearts', 'deepseek-v4.1-flash-1017')];
  const preferences = { period: 'peak', model: 'deepseek-v4.1-flash',
    rates: { workbuddy: { 'deepseek-v4.1-flash': { peak: 50 } },
      codearts: { 'deepseek-v4.1-flash-1017': { peak: 180 } } },
    tokenMappings: { 'deepseek-v4.1-flash': { codearts: ['deepseek-v4.1-flash-1017'] } } };
  const report = buildReport({ cards, catalog, usage: [], preferences, now });
  const workbuddy = report.providers[0];
  const codearts = report.providers[1];
  // Same-name default selection for the provider that literally has the target id.
  assert.deepEqual(workbuddy.tokenBridges, ['deepseek-v4.1-flash']);
  assert.equal(workbuddy.tokenPlan.peak.tokens, 20_000_000);
  // Cross-name alias selected by the user aggregates against the single balance.
  assert.deepEqual(codearts.tokenBridges, ['deepseek-v4.1-flash-1017']);
  assert.equal(codearts.tokenPlan.peak.tokens, 5_000_000);
  assert.ok(Math.abs(codearts.tokenPlan.offpeak.tokens - 7_500_000) < 1e-3);
  // Without a selection and no same-name match, the provider contributes nothing.
  const bare = buildReport({ cards, catalog, usage: [], preferences: { ...preferences, tokenMappings: {} }, now });
  assert.deepEqual(bare.providers[1].tokenBridges, []);
  assert.equal(bare.providers[1].tokenPlan.peak, null);
});

test('token view blends multiple aliases by recent token share without double-counting balance', () => {
  const cards = [card('custom', 1000)];
  const catalog = [catalogEntry('custom', 'deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017')];
  const usage = [
    ...Array.from({ length: 3 }, (_, i) => sample('custom', 'deepseek-v4.1-flash', 30, i)),
    ...Array.from({ length: 1 }, (_, i) => sample('custom', 'deepseek-v4.1-flash-1017', 60, i)),
  ];
  const preferences = { period: 'peak', model: 'deepseek-v4.1-flash',
    rates: { custom: { 'deepseek-v4.1-flash': { peak: 100 }, 'deepseek-v4.1-flash-1017': { peak: 200 } } },
    tokenMappings: { 'deepseek-v4.1-flash': { custom: ['deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017'] } } };
  const report = buildReport({ cards, catalog, usage, preferences, now });
  const custom = report.providers[0];
  // Recent share 3:1 → blended rate 125; one balance of 1000 → 8M tokens.
  assert.equal(custom.tokenPlan.peak.rate.value, 125);
  assert.equal(custom.tokenPlan.peak.tokens, 8_000_000);
});

test('deduplicates an unnamed aggregate window by the sum relation', () => {
  const window = (name, limit, amount) => ({ name, limit, amount, unit: 'credits' });
  const card = { provider: 'custom', windows: [
    window('Pack A', 300, 100), window('Pack B', 700, 200), window('Pool', 1000, 300)] };
  // Pool limit 1000 == 300 + 700, so it is the aggregate; remaining is 700.
  assert.equal(cardBalance(card, now), 700);
});

test('surfaces the vendor-stated expiring batch without deducting it from balance', () => {
  const card = { provider: 'codearts', user: 'a', windows: [
    { name: '总积分', limit: 11600, amount: 1961.32, unit: 'credits',
      display: '1961 / 1.2万 · 3139 即将过期', runsOutAt: new Date(now + 86_400_000).toISOString() },
    { name: '赠送积分包', limit: 11100, amount: 1961.32, unit: 'credits' }] };
  const report = buildReport({ cards: [card], catalog: [], usage: [], now });
  const account = report.providers[0].accounts[0];
  assert.ok(Math.abs(account.balance - (11600 - 1961.32)) < 1e-6);
  assert.equal(account.expiring.amount, 3139);
  assert.ok(account.expiring.at > now);
});

test('anchors official coefficients to the learned counter scale for unmeasured models', () => {
  const cards = [card('codearts', 900, 'codearts-account')];
  const catalog = [{ id: 'codearts', models: [
    { id: 'glm-5.3-flash', rate: 0.08 }, { id: 'deepseek-v4.1-flash-1017', rate: 0.12 }] }];
  // 7d counter 1000 credits over ~100M deepseek tokens → learned ~10/M blended.
  const usage = Array.from({ length: 5 }, (_, i) => ({ ...sample('codearts', 'deepseek-v4.1-flash-1017', undefined, i),
    providerAccount: 'codearts-account', in: 20_000_000, out: 0, cache_read: 0, cache_write: 0 }));
  const dailyCredits = { 'codearts|codearts-account|总积分': { since: '2026-11-10',
    last: { used: 1000, total: 5000, at: new Date(now).toISOString() },
    days: { '2026-11-16': 500, '2026-11-17': 500 } } };
  const report = buildReport({ cards, catalog, usage, dailyCredits, now, preferences: { period: 'peak' } });
  const glm = report.providers[0].models['glm-5.3-flash'];
  // glm has no recent usage, but its rate must be scaled to the learned unit,
  // not the raw 0.08 coefficient.
  assert.equal(glm.peak.rate.source, 'learned-catalog');
  assert.ok(glm.peak.rate.value > 1);
  const deep = report.providers[0].models['deepseek-v4.1-flash-1017'];
  assert.ok(Math.abs(deep.offpeak.rate.value - 10) < 1e-9);
  assert.ok(Math.abs(deep.peak.rate.value - 15) < 1e-9);
});

test('applies key multipliers to local calibration and does not borrow the base supplier rate', () => {
  const cards = [card('workbuddy', 1000), card('custom', 1000, 'custom-account'), card('custom', 1000, 'measured')];
  const catalog = [
    { id: 'workbuddy', models: [{ id: 'deepseek-v4.1-flash', rate: 0.11 }] },
    { id: 'custom', models: [{ id: 'deepseek-v4.1-flash', rate: 0.11 }],
      accounts: [{ accountId: 'custom-account', key: 'custom-key' }, { accountId: 'measured' }] },
  ];
  const usage = Array.from({ length: 5 }, (_, i) => sample('workbuddy', 'deepseek-v4.1-flash', 50, i));
  const providerConfigs = [{
    id: 'custom', priceRate: 2, keyPriceRates: { 'custom-key': 0.5 },
    rateWindows: [{ start: '21:00', end: '08:00', rate: 0.5 }],
  }];
  const before = buildReport({ cards, catalog, usage, providerConfigs, now });
  assert.equal(before.providers[1].models['deepseek-v4.1-flash'].peak.tokens, null);
  usage.push({ ...sample('custom', 'deepseek-v4.1-flash', undefined, 1), providerAccount: 'measured',
    t: new Date('2026-11-17T12:00:00+08:00').toISOString() });
  const dailyCredits = {
    'custom|measured|总积分': { days: { '2026-11-17': 50 } },
    'custom|custom-account|总积分': { days: {} },
  };
  const report = buildReport({ cards, catalog, usage, dailyCredits, providerConfigs, now });
  const model = report.providers[1].models['deepseek-v4.1-flash'];
  assert.ok(Math.abs(model.peak.tokens - 100_000_000) < 1e-6);
  assert.ok(Math.abs(model.offpeak.tokens - 200_000_000) < 1e-6);
});

test('multi-alias forecasts count each supported account balance exactly once', () => {
  const cards = [card('custom', 100, 'a'), card('custom', 100, 'b'), card('custom', 900, 'other')];
  const catalog = [{ id: 'custom', accounts: [
    { accountId: 'a', models: ['first'] }, { accountId: 'b', models: ['second'] },
    { accountId: 'other', models: ['unrelated'] },
  ] }];
  const preferences = { model: 'first', tokenMappings: { first: { custom: ['first', 'second'] } },
    rates: { custom: { first: { peak: 10 }, second: { peak: 20 } } } };
  const { tokenPlan } = buildReport({ cards, catalog, preferences, usage: [], now }).providers[0];
  assert.equal(tokenPlan.peak.tokens, 15_000_000);
  assert.equal(tokenPlan.peak.eligible, 2);
});

test('explicit zero charges are preserved when estimating missing request credits', () => {
  const cards = [card('custom', 100)];
  const catalog = [catalogEntry('custom', 'chosen')];
  const usage = [sample('custom', 'chosen', 0, 1), sample('custom', 'chosen', undefined, 2)];
  const preferences = { rates: { custom: { chosen: { peak: 5 } } } };
  const { total, models } = buildReport({ cards, catalog, preferences, usage, now }).providers[0].spend['24h'];
  assert.equal(models[0].unpriced, 1);
  assert.equal(total, 5);
});

test('rolling spend adds previous-day requests to the current-day counter without overlap', () => {
  const at = Date.parse('2026-11-18T01:00:00+08:00');
  const cards = [card('custom', 1000)];
  const catalog = [catalogEntry('custom', 'chosen')];
  const usage = [sample('custom', 'chosen', undefined, 1, new Date(at - 2 * 3_600_000).toISOString()),
    sample('custom', 'chosen', undefined, 2, new Date(at).toISOString())];
  const dailyCredits = { 'custom|account|总积分': { days: { '2026-11-18': 100 } } };
  const preferences = { rates: { custom: { chosen: { peak: 5 } } } };
  const { total, actual } = buildReport({ cards, catalog, usage, dailyCredits, preferences, now: at }).providers[0].spend['24h'];
  assert.equal(actual, 100);
  assert.equal(total, 105);
});

test('adds confirmed new charges beyond the last counter read exactly once', () => {
  const cards = [card('custom', 100)];
  const catalog = [catalogEntry('custom', 'chosen')];
  const cutoff = now - 3_600_000;
  const usage = [sample('custom', 'chosen', 20, 1, new Date(cutoff).toISOString()),
    sample('custom', 'chosen', 5, 2)];
  const dailyCredits = { 'custom|account|总积分': { since: '2026-11-11',
    last: { at: new Date(cutoff).toISOString() }, days: { '2026-11-17': 100 } } };
  const { spend } = buildReport({ cards, catalog, usage, dailyCredits, now }).providers[0];
  for (const window of ['24h', '7d', '30d']) {
    assert.equal(spend[window].total, 105);
    assert.equal(spend[window].actual, 105);
    assert.equal(spend[window].unallocated, 80);
  }
});

test('does not add unattributed requests on top of overlapping account counters', () => {
  const cards = [card('custom', 100, 'a'), card('custom', 100, 'b')];
  const catalog = [catalogEntry('custom', 'chosen')];
  const usage = [{ ...sample('custom', 'chosen', 40, 1), providerAccount: 'a' },
    { ...sample('custom', 'chosen', 50, 2), providerAccount: undefined }];
  const dailyCredits = {
    'custom|a|总积分': { days: { '2026-11-17': 100 } },
    'custom|b|总积分': { days: { '2026-11-17': 50 } },
  };
  const { spend } = buildReport({ cards, catalog, usage, dailyCredits, now }).providers[0];
  assert.equal(spend['24h'].total, 150);
  assert.equal(spend['24h'].models[0].credits, 90);
  assert.equal(spend['24h'].unallocated, 60);
  assert.equal(spend['24h'].unattributed, true);
  const withoutCounters = buildReport({ cards, catalog, usage, now }).providers[0].spend['24h'];
  assert.equal(withoutCounters.total, 90);
});
