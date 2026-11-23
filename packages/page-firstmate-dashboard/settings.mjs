import { lstat, readFile, realpath, mkdir, readdir, writeFile, rename, unlink } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { cachedValidation, validatorStamp } from './validation-cache.mjs';
import { tmpdir } from 'node:os';

import { definitions, groups } from './settings-catalog.mjs';
const registry = new Map(definitions.map(item => [item.key, item]));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status, error: 'settings' });
const queues = new Map();
const backupPattern = /^settings-backup-[0-9a-f-]+\.json$/;
const validators = {
  capacity: { file: 'fm-project-capacity-lib.sh', command: 'source "$1"; fm_project_capacity_lookup "$2" __dashboard_validation__' },
  exclusions: { file: 'fm-exclude-tools-lib.sh', command: 'source "$1"; fm_exclude_tools_names "$2" >/dev/null' },
  budget: { file: 'fm-startup-memory-budget-lib.sh', command: 'source "$1"; fm_startup_memory_budget_read "$2" >/dev/null' },
};

async function targetFor(entry, key) {
  if (!registry.has(key)) throw fail(400, '不支持的配置项');
  const home = await realpath(resolve(entry.path));
  const config = join(home, 'config');
  if (!(await lstat(config)).isDirectory() || await realpath(config) !== config) throw fail(403, '拒绝跟随配置目录链接');
  return { home, config, file: join(config, key) };
}

async function readCurrent(target, privateValue = false) {
  try {
    const stat = await lstat(target.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536) throw fail(403, '只读取 64KB 以内、没有链接的普通配置文件');
    if (privateValue) return { present: true };
    const text = await readFile(target.file, 'utf8');
    return { present: true, text, revision: digest(`present:${text}`), mode: stat.mode & 0o777, modified: stat.mtime.toISOString() };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { present: false, text: '', revision: digest('absent'), mode: 0o600 };
  }
}

function editReason(def, role) {
  if (def.readOnly) return def.readOnly;
  if (!['primary', 'secondmate'].includes(role?.kind)) return '无法核实 Home 身份，暂不编辑。';
  if (role.kind === 'secondmate' && def.inherited) return '由大副管理；本机显示的是继承副本，请在大副编辑后同步。';
  if (role.kind === 'secondmate' && def.rootOnly) return '容量声明由本机根 Home 管理；此页面不推断根 Home 或编辑本机二副副本。';
  return '';
}

export async function readSettings(entry, role, backupDir, legacyBackupDir) {
  const latest = new Map();
  for (const dir of [backupDir, legacyBackupDir].filter(Boolean)) {
    let backups;
    try { backups = (await readdir(dir)).filter(name => backupPattern.test(name)); } catch { continue; }
    for (const id of backups) {
      try {
        const meta = JSON.parse(await readFile(join(dir, id), 'utf8'));
        const key = JSON.stringify([meta.home, meta.key]);
        if (!latest.has(key) || meta.created > latest.get(key).created) latest.set(key, { id, created: meta.created });
      } catch { /* unrelated or unreadable backup */ }
    }
  }
  const items = [];
  for (const def of definitions) {
    const reason = editReason(def, role);
    const group = groups.find(group => group.key === def.group);
    const item = { ...def, groupName: group.name, groupHint: group.hint, source: `config/${def.key}`, editable: !reason, reason, inheritance: def.inherited ? '大副 → 二副' : def.rootOnly ? '本机根 Home，供同机各 Home 使用' : '仅本 Home，不继承' };
    if (def.rootOnly && role?.kind === 'secondmate') {
      item.unresolved = true;
      item.fallback = '尚未读取本机根 Home 的声明，有效容量未知。';
    }
    try {
      const target = await targetFor(entry, def.key);
      const current = await readCurrent(target, def.private);
      Object.assign(item, current);
      if (item.unresolved) item.text = '本页不将二副 Home 中的副本当作本机根 Home 的有效声明。';
      if (def.flag) item.text = current.present ? def.presentLabel || '已启用' : '';
      if (!def.private) {
        const sensitive = /(?:token|secret|password|credential|authorization|api[_-]?key)\s*[:=]/i;
        if (sensitive.test(item.text)) { item.text = '[敏感内容已隐藏]'; item.editable = false; item.reason = '文件含敏感字段，此页面不展示或编辑。'; }
      }
      item.latestBackup = latest.get(JSON.stringify([target.home, def.key]));
    } catch { Object.assign(item, { editable: false, reason: '配置不可安全读取，未跟随链接或读取内容。', error: true }); }
    items.push(item);
  }
  return items;
}

