import { createHash } from 'node:crypto';
import { readdir, stat, realpath, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const results = new Map();
const ttl = 120000;
export async function validatorStamp(script) {
  const dir = dirname(script);
  const names = (await readdir(dir)).sort();
  const files = await Promise.all(names.map(async name => {
    const path = join(dir, name);
    try {
      const s = await stat(path);
      const digest = s.isFile() ? createHash('sha256').update(await readFile(path)).digest('hex') : null;
      return [name, await realpath(path), s.dev, s.ino, s.size, s.mode, s.mtimeMs, s.ctimeMs, digest];
    } catch (error) { return [name, error.code || 'unreadable']; }
  }));
  return [await realpath(script), files, process.env.PATH || '', process.env.HOME || ''];
}

// Only successful pure parser/validator work is retained. Callers still resolve
// the target, read bytes, check revisions/roles/rosters and stage writes afresh.
export async function cachedValidation(kind, inputs, run, onHit) {
  const key = `${kind}:${createHash('sha256').update(JSON.stringify(inputs)).digest('hex')}`;
  const old = results.get(key);
  if (old && Date.now() - old.at < ttl) { onHit?.(); return old.promise; }
  if (old) results.delete(key);
  const row = { at: Date.now() };
  row.promise = Promise.resolve().then(run).then(value => {
    if (value?.ok === false && results.get(key) === row) results.delete(key);
    return value;
  }, error => { if (results.get(key) === row) results.delete(key); throw error; });
  results.set(key, row);
  while (results.size > 128) results.delete(results.keys().next().value);
  return row.promise;
}
