import { hasSecret } from './runtime.mjs';

export async function generate(o, messages, tools, signal) {
  if (!o.generationBaseUrl || !o.generationModel) throw new Error('generation-not-configured');
  const url = new URL(o.generationBaseUrl);
  const local = ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.href.includes('@') || url.search || url.hash || !(url.protocol === 'https:' || local && url.protocol === 'http:')) throw new Error('invalid-generation-url');
  url.pathname = url.pathname.replace(/\/$/, '') + '/chat/completions';
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'respire-memory' };
  const token = process.env[o.authorizationEnv];
  if (token) headers.Authorization = /^Bearer /i.test(token) ? token : `Bearer ${token}`;
  const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]), headers,
    body: JSON.stringify({ model: o.generationModel, messages, stream: false, ...(tools?.length ? { tools, parallel_tool_calls: false } : {}), max_tokens: 8192 }) });
  if (!response.ok) { await response.body?.cancel(); throw new Error('generation-unavailable'); }
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length;
      if (size > 1024 * 1024) { await reader.cancel(); throw new Error('generation-output-limit'); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  const choice = data.choices?.[0];
  if (!choice || !['stop', 'tool_calls'].includes(choice.finish_reason) || !choice.message || hasSecret(choice.message)) throw new Error('generation-invalid-output');
  return choice.message;
}
