import { createServer } from 'node:http';
import { access, chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { readSettings, planSettings, commitSettings } from './settings.mjs';
import { decorateModels, magpieConfig } from './model-icons.mjs';
import { cachedValidation, validatorStamp } from './validation-cache.mjs';
import { piParameters } from './model-parameters.mjs';
import { nativeModels, mergeNativeModels, gatewayModels } from './native-models.mjs';
import { readAgentState } from './magpie-agent-reader.mjs';
import { isRemoteEntry, readRemoteHome, remoteTarget } from './remote-home.mjs';
import { readQuota, readQuotaSource, saveQuotaSource, trustedQuotaSources } from './quota-source.mjs';

const rootDir = dirname(fileURLToPath(import.meta.url));
const { version: pluginVersion } = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8'));
const assets = join(rootDir, 'ui');
const TOKEN_PLACEHOLDER = '__FM_WRITE_TOKEN__';
const WRITE_HEADER = 'x-fm-write-token';
const FILE_LIMIT = 1024 * 1024;
const modelCatalogs = new Map();
const configPushes = new Map();
const DISPATCH_BACKUP = /^backup-\d+-[a-f0-9]{12}\.json$/;
const MODEL_AGENTS = new Set(['claude', 'codex', 'opencode', 'pi', 'grok', 'kimi', 'cursor', 'antigravity', 'muse', 'rovo', 'omp', 'devin', 'commandcode', 'polytoken', 'cortex', 'kiro', 'hermes']);
const cliAgentOf = harness => harness === 'pi-signed' ? 'pi' : harness === 'agy' ? 'antigravity' : harness;
const nativeAgentOf = agent => agent === 'antigravity' ? 'agy' : agent;
const agentReaderSource = await readFile(new URL('./magpie-agent-reader.mjs', import.meta.url), 'utf8');
const parameterReaderSource = await readFile(new URL('./model-parameters.mjs', import.meta.url), 'utf8');

export function parseMagpieModels(output) {
  const models = [];
  let group = '';
  for (const line of output.replace(/\x1b\[[0-9;]*m/g, '').split('\n')) {
    const match = line.match(/^\s{2,}(\S+\/\S+)\s{2,}(.*)$/);
    if (match) {
      const parts = match[2].trim().split(/\s{2,}/);
      const onlyEfforts = parts[0] && parts[0].split('/').every(value => ['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'light', 'extra_high'].includes(value));
      models.push({ id: match[1], label: !parts[0] || onlyEfforts ? match[1].split('/').slice(1).join('/') : parts[0], provider: match[1].split('/')[0], group, efforts: (onlyEfforts ? parts[0] : parts[1] || '').split('/').filter(Boolean) });
    } else if (/^  \S/.test(line) && !line.includes('/') && !line.includes(':')) {
      group = line.trim();
    }
  }
  return models;
}

async function modelCatalog(harness) {
  const agent = cliAgentOf(harness);
  if (!MODEL_AGENTS.has(agent)) throw httpError(400, 'unsupported', '这个 Harness 暂无 MagPie 模型目录');
  const cached = modelCatalogs.get(agent);
  if (cached && Date.now() - cached.at < 30000) return cached.value;
  const value = Promise.all([
    exec('magpie', ['models', agent], { timeout: 15000, maxBuffer: 1024 * 1024 }),
    nativeModels().catch(() => null),
    gatewayModels(),
    piParameters(),
  ]).then(async ([{ stdout }, native, gateway, pi]) => ({ ...mergeNativeModels(nativeAgentOf(agent), await decorateModels(parseMagpieModels(stdout)), native, gateway, pi), source: 'MagPie Agent fields + magpie models', observedAt: new Date().toISOString() }))
    .catch(error => { modelCatalogs.delete(agent); if (String(error.stderr).includes('unknown agent')) throw httpError(400, 'unsupported', `本机 MagPie 不识别 ${agent}，无法提供原生模型与参数目录`); throw httpError(503, 'catalog_unavailable', 'MagPie 模型目录暂时不可用，请稍后重新打开选择器'); });
  modelCatalogs.set(agent, { at: Date.now(), value });
  return value;
}

// Run the same reader on the execution machine without installing it there.
// The CLI list contributes effort and dispatch ID mappings, never picker rows.
const remoteAgentReader = `${agentReaderSource}
${parameterReaderSource}
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const [agent, cliAgent] = process.argv.slice(2);
try {
  const [native, { stdout }, pi] = await Promise.all([
    readAgentState(agent),
    promisify(execFile)('magpie', ['models', cliAgent], { timeout: 10000, maxBuffer: 1048576 }).catch(() => ({ stdout: '' })),
    agent === 'pi' ? piParameters() : undefined,
  ]);
  process.stdout.write(JSON.stringify({ native, stdout, pi }));
} catch { process.exitCode = 1; }
`;

async function readSeatModels(agent, host) {
  const nativeAgent = nativeAgentOf(agent);
  if (host) {
    const { stdout } = await exec('ssh', [
      '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no',
      '-o', 'ClearAllForwardings=yes', '-o', 'ControlPath=none', '--', host,
      `node --input-type=module - ${nativeAgent} ${agent}`,
    ], { input: remoteAgentReader, timeout: 17000, maxBuffer: 4 * FILE_LIMIT });
    return JSON.parse(stdout);
  }
  const [native, { stdout }, gateway, pi] = await Promise.all([
    readAgentState(nativeAgent),
    exec('magpie', ['models', agent], { timeout: 10000, maxBuffer: FILE_LIMIT }).catch(() => ({ stdout: '' })),
    gatewayModels(),
    agent === 'pi' ? piParameters() : undefined,
  ]);
  return { native, stdout, gateway, pi };
}

function seatCatalogReader(targets = {}) {
  const cache = new Map();
  return async (seat, harness) => {
    const target = Object.hasOwn(targets, seat) ? targets[seat] : seat === 'primary' ? { local: true } : null;
    const host = target?.ssh;
    const agent = cliAgentOf(harness);
    if (!MODEL_AGENTS.has(agent) || (host
      ? typeof host !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(host)
      : target?.local !== true)) {
      throw httpError(400, 'unsupported', '执行席位或工具没有配置模型目录');
    }
    const key = JSON.stringify([seat, harness]);
    const prior = cache.get(key);
    if (prior && Date.now() - prior.at < 30000) return prior.value;
    const value = readSeatModels(agent, host).then(({ native, stdout, gateway, pi }) => {
      const catalog = mergeNativeModels(nativeAgentOf(agent), parseMagpieModels(stdout), native, gateway, pi);
      if (catalog.metadata !== 'native') throw new Error('missing_agent_field');
      return { ...catalog, customIcons: native[0]?.customIcons || {}, seat,
        source: `${seat} · MagPie Agent`, observedAt: new Date().toISOString() };
    }).catch(() => {
      cache.delete(key);
      throw httpError(503, 'catalog_unavailable', '执行机器的 MagPie Agent 目录读取失败');
    });
    cache.set(key, {at: Date.now(), value});
    return value;
  };
}

const profile = (v) => ({ harness: String(v?.harness ?? ''), model: String(v?.model ?? ''), effort: String(v?.effort ?? ''), provider: String(v?.provider ?? '') });
const profiles = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]).map(profile);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const httpError = (status, error, message) => Object.assign(new Error(message), { status, error });

function exec(cmd, args, opts) {
  const { input, onLine, ...runOptions } = opts;
  return new Promise((ok, fail) => {
    const child = execFile(cmd, args, runOptions, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        fail(err);
        return;
      }
      ok({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
    if (input !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
    if (onLine) {
      let tail = ''; child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        const lines = (tail + chunk).split('\n'); tail = lines.pop().slice(-4096);
        for (const line of lines) onLine(line);
      });
      child.stdout.on('end', () => { if (tail) onLine(tail); });
    }
  });
}

async function boundedFile(path, limit) {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size > limit) throw new Error('file_not_supported');
  const bytes = await readFile(path);
  return { text: bytes.toString('utf8'), bytes, modified: s.mtime.toISOString(), mode: s.mode };
}

function viewUse(use) {
  if (Array.isArray(use)) return { useKind: 'array', use: use.map(profile) };
  if (use && typeof use === 'object') return { useKind: 'object', use: [profile(use)] };
  return { useKind: 'missing', use: [] };
}

function viewRule(rule, index) {
  const use = viewUse(rule?.use);
  return {
    index,
    when: typeof rule?.when === 'string' ? rule.when : '',
    why: typeof rule?.why === 'string' ? rule.why : '',
    useKind: use.useKind,
    use: use.use,
  };
}

function backupDirs(options) {
  if (options.backupDir) return [options.backupDir];
  // MagPie reloads directory installs when watched plugin files change.
  return [join(magpieConfig(), 'firstmate-dashboard', 'backups'), join(rootDir, 'backups')];
}

async function findBackup(options, name) {
  for (const directory of backupDirs(options)) {
    let dir, file;
    try {
      dir = await realpath(directory);
      file = await realpath(join(dir, name));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!inside(dir, file)) throw httpError(403, 'forbidden', '拒绝读取备份目录之外的文件');
    return file;
  }
  throw httpError(404, 'rejected', '找不到这份备份');
}

async function latestBackup(dirs, home, pattern = DISPATCH_BACKUP, file) {
  const found = [];
  for (const dir of dirs) {
    let names;
    try { names = await readdir(dir); } catch { continue; }
    for (const name of names) {
      if (!pattern.test(name)) continue;
      try {
        const meta = JSON.parse(await readFile(join(dir, `${name}.meta.json`), 'utf8'));
        if (meta.home !== home || (file && meta.file !== file)) continue;
        found.push({ id: name, created: String(meta.created || '') });
      } catch { /* skip unreadable metadata */ }
    }
  }
  found.sort((a, b) => b.created.localeCompare(a.created) || b.id.localeCompare(a.id));
  return found[0] || null;
}

async function dispatchView(file, dirs, path) {
  let data;
  try { data = JSON.parse(file.text); }
  catch { throw httpError(422, 'invalid', 'crew-dispatch.json 的 JSON 格式无效'); }
  if (!data || !Array.isArray(data.rules) || data.rules.some(rule => !rule || typeof rule !== 'object' || Array.isArray(rule))) {
    throw httpError(422, 'invalid', 'crew-dispatch.json 缺少有效的 rules 数组');
  }
  const sharedQuota = data.shared_quota === true;
  const rules = data.rules.map((rule, i) => ({
    id: `rule-${i + 1}`, when: String(rule.when ?? ''), use: profiles(rule.use), isDefault: false,
  }));
  if (data.default) rules.push({ id: 'default', when: '默认规则', use: profiles(data.default), isDefault: true });
  return {
    rules, sharedQuota, ruleSource: 'config/crew-dispatch.json', ruleModified: file.modified,
    dispatch: {
      revision: sha256(file.bytes), modified: file.modified, sharedQuota, source: 'config/crew-dispatch.json',
      rules: data.rules.map(viewRule), default: data.default == null ? null : viewUse(data.default),
      latestBackup: await latestBackup(dirs, path),
    },
  };
}

export function dispatchEvidence(brief, resolution, record) {
  const spec = brief.split(/^## Firstmate spec\s*$/m)[1]?.split(/^#{1,2} /m)[0] || '';
  const seat = spec.match(/^\s*\[seat:\s*([\w.-]+)\]/m)?.[1] || 'unspecified';
  const taskType = spec.match(/^\s*task-type:\s*([\w.-]+)/m)?.[1] || 'unspecified';
  const selected = resolution?.task === record.id && resolution.status === 'clear' && resolution.profile?.harness ? profile(resolution.profile) : null;
  const comparison = !selected ? 'unknown' : ['harness', 'model', 'effort'].every(key => (record[key] || '') === selected[key]) ? 'match' : 'difference';
  return { seat, taskType, selected, comparison };
}

async function taskEvidence(home, record) {
  let brief = '', resolution = null;
  const sources = [];
  for (const name of ['brief.md', 'dispatch-resolution.json']) {
    try {
      const filePath = await realpath(join(home, 'data', record.id, name));
      if (!inside(home, filePath)) continue;
      const file = await boundedFile(filePath, 128 * 1024);
      if (name === 'brief.md') brief = file.text;
      else resolution = JSON.parse(file.text);
      sources.push(`data/${record.id}/${name}`);
    } catch { /* missing evidence remains unknown */ }
  }
  return { ...dispatchEvidence(brief, resolution, record), sources };
}

async function readSupervision(home) {
  const result = { policy: 'default-by-primary', configured: null, host: null, engine: null, heartbeat: null, sources: [], warnings: [] };
  for (const name of ['supervision-host-off', 'supervision-host']) {
    try {
      const file = await boundedFile(join(home, 'config', name), 1024);
      result.sources.push(`config/${name}`);
      if (name.endsWith('-off')) result.policy = 'off';
      else {
        if (result.policy !== 'off') result.policy = 'explicit';
        const match = file.text.trim().match(/^([\w.-]+)(?:\s+([\w./:@-]+))?$/);
        result.configured = { engine: match?.[1] || '', model: match?.[2] || '' };
      }
    } catch (error) { if (error.code !== 'ENOENT') result.warnings.push(`${name} 不可读取`); }
  }
  for (const name of ['.supervision-host', '.supervision-host-engine', '.last-watcher-beat']) {
    try {
      const file = await boundedFile(join(home, 'state', name), 16 * 1024);
      result.sources.push(`state/${name}`);
      if (name === '.last-watcher-beat') result.heartbeat = file.modified;
      else if (name === '.supervision-host') {
        const line = file.text.split('\n').find(line => /^host\t[1-9]\d*\t/.test(line));
        if (!line) continue;
        const pid = Number(line.split('\t')[1]);
        let pidExists = null;
        try { process.kill(pid, 0); pidExists = true; }
        catch (error) { if (error.code === 'ESRCH') pidExists = false; }
        result.host = { pid, pidExists, modified: file.modified, identityVerified: false };
      } else {
        const fields = Object.fromEntries(file.text.split('\n').filter(line => /^[a-z_]+=/.test(line)).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
        const token = value => /^[\w./:@-]{1,150}$/.test(value || '') ? value : '';
        result.engine = { engine: token(fields.engine), model: token(fields.model), modified: file.modified };
      }
    } catch (error) { if (error.code !== 'ENOENT') result.warnings.push(`${name} 不可读取`); }
  }
  return result;
}

export async function snapshot(options = {}) {
  const entries = Array.isArray(options.homes) ? options.homes.slice(0, 8) : [];
  const dirs = backupDirs(options);
  const homes = [];
  for (const entry of entries) {
    if (isRemoteEntry(entry)) {
      const [home, authority] = await Promise.all([
        readRemoteHome(entry, options),
        entry.remote.dispatchCli ? invokeConfigCli(entry, options, 'dispatch-read', {}).catch(error => ({ dispatchError: error.message })) : null,
      ]);
      if (authority && home.role?.kind === 'primary') {
        Object.assign(home, authority, { dispatchAuthority: true });
      } else if (authority?.dispatchError) home.warnings.push(authority.dispatchError);
      homes.push(home);
      continue;
    }
    const home = { name: String(entry.name ?? 'First Mate'), machine: String(entry.machine ?? '本机'), rules: [], records: [], warnings: [], dispatch: null };
    home.hiddenSecondmates = Array.isArray(entry.hiddenSecondmates) ? entry.hiddenSecondmates.filter(id => typeof id === 'string' && /^[\w.-]+$/.test(id)).slice(0, 100) : [];
    try {
      const path = await realpath(resolve(entry.path));
      await lstat(join(path, 'config')); await lstat(join(path, 'state'));
      home.path = path;
      try {
        const marker = (await boundedFile(join(path, '.fm-secondmate-home'), 1024)).text.trim();
        home.role = /^[a-zA-Z0-9_.-]+$/.test(marker) ? { kind: 'secondmate', id: marker, source: '.fm-secondmate-home' } : { kind: 'unknown', source: '.fm-secondmate-home' };
      } catch (error) {
        home.role = { kind: error.code === 'ENOENT' ? 'primary' : 'unknown' };
      }
      try {
        const file = await boundedFile(join(path, 'config', 'crew-dispatch.json'), FILE_LIMIT);
        Object.assign(home, await dispatchView(file, dirs, path));
      } catch (error) { home.warnings.push(error.code === 'ENOENT' ? '未配置 crew-dispatch.json；不推断默认模型' : '派工规则读取失败'); }
      const names = (await readdir(join(path, 'state'))).filter(name => /^[a-zA-Z0-9_.-]+\.meta$/.test(name)).sort().slice(0, 300);
      for (const name of names) {
        try {
          const file = await boundedFile(join(path, 'state', name), 128 * 1024);
          const meta = Object.fromEntries(file.text.split('\n').filter(line => /^[a-zA-Z_][a-zA-Z0-9_]*=/.test(line)).map(line => {
            const at = line.indexOf('=');
            return [line.slice(0, at), line.slice(at + 1).replace(/^(['"])(.*)\1$/, '$2')];
          }));
          const record = {
            id: name.slice(0, -5), kind: meta.kind || 'unknown', harness: meta.harness || '', model: meta.model || '',
            effort: meta.effort || '', backend: meta.backend || meta.remote_backend || '', remote: Boolean(meta.remote_host),
            source: `state/${name}`, modified: file.modified, liveModel: null, liveStatus: 'unknown',
            location: { machine: meta.remote_host || home.machine, home: meta.home || (meta.remote_host ? '' : path), source: `state/${name}` },
            override: Boolean(meta.dispatch_override),
          };
          if (['ship', 'scout'].includes(record.kind)) record.dispatchEvidence = await taskEvidence(path, record);
          home.records.push(record);
        } catch { home.warnings.push(`无法读取启动记录 ${name}`); }
      }
      home.records.sort((a, b) => b.modified.localeCompare(a.modified));
      home.supervision = await readSupervision(path);
      try {
        home.secondmate = await readSecondmate(path, options, dirs);
        if (home.secondmate?.error) home.warnings.push(home.secondmate.error);
        if (home.secondmate?.rosterWarning) home.warnings.push(home.secondmate.rosterWarning);
      } catch {
        home.secondmate = { absent: false, error: '副手启动配置读取失败', revision: '', default: null, mates: [], latestBackup: null };
        home.warnings.push(home.secondmate.error);
      }
      home.readable = true;
      home.settings = await readSettings(entry, home.role, ...dirs);
    } catch { home.readable = false; home.warnings.push('Home 不可读取；未尝试连接远程机器'); }
    if (home.role?.kind === 'secondmate' && !options.localOnly) {
      home.parent = { status: entry.parent ? 'unavailable' : 'unconfigured' };
      if (entry.parent) {
        try {
          const parent = await parentSnapshot(entry, home.role.id, options);
          const own = parent.home.secondmate?.mates?.find(mate => mate.id === home.role.id);
          home.parent = { status: 'connected', local: Boolean(parent.entry), name: parent.home.name, machine: parent.home.machine, path: parent.home.path, version: parent.data.pluginVersion, observedAt: parent.data.observedAt, startup: own || null, startupRevision: parent.home.secondmate?.revision || '', dispatchRevision: parent.home.dispatch?.revision || '' };
        } catch { home.warnings.push('大副连接不可用；当前显示本机已保存的派工规则，不把它当作大副最新配置。'); }
      }
    }
    homes.push(home);
  }
  return {
    catalogSeats: Object.keys(options.catalogTargets || {}), schemaVersion: 1, pluginVersion, capabilities: { dispatchSync: true, explicitDispatchPush: true, quotaSource: true, settings: true }, observedAt: new Date().toISOString(), readOnly: false, launchRecordsReadOnly: true, homes,
    boundary: '插件只访问明确配置的 Home。各配置分开预览、备份和保存；账号不在页面显示，发布身份只读。state/*.meta 只读。保存不重启运行中的席。',
  };
}

function parentBase(entry) {
  const url = new URL(entry.parent?.url || '');
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw httpError(503, 'parent', '大副连接必须使用已配置的 IPv4 回环地址');
  return url.origin;
}

function parentHeaders(entry) {
  const port = entry.parent.servicePort ?? Number(new URL(parentBase(entry)).port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw httpError(503, 'parent', '大副服务端口无效');
  return { Host: `127.0.0.1:${port}` };
}

async function parentSnapshot(entry, id, options) {
  const index = entry.parent.home ?? 0;
  let data, home, localEntry;
  if (Object.hasOwn(entry.parent, 'url')) {
    const response = await fetch(`${parentBase(entry)}/api/snapshot?local=1`, { headers: parentHeaders(entry), signal: AbortSignal.timeout(8000), redirect: 'error' });
    if (!response.ok) throw httpError(503, 'parent', '无法读取大副配置');
    const text = await response.text();
    if (Buffer.byteLength(text) > 4 * FILE_LIMIT) throw httpError(503, 'parent', '大副响应超过大小限制');
    data = JSON.parse(text);
    home = data.homes?.[index];
  } else {
    localEntry = selectedHome(options, entry.parent.home);
    data = await snapshot({ ...options, homes: [localEntry], localOnly: true });
    [home] = data.homes;
  }
  if (home?.role?.kind !== 'primary' || !home.readable || !home.secondmate?.mates?.some(mate => mate.id === id)) throw httpError(503, 'parent', '大副身份或二副登记不匹配');
  return { data, home, entry: localEntry };
}

async function syncFromParent(entry, id, kind, options, report) {
  try {
    report('parent', '正在连接大副并核对配置');
    const parent = await parentSnapshot(entry, id, options);
    const revision = kind === 'secondmate' ? parent.home.secondmate?.revision : parent.home.dispatch?.revision;
    let sync;
    if (parent.entry) {
      sync = kind === 'secondmate'
        ? await pushSavedPin(options, parent.entry, revision)
        : (await pushSavedDispatch(options, parent.entry, { baseRevision: revision })).sync;
    } else {
      const document = await fetch(`${parentBase(entry)}/`, { headers: parentHeaders(entry), signal: AbortSignal.timeout(8000), redirect: 'error' });
      const text = await document.text();
      const token = text.match(/name="fm-write-token" content="([a-f0-9]{64})"/)?.[1];
      if (!document.ok || !token) throw new Error('parent unavailable');
      report('sync', '大副已连接，正在等待大副执行同步');
      const response = await fetch(`${parentBase(entry)}/api/${kind}/sync`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(125000),
        headers: { ...parentHeaders(entry), 'content-type': 'application/json', [WRITE_HEADER]: token },
        body: JSON.stringify({ home: entry.parent.home ?? 0, baseRevision: revision }),
      });
      if (!response.ok) throw new Error('parent sync failed');
      ({ sync } = await response.json());
    }
    report('verify', '正在核对本机文件与大副回执');
    const fresh = await parentSnapshot(entry, id, options);
    const local = await boundedFile(join(entry.path, 'config', 'crew-dispatch.json'), FILE_LIMIT);
    const matches = sha256(local.bytes) === fresh.home.dispatch?.revision;
    const own = sync?.targets?.find(target => target.id === id);
    const others = (sync?.targets || []).filter(target => target.id !== id);
    const status = matches && own && ['pushed', 'unchanged'].includes(own.dispatch) && own.reread !== 'failed' && (own.dispatch === 'unchanged' || own.reread === 'sent') ? 'completed' : 'partial';
    return { status, targets: own ? [own] : [], otherTargets: others, direction: 'from_primary', parent: { name: fresh.home.name, machine: fresh.home.machine, startupRevision: fresh.home.secondmate?.revision, dispatchRevision: fresh.home.dispatch?.revision }, message: `${matches ? '本机派工文件与大副已一致' : '本机派工文件尚未与大副一致'}；已从大副读取最新启动配置。${own?.reread === 'failed' ? '重读通知失败，仍需重试。' : '不代表运行会话已切换。'}${others.some(target => !['pushed', 'unchanged'].includes(target.dispatch) || target.reread === 'failed') ? '其他登记目标仍有未完成事项，由大副页面单独显示。' : ''}` };
  } catch {
    throw httpError(503, 'parent', '与大副同步未完成，请检查插件中的大副配置及 Firstmate 同步入口。');
  }
}

function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function resolveDispatchFile(entry) {
  const home = await realpath(resolve(String(entry?.path || '')));
  const configDir = await realpath(join(home, 'config'));
  if (configDir !== join(home, 'config')) throw httpError(403, 'forbidden', '拒绝跟随 config 目录链接');
  const file = join(configDir, 'crew-dispatch.json');
  const st = await lstat(file);
  if (!st.isFile() || st.isSymbolicLink()) throw httpError(403, 'forbidden', '只允许写入普通的 crew-dispatch.json 文件');
  const realFile = await realpath(file);
  if (realFile !== join(configDir, 'crew-dispatch.json')) throw httpError(403, 'forbidden', '拒绝跟随配置文件链接');
  if (!inside(home, realFile)) throw httpError(403, 'forbidden', '拒绝写入 Home 之外的路径');
  return { home, file: realFile, mode: st.mode };
}

function configuredHome(options, index) {
  const entries = Array.isArray(options.homes) ? options.homes.slice(0, 8) : [];
  if (!Number.isInteger(index) || index < 0 || index >= entries.length) throw httpError(400, 'rejected', '只能修改插件选项里配置的 Home');
  return entries[index];
}

function selectedHome(options, index) {
  const entry = configuredHome(options, index);
  if (isRemoteEntry(entry)) throw httpError(403, 'read_only_remote', '这个 Home 是远端只读配置。本插件只读取它，不能在这里修改。');
  return entry;
}

export const configOperations = new Set(['dispatch-read', 'dispatch-preview', 'dispatch-commit', 'dispatch-push', 'quota-status', 'quota-read', 'quota-save']);
export const configHomePath = value => typeof value === 'string' && /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(value) && !value.split('/').some(part => part === '..' || part === '.');

async function invokeConfigCli(entry, options, operation, body) {
  const target = remoteTarget(entry);
  const cli = entry.remote.dispatchCli;
  if (!configHomePath(target.path) || !configHomePath(cli) || !cli.endsWith('/firstmate-config.mjs') || !configOperations.has(operation)) {
    throw httpError(503, 'transport', '远端大副 配置 CLI 路径无效');
  }
  const runtime = entry.remote.dispatchRuntime ?? 'node';
  if (!['node', 'bun'].includes(runtime)) throw httpError(503, 'transport', '远端大副 配置 CLI 运行时无效');
  const args = [
    '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ClearAllForwardings=yes',
    target.ssh, `${runtime} ${cli} ${operation} ${target.path}`,
  ];
  let result;
  try {
    const { stdout } = await exec(options.sshCommand || 'ssh', args, {
      input: JSON.stringify(body), timeout: operation === 'dispatch-push' ? 130000 : 30000, maxBuffer: 8 * FILE_LIMIT,
    });
    result = JSON.parse(stdout);
    if (result?.ok !== true && result?.ok !== false) throw new Error('invalid reply');
  } catch {
    const mutation = ['dispatch-commit', 'dispatch-push', 'quota-save'].includes(operation);
    throw httpError(502, 'transport', mutation ? '远端大副 未返回操作回执，请先刷新核对配置或同步结果。' : '远端大副 未返回读取回执，请检查已配置的 SSH 与插件 CLI。');
  }
  if (!result.ok) {
    const status = Number.isInteger(result.status) && result.status >= 400 && result.status <= 599 ? result.status : 502;
    throw httpError(status, result.error, result.message);
  }
  return result.result;
}

function setOptional(obj, key, value) {
  if (value == null || value === '') { delete obj[key]; return; }
  if (typeof value !== 'string') throw httpError(400, 'rejected', `${key} 必须是字符串`);
  if (/[\u0000-\u001f]/.test(value)) throw httpError(400, 'rejected', `${key} 含有控制字符`);
  const trimmed = value.trim();
  if (!trimmed) { delete obj[key]; return; }
  obj[key] = trimmed;
}

function editProfiles(current, edits, label) {
  const list = Array.isArray(current) ? current : [current];
  if (!Array.isArray(edits) || edits.length !== list.length) throw httpError(400, 'rejected', `${label}的候选数量不能增删`);
  edits.forEach((edit, j) => {
    const target = list[j];
    if (!target || typeof target !== 'object' || Array.isArray(target)) throw httpError(400, 'rejected', `${label}的候选必须是对象`);
    if (!edit || typeof edit !== 'object' || Array.isArray(edit)) throw httpError(400, 'rejected', `${label}的候选必须是对象`);
    if (typeof edit.harness !== 'string' || !edit.harness.trim() || /\s/.test(edit.harness) || /[\u0000-\u001f]/.test(edit.harness)) {
      throw httpError(400, 'rejected', `${label}的每个候选都需要不含空白的 harness`);
    }
    target.harness = edit.harness.trim();
    for (const field of ['model', 'effort']) {
      if (Object.hasOwn(edit, field) && edit[field] !== target[field]) setOptional(target, field, edit[field]);
    }
  });
}

export function applyDispatchEdits(original, body) {
  if (!original || typeof original !== 'object' || Array.isArray(original)) throw httpError(400, 'rejected', '配置顶层必须是对象');
  const next = JSON.parse(JSON.stringify(original));
  if (!Array.isArray(next.rules)) throw httpError(400, 'rejected', 'rules 必须是数组');
  if (!Array.isArray(body?.rules) || body.rules.length !== next.rules.length) throw httpError(400, 'rejected', '规则数量不能增删');
  body.rules.forEach((edit, i) => {
    const rule = next.rules[i];
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw httpError(400, 'rejected', '每条规则必须是对象');
    if (!edit || typeof edit !== 'object' || Array.isArray(edit)) throw httpError(400, 'rejected', '每条规则必须是对象');
    if (typeof edit.when !== 'string' || edit.when.trim() === '') throw httpError(400, 'rejected', '每条规则的 when 不能为空');
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(edit.when)) throw httpError(400, 'rejected', 'when 含有控制字符');
    rule.when = edit.when;
    if (rule.use == null || (typeof rule.use !== 'object')) throw httpError(400, 'rejected', '每条规则都需要 use');
    editProfiles(rule.use, edit.use, `规则 ${i + 1}`);
  });
  if (next.default == null) {
    if (body.default != null) throw httpError(400, 'rejected', '不能新增 default');
  } else {
    if (typeof next.default !== 'object') throw httpError(400, 'rejected', 'default 必须是对象或数组');
    editProfiles(next.default, body.default, '默认配置');
  }
  return next;
}

// Preserve original line numbers while withholding complete sensitive JSON values.
function safePreviewLines(text) {
  const lines = text.split('\n');
  const hidden = new Set();
  const sensitive = /env|token|secret|password|account[_-]?key|authorization|api[_-]?key|access[_-]?key|credential/i;
  const property = /"((?:\\.|[^"\\])*)"\s*:/g;
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const lineAt = position => {
    let low = 0, high = starts.length;
    while (low + 1 < high) { const middle = (low + high) >>> 1; if (starts[middle] <= position) low = middle; else high = middle; }
    return low;
  };
  let match;
  while ((match = property.exec(text))) {
    let key;
    try { key = JSON.parse(`"${match[1]}"`); } catch { continue; }
    if (!sensitive.test(key)) continue;
    let at = property.lastIndex;
    while (/\s/.test(text[at] || '') && at < text.length) at++;
    let end = at, depth = 0, quoted = false, escaped = false;
    const container = text[at] === '{' || text[at] === '[';
    for (; end < text.length; end++) {
      const ch = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') { quoted = false; if (!container) { end++; break; } }
      } else if (ch === '"') quoted = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') { if (!container || --depth === 0) { if (container) end++; break; } }
      else if (!container && (ch === ',' || ch === '\n')) break;
    }
    for (let line = lineAt(match.index); line <= lineAt(Math.max(at, end - 1)); line++) hidden.add(line);
  }
  return lines.map((line, i) => hidden.has(i) || /(?:env|token|secret|password|authorization|api[_-]?key|access[_-]?key|credential)\s*[:=]/i.test(line) ? `${line.match(/^\s*/)?.[0] || ''}[敏感配置已隐藏]` : line);
}

export function previewDiff(before, after) {
  if (before === after) return { diff: '（没有文本差异）', fullDiff: '（没有文本差异）' };
  const A = before.split('\n'), B = after.split('\n');
  const safeA = safePreviewLines(before), safeB = safePreviewLines(after);
  const rows = [];
  let i = 0, j = 0;
  const push = type => {
    rows.push({ type, old: i + 1, next: j + 1, text: type === '+' ? safeB[j] : safeA[i] });
    if (type !== '+') i++;
    if (type !== '-') j++;
  };
  if (A.length * B.length <= 400000) {
    const dp = Array.from({ length: A.length + 1 }, () => new Uint32Array(B.length + 1));
    for (let x = A.length - 1; x >= 0; x--) for (let y = B.length - 1; y >= 0; y--) dp[x][y] = A[x] === B[y] ? dp[x + 1][y + 1] + 1 : Math.max(dp[x + 1][y], dp[x][y + 1]);
    while (i < A.length && j < B.length) {
      if (A[i] === B[j]) push(' ');
      else push(dp[i + 1][j] >= dp[i][j + 1] ? '-' : '+');
    }
  } else {
    // Large inputs avoid quadratic allocation; retain shared prefix and suffix.
    while (i < A.length && j < B.length && A[i] === B[j]) push(' ');
    let suffix = 0;
    while (A.length - suffix > i && B.length - suffix > j && A[A.length - suffix - 1] === B[B.length - suffix - 1]) suffix++;
    while (i < A.length - suffix) push('-');
    while (j < B.length - suffix) push('+');
  }
  while (i < A.length && j < B.length) push(' ');
  while (i < A.length) push('-');
  while (j < B.length) push('+');
  const format = ranges => ranges.map(([start, end]) => {
    const selected = rows.slice(start, end);
    return `@@ -${rows[start].old},${selected.filter(r => r.type !== '+').length} +${rows[start].next},${selected.filter(r => r.type !== '-').length} @@\n${selected.map(r => r.type + r.text).join('\n')}`;
  }).join('\n');
  const ranges = [];
  rows.forEach((row, index) => {
    if (row.type === ' ') return;
    const start = Math.max(0, index - 8), end = Math.min(rows.length, index + 9);
    const previous = ranges.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else ranges.push([start, end]);
  });
  return { diff: format(ranges), fullDiff: format([[0, rows.length]]) };
}

function validatorScript(home, options) {
  const script = options.bootstrap || join(home, 'bin', 'fm-bootstrap.sh');
  if (basename(script) !== 'fm-bootstrap.sh') throw httpError(500, 'validator', '配置校验入口不被允许');
  return script;
}

const PIN_FILE = 'secondmate-harness';
const PIN_BACKUP = /^secondmate-backup-\d+-[a-f0-9]{12}\.txt$/;

function harnessScriptPath(home, options) {
  const script = options.harness || (options.bootstrap ? join(dirname(options.bootstrap), 'fm-harness.sh') : join(home, 'bin', 'fm-harness.sh'));
  if (basename(script) !== 'fm-harness.sh') throw httpError(500, 'validator', '副手配置校验入口不被允许');
  return script;
}

function pinEnv(dir) {
  return {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || '',
    TMPDIR: tmpdir(),
    LANG: 'C.UTF-8',
    FM_HOME: dir,
    FM_CONFIG_OVERRIDE: join(dir, 'config'),
  };
}

function splitPin(text) {
  if (text === '') return { lines: [], ended: false, crlf: false };
  const crlf = text.includes('\r\n');
  const norm = crlf ? text.replace(/\r\n/g, '\n') : text;
  const ended = norm.endsWith('\n');
  const body = ended ? norm.slice(0, -1) : norm;
  return { lines: body === '' ? [] : body.split('\n'), ended, crlf };
}

function joinPin(lines, ended, crlf) {
  let text = lines.join('\n') + (ended ? '\n' : '');
  if (crlf) text = text.replace(/\n/g, '\r\n');
  return text;
}

function pinFields(value) {
  const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
  return { harness: parts[0] || '', model: parts[1] || '', effort: parts[2] || '', extra: Math.max(0, parts.length - 3) };
}

function cleanToken(value, label) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') throw httpError(400, 'rejected', `${label} 必须是字符串`);
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/\s/.test(trimmed) || /[\u0000-\u001f]/.test(trimmed)) throw httpError(400, 'rejected', `${label}不能包含空白或控制字符`);
  return trimmed;
}

function pinText(harness, model, effort) {
  const h = cleanToken(harness, 'harness');
  const m = cleanToken(model, 'model');
  const e = cleanToken(effort, 'effort');
  if (!h) throw httpError(400, 'rejected', 'harness 不能为空');
  if (!m && e) throw httpError(400, 'rejected', 'effort 是第三个词，不能在没有 model 时写入');
  if (h === 'default' && (m || e)) throw httpError(400, 'rejected', 'harness 为 default 时，解析器不会读取 model 和 effort');
  return [h, m, e].filter(Boolean).join(' ');
}

async function parserFunction(script) {
  const text = await readFile(script, 'utf8');
  const start = text.indexOf('secondmate_parse() {');
  const end = text.indexOf('\nsecondmate_line() {');
  if (start < 0 || end < start) throw httpError(500, 'validator', 'fm-harness.sh 里没有 secondmate_parse');
  const fn = text.slice(start, end);
  if (!fn.includes('secondmate_parse() {') || !fn.includes('declares_override')) {
    throw httpError(500, 'validator', 'fm-harness.sh 的 secondmate_parse 无法原样调用');
  }
  return fn;
}

const PARSE_SH = `
set -u
. "$1"
CONFIG="$2"
secondmate_parse
status=$?
if [ "$status" -ne 0 ]; then
  exit 0
fi
printf 'OK\\n'
printf 'DEFAULT\\t%s\\t' "\${SM_DEFAULT_LINE_NUM:-0}"
printf '%s' "\${SM_DEFAULT_LINE:-}" | base64 | tr -d '\\n'
printf '\\n'
i=0
while [ "$i" -lt "\${#SM_MATE_IDS[@]}" ]; do
  printf 'MATE\\t%s\\t%s\\t' "\${SM_MATE_LINES[$i]}" "\${SM_MATE_IDS[$i]}"
  printf '%s' "\${SM_MATE_VALS[$i]}" | base64 | tr -d '\\n'
  printf '\\n'
  i=$((i + 1))
done
`;

async function parseSecondmateText(script, text) {
  const fn = await parserFunction(script);
  return cachedValidation('pin-parse', [fn, text], async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fm-secondmate-parse-'));
  try {
    await mkdir(join(dir, 'config'), { recursive: true });
    await writeFile(join(dir, 'config', PIN_FILE), text, { mode: 0o600 });
    await writeFile(join(dir, 'parse.bash'), fn, { mode: 0o600 });
    let result;
    try {
      result = await exec('bash', ['-c', PARSE_SH, 'parse', join(dir, 'parse.bash'), join(dir, 'config')], {
        env: pinEnv(dir),
        timeout: 8000,
        maxBuffer: FILE_LIMIT,
      });
    } catch (error) {
      const stderr = String(error.stderr || '').trim();
      return { ok: false, error: stderr || '配置校验没有完成，已拒绝保存' };
    }
    const stderr = result.stderr.trim();
    const rows = result.stdout.split('\n').filter(Boolean);
    if (rows[0] !== 'OK') return { ok: false, error: stderr || '配置校验没有完成，已拒绝保存' };
    if (stderr) return { ok: false, error: stderr };
    let defaultLine = 0;
    let defaultRaw = '';
    const overrides = [];
    for (const row of rows.slice(1)) {
      const parts = row.split('\t');
      if (parts[0] === 'DEFAULT' && parts.length >= 3) {
        defaultLine = Number(parts[1]) || 0;
        defaultRaw = Buffer.from(parts.slice(2).join('\t'), 'base64').toString('utf8');
      } else if (parts[0] === 'MATE' && parts.length >= 4) {
        overrides.push({
          line: Number(parts[1]) || 0,
          id: parts[2],
          raw: Buffer.from(parts.slice(3).join('\t'), 'base64').toString('utf8'),
        });
      } else {
        return { ok: false, error: '解析器没有返回可读的副手配置结构' };
      }
    }
    const parsedDefault = pinFields(defaultRaw);
    return {
      ok: true,
      defaultLine,
      defaultRaw,
      default: { harness: parsedDefault.harness, model: parsedDefault.model, effort: parsedDefault.effort, extra: parsedDefault.extra },
      overrides: overrides.map(item => ({ ...item, ...pinFields(item.raw) })),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  });
}

async function confirmSecondmateParse(script, text, parsed) {
  return cachedValidation('pin-confirm', [await validatorStamp(script), text], async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fm-secondmate-check-'));
  try {
    await mkdir(join(dir, 'config'), { recursive: true });
    await writeFile(join(dir, 'config', PIN_FILE), text, { mode: 0o600 });
    const env = pinEnv(dir);
    const read = async (args) => {
      try {
        const { stdout } = await exec(script, args, { env, timeout: 15000, maxBuffer: 64 * 1024 });
        return { ok: true, value: stdout.trim() };
      } catch (error) {
        return { ok: false, error: String(error.stderr || '').trim() || '配置校验没有完成，已拒绝保存' };
      }
    };
    const check = async (id, fields) => {
      const args = id ? ['secondmate', id] : ['secondmate'];
      const [harness, model, effort] = await Promise.all([
        read(args),
        read(id ? ['secondmate-model', id] : ['secondmate-model']),
        read(id ? ['secondmate-effort', id] : ['secondmate-effort']),
      ]);
      if (!harness.ok) return harness;
      if (!fields.harness || fields.harness === 'default') return { ok: true };
      if (harness.value !== fields.harness) return { ok: false, error: '原生解析器读到的 Harness 与配置不一致' };
      if (!model.ok) return model;
      if (!effort.ok) return effort;
      if (model.value !== fields.model || effort.value !== fields.effort) {
        return { ok: false, error: `解析器读到${id ? ` ${id} 的` : '默认行的'} model/effort 与文件不一致` };
      }
      return { ok: true };
    };
    const base = await check('', parsed.default);
    if (!base.ok) return base;
    for (const mate of parsed.overrides) {
      const got = await check(mate.id, mate);
      if (!got.ok) return got;
    }
    return { ok: true };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  });
}

function legacyIgnoredCount(text, defaultLine, overrideCount) {
  if (overrideCount > 0) return 0;
  const { lines } = splitPin(text);
  let seen = false;
  let count = 0;
  lines.forEach((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    if (!seen && index + 1 === defaultLine) { seen = true; return; }
    if (!seen) { seen = true; return; }
    count += 1;
  });
  return count;
}

async function secondmateIds(home) {
  const ids = new Set();
  let names = [];
  try { names = await readdir(join(home, 'state')); } catch { names = []; }
  for (const name of names) {
    if (!/^[A-Za-z0-9._-]+\.meta$/.test(name)) continue;
    try {
      const file = await boundedFile(join(home, 'state', name), 128 * 1024);
      let kind = '';
      for (const line of file.text.split('\n')) {
        if (line.startsWith('kind=')) { kind = line.slice(5).trim(); break; }
      }
      if (kind === 'secondmate') ids.add(name.slice(0, -5));
    } catch { /* the launch-record loop already reports unreadable meta */ }
  }
  try {
    const registry = await boundedFile(join(home, 'data', 'secondmates.md'), FILE_LIMIT);
    for (const line of registry.text.split('\n')) {
      const match = /^- ([A-Za-z0-9._-]+)(?:\s|$)/.exec(line);
      if (match) ids.add(match[1]);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') return { ids, warning: 'data/secondmates.md 无法按普通文件读取，名单里可能少了副手' };
  }
  return { ids, warning: null };
}

async function readSecondmate(home, options, dirs) {
  const filePath = join(home, 'config', PIN_FILE);
  let file;
  try { file = await boundedFile(filePath, FILE_LIMIT); }
  catch (error) {
    if (error?.code === 'ENOENT') {
      const roster = await secondmateIds(home);
      const mates = [...roster.ids].sort((a, b) => a.localeCompare(b)).map(id => ({ id, source: 'inherit', line: null, harness: '', model: '', effort: '' }));
      return { absent: true, error: null, revision: '', default: null, mates, rosterWarning: roster.warning, latestBackup: null, source: `config/${PIN_FILE}` };
    }
    return { absent: false, error: 'secondmate-harness 不是可读的普通文件', revision: '', default: null, mates: [], latestBackup: null, source: `config/${PIN_FILE}` };
  }
  const script = harnessScriptPath(home, options);
  try { await access(script); }
  catch { return { absent: false, error: '找不到 fm-harness.sh，不能按现有解析器读取 secondmate-harness', revision: sha256(file.bytes), default: null, mates: [], latestBackup: await latestBackup(dirs, home, PIN_BACKUP, `config/${PIN_FILE}`), source: `config/${PIN_FILE}`, modified: file.modified }; }
  const parsed = await parseSecondmateText(script, file.text);
  const base = {
    absent: false,
    revision: sha256(file.bytes),
    modified: file.modified,
    source: `config/${PIN_FILE}`,
    latestBackup: await latestBackup(dirs, home, PIN_BACKUP, `config/${PIN_FILE}`),
    default: null,
    mates: [],
  };
  if (!parsed.ok) return { ...base, error: parsed.error };
  const confirmed = await confirmSecondmateParse(script, file.text, parsed);
  if (!confirmed.ok) return { ...base, error: confirmed.error };
  const roster = await secondmateIds(home);
  const ids = roster.ids;
  for (const mate of parsed.overrides) ids.add(mate.id);
  const byId = new Map(parsed.overrides.map(mate => [mate.id, mate]));
  const mates = [...ids].sort((a, b) => a.localeCompare(b)).map(id => {
    const over = byId.get(id);
    if (over) return { id, source: 'override', line: over.line, harness: over.harness, model: over.model, effort: over.effort };
    return { id, source: 'inherit', line: null, harness: parsed.default.harness, model: parsed.default.model, effort: parsed.default.effort };
  });
  return {
    ...base,
    error: null,
    rosterWarning: roster.warning,
    ignoredLines: legacyIgnoredCount(file.text, parsed.defaultLine, parsed.overrides.length),
    default: parsed.defaultLine ? {
      line: parsed.defaultLine,
      harness: parsed.default.harness,
      model: parsed.default.model,
      effort: parsed.default.effort,
      ignoredTokens: parsed.default.extra,
    } : null,
    mates,
  };
}

function samePin(fields, harness, model, effort) {
  return fields.harness === harness && fields.model === model && fields.effort === effort;
}

function applySecondmateEdits(originalText, parsed, body) {
  const pin = splitPin(originalText);
  const lines = pin.lines.slice();
  if (!Array.isArray(body.mates)) throw httpError(400, 'rejected', '副手列表格式不对');
  const sentIds = body.mates.map(mate => {
    if (!mate || typeof mate !== 'object' || Array.isArray(mate)) throw httpError(400, 'rejected', '每个副手都必须是对象');
    if (typeof mate.id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(mate.id)) throw httpError(400, 'rejected', '副手 id 不合法');
    if (mate.source !== 'override' && mate.source !== 'inherit') throw httpError(400, 'rejected', `${mate.id} 必须标明是否有独立配置`);
    return mate.id;
  });
  if (sentIds.length !== new Set(sentIds).size) throw httpError(400, 'rejected', '副手 id 重复');
  const drop = new Set();
  const mateLines = new Set(parsed.overrides.map(mate => mate.line));
  // A legacy file can have ignored lines that would become the default after deletion.
  lines.forEach((line, index) => {
    const value = line.trim();
    if (value && !value.startsWith('#') && !mateLines.has(index + 1)) drop.add(index + 1);
  });
  const seen = new Set();
  for (const edit of body.mates) {
    const over = parsed.overrides.find(item => item.id === edit.id);
    if (edit.source === 'inherit') {
      if (over?.line > 0) drop.add(over.line);
      continue;
    }
    const next = pinText(edit.harness, edit.model, edit.effort);
    if (over) {
      seen.add(edit.id);
      if (!(over.line > 0)) throw httpError(422, 'invalid', `覆写行 ${edit.id} 没有可定位的行号`);
      const current = lines[over.line - 1] ?? '';
      const fields = pinFields(over.raw);
      if (!samePin(fields, cleanToken(edit.harness, 'harness'), cleanToken(edit.model, 'model'), cleanToken(edit.effort, 'effort'))) {
        const lead = current.match(/^\s*/)?.[0] ?? '';
        lines[over.line - 1] = `${lead}mate ${edit.id}: ${next}`;
      }
    }
  }
  for (const lineNo of [...drop].sort((a, b) => b - a)) lines.splice(lineNo - 1, 1);
  for (const edit of body.mates) {
    if (edit.source !== 'override' || seen.has(edit.id)) continue;
    lines.push(`mate ${edit.id}: ${pinText(edit.harness, edit.model, edit.effort)}`);
  }
  const text = joinPin(lines, pin.ended || (lines.length > 0 && originalText === ''), pin.crlf);
  if (Buffer.byteLength(text) > FILE_LIMIT) throw httpError(413, 'rejected', '配置超过 1MB，已拒绝保存');
  return text;
}

async function resolvePinFile(entry) {
  const home = await realpath(resolve(String(entry?.path || '')));
  const configDir = await realpath(join(home, 'config'));
  if (!inside(home, configDir)) throw httpError(403, 'forbidden', '拒绝写入未配置的路径');
  const file = join(configDir, PIN_FILE);
  const st = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!st) return { home, file, mode: 0o600 };
  if (!st.isFile() || st.isSymbolicLink()) throw httpError(403, 'forbidden', '只允许写入普通的 secondmate-harness 文件');
  const realFile = await realpath(file);
  if (realFile !== join(configDir, PIN_FILE)) throw httpError(403, 'forbidden', '拒绝跟随配置文件链接');
  if (!inside(home, realFile)) throw httpError(403, 'forbidden', '拒绝写入 Home 之外的路径');
  return { home, file: realFile, mode: st.mode };
}

async function loadPin(file) {
  try { return await boundedFile(file, FILE_LIMIT); }
  catch (error) {
    if (error?.code === 'ENOENT') return { absent: true, text: '', bytes: Buffer.alloc(0) };
    throw httpError(403, 'forbidden', '只允许写入普通的 secondmate-harness 文件');
  }
}

const pinRevision = file => file.absent ? '' : sha256(file.bytes);

function expectedMateIds(roster, overrides) {
  const ids = new Set(roster);
  for (const mate of overrides) ids.add(mate.id);
  return [...ids].sort((a, b) => a.localeCompare(b));
}

async function planSecondmate(options, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'rejected', '请求必须是 JSON 对象');
  if ('path' in body || 'file' in body || 'homePath' in body) throw httpError(400, 'rejected', '请求不能指定写入路径');
  const entry = selectedHome(options, body.home);
  const target = await resolvePinFile(entry);
  const current = await loadPin(target.file);
  const revision = pinRevision(current);
  if (typeof body.baseRevision !== 'string' || body.baseRevision !== revision) {
    throw httpError(409, 'conflict', '配置文件在读取之后已经被改过。请刷新后再保存。');
  }
  const script = harnessScriptPath(target.home, options);
  try { await access(script); }
  catch { throw httpError(422, 'invalid', '找不到 fm-harness.sh，已拒绝保存'); }
  const parsed = await parseSecondmateText(script, current.text);
  if (!parsed.ok) throw httpError(422, 'invalid', parsed.error);
  let nextText;
  if (typeof body.restore === 'string') {
    if (!PIN_BACKUP.test(body.restore) || body.restore !== basename(body.restore)) throw httpError(400, 'rejected', '备份名称无效');
    const realBackup = await findBackup(options, body.restore);
    let meta;
    try { meta = JSON.parse(await readFile(`${realBackup}.meta.json`, 'utf8')); }
    catch { throw httpError(404, 'rejected', '找不到这份备份'); }
    if (meta.home !== target.home || meta.file !== `config/${PIN_FILE}`) throw httpError(403, 'forbidden', '该备份不属于这个 Home 的副手启动配置');
    const bytes = await readFile(realBackup);
    if (sha256(bytes) !== meta.sha256) throw httpError(422, 'invalid', '备份校验失败，已拒绝恢复');
    nextText = bytes.toString('utf8');
  } else {
    const roster = await secondmateIds(target.home);
    const expected = expectedMateIds(roster.ids, parsed.overrides);
    const sent = Array.isArray(body.mates) ? body.mates.map(mate => mate?.id).sort((a, b) => String(a).localeCompare(String(b))) : [];
    if (sent.length !== expected.length || sent.some((id, i) => id !== expected[i])) {
      throw httpError(409, 'conflict', '副手名单在读取之后变了。请刷新后再保存。');
    }
    nextText = applySecondmateEdits(current.text, parsed, body);
  }
  const again = await parseSecondmateText(script, nextText);
  if (!again.ok) throw httpError(422, 'invalid', again.error);
  const confirmed = await confirmSecondmateParse(script, nextText, again);
  if (!confirmed.ok) throw httpError(422, 'invalid', confirmed.error);
  return { target, current, revision, nextText, ...previewDiff(current.text, nextText) };
}

async function commitSecondmate(options, body) {
  const plan = await planSecondmate(options, body);
  if (plan.current.text === plan.nextText) {
    options.onProgress?.('saved', '本机配置已一致', { localSaved: true, unchanged: true });
    return { ok: true, unchanged: true, revision: plan.revision, diff: plan.diff, backup: null, sync: { status: 'not_required', targets: [], message: '启动配置由大副持有，二副直接读取，无需复制；不改变正在运行的会话。' } };
  }
  const again = await loadPin(plan.target.file);
  if (pinRevision(again) !== plan.revision) throw httpError(409, 'conflict', '配置文件在读取之后已经被改过。请刷新后再保存。');
  let id = null;
  if (!again.absent) {
    options.onProgress?.('backup', '校验通过，正在备份原配置');
    const [backupDir] = backupDirs(options);
    const realBackup = await mkdir(backupDir, { recursive: true, mode: 0o700 }).then(() => realpath(backupDir));
    if (inside(plan.target.home, realBackup) || realBackup === plan.target.home) throw httpError(500, 'backup', '备份目录不能放在 Home 里');
    id = `secondmate-backup-${Date.now()}-${randomBytes(6).toString('hex')}.txt`;
    const backupPath = join(realBackup, id);
    await writeFile(backupPath, again.bytes, { mode: 0o600 });
    await writeFile(`${backupPath}.meta.json`, JSON.stringify({
      v: 1, home: plan.target.home, file: `config/${PIN_FILE}`, sha256: plan.revision, created: new Date().toISOString(), bytes: again.bytes.length,
    }), { mode: 0o600 });
  }
  const tmp = `${plan.target.file}.tmp-${randomUUID()}`;
  try {
    options.onProgress?.('write', '正在保存本机配置');
    await writeFile(tmp, plan.nextText, { mode: plan.target.mode & 0o777 });
    const staged = await readFile(tmp, 'utf8');
    if (staged !== plan.nextText) throw httpError(500, 'verify', '写入前复核失败，已拒绝替换配置');
    const raced = await loadPin(plan.target.file);
    if (pinRevision(raced) !== plan.revision) throw httpError(409, 'conflict', '配置文件在读取之后已经被改过。请刷新后再保存。');
    if (again.absent) await link(tmp, plan.target.file);
    else await rename(tmp, plan.target.file);
    options.onProgress?.('verify', '正在读回核对本机配置');
    const written = await readFile(plan.target.file, 'utf8');
    if (written !== plan.nextText) {
      if (again.absent) throw httpError(409, 'conflict', '新配置在创建后发生变化，请刷新后核对。');
      await writeFile(plan.target.file, again.bytes);
      throw httpError(500, 'verify', '写入后读回的内容与预期不一致，已尝试恢复保存前的内容');
    }
  } catch (error) {
    if (again.absent && error.code === 'EEXIST') throw httpError(409, 'conflict', '配置文件在读取之后已经创建。请刷新后再保存。');
    throw error;
  } finally {
    await unlink(tmp).catch(() => {});
  }
  options.onProgress?.('saved', '本机配置已保存并核对', { localSaved: true });
  return { ok: true, unchanged: false, revision: sha256(plan.nextText), diff: plan.diff, backup: id, sync: { status: 'not_required', targets: [], message: '启动配置由大副持有，二副直接读取，无需复制；不改变正在运行的会话。' } };
}

async function typesafeOptIn(home, script) {
  const lib = join(dirname(script), 'fm-env-lib.sh');
  await access(lib);
  const { stdout } = await exec('bash', ['-c', `
set -u
lib=$1
file=$2
. "$lib"
v=$(fmx_env_get TYPESAFE_API_KEY "$file")
if [ -n "$v" ]; then printf yes; else printf no; fi
`, 'fm-env', lib, join(home, '.env')], { timeout: 5000, maxBuffer: 16 * 1024 });
  if (stdout.trim() === 'yes') return true;
  try {
    const cred = JSON.parse(await readFile(join(home, 'config', 'dispatch-credential-sources.json'), 'utf8'));
    return !!cred && typeof cred === 'object' && !Array.isArray(cred) && Object.prototype.hasOwnProperty.call(cred, 'typesafe');
  } catch { return false; }
}

async function validateDispatch(home, script, text, report = () => {}) {
  let typed;
  try { typed = await typesafeOptIn(home, script); } catch { throw httpError(422, 'invalid', '配置校验没有完成，已拒绝保存'); }
  return cachedValidation('dispatch', [home, await validatorStamp(script), text, typed], async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fm-dispatch-validate-'));
  try {
    await mkdir(join(dir, 'config'), { recursive: true });
    await writeFile(join(dir, 'config', 'crew-dispatch.json'), text, { mode: 0o600 });
    const env = {
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || '',
      TMPDIR: tmpdir(),
      LANG: 'C.UTF-8',
      FM_HOME: dir,
      FM_ROOT_OVERRIDE: dir,
      FM_BOOTSTRAP_DETECT_ONLY: '1',
      FM_BOOTSTRAP_NETWORK: 'skip',
      FM_BOOTSTRAP_LOCKED: '1',
      FM_BOOTSTRAP_VERBOSE_FACTS: '1',
    };
    if (typed) env.TYPESAFE_API_KEY = '1';
    let result;
    try {
      result = await exec(script, [], { env, timeout: 20000, maxBuffer: FILE_LIMIT });
    } catch {
      throw httpError(422, 'invalid', '配置校验没有完成，已拒绝保存');
    }
    const lines = result.stdout.split('\n').filter(Boolean);
    const problems = lines.filter(line => line.startsWith('CREW_DISPATCH: invalid config/crew-dispatch.json - ') || line.startsWith('MISSING: jq'));
    if (problems.length) throw httpError(422, 'invalid', problems.join('\n'));
    if (!lines.some(line => line.startsWith('BOOTSTRAP_INFO: crew dispatch active config/crew-dispatch.json'))) {
      throw httpError(422, 'invalid', '配置校验没有完成，已拒绝保存');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  }, () => report('validate-cache', '相同内容的原生校验已通过，正在复用结果'));
}

async function loadOriginal(file) {
  const current = await boundedFile(file, FILE_LIMIT);
  let parsed;
  try { parsed = JSON.parse(current.text); }
  catch { throw httpError(422, 'invalid', 'CREW_DISPATCH: invalid config/crew-dispatch.json - malformed JSON'); }
  return current;
}

function serialize(value, originalText) {
  const newline = originalText.endsWith('\n') || originalText.length === 0;
  const text = `${JSON.stringify(value, null, 2)}${newline ? '\n' : ''}`;
  if (Buffer.byteLength(text) > FILE_LIMIT) throw httpError(413, 'rejected', '配置超过 1MB，已拒绝保存');
  return text;
}

async function planWrite(options, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'rejected', '请求必须是 JSON 对象');
  if ('path' in body || 'file' in body || 'homePath' in body) throw httpError(400, 'rejected', '请求不能指定写入路径');
  const entry = selectedHome(options, body.home);
  const target = await resolveDispatchFile(entry);
  const current = await loadOriginal(target.file);
  const revision = sha256(current.bytes);
  if (typeof body.baseRevision !== 'string' || body.baseRevision !== revision) {
    throw httpError(409, 'conflict', '配置文件在读取之后已经被改过。请刷新后再保存。');
  }
  let nextText;
  if (typeof body.restore === 'string') {
    if (!DISPATCH_BACKUP.test(body.restore) || body.restore !== basename(body.restore)) {
      throw httpError(400, 'rejected', '备份名称无效');
    }
    const realBackup = await findBackup(options, body.restore);
    let meta;
    try { meta = JSON.parse(await readFile(`${realBackup}.meta.json`, 'utf8')); }
    catch { throw httpError(404, 'rejected', '找不到这份备份'); }
    if (meta.home !== target.home) throw httpError(403, 'forbidden', '该备份不属于这个 Home');
    const bytes = await readFile(realBackup);
    if (sha256(bytes) !== meta.sha256) throw httpError(422, 'invalid', '备份校验失败，已拒绝恢复');
    nextText = bytes.toString('utf8');
    try { JSON.parse(nextText); }
    catch { throw httpError(422, 'invalid', 'CREW_DISPATCH: invalid config/crew-dispatch.json - malformed JSON'); }
  } else {
    nextText = serialize(applyDispatchEdits(JSON.parse(current.text), body), current.text);
  }
  const script = validatorScript(target.home, options);
  try { await access(script); }
  catch { throw httpError(422, 'invalid', '配置校验没有完成，已拒绝保存'); }
  await validateDispatch(target.home, script, nextText, options.onProgress);
  return { target, current, revision, nextText, ...previewDiff(current.text, nextText) };
}

async function commitWrite(options, body) {
  const plan = await planWrite(options, body);
  if (body.nextRevision !== undefined && body.nextRevision !== sha256(plan.nextText)) throw httpError(409, 'conflict', '预览后的内容已变化，请重新预览。');
  return withConfigLock(plan.target.file, () => saveDispatchPlan(options, plan));
}

async function withConfigLock(file, action) {
  const lock = `${file}.dashboard-lock`;
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw httpError(409, 'conflict', '此配置正在保存或推送，请稍后刷新。');
    throw error;
  }
  try { return await action(); }
  finally { await rmdir(lock); }
}

