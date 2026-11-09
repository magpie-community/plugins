import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';

const VERSION = 1;
// The one provider ID this adapter creates. The paths it lives under, the
// preset that names it and every reference check below derive from this
// constant: if the name in a path and the name in a value drifted apart, the
// provider would be written without an owner able to restore it. Exported so
// the tests can assert that link instead of restating the literal.
export const PROVIDER = 'magpie';
const own = (o, k) => Object.hasOwn(o, k);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = v => structuredClone(v);
const canonical = v => JSON.stringify(v, (_, x) => object(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
const equal = (a, b) => canonical(a) === canonical(b);
const absent = () => ({ exists: false });
const valueOf = value => ({ exists: true, value: clone(value) });
const fail = code => { throw Object.assign(new Error(code), { code }); };

export function pathsFor({ home = os.homedir(), stateDir, configPath } = {}) {
  const directory = path.resolve(stateDir || path.join(home, '.config', 'magpie-nanobot'));
  return { directory, control: path.join(directory, 'connection.json'), mcp: path.join(directory, 'mcp.json'),
    config: path.resolve(configPath || path.join(home, '.nanobot', 'config.json')),
    state: path.join(directory, 'state.json'), pending: path.join(directory, 'pending.json'),
    lock: path.join(directory, 'bridge.lock'), pause: path.join(directory, 'paused.json'), status: path.join(directory, 'status.json') };
}

// System and home/config directories may be links (e.g. macOS /var).
// Resolve those directories, but never follow the final file, even a dangling
// link. This is a local writer guard, not an OS sandbox or a race-proof walk.
function regular(file, directory = false) {
  const absolute = path.resolve(file);
  try {
    const resolved = directory ? fs.realpathSync(absolute)
      : path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
    const st = fs.lstatSync(resolved);
    if (st.isSymbolicLink()) fail('symlink_refused');
    if (directory ? !st.isDirectory() : !st.isFile()) fail('not_regular_file');
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    if (error.code === 'ENOTDIR') fail('parent_not_directory');
    throw error;
  }
}
// Compare aliases even before the state directory has been created. Resolve
// existing parents only: resolving the leaf would hide a forbidden file link.
function fileIdentity(file) {
  let parent = path.dirname(path.resolve(file));
  const suffix = [path.basename(file)];
  for (;;) {
    try { return path.join(fs.realpathSync(parent), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT' || parent === path.dirname(parent)) throw error;
      suffix.unshift(path.basename(parent));
      parent = path.dirname(parent);
    }
  }
}
function read(file, required = false) {
  if (!regular(file)) { if (required) fail('required_file_missing'); return null; }
  const text = fs.readFileSync(file, 'utf8');
  let data;
  try { data = JSON.parse(text); } catch { fail('invalid_json'); }
  if (!object(data)) fail('json_object_required');
  return { text, data };
}
function atomic(file, data, { text = false } = {}) {
  regular(path.dirname(file), true);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  regular(path.dirname(file), true);
  regular(file);
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, text ? data : `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    regular(file);
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function remove(file) { if (regular(file)) fs.unlinkSync(file); }
function get(doc, keys) {
  let v = doc;
  for (const key of keys) { if (!object(v) || !own(v, key)) return absent(); v = v[key]; }
  return valueOf(v);
}
function put(doc, keys, entry) {
  let o = doc;
  for (const key of keys.slice(0, -1)) {
    if (!own(o, key)) Object.defineProperty(o, key, { value: {}, enumerable: true, writable: true, configurable: true });
    if (!object(o[key])) fail('config_parent_not_object');
    o = o[key];
  }
  const key = keys.at(-1);
  if (entry.exists) Object.defineProperty(o, key, { value: clone(entry.value), enumerable: true, writable: true, configurable: true });
  else delete o[key];
}
function prune(doc, parents) {
  for (const keys of [...parents].sort((a, b) => b.length - a.length)) {
    const v = get(doc, keys);
    if (v.exists && object(v.value) && Object.keys(v.value).length === 0) put(doc, keys, absent());
  }
}
const MODEL_PATHS = { provider: ['providers', PROVIDER], preset: ['modelPresets', PROVIDER], selector: ['agents', 'defaults', 'modelPreset'] };
function recordPath(id) {
  if (own(MODEL_PATHS, id)) return MODEL_PATHS[id];
  if (id.startsWith('mcp:') && id.length > 4) return ['tools', 'mcpServers', id.slice(4)];
  fail('invalid_state_record');
}
// nanobot's own model_dump fills these defaults during an unrelated WebUI
// save. Only these exact schema defaults are equivalent to omission;
// arbitrary extra fields, auth overrides, proxies and tool filters still conflict.
const SCHEMA_DEFAULTS = {
  provider: { extraHeaders: null, extraBody: null, extraQuery: null, useProxy: false, thinkingStyle: null },
  preset: { extraHeaders: null, extraQuery: null, extraBody: null, maxTokens: 8192, contextWindowTokens: 200000, temperature: 0.1, reasoningEffort: null, api: null },
  mcp: { auth: null, command: '', args: [], env: {}, cwd: '', url: '', headers: {}, useProxy: false, toolTimeout: 30, enabledTools: ['*'] },
};
function sameEntry(a, b, id) {
  if (equal(a, b)) return true;
  if (!a.exists || !b.exists || !object(a.value) || !object(b.value)) return false;
  const defaults = SCHEMA_DEFAULTS[id.startsWith('mcp:') ? 'mcp' : id];
  return !!defaults && equal({ ...defaults, ...a.value }, { ...defaults, ...b.value });
}
function validEntry(v) { return object(v) && typeof v.exists === 'boolean' && (!v.exists || own(v, 'value')); }
function validateState(data, config) {
  if (!object(data) || data.version !== VERSION || data.configPath !== config || !Array.isArray(data.records) || !Array.isArray(data.addedWhitelist) || !Array.isArray(data.parents)) fail('invalid_or_wrong_target_state');
  const seen = new Set();
  for (const r of data.records) {
    if (!object(r) || typeof r.id !== 'string' || !validEntry(r.before) || !validEntry(r.applied) || seen.has(r.id)) fail('invalid_state_record');
    recordPath(r.id); seen.add(r.id);
  }
  if (!data.addedWhitelist.every(x => typeof x === 'string' && /^(127\.(?:\d{1,3}\.){2}\d{1,3}\/32|::1\/128)$/.test(x))) fail('invalid_state_whitelist');
  const allowed = [['providers'], ['modelPresets'], ['agents'], ['agents', 'defaults'], ['tools'], ['tools', 'mcpServers']];
  if (!data.parents.every(p => allowed.some(a => equal(a, p)))) fail('invalid_state_parents');
  if (data.whitelistBefore !== undefined && !validEntry(data.whitelistBefore)) fail('invalid_state_whitelist');
  return data;
}
function emptyState(config) { return { version: VERSION, configPath: config, records: [], addedWhitelist: [], parents: [] }; }
function active(st) { return st.records.length > 0 || st.addedWhitelist.length > 0; }
function aliases(doc, model, mcp) {
  if (model && (own(doc, 'model_presets') || own(doc.agents?.defaults || {}, 'model_preset'))) fail('snake_case_alias_conflict');
  if (mcp && (own(doc.tools || {}, 'mcp_servers') || own(doc.tools || {}, 'ssrf_whitelist'))) fail('snake_case_alias_conflict');
}
function parseControl(source) {
  if (!source) return null;
  const d = source.data, keys = ['model', 'baseURL', 'gatewayKey'];
  if (keys.every(k => !own(d, k))) {
    if (own(d, 'modelInfo') && Object.keys(d.modelInfo || {}).length) fail('incomplete_control');
    return null;
  }
  if (!keys.every(k => typeof d[k] === 'string' && d[k].trim().length > 0)) fail('incomplete_control');
  let u; try { u = new URL(d.baseURL); } catch { fail('invalid_gateway_url'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) fail('invalid_gateway_url');
  if (d.modelInfo !== undefined && !object(d.modelInfo)) fail('invalid_model_info');
  for (const k of ['context', 'output']) if (d.modelInfo?.[k] !== undefined && (!Number.isSafeInteger(d.modelInfo[k]) || d.modelInfo[k] < 0)) fail('invalid_model_info');
  if (d.modelInfo?.images !== undefined && typeof d.modelInfo.images !== 'boolean') fail('invalid_model_info');
  return d;
}
function stringMap(v) { return object(v) && Object.values(v).every(x => typeof x === 'string'); }
function parseMCP(source) {
  if (!source) return null; // Unknown is distinct from an explicit empty map.
  const d = source.data;
  if (!own(d, 'mcpServers')) { if (Object.keys(d).length === 0) return {}; fail('invalid_mcp_staging'); }
  if (!object(d.mcpServers)) fail('invalid_mcp_staging');
  const result = Object.create(null);
  for (const [name, s] of Object.entries(d.mcpServers)) {
    if (!name || !object(s) || !['stdio', 'http', 'sse'].includes(s.type)) fail('invalid_mcp_server');
    const v = { type: s.type === 'http' ? 'streamableHttp' : s.type };
    if (s.type === 'stdio') {
      if (typeof s.command !== 'string' || !s.command.trim() || (s.args !== undefined && (!Array.isArray(s.args) || !s.args.every(x => typeof x === 'string'))) || (s.env !== undefined && !stringMap(s.env))) fail('invalid_mcp_stdio');
      v.command = s.command; if (s.args !== undefined) v.args = clone(s.args); if (s.env !== undefined) v.env = clone(s.env);
    } else {
      let u; try { u = new URL(s.url); } catch { fail('invalid_mcp_url'); }
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) fail('invalid_mcp_url');
      if (s.headers !== undefined && !stringMap(s.headers)) fail('invalid_mcp_headers');
      v.url = s.url; if (s.headers !== undefined) v.headers = clone(s.headers);
    }
    Object.defineProperty(result, name, { value: v, enumerable: true });
  }
  return result;
}
function loopbacks(server) {
  // Native nanobot entries may omit type and infer HTTP/SSE from the URL.
  if (!server?.url || (server.type != null && !['http', 'streamableHttp', 'sse'].includes(server.type))) return [];
  let host; try { host = new URL(server.url).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''); } catch { return []; }
  if (host === 'localhost') return ['127.0.0.1/32', '::1/128'];
  if (host === '::1') return ['::1/128'];
  return net.isIP(host) === 4 && host.startsWith('127.') ? [`${host}/32`] : [];
}
function acquire(paths) {
  regular(paths.directory, true); fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 }); regular(paths.directory, true);
  const token = crypto.randomUUID();
  const create = () => fs.writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
  const release = () => { const current = read(paths.lock); if (current?.data.token === token) remove(paths.lock); };
  regular(paths.lock);
  try { create(); return release; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  // Serialize stale-owner reclamation itself. Without a separate exclusive
  // guard, two processes can both observe a dead PID and one can unlink the
  // other's freshly created lock between its final read and unlink.
  const guard = `${paths.lock}.reclaim`;
  regular(guard);
  try { fs.writeFileSync(guard, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') fail('lock_reclaim_in_progress'); throw error; }
  try {
    const held = read(paths.lock)?.data;
    if (held) {
      if (!Number.isSafeInteger(held.pid) || held.pid <= 0 || typeof held.token !== 'string') fail('invalid_lock');
      try { process.kill(held.pid, 0); fail('writer_locked'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      paths.__fault?.('dead-lock-guarded');
      if (!equal(read(paths.lock)?.data, held)) fail('writer_locked');
      remove(paths.lock);
    }
    paths.__fault?.('before-lock-recreate');
    // A new normal wx acquisition can win after removal. In that case stop;
    // never loop back and delete the winning owner's lock.
    try { create(); } catch (error) { if (error.code === 'EEXIST') fail('writer_locked'); throw error; }
    return release;
  } finally {
    try { if (read(guard)?.data.token === token) remove(guard); } catch { /* Leave an uncertain guard for diagnosis. */ }
  }
}
function safeStatus(paths, state, extras = {}) {
  return { state, servers: [], restartRequired: false, recoveryPending: false, configPath: path.resolve(paths.config), ...extras };
}
function references(doc) {
  const fallbackRef = p => [p?.fallbackModels, p?.fallback_models].some(list => Array.isArray(list) && list.some(x => x === PROVIDER || (object(x) && (x.provider === PROVIDER || x.modelPreset === PROVIDER || x.model_preset === PROVIDER))));
  const other = Object.entries(doc.modelPresets || {}).some(([name, p]) => name !== PROVIDER && object(p) && (p.provider === PROVIDER || p.modelPreset === PROVIDER || p.model_preset === PROVIDER || fallbackRef(p)));
  const defaults = doc.agents?.defaults || {};
  // The owned defaults.modelPreset selector is restored separately. Other
  // references created while connected must keep their provider/preset alive.
  return other || defaults.provider === PROVIDER || fallbackRef(defaults)
    || defaults.dream?.modelOverride === PROVIDER || defaults.dream?.model_override === PROVIDER;
}
function modelValues(control) {
  const provider = { apiBase: control.baseURL, apiKey: control.gatewayKey, api: { supportedApis: ['chat_completions'], preferredApi: 'chat_completions' } };
  const preset = { model: control.model.startsWith(`${PROVIDER}/`) ? `${PROVIDER}/${control.model}` : control.model, provider: PROVIDER };
  const { context, output } = control.modelInfo || {};
  if (context > 0) preset.contextWindowTokens = context;
  if (output > 0) preset.maxTokens = context > 0 ? Math.min(context, output) : output;
  else if (context > 0) preset.maxTokens = Math.min(8192, context);
  return { provider, preset, selector: PROVIDER };
}
function validatePending(p, config) {
  if (!object(p) || p.version !== VERSION || p.configPath !== config || !Array.isArray(p.patches) || !Array.isArray(p.cleanupParents)) fail('invalid_or_wrong_target_pending');
  validateState(p.nextState, config);
  const seen = new Set();
  for (const patch of p.patches) {
    if (!object(patch) || typeof patch.id !== 'string' || !validEntry(patch.before) || !validEntry(patch.after) || seen.has(patch.id)) fail('invalid_pending_patch');
    if (patch.id !== 'whitelist') recordPath(patch.id);
    seen.add(patch.id);
  }
  validateState({ ...emptyState(config), parents: p.cleanupParents }, config);
  return p;
}
function patchPath(id) { return id === 'whitelist' ? ['tools', 'ssrfWhitelist'] : recordPath(id); }
function commit(paths, document, transaction) {
  // A pending journal is an intent, not permission to ignore references added
  // since it was prepared. Recheck against the latest native document on every
  // replay, before removing either named object.
  if (transaction.patches.some(p => ['provider', 'preset'].includes(p.id) && !p.after.exists) && references(document.data)) fail('pending_named_object_still_referenced');
  const next = clone(document.data);
  for (const patch of transaction.patches) {
    const current = get(next, patchPath(patch.id));
    if (!sameEntry(current, patch.before, patch.id) && !sameEntry(current, patch.after, patch.id)) fail('pending_patch_conflict');
    put(next, patchPath(patch.id), patch.after);
  }
  const permissionPatch = transaction.patches.find(p => p.id === 'whitelist');
  if (permissionPatch) {
    const removed = (permissionPatch.before.value || []).filter(ip => !(permissionPatch.after.value || []).includes(ip));
    const stillRequired = new Set(Object.values(next.tools?.mcpServers || {}).flatMap(loopbacks));
    if (removed.some(ip => stillRequired.has(ip))) fail('pending_whitelist_still_required');
  }
  prune(next, transaction.cleanupParents);
  paths.__fault?.('before-config');
  const latest = read(paths.config, true);
  if (latest.text !== document.text) fail('config_changed_before_write');
  const changed = !equal(document.data, next);
  if (changed) atomic(paths.config, `${JSON.stringify(next, null, 2)}\n`, { text: true });
  paths.__fault?.('after-config');
  if (active(transaction.nextState)) atomic(paths.state, transaction.nextState); else remove(paths.state);
  paths.__fault?.('after-state');
  remove(paths.pending);
  return changed;
}

export function reconcile(paths, { restore = false, pause = false } = {}) {
  let release, st;
  try {
    paths = { ...paths, config: path.resolve(paths.config) };
    const configIdentity = fileIdentity(paths.config);
    if ([...['control', 'mcp', 'state', 'pending', 'lock', 'pause', 'status'].map(k => paths[k]), `${paths.lock}.reclaim`].some(file => fileIdentity(file) === configIdentity)) fail('reserved_config_path');
    release = acquire(paths);
    regular(paths.status);
    // Validate every source before performing even a pending target write.
    const controlSource = read(paths.control), mcpSource = read(paths.mcp);
    const control = parseControl(controlSource), mcp = parseMCP(mcpSource);
    let document = read(paths.config, true);
    st = read(paths.state)?.data || emptyState(paths.config); validateState(st, paths.config);
    const pending = read(paths.pending)?.data;
    const paused = read(paths.pause)?.data;
    if (paused && (paused.version !== VERSION || paused.configPath !== paths.config || typeof paused.hash !== 'string')) fail('invalid_or_wrong_target_pause');
    const hash = crypto.createHash('sha256').update(canonical({ config: paths.config, control: controlSource?.data ?? null, mcp: mcpSource?.data ?? null })).digest('hex');
    aliases(document.data, !!control || st.records.some(r => own(MODEL_PATHS, r.id)) || !!pending, mcp !== null || st.records.some(r => r.id.startsWith('mcp:')) || st.addedWhitelist.length > 0 || !!pending);
    let changed = false;
    if (pending) {
      validatePending(pending, paths.config);
      changed = commit(paths, document, pending);
      st = pending.nextState; document = read(paths.config, true);
    }
    if (pause) atomic(paths.pause, { version: VERSION, configPath: paths.config, hash });
    if (!restore && (pause || paused?.hash === hash)) {
      const result = safeStatus(paths, 'paused', { servers: st.records.filter(r => r.id.startsWith('mcp:')).map(r => r.id.slice(4)), recoveryPending: active(st), restartRequired: changed });
      atomic(paths.status, result); return result;
    }
    if (paused && paused.hash !== hash && !pause) remove(paths.pause);
    const doc = document.data, nextState = clone(st), desired = new Map();
    if (!restore && control) for (const [id, value] of Object.entries(modelValues(control))) desired.set(id, valueOf(value));
    if (!restore && mcp !== null) for (const [name, value] of Object.entries(mcp)) desired.set(`mcp:${name}`, valueOf(value));
    if (!restore && mcp === null) for (const r of st.records.filter(r => r.id.startsWith('mcp:'))) desired.set(r.id, r.applied);
    const records = new Map(st.records.map(r => [r.id, r]));
    // Do not delete a provider now used by a user's later preset/default.
    if (records.has('provider') && !desired.has('provider') && references(doc)) fail('managed_provider_still_referenced');
    if (records.has('preset') && !desired.has('preset')) {
      const defaults = doc.agents?.defaults;
      const selector = records.get('selector');
      if (defaults?.modelPreset === PROVIDER && (!selector || !equal(get(doc, MODEL_PATHS.selector), selector.applied))) fail('managed_preset_still_referenced');
    }
    const patches = [], after = clone(doc), nextRecords = [];
    for (const id of new Set([...records.keys(), ...desired.keys()])) {
      const previous = records.get(id), current = get(doc, recordPath(id));
      if (previous && !sameEntry(current, previous.applied, id) && !(!desired.has(id) && sameEntry(current, previous.before, id))) fail('managed_field_changed');
      if (!previous && current.exists && id !== 'selector') fail('unowned_name_collision');
      const target = desired.has(id) ? desired.get(id) : previous.before;
      if (!sameEntry(current, target, id)) patches.push({ id, before: current, after: target });
      put(after, recordPath(id), target);
      if (desired.has(id)) nextRecords.push({ id, before: previous?.before || current, applied: target });
    }
    nextState.records = nextRecords;
    const parentCandidates = [['providers'], ['modelPresets'], ['agents'], ['agents', 'defaults'], ['tools'], ['tools', 'mcpServers']];
    for (const p of parentCandidates) if (!get(doc, p).exists && get(after, p).exists && !nextState.parents.some(x => equal(x, p))) nextState.parents.push(p);
    const whitelistCurrent = get(doc, ['tools', 'ssrfWhitelist']);
    if (whitelistCurrent.exists && (!Array.isArray(whitelistCurrent.value) || !whitelistCurrent.value.every(x => typeof x === 'string'))) fail('invalid_ssrf_whitelist');
    const required = new Set();
    // All remaining services count, including non-managed services which depend
    // on a loopback member introduced by this bridge.
    const remaining = get(after, ['tools', 'mcpServers']);
    if (remaining.exists && !object(remaining.value)) fail('invalid_native_mcp_map');
    for (const s of Object.values(remaining.value || {})) for (const ip of loopbacks(s)) required.add(ip);
    const managedRequired = new Set();
    for (const r of nextRecords.filter(r => r.id.startsWith('mcp:'))) for (const ip of loopbacks(r.applied.value)) managedRequired.add(ip);
    const previousAdded = new Set(st.addedWhitelist);
    let whitelist = [...(whitelistCurrent.value || [])];
    if ([...managedRequired].some(ip => previousAdded.has(ip) && !whitelist.includes(ip))) fail('managed_whitelist_removed');
    for (const ip of previousAdded) if (!required.has(ip)) whitelist = whitelist.filter(x => x !== ip);
    const added = new Set([...previousAdded].filter(x => whitelist.includes(x)));
    for (const ip of managedRequired) if (!whitelist.includes(ip)) { whitelist.push(ip); added.add(ip); }
    nextState.addedWhitelist = [...added];
    if (!st.whitelistBefore && added.size) nextState.whitelistBefore = whitelistCurrent;
    const beforeWhitelist = st.whitelistBefore || nextState.whitelistBefore;
    let whitelistAfter = valueOf(whitelist);
    if (whitelist.length === 0 && beforeWhitelist && !beforeWhitelist.exists) whitelistAfter = absent();
    if (!equal(whitelistCurrent, whitelistAfter) && (st.addedWhitelist.length > 0 || managedRequired.size > 0)) {
      patches.push({ id: 'whitelist', before: whitelistCurrent, after: whitelistAfter });
      put(after, ['tools', 'ssrfWhitelist'], whitelistAfter);
    }
    if (!nextState.addedWhitelist.length) delete nextState.whitelistBefore;
    const transaction = { version: VERSION, configPath: paths.config, patches, nextState, cleanupParents: nextState.parents };
    if (patches.length || !equal(st, nextState)) {
      atomic(paths.pending, transaction);
      paths.__fault?.('after-pending');
      changed = commit(paths, document, transaction) || changed;
    }
    const servers = nextRecords.filter(r => r.id.startsWith('mcp:')).map(r => r.id.slice(4));
    const result = safeStatus(paths, active(nextState) ? 'file-applied' : 'disconnected', {
      ...(control && !restore ? { model: control.model } : {}), servers,
      restartRequired: changed || active(nextState), recoveryPending: nextState.addedWhitelist.some(x => !managedRequired.has(x)),
      ...(nextState.addedWhitelist.length ? { networkNotice: 'Exact loopback IP exemptions affect nanobot network policy globally, not only these MCP endpoints.' } : {}),
    });
    atomic(paths.status, result); return result;
  } catch (error) {
    if (error?.__bridgeFault) throw error;
    const known = new Set(['symlink_refused', 'parent_not_directory', 'not_regular_file', 'required_file_missing', 'invalid_json', 'json_object_required', 'config_parent_not_object', 'invalid_state_record', 'invalid_or_wrong_target_state', 'invalid_state_whitelist', 'invalid_state_parents', 'snake_case_alias_conflict', 'incomplete_control', 'invalid_gateway_url', 'invalid_model_info', 'invalid_mcp_staging', 'invalid_mcp_server', 'invalid_mcp_stdio', 'invalid_mcp_url', 'invalid_mcp_headers', 'invalid_lock', 'writer_locked', 'invalid_or_wrong_target_pending', 'invalid_pending_patch', 'pending_patch_conflict', 'config_changed_before_write', 'invalid_or_wrong_target_pause', 'managed_provider_still_referenced', 'managed_preset_still_referenced', 'managed_field_changed', 'unowned_name_collision', 'invalid_ssrf_whitelist', 'invalid_native_mcp_map', 'managed_whitelist_removed', 'reserved_config_path', 'pending_named_object_still_referenced', 'pending_whitelist_still_required', 'lock_reclaim_in_progress']);
    const code = known.has(error?.code) ? error.code : 'bridge_io_error';
    // Control/config parsing can fail before ownership is loaded. Consult a
    // valid record for this target without masking the original failure or
    // treating an unreadable/foreign record as permission to change anything.
    let recoveryState = st;
    if (!recoveryState) {
      try {
        const saved = read(paths.state)?.data;
        if (saved) recoveryState = validateState(saved, path.resolve(paths.config));
      } catch { /* Keep the original conflict; recovery files are left intact. */ }
    }
    const hasOwnership = (Array.isArray(recoveryState?.records) && recoveryState.records.length > 0) || (Array.isArray(recoveryState?.addedWhitelist) && recoveryState.addedWhitelist.length > 0);
    const result = safeStatus(paths, 'conflict', { code, recoveryPending: hasOwnership || fs.existsSync(paths.pending) });
    // Only this lock's owner may publish diagnostics. Failure to publish must
    // never hide the original conflict or modify the target configuration.
    if (release) { try { atomic(paths.status, result); } catch { /* Keep the conflict return usable. */ } }
    return result;
  } finally { try { release?.(); } catch { /* Never unlink a lock replaced by another writer. */ } }
}

export function inspect(paths) {
  // Never return journal/control values, raw parse errors, URLs, or credentials.
  try {
    const pending = read(paths.pending)?.data;
    if (pending) {
      validatePending(pending, path.resolve(paths.config));
      return safeStatus(paths, 'recovery-pending', { recoveryPending: true, restartRequired: true, servers: pending.nextState.records.filter(r => r.id.startsWith('mcp:')).map(r => r.id.slice(4)) });
    }
    const status = read(paths.status)?.data;
    if (!status) return safeStatus(paths, 'disconnected');
    if (status.configPath !== path.resolve(paths.config)) return safeStatus(paths, 'conflict', { code: 'status_target_mismatch' });
    const result = safeStatus(paths, typeof status.state === 'string' ? status.state : 'conflict');
    for (const key of ['model', 'code', 'networkNotice']) if (typeof status[key] === 'string') result[key] = status[key];
    if (Array.isArray(status.servers) && status.servers.every(x => typeof x === 'string')) result.servers = status.servers;
    result.restartRequired = status.restartRequired === true; result.recoveryPending = status.recoveryPending === true;
    return result;
  } catch { return safeStatus(paths, 'conflict', { code: 'status_unreadable' }); }
}
