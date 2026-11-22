import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { displayOptions, project, shanghaiDay } from '../lib/normalize.mjs';
import { startServer, TOKEN_HEADER } from '../lib/server.mjs';
import { cleanup, freePort, mockTailscale, startGateway, tempDir } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iso = (offset = 0) => new Date(Date.now() + offset).toISOString();

// A card of the gateway: one subscription of one account.
const card = (id, provider, account) => ({
  id,
  provider,
  label: provider + (account ? ' · ' + account : ''),
  account: account || null,
  accountUsage: null,
  accountUsageDay: null,
  accounts: 1,
  plan: 'plus',
  updatedAt: iso(),
  stale: false,
  windows: [{ label: '5 小时', usedPercent: 40, remainingPercent: 60, resetsAt: iso(3600_000), amount: null, limit: null }],
});

const snapshot = (cards) => ({
  parts: {
    quotas: { data: cards, observedAt: iso() },
    today: { data: { metrics: { totalTokens: 10, requests: 1 } }, observedAt: iso(), periodDay: shanghaiDay(Date.now()) },
    week: { data: { metrics: { totalTokens: 10, requests: 1 }, trend: [], models: [], agents: [], providers: [], computers: [] }, observedAt: iso() },
  },
  failures: {},
});

// The cards the phone is shown, in the order the phone shows them.
const shown = (cards, display) =>
  project(snapshot(cards), Date.now(), display, {}).subscriptions.map(entry => entry.id);

const CARDS = [
  card('codex@alpha', 'codex', 'alpha'),
  card('codex@beta', 'codex', 'beta'),
  card('minimax', 'minimax', null),
  card('qoder-cn', 'qoder-cn', null),
];

test('a subscription that was turned off does not come back when Magpie is followed', () => {
  // The whole list of Magpie is followed, and one subscription of it was
  // turned off: it is not shown, and it does not come back by itself.
  assert.deepEqual(
    shown(CARDS, { subscriptions: ['*'], subscriptionHidden: ['minimax'] }),
    ['codex@alpha', 'codex@beta', 'qoder-cn'],
  );
});

test('the name of a vendor turns off every account of it', () => {
  // A vendor that is turned off as a whole takes its accounts with it, and
  // the other vendors are not touched.
  assert.deepEqual(
    shown(CARDS, { subscriptions: ['*'], subscriptionHidden: ['codex'] }),
    ['minimax', 'qoder-cn'],
  );
});

test('only the ticked ones are shown when the whole list is not followed', () => {
  // Five subscriptions, four of them are wanted: the fifth one is not shown.
  assert.deepEqual(
    shown(CARDS, { subscriptions: ['codex@alpha', 'codex@beta', 'qoder-cn', 'glm'] }),
    ['codex@alpha', 'codex@beta', 'qoder-cn'],
  );
});

test('a subscription that is new shows up by itself when the whole list is followed', () => {
  // The list that was written down does not hold the new one, and the new one
  // shows up anyway: it comes after the ones that were given an order.
  assert.deepEqual(
    shown(CARDS, { subscriptions: ['*', 'codex@alpha'] }),
    ['codex@alpha', 'codex@beta', 'minimax', 'qoder-cn'],
  );
});

test('a subscription that is new does not show up when the whole list is not followed', () => {
  // The list is the one of the user: a subscription that was not ticked is
  // not shown, not even when the gateway knows it.
  assert.deepEqual(
    shown(CARDS, { subscriptions: ['codex@alpha'] }),
    ['codex@alpha'],
  );
});

test('the order that was given is kept when one of them is turned off', () => {
  assert.deepEqual(
    shown(CARDS, { subscriptions: ['*', 'qoder-cn', 'codex@beta'], subscriptionHidden: ['minimax'] }),
    ['qoder-cn', 'codex@beta', 'codex@alpha'],
  );
});

test('the list of the turned off ones is cleaned', () => {
  const options = displayOptions({
    subscriptions: ['*'],
    subscriptionHidden: ['minimax', 'minimax', '<script>', 'codex@alpha', 'a b', 42],
  });
  // A name that is not a name is not taken, and a name that is written down
  // twice is written down once.
  assert.deepEqual(options.subscriptionHidden, ['minimax', 'codex@alpha']);
  // The whole list of Magpie is still followed.
  assert.deepEqual(options.subscriptions, ['*']);
});

