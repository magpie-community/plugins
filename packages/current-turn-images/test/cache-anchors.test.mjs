import {test} from 'node:test';
import assert from 'node:assert/strict';
import {addCacheAnchors} from '../cache-anchors.js';
import {filterRequest} from '../filter.js';
import {onRequest} from '../request.hooks.js';
import {mkdtemp, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const ctx = {protocol: 'responses', model: 'custom/gpt-6.1-sol', options: {cacheAnchors: {responses: ['custom/gpt-6.1-sol']}}};
const message = {role: 'user', content: [{type: 'input_text', text: 'stable prefix'}, {type: 'input_image', image_url: 'data:image/png;base64,YQ=='}]};
const body = () => ({model: ctx.model, tools: [{type: 'function', name: 'lookup', parameters: {type: 'object'}}], input: [structuredClone(message)]});
test('adds only cache metadata before the image without mutating caller data', () => {
  const original = body();
  const before = structuredClone(original);
  const result = addCacheAnchors(original, ctx);
  assert.deepEqual(original, before);
  assert.equal(result.added, 1);
  const restored = structuredClone(result.body);
  delete restored.prompt_cache_options;
  delete restored.input[0].content[0].prompt_cache_breakpoint;
  assert.deepEqual(restored, before);
});
test('keeps the same anchor when the image becomes historical', () => {
  const first = addCacheAnchors(body(), ctx).body;
  const next = {...body(), input: [structuredClone(message), {role: 'assistant', content: 'OK'}, {role: 'user', content: 'next'}]};
  const prepared = addCacheAnchors(next, ctx);
  const filtered = filterRequest(prepared.body, 'responses').body;
  assert.deepEqual(filtered.input[0].content[0], first.input[0].content[0]);
});
test('unsupported protocol and unconfigured models retain exact objects', () => {
  for (const other of [{...ctx, protocol: 'chat'}, {...ctx, protocol: 'anthropic'}, {...ctx, protocol: 'gemini'}, {...ctx, model: 'unknown'}, {...ctx, options: {}}]) {
    const original = body();
    assert.equal(addCacheAnchors(original, other).body, original);
  }
});
test('respects existing markers and explicit-only cache policy', () => {
  for (const field of ['prompt_cache_breakpoint', 'cache_control']) {
    const original = body();
    original.input[0].content[0][field] = {mode: 'explicit', type: 'ephemeral'};
    assert.equal(addCacheAnchors(original, ctx).body, original);
  }
  const original = {...body(), prompt_cache_options: {mode: 'explicit'}};
  assert.equal(addCacheAnchors(original, ctx).body, original);
});
test('preserves existing implicit cache options and retention fields', () => {
  const original = {...body(), prompt_cache_options: {mode: 'implicit', ttl: '12h'}, prompt_cache_retention: '24h', prompt_cache_key: 'user-key'};
  const result = addCacheAnchors(original, ctx).body;
  assert.equal(result.prompt_cache_options, original.prompt_cache_options);
  assert.equal(result.prompt_cache_key, 'user-key');
  assert.equal(result.prompt_cache_retention, '24h');
});
test('uses one fixed earliest stable boundary and leaves image-only input intact', () => {
  const original = {...body(), input: Array.from({length: 8}, () => structuredClone(message))};
  const result = addCacheAnchors(original, ctx);
  assert.equal(result.added, 1);
  assert.ok(result.body.input.slice(0, 1).every(item => item.content[0].prompt_cache_breakpoint));
  assert.ok(result.body.input.slice(1).every(item => !item.content[0].prompt_cache_breakpoint));
  const imageOnly = {...body(), input: [{role: 'user', content: [message.content[1]]}]};
  assert.equal(addCacheAnchors(imageOnly, ctx).body, imageOnly);
});

test('the hook records the actual outgoing body including added cache metadata', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'magpie-cache-hook-'));
  const original = {...body(), input: [structuredClone(message), {role: 'assistant', content: 'OK'}, {role: 'user', content: 'next'}]};
  const before = structuredClone(original);
  const outgoing = await onRequest(original, {...ctx, options: {...ctx.options, dataDir}});
  assert.deepEqual(original, before);
  assert.equal(outgoing.input[0].content.length, 1);
  assert.deepEqual(outgoing.input[0].content[0].prompt_cache_breakpoint, {mode: 'explicit'});
  const day = new Date().toISOString().slice(0, 10);
  const record = JSON.parse((await readFile(join(dataDir, day + '.jsonl'), 'utf8')).trim());
  assert.equal(record.cacheAnchorsAdded, 1);
  assert.equal(record.removedImages, 1);
  assert.equal(record.requestBytesBefore, Buffer.byteLength(JSON.stringify(original)));
  assert.equal(record.requestBytesAfter, Buffer.byteLength(JSON.stringify(outgoing)));
});

test('Responses never anchors after an initial image-only block', () => {
  const original = body();
  original.input.unshift({role: 'user', content: [message.content[1]]});
  assert.equal(addCacheAnchors(original, ctx).body, original);
});
