import {test} from 'node:test';
import assert from 'node:assert/strict';
import {filterRequest} from '../filter.js';
import {addCacheAnchors} from '../cache-anchors.js';
import {measureRequest} from '../metrics.js';

const codecs = {
  chat: {key: 'messages', content: 'content', text: text => ({type: 'text', text}),
    image: name => ({type: 'image_url', image_url: {url: 'data:image/png;base64,' + name}}),
    tool: parts => ({role: 'tool', tool_call_id: 'screenshot', content: parts})},
  responses: {key: 'input', content: 'content', text: text => ({type: 'input_text', text}),
    image: name => ({type: 'input_image', image_url: 'data:image/png;base64,' + name}),
    tool: parts => ({type: 'function_call_output', call_id: 'screenshot', output: parts})},
  anthropic: {key: 'messages', content: 'content', text: text => ({type: 'text', text}),
    image: name => ({type: 'image', source: {type: 'base64', media_type: 'image/png', data: name}}),
    tool: parts => ({role: 'user', content: [{type: 'tool_result', tool_use_id: 'screenshot', content: parts}]})},
  gemini: {key: 'contents', content: 'parts', text: text => ({text}),
    image: name => ({inlineData: {mimeType: 'image/png', data: name}}),
    tool: parts => ({role: 'user', parts: [{functionResponse: {name: 'screenshot', response: {ok: true}, parts}}]})},
};

for (const [protocol, c] of Object.entries(codecs)) {
  const user = parts => ({role: 'user', [c.content]: parts});
  const assistant = parts => ({role: protocol === 'gemini' ? 'model' : 'assistant', [c.content]: parts});
  const messages = [user([c.text('stable prefix')]), c.tool([c.text('old screenshot text'), c.image('YWJj')]),
    assistant([c.image('YQ==')]), user([c.text('new ask'), c.image('Yg==')]),
    assistant([c.text('continue')]), c.tool([c.text('current screenshot text'), c.image('Yw==')])];
  const body = {[c.key]: messages, tools: [{description: 'unchanged', example: c.image('SCHEMA')}],
    metadata: {example: c.image('METADATA')}};

  test(protocol + ' - removes previous request images, keeps only the newest tool input image', () => {
    const before = structuredClone(body);
    const result = filterRequest(body, protocol);
    assert.deepEqual(body, before);
    assert.equal(result.stats.removedImages, 3);
    assert.equal(result.stats.keptCurrentImages, 1);
    assert.equal(result.stats.affectedMessages, 3);
    assert.equal(result.body[c.key][1].tool_call_id ?? result.body[c.key][1].call_id ?? 'screenshot', 'screenshot');
    assert.ok(JSON.stringify(result.body[c.key][1]).includes('old screenshot text'));
    assert.deepEqual(result.body[c.key].slice(4), messages.slice(4));
    assert.deepEqual(result.body[c.key][3][c.content], [c.text('new ask')]);
    assert.equal(result.body.tools, body.tools);
    assert.equal(result.body.metadata, body.metadata);
    assert.deepEqual(filterRequest(result.body, protocol).body, result.body);
    const metrics = measureRequest(body, result, {protocol});
    assert.equal(metrics.removedDetails.length, 3);
    assert.ok(metrics.removedDetails.every(image => image.path.length > 0));
    assert.equal(metrics.imageJsonBytesAfter, Buffer.byteLength(JSON.stringify(c.image('Yw=='))));
    assert.equal(metrics.removedEmbeddedBytesKnown, 5);
  });

  test(protocol + ' - no new attachment removes previous round screenshots too', () => {
    const request = {...body, [c.key]: [...messages, assistant([c.text('done')]), user([c.text('no new image')])]};
    const result = filterRequest(request, protocol);
    assert.equal(result.stats.removedImages, 4);
    assert.equal(result.stats.keptCurrentImages, 0);
    assert.ok(!JSON.stringify(result.body[c.key]).includes('base64,'));
    assert.ok(JSON.stringify(result.body[c.key]).includes('current screenshot text'));
  });

  test(protocol + ' - image-only historical tool output stays paired and nonempty', () => {
    const request = {[c.key]: [user([c.text('old ask')]), c.tool([c.image('YWJj')]), assistant([c.text('done')]), user([c.text('next')])]};
    const result = filterRequest(request, protocol);
    assert.equal(result.stats.removedImages, 1);
    assert.equal(result.stats.placeholderMessages, 1);
    assert.ok(JSON.stringify(result.body[c.key][1]).includes('[Historical image omitted]'));
    assert.equal(result.body[c.key].length, 4);
  });

  test(protocol + ' - stable already-filtered prefix survives the next screenshot turn', () => {
    const first = filterRequest(body, protocol).body;
    const next = filterRequest({...body, [c.key]: [...messages, assistant([c.text('done')]), user([c.text('next')]), c.tool([c.image('ZA==')])]}, protocol).body;
    assert.deepEqual(next[c.key].slice(0, 3), first[c.key].slice(0, 3));
    assert.equal(next.tools, first.tools);
  });

  test(protocol + ' - embedded JSON text and tool arguments never get rewritten', () => {
    const argumentsText = JSON.stringify({content: [c.image('ARGUMENT')]});
    const request = {[c.key]: [user([c.text('old')]), assistant([c.text(argumentsText)]),
      {role: 'tool', content: argumentsText, arguments: {content: [c.image('ARGUMENT')]}}, user([c.text('now')])]};
    assert.equal(filterRequest(request, protocol).body, request);
  });

  test(protocol + ' - previous assistant image is removed even within the same user task', () => {
    const request = {[c.key]: [user([c.text('ask')]), assistant([c.image('YWJj')]), c.tool([c.image('YQ==')])]};
    const result = filterRequest(request, protocol);
    assert.equal(result.stats.removedImages, 1);
    assert.equal(result.stats.keptCurrentImages, 1);
    assert.deepEqual(result.body[c.key].at(-1), request[c.key].at(-1));
    const later = filterRequest({[c.key]: [...request[c.key], user([c.text('next')])]}, protocol);
    assert.equal(later.stats.removedImages, 2);
    assert.equal(later.stats.keptCurrentImages, 0);
  });

  test(protocol + ' - no new input after the latest assistant output removes all older images', () => {
    const request = {[c.key]: [c.tool([c.image('YWJj')]), assistant([c.image('YQ==')])]};
    const result = filterRequest(request, protocol);
    assert.equal(result.stats.removedImages, 2);
    assert.equal(result.stats.keptCurrentImages, 0);
  });
}

