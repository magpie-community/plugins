import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

export const SETTINGS_PORT = 3491;
export const TOKEN_HEADER = 'x-magpie-kimi-settings-token';

const MAX_BODY_BYTES = 8 * 1024;
const SAVE_ERRORS = new Map([
  ['connect_kimi_first', 409],
  ['model_not_enabled_for_kimi', 400],
  ['connection_changed', 409],
  ['settings_unavailable', 503],
]);

class RequestError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

function settingsView(state) {
  if (!state || typeof state.enabled !== 'boolean' || typeof state.primaryModel !== 'string'
      || typeof state.secondaryModel !== 'string' || typeof state.status !== 'string'
      || !Array.isArray(state.models)) throw new Error('invalid_settings_state');
  const models = state.models.map(model => {
    if (!model || typeof model.id !== 'string' || typeof model.name !== 'string') {
      throw new Error('invalid_settings_state');
    }
    return { id: model.id, name: model.name };
  });
  const view = {
    enabled: state.enabled,
    primaryModel: state.primaryModel,
    secondaryModel: state.secondaryModel,
    status: /^[a-z][a-z0-9_]{0,63}$/.test(state.status) ? state.status : 'settings_unavailable',
    models,
  };
  if (typeof state.appliedSecondaryModel === 'string') view.appliedSecondaryModel = state.appliedSecondaryModel;
  return view;
}

function readBody(req) {
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
    req.resume();
    return Promise.reject(new RequestError('body_too_large', 413));
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    let chunks = [];
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      chunks = [];
      reject(error);
    };
    req.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { fail(new RequestError('body_too_large', 413)); return; }
      chunks.push(chunk);
    });
    req.on('error', () => fail(new RequestError('invalid_request')));
    req.on('aborted', () => fail(new RequestError('invalid_request')));
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new RequestError('invalid_json')); }
    });
  });
}

function uiOrigin(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value
        && !url.username && !url.password) return url.origin;
  } catch { /* An origin is an HTTP(S) origin only, never a CSP fragment. */ }
  throw new RequestError('invalid_ui_origin');
}

// This server holds no gateway or Kimi credentials. Its callbacks own the
// connected-agent model whitelist and persistence; only their view DTO leaves it.
// The iframe keeps an opaque origin after navigation, so API reads need both
// Origin:null CORS and a separate per-server token from the non-CORS HTML page.
export async function startSettingsServer({ port = SETTINGS_PORT, readSettings, saveSettings } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('settings_invalid_port');
  if (typeof readSettings !== 'function' || typeof saveSettings !== 'function') {
    throw new Error('settings_callbacks_required');
  }
  let template;
  try { template = await readFile(new URL('./settings.html', import.meta.url), 'utf8'); }
  catch { throw new Error('settings_page_unavailable'); }
  const token = randomBytes(32).toString('hex');
  const expectedToken = Buffer.from(token);
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([...hosts].map(host => `http://${host}`));

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    const originOK = origin === undefined || origin === 'null' || origins.has(origin);
    const send = (status, body, { html = false, cors = false, extra = {} } = {}) => {
      const headers = {
        'content-type': html ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        ...extra,
      };
      if (cors && originOK) {
        headers.vary = 'Origin';
        if (origin !== undefined) headers['access-control-allow-origin'] = origin;
        headers['access-control-allow-headers'] = `content-type, ${TOKEN_HEADER}`;
        headers['access-control-allow-methods'] = 'GET, POST, OPTIONS';
      }
      res.writeHead(status, headers);
      res.end(html ? body : JSON.stringify(body));
    };
    if (!hosts.has(String(req.headers.host || '').toLowerCase()) || !originOK) {
      send(403, { error: 'forbidden' }); return;
    }
    let url;
    try { url = new URL(req.url || '/', `http://127.0.0.1:${port}`); }
    catch { send(400, { error: 'invalid_request' }); return; }

    if (url.pathname === '/' && req.method === 'GET') {
      try {
        const connectOrigin = uiOrigin(url.searchParams.get('uiOrigin'));
        const nonce = randomBytes(18).toString('hex');
        const theme = ['dark', 'light'].includes(url.searchParams.get('theme')) ? url.searchParams.get('theme') : 'auto';
        const html = template.replaceAll('__KIMI_SETTINGS_TOKEN__', token)
          .replaceAll('__KIMI_SETTINGS_NONCE__', nonce).replaceAll('__KIMI_SETTINGS_THEME__', theme)
          .replaceAll('__KIMI_SETTINGS_HEADER__', TOKEN_HEADER);
        const connect = [...new Set([...origins, ...(connectOrigin ? [connectOrigin] : [])])].join(' ');
        send(200, html, { html: true, extra: {
          'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src ${connect}; base-uri 'none'; form-action 'none'`,
        } });
      } catch { send(400, { error: 'invalid_ui_origin' }); }
      return;
    }
    if (url.pathname !== '/api/settings') { send(404, { error: 'not_found' }); return; }
    if (req.method === 'OPTIONS') { send(204, undefined, { cors: true }); return; }
    const got = Buffer.from(String(req.headers[TOKEN_HEADER] || ''));
    if (got.length !== expectedToken.length || !timingSafeEqual(got, expectedToken)) {
      send(403, { error: 'invalid_session' }, { cors: true }); return;
    }
    if (req.method === 'GET') {
      try { send(200, settingsView(await readSettings()), { cors: true }); }
      catch { send(500, { error: 'settings_read_failed' }, { cors: true }); }
      return;
    }
    if (req.method !== 'POST') {
      send(405, { error: 'method_not_allowed' }, { cors: true, extra: { allow: 'GET, POST, OPTIONS' } }); return;
    }
    let body;
    try {
      if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) {
        throw new RequestError('unsupported_media_type', 415);
      }
      body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).length !== 1 || typeof body.secondaryModel !== 'string') {
        throw new RequestError('invalid_request');
      }
    } catch (error) {
      const code = error instanceof RequestError ? error.code : 'invalid_request';
      send(error instanceof RequestError ? error.status : 400, { error: code }, { cors: true }); return;
    }
    try { send(200, settingsView(await saveSettings({ secondaryModel: body.secondaryModel })), { cors: true }); }
    catch (error) {
      const code = SAVE_ERRORS.has(error?.code) ? error.code : 'settings_save_failed';
      send(SAVE_ERRORS.get(code) || 500, { error: code }, { cors: true });
    }
  });
  await new Promise((resolve, reject) => {
    const onError = error => {
      server.removeListener('listening', onListening);
      const code = error?.code === 'EADDRINUSE' ? 'settings_port_in_use' : 'settings_bind_failed';
      reject(Object.assign(new Error(code), { code }));
    };
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
  server.unref();
  let stopping;
  return {
    port,
    stop: () => stopping ||= new Promise(resolve => { server.close(() => resolve()); server.closeIdleConnections?.(); }),
  };
}
