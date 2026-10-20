/**
 * Octop adapter for Magpie.
 *
 * Octop keeps its LLM providers in ~/.octop/octop.db (SQLite) and serves an
 * HTTP API on the host/port from ~/.octop/config.json (default 127.0.0.1:8088).
 * When Magpie connects this agent it stores a gateway URL and key in
 * ~/.config/magpie-octop/connection.json. The adapter then:
 *
 *   1. mints an admin JWT from the HMAC secret in octop.db's `secrets` table
 *      (Octop's API tokens are HS256 JWTs, so no password is needed),
 *   2. registers Magpie's gateway as an Octop provider named "magpie" with the
 *      model list Magpie exposes,
 *   3. points Octop's active model at the model chosen in Magpie.
 *
 * Everything is reverted on disconnect or when the shared host exits. Provider
 * writes go through Octop's HTTP API so a running server rehydrates at once;
 * the exit path falls back to direct (synchronous) SQLite writes because an
 * `exit` handler cannot await network calls.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// The shared host is Bun; bun:sqlite is the only SQLite binding available
// there. Load it lazily so a non-Bun host degrades to "idle" instead of
// crashing the whole plugin.
let Database = null;
try { ({ Database } = await import('bun:sqlite')); } catch { Database = null; }

const PROVIDER_NAME = 'magpie';
const PROVIDER_NOTE = 'Managed by Magpie (magpie-agent-octop plugin).';
const USER_AGENT = 'Octop';
const JWT_TTL_S = 86400;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8088;
const POLL_MS = 1500;

const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

function atomicJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch { /* Renamed. */ } }
}

function parseActive(value) {
  if (typeof value !== 'string' || !value) return { provider_name: '', model: '' };
  const at = value.indexOf('/');
  if (at < 0) return { provider_name: value, model: '' };
  return { provider_name: value.slice(0, at), model: value.slice(at + 1) };
}

function toOctopModel(model) {
  if (!model || !model.id) return null;
  const out = { id: String(model.id), name: String(model.name || model.id), enabled: true };
  const input = ['text'];
  if (model.images) input.push('image');
  out.input = input;
  if (model.context) out.context_window = model.context;
  if (model.output) out.max_output_tokens = model.output;
  return out;
}

function mintJwt(secret, user) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({
    sub: String(user.id), uname: user.username, role: user.role, iat: now, exp: now + JWT_TTL_S,
  });
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + sig;
}

export class OctopAdapter {
  constructor({ home = os.homedir(), stateDir, octopDir, intervalMs = POLL_MS,
    fetchImpl = globalThis.fetch, log = () => {} } = {}) {
    this.stateDir = stateDir || path.join(home, '.config', 'magpie-octop');
    this.octopDir = octopDir || path.join(home, '.octop');
    this.connectionFile = path.join(this.stateDir, 'connection.json');
    this.stateFile = path.join(this.stateDir, 'adapter-state.json');
    this.octopConfigFile = path.join(this.octopDir, 'config.json');
    this.dbFile = path.join(this.octopDir, 'octop.db');
    Object.assign(this, { intervalMs, fetchImpl, log });
    this.state = null;
    this.status = {};
    this.running = false;
    this.dirty = false;
    this.working = false;
  }

