import {test} from 'node:test';
import assert from 'node:assert/strict';
import {addCacheAnchors} from '../cache-anchors.js';
import {filterRequest} from '../filter.js';
import {onRequest} from '../request.hooks.js';
import {mkdtemp, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const ctx = {protocol: 'anthropic', model: 'any/claude-opus-5-5', options: {cacheAnchors: {anthropic: ['any/claude-opus-5-5']}}};
const image = {type: 'image', source: {type: 'base64', media_type: 'image/png', data: 'YQ=='}, cache_control: {type: 'ephemeral'}};
const body = () => ({model: ctx.model,
  system: [{type: 'text', text: 'system', cache_control: {type: 'ephemeral'}}],
  tools: [{name: 'lookup', input_schema: {type: 'object'}, cache_control: {type: 'ephemeral'}}],
  messages: [{role: 'user', content: [{type: 'text', text: 'stable prefix'}, structuredClone(image)]}],
});

test('Anthropic adds a fourth stable text checkpoint and preserves all client markers and input', () => {
  const original = body();
  const before = structuredClone(original);
  const result = addCacheAnchors(original, ctx);
  assert.deepEqual(original, before);
  assert.equal(result.added, 1);
  const restored = structuredClone(result.body);
  delete restored.messages[0].content[0].cache_control;
  assert.deepEqual(restored, before);
  assert.deepEqual(result.body.messages[0].content[0].cache_control, {type: 'ephemeral'});
});

test('Anthropic text checkpoint stays fixed across consecutive image rounds', () => {
  const first = addCacheAnchors(body(), ctx).body;
  for (let round = 2; round <= 4; round++) {
    const original = body();
    for (let n = 1; n < round; n++) {
      delete original.messages.at(-1).content.at(-1).cache_control;
      original.messages.push({role: 'assistant', content: 'OK'}, {role: 'user', content: [
        {type: 'text', text: 'next'}, structuredClone(image),
      ]});
    }
    const prepared = addCacheAnchors(original, ctx);
    const filtered = filterRequest(prepared.body, 'anthropic').body;
    assert.equal(prepared.added, 1);
    assert.deepEqual(filtered.messages[0].content[0], first.messages[0].content[0]);
  }
});

test('Anthropic full checkpoint budget and an already marked target remain unchanged', () => {
  const original = body();
  original.messages[0].content[0].cache_control = {type: 'ephemeral'};
  assert.equal(addCacheAnchors(original, ctx).body, original);
  delete original.messages[0].content[0].cache_control;
  original.tools.push({...original.tools[0], name: 'another'});
  assert.equal(addCacheAnchors(original, ctx).body, original);
});

test('Anthropic leaves long TTL and mixed TTL policies unchanged', () => {
  const original = body();
  original.messages[0].content[1].cache_control.ttl = '1h';
  assert.equal(addCacheAnchors(original, ctx).body, original);
  assert.equal(original.messages[0].content[0].cache_control, undefined);
});

test('Anthropic unknown cache policies, absent text, and unknown models are not modified', () => {
  const original = body();
  original.system[0].cache_control = {type: 'future-policy'};
  assert.equal(addCacheAnchors(original, ctx).body, original);
  original.system[0].cache_control = {type: 'ephemeral', scope: 'future-scope'};
  assert.equal(addCacheAnchors(original, ctx).body, original);
  const imageOnly = {...body(), messages: [{role: 'user', content: [structuredClone(image)]}]};
  assert.equal(addCacheAnchors(imageOnly, ctx).body, imageOnly);
  assert.equal(addCacheAnchors(body(), {...ctx, model: 'unknown'}).added, 0);
  assert.equal(addCacheAnchors(body(), {...ctx, options: {}}).added, 0);
});

test('Anthropic never marks later text when the earliest image has no preceding text', () => {
  const original = body();
  original.messages.unshift({role: 'user', content: [structuredClone(image)]});
  assert.equal(addCacheAnchors(original, ctx).body, original);
});

test('Anthropic accepts explicit 5m TTL and is idempotent', () => {
  const original = body();
  original.system[0].cache_control.ttl = '5m';
  const result = addCacheAnchors(original, ctx);
  assert.equal(result.added, 1);
  assert.equal(addCacheAnchors(result.body, ctx).body, result.body);
});

test('Anthropic anchors the DSH padding block, not the moving last-user marker', () => {
  const original = body();
  delete original.messages[0].content[1].cache_control;
  original.messages[0].content.unshift({type: 'text', text: 'DSH context'});
  original.messages.push({role: 'user', content: [{type: 'text', text: 'runtime metadata', cache_control: {type: 'ephemeral'}}]});
  const result = addCacheAnchors(original, ctx);
  assert.equal(result.added, 1);
  assert.equal(result.body.messages[0].content[0].cache_control, undefined);
  assert.deepEqual(result.body.messages[0].content[1].cache_control, {type: 'ephemeral'});
  assert.deepEqual(result.body.messages.at(-1), original.messages.at(-1));
});

test('Anthropic hook records the filtered outgoing body and stable checkpoint', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'magpie-anthropic-hook-'));
  const original = body();
  delete original.messages[0].content[1].cache_control;
  const currentImage = structuredClone(image);
  delete currentImage.cache_control;
  original.messages.push({role: 'assistant', content: 'RED'}, {role: 'user', content: [
    {type: 'text', text: 'next', cache_control: {type: 'ephemeral'}},
    currentImage,
  ]});
  const before = structuredClone(original);
  const outgoing = await onRequest(original, {...ctx, options: {...ctx.options, dataDir}});
  assert.deepEqual(original, before);
  assert.equal(outgoing.messages[0].content.length, 1);
  assert.deepEqual(outgoing.messages[0].content[0].cache_control, {type: 'ephemeral'});
  assert.deepEqual(outgoing.messages[2], before.messages[2]);
  const day = new Date().toISOString().slice(0, 10);
  const record = JSON.parse((await readFile(join(dataDir, day + '.jsonl'), 'utf8')).trim());
  assert.equal(record.cacheAnchorsAdded, 1);
  assert.equal(record.removedImages, 1);
  assert.equal(record.keptCurrentImages, 1);
  assert.equal(record.requestBytesBefore, Buffer.byteLength(JSON.stringify(original)));
  assert.equal(record.requestBytesAfter, Buffer.byteLength(JSON.stringify(outgoing)));
});
