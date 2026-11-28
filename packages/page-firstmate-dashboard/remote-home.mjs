// A remote primary Home that this plugin may only read.
//
// The Home is reached through an existing SSH alias. The plugin shows it as a
// configuration seat, and every
// value it shows comes from a single read-only remote command that prints a
// small, fixed set of nonsecret fields: whether the directory looks like a
// Home, whether it is a secondmate home, config/secondmate-harness, and the
// launch-record meta files with only the fields this page already shows for a
// local Home.
//
// There is deliberately no write path here: this module never uploads a file,
// never runs anything that mutates the remote Home, and never hands the remote
// data to the local commit/sync routes. Those routes refuse a remote entry
// before touching a path (see selectedHome in server.mjs).
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

const FILE_LIMIT = 1024 * 1024;
const META_LIMIT_IN_FILE = 300;
const META_FIELDS = new Set(['kind', 'home', 'remote_host', 'remote_backend', 'backend', 'harness', 'model', 'effort', 'project', 'projects']);

// One fixed script. The remote login shell may reject an unmatched glob, so the script is sent
// base64-encoded and piped to `sh -s`: the bytes below arrive unchanged, and
// the Home path is the only argument, already restricted to a plain absolute
// path. The script only prints bytes it read: no temporary file, no write, no
// change on the remote machine.
const READ_SCRIPT = `
FM=$1
printf 'FM-HOME\\t%s\\n' "$FM"
if [ -d "$FM/config" ] && [ -d "$FM/state" ]; then printf 'DIRS\\tok\\n'; else printf 'DIRS\\tmissing\\n'; fi
if [ -f "$FM/.fm-secondmate-home" ]; then printf 'ROLE\\tsecondmate\\n'; else printf 'ROLE\\tprimary\\n'; fi
if [ -f "$FM/config/secondmate-harness" ] && [ ! -L "$FM/config/secondmate-harness" ]; then
  printf 'PIN\\t'; base64 < "$FM/config/secondmate-harness" | tr -d '\\n'; printf '\\n'
else
  printf 'PIN-ABSENT\\t\\n'
fi
seen=0
for m in "$FM"/state/*.meta; do
  [ -f "$m" ] || continue
  [ -L "$m" ] && continue
  seen=$((seen + 1))
  [ "$seen" -gt ${META_LIMIT_IN_FILE} ] && break
  id=\${m##*/}
  id=\${id%.meta}
  stamp=$(stat -c %Y "$m" 2>/dev/null || echo '')
  printf 'META\\t%s\\t%s' "$id" "$stamp"
  while IFS= read -r line; do
    case "$line" in
      kind=*|home=*|remote_host=*|remote_backend=*|backend=*|harness=*|model=*|effort=*|project=*|projects=*) printf '\\t%s' "$line" ;;
    esac
  done < "$m"
  printf '\\n'
done
printf 'END\\t%s\\n' "$seen"
`;

const sshAlias = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
const remotePath = value => typeof value === 'string' && /^\/[A-Za-z0-9._/-]+$/.test(value) && !value.split('/').includes('..');

export function remoteTarget(entry) {
  const remote = entry?.remote;
  if (!remote || typeof remote !== 'object') return null;
  if (!sshAlias(remote.ssh)) throw new Error('remote.ssh 必须是已存在的 SSH 别名（字母、数字、点、下划线、连字符）');
  if (!remotePath(remote.path)) throw new Error('remote.path 必须是绝对路径，且只含字母、数字、点、下划线、斜杠或连字符');
  return { ssh: remote.ssh, path: remote.path };
}

export function isRemoteEntry(entry) {
  return Boolean(entry && typeof entry === 'object' && entry.remote);
}

// Read-only SSH. StrictHostKeyChecking=yes refuses a changed or unknown host
// key instead of trusting it; ControlMaster=no keeps this read off any shared
// master connection, so nothing stays open behind us.
export function sshRead(alias, home, options = {}) {
  const command = options.sshCommand || 'ssh';
  const payload = Buffer.from(READ_SCRIPT, 'utf8').toString('base64');
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=8',
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none',
    alias,
    `echo ${payload} | base64 -d | sh -s -- ${home}`,
  ];
  return new Promise((ok, fail) => {
    execFile(command, args, { timeout: options.sshTimeout ?? 20000, maxBuffer: FILE_LIMIT }, (error, stdout, stderr) => {
      if (error) {
        // The last real error line, not the "WARNING:" preface ssh prints above it.
        const lines = String(stderr || '').trim().split('\n').map(line => line.trim()).filter(line => line && !/^WARNING:/.test(line));
        const detail = (lines.at(-1) || error.message || '').replace(/[.\u3002]\s*$/, '');
        fail(Object.assign(new Error(detail.slice(0, 300) || 'SSH 读取未完成'), { code: error.killed ? 'timeout' : 'ssh' }));
        return;
      }
      ok(String(stdout || ''));
    });
  });
}

