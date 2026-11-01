// Shared by the gateway hook and the sandboxed settings page. This classic
// script validates explicit settings; the hook resolves environment fallback.
// Keep the global available for later importers: ES modules are cached.
globalThis.__nowledgeMemValidateOptions = (raw = {}) => {
 const fail = () => { throw new Error('invalidOption'); };
 const text = (name) => {
  const v = raw[name];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || !v.trim()) fail();
  return v;
 };
 for (const name of ['spaceId','agentId','hostAgentId']) text(name);
 const skip = raw.skipAgents;
 if (skip != null && typeof skip !== 'string' && (!Array.isArray(skip) || skip.some((name) => typeof name !== 'string'))) fail();
 for (const name of ['recall','contextBundle','capture','recallRemote','captureRemote','captureTools','captureCindy'])
  if (raw[name] !== undefined && typeof raw[name] !== 'boolean') fail();
 for (const [name,fallback,min,max] of [['maxMemories',5,1,20],['maxBytes',6000,512,32768],['requestTimeoutMs',1500,50,5000],['recallBackoffMs',30000,100,300000]]) {
  const n = raw[name] ?? fallback;
  if (!Number.isInteger(n) || n < min || n > max) fail();
 }
 if (raw.captureFilter !== undefined && raw.captureFilter !== 'off' && raw.captureFilter !== 'human') fail();
 const endpoint = text('serverUrl');
 if (endpoint) {
  let u; try { u = new URL(endpoint); } catch { throw new Error('invalidUrl'); }
  const local = ['localhost','127.0.0.1','[::1]'].includes(u.hostname);
  if (!['http:','https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || (u.protocol === 'http:' && !local && raw.allowInsecureHttp !== true)) throw new Error('invalidUrl');
 }
 const env = text('apiKeyEnv') ?? 'NMEM_API_KEY';
 if (!/^NMEM_[A-Za-z0-9_]+$/.test(env)) fail();
 const secret = text('apiKey');
 const key = secret?.replace(/^Bearer\s+/i,'').trim();
 if (key && /[\s\u0000-\u001f\u007f]/.test(key)) throw new Error('invalidKey');
};
