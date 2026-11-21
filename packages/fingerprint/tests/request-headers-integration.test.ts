import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server';
import { cacheFixture } from './bank-fixture';

test('batch headers reach every sampler protocol but never metadata, another run or history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fingerprint-headers-'));
  const samples: {
    path: string;
    userAgent: string | null;
    client: string | null;
    auth: string | null;
  }[] = [];
  const metadata: { path: string; client: string | null }[] = [];
  const gateway = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === 'POST') {
        samples.push({
          path,
          userAgent: req.headers.get('user-agent'),
          client: req.headers.get('x-client-name'),
          auth: req.headers.get('authorization'),
        });
        const chunk = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
        const body = path.endsWith('/messages')
          ? chunk({
              type: 'message_start',
              message: { id: 'test', model: 'model', usage: { input_tokens: 1, output_tokens: 0 } },
            }) +
            chunk({
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            }) +
            chunk({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: '1, 2, 3' },
            }) +
            chunk({ type: 'content_block_stop', index: 0 }) +
            chunk({
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 3 },
            }) +
            chunk({ type: 'message_stop' })
          : path.endsWith('/responses')
            ? chunk({ type: 'response.output_text.delta', delta: '1, 2, 3' }) +
              chunk({
                type: 'response.completed',
                response: { id: 'test', model: 'model', status: 'completed' },
              })
            : chunk({ choices: [{ delta: { content: '1, 2, 3' } }] }) +
              chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
              'data: [DONE]\n\n';
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      }
      metadata.push({ path, client: req.headers.get('x-client-name') });
      return path === '/v1/models'
        ? Response.json({
            data: [{ id: 'provider/model', native_endpoints: ['/v1/chat/completions'] }],
          })
        : Response.json({ data: [] });
    },
  });
  let service: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await mkdir(join(dir, 'ui'));
    await writeFile(join(dir, 'ui/index.html'), '<head></head>');
    await writeFile(join(dir, 'reference.bin'), cacheFixture());
    service = await startServer({
      port: 0,
      dataDir: dir,
      uiDir: join(dir, 'ui'),
      gateway: `http://127.0.0.1:${gateway.port}`,
      apiKey: 'gateway-key',
      bankSource: 'http://127.0.0.1:9/',
    });
    const base = `http://127.0.0.1:${service.port}`;
    const html = await (await fetch(base)).text();
    const token = JSON.parse(html.match(/window\.__FINGERPRINT__=(.*?)<\/script>/)![1]).token;
    const api = (path: string, init: RequestInit = {}) =>
      fetch(`${base}/api/${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      });
    const metadataBeforeInvalid = metadata.length;
    for (const headers of [
      { Authorization: 'do-not-echo-this-value' },
      { 'X-Client-Name': 'do-not-echo-this-value\r\nInjected: true' },
    ]) {
      const response = await api('jobs', {
        method: 'POST',
        body: JSON.stringify({ targets: [{ model: 'provider/model' }], headers }),
      });
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain('do-not-echo-this-value');
    }
    expect(metadata).toHaveLength(metadataBeforeInvalid);
    expect(samples).toHaveLength(0);
    for (const [index, protocol] of [
      'chat_completions',
      'responses',
      'messages',
      'chat_completions',
    ].entries()) {
      const headers =
        index < 3
          ? { 'User-Agent': 'coding-client/1.0', 'X-Client-Name': 'run-only-value' }
          : undefined;
      const response = await api('jobs', {
        method: 'POST',
        body: JSON.stringify({
          targets: [{ model: 'provider/model' }],
          api: protocol,
          effort: '',
          serviceTier: 'default',
          strict: false,
          targetParallel: 1,
          sampleParallel: 3,
          deadlineSeconds: 10,
          ...(headers ? { headers } : {}),
        }),
      });
      expect(response.status).toBe(202);
      const { id } = await response.json();
      let job: any;
      for (let attempt = 0; attempt < 500; attempt++) {
        job = await (await api(`jobs/${id}`)).json();
        if (!['queued', 'running'].includes(job.state)) break;
        await Bun.sleep(10);
      }
      expect(['queued', 'running']).not.toContain(job.state);
      expect(job.config.headers).toBeUndefined();
      expect(job.config.headerNames).toEqual(headers ? ['user-agent', 'x-client-name'] : undefined);
      expect(await (await api(`jobs/${id}/export`)).text()).not.toContain('run-only-value');
      expect(await readFile(join(dir, 'jobs', `${id}.json`), 'utf8')).not.toContain(
        'run-only-value',
      );
    }
    expect(samples).toHaveLength(12);
    for (const sample of samples.slice(0, 9)) {
      expect(sample.userAgent).toBe('coding-client/1.0');
      expect(sample.client).toBe('run-only-value');
      expect(sample.auth).toBe('Bearer gateway-key');
    }
    expect(new Set(samples.slice(0, 9).map((sample) => sample.path))).toEqual(
      new Set(['/v1/chat/completions', '/v1/responses', '/v1/messages']),
    );
    expect(samples.slice(9).every((sample) => sample.client === null)).toBe(true);
    expect(metadata.every((request) => request.client === null)).toBe(true);
    expect(await (await api('bootstrap')).text()).not.toContain('run-only-value');
  } finally {
    await service?.close();
    gateway.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});
