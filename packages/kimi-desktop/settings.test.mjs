import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { KimiAdapter } from './adapter.mjs';
import KimiDesktop from './index.mjs';
import { startSettingsServer, TOKEN_HEADER } from './settings.mjs';

const initial = () => ({
  enabled: true, primaryModel: 'example/main', secondaryModel: '', status: 'connected',
  models: [{ id: 'example/main', name: 'Main' }, { id: 'example/secondary', name: 'Secondary' }],
});
const close = server => new Promise(resolve => server.close(resolve));
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

async function fixture(callbacks = {}) {
  // Production rejects port 0: reserve and release one only to choose this
  // fixture's explicit configured port, then verify the service keeps it.
  const reservation = createServer();
  const port = await listen(reservation);
  await close(reservation);
  let state = initial();
  const saved = [];
  const service = await startSettingsServer({
    port,
    readSettings: callbacks.readSettings || (() => state),
    saveSettings: callbacks.saveSettings || (body => {
      saved.push(body);
      state = { ...state, ...body, status: 'waiting_kimi_idle' };
      return state;
    }),
  });
  const raw = (method, path, headers = {}, body) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, method, path, headers: {
      host: `127.0.0.1:${port}`, connection: 'close', ...headers,
    } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
  const page = await raw('GET', '/');
  const token = /name="magpie-kimi-settings-token" content="([0-9a-f]{64})"/.exec(page.text)?.[1];
  const auth = { origin: 'null', [TOKEN_HEADER]: token };
  return { service, raw, page, token, auth, saved, port };
}

test('the opaque page receives its own token and concrete proxy CSP, without HTML CORS', async () => {
  const f = await fixture();
  try {
    expect(f.service.port).toBe(f.port);
    expect(f.token).toMatch(/^[a-f0-9]{64}$/);
    expect(f.page.headers['access-control-allow-origin']).toBeUndefined();
    const page = await f.raw('GET', '/?theme=dark&uiOrigin=' + encodeURIComponent('https://magpie.example:444'), { origin: 'null' });
    expect(page.status).toBe(200);
    expect(page.headers['access-control-allow-origin']).toBeUndefined();
    expect(page.headers['content-security-policy']).toContain(`connect-src http://127.0.0.1:${f.port} http://localhost:${f.port} https://magpie.example:444;`);
    expect(page.text).toContain('data-theme="dark"');
    expect(page.text).toContain(`'${TOKEN_HEADER}': token`);
    expect(page.text).not.toContain('__KIMI_SETTINGS_');
    expect((await f.raw('GET', '/?uiOrigin=' + encodeURIComponent("https://magpie.example; script-src *"))).status).toBe(400);
    expect((await f.raw('GET', '/?uiOrigin=' + encodeURIComponent('https://magpie.example/path'))).status).toBe(400);
    const script = /<script nonce="[a-f0-9]+">([\s\S]*?)<\/script>/.exec(page.text)?.[1];
    expect(typeof script).toBe('string');
    new Function(script);
  } finally { await f.service.stop(); }
});

