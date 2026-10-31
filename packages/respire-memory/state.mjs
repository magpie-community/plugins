import { mkdir, open, readFile, rename, unlink, readdir, link } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

export const digest = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export const stateDirectory = o => o.stateDir || join(homedir(), '.rsrs', 'magpie');

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
    const value = JSON.parse(text);
    const decrypt = createDecipheriv('aes-256-gcm', await this.key(), Buffer.from(value.iv, 'base64'));
    decrypt.setAAD(Buffer.from(name)); decrypt.setAuthTag(Buffer.from(value.tag, 'base64'));
    return JSON.parse(Buffer.concat([decrypt.update(Buffer.from(value.data, 'base64')), decrypt.final()]).toString('utf8'));
  }
  async put(name, value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', await this.key(), iv);
    cipher.setAAD(Buffer.from(name));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    const temp = this.path(name) + '.' + randomBytes(8).toString('hex') + '.tmp';
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }));
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temp, this.path(name));
  }
  async change(name, fn) {
    await this.key();
    const path = this.path(name) + '.lock';
    const handle = await open(path, 'wx', 0o600);
    try { return await fn(await this.get(name), value => this.put(name, value)); }
    finally { await handle.close(); await unlink(path); }
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
