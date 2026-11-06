import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const failure = code => Object.assign(new Error(code), { code });

async function executablePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value.trim())) return '';
  try {
    const resolved = await realpath(value.trim());
    if (!(await stat(resolved)).isFile()) return '';
    await access(resolved, constants.X_OK);
    return resolved;
  } catch { return ''; }
}

// Use the running host's executable and environment so its normal agent setter
// owns the primary model, applied record and stash, including portable profiles.
export async function setPrimaryModel(model, { magpiePath, directory, env = process.env,
  platform = process.platform, parentPID = process.ppid, run = runFile,
  which = name => globalThis.Bun?.which?.(name) } = {}) {
  let executable = '';
  if (magpiePath !== undefined && magpiePath !== '') {
    executable = await executablePath(magpiePath);
  } else {
    let parent = '';
    try {
      if (platform === 'darwin') {
        const result = await run('/bin/ps', ['-ww', '-p', String(parentPID), '-o', 'comm='],
          { timeout: 6000, encoding: 'utf8', windowsHide: true });
        parent = String(result.stdout || '').trim();
      } else if (platform === 'linux') {
        parent = await readlink(`/proc/${parentPID}/exe`);
      }
    } catch { /* An explicit path or PATH may still name the host. */ }
    executable = await executablePath(parent);
    if (!executable) {
      try { executable = await executablePath(which('magpie')); } catch { /* No PATH entry. */ }
    }
  }
  if (!executable) throw failure('primary_model_unavailable');
  try {
    await run(executable, ['kimi-desktop', 'model', 'magpie/' + model], {
      cwd: directory || undefined,
      env: { ...env, MAGPIE_KIMI_SKIP_ADAPTER: '1' },
      timeout: 60000,
      windowsHide: true,
    });
  } catch { throw failure('primary_model_update_failed'); }
}
