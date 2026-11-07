export function normalizeURL(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP(S) URL without embedded credentials, query or fragment.');
  return url.toString().replace(/\/+$/, '');
}

export function createAPI({apiUrl, apiKey, timeoutMs = 10000}) {
  const base = normalizeURL(apiUrl);
  const hostname = new URL(base).hostname;
  if (apiKey && new URL(base).protocol !== 'https:' && !['127.0.0.1','localhost','[::1]'].includes(hostname)) throw new Error('A remote Nowledge backend with an API key requires HTTPS.');
  return async (route, body) => {
    const response = await fetch(`${base}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? {authorization: `Bearer ${apiKey}`} : {}) },
      ...(body === undefined ? {} : {body:JSON.stringify(body)}),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    // Do not include server bodies in errors: some gateways echo credentials.
    if (!response.ok) throw new Error(`Nowledge ${route}: HTTP ${response.status}`);
    const result = await response.json();
    if (result?.success === false) throw new Error(`Nowledge ${route}: operation rejected`);
    return result?.config && typeof result.config === 'object' ? result.config : result;
  };
}
