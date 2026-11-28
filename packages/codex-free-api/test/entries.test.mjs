import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('Magpie entry exports exactly one plugin and every runtime entry is packed', async () => {
  const mod = await import(new URL('../' + pkg.main, import.meta.url));
  assert.deepEqual(Object.keys(mod), ['CodexFreeApiPlugin']);
  assert.equal(typeof mod.CodexFreeApiPlugin, 'function');
  for (const file of ['index.mjs', 'opencode.mjs', 'opencode2.mjs']) assert.ok(pkg.files.includes(file));
});

test('OpenCode 2 entry registers native key configuration and the provider without network access', async () => {
  const entry = await import(new URL('../' + pkg.exports['.'], import.meta.url));
  assert.equal(entry.default.id, pkg.name);
  const methods = [];
  const providers = [];
  const hooks = [];
  const storage = new Map();
  const ctx = {
    location: { directory: '/nowhere' },
    integration: {
      transform: async fn => fn({ method: { update: method => methods.push(method) } }),
      connection: { active: async () => undefined, resolve: async () => undefined },
    },
    provider: { transform: async fn => fn({ add: provider => providers.push(provider) }), reload: async () => {} },
    model: { reload: async () => {} },
    aisdk: { hook: async (name, fn, filter) => hooks.push({ name, fn, filter }) },
    storage: { get: async key => storage.get(key), set: async (key, value) => { storage.set(key, value); } },
    event: { async *subscribe() {} },
  };
  const previous = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error('Unexpected network request'); };
  try { await entry.default.setup(ctx); }
  finally { globalThis.fetch = previous; }
  assert.equal(networkCalls, 0);
  assert.equal(methods.length, 1);
  assert.equal(methods[0].integrationID, 'codex-free-api-quota');
  assert.equal(methods[0].method.type, 'key');
  assert.ok(methods[0].method.form.every(field => field.required !== true));
  assert.equal(providers.length, 1);
  assert.equal(providers[0].info.id, 'codex-free-api-quota');
  assert.ok(providers[0].models.length > 0);
  assert.ok(hooks.some(hook => hook.name === 'sdk' && hook.filter.providerID === 'codex-free-api-quota'));
});
