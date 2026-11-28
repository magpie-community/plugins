import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, lstat, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const aliasPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const localProviders = new Set(['claude', 'codex', 'cursor', 'copilot', 'grok', 'kimi', 'zai', 'agy', 'alibaba', 'opencode-go', 'commandcode', 'minimax', 'mimo', 'openrouter', 'elevenlabs', 'devin', 'muse', 'higgsfield']);
const sshProviders = ['codex', 'agy'];
const quotaStates = new Set(['fresh', 'stale', 'unavailable', 'auth_required', 'rate_limited', 'error']);
const bucketKinds = new Set(['session', 'weekly', 'monthly', 'model', 'credits', 'unknown']);
const issue = (status, error, message) => Object.assign(new Error(message), { status, error });

export function trustedQuotaSources(aliases) {
  if (aliases === undefined) return ['local'];
  if (!Array.isArray(aliases) || aliases.length > 12 || aliases.some(alias => typeof alias !== 'string' || !aliasPattern.test(alias))) {
    throw issue(503, 'quota_config', '插件中配置的额度 SSH 别名无效。');
  }
  return ['local', ...new Set(aliases.map(alias => `ssh:${alias}`))];
}

async function sourceFile(home) {
  const root = await realpath(home);
  const dir = join(root, 'config');
  const dirStat = await lstat(dir);
  if (!dirStat.isDirectory() || await realpath(dir) !== dir) throw issue(403, 'forbidden', '额度来源的 config 目录必须是普通目录。');
  return join(dir, 'quota-source');
}

async function sourceVersion(file) {
  let stat;
  try { stat = await lstat(file); }
  catch (error) {
    if (error.code === 'ENOENT') return { absent: true, revision: 'absent', mode: 0o600 };
    throw error;
  }
  if (!stat.isFile() || stat.size > 1024) throw issue(403, 'forbidden', '额度来源必须是普通的小型配置文件。');
  const bytes = await readFile(file);
  if (bytes.length > 1024) throw issue(403, 'forbidden', '额度来源文件超出大小限制。');
  const mode = stat.mode & 0o7777;
  return { bytes, mode, revision: createHash('sha256').update(String(mode)).update(':').update(bytes).digest('hex') };
}

async function quotaCli(home, operation) {
  const { stdout } = await exec(join(home, 'bin', 'fm-quota-source.sh'), [operation, '--json'], {
    timeout: operation === 'status' ? 6000 : 27000, maxBuffer: 1024 * 1024,
    env: { ...process.env, FM_HOME: home, FM_CONFIG_OVERRIDE: join(home, 'config') },
  });
  return JSON.parse(stdout);
}

export async function readQuotaSource(home, sources) {
  const file = await sourceFile(home);
  const current = await sourceVersion(file);
  let result;
  try { result = await quotaCli(home, 'status'); }
  catch (error) {
    if (error.code === 1) {
      return { status: 'unavailable', source: null, revision: current.revision, sources, message: '额度来源配置无效，请重新选择并保存。' };
    }
    return { status: 'error', source: null, revision: null, sources, message: '无法运行 Firstmate 额度读取入口。' };
  }
  if ((await sourceVersion(file)).revision !== current.revision) throw issue(409, 'conflict', '额度来源已变化，请刷新。');
  if (result?.status !== 'configured' || !sources.includes(result.source)) {
    return { status: 'unavailable', source: null, revision: current.revision, sources, message: '已配置的额度来源不在此 Home 的受信任选项中，请重新选择。' };
  }
  return { status: 'configured', source: result.source, revision: current.revision, sources };
}

const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const percent = value => typeof value === 'number' && value >= 0 && value <= 100 ? value : null;

