import fs from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {combineMiddleware} from '../server/middleware.mjs';

const root = new URL('../', import.meta.url);
const read = name => fs.readFileSync(new URL(name, root));
const sha = value => createHash('sha256').update(value).digest('hex');
test('community distribution preserves its package identity and ships a public prebuilt hook', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, '@magpie-community/middleware-codex-history');
  assert.equal(pkg.repository.directory, 'packages/codex-history');
  assert.deepEqual(pkg.magpie.options, {providers: {}, aliases: {}});
  assert.equal(read('workbench.middleware.js').toString(), combineMiddleware());
  for (const name of [pkg.main, pkg.magpie.middleware, pkg.magpie.page.file, pkg.magpie.page.icon]) {
    assert.ok(fs.existsSync(new URL(name, root)), name);
  }
  for (const name of ['docs/USAGE.md', 'docs/RELEASE-v0.2.1.md', 'MAINTAINING.md']) {
    assert.ok(pkg.files.includes(name), name + ': missing from package allowlist');
    assert.ok(fs.existsSync(new URL(name, root)), name);
  }
});
test('upstream history and ModelTrace bytes match the pinned provenance', () => {
  const history = JSON.parse(read('history/PROVENANCE.json'));
  assert.equal(sha(read('history/codex-history.middleware.js')), history.sha256);
  assert.equal(sha(read('codex-history.middleware.js')), history.sha256);
  const provenance = JSON.parse(read('vendor/modeltrace/PROVENANCE.json'));
  for (const [name, info] of Object.entries(provenance.files)) assert.equal(sha(read('vendor/modeltrace/' + name)), info.sha256, name);
});