test('a state of an older version keeps its meaning', () => {
  // The state of 0.4.19 has no list of turned off ones: nothing is turned
  // off, and the whole list of Magpie is followed as before.
  const options = displayOptions({ subscriptions: ['*'] });
  assert.deepEqual(options.subscriptionHidden, []);
  assert.deepEqual(
    shown(CARDS, { subscriptions: ['*'] }),
    ['codex@alpha', 'codex@beta', 'minimax', 'qoder-cn'],
  );
  // An older list that names the subscriptions is kept as it was.
  assert.deepEqual(
    shown(CARDS, { subscriptions: ['codex@beta', 'minimax'] }),
    ['codex@beta', 'minimax'],
  );
});

const start = async (dir, options = {}) => startServer({
  root,
  dataDir: dir,
  magpieDir: dir,
  options: {
    port: await freePort(),
    phonePort: await freePort(),
    listenTailnet: false,
    forward: false,
    gatewayURL: 'http://127.0.0.1:1',
    tailscaleRunner: mockTailscale().runner,
    ...options,
  },
});

const post = (base, route, value, headers = {}) => fetch(base + route, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(value || {}),
});

const quotaRow = (provider, user) => ({
  provider,
  user,
  readAt: '2026-11-22T12:00:00.000Z',
  windows: [{ name: '5h', used: 12, remaining: 88, resetsAt: '2026-11-22T17:00:00.000Z' }],
});

// A service with a gateway of its own, a console token and a phone token.
const withService = async (routes, run) => {
  const gateway = await startGateway(routes);
  const dir = await tempDir();
  let service = await start(dir, { gatewayURL: gateway.url });
  const base = `http://127.0.0.1:${service.port}`;
  try {
    const token = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')).consoleToken;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const answer = await fetch(base + '/api/v1/console/state', { headers: { [TOKEN_HEADER]: token } });
      if (answer.status !== 503) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const paired = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
    const session = await post(base, '/api/v1/session', { code: paired.pairing.code, name: '测试的手机' });
    const phoneToken = (await session.json()).token;
    const cards = async () => {
      const answer = await fetch(base + '/api/v1/overview', { headers: { Authorization: 'Bearer ' + phoneToken } });
      const body = await answer.json();
      return (body.subscriptions || []).map(entry => entry.id);
    };
    await run({ base, token, phoneToken, cards, dir, service });
  } finally {
    await service?.close();
    await gateway.close();
    await cleanup(dir);
  }
};

test('the subscriptions that are turned off are remembered and reach the phone', async () => {
  await withService({
    '/v1/magpie/quotas?kept=1': { data: [quotaRow('codex', 'alpha@example.com'), quotaRow('codex', 'beta@example.com'), quotaRow('minimax', 'gamma@example.com')] },
    '/v1/magpie/usage?period=today': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, providerKeys: [], accounts: [], series: [] },
    '/v1/magpie/usage/requests?period=7d&limit=1': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, by: { model: [], provider: [], agent: [] }, series: [] },
  }, async ({ base, token, cards }) => {
    // The reading of the gateway reaches the phone.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await cards()).length === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.deepEqual((await cards()).sort(), ['codex@alpha', 'codex@beta', 'minimax']);

    // One subscription is turned off, and the whole list of Magpie is still
    // followed: the phone does not show it.
    const answer = await post(base, '/api/v1/console/options', {
      subscriptions: ['*', 'codex@alpha', 'codex@beta'],
      subscriptionHidden: ['minimax'],
    }, { [TOKEN_HEADER]: token });
    assert.equal(answer.status, 200);
    const body = await answer.json();
    assert.deepEqual(body.display.subscriptionHidden, ['minimax']);
    assert.deepEqual(await cards(), ['codex@alpha', 'codex@beta']);
  });
});

test('the state of the turned off ones is kept on the disk', async () => {
  await withService({
    '/v1/magpie/quotas?kept=1': { data: [quotaRow('codex', 'alpha@example.com'), quotaRow('minimax', 'gamma@example.com')] },
    '/v1/magpie/usage?period=today': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, providerKeys: [], accounts: [], series: [] },
    '/v1/magpie/usage/requests?period=7d&limit=1': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, by: { model: [], provider: [], agent: [] }, series: [] },
  }, async ({ base, token, dir }) => {
    await post(base, '/api/v1/console/options', {
      subscriptions: ['*'],
      subscriptionHidden: ['minimax'],
    }, { [TOKEN_HEADER]: token });
    const state = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
    assert.deepEqual(state.settings.subscriptionHidden, ['minimax']);
  });
});

