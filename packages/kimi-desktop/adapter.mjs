import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { rpc } from './rpc.mjs';
import { normalizeModels, isMenuAlias, canonicalMenuAlias, neutralPromptAliases } from './catalog.mjs';
import { prepareLibrary, applyInstructions } from './library.mjs';
import { inspectSecondary, patchSecondary } from './secondary-config.mjs';
import { inspectModelPool, patchModelPool } from './model-pool-config.mjs';
import { AgentModelRouter } from './agent-routing.mjs';
import { ensureAgentProfiles } from './agent-profiles.mjs';
import { kernelFamily, runnerGeneration } from './runtime-family.mjs';

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

function rolePluginFiles(directory) {
  const names = ['kimi.plugin.json', ...fs.readdirSync(path.join(directory, 'agents')).sort().map(name => {
    if (!/^local-agent-[a-f0-9]{24}\.md$/.test(name)) throw Error('agent_profile_conflict');
    return 'agents/' + name;
  })];
  return Object.fromEntries(names.map(name => {
    const file = path.join(directory, name);
    if (!fs.lstatSync(file).isFile()) throw Error('agent_profile_conflict');
    return [name, sha(fs.readFileSync(file))];
  }));
}
const sameFiles = (left, right) => record(left) && record(right)
  && Object.keys(left).length === Object.keys(right).length
  && Object.entries(left).every(([key, value]) => right[key] === value);

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

