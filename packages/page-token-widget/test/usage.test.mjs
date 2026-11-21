import test from 'node:test';
import assert from 'node:assert/strict';
import { displayOptions, normalizeQuotas, normalizeUsageSummary, project, resolveQuotas, sanitizeCachedLabels, sanitizeCachedSummary, shanghaiDay } from '../lib/normalize.mjs';

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
// the plain "Quota", and not something the table happens to inherit. Three
// of them on one card are numbered, so that they can be told apart.
test('a window whose name is a word of the prototype gets the plain name', () => {
  const cards = normalizeQuotas({ data: [{
    provider: 'codex',
    windows: [
      { name: 'constructor', used: 1 },
      { name: '__proto__', used: 2 },
      { name: 'toString', used: 3 },
    ],
  }] });
  assert.deepEqual(cards[0].windows.map(window => window.label), ['Quota 1', 'Quota 2', 'Quota 3']);
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

// Magpie names its vendors itself: "Zhipu GLM", "MiniMax (China)". The
// widget used to carry names of its own ("GLM", "MiniMax"), and the software
// and the widget said two different things about the same subscription. The
// name of the software is the name of the widget.
test('a card carries the name Magpie gives the vendor', () => {
  const [glm] = normalizeQuotas({ data: [{ provider: 'zhipu', name: 'Zhipu GLM', windows: [{ name: '5 hours', used: 1 }] }] });
  assert.equal(glm.label, 'Zhipu GLM');
  assert.equal(glm.vendor, 'Zhipu GLM');
  const [minimax] = normalizeQuotas({ data: [{ provider: 'minimax-cn', name: 'MiniMax (China)', windows: [{ name: '5 hours', used: 1 }] }] });
  assert.equal(minimax.label, 'MiniMax (China)');
  // The account of a vendor still stands behind the name of the vendor.
  const [codex] = normalizeQuotas({ data: [
    { provider: 'codex', name: 'Codex', user: 'alpha@example.com', windows: [{ name: '5 hours', used: 1 }] },
    { provider: 'codex', name: 'Codex', user: 'beta@example.com', windows: [{ name: '5 hours', used: 1 }] },
  ] });
  assert.equal(codex.label, 'Codex · alpha');
});

test('a vendor name that cannot be shown is not shown', () => {
  // The separator of a label would cut the name in two, a name that is too
  // long is not a name, and control characters have no place in one: all of
  // them fall back to the plain name of the family.
  const [plain] = normalizeQuotas({ data: [{ provider: 'zhipu', windows: [{ name: '5 hours', used: 1 }] }] });
  assert.equal(plain.label, 'GLM');
  const [cut] = normalizeQuotas({ data: [{ provider: 'zhipu', name: 'A · B', windows: [{ name: '5 hours', used: 1 }] }] });
  assert.equal(cut.label, 'GLM');
  const [long] = normalizeQuotas({ data: [{ provider: 'zhipu', name: 'x'.repeat(41), windows: [{ name: '5 hours', used: 1 }] }] });
  assert.equal(long.label, 'GLM');
  const bell = String.fromCharCode(7);
  const [loud] = normalizeQuotas({ data: [{ provider: 'zhipu', name: bell, windows: [{ name: '5 hours', used: 1 }] }] });
  assert.equal(loud.label, 'GLM');
  // A name that carries a control character is cleaned, not thrown away.
  const [cleaned] = normalizeQuotas({ data: [{ provider: 'zhipu', name: 'Zhipu' + bell + 'GLM', windows: [{ name: '5 hours', used: 1 }] }] });
  assert.equal(cleaned.label, 'Zhipu GLM');
});

test('the name of a vendor survives a reading that was stored', () => {
  // The card falls back to the reading that was stored when the gateway is
  // quiet. The name of the vendor is part of the card, so the card that comes
  // back says the same name.
  const live = resolveQuotas({ data: [{ provider: 'zhipu', name: 'Zhipu GLM', windows: [{ name: '5 hours', used: 1 }] }] }, {}, []);
  const stored = sanitizeCachedLabels(live, 'quotas');
  assert.equal(stored[0].label, 'Zhipu GLM');
  const [again] = resolveQuotas({ data: [] }, {}, stored);
  assert.equal(again.label, 'Zhipu GLM');
});

test('the name the user gives a subscription is kept, the others are not', () => {
  const display = displayOptions({
    names: {
      'codex@alpha': '工作账号',
      'codex@beta': 'x'.repeat(33),
      'codex@gamma': 'A · B',
      'codex@delta': 42,
      'codex@epsilon': '   ',
    },
  });
  assert.deepEqual(display.names, { 'codex@alpha': '工作账号' });
});

test('a subscription carries the name the user gives it', () => {
  const view = project(
    snapshot({
      today: iso(),
      todayPeriodDay: shanghaiDay(Date.now()),
      cards: [card('codex@alpha', 'codex', 'alpha', { today: { totalTokens: 1234, requests: 5 } })],
    }),
    Date.now(),
    { subscriptions: ['codex@alpha'], names: { 'codex@alpha': '工作账号' } },
    {},
  );
  assert.equal(view.subscriptions[0].label, '工作账号');
  // Without a name of his own the card keeps the name of the vendor.
  const plain = project(
    snapshot({
      today: iso(),
      todayPeriodDay: shanghaiDay(Date.now()),
      cards: [card('codex@alpha', 'codex', 'alpha', { today: { totalTokens: 1234, requests: 5 } })],
    }),
    Date.now(),
    { subscriptions: ['codex@alpha'] },
    {},
  );
  assert.equal(plain.subscriptions[0].label, 'codex · alpha');
});

// A vendor that is not written down in the plugin is a vendor of its own. The
// name Magpie gives it is the name its card carries, and its quota is read
// like the quota of any other subscription.
test('a vendor that is not written down in the plugin is a vendor of its own', () => {
  const answer = { data: [{
    provider: 'qoder-cn',
    name: 'Qoder CN',
    kind: 'subscription',
    plan: 'personal_professional',
    user: '01a1fe89-c345-7246-86ae-4e0e03678e7f',
    alias: '180****2463',
    windows: [
      { name: 'Total credits', used: 0.958, remaining: 99.04, limit: 2400, amount: 23 },
      { name: 'Credits', used: 0, remaining: 100, limit: 2000, amount: 0 },
    ],
    readAt: iso(),
  }] };
  const cards = resolveQuotas(answer, {}, []);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].provider, 'qoder-cn');
  assert.equal(cards[0].vendor, 'Qoder CN');
  assert.equal(cards[0].label, 'Qoder CN · 180****2463');
  assert.equal(cards[0].plan, 'personal_professional');
  assert.equal(cards[0].windows.length, 2);
  assert.equal(cards[0].windows[0].usedPercent, 0.958);
  assert.equal(cards[0].windows[0].remainingPercent, 99.042);
});

