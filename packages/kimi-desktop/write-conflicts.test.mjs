import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { recoveryPeer } from './test-fixtures/control-peer.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
async function duringStaging(file, edit, run) {
  const original = fs.writeFileSync;
  let injected = false;
  fs.writeFileSync = function (target, ...args) {
    const result = original.call(this, target, ...args);
    if (!injected && String(target).startsWith(file + '.') && String(target).endsWith('.tmp')) {
      injected = true;
      edit(original);
    }
    return result;
  };
  try { await run(); expect(injected).toBe(true); }
  finally { fs.writeFileSync = original; }
}

test('a desktop config edit during staging is preserved instead of overwritten', async () => {
  const f = recoveryPeer();
  try {
    await f.controller.tick();
    const file = f.controller.configFile;
    await duringStaging(file, write => write(file, JSON.stringify({ ...read(file), unrelated: 'new external setting' })),
      () => expect(() => f.controller.changeBase(f.controller.bridgeURL, 'https://agent-gw.kimi.com/coding/v1')).toThrow('kimi_config_changed'));
    expect(read(file).unrelated).toBe('new external setting');
    expect(read(file).model.providers['daimon-kimi-code'].baseUrl).toBe(f.controller.bridgeURL);
  } finally { await f.cleanup(); }
});

test('a native runtime edit during staging is preserved instead of overwritten', async () => {
  const f = recoveryPeer();
  try {
    const file = f.controller.nativeConfigFile;
    fs.writeFileSync(file, 'marker = "before"\n');
    const before = fs.readFileSync(file);
    await duringStaging(file, write => write(file, 'marker = "external"\n'),
      () => expect(() => f.controller.commitNativeSecondary(before, 'marker = "adapter"\n')).toThrow('kimi_config_changed'));
    expect(fs.readFileSync(file, 'utf8')).toBe('marker = "external"\n');
  } finally { await f.cleanup(); }
});

test('a host connection edit during a secondary save is preserved and requires a refresh', async () => {
  const f = recoveryPeer();
  try {
    const file = f.controller.connectionFile;
    await duringStaging(file, write => write(file, JSON.stringify({ ...read(file), hostOwned: 'new external setting' })),
      () => expect(f.controller.saveSettings({ secondaryModel: 'provider/main' })).rejects.toThrow('connection_changed'));
    expect(read(file).hostOwned).toBe('new external setting');
    expect(read(file).secondaryModel).toBeUndefined();
  } finally { await f.cleanup(); }
});
