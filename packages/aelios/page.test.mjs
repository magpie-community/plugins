import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = (name) => readFileSync(new URL(`./page/${name}`, import.meta.url), 'utf8');
const context = vm.createContext({ URL });
vm.runInContext(source('form.js'), context);
const build = context.aeliosForm.build;
const values = (changes = {}) => ({ url: 'https://example.test/base', key: '', keyEnv: '', identity: '', agents: '', recall: true, record: false, allowRemote: false, routes: [], ...changes });

test('form preserves advanced options and supplies a usable default gateway timeout', () => {
  const next = build({ custom: { kept: true }, requestTimeoutMs: 4200 }, values());
  expect(JSON.parse(JSON.stringify(next))).toEqual({ custom: { kept: true }, requestTimeoutMs: 4200, serverUrl: 'https://example.test/base', gatewayTimeoutMs: 5000, recall: true, record: false, allowRemote: false });
  expect(build({ gatewayTimeoutMs: 7000 }, values()).gatewayTimeoutMs).toBe(7000);
  expect(build({}, values({ url: '' })).serverUrl).toBeUndefined();
});
test('form validates URL and authentication before writing', () => {
  for (const url of ['http://remote.test', 'https://user:pass@example.test', 'https://example.test/?key=x', 'https://example.test/#x', 'invalid']) expect(() => build({}, values({ url }))).toThrow('invalidUrl');
  for (const url of ['http://localhost:1234', 'http://127.0.0.1:3481', 'http://[::1]:1234']) expect(build({}, values({ url })).serverUrl).toBeTruthy();
  expect(build({}, values({ key: 'Bearer secret', keyEnv: 'OTHER_KEY' })).apiKey).toBe('secret');
  expect(() => build({}, values({ key: 'bad key' }))).toThrow('invalidKey');
  expect(() => build({}, values({ identity: 'x'.repeat(129) }))).toThrow('invalidIdentity');
});
test('route validation mirrors hook identities, priority and selector limits', () => {
  const route = { identity: 'my-identity', models: 'claude-*, gpt-*', agents: 'codex', original: { custom: 'kept' } };
  const next = build({}, values({ routes: [route, { ...route, identity: 'second' }] }));
  expect(JSON.parse(JSON.stringify(next.routes))).toEqual([{ custom: 'kept', identity: 'my-identity', models: ['claude-*', 'gpt-*'], agents: ['codex'] }, { custom: 'kept', identity: 'second', models: ['claude-*', 'gpt-*'], agents: ['codex'] }]);
  for (const identity of ['admin', 'V1', 'memory-mcp', '-bad', 'x'.repeat(65)]) expect(() => build({}, values({ routes: [{ ...route, identity }] }))).toThrow('invalidRoute');
  expect(() => build({}, values({ routes: [{ ...route, models: '', agents: '' }] }))).toThrow('missingSelector');
  expect(() => build({}, values({ routes: [{ ...route, models: 'a,,b' }] }))).toThrow('invalidSelectors');
  expect(() => build({}, values({ routes: [{ ...route, models: 'x'.repeat(201) }] }))).toThrow('invalidSelectors');
  expect(build({}, values({ routes: [{ ...route, models: 'x'.repeat(200) }] })).routes).toHaveLength(1);
  expect(build({}, values({ routes: Array.from({ length: 64 }, () => route) })).routes).toHaveLength(64);
  expect(() => build({}, values({ routes: Array.from({ length: 65 }, () => route) }))).toThrow('tooManyRoutes');
});
test('preserved invalid timing options are rejected', () => {
  for (const options of [{ gatewayTimeoutMs: 99 }, { requestTimeoutMs: 9001 }, { recallBackoffMs: -1 }, { gatewayTimeoutMs: '5000' }]) expect(() => build(options, values())).toThrow('invalidAdvanced');
});

