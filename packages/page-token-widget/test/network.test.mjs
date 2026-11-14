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

const stateOf = async (dir) => JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));

// A request of our own: fetch will not carry a Host of our own.
const rawGet = (host, port, route, headers = {}) => new Promise((resolve, reject) => {
  const request = http.request({ host, port, path: route, headers }, (response) => {
    let body = '';
    response.on('data', (piece) => { body += piece; });
    response.on('end', () => resolve({ status: response.statusCode, body, headers: response.headers }));
  });
  request.on('error', reject);
  request.end();
});

// The question of the browser before it sends a request with a token.
const rawOptions = (host, port, route, headers = {}) => new Promise((resolve, reject) => {
  const request = http.request({ host, port, path: route, method: 'OPTIONS', headers }, (response) => {
    let body = '';
    response.on('data', (piece) => { body += piece; });
    response.on('end', () => resolve({ status: response.statusCode, body, headers: response.headers }));
  });
  request.on('error', reject);
  request.end();
});

const waitForConsole = async (base, token) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await fetch(base + '/api/v1/console/state', { headers: { [TOKEN_HEADER]: token } });
    if (response.status !== 503) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the console of the service never opened');
};

// A service of its own, so that one test cannot bother another.
const withService = async (fn, options = {}, prepared = null) => {
  const dir = await tempDir();
  if (prepared) await writeFile(path.join(dir, 'state.json'), JSON.stringify(prepared));
  const service = await start(dir, options);
  const base = `http://127.0.0.1:${service.port}`;
  const token = (await stateOf(dir)).consoleToken;
  await waitForConsole(base, token);
  try {
    await fn({ dir, service, base, token });
  } finally {
    await service.close();
    await cleanup(dir);
  }
};

test('the address the phone is told to use is checked', async () => {
  await withService(async ({ base, token }) => {
    const good = [
      // A private address of a house or an office.
      'http://192.168.1.50:3499',
      'http://10.1.2.3:3499',
      'http://172.20.0.4:3499',
      // The range a tailnet hands out.
      'http://100.64.0.5:3499',
      // The private addresses of IPv6.
      'http://[fd00::1]:3499',
      // The loopback of this computer.
      'http://127.0.0.1:3499',
      'http://[::1]:3499',
      // A name of the own network.
      'http://myserver:8080',
      'http://box.local:8080',
      'http://box.ts.net',
      // HTTPS may carry any name: the transport itself is the answer.
      'https://example.com',
      'https://my-server.example.com',
      'https://example.com:8443',
    ];
    for (const value of good) {
      const answer = await post(base, '/api/v1/console/options', { externalURL: value }, { [TOKEN_HEADER]: token });
      assert.equal(answer.status, 200, value);
    }
    const bad = [
      // Not a URL at all.
      'example.com',
      'http://exa mple.com',
      // A scheme that is not carried.
      'ftp://example.com',
      // A name and a password in the address.
      'http://user@example.com',
      'http://user:secret@example.com',
      // Ports that do not exist.
      'http://example.com:99999',
      'http://example.com:0',
      // Parameters and fragments.
      'http://example.com?token=1',
      'http://example.com#part',
      // The public internet over plain HTTP: the token would be read on the
      // way.
      'http://example.com',
      'http://93.184.216.34:3499',
      'http://[2001:db8::1]:3499',
      // A path: the routes of the service live in the root.
      'https://example.com/widget',
      'http://192.168.1.50:3499/widget',
    ];
    for (const value of bad) {
      const answer = await post(base, '/api/v1/console/options', { externalURL: value }, { [TOKEN_HEADER]: token });
      assert.equal(answer.status, 400, value);
    }
  });
});

test('a refused address says why it was refused', async () => {
  await withService(async ({ base, token }) => {
    const plain = await post(base, '/api/v1/console/options', { externalURL: 'http://example.com' }, { [TOKEN_HEADER]: token });
    assert.equal(plain.status, 400);
    const plainText = await plain.json();
    assert.match(plainText.error, /HTTPS/, 'the reason must name HTTPS');
    const path = await post(base, '/api/v1/console/options', { externalURL: 'https://example.com/widget' }, { [TOKEN_HEADER]: token });
    assert.equal(path.status, 400);
    const pathText = await path.json();
    assert.match(pathText.error, /根路径|路径/, 'the reason must say that a path is not carried');
  });
});

