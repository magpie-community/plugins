import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {defaultDataDir} from '../journal.js';

test('default metrics directory follows the current platform', () => {
  const base = process.platform === 'win32'
    ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    : process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  assert.equal(defaultDataDir(), join(base, 'magpie', 'current-turn-images'));
});

test('public package declares hooks, safe budgets and no private defaults', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.name, '@magpie-community/gateway-current-turn-images');
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.magpie.hooks, './request.hooks.js');
  assert.deepEqual(pkg.magpie.permissions, []);
  assert.equal(pkg.magpie.options.gatewayTimeoutMs, 10000);
  assert.equal(pkg.magpie.options.imageCompression.enabled, true);
  assert.equal(pkg.magpie.options.dataDir, undefined);
  assert.equal(pkg.magpie.options.cacheAnchors, undefined);
  for (const name of ['bin', 'LICENSES', 'vendor-sources', 'page']) assert.ok(pkg.files.includes(name));
});
