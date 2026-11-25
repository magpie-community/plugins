import assert from 'node:assert/strict';
import { randomFillSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const boot = await read('bootstrap/boot.js');
const key = 'ab'.repeat(32);
const entry = 'https://magpie.example/_magpie/plugin/0123456789abcdef0123456789abcdef/index.html';
const service = 'https://magpie.example/_magpie/plugin/0123456789abcdef0123456789abcdef/_magpie/service/';

async function launch({ options = {}, pageService = '', href = entry } = {}) {
  const calls = [];
  const status = {};
  const retry = { hidden: true, addEventListener() {} };
  let saved;
  await vm.runInNewContext(boot, {
    URL, URLSearchParams, Uint8Array,
    window: { magpie: {
      ready: Promise.resolve(),
      service: pageService,
      options: {
        async get() { return options; },
        async set(value) {
          await Promise.resolve();
          saved = { ...value };
          calls.push('saved');
        },
      },
    } },
    crypto: { getRandomValues(bytes) {
      assert.equal(bytes.length, 32);
      return randomFillSync(bytes);
    } },
    location: {
      href, reload() { calls.push('reload'); },
      replace(destination) { calls.push(destination); },
    },
    document: { querySelector(selector) { return selector === '#status' ? status : retry; } },
    setTimeout() { return 1; }, clearTimeout() {},
  });
  return { calls, saved, retry, status };
}

test('bootstrap waits for a newly generated key to be saved before restarting the host page', async () => {
  const first = await launch({ options: { port: 3501 } });
  const second = await launch();
  assert.deepEqual(first.calls, ['saved', 'reload']);
  assert.deepEqual(second.calls, ['saved', 'reload']);
  assert.equal(first.saved.port, 3501);
  assert.match(first.saved.arenaAccess, /^[a-f\d]{64}$/);
  assert.notEqual(first.saved.arenaAccess, second.saved.arenaAccess);
});

test('an existing key reaches only the plugin service and travels in the fragment', async () => {
  const cases = [
    { href: entry, pageService: service, expected: service },
    { href: 'wails://localhost/_magpie/plugin/0123456789abcdef0123456789abcdef/index.html',
      pageService: '', port: 3501, expected: 'http://127.0.0.1:3501/' },
  ];
  for (const { href, pageService, port, expected } of cases) {
    const { calls, saved } = await launch({ href, pageService, options: { arenaAccess: key, port } });
    assert.equal(saved, undefined);
    assert.equal(calls.length, 1);
    const url = new URL(calls[0]);
    assert.equal(url.search, '');
    assert.equal(new URLSearchParams(url.hash.slice(1)).get('access'), key);
    url.hash = '';
    assert.equal(url.href, expected);
  }
});

test('a remote or unrelated bridge URL cannot receive the local service key', async () => {
  for (const pageService of [
    'https://unrelated.example/_magpie/plugin/0123456789abcdef0123456789abcdef/_magpie/service/',
    'https://magpie.example/_magpie/plugin/00000000000000000000000000000000/_magpie/service/',
    'https://magpie.example/api/unrelated',
  ]) {
    const result = await launch({ pageService, options: { arenaAccess: key } });
    assert.deepEqual(result.calls, []);
    assert.equal(result.retry.hidden, false);
  }
});

test('the plugin registers one local service page without requesting extra permissions or external assets', async () => {
  const { magpie } = JSON.parse(await read('package.json'));
  assert.deepEqual(magpie.permissions || [], []);
  assert.equal(magpie.page.file, 'bootstrap/index.html');
  assert.deepEqual(magpie.page.service, { port: 3497, option: 'port' });
  for (const file of [magpie.page.file, 'page/index.html']) {
    const html = await read(file);
    for (const match of html.matchAll(/\b(?:src|href|action)\s*=\s*["']([^"']+)["']/gi)) {
      assert.doesNotMatch(match[1], /^(?:[a-z]+:|\/)/i, file + ' loads only relative local resources');
    }
  }
});

test('the sandboxed page starts through a validated button click with authenticated local requests', async () => {
  const page = await read('page/index.html');
  const startTag = page.match(/<button\b[^>]*\bid="start"[^>]*>/i)?.[0];
  assert.match(startTag, /\btype="button"/);
  const source = await read('page/app.js');
  const calls = [];
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const listeners = new Map();
      elements.set(id, {
        value: '', firstElementChild: {}, listeners,
        addEventListener(name, listener) { listeners.set(name, listener); },
        click() { return listeners.get('click')?.(); },
        setCustomValidity() {}, setAttribute() {}, removeAttribute() {}, focus() {},
        add() {}, append() {}, replaceChildren() {}, classList: { toggle() {} },
      });
    }
    return elements.get(id);
  }
  const sandbox = vm.createContext({
    location: { hash: '#access=' + key }, URLSearchParams,
    document: { hidden: false, getElementById: element, createElement: () => element(Symbol()), addEventListener() {} },
    window: { setTimeout() {} }, Option: class {},
    async fetch(path, options) {
      calls.push({ path, options });
      return { ok: true, async json() {
        if (path === './api/models') return { models: ['a', 'b'] };
        return { run: { ...JSON.parse(options.body), id: 'r', status: 'running', base: 'abc', candidates: [] } };
      } };
    },
  });
  await vm.runInContext(source, sandbox);
  assert.deepEqual(calls.map(c => c.path), ['./api/models']);
  await new Promise(resolve => setImmediate(resolve));
  element('repo').value = '/tmp/project';
  element('prompt').value = 'Add search';
  let valid = false;
  element('run-form').reportValidity = () => valid;
  await element('start').click();
  assert.equal(calls.length, 1, 'an invalid form must not start an agent');
  valid = true;
  await element('start').click();
  assert.deepEqual(calls.map(c => c.path), ['./api/models', './api/runs']);
  for (const { options } of calls) {
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers['X-Arena-Key'], key);
  }
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    repo: '/tmp/project', prompt: 'Add search', models: ['a', 'b'],
  });
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[1].options.headers['X-Arena-Request'], '1');
  assert.equal(calls[1].options.headers['Content-Type'], 'application/json');
});
