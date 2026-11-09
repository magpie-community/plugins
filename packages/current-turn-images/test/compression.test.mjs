import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, mkdtemp, unlink, rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {deflateSync} from 'node:zlib';
import {compressRequest} from '../compression.js';
import {inspectImage, sameImageProperties} from '../image-formats.js';
import {onRequest} from '../request.hooks.js';

const native = process.platform === 'win32' && process.arch === 'x64';
const images = [];
for (const [extension, mime] of [['png', 'image/png'], ['jpg', 'image/jpeg'], ['gif', 'image/gif'], ['webp', 'image/webp']]) {
  images.push({extension, mime, data: await readFile(new URL('./compression-fixtures/large.' + extension, import.meta.url))});
}
const formats = {
  chat: {key: 'messages', part: (mime, data) => ({type: 'image_url', image_url: {url: `data:${mime};base64,${data}`}, detail: 'high'}),
    user: part => ({role: 'user', content: [part]}), encoded: part => part.image_url.url.split(',')[1]},
  responses: {key: 'input', part: (mime, data) => ({type: 'input_image', image_url: `data:${mime};base64,${data}`, detail: 'high'}),
    user: part => ({role: 'user', content: [part]}), encoded: part => part.image_url.split(',')[1]},
  anthropic: {key: 'messages', part: (mime, data) => ({type: 'image', source: {type: 'base64', media_type: mime, data}}),
    user: part => ({role: 'user', content: [part]}), encoded: part => part.source.data},
  gemini: {key: 'contents', part: (mime, data) => ({inlineData: {mimeType: mime, data}}),
    user: part => ({role: 'user', parts: [part]}), encoded: part => part.inlineData.data},
};

for (const [protocol, f] of Object.entries(formats)) for (const image of images) {
  test(protocol + ' - real lossless ' + image.extension + ' optimization preserves metadata and all request fields', {skip: !native}, async () => {
    const part = {...f.part(image.mime, image.data.toString('base64')), cache_control: {type: 'ephemeral'}};
    const body = {model: 'test/model', [f.key]: [f.user(part)], tools: [{name: 'unchanged'}], prompt_cache_key: 'unchanged'};
    const before = structuredClone(body);
    const result = await compressRequest(body, protocol, {maxMilliseconds: 6000, toolMilliseconds: 3000});
    assert.equal(result.compressedImages, 1, JSON.stringify(result.details));
    assert.ok(result.savedFileBytes > 0 && result.savedRequestBytes > 0);
    assert.deepEqual(body, before);
    assert.equal(result.body.tools, body.tools);
    assert.equal(result.body.prompt_cache_key, body.prompt_cache_key);
    const outputPart = result.body[f.key][0][protocol === 'gemini' ? 'parts' : 'content'][0];
    assert.deepEqual(outputPart.cache_control, part.cache_control);
    const output = Buffer.from(f.encoded(outputPart), 'base64');
    assert.ok(output.length < image.data.length);
    assert.ok(sameImageProperties(inspectImage(image.data), inspectImage(output)));
    if (process.env.PIXEL_EVIDENCE_DIR) {
      await mkdir(process.env.PIXEL_EVIDENCE_DIR, {recursive: true});
      await writeFile(join(process.env.PIXEL_EVIDENCE_DIR, protocol + '.' + image.extension), output);
    }
  });
}

test('compression can be explicitly disabled', async () => {
  const body = {messages: [{role: 'user', content: [formats.chat.part('image/png', images[0].data.toString('base64'))]}]};
  const result = await compressRequest(body, 'chat', {enabled: false});
  assert.equal(result.body, body);
  assert.equal(result.details[0].reason, 'disabled');
});

test('every retained image is inspected, including URLs and unsupported formats', async () => {
  const body = {input: [{role: 'user', content: [
    {type: 'input_image', image_url: 'https://example.invalid/remote.png'},
    {type: 'input_image', file_id: 'file_reference'},
    {type: 'input_image', image_url: 'data:image/bmp;base64,' + Buffer.from('BM1234').toString('base64')},
    {type: 'input_image', image_url: 'data:image/png;base64,%%invalid%%'},
  ]}]};
  const result = await compressRequest(body, 'responses');
  assert.equal(result.body, body);
  assert.equal(result.details.length, 4);
  assert.deepEqual(result.details.map(d => d.reason), ['external_reference', 'external_reference', 'unsupported_format', 'invalid_base64']);
});

