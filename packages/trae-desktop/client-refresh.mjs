import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const MAIN_SHA256 = '6540f065068c73e9a76f63c92283abedab234d69ea0779996ff7098e4b21bf2a';
export const LOADER = '\n// Magpie model catalog refresh (reversible, Trae CN 3.4.18).\nimport("./magpie-model-refresh.cjs").then(m=>m.default.startNotifier()).catch(()=>{});\n';
const sha = value => createHash('sha256').update(value).digest('hex');

function atomicWrite(file, content) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, content, { flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}

export function installClientRefresh({ local = process.env.LOCALAPPDATA, home = os.homedir(),
  expectedHash = MAIN_SHA256, restore = false } = {}) {
  if (!local) throw new Error('trae_client_not_installed');
  const app = path.join(local, 'Programs/Trae CN/resources/app');
  const product = JSON.parse(fs.readFileSync(path.join(app, 'product.json'), 'utf8'));
  if (product.appVersion !== '3.4.18') throw new Error('trae_client_refresh_build_unsupported');
  const main = path.join(app, 'out/main.js'), helper = path.join(app, 'out/magpie-model-refresh.cjs');
  const current = fs.readFileSync(main, 'utf8');
  const original = current.endsWith(LOADER) ? current.slice(0, -LOADER.length) : current;
  if (sha(original) !== expectedHash) throw new Error('trae_client_refresh_build_unsupported');
  const directory = path.join(home, '.config/magpie-trae/client-backups/3.4.18');
  fs.mkdirSync(directory, { recursive: true });
  const backup = path.join(directory, 'main.original.js');
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, original, { flag: 'wx' });
  if (sha(fs.readFileSync(backup)) !== expectedHash) throw new Error('trae_client_refresh_backup_invalid');
  if (!restore) {
    const content = fs.readFileSync(new URL('./trae-refresh-notifier.cjs', import.meta.url));
    if (!fs.existsSync(helper) || sha(fs.readFileSync(helper)) !== sha(content)) atomicWrite(helper, content);
  }
  const wanted = restore ? original : original + LOADER;
  if (current !== wanted) atomicWrite(main, wanted);
  if (restore) fs.rmSync(helper, { force: true });
  const result = { state: restore ? 'restored' : 'installed', version: product.appVersion,
    changed: current !== wanted, backup, updatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(result, null, 2));
  return result;
}
