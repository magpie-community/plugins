#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isIP } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const HELP = `magpie-amp setup --base-url URL --amp-model provider/model --gateway-key-file PATH
magpie-amp sync [--dry-run]
magpie-amp status
magpie-amp disconnect
magpie-amp help

Global options: --state-dir PATH, --amp-bin PATH
Requires Node >=20 and the Amp CLI. Setup writes local settings only.
Sync changes only this installation's personal Custom URL route, never its priority.
Dry-run and status read account/routes but do not write or run inference.
Disconnect retains the inactive route. Later sync can reactivate it.
Secrets come from a private key file and reach Amp through stdin, never argv.
`;
const fail = message => { throw new Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stable = value => JSON.stringify(value, (_, item) => object(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const equal = (a, b) => stable(a) === stable(b);
const digest = value => createHash('sha256').update(value).digest('hex');

function identifier(value, canonical = false) {
  const segment = '[A-Za-z0-9_][A-Za-z0-9_.:+-]*';
  const pattern = canonical ? `${segment}/${segment}` : `${segment}(?:/${segment})+`;
  if (typeof value !== 'string' || !new RegExp(`^${pattern}$`).test(value)) {
    fail('Invalid exact model identifier. Use provider/model or a full Magpie group/model ID, without mapping syntax.');
  }
  return value;
}

function httpsURL(value, base = false) {
  if (typeof value !== 'string' || /[\s\x00-\x1f\x7f]/.test(value)) fail('Expected an absolute HTTPS URL without whitespace.');
  let url;
  try { url = new URL(value); } catch { fail('Expected an absolute HTTPS URL.'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const v4 = isIP(host) === 4 ? host.split('.').map(Number) : null;
  const privateIP = v4 ? v4[0] === 0 || v4[0] === 10 || v4[0] === 127 || v4[0] >= 224 ||
    (v4[0] === 169 && v4[1] === 254) || (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31) ||
    (v4[0] === 192 && v4[1] === 168) || (v4[0] === 100 && v4[1] >= 64 && v4[1] <= 127)
    : isIP(host) === 6 && (!/^[23][a-f0-9]{3}:/.test(host) || host.startsWith('2001:db8:'));
  if (url.protocol !== 'https:' || url.username || url.password || url.href.includes('?') || url.href.includes('#') ||
      privateIP || (!host.includes('.') && !isIP(host)) || /(?:^|\.)(?:localhost|local|internal|lan|home|home\.arpa|test|invalid)$/.test(host) ||
      (base && (!/\/v1\/?$/.test(url.pathname) || /\/(?:responses|chat\/completions)(?:\/|$)/.test(url.pathname)))) {
    fail('Use an HTTPS URL without credentials, query, fragment or a local/private host. Provider bases must end in /v1.');
  }
  return url.href.replace(/\/$/, '');
}

function readFile(file, privateFile = true) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.size > 65536 ||
        (privateFile && (stat.mode & 0o077))) fail('Expected an owned, private regular file (mode 0600 or 0400).');
    return fs.readFileSync(fd, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    if (error.code) fail('Cannot read a required file safely. Check its path, ownership and permissions.');
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function readJSON(file, privateFile = true, empty = false) {
  const text = readFile(file, privateFile);
  if (text === undefined || (empty && !text.trim())) return undefined;
  try { return JSON.parse(text); } catch { fail('Malformed local JSON. No remote changes were made from this record.'); }
}

function atomic(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function readKey(file) {
  const text = readFile(file);
  const key = text?.replace(/\r?\n$/, '');
  if (!key || /[\s\x00-\x1f\x7f]/.test(key) || /^(?:magpie|magpie-amp)$/i.test(key)) {
    fail('A private file containing one non-placeholder remote gateway key is required.');
  }
  return key;
}

function parseArgs() {
  const options = {};
  let command;
  const valued = ['--state-dir', '--amp-bin', '--base-url', '--amp-model', '--gateway-key-file'];
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (valued.includes(arg)) {
      if (options[arg] !== undefined || !process.argv[i + 1] || process.argv[i + 1].startsWith('--')) fail('Missing or repeated option value.');
      options[arg] = process.argv[++i];
    } else if (arg === '--dry-run') options[arg] = true;
    else if (arg === '--help' || arg === '-h') return { command: 'help', options };
    else if (!arg.startsWith('-') && !command) command = arg;
    else fail('Unknown argument. Run magpie-amp help.');
  }
  command ||= 'help';
  if (!['help', 'setup', 'sync', 'status', 'disconnect'].includes(command)) fail('Unknown command. Run magpie-amp help.');
  if (options['--dry-run'] && command !== 'sync') fail('--dry-run is only supported by sync.');
  if (command !== 'setup' && valued.slice(2).some(key => options[key])) fail('Setup options are only supported by setup.');
  return { command, options };
}

function serviceURL() {
  if (process.env.AMP_API_KEY !== undefined) fail('AMP_API_KEY overrides are not supported. Use the bound saved Amp account.');
  return httpsURL(process.env.AMP_URL || 'https://ampcode.com');
}

function ampContext(bin, ampURL, accountUserId) {
  function run(args, key) {
    const result = spawnSync(bin, args, {
      shell: false, input: key === undefined ? '' : `${key}\n`, encoding: 'utf8',
      timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, AMP_URL: ampURL }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) fail('Amp command failed or timed out. Output withheld to protect credentials. A submitted change may be uncertain; run status before retrying.');
    return result.stdout;
  }
  function json(args) {
    try { return JSON.parse(run(args)); } catch (error) {
      if (error instanceof SyntaxError) fail('Amp returned invalid JSON. No raw output is displayed.');
      throw error;
    }
  }
  function account() {
    const data = json(['account', 'list', '--json']);
    if (!object(data) || !Array.isArray(data.accounts)) fail('Unsupported Amp account list shape. Expected object.accounts.');
    const active = data.accounts.filter(item => object(item) && item.active === true);
    if (active.length !== 1 || typeof active[0].userID !== 'string' || !/^user_[A-Za-z0-9_-]+$/.test(active[0].userID)) fail('Exactly one saved active Amp account is required.');
    if (accountUserId && active[0].userID !== accountUserId) fail('Account binding conflict. Switch back to the saved account using Amp, not this plugin.');
    return active[0].userID;
  }
  function routes() {
    account();
    const data = json(['config', 'model-providers', 'list', '--json']);
    if (!Array.isArray(data) || data.some(route => !object(route) || typeof route.id !== 'string' ||
        !/^[A-Za-z0-9_-]+$/.test(route.id) || typeof route.name !== 'string' || typeof route.type !== 'string' ||
        typeof route.active !== 'boolean' || !Number.isFinite(route.priority) || !object(route.config)) ||
        new Set(data.map(route => route.id)).size !== data.length) fail('Unsupported Amp personal connection list shape.');
    account();
    return data;
  }
  function mutate(args, key) {
    account();
    run(['config', 'model-providers', ...args], key);
    account();
  }
  return { account, routes, mutate };
}

function shape(route) {
  return { name: route.name, type: route.type, config: {
    ...route.config, headers: route.config.headers ?? [], queryParams: route.config.queryParams ?? {},
  } };
}

function desiredShape(settings, model) {
  return { name: `magpie-amp-${settings.installationId}`, type: 'model_provider_custom_url', config: {
    apiFormat: 'responses', baseURL: settings.baseURL,
    modelMapping: `${settings.ampModel} -> ${model}`, headers: [], queryParams: {},
  } };
}

function controlModel(file) {
  const control = readJSON(file, false, true);
  if (control === undefined || (object(control) && Object.keys(control).length === 0)) return undefined;
  if (!object(control) || control.version !== 1 || Object.keys(control).some(key => !['version', 'model'].includes(key))) fail('Malformed control. Expected {version:1,model}; only a missing or fully empty control means disconnect.');
  return identifier(control.model);
}

function validateSettings(settings) {
  if (!object(settings) || settings.version !== 1 || !/^[a-f0-9-]{36}$/.test(settings.installationId) ||
      typeof settings.accountUserId !== 'string' || !/^user_[A-Za-z0-9_-]+$/.test(settings.accountUserId) ||
      typeof settings.keyFile !== 'string' || !path.isAbsolute(settings.keyFile)) fail('Invalid settings. Refusing to infer or replace an account binding.');
  if (httpsURL(settings.ampURL) !== settings.ampURL || httpsURL(settings.baseURL, true) !== settings.baseURL) fail('Invalid saved URLs.');
  identifier(settings.ampModel, true);
  if (serviceURL() !== settings.ampURL) fail('AMP_URL differs from the bound Amp service.');
  return settings;
}

function validateState(state, settings) {
  if (state === undefined) state = { version: 1 };
  if (!object(state) || state.version !== 1 || Object.keys(state).some(key => !['version', 'connectionId', 'pendingCreate', 'pendingEdit', 'lastApplied'].includes(key)) ||
      ('pendingCreate' in state && !object(state.pendingCreate)) || ('lastApplied' in state && !object(state.lastApplied)) ||
      ('pendingEdit' in state && !object(state.pendingEdit)) ||
      (state.connectionId && state.pendingCreate) ||
      (state.connectionId !== undefined && (typeof state.connectionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(state.connectionId))) ||
      (state.connectionId && !state.lastApplied) || (!state.connectionId && (state.lastApplied || state.pendingEdit))) fail('Invalid owned connection state. Refusing recovery by guessing.');
  if (state.pendingEdit && (state.pendingEdit.connectionId !== state.connectionId || !object(state.pendingEdit.after) ||
      Object.keys(state.pendingEdit).some(key => !['connectionId', 'after'].includes(key)))) fail('Invalid pending edit binding.');
  for (const receipt of [state.pendingCreate, state.lastApplied, state.pendingEdit?.after]) {
    if (receipt && (!object(receipt) || !object(receipt.shape) || typeof receipt.keyDigest !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.keyDigest) ||
        receipt.shape.name !== `magpie-amp-${settings.installationId}` || receipt.shape.type !== 'model_provider_custom_url' ||
        !object(receipt.shape.config) || receipt.shape.config.apiFormat !== 'responses')) fail('Invalid saved connection receipt.');
  }
  if (state.pendingEdit) {
    const after = state.pendingEdit.after.shape;
    const mapping = typeof after.config.modelMapping === 'string' ? after.config.modelMapping.split(' -> ') : [];
    if (mapping.length !== 2) fail('Invalid pending edit mapping.');
    const canonical = identifier(mapping[0], true);
    const target = identifier(mapping[1]);
    const baseURL = httpsURL(after.config.baseURL, true);
    if (!equal(after, desiredShape({ ...settings, baseURL, ampModel: canonical }, target))) fail('Invalid pending edit shape.');
  }
  return state;
}

function ownedRoute(state, routes) {
  if (state.pendingCreate) {
    const matches = routes.filter(route => route.name === state.pendingCreate.shape.name);
    if (matches.length === 0) return { pendingAbsent: true };
    if (matches.length !== 1 || matches[0].active || !equal(shape(matches[0]), state.pendingCreate.shape)) fail('Pending-create conflict. Reserved name or full nonsecret shape does not match exactly one inactive route.');
    return { route: matches[0], recovered: true };
  }
  if (!state.connectionId) return {};
  const route = routes.find(item => item.id === state.connectionId);
  if (!route || (!equal(shape(route), state.lastApplied.shape) &&
      !(state.pendingEdit && equal(shape(route), state.pendingEdit.after.shape)))) fail('Owned-route conflict. The bound ID is missing or its nonsecret configuration changed outside this CLI.');
  return { route };
}

function matchesModel(route, model) {
  const mapping = route.config.modelMapping;
  if (!mapping) {
    const family = { model_provider_chatgpt: 'openai/', model_provider_openai: 'openai/', model_provider_anthropic: 'anthropic/' }[route.type];
    return family ? model.startsWith(family) : undefined;
  }
  if (typeof mapping !== 'string') return undefined;
  let included = false;
  for (const raw of mapping.split(/[\n,]/)) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const parts = line.split('->');
    const exclude = parts[0].startsWith('-');
    const pattern = (exclude ? parts[0].slice(1) : parts[0]).trim();
    if (parts.length > 2 || !/^[A-Za-z0-9_*][A-Za-z0-9_.*:+/\-]*$/.test(pattern) ||
        (parts.length === 2 && (exclude || pattern.includes('*')))) return undefined;
    const expression = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    if (new RegExp(`^${expression}$`).test(model)) included = !exclude;
  }
  return included;
}

function precedence(routes, route, model) {
  let uncertain = false;
  for (const earlier of routes) {
    if (earlier.id === route.id || !earlier.active || earlier.priority > route.priority) continue;
    const match = matchesModel(earlier, model);
    if (match === true && earlier.priority < route.priority) return 'shadowed';
    if (match === undefined || (match && earlier.priority === route.priority)) uncertain = true;
  }
  return uncertain ? 'potentially-shadowed' : 'no-earlier-match-observed';
}

function report(status, route, expected, extra = {}) {
  console.log(JSON.stringify({ status, ...(route && {
    connectionId: route.id, mapping: route.config.modelMapping, baseURL: route.config.baseURL, active: route.active,
  }), ...(!route && expected && { mapping: expected.config.modelMapping, baseURL: expected.config.baseURL }), ...extra }, null, 2));
}

function operate(command, options, directory) {
  const file = name => path.join(directory, `${name}.json`);
  const existing = readJSON(file('settings'));
  const savedState = readJSON(file('state'));
  if (existing !== undefined) validateSettings(existing);
  if (savedState !== undefined && existing === undefined) fail('State exists without settings. Refusing to replace its owner binding.');
  if (command === 'setup') {
    const ampURL = serviceURL();
    const old = existing;
    if (old !== undefined) validateState(savedState, old);
    const baseURL = httpsURL(options['--base-url'], true);
    const ampModel = identifier(options['--amp-model'], true);
    if (!options['--gateway-key-file']) fail('setup requires --gateway-key-file.');
    const keyFile = path.resolve(options['--gateway-key-file']);
    readKey(keyFile);
    const accountUserId = ampContext(options['--amp-bin'] || 'amp', ampURL, old?.accountUserId).account();
    const settings = { version: 1, installationId: old?.installationId || randomUUID(), accountUserId, ampURL, baseURL, ampModel, keyFile };
    if (!equal(settings, existing)) atomic(file('settings'), settings);
    if (savedState === undefined) atomic(file('state'), { version: 1 });
    report('prepared/pending', undefined, undefined, { message: 'Local setup saved. Select a model in Magpie, then run magpie-amp sync. No remote mutation performed.' });
    return;
  }
  if (existing === undefined) {
    report('not-configured');
    return;
  }
  const settings = existing;
  let state = validateState(savedState, settings);
  const model = command === 'disconnect' ? undefined : controlModel(file('control'));
  const disconnect = command === 'disconnect' || model === undefined;
  const expected = disconnect ? undefined : desiredShape(settings, model);
  const key = disconnect ? undefined : readKey(settings.keyFile);
  const keyDigest = key === undefined ? undefined : digest(key);
  const amp = ampContext(options['--amp-bin'] || 'amp', settings.ampURL, settings.accountUserId);
  let routes = amp.routes();
  const observed = ownedRoute(state, routes);
  let route = observed.route;
  const readOnly = command === 'status' || options['--dry-run'];
  const save = next => { amp.account(); atomic(file('state'), next); state = next; };
  if (observed.pendingAbsent) {
    report('prepared/pending', undefined, state.pendingCreate.shape, { message: 'Creation outcome is uncertain and no reserved route is visible. Creation will NOT be retried. Resolve this with the bound Amp account before clearing pending state.' });
    process.exitCode = 2;
    return;
  }
  if (observed.recovered && !readOnly) {
    save({ version: 1, connectionId: route.id, lastApplied: state.pendingCreate });
  }
  if (disconnect) {
    if (route?.active && !readOnly) {
      amp.mutate(['deactivate', route.id]);
      routes = amp.routes();
      route = ownedRoute(state, routes).route;
      if (route.active) fail('Deactivation did not read back inactive.');
    }
    report(route?.active ? 'prepared/pending' : 'disconnected', route, undefined, {
      ...(route?.active && { actions: ['deactivate'] }),
      ...(state.pendingEdit && { pendingEdit: true }),
      ...(command === 'disconnect' && { message: 'The owned remote route is retained. Later sync can reactivate it if Magpie control still selects a model.' }),
    });
    return;
  }
  if (!route) {
    if (routes.some(item => item.name === expected.name)) fail('Reserved-name conflict without a pending-create receipt. No existing route will be adopted.');
    if (readOnly) { report('prepared/pending', undefined, expected, { actions: ['create-inactive', 'check-precedence', 'activate-if-unshadowed'] }); return; }
    const pendingCreate = { shape: expected, keyDigest };
    save({ version: 1, pendingCreate });
    amp.mutate(['add-router', 'custom-url', '--personal', '--no-active', '--name', expected.name,
      '--api-format', 'responses', '--base-url', settings.baseURL, '--model-mapping', expected.config.modelMapping,
      '--api-key-file', '-'], key);
    routes = amp.routes();
    route = ownedRoute(state, routes).route;
    if (!route) fail('Create returned without an exact inactive route. Pending marker retained; no automatic retry.');
    save({ version: 1, connectionId: route.id, lastApplied: pendingCreate });
  }
  const receipt = state.lastApplied || state.pendingCreate;
  const changed = Boolean(state.pendingEdit) || !equal(shape(route), expected) || receipt.keyDigest !== keyDigest;
  const routing = precedence(routes, route, settings.ampModel);
  if (readOnly) {
    report(observed.recovered || changed || !route.active ? 'prepared/pending' : 'configured-unverified', route, expected, {
      routing, ...(state.pendingEdit ? { pendingEdit: true } : { verification: 'configured-unverified' }),
      desiredMapping: expected.config.modelMapping, desiredBaseURL: expected.config.baseURL,
      actions: [...(observed.recovered ? ['record-recovered-create'] : []), ...(changed ? ['edit-owned'] : []),
        ...(!route.active && routing === 'no-earlier-match-observed' && !route.hasWarnings ? ['activate'] : [])],
      ...(route.hasWarnings && { message: 'Amp reports warnings. Activation is blocked until resolved natively.' }),
    });
    return;
  }
  if (changed) {
    const args = ['edit-router', route.id];
    for (const [field, flag] of [['baseURL', '--base-url'], ['modelMapping', '--model-mapping']]) {
      if (route.config[field] !== expected.config[field]) args.push(flag, expected.config[field]);
    }
    const replaceKey = Boolean(state.pendingEdit) || receipt.keyDigest !== keyDigest;
    if (replaceKey) args.push('--api-key-file', '-');
    const before = equal(shape(route), state.lastApplied.shape) ? state.lastApplied : state.pendingEdit.after;
    save({ version: 1, connectionId: route.id, lastApplied: before,
      pendingEdit: { connectionId: route.id, after: { shape: expected, keyDigest } } });
    amp.mutate(args, replaceKey ? key : undefined);
    routes = amp.routes();
    route = routes.find(item => item.id === state.connectionId);
    if (!route || !equal(shape(route), expected)) fail('Edit readback differs from intended owned configuration. State receipt was not advanced.');
    save({ version: 1, connectionId: route.id, lastApplied: { shape: expected, keyDigest } });
  }
  const finalRouting = precedence(routes, route, settings.ampModel);
  let activated = false;
  if (!route.active && finalRouting === 'no-earlier-match-observed' && !route.hasWarnings) {
    amp.mutate(['activate', route.id]);
    activated = true;
    routes = amp.routes();
    route = ownedRoute(state, routes).route;
    if (!route.active) fail('Activation did not read back active.');
  }
  const finalPrecedence = precedence(routes, route, settings.ampModel);
  const hasWarnings = route.hasWarnings;
  const blocked = finalPrecedence !== 'no-earlier-match-observed' || hasWarnings;
  if (activated && blocked) {
    amp.mutate(['deactivate', route.id]);
    routes = amp.routes();
    route = ownedRoute(state, routes).route;
    if (route.active) fail('Post-activation rollback did not read back inactive.');
  }
  report(route.active ? 'configured-unverified' : 'prepared/pending', route, expected, {
    routing: finalPrecedence, verification: 'configured-unverified',
    message: (activated && blocked ? 'The newly activated owned route was deactivated after conflicting readback. ' : '') +
      (hasWarnings ? 'Amp reports warnings. Resolve them natively; no inference was performed.' :
      finalPrecedence !== 'no-earlier-match-observed' ? 'Route is shadowed or potentially shadowed. No priorities or unrelated routes were changed. Adjust order with native Amp commands if intended.' : 'No inference was performed. Routing and backend compatibility remain unverified.'),
  });
  if (blocked) process.exitCode = 2;
}

function main() {
  const { command, options } = parseArgs();
  if (command === 'help') { console.log(HELP); return; }
  const directory = path.resolve(options['--state-dir'] || path.join(os.homedir(), '.config/magpie-amp'));
  const mutation = command !== 'status' && !options['--dry-run'];
  if (!fs.existsSync(directory)) {
    if (!mutation || command !== 'setup') { report('not-configured'); return; }
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) fail('State directory must be owned, non-symlinked and private (0700).');
  const lock = path.join(directory, 'cli.lock');
  let fd;
  try {
    if (mutation) {
      try { fd = fs.openSync(lock, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') fail('CLI lock exists. Confirm its owner is stopped before manually removing it. Ambiguous or stale locks are never reclaimed automatically.'); throw error; }
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname() }));
    } else if (fs.existsSync(lock)) fail('CLI mutation is locked. Wait for its owner; readback would not be consistent.');
    operate(command, options, directory);
  } finally {
    if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
}

try { main(); } catch (error) {
  console.error(JSON.stringify({ status: 'conflict', message: error.code ? 'Local filesystem operation failed. Check private state paths and permissions.' : error.message }));
  process.exitCode = 1;
}
