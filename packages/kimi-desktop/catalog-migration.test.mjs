import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { canonicalMenuAlias, isMenuAlias, normalizeModels, neutralPromptAliases } from './catalog.mjs';
import { recoveryPeer } from './test-fixtures/control-peer.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

test('neutral model aliases retain the old namespace for migration and cleanup', () => {
  const rows = normalizeModels({ data: [{ id: 'provider/main' }] });
  const alias = rows[0].alias, legacy = alias.replace('local-model-', 'magpie-local-');
  expect(alias).toMatch(/^local-model-[a-f0-9]{24}$/);
  expect(rows[0].menu.displayName).not.toMatch(/magpie/i);
  expect(isMenuAlias(alias)).toBe(true);
  expect(isMenuAlias(legacy)).toBe(true);
  expect(canonicalMenuAlias(legacy)).toBe(alias);
  const prose = { messages: [{ role: 'user', content: 'magpie is a word in my own instructions' }] };
  expect(neutralPromptAliases(prose)).toEqual(prose);
});

test('catalog migration acknowledges a native selection before removing the old selected alias', async () => {
  const f = recoveryPeer();
  try {
    await f.controller.tick();
    const oldSelection = f.selectAlias();
    const before = f.calls.length;
    f.controller.catalogAfter = 0;
    await f.controller.tick();
    expect(read(f.controller.configFile).model.current).toBe('native');
    expect(isMenuAlias(oldSelection)).toBe(true);
    expect(f.menu.map(row => row.model)).toEqual(['native']);
    expect(Object.keys(read(f.controller.configFile).model.models)).toEqual(['native']);
    expect(f.calls.slice(before).filter(call => call.method.startsWith('conversations.')).map(call => [call.method, call.params])).toEqual([
      ['conversations.getKimiModelList', {}],
      ['conversations.setModel', { modelAlias: 'native' }],
      ['conversations.updateKimiModelList', { models: [{ model: 'native', maxContextSize: 131072, capabilities: [] }] }],
    ]);
    expect(f.controller.status.code).toBe('connected');
  } finally { await f.cleanup(); }
});

test('review guard: a native catalog containing only local aliases never selects or updates a menu', async () => {
  const f = recoveryPeer();
  try {
    await f.controller.tick();
    const alias = f.selectAlias({ legacy: false });
    const doc = read(f.controller.configFile);
    // Keep a native current selection so removing the empty-native guard would
    // reach updateKimiModelList instead of throwing while choosing native[0].
    doc.model.current = 'native';
    fs.writeFileSync(f.controller.configFile, JSON.stringify(doc));
    const control = f.controller.rpcCall;
    const writes = [];
    f.controller.rpcCall = async (runner, method, params, options) => {
      if (method === 'conversations.getKimiModelList') return { models: [{ model: alias }] };
      if (method === 'conversations.setModel' || method === 'conversations.updateKimiModelList') {
        writes.push({ method, params });
        return { ok: true };
      }
      return control(runner, method, params, options);
    };
    const before = fs.readFileSync(f.controller.configFile);
    f.controller.catalogAfter = 0;
    await f.controller.tick();
    expect(writes).toEqual([]);
    expect(f.controller.catalogError).toBe('catalog_sync_failed');
    expect(fs.readFileSync(f.controller.configFile)).toEqual(before);
    // Avoid exercising shutdown with the deliberately incomplete catalog.
    f.controller.rpcCall = control;
  } finally { await f.cleanup(); }
});

test('normal user data and non-Agent tools retain alias-shaped filenames and distinct keys', () => {
  const alias = normalizeModels({ data: [{ id: 'provider/main' }] })[0].alias;
  const old = alias.replace('local-model-', 'magpie-local-'), filename = `/tmp/${old}.json`;
  const payload = { tools: [
    { type: 'function', function: { name: 'read_file', parameters: { properties: { [old]: { type: 'string' }, [alias]: { type: 'integer' } } } } },
    { type: 'function', function: { name: 'Agent', description: `Read ${filename} if needed.\nAvailable models (pass via model):\n- ${old} [default]: Secondary model`,
      parameters: { properties: { model: { type: 'string', enum: [old] }, prompt: { description: filename } } } } },
  ], messages: [
    { role: 'user', content: `Read exactly ${filename}` },
    { role: 'assistant', tool_calls: [{ type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: filename }) } }] },
    { role: 'tool', content: JSON.stringify({ [old]: 'first', [alias]: 'second' }) },
    { role: 'assistant', tool_calls: [{ type: 'function', function: { name: 'Agent', arguments: JSON.stringify({ model: old, prompt: `Read ${filename}` }) } }] },
  ] };
  const normalized = neutralPromptAliases(payload);
  expect(normalized.messages.slice(0, 3)).toEqual(payload.messages.slice(0, 3));
  expect(normalized.tools[0]).toEqual(payload.tools[0]);
  expect(normalized.tools[1].function.parameters.properties.prompt).toEqual(payload.tools[1].function.parameters.properties.prompt);
  expect(normalized.tools[1].function.description).toContain(filename);
  expect(normalized.tools[1].function.description).toContain(`- ${alias} [default]:`);
  const args = JSON.parse(normalized.messages[3].tool_calls[0].function.arguments);
  expect(args).toEqual({ model: alias, prompt: `Read ${filename}` });
  expect(normalized.tools[1].function.parameters.properties.model.enum).toEqual([alias]);
});

for (const after of [false, true]) {
test(`an unacknowledged native selection retains old definitions until retry (${after ? 'after' : 'before'} effect)`, async () => {
  const f = recoveryPeer();
  try {
    await f.controller.tick();
    const old = f.selectAlias();
    const before = f.calls.length;
    f.fail('select', after); f.controller.catalogAfter = 0;
    await f.controller.tick();
    expect(read(f.controller.configFile).model.current).toBe(after ? 'native' : old);
    expect(f.menu.some(row => row.model === old)).toBe(true);
    expect(read(f.controller.configFile).model.models[old]).toBeDefined();
    expect(f.calls.slice(before).some(call => call.method === 'conversations.updateKimiModelList')).toBe(false);
    expect(f.controller.catalogError).toBe('catalog_sync_failed');
    f.clearFault(); f.controller.catalogAfter = 0;
    await f.controller.tick();
    expect(read(f.controller.configFile).model.current).toBe('native');
    expect(f.menu.map(row => row.model)).toEqual(['native']);
    expect(f.controller.catalogError).toBeNull();
  } finally { await f.cleanup(); }
});
}
