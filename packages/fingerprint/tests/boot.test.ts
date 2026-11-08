import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../page/boot.js', import.meta.url), 'utf8');
async function boot(
  lang?: string,
  remote = false,
  port = 4388,
  desktopHost = '',
  clipboard?: { writeText: (value: string) => Promise<void> },
) {
  const elements = {
    status: { textContent: 'Connecting to Fingerprint…' },
    title: { textContent: 'Fingerprint' },
    fallback: { hidden: true },
    'service-url': { value: '', focus: () => {}, select: () => {} },
    'copy-service-url': { textContent: '', onclick: async () => {} },
  };
  const document = {
    title: 'Fingerprint',
    documentElement: { lang: 'en' },
    getElementById: (id: keyof typeof elements) => elements[id],
  };
  let destination: URL | undefined;
  let fallback: (() => void) | undefined;
  // magpie hands no service to its desktop window, only to magpie web
  const service = remote || desktopHost ? '' : `http://127.0.0.1:${port}/`;
  await runInNewContext(source, {
    URL,
    setTimeout: (callback: () => void) => {
      fallback = callback;
    },
    document,
    window: {
      navigator: clipboard ? { clipboard } : undefined,
      magpie: {
        ready: Promise.resolve({ dark: true, ...(lang ? { lang } : {}) }),
        service,
        context: { provider: { id: 'vendor' } },
        options: { get: async () => ({ port }) },
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
  return { document, elements, destination, fallback };
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