async function saveDispatchPlan(options, plan) {
  const again = await boundedFile(plan.target.file, FILE_LIMIT);
  if (sha256(again.bytes) !== plan.revision) throw httpError(409, 'conflict', '配置文件在读取之后已经被改过。请刷新后再保存。');
  if (again.text === plan.nextText) {
    options.onProgress?.('saved', '已保存的派工配置一致', { localSaved: true, unchanged: true });
    return { ok: true, unchanged: true, revision: plan.revision, diff: plan.diff, backup: null };
  }
  options.onProgress?.('backup', '校验通过，正在备份原配置');
  const [backupDir] = backupDirs(options);
  const realBackup = await mkdir(backupDir, { recursive: true, mode: 0o700 }).then(() => realpath(backupDir));
  if (inside(plan.target.home, realBackup) || realBackup === plan.target.home) throw httpError(500, 'backup', '备份目录不能放在 Home 里');
  const id = `backup-${Date.now()}-${randomBytes(6).toString('hex')}.json`;
  const backupPath = join(realBackup, id);
  await writeFile(backupPath, again.bytes, { mode: 0o600 });
  await writeFile(`${backupPath}.meta.json`, JSON.stringify({
    v: 1, home: plan.target.home, sha256: sha256(again.bytes), created: new Date().toISOString(), bytes: again.bytes.length,
  }), { mode: 0o600 });
  const tmp = `${plan.target.file}.tmp-${randomUUID()}`;
  try {
    options.onProgress?.('write', '正在保存派工配置');
    await writeFile(tmp, plan.nextText, { flag: 'wx', mode: 0o600 });
    const mode = again.mode & 0o7777;
    await chmod(tmp, mode);
    const staged = await readFile(tmp, 'utf8');
    if (staged !== plan.nextText) throw httpError(500, 'verify', '写入前复核失败，已拒绝替换配置');
    const raced = await boundedFile(plan.target.file, FILE_LIMIT);
    if (sha256(raced.bytes) !== plan.revision || raced.mode !== again.mode) throw httpError(409, 'conflict', '配置文件在读取之后已经被改过。请刷新后再保存。');
    await rename(tmp, plan.target.file);
    options.onProgress?.('verify', '正在读回核对派工配置');
    const written = await boundedFile(plan.target.file, FILE_LIMIT);
    if (written.text !== plan.nextText || (written.mode & 0o7777) !== mode) throw httpError(503, 'verify', '保存后读回内容或权限已有变化，请刷新核对。');
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
  options.onProgress?.('saved', '派工配置已保存并核对', { localSaved: true });
  return { ok: true, unchanged: false, revision: sha256(plan.nextText), diff: plan.diff, backup: id };
}

const previewOf = plan => ({
  ok: true, diff: plan.diff, fullDiff: plan.fullDiff, revision: plan.revision, nextRevision: sha256(plan.nextText), unchanged: plan.current.text === plan.nextText,
});

async function pushSavedDispatch(options, entry, body) {
  const target = await resolveDispatchFile(entry);
  return withConfigLock(target.file, async () => {
    const current = await loadOriginal(target.file);
    const revision = sha256(current.bytes);
    if (body.baseRevision !== revision) throw httpError(409, 'conflict', '配置已变化，请刷新后推送。');
    const sync = await pushDispatch(options, target.home, ['crew-dispatch.json']);
    const after = await boundedFile(target.file, FILE_LIMIT).catch(() => null);
    if (!after || revision !== sha256(after.bytes)) {
      sync.status = 'partial';
      sync.message = '推送期间源文件已变化，请刷新后核对并重新推送。';
    }
    return { ok: true, sync: { ...sync, direction: 'to_secondmates' } };
  });
}

async function pushSavedPin(options, entry, baseRevision) {
  const target = await resolvePinFile(entry);
  const revision = pinRevision(await loadPin(target.file));
  if (baseRevision !== revision) throw httpError(409, 'conflict', '配置已变化，请刷新后同步。');
  const sync = await pushDispatch(options, target.home);
  return { ...sync, direction: 'to_secondmates', startupRevision: revision };
}

async function pushDispatch(options, home, items) {
  try { await access(join(home, '.fm-secondmate-home')); throw httpError(409, 'inherited', '当前是二副，请从大副同步配置。'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  options.onProgress?.('sync-wait', '正在等待同步入口');
  const previous = configPushes.get(home) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    const script = join(dirname(validatorScript(home, options)), 'fm-config-push.sh');
    try { await access(script); }
    catch { return { status: 'unavailable', targets: [], message: '找不到继承同步入口；本机配置已保留。' }; }
    let output = '', failed = false;
    options.onProgress?.('sync', items ? `正在增量同步 ${items.join('、')}` : '正在检查全部继承配置并同步差异');
    let activeTarget = '';
    const onLine = line => {
      const header = line.match(/^secondmate ([a-zA-Z0-9_.-]{1,80})(?:\s|:)/);
      if (header) { activeTarget = header[1]; options.onProgress?.('sync', `正在同步二副 ${activeTarget}`); }
      if (!activeTarget) return;
      const change = line.match(/^\s+crew-dispatch\.json: (pushed|unchanged|skipped|error)\b/) || line.match(/^\s+(pushed|unchanged|removed|skipped|error): config\/crew-dispatch\.json\b/);
      const labels = { pushed: '派工配置已推送，等待重读通知', unchanged: '派工配置已一致', skipped: '派工配置已跳过', error: '派工配置推送失败', removed: '派工配置已移除' };
      if (change) options.onProgress?.('sync', `${activeTarget}：${labels[change[1]]}`);
      const file = line.match(/^\s+(pushed|unchanged|removed): (config\/[A-Za-z0-9._-]+)\b/);
      if (file) options.onProgress?.('sync', `${activeTarget}：${file[2]} ${file[1] === 'unchanged' ? '已一致' : file[1] === 'removed' ? '已移除' : '已推送'}`);
      if (/config-reread: sent/i.test(line)) options.onProgress?.('sync', `${activeTarget}：已发送重读通知`);
      if (/config[_-]reread:.*(?:failed|error)/i.test(line)) options.onProgress?.('sync', `${activeTarget}：重读通知失败`);
    };
    try {
      const result = await exec('bash', [script], {
        cwd: home, timeout: 120000, maxBuffer: FILE_LIMIT, onLine,
        env: { ...process.env, ...(items ? { FM_INHERITABLE_CONFIG: items.join(' ') } : {}), FM_HOME: home, FM_ROOT_OVERRIDE: dirname(dirname(script)), FM_CONFIG_OVERRIDE: join(home, 'config'), FM_STATE_OVERRIDE: join(home, 'state'), FM_DATA_OVERRIDE: join(home, 'data') },
      });
      output = result.stdout;
    } catch (error) {
      output = String(error.stdout || '');
      failed = true;
    }
    const targets = [];
    let target;
    for (const line of output.split('\n')) {
      const header = line.match(/^secondmate ([a-zA-Z0-9_.-]{1,80})(?:\s|:)/);
      if (header) {
        target = { id: header[1], dispatch: /:\s*skipped\b/.test(line) ? 'skipped' : 'unknown', reread: 'unknown', files: {} };
        targets.push(target);
      }
      if (!target) continue;
      const item = line.match(/^\s+crew-dispatch\.json: (pushed|unchanged|skipped|error)\b/) || line.match(/^\s+(pushed|unchanged|removed|skipped|error): config\/crew-dispatch\.json\b/);
      if (item) target.dispatch = item[1];
      const file = line.match(/^\s+(pushed|unchanged|removed|skipped|error): (config\/[A-Za-z0-9._-]+|data\/captain-shared\.md)\b/) || line.match(/^\s+([A-Za-z0-9._-]+): (pushed|unchanged|removed|skipped|error)\b/);
      if (file) {
        if (['pushed','unchanged','removed','skipped','error'].includes(file[1])) target.files[file[2]] = file[1];
        else target.files[`config/${file[1]}`] = file[2];
      }
      if (/config-reread: sent/i.test(line)) target.reread = 'sent';
      if (/config[_-]reread:.*(?:failed|error)/i.test(line)) target.reread = 'failed';
    }
    const required = items || ['crew-dispatch.json'];
    for (const target of targets) {
      const statuses = required.map(name => target.files[`config/${name}`] || (name === 'crew-dispatch.json' ? target.dispatch : 'unknown'));
      target.transfer = statuses.every(status => ['pushed','removed','unchanged'].includes(status)) ? statuses.some(status => status !== 'unchanged') ? 'pushed' : 'unchanged' : 'unknown';
    }
    const complete = targets.length > 0 && targets.every(item => ['pushed', 'unchanged'].includes(item.transfer) && item.reread !== 'failed' && (item.transfer !== 'pushed' || item.reread === 'sent'));
    if (failed) return { status: targets.some(item => ['pushed', 'unchanged'].includes(item.transfer) && item.reread !== 'failed') ? 'partial' : 'failed', targets, message: '部分同步未完成或回执未知；已成功的目标保留，可以重试同步。' };
    if (output.includes('config-push: no live secondmate homes found')) return { status: 'no_targets', targets, message: '没有发现可同步的活跃二副；不代表远端配置已更新。' };
    if (!complete) return { status: 'partial', targets, message: '部分二副被跳过或缺少配置回执；请重试同步并检查二副登记。' };
    return { status: 'completed', targets, message: '继承脚本已完成配置同步；重读通知不等于运行会话已加载。' };
  });
  configPushes.set(home, pending);
  try { return await pending; }
  finally { if (configPushes.get(home) === pending) configPushes.delete(home); }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > FILE_LIMIT) throw httpError(413, 'rejected', '请求过大');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); }
  catch { throw httpError(400, 'rejected', '请求不是 JSON'); }
}

function strictKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw httpError(400, 'rejected', '请求含有无效参数。');
  }
}

function checkConfigRequest(operation, body) {
  if (operation === 'dispatch-read') return strictKeys(body, []);
  const quota = operation.startsWith('quota-');
  if (quota && operation !== 'quota-save') return strictKeys(body, ['aliases']);
  if (operation === 'quota-save') {
    strictKeys(body, ['baseRevision', 'source', 'aliases']);
    if (body.baseRevision === 'absent') return;
  } else if (operation === 'dispatch-push') {
    strictKeys(body, ['baseRevision']);
  } else {
    const commit = operation === 'dispatch-commit';
    const keys = body?.restore !== undefined ? ['restore'] : ['rules', 'default'];
    strictKeys(body, ['baseRevision', ...(commit ? ['nextRevision'] : []), ...keys]);
    if (commit && (typeof body.nextRevision !== 'string' || !/^[a-f0-9]{64}$/.test(body.nextRevision))) {
      throw httpError(409, 'conflict', '请先预览，再确认保存。');
    }
    if (keys.includes('rules')) {
      const checkProfiles = rows => {
        if (!Array.isArray(rows)) throw httpError(400, 'rejected', '候选必须是数组。');
        for (const profile of rows) strictKeys(profile, ['harness', 'model', 'effort']);
      };
      if (!Array.isArray(body.rules)) throw httpError(400, 'rejected', '派工规则必须是数组。');
      for (const rule of body.rules) {
        strictKeys(rule, ['when', 'use']);
        checkProfiles(rule.use);
      }
      if (body.default != null) checkProfiles(body.default);
    } else if (typeof body.restore !== 'string') {
      throw httpError(400, 'rejected', '备份名称无效。');
    }
  }
  if (typeof body.baseRevision !== 'string' || !/^[a-f0-9]{64}$/.test(body.baseRevision)) {
    throw httpError(400, 'rejected', '请求缺少有效的配置版本。');
  }
}

