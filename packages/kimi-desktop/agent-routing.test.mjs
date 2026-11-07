import { test, expect, spyOn } from 'bun:test';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { AgentModelRouter } from './agent-routing.mjs';

const secret = 'a3'.repeat(32);
const models = { primaryModel: 'synthetic/primary', secondaryModel: 'synthetic/secondary' };
const allowedModels = Object.values(models);
const fixture = JSON.parse(fs.readFileSync(new URL('./test-fixtures/v2-agent-schema.json', import.meta.url), 'utf8'));
const nativeTool = fixture.request.tools[0];
const router = (bindings = {}) => new AgentModelRouter({ secret, bindings });
const options = { ...models, allowedModels };
const args = (extra = {}) => ({ prompt: 'Read magpie-local-0123456789abcdef01234567.txt，返回文件。',
  description: 'Read one test file', ...extra });
const call = (parameters, name = 'Agent', id = 'call-1') => ({ id, type: 'function', function: {
  name, arguments: typeof parameters === 'string' ? parameters : JSON.stringify(parameters),
} });
const completion = (calls, extra = {}) => ({ id: 'completion-1', object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: calls }, finish_reason: 'tool_calls' }],
  ...extra,
});
const translated = (r, parameters, configuration = models) =>
  JSON.parse(r.transformJSON(completion([call(parameters)]), configuration).choices[0].message.tool_calls[0].function.arguments);
const prepare = (r, messages, configuration = options, extra = {}) =>
  r.prepare({ model: 'native/current', messages, ...extra }, configuration);
const user = content => ({ role: 'user', content });
const system = content => ({ role: 'system', content });
const profileBody = (r, model = models.secondaryModel) => r.profileText(model).split('\n---\n')[1]
  .replace('${base_prompt}', 'Native base system prompt.');
const section = (r, model = models.secondaryModel) =>
  profileBody(r, model).match(/\[agent-profile-route:v1\][\s\S]*?\[\/agent-profile-route\]/)[0];
const event = (value, { crlf = false, multiline = false, metadata = '' } = {}) =>
  (metadata + JSON.stringify(value, null, multiline ? 2 : undefined).split('\n').map(line => 'data: ' + line).join('\n')
    + '\n\n').replace(/\n/g, crlf ? '\r\n' : '\n');
const chunk = (choices, extra = {}) => ({ id: 'stream-1', object: 'chat.completion.chunk', model: 'wire/model',
  created: 123, choices, ...extra });
const choice = (index, delta, finish_reason = null) => ({ index, delta, finish_reason });
async function* bytes(text, size = 37) {
  const encoded = Buffer.from(text);
  for (let index = 0; index < encoded.length; index += size) yield encoded.subarray(index, index + size);
}
async function readStream(r, text, size = 37) {
  let result = '';
  for await (const part of r.transformSSE(bytes(text, size), models)) result += part;
  return result;
}
async function fulfilled(promise) {
  const outcome = await promise.then(value => ({ value }), error => ({ error }));
  expect(outcome).toHaveProperty('value');
  return outcome.value;
}
function events(text) {
  return text.split(/\r\n\r\n|\n\n/).flatMap(frame => {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    return !data || data.trim() === '[DONE]' ? [] : [JSON.parse(data)];
  });
}
function streamCalls(text) {
  return events(text).flatMap(value => value.choices || []).flatMap(value => value.delta?.tool_calls || []);
}
function assembledCalls(text) {
  const calls = new Map();
  for (const choice of events(text).flatMap(value => value.choices || [])) {
    for (const fragment of choice.delta?.tool_calls || []) {
      const key = choice.index + ':' + fragment.index;
      if (!calls.has(key)) calls.set(key, { index: fragment.index, function: {} });
      const call = calls.get(key);
      for (const [name, value] of Object.entries(fragment)) {
        if (name === 'id') call.id = (call.id || '') + value;
        else if (name !== 'function') call[name] = value;
      }
      for (const [name, value] of Object.entries(fragment.function || {})) {
        call.function[name] = (call.function[name] || '') + value;
      }
    }
  }
  return [...calls.values()];
}

test('the routing key is required and is never an enumerable property or output', () => {
  for (const invalid of ['', 'test', 'a'.repeat(63), 'z'.repeat(64), null]) {
    expect(() => new AgentModelRouter({ secret: invalid })).toThrow('agent_routing_invalid_secret');
  }
  const r = router();
  expect(JSON.stringify(r)).toBe('{}');
  expect(r.profileText(models.primaryModel)).not.toContain(secret);
  expect(r.profileName(models.primaryModel)).toMatch(/^local-agent-[a-f0-9]{12}-[a-f0-9]{24}$/);
});

test('opaque binding snapshots survive restart and registration prunes only models removed from the catalog', () => {
  const r = router();
  r.registerModels(allowedModels, allowedModels);
  const original = r.bindings, body = profileBody(r);
  expect(r.bindings).toEqual(original);
  expect(Object.values(original).sort()).toEqual([...allowedModels].sort());
  expect(Object.keys(original).every(token => /^[A-Za-z0-9_-]{43}$/.test(token))).toBe(true);
  expect(r.namespace).toBe(crypto.createHash('sha256').update(secret).digest('hex').slice(0, 12));
  expect(new AgentModelRouter({ secret: secret.toUpperCase() }).namespace).toBe(r.namespace);
  expect(r.profileName(models.primaryModel)).toStartWith('local-agent-' + r.namespace + '-');
  const suffix = crypto.createHmac('sha256', Buffer.from(secret, 'hex'))
    .update('agent-profile-name:v1:' + models.primaryModel).digest('hex').slice(0, 24);
  expect(r.profileName(models.primaryModel)).toBe('local-agent-' + r.namespace + '-' + suffix);
  expect(suffix).not.toBe(crypto.createHash('sha256').update(models.primaryModel).digest('hex').slice(0, 24));
  expect(new AgentModelRouter({ secret: secret.toUpperCase() }).profileName(models.primaryModel)).toBe(r.profileName(models.primaryModel));
  const sameKey = router();
  expect(() => prepare(sameKey, [system(body)])).toThrow('agent_profile_unbound');
  const restarted = router(original);
  expect(prepare(restarted, [system(body)]).model).toBe(models.secondaryModel);
  expect(restarted.profileText(models.secondaryModel)).toBe(r.profileText(models.secondaryModel));
  original[Object.keys(original)[0]] = 'synthetic/changed';
  expect(restarted.bindings).toEqual(r.bindings);
  const snapshot = restarted.bindings;
  delete snapshot[Object.keys(snapshot)[0]];
  expect(restarted.boundModels).toHaveLength(2);
  const retained = restarted.registerModels([models.primaryModel], allowedModels);
  expect(Object.values(retained)).toContain(models.secondaryModel);
  restarted.registerModels([models.primaryModel], [models.primaryModel]);
  expect(restarted.boundModels).toEqual([models.primaryModel]);
  expect(Object.values(restarted.bindings)).toEqual([models.primaryModel]);
  expect(() => prepare(restarted, [system(body)])).toThrow('agent_profile_unbound');
});

