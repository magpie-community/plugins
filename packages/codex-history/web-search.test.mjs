import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as middleware from './codex-history.middleware.js';
import {portableWebSearch} from './history/portable-web-search.mjs';

const options = {providers: {'magpie:demo': {historyFilter: true, preserveEncryptedInclude: true}}};
const request = {model: 'demo/mock-model', include: ['reasoning.encrypted_content'],
  reasoning: {effort: 'xhigh'}, instructions: 'Summarize the recorded history.', input: [
    {type: 'reasoning', id: 'rs_foreign', encrypted_content: 'FOREIGN_CIPHERTEXT', summary: []},
    {type: 'web_search_call', id: 'ws_foreign', status: 'completed',
      action: {type: 'search', query: 'example', queries: ['example', 'another example'],
        sources: [{type: 'url', url: 'https://example.invalid/rules', title: 'Recorded source'}]},
      internal_chat_message_metadata_passthrough: {turn_id: 'PRIVATE_TURN'}},
    {type: 'message', role: 'assistant', content: 'Recorded conclusion: https://example.invalid/rules'},
    {type: 'function_call', id: 'fc_old', call_id: 'pair_keep', name: 'read_file', arguments: '{"id":"BUSINESS_ID"}'},
    {type: 'function_call_output', id: 'fco_old', call_id: 'pair_keep', output: 'FILE_TEXT_KEEP'},
    {role: 'user', content: 'Create a text summary without new searches.'}
  ]};

function filter(body, overrides = {}) {
  let rejected;
  const result = middleware.onRequest(body, {protocol: 'responses', path: '/v1/responses', options,
    ...overrides, reject: (status, message) => { rejected = {status, message}; }});
  return {result, rejected};
}

test('search history retains recorded data and later answers without native reasoning dependencies', () => {
  const before = structuredClone(request);
  const {result, rejected} = filter(request);
  assert.equal(rejected, undefined);
  assert.deepEqual(result.input[0], portableWebSearch(request.input[1]));
  assert.equal(result.input[0].type, 'message');
  assert.equal(result.input[0].role, 'assistant');
  assert.match(result.input[0].content, /recorded data only, not a new tool call/);
  assert.deepEqual(JSON.parse(result.input[0].content.split('\n').slice(1).join('\n')), {
    status: request.input[1].status, action: request.input[1].action
  });
  assert.doesNotMatch(JSON.stringify(result), /FOREIGN_CIPHERTEXT|rs_foreign|ws_foreign|PRIVATE_TURN/);
  assert.deepEqual(result.input.slice(1), [request.input[2],
    {type: 'function_call', call_id: 'pair_keep', name: 'read_file', arguments: '{"id":"BUSINESS_ID"}'},
    {type: 'function_call_output', call_id: 'pair_keep', output: 'FILE_TEXT_KEEP'}, request.input[5]]);
  assert.deepEqual(result.reasoning, request.reasoning);
  assert.deepEqual(result.include, request.include);
  assert.equal(result.instructions, request.instructions);
  assert.equal(result.model, request.model);
  assert.equal(result.store, false);
  assert.deepEqual(request, before);
  assert.deepEqual(filter(result).result, result);
});

test('all recorded search actions and partial status remain data without reconstructed results', () => {
  for (const action of [
    {type: 'search', query: 'example'},
    {type: 'open_page', url: 'https://example.invalid/doc', sources: [{id: 'BUSINESS_ID'}]},
    {type: 'find_in_page', url: 'https://example.invalid/doc', pattern: 'deadline'}
  ]) {
    for (const status of ['completed', 'in_progress', 'incomplete']) {
      const item = {type: 'web_search_call', id: 'ws_old', status, action};
      const {result} = filter({...request, input: [item]});
      assert.deepEqual(result.input[0], portableWebSearch(item));
      assert.deepEqual(JSON.parse(result.input[0].content.split('\n').slice(1).join('\n')), {status, action});
    }
  }
  assert.deepEqual(JSON.parse(portableWebSearch({type: 'web_search_call'}).content.split('\n')[1]), {});
});

test('only enabled Responses provider rules transform search history', () => {
  for (const context of [
    {options: {}}, {options: {providers: {'magpie:demo': {historyFilter: false}}}},
    {protocol: 'chat-completions'}, {protocol: 'anthropic'}
  ]) assert.equal(filter(request, context).result, undefined);
  assert.equal(filter({...request, model: 'other/mock-model'}).result, undefined);
  assert.equal(filter({...request, model: 'mock-model'}).result, undefined);
  assert.deepEqual(filter({...request, model: 'old-demo/mock-model'}, {
    options: {...options, aliases: {'old-demo': 'demo'}}
  }).result.input[0], portableWebSearch(request.input[1]));
});

test('other native tools keep their resource IDs and contents', () => {
  const file = {type: 'file_search_call', id: 'fs_keep', queries: ['example'], results: [{id: 'resource_keep', text: 'FILE_TEXT'}]};
  assert.deepEqual(filter({...request, input: [file]}).result.input, [file]);
});

test('search adaptation keeps unsafe context rejection and explicit encrypted-content cleanup', () => {
  assert.equal(filter(request, {path: '/v1/responses/compact'}).rejected.status, 409);
  for (const body of [
    {...request, previous_response_id: 'resp_old'}, {...request, conversation: 'conv_old'},
    {...request, input: [{type: 'compaction', encrypted_content: 'SEALED_CONTEXT'}]},
    {...request, input: [{type: 'item_reference', id: 'ws_old'}]},
    {...request, context_management: [{type: 'compaction'}]}
  ]) assert.ok(filter(body).rejected);
  const item = {...request.input[1], content: [
    {type: 'encrypted_content', encrypted_content: 'SEALED_PART'}, {type: 'input_text', text: 'RECORDED_TEXT'}
  ]};
  const text = filter({...request, input: [item]}).result.input[0].content;
  assert.doesNotMatch(text, /SEALED_PART/);
  assert.match(text, /RECORDED_TEXT/);
});

test('the shipped middleware remains a small import-free package with only the request hook', () => {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, '0.1.1');
  assert.deepEqual(Object.keys(middleware), ['onRequest']);
  assert.deepEqual(pkg.files, ['codex-history.middleware.js', 'README.md', 'LICENSE', 'PROVENANCE.json']);
  assert.deepEqual(Object.keys(pkg.magpie).sort(), ['middleware', 'options']);
  assert.equal(pkg.main, undefined);
  assert.equal(pkg.dependencies, undefined);
  const code = readFileSync(new URL(pkg.magpie.middleware, import.meta.url), 'utf8');
  assert.doesNotMatch(code, /\bimport\s|\bfetch\s*\(|\brequire\s*\(/);
});
