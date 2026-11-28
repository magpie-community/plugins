// The harness of the tests has to be dependable: a gateway that lands on a
// port the fetch refuses makes a test fail for a reason that has nothing to
// do with the code it wants to test.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startGateway, BAD_PORTS, portIsUsable } from './helpers.mjs';

test('the gateway of the tests always listens on a port that fetch can talk to', async () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const gateway = await startGateway({ '/hello': { ok: true } });
    try {
      const port = Number(new URL(gateway.url).port);
      assert.equal(portIsUsable(port), true, `the gateway listens on ${port}, a port that fetch refuses`);
      // The fetch has to reach it: a bad port answers with "fetch failed".
      const answer = await fetch(`${gateway.url}/hello`);
      assert.equal(answer.status, 200);
      assert.deepEqual(await answer.json(), { ok: true });
    } finally {
      await gateway.close();
    }
  }
});

// The rule the gateway has to obey, on its own.
test('a port the fetch refuses is not a port for a gateway', () => {
  assert.equal(portIsUsable(10080), false);
  assert.equal(portIsUsable(6000), false);
  assert.equal(portIsUsable(3498), true);
});

// The rule above only shows up by chance when the system picks the port, so
// the giving back is done on purpose here: the gateway is told to try a port
// that fetch refuses first, and it has to hand it back and take another one.
test('the gateway gives a port that fetch refuses back', async (t) => {
  // Find a port of that kind that is free right now, so the gateway can
  // really take it and really give it back.
  let bad = null;
  for (const port of BAD_PORTS) {
    if (port < 1024) continue;
    const probe = net.createServer();
    const free = await new Promise((resolve) => {
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (!free) continue;
    await new Promise((resolve) => probe.close(resolve));
    bad = port;
    break;
  }
  if (!bad) {
    t.skip('no port that fetch refuses is free at the moment');
    return;
  }
  const gateway = await startGateway({ '/hello': { ok: true } }, { firstPort: bad });
  try {
    assert.ok(gateway.refused.includes(bad), `the gateway should have given ${bad} back`);
    const port = Number(new URL(gateway.url).port);
    assert.equal(portIsUsable(port), true, `the gateway listens on ${port}, a port that fetch refuses`);
    assert.notEqual(port, bad);
    // And the fetch has to reach the gateway that is left.
    const answer = await fetch(`${gateway.url}/hello`);
    assert.equal(answer.status, 200);
  } finally {
    await gateway.close();
  }
});
