import { mkdir, open, readFile, rename, unlink, readdir, link, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { acquireLock } from './lock.mjs';

export const digest = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export const stateDirectory = o => o.stateDir || join(homedir(), '.rsrs', 'magpie');
const BACKUP_NAME = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}-\d{4}-\d{2}-\d{2}T\d{6}\.\d{3}Z\.bin$/i;
const BACKUP_MAX_AGE_MS = 7 * 86400000;

// The single encryption format used for every persisted record and update backup.
export function encryptRecord(key, name, value) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(name));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
}

export function decryptRecord(key, name, text) {
  const value = JSON.parse(text);
  const decrypt = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
  decrypt.setAAD(Buffer.from(name)); decrypt.setAuthTag(Buffer.from(value.tag, 'base64'));
  return JSON.parse(Buffer.concat([decrypt.update(Buffer.from(value.data, 'base64')), decrypt.final()]).toString('utf8'));
}

// Write 0600, flush, then atomically replace — the same durability as Store.put.
export async function writeFileAtomic(path, text) {
  const temp = path + '.' + randomBytes(8).toString('hex') + '.tmp';
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, path);
}

export class Store {
  constructor(dir) { this.dir = dir; }
  path(name) {
    if (!/^(?:turn|job|session|control)-[a-f0-9]{64}$/.test(name)) throw new Error('invalid-state-key');
    return join(this.dir, name + '.json');
  }
  async key() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, 'state.key');
    try {
      return await readFile(path).then(key => { if (key.length !== 32) throw new Error('invalid-state-key-file'); return key; });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temp = path + '.' + randomBytes(8).toString('hex');
    try {
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(randomBytes(32)); await handle.sync(); } finally { await handle.close(); }
      await link(temp, path);
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { await unlink(temp); }
    const key = await readFile(path);
    if (key.length !== 32) throw new Error('invalid-state-key-file');
    return key;
  }
  async get(name) {
    let text;
    try { text = await readFile(this.path(name), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    return decryptRecord(await this.key(), name, text);
  }
  async put(name, value) {
    await writeFileAtomic(this.path(name), encryptRecord(await this.key(), name, value));
  }
  async putBackup(name, value) {
    if (!BACKUP_NAME.test(name)) throw new Error('invalid-backup-name');
    const dir = join(this.dir, 'backups');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFileAtomic(join(dir, name), encryptRecord(await this.key(), name, value));
  }
  async getBackup(name) {
    if (!BACKUP_NAME.test(name)) throw new Error('invalid-backup-name');
    return decryptRecord(await this.key(), name, await readFile(join(this.dir, 'backups', name), 'utf8'));
  }
  async pruneBackups(now = Date.now()) {
    const dir = join(this.dir, 'backups');
    let files;
    try { files = await readdir(dir); } catch (error) { if (error.code !== 'ENOENT') throw error; return; }
    for (const file of files) {
      if (!BACKUP_NAME.test(file)) continue;
      try { if (now - (await stat(join(dir, file))).mtimeMs > BACKUP_MAX_AGE_MS) await unlink(join(dir, file)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  async change(name, fn) {
    await this.key();
    const path = this.path(name) + '.lock';
    const release = await acquireLock(path);
    try { return await fn(await this.get(name), value => this.put(name, value)); }
    finally { await release(); }
  }
  async prune(now = Date.now()) {
    await this.key();
    let release;
    try { release = await acquireLock(join(this.dir, 'prune.lock'), { waitMs: 0 }); }
    catch (error) { if (error.message === 'lock-busy') return; throw error; }
    try {
    for (const file of await readdir(this.dir)) {
      if (!/^(?:turn|session|job)-[a-f0-9]{64}\.json$/.test(file)) continue;
      const name = file.slice(0, -5);
      let age;
      try { age = now - (await stat(this.path(name))).mtimeMs; } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (name.startsWith('job-')) {
        if (age < 86400000) continue;
        await this.change(name, async (job, save) => {
          if (!job || !['completed', 'unconfirmed', 'expired'].includes(job.status)) return;
          const retentionAt = job.retentionAt ?? job.finishedAt ?? job.createdAt ?? new Date(now - age).toISOString();
          const lifetime = now - Date.parse(retentionAt);
          if (!Number.isFinite(lifetime)) throw new Error('invalid-retention-time');
          if (lifetime < 86400000) return;
          if (job.messages) { const { messages, ...receipt } = job; await save({ ...receipt, retentionAt, evidenceExpired: true }); }
          // Unknown writes retain their compact receipt and are never made replayable by expiry.
          if (job.status !== 'unconfirmed' && lifetime > 7 * 86400000) await unlink(this.path(name));
        });
      } else if (age > 7 * 86400000) await this.change(name, async value => {
        if (now - (await stat(this.path(name))).mtimeMs < 7 * 86400000) return;
        if (value?.phase === 'writing' || value?.storage?.status === 'uncertain') {
          if (value.text) { const { text, ...marker } = value; await this.put(name, marker); }
          return;
        }
        await unlink(this.path(name));
      });
    }
    } finally { await release(); }
  }
  async jobs() {
    await this.key();
    return (await readdir(this.dir)).filter(f => /^job-[a-f0-9]{64}\.json$/.test(f)).sort().map(f => f.slice(0, -5));
  }
}

export async function accountIdentity(o, call) {
  const doc = await call(['status']);
  const s = doc.summary;
  if (doc.status !== 'ok' || !s?.data_dir || !s.session?.has_session || s.unlocked !== true) throw new Error('runtime-not-ready');
  return digest(o.url, s.data_dir, s.session.user, s.session.addr);
}