class Element {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.dataset = {}; this.children = []; this.value = ''; this.checked = false; this.type = ''; this.hidden = false; this.attributes = {}; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener() {}
  focus() {}
}
async function setup(initial = {}, setMode = 'success') {
  const elements = new Map(); const document = { documentElement: new Element('html'), title: '', createElement: (tag) => new Element(tag), querySelectorAll: () => [], getElementById: (id) => {
    if (elements.has(id)) return elements.get(id);
    const visit = (node) => node.id === id ? node : node.children.map(visit).find(Boolean);
    return [...elements.values()].map(visit).find(Boolean);
  } };
  for (const [, id] of source('settings.html').matchAll(/\bid="([^"]+)"/g)) elements.set(id, new Element());
  elements.get('key').type = 'password';
  let options = structuredClone(initial), sets = 0, reads = 0, target;
  const magpie = { theme: { lang: 'zh-CN' }, service: '', ready: Promise.resolve(), onTheme(fn) { this.onThemeChange = fn; }, options: {
    async get() { reads++; return structuredClone(options); },
    async set(next) { sets++; if (setMode !== 'reject') options = structuredClone(next); if (setMode !== 'success') throw new Error('bridge failed'); return next; }
  } };
  const sandbox = vm.createContext({ URL, document, navigator: { language: 'en' }, magpie, location: { assign: (url) => { target = url; } } });
  sandbox.window = sandbox;
  for (const name of ['i18n.js', 'form.js', 'settings.js']) vm.runInContext(source(name), sandbox);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { elements, magpie, async save() { await elements.get('save').onclick(); }, async submit() { await elements.get('form').onsubmit({ preventDefault() {} }); }, async test() { await elements.get('test').onclick(); }, updateOptions(next) { options = next; }, get options() { return options; }, get sets() { return sets; }, get reads() { return reads; }, get target() { return target; } };
}
test('saving is a click, never a form submit, because Magpie frames forbid forms', async () => {
  const html = source('settings.html');
  expect(/<button id="save"[^>]*type="button"/.test(html)).toBe(true);
  expect(html).not.toContain('type="submit"');
  const page = await setup({ serverUrl: 'https://example.test' });
  page.elements.get('identity').value = 'via-submit';
  await page.submit();
  expect(page.sets).toBe(0);
  expect(page.options.identity).toBeUndefined();
  await page.save();
  expect(page.options.identity).toBe('via-submit');
});
test('bridge save merges latest configuration and re-reads authoritative options', async () => {
  const page = await setup({ serverUrl: 'https://example.test', custom: 1 });
  expect(page.elements.get('recall').checked).toBe(true);
  expect(page.elements.get('record').checked).toBe(false);
  expect(page.elements.get('allow-remote').checked).toBe(false);
  page.updateOptions({ serverUrl: 'https://example.test', custom: 2, requestTimeoutMs: 4500 });
  page.elements.get('identity').value = 'personal';
  await page.save();
  expect(page.options.custom).toBe(2);
  expect(page.options.requestTimeoutMs).toBe(4500);
  expect(page.options.identity).toBe('personal');
  expect(page.reads).toBe(3);
  expect(page.elements.get('result').dataset.message).toBe('saved');
});
test('failed bridge writes reconcile saved state without losing edits', async () => {
  const rejected = await setup({ serverUrl: 'https://example.test' }, 'reject');
  rejected.elements.get('identity').value = 'draft'; await rejected.save();
  expect(rejected.options.identity).toBeUndefined();
  expect(rejected.elements.get('identity').value).toBe('draft');
  expect(rejected.elements.get('result').dataset.message).toBe('saveFailed');
  await rejected.test(); expect(rejected.target).toBeUndefined();
  const written = await setup({ serverUrl: 'https://example.test' }, 'write-then-reject');
  written.elements.get('identity').value = 'confirmed'; await written.save();
  expect(written.elements.get('result').dataset.message).toBe('saved');
  expect(written.options.identity).toBe('confirmed');
});
test('testing blocks dirty edits and navigates only using saved options and theme language', async () => {
  const page = await setup({ serverUrl: 'https://example.test' });
  page.elements.get('identity').value = 'draft'; await page.test();
  expect(page.target).toBeUndefined(); expect(page.sets).toBe(0);
  expect(page.elements.get('identity').value).toBe('draft');
  expect(page.elements.get('result').dataset.message).toBe('saveFirst');
  await page.save(); await page.test();
  expect(page.target).toBe('http://127.0.0.1:3481/test?lang=zh');
  page.updateOptions({ ...page.options, port: 4567 }); await page.test();
  expect(page.target).toBe('http://127.0.0.1:4567/test?lang=zh');
  page.magpie.service = 'https://host.test/plugin-service/'; page.magpie.theme.lang = 'en'; page.magpie.onThemeChange();
  await page.test(); expect(page.target).toBe('https://host.test/plugin-service/test?lang=en');
});
