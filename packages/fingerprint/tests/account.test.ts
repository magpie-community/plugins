import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server';
import { cacheFixture } from './bank-fixture';

// StockRabbit's case (plugins#615): Magpie 0.1.2587, workbuddy's
// deepseek-v4.1-flash, an account named 北冥 beside one named by its email.
const MODEL = 'workbuddy/deepseek-v4.1-flash';
const config = (account: string) => ({
  targets: [{ model: MODEL, account }],
  api: 'auto',
  effort: '',
  serviceTier: 'default',
  strict: true,
  targetParallel: 1,
  sampleParallel: 3,
  deadlineSeconds: 30,
});
// a job saved by 0.2.1, as the issue quotes it: no account anywhere
const oldJob = {
  id: 'old-job-0-2-1',
  createdAt: '2026-11-01T00:00:00.000Z',
  finishedAt: '2026-11-01T00:01:00.000Z',
  state: 'completed',
  config: { ...config(''), targets: [{ model: MODEL }] },
  challenges: [],
  results: [
    {
      id: 'target-1',
      target: { model: MODEL },
      api: 'chat_completions',
      state: 'completed',
      samples: [],
      provenance: [],
      analysis: null,
      error: null,
    },
  ],
  bank: { builtAt: 'test-snapshot', sdk: '0.2.0' },
};

test('a run pinned to 北冥 reaches Magpie and its job file names the account', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fingerprint-account-test-'));
  const pins: string[] = [];
  const gateway = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/v1/models')
        return Response.json({
          data: [{ id: MODEL, native_endpoints: ['/v1/chat/completions'] }],
        });
      if (url.pathname === '/v1/magpie/quotas')
        return Response.json({
          data: [
            { provider: 'workbuddy', name: 'WorkBuddy', kind: 'subscription', user: '北冥' },
            {
              provider: 'workbuddy',
              name: 'WorkBuddy',
              kind: 'subscription',
              user: 'csmlovenn@gmail.com',
            },
          ],
        });
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        pins.push(req.headers.get('x-magpie-account') || '');
        const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
        return new Response(
          chunk({ choices: [{ delta: { content: '1, 2, 3' } }] }) +
            chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
            'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response('not here', { status: 404 });
    },
  });
  let service: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await mkdir(join(dir, 'ui'));
    await writeFile(join(dir, 'ui/index.html'), '<head></head>');
    await writeFile(join(dir, 'reference.bin'), cacheFixture());
    await utimes(join(dir, 'reference.bin'), new Date(0), new Date(0));
    await mkdir(join(dir, 'jobs'));
    await writeFile(join(dir, 'jobs', `${oldJob.id}.json`), JSON.stringify(oldJob));
    service = await startServer({
      port: 0,
      dataDir: dir,
      uiDir: join(dir, 'ui'),
      gateway: `http://127.0.0.1:${gateway.port}`,
      apiKey: 'gateway-secret',
      bankSource: 'http://127.0.0.1:9/',
      demo: false,
    });
    const base = `http://127.0.0.1:${service.port}`;
    const html = await (await fetch(base)).text();
    const token = JSON.parse(html.match(/window\.__FINGERPRINT__=(.*?)<\/script>/)![1]).token;
    const api = (path: string, init: RequestInit = {}) =>
      fetch(`${base}/api/${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      });

    const boot = await (await api('bootstrap')).json();
    // the old job loads as it was saved
    expect(boot.jobs.map((j: { id: string }) => j.id)).toContain(oldJob.id);
    const old = boot.jobs.find((j: { id: string }) => j.id === oldJob.id);
    expect(old.config.account).toBeUndefined();
    expect(old.results[0].target).toEqual({ model: MODEL });
    // the account selector names the seat, not the provider
    expect(boot.accounts).toContainEqual({ provider: 'workbuddy', id: '北冥', name: '北冥' });

    const created = await api('jobs', { method: 'POST', body: JSON.stringify(config('北冥')) });
    expect(created.status).toBe(202);
    const { id } = await created.json();
    let job: any;
    for (let i = 0; i < 500; i++) {
      job = await (await api(`jobs/${id}`)).json();
      if (!['queued', 'running'].includes(job.state)) break;
      await Bun.sleep(10);
    }
    // every sample reached Magpie, pinned to 北冥 percent-encoded
    expect(pins).toEqual(['%E5%8C%97%E5%86%A5', '%E5%8C%97%E5%86%A5', '%E5%8C%97%E5%86%A5']);
    expect(pins.map(decodeURIComponent)).toEqual(['北冥', '北冥', '北冥']);
    for (const sample of job.results[0].samples)
      expect(String(sample.error ?? '')).not.toMatch(/invalid value/i);
    await service.close();
    service = undefined;
    const saved = JSON.parse(await readFile(join(dir, 'jobs', `${id}.json`), 'utf8'));
    expect(saved.config.account).toBe('北冥');
    expect(saved.config.accountName).toBe('北冥');
    expect(saved.config.targets[0]).toEqual({ model: MODEL, account: '北冥', accountName: '北冥' });
    expect(saved.results[0].target).toEqual({ model: MODEL, account: '北冥', accountName: '北冥' });
  } finally {
    await service?.close();
    gateway.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});
