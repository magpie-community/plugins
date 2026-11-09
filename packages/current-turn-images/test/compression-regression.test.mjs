import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {onRequest} from '../request.hooks.js';

test('installed HTTP hook reduces embedded PNG bytes without dropping its current image', {skip: process.platform !== 'win32' || process.arch !== 'x64'}, async () => {
  const input = await readFile(new URL('./compression-fixtures/large.png', import.meta.url));
  const body = {model: 'test/model', messages: [{role: 'user', content: [{type: 'image_url', image_url: {
    url: 'data:image/png;base64,' + input.toString('base64')}}]}]};
  const dataDir = await mkdtemp(join(tmpdir(), 'magpie-lossless-regression-'));
  const result = await onRequest(body, {protocol: 'chat', model: body.model, options: {dataDir, gatewayTimeoutMs: 10000}});
  const actual = result ?? body;
  const output = Buffer.from(actual.messages[0].content[0].image_url.url.split(',')[1], 'base64');
  assert.ok(output.length < input.length, 'current PNG was not losslessly compressed');
  assert.ok(Buffer.byteLength(JSON.stringify(actual)) < Buffer.byteLength(JSON.stringify(body)));
});
