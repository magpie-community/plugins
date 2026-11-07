// npm pack / publish 前的守卫：公开包里不能出现口令或本机部署配置。
// 这些文件不进 git（见 .gitignore），但 deploy.sh 会把它们生成为运行时副本，
// 在错误的目录里执行 npm pack 就会把 key 带上船。
// 同时做布局守卫（community-submission.md 的 layout trap）：README/docs 承诺的
// 文件（docs/、Docker 三件套）必须真实存在，文档相对链接必须可达——否则合并后全 404。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

const forbidden = [
  'static/remote.js',
  'server.log',
  'usage-page-key',
];
for (const f of forbidden) {
  if (existsSync(path.join(root, f))) problems.push(`${f} must not be in the package`);
}

const secret = /[?&]key=[0-9a-f]{16,}|"key"\s*:\s*"[0-9a-f]{16,}"|PAGE_KEY\s*[:=]\s*['"]?[0-9a-f]{16,}/i;
for (const f of ['page/index.html', 'static/index.html', 'server.mjs', 'index.mjs']) {
  const full = path.join(root, f);
  if (!existsSync(full)) continue;
  const text = readFileSync(full, 'utf8');
  if (secret.test(text)) problems.push(`${f} contains what looks like a page key`);
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const f of pkg.files) {
  if (!existsSync(path.join(root, f))) problems.push(`files entry is missing: ${f}`);
}
if (!pkg.files.includes('LICENSE')) problems.push('files must include LICENSE');

// 布局守卫：README 与 self-hosting 承诺的部署文件必须随仓库走。
// 仅在 git checkout 里强制（tarball 解包环境没有 Docker 三件套，属正常）
const inCheckout = existsSync(path.join(root, '.git'));
if (inCheckout) {
  for (const f of ['docs', 'Dockerfile', 'docker-compose.yml', '.env.example', 'README.md', 'LICENSE', 'NOTICE', 'LICENSES']) {
    if (!existsSync(path.join(root, f))) problems.push(`repo tree must contain ${f} (docs/Docker references 404 otherwise)`);
  }
  for (const f of ['docs', 'scripts', 'NOTICE', 'LICENSES']) {
    if (!pkg.files.includes(f)) problems.push(`files must include ${f} (docs/NOTICE references 404 on npm otherwise)`);
  }
}
// README 与 docs 里的 .md 相对链接必须指向存在的文件
function walk(dir) {
  let out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    else out.push(full);
  }
  return out;
}
for (const doc of ['README.md', ...walk('docs').filter((f) => f.endsWith('.md'))]) {
  const text = readFileSync(path.join(root, doc), 'utf8');
  for (const m of text.matchAll(/\]\(([^)#]+?\.md)\)/g)) {
    const target = path.resolve(path.dirname(path.join(root, doc)), m[1]);
    if (!existsSync(target)) problems.push(`${doc} links to missing file: ${m[1]}`);
  }
}
// 全量扫描 files 条目覆盖到的文本文件：口令模式不允许出现在任何被打包的位置
const pkgFiles = [];
for (const entry of pkg.files) {
  const full = path.join(root, entry);
  if (!existsSync(full)) continue;
  if (statSync(full).isFile()) pkgFiles.push(full);
  else pkgFiles.push(...walk(full));
}
for (const full of pkgFiles) {
  let text;
  try { text = readFileSync(full, 'utf8'); } catch { continue; }
  const rel = path.relative(root, full);
  if (secret.test(text)) problems.push(`${rel} contains what looks like a page key`);
  // remote.js 任何形态都不允许（打包产物里按任意路径出现也算）
  if (path.basename(full).toLowerCase() === 'remote.js') problems.push(`${rel} must not be in the package`);
}
// 非 hex 长随机口令（vps-init 允许任意长随机串）：PAGE_KEY=xxx 16 位以上非空白也要拦
const passphr = /PAGE_KEY\s*[:=]\s*['"]?[A-Za-z0-9_/+-]{16,}/;
for (const f of ['vps-init.sh', '.env.example', 'docs/docker.md', 'docs/self-hosting.md']) {
  const full = path.join(root, f);
  if (!existsSync(full)) continue;
  const text = readFileSync(full, 'utf8');
  const hit = [...text.matchAll(/PAGE_KEY\s*[:=]\s*['"]?([^\s'"]{16,})/g)].filter((m) => !/^\$\{/.test(m[1]) && m[1] !== 'must-be-set');
  if (hit.length) problems.push(`${f} contains a literal PAGE_KEY value (${hit.length} occurrence(s))`);
  if (passphr.test(text)) problems.push(`${f} contains what looks like a page passphrase`);
}

if (problems.length) {
  console.error('✗ cannot pack:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('✓ package is publishable');
