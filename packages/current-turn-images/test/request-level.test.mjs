import {test} from 'node:test';
import assert from 'node:assert/strict';
import {filterRequest} from '../filter.js';
import {addCacheAnchors} from '../cache-anchors.js';
import {measureRequest} from '../metrics.js';

const formats = {
  chat: {key: 'messages', text: text => ({type: 'text', text}),
    image: data => ({type: 'image_url', image_url: {url: 'data:image/png;base64,' + data}}),
    user: content => ({role: 'user', content}),
    call: id => ({role: 'assistant', tool_calls: [{id, type: 'function', function: {name: 'screen', arguments: '{}'}}]}),
    tool: (id, content) => ({role: 'tool', tool_call_id: id, content})},
  responses: {key: 'input', text: text => ({type: 'input_text', text}),
    image: data => ({type: 'input_image', image_url: 'data:image/png;base64,' + data}),
    user: content => ({role: 'user', content}),
    call: id => ({type: 'function_call', call_id: id, name: 'screen', arguments: '{}'}),
    tool: (id, output) => ({type: 'function_call_output', call_id: id, output})},
  anthropic: {key: 'messages', text: text => ({type: 'text', text}),
    image: data => ({type: 'image', source: {type: 'base64', media_type: 'image/png', data}}),
    user: content => ({role: 'user', content}),
    call: id => ({role: 'assistant', content: [{type: 'tool_use', id, name: 'screen', input: {}}]}),
    tool: (id, content) => ({role: 'user', content: [{type: 'tool_result', tool_use_id: id, content}]})},
  gemini: {key: 'contents', text: text => ({text}),
    image: data => ({inlineData: {mimeType: 'image/png', data}}),
    user: parts => ({role: 'user', parts}),
    call: id => ({role: 'model', parts: [{functionCall: {id, name: 'screen', args: {}}}]}),
    tool: (id, parts) => ({role: 'user', parts: [{functionResponse: {id, name: 'screen', response: {ok: true}, parts}}]})},
};

