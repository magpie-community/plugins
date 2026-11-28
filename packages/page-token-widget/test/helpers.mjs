// The helpers of the tests. Nothing here touches the real Tailscale of this
// computer and nothing here reaches the real Magpie gateway: the tests speak
// with a mock of the command of Tailscale and with a gateway of their own.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

export const ask = (origin, route, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(origin + route, { headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });

export const tempDir = async () => mkdtemp(path.join(tmpdir(), 'token-widget-'));

// A port of its own for every test, so the files of the tests can run at the
// same time without fighting over the same number.
// The numbers that were handed out are remembered: the system is free to
// give the same number again right after it gave it back, and two tests that
// share a number would fight over it.
const handedOut = new Set();
// The ports that the fetch of the browser (and of node) refuses to talk to.
// A gateway of the tests that lands on one of them answers nothing to the
// collector, and the test fails for a reason that has nothing to do with the
// code it wants to test.
export const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161,
  179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563,
  587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060,
  5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

// A port is only good when something can talk to it. This is the one rule
// the gateway of the tests has to obey.
export const portIsUsable = (port) => !BAD_PORTS.has(port);

export const freePort = async () => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const server = http.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    if (handedOut.has(port)) continue;
    if (BAD_PORTS.has(port)) continue;
    handedOut.add(port);
    return port;
  }
  throw new Error('no free port for the tests');
};

export const cleanup = async (dir) => {
  if (!dir) return;
  // A file of the service may still be open when a test is over, and Windows
  // says so with EBUSY. The directory is in the temporary folder of the
  // operating system, so a file that is still open must not fail a test.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
};

export const readJSON = async (file) => JSON.parse(await (await import('node:fs/promises')).readFile(file, 'utf8'));

// A Magpie gateway of the tests. Every request is written down, so a test can
// count how many times the service asked for something.
export async function startGateway(routes = {}, { firstPort = 0 } = {}) {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const key = url.pathname + url.search;
    calls.push(key);
    let handler = routes[key];
    if (!handler) {
      const bare = url.pathname;
      handler = routes[bare];
    }
    if (!handler) handler = routes['*'];
    if (!handler) {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const answer = typeof handler === 'function' ? await handler() : handler;
    if (answer === 'hang') return; // the answer never comes
    if (answer === 'broken') {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'broken' }));
      return;
    }
    if (answer === 'garbage') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('this is not json');
      return;
    }
    // An answer with a status of its own, so that a test can say "this
    // endpoint is not there" (404) or "not this way" (405) without a server
    // of its own.
    if (answer && typeof answer === 'object' && typeof answer.httpStatus === 'number') {
      response.writeHead(answer.httpStatus, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(answer.body ?? { error: 'failed' }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(answer));
  });
  // The system picks the number when the port is 0. Sometimes it picks one
  // that the fetch refuses, and then the gateway is deaf. Give it back and
  // ask for another one. A test can hand in a port of its own (firstPort) to
  // watch the giving back happen for real.
  const refused = [];
  const wanted = firstPort ? [firstPort] : [];
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const asked = wanted.length ? wanted.shift() : 0;
    const listened = await new Promise((resolve) => {
      const onError = () => resolve({ error: true });
      server.once('error', onError);
      server.listen(asked, '127.0.0.1', () => {
        server.removeListener('error', onError);
        resolve({});
      });
    });
    // The port is taken by somebody else; ask for another one.
    if (listened.error) continue;
    const { port } = server.address();
    if (!portIsUsable(port)) {
      refused.push(port);
      await new Promise((resolve) => server.close(resolve));
      continue;
    }
    return {
      url: `http://127.0.0.1:${port}`,
      calls,
      refused,
      close: () => new Promise((resolve) => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        server.close(resolve);
      }),
    };
  }
  throw new Error('no usable port for the gateway of the tests');
}

// A mock of the command of Tailscale. The published ports live in it, so a
// test can see what the plugin did to the forwarding.
export function mockTailscale({ status = {}, ping = 'pong from 100.64.0.1:41641' } = {}) {
  const calls = [];
  // The shape of the real answer of "tailscale serve status --json".
  const serve = { TCP: {} };
  const answer = (args) => {
    const line = args.join(' ');
    calls.push(line);
    if (args[0] === 'status') {
      return { ok: true, stdout: JSON.stringify(status) };
    }
    if (args[0] === 'serve') {
      if (args[1] === 'status') {
        return { ok: true, stdout: JSON.stringify(serve) };
      }
      const flag = args.find((arg) => arg.startsWith('--tcp='));
      const published = flag ? Number(flag.split('=')[1]) : 0;
      if (args.includes('off')) {
        delete serve.TCP[String(published)];
        return { ok: true, stdout: '' };
      }
      const target = String(args[args.length - 1] || '').replace('tcp://', '');
      serve.TCP[String(published)] = { TCPForward: target };
      return { ok: true, stdout: '' };
    }
    if (args[0] === 'ping') {
      return { ok: true, stdout: ping };
    }
    return { ok: false, error: `unknown command: ${line}` };
  };
  const runner = async (args) => answer(args);
  // The same answers, but at once: the way out of a run cannot wait for a
  // promise, so the tests need a runner that answers in one go.
  const runnerSync = (args) => answer(args);
  return { runner, runnerSync, calls, serve };
}

// The status that Tailscale answers with on this computer.
export const tailscaleStatus = {
  Version: '1.104.6',
  BackendState: 'Running',
  Self: {
    HostName: 'testnode',
    DNSName: 'testnode.tail1234.ts.net.',
    OS: 'windows',
    TailscaleIPs: ['100.64.0.1', 'fd7a:115c:a1e0::1'],
    Relay: 'hkg',
    CurAddr: '',
    Online: true,
  },
  Peer: {
    p1: {
      HostName: 'iphone',
      DNSName: 'iphone.tail1234.ts.net.',
      OS: 'iOS',
      Online: true,
      Active: true,
      Relay: '',
      CurAddr: '192.168.10.44:41641',
      TailscaleIPs: ['100.64.0.2'],
    },
  },
};
