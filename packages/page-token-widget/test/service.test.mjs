import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { startServer } from '../lib/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 18799;
const base = `http://127.0.0.1:${port}`;
// The phone side of the service listens on a port of its own. The forwarding
// of Tailscale points the published port at it.
const phonePort = port + 1;
const phoneBase = `http://127.0.0.1:${phonePort}`;
const TOKEN_HEADER = 'x-token-widget-token';

// The browser does not let a page set Sec-Fetch-Mode, so a plain request is
// the only way to pretend to be a navigation.
const ask = (origin, route, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = httpRequest(origin + route, { headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });

const get = (route, headers = {}) => ask(base, route, headers);

let service;
let dataDir;
let state;

const post = (route, value, headers = {}) =>
  fetch(base + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(value || {}),
  });

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'page-token-widget-'));
  service = await startServer({
    root,
    dataDir,
    magpieDir: dataDir,
    options: { port, listenTailnet: false, forward: false, gatewayURL: 'http://127.0.0.1:1' },
  });
  state = JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8'));
  await waitForConsole();
});

// The console of the computer stays shut until the service knows that the
// forwarding of the tailnet points at the phone side.
const waitForConsole = async () => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await fetch(base + '/api/v1/console/state', {
      headers: { [TOKEN_HEADER]: state.token },
    });
    if (response.status !== 503) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the console of the service never opened');
};

after(async () => {
  await service?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('the service tells that it is alive', async () => {
  const response = await fetch(base + '/health');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, '@magpie-community/page-token-widget');
});

test('the overview is only read with the token', async () => {
  const denied = await fetch(base + '/api/v1/overview');
  assert.equal(denied.status, 401);
  const allowed = await fetch(base + '/api/v1/overview', {
    headers: { Authorization: 'Bearer ' + state.token },
  });
  assert.equal(allowed.status, 200);
  const body = await allowed.json();
  assert.equal(body.schemaVersion, 1);
});

test('a pairing code is worth one try', async () => {
  const wrong = await post('/api/v1/session', { code: 'not-the-code' });
  assert.equal(wrong.status, 403);
  const right = await post('/api/v1/session', { code: state.pairing.code });
  assert.equal(right.status, 200);
  const body = await right.json();
  assert.equal(body.token, state.token);
  const again = await post('/api/v1/session', { code: state.pairing.code });
  assert.equal(again.status, 403);
});

test('the widget of the phone carries the pairing code', async () => {
  const rotated = await post('/api/v1/console/pair', {}, { [TOKEN_HEADER]: state.token });
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
    headers: { Authorization: 'Bearer ' + state.token },
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

test('the page of the phone explains the three steps', async () => {
  const rotated = await post('/api/v1/console/pair', {}, { [TOKEN_HEADER]: state.token });
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
    headers: { [TOKEN_HEADER]: state.token },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.token, state.token);
  assert.equal(typeof body.pairingCode, 'string');
  assert.equal(typeof body.qr, 'string');
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
    { [TOKEN_HEADER]: state.token }
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.display.subscriptions, ['codex']);
  await post('/api/v1/console/options', { subscriptions: ['*'] }, { [TOKEN_HEADER]: state.token });
});

test('a second Magpie shares the service of the first one', async () => {
  // Two Magpies on one computer both want the same port. The second one
  // joins the running service instead of failing to load.
  const second = await startServer({
    root,
    dataDir,
    magpieDir: dataDir,
    options: { port, listenTailnet: false, forward: false, gatewayURL: 'http://127.0.0.1:1' },
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
  const onConsole = await get('/api/v1/console/state', { [TOKEN_HEADER]: state.token });
  assert.equal(onConsole.status, 200);

  const onPhone = await ask(phoneBase, '/api/v1/console/state', {
    host: `127.0.0.1:${port}`,
    [TOKEN_HEADER]: state.token,
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
    Authorization: 'Bearer ' + state.token,
  });
  assert.equal(overview.status, 200);
});

test('a request from the tailnet is not one of this computer', async () => {
  // The forwarding of the tailnet keeps the name the phone asked for, and a
  // name can be written by anyone. The side the request arrived on decides
  // what it may see, not the name it carries.
  const stolen = await ask(phoneBase, '/api/v1/console/state', {
    host: `127.0.0.1:${port}`,
    [TOKEN_HEADER]: state.token,
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
  assert.doesNotMatch(page.body, /state\.token/);

  // The console of this computer answers on its own port as before.
  const onConsole = await get('/api/v1/console/state', { [TOKEN_HEADER]: state.token });
  assert.equal(onConsole.status, 200);
});