test('a refused address changes nothing at all', async () => {
  await withService(async ({ base, token }) => {
    await post(base, '/api/v1/console/options', { subscriptions: ['codex'] }, { [TOKEN_HEADER]: token });
    const answer = await post(
      base,
      '/api/v1/console/options',
      { externalURL: 'example.com', subscriptions: ['minimax'] },
      { [TOKEN_HEADER]: token },
    );
    assert.equal(answer.status, 400);
    const state = await (await fetch(base + '/api/v1/console/state', { headers: { [TOKEN_HEADER]: token } })).json();
    assert.equal(state.external.url, '');
    assert.deepEqual(state.display.subscriptions, ['codex']);
  });
});

test('the phone is told the address of the user', async () => {
  await withService(async ({ dir, base, token }) => {
    await post(base, '/api/v1/console/options', { externalURL: 'http://192.168.1.50:3499' }, { [TOKEN_HEADER]: token });
    const state = await (await fetch(base + '/api/v1/console/state', { headers: { [TOKEN_HEADER]: token } })).json();
    assert.equal(state.external.url, 'http://192.168.1.50:3499');
    assert.equal(state.serviceURL, 'http://192.168.1.50:3499');
    assert.ok(state.pairingURL.startsWith('http://192.168.1.50:3499/p/'), state.pairingURL);
    // A phone that pairs is told the same address.
    await post(base, '/api/v1/console/pair', {}, { [TOKEN_HEADER]: token });
    const code = (await stateOf(dir)).pairing.code;
    const session = await post(base, '/api/v1/session', { code });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).baseURL, 'http://192.168.1.50:3499');
  });
});

test('the forwarding of the tailnet is not built when the user has an address of his own', async () => {
  const mock = mockTailscale();
  await withService(async ({ base, token }) => {
    const built = mock.calls.filter((line) => line.includes('--bg'));
    assert.equal(built.length, 0);
  }, { forward: true, tailscaleRunner: mock.runner }, {
    version: 1,
    consoleToken: 'console-token-for-the-test-of-a-network-of-ones-own',
    pairing: { code: 'code-for-the-test', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() },
    settings: { externalURL: 'http://192.168.1.50:3499' },
    paired: [],
    devices: [],
  });
});

test('the phone side does not listen on an address that is not of this computer', async () => {
  await withService(async ({ base, token }) => {
    const answer = await post(base, '/api/v1/console/options', { listenAddress: '10.9.9.9' }, { [TOKEN_HEADER]: token });
    assert.equal(answer.status, 400);
    const state = await (await fetch(base + '/api/v1/console/state', { headers: { [TOKEN_HEADER]: token } })).json();
    assert.equal(state.external.listenAddress, '');
  });
});

test('the phone side listens on an address of this computer', async (t) => {
  const candidates = bindCandidates();
  if (!candidates.length) {
    t.skip('this computer has no address of its own to bind');
    return;
  }
  const address = candidates[0].address;
  await withService(async ({ base, service, token }) => {
    const answer = await post(base, '/api/v1/console/options', { listenAddress: address }, { [TOKEN_HEADER]: token });
    assert.equal(answer.status, 200);
    const state = await (await fetch(base + '/api/v1/console/state', { headers: { [TOKEN_HEADER]: token } })).json();
    assert.equal(state.external.listenAddress, address);
    // The socket is open there, and it answers as the phone side.
    const health = await fetch(`http://${address.includes(':') ? `[${address}]` : address}:${service.phonePort}/health`);
    assert.equal(health.status, 200);
  });
});

test('the door of the phone on the own network opens the phone side only', async (t) => {
  const candidates = bindCandidates();
  if (!candidates.length) {
    t.skip('this computer has no address of its own to bind');
    return;
  }
  const address = candidates[0].address;
  const host = address.includes(':') ? `[${address}]` : address;
  await withService(async ({ base, service, dir, token }) => {
    const answer = await post(base, '/api/v1/console/options', { listenAddress: address }, { [TOKEN_HEADER]: token });
    assert.equal(answer.status, 200);
    const phone = `http://${host}:${service.phonePort}`;
    // The console of this computer is not on that door, even with its token.
    const consoleAnswer = await fetch(`${phone}/api/v1/console/state`, { headers: { [TOKEN_HEADER]: token } });
    assert.equal(consoleAnswer.status, 403);
    // And the port of the console is not open on that address at all.
    await assert.rejects(fetch(`http://${host}:${service.port}/health`));
    // A name that is not ours is refused.
    const forged = await rawGet(address, service.phonePort, '/health', { Host: 'made-up.example' });
    assert.equal(forged.status, 403);
    // The page of the pairing code is open there: that is the way in.
    const code = (await stateOf(dir)).pairing.code;
    const page = await fetch(`${phone}/p/${code}`);
    assert.equal(page.status, 200);
  });
});

