// The boundary of the service: who may do what, and where that is decided.
//
// The permission of a request is not written in a header the client can
// make up. It is the listener that took the connection that says it: the
// console of this computer listens on 127.0.0.1 and nothing else does, and
// every other listener — the phone, the tailnet, the own network — answers
// as a request of the phone. A Host header that says 127.0.0.1 changes
// nothing; a device in the tailnet cannot borrow the console that way.
import { after, before, test } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, TOKEN_HEADER } from '../lib/server.mjs';
import { bindCandidates } from '../lib/tailnet.mjs';
import { cleanup, freePort, mockTailscale, tailscaleStatus, tempDir } from './helpers.mjs';

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
    // The tests never touch the real Tailscale of this computer: the mock
    // answers with the status of a tailnet, so that the listener of the
    // tailnet is opened on any machine, with or without Tailscale.
    tailscaleRunner: mockTailscale({ status: tailscaleStatus }).runner,
    ...options,
  },
});

// A request of our own: fetch will not carry a Host of our own.
const raw = (host, port, route, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
  const request = http.request({ host, port, path: route, method, headers }, (response) => {
    let body = '';
    response.on('data', (piece) => { body += piece; });
    response.on('end', () => resolve({ status: response.statusCode, body, headers: response.headers }));
  });
  request.on('error', reject);
  request.end();
});

const waitFor = async (host, port, timeoutMs = 5000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      await raw(host, port, '/health');
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  return false;
};

const stateOf = async (dir) => JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));

let dir = '';
let service = null;

before(async () => {
  dir = await tempDir();
  // The tailnet listener is bound to 127.0.0.2 instead of the address of the
  // tailnet, because a test cannot own a 100.64.x address. The address does
  // not decide the permission: the listener does. That is the whole point of
  // this file.
  service = await start(dir, { listenTailnet: true, tailnetAddress: '127.0.0.2' });
});

after(async () => {
  if (service) await service.close();
  await cleanup(dir);
});

test('a request on the tailnet listener is a request of the phone, whatever its Host says', async () => {
  const { port } = service;
  assert.ok(await waitFor('127.0.0.2', port), 'the tailnet listener has to answer');
  const token = (await stateOf(dir)).consoleToken;
  const forged = { Host: `127.0.0.1:${port}`, 'sec-fetch-mode': 'navigate' };

  // The page of the phone comes, not the page of the console: the token of
  // the service is not in it.
  const page = await raw('127.0.0.2', port, '/', forged);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.body, new RegExp(token));
  assert.doesNotMatch(page.body, /__SERVICE_TOKEN__/);

  // The console wants its own token, and a borrowed Host is not one.
  const console_ = await raw('127.0.0.2', port, '/api/v1/console/state', {
    ...forged,
    [TOKEN_HEADER]: token,
  });
  assert.equal(console_.status, 403);

  // The console's own files are not on the phone's side either: the phone has
  // a script of its own, and the script of the console never comes.
  const script = await raw('127.0.0.2', port, '/app.js', forged);
  assert.equal(script.status, 200);
  assert.doesNotMatch(script.body, /api\/v1\/console/);
  assert.doesNotMatch(script.body, new RegExp(token));
});

test('the console of this computer answers only with its own token', async () => {
  const { port } = service;
  const token = (await stateOf(dir)).consoleToken;

  const without = await raw('127.0.0.1', port, '/api/v1/console/state', { Host: `127.0.0.1:${port}` });
  assert.equal(without.status, 403);

  const with_ = await raw('127.0.0.1', port, '/api/v1/console/state', {
    Host: `127.0.0.1:${port}`,
    [TOKEN_HEADER]: token,
  });
  assert.equal(with_.status, 200);

  // The page of the console carries the token — on this computer only.
  const page = await raw('127.0.0.1', port, '/', { Host: `127.0.0.1:${port}`, 'sec-fetch-mode': 'navigate' });
  assert.equal(page.status, 200);
  assert.match(page.body, new RegExp(token));
});

test('a phone still pairs over the tailnet', async () => {
  const { port } = service;
  const state = await stateOf(dir);
  const answer = await raw('127.0.0.2', port, '/api/v1/session', {
    'Content-Type': 'application/json',
    Host: `127.0.0.1:${port}`,
  }, 'POST');
  assert.equal(answer.status, 400); // no code, no phone

  const paired = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ code: state.pairing.code, name: 'a phone of the tailnet' });
    const request = http.request({
      host: '127.0.0.2',
      port,
      path: '/api/v1/session',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Host: `127.0.0.1:${port}` },
    }, (response) => {
      let text = '';
      response.on('data', (piece) => { text += piece; });
      response.on('end', () => resolve({ status: response.statusCode, body: text }));
    });
    request.on('error', reject);
    request.end(body);
  });
  assert.equal(paired.status, 200);
  const device = JSON.parse(paired.body);
  assert.ok(device.token);

  // And the phone reads its numbers with that token.
  const overview = await raw('127.0.0.2', port, '/api/v1/overview', {
    Host: `127.0.0.1:${port}`,
    Authorization: `Bearer ${device.token}`,
  });
  assert.equal(overview.status, 200);
});

test('the door of the own network opens the phone side only', async (t) => {
  // The address of the own network is an address of this computer. A wire
  // comes first, a virtual adapter is the next best thing.
  const candidates = bindCandidates();
  const own = candidates.find((entry) => entry.kind === 'wifi' || entry.kind === 'ethernet')
    || candidates.find((entry) => entry.kind !== 'tailscale');
  if (!own) {
    // A computer without a private address has nothing to open. It is said
    // out loud, so that a green run never hides a test that did nothing.
    return t.skip('this computer has no private address of its own');
  }

  const lanDir = await tempDir();
  // The address of the own network is not an option of the service: it is
  // what the user wrote down, and it is read from the state file.
  await writeFile(
    path.join(lanDir, 'state.json'),
    JSON.stringify({
      version: 1,
      consoleToken: 'c'.repeat(43),
      settings: { listenAddress: own.address },
    }),
  );
  const lan = await start(lanDir);
  try {
    const { port, phonePort } = lan;
    assert.ok(await waitFor(own.address, phonePort), 'the phone side has to answer on the own network');
    const token = (await stateOf(lanDir)).consoleToken;
    const forged = { Host: `127.0.0.1:${port}` };

    const page = await raw(own.address, phonePort, '/', forged);
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.body, new RegExp(token));

    const console_ = await raw(own.address, phonePort, '/api/v1/console/state', {
      ...forged,
      [TOKEN_HEADER]: token,
    });
    assert.equal(console_.status, 403);
  } finally {
    await lan.close();
    await cleanup(lanDir);
  }
});
