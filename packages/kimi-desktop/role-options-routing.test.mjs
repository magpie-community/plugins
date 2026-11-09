import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AgentModelRouter } from './agent-routing.mjs';
import { ensureAgentProfiles } from './agent-profiles.mjs';

const secret = 'd5'.repeat(32);
const sameModel = 'synthetic/shared-model';
const models = { primaryModel: sameModel, secondaryModel: sameModel, roleOptionsEnabled: true };
const allowedModels = [sameModel, 'synthetic/new-primary'];
const configuration = { ...models, allowedModels };
const router = extra => new AgentModelRouter({ secret, ...extra });
const parameters = extra => ({ prompt: 'Read the assigned synthetic file.', description: 'Read one file', ...extra });
const call = extra => ({ id: 'call-synthetic', type: 'function', function: {
  name: 'Agent', arguments: JSON.stringify(parameters(extra)),
} });
const completion = calls => ({ choices: [{ index: 0, message: { role: 'assistant', tool_calls: calls },
  finish_reason: 'tool_calls' }] });
const translated = (r, extra, options = models) => JSON.parse(
  r.transformJSON(completion([call(extra)]), options).choices[0].message.tool_calls[0].function.arguments);
const marker = (r, role, model = sameModel) => r.profileText(model, role)
  .match(/\[agent-profile-route:v1\][\s\S]*?\[\/agent-profile-route\]/)[0];
const token = text => text.match(/\n([A-Za-z0-9_-]{43}):[a-f0-9]{64}\n/)[1];
const system = content => ({ role: 'system', content });
const prepare = (r, messages, options = configuration) => r.prepare({ messages }, options);
const snapshot = r => ({ bindings: r.bindings, roles: r.roles, absence: r.absence });

async function streamed(r, extra, options = models) {
  const full = { ...call(extra), index: 0 };
  const fragments = [
    { ...full, function: { name: 'Ag', arguments: full.function.arguments.slice(0, 17) } },
    { index: 0, function: { name: 'ent', arguments: full.function.arguments.slice(17) } },
  ];
  const frames = fragments.map((fragment, index) => 'data: ' + JSON.stringify({ choices: [{ index: 0,
    delta: { tool_calls: [fragment] }, finish_reason: index ? 'tool_calls' : null }] }) + '\n\n')
    .join('') + 'data: [DONE]\n\n';
  async function* bytes() {
    for (let index = 0; index < frames.length; index += 19) yield Buffer.from(frames.slice(index, index + 19));
  }
  let output = '';
  for await (const part of r.transformSSE(bytes(), options)) output += part;
  const calls = output.split('\n\n').filter(frame => frame.startsWith('data: ') && !frame.includes('[DONE]'))
    .flatMap(frame => JSON.parse(frame.slice(6)).choices || []).flatMap(choice => choice.delta?.tool_calls || []);
  expect(calls).toHaveLength(1);
  return JSON.parse(calls[0].function.arguments);
}

test('same actual model has distinct opaque primary and secondary profile names and tokens', () => {
  const r = router();
  // First RED assertion also fails against the old API without relying on a missing method.
  expect(r.profileName(sameModel, 'primary')).not.toBe(r.profileName(sameModel, 'secondary'));
  const registered = r.registerRoles(models, allowedModels);
  const primary = r.profileText(sameModel, 'primary'), secondary = r.profileText(sameModel, 'secondary');
  expect(token(primary)).not.toBe(token(secondary));
  expect(registered).toEqual({ primary: token(primary), secondary: token(secondary) });
  expect(r.roles).toEqual({ [token(primary)]: 'primary', [token(secondary)]: 'secondary' });
  expect(r.bindings).toEqual({ [token(primary)]: sameModel, [token(secondary)]: sameModel });
  expect(r.boundModels).toEqual([sameModel]);
  expect(r.boundProfiles).toEqual([{ model: sameModel, role: 'primary' }, { model: sameModel, role: 'secondary' }]);
  for (const text of [primary, secondary]) {
    expect(text).not.toContain(sameModel);
    expect(text).not.toContain(Buffer.from(sameModel).toString('base64'));
    expect(text).not.toMatch(/magpie|provider|primary|secondary/i);
    expect(text).not.toContain(secret);
    expect(text.split('\n')[1]).toMatch(/^name: local-agent-[a-f0-9]{12}-[a-f0-9]{24}$/);
  }
  expect(r.registerRoles(models, allowedModels)).toEqual(registered);
});