// A subscription that is removed in Magpie is gone. The answer of the gateway
// is the list of the subscriptions that exist, so a vendor it does not
// mention is not brought back from the reading that was stored.
test('a subscription that is removed is not brought back', () => {
  const live = resolveQuotas({ data: [{ provider: 'qoder-cn', name: 'Qoder CN', windows: [{ name: 'Credits', used: 1 }] }] }, {}, []);
  assert.equal(live.length, 1);
  const stored = sanitizeCachedLabels(live, 'quotas');
  // The gateway answers with the other subscriptions; the removed one is not
  // among them.
  const after = resolveQuotas({ data: [{ provider: 'codex', user: 'alpha@example.com', windows: [{ name: '5 hours', used: 1 }] }] }, {}, stored);
  assert.equal(after.length, 1);
  assert.equal(after[0].provider, 'codex');
  assert.equal(after.some(card => card.provider === 'qoder-cn'), false);
});

// The total of the day of a vendor that is not written down is found as well:
// the card and the row of the usage are matched by the name of the vendor.
test('the total of the day of a vendor that is not written down is found', () => {
  const view = project(
    {
      parts: {
        quotas: { data: [{
          id: 'qoder-cn', provider: 'qoder-cn', label: 'Qoder CN', vendor: 'Qoder CN',
          account: null, accountUsage: null, accountUsageDay: null, accounts: 1,
          plan: '', updatedAt: iso(), stale: false,
          windows: [{ label: 'Credits', usedPercent: 10, remainingPercent: 90, resetsAt: null }],
        }], observedAt: iso() },
        today: { data: {
          metrics: { totalTokens: 4321, requests: 12 },
          providers: [{ label: 'Qoder CN', totalTokens: 777, requests: 9 }],
        }, observedAt: iso(), periodDay: shanghaiDay(Date.now()) },
        week: { data: { metrics: {}, trend: [], models: [], agents: [], providers: [], computers: [] }, observedAt: iso() },
      },
      failures: {},
    },
    Date.now(),
    { subscriptions: ['*'] },
    {},
  );
  assert.equal(view.subscriptions.length, 1);
  assert.equal(view.subscriptions[0].usage.today.totalTokens, 777);
  assert.equal(view.subscriptions[0].usage.today.requests, 9);
});

