import M from './page/model.js';
export const ENDPOINT = 'https://codex-resets.com/api/v1/status';
export const INTERVAL = 5 * 60e3;
const MAX_BODY = 64 * 1024, MAX_RETRY = 24 * 3600e3;
function retryAfter(value, now) {
  const ms = /^\d+$/.test(value || '') ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.max(INTERVAL, Math.min(MAX_RETRY, ms)) : INTERVAL;
}
async function json(response) {
  if (!response.body) throw new Error('Empty response');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) throw new Error('Response too large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
// Retain only public fields the page needs; never persist arbitrary extra data.
function compact(payload) {
  const pick = (x, keys) => x === null ? null : Object.fromEntries(keys.filter(k => Object.hasOwn(x, k)).map(k => [k, x[k]]));
  const event = (x, keys) => x === null ? null : { ...pick(x, keys), source: pick(x.source, ['type', 'author', 'url']) };
  return {
    meta: pick(payload.meta, ['api_version', 'generated_at']),
    data: {
      scheduled_reset: event(payload.data.scheduled_reset, ['id', 'status', 'reset_type', 'announced_at', 'scheduled_for']),
      latest_reset: event(payload.data.latest_reset, ['id', 'reset_type', 'announced_at']),
    },
  };
}
// One bounded check. Page-lifetime coordination, transport and plugin-scoped publication are
// supplied by the caller; importing this module starts no process or request.
// The Magpie host adapter is pending yetone/magpie#3609.
export async function syncOnce({ now = Date.now(), options = {}, request, save, signal }) {
  if (typeof request !== 'function') throw new TypeError('An explicit transport is required');
  if (typeof save !== 'function') throw new TypeError('Plugin-scoped publication is required');
  signal?.throwIfAborted();
  const prior = options.codexResets;
  const next = Date.parse(prior?.nextCheckAt);
  if (Number.isFinite(next) && next > now && next - now <= MAX_RETRY) return { changed: false, nextCheckAt: next };
  const checkedAt = new Date(now).toISOString();
  const notified = Array.isArray(prior?.notified) ? prior.notified.filter(x => typeof x === 'string' && x.length < 120).slice(-64) : [];
  let delay = INTERVAL, payload = null, error = '', notice = null;
  try {
    const timeout = AbortSignal.timeout(8000);
    const response = await request(ENDPOINT, { method: 'GET', headers: { Accept: 'application/json' },
      credentials: 'omit', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    delay = retryAfter(response.headers.get('retry-after'), now);
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    const wire = await json(response), data = M.parse(wire, now);
    payload = compact(wire);
    const a = data.announcement;
    if (a && (!a.scheduledFor || Date.parse(a.scheduledFor) > now)) {
      const id = `${a.id}:${a.scheduledFor || 'unknown'}`;
      if (!notified.includes(id)) { notice = a; notified.push(id); }
    }
  } catch (e) {
    if (signal?.aborted) throw e;
    // Do not display old announcements while the source cannot be verified.
    error = 'Public status could not be verified. Check the source and try again later.';
  }
  const record = { version: 1, checkedAt, nextCheckAt: new Date(now + delay).toISOString(), payload, error, notified: notified.slice(-64) };
  // A failed save must surface to the caller. Do not report a published update.
  signal?.throwIfAborted();
  await save({ ...options, codexResets: record });
  return { changed: true, nextCheckAt: now + delay, error, notice };
}
