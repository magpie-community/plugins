import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuotas, project, resolveQuotas, sanitizeCachedLabels, shanghaiDay } from '../lib/normalize.mjs';

const iso = (offset = 0) => new Date(Date.now() + offset).toISOString();

test('a live identity cannot inherit usage from a local-name-only quota history', () => {
  const previous = card('codex@alpha', 'codex', 'alpha', { today: { requests: 5, totalTokens: 50 } });
  const broken = { provider: 'codex', user: 'alpha@replacement.example', windows: [] };
  const [fallback] = resolveQuotas({ data: [broken] }, {}, [previous]);
  assert.equal(fallback.stale, true);
  assert.equal(fallback.accountUsage, null);
});

const card = (id, provider, account, usage, day) => ({
  id,
  provider,
  label: provider + (account ? ' · ' + account : ''),
  account: account || null,
  accountUsage: usage || null,
  // The day the number was taken on. A number without a day is a number of
  // no day, and it is not shown as the number of today.
  accountUsageDay: usage ? (day || shanghaiDay(Date.now())) : null,
  accounts: 2,
  plan: 'plus',
  updatedAt: iso(),
  stale: false,
  windows: [{ label: '5 小时', usedPercent: 40, remainingPercent: 60, resetsAt: iso(3600_000), amount: null, limit: null }],
});

const snapshot = ({ today, todayPeriodDay, cards, metrics }) => ({
  parts: {
    quotas: { data: cards, observedAt: iso() },
    today: { data: { metrics: metrics || { totalTokens: 4321, requests: 12 } }, observedAt: today, periodDay: todayPeriodDay },
    week: { data: { metrics: { totalTokens: 9999, requests: 40 }, trend: [], models: [], agents: [], providers: [], computers: [] }, observedAt: iso() },
  },
  failures: {},
});

test('the usage of a card is the usage of today', () => {
  const view = project(
    snapshot({
      today: iso(),
      todayPeriodDay: shanghaiDay(Date.now()),
      cards: [card('codex@alpha', 'codex', 'alpha', { today: { totalTokens: 1234, requests: 5 } })],
    }),
    Date.now(),
    { subscriptions: ['codex@alpha'] },
    {},
  );
  assert.equal(view.subscriptions.length, 1);
  assert.equal(view.subscriptions[0].usage.today.totalTokens, 1234);
  assert.equal(view.usage.today.totalTokens, 4321);
});

test('a reading of another day is not the usage of today', () => {
  // The reading of the quotas is fresh, but the usage of today is from
  // yesterday. The numbers of yesterday must not be shown as today's.
  const view = project(
    snapshot({
      today: iso(-24 * 3600_000),
      todayPeriodDay: shanghaiDay(Date.now() - 24 * 3600_000),
      cards: [card('codex@alpha', 'codex', 'alpha', { today: { totalTokens: 1234, requests: 5 } })],
    }),
    Date.now(),
    { subscriptions: ['codex@alpha'] },
    {},
  );
  assert.equal(view.sources.today.outdated, true);
  // The card has no usage of its own to show.
  assert.equal(view.subscriptions[0].usage, null);
  // And the total is nothing, as it has always been.
  assert.equal(view.usage.today, null);
});

test('the number of an account of another day is not the number of today', () => {
  // The reading of today is of today, but the number of the account came
  // with the reading of the quota, which is of yesterday: it is not the
  // number of today and must not be shown as one.
  const view = project(
    snapshot({
      today: iso(),
      todayPeriodDay: shanghaiDay(Date.now()),
      cards: [card('codex@alpha', 'codex', 'alpha', { today: { totalTokens: 1234, requests: 5 } },
        shanghaiDay(Date.now() - 24 * 3600_000))],
    }),
    Date.now(),
    { subscriptions: ['codex@alpha'] },
    {},
  );
  assert.equal(view.sources.today.outdated, undefined);
  assert.equal(view.subscriptions[0].usage, null);
});

test('a number without a day is a number of no day', () => {
  // An old state file, or a reading of the quota that was taken before the
  // day was written on it, must not turn into the number of today.
  const view = project(
    snapshot({
      today: iso(),
      todayPeriodDay: shanghaiDay(Date.now()),
      cards: [card('codex@alpha', 'codex', 'alpha', { today: { totalTokens: 1234, requests: 5 } }, 'no-day')],
    }),
    Date.now(),
    { subscriptions: ['codex@alpha'] },
    {},
  );
  assert.equal(view.subscriptions[0].usage, null);
});