test('binding import and model registration reject invalid ownership without changing valid saved bindings', () => {
  const token = 'A'.repeat(43);
  for (const bindings of [null, [], { bad: models.primaryModel }, { [token]: '' }, { [token]: 'bad\nmodel' }]) {
    expect(() => new AgentModelRouter({ secret, bindings })).toThrow('agent_profile_unbound');
  }
  const r = new AgentModelRouter({ secret, bindings: { [token]: models.primaryModel, ['B'.repeat(43)]: models.primaryModel } });
  expect(r.boundModels).toEqual([models.primaryModel]);
  const before = r.bindings;
  for (const [requested, allowed] of [[null, allowedModels], [[], null], [[models.secondaryModel], [models.primaryModel]],
    [[''], allowedModels], [[models.primaryModel, 'unavailable/model'], allowedModels]]) {
    expect(() => r.registerModels(requested, allowed)).toThrow('model_not_enabled_for_kimi');
    expect(r.bindings).toEqual(before);
  }
});

test('a random token collision never overwrites another model binding', () => {
  const first = Buffer.alloc(32, 1), second = Buffer.alloc(32, 2);
  const token = first.toString('base64url');
  const r = new AgentModelRouter({ secret, bindings: { [token]: models.primaryModel } });
  const random = spyOn(crypto, 'randomBytes').mockReturnValueOnce(first).mockReturnValueOnce(second);
  try {
    r.profileText(models.secondaryModel);
    expect(r.bindings).toEqual({ [token]: models.primaryModel, [second.toString('base64url')]: models.secondaryModel });
    expect(random).toHaveBeenCalledTimes(2);
  } finally { random.mockRestore(); }
});

test('disabled roles preserve native tools and assistant audit bytes while retaining authenticated old worker bindings', () => {
  const r = router();
  const signed = r.transformJSON(completion([call(args({ model: 'primary' }))]), models).choices[0].message.tool_calls[0];
  const assistant = { role: 'assistant', tool_calls: [signed] }, tools = [nativeTool];
  const disabled = { ...options, enableRoles: false };
  const result = prepare(r, [assistant], disabled, { tools });
  expect(result.translateResponse).toBe(false);
  expect(result.payload.tools).toBe(tools);
  expect(JSON.stringify(result.payload.tools)).toBe(JSON.stringify(tools));
  expect(result.payload.messages[0]).toBe(assistant);
  expect(result.payload.messages[0].tool_calls[0]).toBe(signed);
  expect(JSON.parse(prepare(r, [assistant]).payload.messages[0].tool_calls[0].function.arguments).model).toBe('primary');
  const bound = prepare(r, [system(profileBody(r)), assistant], disabled, { tools });
  expect(bound.model).toBe(models.secondaryModel);
  expect(bound.payload.tools).toBe(tools);
  expect(bound.payload.messages[1]).toBe(assistant);
  expect(JSON.stringify(bound.payload)).not.toContain('[agent-profile-route');
  expect(() => prepare(r, [user(section(r))], disabled)).toThrow('agent_profile_unbound');
});

test('reserved route residue in incomplete tags or unsupported nested fields fails closed', () => {
  const r = router(), marker = section(r);
  for (const message of [system('[agent-profile-route:v2]\nopaque\n[/agent-profile-route]'),
    system('[/agent-profile-route]'), system(marker.replace('[/agent-profile-route]', '')),
    system([{ type: 'image_url', image_url: { url: marker } }]),
    system([{ type: 'text', text: marker, metadata: { text: marker } }])]) {
    expect(() => prepare(r, [message])).toThrow('agent_profile_unbound');
  }
});

test('only the observed native Agent shape receives optional role selection, without changing other prose or schema', () => {
  const r = router(), input = structuredClone(fixture.request), before = structuredClone(input);
  const result = r.prepare(input, options);
  expect(result.model).toBe(models.primaryModel);
  expect(result.payload.model).toBe(models.primaryModel);
  expect(result.translateResponse).toBe(true);
  const tool = result.payload.tools[0];
  expect(tool.function.parameters.properties.model.enum).toEqual(['primary', 'secondary', 'native']);
  expect(tool.function.parameters.required).toEqual(['prompt', 'description']);
  expect(tool.function.parameters.additionalProperties).toBe(false);
  expect(tool.function.parameters.properties.prompt).toEqual(nativeTool.function.parameters.properties.prompt);
  expect(tool.function.description.split('Available models (pass via model):')[0])
    .toBe(nativeTool.function.description.split('Available models (pass via model):')[0]);
  expect(tool.function.description).not.toContain('local-model-');
  expect(tool.function.description).not.toMatch(/magpie|provider/i);
  expect(tool.function.description).toContain('secondary [default]');
  expect(tool.function.description).toContain('Resumed and forked');
  expect(tool.function.description).toContain('ordinary Work worker profile');
  expect(tool.function.description).toContain('replaces subagent_type');
  expect(tool.function.description).toContain('native: Preserve');
  expect(r.prepare(result.payload, options).payload.tools).toEqual(result.payload.tools);
  expect(input).toEqual(before);
  expect(result.payload.messages).toEqual(input.messages);
  const same = r.prepare({ tools: [nativeTool], messages: [] }, { ...options, secondaryModel: models.primaryModel });
  expect(same.payload.tools[0].function.parameters.properties.model.enum).toEqual(['primary', 'secondary', 'native']);
});