export async function runConfigOperation(operation, path, body, options = {}) {
  if (!configOperations.has(operation)) throw httpError(400, 'rejected', '配置操作无效。');
  checkConfigRequest(operation, body);
  const home = await realpath(path);
  const entry = { path: home };
  if (operation.startsWith('quota-')) {
    const sources = trustedQuotaSources(body.aliases);
    if (operation === 'quota-status') return readQuotaSource(home, sources);
    if (operation === 'quota-read') return readQuota(home, sources);
    return saveQuotaSource(home, sources, body, withConfigLock);
  }
  try {
    await lstat(join(home, '.fm-secondmate-home'));
    throw httpError(409, 'inherited', '二副 Home 不能作为派工配置来源。');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const local = { ...options, homes: [entry] };
  if (operation === 'dispatch-preview') return previewOf(await planWrite(local, { ...body, home: 0 }));
  if (operation === 'dispatch-commit') return commitWrite(local, { ...body, home: 0 });
  if (operation === 'dispatch-push') return pushSavedDispatch(local, entry, body);
  const target = await resolveDispatchFile(entry);
  return dispatchView(await boundedFile(target.file, FILE_LIMIT), backupDirs(options), home);
}

export function configError(error) {
  if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) return { status: 403, error: 'permissions', message: '所选 Home 的配置权限不足。' };
  if (error.code === 'ENOENT') return { status: 404, error: 'unavailable', message: '所选 Home 缺少配置文件或所需入口。' };
  const status = error.status || 500;
  return { status, error: error.error || 'failed', message: status >= 500 && !error.error ? '配置操作未完成。' : (error.message || '配置操作未完成。') };
}