  bootstrap() {
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.connectionFile)) {
      try {
        fs.writeFileSync(this.connectionFile, JSON.stringify({
          schemaVersion: 1, enabled: false, model: '', gateway: { url: '', key: '' }, models: [],
        }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    return fs.existsSync(this.dbFile) && fs.existsSync(this.octopConfigFile);
  }

  report(code, details = {}) {
    const next = { code, ...details };
    if (JSON.stringify(next) === JSON.stringify(this.status)) return;
    this.status = next;
    if (fs.existsSync(this.stateDir)) {
      try { atomicJSON(this.stateDir + '/status.json', { ...next, at: new Date().toISOString() }); } catch { /* Best effort. */ }
    }
    if (code.endsWith('_failed')) this.log(code);
  }

  saveState() { atomicJSON(this.stateFile, this.state); }

  async start() {
    const installed = this.bootstrap();
    try { this.state = readJSON(this.stateFile); } catch { this.state = { active: false }; }
    if (!this.state || typeof this.state !== 'object') this.state = { active: false };
    if (!installed) { this.report('octop_not_installed'); return this; }
    this.running = true;
    try { this.watcher = fs.watch(this.stateDir, () => this.schedule()); } catch { /* Poll still covers it. */ }
    const timer = setInterval(() => this.schedule(), this.intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.timer = timer;
    this.schedule();
    return this;
  }

  schedule() {
    if (this.working) { this.dirty = true; return; }
    this.working = true;
    void this.applyNow()
      .catch(error => this.report('octop_apply_failed', { message: String(error?.message || error) }))
      .finally(() => {
        this.working = false;
        if (this.dirty) { this.dirty = false; this.schedule(); }
      });
  }

  readConnection() {
    try { return readJSON(this.connectionFile); } catch { return null; }
  }

  octopBase() {
    try {
      const cfg = readJSON(this.octopConfigFile);
      const host = cfg.host || cfg.server?.host || cfg.bind_host || DEFAULT_HOST;
      const port = cfg.port || cfg.server?.port || cfg.bind_port || DEFAULT_PORT;
      return `http://${host}:${port}`;
    } catch { return `http://${DEFAULT_HOST}:${DEFAULT_PORT}`; }
  }

  // Reads what the adapter needs from Octop: an admin JWT and the current
  // active model. Returns null when Octop has not been initialised.
  openApi() {
    if (!Database || !fs.existsSync(this.dbFile)) return null;
    let db;
    try {
      db = new Database(this.dbFile, { readonly: true });
      const secret = db.query("SELECT v FROM secrets WHERE k = 'jwt'").get();
      const admin = db.query("SELECT id, username, role FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
      const active = db.query("SELECT value FROM settings WHERE key = 'active_model'").get();
      if (!secret?.v || !admin) return null;
      return {
        base: this.octopBase(),
        token: mintJwt(Buffer.from(secret.v), admin),
        active: parseActive(active?.value),
      };
    } catch { return null; } finally { try { db?.close(); } catch { /* Already closed. */ } }
  }

  async request(api, method, endpoint, body) {
    const response = await this.fetchImpl(api.base + endpoint, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer ' + api.token,
        'User-Agent': USER_AGENT,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
      redirect: 'error',
      proxy: '',
    });
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok) {
      const message = data?.detail || data?.error?.message || data?.message || `http_${response.status}`;
      throw Error(String(message));
    }
    return data;
  }

  async ensureProvider(api, connection) {
    const gateway = connection.gateway || {};
    const exposed = Array.isArray(connection.models) ? connection.models : [];
    let octopModels = exposed.map(toOctopModel).filter(Boolean);
    const chosen = typeof connection.model === 'string' ? connection.model : '';
    // If Magpie exposed no catalog, still make the chosen model resolvable.
    if (octopModels.length === 0 && chosen) octopModels = [{ id: chosen, name: chosen, enabled: true, input: ['text'] }];

    const providers = await this.request(api, 'GET', '/api/admin/providers');
    const existing = Array.isArray(providers) ? providers.find(p => p.name === PROVIDER_NAME) : null;

    if (!existing) {
      const created = await this.request(api, 'POST', '/api/admin/providers', {
        name: PROVIDER_NAME,
        kind: 'openai',
        base_url: gateway.url,
        api_key: gateway.key,
        models: octopModels,
        note: PROVIDER_NOTE,
      });
      this.state.createdProviderId = created?.id ?? null;
      this.state.providerSnapshot = null;
    } else {
      this.state.createdProviderId = null;
      this.state.providerSnapshot = {
        id: existing.id,
        kind: existing.kind,
        base_url: existing.base_url,
        api_key: existing.api_key,
        models: existing.models,
        enabled: existing.enabled,
      };
      await this.request(api, 'PATCH', `/api/admin/providers/${existing.id}`, {
        kind: 'openai',
        base_url: gateway.url,
        api_key: gateway.key,
        models: octopModels,
        enabled: true,
      });
    }
  }

  async applyNow() {
    const connection = this.readConnection();
    if (!connection || connection.enabled !== true
      || !connection.gateway?.url || !connection.gateway?.key) {
      await this.restore();
      return;
    }

    const api = this.openApi();
    if (!api) { this.report('octop_unavailable'); await this.restore(); return; }

    // Capture the previous active model once, before the first write, so a
    // later re-apply does not overwrite the restore point with our own value.
    if (!this.state.active) this.state.prevActiveModel = api.active;

    await this.ensureProvider(api, connection);

    const chosen = typeof connection.model === 'string' ? connection.model : '';
    if (chosen) {
      await this.request(api, 'PUT', '/api/providers/active-model', {
        provider_name: PROVIDER_NAME,
        model: chosen,
      });
    }

    this.state.active = true;
    this.saveState();
    this.report('octop_connected', { provider: PROVIDER_NAME, model: chosen });
  }

  // Revert Octop to its previous provider/model. Used on disconnect while the
  // host is still running, so the HTTP API can rehydrate the live server.
  async restore() {
    if (!this.state?.active) return;
    const api = this.openApi();
    if (api) {
      try {
        await this.restoreHttp(api);
      } catch { this.restoreDbSync(); }
    } else {
      this.restoreDbSync();
    }
    this.state.active = false;
    this.saveState();
    this.report('octop_disabled');
  }

  async restoreHttp(api) {
    const previous = this.state.prevActiveModel;
    if (previous?.provider_name) {
      await this.request(api, 'PUT', '/api/providers/active-model', {
        provider_name: previous.provider_name,
        model: previous.model || '',
      });
    } else {
      this.clearActiveModelDb();
    }
    if (this.state.createdProviderId) {
      await this.request(api, 'DELETE', `/api/admin/providers/${this.state.createdProviderId}`);
    } else if (this.state.providerSnapshot) {
      const snap = this.state.providerSnapshot;
      await this.request(api, 'PATCH', `/api/admin/providers/${snap.id}`, {
        kind: snap.kind,
        base_url: snap.base_url,
        api_key: snap.api_key,
        models: snap.models,
        enabled: snap.enabled,
      });
    }
  }

  clearActiveModelDb() {
    if (!Database) return;
    let db;
    try { db = new Database(this.dbFile); db.run("DELETE FROM settings WHERE key = 'active_model'"); }
    catch { /* Best effort. */ } finally { try { db?.close(); } catch { /* Already closed. */ } }
  }

  // Synchronous revert for the host `exit` path, where network calls are no
  // longer possible. Direct writes are picked up on the next Octop start.
  restoreDbSync() {
    if (!Database || !fs.existsSync(this.dbFile)) return;
    let db;
    try {
      db = new Database(this.dbFile);
      const previous = this.state.prevActiveModel;
      if (previous?.provider_name) {
        db.run("INSERT INTO settings(key, value) VALUES('active_model', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          [previous.provider_name + '/' + (previous.model || '')]);
      } else {
        db.run("DELETE FROM settings WHERE key = 'active_model'");
      }
      if (this.state.createdProviderId) {
        db.run("DELETE FROM providers WHERE id = ?", [this.state.createdProviderId]);
      } else if (this.state.providerSnapshot) {
        const snap = this.state.providerSnapshot;
        db.run("UPDATE providers SET kind = ?, base_url = ?, api_key = ?, models_json = ?, enabled = ? WHERE id = ?", [
          snap.kind, snap.base_url, snap.api_key,
          snap.models == null ? null : JSON.stringify(snap.models),
          snap.enabled ? 1 : 0, snap.id,
        ]);
      }
    } catch { /* Best effort. */ } finally { try { db?.close(); } catch { /* Already closed. */ } }
  }

  restoreOnExit() {
    if (!this.state?.active) return;
    this.restoreDbSync();
    this.state.active = false;
    try { this.saveState(); } catch { /* Disk may already be gone. */ }
  }
}
