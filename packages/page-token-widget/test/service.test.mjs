import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, TOKEN_HEADER } from '../lib/server.mjs';
import { ask, cleanup, freePort, mockTailscale, tempDir } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let service;
let dataDir;
let state;
let port;
let phonePort;
let base;
let phoneBase;
// The token of one phone: a token of its own, handed over once.
let phoneToken = '';

const get = (route, headers = {}) => ask(base, route, headers);

const post = (route, value, headers = {}) =>
  fetch(base + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(value || {}),
  });

// A phone pairs: a new code, then the code is used once and the phone
// gets a token of its own.
const pairPhone = async (name) => {
  await post('/api/v1/console/pair', {}, { [TOKEN_HEADER]: state.consoleToken });
  state = JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8'));
  const answer = await post('/api/v1/session', { code: state.pairing.code, name });
  assert.equal(answer.status, 200);
  const body = await answer.json();
  phoneToken = body.token;
  return body;
};

before(async () => {
  dataDir = await tempDir();
  port = await freePort();
  phonePort = await freePort();
  base = `http://127.0.0.1:${port}`;
  phoneBase = `http://127.0.0.1:${phonePort}`;
  service = await startServer({
    root,
    dataDir,
    magpieDir: dataDir,
    options: {
      port,
      phonePort,
      listenTailnet: false,
      forward: false,
      gatewayURL: 'http://127.0.0.1:1',
      // The tests never touch the real Tailscale of this computer.
      tailscaleRunner: mockTailscale().runner,
    },
  });
  state = JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8'));
  await waitForConsole();
});

// The console of the computer stays shut until the service knows that the
// forwarding of the tailnet points at the phone side.
const waitForConsole = async () => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await fetch(base + '/api/v1/console/state', {
      headers: { [TOKEN_HEADER]: state.consoleToken },
    });
    if (response.status !== 503) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the console of the service never opened');
};

after(async () => {
  await service?.close();
  await cleanup(dataDir);
});

test('the service tells that it is alive', async () => {
  const response = await fetch(base + '/health');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, '@magpie-community/page-token-widget');
});

test('the overview is only read with the token', async () => {
  await pairPhone('iPhone');
  const denied = await fetch(base + '/api/v1/overview');
  assert.equal(denied.status, 401);
  const allowed = await fetch(base + '/api/v1/overview', {
    headers: { Authorization: 'Bearer ' + phoneToken },
  });
  assert.equal(allowed.status, 200);
  const body = await allowed.json();
  assert.equal(body.schemaVersion, 1);
});

test('a pairing code is worth one try', async () => {
  await post('/api/v1/console/pair', {}, { [TOKEN_HEADER]: state.consoleToken });
  state = JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8'));
  const wrong = await post('/api/v1/session', { code: 'not-the-code' });
  assert.equal(wrong.status, 403);
  const right = await post('/api/v1/session', { code: state.pairing.code });
  assert.equal(right.status, 200);
  const body = await right.json();
  // The phone gets a token of its own, not the token of the console.
  assert.notEqual(body.token, state.consoleToken);
  assert.equal(typeof body.device.id, 'string');
  // The code is used once: the next try with the same code fails.
  const again = await post('/api/v1/session', { code: state.pairing.code });
  assert.equal(again.status, 403);
  // The new token opens the door of the phone.
  const allowed = await fetch(base + '/api/v1/overview', {
    headers: { Authorization: 'Bearer ' + body.token },
  });
  assert.equal(allowed.status, 200);
});