test('raw image and encoded input limits keep original data', async () => {
  const body = {messages: [{role: 'user', content: [formats.chat.part('image/png', images[0].data.toString('base64'))]}]};
  const input = await compressRequest(body, 'chat', {maxInputBytes: 1024});
  assert.equal(input.body, body); assert.equal(input.details[0].reason, 'input_limit');
  const raw = await compressRequest(body, 'chat', {maxRawBytes: 1024});
  assert.equal(raw.body, body); assert.equal(raw.details[0].reason, 'raw_limit');
});

test('malformed image data and unsupported animations are not repaired or flattened', async () => {
  const png = images[0].data.subarray(0, 20);
  const body = {messages: [{role: 'user', content: [formats.chat.part('image/png', png.toString('base64'))]}]};
  const result = await compressRequest(body, 'chat');
  assert.equal(result.body, body); assert.equal(result.details[0].reason, 'invalid_image');
});

test('aborted processing keeps original images', async () => {
  const controller = new AbortController(); controller.abort();
  const body = {messages: [{role: 'user', content: [formats.chat.part('image/png', images[0].data.toString('base64'))]}]};
  const result = await compressRequest(body, 'chat', undefined, controller.signal);
  assert.equal(result.body, body); assert.equal(result.details[0].reason, 'aborted');
});

test('PNG color profile and all non-image chunks stay byte-identical', {skip: !native}, async () => {
  const data = images[0].data;
  const body = {messages: [{role: 'user', content: [formats.chat.part('image/png', data.toString('base64'))]}]};
  const result = await compressRequest(body, 'chat', {maxMilliseconds: 6000, toolMilliseconds: 3000});
  const output = Buffer.from(formats.chat.encoded(result.body.messages[0].content[0]), 'base64');
  assert.deepEqual(inspectImage(output).chunks.filter(c => c.type !== 'IDAT').map(c => c.raw), inspectImage(data).chunks.filter(c => c.type !== 'IDAT').map(c => c.raw));
});

test('retries of the same image produce exactly the same optimized bytes', {skip: !native}, async () => {
  const body = {messages: [{role: 'user', content: [formats.chat.part('image/png', images[0].data.toString('base64'))]}]};
  const options = {maxMilliseconds: 6000, toolMilliseconds: 3000};
  const one = await compressRequest(body, 'chat', options), two = await compressRequest(body, 'chat', options);
  assert.deepEqual(one.body, two.body);
  const again = await compressRequest(one.body, 'chat', options);
  assert.equal(again.body, one.body, 'already-optimized data never grows');
  assert.equal(again.details[0].reason, 'not_smaller');
});

test('HTTP hook compresses only current images and records exact final byte sizes', {skip: !native}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'magpie-compression-metrics-'));
  const image = formats.responses.part('image/png', images[0].data.toString('base64'));
  const text = {type: 'input_text', text: 'Fixed text prefix'};
  const body = {model: 'test/model', input: [{role: 'user', content: [text, image]},
    {type: 'function_call', call_id: 'c', name: 'screen', arguments: '{}'},
    {type: 'function_call_output', call_id: 'c', output: [{type: 'input_text', text: 'New screenshot'}, image]}]};
  const before = structuredClone(body);
  const result = await onRequest(body, {protocol: 'responses', model: body.model, options: {
    dataDir, cacheAnchors: {responses: [body.model]}, imageCompression: {maxMilliseconds: 6000, toolMilliseconds: 3000}}});
  assert.deepEqual(body, before);
  assert.equal(result.input[0].content.length, 1);
  assert.deepEqual(result.input[0].content[0].prompt_cache_breakpoint, {mode: 'explicit'});
  const rows = (await readFile(join(dataDir, new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.schemaVersion, 5); assert.equal(row.removedImages, 1); assert.equal(row.keptCurrentImages, 1);
  assert.equal(row.compressedImages, 1); assert.equal(row.compressionDetails.length, 1);
  assert.equal(row.requestBytesBefore, Buffer.byteLength(JSON.stringify(body)));
  assert.equal(row.requestBytesAfter, Buffer.byteLength(JSON.stringify(result)));
  assert.equal(row.imageJsonBytesAfter, Buffer.byteLength(JSON.stringify(result.input[2].output[1])));
  assert.ok(row.compressionSavedRequestBytes > 0);
});

test('concurrent requests have bounded native work and safely keep busy images', {skip: !native}, async () => {
  const body = {messages: [{role: 'user', content: [formats.chat.part('image/png', images[0].data.toString('base64'))]}]};
  const results = await Promise.all(Array.from({length: 6}, () => compressRequest(body, 'chat', {maxMilliseconds: 6000, toolMilliseconds: 3000})));
  assert.ok(results.some(r => r.details[0].reason === 'busy'));
  assert.ok(results.every(r => r.compressedImages === 1 || r.body === body));
});