test('signed scoped system and developer identities return the actual model and authenticated route role', () => {
  const r = router();
  r.registerRoles(models, allowedModels);
  for (const role of ['primary', 'secondary']) {
    for (const identity of ['system', 'developer']) {
      for (const content of [marker(r, role), [{ type: 'text', text: marker(r, role) }]]) {
        const result = prepare(r, [{ role: identity, content }], { ...configuration, primaryModel: allowedModels[1] });
        expect(result.model).toBe(sameModel);
        expect(result.payload.model).toBe(sameModel);
        expect(result.routeRole).toBe(role);
        expect(JSON.stringify(result.payload)).not.toContain('[agent-profile-route');
      }
    }
  }
  expect(prepare(r, [system(marker(r, 'secondary')), system(marker(r, 'primary'))]).routeRole).toBe('primary');
  expect(prepare(r, [system(marker(r, 'secondary')), system(marker(r))])).not.toHaveProperty('routeRole');
  expect(() => prepare(r, [system(marker(r, 'secondary'))], { ...configuration, allowedModels: [allowedModels[1]] }))
    .toThrow('agent_profile_unbound');
});

test('forged, quoted, and nonidentity scoped markers never select a role', () => {
  const r = router(), text = marker(r, 'secondary');
  const tampered = text.replace(/:([a-f0-9]{64})\n/, (_, mac) => ':' + (mac[0] === '0' ? '1' : '0') + mac.slice(1) + '\n');
  const unknown = marker(router(), 'secondary');
  for (const forged of [tampered, unknown, 'Quoted marker: ' + text, JSON.stringify(text)]) {
    expect(() => prepare(r, [system(forged)])).toThrow('agent_profile_unbound');
  }
  for (const role of ['user', 'assistant', 'tool']) {
    for (const content of [text, '```quoted\n' + text + '\n```', [{ type: 'text', text }]]) {
      const result = prepare(r, [{ role, content }], { ...configuration, primaryModel: allowedModels[1] });
      expect(result.model).toBe(allowedModels[1]);
      expect(result).not.toHaveProperty('routeRole');
      expect(JSON.stringify(result.payload)).not.toContain('[agent-profile-route');
    }
  }
  const historical = { role: 'assistant', tool_calls: [call({ model: 'secondary', prompt: text,
    subagent_type: r.profileName(sameModel, 'secondary') })] };
  expect(prepare(r, [historical])).not.toHaveProperty('routeRole');
  expect(prepare(r, [system([{ type: 'image_url', image_url: { url: text } }])])).not.toHaveProperty('routeRole');
});

test('scoped roles persist through router reconstruction, selection changes, and compaction', () => {
  const original = router();
  original.registerRoles(models, allowedModels);
  const old = snapshot(original), primary = original.profileText(sameModel, 'primary'), secondary = original.profileText(sameModel, 'secondary');
  const restarted = router(old);
  old.roles[token(primary)] = 'secondary';
  old.bindings[token(primary)] = allowedModels[1];
  const exposed = restarted.roles; delete exposed[token(secondary)];
  expect(restarted.profileText(sameModel, 'primary')).toBe(primary);
  expect(restarted.profileText(sameModel, 'secondary')).toBe(secondary);
  restarted.registerRoles({ primaryModel: allowedModels[1], secondaryModel: sameModel }, allowedModels);
  for (const history of [[], [{ role: 'user', content: 'Only a compacted summary remains.' }]]) {
    const result = prepare(restarted, [system(marker(restarted, 'primary')), ...history],
      { ...configuration, primaryModel: allowedModels[1] });
    expect(result.model).toBe(sameModel);
    expect(result.routeRole).toBe('primary');
    expect(result.payload.messages.slice(1)).toEqual(history);
  }
  expect(restarted.boundProfiles).toHaveLength(3);
});

