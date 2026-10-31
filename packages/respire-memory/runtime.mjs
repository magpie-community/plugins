import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

export const STORE_PREFIX = /^(?:记|存|记录|记住|remember)\s*[:：]\s*/i;
export const SKIP_PREFIX = /^(?:\/nomem|#nomem)(?=\s|$)/i;
export const bytes = text => Buffer.byteLength(text, 'utf8');
export const validId = id => typeof id === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id);
export const containsSecret = text => /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\b(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}|\b(?:sk|rk)_live_[A-Za-z0-9]{8,}|\bAIza[0-9A-Za-z_-]{35}\b|\bAKIA[0-9A-Z]{16}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]+:[^\s/?#@]+@|(?:[\w-]*(?:pass(?:word|wd)|pwd|api[_ -]?key|access[_ -]?key|token|authorization|secret|private[_ -]?key)|密码|口令|私钥)["']?\s*[:=：]\s*\S+/iu.test(text);

export function hasSecret(value) {
  if (typeof value === 'string') return containsSecret(value);
  if (Array.isArray(value)) return value.some(hasSecret);
  return value && typeof value === 'object' ? Object.entries(value).some(([key, item]) =>
    containsSecret(`${key}: ${typeof item === 'string' ? item : '[value]'}`) || hasSecret(item)) : false;
}

export class Failure extends Error {
  constructor(code) { super(`Respire ${code}`); this.code = code; }
}

export function options(raw = {}) {
  const url = new URL(raw.runtimeUrl ?? 'http://127.0.0.1:15169');
  // Only literal loopback hosts: no DNS aliases, proxies, credentials or redirects.
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.href.includes('@') || url.search || url.hash || url.pathname !== '/') throw new Failure('invalid');
  const o = { url: url.href, project: raw.project ?? '', timeout: raw.requestTimeoutMs ?? 1500,
    maxBytes: raw.maxBytes ?? 8000, limit: raw.limit ?? 3, remember: raw.remember ?? true, capture: raw.capture ?? false,
    readOnly: raw.readOnly ?? false, archive: raw.archive ?? false, showMemoryStatus: raw.showMemoryStatus ?? true,
    injectRules: raw.injectRules ?? true, stateDir: raw.stateDir ?? '', generationBaseUrl: raw.generationBaseUrl ?? '',
    generationModel: raw.generationModel ?? '', authorizationEnv: raw.authorizationEnv ?? 'RESPIRE_MAGPIE_AUTHORIZATION' };
  if (typeof o.project !== 'string' || o.project.length > 256 || /[\x00-\x1f\x7f]/.test(o.project) ||
      typeof o.remember !== 'boolean' || typeof o.capture !== 'boolean' ||
      !Number.isInteger(o.timeout) || o.timeout < 100 || o.timeout > 5000 ||
      !Number.isInteger(o.maxBytes) || o.maxBytes < 1024 || o.maxBytes > 32768 ||
      !Number.isInteger(o.limit) || o.limit < 1 || o.limit > 5) throw new Failure('invalid');
  for (const key of ['readOnly', 'archive', 'showMemoryStatus', 'injectRules']) if (typeof o[key] !== 'boolean') throw new Failure('invalid');
  for (const key of ['stateDir', 'generationBaseUrl', 'generationModel', 'authorizationEnv']) if (typeof o[key] !== 'string' || o[key].length > 2048 || /[\x00-\x1f\x7f]/.test(o[key])) throw new Failure('invalid');
  if (o.stateDir && !isAbsolute(o.stateDir)) throw new Failure('invalid');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(o.authorizationEnv)) throw new Failure('invalid');
  if (o.generationBaseUrl) {
    const generation = new URL(o.generationBaseUrl);
    if (generation.href.includes('@') || generation.search || generation.hash || !(generation.protocol === 'https:' ||
        generation.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(generation.hostname))) throw new Failure('invalid');
  }
  return o;
}

export async function rpc(o, args, signal) {
  const id = randomUUID();
  const combined = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(o.timeout)]);
  let response;
  try {
    response = await fetch(new URL('api/rpc', o.url), { method: 'POST', redirect: 'error', signal: combined,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'respire-magpie/0.1.0' },
      body: JSON.stringify({ v: 1, id, method: 'cli.exec', args: ['--json', ...args], queue_wait_ms: Math.min(500, o.timeout) }) });
  } catch { throw new Failure('unavailable'); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Failure([401, 403].includes(response.status) ? 'unauthorized' : 'unavailable');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Failure('invalid');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 512 * 1024) { await reader.cancel(); throw new Failure('invalid'); }
      chunks.push(value);
    }
  } catch (error) { throw error instanceof Failure ? error : new Failure('unavailable'); }
  finally { reader.releaseLock(); }
  let result;
  try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new Failure('invalid'); }
  if (!result || result.v !== 1 || result.id !== id) throw new Failure('invalid');
  const pending = result.ok === false && result.exit === 2 && result.envelope?.status === 'pending';
  if (!pending && (result.ok !== true || result.exit !== 0)) throw new Failure(result.code === 'daemon_unavailable' ? 'unavailable' : 'invalid');
  if (!result.envelope || !['ok', 'pending', 'skip'].includes(result.envelope.status)) throw new Failure('invalid');
  return result.envelope;
}

export function receipt(doc) {
  if (doc.status === 'skip') return { status: 'skipped', message: '引擎跳过存储，遵循其只读或暂停状态。' };
  if (doc.status === 'ok' && validId(doc.summary?.id)) return { status: 'stored', id: doc.summary.id };
  if (doc.status === 'pending') return { status: 'pending', message: '尚未写入；需读候选后决定更新、合并或挂靠，不要强制重复存储。',
    candidates: (Array.isArray(doc.items) ? doc.items : []).slice(0, 5).filter(x => !containsSecret(JSON.stringify(x))).map(x => ({ name: String(x.name).slice(0, 80), value: String(x.value).slice(0, 180) })) };
  return { status: 'uncertain', message: '结果未确认，可能已写入；请先查库，禁止自动重试。' };
}