export function splitPin(text) {
  const lines = String(text || '').split('\n');
  return text.trim() ? lines : [];
}

const tokens = value => String(value || '').trim().split(/\s+/).filter(Boolean);

// Mirrors the documented line shape of config/secondmate-harness: an optional
// "mate <id>: <harness> [model] [effort]" override or one default line
// "<harness> [model] [effort]", with '#' comments. Anything unexpected is
// reported instead of skipped, so a line the plugin cannot read stays visible.
export function parsePinText(text) {
  const result = { default: null, overrides: [], ignoredLines: 0, error: null };
  let sawBody = false;
  const lines = String(text || '').split('\n');
  lines.forEach((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const lineNo = index + 1;
    const mate = trimmed.match(/^mate\s+([A-Za-z0-9._-]+)\s*:\s*(.*)$/);
    if (mate) {
      const parts = tokens(mate[2]);
      if (!parts.length) { result.error = `第 ${lineNo} 行有 mate ${mate[1]}，但没有 harness`; return; }
      if (result.overrides.some(item => item.id === mate[1])) { result.error = `第 ${lineNo} 行的 mate ${mate[1]} 重复`; return; }
      result.overrides.push({ id: mate[1], line: lineNo, harness: parts[0], model: parts[1] || '', effort: parts[2] || '', extra: Math.max(0, parts.length - 3) });
      return;
    }
    if (/^mate\b/.test(trimmed)) { result.error = `第 ${lineNo} 行不像 \"mate <id>: <harness>\"，未跳过`; return; }
    if (!sawBody) {
      const parts = tokens(trimmed);
      sawBody = true;
      result.default = { line: lineNo, harness: parts[0], model: parts[1] || '', effort: parts[2] || '', extra: Math.max(0, parts.length - 3) };
      return;
    }
    result.ignoredLines += 1;
  });
  return result;
}

