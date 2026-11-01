import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, rename, unlink, access } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, extname } from 'node:path';
import { loadDetector, parseNumbers, type Detector } from '../vendor/lmfpd-sdk/index.js';
import { options, type Options } from './config';
import { Gateway, accountHeader } from './gateway';
import { Store } from './store';
import { boundedText, BodyTooLargeError } from './http';
import { normalizeChatStream } from './sse';
import { serviceIdentity, VERSION } from './service-identity';
import { createJob, runJob } from './detector';
import { demoModels, demoHistory, demoAnalysis } from './demo';
import type { Account, Job, Model, Provenance, TargetResult, RunConfig } from './types';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(data, { status, headers });
const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const isTerminal = (job: Job) => !['queued', 'running'].includes(job.state);
const uuid = () => crypto.randomUUID();
type SampleTicket = {
  job: Job;
  result: TargetResult;
  index: number;
  secret: string;
  controller: AbortController;
  used: boolean;
  done: Promise<void>;
  finish: () => void;
};

export async function startServer(input: Options = {}) {
  const opt = options(input);
  const gateway = new Gateway(opt.gateway, opt.apiKey);
  const store = new Store(join(opt.dataDir, opt.demo ? 'demo-jobs' : 'jobs'));
  const token = randomBytes(32).toString('hex');
  const active = new Map<string, AbortController>();
  const tickets = new Map<string, SampleTicket>();
  const listeners = new Map<string, Set<(job: Job) => void>>();
  let detector: Detector | undefined,
    bankError = '',
    loading: Promise<Detector | undefined> | undefined;
  let models: Model[] = [],
    accounts: Account[] = [],
    catalogError = '';
  let closed = false,
    creatingJob = false;
  let modelCount: number | undefined;
  const emit = (job: Job) => {
    for (const fn of listeners.get(job.id) || []) fn(job);
  };
  const persist = async (job: Job) => {
    emit(job);
    await store.save(job);
  };
  async function ensureDetector(force = false) {
    if (opt.demo) return undefined;
    if (detector && !force) return detector;
    if (loading) return loading;
    loading = (async () => {
      try {
        await mkdir(opt.dataDir, { recursive: true, mode: 0o700 });
        const cache = join(
          opt.dataDir,
          force && (!opt.bankSource || /^https?:\/\//i.test(opt.bankSource))
            ? `reference-refresh-${uuid()}.bin`
            : 'reference.bin',
        );
        try {
          const next = await loadDetector({
            ...(opt.bankSource ? { source: opt.bankSource } : {}),
            cache,
            // Cached data never schedules the SDK's background refresh.
            // Only an explicit download action replaces the cached snapshot.
            ttl: Infinity,
          });
          if (force && cache !== join(opt.dataDir, 'reference.bin'))
            await rename(cache, join(opt.dataDir, 'reference.bin'));
          detector = next;
          try {
            const bytes = await readFile(join(opt.dataDir, 'reference.bin'));
            modelCount = JSON.parse(bytes.subarray(4, 4 + bytes.readUInt32LE(0)).toString()).models
              ?.length;
          } catch {
            /* Local reference directories need no downloaded cache. */
          }
        } finally {
          if (force && cache !== join(opt.dataDir, 'reference.bin'))
            await unlink(cache).catch(() => {});
        }
        bankError = '';
        return detector;
      } catch (e) {
        bankError = gateway.redact(e);
        return undefined;
      } finally {
        loading = undefined;
      }
    })();
    return loading;
  }
  function bankInfo() {
    return opt.demo
      ? { builtAt: 'Demo reference data', modelCount: 64 }
      : detector
        ? { builtAt: detector.builtAt, modelCount }
        : null;
  }
  async function bankStatus() {
    if (opt.demo || detector) return { state: 'ready' as const };
    const localSource = opt.bankSource && !/^https?:\/\//i.test(opt.bankSource);
    const file = localSource
      ? join(opt.bankSource!, 'unified_bank.json')
      : join(opt.dataDir, 'reference.bin');
    const cached = await access(file).then(
      () => true,
      () => false,
    );
    return { state: cached ? ('cached' as const) : ('missing' as const) };
  }
  async function catalog() {
    if (opt.demo) {
      models = demoModels;
      accounts = [];
      return { models, accounts };
    }
    try {
      const result = await gateway.catalog();
      models = result.models;
      accounts = result.accounts;
      catalogError = '';
      return result;
    } catch (e) {
      catalogError = gateway.redact(e);
      return { models: [], accounts: [] };
    }
  }
  // The SDK talks only to this private, one-shot, job-bound transport. It is
  // never exposed through Magpie's page service and cannot select a URL/model.
  const transport = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.headers.get('host') !== url.host || url.hostname !== '127.0.0.1')
        return new Response('Forbidden', { status: 403 });
      const match = url.pathname.match(
        /^\/sample\/([\w-]+)\/v1\/(responses|chat\/completions|messages)$/,
      );
      const ticket = match ? tickets.get(match[1]) : undefined;
      if (!ticket || req.method !== 'POST' || ticket.used || ticket.controller.signal.aborted)
        return new Response('Unknown sample', { status: 404 });
      const key =
        req.headers.get('authorization')?.replace(/^Bearer /, '') ||
        req.headers.get('x-api-key') ||
        '';
      if (!equal(key, ticket.secret)) return new Response('Unauthorized', { status: 401 });
      ticket.used = true;
      const { job, result, index, controller } = ticket;
      const provenance: Provenance = {
        session: `fp-${uuid()}`,
        requestedModel: result.target.model,
      };
      result.provenance[index] = provenance;
      let finishing: Promise<void> | undefined;
      const finish = () =>
        (finishing ??= (async () => {
          try {
            await gateway.route(provenance);
            emit(job);
          } finally {
            ticket.finish();
          }
        })());
      try {
        const payload = await boundedText(req, 16384);
        if (payload.length > 16384) throw new Error('Sample request too large.');
        const body = JSON.parse(payload);
        if (body.model !== result.target.model)
          throw new Error('Sample model does not match its job.');
        const expected = {
          responses: 'responses',
          chat_completions: 'chat/completions',
          messages: 'messages',
        }[result.api];
        if (match![2] !== expected) throw new Error('Sample protocol does not match its job.');
        const startedAt = Date.now();
        const headers = gateway.headers({
          'X-Magpie-Session': provenance.session,
          ...(result.target.account
            ? { 'X-Magpie-Account': accountHeader(result.target.account) }
            : {}),
        });
        for (const name of ['anthropic-version', 'anthropic-beta', 'accept']) {
          const value = req.headers.get(name);
          if (value) (headers as Record<string, string>)[name] = value;
        }
        const upstream = await fetch(`${gateway.url}/v1/${expected}`, {
          method: 'POST',
          headers,
          body: payload,
          signal: controller.signal,
          redirect: 'error',
          timeout: false,
        });
        provenance.provider = upstream.headers.get('X-Magpie-Provider') || undefined;
        provenance.model = upstream.headers.get('X-Magpie-Model') || undefined;
        provenance.mismatch = !!(
          (provenance.model && provenance.model !== result.target.model) ||
          (provenance.provider && provenance.provider !== result.target.model.split('/')[0])
        );
        if (!upstream.ok || !upstream.body) {
          await upstream.body?.cancel();
          await finish();
          return json(
            {
              error: {
                message: `Magpie returned HTTP ${upstream.status}. Inspect Magpie's request log for details.`,
              },
            },
            upstream.ok ? 502 : upstream.status,
          );
        }
        let ended = false,
          text = '',
          lineBuffer = '',
          totalBytes = 0;
        const responseBody =
          result.api === 'chat_completions' &&
          upstream.headers.get('content-type')?.includes('text/event-stream')
            ? normalizeChatStream(upstream.body, () => {
                provenance.streamNormalization = 'chat-done-after-stop';
              })
            : upstream.body;
        const reader = responseBody.getReader();
        let lastEmit = 0;
        const decoder = new TextDecoder();
        const recordChunk = (bytes: Uint8Array) => {
          const sample = result.samples[index];
          if (!sample) return;
          totalBytes += bytes.byteLength;
          if (totalBytes > 2 * 1024 * 1024)
            throw new Error('Sample exceeded the 2 MiB response limit.');
          sample.state = 'streaming';
          sample.first_byte_ms ??= Date.now() - startedAt;
          lineBuffer += decoder.decode(bytes, { stream: true });
          let newline: number;
          while ((newline = lineBuffer.indexOf('\n')) >= 0) {
            const line = lineBuffer.slice(0, newline).trim();
            lineBuffer = lineBuffer.slice(newline + 1);
            if (!line.startsWith('data:')) continue;
            try {
              const event = JSON.parse(line.slice(5));
              const delta =
                event.choices?.[0]?.delta?.content ??
                (event.type === 'response.output_text.delta' ? event.delta : undefined) ??
                (event.type === 'content_block_delta' ? event.delta?.text : undefined);
              if (typeof delta === 'string') text += delta;
            } catch {
              /* SSE metadata and [DONE] are not sample text. */
            }
          }
          if (text.length > 100000 || lineBuffer.length > 100000)
            throw new Error('Sample text exceeded the response limit.');
          sample.raw_text = text;
          sample.count = parseNumbers(text).length;
          if (Date.now() - lastEmit > 150) {
            lastEmit = Date.now();
            emit(job);
          }
        };
        const stream = new ReadableStream<Uint8Array>({
          async pull(out) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                ended = true;
                await finish();
                out.close();
              } else {
                recordChunk(chunk.value);
                out.enqueue(chunk.value);
              }
            } catch (e) {
              await reader.cancel().catch(() => {});
              if (!ended) {
                ended = true;
                await finish();
              }
              out.error(e);
            }
          },
          async cancel() {
            if (!ended) {
              ended = true;
              await reader.cancel().catch(() => {});
              await finish();
            }
          },
        });
        return new Response(stream, {
          headers: {
            'content-type': upstream.headers.get('content-type') || 'text/event-stream',
            'cache-control': 'no-store',
          },
        });
      } catch (e) {
        await finish();
        return json(
          {
            error: {
              message: controller.signal.aborted
                ? 'Detection cancelled or deadline exceeded.'
                : gateway.redact(e),
            },
          },
          502,
        );
      }
    },
  });

  async function launch(job: Job, engine?: Detector) {
    const controller = new AbortController();
    active.set(job.id, controller);
    const timer = setTimeout(
      () => controller.abort(new Error('Job deadline exceeded')),
      job.config.deadlineSeconds * 1000,
    );
    try {
      if (opt.demo) {
        job.demo = true;
        job.state = 'running';
        await persist(job);
        for (const r of job.results) {
          r.state = 'running';
          for (let i = 0; i < 3; i++) {
            if (controller.signal.aborted) break;
            r.samples[i] = {
              state: 'streaming',
              text: '',
              raw_text: '',
              count: 0,
              expected_count: job.challenges[i].expected_count,
              first_byte_ms: 650,
              response_model: r.target.model.split('/')[1],
              response_id: 'demo',
              error: null,
            };
            emit(job);
            await Bun.sleep(350);
            r.samples[i] = {
              ...r.samples[i],
              state: 'complete',
              text: '137, 42, 291, 65, 188',
              raw_text: '137, 42, 291, 65, 188 (illustrative excerpt)',
              count: job.challenges[i].expected_count,
            };
            r.provenance[i] = {
              session: `demo-${i}`,
              requestedModel: r.target.model,
              model: r.target.model,
              provider: r.target.model.split('/')[0],
            };
            emit(job);
          }
          r.state = controller.signal.aborted ? 'cancelled' : 'completed';
          r.analysis = controller.signal.aborted ? null : demoAnalysis(r.target.model);
          await persist(job);
          if (controller.signal.aborted) break;
        }
        job.state = controller.signal.aborted ? 'cancelled' : 'completed';
        job.finishedAt = new Date().toISOString();
      } else {
        if (!engine) throw new Error(bankError || 'Reference data is not loaded.');
        await runJob(job, {
          detector: engine,
          signal: controller.signal,
          sampleEndpoint: (result, index) => {
            const id = uuid();
            let finish!: () => void;
            const done = new Promise<void>((r) => {
              finish = r;
            });
            const ticket: SampleTicket = {
              job,
              result,
              index,
              secret: randomBytes(32).toString('hex'),
              controller,
              used: false,
              done,
              finish,
            };
            tickets.set(id, ticket);
            return {
              baseUrl: `http://127.0.0.1:${transport.port}/sample/${id}/v1`,
              apiKey: ticket.secret,
            };
          },
          afterSample: async (result, index) => {
            const entry = [...tickets.values()].find(
              (t) => t.job === job && t.result === result && t.index === index,
            );
            if (entry?.used) await Promise.race([entry.done, Bun.sleep(3500)]);
          },
          onUpdate: () => persist(job),
        });
      }
    } catch (e) {
      job.state = controller.signal.aborted ? 'cancelled' : 'failed';
      job.error = gateway.redact(e);
      job.finishedAt = new Date().toISOString();
    } finally {
      clearTimeout(timer);
      active.delete(job.id);
      if (controller.signal.aborted && !job.error)
        job.error = errorText(controller.signal.reason || 'Cancelled');
      for (const [id, t] of tickets)
        if (t.job === job) {
          t.finish();
          tickets.delete(id);
        }
      for (const r of job.results)
        if (r.state === 'running' || r.state === 'queued') {
          r.state = 'cancelled';
          r.analysis = null;
        }
      await persist(job);
    }
  }
  const uiDir =
    opt.uiDir || resolve(import.meta.dir, import.meta.dir.endsWith('/src') ? '../dist/ui' : 'ui');
  let server: ReturnType<typeof Bun.serve>;
  let initialized = Promise.resolve();
  try {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: opt.port,
      idleTimeout: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const own = `127.0.0.1:${server.port}`;
        const host = req.headers.get('host');
        if (host !== own && host !== `localhost:${server.port}`)
          return new Response('Invalid host', { status: 403 });
        const origin = req.headers.get('origin');
        if (
          origin &&
          origin !== 'null' &&
          origin !== `http://${own}` &&
          origin !== `http://localhost:${server.port}`
        )
          return new Response('Invalid origin', { status: 403 });
        const cors: Record<string, string> = {
          'access-control-allow-origin': origin || '*',
          'access-control-allow-headers': 'Authorization, Content-Type',
          'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
          vary: 'Origin',
          'cache-control': 'no-store',
        };
        if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
        if (url.pathname === '/_fingerprint/health' && req.method === 'GET')
          return json(serviceIdentity(opt), 200, cors);
        await initialized;
        const api = url.pathname.startsWith('/api/');
        if (api && !equal(req.headers.get('authorization')?.replace(/^Bearer /, '') || '', token))
          return json({ error: 'Unauthorized' }, 401, cors);
        try {
          let response: Response;
          if (api) {
            const path = url.pathname;
            if (path === '/api/bootstrap' && req.method === 'GET') {
              const cat = await catalog();
              response = json({
                version: VERSION,
                demo: opt.demo,
                ...cat,
                jobs: store.list(),
                bank: bankInfo(),
                bankStatus: await bankStatus(),
                gateway: {
                  url: opt.gateway,
                  reachable: opt.demo || !catalogError,
                  ...(catalogError ? { error: catalogError } : {}),
                },
                ...(bankError ? { bankError } : {}),
              });
            } else if (path === '/api/models' && req.method === 'GET')
              response = json(await catalog());
            else if (path === '/api/jobs' && req.method === 'GET') response = json(store.list());
            else if (path === '/api/jobs' && req.method === 'POST') {
              if (active.size || creatingJob)
                return json({ error: 'A detection batch is already running.' }, 409, cors);
              creatingJob = true;
              try {
                if (store.jobs.size >= 200)
                  return json(
                    {
                      error:
                        'History limit reached (200 batches). Export and delete older batches first.',
                    },
                    409,
                    cors,
                  );
                if (Number(req.headers.get('content-length') || 0) > 16384)
                  return json({ error: 'Request too large' }, 413, cors);
                const text = await boundedText(req, 16384);
                const config = JSON.parse(text) as RunConfig;
                await catalog();
                // Reject malformed targets before allowing any reference download.
                const job = createJob(config, models, '', accounts);
                const engine = await ensureDetector();
                if (!opt.demo && !engine)
                  return json({ error: bankError || 'Reference data unavailable' }, 503, cors);
                job.bank.builtAt = opt.demo ? 'Demo reference data' : engine!.builtAt;
                if (opt.demo) job.demo = true;
                store.jobs.set(job.id, job);
                await store.save(job);
                void launch(job, engine).catch((e) => {
                  job.state = 'failed';
                  job.error = `Could not save task history: ${gateway.redact(e)}`;
                  emit(job);
                });
                response = json(job, 202);
              } finally {
                creatingJob = false;
              }
            } else if (
              (path === '/api/bank/download' || path === '/api/reload-data') &&
              req.method === 'POST'
            ) {
              await ensureDetector(true);
              response = json(
                {
                  bank: bankInfo(),
                  bankStatus: await bankStatus(),
                  error: bankError || undefined,
                },
                bankError ? 503 : 200,
              );
            } else {
              const m = path.match(/^\/api\/jobs\/([\w-]+)(?:\/(cancel|events|export))?$/);
              const job = m ? store.jobs.get(m[1]) : undefined;
              if (!job) return json({ error: 'Job not found' }, 404, cors);
              if (m![2] === 'cancel' && req.method === 'POST') {
                active.get(job.id)?.abort(new Error('Cancelled by user'));
                response = json(job);
              } else if (m![2] === 'export' && req.method === 'GET')
                response = new Response(
                  JSON.stringify({ schema: 'magpie-fingerprint/v1', ...job }, null, 2),
                  {
                    headers: {
                      'content-type': 'application/json',
                      'content-disposition': `attachment; filename="fingerprint-${job.id}.json"`,
                    },
                  },
                );
              else if (m![2] === 'events' && req.method === 'GET') {
                if ((listeners.get(job.id)?.size || 0) >= 6)
                  return json({ error: 'Too many event subscribers.' }, 429, cors);
                const encoder = new TextEncoder();
                let release = () => {};
                const stream = new ReadableStream<Uint8Array>({
                  start(out) {
                    let finished = false;
                    let beat: ReturnType<typeof setInterval> | undefined;
                    const send = (j: Job) => {
                      if (finished || ((out.desiredSize ?? 0) <= 0 && !isTerminal(j))) return;
                      try {
                        out.enqueue(
                          encoder.encode(`event: snapshot\ndata: ${JSON.stringify(j)}\n\n`),
                        );
                        if (isTerminal(j)) {
                          finished = true;
                          release();
                          out.close();
                        }
                      } catch {
                        finished = true;
                        release();
                      }
                    };
                    const set = listeners.get(job.id) || new Set();
                    set.add(send);
                    listeners.set(job.id, set);
                    release = () => {
                      if (beat) clearInterval(beat);
                      set.delete(send);
                      if (!set.size) listeners.delete(job.id);
                    };
                    beat = setInterval(() => {
                      if (!finished && (out.desiredSize ?? 0) > 0)
                        try {
                          out.enqueue(encoder.encode(': heartbeat\n\n'));
                        } catch {
                          finished = true;
                          release();
                        }
                    }, 15000);
                    req.signal.addEventListener(
                      'abort',
                      () => {
                        finished = true;
                        release();
                        try {
                          out.close();
                        } catch {}
                      },
                      { once: true },
                    );
                    send(job);
                  },
                  cancel() {
                    release();
                  },
                });
                response = new Response(stream, {
                  headers: {
                    'content-type': 'text/event-stream',
                    'x-accel-buffering': 'no',
                  },
                });
              } else if (!m![2] && req.method === 'GET') response = json(job);
              else if (!m![2] && req.method === 'DELETE') {
                if (active.has(job.id))
                  return json({ error: 'Cancel the running batch before deleting it.' }, 409, cors);
                await store.remove(job.id);
                response = json({ ok: true });
              } else response = json({ error: 'Method not allowed' }, 405);
            }
            for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
            return response;
          }
          if (req.method !== 'GET' && req.method !== 'HEAD')
            return new Response('Method not allowed', { status: 405 });
          if (url.pathname === '/' || url.pathname === '/index.html') {
            const uiOrigin = url.searchParams.get('uiOrigin');
            if (uiOrigin) {
              const parsed = new URL(uiOrigin);
              if (
                !['http:', 'https:'].includes(parsed.protocol) ||
                parsed.hostname.includes('*') ||
                parsed.origin !== uiOrigin
              )
                throw new Error('Invalid UI origin.');
            }
            // This document's own origins, named: in magpie's frame the
            // document is sandboxed to an opaque origin, and WebKitGTK
            // (magpie's Linux window) then matches nothing to 'self', so
            // a policy of 'self' alone loads no script, style or image
            // there and the page stays blank.
            const ownSources = [
              ...new Set([`http://${host}`, ...(uiOrigin ? [uiOrigin] : [])]),
            ].join(' ');
            let html = await readFile(join(uiDir, 'index.html'), 'utf8').catch(
              () =>
                '<!doctype html><title>Build required</title><p>Run bun run build to create the Fingerprint interface.</p>',
            );
            const boot = JSON.stringify({
              token,
              initialProvider: url.searchParams.get('provider') || '',
              theme: url.searchParams.get('theme') || '',
              lang: url.searchParams.get('lang') || '',
            }).replaceAll('<', '\\u003c');
            const nonce = randomBytes(16).toString('base64');
            html = html.replace(
              '</head>',
              `<script nonce="${nonce}">window.__FINGERPRINT__=${boot}</script></head>`,
            );
            return new Response(html, {
              headers: {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
                'referrer-policy': 'no-referrer',
                'x-content-type-options': 'nosniff',
                // Opaque sandbox origins cannot reliably match 'self'. The
                // launcher supplies the HTTP(S) origin of Magpie's proxy;
                // it affects this document's CSP only, never API admission.
                'content-security-policy': `default-src 'self' ${ownSources}; connect-src 'self' ${ownSources}; script-src 'self' ${ownSources} 'nonce-${nonce}'; style-src 'self' ${ownSources} 'unsafe-inline'; img-src 'self' ${ownSources} data:; object-src 'none'; base-uri 'none'; form-action 'none'`,
              },
            });
          }
          const decoded = decodeURIComponent(url.pathname);
          const file = resolve(uiDir, `.${decoded}`);
          // inside uiDir by the system's own separator: on Windows resolve
          // gives back slashes, and a check for "/" refused every asset
          const inside = relative(resolve(uiDir), file);
          if (!inside || inside.startsWith('..') || isAbsolute(inside) || decoded.includes('..'))
            return new Response('Not found', { status: 404 });
          const asset = Bun.file(file);
          if (!(await asset.exists())) return new Response('Not found', { status: 404 });
          const mime: Record<string, string> = {
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
            '.woff2': 'font/woff2',
          };
          return new Response(asset, {
            headers: {
              'content-type': mime[extname(file)] || 'application/octet-stream',
              'access-control-allow-origin': '*',
              'x-content-type-options': 'nosniff',
            },
          });
        } catch (e) {
          return json(
            { error: gateway.redact(e) },
            e instanceof BodyTooLargeError ? 413 : 400,
            cors,
          );
        }
      },
    });
  } catch (e) {
    transport.stop(true);
    throw e;
  }
  initialized = (async () => {
    // Only the process that owns the listening port may repair persisted jobs.
    await store.load();
    if (opt.demo && !store.jobs.size) {
      const job = demoHistory();
      store.jobs.set(job.id, job);
    }
  })();
  try {
    await initialized;
  } catch (error) {
    server.stop(true);
    transport.stop(true);
    throw error;
  }
  return {
    port: server.port,
    demo: opt.demo,
    async close() {
      if (closed) return;
      closed = true;
      for (const c of active.values()) c.abort(new Error('Plugin service stopped'));
      while (active.size) await Bun.sleep(20);
      await store.flush();
      server.stop(true);
      transport.stop(true);
    },
  };
}
