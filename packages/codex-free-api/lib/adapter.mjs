import { sanitizeRequest, upstreamHeaders } from '../vendor/sanitize.mjs';

const BASE = 'https://api.openai.com/v1';
const PROVIDER = 'codex-free-api-quota';
const routes = [
  ['GET', /^\/v1\/models(?:\/[A-Za-z0-9_.:-]+)?$/],
  ['POST', /^\/v1\/(?:responses(?:\/(?:compact|input_tokens))?|chat\/completions|embeddings)$/],
  ['GET', /^\/v1\/responses\/[A-Za-z0-9_-]+(?:\/input_items)?$/],
  ['DELETE', /^\/v1\/responses\/[A-Za-z0-9_-]+$/],
  ['POST', /^\/v1\/responses\/[A-Za-z0-9_-]+\/cancel$/],
];
const queryKeys = new Set(['after', 'before', 'limit', 'order', 'include', 'include[]', 'stream', 'starting_after']);

function integer(value, fallback, min, max, name) {
  const number = value ?? fallback;
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${name} 必须为 ${min}–${max} 之间的整数`);
  return number;
}

function keyConfig(auth) {
  const apiKey = auth?.type === 'api' ? auth.key?.trim() : '';
  if (!apiKey || /\s/.test(apiKey)) throw new Error('请在 Magpie 中设置有效的 OpenAI 官方 API Key');
  const values = { apiKey, organization: auth.metadata?.organization?.trim() || '', project: auth.metadata?.project?.trim() || '' };
  if ([values.organization, values.project].some(value => value && !/^[A-Za-z0-9_-]+$/.test(value))) throw new Error('OpenAI Organization / Project ID 格式无效');
  return values;
}

function failure(status, message, type = 'invalid_request_error') {
  return Response.json({ error: { message, type } }, { status });
}

async function readBounded(body, maxBytes) {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RangeError('Body exceeds configured limit');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    reader.releaseLock();
  }
}

// The host supplies its account-scoped fetch, preserving Magpie's proxy and cancellation.
export function createCleanFetch(getAuth, options = {}, fetchImpl = globalThis.fetch) {
  const timeoutMs = integer(options.timeoutMs, 600000, 1000, 3600000, 'timeoutMs');
  const maxBytes = integer(options.maxBodyMB, 32, 1, 512, 'maxBodyMB') * 1024 * 1024;
  return async function cleanFetch(input, init = {}) {
    const request = input instanceof Request ? input : null;
    const callerSignal = init.signal ?? request?.signal;
    callerSignal?.throwIfAborted();
    let url;
    try { url = new URL(request?.url ?? String(input)); }
    catch { return failure(400, 'Invalid API URL'); }
    const method = String(init.method ?? request?.method ?? 'GET').toUpperCase();
    if (url.origin !== 'https://api.openai.com' || url.username || url.password || url.hash ||
      !routes.some(([verb, pattern]) => verb === method && pattern.test(url.pathname))) {
      return failure(400, 'Unsupported OpenAI API route');
    }
    for (const key of [...url.searchParams.keys()]) if (!queryKeys.has(key)) url.searchParams.delete(key);
    const sourceHeaders = new Headers(init.headers ?? request?.headers);
    let body;
    let stream = url.searchParams.get('stream') === 'true';
    if (method === 'POST') {
      if (!/^application\/json(?:\s*;|$)/i.test(sourceHeaders.get('content-type') || '')) return failure(415, 'Content-Type must be application/json');
      const encoding = sourceHeaders.get('content-encoding');
      if (encoding && encoding !== 'identity') return failure(415, 'Magpie plugin expects an uncompressed JSON body');
      let raw = init.body;
      if (raw === undefined && request) {
        try { raw = await readBounded(request.body, maxBytes); }
        catch (error) {
          callerSignal?.throwIfAborted();
          return failure(error instanceof RangeError ? 413 : 400, error instanceof RangeError ? 'Body exceeds configured limit' : 'Unable to read JSON body');
        }
      }
      if (typeof raw !== 'string' && !ArrayBuffer.isView(raw) && !(raw instanceof ArrayBuffer)) return failure(400, 'Body must contain valid UTF-8 JSON');
      if ((typeof raw === 'string' ? Buffer.byteLength(raw) : raw.byteLength) > maxBytes) return failure(413, 'Body exceeds configured limit');
      let parsed;
      try {
        parsed = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder('utf-8', { fatal: true }).decode(raw));
      } catch { return failure(400, 'Body must contain valid UTF-8 JSON'); }
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return failure(400, 'Body must be a JSON object');
      const clean = sanitizeRequest(parsed);
      body = JSON.stringify(clean);
      stream = clean.stream === true;
      if (Buffer.byteLength(body) > maxBytes) return failure(413, 'Rewritten body exceeds configured limit');
    }
    callerSignal?.throwIfAborted();
    let config;
    let auth;
    try { auth = await getAuth(); }
    catch { return failure(401, 'Unable to read the selected account', 'authentication_error'); }
    try { config = keyConfig(auth); }
    catch (error) { return failure(401, error.message, 'authentication_error'); }
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
    try {
      const response = await fetchImpl(url, {
        method, headers: upstreamHeaders(config, body !== undefined, stream), body,
        signal, redirect: 'manual',
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        return failure(502, 'Upstream redirect rejected', 'relay_error');
      }
      // Return the original Response: tool calls, reasoning, SSE and errors are untouched.
      return response;
    } catch {
      callerSignal?.throwIfAborted();
      return failure(deadline.aborted ? 504 : 502, deadline.aborted ? 'Upstream request timed out' : 'Unable to reach upstream API', 'relay_error');
    }
  };
}

export function providerConfig(models) {
  return {
    name: 'Codex-free-api', npm: '@ai-sdk/openai', api: BASE, searches: true,
    models: Object.fromEntries(Object.entries(models).map(([id, model]) => [id, {
      ...model,
      variants: Object.fromEntries((model.reasoning_options?.find(option => option.type === 'effort')?.values ?? []).map(effort => [effort, {}])),
    }])),
  };
}

function modelDetails(id, knownModels) {
  if (Object.hasOwn(knownModels, id)) return knownModels[id];
  const base = id.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  return Object.hasOwn(knownModels, base) ? knownModels[base] : undefined;
}

export async function discoverModels(provider, auth, knownModels, options = {}, fetchImpl = globalThis.fetch) {
  const config = keyConfig(auth);
  const deadline = AbortSignal.timeout(Math.min(integer(options.timeoutMs, 600000, 1000, 3600000, 'timeoutMs'), 20000));
  let response;
  try {
    response = await fetchImpl(`${BASE}/models`, {
      headers: upstreamHeaders(config, false, false), redirect: 'manual', signal: deadline,
    });
  } catch {
    throw new Error(deadline.aborted ? 'OpenAI 模型列表请求超时' : '无法连接 OpenAI 模型列表接口');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const error = new Error(`OpenAI 模型列表请求失败（HTTP ${response.status}）`);
    if (response.status === 401) error.signIn = 'expired';
    throw error;
  }
  let payload;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(response.body, 4 * 1024 * 1024)));
  } catch {
    throw new Error('OpenAI 模型列表格式无效或超过 4 MiB');
  }
  if (!Array.isArray(payload?.data)) throw new Error('OpenAI 模型列表格式无效');
  const out = {};
  for (const item of payload.data) {
    const id = item?.id;
    if (typeof id !== 'string' || !id.trim()) throw new Error('OpenAI 模型列表包含无效 ID');
    const known = modelDetails(id, knownModels);
    if (!known) continue;
    const existing = provider.models[id];
    out[id] = existing ?? {
      id, providerID: PROVIDER, name: knownModels[id] ? known.name : id,
      api: { id, url: BASE, npm: '@ai-sdk/openai' },
      limit: known.limit,
      capabilities: {
        temperature: known.temperature === true, reasoning: known.reasoning === true,
        toolcall: known.tool_call === true, attachment: known.attachment === true,
        input: Object.fromEntries((known.modalities?.input ?? ['text']).map(type => [type, true])),
        output: { text: true },
      },
      cost: { input: known.cost?.input ?? 0, output: known.cost?.output ?? 0, cache: { read: known.cost?.cache_read ?? 0, write: known.cost?.cache_write ?? 0 } },
      variants: Object.fromEntries((known.reasoning_options?.find(option => option.type === 'effort')?.values ?? []).map(effort => [effort, {}])),
    };
  }
  return out;
}
