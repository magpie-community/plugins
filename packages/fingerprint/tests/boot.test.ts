import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../page/boot.js', import.meta.url), 'utf8');
const pageHtml = await readFile(new URL('../page/index.html', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

function startBoot(
  lang?: string,
  remote = false,
  port = 4388,
  desktopHost = '',
  clipboard?: { writeText: (value: string) => Promise<void> },
  overrides: {
    ready?: Promise<{ dark?: boolean; lang?: string } | undefined>;
    options?: Promise<{ port?: number }>;
    service?: string;
    staticMetaPresent?: boolean;
  } = {},
) {
  const elements = {
    status: { textContent: 'Connecting to Fingerprint…' },
    title: { textContent: 'Fingerprint' },
    fallback: { hidden: true },
    'service-url': { value: '', focus: () => {}, select: () => {} },
    'copy-service-url': { textContent: '', onclick: async () => {} },
    'static-help': { textContent: '' },
    'static-port-note': { textContent: '' },
  };
  const startupCalls: string[] = [];
  const staticRefresh = { remove: () => startupCalls.push('remove') };
  const document = {
    title: 'Fingerprint',
    documentElement: { lang: 'en' },
    getElementById: (id: keyof typeof elements | 'magpie-static-service-refresh') =>
      id === 'magpie-static-service-refresh'
        ? overrides.staticMetaPresent === false
          ? undefined
          : staticRefresh
        : elements[id],
  };
  let destination: URL | undefined;
  let fallback: (() => void) | undefined;
  // magpie hands no service to its desktop window, only to magpie web
  const service = overrides.service ?? (remote || desktopHost ? '' : `http://127.0.0.1:${port}/`);
  const run = runInNewContext(source, {
    URL,
    setTimeout: (callback: () => void) => {
      fallback = callback;
    },
    document,
    window: {
      stop: () => startupCalls.push('stop'),
      navigator: clipboard ? { clipboard } : undefined,
      magpie: {
        ready: overrides.ready ?? Promise.resolve({ dark: true, ...(lang ? { lang } : {}) }),
        service,
        context: { provider: { id: 'vendor' } },
        options: { get: async () => overrides.options ?? { port } },
        onAction() {},
        onTheme() {},
      },
    },
    location: {
      hostname: desktopHost || (remote ? 'magpie.example' : '127.0.0.1'),
      href: 'http://127.0.0.1/boot/index.html',
      replace: (url: string) => {
        destination = new URL(url);
      },
    },
  });
  return {
    document,
    elements,
    get destination() {
      return destination;
    },
    get fallback() {
      return fallback;
    },
    get startupCalls() {
      return startupCalls;
    },
    run,
  };
}

async function boot(
  lang?: string,
  remote = false,
  port = 4388,
  desktopHost = '',
  clipboard?: { writeText: (value: string) => Promise<void> },
) {
  const result = startBoot(lang, remote, port, desktopHost, clipboard);
  await result.run;
  return result;
}

test('boot defaults to English and follows host languages before navigation', async () => {
  for (const [lang, htmlLang, status] of [
    [undefined, 'en', 'Connecting'],
    ['fr', 'en', 'Connecting'],
    ['zh-CN', 'zh-Hans', '正在连接'],
    ['zh-TW', 'zh-Hant', '正在連線'],
    ['zh-Hant-HK', 'zh-Hant', '正在連線'],
    ['zh_HK', 'zh-Hant', '正在連線'],
    ['ja', 'ja', '接続中'],
    ['de-DE', 'de', 'Verbindung'],
  ]) {
    const result = await boot(lang);
    expect(result.document.documentElement.lang).toBe(htmlLang!);
    expect(result.elements.status.textContent).toContain(status!);
    expect(result.destination?.searchParams.get('provider')).toBe('vendor');
    expect(result.destination?.searchParams.get('uiOrigin')).toBe('http://127.0.0.1:4388');
    expect(result.destination?.searchParams.get('lang')).toBe(lang || null);
  }
});

test('static launch address matches the manifest default and explains custom ports', () => {
  const port = manifest.magpie.page.service.port;
  const expected = `http://127.0.0.1:${port}/?uiOrigin=http://127.0.0.1:${port}`;
  const compactHtml = pageHtml.replace(/\s+/g, ' ');
  expect(compactHtml).toContain(`content="6;url=${expected}"`);
  expect(compactHtml).toContain(`href="${expected}"`);
  expect(compactHtml).toContain(`default port, ${port}`);
  expect(compactHtml).toContain(`replace ${port} with it`);
});

test('boot stops then removes the static refresh before waiting for the bridge handshake', async () => {
  let resolveReady!: (value: { dark: boolean }) => void;
  const ready = new Promise<{ dark: boolean }>((resolve) => (resolveReady = resolve));
  const result = startBoot(undefined, false, 4388, 'wails.localhost', undefined, { ready });
  expect(result.startupCalls).toEqual(['stop', 'remove']);
  resolveReady({ dark: true });
  await result.run;
  expect(result.destination?.origin).toBe('http://127.0.0.1:4388');
});

test('boot stops then removes the static refresh before options and keeps custom ports', async () => {
  let resolveOptions!: (value: { port: number }) => void;
  const options = new Promise<{ port: number }>((resolve) => (resolveOptions = resolve));
  const result = startBoot(undefined, false, 4388, 'wails.localhost', undefined, { options });
  await Promise.resolve();
  expect(result.startupCalls).toEqual(['stop', 'remove']);
  resolveOptions({ port: 4391 });
  await result.run;
  expect(result.destination?.origin).toBe('http://127.0.0.1:4391');
});

test('boot keeps the configured remote service after a delayed options response', async () => {
  let resolveOptions!: (value: { port: number }) => void;
  const options = new Promise<{ port: number }>((resolve) => (resolveOptions = resolve));
  const service = 'https://fingerprint.example/';
  const result = startBoot(undefined, false, 4388, '', undefined, { options, service });
  await Promise.resolve();
  expect(result.startupCalls).toEqual(['stop', 'remove']);
  resolveOptions({ port: 4391 });
  await result.run;
  expect(result.destination?.origin).toBe('https://fingerprint.example');
});

test('boot does not stop ordinary pages without the static refresh', async () => {
  let resolveReady!: (value: { dark: boolean }) => void;
  const ready = new Promise<{ dark: boolean }>((resolve) => (resolveReady = resolve));
  const result = startBoot(undefined, false, 4388, 'wails.localhost', undefined, {
    ready,
    staticMetaPresent: false,
  });
  expect(result.startupCalls).toEqual([]);
  resolveReady({ dark: true });
  await result.run;
  expect(result.destination?.origin).toBe('http://127.0.0.1:4388');
});

test('a stalled desktop navigation offers the local service address', async () => {
  const result = await boot('zh-CN', false, 4388, 'wails.localhost');
  expect(result.elements.fallback.hidden).toBe(true);
  result.fallback?.();
  expect(result.elements.fallback.hidden).toBe(false);
  expect(result.elements['service-url'].value).toBe('http://127.0.0.1:4388/');
  expect(result.elements.status.textContent).toContain('本机浏览器');
  const copied: string[] = [];
  const withClipboard = await boot('en', false, 4388, 'wails.localhost', {
    writeText: async (value) => void copied.push(value),
  });
  withClipboard.fallback?.();
  await withClipboard.elements['copy-service-url'].onclick();
  expect(copied).toEqual(['http://127.0.0.1:4388/']);
  expect(withClipboard.elements.status.textContent).toBe('Address copied.');
  await result.elements['copy-service-url'].onclick();
  expect(result.elements.status.textContent).toContain('已选中地址');
  const remote = await boot('en');
  expect(remote.fallback).toBeUndefined();
});

test('boot localizes remote-service guidance and invalid-port errors', async () => {
  const remote = await boot('zh-TW', true);
  expect(remote.destination).toBeUndefined();
  expect(remote.elements.status.textContent).toContain('遠端外掛');
  const invalid = await boot('de', false, -1);
  expect(invalid.destination).toBeUndefined();
  expect(invalid.elements.status.textContent).toContain('Ungültiger Port');
});

test("boot goes to the local service from magpie's desktop window on every system", async () => {
  // Wails v3: wails://localhost on macOS and Linux, http://wails.localhost
  // on Windows (WebView2), where the page said "upgrade Magpie" instead
  for (const host of ['localhost', 'wails.localhost', '[::1]', '127.0.0.1']) {
    const result = await boot('zh-CN', false, 4390, host);
    expect(result.destination?.origin).toBe('http://127.0.0.1:4390');
    expect(result.destination?.searchParams.get('uiOrigin')).toBe('http://127.0.0.1:4390');
    expect(result.elements.status.textContent).not.toContain('升级');
  }
});
