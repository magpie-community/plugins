import { test, expect } from 'bun:test';
import { AgentModelRouter } from './agent-routing.mjs';

// Synthetic-only reproduction suite. It never starts a server, never reads a
// real credential, and only exercises the in-process router API.
const secret = 'a3'.repeat(32);
const otherSecret = 'b4'.repeat(32);
const models = { primaryModel: 'synthetic/primary', secondaryModel: 'synthetic/secondary' };
const allowedModels = Object.values(models);
const options = { ...models, allowedModels };
const router = (value = secret) => new AgentModelRouter({ secret: value });
const args = (extra = {}) => ({ prompt: 'Read magpie-local-0123456789abcdef01234567.txt，返回文件。',
  description: 'Read one test file', ...extra });
const user = content => ({ role: 'user', content });
const system = content => ({ role: 'system', content });
const developer = content => ({ role: 'developer', content });
const call = (parameters, name = 'Agent', id = 'call-1') => ({ id, type: 'function', function: {
  name, arguments: typeof parameters === 'string' ? parameters : JSON.stringify(parameters),
} });
const completion = (calls, extra = {}) => ({ id: 'completion-1', object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: calls }, finish_reason: 'tool_calls' }],
  ...extra });
const prepare = (r, messages, configuration = options, extra = {}) =>
  r.prepare({ model: 'native/current', messages, ...extra }, configuration);
const translated = (r, parameters, configuration = models) =>
  JSON.parse(r.transformJSON(completion([call(parameters)]), configuration)
    .choices[0].message.tool_calls[0].function.arguments);
const profileBody = (r, model = models.secondaryModel) => r.profileText(model).split('\n---\n')[1]
  .replace('${base_prompt}', 'Native base system prompt.');
const section = (r, model = models.secondaryModel) =>
  profileBody(r, model).match(/\[agent-profile-route:v1\][\s\S]*?\[\/agent-profile-route\]/)[0];
const tokenOf = marker => {
  const match = /\[agent-profile-route:v1\]\r?\n([^\r\n]+)\r?\n\[\/agent-profile-route\]/.exec(marker);
  return match ? match[1].slice(0, match[1].lastIndexOf(':')) : '';
};
const event = (value, { crlf = false, multiline = false, metadata = '' } = {}) =>
  (metadata + JSON.stringify(value, null, multiline ? 2 : undefined).split('\n').map(line => 'data: ' + line).join('\n')
    + '\n\n').replace(/\n/g, crlf ? '\r\n' : '\n');
const chunk = (choices, extra = {}) => ({ id: 'stream-1', object: 'chat.completion.chunk',
  model: 'wire/model', created: 123, choices, ...extra });
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
const readTool = marker => ({ type: 'function', function: { name: 'Read',
  description: 'Synthetic reader.\n' + marker,
  parameters: { type: 'object', properties: {
    file_path: { type: 'string', description: 'Synthetic path. ' + marker },
  }, required: ['file_path'] } } });
function markerMessages(marker) {
  return {
    messages: [
      user('Before\n' + marker + '\nAfter'),
      user([{ type: 'text', text: marker }, { type: 'text', text: 'Plain part.' }]),
      { role: 'tool', tool_call_id: 'read-1', content: marker },
      { role: 'assistant', content: marker },
      { role: 'assistant', content: null, tool_calls: [{ id: 'read-1', type: 'function',
        function: { name: 'Read', arguments: JSON.stringify({ file_path: marker }) } }] },
    ],
    tools: [readTool(marker)],
  };
}

// B1: an omitted model with an explicit native subagent_type is native intent.
test('B1: an Agent call without model keeps an explicit native subagent_type (JSON)', () => {
  const r = router();
  const output = translated(r, args({ subagent_type: 'explore' }));
  expect(output.subagent_type).toBe('explore');
  expect(output).not.toHaveProperty('model');
  expect(output.prompt).toBe(args().prompt);
  expect(output.description).toBe(args().description);
});