test('no tool is created or inferred from its name alone', () => {
  const variants = [
    tool => { tool.function.parameters.properties.prompt.type = 'object'; },
    tool => { delete tool.function.parameters.properties.description; },
    tool => { tool.function.parameters.required = ['prompt']; },
    tool => { tool.function.parameters.type = 'array'; },
    tool => { tool.function.name = 'AgentOther'; },
    tool => { tool.type = 'custom'; },
  ];
  for (const mutate of variants) {
    const tool = structuredClone(nativeTool); mutate(tool);
    const result = router().prepare({ messages: [], tools: [tool] }, options);
    expect(result.translateResponse).toBe(false);
    expect(result.payload.tools[0]).toBe(tool);
  }
  const result = router().prepare({ messages: [] }, options);
  expect(result.translateResponse).toBe(false);
  expect(result.payload).not.toHaveProperty('tools');
});

test('explicit roles select ordinary profiles while omitted model preserves a supplied native type without modifying prompt', () => {
  const schema = structuredClone(nativeTool.function.parameters);
  delete schema.properties.model; // The observed queue-dispatch schema has no model field.
  const r = router();
  for (const [role, expected] of [[undefined, null], ['secondary', models.secondaryModel], ['primary', models.primaryModel]]) {
    const input = args({ subagent_type: 'coder', run_in_background: false, ...(role ? { model: role } : {}) });
    const output = translated(r, input);
    expect(output).not.toHaveProperty('model');
    for (const required of schema.required) expect(Object.hasOwn(output, required)).toBe(true);
    for (const [key, value] of Object.entries(output)) {
      expect(Object.hasOwn(schema.properties, key)).toBe(true);
      expect(typeof value).toBe(schema.properties[key].type);
    }
    const forwarded = prepare(r, [...(expected ? [system(profileBody(r, expected))] : []), user(output.prompt)]);
    expect(forwarded.model).toBe(expected || models.primaryModel);
    expect(forwarded.payload.messages.at(-1).content).toBe(input.prompt);
    expect(JSON.stringify(forwarded.payload.messages)).not.toContain('[agent-profile-route:v1]');
    expect(output.prompt).toBe(input.prompt);
    expect(output.description).toBe(input.description);
    expect(output.subagent_type).toBe(expected ? r.profileName(expected) : 'coder');
    expect(output.run_in_background).toBe(false);
  }
});

test('a restarted router keeps the profile binding through preference changes, full compaction, and an empty history', () => {
  const original = router(), body = profileBody(original);
  const restarted = router(original.bindings);
  const configuration = { primaryModel: 'synthetic/new-primary', secondaryModel: 'synthetic/new-secondary',
    allowedModels: [...allowedModels, 'synthetic/new-primary', 'synthetic/new-secondary'] };
  for (const history of [
    [user('Original system_trigger task.'), { role: 'assistant', content: 'Ready.' }, user('Continue.')],
    [user('Synthetic compacted summary; original task message was removed.')], [],
  ]) {
    const result = prepare(restarted, [system(body), ...history], configuration);
    expect(result.model).toBe(models.secondaryModel);
    expect(result.payload.messages[0].content).toBe(body.replace(section(restarted), ''));
    expect(result.payload.messages.slice(1)).toEqual(history);
  }
  const next = profileBody(restarted, configuration.primaryModel);
  expect(prepare(restarted, [system(body), { role: 'developer', content: next }], configuration).model)
    .toBe(configuration.primaryModel);
});

test('system/developer text sections route and are removed while unmarked images, sources and metadata remain intact', () => {
  const r = router(), first = section(r, models.primaryModel), second = section(r);
  const image = { type: 'image_url', image_url: { url: 'synthetic-image' }, text: 'Image metadata.' };
  const source = { type: 'source', text: 'Source text.', source: { text: 'Nested metadata.' } };
  for (const role of ['system', 'developer']) {
    const input = [{ role, content: [{ type: 'text', text: first, metadata: { text: 'Unchanged metadata.' } }, image,
      { type: 'text', text: 'Unmarked middle.' }, source, { type: 'text', text: second }] }];
    const result = prepare(r, input);
    expect(result.model).toBe(models.secondaryModel);
    expect(result.payload.messages[0].content[0]).toEqual({ type: 'text', text: '', metadata: { text: 'Unchanged metadata.' } });
    expect(result.payload.messages[0].content[1]).toBe(image);
    expect(result.payload.messages[0].content[3]).toBe(source);
    expect(result.payload.messages[0].content[4].text).toBe('');
    expect(input[0].content[0].text).toBe(first);
  }
});

test('tampering, a different key, inline or incomplete sections fail closed while old model aliases cannot choose a model', () => {
  const r = router(), marker = section(r);
  const tampered = marker.replace(/:([a-f0-9]{64})\n/, (_, mac) => ':' + (mac[0] === '0' ? '1' : '0') + mac.slice(1) + '\n');
  const otherKey = section(new AgentModelRouter({ secret: 'b4'.repeat(32) }));
  const modifiedModel = marker.replace(/\n([A-Za-z0-9_-]{43}):/, (_, token) => '\n' + (token[0] === 'A' ? 'B' : 'A') + token.slice(1) + ':');
  for (const text of [tampered, otherKey, modifiedModel, 'Inline marker: ' + marker,
    marker + ' trailing text', marker.replace('[/agent-profile-route]', '')]) {
    expect(() => prepare(r, [system(text)])).toThrow('agent_profile_unbound');
  }
  const alias = 'Use local-model-963636a7ab87f074d7b3206d or magpie-local-0123456789abcdef01234567.txt';
  expect(prepare(r, [system(alias)]).model).toBe(models.primaryModel);
  expect(prepare(r, [system(alias)]).payload.messages[0].content).toBe(alias);
  expect(() => prepare(r, [system(marker), system(tampered)])).toThrow('agent_profile_unbound');
  expect(prepare(r, [system(marker.replace(/\n/g, '\r\n'))]).model).toBe(models.secondaryModel);
});

