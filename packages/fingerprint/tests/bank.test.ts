import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server';
import { cacheFixture } from './bank-fixture';

const config = {
  targets: [{ model: 'vendor/model' }],
  api: 'auto',
  effort: '',
  serviceTier: 'default',
  strict: false,
  targetParallel: 1,
  sampleParallel: 3,
  deadlineSeconds: 10,
};

async function fixture(cached = false, downloadable = false) {
  const dir = await mkdtemp(join(tmpdir(), 'fingerprint-bank-test-'));
  const downloads: Request[] = [];
  let samples = 0;
  const source = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      downloads.push(req);
      if (downloadable) {
        const cache = cacheFixture();
        const bankLength = cache.readUInt32LE(0);
        if (new URL(req.url).pathname.endsWith('/bundle.json'))
          return new Response(cache.subarray(4, 4 + bankLength));
        const bytes = cache.subarray(4 + bankLength);
        // A single-segment Zstandard frame containing one uncompressed block.
        const header = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, bytes.length, 0, 0, 0]);
        header.writeUIntLE((bytes.length << 3) | 1, 6, 3);
        return new Response(Buffer.concat([header, bytes]));
      }
      return new Response('Unavailable', { status: 503 });
    },
  });
  const gateway = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === '/v1/models') return Response.json({ data: [{ id: 'vendor/model' }] });
      if (req.method === 'POST') samples++;
      return Response.json(
        { error: { message: 'Test gateway does not sample' }, data: [] },
        { status: req.method === 'POST' ? 503 : 200 },
      );
    },
  });
  let service: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await mkdir(join(dir, 'ui'));
    await writeFile(join(dir, 'ui/index.html'), '<head></head>');
    if (cached) {
      await writeFile(join(dir, 'reference.bin'), cacheFixture());
      await utimes(join(dir, 'reference.bin'), new Date(0), new Date(0));
    }
    service = await startServer({
      port: 0,
      dataDir: dir,
      uiDir: join(dir, 'ui'),
      gateway: `http://127.0.0.1:${gateway.port}`,
      apiKey: 'gateway-secret',
      bankSource: `http://127.0.0.1:${source.port}/`,
      demo: false,
    });
    const base = `http://127.0.0.1:${service.port}`;
    const html = await (await fetch(base)).text();
    const token = JSON.parse(html.match(/window\.__FINGERPRINT__=(.*?)<\/script>/)![1]).token;
    return {
      base,
      downloads,
      cachedBytes: () => Bun.file(join(dir, 'reference.bin')).arrayBuffer(),
      samples: () => samples,
      api: (path: string, init: RequestInit = {}) =>
        fetch(`${base}/api/${path}`, {
          ...init,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
        }),
      async close() {
        await service?.close();
        source.stop(true);
        gateway.stop(true);
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await service?.close();
    source.stop(true);
    gateway.stop(true);
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

test('opening, refreshing and invalid jobs never download reference data; explicit actions do', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 2; i++) {
      const boot = await (await f.api('bootstrap')).json();
      expect(boot.bank).toBeNull();
      expect(boot.bankStatus.state).toBe('missing');
    }
    expect((await fetch(`${f.base}/api/bank/download`, { method: 'POST' })).status).toBe(401);
    expect((await f.api('jobs', { method: 'POST', body: 'null' })).status).toBe(400);
    expect(f.downloads).toHaveLength(0);
    expect(f.samples()).toBe(0);
    expect((await f.api('bank/download', { method: 'POST' })).status).toBe(503);
    expect(f.downloads).toHaveLength(1);
    expect(f.downloads[0].headers.has('authorization')).toBe(false);
    expect((await f.api('bootstrap')).status).toBe(200);
    expect(f.downloads).toHaveLength(1);
    expect((await f.api('jobs', { method: 'POST', body: JSON.stringify(config) })).status).toBe(
      503,
    );
    expect(f.downloads).toHaveLength(2);
    expect(f.samples()).toBe(0);
  } finally {
    await f.close();
  }
});

test('an old cached snapshot is reused without background network refresh', async () => {
  const f = await fixture(true);
  try {
    expect((await (await f.api('bootstrap')).json()).bankStatus.state).toBe('cached');
    const created = await f.api('jobs', {
      method: 'POST',
      body: JSON.stringify(config),
    });
    expect(created.status).toBe(202);
    const job = await created.json();
    expect(job.bank.builtAt).toBe('test-snapshot');
    for (let i = 0; i < 100; i++) {
      const current = await (await f.api(`jobs/${job.id}`)).json();
      if (!['queued', 'running'].includes(current.state)) break;
      await Bun.sleep(10);
    }
    expect(f.downloads).toHaveLength(0);
    expect((await (await f.api('bootstrap')).json()).bankStatus.state).toBe('ready');
    expect((await f.api('bank/download', { method: 'POST' })).status).toBe(503);
    expect(f.downloads).toHaveLength(1);
    expect((await (await f.api('bootstrap')).json()).bank.builtAt).toBe('test-snapshot');
    expect(f.downloads).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('an explicit download installs a usable snapshot without sending model requests', async () => {
  const f = await fixture(false, true);
  try {
    expect((await (await f.api('bootstrap')).json()).bankStatus.state).toBe('missing');
    const response = await f.api('bank/download', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      bank: { builtAt: 'test-snapshot', modelCount: 0 },
      bankStatus: { state: 'ready' },
    });
    expect(Buffer.from(await f.cachedBytes())).toEqual(cacheFixture());
    expect(f.downloads.map((req) => new URL(req.url).pathname)).toEqual([
      '/bundle.json',
      '/chunks/fixture.zst',
    ]);
    expect(f.samples()).toBe(0);
    await f.api('bootstrap');
    expect(f.downloads).toHaveLength(2);
  } finally {
    await f.close();
  }
});