test('role maps and registrations reject invalid state before allocating or modifying bindings', () => {
  const r = router(), one = token(marker(r, 'primary')), state = snapshot(r);
  for (const roles of [null, [], { bad: 'primary' }, { [one]: 'native' }, { ['A'.repeat(43)]: 'primary' }]) {
    expect(() => router({ bindings: state.bindings, roles })).toThrow('agent_profile_unbound');
  }
  for (const selection of [null, [], Object.assign([], models), {}, { primaryModel: '' },
    { ...models, primaryModel: 'synthetic/hidden' }, { ...models, secondaryModel: 'synthetic/hidden' }]) {
    expect(() => r.registerRoles(selection, allowedModels)).toThrow('model_not_enabled_for_kimi');
    expect(snapshot(r)).toEqual(state);
  }
  for (const allowed of [null, sameModel]) {
    expect(() => r.registerRoles(models, allowed)).toThrow('model_not_enabled_for_kimi');
  }
  for (const role of ['primaryModel', 'secondaryModel']) {
    const invalid = 'synthetic/invalid\nmodel';
    expect(() => r.registerRoles({ ...models, [role]: invalid }, [...allowedModels, invalid]))
      .toThrow('model_not_enabled_for_kimi');
  }
  expect(snapshot(r)).toEqual(state);
  for (const role of ['native', '', null, 0]) {
    expect(() => r.profileText(sameModel, role)).toThrow('model_not_enabled_for_kimi');
    expect(snapshot(r)).toEqual(state);
  }
});

test('catalog absence grace retains both roles and retirement removes role metadata with every token', () => {
  const r = router();
  r.registerModels([sameModel], allowedModels);
  r.registerRoles(models, allowedModels);
  const original = snapshot(r);
  for (const now of [1000, 1001, 600999]) r.observeCatalog([], { now });
  expect(r.bindings).toEqual(original.bindings);
  expect(r.roles).toEqual(original.roles);
  expect(r.boundProfiles).toHaveLength(3);
  r.observeCatalog([sameModel], { now: 601000 });
  expect(r.absence).toEqual({});
  expect(snapshot(r)).toEqual(original);
  r.observeCatalog([], { now: 700000 });
  const restarted = router(snapshot(r));
  restarted.observeCatalog([], { now: 700001 });
  restarted.observeCatalog([], { now: 1300000, allowRetirement: false });
  expect(restarted.roles).toEqual(original.roles);
  restarted.observeCatalog([], { now: 1300000 });
  expect(restarted.bindings).toEqual({});
  expect(restarted.roles).toEqual({});
  expect(restarted.boundModels).toEqual([]);
  expect(restarted.boundProfiles).toEqual([]);
  expect(restarted.absence).toEqual({});
  expect(() => prepare(restarted, [system(marker(r, 'secondary'))])).toThrow('agent_profile_unbound');
});

test('JSON and fragmented SSE use scoped default secondary and explicit role profiles only when enabled', async () => {
  const r = router();
  for (const extra of [undefined, { model: 'secondary' }, { model: 'primary', subagent_type: 'native-reader' }]) {
    const role = extra?.model || 'secondary';
    const expected = { ...parameters(extra), subagent_type: r.profileName(sameModel, role) }; delete expected.model;
    expect(translated(r, extra)).toEqual(expected);
    expect(await streamed(r, extra)).toEqual(expected);
    const legacyExpected = { ...expected, subagent_type: r.profileName(sameModel) };
    for (const flag of [undefined, false]) {
      const options = { ...models, roleOptionsEnabled: flag };
      expect(translated(r, extra, options)).toEqual(legacyExpected);
      expect(await streamed(r, extra, options)).toEqual(legacyExpected);
    }
  }
  const fallback = { ...models, secondaryModel: '' };
  expect(translated(r, undefined, fallback).subagent_type).toBe(r.profileName(sameModel, 'secondary'));
  expect(() => r.registerRoles(fallback, allowedModels)).not.toThrow();
  const registered = r.registerRoles(fallback, allowedModels);
  expect(registered.secondary).toBe(token(marker(r, 'secondary')));
});