test('only the latest authenticated system binding is checked against the current allowed models', () => {
  const r = router(), secondary = section(r), primary = section(r, models.primaryModel);
  const limited = { ...options, allowedModels: [models.primaryModel] };
  expect(() => prepare(r, [system(secondary)], limited)).toThrow('agent_profile_unbound');
  expect(prepare(r, [system(secondary), system(primary)], limited).model).toBe(models.primaryModel);
  expect(() => prepare(r, [], { ...options, allowedModels: [] })).toThrow('model_not_enabled_for_kimi');
  expect(() => prepare(r, [], { ...options, allowedModels: ['local-model-963636a7ab87f074d7b3206d'] }))
    .toThrow('model_not_enabled_for_kimi');
});

test('copied profile metadata in user, assistant, tool or historical arguments fails closed without selecting a route', () => {
  const r = router(), prompt = section(r);
  const historical = args({ prompt, metadata: { prompt }, subagent_type: r.profileName(models.secondaryModel) });
  const other = call(historical, 'Other');
  const invalid = call('{not-json');
  const input = [
    { role: 'assistant', content: prompt, tool_calls: [call(historical), other, invalid] },
    { role: 'tool', tool_call_id: 'result', content: prompt },
    user(prompt), user([{ type: 'text', text: prompt }]),
    user('Read magpie-local-0123456789abcdef01234567.txt'),
  ];
  for (const message of input.slice(0, -1)) expect(() => prepare(r, [message])).toThrow('agent_profile_unbound');
  expect(prepare(r, input.slice(-1)).payload.messages[0]).toBe(input.at(-1));
});

test('native mode preserves specialized profiles and arbitrary argument values while ordinary roles replace only the type', () => {
  const r = router();
  const original = args({ model: 'native', subagent_type: 'specialized-reader',
    metadata: { model: 'primary', prompt: section(r), file: 'magpie-local-0123456789abcdef01234567.txt' } });
  const expected = { ...original }; delete expected.model;
  expect(translated(r, original)).toEqual(expected);
  const noType = translated(r, args({ model: 'native' }));
  expect(noType).not.toHaveProperty('subagent_type');
  const ordinary = translated(r, { ...original, model: 'primary' });
  expect(ordinary).toEqual({ ...expected, subagent_type: r.profileName(models.primaryModel) });
  const inherited = translated(r, args(), { ...models, secondaryModel: '' });
  expect(inherited.subagent_type).toBe(r.profileName(models.primaryModel));
  expect(inherited.prompt).toBe(args().prompt);
});

test('resume and fork remove only the role field and keep the native binding and all remaining arguments', () => {
  const r = router(), bound = profileBody(r);
  for (const inherited of [{ resume: 'agent-existing' }, { fork: true }, { resume: 'agent-existing', fork: true }]) {
    for (const role of [undefined, 'primary', 'secondary', 'native']) {
      const input = args({ ...inherited, ...(role ? { model: role } : {}), nested: { model: 'primary' },
        subagent_type: r.profileName(models.secondaryModel) });
      const expected = { ...input }; delete expected.model;
      expect(translated(r, input)).toEqual(expected);
      expect(prepare(r, [system(bound), user(expected.prompt)]).model).toBe(models.secondaryModel);
    }
  }
  expect(translated(r, args({ resume: '', fork: false, model: 'primary' })).subagent_type).toBe(r.profileName(models.primaryModel));
});

test('authenticated opaque IDs preserve omitted versus explicit role intent through native history and restart', () => {
  const r = router(), restarted = router();
  for (const [role, code] of [[undefined, 'd'], ['primary', 'p'], ['secondary', 's'], ['native', 'n']]) {
    const input = args({ subagent_type: 'specialized-reader', ...(role ? { model: role } : {}) });
    const original = completion([call(input, 'Agent', 'call_0')]), before = structuredClone(original);
    const native = r.transformJSON(original, models).choices[0].message.tool_calls[0];
    const nativeArgs = JSON.parse(native.function.arguments);
    expect(native.id).toMatch(new RegExp('^call_rs1_[a-f0-9]{16}_' + code + '_[a-f0-9]{24}$'));
    expect(native.id).toMatch(/^[A-Za-z0-9_]+$/);
    expect(native.id.length).toBeLessThanOrEqual(64);
    expect(native.id).not.toContain(secret);
    expect(native.id).not.toMatch(/magpie|provider|synthetic/);
    expect(nativeArgs).not.toHaveProperty('model');
    expect(nativeArgs.prompt).toBe(input.prompt);
    expect(nativeArgs.description).toBe(input.description);
    expect(original).toEqual(before);
    const resultMessage = { role: 'tool', tool_call_id: native.id, content: 'Native result for ' + native.id };
    const history = [{ role: 'assistant', content: null, tool_calls: [native] }, resultMessage];
    const prepared = prepare(restarted, history);
    const restored = prepared.payload.messages[0].tool_calls[0];
    expect(JSON.parse(restored.function.arguments)).toEqual({ ...nativeArgs, ...(role ? { model: role } : {}) });
    expect(restored.id).toBe(native.id);
    expect(prepared.payload.messages[1]).toBe(resultMessage);
    expect(prepared.payload.messages[1].tool_call_id).toBe(restored.id);
    expect(prepared.model).toBe(models.primaryModel); // Call IDs are audit metadata, never routing authority.
    expect(prepare(restarted, prepared.payload.messages).payload.messages).toEqual(prepared.payload.messages);
  }
  const repeated = r.transformJSON(completion([call(args(), 'Agent', 'call_0'), call(args(), 'Agent', 'call_0')]), models);
  const first = repeated.choices[0].message.tool_calls[0], second = repeated.choices[0].message.tool_calls[1];
  const later = r.transformJSON(completion([call(args(), 'Agent', 'call_0')]), models).choices[0].message.tool_calls[0];
  expect(new Set([first.id, second.id, later.id]).size).toBe(3);
});