test('the order of the accounts is the order the user gave', () => {  const view = project(
    snapshot({
      today: iso(),
      todayPeriodDay: shanghaiDay(Date.now()),
      cards: [
        card('codex@alpha', 'codex', 'alpha', { today: { totalTokens: 1, requests: 1 } }),
        card('codex@liuzq', 'codex', 'liuzq', { today: { totalTokens: 2, requests: 2 } }),
        card('minimax', 'minimax', null, null),
      ],
    }),
    Date.now(),
    { subscriptions: ['codex@liuzq', 'codex@alpha', 'minimax'] },
    {},
  );
  assert.deepEqual(view.subscriptions.map(entry => entry.id), ['codex@liuzq', 'codex@alpha', 'minimax']);
});

// A window of a provider that is not a span of time keeps a name of its own:
// the image quota of Codex is one of them, and "Quota" says nothing about
// it. A name that is not known does not reach the phone as it is.
test('a window keeps the name it has', () => {
  const cards = normalizeQuotas({ data: [{
    provider: 'codex',
    windows: [
      { name: '5 hours', used: 10 },
      { name: 'Image generation', used: 0 },
      { name: 'a word of the provider', used: 3 },
    ],
  }] });
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].windows.map(window => window.label), ['5 hours', '图片生成', 'Quota']);
});

// A name that is a word of the prototype is a name like any other: it gets
// the plain "Quota", and not something the table happens to inherit.
test('a window whose name is a word of the prototype gets the plain name', () => {
  const cards = normalizeQuotas({ data: [{
    provider: 'codex',
    windows: [
      { name: 'constructor', used: 1 },
      { name: '__proto__', used: 2 },
      { name: 'toString', used: 3 },
    ],
  }] });
  assert.deepEqual(cards[0].windows.map(window => window.label), ['Quota', 'Quota', 'Quota']);
});

// A reading that was stored comes back in with the name it was stored under.
// The name we wrote ourselves has to be the name of ourselves when it comes
// back, or a reading that is old loses the name it had when it was new. The
// road it comes back on is the one the service walks: it hands the stored
// cards in again, with the name they were stored under.
test('a window keeps its name when the service reads the stored cards again', () => {
  const stored = [{
    id: 'codex@alpha',
    provider: 'codex',
    account: 'alpha',
    label: 'Codex · alpha',
    plan: 'ChatGPT',
    accounts: 1,
    updatedAt: new Date().toISOString(),
    stale: true,
    windows: [
      { label: '5 hours', usedPercent: 10, remainingPercent: 90, resetsAt: null },
      { label: '图片生成', usedPercent: 0, remainingPercent: 100, resetsAt: null },
    ],
  }];
  const back = resolveQuotas({ data: [] }, {}, stored);
  assert.deepEqual(back[0].windows.map(window => window.label), ['5 hours', '图片生成']);
  const cleaned = sanitizeCachedLabels(stored, 'quotas');
  assert.deepEqual(cleaned[0].windows.map(window => window.label), ['5 hours', '图片生成']);
});

// The gateway sends the money of an account next to the plan of that account:
// a row that carries a balance and no window at all. There is no quota in
// such a row, so it is not a broken reading — but taken for a reading it
// makes the whole account look broken, and the card of that account falls
// back to the reading that was stored. A card that falls back never moves
// again: the reading that was stored is the card of the round after.
test('the plan of an account is read even when the gateway sends the money of the account too', () => {
  const rows = used => ([
    {
      provider: 'zhipu', name: 'Zhipu GLM', kind: 'plan', plan: 'max',
      windows: [{ name: '5 hours', used: 10, remaining: 90 }, { name: '7 days', used, remaining: 100 - used }],
      readAt: iso(),
    },
    { provider: 'zhipu', name: 'Zhipu GLM', kind: 'balance', windows: [], balance: '¥0.00', readAt: iso() },
  ]);
  const first = resolveQuotas({ data: rows(45) }, {}, []);
  assert.equal(first.length, 1, 'the money of the account is not a card of its own');
  assert.equal(first[0].provider, 'glm');
  assert.equal(first[0].stale, false, 'the reading of the account is the live one');
  assert.deepEqual(first[0].windows.map(window => window.usedPercent), [10, 45]);
  // The round after: the number follows the live reading and does not stay
  // where it was.
  const second = resolveQuotas({ data: rows(60) }, {}, first);
  assert.equal(second.length, 1, 'the money of the account is not a card of its own');
  assert.equal(second[0].stale, false, 'the reading of the account is the live one');
  assert.deepEqual(second[0].windows.map(window => window.usedPercent), [10, 60],
    'the card of the account did not follow the live reading');
});
