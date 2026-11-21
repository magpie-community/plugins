import { readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

// A file is written somewhere else first and then moved onto its place, so a
// reader never sees half a file. The name of the temporary file is one of its
// own for every write, so two writes cannot pull the same file away from
// under each other.
//
// Windows refuses to move a file onto a place that another program happens to
// hold open (a scanner, a viewer), and it says EPERM for that. The move is
// therefore tried a few times before the write is given up on.
const MOVES = 4;
const PAUSE_MS = 40;

const pause = ms => new Promise(resolve => { setTimeout(resolve, ms).unref?.(); });

export async function writeAtomic(file, data, { mode = 0o600 } = {}) {
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, data, { mode });
    for (let attempt = 1; ; attempt += 1) {
      try {
        await rename(temporary, file);
        return;
      } catch (error) {
        if (attempt >= MOVES || (error?.code !== 'EPERM' && error?.code !== 'EACCES' && error?.code !== 'EBUSY')) {
          throw error;
        }
        await pause(PAUSE_MS);
      }
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

// When the program is killed between the write and the move, the temporary
// file stays behind. Nothing ever reads it, but it is litter, so it is swept
// away when the service starts.
export async function sweepTemporaries(file, { olderThanMs = 60 * 60 * 1000 } = {}) {
  const folder = path.dirname(file);
  const name = path.basename(file);
  const prefix = `${name}.`;
  let names = [];
  try {
    names = await readdir(folder);
  } catch {
    return 0;
  }
  let swept = 0;
  for (const entry of names) {
    if (!entry.startsWith(prefix) || !entry.endsWith('.tmp')) continue;
    const stale = path.join(folder, entry);
    try {
      const info = await stat(stale);
      if (Date.now() - info.mtimeMs < olderThanMs) continue;
      await rm(stale, { force: true });
      swept += 1;
    } catch {
      // A file that cannot be looked at is left where it is.
    }
  }
  return swept;
}
