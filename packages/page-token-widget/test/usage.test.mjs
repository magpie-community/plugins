import test from 'node:test';
import assert from 'node:assert/strict';
import { project, shanghaiDay } from '../lib/normalize.mjs';

const iso = (offset = 0) => new Date(Date.now() + offset).toISOString();

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
