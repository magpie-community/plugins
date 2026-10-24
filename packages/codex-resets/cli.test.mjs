import { test } from 'node:test';
import assert from 'node:assert/strict';
import { args, parseOptions } from './sync.mjs';
test('only explicit flags are accepted and no scheduler is installed', () => {
  assert.deepEqual(args([]), { watch: false, bell: false, magpie: 'magpie', plugin: 'codex-resets' });
  assert.equal(args(['--watch', '--bell']).watch, true);
  assert.equal(args(['--magpie', '/path with spaces/magpie']).magpie, '/path with spaces/magpie');
  for (const a of [['--magpie'], ['--plugin', '--watch'], ['--endpoint', 'https://other.test']]) assert.throws(() => args(a));
});
test('official CLI options output is parsed without guessing arbitrary log text', () => {
  assert.deepEqual(parseOptions('No options set.'), {});
  assert.deepEqual(parseOptions('No options set. Its package suggests:\n{"codexResets":null}'), { codexResets: null });
  assert.deepEqual(parseOptions('{"custom":true}'), { custom: true });
  for (const bad of ['null', '[]', 'not a plugin', 'warning\n{"x":true}']) assert.throws(() => parseOptions(bad));
});
