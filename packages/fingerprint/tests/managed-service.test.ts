import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serviceBindError, startManagedService } from '../src/managed-service';

const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await Bun.sleep(20);
  }
  throw new Error('Timed out waiting for host takeover');
};

test('bind diagnostics distinguish port conflicts from Windows port exclusions', () => {
  const inUse = Object.assign(new Error('bind failed'), { code: 'EADDRINUSE' });
  const denied = Object.assign(new Error('bind failed'), { code: 'EACCES' });
  expect(serviceBindError(inUse, 3488).message).toContain('port 3488: the port is already in use');
  expect(serviceBindError(denied, 3488).message).toContain('reserved or excluded');
  expect(serviceBindError(denied, 3488).message).toContain(
    'netsh interface ipv4 show excludedportrange protocol=tcp',
  );
});

test('two hosts share one compatible service and the survivor takes over', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fingerprint-hosts-'));
  const opts = { demo: true, dataDir: dir, uiDir: join(dir, 'ui') };
  await mkdir(opts.uiDir);
  await writeFile(join(opts.uiDir, 'index.html'), '<head></head>');
  const a = await startManagedService({ ...opts, port: 0 }, 20);
  let b: Awaited<ReturnType<typeof startManagedService>> | undefined;
  let c: Awaited<ReturnType<typeof startManagedService>> | undefined;
  try {
    const port = a.port;
    b = await startManagedService({ ...opts, port }, 20);
    expect(a.role).toBe('owner');
    expect(b.role).toBe('attached');
    await a.close();
    await waitFor(() => b!.role === 'owner');
    expect(b.port).toBe(port);
    c = await startManagedService({ ...opts, port }, 20);
    expect(c.role).toBe('attached');
    await c.close();
    expect((await fetch(`http://127.0.0.1:${port}/_fingerprint/health`)).ok).toBe(true);
    await expect(
      startManagedService({ ...opts, dataDir: join(dir, 'different'), port }),
    ).rejects.toThrow('incompatible');
  } finally {
    await a.close();
    await b?.close();
    await c?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('identity hides the gateway key but still rejects a changed key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fingerprint-identity-'));
  const gateway = 'http://127.0.0.1:3425';
  const oldKey = 'old-key';
  const opts = { dataDir: dir, demo: true, gateway };
  let owner: Awaited<ReturnType<typeof startManagedService>> | undefined;
  let attached: Awaited<ReturnType<typeof startManagedService>> | undefined;
  try {
    owner = await startManagedService({ ...opts, apiKey: oldKey, port: 0 }, 20);
    const health = await (await fetch(`http://127.0.0.1:${owner.port}/_fingerprint/health`)).json();
    const legacy = createHash('sha256')
      .update(
        JSON.stringify({
          gateway,
          apiKey: oldKey,
          dataDir: dir,
          bankSource: null,
          demo: true,
          uiDir: null,
        }),
      )
      .digest('hex');
    expect(health.configuration).not.toBe(legacy);
    expect((await readFile(join(dir, '.service-identity-salt'))).length).toBe(32);

    await expect(
      startManagedService({ ...opts, apiKey: 'new-key', port: owner.port }),
    ).rejects.toThrow('incompatible');
    attached = await startManagedService({ ...opts, apiKey: oldKey, port: owner.port }, 20);
    expect(attached.role).toBe('attached');
  } finally {
    await owner?.close();
    await attached?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrent first starts publish one persistent identity salt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fingerprint-identity-race-'));
  const source = join(import.meta.dir, '../src/service-identity.ts');
  const input = JSON.stringify({
    dataDir: dir,
    demo: true,
    gateway: 'http://127.0.0.1:3425',
    apiKey: 'race-key',
  });
  const script = `import { serviceIdentity } from ${JSON.stringify(source)}; process.stdout.write(serviceIdentity(${input}).configuration);`;
  try {
    const children = Array.from({ length: 2 }, () =>
      Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' }),
    );
    const outputs = await Promise.all(
      children.map(async (child) => {
        const output = await new Response(child.stdout).text();
        expect(await child.exited).toBe(0);
        return output;
      }),
    );
    expect(outputs[0]).toBe(outputs[1]);
    expect((await readFile(join(dir, '.service-identity-salt'))).length).toBe(32);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('simultaneous hosts elect one owner without touching another application', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fingerprint-election-'));
  const reservation = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('not fingerprint'),
  });
  const port = reservation.port!;
  try {
    await expect(startManagedService({ port, dataDir: dir, demo: true })).rejects.toThrow(
      'incompatible',
    );
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('not fingerprint');
  } finally {
    reservation.stop(true);
  }
  const hosts: Awaited<ReturnType<typeof startManagedService>>[] = [];
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () => startManagedService({ port, dataDir: dir, demo: true }, 20)),
    );
    for (const result of results) if (result.status === 'fulfilled') hosts.push(result.value);
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(hosts.filter((host) => host.role === 'owner')).toHaveLength(1);
  } finally {
    await Promise.all(hosts.map((host) => host.close()));
    await rm(dir, { recursive: true, force: true });
  }
});
