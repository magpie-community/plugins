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

async function discoveredMagpiePath(value, platform) {
  const names = platform === 'win32' ? /^magpie(?:\.exe)?$/i : /^magpie$/i;
  const basename = value => (platform === 'win32' ? path.win32 : path).basename(value.trim());
  if (typeof value !== 'string' || !names.test(basename(value))) return '';
  const resolved = await executablePath(value);
  // A magpie symlink must not turn an unrelated executable into the host.
  return resolved && names.test(basename(resolved)) ? resolved : '';
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
      const validPID = Number.isSafeInteger(parentPID) && parentPID > 0;
      const options = { cwd: directory || undefined, env,
        timeout: 6000, encoding: 'utf8', windowsHide: true };
      if (validPID && platform === 'darwin') {
        const result = await run('/bin/ps', ['-ww', '-p', String(parentPID), '-o', 'comm='],
          options);
        parent = String(result.stdout || '').trim();
      } else if (validPID && platform === 'linux') {
        parent = await readlink(`/proc/${parentPID}/exe`);
      } else if (validPID && platform === 'win32') {
        const command = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; '
          + `(Get-CimInstance Win32_Process -Filter 'ProcessId=${parentPID}').ExecutablePath`;
        const result = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], options);
        parent = String(result.stdout || '').trim();
      }
    } catch { /* An explicit path or PATH may still name the host. */ }
    executable = await discoveredMagpiePath(parent, platform);
    if (!executable) {
      try { executable = await discoveredMagpiePath(which('magpie'), platform); } catch { /* No PATH entry. */ }
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
