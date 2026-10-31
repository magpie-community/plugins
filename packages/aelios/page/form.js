/* Pure helpers shared by the classic browser script and standalone tests. */
globalThis.aeliosForm = (() => {
  const reserved = new Set(['v1', 'api', 'admin', 'health', 'mcp', 'memory-mcp', 'memory-admin', 'guide-dog']);
  const fail = (key, field) => { throw Object.assign(new Error(key), { field }); };
  function selectors(value, field, models = false) {
    if (!value.trim()) return undefined;
    const values = value.split(',').map((v) => v.trim());
    if (values.some((v) => !v || (models && v.length > 200))) fail('invalidSelectors', field);
    return values;
  }
  function build(previous, values) {
    if (!previous || typeof previous !== 'object' || Array.isArray(previous)) fail('invalidOptions');
    const next = { ...previous, recall: values.recall, record: values.record, allowRemote: values.allowRemote };
    const optional = (name, value) => { if (value) next[name] = value; else delete next[name]; };
    const raw = values.url.trim();
    if (raw) {
      let url;
      try { url = new URL(raw); } catch { fail('invalidUrl', 'url'); }
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && local))) fail('invalidUrl', 'url');
      optional('serverUrl', url.href);
    } else delete next.serverUrl;
    const key = values.key.trim().replace(/^Bearer\s+/i, '');
    if (key && /[\s\u0000-\u001f\u007f]/.test(key)) fail('invalidKey', 'key');
    optional('apiKey', key);
    optional('apiKeyEnv', values.keyEnv.trim());
    const identity = values.identity.trim();
    if (identity.length > 128) fail('invalidIdentity', 'identity');
    optional('identity', identity);
    optional('agents', selectors(values.agents, 'agents'));
    if (values.routes.length > 64) fail('tooManyRoutes', 'add-route');
    const routes = values.routes.map((route, i) => {
      const identity = route.identity.trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(identity) || reserved.has(identity.toLowerCase())) fail('invalidRoute', `route-${i}-identity`);
      const models = selectors(route.models, `route-${i}-models`, true);
      const agents = selectors(route.agents, `route-${i}-agents`);
      if (!models && !agents) fail('missingSelector', `route-${i}-models`);
      const out = { ...route.original, identity };
      if (models) out.models = models; else delete out.models;
      if (agents) out.agents = agents; else delete out.agents;
      return out;
    });
    optional('routes', routes.length ? routes : undefined);
    // The host otherwise gives hooks only 1000 ms. Keep an explicit user value.
    next.gatewayTimeoutMs ??= 5000;
    for (const [name, fallback, min, max] of [['gatewayTimeoutMs', 5000, 100, 10000], ['requestTimeoutMs', 4000, 50, 9000], ['recallBackoffMs', 30000, 0, 3600000]]) {
      const value = next[name] ?? fallback;
      if (!Number.isInteger(value) || value < min || value > max) fail('invalidAdvanced');
    }
    return next;
  }
  return { build, selectors };
})();
