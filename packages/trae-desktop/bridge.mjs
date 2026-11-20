import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream';

export const DEFAULT_PORT = 3498;
// This is a public marker for a loopback service, never an upstream key.
export const LOCAL_TOKEN = 'sk-magpie-trae-local-00000000000000000000000000000000';
const VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

function syncStatus(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { state: ['synced', 'disconnected', 'pending'].includes(s.state) ? s.state : 'unknown',
      ...(Number.isInteger(s.models) ? { models: s.models } : {}),
      ...(typeof s.code === 'string' && /^[a-z_0-9]+$/.test(s.code) ? { code: s.code } : {}),
      ...(typeof s.updatedAt === 'string' ? { updatedAt: s.updatedAt } : {}),
      ...(/^[a-f0-9]{64}$/.test(s.revision || '') ? { revision: s.revision } : {}),
      warnings: Array.isArray(s.warnings) ? s.warnings.map(w => ({ model: String(w.model || ''), code: String(w.code || '') })) : [] };
  } catch { return { state: 'pending', code: 'sync_status_unavailable' }; }
}

export function connectionPath(home = os.homedir()) {
  return path.join(home, '.config', 'magpie-trae', 'connection.json');
}

function readConnection(file, bridgePort) {
  let c;
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error();
    const raw = fs.readFileSync(file, 'utf8');
    if (raw.length > 2 * 1024 * 1024) throw new Error();
    c = JSON.parse(raw);
  } catch {
    throw new Error('Magpie connection is unavailable. Choose a model on the Trae Agent row.');
  }
  if (c.version !== 2 || !Array.isArray(c.models) || c.models.some(m => !m || typeof m.id !== 'string' || !m.id.trim()) ||
      typeof c.gatewayKey !== 'string' || !/^[\x21-\x7e]+$/.test(c.gatewayKey)) {
    throw new Error('Trae is disconnected. Enable its connection on the Magpie Agent row.');
  }
  let url;
  try { url = new URL(c.baseURL); } catch { throw new Error('Invalid Magpie gateway address.'); }
  if (!['http:', 'https:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash ||
      url.pathname.replace(/\/$/, '') !== '/v1' || Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === bridgePort) {
    throw new Error('This bridge requires a local Magpie /v1 gateway on a different port.');
  }
  url.pathname = '/v1/chat/completions';
  return { ...c, url };
}

