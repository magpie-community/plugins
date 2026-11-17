import { expect, test } from 'bun:test';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { KimiAdapter } from './adapter.mjs';
import KimiDesktop from './index.mjs';
import { startSettingsServer, TOKEN_HEADER } from './settings.mjs';

const key = Symbol.for('magpie.kimi-desktop.adapter.v1');
const state = () => ({ enabled: true, primaryModel: 'example/main', secondaryModel: '',
  status: 'connected', models: [{ id: 'example/main', name: 'Main' }] });
const close = server => new Promise(resolve => server.close(resolve));
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const page = async port => {
  const response = await fetch(`http://127.0.0.1:${port}/`, { headers: { connection: 'close' }, signal: AbortSignal.timeout(1000) });
  return { status: response.status, text: await response.text() };
};
async function fixture(entry = KimiDesktop) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kimi-settings-recovery-fixture-'));
  const logs = [];
  const adapter = new KimiAdapter({ home, kimiDir: path.join(home, 'kimi'), stateDir: path.join(home, 'state') });
  let bootstrapCalls = 0, initCalls = 0;
  // Real tick/stop, with Native IO cut off before its first filesystem action.
  adapter.bootstrap = () => { bootstrapCalls++; return false; };
  adapter.readSettings = state;
  adapter.saveSettings = state;
  const previous = globalThis[key];
  globalThis[key] = adapter;
  return { adapter, logs, get bootstrapCalls() { return bootstrapCalls; }, get initCalls() { return initCalls; },
    init: async port => {
      initCalls++;
      return entry({ client: { app: { log: ({ body }) => { logs.push(body.message); return Promise.resolve(); } } } },
        { settingsPort: port });
    },
    cleanup: async () => {
      await adapter.stop();
      if (previous === undefined) delete globalThis[key]; else globalThis[key] = previous;
      await rm(home, { recursive: true, force: true });
    },
  };
}

test('control: a released configured port accepts a fresh settings server', async () => {
  const holder = createServer();
  const port = await listen(holder);
  await close(holder);
  const service = await startSettingsServer({ port, readSettings: state, saveSettings: state });
  try {
    expect(service.port).toBe(port);
    expect((await page(port)).text).toContain('magpie-kimi-settings-token');
  } finally { await service.stop(); }
});

test('a normal adapter tick recovers the configured settings port after one failed initialization', async () => {
  const f = await fixture();
  const marker = 'synthetic-holder';
  const holder = createServer((req, res) => res.end(marker));
  const port = await listen(holder);
  try {
    await f.init(port);
    expect(f.adapter.settingsServer).toBeFalsy();
    expect((await page(port)).text).toBe(marker);
    await f.adapter.tick();
    expect(f.logs).toEqual(['settings_port_in_use']);
    await close(holder);
    await f.adapter.tick();
    expect(f.initCalls).toBe(1);
    expect(f.adapter.settingsServer?.port).toBe(port);
    expect((await page(port)).text).toContain('magpie-kimi-settings-token');
  } finally {
    if (holder.listening) await close(holder);
    await f.cleanup();
  }
}, 3000);

async function freePort() {
  const reservation = createServer();
  const port = await listen(reservation);
  await close(reservation);
  return port;
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('the same configured port reuses its service across initialization and normal ticks', async () => {
  const f = await fixture();
  const port = await freePort();
  try {
    await f.init(port);
    const service = f.adapter.settingsServer;
    const token = /name="magpie-kimi-settings-token" content="([a-f0-9]{64})"/.exec((await page(port)).text)[1];
    await f.init(port);
    await f.adapter.tick();
    expect(f.adapter.settingsServer).toBe(service);
    expect(f.logs).toEqual([]);
    const response = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      headers: { origin: 'null', [TOKEN_HEADER]: token }, signal: AbortSignal.timeout(1000),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).primaryModel).toBe('example/main');
  } finally { await f.cleanup(); }
});

test('overlapping initialization and tick share one pending port replacement', async () => {
  const f = await fixture();
  const first = await freePort(), second = await freePort();
  const entered = deferred(), release = deferred();
  const pending = [];
  try {
    await f.init(first);
    const old = f.adapter.settingsServer;
    const stop = old.stop;
    let stopCalls = 0;
    old.stop = async () => { stopCalls++; entered.resolve(); await release.promise; await stop(); };
    pending.push(f.init(second));
    await entered.promise;
    pending.push(f.init(second), f.adapter.tick());
    expect(stopCalls).toBe(1);
    release.resolve();
    await Promise.all(pending);
    expect(f.adapter.settingsServer?.port).toBe(second);
    expect(f.logs).toEqual([]);
    await expect(page(first)).rejects.toThrow();
    expect((await page(second)).status).toBe(200);
  } finally {
    release.resolve();
    await Promise.allSettled(pending);
    await f.cleanup();
  }
});