test('the refresh reads the gateway again and tells what is new', async () => {
  let revealed = false;
  await withService({
    '/v1/magpie/quotas?kept=1': () => ({
      data: [
        quotaRow('codex', 'alpha@example.com'),
        quotaRow('minimax', 'gamma@example.com'),
        ...(revealed ? [quotaRow('qoder-cn', 'delta@example.com')] : []),
      ],
    }),
    '/v1/magpie/usage?period=today': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, providerKeys: [], accounts: [], series: [] },
    '/v1/magpie/usage/requests?period=7d&limit=1': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, by: { model: [], provider: [], agent: [] }, series: [] },
  }, async ({ base, token, cards }) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await cards()).length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // The user adds a subscription to Magpie and asks the service to read
    // the gateway again.
    revealed = true;
    const answer = await post(base, '/api/v1/console/subscriptions/refresh', {}, { [TOKEN_HEADER]: token });
    assert.equal(answer.status, 200);
    const body = await answer.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.added, ['qoder-cn']);
    assert.deepEqual(body.removed, []);
    assert.equal(body.subscriptions.length, 3);
    // The new subscription shows up on the phone by itself: the whole list of
    // Magpie is followed.
    assert.equal((await cards()).includes('qoder-cn'), true);
  });
});

test('a subscription that is not ticked does not show up after a refresh', async () => {
  let revealed = false;
  await withService({
    '/v1/magpie/quotas?kept=1': () => ({
      data: [
        quotaRow('codex', 'alpha@example.com'),
        quotaRow('minimax', 'gamma@example.com'),
        ...(revealed ? [quotaRow('qoder-cn', 'delta@example.com')] : []),
      ],
    }),
    '/v1/magpie/usage?period=today': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, providerKeys: [], accounts: [], series: [] },
    '/v1/magpie/usage/requests?period=7d&limit=1': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, by: { model: [], provider: [], agent: [] }, series: [] },
  }, async ({ base, token, cards }) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await cards()).length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // The user picks the subscriptions of his own.
    await post(base, '/api/v1/console/options', { subscriptions: ['codex@alpha'] }, { [TOKEN_HEADER]: token });
    revealed = true;
    const answer = await post(base, '/api/v1/console/subscriptions/refresh', {}, { [TOKEN_HEADER]: token });
    const body = await answer.json();
    assert.equal(body.ok, true);
    // The gateway knows it, the console shows it, and the phone does not.
    assert.equal(body.subscriptions.some(entry => entry.id === 'qoder-cn'), true);
    assert.equal((await cards()).includes('qoder-cn'), false);
  });
});

test('a refresh the gateway does not answer is told as a failure', async () => {
  await withService({
    '/v1/magpie/quotas?kept=1': { httpStatus: 500, body: { error: 'broken' } },
    '/v1/magpie/usage?period=today': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, providerKeys: [], accounts: [], series: [] },
    '/v1/magpie/usage/requests?period=7d&limit=1': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, by: { model: [], provider: [], agent: [] }, series: [] },
  }, async ({ base, token }) => {
    const answer = await post(base, '/api/v1/console/subscriptions/refresh', {}, { [TOKEN_HEADER]: token });
    assert.equal(answer.status, 200);
    const body = await answer.json();
    // The failure is told as a failure: an old list is never passed for a
    // new one.
    assert.equal(body.ok, false);
    assert.ok(body.error);
    assert.deepEqual(body.added, []);
    assert.deepEqual(body.removed, []);
  });
});

test('a gateway that answers with no subscription at all is not a failure', async () => {
  await withService({
    '/v1/magpie/quotas?kept=1': { data: [] },
    '/v1/magpie/quotas': { httpStatus: 500, body: { error: 'not now' } },
    '/v1/magpie/usage?period=today': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, providerKeys: [], accounts: [], series: [] },
    '/v1/magpie/usage/requests?period=7d&limit=1': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, by: { model: [], provider: [], agent: [] }, series: [] },
  }, async ({ base, token }) => {
    const answer = await post(base, '/api/v1/console/subscriptions/refresh', {}, { [TOKEN_HEADER]: token });
    const body = await answer.json();
    // The gateway answered: it says that it has nothing. That is not the
    // same as the gateway that does not answer at all, and the two are not
    // told in the same way.
    assert.equal(body.ok, true);
    assert.equal(body.error, '');
    assert.equal(body.subscriptions.length, 0);
    assert.deepEqual(body.added, []);
    assert.deepEqual(body.removed, []);
  });
});

