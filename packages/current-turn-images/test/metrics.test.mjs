import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {filterRequest} from '../filter.js';
import {measureRequest} from '../metrics.js';
import {onRequest} from '../request.hooks.js';

const image = value => ({type: 'image_url', image_url: {url: 'data:image/png;base64,' + value}});
const user = content => ({role: 'user', content});
const assistant = {role: 'assistant', content: 'OK'};
const text = value => ({type: 'text', text: value});

const fixtures = JSON.parse(await readFile(new URL('./cases.json', import.meta.url), 'utf8'));
for (const protocol of ['chat', 'responses', 'anthropic', 'gemini']) {
  test(protocol + ' - async measurement preserves cached content and legacy output', async () => {
    const fixture = structuredClone(fixtures.find(row => row.name === protocol + ' - historical image removed and current images retained'));
    const key = protocol === 'responses' ? 'input' : protocol === 'gemini' ? 'contents' : 'messages';
    const content = protocol === 'gemini' ? 'parts' : 'content';
    for (const body of [fixture.request, fixture.expected]) {
      body.prompt_cache_key = 'unchanged-cache-key';
      body.prompt_cache_retention = '24h';
      body[key][0][content][0].cache_control = {type: 'ephemeral'};
      body.tools = [{name: 'unchanged-tool', input_schema: {type: 'object'}}];
      body.tool_choice = 'auto';
    }
    const original = structuredClone(fixture.request);
    const dataDir = await mkdtemp(join(tmpdir(), 'magpie-cache-fields-'));
    const result = await onRequest(fixture.request, {protocol, options: {dataDir}});
    assert.deepEqual(result, fixture.expected);
    assert.deepEqual(fixture.request, original);
    assert.equal(result[key][0][content][0], fixture.request[key][0][content][0]);
  });
}

test('UTF-8 JSON and individual image sizes match independent Buffer measurements', () => {
  const oldImage = image('YWJjZA==');
  const newImage = image('YWJj');
  const body = {model: 'test', messages: [user([text('中文😀'), oldImage]), assistant, user([newImage])]};
  const result = filterRequest(body, 'chat');
  const metrics = measureRequest(body, result, {protocol: 'chat'});
  const size = object => Buffer.byteLength(JSON.stringify(object), 'utf8');
  assert.equal(metrics.requestBytesBefore, size(body));
  assert.equal(metrics.requestBytesAfter, size(result.body));
  assert.equal(metrics.savedBytes, size(body) - size(result.body));
  assert.equal(metrics.removedImageJsonBytes, size(oldImage));
  assert.equal(metrics.imageJsonBytesBefore, size(oldImage) + size(newImage));
  assert.equal(metrics.imageJsonBytesAfter, size(newImage));
  assert.equal(metrics.removedDetails[0].embeddedBytes, 4);
  assert.equal(metrics.removedEmbeddedBytesKnown, 4);
});

test('URL image file sizes remain unknown', () => {
  const body = {messages: [user([{type: 'image_url', image_url: {url: 'https://example.invalid/image'}}]), assistant, user('next')]};
  const metrics = measureRequest(body, filterRequest(body, 'chat'), {protocol: 'chat'});
  assert.equal(metrics.removedUnknownFileSizes, 1);
  assert.equal(metrics.removedDetails[0].embeddedBytes, null);
});

test('pure-image placeholders are included in the post-filter request size', () => {
  const body = {messages: [user([image('YWJjZA==')]), assistant, user('next')]};
  const metrics = measureRequest(body, filterRequest(body, 'chat'), {protocol: 'chat'});
  assert.ok(metrics.savedBytes < metrics.removedImageJsonBytes);
  assert.equal(metrics.placeholderMessages, 1);
});

test('cache fields, tools, request parameters and content before the removed image remain equal', () => {
  const body = {model: 'test', prompt_cache_key: 'stable', prompt_cache_retention: '24h', temperature: 0.5,
    tools: [{type: 'function', function: {name: 'lookup', parameters: {type: 'object'}}}], tool_choice: 'auto',
    messages: [{role: 'system', content: [{...text('stable system'), cache_control: {type: 'ephemeral'}}]},
      user([{...text('long cached prefix'), cache_control: {type: 'ephemeral'}}, image('YWJjZA=='), text('following text')]), assistant, user('next')]};
  const original = structuredClone(body);
  const result = filterRequest(body, 'chat').body;
  assert.deepEqual(body, original);
  assert.deepEqual(result, {...body, messages: [body.messages[0], user([body.messages[1].content[0], body.messages[1].content[2]]), assistant, body.messages[3]]});
  assert.equal(result.messages[0], body.messages[0]);
  assert.equal(result.messages[1].content[0], body.messages[1].content[0]);
});

test('adjacent outgoing rounds keep the previously cleaned prefix identical', () => {
  const older = [user([text('prefix'), image('YWJjZA==')]), assistant];
  const roundOne = {messages: [...older, user([text('first image'), image('YWJj')])]};
  const roundTwo = {messages: [...roundOne.messages, assistant, user([text('second image'), image('YQ==')])]};
  const first = filterRequest(roundOne, 'chat').body;
  const second = filterRequest(roundTwo, 'chat').body;
  assert.deepEqual(second.messages.slice(0, older.length), first.messages.slice(0, older.length));
  assert.deepEqual(second.messages[2].content, [roundOne.messages[2].content[0]]);
  assert.deepEqual(second.messages[4], roundTwo.messages[4]);
});

test('concurrent request records are durable and the observer preserves request fields', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'magpie-images-test-'));
  const originals = Array.from({length: 80}, (_, index) => ({model: 'test', prompt_cache_key: 'key-' + index, messages: [user('unchanged ' + index)]}));
  const before = structuredClone(originals);
  const outputs = await Promise.all(originals.map(body => onRequest(body, {protocol: 'chat', options: {dataDir}})));
  assert.deepEqual(outputs, Array(80).fill(undefined));
  assert.deepEqual(originals, before);
  const day = new Date().toISOString().slice(0, 10);
  const rows = (await readFile(join(dataDir, day + '.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, 80);
  assert.equal(new Set(rows.map(row => row.id)).size, 80);
  assert.ok(rows.every(row => row.requestBytesBefore === row.requestBytesAfter));
  assert.ok(rows.every(row => !JSON.stringify(row).includes('unchanged ')));
});

test('record failure still preserves the existing filtering result', async t => {
  t.mock.method(console, 'error', () => {});
  const body = {messages: [user([image('YWJjZA==')]), assistant, user('next')]};
  const result = await onRequest(body, {protocol: 'chat', options: {dataDir: new URL('../package.json', import.meta.url).pathname}});
  assert.deepEqual(result, filterRequest(body, 'chat').body);
});
