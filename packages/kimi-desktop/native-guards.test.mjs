// These exercise the production file commit and authenticated control client.
// All files and tokens are synthetic; the WebSocket server is loopback only.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KimiAdapter } from './adapter.mjs';
import { rpc as rpcCall } from './rpc.mjs';

test('native secondary commit refuses stale bytes and preserves the other writer exactly', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-kimi-commit-'));
  try {
    const adapter = Object.create(KimiAdapter.prototype);
    adapter.nativeConfigFile = path.join(directory, 'config.toml');
    const original = 'default_model = "k2d8-preview"\n# initial settings\n';
    fs.writeFileSync(adapter.nativeConfigFile, original, { mode: 0o600 });
    const bytes = fs.readFileSync(adapter.nativeConfigFile);
    const target = original + '\n[secondary_model]\nmodel = "synthetic-new-alias"\n';

    // Another writer changes only unrelated bytes after we computed the patch.
    // Comparing parsed secondary fields would miss the comment and CRLF edit.
    const otherWriter = Buffer.from('default_model = "k2d8-preview"\r\n# other writer: 保留字节\r\n');
    fs.writeFileSync(adapter.nativeConfigFile, otherWriter);
    expect(() => adapter.commitNativeSecondary(bytes, target)).toThrow('kimi_config_changed');
    expect(fs.readFileSync(adapter.nativeConfigFile).equals(otherWriter)).toBe(true);
    expect(fs.readFileSync(adapter.nativeConfigFile, 'utf8')).not.toContain('synthetic-new-alias');
    expect(fs.readdirSync(directory)).toEqual(['config.toml']);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

const kernelSessionId = 'synthetic-kernel-session';
const reloadCases = [
  ['kimiPlugin.reloadActiveSessions', {}, { sessions: [{ kernelSessionId, status: 'reloaded' }] }],
  ['kimiPlugin.ReloadSession', { kernelSessionId }, { status: 'reloaded' }],
  ['kimiPlugin.installPlugin', { source: '/synthetic/role-plugin' }, { id: 'synthetic-role-plugin', enabled: true }],
  ['kimiPlugin.updatePlugin', { source: '/synthetic/role-plugin' }, { id: 'synthetic-role-plugin', enabled: true }],
  ['kimiPlugin.getPluginInfo', { id: 'synthetic-role-plugin' }, { id: 'synthetic-role-plugin', enabled: true }],
  ['kimiPlugin.setPluginEnabled', { id: 'synthetic-role-plugin', enabled: true }, { id: 'synthetic-role-plugin', enabled: true }],
];

for (const [method, params, acknowledgement] of reloadCases) {
  test(`production RPC sends ${method} and receives its acknowledgement`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-kimi-control-'));
    const token = 'synthetic-synthetic-control-token';
    const handshakes = [], messages = [];
    let server;
    try {
      server = Bun.serve({
        hostname: '127.0.0.1', port: 0,
        fetch(request, listener) {
          handshakes.push({ path: new URL(request.url).pathname,
            authorization: request.headers.get('authorization') });
          if (new URL(request.url).pathname !== '/control'
              || request.headers.get('authorization') !== 'Bearer ' + token) {
            return new Response('synthetic unauthorized', { status: 401 });
          }
          if (listener.upgrade(request)) return;
          return new Response('WebSocket required', { status: 400 });
        },
        websocket: {
          message(socket, data) {
            const message = JSON.parse(String(data));
            messages.push(message);
            socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: acknowledgement }));
          },
        },
      });
      const runnerFile = path.join(directory, 'agents/main/runner.state.json');
      fs.mkdirSync(path.dirname(runnerFile), { recursive: true });
      fs.writeFileSync(runnerFile, JSON.stringify({ lifecycleStatus: 'running',
        daemonGeneration: 'synthetic-generation',
        control: { endpoint: { url: `ws://127.0.0.1:${server.port}/control`, auth: { token } } },
      }), { mode: 0o600 });
      const runner = JSON.parse(fs.readFileSync(runnerFile, 'utf8'));

      expect(await rpcCall(runner, method, params, { timeout: 1000 })).toEqual(acknowledgement);
      expect(handshakes).toEqual([{ path: '/control', authorization: 'Bearer ' + token }]);
      expect(messages).toEqual([{ jsonrpc: '2.0', id: 1, method, params }]);

      // Reject unknown names before opening another authenticated connection.
      await expect(rpcCall(runner, 'kimiPlugin.unknownMethod', {}, { timeout: 1000 }))
        .rejects.toThrow('unsupported_control_method');
      expect(handshakes).toHaveLength(1);
      expect(messages).toHaveLength(1);
    } finally {
      if (server) await server.stop(true);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