// The same, but the way the number really comes in: the gateway answers with
// the vendors of the day, and a vendor that has no name of its own yet is
// counted under a name that is not written down. The card of that vendor and
// the row of its usage are found by the family they share.
test('the total of the day of a new vendor is found the way it really comes in', () => {
  const today = normalizeUsageSummary({
    input: 100, output: 20, cache_read: 0, cache_write: 0, calls: 5,
    providerKeys: [{ provider: 'qoder-cn', calls: 5, input: 100, output: 20 }],
    accounts: [],
  });
  assert.equal(today.providers.length, 1);
  assert.equal(today.providers[0].family, 'qoder-cn');
  const cards = resolveQuotas({ data: [{
    provider: 'qoder-cn',
    name: 'Qoder CN',
    windows: [{ name: 'Credits', used: 1 }],
  }] }, {}, []);
  const view = project({
    parts: {
      quotas: { data: cards, observedAt: iso() },
      today: { data: today, observedAt: iso(), periodDay: shanghaiDay(Date.now()) },
      week: { data: { metrics: {}, trend: [], models: [], agents: [], providers: [], computers: [] }, observedAt: iso() },
    },
    failures: {},
  }, Date.now(), { subscriptions: ['*'] }, {});
  assert.equal(view.subscriptions.length, 1);
  assert.equal(view.subscriptions[0].usage.today.requests, 5);
  assert.equal(view.subscriptions[0].usage.today.totalTokens, 120);
});

// A vendor whose id carries a dot or an underscore is a vendor like any
// other: it is a vendor of its own and it is shown.
test('a vendor whose id carries a dot or an underscore is a vendor of its own', () => {
  const cards = resolveQuotas({ data: [{
    provider: 'openai_compatible',
    name: 'OpenAI Compatible',
    windows: [{ name: 'Credits', used: 1 }],
  }] }, {}, []);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].provider, 'openai_compatible');
  assert.equal(cards[0].vendor, 'OpenAI Compatible');
});

// A plan that is written with capitals and with a space is a plan like any
// other: it is shown as it is.
test('a plan that is written in capitals is shown', () => {
  const cards = resolveQuotas({ data: [{
    provider: 'qoder-cn',
    name: 'Qoder CN',
    plan: 'Pro Plan',
    windows: [{ name: 'Credits', used: 1 }],
  }] }, {}, []);
  assert.equal(cards[0].plan, 'Pro Plan');
});

// An answer that holds nothing that can be read is not an answer about which
// subscriptions exist: the reading that was stored is shown instead of
// nothing at all.
test('an answer that holds nothing readable keeps the reading that was stored', () => {
  const stored = sanitizeCachedLabels(resolveQuotas({ data: [{
    provider: 'codex',
    name: 'Codex',
    user: 'alpha@example.com',
    windows: [{ name: '5 hours', used: 1 }],
  }] }, {}, []), 'quotas');
  const after = resolveQuotas({ data: [{ provider: 'not a vendor', windows: [{ name: 'x', used: 1 }] }] }, {}, stored);
  assert.equal(after.length, 1);
  assert.equal(after[0].provider, 'codex');
});

// The order the user has given is kept when the whole list of Magpie is
// followed: the star says "and everything else", and what is written down
// keeps its place.
test('the order that was written down is kept when everything is followed', () => {
  const cards = [
    { id: 'codex@a', provider: 'codex', label: 'Codex · a', accounts: 2, updatedAt: iso(), windows: [{ label: '5 hours', usedPercent: 1, remainingPercent: 99, resetsAt: null }] },
    { id: 'codex@b', provider: 'codex', label: 'Codex · b', accounts: 2, updatedAt: iso(), windows: [{ label: '5 hours', usedPercent: 1, remainingPercent: 99, resetsAt: null }] },
    { id: 'minimax', provider: 'minimax', label: 'MiniMax', accounts: 1, updatedAt: iso(), windows: [{ label: '4 hours', usedPercent: 1, remainingPercent: 99, resetsAt: null }] },
    { id: 'qoder-cn', provider: 'qoder-cn', label: 'Qoder CN', accounts: 1, updatedAt: iso(), windows: [{ label: 'Quota 1', usedPercent: 1, remainingPercent: 99, resetsAt: null }] },
  ];
  const view = project({
    parts: {
      quotas: { data: cards, observedAt: iso() },
      today: { data: { metrics: {}, providers: [] }, observedAt: iso(), periodDay: shanghaiDay(Date.now()) },
      week: { data: { metrics: {}, trend: [], models: [], agents: [], providers: [], computers: [] }, observedAt: iso() },
    },
    failures: {},
  }, Date.now(), { subscriptions: ['*', 'codex@b', 'codex@a'] }, {});
  assert.deepEqual(view.subscriptions.map(card => card.id), ['codex@b', 'codex@a', 'minimax', 'qoder-cn']);
});