test('default signed Agent history preserves native argument bytes and tool-result linkage after formatting', () => {
  const r = router();
  const native = r.transformJSON(completion([call(args())]), models).choices[0].message.tool_calls[0];
  const formatted = ' \n' + JSON.stringify(JSON.parse(native.function.arguments), null, 2) + '\n ';
  const storedCall = { ...native, function: { ...native.function, arguments: formatted } };
  const storedResult = { role: 'tool', tool_call_id: native.id, content: 'NATIVE_FORMATTED_DEFAULT_OK' };
  const history = prepare(r, [{ role: 'assistant', content: null, tool_calls: [storedCall] }, storedResult]);
  const restored = history.payload.messages[0].tool_calls[0];
  expect(restored.function.arguments).toBe(formatted);
  expect(JSON.parse(restored.function.arguments)).not.toHaveProperty('model');
  expect(restored.id).toBe(native.id);
  expect(history.payload.messages[1].tool_call_id).toBe(restored.id);
  expect(history.payload.messages[1].content).toBe('NATIVE_FORMATTED_DEFAULT_OK');
  expect(history.model).toBe(models.primaryModel);
});

test('resume and fork retain explicit intent for audits without changing the inherited profile or prompt', () => {
  const r = router();
  for (const inherited of [{ resume: 'existing-agent' }, { fork: true, subagent_type: r.profileName(models.secondaryModel) }]) {
    for (const role of [undefined, 'primary', 'secondary', 'native']) {
      const original = args({ ...inherited, ...(role ? { model: role } : {}) });
      const native = r.transformJSON(completion([call(original)]), models).choices[0].message.tool_calls[0];
      const expected = { ...original }; delete expected.model;
      expect(JSON.parse(native.function.arguments)).toEqual(expected);
      const prepared = prepare(r, [system(profileBody(r)), { role: 'assistant', tool_calls: [native] }]);
      expect(prepared.model).toBe(models.secondaryModel);
      expect(JSON.parse(prepared.payload.messages[1].tool_calls[0].function.arguments)).toEqual(original);
      expect(prepared.payload.messages[1].tool_calls[0].id).toBe(native.id);
    }
  }
});

test('tampered IDs, changed subtypes, unsigned history and unrelated tool calls never recover a role', () => {
  const r = router();
  const signed = r.transformJSON(completion([call(args({ model: 'primary' }))]), models).choices[0].message.tool_calls[0];
  const variants = [
    entry => { entry.id = entry.id.replace(/.$/, digit => digit === '0' ? '1' : '0'); },
    entry => { entry.id = entry.id.replace('_p_', '_s_'); },
    entry => { entry.id = entry.id.replace(/^(call_rs1_)(.)/, (_, prefix, digit) => prefix + (digit === '0' ? '1' : '0')); },
    entry => { entry.id = 'call_0'; },
    entry => { entry.function.arguments = JSON.stringify({ ...JSON.parse(entry.function.arguments), subagent_type: r.profileName(models.secondaryModel) }); },
    entry => { const value = JSON.parse(entry.function.arguments); delete value.subagent_type; entry.function.arguments = JSON.stringify(value); },
    entry => { entry.function.name = 'ReadFile'; },
    entry => { entry.type = 'custom'; },
    entry => { entry.function.arguments = '{invalid-json'; },
  ];
  for (const mutate of variants) {
    const modified = structuredClone(signed); mutate(modified);
    const message = { role: 'assistant', tool_calls: [modified] };
    expect(prepare(r, [message]).payload.messages[0]).toBe(message);
  }
  const message = { role: 'assistant', tool_calls: [signed] };
  expect(prepare(new AgentModelRouter({ secret: 'b4'.repeat(32) }), [message]).payload.messages[0]).toBe(message);
  const alreadySpecified = { ...signed, function: { ...signed.function,
    arguments: JSON.stringify({ ...JSON.parse(signed.function.arguments), model: 'secondary' }),
  } };
  const existing = { role: 'assistant', tool_calls: [alreadySpecified] };
  expect(prepare(r, [existing]).payload.messages[0]).toBe(existing);
  const embedded = JSON.stringify(signed);
  const unrelated = [
    { role: 'assistant', content: embedded },
    { role: 'user', content: embedded, tool_calls: [signed] },
    { role: 'tool', content: embedded, tool_call_id: signed.id, tool_calls: [signed] },
    user([{ type: 'text', text: embedded }]),
  ];
  const preserved = prepare(r, unrelated);
  expect(preserved.model).toBe(models.primaryModel);
  for (let index = 0; index < unrelated.length; index++) expect(preserved.payload.messages[index]).toBe(unrelated[index]);
});

test('the parent audit sees a default first worker and an explicit primary second worker after native execution', () => {
  const r = router();
  const output = r.transformJSON(completion([
    call(args({ description: 'Default secondary file read' }), 'Agent', 'call_0'),
    call(args({ description: 'Explicit primary file read', model: 'primary' }), 'Agent', 'call_1'),
  ]), models).choices[0].message;
  const [first, second] = output.tool_calls;
  expect(JSON.parse(first.function.arguments).subagent_type).toBe(r.profileName(models.secondaryModel));
  expect(JSON.parse(second.function.arguments).subagent_type).toBe(r.profileName(models.primaryModel));
  const results = output.tool_calls.map(entry => ({ role: 'tool', tool_call_id: entry.id, content: 'TEST_FILE_OK' }));
  const history = prepare(r, [output, ...results, user('Audit the original role selections.')]).payload.messages;
  const audited = history[0].tool_calls.map(entry => JSON.parse(entry.function.arguments));
  expect(audited[0]).not.toHaveProperty('model');
  expect(audited[1].model).toBe('primary');
  expect(audited[0].prompt).toBe(args().prompt);
  expect(audited[1].prompt).toBe(args().prompt);
  expect(history[1].tool_call_id).toBe(history[0].tool_calls[0].id);
  expect(history[2].tool_call_id).toBe(history[0].tool_calls[1].id);
  expect(history[1]).toBe(results[0]);
  expect(history[2]).toBe(results[1]);
});