async function validate(def, text, home, options) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 65536 || /[\x00-\x08\x0b-\x1f\x7f]/.test(text)) throw fail(422, '配置文本格式不合法或超过 64KB');
  if (/(?:token|secret|password|credential|authorization|api[_-]?key)\s*[:=]/i.test(text)) throw fail(422, '配置不能包含凭据字段');
  const value = text.trim();
  if (def.choices && value && !def.choices.includes(value)) throw fail(422, '请选择受支持的配置值');
  if (def.lineFormat === 'envNames') {
    for (const line of text.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'))) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(line)) throw fail(422, '环境白名单每行只能填写一个变量名，不能包含值、通配符或命令。');
    }
  }
  if (def.parameters) {
    const seen = new Set();
    for (const line of text.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'))) {
      const [key, number, ...extra] = line.split('=');
      if (!def.parameters.some(p => p.key === key) || !/^[1-9][0-9]*$/.test(number || '') || extra.length || seen.has(key)) throw fail(422, '参数必须使用所列名称及正整数，每个参数只能出现一次。');
      seen.add(key);
    }
  }
  if (def.key === 'supervision-host' && value && !/^(claude|default)(?: [A-Za-z0-9_./@:+-]+)?$/.test(value)) throw fail(422, '监督引擎只支持 claude 或 default，可跟一个模型名称');
  if (!def.native) return;
  const { file, command } = validators[def.native];
  const script = join(options.bootstrap ? dirname(options.bootstrap) : join(home, 'bin'), file);
  return cachedValidation('settings', [home, def.native, text, await validatorStamp(script)], async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fm-settings-check-'));
  try {
    await writeFile(join(dir, def.key), text, { mode: 0o600 });
    await new Promise((ok, reject) => execFile('/bin/bash', ['-c', command, 'settings', script, dir], { timeout: 5000, maxBuffer: 65536 }, error => error ? reject(fail(422, 'Firstmate 原生配置校验失败，未保存；请检查格式或原生校验器是否可用。')) : ok()));
  } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

async function roleFor(home) {
  try {
    const st = await lstat(join(home, '.fm-secondmate-home'));
    if (!st.isFile() || st.isSymbolicLink()) throw fail(403, '无法核实 Home 身份');
    const id = (await readFile(join(home, '.fm-secondmate-home'), 'utf8')).trim();
    return { kind: /^[\w.-]+$/.test(id) ? 'secondmate' : 'unknown' };
  } catch (error) { if (error.code === 'ENOENT') return { kind: 'primary' }; throw error; }
}

export async function planSettings(options, body) {
  if (!body || Array.isArray(body) || Object.keys(body).some(k => !['home', 'key', 'baseRevision', 'text', 'present', 'restore', 'nextRevision'].includes(k))) throw fail(400, '配置请求格式不合法');
  if (!Number.isInteger(body.home) || body.home < 0 || !options.homes?.[body.home]) throw fail(400, 'Home 选择不合法');
  const entry = options.homes[body.home];
  if (entry.remote) throw Object.assign(fail(403, '这个 Home 是远端只读配置。本插件只读取它，不能在这里修改。'), { error: 'read_only_remote' });
  const target = await targetFor(entry, body.key);
  const def = registry.get(body.key);
  const reason = editReason(def, await roleFor(target.home));
  if (reason) throw fail(403, reason);
  const current = await readCurrent(target);
  if (current.revision !== body.baseRevision) throw fail(409, '配置在读取之后已变化，请刷新后重新预览。');
  let text = body.text, present = body.present;
  if (body.restore !== undefined) {
    if (!backupPattern.test(body.restore)) throw fail(400, '备份名称不合法');
    let file = join(options.backupDir, body.restore);
    const st = await lstat(file).catch(error => {
      if (error.code !== 'ENOENT' || !options.legacyBackupDir) throw error;
      file = join(options.legacyBackupDir, body.restore);
      return lstat(file);
    });
    if (!st.isFile() || st.isSymbolicLink() || st.size > 150000) throw fail(403, '备份不可安全读取');
    const backup = JSON.parse(await readFile(file, 'utf8'));
    if (backup.home !== target.home || backup.key !== body.key || digest(backup.text) !== backup.sha256 || typeof backup.present !== 'boolean') throw fail(403, '备份不属于此 Home 和配置项，或校验失败');
    text = backup.text; present = backup.present;
  }
  if (typeof present !== 'boolean' || typeof text !== 'string') throw fail(400, '必须明确选择显式设置或恢复默认');
  if (def.flag && body.restore === undefined) text = present ? (current.present ? current.text : '') : '';
  if (present && !def.flag) await validate(def, text, target.home, options);
  if (!present) text = '';
  const revision = digest(present ? `present:${text}` : 'absent');
  return { target, current, text, present, revision, def };
}

export async function commitSettings(options, body) {
  const entry = options.homes?.[body?.home];
  const lock = `${entry?.path}:${body?.key}`;
  const previous = queues.get(lock) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    const plan = await planSettings(options, body);
    if (body.nextRevision !== plan.revision) throw fail(409, '保存内容与预览不一致，请重新预览。');
    if (plan.current.revision === plan.revision) { options.onProgress?.('saved', '本机配置已一致', { localSaved: true }); return { ok: true, unchanged: true }; }
    options.onProgress?.('backup', '校验通过，正在备份原配置');
    const backupDir = await mkdir(options.backupDir, { recursive: true, mode: 0o700 }).then(() => realpath(options.backupDir));
    if (backupDir === plan.target.home || backupDir.startsWith(`${plan.target.home}/`)) throw fail(403, '备份目录必须位于 Home 之外');
    const id = `settings-backup-${randomUUID()}.json`;
    await writeFile(join(backupDir, id), JSON.stringify({ home: plan.target.home, key: plan.def.key, created: new Date().toISOString(), present: plan.current.present, text: plan.current.text, sha256: digest(plan.current.text) }), { mode: 0o600, flag: 'wx' });
    const temp = `${plan.target.file}.tmp-${randomUUID()}`;
    try {
      options.onProgress?.('write', '正在保存本机设置');
      if (plan.present) await writeFile(temp, plan.text, { mode: plan.current.mode, flag: 'wx' });
      const fresh = await readCurrent(await targetFor(entry, plan.def.key));
      if (fresh.revision !== plan.current.revision) throw fail(409, '配置已被其他操作修改，未覆盖。');
      if (plan.present) await rename(temp, plan.target.file);
      else if (fresh.present) await unlink(plan.target.file);
      options.onProgress?.('verify', '正在读回核对本机设置');
      const written = await readCurrent(plan.target);
      if (written.revision !== plan.revision) throw fail(500, '保存后复核未通过，请检查原配置与备份。');
    } finally { await unlink(temp).catch(() => {}); }
    options.onProgress?.('saved', '本机设置已保存并核对', { localSaved: true });
    return { ok: true, unchanged: false, backup: id, revision: plan.revision, inherited: Boolean(plan.def.inherited) };
  });
  queues.set(lock, pending);
  try { return await pending; } finally { if (queues.get(lock) === pending) queues.delete(lock); }
}