for (const extension of ['png', 'webp']) {
  test('animated ' + extension + ' retains every frame and timing without flattening', {skip: !native}, async () => {
    const input = await readFile(new URL('./compression-fixtures/animated.' + extension, import.meta.url));
    const body = {messages: [{role: 'user', content: [formats.chat.part('image/' + extension, input.toString('base64'))]}]};
    const result = await compressRequest(body, 'chat', {maxMilliseconds: 6000, toolMilliseconds: 3000});
    assert.ok(result.compressedImages === 1 || result.details[0].reason === 'not_smaller', JSON.stringify(result.details));
    const output = Buffer.from(formats.chat.encoded(result.body.messages[0].content[0]), 'base64');
    assert.ok(sameImageProperties(inspectImage(input), inspectImage(output)));
    if (process.env.PIXEL_EVIDENCE_DIR) await writeFile(join(process.env.PIXEL_EVIDENCE_DIR, 'animated.' + extension), output);
  });
}

test('all four formats in one newest request are optimized, including nested tool results', {skip: !native}, async () => {
  const body = {messages: [{role: 'user', content: [{type: 'tool_result', tool_use_id: 'c', content: images.map(image => ({type: 'image', source: {
    type: 'base64', media_type: image.mime, data: image.data.toString('base64')}}))}]}]};
  const result = await compressRequest(body, 'anthropic', {maxMilliseconds: 6000, toolMilliseconds: 3000});
  assert.equal(result.compressedImages, 4);
  assert.equal(result.details.length, 4);
  assert.equal(result.body.messages[0].content[0].tool_use_id, 'c');
  assert.ok(result.details.every(image => image.path.join('.').startsWith('content.0.content.')));
});

test('snake-case inline data and MCP image data retain their structural fields', {skip: !native}, async () => {
  const data = images[0].data.toString('base64');
  const gemini = {contents: [{role: 'user', parts: [{inline_data: {mime_type: 'image/png', data}, thought_signature: 'unchanged'}]}]};
  const output = await compressRequest(gemini, 'gemini', {maxMilliseconds: 6000, toolMilliseconds: 3000});
  assert.equal(output.compressedImages, 1); assert.equal(output.body.contents[0].parts[0].thought_signature, 'unchanged');
  assert.equal(output.body.contents[0].parts[0].inline_data.mime_type, 'image/png');
  const mcp = {input: [{type: 'function_call_output', call_id: 'c', output: [{type: 'image', mimeType: 'image/png', data}]}]};
  const next = await compressRequest(mcp, 'responses', {maxMilliseconds: 6000, toolMilliseconds: 3000});
  assert.equal(next.compressedImages, 1); assert.equal(next.body.input[0].call_id, 'c'); assert.equal(next.body.input[0].output[0].type, 'image');
});

test('corrupt native image data is kept rather than silently repaired', {skip: !native}, async () => {
  const data = Buffer.from(images[0].data);
  const imageData = inspectImage(data).chunks.find(c => c.type === 'IDAT');
  const position = data.indexOf(imageData.raw);
  data[position + 10] ^= 128;
  const body = {messages: [{role: 'user', content: [formats.chat.part('image/png', data.toString('base64'))]}]};
  const result = await compressRequest(body, 'chat', {maxMilliseconds: 6000, toolMilliseconds: 3000});
  assert.equal(result.body, body); assert.equal(result.details[0].reason, 'codec_failed');
});

test('native work is terminated when an active request is cancelled', {skip: !native}, async () => {
  const body = {messages: [{role: 'user', content: [formats.chat.part('image/png', images[0].data.toString('base64'))]}]};
  // Fire cancellation at listener registration, not after a flaky wall-clock delay.
  const signal = {aborted: false, addEventListener: (_event, callback) => callback(), removeEventListener: () => {}};
  const result = await compressRequest(body, 'chat', {maxMilliseconds: 6000, toolMilliseconds: 3000}, signal);
  assert.equal(result.body, body); assert.equal(result.details[0].reason, 'aborted');
});

