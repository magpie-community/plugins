import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as middleware from './codex-history.middleware.js';

const options = {providers: {'magpie:demo': {historyFilter: true, preserveEncryptedInclude: true}}, aliases: {}};
const history = model => ({model, include: ['reasoning.encrypted_content'], input: [
  {type: 'reasoning', id: 'rs_old', encrypted_content: 'FOREIGN', summary: []},
  {type: 'message', id: 'msg_old', role: 'assistant', content: [{type: 'output_text', text: 'KEEP'}]},
  {type: 'function_call', id: 'fc_old', call_id: 'pair', name: 'shell', arguments: '{}'},
  {type: 'function_call_output', id: 'fco_old', call_id: 'pair', output: 'KEEP_RESULT'},
  {role: 'user', content: 'next'},
]});
const context = (extra = {}) => ({protocol: 'responses', path: '/v1/responses', options, state: {},
  reject: () => assert.fail('a provider try cannot refuse a request'), ...extra});

test('a group try is sent what a direct request to that provider is', () => {
  const group = history('group/sol-dedicated');
  const before = structuredClone(group);
  assert.equal(middleware.onRequest(group, context()), undefined, 'a group prefix has no rule of its own');
  const direct = middleware.onRequest(history('demo/gpt-6-astra'), context());
  const sent = middleware.onProvider(group, context({provider: {id: 'demo', name: 'demo', model: 'gpt-6-astra'}}));
  assert.deepEqual(sent, {...direct, model: group.model});
  assert.deepEqual(group, before, 'the hook does not change the body it is given');
});

test('a request filtered by its own prefix is not filtered again on its try', () => {
  const ctx = context();
  const filtered = middleware.onRequest(history('demo/gpt-6-astra'), ctx);
  assert.equal(ctx.state.historyFiltered, true);
  const provider = {id: 'demo', name: 'demo', model: 'gpt-6-astra'};
  assert.equal(middleware.onProvider(filtered, {...ctx, provider}), undefined);
  assert.deepEqual(middleware.onProvider(structuredClone(filtered), context({provider})), filtered,
    'filtering the filtered body again changes nothing');
});

test('a try that has no rule, is off, or carries history that cannot move stays byte-identical', () => {
  for (const [label, request, extra] of [
    ['no rule', history('group/sol-dedicated'), {provider: {id: 'other', model: 'gpt-6-astra'}}],
    ['rule off', history('group/sol-dedicated'), {provider: {id: 'demo', model: 'gpt-6-astra'},
      options: {providers: {'magpie:demo': {historyFilter: false}}}}],
    ['cannot move', {...history('group/sol-dedicated'), previous_response_id: 'resp_old'},
      {provider: {id: 'demo', model: 'gpt-6-astra'}}],
  ]) {
    const bytes = JSON.stringify(request);
    assert.equal(middleware.onProvider(request, context(extra)), undefined, label);
    assert.equal(JSON.stringify(request), bytes, label);
  }
});
