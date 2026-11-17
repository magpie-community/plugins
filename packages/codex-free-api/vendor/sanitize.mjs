const attributionKey = /(?:codex|chatgpt|originator|session[_-]?id|conversation[_-]?id|thread[_-]?id|trace[_-]?id)/i;
const privateFields = new Set(['metadata', 'client_metadata', 'prompt_cache_key', 'safety_identifier', 'user']);

export function sanitizeRequest(body) {
  const clean = {};
  // Only top-level attribution is removed. Prompts and message contents are opaque.
  for (const [key, value] of Object.entries(body)) {
    if (privateFields.has(key) || attributionKey.test(key)) continue;
    clean[key] = value;
  }
  return clean;
}

export function upstreamHeaders(config, hasBody, wantsStream) {
  const headers = {
    authorization: `Bearer ${config.apiKey}`,
    'user-agent': 'local-agent-harness/1.0',
    accept: wantsStream ? 'text/event-stream' : 'application/json',
    'accept-encoding': 'identity',
  };
  if (hasBody) headers['content-type'] = 'application/json';
  if (config.organization) headers['openai-organization'] = config.organization;
  if (config.project) headers['openai-project'] = config.project;
  return headers;
}

export function responseHeaders(incoming) {
  const hopByHop = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade']);
  for (const token of String(incoming.connection || '').split(',')) hopByHop.add(token.trim().toLowerCase());
  const headers = {};
  // End-to-end response headers are preserved; connection headers belong to each hop.
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined && !hopByHop.has(key.toLowerCase())) headers[key] = value;
  }
  return headers;
}