test('Gemini - newest functionResponse screenshot replaces the previous user image', () => {
  const c = codecs.gemini;
  const body = {contents: [{role: 'user', parts: [c.text('ask'), c.image('YWJj')]},
    {role: 'model', parts: [{functionCall: {name: 'screenshot', args: {}}}]},
    {role: 'user', parts: [{functionResponse: {name: 'screenshot', response: {ok: true}}}, c.image('YQ==')]}]};
  const result = filterRequest(body, 'gemini');
  assert.equal(result.stats.removedImages, 1);
  assert.equal(result.stats.keptCurrentImages, 1);
  assert.deepEqual(result.body.contents[2], body.contents[2]);
});

test('Gemini - nested snake-case tool screenshot removed without deleting audio or file results', () => {
  const audio = {inline_data: {mime_type: 'audio/wav', data: 'YQ=='}};
  const image = {file_data: {mime_type: 'IMAGE/PNG', file_uri: 'https://example.invalid/old'}};
  const body = {contents: [{role: 'user', parts: [{text: 'old'}]},
    {role: 'user', parts: [{function_response: {name: 'screen', response: {content: [audio, image]}}}]},
    {role: 'model', parts: [{text: 'done'}]}, {role: 'user', parts: [{text: 'next'}]}]};
  const result = filterRequest(body, 'gemini');
  assert.equal(result.stats.removedImages, 1);
  assert.deepEqual(result.body.contents[1].parts[0].function_response.response.content, [audio, {text: '[Historical image omitted]'}]);
});

for (const protocol of ['responses', 'anthropic']) {
  const c = codecs[protocol];
  const model = 'test/model';
  const ctx = {protocol, model, options: {cacheAnchors: {[protocol]: [model]}}};
  const initial = {model, [c.key]: [{role: 'user', content: [c.text('fixed long text prefix')]}, c.tool([c.image('YWJj')])]};
  test(protocol + ' - fixed anchor before the first TOOL image stays put across turns', () => {
    const warm = addCacheAnchors(initial, ctx);
    assert.equal(warm.added, 1);
    const later = {...initial, [c.key]: [...initial[c.key], {role: 'assistant', content: 'done'}, {role: 'user', content: [c.text('next')]}, c.tool([c.image('YQ==')])]};
    const prepared = addCacheAnchors(later, ctx);
    const outgoing = filterRequest(prepared.body, protocol).body;
    assert.equal(prepared.added, 1);
    assert.deepEqual(outgoing[c.key][0], warm.body[c.key][0]);
    assert.equal(filterRequest(prepared.body, protocol).stats.removedImages, 1);
  });

  test(protocol + ' - cache-marked historical image becomes marked TEXT, no marker loss', () => {
    const mark = protocol === 'anthropic' ? {cache_control: {type: 'ephemeral'}} : {prompt_cache_breakpoint: {mode: 'explicit'}};
    const image = {...c.image('YWJj'), ...mark};
    const request = {[c.key]: [{role: 'user', content: [image]}, {role: 'assistant', content: 'done'}, {role: 'user', content: [c.text('next')]}]};
    const result = filterRequest(request, protocol);
    assert.deepEqual(result.body[c.key][0].content[0], {...c.text('[Historical image omitted]'), ...mark});
    assert.equal(result.stats.removedImages, 1);
    assert.equal(addCacheAnchors(request, ctx).added, 0);
  });
}

test('Responses - tool text anchor survives screenshot removal at exactly the same output path', () => {
  const model = 'test/model';
  const ctx = {protocol: 'responses', model, options: {cacheAnchors: {responses: [model]}}};
  const c = codecs.responses;
  const request = {model, input: [{role: 'user', content: [c.text('prefix')]},
    c.tool([c.text('captured screenshot'), c.image('YWJj')])]};
  const prepared = addCacheAnchors(request, ctx);
  assert.equal(prepared.added, 1);
  assert.deepEqual(prepared.body.input[1].output[0].prompt_cache_breakpoint, {mode: 'explicit'});
  assert.equal(prepared.body.input[0], request.input[0]);
  const next = {...request, input: [...request.input, {role: 'assistant', content: 'done'}, {role: 'user', content: [c.text('next')]}, c.tool([c.text('next screenshot'), c.image('YQ==')])]};
  const output = filterRequest(addCacheAnchors(next, ctx).body, 'responses').body;
  assert.deepEqual(output.input[1].output[0], prepared.body.input[1].output[0]);
  assert.equal(output.input[1].output.length, 2);
  assert.deepEqual(output.input[1].output[1], c.text('[Historical image omitted]'));
  assert.deepEqual(addCacheAnchors(prepared.body, ctx), {body: prepared.body, added: 0});
});