test('the refresh is only for the computer of the service', async () => {
  await withService({
    '/v1/magpie/quotas?kept=1': { data: [quotaRow('codex', 'alpha@example.com')] },
    '/v1/magpie/usage?period=today': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, providerKeys: [], accounts: [], series: [] },
    '/v1/magpie/usage/requests?period=7d&limit=1': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, by: { model: [], provider: [], agent: [] }, series: [] },
  }, async ({ base, token, phoneToken }) => {
    // The console of the computer, with its own token.
    const allowed = await post(base, '/api/v1/console/subscriptions/refresh', {}, { [TOKEN_HEADER]: token });
    assert.equal(allowed.status, 200);
    // The token of the phone is not the token of the console.
    const refused = await post(base, '/api/v1/console/subscriptions/refresh', {}, { [TOKEN_HEADER]: phoneToken });
    assert.equal(refused.status, 403);
  });
});

test('the refresh asks the gateway again, even when a reading is on its way', async () => {
  let quotaCalls = 0;
  await withService({
    // The gateway knows one subscription at first, and two a moment later:
    // the user added the second one while the first reading was on its way.
    '/v1/magpie/quotas?kept=1': () => {
      quotaCalls += 1;
      return {
        data: quotaCalls === 1
          ? [quotaRow('codex', 'alpha@example.com')]
          : [quotaRow('codex', 'alpha@example.com'), quotaRow('qoder-cn', 'gamma@example.com')],
      };
    },
    // The reading of the day is slow, so the reading of the quotas is held
    // back by it, and the click of the person at the keyboard comes while a
    // reading is still on its way.
    '/v1/magpie/usage?period=today': async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      return { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, providerKeys: [], accounts: [], series: [] };
    },
    '/v1/magpie/usage/requests?period=7d&limit=1': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, by: { model: [], provider: [], agent: [] }, series: [] },
  }, async ({ base, token }) => {
    const answer = await post(base, '/api/v1/console/subscriptions/refresh', {}, { [TOKEN_HEADER]: token });
    const body = await answer.json();
    assert.equal(body.ok, true);
    // The answer is the one of this moment: the subscription that was added
    // while the first reading was on its way is in it. The reading that was
    // on its way was read before the click, and its list is an old one.
    assert.equal(body.subscriptions.some(entry => entry.id === 'qoder-cn'), true);
    // The gateway was asked again, and not only once.
    assert.ok(quotaCalls >= 2);
  });
});

test('a list that is new but whose numbers are old is not a failure', async () => {
  let withoutNumbers = false;
  await withService({
    // The row carries no window: the number of the account falls back to the
    // one that was stored, and the card is marked as old. The list of the
    // subscriptions is a new one all the same.
    '/v1/magpie/quotas?kept=1': () => ({
      data: withoutNumbers
        ? [
          { provider: 'codex', user: 'alpha@example.com', readAt: '2026-11-22T12:00:00.000Z' },
          { provider: 'codex', user: 'beta@example.com', readAt: '2026-11-22T12:00:00.000Z' },
        ]
        : [quotaRow('codex', 'alpha@example.com'), quotaRow('codex', 'beta@example.com')],
    }),
    '/v1/magpie/usage?period=today': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, providerKeys: [], accounts: [], series: [] },
    '/v1/magpie/usage/requests?period=7d&limit=1': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, by: { model: [], provider: [], agent: [] }, series: [] },
  }, async ({ base, token }) => {
    const first = await post(base, '/api/v1/console/subscriptions/refresh', {}, { [TOKEN_HEADER]: token });
    assert.equal((await first.json()).ok, true);
    withoutNumbers = true;
    const second = await post(base, '/api/v1/console/subscriptions/refresh', {}, { [TOKEN_HEADER]: token });
    const body = await second.json();
    // The gateway named the subscription again: the list is a new one, and
    // the button was asked for the list, not for the numbers.
    assert.equal(body.ok, true);
    assert.equal(body.error, '');
    assert.equal(body.subscriptions.length, 2);
  });
});