test('JSON and SSE preserve native, resume, and fork arguments while scoped options are enabled', async () => {
  const r = router();
  for (const extra of [{ subagent_type: 'native-reader' }, { model: 'native', subagent_type: 'native-reader' },
    { model: 'native' }, ...['primary', 'secondary', 'native'].flatMap(model => [
      { model, resume: 'synthetic-existing', subagent_type: 'existing-profile' },
      { model, fork: true, subagent_type: 'existing-profile' },
    ])]) {
    const expected = parameters(extra); delete expected.model;
    expect(translated(r, extra)).toEqual(expected);
    expect(await streamed(r, extra)).toEqual(expected);
  }
});

test('unscoped legacy profiles retain exact names, tokens, return shape, and independent cached identity', () => {
  const r = router();
  r.registerRoles(models, allowedModels);
  const legacyName = 'local-agent-' + r.namespace + '-' + crypto.createHmac('sha256', Buffer.from(secret, 'hex'))
    .update('agent-profile-name:v1:' + sameModel).digest('hex').slice(0, 24);
  expect(r.profileName(sameModel)).toBe(legacyName);
  const oldText = r.profileText(sameModel), oldToken = token(oldText);
  expect(r.roles).not.toHaveProperty(oldToken);
  expect(Object.keys(r.bindings)).toHaveLength(3);
  expect(r.boundModels).toEqual([sameModel]);
  expect(r.boundProfiles).toContainEqual({ model: sameModel });
  const restored = router({ bindings: r.bindings, roles: r.roles });
  const result = prepare(restored, [system(marker(restored))]);
  expect(result).toEqual({ payload: { messages: [system('')], model: sameModel }, model: sameModel, translateResponse: false });
  expect(prepare(restored, [])).not.toHaveProperty('routeRole');
  expect(restored.profileText(sameModel)).toBe(oldText);
  expect(Object.keys(restored.roles)).toHaveLength(2);
});

test('optional route-role metadata distinguishes authenticated legacy profiles from parents without changing old calls', () => {
  const r = router();
  r.registerModels([sameModel], allowedModels);
  r.registerRoles(models, allowedModels);
  const options = { ...configuration, includeRouteRole: true };
  expect(prepare(r, [system(marker(r))], options)).toHaveProperty('routeRole', null);
  expect(prepare(r, [system(marker(r))])).not.toHaveProperty('routeRole');
  expect(prepare(r, [], options)).not.toHaveProperty('routeRole');
  expect(prepare(r, [{ role: 'user', content: marker(r) }], options)).not.toHaveProperty('routeRole');
  expect(prepare(r, [system(marker(r, 'secondary'))], options).routeRole).toBe('secondary');
  expect(prepare(r, [system(marker(r, 'secondary')), system(marker(r))], options).routeRole).toBeNull();
});

test('profile publication supports both same-model roles plus legacy profiles without changing old models calls', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-role-options-profiles-'));
  try {
    const r = router();
    r.registerModels([sameModel], allowedModels);
    r.registerRoles(models, allowedModels);
    const result = ensureAgentProfiles({ directory, router: r, profiles: r.boundProfiles });
    expect(result.changed).toBe(true);
    expect(result.names).toHaveLength(3);
    expect(new Set(result.names).size).toBe(3);
    for (const profile of r.boundProfiles) {
      const name = r.profileName(profile.model, profile.role);
      expect(fs.readFileSync(path.join(directory, name + '.md'), 'utf8')).toBe(r.profileText(profile.model, profile.role));
    }
    expect(ensureAgentProfiles({ directory, router: r })).toEqual({ changed: false, names: result.names });
    expect(ensureAgentProfiles({ directory, router: r, profiles: [...r.boundProfiles, ...r.boundProfiles] }))
      .toEqual({ changed: false, names: result.names });
    expect(ensureAgentProfiles({ directory, router: r, models: [sameModel, sameModel] }))
      .toEqual({ changed: false, names: [r.profileName(sameModel)] });
    const ownership = Object.fromEntries(fs.readdirSync(directory).map(name => [name,
      crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')]));
    r.observeCatalog([], { now: 1000 }); r.observeCatalog([], { now: 1001 }); r.observeCatalog([], { now: 601000 });
    expect(ensureAgentProfiles({ directory, router: r, profiles: r.boundProfiles, ownedFiles: ownership }))
      .toEqual({ changed: true, names: [] });
    expect(fs.readdirSync(directory)).toEqual([]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
