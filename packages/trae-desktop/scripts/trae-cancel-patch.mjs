// Local, reversible compatibility patch for the inspected TraeWork build.
// Not part of the Magpie plugin package.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ORIGINAL_SHA256 = '567e4b3ead49570ddcd51283a7155c5c24895ee9cb3dd2df2bb0582ad2c87404';
export const hash = value => createHash('sha256').update(value).digest('hex');
export const relativeFile = 'node_modules/@byted-icube/solo-lite/dist/3312.ab69b1ac.mjs';
const subscriptionAnchor = 'n=this.streamStore.subscription.get(e);if(t===s.Ph.Failed){';
const ackAnchor = 'if(0===t.code)return u.logger.info("[ChatSessionService] Stop request sent, waiting for done event:",e),{success:!0};';

export function patchSource(source) {
  for (const anchor of [subscriptionAnchor, ackAnchor]) {
    if (source.split(anchor).length !== 2) throw new Error('trae_cancel_patch_source_unknown');
  }
  return source.replace(subscriptionAnchor,
    'n=this.streamStore.subscription.get(e);if(n!==o)return void d.logger.info("[RealtimeEventService] Ignoring stale delayed status from a replaced subscription:",e);if(t===s.Ph.Failed){')
    .replace(ackAnchor,
      'if(0===t.code){if(!this.streamService.isStreaming(e))try{await this.refreshSession(e,"stop_ack_reconcile",{preserveTerminalStatus:!0});[f.Ph.Stopped,f.Ph.Finished,f.Ph.Failed].includes(this.sessionStore.sessionStatus.get(e))&&this.streamStore.core.clearPendingCancelReason(e)}catch(t){u.logger.warn("[ChatSessionService] Stop acknowledgement reconciliation failed:",e,t)}return u.logger.info("[ChatSessionService] Stop request sent, waiting for done event:",e),{success:!0}}');
}

export function patchPaths() {
  const app = path.join(process.env.LOCALAPPDATA, 'Programs/Trae CN/resources/app');
  const backup = fileURLToPath(new URL('../artifacts/trae-cancel-patch-3.4.18/', import.meta.url));
  return { app, file: path.join(app, relativeFile), backup,
    original: path.join(backup, '3312.ab69b1ac.original.mjs'), manifest: path.join(backup, 'manifest.json') };
}

export function originalSource() {
  const p = patchPaths();
  const current = fs.readFileSync(p.file);
  const original = hash(current) === ORIGINAL_SHA256 ? current : fs.readFileSync(p.original);
  if (hash(original) !== ORIGINAL_SHA256) throw new Error('trae_cancel_patch_build_unknown');
  return original.toString('utf8');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] || '--check';
  if (!['--check', '--apply', '--restore'].includes(command)) throw new Error('Expected --check, --apply or --restore');
  const p = patchPaths();
  const product = JSON.parse(fs.readFileSync(path.join(p.app, 'product.json')));
  if (product.appVersion !== '3.4.18') throw new Error('trae_cancel_patch_version_unknown');
  const original = originalSource(), patched = patchSource(original);
  const currentHash = hash(fs.readFileSync(p.file)), patchedHash = hash(patched);
  if (![ORIGINAL_SHA256, patchedHash].includes(currentHash)) throw new Error('trae_cancel_patch_file_changed');
  if (command !== '--check') {
    fs.mkdirSync(p.backup, { recursive: true });
    if (!fs.existsSync(p.original)) fs.writeFileSync(p.original, original, { flag: 'wx' });
    if (hash(fs.readFileSync(p.original)) !== ORIGINAL_SHA256) throw new Error('trae_cancel_patch_backup_invalid');
    const wanted = command === '--apply' ? patched : original;
    if (hash(wanted) !== currentHash) {
      const temporary = p.file + '.magpie-cancel.tmp';
      fs.writeFileSync(temporary, wanted, { flag: 'wx' });
      fs.renameSync(temporary, p.file);
    }
    fs.writeFileSync(p.manifest, JSON.stringify({ appVersion: product.appVersion, relativeFile,
      originalHash: ORIGINAL_SHA256, patchedHash, command, updatedAt: new Date().toISOString() }, null, 2));
  }
  console.log(JSON.stringify({ version: product.appVersion, command,
    state: hash(fs.readFileSync(p.file)) === patchedHash ? 'patched' : 'original', backup: p.original }));
}