test('the address of the user can be cleared, and the tailnet comes back', async () => {
  const mock = mockTailscale({ status: tailscaleStatus });
  await withService(async ({ base, token }) => {
    await post(base, '/api/v1/console/options', { externalURL: 'http://192.168.1.50:3499' }, { [TOKEN_HEADER]: token });
    const before = await (await fetch(base + '/api/v1/console/state', { headers: { [TOKEN_HEADER]: token } })).json();
    assert.equal(before.serviceURL, 'http://192.168.1.50:3499');
    const answer = await post(base, '/api/v1/console/options', { externalURL: '' }, { [TOKEN_HEADER]: token });
    assert.equal(answer.status, 200);
    const after = await (await fetch(base + '/api/v1/console/state', { headers: { [TOKEN_HEADER]: token } })).json();
    assert.equal(after.external.url, '');
    // The tailnet is the way in again.
    assert.equal(after.serviceURL, `http://100.64.0.1:${after.port}`);
    // And the forwarding of the tailnet is built again.
    assert.ok(mock.calls.some((line) => line.includes('--bg')), 'the forwarding was not built');
  }, { tailscaleRunner: mock.runner, forward: true });
});

test('the port of the own network is closed for real when the tailnet comes back', async (t) => {
  const candidates = bindCandidates();
  const address = candidates.find((entry) => /^\d+\.\d+\.\d+\.\d+$/.test(entry.address));
  if (!address) {
    t.skip('this computer has no address of its own to bind');
    return;
  }
  const mock = mockTailscale({ status: tailscaleStatus });
  await withService(async ({ base, service, dir, token }) => {
    // The phone side opens on the own network of the user, and the phone is
    // told that address.
    const opened = await post(
      base,
      '/api/v1/console/options',
      { listenAddress: address.address, externalURL: `http://${address.address}:${service.phonePort}` },
      { [TOKEN_HEADER]: token },
    );
    assert.equal(opened.status, 200);
    const phone = `http://${address.address}:${service.phonePort}`;
    // The port answers on that address.
    const health = await fetch(`${phone}/health`);
    assert.equal(health.status, 200);
    // The forwarding of the tailnet is taken away, because the phone has an
    // address of its own now.
    assert.ok(mock.calls.some((line) => line.includes('off')), 'the forwarding of the tailnet was not taken away');

    // The way back to the tailnet.
    const reset = await post(base, '/api/v1/console/network/reset', {}, { [TOKEN_HEADER]: token });
    assert.equal(reset.status, 200);

    // The port of the own network is closed: it does not answer any more.
    await assert.rejects(fetch(`${phone}/health`));

    // The console of this computer still works.
    const state = await (await fetch(base + '/api/v1/console/state', { headers: { [TOKEN_HEADER]: token } })).json();
    assert.equal(state.external.url, '');
    assert.equal(state.external.listenAddress, '');
    assert.equal(state.external.mode, 'tailscale');

    // And the forwarding of the tailnet is there again.
    const built = mock.calls.filter((line) => line.includes('--bg'));
    assert.ok(built.length >= 2, 'the forwarding of the tailnet was not built again');

    // The two doors stay apart: the phone port has no console of its own.
    const consoleAnswer = await fetch(`http://127.0.0.1:${service.phonePort}/api/v1/console/state`, { headers: { [TOKEN_HEADER]: token } });
    assert.equal(consoleAnswer.status, 403);
    await assert.rejects(fetch(`http://${address.address}:${service.port}/health`));

    // The file does not remember the network of the user either.
    const saved = await stateOf(dir);
    assert.equal(saved.settings.externalURL, undefined);
    assert.equal(saved.settings.listenAddress, undefined);
  }, { tailscaleRunner: mock.runner, forward: true });
});

