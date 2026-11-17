// Exercise the real control WebSocket transport against a temporary Kimi peer.
// No desktop profile, application or external model is used.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { isMenuAlias } from './catalog.mjs';
import { recoveryPeer } from './test-fixtures/control-peer.mjs';

const official = 'https://agent-gw.kimi.com/coding/v1';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

for (const [point, after] of [['list', false], ['select', false], ['select', true],
  ['menu', false], ['menu', true], ['reload', false], ['reload', true]]) {
  test(`stop preserves retryable recovery when ${point} fails ${after ? 'after' : 'before'} its effect`, async () => {
    const f = recoveryPeer();
    try {
      await f.controller.tick();
      expect(f.controller.status.code).toBe('connected');
      f.selectAlias();
      f.disable();
      f.fail(point, after);
      await f.controller.stop();
      expect(read(f.controller.configFile).model.providers['daimon-kimi-code'].baseUrl).toBe(official);
      expect(read(f.controller.stateFile).active).toBe(true);
      expect(fs.existsSync(f.controller.modelBackupFile)).toBe(true);
      expect(f.controller.status.code).toBe('restored_waiting_kimi');
      f.recover();
      await f.controller.tick();
      expect(f.controller.status.code).toBe('disconnected');
      expect(read(f.controller.stateFile).active).toBe(false);
      expect(read(f.controller.configFile).model.current).toBe('native');
      expect(f.menu.map(row => row.model)).toEqual(['native']);
      expect(f.runtimeBase).toBe(official);
      expect(fs.existsSync(f.controller.modelBackupFile)).toBe(false);
      expect(read(f.controller.configFile).unrelated).toBe('keep');
    } finally { await f.cleanup(); }
  });
}

test('a disabled next start completes native menu and runtime recovery after synchronous exit', async () => {
  const f = recoveryPeer();
  try {
    await f.controller.tick();
    f.selectAlias();
    f.controller.restoreFileOnExit();
    expect(read(f.controller.stateFile).active).toBe(true);
    expect(f.menu.some(row => isMenuAlias(row.model))).toBe(true);
    await f.controller.stop();
    f.disable();
    f.recover();
    await f.controller.tick();
    expect(f.controller.status.code).toBe('disconnected');
    expect(read(f.controller.configFile).model.current).toBe('native');
    expect(f.menu.map(row => row.model)).toEqual(['native']);
    expect(f.runtimeBase).toBe(official);
    expect(fs.existsSync(f.controller.modelBackupFile)).toBe(false);
  } finally { await f.cleanup(); }
});

test('a first apply with an unacknowledged side effect retains recovery for disconnect', async () => {
  const f = recoveryPeer();
  try {
    f.fail('select', true);
    await f.controller.tick();
    expect(f.runtimeBase).toBe(f.controller.bridgeURL);
    expect(read(f.controller.configFile).model.providers['daimon-kimi-code'].baseUrl).toBe(official);
    expect(read(f.controller.stateFile).active).toBe(true);
    f.disable();
    await f.controller.stop();
    f.recover();
    await f.controller.tick();
    expect(read(f.controller.stateFile).active).toBe(false);
    expect(f.runtimeBase).toBe(official);
    expect(f.controller.status.code).toBe('disconnected');
  } finally { await f.cleanup(); }
});

for (const [message, code, expected] of [
  ['kimi_config_changed', undefined, 'kimi_config_changed'],
  ['secondary_model_unsupported_runtime', undefined, 'secondary_model_unsupported_runtime'],
  ['missing file', 'ENOENT', 'secondary_model_unavailable'],
]) {
  test(`stop retains the classified pool restore error ${expected}`, async () => {
    const f = recoveryPeer();
    try {
      await f.controller.tick();
      f.controller.restoreModelPoolOnExit = () => { throw Object.assign(Error(message), { code }); };
      await f.controller.stop();
      expect(f.controller.status.code).toBe(expected);
    } finally { await f.cleanup(); }
  });
}