test('an empty answer after a good reading does not bring the old list back', async () => {
  let empty = false;
  await withService({
    '/v1/magpie/quotas?kept=1': () => ({
      data: empty ? [] : [quotaRow('codex', 'alpha@example.com'), quotaRow('codex', 'beta@example.com')],
    }),
    '/v1/magpie/usage?period=today': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, providerKeys: [], accounts: [], series: [] },
    '/v1/magpie/usage/requests?period=7d&limit=1': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, by: { model: [], provider: [], agent: [] }, series: [] },
  }, async ({ base, token, cards }) => {
    const first = await post(base, '/api/v1/console/subscriptions/refresh', {}, { [TOKEN_HEADER]: token });
    const firstBody = await first.json();
    assert.equal(firstBody.ok, true);
    assert.equal(firstBody.subscriptions.length, 2);
    empty = true;
    const second = await post(base, '/api/v1/console/subscriptions/refresh', {}, { [TOKEN_HEADER]: token });
    const secondBody = await second.json();
    // The gateway says that it has nothing: the old cards are not brought
    // back as though the gateway had named them.
    assert.equal(secondBody.ok, true);
    assert.equal(secondBody.error, '');
    assert.deepEqual(secondBody.subscriptions, []);
    assert.deepEqual(secondBody.shown, []);
    const onThePhone = await cards();
    assert.deepEqual(onThePhone, []);
  });
});

test('an answer that holds no list is an old list', async () => {
  await withService({
    '/v1/magpie/quotas?kept=1': { note: 'nothing here' },
    '/v1/magpie/usage?period=today': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, providerKeys: [], accounts: [], series: [] },
    '/v1/magpie/usage/requests?period=7d&limit=1': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, by: { model: [], provider: [], agent: [] }, series: [] },
  }, async ({ base, token }) => {
    const answer = await post(base, '/api/v1/console/subscriptions/refresh', {}, { [TOKEN_HEADER]: token });
    const body = await answer.json();
    // The gateway answered, but it did not say which subscriptions there are.
    // Nothing is passed for a new list.
    assert.equal(body.ok, false);
    assert.ok(body.error);
    assert.equal(body.answered, true);
    assert.equal(body.named, false);
    assert.deepEqual(body.added, []);
    assert.deepEqual(body.removed, []);
  });
});

test('the console says which cards the phone is shown', async () => {
  await withService({
    '/v1/magpie/quotas?kept=1': { data: [quotaRow('codex', 'alpha@example.com'), quotaRow('codex', 'beta@example.com'), quotaRow('minimax', 'gamma@example.com')] },
    '/v1/magpie/usage?period=today': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, providerKeys: [], accounts: [], series: [] },
    '/v1/magpie/usage/requests?period=7d&limit=1': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, by: { model: [], provider: [], agent: [] }, series: [] },
  }, async ({ base, token }) => {
    await post(base, '/api/v1/console/options', {
      subscriptions: ['*'],
      subscriptionHidden: ['minimax'],
    }, { [TOKEN_HEADER]: token });
    const answer = await fetch(base + '/api/v1/console/state', { headers: { [TOKEN_HEADER]: token } });
    const body = await answer.json();
    // The console knows the whole list and the cards that are really shown.
    assert.equal(body.subscriptions.length, 3);
    assert.deepEqual(body.shown, ['codex@alpha', 'codex@beta']);
    assert.equal(typeof body.reading.observedAt, 'string');
  });
});

test('a choice that turns off everything is refused', async () => {
  await withService({
    '/v1/magpie/quotas?kept=1': { data: [quotaRow('codex', 'alpha@example.com'), quotaRow('codex', 'beta@example.com'), quotaRow('minimax', 'gamma@example.com')] },
    '/v1/magpie/usage?period=today': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, providerKeys: [], accounts: [], series: [] },
    '/v1/magpie/usage/requests?period=7d&limit=1': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, by: { model: [], provider: [], agent: [] }, series: [] },
  }, async ({ base, token, cards }) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await cards()).length === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // The service knows the subscriptions of the gateway before it can say
    // that a choice leaves nothing.
    assert.equal((await cards()).length, 3);
    // Every subscription the gateway knows is turned off: the widgets would
    // have nothing to show, so the choice is refused.
    const answer = await post(base, '/api/v1/console/options', {
      subscriptions: ['*'],
      subscriptionHidden: ['codex@alpha', 'codex@beta', 'minimax'],
    }, { [TOKEN_HEADER]: token });
    assert.equal(answer.status, 400);
    assert.ok((await answer.json()).error);
    // Nothing was written: the phone still shows what it showed.
    assert.equal((await cards()).length, 3);
  });
});

