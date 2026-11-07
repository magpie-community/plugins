import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { rpc } from './rpc.mjs';
import { normalizeModels, mergeRuntimeModels, isMenuAlias } from './catalog.mjs';
import { prepareLibrary, applyInstructions } from './library.mjs';
import { inspectSecondary, patchSecondary } from './secondary-config.mjs';
import { inspectModelPool, patchModelPool } from './model-pool-config.mjs';

const PROVIDER = 'daimon-kimi-code';
const TOOL_ORIGIN = 'https://agent-gw.kimi.com';
const BODY_LIMIT = 32 * 1024 * 1024;
const HEADERS = ['user-agent', 'x-msh-version', 'r-timezone', 'x-session-id', 'session_id'];
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const baseURL = doc => doc?.model?.providers?.[PROVIDER]?.baseUrl;
const activeCount = value => Array.isArray(value) ? value.length : Number(value) || 0;
const busy = runner => activeCount(runner?.activeKernelTurns) + activeCount(runner?.activeKernelToolCalls) > 0;

// The only two control calls this feature adds. Kimi's reload walks the
// sessions it currently caches; the targeted call retries one of them.
const RELOAD_SESSIONS = 'kimiPlugin.reloadActiveSessions';
const RELOAD_SESSION = 'kimiPlugin.ReloadSession';
const SECONDARY_RETRY_MS = 5000;
const MODEL_ID = /^[^\x00-\x1f/]+\/[^\x00-\x1f]+$/;
const SECONDARY_CODES = new Set(['secondary_config_unsupported', 'secondary_model_unavailable',
  'secondary_model_reload_failed', 'secondary_model_unsupported_runtime', 'kimi_config_changed']);

const validModelID = value => typeof value === 'string' && value.length <= 1024 && MODEL_ID.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameModels = (left, right) => left === null || right === null ? left === right
  : Object.keys(left).length === Object.keys(right).length
    && Object.entries(left).every(([key, value]) => Object.hasOwn(right, key) && right[key] === value);
const samePool = (left, right) => Boolean(left && right) && sameModels(left.models, right.models)
  && left.defaultModel === right.defaultModel
  && left.hasSecondaryTable === right.hasSecondaryTable && left.hasModelsTable === right.hasModelsTable;

function plainPoolSnapshot(value) {
  if (!record(value) || (value.models !== null && (!record(value.models)
      || Object.values(value.models).some(description => typeof description !== 'string')))
      || (value.defaultModel !== null && typeof value.defaultModel !== 'string')
      || typeof value.hasSecondaryTable !== 'boolean' || typeof value.hasModelsTable !== 'boolean') return null;
  return { models: value.models === null ? null : { ...value.models }, defaultModel: value.defaultModel,
    hasSecondaryTable: value.hasSecondaryTable, hasModelsTable: value.hasModelsTable };
}

// A snapshot is the helper's four JSON fields and nothing else. Anything else
// is treated as absent instead of being trusted.
function plainSnapshot(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const { model, enabled, hasSecondaryTable, hasExperimentalTable } = value;
  if (model !== null && typeof model !== 'string') return null;
  if (enabled !== null && typeof enabled !== 'boolean') return null;
  if (typeof hasSecondaryTable !== 'boolean' || typeof hasExperimentalTable !== 'boolean') return null;
  return { model, enabled, hasSecondaryTable, hasExperimentalTable };
}

const isRestoredBaseline = (current, owned) => owned?.restored
  && current.model === owned.baseline.model && current.enabled === owned.baseline.enabled;

// The scalars this adapter does not own. A control call can make Daimon rewrite
// the whole file from a fixed key set, so these are read before that call and
// put back afterwards. Only the helper's four JSON fields are remembered.
function externalFields(current, owned) {
  if (isRestoredBaseline(current, owned)) return null;
  const foreignModel = current.model !== null && current.model !== owned.alias;
  const foreignFlag = current.enabled === false;
  if (!foreignModel && !foreignFlag) return null;
  return { model: foreignModel ? current.model : null,
    enabled: foreignFlag ? false : null,
    hasSecondaryTable: foreignModel, hasExperimentalTable: foreignFlag };
}

// Restore per field: a scalar this adapter wrote (or Daimon dropped) returns to
// its original value; a scalar another writer changed stays untouched.
function restoreTarget(current, baseline, alias) {
  const ownsModel = current.model === null || (alias !== '' && current.model === alias);
  const ownsFlag = current.enabled === null || current.enabled === true;
  return {
    model: ownsModel ? baseline.model : current.model,
    enabled: ownsFlag ? baseline.enabled : current.enabled,
    hasSecondaryTable: ownsModel ? baseline.hasSecondaryTable : current.hasSecondaryTable,
    hasExperimentalTable: ownsFlag ? baseline.hasExperimentalTable : current.hasExperimentalTable,
  };
}

function atomicJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch { /* Renamed. */ } }
}

function gatewayURL(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('invalid_gateway'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || !/^\/v1\/?$/.test(url.pathname)) {
    throw Error('invalid_gateway');
  }
  return url.href.replace(/\/$/, '');
}

function officialURL(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('unsupported_kimi_config'); }
  if (url.origin !== TOOL_ORIGIN || url.pathname !== '/coding/v1'
      || url.username || url.password || url.search || url.hash) throw Error('unsupported_kimi_config');
  return url.href;
}