test('B1: a streamed Agent call without model keeps an explicit native subagent_type', async () => {
  const r = router();
  const input = JSON.stringify(args({ subagent_type: 'explore' }));
  const stream = event(chunk([choice(0, { tool_calls: [{ index: 0, id: 'agent-explore', type: 'function',
    function: { name: 'Agent', arguments: input } }] })]))
    + event(chunk([choice(0, {}, 'tool_calls')]))
    + 'data: [DONE]\n\n';
  const output = await readStream(r, stream);
  const calls = streamCalls(output);
  expect(calls).toHaveLength(1);
  expect(JSON.parse(calls[0].function.arguments).subagent_type).toBe('explore');
});

// B2: profileText must be opaque: no model ID, no reversible base64/base64url.
test('B2: profileText never exposes the model ID or its base64/base64url forms', () => {
  const r = router();
  const model = 'vendor/review-private-target';
  const text = r.profileText(model);
  const marker = section(r, model);
  const token = tokenOf(marker);
  const base64 = Buffer.from(model).toString('base64');
  const base64url = Buffer.from(model).toString('base64url');
  expect(marker).toContain('[agent-profile-route:v1]');
  expect(token).not.toBe('');
  expect(text).not.toContain(model);
  expect(text).not.toContain(base64);
  expect(text).not.toContain(base64url);
  // The current token is the model ID encoded; it must not decode to it.
  expect(Buffer.from(token, 'base64url').toString('utf8')).not.toBe(model);
});

test('B2: profileName is key-bound, so different secrets never share a name', () => {
  const one = router(secret), two = router(otherSecret), again = router(secret);
  for (const model of [models.primaryModel, models.secondaryModel, 'vendor/review-private-target']) {
    expect(one.profileName(model)).toBe(again.profileName(model));
    expect(one.profileName(model)).not.toBe(two.profileName(model));
  }
  expect(one.profileName(models.primaryModel)).not.toBe(one.profileName(models.secondaryModel));
});