test('wrong bundled tool hashes fail closed and preserve image data', {skip: !native}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'magpie-tool-integrity-'));
  t.after(async () => {
    for (const name of ['compression.js', 'filter.js', 'image-formats.js', 'package.json', 'bin/manifest.json', 'bin/oxipng.exe']) await unlink(join(directory, name)).catch(() => {});
    await rmdir(join(directory, 'bin')).catch(() => {}); await rmdir(directory).catch(() => {});
  });
  await mkdir(join(directory, 'bin'));
  for (const name of ['compression.js', 'filter.js', 'image-formats.js']) await writeFile(join(directory, name), await readFile(new URL('../' + name, import.meta.url)));
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(join(directory, 'bin/manifest.json'), '{"files":{"oxipng.exe":"invalid"}}');
  await writeFile(join(directory, 'bin/oxipng.exe'), await readFile(new URL('../bin/oxipng.exe', import.meta.url)));
  const module = await import(pathToFileURL(join(directory, 'compression.js')).href);
  const body = {messages: [{role: 'user', content: [formats.chat.part('image/png', images[0].data.toString('base64'))]}]};
  const result = await module.compressRequest(body, 'chat');
  assert.equal(result.body, body); assert.equal(result.details[0].reason, 'tool_integrity');
});

test('GIF optimization must preserve RGB values beneath original transparency', {skip: !native}, async () => {
  const input = await readFile(new URL('./compression-fixtures/transparent.gif', import.meta.url));
  const body = {messages: [{role: 'user', content: [formats.chat.part('image/gif', input.toString('base64'))]}]};
  const result = await compressRequest(body, 'chat', {maxMilliseconds: 6000, toolMilliseconds: 3000});
  assert.ok(result.compressedImages === 1 || ['validation_failed', 'not_smaller'].includes(result.details[0].reason));
  const output = Buffer.from(formats.chat.encoded(result.body.messages[0].content[0]), 'base64');
  assert.ok(sameImageProperties(inspectImage(input), inspectImage(output)));
  if (process.env.PIXEL_EVIDENCE_DIR) await writeFile(join(process.env.PIXEL_EVIDENCE_DIR, 'transparent.gif'), output);
});

test('inconsistent WebP canvas dimensions are rejected before native decoding', async () => {
  const data = Buffer.from(images.find(image => image.extension === 'webp').data);
  const extended = inspectImage(data).chunks.find(chunk => chunk.type === 'VP8X');
  assert.ok(extended);
  const position = data.indexOf(extended.raw);
  data.writeUIntLE(0, position + 12, 3);
  const body = {messages: [{role: 'user', content: [formats.chat.part('image/webp', data.toString('base64'))]}]};
  const result = await compressRequest(body, 'chat');
  assert.equal(result.body, body); assert.equal(result.details[0].reason, 'invalid_image');
});

test('compressed PNG metadata has an independent expansion bound', async () => {
  const payload = Buffer.concat([Buffer.from('ICC Profile\0\0'), deflateSync(Buffer.alloc(2 * 1024 * 1024, 66))]);
  const type = Buffer.from('iCCP'), encoded = Buffer.concat([type, payload]);
  let crc = 0xffffffff;
  for (const byte of encoded) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const head = Buffer.alloc(4), tail = Buffer.alloc(4);
  head.writeUInt32BE(payload.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  const replacement = Buffer.concat([head, encoded, tail]);
  const original = images[0].data;
  const chunks = inspectImage(original).chunks.map(chunk => chunk.type === 'iCCP' ? replacement : chunk.raw);
  const bytes = Buffer.concat([original.subarray(0, 8), ...chunks]);
  const body = {messages: [{role: 'user', content: [formats.chat.part('image/png', bytes.toString('base64'))]}]};
  const result = await compressRequest(body, 'chat');
  assert.equal(result.body, body); assert.equal(result.details[0].reason, 'metadata_limit');
});

test('progressive JPEG mode and sample layout are preserved', {skip: !native}, async () => {
  const input = await readFile(new URL('./compression-fixtures/progressive.jpg', import.meta.url));
  const body = {messages: [{role: 'user', content: [formats.chat.part('image/jpeg', input.toString('base64'))]}]};
  const result = await compressRequest(body, 'chat', {maxMilliseconds: 6000, toolMilliseconds: 3000});
  assert.ok(result.compressedImages === 1 || result.details[0].reason === 'not_smaller');
  const output = Buffer.from(formats.chat.encoded(result.body.messages[0].content[0]), 'base64');
  assert.ok(inspectImage(output).progressive);
  assert.ok(sameImageProperties(inspectImage(input), inspectImage(output)));
  if (process.env.PIXEL_EVIDENCE_DIR) await writeFile(join(process.env.PIXEL_EVIDENCE_DIR, 'progressive.jpg'), output);
});