// A vendor whose id is a word of the prototype is counted like any other:
// the second card of that vendor is told apart from the first one.
test('a vendor whose id is a word of the prototype is counted like any other', () => {
  const cards = normalizeQuotas({ data: [
    { provider: 'constructor', name: 'Constructor', windows: [{ name: 'Credits', used: 1 }] },
    { provider: 'constructor', name: 'Constructor', windows: [{ name: 'Credits', used: 2 }] },
  ] });
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map(card => card.id), ['constructor', 'constructor-2']);
  assert.equal(cards[1].label, 'Constructor 2');
});

// The cards of the vendors that are not known are ordered by the id of their
// vendor, so that the cards of one vendor stay together and do not change
// places when the reading is written down and read again.
test('the cards of a vendor that is not known stay together', () => {
  const cards = normalizeQuotas({ data: [
    { provider: 'beta-vendor', name: 'Beta', user: 'alice@example.com', windows: [{ name: 'Credits', used: 1 }] },
    { provider: 'alpha-vendor', name: 'Alpha', user: 'bob@example.com', windows: [{ name: 'Credits', used: 1 }] },
  ] });
  assert.deepEqual(cards.map(card => card.provider), ['alpha-vendor', 'beta-vendor']);
});

// A reading that was stored is found for the vendor as Magpie writes it down
// and for the family it belongs to: "minimax-cn" and "minimax" are one
// family, and the reading of one of them is the reading of the other. The
// name Magpie writes down may change; the family does not.
test('a reading that was stored is found for the family of the vendor', () => {
  const at = iso(-60_000);
  const cache = {
    'minimax/plan': {
      at,
      quota: { provider: 'minimax', windows: [{ name: '4 hours', used: 1 }] },
    },
  };
  const [card] = normalizeQuotas({ data: [
    { provider: 'minimax-cn', name: 'MiniMax (China)', windows: [{ name: '4 hours', used: 1 }] },
  ] }, cache);
  assert.equal(card.updatedAt, at);
});

// The ranking of the vendors says the name that Magpie gives a vendor that
// is not written down in the plugin, and that name survives the way back
// through the reading that was stored.
test('the ranking of a new vendor carries the name Magpie gives it', () => {
  const names = { 'qoder-cn': 'Qoder CN' };
  const summary = normalizeUsageSummary({
    input: 10, output: 5, cache_read: 0, cache_write: 0, calls: 2,
    providerKeys: [{ provider: 'qoder-cn', calls: 2, input: 10, output: 5 }],
    accounts: [],
  }, names);
  assert.equal(summary.providers[0].label, 'Qoder CN');
  assert.equal(summary.providers[0].family, 'qoder-cn');
  // The reading that was stored comes back with the name it was stored under.
  const stored = sanitizeCachedSummary(summary);
  assert.equal(stored.providers[0].label, 'Qoder CN');
  // A vendor that is not written down keeps its own id when there is no name
  // of it: an id says more than "Unknown" does.
  const plain = normalizeUsageSummary({
    input: 1, output: 0, cache_read: 0, cache_write: 0, calls: 1,
    providerKeys: [{ provider: 'qoder-cn', calls: 1, input: 1 }],
    accounts: [],
  });
  assert.equal(plain.providers[0].label, 'qoder-cn');
});

// Several windows of one card can carry the same plain name. They are
// numbered, so that they can be told apart, and the number survives the way
// back through the reading that was stored.
test('windows that carry the same plain name are numbered', () => {
  const answer = { data: [{
    provider: 'qoder-cn',
    name: 'Qoder CN',
    windows: [
      { name: 'Total credits', used: 0.958 },
      { name: 'Credits', used: 0 },
      { name: 'Add-on credits', used: 0.575 },
    ],
  }] };
  const cards = resolveQuotas(answer, {}, []);
  assert.deepEqual(cards[0].windows.map(window => window.label), ['Quota 1', 'Quota 2', 'Quota 3']);
  // The reading that was stored comes back with the names it was stored
  // under, and the numbers are still there.
  const stored = sanitizeCachedLabels(cards, 'quotas');
  const again = resolveQuotas({}, {}, stored);
  assert.deepEqual(again[0].windows.map(window => window.label), ['Quota 1', 'Quota 2', 'Quota 3']);
});
