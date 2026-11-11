import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function readJSON(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function writeJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}

export async function withLock(stateFile, run) {
  const lock = `${stateFile}.lock`;
  await fs.mkdir(path.dirname(lock), { recursive: true, mode: 0o700 });
  let handle;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { handle = await fs.open(lock, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const owner = await readJSON(lock);
        if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); }
          catch (e) { if (e.code === 'ESRCH') stale = true; }
        }
      } catch (e) {
        if (e.code === 'ENOENT') continue;
        // A process can die between creating and filling the lock.
        if (e instanceof SyntaxError) stale = Date.now() - (await fs.stat(lock)).mtimeMs > 30000;
        else throw e;
      }
      if (!stale) throw new Error('Another Nowledge sync is running; retry shortly.');
      await fs.rm(lock, { force: true });
    }
  }
  if (!handle) throw new Error('Could not acquire Nowledge sync lock.');
  try { await handle.writeFile(JSON.stringify({ pid: process.pid })); return await run(); }
  finally { await handle.close(); await fs.rm(lock, { force: true }); }
}