test('invalid Agent JSON, required fields, and role values remain original for native validation; unrelated calls stay byte-exact', () => {
  const r = router();
  for (const invalid of ['{', 'null', '[]', '{}', JSON.stringify({ prompt: 'missing description' }),
    JSON.stringify({ description: 'missing prompt' }), JSON.stringify(args({ prompt: 5 })),
    ...['', 'Primary', 'unknown/model', null, 0, {}, ['secondary']].map(model => JSON.stringify(args({ model })))]) {
    const original = call(invalid);
    expect(r.transformJSON(completion([original]), models).choices[0].message.tool_calls[0]).toBe(original);
  }
  const foreign = call(' { "model" : "primary", "prompt": "magpie-local-0123456789abcdef01234567.txt" } ', 'Other');
  expect(r.transformJSON(completion([foreign]), models).choices[0].message.tool_calls[0]).toBe(foreign);
  const custom = { ...call(args({ model: 'unknown/model' })), type: 'custom' };
  expect(r.transformJSON(completion([custom]), models).choices[0].message.tool_calls[0]).toBe(custom);
});

test('JSON translation preserves text, reasoning, usage, multiple choices, and unrelated argument values', () => {
  const r = router(), foreign = call(' { "arguments" : "unchanged\\n", "model": "primary" } ', 'ReadFile', 'read-1');
  const input = completion([call(args()), foreign], { usage: { prompt_tokens: 11, completion_tokens: 23 }, model: 'wire/model' });
  input.choices[0].message.content = 'Keep this message.';
  input.choices[0].message.reasoning_content = 'Keep this reasoning.';
  input.choices[0].logprobs = { content: [] };
  input.choices.push({ index: 1, message: { role: 'assistant', content: 'Other choice.' }, finish_reason: 'stop' });
  const before = structuredClone(input), result = r.transformJSON(input, models);
  expect(input).toEqual(before);
  expect(result.usage).toBe(input.usage);
  expect(result.choices[0].message.content).toBe('Keep this message.');
  expect(result.choices[0].message.reasoning_content).toBe('Keep this reasoning.');
  expect(result.choices[0].logprobs).toBe(input.choices[0].logprobs);
  expect(result.choices[0].message.tool_calls[1]).toBe(foreign);
  expect(result.choices[1]).toBe(input.choices[1]);
  for (const finish_reason of ['length', 'content_filter', 'error', 'cancelled']) {
    const incomplete = structuredClone(input); incomplete.choices[0].finish_reason = finish_reason;
    expect(() => r.transformJSON(incomplete, models)).not.toThrow();
    expect(r.transformJSON(incomplete, models).choices[0]).toBe(incomplete.choices[0]);
  }
});

test('SSE aggregates interleaved calls and choices across UTF-8 bytes, CRLF, multiline data, names, IDs, and arguments', async () => {
  const r = router();
  const agentArgs = JSON.stringify(args({ model: 'primary' }));
  const secondArgs = JSON.stringify(args({ prompt: '第二个任务。' }));
  const foreignArgs = ' { "file" : "magpie-local-0123456789abcdef01234567.txt", "model" : "primary" } ';
  const stream = ': keepalive\r\n\r\n'
    + event(chunk([choice(0, { role: 'assistant', content: '开头', reasoning_content: '思考' })]), { crlf: true })
    + event(chunk([
      choice(0, { tool_calls: [{ index: 1, id: 'read-', type: 'function', function: { name: 'Read', arguments: foreignArgs.slice(0, 17) } },
        { index: 0, id: 'ag', type: 'function', function: { name: 'Ag', arguments: agentArgs.slice(0, 21) } }] }),
      choice(1, { role: 'assistant', tool_calls: [{ index: 0, id: 'second', type: 'function', function: { name: 'Agent', arguments: secondArgs.slice(0, 11) } }] }),
    ]), { multiline: true, metadata: 'id: wire-event\nevent: message\nretry: 100\n' })
    + event(chunk([
      choice(1, { tool_calls: [{ index: 0, function: { arguments: secondArgs.slice(11) } }] }),
      choice(0, { content: '尾巴', reasoning_content: '继续', tool_calls: [
        { index: 0, id: 'ent-1', function: { name: 'ent', arguments: agentArgs.slice(21) } },
        { index: 1, id: '1', function: { name: 'File', arguments: foreignArgs.slice(17) } },
      ] }),
    ]), { crlf: true })
    + event(chunk([choice(1, {}, 'tool_calls')]))
    + event(chunk([choice(0, {}, 'tool_calls')]), { crlf: true })
    + event(chunk([], { usage: { prompt_tokens: 7, completion_tokens: 19 } }))
    + 'data: [DONE]\r\n\r\n';
  const output = await readStream(r, stream, 1);
  expect(output).toStartWith(': keepalive\r\n\r\n');
  expect(output).toContain('id: wire-event\nevent: message\nretry: 100\n');
  expect(output).toEndWith('data: [DONE]\r\n\r\n');
  const parsed = events(output), choices = parsed.flatMap(value => value.choices || []);
  expect(choices.map(value => value.delta.content || '').join('')).toBe('开头尾巴');
  expect(choices.map(value => value.delta.reasoning_content || '').join('')).toBe('思考继续');
  expect(parsed.at(-1).usage).toEqual({ prompt_tokens: 7, completion_tokens: 19 });
  expect(choices.filter(value => value.finish_reason).map(value => [value.index, value.finish_reason])).toEqual([[1, 'tool_calls'], [0, 'tool_calls']]);
  const calls = assembledCalls(output);
  expect(calls).toHaveLength(3);
  const primary = calls.find(value => /_p_/.test(value.id));
  const secondary = calls.find(value => /_d_/.test(value.id));
  const foreign = calls.find(value => value.id === 'read-1');
  expect(primary.function.name).toBe('Agent');
  expect(JSON.parse(primary.function.arguments).subagent_type).toBe(r.profileName(models.primaryModel));
  expect(JSON.parse(primary.function.arguments).prompt).toBe(args().prompt);
  expect(JSON.parse(secondary.function.arguments).subagent_type).toBe(r.profileName(models.secondaryModel));
  expect(JSON.parse(secondary.function.arguments).prompt).toBe('第二个任务。');
  expect(foreign.function.name).toBe('ReadFile');
  expect(foreign.function.arguments).toBe(foreignArgs);
  expect(primary.index).toBe(0);
  expect(foreign.index).toBe(1);
  const audited = prepare(r, [{ role: 'assistant', tool_calls: calls }]).payload.messages[0].tool_calls;
  expect(JSON.parse(audited.find(value => value.id === primary.id).function.arguments).model).toBe('primary');
  expect(JSON.parse(audited.find(value => value.id === secondary.id).function.arguments)).not.toHaveProperty('model');
  expect(audited.find(value => value.id === foreign.id)).toBe(foreign);
  expect(output).not.toContain(secret);
});