test('a choice that does not match the gateway is kept', async () => {
  await withService({
    '/v1/magpie/quotas?kept=1': { data: [quotaRow('codex', 'alpha@example.com')] },
    '/v1/magpie/usage?period=today': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, providerKeys: [], accounts: [], series: [] },
    '/v1/magpie/usage/requests?period=7d&limit=1': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, by: { model: [], provider: [], agent: [] }, series: [] },
  }, async ({ base, token }) => {
    // The vendor of the choice has been renamed: the choice is the choice of
    // the user and it is kept, as it has always been.
    const answer = await post(base, '/api/v1/console/options', { subscriptions: ['glm'] }, { [TOKEN_HEADER]: token });
    assert.equal(answer.status, 200);
    assert.deepEqual((await answer.json()).display.subscriptions, ['glm']);
  });
});

test('a reading that fails keeps the list that was there', async () => {
  let broken = false;
  await withService({
    '/v1/magpie/quotas?kept=1': () => (broken
      ? { httpStatus: 500, body: { error: 'broken' } }
      : { data: [quotaRow('codex', 'alpha@example.com'), quotaRow('minimax', 'gamma@example.com')] }),
    '/v1/magpie/usage?period=today': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, providerKeys: [], accounts: [], series: [] },
    '/v1/magpie/usage/requests?period=7d&limit=1': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, by: { model: [], provider: [], agent: [] }, series: [] },
  }, async ({ base, token }) => {
    // The first reading works.
    const first = await post(base, '/api/v1/console/subscriptions/refresh', {}, { [TOKEN_HEADER]: token });
    assert.equal((await first.json()).ok, true);
    // The gateway stops answering: the list that was there stays, and the
    // failure is told as a failure.
    broken = true;
    const second = await post(base, '/api/v1/console/subscriptions/refresh', {}, { [TOKEN_HEADER]: token });
    const body = await second.json();
    assert.equal(body.ok, false);
    assert.ok(body.error);
    assert.equal(body.subscriptions.length, 2);
    assert.deepEqual(body.added, []);
    assert.deepEqual(body.removed, []);
    assert.deepEqual(body.hidden, []);
  });
});

test('a choice that turns off everything leaves the file as it was', async () => {
  await withService({
    '/v1/magpie/quotas?kept=1': { data: [quotaRow('codex', 'alpha@example.com'), quotaRow('minimax', 'gamma@example.com')] },
    '/v1/magpie/usage?period=today': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, providerKeys: [], accounts: [], series: [] },
    '/v1/magpie/usage/requests?period=7d&limit=1': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, by: { model: [], provider: [], agent: [] }, series: [] },
  }, async ({ base, token, dir, cards }) => {
    // The service has to know the subscriptions of the gateway before it can
    // say that a choice leaves nothing.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await cards()).length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // The service knows the subscriptions of the gateway before it can say
    // that a choice leaves nothing.
    assert.equal((await cards()).length, 2);
    // One subscription is turned off: that is written down.
    const known = (await (await fetch(base + '/api/v1/console/state', { headers: { [TOKEN_HEADER]: token } })).json())
      .subscriptions.map(entry => entry.id);
    assert.equal(known.length, 2);
    await post(base, '/api/v1/console/options', {
      subscriptions: ['*'],
      subscriptionHidden: ['minimax'],
    }, { [TOKEN_HEADER]: token });
    const before = await readFile(path.join(dir, 'state.json'), 'utf8');
    // Turning off every subscription is refused, and nothing is written.
    const answer = await post(base, '/api/v1/console/options', {
      subscriptions: ['*'],
      subscriptionHidden: known,
    }, { [TOKEN_HEADER]: token });
    assert.equal(answer.status, 400);
    const after = await readFile(path.join(dir, 'state.json'), 'utf8');
    assert.equal(after, before);
  });
});