function tokenOk(header, token) {
  const given = Buffer.from(String(header || ''));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

// MagPie lets the previous host drain its calls during a plugin reload, so its
// listener can hold the port for a while. Retry for about thirty seconds with
// jitter, then name the port holder. The plugin never stops, signals or adopts
// the process it finds; it only reports it.
export const BIND_RETRY = Object.freeze({ budgetMs: 30_000, budgetJitterMs: 3_000, delayMs: 150, maxDelayMs: 1_000, delayJitter: 0.2 });

export function bindRetryPlan(overrides = {}) {
  const source = overrides && typeof overrides === 'object' ? overrides : {};
  const random = typeof source.random === 'function' ? source.random : Math.random;
  const settings = Object.fromEntries(Object.entries(source).filter(([name]) => name !== 'random'));
  const pick = (name, fallback) => {
    const value = Number(settings[name] ?? fallback);
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid bind retry ${name}`);
    return value;
  };
  const budgetMs = pick('budgetMs', BIND_RETRY.budgetMs) + (random() * 2 - 1) * pick('budgetJitterMs', BIND_RETRY.budgetJitterMs);
  const maxDelayMs = pick('maxDelayMs', BIND_RETRY.maxDelayMs);
  const delayJitter = pick('delayJitter', BIND_RETRY.delayJitter);
  let delayMs = Math.min(pick('delayMs', BIND_RETRY.delayMs), maxDelayMs);
  return {
    budgetMs: Math.max(0, budgetMs),
    nextDelay(remainingMs = Number.POSITIVE_INFINITY) {
      const wait = Math.max(1, Math.round(delayMs * (1 + (random() * 2 - 1) * delayJitter)));
      delayMs = Math.min(delayMs * 2, maxDelayMs);
      return Math.min(wait, Math.max(1, Math.round(remainingMs)));
    },
  };
}

// The plugin reports a port holder; it never signals or adopts one. lsof is the
// macOS default, while WSL and most Linux images ship ss instead, so both are
// tried and an absent tool is simply an unidentified holder.
async function lsofPortHolder(port) {
  try {
    const { stdout } = await exec('lsof', ['-nP', '-Fpc', `-iTCP:${port}`, '-sTCP:LISTEN'], { timeout: 1500 });
    return parseLsofHolder(stdout);
  } catch { return null; }
}

export function parseLsofHolder(stdout) {
  let pid = 0, command = '';
  for (const line of String(stdout).split('\n')) {
    if (!pid && /^p\d+$/.test(line)) pid = Number(line.slice(1));
    else if (pid && !command && /^c.+$/.test(line)) command = line.slice(1).trim();
  }
  return pid ? { pid, command } : null;
}

async function ssPortHolder(port) {
  try {
    // No -H: older iproute2 releases lack it, and the parser ignores the header line.
    const { stdout } = await exec('ss', ['-ltnp', `sport = :${port}`], { timeout: 1500 });
    return parseSsHolder(stdout);
  } catch { return null; }
}

export function parseSsHolder(stdout) {
  // ss -p prints users:(("cmd",pid=1234,fd=5)) on the listener line.
  const match = String(stdout).match(/users:\(\("([^"]+)",pid=(\d+)/);
  return match ? { pid: Number(match[2]), command: match[1] } : null;
}

async function defaultPortHolder(port) {
  const lsof = await lsofPortHolder(port);
  if (lsof) return { ...lsof, source: 'lsof' };
  const ss = await ssPortHolder(port);
  return ss ? { ...ss, source: 'ss' } : null;
}

export async function describePortHolder(port, options = {}) {
  const lookup = typeof options.portHolderLookup === 'function' ? options.portHolderLookup : defaultPortHolder;
  let holder = null;
  try { holder = await lookup(port); } catch { holder = null; }
  if (!holder?.pid) return { port, holder: null, owner: '' };
  const source = holder.source ? ` per ${holder.source}` : '';
  return { port, holder, owner: `pid ${holder.pid}${holder.command ? ` (${holder.command})` : ''}${source}` };
}

export async function startDashboard(options = {}) {
  const port = Number(options.port ?? 35871);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local service port');
  const seatCatalog = seatCatalogReader(options.catalogTargets);
  const writeToken = randomBytes(32).toString('hex');
  const server = createServer(async (req, res) => {
    const host = String(req.headers.host ?? '');
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) { res.writeHead(403); res.end('Forbidden host'); return; }
    const origin = req.headers.origin;
    if (origin && origin !== 'null' && origin !== `http://${host}`) { res.writeHead(403); res.end('Forbidden origin'); return; }
    const cors = origin === 'null' ? { 'Access-Control-Allow-Origin': 'null', Vary: 'Origin' } : {};
    const headers = {
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...cors,
      'Content-Security-Policy': `default-src 'none'; script-src 'self' http://127.0.0.1:${port}; style-src 'self' http://127.0.0.1:${port}; connect-src 'self' http://127.0.0.1:${port}; img-src 'self' data:`,
    };
    const url = new URL(req.url, `http://${host}`);
    const path = url.pathname;
    const pinSync = path === '/api/secondmate/sync';
    const dispatchSync = path === '/api/dispatch/sync' || pinSync;
    const dispatchRoute = dispatchSync || path === '/api/dispatch/preview' || path === '/api/dispatch/commit';
    const quotaOperation = new Map([
      ['/api/quota/status', 'quota-status'], ['/api/quota/read', 'quota-read'], ['/api/quota/save', 'quota-save'],
    ]).get(path);
    const secondmateRoute = path === '/api/secondmate/preview' || path === '/api/secondmate/commit';
    const settingsRoute = path === '/api/settings/preview' || path === '/api/settings/commit';
    const writeRoute = dispatchRoute || secondmateRoute || settingsRoute || quotaOperation;
    const readRoute = path === '/api/models' || path === '/api/snapshot';
    let streaming = false, localSaved = false;
    const frame = value => { if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(value)}\n`); };
    const report = (stage, message, facts = {}) => {
      localSaved ||= facts.localSaved === true;
      if (streaming) frame({ type: 'progress', stage, message, localSaved, at: Date.now() });
    };
    const reply = result => {
      if (streaming) { frame({ type: 'result', result, localSaved }); res.end(); }
      else { res.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(result)); }
    };
    try {
      if (req.method === 'OPTIONS' && (writeRoute || readRoute)) {
        if (!origin) { res.writeHead(204, headers); res.end(); return; }
        res.writeHead(204, {
          ...headers,
          'Access-Control-Allow-Methods': writeRoute ? 'POST, OPTIONS' : 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'content-type, x-fm-write-token',
          'Access-Control-Max-Age': '600',
        });
        res.end();
        return;
      }
      if (writeRoute) {
        if (req.method !== 'POST') { res.writeHead(405, { ...headers, Allow: 'POST, OPTIONS' }); res.end('Method not allowed'); return; }
        const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (type !== 'application/json') throw httpError(415, 'rejected', '写入请求必须是 application/json');
        if (!tokenOk(req.headers[WRITE_HEADER], writeToken)) throw httpError(403, 'session_expired', '插件服务已重载或页面凭据已失效。本次请求未执行；请重新连接后再试。');
        const body = await readBody(req);
        if (String(req.headers.accept || '').includes('application/x-ndjson')) {
          streaming = true;
          res.writeHead(200, { ...headers, 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
        }
        const requestOptions = { ...options, onProgress: report };
        report(path.endsWith('/sync') ? 'prepare' : 'validate', path.endsWith('/sync') ? '正在核对同步配置' : '正在校验配置与当前版本');
        if (quotaOperation) {
          strictKeys(body, quotaOperation === 'quota-save' ? ['home', 'source', 'baseRevision'] : ['home']);
          const entry = configuredHome(options, body.home);
          const { home, ...request } = body;
          const args = { ...request, aliases: entry.quotaSshAliases };
          try {
            reply(isRemoteEntry(entry) && entry.remote.dispatchCli
              ? await invokeConfigCli(entry, options, quotaOperation, args)
              : await runConfigOperation(quotaOperation, selectedHome(options, home).path, args, requestOptions));
          } catch (error) {
            const failure = configError(error);
            throw httpError(failure.status, failure.error, failure.message);
          }
          return;
        }
        if (settingsRoute) {
          const [backupDir, legacyBackupDir] = backupDirs(options);
          const settingOptions = { ...requestOptions, backupDir, legacyBackupDir };
          let result;
          if (path.endsWith('/preview')) {
            const plan = await planSettings(settingOptions, body);
            const diff = previewDiff(plan.current.text, plan.text);
            if (plan.current.present !== plan.present) {
              const presence = plan.present ? '+[创建显式配置文件]' : '-[移除显式配置文件，恢复默认行为]';
              diff.diff = `${presence}\n${diff.diff}`;
              diff.fullDiff = `${presence}\n${diff.fullDiff}`;
            }
            result = { ok: true, ...diff, file: `config/${plan.def.key}`, nextRevision: plan.revision, unchanged: plan.revision === plan.current.revision, action: plan.present ? '保存显式配置' : '移除显式配置，恢复默认行为' };
          } else {
            result = await commitSettings(settingOptions, body);
            if (result.inherited && !result.unchanged) result.sync = await pushDispatch(requestOptions, selectedHome(options, body.home).path, [body.key]);
          }
          reply(result);
          return;
        }
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          const configured = configuredHome(options, body.home);
          if (dispatchRoute && !pinSync && isRemoteEntry(configured) && configured.remote.dispatchCli) {
            const { home, ...args } = body;
            const operation = dispatchSync ? 'dispatch-push' : path.endsWith('/preview') ? 'dispatch-preview' : 'dispatch-commit';
            checkConfigRequest(operation, args);
            report(dispatchSync ? 'sync' : 'remote', dispatchSync ? '正在等待 远端大副 推送回执' : '正在通过 远端大副 CLI 校验或保存派工配置');
            const result = await invokeConfigCli(configured, options, operation, args);
            if (operation === 'dispatch-commit') report('saved', '远端大副 派工配置已保存并读回核对', { localSaved: true });
            reply(result);
            return;
          }
          const entry = selectedHome(options, body.home);
          let id;
          try {
            id = (await boundedFile(join(entry.path, '.fm-secondmate-home'), 1024)).text.trim();
            if (!/^[a-zA-Z0-9_.-]+$/.test(id)) throw new Error('invalid role marker');
          }
          catch (error) { if (error.code !== 'ENOENT') throw httpError(503, 'role', '无法核实 Home 身份'); }
          if (id) {
            if (!dispatchSync) throw httpError(409, 'inherited', '二副页面只读大副管理的配置，请在大副页面编辑后同步。');
            if ('path' in body || 'file' in body || 'homePath' in body) throw httpError(400, 'rejected', '请求不能指定路径');
            const sync = await syncFromParent(entry, id, pinSync ? 'secondmate' : 'dispatch', requestOptions, report);
            reply({ ok: true, sync });
            return;
          }
        }
        if (dispatchSync) {
          if (!body || typeof body !== 'object' || Array.isArray(body) || 'path' in body || 'file' in body || 'homePath' in body) throw httpError(400, 'rejected', '请求不能指定写入路径');
          const entry = selectedHome(options, body.home);
          if (!pinSync) { reply(await pushSavedDispatch(requestOptions, entry, body)); return; }
          reply({ ok: true, sync: await pushSavedPin(requestOptions, entry, body.baseRevision) });
          return;
        }
        const result = secondmateRoute
          ? (path.endsWith('/preview') ? previewOf(await planSecondmate(requestOptions, body)) : await commitSecondmate(requestOptions, body))
          : (path.endsWith('/preview') ? previewOf(await planWrite(requestOptions, body)) : await commitWrite(requestOptions, body));
        reply(result);
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end('Method not allowed'); return; }
      if (readRoute && (origin === 'null' || req.headers[WRITE_HEADER] !== undefined) && !tokenOk(req.headers[WRITE_HEADER], writeToken)) {
        res.writeHead(403, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'session_expired' }));
        return;
      }
      if (path === '/api/models') {
        try {
          const harness = url.searchParams.get('harness') || '';
          const seat = url.searchParams.get('seat');
          const catalog = seat ? await seatCatalog(seat, harness) : await modelCatalog(harness);
          res.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
          res.end(req.method === 'HEAD' ? '' : JSON.stringify(catalog));
        } catch (error) {
          res.writeHead(error.status || 503, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: error.message }));
        }
        return;
      }
      if (path === '/api/snapshot') {
        res.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(req.method === 'HEAD' ? '' : JSON.stringify(await snapshot({ ...options, localOnly: url.searchParams.get('local') === '1' })));
        return;
      }
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/controls.js': ['controls.js', 'text/javascript'], '/settings.js': ['settings.js', 'text/javascript'], '/bridge.js': ['bridge.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/settings.css': ['settings.css', 'text/css'] };
      if (path.startsWith('/provider-icons/')) {
        const name = path.slice('/provider-icons/'.length);
        if (!/^[a-f0-9]{8,64}\.(png|webp|jpe?g|svg)$/i.test(name)) { res.writeHead(404, headers); res.end('Not found'); return; }
        const file = join(magpieConfig(), 'icons', name);
        const stat = await lstat(file).catch(() => null);
        if (!stat?.isFile() || stat.size > FILE_LIMIT) { res.writeHead(404, headers); res.end('Not found'); return; }
        const types = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml' };
        res.writeHead(200, { ...headers, 'Content-Type': types[name.split('.').pop().toLowerCase()] });
        res.end(req.method === 'HEAD' ? '' : await readFile(file)); return;
      }
      const iconName = path.startsWith('/icons/') ? path.slice('/icons/'.length) : '';
      if (iconName) {
        if (!/^[A-Za-z0-9._-]+\.(svg|webp|png)$/.test(iconName)) { res.writeHead(404, headers); res.end('Not found'); return; }
        let iconBody;
        try { iconBody = await readFile(join(assets, 'icons', iconName)); }
        catch { res.writeHead(404, headers); res.end('Not found'); return; }
        res.writeHead(200, { ...headers, 'Content-Type': iconName.endsWith('.png') ? 'image/png' : iconName.endsWith('.webp') ? 'image/webp' : 'image/svg+xml' });
        res.end(req.method === 'HEAD' ? '' : iconBody);
        return;
      }
      const asset = files[path];
      if (!asset) { res.writeHead(404, headers); res.end('Not found'); return; }
      let body = await readFile(join(assets, asset[0]));
      if (path === '/app.js') {
        const modules = await Promise.all(['controls.js', 'models.js', 'actions.js', 'settings-scope.js', 'settings.js', 'recovery.js', 'quota.js'].map(name => readFile(join(assets, name), 'utf8')));
        body = Buffer.from([...modules, body.toString('utf8')].join('\n;\n'));
      }
      // The document is read by navigation, not by a cross-origin fetch. A write
      // token in that document must not be readable by another Origin: null page.
      const documentHeaders = path === '/' ? { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': headers['Content-Security-Policy'] } : headers;
      if (path === '/') body = Buffer.from(body.toString('utf8').replaceAll(TOKEN_PLACEHOLDER, writeToken).replaceAll('__FM_VERSION__', pluginVersion));
      res.writeHead(200, { ...documentHeaders, 'Content-Type': `${asset[1]}; charset=utf-8` });
      res.end(req.method === 'HEAD' ? '' : body);
    } catch (error) {
      const status = error.status || 500;
      const payload = { ok: false, error: error.error || 'failed', message: status === 500 ? '请求失败' : String(error.message || '请求失败') };
      if (writeRoute) {
        if (streaming) { frame({ type: 'error', status, ...payload, localSaved }); res.end(); return; }
        res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
        return;
      }
      res.writeHead(status, headers);
      res.end(status === 500 ? 'Read failed' : payload.message);
    }
  });
  const retry = bindRetryPlan(options.bindRetry && typeof options.bindRetry === 'object' ? options.bindRetry : {});
  const started = Date.now();
  const deadline = started + retry.budgetMs;
  // Options arrive from the host's JSON config, so only a function is a logger.
  const log = typeof options.log === 'function' ? options.log : (line => console.error(line));
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      await new Promise((ok, fail) => {
        const onError = error => { server.off('listening', onListening); fail(error); };
        const onListening = () => { server.off('error', onError); ok(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      break;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const report = await describePortHolder(port, options);
        const elapsedMs = Date.now() - started;
        const diagnostic = `First Mate dashboard could not bind 127.0.0.1:${port} after ${(elapsedMs / 1000).toFixed(1)}s and ${attempts} attempts (EADDRINUSE). `
          + (report.owner ? `Port holder: ${report.owner}.` : 'Port holder not identified: neither lsof nor ss named a listening process on that port, or neither tool is available.')
          + ' The plugin leaves that process untouched and stops startup; free the port or reload its owner.';
        log(diagnostic);
        throw Object.assign(error, { diagnostic, portHolder: report.holder, attempts, elapsedMs });
      }
      await new Promise(ok => setTimeout(ok, retry.nextDelay(remaining)));
    }
  }
  server.unref();
  return server;
}

if (import.meta.main) {
  const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const server = await startDashboard(config);
  server.ref();
  console.log('First Mate dashboard ready');
}