test('ordinary SSE text remains incremental while tool fragments wait for a finish event', async () => {
  const first = event(chunk([choice(0, { content: 'Visible immediately.' })]));
  const partial = event(chunk([choice(0, { tool_calls: [{ index: 0, id: 'a', type: 'function',
    function: { name: 'Agent', arguments: JSON.stringify(args()) } }] })]));
  let reads = 0;
  async function* source() {
    reads++; yield Buffer.from(first);
    reads++; yield Buffer.from(partial);
    reads++; yield Buffer.from(event(chunk([choice(0, {}, 'tool_calls')])) + 'data: [DONE]\n\n');
  }
  const iterator = router().transformSSE(source(), models);
  expect((await iterator.next()).value).toBe(first);
  expect(reads).toBe(1);
  const buffered = (await iterator.next()).value;
  expect(streamCalls(buffered)).toEqual([]);
  expect(reads).toBe(2);
  expect(streamCalls((await iterator.next()).value)).toHaveLength(1);
  expect(reads).toBe(3);
  expect((await iterator.next()).value).toBe('data: [DONE]\n\n');
  expect((await iterator.next()).done).toBe(true);
});

test('SSE truncation, malformed arguments and unfinished termination preserve original calls for native validation', async () => {
  const partial = event(chunk([choice(0, { tool_calls: [{ index: 0, id: 'a', type: 'function',
    function: { name: 'Agent', arguments: '{"prompt":"half' } }] })]));
  const whole = event(chunk([choice(0, { tool_calls: [{ index: 0, id: 'a', type: 'function',
    function: { name: 'Agent', arguments: JSON.stringify(args()) } }] })]));
  for (const [text, expected] of [
    [partial, '{"prompt":"half'],
    [partial + 'data: [DONE]\n\n', '{"prompt":"half'],
    [partial + event(chunk([choice(0, {}, 'tool_calls')])), '{"prompt":"half'],
    [whole + event(chunk([choice(0, {}, 'length')])) + 'data: [DONE]\n\n', JSON.stringify(args())],
  ]) {
    const output = await readStream(router(), text), calls = assembledCalls(output);
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('a');
    expect(calls[0].function.arguments).toBe(expected);
    if (text.includes('[DONE]')) expect(output).toEndWith('data: [DONE]\n\n');
  }
  const malformed = 'data: {"choices":';
  const output = await readStream(router(), whole + malformed);
  expect(output).toContain(malformed);
  expect(assembledCalls(output.slice(0, output.indexOf(malformed)))[0].function.arguments).toBe(JSON.stringify(args()));
});

test('SSE upstream errors and caller cancellation discard buffered calls and close the input iterator', async () => {
  const partial = event(chunk([choice(0, { tool_calls: [{ index: 0, id: 'a', type: 'function',
    function: { name: 'Agent', arguments: '{' } }] })]));
  const errorEvent = event({ error: { code: 'upstream_error', message: 'Synthetic failure' } }, { metadata: 'event: error\n' });
  const output = await readStream(router(), partial + errorEvent + 'data: [DONE]\n\n');
  expect(output).toContain(errorEvent);
  expect(streamCalls(output)).toEqual([]);
  let closed = false, captured = '';
  async function* cancelled() {
    try { yield Buffer.from(partial); throw Object.assign(Error('cancelled'), { name: 'AbortError' }); }
    finally { closed = true; }
  }
  await expect((async () => { for await (const value of router().transformSSE(cancelled(), models)) captured += value; })()).rejects.toThrow('cancelled');
  expect(closed).toBe(true);
  expect(streamCalls(captured)).toEqual([]);
  closed = false;
  async function* returned() {
    try { yield Buffer.from(partial); yield Buffer.from('data: [DONE]\n\n'); }
    finally { closed = true; }
  }
  const iterator = router().transformSSE(returned(), models);
  expect(streamCalls((await iterator.next()).value)).toEqual([]);
  await iterator.return();
  expect(closed).toBe(true);
});

test('SSE passes malformed UTF-8 and JSON without aborting and enforces the same finite response cap as JSON', async () => {
  async function* invalidUTF8() { yield new Uint8Array([0xff]); }
  let decoded = '';
  for await (const value of router().transformSSE(invalidUTF8(), models)) decoded += value;
  expect(decoded).toBe('\ufffd');
  expect(await readStream(router(), 'data: {broken}\n\n')).toBe('data: {broken}\n\n');
  async function* oversized() { yield Buffer.alloc(32 * 1024 * 1024 + 1, 32); }
  await expect((async () => { for await (const ignored of router().transformSSE(oversized(), models)) {} })())
    .rejects.toThrow('agent_routing_response_too_large');
  expect(() => router().transformJSON({ text: 'x'.repeat(32 * 1024 * 1024) }, models))
    .toThrow('agent_routing_response_too_large');
});