test('a subscription that was taken away in Magpie is taken off the list of the turned off ones', async () => {
  let taken = false;
  await withService({
    '/v1/magpie/quotas?kept=1': () => ({
      data: [
        quotaRow('codex', 'alpha@example.com'),
        ...(taken ? [] : [quotaRow('minimax', 'gamma@example.com')]),
      ],
    }),
    '/v1/magpie/usage?period=today': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, providerKeys: [], accounts: [], series: [] },
    '/v1/magpie/usage/requests?period=7d&limit=1': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, by: { model: [], provider: [], agent: [] }, series: [] },
  }, async ({ base, token, dir }) => {
    await post(base, '/api/v1/console/options', {
      subscriptions: ['*'],
      subscriptionHidden: ['minimax'],
    }, { [TOKEN_HEADER]: token });
    // The subscription is taken away in Magpie and the gateway is read again.
    taken = true;
    const answer = await post(base, '/api/v1/console/subscriptions/refresh', {}, { [TOKEN_HEADER]: token });
    const body = await answer.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.removed, ['minimax']);
    // It is not turned off any more: it is gone.
    assert.deepEqual(body.hidden, []);
    const state = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(state.settings.subscriptionHidden, undefined);
  });
});

test('a vendor that was turned off stays off when one of its accounts is gone', () => {
  // The name of a vendor turns off every account of it. One account that is
  // taken away in Magpie does not bring the others back.
  const two = [
    card('codex@alpha', 'codex', 'alpha'),
    card('codex@beta', 'codex', 'beta'),
    card('minimax', 'minimax', null),
    card('qoder-cn', 'qoder-cn', null),
  ];
  const withoutBeta = two.filter(entry => entry.id !== 'codex@beta');
  assert.deepEqual(
    shown(withoutBeta, { subscriptions: ['*'], subscriptionHidden: ['codex'] }),
    ['minimax', 'qoder-cn'],
  );
  // The name of one account turns off that account only.
  assert.deepEqual(
    shown(two, { subscriptions: ['*'], subscriptionHidden: ['codex@alpha'] }),
    ['codex@beta', 'minimax', 'qoder-cn'],
  );
});

test('a choice that turns off every card does not leave the phone empty', () => {
  // The widgets need something to show: a choice that turns off every card
  // is left out, and the cards are shown as they were before it. The service
  // refuses such a choice when it is written, so this is the floor under a
  // state file that was written by hand.
  assert.deepEqual(
    shown(CARDS, { subscriptions: ['*'], subscriptionHidden: ['codex', 'minimax', 'qoder-cn'] }),
    ['codex@alpha', 'codex@beta', 'minimax', 'qoder-cn'],
  );
  // A choice that matches nothing is a choice of the user: it is kept, and
  // nothing is shown for it.
  assert.deepEqual(shown(CARDS, { subscriptions: ['glm'] }), []);
});

test('a choice that does not match the gateway is kept even when some are turned off', async () => {
  await withService({
    '/v1/magpie/quotas?kept=1': { data: [quotaRow('codex', 'alpha@example.com'), quotaRow('minimax', 'gamma@example.com')] },
    '/v1/magpie/usage?period=today': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, providerKeys: [], accounts: [], series: [] },
    '/v1/magpie/usage/requests?period=7d&limit=1': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, by: { model: [], provider: [], agent: [] }, series: [] },
  }, async ({ base, token, cards }) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await cards()).length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // The service knows the subscriptions of the gateway before the choice
    // of the user is written down.
    assert.equal((await cards()).length, 2);
    // One subscription is turned off and written down.
    await post(base, '/api/v1/console/options', {
      subscriptions: ['*'],
      subscriptionHidden: ['minimax'],
    }, { [TOKEN_HEADER]: token });
    // The list of the user names a vendor the gateway does not know. It is
    // the choice of the user, and it is kept: the choice is not the one
    // that was refused.
    const answer = await post(base, '/api/v1/console/options', {
      subscriptions: ['glm'],
    }, { [TOKEN_HEADER]: token });
    assert.equal(answer.status, 200);
    const body = await answer.json();
    assert.deepEqual(body.display.subscriptions, ['glm']);
    // The ones that were turned off stay off.
    assert.deepEqual(body.display.subscriptionHidden, ['minimax']);
  });
});

