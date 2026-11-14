// The life of the plugin: the host asks it to stop, and the way out of a run
// takes the forwarding of the tailnet away — but only its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import plugin from '../index.mjs';
import { cleanupForward } from '../lib/cleanup.mjs';
import { DATA_DIR } from '../lib/paths.mjs';
import { tempDir, freePort, cleanup, mockTailscale } from './helpers.mjs';

test('the service stops when the host asks it to stop', async () => {
  const dir = await tempDir();
  const port = await freePort();
  const phonePort = await freePort();
  try {
    await plugin.server(
      { directory: dir },
      { port, phonePort, gatewayURL: 'http://127.0.0.1:1', forward: false },
    );
    const answer = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(answer.status, 200);

    const stopped = await plugin.stop();
    assert.equal(stopped.ok, true);
    assert.equal(stopped.stopped, true);

    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  } finally {
    await plugin.stop();
    await cleanup(dir);
  }
});

test('a host that asks twice does not complain', async () => {
  const dir = await tempDir();
  try {
    const stopped = await plugin.stop();
    assert.equal(stopped.ok, true);
    assert.equal(stopped.stopped, false);
  } finally {
    await cleanup(dir);
  }
});

test('the forwarding of the tailnet is taken away at the end of a run', async () => {
  const dir = await tempDir();
  try {
    mkdirSync(path.join(dir, DATA_DIR), { recursive: true });
    writeFileSync(
      path.join(dir, DATA_DIR, 'state.json'),
      JSON.stringify({
        forward: {
          publishedPort: 8790,
          phonePort: 8791,
          target: '127.0.0.1:8791',
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      }),
    );
    const mock = mockTailscale();
    mock.serve.TCP['8790'] = { TCPForward: '127.0.0.1:8791' };

    const answer = cleanupForward(dir, mock.runnerSync);
    assert.equal(answer.ok, true);
    assert.ok(mock.calls.includes('serve --tcp=8790 off'), mock.calls.join(' | '));
    assert.equal(mock.serve.TCP['8790'], undefined);
  } finally {
    await cleanup(dir);
  }
});

test('a forwarding of somebody else is left alone', async () => {
  const dir = await tempDir();
  try {
    mkdirSync(path.join(dir, DATA_DIR), { recursive: true });
    writeFileSync(
      path.join(dir, DATA_DIR, 'state.json'),
      JSON.stringify({
        forward: {
          publishedPort: 8790,
          phonePort: 8791,
          target: '127.0.0.1:8791',
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      }),
    );
    const mock = mockTailscale();
    // Somebody else put a forwarding on the port.
    mock.serve.TCP['8790'] = { TCPForward: '127.0.0.1:9999' };

    const answer = cleanupForward(dir, mock.runnerSync);
    assert.equal(answer.ok, false);
    assert.ok(!mock.calls.some((line) => line.includes('off')), mock.calls.join(' | '));
    assert.deepEqual(mock.serve.TCP['8790'], { TCPForward: '127.0.0.1:9999' });
  } finally {
    await cleanup(dir);
  }
});

test('nothing is taken away when this plugin never made a forwarding', async () => {
  const dir = await tempDir();
  try {
    mkdirSync(path.join(dir, DATA_DIR), { recursive: true });
    writeFileSync(path.join(dir, DATA_DIR, 'state.json'), JSON.stringify({}));
    const mock = mockTailscale();
    const answer = cleanupForward(dir, mock.runnerSync);
    assert.equal(answer.ok, true);
    assert.equal(answer.skipped, true);
    assert.deepEqual(mock.calls, []);
  } finally {
    await cleanup(dir);
  }
});