function parseMetaLine(line) {
  const fields = {};
  for (const part of line.split('\t').slice(2)) {
    const at = part.indexOf('=');
    if (at <= 0) continue;
    const key = part.slice(0, at);
    if (!META_FIELDS.has(key)) continue;
    fields[key] = part.slice(at + 1).replace(/^(['"])(.*)\1$/, '$2');
  }
  return fields;
}

export function readRemoteOutput(text, entry) {
  const rows = String(text || '').split('\n').filter(Boolean);
  const files = { pin: null, pinAbsent: false, dirs: '', role: '', metas: [], end: null };
  for (const row of rows) {
    const parts = row.split('\t');
    if (parts[0] === 'FM-HOME') files.home = parts[1] || '';
    else if (parts[0] === 'DIRS') files.dirs = parts[1] || '';
    else if (parts[0] === 'ROLE') files.role = parts[1] || '';
    else if (parts[0] === 'PIN') files.pin = Buffer.from(parts[1] || '', 'base64');
    else if (parts[0] === 'PIN-ABSENT') files.pinAbsent = true;
    else if (parts[0] === 'META') files.metas.push({ id: parts[1] || '', stamp: Number(parts[2]) || 0, raw: row });
    else if (parts[0] === 'END') files.end = Number(parts[1]);
  }
  return files;
}

export async function readRemoteHome(entry, options = {}) {
  const name = String(entry.name ?? 'First Mate');
  const machine = String(entry.machine ?? '远端');
  const hiddenSecondmates = Array.isArray(entry.hiddenSecondmates) ? entry.hiddenSecondmates.filter(id => typeof id === 'string' && /^[\w.-]+$/.test(id)).slice(0, 100) : [];
  const base = {
    name, machine, hiddenSecondmates, rules: [], records: [], warnings: [], dispatch: null, settings: [],
    remote: { ssh: String(entry.remote?.ssh ?? ''), path: String(entry.remote?.path ?? ''), readOnly: true },
    supervision: { read: false, policy: 'not-read', configured: null, host: null, engine: null, heartbeat: null, sources: [], warnings: [] },
  };
  let target;
  try { target = remoteTarget(entry); }
  catch (error) {
    return {
      ...base,
      path: base.remote.path,
      readable: false,
      role: { kind: 'unknown', source: '插件选项里的远端条目' },
      observedAt: new Date().toISOString(),
      readSource: '插件选项里的远端条目',
      readError: `远端条目不可用：${error.message}`,
      warnings: [`远端条目不可用：${error.message}。没有连接任何机器，也没有回退为本机 Home。`],
    };
  }
  base.path = target.path;
  base.remote = { ssh: target.ssh, path: target.path, readOnly: true };
  let output;
  try {
    output = await sshRead(target.ssh, target.path, options);
  } catch (error) {
    return {
      ...base,
      readable: false,
      role: { kind: 'unknown', source: `ssh ${target.ssh}（只读）` },
      observedAt: new Date().toISOString(),
      readSource: `ssh ${target.ssh}（只读）· 未读取到内容`,
      readError: `远端 Home 读取失败：${error.message}；这里没有显示任何缓存或旧 Home 的数据。`,
      warnings: [`远端 Home 读取失败（ssh ${target.ssh}）：${error.message}。这里不显示任何缓存或旧 Home 的数据。`],
    };
  }
  const files = readRemoteOutput(output, entry);
  if (files.dirs !== 'ok' || files.end === null) {
    return {
      ...base,
      readable: false,
      role: { kind: 'unknown', source: `ssh ${target.ssh}（只读）` },
      observedAt: new Date().toISOString(),
      readSource: `ssh ${target.ssh}（只读）· 内容不完整`,
      readError: '远端 Home 读取结果不完整；未把它当作有效配置。',
      warnings: ['远端 Home 读取结果不完整（缺少 config/ 或 state/ 的读取回执）；未把它当作有效配置。'],
    };
  }
  const observedAt = new Date().toISOString();
  const readSource = `ssh ${target.ssh}（只读）· ${target.path}`;
  const home = {
    ...base,
    readable: true,
    observedAt,
    readSource,
    role: { kind: files.role === 'secondmate' ? 'secondmate' : 'primary', source: `ssh ${target.ssh}：${files.role === 'secondmate' ? '.fm-secondmate-home 存在' : '未发现 .fm-secondmate-home'}` },
  };
  const metas = files.metas
    .map(item => ({ id: item.id, stamp: item.stamp, meta: parseMetaLine(item.raw) }))
    .filter(item => item.id && /^[A-Za-z0-9._-]+$/.test(item.id));
  home.records = metas.map(({ id, stamp, meta }) => ({
    id,
    kind: meta.kind || 'unknown',
    harness: meta.harness || '',
    model: meta.model || '',
    effort: meta.effort || '',
    backend: meta.backend || meta.remote_backend || '',
    remote: Boolean(meta.remote_host),
    source: `state/${id}.meta（远端只读）`,
    modified: stamp ? new Date(stamp * 1000).toISOString() : '',
    liveModel: null,
    liveStatus: 'unknown',
    location: { machine: meta.remote_host || machine, home: meta.home || '', source: `state/${id}.meta（远端只读）` },
    override: false,
  })).sort((a, b) => String(b.modified).localeCompare(String(a.modified)));

  const pin = files.pin ? files.pin.toString('utf8') : '';
  const pinBytes = files.pin || Buffer.from('');
  const parsed = parsePinText(pin);
  const ids = new Set(metas.filter(item => item.meta.kind === 'secondmate').map(item => item.id));
  for (const mate of parsed.overrides) ids.add(mate.id);
  const byId = new Map(parsed.overrides.map(item => [item.id, item]));
  home.secondmate = {
    absent: Boolean(files.pinAbsent),
    error: parsed.error,
    revision: files.pinAbsent ? '' : createHash('sha256').update(pinBytes).digest('hex'),
    modified: '',
    source: `config/secondmate-harness（${readSource}）`,
    latestBackup: null,
    readOnly: true,
    parse: 'plugin',
    note: '远端只读：这个 Home 的启动配置由插件按行读取，未在远端运行 fm-harness.sh 原生解析，也未写入。',
    default: parsed.default,
    ignoredLines: parsed.ignoredLines,
    mates: [...ids].sort((a, b) => a.localeCompare(b)).map(id => {
      const over = byId.get(id);
      if (over) return { id, source: 'override', line: over.line, harness: over.harness, model: over.model, effort: over.effort };
      return { id, source: 'inherit', line: null, harness: parsed.default?.harness || '', model: parsed.default?.model || '', effort: parsed.default?.effort || '' };
    }),
  };
  if (home.secondmate.error) home.warnings.push(home.secondmate.error);
  if (files.pinAbsent) home.warnings.push('远端没有 config/secondmate-harness；不推断二副的启动配置。');
  home.settingsNote = '远端只读 Home：本插件不读取也不写入它的设置目录。';
  return home;
}