test('more subscriptions that are turned off than there can be are refused', async () => {
  await withService({
    '/v1/magpie/quotas?kept=1': { data: [quotaRow('codex', 'alpha@example.com')] },
    '/v1/magpie/usage?period=today': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, providerKeys: [], accounts: [], series: [] },
    '/v1/magpie/usage/requests?period=7d&limit=1': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, by: { model: [], provider: [], agent: [] }, series: [] },
  }, async ({ base, token, dir }) => {
    // More names than there can be: it is refused, and nothing is written.
    const many = Array.from({ length: 300 }, (unused, index) => 'v' + index);
    const answer = await post(base, '/api/v1/console/options', {
      subscriptions: ['*'],
      subscriptionHidden: many,
    }, { [TOKEN_HEADER]: token });
    assert.equal(answer.status, 400);
    assert.ok((await answer.json()).error);
    const state = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(state.settings.subscriptionHidden, undefined);
    // The same name written down many times is one name, and it is kept.
    const again = await post(base, '/api/v1/console/options', {
      subscriptions: ['*'],
      subscriptionHidden: ['minimax', 'minimax', 'minimax'],
    }, { [TOKEN_HEADER]: token });
    assert.equal(again.status, 200);
    assert.deepEqual((await again.json()).display.subscriptionHidden, ['minimax']);
  });
});

test('a refresh that takes the last visible subscription away does not blank the phone', async () => {
  let taken = false;
  await withService({
    '/v1/magpie/quotas?kept=1': () => ({
      data: [
        quotaRow('codex', 'alpha@example.com'),
        ...(taken ? [] : [quotaRow('minimax', 'gamma@example.com')]),
      ],
    }),
    '/v1/magpie/usage?period=today': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, providerKeys: [], accounts: [], series: [] },
    '/v1/magpie/usage/requests?period=7d&limit=1': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, by: { model: [], provider: [], agent: [] }, series: [] },
  }, async ({ base, token, cards }) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await cards()).length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // The service knows the subscriptions of the gateway before the choice
    // of the user is written down.
    assert.equal((await cards()).length, 2);
    const known = (await (await fetch(base + '/api/v1/console/state', { headers: { [TOKEN_HEADER]: token } })).json())
      .subscriptions.map(entry => entry.id);
    const codex = known.find(id => id.startsWith('codex'));
    // The codex subscription is turned off: only the minimax one is shown.
    await post(base, '/api/v1/console/options', {
      subscriptions: ['*'],
      subscriptionHidden: [codex],
    }, { [TOKEN_HEADER]: token });
    assert.equal((await cards()).length, 1);
    // The minimax subscription is taken away in Magpie as well: nothing is
    // left that the choice of the user keeps, and the phone is not empty.
    taken = true;
    const answer = await post(base, '/api/v1/console/subscriptions/refresh', {}, { [TOKEN_HEADER]: token });
    assert.equal((await answer.json()).ok, true);
    assert.equal((await cards()).length, 1);
  });
});

test('a subscription that was turned off stays off when its vendor gets a second account', async () => {
  // The name of a card of a vendor with one account is the name of the
  // vendor; with two accounts it is the name of the vendor and the name of
  // the account. The choice of the user is about the vendor, so it has to
  // hold when the cards of that vendor change their names.
  let two = false;
  await withService({
    '/v1/magpie/quotas?kept=1': () => ({
      data: [
        quotaRow('codex', 'alpha@example.com'),
        quotaRow('minimax', 'gamma@example.com'),
        ...(two ? [quotaRow('minimax', 'delta@example.com')] : []),
      ],
    }),
    '/v1/magpie/usage?period=today': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, providerKeys: [], accounts: [], series: [] },
    '/v1/magpie/usage/requests?period=7d&limit=1': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, by: { model: [], provider: [], agent: [] }, series: [] },
  }, async ({ base, token, dir, cards }) => {
    await post(base, '/api/v1/console/options', {
      subscriptions: ['*'],
      subscriptionHidden: ['minimax'],
    }, { [TOKEN_HEADER]: token });
    // The vendor gets a second account in Magpie: the card of the first
    // account is not called the same thing any more.
    two = true;
    const answer = await post(base, '/api/v1/console/subscriptions/refresh', {}, { [TOKEN_HEADER]: token });
    const body = await answer.json();
    assert.equal(body.ok, true);
    // The name of the vendor is still written down: the cards of that vendor
    // changed their names, the choice of the user did not.
    assert.deepEqual(body.hidden, ['minimax']);
    const state = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
    assert.deepEqual(state.settings.subscriptionHidden, ['minimax']);
    // And the phone does not show that vendor.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await cards()).length) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const onThePhone = await cards();
    assert.equal(onThePhone.length, 1);
    assert.equal(onThePhone.some(id => id.startsWith('minimax')), false);
  });
});