function quotaBuckets(row, fresh) {
  const identifiers = [row.accountKey, ...(Array.isArray(row.accountKeys) ? row.accountKeys : []), row.account?.email, row.account?.accountId, row.account?.organization]
    .filter(value => typeof value === 'string' && value !== 'default' && value.length > 0);
  return (Array.isArray(row.windows) ? row.windows : []).slice(0, 80).map(window => {
    const kind = bucketKinds.has(window?.kind) ? window.kind : 'unknown';
    const label = typeof window?.label === 'string' && /^[\p{L}\p{N} ._+:/()\-]{1,96}$/u.test(window.label) &&
      !identifiers.some(value => window.label.includes(value)) ? window.label : null;
    const untrusted = Array.isArray(row.state?.untrustedWindowIds) && row.state.untrustedWindowIds.includes(window?.id);
    return { kind, label, remaining: fresh && !untrusted ? percent(window?.percentRemaining) : null, resetsAt: fresh && !untrusted ? timestamp(window?.resetsAt) : null };
  });
}

function providerReading(row, generatedAt) {
  const state = row.state || {};
  let status = row.notSetUp ? 'unavailable' : quotaStates.has(state.status) ? state.status : 'unknown';
  if (state.stale === true || (status === 'unavailable' && /(?:^|[_-])stale(?:[_-]|$)/.test(state.reason || ''))) status = 'stale';
  const readAt = timestamp(state.refreshedAt) || (status === 'fresh' ? generatedAt : null);
  const buckets = quotaBuckets(row, status === 'fresh' && readAt !== null);
  if (status === 'fresh' && !buckets.some(bucket => bucket.remaining !== null)) status = 'unknown';
  return { provider: row.provider, status, readAt, buckets };
}

export async function readQuota(home, sources) {
  const config = await readQuotaSource(home, sources);
  if (config.status !== 'configured') return { ...config, generatedAt: null, providers: [] };
  const { source, revision } = config;
  try {
    const data = await quotaCli(home, 'read');
    if (![5, 6].includes(data?.schemaVersion) || data.quotaSource !== source || !Array.isArray(data.providers)) throw new Error('invalid quota report');
    const generatedAt = timestamp(data.generatedAt);
    if (!generatedAt) throw new Error('invalid quota timestamp');
    if ((await sourceVersion(await sourceFile(home))).revision !== revision) throw issue(409, 'conflict', '读取期间额度来源已变化，请刷新。');
    const remote = source !== 'local';
    const providers = data.providers.filter(row => remote ? sshProviders.includes(row?.provider) : localProviders.has(row?.provider))
      .filter(row => remote || row.notSetUp !== true).slice(0, 80).map(row => providerReading(row, generatedAt));
    if (remote) for (const provider of sshProviders) {
      if (!providers.some(row => row.provider === provider)) providers.push({ provider, status: 'unknown', readAt: null, buckets: [] });
    }
    return { ...config, status: providers.length ? 'read' : 'unknown', generatedAt, providers };
  } catch (error) {
    if (error.status === 409) throw error;
    return { ...config, status: 'error', message: '所选来源的额度读取失败，当前读数未知。', generatedAt: null, providers: [] };
  }
}

export async function saveQuotaSource(home, sources, body, withLock) {
  if (!sources.includes(body.source)) throw issue(400, 'rejected', '请选择此 Home 已配置的额度来源。');
  const file = await sourceFile(home);
  return withLock(file, async () => {
    const current = await sourceVersion(file);
    if (current.revision !== body.baseRevision) throw issue(409, 'conflict', '额度来源已变化，请刷新后保存。');
    const content = Buffer.from(`${body.source}\n`);
    if (!(current.absent && body.source === 'local') && !current.bytes?.equals(content)) {
      const tmp = `${file}.tmp-${randomUUID()}`;
      try {
        await writeFile(tmp, content, { flag: 'wx', mode: 0o600 });
        await chmod(tmp, current.mode);
        if ((await sourceVersion(file)).revision !== current.revision) throw issue(409, 'conflict', '额度来源已变化，请刷新后保存。');
        if (current.absent) await link(tmp, file);
        else await rename(tmp, file);
      } catch (error) {
        if (error.code === 'EEXIST') throw issue(409, 'conflict', '额度来源已变化，请刷新后保存。');
        throw error;
      } finally { await unlink(tmp).catch(() => {}); }
      const written = await sourceVersion(file);
      if (!written.bytes?.equals(content) || written.mode !== current.mode) throw issue(503, 'verify', '额度来源写入后的核对未完成，请刷新。');
    }
    return { ...await readQuotaSource(home, sources), ok: true };
  });
}