test('a newer configured port wins while the first bind awaits its real page file', async () => {
  const f = await fixture();
  const first = await freePort(), second = await freePort();
  const pending = [];
  try {
    pending.push(f.init(first));
    // The sync flight has reached startSettingsServer's asynchronous readFile.
    await Promise.resolve();
    pending.push(f.init(second));
    await Promise.all(pending);
    expect(f.adapter.settingsServer?.port).toBe(second);
    await expect(page(first)).rejects.toThrow();
    expect((await page(second)).text).toContain('magpie-kimi-settings-token');
    expect(f.logs).toEqual([]);
  } finally { await Promise.allSettled(pending); await f.cleanup(); }
});

test('stop awaits a pending initialization blocked on the old service stop', async () => {
  const f = await fixture();
  const first = await freePort(), second = await freePort();
  const entered = deferred(), release = deferred();
  const pending = [];
  try {
    await f.init(first);
    const old = f.adapter.settingsServer;
    const stop = old.stop;
    old.stop = async () => { entered.resolve(); await release.promise; await stop(); };
    pending.push(f.init(second));
    await entered.promise;
    let stopped = false;
    const stopping = f.adapter.stop().then(() => { stopped = true; });
    pending.push(stopping);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(stopped).toBe(false);
    release.resolve();
    await Promise.all(pending);
    expect(f.adapter.settingsServer).toBeNull();
    await expect(page(first)).rejects.toThrow();
    await expect(page(second)).rejects.toThrow();
  } finally { release.resolve(); await Promise.allSettled(pending); await f.cleanup(); }
});

test('initialization and normal ticks do not restart a stopping adapter', async () => {
  const f = await fixture();
  const port = await freePort();
  try {
    await f.adapter.stop();
    await f.init(port);
    await f.adapter.tick();
    expect(f.adapter.settingsServer).toBeFalsy();
    await expect(page(port)).rejects.toThrow();
    expect(f.logs).toEqual([]);
  } finally { await f.cleanup(); }
});

test('repeated bind failures log one safe warning until a successful recovery', async () => {
  const f = await fixture();
  const holders = [createServer(), createServer()];
  const [first, second] = await Promise.all(holders.map(listen));
  try {
    await f.init(first);
    await f.adapter.tick();
    await f.adapter.tick();
    expect(f.logs).toEqual(['settings_port_in_use']);
    await close(holders[0]);
    await f.adapter.tick();
    expect(f.adapter.settingsServer?.port).toBe(first);
    await f.init(second);
    await f.adapter.tick();
    expect(f.logs).toEqual(['settings_port_in_use', 'settings_port_in_use']);
  } finally {
    await Promise.all(holders.filter(holder => holder.listening).map(close));
    await f.cleanup();
  }
});


test('safe bind codes stay distinct and unknown page-file failures use a fixed code', async () => {
  const modules = await mkdtemp(path.join(os.tmpdir(), 'kimi-settings-errors-'));
  let f;
  try {
    // Copy modules only: this temporary package deliberately has no HTML page.
    for (const name of await readdir(new URL('.', import.meta.url))) {
      if (name.endsWith('.mjs') && !name.endsWith('.test.mjs')) {
        await copyFile(new URL(name, import.meta.url), path.join(modules, name));
      }
    }
    const { default: entry } = await import(pathToFileURL(path.join(modules, 'index.mjs')).href);
    f = await fixture(entry);
    const port = await freePort();
    await f.init(0);
    await f.adapter.tick();
    expect(f.logs).toEqual(['settings_invalid_port']);
    await f.init(port);
    await f.adapter.tick();
    expect(f.logs).toEqual(['settings_invalid_port', 'settings_server_unavailable']);
    expect(f.adapter.settingsServer).toBeFalsy();
  } finally {
    await f?.cleanup();
    await rm(modules, { recursive: true, force: true });
  }
});

test('a normal adapter tick works before its optional settings callback is attached', async () => {
  const f = await fixture();
  const reports = [];
  f.adapter.report = code => reports.push(code);
  try {
    await f.adapter.tick();
    expect(f.bootstrapCalls).toBe(1);
    expect(reports).toEqual([]);
    expect(f.initCalls).toBe(0);
  } finally { await f.cleanup(); }
});
