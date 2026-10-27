import {test, expect} from 'bun:test';
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
  expect(fixed.type).toBe('object');
  expect(fixed.oneOf).toBeUndefined();
  expect(Object.keys(fixed.properties).sort()).toEqual(['id', 'mode', 'prompt']);
  expect(fixed.required).toEqual(['mode']);
  expect(fixed.$defs).toEqual(schema().$defs);
}

test('provider compatibility is opt-in and independent from history filtering', () => {
  const request = {tools: [namespace()]};
  expect(invoke(request, {id: 'other', model: 'deepseek-v4.1-flash'})).toBeUndefined();
  expect(invoke(request, {id: 'deep', model: 'glm-5.3'})).toBeUndefined();
  expect(invoke(request, {id: 'deep', model: 'deepseek-v4.1-flash'}, {providers: {}, aliases: {}})).toBeUndefined();
  expect(invoke(request, {id: 'deep', model: 'deepseek-v4.1-flash'},
    {providers: {'magpie:deep': {deepSeekObjectRoot: false}}})).toBeUndefined();

  const result = invoke(request, {id: 'deep', model: 'deepseek-v4.1-flash'});
  expect(result).toBe(request);
  assertFixed(request.tools[0].tools[0].parameters);
  expect(invoke(request, {id: 'deep', model: 'deepseek-v4.1-flash'})).toBeUndefined();
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
      expect(invoke(request, {id: 'deep', model: 'glm-5.3'})).toBeUndefined();
      expect(request).toEqual(before);

      const result = invoke(request, {id: 'deep-old', model: 'deepseek-v4.1-flash'});
      assertFixed(result.input[0].tools[0].tools[0].parameters);
      expect(result.input[0].call_id).toBe('search_pair');
      expect(result.input.slice(1)).toEqual(before.input.slice(1));
      expect(result.tools).toEqual(before.tools);
      expect(invoke(result, {id: 'deep', model: 'deepseek-v4.1-flash'})).toBeUndefined();
    }
  }
});

test('ship remains a single import-free provider hook', () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  const code = fs.readFileSync(new URL('./' + packageJson.magpie.middleware, import.meta.url), 'utf8');
  expect(code).not.toMatch(/\bimport\s|\bfetch\s*\(|\brequire\s*\(/);
  expect(Object.keys(middleware)).toEqual(['onProvider', 'onRequest']);
});