function authenticated(actual, key) {
  if (!key || typeof key !== 'string') return false;
  const left = Buffer.from(actual || ''), right = Buffer.from('Bearer ' + key);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// Kimi's daimon folder, as Kimi 3.2.21 finds it: under the shareDir its
// <userData>/daimon-storage.json names ({"version":1,"shareDir":<absolute>}),
// else under <userData>/daimon-share. On Windows Kimi writes that pointer
// for a new user who installed it on another drive than %APPDATA%'s
// (D:\KimiData\daimon-share), and on any system when the user moves its
// storage. A pointer Kimi wouldn't take leaves the default, as in Kimi
// (magpie-community/plugins#425).
export function defaultKimiDirectory(home = os.homedir(), { platform = process.platform, appdata = process.env.APPDATA,
  read = file => { if (fs.statSync(file).size > 64 * 1024) throw Error('too large'); return fs.readFileSync(file, 'utf8'); } } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const support = platform === 'win32' ? appdata || P.join(home, 'AppData', 'Roaming')
    : platform === 'darwin' ? P.join(home, 'Library', 'Application Support') : P.join(home, '.config');
  const data = P.join(support, 'kimi-desktop');
  let share = P.join(data, 'daimon-share');
  try {
    const dir = JSON.parse(read(P.join(data, 'daimon-storage.json')).replace(/^\uFEFF/, ''))?.shareDir;
    if (typeof dir === 'string' && dir.trim() && P.isAbsolute(dir)) share = P.resolve(dir);
  } catch {}
  return P.join(share, 'daimon');
}

export class KimiAdapter {
  constructor({ home = os.homedir(), stateDir, kimiDir, intervalMs = 1000, stabilityMs = 2000,
    rpcCall = rpc, fetchImpl = globalThis.fetch, setPrimaryModel = null, log = () => {} } = {}) {
    this.stateDir = stateDir || path.join(home, '.config', 'magpie-kimi');
    this.kimiDir = kimiDir || defaultKimiDirectory(home);
    this.configFile = path.join(this.kimiDir, 'config.json');
    this.nativeConfigFile = path.join(this.kimiDir, 'runtime', 'kimi-code', 'config.toml');
    this.convertedNativeConfigFile = path.join(this.kimiDir, 'runtime', 'kimi-code', 'home', 'config.toml');
    this.runnerFile = path.join(this.kimiDir, 'agents', 'main', 'runner.state.json');
    this.connectionFile = path.join(this.stateDir, 'connection.json');
    this.stateFile = path.join(this.stateDir, 'adapter-state.json');
    this.lockFile = path.join(this.stateDir, 'adapter-owner.json');
    this.statusFile = path.join(this.stateDir, 'status.json');
    this.catalogFile = path.join(this.stateDir, 'menu-catalog.json');
    this.modelBackupFile = path.join(this.stateDir, 'before-menu-models.json');
    this.instructionsFile = path.join(this.stateDir, 'AGENTS.md');
    this.catalog = [];
    Object.assign(this, { intervalMs, stabilityMs, rpcCall, fetchImpl, setPrimaryModel, log });
    this.ownerID = crypto.randomUUID();
    this.status = {};
    this.running = false;
    this.live = null;
    this.stopping = false;
    this.state = null;
    this.inflight = new Set();
    // Memory only: ids whose cached session was mid-turn when the secondary
    // settings were written. Never persisted, never resent after a reload.
    this.secondaryPending = new Set();
    this.secondaryReloadPending = false;
    this.secondaryReloadStale = false;
    this.secondaryExternal = null;
    this.modelPoolExternal = null;
    this.secondaryReloadRuntime = null;
    this.secondaryReloadGeneration = null;
    this.secondaryAfter = 0;
  }

  bootstrap() {
    if (!fs.existsSync(this.configFile)) return false;
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    prepareLibrary(this.stateDir, this.kimiDir);
    if (!fs.existsSync(this.connectionFile)) {
      try {
        fs.writeFileSync(this.connectionFile, JSON.stringify({ schemaVersion: 1, enabled: false,
          model: '', gateway: { url: '', key: '' } }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    return true;
  }

  ownLock() {
    if (this.locked) {
      try { return readJSON(this.lockFile).ownerID === this.ownerID; } catch { this.locked = false; }
    }
    let before;
    try { before = fs.readFileSync(this.lockFile, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw Error('adapter_lock_unavailable'); }
    if (before !== undefined) {
      let owner;
      try { owner = JSON.parse(before); } catch { throw Error('adapter_lock_invalid'); }
      if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || owner.pid > 2147483647
          || typeof owner.ownerID !== 'string' || !owner.ownerID) throw Error('adapter_lock_invalid');
      let alive = true;
      try { process.kill(owner.pid, 0); } catch (error) { alive = error.code !== 'ESRCH'; }
      if (alive) return false;
      try {
        if (fs.readFileSync(this.lockFile, 'utf8') !== before) return false;
        fs.unlinkSync(this.lockFile);
      } catch (error) { if (error.code !== 'ENOENT') throw Error('adapter_lock_unavailable'); }
    }
    // Publish a complete record exclusively. A crash during the staging write
    // cannot leave a truncated owner record that blocks every future host.
    const staged = this.lockFile + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    try {
      fs.writeFileSync(staged, JSON.stringify({ pid: process.pid, ownerID: this.ownerID }), { flag: 'wx', mode: 0o600 });
      fs.linkSync(staged, this.lockFile);
      this.locked = true;
      try { this.state = readJSON(this.stateFile); } catch { this.state = { active: false }; }
      return true;
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw Error('adapter_lock_unavailable');
    } finally { try { fs.unlinkSync(staged); } catch { /* Never published, or already unlinked. */ } }
  }

  releaseLock() {
    try { if (readJSON(this.lockFile).ownerID === this.ownerID) fs.unlinkSync(this.lockFile); } catch { /* Not ours. */ }
    this.locked = false;
  }

  report(code, details = {}) {
    const next = { code, ...details };
    if (JSON.stringify(next) === JSON.stringify(this.status)) return;
    this.status = next;
    if (fs.existsSync(this.stateDir)) atomicJSON(this.statusFile, { ...next, at: new Date().toISOString() });
    if (code.endsWith('_failed') || code.startsWith('adapter_lock_') || code === 'kimi_config_changed') this.log(code);
  }

  saveState() { atomicJSON(this.stateFile, this.state); }

  async gatewayCatalog(target, key) {
    // Magpie applies this agent's visibility and model selection. The key
    // and registered User-Agent identify it; no credential/config file read.
    const response = await this.fetchImpl(target + '/models', {method: 'GET', headers: {
      Accept: 'application/json', Authorization: 'Bearer ' + key, 'User-Agent': 'Desktop Kimi Work',
    }, signal: AbortSignal.timeout(6000), redirect: 'error', proxy: ''});
    if (!response.ok || Number(response.headers.get('content-length') || 0) > 8 * 1024 * 1024) throw Error('catalog_unavailable');
    const text = await response.text();
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw Error('catalog_unavailable');
    return normalizeModels(JSON.parse(text), {allowEmpty: true});
  }

  async readSettings() {
    let desired;
    try { desired = readJSON(this.connectionFile); }
    catch (error) {
      if (error.code !== 'ENOENT') throw Error('settings_unavailable');
      return { enabled: false, primaryModel: '', secondaryModel: '', status: 'disconnected', models: [] };
    }
    let catalog = [], status = this.status.code || 'disconnected';
    if (desired.enabled && desired.gateway?.key) {
      try { catalog = await this.gatewayCatalog(gatewayURL(desired.gateway.url), desired.gateway.key); }
      catch { status = 'catalog_unavailable'; }
    }
    const appliedSecondaryModel = fs.existsSync(this.convertedNativeConfigFile) ? this.confirmedModelPool()
      : this.state?.secondaryPool ? undefined : this.state?.secondaryModel
        || (!this.state?.secondary ? this.state?.model || this.live?.model : undefined);
    return {
      enabled: desired.enabled === true,
      primaryModel: typeof desired.model === 'string' ? desired.model : '',
      secondaryModel: typeof desired.secondaryModel === 'string' ? desired.secondaryModel : '',
      ...(this.live && this.state?.active ? { appliedPrimaryModel: this.live.model } : {}),
      ...(this.live && this.state?.active && appliedSecondaryModel ? { appliedSecondaryModel } : {}),
      status,
      models: catalog.map(row => ({ id: row.id, name: row.menu.displayName })),
    };
  }

  async saveSettings(patch) {
    const fail = code => { throw Object.assign(Error(code), { code }); };
    const hasPrimary = Object.hasOwn(patch, 'primaryModel');
    const hasSecondary = Object.hasOwn(patch, 'secondaryModel');
    const { primaryModel, secondaryModel } = patch;
    let desired;
    try { desired = readJSON(this.connectionFile); } catch { fail('connect_kimi_first'); }
    if (hasPrimary || secondaryModel) {
      if (!desired.enabled || !desired.model || !desired.gateway?.key) fail('connect_kimi_first');
      if ((hasPrimary && !validModelID(primaryModel)) || (secondaryModel && !validModelID(secondaryModel))) {
        fail('model_not_enabled_for_kimi');
      }
      let catalog;
      try { catalog = await this.gatewayCatalog(gatewayURL(desired.gateway.url), desired.gateway.key); }
      catch { fail('settings_unavailable'); }
      if ((hasPrimary && !catalog.some(row => row.id === primaryModel))
          || (secondaryModel && !catalog.some(row => row.id === secondaryModel))) fail('model_not_enabled_for_kimi');
    }
    const sameGateway = value => value.gateway?.url === desired.gateway?.url && value.gateway?.key === desired.gateway?.key;
    let fresh;
    try { fresh = readJSON(this.connectionFile); } catch { fail('settings_unavailable'); }
    if (!sameGateway(fresh) || ((hasPrimary || secondaryModel) && !fresh.enabled)) fail('connection_changed');
    let primarySaved = false;
    if (hasPrimary && primaryModel !== fresh.model) {
      if (typeof this.setPrimaryModel !== 'function') fail('primary_model_unavailable');
      try { await this.setPrimaryModel(primaryModel); }
      catch (error) { fail(error?.code === 'primary_model_unavailable' ? error.code : 'primary_model_update_failed'); }
      try { fresh = readJSON(this.connectionFile); } catch { fail('primary_model_update_failed'); }
      if (!fresh.enabled || fresh.model !== primaryModel) fail('connection_changed');
      primarySaved = true;
      if (!sameGateway(fresh)) fail(hasSecondary ? 'settings_partially_saved' : 'connection_changed');
    }
    if (hasSecondary) {
      // The host owns model/gateway. Merge the requested secondary preference
      // only after its primary selection, into the newest connection document.
      const secondaryFailure = code => fail(primarySaved ? 'settings_partially_saved' : code);
      try { fresh = readJSON(this.connectionFile); } catch { secondaryFailure('settings_unavailable'); }
      if (!sameGateway(fresh) || ((hasPrimary || secondaryModel) && !fresh.enabled)
          || (hasPrimary && fresh.model !== primaryModel)) secondaryFailure('connection_changed');
      fresh.secondaryModel = secondaryModel;
      try { atomicJSON(this.connectionFile, fresh); } catch { secondaryFailure('settings_unavailable'); }
    }
    return this.readSettings();
  }

  publishCatalog(desired) {
    atomicJSON(this.catalogFile,{schemaVersion:1,enabled:true,exclusive:true,updatedAt:new Date().toISOString(),
      selectedAlias:this.catalog.find(x=>x.id===desired.model)?.alias||'',models:this.catalog.map(x=>x.menu)});
  }

  // Change one field in the newest document; never restore stale login tokens.
  changeBase(expected, replacement) {
    const before = fs.readFileSync(this.configFile), doc = JSON.parse(before.toString('utf8').replace(/^\uFEFF/, ''));
    if (baseURL(doc) !== expected) throw Error('kimi_config_changed');
    if (expected === replacement) return doc;
    doc.model.providers[PROVIDER].baseUrl = replacement;
    if (!fs.readFileSync(this.configFile).equals(before)) throw Error('kimi_config_changed');
    atomicJSON(this.configFile, doc);
    return doc;
  }

  async listen() {
    if (this.server) return;
    const server = http.createServer((req, res) => { void this.forward(req, res); });
    server.requestTimeout = 300000;
    server.headersTimeout = 15000;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    this.server = server;
    this.bridgeURL = 'http://127.0.0.1:' + server.address().port + '/v1';
  }

  async forward(req, res) {
    const error = (status, code) => {
      if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: { type: 'kimi_adapter_error', code, message: code } }));
    };
    if (req.method !== 'POST' || !['/v1/chat/completions', '/v1/search', '/v1/fetch'].includes(req.url)) {
      error(404, 'not_found'); return;
    }
    const active = this.live;
    if (!active) { error(503, 'kimi_not_connected'); return; }
    let doc;
    try { doc = readJSON(this.configFile); } catch { error(503, 'kimi_config_unavailable'); return; }
    if (!authenticated(req.headers.authorization, doc.credentials?.kimiCode?.apiKey)) {
      error(401, 'unauthorized'); return;
    }
    if (req.headers.origin || req.headers['sec-fetch-site']) { error(403, 'browser_request_refused'); return; }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300000);
    this.inflight.add(controller);
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    req.once('aborted', () => controller.abort());
    try {
      let length = 0;
      const chunks = [];
      for await (const chunk of req) {
        length += chunk.length;
        if (length > BODY_LIMIT) { error(413, 'request_too_large'); return; }
        chunks.push(chunk);
      }
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { error(400, 'invalid_json'); return; }
      if (!payload || Array.isArray(payload) || typeof payload !== 'object') { error(400, 'invalid_json'); return; }
      const inference = req.url === '/v1/chat/completions';
      if (inference) {
        const selected = this.catalog.find(x => x.alias === payload.model);
        if (!selected && isMenuAlias(payload.model)) { error(409, 'model_no_longer_available'); return; }
        const model=selected?.id||active.model;
        let allowed;
        try { allowed = await this.gatewayCatalog(active.gatewayURL, active.gatewayKey); }
        catch { error(503, 'catalog_unavailable'); return; }
        if (!allowed.some(row => row.id === model)) { error(409, 'model_not_enabled_for_kimi'); return; }
        payload.model = model;
        try { payload = applyInstructions(payload, this.instructionsFile); }
        catch (failure) { error(failure.message === 'invalid_messages' ? 400 : 503, failure.message); return; }
      }
      const headers = { 'Content-Type': 'application/json',
        Authorization: inference ? 'Bearer ' + active.gatewayKey : req.headers.authorization };
      for (const name of HEADERS) if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
      if (!headers['user-agent']) headers['user-agent'] = 'Desktop Kimi Work';
      const url = inference ? active.gatewayURL + '/chat/completions'
        : officialURL(active.originalBase) + req.url.slice('/v1'.length);
      const upstream = await this.fetchImpl(url, { method: 'POST', headers,
        body: JSON.stringify(payload), signal: controller.signal, redirect: 'error' });
      const responseHeaders = { 'Content-Type': upstream.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' };
      const retryAfter = upstream.headers.get('retry-after');
      if (retryAfter !== null) responseHeaders['Retry-After'] = retryAfter;
      res.writeHead(upstream.status, responseHeaders);
      res.flushHeaders();
      if (upstream.body) for await (const chunk of upstream.body) {
        if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
      }
      res.end();
    } catch {
      if (res.headersSent) res.destroy();
      else error(controller.signal.aborted ? 499 : 502, controller.signal.aborted ? 'request_cancelled' : 'upstream_connection_failed');
    } finally {
      clearTimeout(timeout);
      this.inflight.delete(controller);
    }
  }

  async restore({ reload = true } = {}) {
    // Read the two scalars before the control calls below can regenerate the
    // file, so a value another writer owns survives them.
    this.observeNativeSecondary();
    this.observeModelPool();
    if (!this.state?.active) return;
    let doc = readJSON(this.configFile);
    let modelsRestored = false;
    if (reload && baseURL(doc) === this.state.bridgeURL) {
      try {
        const runner = readJSON(this.runnerFile);
        const current = await this.rpcCall(runner, 'conversations.getKimiModelList');
        const native = (current?.models || []).filter(x => !isMenuAlias(x.model));
        if (native.length) {
          if (isMenuAlias(doc.model.current)) {
            let original;
            try {original=readJSON(this.modelBackupFile).current;} catch {}
            const alias=native.some(x => x.model === original) ? original : native[0].model;
            await this.rpcCall(runner,'conversations.setModel',{modelAlias:alias});
          }
          if (native.length !== current.models.length) await this.rpcCall(runner,'conversations.updateKimiModelList',{models:native});
          doc=readJSON(this.configFile);
          modelsRestored = true;
        }
      } catch { this.report('restored_waiting_kimi'); }
    }
    let changed = false;
    if (baseURL(doc) === this.state.bridgeURL) {
      this.changeBase(this.state.bridgeURL, this.state.originalBase);
      changed = true;
    }
    this.live = null;
    if (fs.existsSync(this.catalogFile)) atomicJSON(this.catalogFile, {schemaVersion: 1, enabled: false, models: [], updatedAt: new Date().toISOString()});
    this.state.active = false;
    this.saveState();
    if (changed && reload) {
      try {
        const current = readJSON(this.configFile);
        await this.rpcCall(readJSON(this.runnerFile), 'conversations.setModel', { modelAlias: current.model.current });
      } catch { this.report('restored_waiting_kimi'); }
    }
    // Only model fields were saved, never the full credentials-bearing config.
    if (modelsRestored) {
      try { fs.unlinkSync(this.modelBackupFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  async syncCatalog(runner, desired, target) {
    if (Date.now() < (this.catalogAfter || 0)) return;
    this.catalogAfter = Date.now() + 10000;
    if (busy(runner)) {
      // Long Work turns must retain their menu entries. Refresh the local
      // liveness timestamp without changing models or reloading a busy runtime.
      try {
        const keep = new Set((await this.gatewayCatalog(target, desired.gateway.key)).map(x => x.id));
        this.catalog=this.catalog.filter(x=>keep.has(x.id));
        const saved=readJSON(this.catalogFile);
        if(saved.enabled) this.publishCatalog(desired);
      } catch { /* Initial connection waits until idle. */ }
      return;
    }
    try {
      const catalog = await this.gatewayCatalog(target, desired.gateway.key);
      const current = await this.rpcCall(runner, 'conversations.getKimiModelList');
      if (!Array.isArray(current?.models)) throw Error('catalog_unavailable');
      const merged = mergeRuntimeModels(current.models, catalog);
      const same = merged.length === current.models.length && catalog.every(wanted => {
        const found = current.models.find(x => x.model === wanted.alias);
        return found && Object.entries(wanted.runtime).every(([key,value]) => {
          const left = Array.isArray(value) ? [...value].sort() : value;
          const right = Array.isArray(found[key]) ? [...found[key]].sort() : found[key];
          return JSON.stringify(left) === JSON.stringify(right);
        });
      });
      if (!same) {
        if (!fs.existsSync(this.modelBackupFile)) {
          atomicJSON(this.modelBackupFile, {models: current.models, current: readJSON(this.configFile).model.current});
        }
        await this.rpcCall(runner, 'conversations.updateKimiModelList', {models: merged});
      }
      this.catalog = catalog;
      this.publishCatalog(desired);
      this.catalogError = null;
    } catch { this.catalogError = 'catalog_sync_failed'; }
  }

  // --- Secondary model -----------------------------------------------------
  // Kimi persists the secondary role in two scalars of its runtime TOML:
  //   [secondary_model] model = "<registered alias>"
  //   [experimental]    "secondary-model" = true
  // Only those two parsed settings change; Bun reserializes the whole TOML,
  // which can normalize comments and spelling. No full-file backup is kept.

  readNativeSecondary() {
    return inspectSecondary(fs.readFileSync(this.nativeConfigFile, 'utf8'));
  }

  // Replace the runtime TOML atomically, but only while it still holds the
  // bytes this patch was computed from. Mode 0600, same as Kimi's own writes.
  commitNativeSecondary(bytes, text, file = this.nativeConfigFile) {
    if (!fs.readFileSync(file).equals(bytes)) throw Error('kimi_config_changed');
    const temp = file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    try {
      fs.writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, file);
    } finally { try { fs.unlinkSync(temp); } catch { /* Renamed. */ } }
  }

  // Ownership is the four-field baseline plus the alias this adapter wrote. It
  // is persisted with the adapter state and survives rebuilding the main state
  // object; it is only dropped once the baseline is back on disk.
  secondaryOwnership() {
    const owned = this.state?.secondary;
    const baseline = plainSnapshot(owned?.baseline);
    return baseline ? { baseline, alias: typeof owned.alias === 'string' ? owned.alias : '',
      restored: owned.restored === true } : null;
  }

  captureSecondaryBaseline() {
    if (this.secondaryOwnership()) return;
    let baseline;
    try { baseline = this.readNativeSecondary(); }
    catch {
      // Native secondary settings are optional. Connect the primary first;
      // reconcileSecondary classifies unreadable or unsupported input later.
      return;
    }
    this.state.secondary = { baseline, alias: '' };
    this.saveState();
  }

  setAppliedSecondary(value) {
    if (!this.state) return;
    let changed = this.state.secondaryModel !== value;
    this.state.secondaryModel = value;
    if (value && this.state.secondary?.restored) {
      delete this.state.secondary.restored;
      changed = true;
    }
    if (changed) this.saveState();
  }

  dropSecondaryOwnership() {
    const changed = Boolean(this.state?.secondary) || Boolean(this.state?.secondaryModel);
    if (this.state?.secondary) delete this.state.secondary;
    if (this.state) this.state.secondaryModel = '';
    this.secondaryPending.clear();
    this.secondaryReloadPending = false;
    this.secondaryReloadStale = false;
    this.secondaryExternal = null;
    if (changed) this.saveState();
  }

  // Read the file before a control call that can make Daimon rewrite it: keep
  // the scalars another writer owns, and capture the original values on the
  // first application. Nothing is read while the feature is not in use.
  protectNativeSecondary(wanted) {
    this.observeNativeSecondary();
    this.observeModelPool();
    if (fs.existsSync(this.convertedNativeConfigFile)) {
      if ((wanted || this.secondaryOwnership()) && !this.modelPoolOwnership()) this.captureModelPoolBaseline();
    } else if (wanted && !this.secondaryOwnership() && !this.modelPoolOwnership()) {
      this.captureSecondaryBaseline();
    }
  }

  // Only the helper's four fields of the scalars this adapter does not own.
  observeNativeSecondary() {
    const owned = this.secondaryOwnership();
    if (!owned) { this.secondaryExternal = null; return; }
    let current;
    try { current = this.readNativeSecondary(); } catch { return; }
    // A prior control call may have removed an external value while a cached
    // session was still busy. Keep that observation until it is back on disk.
    this.secondaryExternal = externalFields(this.effectiveSecondary(current), owned);
  }

  // A rewrite may have dropped a scalar observed just before it; that value
  // stands in for the missing one so it can be put back afterwards.
  effectiveSecondary(current) {
    const external = this.secondaryExternal;
    if (!external) return current;
    const model = current.model === null && external.model !== null ? external.model : current.model;
    const enabled = current.enabled === null && external.enabled !== null ? external.enabled : current.enabled;
    return {
      model, enabled,
      hasSecondaryTable: model === current.model ? current.hasSecondaryTable : external.hasSecondaryTable,
      hasExperimentalTable: enabled === current.enabled ? current.hasExperimentalTable : external.hasExperimentalTable,
    };
  }

  // V2 owns only the pool/default keys. Model and provider definitions can carry
  // credentials, so they are validated in memory and never copied into state.
  modelPoolOwnership() {
    const owned = this.state?.secondaryPool;
    const baseline = plainPoolSnapshot(owned?.baseline);
    return baseline ? { baseline, written: plainPoolSnapshot(owned.written),
      selection: typeof owned.selection === 'string' ? owned.selection : '', restored: owned.restored === true } : null;
  }

  convertedConfig(text) {
    let doc;
    try { doc = Bun.TOML.parse(text); } catch { throw Error('secondary_model_unsupported_runtime'); }
    if (!record(doc.models) || !record(doc.providers) || typeof doc.default_model !== 'string'
        || !record(doc.models[doc.default_model]) || !record(doc.loop_control)
        || !Number.isSafeInteger(doc.loop_control.max_attempts_per_step)
        || doc.loop_control.max_attempts_per_step < 0 || Object.hasOwn(doc.loop_control, 'max_retries_per_step')) {
      throw Error('secondary_model_unsupported_runtime');
    }
    return doc;
  }

  assertModelPoolAliases(doc, aliases) {
    for (const alias of aliases) {
      const model = doc.models[alias];
      if (!isMenuAlias(alias) || !record(model) || model.provider !== PROVIDER || model.model !== alias
          || (model.name !== undefined && model.name !== alias)
          || !record(doc.providers[PROVIDER]) || doc.providers[PROVIDER].type !== 'kimi') {
        throw Error('secondary_model_unsupported_runtime');
      }
    }
  }

  captureModelPoolBaseline() {
    let baseline;
    try {
      const text = fs.readFileSync(this.convertedNativeConfigFile, 'utf8');
      this.convertedConfig(text);
      baseline = inspectModelPool(text);
    } catch { return; } // The primary connects before optional native errors are reported.
    this.state.secondaryPool = { baseline, written: null, selection: '' };
    this.saveState();
  }

  confirmedModelPool() {
    const owned = this.modelPoolOwnership();
    if (!owned?.written?.models || !this.state?.secondaryPoolModel) return;
    try {
      const text = fs.readFileSync(this.convertedNativeConfigFile, 'utf8');
      this.assertModelPoolAliases(this.convertedConfig(text), Object.keys(owned.written.models));
      if (samePool(inspectModelPool(text), owned.written)) {
        return this.state.secondaryPoolModel;
      }
    } catch { /* An unreadable or changed pool has no current confirmation. */ }
  }

  setAppliedModelPool(value) {
    if (!this.state) return;
    let changed = this.state.secondaryPoolModel !== value;
    this.state.secondaryPoolModel = value;
    if (value && this.state.secondaryPool?.restored) { delete this.state.secondaryPool.restored; changed = true; }
    if (changed) this.saveState();
  }

  observeModelPool() {
    const owned = this.modelPoolOwnership();
    if (!owned?.written) { this.modelPoolExternal = null; return; }
    let current;
    try { current = this.effectiveModelPool(inspectModelPool(fs.readFileSync(this.convertedNativeConfigFile, 'utf8'))); }
    catch { return; }
    if (owned.restored && samePool(current, owned.baseline)) { this.modelPoolExternal = null; return; }
    const foreignModels = current.models !== null && !sameModels(current.models, owned.written.models);
    const foreignDefault = current.defaultModel !== null && current.defaultModel !== owned.written.defaultModel;
    // Pool keys and its default form one valid binding. Preserve the whole
    // narrow snapshot if either part changed, including across regeneration.
    this.modelPoolExternal = foreignModels || foreignDefault ? current : null;
  }

  effectiveModelPool(current) {
    const external = this.modelPoolExternal;
    if (!external) return current;
    const models = current.models === null && external.models !== null ? external.models : current.models;
    const defaultModel = current.defaultModel === null && external.defaultModel !== null ? external.defaultModel : current.defaultModel;
    return { models, defaultModel,
      hasSecondaryTable: current.hasSecondaryTable || external.hasSecondaryTable,
      hasModelsTable: models === current.models ? current.hasModelsTable : external.hasModelsTable };
  }

  useSecondaryReloadRuntime(runtime) {
    const generation = this.state?.generation;
    if (this.secondaryReloadRuntime === runtime && this.secondaryReloadGeneration === generation) return;
    this.secondaryReloadRuntime = runtime;
    this.secondaryReloadGeneration = generation;
    this.secondaryPending.clear();
    this.secondaryReloadPending = false;
    this.secondaryReloadStale = false;
    this.secondaryAfter = 0;
  }

  async confirmModelPoolReload(runner, requireSession) {
    const retried = await this.retrySecondarySessions(runner);
    if (retried.failed) throw Error('secondary_model_reload_failed');
    if (retried.pending) return { waiting: true };
    if (!this.secondaryReloadPending) return {};
    if (!runner || runner.lifecycleStatus !== 'running') return requireSession ? { waitingSession: true } : {};
    if (busy(runner)) return { waiting: true };
    if (Date.now() < this.secondaryAfter) return requireSession ? { waitingSession: true } : { waiting: true };
    const reload = await this.reloadSecondarySessions(runner);
    if (reload.failed) throw Error('secondary_model_reload_failed');
    if (reload.pending) return { waiting: true };
    // Unlike legacy, an empty V2 batch does not reload the shared ConfigService.
    if (requireSession && !reload.confirmed) return { waitingSession: true };
    this.secondaryReloadPending = false;
    return {};
  }

  async reconcileModelPool(runner, wanted, primary) {
    let owned = this.modelPoolOwnership();
    if (!wanted && !owned && !this.secondaryOwnership()) return { untouched: true };
    this.useSecondaryReloadRuntime('v2');
    this.setAppliedSecondary(''); // Never carry a legacy acknowledgement into V2.
    let bytes, doc, fileState;
    try {
      bytes = fs.readFileSync(this.convertedNativeConfigFile);
      doc = this.convertedConfig(bytes.toString('utf8'));
      fileState = inspectModelPool(bytes.toString('utf8'));
    } catch { this.setAppliedModelPool(''); throw Error('secondary_model_unsupported_runtime'); }
    const primaryRow = this.catalog.find(row => row.id === primary);
    const secondaryRow = this.catalog.find(row => row.id === (wanted || primary));
    if (!primaryRow || !secondaryRow) { this.setAppliedModelPool(''); throw Error('secondary_model_unavailable'); }
    try { this.assertModelPoolAliases(doc, [primaryRow.alias, secondaryRow.alias]); }
    catch (error) { this.setAppliedModelPool(''); throw error; }
    const nativeEffort = doc.secondary_model?.default_effort;
    if (nativeEffort !== undefined) {
      if (typeof nativeEffort !== 'string') { this.setAppliedModelPool(''); throw Error('secondary_config_unsupported'); }
      const effort = nativeEffort.trim().toLowerCase();
      for (const row of [primaryRow, secondaryRow]) {
        if (!effort) break;
        const model = doc.models[row.alias];
        const capabilities = Array.isArray(model.capabilities)
          ? model.capabilities.filter(value => typeof value === 'string').map(value => value.trim().toLowerCase())
          : model.capabilities?.thinking === true ? ['thinking'] : [];
        const always = model.always_thinking === true || capabilities.includes('always_thinking');
        const thinking = always || model.adaptive_thinking === true || capabilities.includes('thinking');
        const efforts = Array.isArray(model.support_efforts)
          ? model.support_efforts.filter(value => typeof value === 'string').map(value => value.trim()).filter(Boolean) : [];
        if (effort === 'off' ? always : !thinking || (efforts.length > 0 && effort !== 'on' && !efforts.includes(effort))) {
          this.setAppliedModelPool(''); throw Error('secondary_config_unsupported');
        }
      }
    }
    const requested = { models: primaryRow.alias === secondaryRow.alias
      ? { [primaryRow.alias]: 'Primary and secondary model / 主模型与副模型' }
      : { [primaryRow.alias]: 'Primary model / 主模型', [secondaryRow.alias]: 'Secondary model / 副模型' },
      defaultModel: secondaryRow.alias, hasSecondaryTable: true, hasModelsTable: true };
    const selection = sha(JSON.stringify([primary, wanted || primary]));
    const current = this.effectiveModelPool(fileState);
    const reassert = !owned || owned.selection !== selection || (owned.restored && samePool(current, owned.baseline));
    const ownsModels = current.models === null || sameModels(current.models, requested.models)
      || Boolean(owned?.written && sameModels(current.models, owned.written.models));
    const ownsDefault = current.defaultModel === null || current.defaultModel === requested.defaultModel
      || current.defaultModel === owned?.written?.defaultModel;
    const target = reassert || (ownsModels && ownsDefault) ? requested : current;
    let next;
    try { next = patchModelPool(bytes.toString('utf8'), target); }
    catch { this.setAppliedModelPool(''); throw Error('secondary_model_unsupported_runtime'); }
    const changed = next !== bytes.toString('utf8');
    const applied = samePool(target, requested);
    const newSelection = !owned?.written || owned.selection !== selection || !samePool(owned.written, requested);
    if (changed || newSelection || !applied) this.setAppliedModelPool('');
    if ((changed || newSelection || this.secondaryReloadPending || (applied && !this.state.secondaryPoolModel)) && busy(runner)) {
      return { waiting: true };
    }
    if (!owned) {
      this.state.secondaryPool = { baseline: fileState, written: null, selection: '' };
      owned = this.modelPoolOwnership();
    }
    if (newSelection) {
      this.state.secondaryPool.written = requested;
      this.state.secondaryPool.selection = selection;
      this.saveState();
    }
    if (changed || newSelection) {
      this.secondaryPending.clear();
      this.secondaryReloadStale = false;
      this.secondaryAfter = 0;
      this.secondaryReloadPending = true;
    }
    if (changed) this.commitNativeSecondary(bytes, next, this.convertedNativeConfigFile);
    this.modelPoolExternal = null;
    if (applied && !this.state.secondaryPoolModel) this.secondaryReloadPending = true;
    const confirmation = await this.confirmModelPoolReload(runner, applied);
    if (confirmation.waiting || confirmation.waitingSession) return confirmation;
    if (!applied) return { applied: false };
    this.setAppliedModelPool(wanted || primary);
    return { applied: true };
  }

  restoreModelPoolOnExit() {
    const owned = this.modelPoolOwnership();
    if (!owned) return;
    const bytes = fs.readFileSync(this.convertedNativeConfigFile);
    const current = this.effectiveModelPool(inspectModelPool(bytes.toString('utf8')));
    const ownsModels = current.models === null || Boolean(owned.written && sameModels(current.models, owned.written.models));
    const ownsDefault = current.defaultModel === null || current.defaultModel === owned.written?.defaultModel;
    const target = ownsModels && ownsDefault ? owned.baseline : current;
    const next = patchModelPool(bytes.toString('utf8'), target);
    if (next !== bytes.toString('utf8')) this.commitNativeSecondary(bytes, next, this.convertedNativeConfigFile);
    if (ownsModels && ownsDefault) { this.state.secondaryPool.restored = true; this.saveState(); }
    this.setAppliedModelPool('');
  }

  async restoreModelPools(runner) {
    if (busy(runner)) return { waiting: true };
    const starting = this.secondaryReloadRuntime !== 'v2-restore';
    this.useSecondaryReloadRuntime('v2-restore');
    // Both files return to their own baseline before confirming the final state.
    this.restoreNativeSecondaryOnExit();
    this.restoreModelPoolOnExit();
    if (starting) this.secondaryReloadPending = true;
    const confirmation = await this.confirmModelPoolReload(runner, false);
    if (confirmation.waiting) return confirmation;
    this.dropSecondaryOwnership();
    delete this.state.secondaryPool;
    delete this.state.secondaryPoolModel;
    this.modelPoolExternal = null;
    this.saveState();
    return { applied: true };
  }

  // Cached sessions only. An empty list means there is nothing left to reload;
  // an unconfirmed session is retried by id once the runtime is idle. Every row
  // is accounted for by id, so a mixed skipped+failed result can never become a
  // false "applied".
  async reloadSecondarySessions(runner) {
    this.secondaryAfter = Date.now() + SECONDARY_RETRY_MS;
    let result;
    try { result = await this.rpcCall(runner, RELOAD_SESSIONS, {}, { timeout: 30000 }); }
    catch { this.secondaryReloadStale = true; return { failed: true }; }
    if (!Array.isArray(result?.sessions)) { this.secondaryReloadStale = true; return { failed: true }; }
    let failed = false, confirmed = false;
    for (const session of result.sessions) {
      const status = session?.status;
      const id = typeof session?.kernelSessionId === 'string' && session.kernelSessionId
        ? session.kernelSessionId : '';
      if (status === 'reloaded') { if (id) { confirmed = true; this.secondaryPending.delete(id); } continue; }
      if ((status === 'skipped-active-turn' || status === 'failed') && id) {
        this.secondaryPending.add(id);
        if (status === 'failed') failed = true;
        continue;
      }
      // A row that cannot be retried by id: only a complete pass resolves it.
      this.secondaryReloadStale = true;
      failed = true;
    }
    if (failed) return { failed: true };
    const pending = this.secondaryPending.size > 0;
    if (!pending) this.secondaryReloadStale = false;
    return { pending, confirmed };
  }

  // Retry only the ids a previous pass left unconfirmed. Sessions that were
  // already reloaded are never reloaded again.
  async retrySecondarySessions(runner) {
    if (!this.secondaryPending.size) return { pending: false };
    if (busy(runner)) return { pending: true };
    if (Date.now() < (this.secondaryAfter || 0)) return { pending: true };
    this.secondaryAfter = Date.now() + SECONDARY_RETRY_MS;
    for (const kernelSessionId of [...this.secondaryPending]) {
      let result;
      try { result = await this.rpcCall(runner, RELOAD_SESSION, { kernelSessionId }, { timeout: 30000 }); }
      catch { return { failed: true }; }
      const status = result?.status;
      if (status === 'skipped-active-turn') continue;
      // Only an explicit acknowledgement counts; a timeout, an unknown shape or
      // any other status means the preference is not applied.
      if (status !== 'reloaded') return { failed: true };
      this.secondaryPending.delete(kernelSessionId);
    }
    if (this.secondaryPending.size) return { pending: true };
    // A complete pass the adapter could not attribute still has to be redone.
    if (!this.secondaryReloadStale) this.secondaryReloadPending = false;
    return { pending: false, confirmed: true };
  }

  // A connected empty preference follows inheritModel; a restore call omits
  // it and puts the baseline back. Returns {untouched}, {applied:false} or
  // {waiting}; unsupported input and unconfirmed reloads throw a fixed code.
  // With no preference and no ownership the runtime TOML is never read.
  async reconcileSecondary(runner, wanted, { inheritModel = '' } = {}) {
    if (!wanted && !inheritModel) {
      if (this.modelPoolOwnership()) return this.restoreModelPools(runner);
    } else if (fs.existsSync(this.convertedNativeConfigFile) || this.modelPoolOwnership()) {
      return this.reconcileModelPool(runner, wanted, inheritModel);
    }
    return this.reconcileLegacySecondary(runner, wanted, { inheritModel });
  }

  async reconcileLegacySecondary(runner, wanted, { inheritModel = '' } = {}) {
    const owned = this.secondaryOwnership();
    if (!wanted && !owned) { this.secondaryExternal = null; return { untouched: true }; }
    const inheriting = !wanted && Boolean(inheritModel);
    if (inheriting) wanted = inheritModel;

    const retried = await this.retrySecondarySessions(runner);
    if (retried.failed) throw Error('secondary_model_reload_failed');
    if (retried.pending) return { waiting: true };

    let row = null;
    if (wanted) {
      row = this.catalog.find(candidate => candidate.id === wanted) || null;
      if (!row) throw Error('secondary_model_unavailable');
    }

    let bytes;
    try { bytes = fs.readFileSync(this.nativeConfigFile); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw Error('secondary_config_unsupported');
      if (wanted) throw Error('secondary_model_unavailable');
      this.dropSecondaryOwnership();
      return { applied: false, absent: true };
    }
    const text = bytes.toString('utf8');
    let fileState;
    try { fileState = inspectSecondary(text); } catch { throw Error('secondary_config_unsupported'); }
    const current = this.effectiveSecondary(fileState);

    let target;
    if (wanted) {
      // A saved preference that differs from the alias this adapter wrote is an
      // explicit change and takes effect. Otherwise only an adapter-owned or a
      // dropped scalar is replaced; another writer's value stays untouched.
      const reassert = owned === null || (!inheriting && owned.alias !== row.alias) || isRestoredBaseline(current, owned);
      const ownsModel = current.model === null || current.model === row.alias
        || (owned !== null && current.model === owned.alias);
      const ownsFlag = current.enabled === null || current.enabled === true;
      target = { model: (ownsModel || reassert) ? row.alias : current.model,
        enabled: (ownsFlag || reassert) ? true : current.enabled,
        hasSecondaryTable: true, hasExperimentalTable: true };
    } else {
      target = restoreTarget(current, owned.baseline, owned.alias);
    }

    let next;
    try { next = patchSecondary(text, target); } catch { throw Error('secondary_config_unsupported'); }
    const changed = next !== text;
    const appliedNow = wanted ? target.model === row.alias && target.enabled === true : true;
    const confirmationNeeded = appliedNow && !retried.confirmed && Boolean(wanted || this.state.secondaryModel)
      && this.state.secondaryModel !== wanted;
    // Matching file bytes do not prove that existing cached sessions have read
    // a newly selected preference. They need one acknowledgement as well.
    if ((changed || confirmationNeeded || this.secondaryReloadPending) && busy(runner)) return { waiting: true };
    if (changed) {
      if (wanted && !owned) {
        // First capture uses the file as it is, never the preserved view.
        this.state.secondary = { baseline: fileState, alias: '' };
      }
      if (wanted && target.model === row.alias && this.state.secondary.alias !== row.alias) {
        // Record intent before the write; a crash in between then leaves the
        // file exactly as it was.
        this.state.secondary.alias = row.alias;
        this.saveState();
      }
      this.commitNativeSecondary(bytes, next);
      this.secondaryReloadPending = true;
    } else if (wanted && !owned) {
      // Already in place without a captured baseline: never claim it.
      return { applied: false };
    }
    if (wanted && appliedNow && this.state.secondary.alias !== row.alias) {
      this.state.secondary.alias = row.alias;
      this.saveState();
    }
    if (confirmationNeeded) this.secondaryReloadPending = true;
    this.secondaryExternal = null;

    if (this.secondaryReloadPending) {
      if (!runner || runner.lifecycleStatus !== 'running') {
        // No live runtime caches the old value; the next start reads the file.
        this.secondaryReloadPending = false;
        this.secondaryPending.clear();
        this.secondaryReloadStale = false;
      } else {
        if (Date.now() < (this.secondaryAfter || 0)) return { waiting: true };
        const reload = await this.reloadSecondarySessions(runner);
        if (reload.failed) throw Error('secondary_model_reload_failed');
        if (reload.pending) return { waiting: true };
        this.secondaryReloadPending = false;
      }
    }

    if (!appliedNow) { this.setAppliedSecondary(''); return { applied: false }; }
    if (wanted) {
      this.setAppliedSecondary(wanted);
      return { applied: true };
    }
    // The baseline is back on disk and the runtime was reloaded.
    this.dropSecondaryOwnership();
    return { applied: true };
  }

  // Synchronous exit path: only the two owned scalars, no RPC. Ownership stays
  // on disk so the next start can finish anything left behind.
  restoreNativeSecondaryOnExit() {
    const owned = this.secondaryOwnership();
    if (!owned) return;
    const bytes = fs.readFileSync(this.nativeConfigFile);
    const text = bytes.toString('utf8');
    const current = this.effectiveSecondary(inspectSecondary(text));
    const next = patchSecondary(text, restoreTarget(current, owned.baseline, owned.alias));
    if (next !== text) this.commitNativeSecondary(bytes, next);
    // A clean exit deliberately restored our own two scalars. Distinguish that
    // baseline from a later third-party edit when the saved preference resumes.
    if ((current.model === null || current.model === owned.alias)
        && (current.enabled === null || current.enabled === true)) {
      this.state.secondary.restored = true;
      this.saveState();
    }
  }

  async tick() {
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      if (!this.bootstrap()) return;
      if (!this.ownLock()) return;
      const desired = readJSON(this.connectionFile);
      let runner;
      try { runner = readJSON(this.runnerFile); } catch { /* Kimi isn't running yet. */ }
      if (!desired.enabled || !desired.model) {
        if (this.state.active && busy(runner)) { this.report('waiting_kimi_idle'); return; }
        const wasActive = this.state.active;
        await this.restore();
        if (wasActive && (this.secondaryOwnership() || this.modelPoolOwnership())) {
          // These ids were waiting for the old preference. A full disconnect
          // restores the file first and starts confirmation of that baseline.
          this.secondaryPending.clear();
          this.secondaryReloadStale = false;
          this.secondaryReloadPending = true;
          this.secondaryAfter = 0;
        }
        // Restoring the two native scalars runs after every control call above,
        // because Daimon rewrites its runtime TOML from its own state.
        const secondary = await this.reconcileSecondary(runner, '');
        this.pausedSignature = null;
        this.retryAfter = 0;
        this.report(secondary.waiting ? 'waiting_kimi_idle' : 'disconnected');
        return;
      }
      const target = gatewayURL(desired.gateway?.url);
      const wantedSecondary = typeof desired.secondaryModel === 'string' ? desired.secondaryModel : '';
      if (typeof desired.gateway?.key !== 'string' || !desired.gateway.key
          || typeof desired.model !== 'string' || !desired.model.includes('/') || desired.model.length > 1024
          || (desired.secondaryModel !== undefined && typeof desired.secondaryModel !== 'string')
          || (wantedSecondary !== '' && !validModelID(wantedSecondary))) {
        throw Error('invalid_connection');
      }
      if (!runner || runner.lifecycleStatus !== 'running') { this.report('waiting_kimi'); return; }
      const bytes = fs.readFileSync(this.configFile), doc = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
      const generation = sha(JSON.stringify([runner.daemonGeneration, runner.control?.endpoint?.url,
        runner.control?.endpoint?.startedAt, runner.control?.endpoint?.pid]));
      const signature = sha(JSON.stringify([desired.model, target, desired.gateway.key]));
      const fingerprint = sha(bytes);
      if (fingerprint !== this.fingerprint) { this.fingerprint = fingerprint; this.stableSince = Date.now(); }
      const unchanged = this.state.active && this.state.generation === generation && this.state.signature === signature;
      if (unchanged && baseURL(doc) === this.bridgeURL && this.live) {
        this.protectNativeSecondary(wantedSecondary);
        await this.syncCatalog(runner, desired, target);
        const secondary = await this.reconcileSecondary(runner, wantedSecondary, { inheritModel: desired.model });
        if (secondary.waitingSession) { this.report('secondary_model_waiting_session'); return; }
        if (secondary.waiting) { this.report('waiting_kimi_idle'); return; }
        if (secondary.applied === false) { this.report('kimi_config_changed'); return; }
        this.report('connected', { model: desired.model, models: this.catalog.length, ...(this.catalogError ? {catalog: this.catalogError} : {}) }); return;
      }
      if (this.pausedSignature === signature) { this.report('kimi_config_changed'); return; }
      if (unchanged && this.live && baseURL(doc) !== this.bridgeURL) {
        this.pausedSignature = signature;
        this.live = null;
        this.report('kimi_config_changed');
        return;
      }
      if (busy(runner)) { this.report('waiting_kimi_idle'); return; }
      if (Date.now() - this.stableSince < this.stabilityMs) { this.report('waiting_kimi_ready'); return; }
      if (Date.now() < (this.retryAfter || 0)) return;
      this.retryAfter = Date.now() + 5000;
      const oldBase = baseURL(doc);
      const originalBase = this.state.active && oldBase === this.state.bridgeURL
        ? officialURL(this.state.originalBase) : officialURL(oldBase);
      if (!doc.model.models?.[doc.model.current] || typeof doc.credentials?.kimiCode?.apiKey !== 'string') {
        throw Error('unsupported_kimi_config');
      }
      await this.rpcCall(runner, 'models.current');
      await this.listen();
      if (!fs.readFileSync(this.configFile).equals(bytes)) throw Error('kimi_config_changed');
      // Protect the two scalars before the first control call below can make
      // Daimon rewrite its runtime TOML from a fixed key set.
      this.protectNativeSecondary(wantedSecondary);
      const previous = this.state;
      this.state = { active: true, originalBase, bridgeURL: this.bridgeURL, generation, signature, model: desired.model,
        ...(previous?.secondary ? { secondary: previous.secondary } : {}),
        ...(previous?.secondaryPool ? { secondaryPool: previous.secondaryPool, secondaryPoolModel: '' } : {}),
        ...(typeof previous?.secondaryModel === 'string' ? { secondaryModel: previous.secondaryModel } : {}) };
      // Persist recovery ownership before writing the Kimi file.
      this.saveState();
      this.changeBase(oldBase, this.bridgeURL);
      try {
        await this.rpcCall(runner, 'conversations.setModel', { modelAlias: doc.model.current });
      } catch (error) {
        this.changeBase(this.bridgeURL, oldBase);
        this.state = previous;
        this.saveState();
        throw error;
      }
      this.live = { model: desired.model, gatewayURL: target, gatewayKey: desired.gateway.key, originalBase };
      await this.syncCatalog(runner, desired, target);
      // Reapply after the catalog sync, which may regenerate the same file.
      const secondary = await this.reconcileSecondary(runner, wantedSecondary, { inheritModel: desired.model });
      this.pausedSignature = null;
      if (secondary.waitingSession) { this.report('secondary_model_waiting_session'); return; }
      if (secondary.waiting) { this.report('waiting_kimi_idle'); return; }
      if (secondary.applied === false) { this.report('kimi_config_changed'); return; }
      this.report('connected', { model: desired.model });
    } catch (error) {
      const codes = new Set(['invalid_gateway', 'invalid_connection', 'unsupported_kimi_config',
        'library_path_conflict', 'adapter_lock_invalid', 'adapter_lock_unavailable',
        'kimi_config_changed', 'kimi_control_unavailable', 'kimi_control_timeout', 'kimi_control_closed', 'kimi_control_rejected',
        'secondary_config_unsupported', 'secondary_model_unavailable', 'secondary_model_reload_failed',
        'secondary_model_unsupported_runtime']);
      const code = codes.has(error.message) ? error.message : 'adapter_failed';
      this.report(code);
    } finally { this.running = false; }
  }

  async start() {
    await this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  async stop() {
    clearInterval(this.timer);
    this.stopping = true;
    const settingsServer = this.settingsServer;
    this.settingsServer = null;
    await settingsServer?.stop();
    while (this.running) await new Promise(resolve => setTimeout(resolve, 20));
    if (this.locked) {
      try { await this.restore(); } catch { /* Never write a changed third-party configuration. */ }
      // Restore primary/menu settings through the normal control API first.
      // The owned secondary fields then return to disk without extra session
      // reload calls; keep ownership for the next start, as on synchronous exit.
      let code = 'disconnected';
      try {
        this.restoreNativeSecondaryOnExit();
      } catch (error) {
        if (SECONDARY_CODES.has(error.message)) code = error.message;
      }
      try { this.restoreModelPoolOnExit(); }
      catch { code = 'secondary_config_unsupported'; }
      this.report(code);
      this.releaseLock();
    }
    for (const pending of this.inflight) pending.abort();
    if (this.server) {
      this.server.closeAllConnections?.();
      await new Promise(resolve => this.server.close(resolve));
      this.server = null;
    }
  }

  restoreFileOnExit() {
    if (!this.locked) return;
    try {
      if (this.state?.active && baseURL(readJSON(this.configFile)) === this.state.bridgeURL) {
        this.changeBase(this.state.bridgeURL, this.state.originalBase);
      }
    } catch { /* Leave a changed configuration alone. */ }
    // Synchronous host exit: only the two owned scalars, never a control call.
    // Ownership stays on disk so the next start can finish anything left over.
    try { this.restoreNativeSecondaryOnExit(); } catch { /* Leave a changed configuration alone. */ }
    try { this.restoreModelPoolOnExit(); } catch { /* Leave a changed configuration alone. */ }
    try { atomicJSON(this.catalogFile, {schemaVersion:1, enabled:false, models:[], updatedAt:new Date().toISOString()}); } catch { /* Exiting. */ }
    this.releaseLock();
  }
}