for (const [protocol, f] of Object.entries(formats)) {
  const A = f.image('YQ=='), B = f.image('Yg=='), C = f.image('Yw==');
  const first = [f.user([f.text('One user task. Inspect this image, then use tools as needed.'), A])];
  const second = [...first, f.call('call_B'), f.tool('call_B', [f.text('screenshot B'), B])];
  const third = [...second, f.call('call_C'), f.tool('call_C', [f.text('screenshot C'), C])];
  const fourth = [...third, f.call('call_text'), f.tool('call_text', [f.text('No new image. Continue the same task.')])];

  test(protocol + ' - A -> B -> C -> text within ONE user task keeps only each new request image', () => {
    for (const [messages, removed, kept] of [[first, 0, 1], [second, 1, 1], [third, 2, 1], [fourth, 3, 0]]) {
      const original = {[f.key]: structuredClone(messages), tools: [{name: 'unchanged'}]};
      const before = structuredClone(original);
      const result = filterRequest(original, protocol);
      assert.equal(result.stats.removedImages, removed);
      assert.equal(result.stats.keptCurrentImages, kept);
      assert.deepEqual(original, before);
      assert.deepEqual(result.body[f.key].at(-1), messages.at(-1));
      assert.equal(result.body.tools, original.tools);
    }
  });

  test(protocol + ' - multiple tool results newly supplied together keep ALL their images', () => {
    const messages = [...first, f.call('call_B'), f.call('call_C'),
      f.tool('call_B', [B]), f.tool('call_C', [C])];
    const result = filterRequest({[f.key]: messages}, protocol);
    assert.equal(result.stats.removedImages, 1);
    assert.equal(result.stats.keptCurrentImages, 2);
    assert.deepEqual(result.body[f.key].slice(-2), messages.slice(-2));
  });

  test(protocol + ' - byte-identical newly captured image is retained, not deduplicated by content', () => {
    const messages = [...first, f.call('same_image'), f.tool('same_image', [structuredClone(A)])];
    const result = filterRequest({[f.key]: messages}, protocol);
    assert.equal(result.stats.removedImages, 1);
    assert.equal(result.stats.keptCurrentImages, 1);
    assert.deepEqual(result.body[f.key].at(-1), messages.at(-1));
  });

  test(protocol + ' - retry of unchanged request preserves current image and filtering is idempotent', () => {
    const request = {[f.key]: second};
    const one = filterRequest(request, protocol);
    const retry = filterRequest(request, protocol);
    assert.deepEqual(retry.body, one.body);
    assert.equal(retry.stats.keptCurrentImages, 1);
    assert.deepEqual(filterRequest(one.body, protocol).body, one.body);
  });

  test(protocol + ' - previous model answer followed by text-only input removes screenshots', () => {
    const answer = protocol === 'gemini' ? {role: 'model', parts: [f.text('answer')]} : {role: 'assistant', content: [f.text('answer')]};
    const result = filterRequest({[f.key]: [...second, answer, f.user([f.text('Continue; no new attachment.')])]}, protocol);
    assert.equal(result.stats.removedImages, 2);
    assert.equal(result.stats.keptCurrentImages, 0);
  });

  test(protocol + ' - previously filtered prefix and original tool call metadata stay stable', () => {
    const two = filterRequest({[f.key]: second}, protocol).body[f.key];
    const three = filterRequest({[f.key]: third}, protocol).body[f.key];
    assert.deepEqual(three.slice(0, 2), two.slice(0, 2));
    assert.deepEqual(three[1], second[1]);
    assert.deepEqual(three[3], third[3]);
    assert.ok(JSON.stringify(three[2]).includes('screenshot B'));
    assert.ok(JSON.stringify(three[2]).includes('[Historical image omitted]'));
  });

  if (protocol === 'responses' || protocol === 'anthropic') {
    test(protocol + ' - request-level image removal preserves the same cache anchor and policy', () => {
      const model = 'test/model';
      const ctx = {protocol, model, options: {cacheAnchors: {[protocol]: [model]}}};
      const warm = addCacheAnchors({model, [f.key]: first}, ctx);
      const next = addCacheAnchors({model, [f.key]: second}, ctx);
      assert.equal(warm.added, 1);
      assert.equal(next.added, 1);
      const filtered = filterRequest(next.body, protocol);
      assert.deepEqual(filtered.body[f.key][0].content[0], warm.body[f.key][0].content[0]);
      assert.equal(filtered.stats.removedImages, 1);
      assert.equal(filtered.stats.keptCurrentImages, 1);
    });
  }
}

test('Responses - reasoning and custom tool call delimit the newest inference input', () => {
  const body = {input: [{role: 'user', content: [{type: 'input_image', image_url: 'old'}]},
    {type: 'reasoning', id: 'rs', summary: []}, {type: 'custom_tool_call', call_id: 'c', name: 'screen', input: 'noop'},
    {type: 'custom_tool_call_output', call_id: 'c', output: [{type: 'input_image', image_url: 'new'}]}]};
  const result = filterRequest(body, 'responses');
  assert.equal(result.stats.removedImages, 1);
  assert.equal(result.stats.keptCurrentImages, 1);
  assert.deepEqual(result.body.input.slice(1), body.input.slice(1));
});

test('request-level records identify the new policy without rewriting legacy records', () => {
  const body = {input: [{role: 'user', content: [{type: 'input_image', image_url: 'old'}]},
    {type: 'function_call', call_id: 'c', name: 'screen', arguments: '{}'},
    {type: 'function_call_output', call_id: 'c', output: [{type: 'input_image', image_url: 'new'}]}]};
  const measured = measureRequest(body, filterRequest(body, 'responses'), {protocol: 'responses'});
  assert.equal(measured.schemaVersion, 5);
  assert.equal(measured.imagePolicy, 'latest-request-input');
  assert.equal(measured.currentInputStart, 2);
  assert.equal(measured.removedImages, 1);
  assert.equal(measured.keptCurrentImages, 1);
});
