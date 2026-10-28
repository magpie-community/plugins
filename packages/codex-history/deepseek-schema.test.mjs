import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as middleware from './codex-history.middleware.js';

const options = {
  providers: {
    'magpie:deep': {historyFilter: false, preserveEncryptedInclude: true, deepSeekObjectRoot: true},
    'magpie:other': {historyFilter: true, preserveEncryptedInclude: true},
  },
  aliases: {'deep-old': 'deep'},
};

function schema() {
  return {
    oneOf: [{$ref: '#/$defs/view'}, {$ref: '#/$defs/changes'}],
    $defs: {
      view: {type: 'object', properties: {mode: {const: 'view'}, id: {type: 'string'}},
        required: ['mode', 'id']},
      changes: {oneOf: [
        {type: 'object', properties: {mode: {const: 'create'}, prompt: {type: 'string'}},
          required: ['mode', 'prompt']},
        {type: 'object', properties: {mode: {const: 'update'}, id: {type: 'string'}},
          required: ['mode', 'id']},
      ]},
    },
  };
}

function namespace() {
  return {type: 'namespace', name: 'codex_app', tools: [
    {type: 'function', name: 'automation_update', strict: false, parameters: schema()},
  ]};
}

function invoke(body, provider, providerOptions = options) {
  return middleware.onProvider(body, {provider, options: providerOptions});
}

function assertFixed(fixed) {
  assert.equal(fixed.type, 'object');
  assert.equal(fixed.oneOf, undefined);
  assert.deepEqual(Object.keys(fixed.properties).sort(), ['id', 'mode', 'prompt']);
  assert.deepEqual(fixed.required, ['mode']);
  assert.deepEqual(fixed.$defs, schema().$defs);
}

test('provider compatibility is opt-in and independent from history filtering', () => {
  const request = {tools: [namespace()]};
  assert.equal(invoke(request, {id: 'other', model: 'deepseek-v4.1-flash'}), undefined);
  assert.equal(invoke(request, {id: 'deep', model: 'glm-5.3'}), undefined);
  assert.equal(invoke(request, {id: 'deep', model: 'deepseek-v4.1-flash'}, {providers: {}, aliases: {}}), undefined);
  assert.equal(invoke(request, {id: 'deep', model: 'deepseek-v4.1-flash'},
    {providers: {'magpie:deep': {deepSeekObjectRoot: false}}}), undefined);

  const result = invoke(request, {id: 'deep', model: 'deepseek-v4.1-flash'});
  assert.equal(result, request);
  assertFixed(request.tools[0].tools[0].parameters);
  assert.equal(invoke(request, {id: 'deep', model: 'deepseek-v4.1-flash'}), undefined);
});

test('no provider ID is enabled implicitly; a rule without the field stays off', () => {
  for (const [id, providerOptions] of [
    ['deepseek', {providers: {}, aliases: {}}],
    ['strict-deepseek', {providers: {'magpie:strict-deepseek': {historyFilter: false}}, aliases: {}}],
    ['strict-deepseek', {providers: {'magpie:strict-deepseek': {historyFilter: true, deepSeekObjectRoot: false}}, aliases: {}}],
  ]) {
    const request = {tools: [namespace()]};
    assert.equal(invoke(request, {id, model: 'deepseek-v4.1-flash'}, providerOptions), undefined, id);
    assert.equal(request.tools[0].tools[0].parameters.oneOf.length, 2);
  }
});

test('resumed and Lite history repairs only declarations, retaining calls and results', () => {
  for (const type of ['tool_search_output', 'additional_tools']) {
    for (const tools of [undefined, [], [{type: 'tool_search', execution: 'client'}]]) {
      const request = {model: 'deep-old/deepseek-v4.1-flash', tools, input: [
        {type, call_id: 'search_pair', tools: [namespace()]},
        {type: 'function_call_output', call_id: 'result_pair', output: JSON.stringify(namespace()),
          tools: [namespace()]},
        {role: 'user', content: 'KEEP_HISTORY'},
      ]};
      const before = structuredClone(request);
      // The alias and display provider IDs both resolve to the same rule.
      assert.equal(invoke(request, {id: 'deep', model: 'glm-5.3'}), undefined);
      assert.deepEqual(request, before);

      const result = invoke(request, {id: 'deep-old', model: 'deepseek-v4.1-flash'});
      assertFixed(result.input[0].tools[0].tools[0].parameters);
      assert.equal(result.input[0].call_id, 'search_pair');
      assert.deepEqual(result.input.slice(1), before.input.slice(1));
      assert.deepEqual(result.tools, before.tools);
      assert.equal(invoke(result, {id: 'deep', model: 'deepseek-v4.1-flash'}), undefined);
    }
  }
});

test('ship remains a single import-free file with request and provider hooks', () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  const code = fs.readFileSync(new URL(packageJson.magpie.middleware, import.meta.url), 'utf8');
  assert.doesNotMatch(code, /\bimport\s|\bfetch\s*\(|\brequire\s*\(/);
  assert.deepEqual(Object.keys(middleware), ['onProvider', 'onRequest']);
});
