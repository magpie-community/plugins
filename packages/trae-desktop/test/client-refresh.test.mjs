import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import notifier from '../trae-refresh-notifier.cjs';
import { installClientRefresh, LOADER } from '../client-refresh.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-refresh-test-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('notifier refreshes all local editor windows once per revision, including disconnect', t => {
  const directory = fixture(t), app = new EventEmitter(), sent = [];
  const window = id => ({ id, isDestroyed: () => false, isLoadingMainFrame: () => false,
    getURL: () => 'vscode-file://vscode-app/fixture.html', send: (...args) => sent.push({ id, args }) });
  const windows = [window(1), window(2), { ...window(3), getURL: () => 'https://example.com' }];
  const write = (revision, state = 'synced') => fs.writeFileSync(path.join(directory, 'sync-status.json'), JSON.stringify({ revision, state }));
  write('a'.repeat(64));
  const service = notifier.startNotifier({ directory, electron: { app, webContents: { getAllWebContents: () => windows } } });
  t.after(() => service.stop());
  assert.equal(sent.length, 2); service.tick(); assert.equal(sent.length, 2);
  write('b'.repeat(64), 'pending'); service.tick(); assert.equal(sent.length, 2);
  write('b'.repeat(64), 'disconnected'); service.tick(); assert.equal(sent.length, 4);
  assert.ok(sent.every(s => s.args[0] === notifier.CHANNEL));
  windows.push(window(4)); service.tick(); assert.equal(sent.length, 5);
  app.emit('will-quit'); write('c'.repeat(64)); service.tick(); assert.equal(sent.length, 5);
});

test('client installation is hash guarded, idempotent and exactly reversible', t => {
  const root = fixture(t), app = path.join(root, 'Programs/Trae CN/resources/app');
  fs.mkdirSync(path.join(app, 'out'), { recursive: true });
  fs.writeFileSync(path.join(app, 'product.json'), '{"appVersion":"3.4.18"}');
  const main = path.join(app, 'out/main.js'), original = '/* native fixture */\n';
  fs.writeFileSync(main, original);
  const options = { local: root, home: root, expectedHash: createHash('sha256').update(original).digest('hex') };
  assert.equal(installClientRefresh(options).changed, true);
  assert.equal(fs.readFileSync(main, 'utf8'), original + LOADER);
  assert.equal(installClientRefresh(options).changed, false);
  installClientRefresh({ ...options, restore: true }); assert.equal(fs.readFileSync(main, 'utf8'), original);
  fs.writeFileSync(main, 'other build');
  assert.throws(() => installClientRefresh(options), /build_unsupported/);
  assert.equal(fs.readFileSync(main, 'utf8'), 'other build');
});
