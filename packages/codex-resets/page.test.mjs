import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
const dir = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(dir, 'package.json')));
const read = f => readFileSync(join(dir, 'page', f), 'utf8');
test('standalone page declares no private reads, replacement page or automatic hooks', () => {
  assert.deepEqual(pkg.magpie.permissions, []);
  for (const k of ['main', 'exports', 'dependencies', 'scripts']) assert.equal(pkg[k], undefined);
  for (const k of ['panels', 'hooks', 'middleware']) assert.equal(pkg.magpie[k], undefined);
  assert.equal(pkg.magpie.page.replaces, undefined);
  assert.equal(pkg.magpie.page.file, 'page/index.html');
});
test('page uses external scripts and only the documented options bridge', () => {
  const html = read('index.html');
  assert.match(html, /<script src="_magpie\/bridge.js"><\/script>/);
  for (const match of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    assert.match(match[1], /src="[^:"]+"/); assert.equal(match[2].trim(), '');
  }
  for (const f of readdirSync(join(dir, 'page')).filter(f => f.endsWith('.js'))) {
    assert.doesNotMatch(read(f), /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts|innerHTML|magpie\.read\(|magpie\.options\.set/);
  }
  assert.match(read('app.js'), /magpie\.options\.get\(\)/);
});
test('all supported page languages have the same complete message set', () => {
  const scope = {}; vm.runInNewContext(read('words.js'), scope);
  const en = scope.CodexResetWords('en'), keys = Object.keys(en).sort();
  for (const lang of ['zh', 'zh-CN', 'zh-TW', 'en', 'ja', 'de']) {
    const words = scope.CodexResetWords(lang);
    assert.deepEqual(Object.keys(words).sort(), keys);
    for (const value of Object.values(words)) assert.equal(typeof value, 'string');
  }
  for (const key of [...read('index.html').matchAll(/data-t="([^"]+)"/g)].map(m => m[1])) assert.ok(en[key], key);
});