// B2: a complete route section that does not authenticate is a hard failure,
// never a silent fallback to the primary model.
test('B2: invalid or unknown route sections fail agent_profile_unbound instead of falling back to primary', () => {
  const r = router();
  const marker = section(r);
  const tamperedMAC = marker.replace(/:([a-f0-9]{64})/, (_, mac) =>
    ':' + (mac[0] === '0' ? '1' : '0') + mac.slice(1));
  const tamperedToken = marker.replace(/^\[agent-profile-route:v1\]\r?\n([A-Za-z0-9_-]+):/,
    (_, token) => '[agent-profile-route:v1]\n' + token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A') + ':');
  const foreign = section(router(otherSecret));
  const unknown = section(router()); // Same key and valid MAC, but absent from this router's saved bindings.
  const cases = [
    ['tampered MAC', system(tamperedMAC)],
    ['tampered token', system(tamperedToken)],
    ['section signed by another secret', system(foreign)],
    ['unknown token with a valid MAC', system(unknown)],
    ['developer role invalid section', developer(tamperedMAC)],
  ];
  for (const [name, message] of cases) {
    let error;
    try { prepare(r, [message]); } catch (caught) { error = caught; }
    expect({ name, code: error?.code, message: error?.message })
      .toEqual({ name, code: 'agent_profile_unbound', message: 'agent_profile_unbound' });
  }
  // A later valid binding must not hide an earlier unknown reserved section.
  expect(() => prepare(r, [system(unknown), developer(marker)])).toThrow('agent_profile_unbound');
  expect(() => prepare(r, [system(unknown + '\n' + marker)])).toThrow('agent_profile_unbound');
  // A section that does authenticate still selects its model and is removed.
  const bound = prepare(r, [system(section(r))]);
  expect(bound.model).toBe(models.secondaryModel);
  expect(JSON.stringify(bound.payload.messages)).not.toContain('[agent-profile-route:v1]');
});

// B2: user, tool, and history strings never select a model.
test('B2: user, tool, history, and tool-schema markers never select a route', () => {
  const r = router();
  const { messages, tools } = markerMessages(section(r));
  for (const message of messages) expect(() => prepare(r, [message])).toThrow('agent_profile_unbound');
  expect(() => prepare(r, [], options, { tools })).toThrow('agent_profile_unbound');
});

// B2: those same strings must not carry the retained route section upstream.
test('B2: route sections do not leak into upstream messages or tool strings', () => {
  const r = router();
  const marker = section(r);
  const token = tokenOf(marker);
  expect(token).not.toBe('');
  const { messages, tools } = markerMessages(marker);
  const before = structuredClone({ messages, tools });
  expect(() => prepare(r, messages, options, { tools })).toThrow('agent_profile_unbound');
  expect({ messages, tools }).toEqual(before);
  const result = prepare(r, [system(marker)]);
  const serialized = JSON.stringify(result.payload);
  expect(serialized).not.toContain('[agent-profile-route:v1]');
  expect(serialized).not.toContain('[/agent-profile-route]');
  expect(serialized).not.toContain(token);
});

// S1: non-Agent fragments are forwarded as they arrive, not held to finish.
test('S1: non-Agent tool fragments stream immediately instead of waiting for finish', async () => {
  const r = router();
  const readArgs = '{"file_path":"magpie-local-0123456789abcdef01234567.txt"}';
  const first = event(chunk([choice(0, { tool_calls: [{ index: 0, id: 'read-1', type: 'function',
    function: { name: 'Read', arguments: readArgs.slice(0, 11) } }] })]));
  const second = event(chunk([choice(0, { tool_calls: [{ index: 0,
    function: { arguments: readArgs.slice(11) } }] })]));
  const finish = event(chunk([choice(0, {}, 'tool_calls')]));
  const done = 'data: [DONE]\n\n';
  const yields = [];
  for await (const part of r.transformSSE(bytes(first + second + finish + done), models)) yields.push(part);
  expect(yields).toHaveLength(4);
  const firstCalls = streamCalls(yields[0]);
  expect(firstCalls).toHaveLength(1);
  expect(firstCalls[0].id).toBe('read-1');
  expect(firstCalls[0].function.name).toBe('Read');
  expect(firstCalls[0].function.arguments).toBe(readArgs.slice(0, 11));
  expect(streamCalls(yields[1])[0].function.arguments).toBe(readArgs.slice(11));
  for (const part of yields.slice(0, 3)) expect(part).not.toContain('[DONE]');
  expect(yields[3]).toBe(done);
});

// S1: native validation, not the transformer, rejects invalid Agent arguments.
test('S1: invalid Agent JSON arguments pass through to native validation and DONE completes', async () => {
  const r = router();
  const invalid = '{"prompt":"half';
  const first = event(chunk([choice(0, { tool_calls: [{ index: 0, id: 'agent-bad', type: 'function',
    function: { name: 'Agent', arguments: invalid.slice(0, 5) } }] })]));
  const second = event(chunk([choice(0, { tool_calls: [{ index: 0,
    function: { arguments: invalid.slice(5) } }] })]));
  const finish = event(chunk([choice(0, {}, 'tool_calls')]));
  const done = 'data: [DONE]\n\n';
  const read = readStream(r, first + second + finish + done);
  const output = await fulfilled(read);
  expect(output).toEndWith(done);
  const calls = streamCalls(output);
  expect(calls).toHaveLength(1);
  expect(calls[0].function.name).toBe('Agent');
  expect(calls[0].function.arguments).toBe(invalid);
});

test('S1: an invalid Agent model value passes through to native validation and DONE completes', async () => {
  const r = router();
  const input = JSON.stringify({ prompt: 'Read magpie-local-0123456789abcdef01234567.txt',
    description: 'Read one test file', model: 'unknown/model' });
  const stream = event(chunk([choice(0, { tool_calls: [{ index: 0, id: 'agent-model', type: 'function',
    function: { name: 'Agent', arguments: input } }] })]))
    + event(chunk([choice(0, {}, 'tool_calls')]))
    + 'data: [DONE]\n\n';
  const done = 'data: [DONE]\n\n';
  const read = readStream(r, stream);
  const output = await fulfilled(read);
  expect(output).toEndWith(done);
  const calls = streamCalls(output);
  expect(calls).toHaveLength(1);
  expect(calls[0].function.arguments).toBe(input);
  expect(JSON.parse(calls[0].function.arguments).model).toBe('unknown/model');
});

// S1: a missing fragment index is a native-shape detail, not a stream failure.
test('S1: a non-Agent tool fragment without index does not destroy the stream', async () => {
  const r = router();
  const readArgs = '{"file_path":"magpie-local-0123456789abcdef01234567.txt"}';
  const first = event(chunk([choice(0, { tool_calls: [{ id: 'read-1', type: 'function',
    function: { name: 'Read', arguments: readArgs.slice(0, 7) } }] })]));
  const finish = event(chunk([choice(0, {}, 'tool_calls')]));
  const done = 'data: [DONE]\n\n';
  const yields = [];
  const read = (async () => {
    for await (const part of r.transformSSE(bytes(first + finish + done), models)) yields.push(part);
    return yields;
  })();
  expect(await fulfilled(read)).toHaveLength(3);
  const calls = streamCalls(yields[0]);
  expect(calls).toHaveLength(1);
  expect(calls[0].id).toBe('read-1');
  expect(calls[0].function.name).toBe('Read');
  expect(calls[0].function.arguments).toBe(readArgs.slice(0, 7));
  expect(yields[2]).toBe(done);
});

test('S1: an Agent fragment without index does not destroy the stream', async () => {
  const r = router();
  const content = event(chunk([choice(0, { content: 'visible before the call' })]));
  const fragment = event(chunk([choice(0, { tool_calls: [{ id: 'agent-no-index', type: 'function',
    function: { name: 'Agent', arguments: JSON.stringify(args()) } }] })]));
  const finish = event(chunk([choice(0, {}, 'tool_calls')]));
  const done = 'data: [DONE]\n\n';
  const read = readStream(r, content + fragment + finish + done);
  const output = await fulfilled(read);
  expect(output).toContain('visible before the call');
  expect(output).toEndWith(done);
});

// S1: DONE without a finish_reason still flushes buffered Agent calls.
test('S1: a stream ending at DONE without finish_reason flushes Agent calls with tool_calls semantics', async () => {
  const r = router();
  const input = JSON.stringify(args());
  const first = event(chunk([choice(0, { tool_calls: [{ index: 0, id: 'agent-1', type: 'function',
    function: { name: 'Agent', arguments: input.slice(0, 9) } }] })]));
  const second = event(chunk([choice(0, { tool_calls: [{ index: 0,
    function: { arguments: input.slice(9) } }] })]));
  const done = 'data: [DONE]\n\n';
  const read = readStream(r, first + second + done);
  const output = await fulfilled(read);
  expect(output).toEndWith(done);
  const flushed = events(output).flatMap(value => value.choices || [])
    .find(value => value.delta?.tool_calls?.length);
  expect(flushed).toBeTruthy();
  expect(flushed.finish_reason).toBe('tool_calls');
  const calls = streamCalls(output);
  expect(calls).toHaveLength(1);
  expect(calls[0].function.name).toBe('Agent');
  expect(JSON.parse(calls[0].function.arguments).subagent_type).toBe(r.profileName(models.secondaryModel));
});

// S1 regression: existing multi-choice, UTF-8, CRLF, and native result-link
// behavior must keep working while the streaming rules above change.
test('S1 regression: multi-choice UTF-8 CRLF streams keep native tool IDs linked to results', async () => {
  const r = router();
  const primary = { prompt: '读取中文文件。', description: '合成主要任务', model: 'primary' };
  const secondary = { prompt: '第二个任务。', description: '合成次要任务' };
  const readArgs = '{"file_path":"magpie-local-0123456789abcdef01234567.txt"}';
  const stream = event(chunk([choice(0, { role: 'assistant', content: '开头中文' })]), { crlf: true })
    + event(chunk([
      choice(0, { tool_calls: [{ index: 0, id: 'agent-primary', type: 'function',
        function: { name: 'Agent', arguments: JSON.stringify(primary) } }] }),
      choice(1, { tool_calls: [{ index: 0, id: 'agent-secondary', type: 'function',
        function: { name: 'Agent', arguments: JSON.stringify(secondary) } }] }),
    ]), { crlf: true, multiline: true })
    + event(chunk([choice(0, { tool_calls: [{ index: 1, id: 'read-1', type: 'function',
      function: { name: 'Read', arguments: readArgs } }] })]), { crlf: true })
    + event(chunk([choice(0, {}, 'tool_calls'), choice(1, {}, 'tool_calls')]), { crlf: true })
    + 'data: [DONE]\r\n\r\n';
  const output = await readStream(r, stream, 1);
  expect(output).toEndWith('data: [DONE]\r\n\r\n');
  const parsed = events(output);
  expect(parsed.flatMap(value => value.choices || []).map(value => value.delta?.content || '').join(''))
    .toContain('开头中文');
  const calls = streamCalls(output);
  const primaryCall = calls.find(value => value.function?.name === 'Agent'
    && JSON.parse(value.function.arguments).prompt === primary.prompt);
  const secondaryCall = calls.find(value => value.function?.name === 'Agent'
    && JSON.parse(value.function.arguments).prompt === secondary.prompt);
  const nativeCall = calls.find(value => value.id === 'read-1');
  expect(primaryCall).toBeTruthy();
  expect(secondaryCall).toBeTruthy();
  expect(nativeCall).toBeTruthy();
  expect(JSON.parse(primaryCall.function.arguments).subagent_type).toBe(r.profileName(models.primaryModel));
  expect(JSON.parse(secondaryCall.function.arguments).subagent_type).toBe(r.profileName(models.secondaryModel));
  expect(nativeCall.function.arguments).toBe(readArgs);
  expect(parsed.flatMap(value => value.choices || []).filter(value => value.finish_reason)
    .map(value => value.finish_reason)).toEqual(['tool_calls', 'tool_calls']);
  const results = [{ role: 'tool', tool_call_id: primaryCall.id, content: 'SYNTHETIC_AGENT_OK' },
    { role: 'tool', tool_call_id: secondaryCall.id, content: 'SYNTHETIC_AGENT_OK' },
    { role: 'tool', tool_call_id: nativeCall.id, content: 'SYNTHETIC_FILE_OK' }];
  const history = prepare(r, [system(profileBody(r)), { role: 'assistant', content: null, tool_calls: calls },
    ...results, user('Audit the synthetic results.')]);
  expect(history.model).toBe(models.secondaryModel);
  const restored = history.payload.messages[1].tool_calls;
  const ids = new Set(restored.map(value => value.id));
  for (const result of results) expect(ids.has(result.tool_call_id)).toBe(true);
  for (let index = 0; index < results.length; index++) expect(history.payload.messages[2 + index]).toBe(results[index]);
  expect(restored.find(value => value.id === 'read-1').function.arguments).toBe(readArgs);
  expect(JSON.parse(restored.find(value => value.id === primaryCall.id).function.arguments).model).toBe('primary');
  expect(JSON.parse(restored.find(value => value.id === secondaryCall.id).function.arguments))
    .not.toHaveProperty('model');
});
