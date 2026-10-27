import {test, expect} from 'bun:test';
import {_internal as I} from '../index.mjs';

const controls = [
  {}, {thinking: {type: 'disabled'}, reasoning_effort: 'none'},
  {thinking: {type: 'enabled', effort: 'max', keep: 'all'}, reasoning_effort: 'max'},
  {thinking: {type: 'adaptive', budget_tokens: 16384}, reasoning: {effort: 'high', summary: 'auto'}},
  {thinking: null, reasoning_effort: null, reasoning: null},
];
const history = [
  {role: 'system', content: 'synthetic original system'},
  {role: 'developer', content: 'synthetic original developer'},
  {role: 'user', content: [{type: 'text', text: 'synthetic 中文'},
    {type: 'image_url', image_url: {url: 'data:image/png;base64,AAAA'}}]},
  {role: 'assistant', content: 'synthetic progress', reasoning_content: 'synthetic reasoning',
    tool_calls: [{id: 'call_read', type: 'function', function: {name: 'Read', arguments: '{}'}}]},
  {role: 'tool', tool_call_id: 'call_read', content: 'synthetic result'},
  {role: 'user', content: 'synthetic continuation'},
];

for (const [index, control] of controls.entries()) for (const form of ['string', 'request', 'bytes']) {
  test(`thinking and history survive Work provider: controls ${index}, ${form}`, async () => {
    const calls = [];
    const session = {uid: 'synthetic', workToken: 'synthetic-work', webToken: 'synthetic-web'};
    const reply = new Response('data: [DONE]\n\n', {headers: {'Content-Type': 'text/event-stream'}});
    const p = I.createPlugin({readSession: () => session, fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body)); return reply;
    }});
    const loader = await p.auth.loader(async () => ({source: 'kimi-work-desktop', uid: session.uid}));
    const payload = {model: 'synthetic-model', stream: true, messages: history, tools: [
      {type: 'function', function: {name: 'Read', parameters: {type: 'object', properties: {path: {type: 'string'}}}}},
    ], ...control};
    const body = JSON.stringify(payload), url = I.BASE + '/chat/completions';
    const result = form === 'request' ? await loader.fetch(new Request(url, {method: 'POST', body}))
      : await loader.fetch(url, {method: 'POST', body: form === 'bytes' ? new TextEncoder().encode(body) : body});
    expect(result).toBe(reply);
    expect(calls).toEqual([payload]);
  });
}

test('a required tool-schema rewrite preserves thinking, tool identity and the entire large history', async () => {
  const session = {uid: 'synthetic', workToken: 'synthetic-work', webToken: 'synthetic-web'};
  let sent;
  const p = I.createPlugin({readSession: () => session, fetchImpl: async (_url, init) => {
    sent = JSON.parse(init.body); return new Response('{}');
  }});
  const loader = await p.auth.loader(async () => ({source: 'kimi-work-desktop', uid: session.uid}));
  const payload = {model: 'synthetic-model', thinking: {type: 'enabled', effort: 'max', keep: 'all'},
    messages: [...history, {role: 'user', content: 'history '.repeat(270000)}], tools: [
      {type: 'function', function: {name: 'Read', description: 'synthetic declaration', parameters: {
        type: 'object', properties: {mode: {enum: ['text', 'bytes']}}}}},
    ]};
  await loader.fetch(I.BASE + '/chat/completions', {method: 'POST', body: JSON.stringify(payload)});
  expect(sent.messages).toEqual(payload.messages);
  expect(sent.thinking).toEqual(payload.thinking);
  expect(sent.tools[0].function.name).toBe('Read');
  expect(sent.tools[0].function.description).toBe('synthetic declaration');
  expect(sent.tools[0].function.parameters.properties.mode).toEqual({type: 'string', enum: ['text', 'bytes']});
  expect({...sent, tools: undefined}).toEqual({...payload, tools: undefined});
});