function json(res, status, data) {
  if (res.destroyed || res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function fail(res, status, message) {
  json(res, status, { error: { type: 'magpie_trae_error', message } });
}

export function createBridge({ file = connectionPath(), port = DEFAULT_PORT, maxBodyBytes = 32 * 1024 * 1024,
  upstreamTimeoutMs = 600000, onRequest = () => {} } = {}) {
  let lastRequest = null;
  let count = 0;
  let rejected = 0, lastRejection = null;
  let received = 0, lastInbound = null;
  const inFlight = new Set();
  const server = http.createServer(async (req, res) => {
    if (req.url !== '/health') {
      received++;
      const inbound = { time: new Date().toISOString(), method: req.method, route: req.url?.split('?')[0], status: null };
      lastInbound = inbound;
      res.once('finish', () => { inbound.status = res.statusCode; });
    }
    // Trae supplies forwarding headers. It is a local client of this bridge;
    // build a fresh request to Magpie rather than passing its cloud headers on.
    if (req.headers.origin || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
      fail(res, 403, 'Only local non-browser clients are accepted.'); return;
    }
    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) {
      fail(res, 403, 'Invalid local Host header.'); return;
    }
    if (req.url === '/health' && req.method === 'GET') {
      let c, error;
      try { c = readConnection(file, server.address()?.port ?? port); } catch (e) { error = e.message; }
      json(res, 200, { name: 'magpie-trae', version: VERSION, connected: !!c,
        sync: syncStatus(path.join(path.dirname(file), 'sync-status.json')),
        models: c?.models.map(m => ({ id: m.id, name: m.name })) ?? [], requests: count, lastRequest,
        received, lastInbound, rejected, lastRejection, ...(error ? { error } : {}) });
      return;
    }
    if (req.headers.authorization !== `Bearer ${LOCAL_TOKEN}`) {
      rejected++; lastRejection = { time: new Date().toISOString(), status: 401, code: 'local_auth_invalid' };
      fail(res, 401, 'The Trae local connection value is invalid. Check native model sync status.'); return;
    }
    const models = req.url === '/v1/models';
    const chat = req.url === '/v1/chat/completions';
    if (!models && !chat) { fail(res, 404, 'Unknown bridge endpoint.'); return; }
    if ((models && req.method !== 'GET') || (chat && req.method !== 'POST')) {
      fail(res, 405, 'Method not allowed.'); return;
    }
    let connection;
    try { connection = readConnection(file, server.address()?.port ?? port); }
    catch (e) { fail(res, 503, e.message); return; }
    if (models) {
      json(res, 200, { object: 'list', data: connection.models.map(m => ({ id: m.id, object: 'model', owned_by: 'magpie',
        name: m.name || m.id, ...(m.context ? { context_length: m.context } : {}),
        ...(m.output ? { max_output_tokens: m.output } : {}), images: !!m.images, efforts: m.efforts || [] })) });
      return;
    }
    if (Number(req.headers['content-length']) > maxBodyBytes) { fail(res, 413, 'Request body is too large.'); req.resume(); return; }
    let body;
    try {
      const chunks = []; let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > maxBodyBytes) { fail(res, 413, 'Request body is too large.'); req.resume(); return; }
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { fail(res, 400, 'Expected a JSON request body.'); return; }
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.model !== 'string' || !Array.isArray(body.messages)) {
      fail(res, 400, 'Use an explicit Magpie model ID and a messages array.'); return;
    }
    if (!connection.models.some(m => m.id === body.model)) { fail(res, 404, 'This model is not in the Trae Magpie catalog. Select an available model in Trae.'); return; }
    if (res.destroyed) return;
    const encoded = Buffer.from(JSON.stringify(body));
    const started = Date.now();
    const headers = { authorization: `Bearer ${connection.gatewayKey}`, 'content-type': 'application/json',
      'content-length': encoded.length, 'user-agent': `magpie-trae/${VERSION}`, accept: body.stream ? 'text/event-stream' : 'application/json' };
    const conversation = req.headers['x-magpie-conversation'];
    if (typeof conversation === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(conversation)) headers['x-magpie-conversation'] = conversation;
    const transport = connection.url.protocol === 'https:' ? https : http;
    let reported = false;
    const report = status => {
      if (reported) return; reported = true;
      lastRequest = { time: new Date().toISOString(), model: body.model, status,
        stream: !!body.stream, tools: Array.isArray(body.tools) ? body.tools.length : 0,
        images: body.messages.reduce((n, m) => n + (Array.isArray(m?.content) ? m.content.filter(c => c?.type === 'image_url').length : 0), 0),
        ...(typeof body.reasoning_effort === 'string' ? { reasoningEffort: body.reasoning_effort.slice(0, 24) } : {}),
        durationMs: Date.now() - started };
      count++;
      try { onRequest(lastRequest); } catch { /* Observers do not affect requests. */ }
    };
    const upstream = transport.request(connection.url, { method: 'POST', headers }, response => {
      if (res.destroyed) { response.destroy(); return; }
      const out = { 'cache-control': 'no-store', 'x-accel-buffering': 'no' };
      for (const name of ['content-type', 'content-encoding', 'retry-after']) if (response.headers[name]) out[name] = response.headers[name];
      res.writeHead(response.statusCode || 502, out);
      // Raw streaming preserves fragmented tool arguments, images and usage.
      pipeline(response, res, () => report(response.statusCode || 502));
    });
    inFlight.add(upstream);
    upstream.once('close', () => inFlight.delete(upstream));
    upstream.setTimeout(upstreamTimeoutMs, () => upstream.destroy(new Error('timeout')));
    upstream.once('error', () => {
      report(502);
      if (!res.headersSent) fail(res, 502, 'Magpie could not complete the request. Check its gateway and selected model.');
      else res.destroy();
    });
    res.once('close', () => { if (!res.writableFinished) upstream.destroy(); });
    upstream.end(encoded);
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      const error = e => { server.off('listening', ready); reject(e); };
      const ready = () => { server.off('error', error); resolve(server.address()); };
      server.once('error', error); server.once('listening', ready);
      server.listen(port, '127.0.0.1');
    }),
    close: () => new Promise(resolve => {
      for (const request of inFlight) request.destroy();
      server.close(resolve);
      server.closeAllConnections?.();
    }),
  };
}

export function startHost(options = {}) {
  const port = options.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Trae bridge port.');
  let bridge, retry, stopped = false, warned = false;
  const attempt = async () => {
    if (stopped) return;
    bridge = createBridge({ ...options, port });
    try {
      await bridge.listen();
      if (stopped) { await bridge.close(); return; }
      bridge.server.unref();
    } catch (e) {
      if (!warned && e.code !== 'EADDRINUSE') { console.error('Trae local bridge could not listen. Check its configured port.'); warned = true; }
      if (!stopped) { retry = setTimeout(attempt, options.retryMs ?? 2000); retry.unref(); }
    }
  };
  const ready = attempt();
  return { ready, stop: async () => { stopped = true; clearTimeout(retry); await bridge?.close(); } };
}