test('the phone side works behind an https proxy', async () => {
  await withService(async ({ base, service, dir, token }) => {
    const answer = await post(base, '/api/v1/console/options', { externalURL: 'https://example.com' }, { [TOKEN_HEADER]: token });
    assert.equal(answer.status, 200);
    const state = await (await fetch(base + '/api/v1/console/state', { headers: { [TOKEN_HEADER]: token } })).json();
    assert.equal(state.external.url, 'https://example.com');
    assert.equal(state.external.mode, 'https');
    // The phone is told the address with the scheme of the proxy.
    assert.equal(state.serviceURL, 'https://example.com');
    assert.ok(state.pairingURL.startsWith('https://example.com/p/'), state.pairingURL);

    // A token of a phone of its own.
    const created = await post(base, '/api/v1/console/device', { action: 'create', name: 'iPhone' }, { [TOKEN_HEADER]: token });
    const phoneToken = (await created.json()).token;

    // The name of the proxy is the name of the service.
    const overview = await rawGet('127.0.0.1', service.phonePort, '/api/v1/overview', {
      Host: 'example.com',
      [TOKEN_HEADER]: phoneToken,
    });
    assert.equal(overview.status, 200);

    // The page of the pairing code is there as well.
    const code = (await stateOf(dir)).pairing.code;
    const page = await rawGet('127.0.0.1', service.phonePort, `/p/${code}`, { Host: 'example.com' });
    assert.equal(page.status, 200);

    // A page of the same name over http is not the same origin.
    const downgraded = await rawGet('127.0.0.1', service.phonePort, '/health', {
      Host: 'example.com',
      Origin: 'http://example.com',
    });
    assert.equal(downgraded.status, 403);

    // An origin of another site is refused.
    const foreign = await rawGet('127.0.0.1', service.phonePort, '/health', {
      Host: 'example.com',
      Origin: 'https://another.example',
    });
    assert.equal(foreign.status, 403);

    // A name that is not ours is refused.
    const forged = await rawGet('127.0.0.1', service.phonePort, '/health', { Host: 'made-up.example' });
    assert.equal(forged.status, 403);

    // The question of the browser before a request with a token is answered.
    const preflight = await rawOptions('127.0.0.1', service.phonePort, '/api/v1/overview', {
      Host: 'example.com',
      Origin: 'https://example.com',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': TOKEN_HEADER,
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], 'https://example.com');
    assert.match(String(preflight.headers['access-control-allow-headers']), new RegExp(TOKEN_HEADER));
  });
});

test('the origin of the proxy is answered with the origin itself', async () => {
  await withService(async ({ base, service, token }) => {
    await post(base, '/api/v1/console/options', { externalURL: 'https://example.com' }, { [TOKEN_HEADER]: token });
    const answer = await rawGet('127.0.0.1', service.phonePort, '/health', {
      Host: 'example.com',
      Origin: 'https://example.com',
    });
    assert.equal(answer.status, 200);
    assert.equal(answer.headers['access-control-allow-origin'], 'https://example.com');
  });
});

test('the window of Magpie may read the scripts of the service', async () => {
  await withService(async ({ service, token }) => {
    // The window of Magpie shows the console inside a sandboxed frame. Such a
    // frame has no origin of its own; the browser calls it "null". A module
    // script is always fetched in CORS mode, so the scripts and the styles of
    // the console have to say that they may be read.
    for (const route of ['/app.js', '/timing.mjs', '/style.css']) {
      const answer = await rawGet('127.0.0.1', service.port, route, { Origin: 'null' });
      assert.equal(answer.status, 200, route);
      assert.equal(answer.headers['access-control-allow-origin'], 'null', route);
    }
    // The page that carries the token is not handed to anybody else: a site
    // on the internet must not be able to read the console of this computer.
    const page = await rawGet('127.0.0.1', service.port, '/', { Origin: 'null' });
    assert.equal(page.status, 200);
    assert.equal(page.headers['access-control-allow-origin'], undefined);
    // The answers of the console are read by that window as well.
    const state = await rawGet('127.0.0.1', service.port, '/api/v1/console/state', {
      Origin: 'null',
      [TOKEN_HEADER]: token,
    });
    assert.equal(state.status, 200);
    assert.equal(state.headers['access-control-allow-origin'], 'null');
    // Another site is still turned away at the door.
    const foreign = await rawGet('127.0.0.1', service.port, '/app.js', { Origin: 'https://another.example' });
    assert.equal(foreign.status, 403);
  });
});

test('the gateway of Magpie has to be on this computer', async () => {
  await withService(async ({ base, token }) => {
    const state = await (await fetch(base + '/api/v1/console/state', { headers: { [TOKEN_HEADER]: token } })).json();
    // The gateway of the tests is on this computer, and it is used.
    assert.equal(state.upstreamError, '');
    assert.equal(state.upstream, 'http://127.0.0.1:1');
  });
  await withService(async ({ base, token }) => {
    const state = await (await fetch(base + '/api/v1/console/state', { headers: { [TOKEN_HEADER]: token } })).json();
    // The loopback of IPv6 is the loopback as well.
    assert.equal(state.upstreamError, '');
    assert.equal(state.upstream, 'http://[::1]:3425');
  }, { gatewayURL: 'http://[::1]:3425' });
  await withService(async ({ base, token }) => {
    const state = await (await fetch(base + '/api/v1/console/state', { headers: { [TOKEN_HEADER]: token } })).json();
    assert.equal(state.upstream, '');
    assert.match(state.upstreamError, /本机/, 'the reason must say that the gateway has to be local');
  }, { gatewayURL: 'http://magpie.example.com:3425' });
});
