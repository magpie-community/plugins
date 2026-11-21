import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, TOKEN_HEADER } from '../lib/server.mjs';
import { cleanup, freePort, mockTailscale, startGateway, tempDir } from './helpers.mjs';


const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
    // The tests never touch the real Tailscale of this computer.
    tailscaleRunner: mockTailscale().runner,
    ...options,
  },
});

const post = (base, route, value, headers = {}) => fetch(base + route, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(value || {}),
});

let dir;
let service;
let base;

before(async () => {
  dir = await tempDir();
  service = await start(dir);
  base = `http://127.0.0.1:${service.port}`;
});

after(async () => {
  await service?.close();
  await cleanup(dir);
});

const consoleToken = async () =>
  JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')).consoleToken;

// A phone asks the service for its own token with the pairing code.
const pairDevice = async () => {
  const state = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
  const answer = await post(base, '/api/v1/session', { code: state.pairing.code, name: 'test phone' });
  assert.equal(answer.status, 200);
  return (await answer.json()).token;
};

const waitForConsole = async () => {
  const token = await consoleToken();
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await fetch(base + '/api/v1/console/state', { headers: { [TOKEN_HEADER]: token } });
    if (response.status !== 503) return token;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the console of the service never opened');
};

test('the service starts with sensible defaults', async () => {
  const token = await waitForConsole();
  const state = await (await fetch(base + '/api/v1/console/state', { headers: { [TOKEN_HEADER]: token } })).json();
  assert.equal(state.refresh.strategy, 'smart');
  assert.ok(state.refresh.label);
  assert.deepEqual(state.display.subscriptions, ['codex', 'minimax', 'glm']);
  assert.equal(state.port > 0, true);
  // The phone side has a port of its own, and it is not the console.
  assert.equal(state.phonePort > 0, true);
  assert.notEqual(state.phonePort, state.port);
  assert.match(state.upstream, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test('a rhythm the service does not know falls back to the smart one', async () => {
  const token = await consoleToken();
  const answer = await post(base, '/api/v1/console/options', { refreshStrategy: 'every minute' }, { [TOKEN_HEADER]: token });
  assert.equal(answer.status, 200);
  const body = await answer.json();
  assert.equal(body.refresh.strategy, 'smart');
});

test('the rhythm of the reading changes at once', async () => {
  const token = await consoleToken();
  const answer = await post(base, '/api/v1/console/options', { refreshStrategy: '5m' }, { [TOKEN_HEADER]: token });
  assert.equal(answer.status, 200);
  // The collector knows it at once: the service does not have to be started
  // again for that.
  assert.equal(service.collector.strategy, '5m');
  const state = await (await fetch(base + '/api/v1/console/state', { headers: { [TOKEN_HEADER]: token } })).json();
  assert.equal(state.refresh.strategy, '5m');
});

test('the rhythm is still there after the service starts again', async () => {
  await service.close();
  service = await start(dir);
  base = `http://127.0.0.1:${service.port}`;
  await waitForConsole();
  assert.equal(service.collector.strategy, '5m');
});

test('the choice of the subscriptions is checked', async () => {
  const token = await consoleToken();
  // A list that is empty falls back to the default.
  const empty = await post(base, '/api/v1/console/options', { subscriptions: [] }, { [TOKEN_HEADER]: token });
  assert.equal((await empty.json()).display.subscriptions.length, 3);
  // A name that is not a name is not taken.
  const wrong = await post(base, '/api/v1/console/options', { subscriptions: ['<script>'] }, { [TOKEN_HEADER]: token });
  assert.deepEqual((await wrong.json()).display.subscriptions, ['codex', 'minimax', 'glm']);
  // A real choice is kept.
  const good = await post(base, '/api/v1/console/options', { subscriptions: ['codex'] }, { [TOKEN_HEADER]: token });
  assert.deepEqual((await good.json()).display.subscriptions, ['codex']);
});

test('the look of the widget is chosen on the plugin side', async () => {
  const token = await consoleToken();
  // The direction of the numbers.
  const used = await post(base, '/api/v1/console/options', { widgetMode: 'used' }, { [TOKEN_HEADER]: token });
  assert.equal(used.status, 200);
  assert.equal((await used.json()).display.widgetMode, 'used');
  // A word that is not a direction is not a direction.
  const wrong = await post(base, '/api/v1/console/options', { widgetMode: 'sideways' }, { [TOKEN_HEADER]: token });
  assert.equal((await wrong.json()).display.widgetMode, 'remaining');
  // The card of the small widget.
  const card = await post(base, '/api/v1/console/options', { widgetCard: 'Codex@Alice' }, { [TOKEN_HEADER]: token });
  assert.equal((await card.json()).display.widgetCard, 'codex@Alice');
  // A name that is not a name is not a card.
  const bad = await post(base, '/api/v1/console/options', { widgetCard: '<script>' }, { [TOKEN_HEADER]: token });
  assert.equal((await bad.json()).display.widgetCard, '');
  // The phone reads the choice as well.
  const overview = await fetch(base + '/api/v1/overview', {
    headers: { Authorization: 'Bearer ' + (await pairDevice()) },
  });
  assert.equal(overview.status, 200);
  assert.equal((await overview.json()).display.widgetMode, 'remaining');
});

test('the choices survive a restart of the service', async () => {
  await service.close();
  service = await start(dir);
  base = `http://127.0.0.1:${service.port}`;
  const token = await waitForConsole();
  const state = await (await fetch(base + '/api/v1/console/state', { headers: { [TOKEN_HEADER]: token } })).json();
  assert.deepEqual(state.display.subscriptions, ['codex']);
  assert.equal(state.refresh.strategy, '5m');
  // The look of the widget is a choice too, and it survives the restart.
  assert.equal(state.display.widgetMode, 'remaining');
  assert.equal(state.display.widgetCard, '');
  await post(base, '/api/v1/console/options', { widgetMode: 'used', widgetCard: 'codex@Alice' }, { [TOKEN_HEADER]: token });
  await service.close();
  service = await start(dir);
  base = `http://127.0.0.1:${service.port}`;
  const again = await waitForConsole();
  const after = await (await fetch(base + '/api/v1/console/state', { headers: { [TOKEN_HEADER]: again } })).json();
  assert.equal(after.display.widgetMode, 'used');
  assert.equal(after.display.widgetCard, 'codex@Alice');
});

test('the order of the subscriptions reaches the phone and stays there', async () => {
  // The order the user gives by dragging the rows is the order the phone
  // shows, and it is still that order when the service starts again.
  const quotaRow = (provider, user) => ({
    provider,
    user,
    readAt: '2026-11-13T12:00:00.000Z',
    windows: [{ name: '5h', used: 12, remaining: 88, resetsAt: '2026-11-13T17:00:00.000Z' }],
  });
  const gateway = await startGateway({
    '/v1/magpie/quotas?kept=1': { data: [quotaRow('codex', 'alpha@example.com'), quotaRow('codex', 'beta@example.com'), quotaRow('minimax', 'gamma@example.com')] },
    '/v1/magpie/usage?period=today': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, providerKeys: [], accounts: [], series: [] },
    '/v1/magpie/usage/requests?period=7d&limit=1': { calls: 10, input: 100, output: 50, cache_read: 0, cache_write: 0, by: { model: [], provider: [], agent: [] }, series: [] },
  });
  const local = await tempDir();
  let own = await start(local, { gatewayURL: gateway.url });
  const ownBase = `http://127.0.0.1:${own.port}`;
  try {
    const consoleToken = JSON.parse(await readFile(path.join(local, 'state.json'), 'utf8')).consoleToken;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const response = await fetch(ownBase + '/api/v1/console/state', { headers: { [TOKEN_HEADER]: consoleToken } });
      if (response.status !== 503) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const paired = JSON.parse(await readFile(path.join(local, 'state.json'), 'utf8'));
    const session = await post(ownBase, '/api/v1/session', { code: paired.pairing.code, name: '排序的手机' });
    const phoneToken = (await session.json()).token;
    const readCards = async () => {
      const answer = await fetch(ownBase + '/api/v1/overview', { headers: { Authorization: 'Bearer ' + phoneToken } });
      const body = await answer.json();
      return (body.subscriptions || []).map(card => card.id);
    };
    // The first reading waits for the gateway; the cards are there then.
    let cards = [];
    for (let attempt = 0; attempt < 20 && cards.length < 3; attempt += 1) {
      cards = await readCards();
      if (cards.length < 3) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.deepEqual(cards.sort(), ['codex@alpha', 'codex@beta', 'minimax']);

    // The order the console writes is the order the phone gets.
    const chosen = await post(ownBase, '/api/v1/console/options', { subscriptions: ['minimax', 'codex@alpha'] }, { [TOKEN_HEADER]: consoleToken });
    assert.equal(chosen.status, 200);
    assert.deepEqual(await readCards(), ['minimax', 'codex@alpha']);

    // And it is still that order after the service starts again.
    await own.close();
    own = await start(local, { gatewayURL: gateway.url });
    const again = `http://127.0.0.1:${own.port}`;
    const state = JSON.parse(await readFile(path.join(local, 'state.json'), 'utf8'));
    assert.deepEqual(state.settings.subscriptions, ['minimax', 'codex@alpha']);
    const answer = await fetch(again + '/api/v1/overview', { headers: { Authorization: 'Bearer ' + phoneToken } });
    assert.equal(answer.status, 200);
    const body = await answer.json();
    assert.deepEqual(body.subscriptions.map(card => card.id), ['minimax', 'codex@alpha']);
  } finally {
    await own.close();
    await gateway.close();
    await cleanup(local);
  }
});

test('the diagnosis does not change the network of this computer', async () => {
  const mock = mockTailscale();
  // Another service has its own forwarding.
  mock.serve.TCP['9999'] = { TCPForward: '127.0.0.1:9999' };
  const local = await tempDir();
  const other = await start(local, { tailscaleRunner: mock.runner });
  const otherBase = `http://127.0.0.1:${other.port}`;
  try {
    const state = JSON.parse(await readFile(path.join(local, 'state.json'), 'utf8'));
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const response = await fetch(otherBase + '/api/v1/console/state', { headers: { [TOKEN_HEADER]: state.consoleToken } });
      if (response.status !== 503) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const answer = await post(otherBase, '/api/v1/console/diagnose', {}, { [TOKEN_HEADER]: state.consoleToken });
    assert.equal(answer.status, 200);
    const body = await answer.json();
    assert.ok(body.tailnet);
    assert.ok('ping' in body);
    // Nothing was published and nothing was taken away.
    assert.deepEqual(mock.serve.TCP, { '9999': { TCPForward: '127.0.0.1:9999' } });
  } finally {
    await other.close();
    await cleanup(local);
  }
});

test('the port of the service comes from the plugin and is kept', async () => {
  const file = path.join(dir, 'state.json');
  const state = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(typeof state.consoleToken, 'string');
  assert.ok(state.consoleToken.length >= 32);
  // There is no shared token for the phones any more.
  assert.equal(state.token, undefined);
  assert.equal(Array.isArray(state.devices), true);
});

test('a damaged state file does not stop the service', async () => {
  const local = await tempDir();
  await writeFile(path.join(local, 'state.json'), '{ this is not json');
  const other = await start(local);
  try {
    const state = JSON.parse(await readFile(path.join(local, 'state.json'), 'utf8'));
    assert.equal(typeof state.consoleToken, 'string');
    assert.equal(state.version, 1);
  } finally {
    await other.close();
    await cleanup(local);
  }
});

test('the console stays shut while a rule of an older version points at it', async () => {
  // A rule that an older version left behind can point the published port
  // at the console of this computer. Then the console must not open: it
  // carries the token of the console.
  const mock = mockTailscale();
  const local = await tempDir();
  const port = await freePort();
  mock.serve.TCP[String(port)] = { TCPForward: `127.0.0.1:${port}` };
  const service = await start(local, { port, tailscaleRunner: mock.runner });
  try {
    const state = JSON.parse(await readFile(path.join(local, 'state.json'), 'utf8'));
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/console/state`, {
      headers: { [TOKEN_HEADER]: state.consoleToken },
    });
    assert.equal(response.status, 503);
    // The page of the computer is not given out either.
    const page = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { 'Sec-Fetch-Mode': 'navigate' },
    });
    assert.equal(page.status, 503);
  } finally {
    await service.close();
    await cleanup(local);
  }
});

test('the temporary files of a run that was killed are swept away', async () => {
  // A write that was killed between the write and the move leaves its
  // temporary file behind. Nothing ever reads it, but it should not pile up.
  const local = await tempDir();
  const old = path.join(local, 'state.json.1234.deadbeef.tmp');
  await writeFile(old, 'half a file');
  const stale = new Date(Date.now() - 3 * 60 * 60 * 1000);
  await utimes(old, stale, stale);
  // A write that is running right now has a fresh file of the same name.
  // It must not be swept away, and neither may a file of somebody else.
  const fresh = path.join(local, 'state.json.1234.cafe.tmp');
  await writeFile(fresh, 'a file of this very moment');
  const foreign = path.join(local, 'notes.tmp');
  await writeFile(foreign, 'a note of somebody else');
  const backup = path.join(local, 'state.json.bak');
  await writeFile(backup, 'a copy of yesterday');
  const service = await start(local);
  try {
    const names = await readdir(local);
    assert.equal(names.includes(path.basename(old)), false);
    assert.equal(names.includes(path.basename(fresh)), true);
    assert.equal(names.includes(path.basename(foreign)), true);
    assert.equal(names.includes(path.basename(backup)), true);
  } finally {
    await service.close();
    await cleanup(local);
  }
});

test('the gateway of Magpie comes from the plugin option and nothing else', async () => {
  const local = await tempDir();
  const first = await start(local);
  await first.close();
  // An old state file may still carry a gateway that an earlier version
  // wrote down. It is not read any more: the plugin option is the only
  // place the address comes from.
  const file = path.join(local, 'state.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.settings.gatewayURL = 'http://127.0.0.1:3999';
  await writeFile(file, JSON.stringify(saved, null, 2), 'utf8');
  const second = await start(local, { gatewayURL: 'http://127.0.0.1:1' });
  try {
    const token = JSON.parse(await readFile(file, 'utf8')).consoleToken;
    const shown = await (await fetch(`http://127.0.0.1:${second.port}/api/v1/console/state`, { headers: { [TOKEN_HEADER]: token } })).json();
    assert.equal(shown.upstream, 'http://127.0.0.1:1');
  } finally {
    await second.close();
    await cleanup(local);
  }
});