test('the widget of the phone carries the pairing code', async () => {
  const rotated = await post('/api/v1/console/pair', {}, { [TOKEN_HEADER]: state.consoleToken });
  assert.equal(rotated.status, 200);
  const consoleState = await rotated.json();
  const response = await fetch(base + '/scriptable/UsageWidget.js?code=' + consoleState.pairingCode);
  assert.equal(response.status, 200);
  const source = await response.text();
  assert.match(source, /let PAIRED = \{/);
  assert.match(source, /Script\.setWidget/);
  const denied = await fetch(base + '/scriptable/UsageWidget.js?code=nope');
  assert.equal(denied.status, 403);
});

test('a phone that installs by hand gets the widget with its token', async () => {
  // The setup script of the phone knows the token, not the pairing code.
  const response = await fetch(base + '/scriptable/UsageWidget.js', {
    headers: { Authorization: 'Bearer ' + phoneToken },
  });
  assert.equal(response.status, 200);
  const source = await response.text();
  assert.match(source, /Script\.setWidget/);
  // Without a pairing code there is nothing to fill in.
  assert.match(source, /let PAIRED = null;/);

  const denied = await fetch(base + '/scriptable/UsageWidget.js');
  assert.equal(denied.status, 403);
});

test('the setup script of the phone carries the port of this service', async () => {
  const response = await fetch(base + '/scriptable/SetupUsageWidget.js');
  assert.equal(response.status, 200);
  const source = await response.text();
  assert.match(source, new RegExp('const DEFAULT_PORT = ' + port + ';'));
  // The script and the widget have to agree on the keychain key.
  assert.match(source, /const SETTINGS_KEY = "ameaq-rmrcxu-b2";/);
});

test('the small widget is never empty because of an old parameter', async () => {
  const source = await readFile(path.join(root, 'scriptable', 'UsageWidget.js'), 'utf8');
  // A parameter that names an account that was renamed finds nothing; the
  // first card is shown instead and the note says what was not found.
  assert.match(source, /const card = found \|\| cards\.find\(c => c && c\.usage && c\.usage\.today\) \|\| cards\[0\];/);
  assert.match(source, /没有找到/);
  // Every number says which way it is read.
  assert.match(source, /function direction\(\)/);
  // The bar is ink in the night mode as well; a bright bar was read as a
  // warning, and a warning that means "plenty left" turns the card upside
  // down.
  assert.doesNotMatch(source, /#b9c8b0/);
});

test('the page of the phone explains the three steps', async () => {
  const rotated = await post('/api/v1/console/pair', {}, { [TOKEN_HEADER]: state.consoleToken });
  const consoleState = await rotated.json();
  const response = await fetch(base + '/p/' + consoleState.pairingCode);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /下载组件脚本/);
  assert.match(html, /UsageWidget\.js/);
  const expired = await fetch(base + '/p/nope');
  assert.equal(expired.status, 410);
  assert.match(await expired.text(), /已经失效/);
});

test('the console answers with the token only', async () => {
  const denied = await fetch(base + '/api/v1/console/state');
  assert.equal(denied.status, 403);
  const response = await fetch(base + '/api/v1/console/state', {
    headers: { [TOKEN_HEADER]: state.consoleToken },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  // The console holds no shared token any more.
  assert.equal(body.token, undefined);
  assert.equal(typeof body.pairingCode, 'string');
  assert.equal(typeof body.qr, 'string');
  // The console never hands out the hash of a token.
  assert.doesNotMatch(JSON.stringify(body), /"hash"/);
});

test('the console token of this computer does not open the door of the phone', async () => {
  const denied = await fetch(base + '/api/v1/overview', {
    headers: { Authorization: 'Bearer ' + state.consoleToken },
  });
  assert.equal(denied.status, 401);
});

test('the page of the console asks for its token before the browser sends it', async () => {
  // A navigation may read the page. A fetch from another page may not, or it
  // could take the token and read the quota of this computer.
  const navigation = await get('/', { 'sec-fetch-mode': 'navigate' });
  assert.equal(navigation.status, 200);
  assert.match(navigation.body, /name="service-token"/);
  assert.match(navigation.body, /content="[^"]{20,}"/);
  assert.doesNotMatch(navigation.body, /__SERVICE_TOKEN__/);
  assert.match(
    navigation.headers['content-security-policy'] || '',
    new RegExp('127\\.0\\.0\\.1:' + port)
  );

  const stolen = await get('/', { 'sec-fetch-mode': 'cors' });
  assert.equal(stolen.status, 403);
});

test('the choice of the subscriptions is remembered', async () => {
  const response = await post(
    '/api/v1/console/options',
    { subscriptions: ['codex'] },
    { [TOKEN_HEADER]: state.consoleToken }
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.display.subscriptions, ['codex']);
  await post('/api/v1/console/options', { subscriptions: ['*'] }, { [TOKEN_HEADER]: state.consoleToken });
});

test('a second Magpie shares the service of the first one', async () => {
  // Two Magpies on one computer both want the same port. The second one
  // joins the running service instead of failing to load.
  const second = await startServer({
    root,
    dataDir,
    magpieDir: dataDir,
    options: {
      port,
      phonePort,
      listenTailnet: false,
      forward: false,
      gatewayURL: 'http://127.0.0.1:1',
    },
  });
  assert.equal(second.shared, true);
  await second.close();

  // The first one is still the one answering.
  const response = await fetch(base + '/health');
  assert.equal(response.status, 200);
});

test('the console and the phone side are two different rooms', async () => {
  // Both listeners take the same requests, but each one knows which side it
  // belongs to. The console of this computer is only open on its own port.
  const onConsole = await get('/api/v1/console/state', { [TOKEN_HEADER]: state.consoleToken });
  assert.equal(onConsole.status, 200);

  const onPhone = await ask(phoneBase, '/api/v1/console/state', {
    host: `127.0.0.1:${port}`,
    [TOKEN_HEADER]: state.consoleToken,
  });
  assert.equal(onPhone.status, 403);
  assert.match(onPhone.body, /only opened on the computer of the service/);

  // The phone gets the page of the phone. It carries no token: the phone
  // brings its own in the address.
  const page = await ask(phoneBase, '/', {
    host: `127.0.0.1:${port}`,
    'sec-fetch-mode': 'navigate',
  });
  assert.equal(page.status, 200);
  assert.match(page.body, /用量总览/);
  assert.doesNotMatch(page.body, /name="service-token"/);
  assert.doesNotMatch(page.body, /__SERVICE_TOKEN__/);

  // The scripts of that page come with it.
  const script = await ask(phoneBase, '/app.js', { host: `127.0.0.1:${port}` });
  assert.equal(script.status, 200);
  const sheet = await ask(phoneBase, '/style.css', { host: `127.0.0.1:${port}` });
  assert.equal(sheet.status, 200);

  // What the phone came for still works there.
  const overview = await ask(phoneBase, '/api/v1/overview', {
    host: `127.0.0.1:${port}`,
    Authorization: 'Bearer ' + phoneToken,
  });
  assert.equal(overview.status, 200);
});

test('a request from the tailnet is not one of this computer', async () => {
  // The forwarding of the tailnet keeps the name the phone asked for, and a
  // name can be written by anyone. The side the request arrived on decides
  // what it may see, not the name it carries.
  const stolen = await ask(phoneBase, '/api/v1/console/state', {
    host: `127.0.0.1:${port}`,
    [TOKEN_HEADER]: state.consoleToken,
  });
  assert.equal(stolen.status, 403);
  assert.doesNotMatch(stolen.body, /"token"/);

  // The phone gets its own page, and that page carries no secret: the
  // token travels in the address of the phone, not in the page.
  const page = await ask(phoneBase, '/', {
    host: `127.0.0.1:${port}`,
    'sec-fetch-mode': 'navigate',
  });
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.body, /__SERVICE_TOKEN__/);
  assert.doesNotMatch(page.body, /name="service-token"/);

  // The console of this computer answers on its own port as before.
  const onConsole = await get('/api/v1/console/state', { [TOKEN_HEADER]: state.consoleToken });
  assert.equal(onConsole.status, 200);
});

test('the console counts the time of the pairing code itself', async () => {
  // The time left is counted on the page, from the moment the code was made.
  // If the page used the number the server sent when it was opened, the code
  // would never be renewed.
  const script = await readFile(path.join(root, 'ui', 'app.js'), 'utf8');
  const timing = await readFile(path.join(root, 'ui', 'timing.mjs'), 'utf8');
  // The time is counted from the moment the code was made, on the page.
  assert.equal(timing.includes('pairingExpiresAt'), true);
  assert.equal(timing.includes('export const pairingLeft'), true);
  // The page uses it, and it counts the time itself.
  assert.equal(script.includes("from './timing.mjs'"), true);
  assert.equal(script.includes('pairingLeft(current)'), true);
});