test('an unresolved tool name releases its original fragments as soon as it is known to be non-Agent', async () => {
  const first = event(chunk([choice(0, { tool_calls: [
    { index: 0, id: 'read-', type: 'function', function: { arguments: '{"file":' } },
    { index: 1, id: 'worker', type: 'function', function: { name: 'Agent', arguments: JSON.stringify(args()) } },
  ] })]));
  const second = event(chunk([choice(0, { tool_calls: [
    { index: 0, id: '1', function: { name: 'Read', arguments: '"one"}' } },
  ] })]));
  const third = event(chunk([choice(0, { tool_calls: [{ index: 0, function: { name: 'File', arguments: '' } }] })]));
  let reads = 0;
  async function* source() {
    for (const frame of [first, second, third, event(chunk([choice(0, {}, 'tool_calls')])), 'data: [DONE]\n\n']) {
      reads++; yield Buffer.from(frame);
    }
  }
  const iterator = router().transformSSE(source(), models);
  expect(streamCalls((await iterator.next()).value)).toEqual([]);
  expect(reads).toBe(1);
  const released = streamCalls((await iterator.next()).value);
  expect(reads).toBe(2);
  expect(released.map(call => call.id).filter(Boolean).join('')).toBe('read-1');
  expect(released.map(call => call.function?.arguments || '').join('')).toBe('{"file":"one"}');
  expect((await iterator.next()).value).toBe(third);
  const flushed = streamCalls((await iterator.next()).value);
  expect(flushed).toHaveLength(1);
  expect(flushed[0].function.name).toBe('Agent');
  expect((await iterator.next()).value).toBe('data: [DONE]\n\n');
  expect((await iterator.next()).done).toBe(true);
});

test('a missing index releases earlier Agent fragments and keeps the rest of that choice raw', async () => {
  const text = JSON.stringify(args()), split = Math.floor(text.length / 2);
  const fragments = [
    { index: 0, id: 'original-agent', type: 'function', function: { name: 'Agent', arguments: text.slice(0, split) } },
    { function: { arguments: text.slice(split) } },
    { index: 1, id: 'later-agent', type: 'function', function: { name: 'Agent', arguments: JSON.stringify(args({ model: 'primary' })) } },
  ];
  const input = fragments.map(fragment => event(chunk([choice(0, { tool_calls: [fragment] })]))).join('')
    + event(chunk([choice(0, {}, 'tool_calls')])) + 'data: [DONE]\n\n';
  const output = await readStream(router(), input);
  expect(streamCalls(output)).toEqual(fragments);
  expect(output).toEndWith('data: [DONE]\n\n');
  expect(output).not.toContain('call_rs1_');
});

test('DONE flushes multiple pending choices once without repeating text, reasoning or usage', async () => {
  const r = router(), usage = { prompt_tokens: 7, completion_tokens: 9 };
  const input = event(chunk([
    choice(0, { content: '一次中文', reasoning_content: '一次思考', tool_calls: [
      { index: 0, id: 'first', type: 'function', function: { name: 'Agent', arguments: JSON.stringify(args()) } },
    ] }),
    choice(1, { content: 'second', tool_calls: [
      { index: 0, id: 'second', type: 'function', function: { name: 'Agent', arguments: JSON.stringify(args({ model: 'primary' })) } },
    ] }),
  ]), { crlf: true }) + event(chunk([], { usage }), { crlf: true }) + 'data: [DONE]\r\n\r\n';
  const output = await readStream(r, input, 1), parsed = events(output);
  const choices = parsed.flatMap(value => value.choices || []);
  expect(output).toEndWith('data: [DONE]\r\n\r\n');
  expect(choices.map(value => value.delta?.content || '').join('')).toBe('一次中文second');
  expect(choices.map(value => value.delta?.reasoning_content || '').join('')).toBe('一次思考');
  expect(parsed.filter(value => value.usage)).toHaveLength(1);
  expect(parsed.find(value => value.usage).usage).toEqual(usage);
  expect(choices.filter(value => value.finish_reason).map(value => [value.index, value.finish_reason]))
    .toEqual([[0, 'tool_calls'], [1, 'tool_calls']]);
  const calls = streamCalls(output);
  expect(calls).toHaveLength(2);
  expect(calls.map(call => JSON.parse(call.function.arguments).subagent_type))
    .toEqual([r.profileName(models.secondaryModel), r.profileName(models.primaryModel)]);
});

test('unrecognized SSE shapes release pending calls and pass through instead of aborting the turn', async () => {
  const held = { index: 0, id: 'original-agent', type: 'function',
    function: { name: 'Agent', arguments: '{' } };
  const prefix = event(chunk([choice(0, { tool_calls: [held] })]));
  for (const malformed of ['data: {broken}\n\n', event(chunk([null])),
    event(chunk([choice('unknown', { tool_calls: [held] })])),
    event(chunk([choice(0, { tool_calls: 'native-invalid-shape' })]))]) {
    const read = readStream(router(), prefix + malformed + 'data: [DONE]\n\n');
    const output = await fulfilled(read);
    expect(output).toContain(malformed);
    expect(output).toContain('original-agent');
    expect(output).toEndWith('data: [DONE]\n\n');
    expect(output).not.toContain('call_rs1_');
  }
});

test('custom calls named Agent and fragments after a native finish event remain incremental and raw', async () => {
  const custom = event(chunk([choice(0, { tool_calls: [{ index: 0, id: 'custom-agent', type: 'custom',
    function: { name: 'Agent', arguments: JSON.stringify(args()) } }] })]));
  const finish = event(chunk([choice(0, {}, 'tool_calls')]));
  const after = event(chunk([choice(0, { tool_calls: [{ index: 1, id: 'after-finish', type: 'function',
    function: { name: 'Agent', arguments: JSON.stringify(args()) } }] })]));
  async function* source() { for (const frame of [custom, finish, after, 'data: [DONE]\n\n']) yield Buffer.from(frame); }
  const iterator = router().transformSSE(source(), models);
  expect((await iterator.next()).value).toBe(custom);
  expect((await iterator.next()).value).toBe(finish);
  expect((await iterator.next()).value).toBe(after);
  expect((await iterator.next()).value).toBe('data: [DONE]\n\n');
  expect((await iterator.next()).done).toBe(true);
});
