// Regression evidence for synchronous exit. Every profile is synthetic and
// lives under the temporary home passed explicitly to the controller.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { KimiAdapter } from './adapter.mjs';

const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

test('synchronous exit disables the owned native plugin registration without RPC', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-plugin-exit-home-'));
  let controller;
  try {
    const calls = [];
    controller = new KimiAdapter({ home, stateDir: path.join(home, 'state'),
      kimiDir: path.join(home, 'kimi'), rpcCall: (...args) => { calls.push(args); throw Error('unexpected_rpc'); },
      fetchImpl: () => { throw Error('unexpected_fetch'); } });
    write(controller.configFile, { model: { providers: {
      'daimon-kimi-code': { type: 'kimi', baseUrl: 'https://agent-gw.kimi.com/coding/v1' },
    } } });
    expect(controller.bootstrap()).toBe(true);
    expect(controller.ownLock()).toBe(true);
    const secret = 'synthetic-routing-secret-used-only-in-temporary-fixture';
    const id = 'local-work-model-roles-' + hash(secret).slice(0, 12);
    const source = path.join(controller.stateDir, 'native-model-roles');
    const manifest = { name: id, version: '1.0.0', description: 'Local Work model roles', agents: ['./agents'] };
    write(path.join(source, 'kimi.plugin.json'), manifest);
    const registryFile = path.join(path.dirname(controller.convertedNativeConfigFile), 'plugins', 'installed.json');
    const root = path.join(path.dirname(registryFile), 'managed', id);
    fs.cpSync(source, root, { recursive: true });
    write(registryFile, { version: 1, plugins: [{ id, root, source: 'local-path', originalSource: source,
      enabled: true, origin: 'custom', installedAt: 'synthetic-date' }] });
    controller.state = { active: false, agentRoutingSecret: secret, agentPlugin: { id, phase: 'ready',
      files: { 'kimi.plugin.json': hash(fs.readFileSync(path.join(source, 'kimi.plugin.json'))) } } };
    controller.saveState();

    controller.restoreFileOnExit();

    expect(read(registryFile).plugins[0].enabled).toBe(false);
    expect(calls).toEqual([]);
    expect(fs.existsSync(path.join(root, 'kimi.plugin.json'))).toBe(true);
  } finally {
    controller?.releaseLock();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