test('API requests require the page token and exact loopback Host and Origin', async () => {
  const f = await fixture();
  try {
    for (const origin of [undefined, 'null']) {
      expect((await f.raw('GET', '/api/settings', origin ? { origin } : {})).status).toBe(403);
    }
    expect((await f.raw('GET', '/api/settings', { ...f.auth, [TOKEN_HEADER]: '0'.repeat(64) })).status).toBe(403);
    for (const headers of [
      { ...f.auth, host: `evil.example:${f.port}` },
      { ...f.auth, host: '127.0.0.1:1' },
      { ...f.auth, origin: 'https://evil.example' },
      { ...f.auth, origin: `http://127.0.0.1:${f.port + 1}` },
    ]) {
      const denied = await f.raw('GET', '/api/settings', headers);
      expect(denied.status).toBe(403);
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    }
    const preflight = await f.raw('OPTIONS', '/api/settings', {
      origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': TOKEN_HEADER + ', content-type',
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('null');
    expect(preflight.headers['access-control-allow-headers']).toContain(TOKEN_HEADER);
    const state = await f.raw('GET', '/api/settings', f.auth);
    expect(state.status).toBe(200);
    expect(state.headers['access-control-allow-origin']).toBe('null');
    expect(state.json()).toEqual(initial());
    expect((await f.raw('GET', '/api/settings', { ...f.auth, origin: `http://localhost:${f.port}` })).status).toBe(200);
  } finally { await f.service.stop(); }
});

test('model patches stay narrow; blank secondary inherits and saving does not imply applied', async () => {
  const f = await fixture();
  try {
    const headers = { ...f.auth, 'content-type': 'application/json; charset=utf-8' };
    const saved = await f.raw('POST', '/api/settings', headers, { secondaryModel: 'example/secondary' });
    expect(saved.status).toBe(200);
    expect(f.saved).toEqual([{ secondaryModel: 'example/secondary' }]);
    expect(saved.json().status).toBe('waiting_kimi_idle');
    expect(saved.json().appliedSecondaryModel).toBeUndefined();
    const cleared = await f.raw('POST', '/api/settings', headers, { secondaryModel: '' });
    expect(cleared.status).toBe(200);
    expect(f.saved.at(-1)).toEqual({ secondaryModel: '' });
    for (const body of [null, [], {}, { primaryModel: '' }, { primaryModel: 1 }, { secondaryModel: 1 },
      { secondaryModel: '', enabled: true }, { secondaryModel: '', effort: 'high' }]) {
      expect((await f.raw('POST', '/api/settings', headers, body)).status).toBe(400);
    }
    expect((await f.raw('POST', '/api/settings', headers, '{')).json().error).toBe('invalid_json');
    expect((await f.raw('POST', '/api/settings', f.auth, { secondaryModel: '' })).status).toBe(415);
    const huge = JSON.stringify({ secondaryModel: 'a'.repeat(9 * 1024) });
    expect((await f.raw('POST', '/api/settings', { ...headers, 'content-length': Buffer.byteLength(huge) }, huge)).status).toBe(413);
    expect((await f.raw('POST', '/api/settings', { ...headers, 'transfer-encoding': 'chunked' }, huge)).status).toBe(413);
    expect(f.saved).toHaveLength(2);
  } finally { await f.service.stop(); }
});

test('a primary-only settings request reaches the saver without inventing a secondary change', async () => {
  const f = await fixture();
  try {
    const saved = await f.raw('POST', '/api/settings', { ...f.auth, 'content-type': 'application/json' },
      { primaryModel: 'example/secondary' });
    expect(saved.status).toBe(200);
    expect(f.saved).toEqual([{ primaryModel: 'example/secondary' }]);
    expect(saved.json().primaryModel).toBe('example/secondary');
    expect(saved.json().status).toBe('waiting_kimi_idle');
    const pair = { primaryModel: 'example/main', secondaryModel: '' };
    expect((await f.raw('POST', '/api/settings', { ...f.auth, 'content-type': 'application/json' }, pair)).status).toBe(200);
    expect(f.saved.at(-1)).toEqual(pair);
  } finally { await f.service.stop(); }
});

test('callbacks own model validation, DTO projection and sanitized errors', async () => {
  let saveError = Object.assign(new Error('private callback details'), { code: 'model_not_enabled_for_kimi' });
  let readError = null;
  const f = await fixture({
    readSettings: () => {
      if (readError) throw readError;
      return { ...initial(), privateConfig: 'private sentinel', appliedPrimaryModel: 'example/main', appliedSecondaryModel: 'example/main',
        models: [{ id: 'example/main', name: 'Main', privateField: 'private sentinel' }] };
    },
    saveSettings: () => { throw saveError; },
  });
  try {
    const state = await f.raw('GET', '/api/settings', f.auth);
    expect(state.json().appliedSecondaryModel).toBe('example/main');
    expect(state.json().appliedPrimaryModel).toBe('example/main');
    expect(state.text).not.toContain('private sentinel');
    const headers = { ...f.auth, 'content-type': 'application/json' };
    const rejected = await f.raw('POST', '/api/settings', headers, { secondaryModel: 'not/in/list' });
    expect(rejected.status).toBe(400);
    expect(rejected.json()).toEqual({ error: 'model_not_enabled_for_kimi' });
    for (const [code, status] of [['primary_model_unavailable', 503], ['primary_model_update_failed', 502], ['settings_partially_saved', 409]]) {
      saveError = Object.assign(new Error('private callback details'), { code });
      const result = await f.raw('POST', '/api/settings', headers, { primaryModel: 'example/secondary' });
      expect(result.status).toBe(status);
      expect(result.json()).toEqual({ error: code });
    }
    saveError = Object.assign(new Error('private callback details'), { code: 'private_code' });
    const failed = await f.raw('POST', '/api/settings', headers, { secondaryModel: '' });
    expect(failed.status).toBe(500);
    expect(failed.json()).toEqual({ error: 'settings_save_failed' });
    readError = new Error('private callback details');
    const unreadable = await f.raw('GET', '/api/settings', f.auth);
    expect(unreadable.json()).toEqual({ error: 'settings_read_failed' });
  } finally { await f.service.stop(); }
});

test('the service rejects a held configured port and tokens are per instance', async () => {
  const f = await fixture();
  const other = await fixture();
  try {
    await expect(startSettingsServer({ port: f.port, readSettings: initial, saveSettings: initial })).rejects.toThrow('settings_port_in_use');
    expect((await f.raw('GET', '/api/settings', { ...f.auth, [TOKEN_HEADER]: other.token })).status).toBe(403);
    await expect(startSettingsServer({ port: 0, readSettings: initial, saveSettings: initial })).rejects.toThrow('settings_invalid_port');
  } finally { await f.service.stop(); await other.service.stop(); }
});

test('adapter shutdown closes its settings HTTP service', async () => {
  const f = await fixture();
  const home = await mkdtemp(path.join(os.tmpdir(), 'kimi-settings-stop-'));
  const adapter = new KimiAdapter({ home, kimiDir: path.join(home, 'kimi'), stateDir: path.join(home, 'state') });
  adapter.settingsServer = f.service;
  try {
    await adapter.stop();
    expect(adapter.settingsServer).toBeNull();
    await expect(f.raw('GET', '/')).rejects.toHaveProperty('code', 'ECONNREFUSED');
  } finally { await f.service.stop(); await rm(home, { recursive: true, force: true }); }
});

test('changing settingsPort rebuilds only the UI service', async () => {
  const reservations = [createServer(), createServer()];
  const [first, second] = await Promise.all(reservations.map(listen));
  await Promise.all(reservations.map(close));
  const key = Symbol.for('magpie.kimi-desktop.adapter.v1');
  const previous = globalThis[key];
  const adapter = { readSettings: initial, saveSettings: initial };
  globalThis[key] = adapter;
  try {
    await KimiDesktop({}, { settingsPort: first });
    const old = adapter.settingsServer;
    await KimiDesktop({}, { settingsPort: second });
    expect(adapter.settingsServer).not.toBe(old);
    expect(adapter.settingsServer.port).toBe(second);
    await expect(fetch(`http://127.0.0.1:${first}/`)).rejects.toThrow();
    const response = await fetch(`http://127.0.0.1:${second}/`);
    expect(response.status).toBe(200);
    await response.text();
  } finally {
    await adapter.settingsServer?.stop();
    if (previous === undefined) delete globalThis[key]; else globalThis[key] = previous;
  }
});

test('the launcher awaits options and uses the service proxy, with local fallback only', async () => {
  const source = await readFile(new URL('./page/boot.js', import.meta.url), 'utf8');
  const boot = async (magpie, hostname) => {
    let destination = '';
    const message = { textContent: '' };
    await runInNewContext(source, {
      URL, window: { magpie }, location: { hostname, replace: value => { destination = value; } },
      document: { getElementById: () => message },
    });
    return { destination, message: message.textContent };
  };
  let ready = false;
  const magpie = {
    ready: Promise.resolve().then(() => { ready = true; return { dark: true }; }),
    options: { get: async () => { expect(ready).toBe(true); return { settingsPort: 9999 }; } },
    service: 'https://magpie.example/prefix/_magpie/service/',
  };
  const proxied = new URL((await boot(magpie, 'magpie.example')).destination);
  expect(proxied.pathname).toBe('/prefix/_magpie/service/');
  expect(proxied.searchParams.get('uiOrigin')).toBe('https://magpie.example');
  expect(proxied.searchParams.get('theme')).toBe('dark');
  const local = await boot({ ready: Promise.resolve({ dark: false }), options: { get: async () => ({ settingsPort: 9999 }) } }, '127.0.0.1');
  expect(new URL(local.destination).port).toBe('9999');
  const remote = await boot({ ready: Promise.resolve({ lang: 'zh' }) }, 'magpie.example');
  expect(remote.destination).toBe('');
  expect(remote.message).toContain('未获得设置服务地址');
  expect(new URL((await boot(undefined, 'localhost')).destination).port).toBe('3491');
  expect((await boot({ service: 'javascript:alert(1)' }, 'magpie.example')).destination).toBe('');
});
