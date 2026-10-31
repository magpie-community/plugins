import { mkdir, readdir, writeFile, readFile, unlink, rmdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}

async function removeEmpty(path) {
  for (let attempt = 0; ; attempt++) {
    try { await rmdir(path); return true; }
    catch (error) {
      if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) return false;
      if (process.platform === 'win32' && ['EPERM', 'EBUSY'].includes(error.code)) {
        // Windows can briefly retain a directory handle; an empty lock remains recoverable.
        if (attempt === 2) return false;
        await delay(25); continue;
      }
      throw error;
    }
  }
}

export async function acquireLock(path, { waitMs = 5000 } = {}) {
  const deadline = Date.now() + Math.max(waitMs, 100);
  let first = true;
  while (true) {
    if (!first && Date.now() >= deadline) throw new Error('lock-busy');
    first = false;
    try {
      await mkdir(path, { mode: 0o700 });
      const owner = `${process.pid}-${randomBytes(12).toString('hex')}.owner`;
      try {
        await writeFile(join(path, owner), String(Date.now()), { flag: 'wx', mode: 0o600 });
        const owners = await readdir(path);
        // An empty directory may be recovered while its creator is publishing ownership.
        if (owners.length === 1 && owners[0] === owner) return async () => {
          await unlink(join(path, owner)); await removeEmpty(path);
        };
        await unlink(join(path, owner));
      } catch (error) {
        // A directory removed before ownership is published reports open EPERM on Windows.
        if (process.platform === 'win32' && error.code === 'EPERM' && error.syscall === 'open' && error.path === join(path, owner)) {
          if (Date.now() >= deadline) throw error;
          await delay(25); continue;
        }
        if (error.code !== 'ENOENT') throw error;
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if ((await lstat(path)).isDirectory()) {
          for (const name of await readdir(path)) {
            const match = /^([1-9]\d*)-[a-f0-9]+\.owner$/.exec(name);
            if (match && !alive(Number(match[1]))) {
              try { await unlink(join(path, name)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
            }
          }
          if (await removeEmpty(path)) continue;
        } else {
          // Older workers used a PID file. Never unlink an unknown or live owner.
          const pid = Number(await readFile(path, 'utf8'));
          if (!alive(pid)) {
            try { await unlink(path); } catch (e) { if (!['ENOENT', 'EISDIR', 'EPERM'].includes(e.code)) throw e; }
            continue;
          }
        }
      } catch (e) { if (['ENOENT', 'EISDIR', 'ENOTDIR'].includes(e.code)) continue; throw e; }
    }
    if (waitMs === 0 || Date.now() >= deadline) throw new Error('lock-busy');
    await delay(25);
  }
}