function atomicJSON(file, value, expectedBytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    if (expectedBytes && !fs.readFileSync(file).equals(expectedBytes)) throw Error('kimi_config_changed');
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
    this.rolesReady = false;
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
    const appliedSecondaryModel = this.rolesReady ? this.bridgeSecondaryModel : undefined;
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
      let freshBytes;
      try {
        freshBytes = fs.readFileSync(this.connectionFile);
        fresh = JSON.parse(freshBytes.toString('utf8').replace(/^\uFEFF/, ''));
      } catch { secondaryFailure('settings_unavailable'); }
      if (!sameGateway(fresh) || ((hasPrimary || secondaryModel) && !fresh.enabled)
          || (hasPrimary && fresh.model !== primaryModel)) secondaryFailure('connection_changed');
      fresh.secondaryModel = secondaryModel;
      try { atomicJSON(this.connectionFile, fresh, freshBytes); }
      catch (error) { secondaryFailure(error?.message === 'kimi_config_changed' ? 'connection_changed' : 'settings_unavailable'); }
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
    atomicJSON(this.configFile, doc, before);
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
      let routing, roles, router;
      if (inference) {
        const selected = this.catalog.find(x => x.alias === canonicalMenuAlias(payload.model));
        if (!selected && isMenuAlias(payload.model)) { error(409, 'model_no_longer_available'); return; }
        let allowed;
        try { allowed = await this.gatewayCatalog(active.gatewayURL, active.gatewayKey); }
        catch { error(503, 'catalog_unavailable'); return; }
        const primary = selected?.id || active.model;
        roles = { primaryModel: primary, secondaryModel: this.bridgeSecondaryModel || primary };
        router = this.ensureAgentRouter();
        const originalTools = payload.tools;
        routing = router.prepare(payload, { ...roles, allowedModels: allowed.map(row => row.id) });
        if (!this.rolesReady) {
          if (originalTools !== undefined) routing.payload.tools = originalTools;
          routing.translateResponse = false;
        }
        payload = routing.payload;
        try { payload = applyInstructions(payload, this.instructionsFile); }
        catch (failure) { error(failure.message === 'invalid_messages' ? 400 : 503, failure.message); return; }
        payload = neutralPromptAliases(payload);
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
      let body = upstream.body;
      if (body && upstream.ok && routing?.translateResponse) {
        const contentType = upstream.headers.get('content-type') || '';
        if (contentType.includes('text/event-stream')) body = router.transformSSE(body, roles);
        else if (contentType.includes('application/json')) {
          const chunks = [];
          let length = 0;
          for await (const chunk of body) {
            length += chunk.length;
            if (length > BODY_LIMIT) throw Error('agent_routing_response_too_large');
            chunks.push(chunk);
          }
          body = [JSON.stringify(router.transformJSON(JSON.parse(Buffer.concat(chunks).toString('utf8')), roles))];
        } else throw Error('agent_routing_unsupported_response');
      }
      if (body) for await (const chunk of body) {
        if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
      }
      res.end();
    } catch (failure) {
      if (res.headersSent) res.destroy();
      else if (failure?.message === 'model_not_enabled_for_kimi') error(409, failure.message);
      else if (failure?.message?.startsWith('agent_routing_')) error(400, failure.message);
      else error(controller.signal.aborted ? 499 : 502, controller.signal.aborted ? 'request_cancelled' : 'upstream_connection_failed');
    } finally {
      clearTimeout(timeout);
      this.inflight.delete(controller);
    }
  }

  async restore({ reload = true } = {}) {
    // Read the two scalars before the control calls below can regenerate the
    // file, so a value another writer owns survives them.
    if (!this.state?.active) return { restored: true };
    this.protectNativeSecondary('', { capture: true });
    let doc = readJSON(this.configFile);
    let modelsRestored = false;
    // A synchronous exit (or an earlier partial restore) can already have
    // restored the address while the menu/runtime still needs its RPCs.
    const ownedAddress = baseURL(doc) === this.state.bridgeURL || baseURL(doc) === this.state.originalBase;
    if (reload && ownedAddress) {
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
    if (baseURL(doc) === this.state.bridgeURL) {
      this.changeBase(this.state.bridgeURL, this.state.originalBase);
    }
    this.live = null;
    this.rolesReady = false;
    if (fs.existsSync(this.catalogFile)) atomicJSON(this.catalogFile, {schemaVersion: 1, enabled: false, models: [], updatedAt: new Date().toISOString()});
    let runtimeRestored = false;
    if (modelsRestored && reload) {
      try {
        const current = readJSON(this.configFile);
        await this.rpcCall(readJSON(this.runnerFile), 'conversations.setModel', { modelAlias: current.model.current });
        runtimeRestored = true;
      } catch { this.report('restored_waiting_kimi'); }
    }
    // Persist the recovery obligation until both the menu and final runtime
    // reload are acknowledged. A lost reply can follow a successful side effect.
    const waiting = ownedAddress && !(modelsRestored && runtimeRestored);
    this.state.active = waiting;
    this.saveState();
    // Only model fields were saved, never the full credentials-bearing config.
    if (modelsRestored && runtimeRestored) {
      try { fs.unlinkSync(this.modelBackupFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return { restored: !waiting, waiting };
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
      this.catalog = catalog;
      const doc = readJSON(this.configFile);
      if (Object.keys(doc.model?.models || {}).some(isMenuAlias)) {
        const current = await this.rpcCall(runner, 'conversations.getKimiModelList');
        const native = current?.models?.filter(row => !isMenuAlias(row.model));
        if (!native?.length) throw Error('catalog_unavailable');
        if (isMenuAlias(doc.model.current)) {
          let previous;
          try { previous = readJSON(this.modelBackupFile).current; } catch {}
          const alias = native.some(row => row.model === previous) ? previous : native[0].model;
          await this.rpcCall(runner, 'conversations.setModel', { modelAlias: alias });
        }
        await this.rpcCall(runner, 'conversations.updateKimiModelList', { models: native });
      }
      this.publishCatalog(desired);
      this.catalogError = null;
    } catch { this.catalogError = 'catalog_sync_failed'; }
  }

  // Earlier adapters persisted a native secondary setting. Restore any owned
  // fields once, then keep role selection in the existing inference bridge.
  // Desktop queue-dispatch rebuilds native TOML before every ordinary turn.
  protectNativeSecondary(_wanted, { capture = false } = {}) {
    this.observeNativeSecondary();
    this.observeModelPool();
    if (!capture || !this.state) return;
    let changed = false;
    if (!this.secondaryOwnership()) {
      try {
        const baseline = this.readNativeSecondary();
        if (baseline.model !== null || baseline.enabled !== null) {
          this.state.secondary = { baseline, alias: '' };
          changed = true;
        }
      } catch { /* No readable legacy setting to preserve. */ }
    }
    if (!this.modelPoolOwnership()) {
      try {
        const baseline = inspectModelPool(fs.readFileSync(this.convertedNativeConfigFile, 'utf8'));
        if (baseline.models !== null || baseline.defaultModel !== null) {
          this.state.secondaryPool = { baseline, written: null, selection: '' };
          changed = true;
        }
      } catch { /* No readable V2 setting to preserve. */ }
    }
    if (changed) this.saveState();
  }

  ensureAgentRouter() {
    if (!/^[a-f0-9]{64}$/.test(this.state?.agentRoutingSecret || '')) {
      this.state.agentRoutingSecret = crypto.randomBytes(32).toString('hex');
      this.saveState();
    }
    if (this.agentRouterSecret !== this.state.agentRoutingSecret) {
      this.agentRouter = new AgentModelRouter({ secret: this.state.agentRoutingSecret });
      this.agentRouterSecret = this.state.agentRoutingSecret;
    }
    return this.agentRouter;
  }

  async reconcileSecondary(runner, wanted, { inheritModel = '' } = {}) {
    if (this.secondaryOwnership() || this.modelPoolOwnership()) {
      const restored = await this.restoreModelPools(runner);
      if (restored.waiting) return restored;
    }
    if (!inheritModel) { this.bridgeSecondaryModel = ''; return { applied: true }; }
    const target = wanted || inheritModel;
    if (!this.catalog.some(row => row.id === target)) throw Error('secondary_model_unavailable');
    if (this.bridgeSecondaryModel !== target && busy(runner)) return { waiting: true };
    this.ensureAgentRouter();
    if (kernelFamily(runner, { hasConverted: fs.existsSync(this.convertedNativeConfigFile) }) !== 'v2') {
      this.rolesReady = false;
      if (wanted) throw Error('secondary_model_unsupported_runtime');
      this.bridgeSecondaryModel = inheritModel;
      return { applied: true };
    }
    const profiles = await this.syncRolePlugin(runner, [inheritModel, target]);
    if (profiles.waiting) return profiles;
    this.rolesReady = true;
    this.bridgeSecondaryModel = target;
    return { applied: true };
  }

  async syncRolePlugin(runner, models) {
    const router = this.ensureAgentRouter();
    const id = 'local-work-model-roles-' + sha(this.state.agentRoutingSecret).slice(0, 12);
    const directory = path.join(this.stateDir, 'native-model-roles');
    const manifestFile = path.join(directory, 'kimi.plugin.json');
    const manifest = JSON.stringify({ name: id, version: '1.0.0', description: 'Local Work model roles', agents: ['./agents'] }, null, 2) + '\n';
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(directory).isDirectory()) throw Error('agent_profile_conflict');
    try { fs.writeFileSync(manifestFile, manifest, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!fs.lstatSync(manifestFile).isFile() || fs.readFileSync(manifestFile, 'utf8') !== manifest) throw Error('agent_profile_conflict');
    }
    ensureAgentProfiles({ directory: path.join(directory, 'agents'), router, models });
    const files = rolePluginFiles(directory);
    const selection = sha(JSON.stringify(models));
    const installed = path.join(path.dirname(this.convertedNativeConfigFile), 'plugins', 'managed', id);
    const saved = this.state.agentPlugin;
    for (const [name, digest] of Object.entries(saved?.files || {})) {
      if (files[name] !== digest) throw Error('agent_profile_conflict');
    }
    let current;
    try { current = rolePluginFiles(installed); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (fs.existsSync(installed)) throw Error('agent_profile_conflict');
    }
    if (current && !sameFiles(current, saved?.files) && !sameFiles(current, saved?.previousFiles) && !sameFiles(current, files)) {
      throw Error('agent_profile_conflict');
    }
    let needsReload = saved?.phase !== 'ready' || saved?.id !== id;
    let installedOrEnabled = false;
    if (!sameFiles(current, files)) {
      if (busy(runner)) return { waiting: true };
      this.rolesReady = false;
      this.state.agentPlugin = { id, files, previousFiles: current, selection, phase: 'installing' };
      this.saveState();
      try {
        await this.rpcCall(runner, current ? 'kimiPlugin.updatePlugin' : 'kimiPlugin.installPlugin', { source: directory }, { timeout: 30000 });
      } catch { throw Error('secondary_model_reload_failed'); }
      if (!sameFiles(rolePluginFiles(installed), files)) throw Error('secondary_model_reload_failed');
      needsReload = true;
      installedOrEnabled = true;
    }
    let info;
    try { info = await this.rpcCall(runner, 'kimiPlugin.getPluginInfo', { id }); }
    catch { throw Error('secondary_model_reload_failed'); }
    if (info?.id !== id || typeof info.enabled !== 'boolean') throw Error('secondary_model_reload_failed');
    if (!info.enabled) {
      if (saved?.phase === 'ready' && saved.selection === selection) throw Error('secondary_model_unavailable');
      if (busy(runner)) return { waiting: true };
      this.rolesReady = false;
      this.state.agentPlugin = { id, files, selection, phase: 'installing' };
      this.saveState();
      try { await this.rpcCall(runner, 'kimiPlugin.setPluginEnabled', { id, enabled: true }, { timeout: 30000 }); }
      catch { throw Error('secondary_model_reload_failed'); }
      needsReload = true;
      installedOrEnabled = true;
    }
    if (needsReload) {
      this.state.agentPlugin = { id, files, selection, phase: 'reloading' };
      this.saveState();
      const starting = this.secondaryReloadRuntime !== 'role-profiles'
        || this.secondaryReloadGeneration !== this.state.generation;
      this.useSecondaryReloadRuntime('role-profiles');
      if (starting || installedOrEnabled || saved?.phase === 'installing') this.secondaryReloadPending = true;
      const confirmation = await this.confirmModelPoolReload(runner, false);
      if (confirmation.waiting) return confirmation;
    }
    const ready = { id, files, selection, phase: 'ready' };
    if (JSON.stringify(this.state.agentPlugin) !== JSON.stringify(ready)) {
      this.state.agentPlugin = ready;
      this.saveState();
    }
    return { applied: true };
  }

  readNativeSecondary() {
    return inspectSecondary(fs.readFileSync(this.nativeConfigFile, 'utf8'));
  }

  secondaryOwnership() {
    const owned = this.state?.secondary;
    const baseline = plainSnapshot(owned?.baseline);
    return baseline ? { baseline, alias: typeof owned.alias === 'string' ? owned.alias : '',
      restored: owned.restored === true } : null;
  }

  commitNativeSecondary(bytes, text, file = this.nativeConfigFile) {
    const temp = file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    try {
      fs.writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
      if (!fs.readFileSync(file).equals(bytes)) throw Error('kimi_config_changed');
      fs.renameSync(temp, file);
    } finally { try { fs.unlinkSync(temp); } catch { /* Renamed. */ } }
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

  observeNativeSecondary() {
    const owned = this.secondaryOwnership();
    if (!owned) { this.secondaryExternal = null; return; }
    let current;
    try { current = this.readNativeSecondary(); } catch { return; }
    // A prior control call may have removed an external value while a cached
    // session was still busy. Keep that observation until it is back on disk.
    this.secondaryExternal = externalFields(this.effectiveSecondary(current), owned);
  }

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

  modelPoolOwnership() {
    const owned = this.state?.secondaryPool;
    const baseline = plainPoolSnapshot(owned?.baseline);
    return baseline ? { baseline, written: plainPoolSnapshot(owned.written),
      previousWritten: plainPoolSnapshot(owned.previousWritten),
      selection: typeof owned.selection === 'string' ? owned.selection : '', restored: owned.restored === true } : null;
  }

  observeModelPool() {
    const owned = this.modelPoolOwnership();
    if (!owned?.written) { this.modelPoolExternal = null; return; }
    let current;
    try { current = this.effectiveModelPool(inspectModelPool(fs.readFileSync(this.convertedNativeConfigFile, 'utf8'))); }
    catch { return; }
    if (owned.restored && samePool(current, owned.baseline)) { this.modelPoolExternal = null; return; }
    if (samePool(current, owned.previousWritten)) { this.modelPoolExternal = null; return; }
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

  setAppliedModelPool(value) {
    if (!this.state) return;
    let changed = this.state.secondaryPoolModel !== value;
    this.state.secondaryPoolModel = value;
    if (value && this.state.secondaryPool?.restored) { delete this.state.secondaryPool.restored; changed = true; }
    if (changed) this.saveState();
  }

  restoreModelPoolOnExit() {
    const owned = this.modelPoolOwnership();
    if (!owned) return;
    const bytes = fs.readFileSync(this.convertedNativeConfigFile);
    const current = this.effectiveModelPool(inspectModelPool(bytes.toString('utf8')));
    const ownsModels = current.models === null || Boolean(owned.written && sameModels(current.models, owned.written.models));
    const ownsDefault = current.defaultModel === null || current.defaultModel === owned.written?.defaultModel;
    const ownsPrevious = samePool(current, owned.previousWritten);
    let fromBaseline = (ownsModels && ownsDefault) || ownsPrevious;
    const doc = Bun.TOML.parse(bytes.toString('utf8'));
    if (!record(doc.models)) throw Error('secondary_config_unsupported');
    const independent = alias => !isMenuAlias(alias) && record(doc.models[alias]);
    const nativePool = snapshot => {
      if (snapshot.models === null) {
        return snapshot.defaultModel === null || independent(snapshot.defaultModel) ? snapshot : null;
      }
      const models = Object.fromEntries(Object.entries(snapshot.models).filter(([alias]) => independent(alias)));
      const aliases = Object.keys(models);
      if (!aliases.length) return null;
      const defaultModel = Object.hasOwn(models, snapshot.defaultModel) ? snapshot.defaultModel
        : Object.hasOwn(models, owned.baseline.defaultModel) ? owned.baseline.defaultModel : aliases[0];
      return { models, defaultModel, hasSecondaryTable: true, hasModelsTable: true };
    };
    // Managed aliases depend on the bridge/menu being removed. Preserve only
    // independent native bindings; a preserved string must still resolve.
    let target = nativePool(fromBaseline ? owned.baseline : current);
    if (!target) {
      fromBaseline = true;
      target = nativePool(owned.baseline) || { models: null, defaultModel: null,
        hasSecondaryTable: owned.baseline.hasSecondaryTable, hasModelsTable: false };
    }
    // Removing the modern pool would reactivate this unowned compatibility
    // scalar. Do not silently edit it or claim a dangling binding was restored.
    if (target.models === null && target.defaultModel === null
        && typeof doc.secondary_model?.model === 'string' && isMenuAlias(doc.secondary_model.model)) {
      throw Error('secondary_config_unsupported');
    }
    const next = patchModelPool(bytes.toString('utf8'), target);
    if (next !== bytes.toString('utf8')) this.commitNativeSecondary(bytes, next, this.convertedNativeConfigFile);
    if (fromBaseline) {
      // The cleaned baseline is the restart boundary, so a removed managed
      // binding cannot reappear or be mistaken for a foreign native edit.
      this.state.secondaryPool.baseline = target;
      this.state.secondaryPool.restored = true;
      this.saveState();
    }
    this.setAppliedModelPool('');
  }

  async restoreModelPools(runner) {
    if (busy(runner)) return { waiting: true };
    const starting = this.secondaryReloadRuntime !== 'v2-restore'
      || this.secondaryReloadGeneration !== this.state?.generation;
    this.useSecondaryReloadRuntime('v2-restore');
    // A failed disk restoration must retain the obligation to confirm the
    // baseline once a later tick can write it successfully.
    if (starting) this.secondaryReloadPending = true;
    // Both files return to their own baseline before confirming the final state.
    this.restoreNativeSecondaryOnExit();
    this.restoreModelPoolOnExit();
    const confirmation = await this.confirmModelPoolReload(runner, false);
    if (confirmation.waiting) return confirmation;
    this.dropSecondaryOwnership();
    delete this.state.secondaryPool;
    delete this.state.secondaryPoolModel;
    this.modelPoolExternal = null;
    this.saveState();
    return { applied: true };
  }

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
        const primaryRestore = await this.restore();
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
        this.report(primaryRestore.waiting ? 'restored_waiting_kimi' : secondary.waiting ? 'waiting_kimi_idle' : 'disconnected');
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
      const generation = runnerGeneration(runner);
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
      this.protectNativeSecondary(wantedSecondary, { capture: true });
      const previous = this.state;
      this.state = { active: true, originalBase, bridgeURL: this.bridgeURL, generation, signature, model: desired.model,
        ...(previous?.agentRoutingSecret ? { agentRoutingSecret: previous.agentRoutingSecret } : {}),
        ...(previous?.agentPlugin ? { agentPlugin: previous.agentPlugin } : {}),
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
        // The command may have regenerated the native runtime before its
        // acknowledgement was lost. Keep ownership even on a first connection
        // so a subsequent disconnect/exit can finish that runtime restore.
        if (previous?.active) this.state = previous;
        this.saveState();
        throw error;
      }
      this.rolesReady = false;
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
        'secondary_model_unsupported_runtime', 'agent_profile_conflict']);
      const code = codes.has(error.message) ? error.message : 'adapter_failed';
      if (SECONDARY_CODES.has(code) || code === 'agent_profile_conflict') this.rolesReady = false;
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
      let code = 'disconnected';
      try { if ((await this.restore()).waiting) code = 'restored_waiting_kimi'; }
      catch { code = 'kimi_config_changed'; } // Never write a changed third-party configuration.
      // Restore primary/menu settings through the normal control API first.
      // The owned secondary fields then return to disk without extra session
      // reload calls; keep ownership for the next start, as on synchronous exit.
      try {
        this.restoreNativeSecondaryOnExit();
      } catch (error) {
        if (SECONDARY_CODES.has(error.message)) code = error.message;
      }
      try { this.restoreModelPoolOnExit(); }
      catch (error) { code = SECONDARY_CODES.has(error?.message) ? error.message
        : error?.code === 'ENOENT' ? 'secondary_model_unavailable' : 'secondary_config_unsupported'; }
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
