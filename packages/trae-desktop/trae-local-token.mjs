import fs from 'node:fs';
import path from 'node:path';
import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { LOCAL_TOKEN } from './bridge.mjs';

const SOURCE_MARKER = Buffer.from('apps\\icube_server_rs\\crates\\llm-client\\src\\crypto\\crypto.rs');
const HARNESS_MARKER = Buffer.from('key too shortrandom too short');
const HARNESS_SHA256 = '11b4c76ac34c31a93a5bf4992444e4c406cfd293dcefd89a73d11801841dcb48';
const LEGACY_SHA256 = '62f6a4e43c778a8114d0b77073d8425c9bd855ffeb815ba1946d0357c133448d';
let cachedProfile;

// Vendor codec constants stay in the installed client. Scan with bounded memory;
// neither the package nor the credential cache contains its AES key.
function inspect(file, marker, prefixBytes) {
  const fd = fs.openSync(file, 'r'), hash = createHash('sha256');
  const chunk = Buffer.alloc(1024 * 1024), candidates = [];
  let tail = Buffer.alloc(0), total = 0;
  try {
    let count;
    while ((count = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      const current = chunk.subarray(0, count); hash.update(current);
      const window = Buffer.concat([tail, current]);
      let at = -1;
      while ((at = window.indexOf(marker, at + 1)) >= 0) {
        const absolute = total - tail.length + at;
        if (at >= prefixBytes && absolute + marker.length > total) candidates.push(Buffer.from(window.subarray(at - prefixBytes, at)));
      }
      total += count;
      tail = Buffer.from(window.subarray(-prefixBytes - marker.length));
    }
  } finally { fs.closeSync(fd); }
  if (candidates.length !== 1) throw new Error('trae_credential_profile_unknown');
  return { prefix: candidates[0], digest: hash.digest('hex') };
}

export function readNativeCredentialProfile({ local = process.env.LOCALAPPDATA } = {}) {
  if (!local) throw new Error('trae_installation_unavailable');
  const app = path.join(local, 'Programs/Trae CN/resources/app');
  const version = JSON.parse(fs.readFileSync(path.join(app, 'product.json'), 'utf8')).appVersion;
  if (version !== '3.4.18') throw new Error('trae_credential_version_unsupported');
  const root = path.join(app, 'modules/ai-agent');
  const files = ['harness.dll', 'ai_agent.dll'].map(name => path.join(root, name));
  const identity = files.map(file => { const s = fs.statSync(file); return `${file}:${s.size}:${s.mtimeMs}`; }).join('|');
  if (cachedProfile?.identity === identity) return cachedProfile;
  const harness = inspect(files[0], HARNESS_MARKER, 84);
  const legacy = inspect(files[1], SOURCE_MARKER, 94);
  if (harness.digest !== HARNESS_SHA256 || legacy.digest !== LEGACY_SHA256) throw new Error('trae_credential_build_unsupported');
  const a = legacy.prefix.toString('ascii'), h = harness.prefix.toString('ascii');
  if (!/^[0-9a-f]{84}$/.test(h) || !/^[0-9a-f]{64}[0-9]{10}[0-9a-f]{20}$/.test(a) ||
      a.slice(0, 64) !== h.slice(0, 64) || a.slice(74) !== h.slice(64)) throw new Error('trae_credential_profile_unknown');
  const key = Buffer.from(h.slice(0, 64), 'hex'), salt = Buffer.from(h.slice(64), 'hex');
  for (let i = 0; i < 8; i++) key[i] ^= salt[i];
  salt.fill(0);
  cachedProfile = { identity, id: `trae-cn-${version}:${harness.digest}`, key, aad: Buffer.from(a.slice(64, 74)) };
  return cachedProfile;
}

export function encodeCredential(value, profile, nonce = randomBytes(12)) {
  if (typeof value !== 'string' || nonce.length !== 12) throw new Error('trae_credential_input_invalid');
  const cipher = createCipheriv('aes-256-gcm', profile.key, nonce);
  cipher.setAAD(profile.aad);
  return Buffer.concat([nonce, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
}

export function decodeCredential(value, profile) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('trae_credential_invalid');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 28 || bytes.toString('base64') !== value) throw new Error('trae_credential_invalid');
  try {
    const decipher = createDecipheriv('aes-256-gcm', profile.key, bytes.subarray(0, 12));
    decipher.setAAD(profile.aad); decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
  } catch { throw new Error('trae_credential_invalid'); }
}

export function localCredential(file, { profile = readNativeCredentialProfile() } = {}) {
  let stored;
  try { stored = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('trae_credential_cache_unreadable'); }
  if (stored?.version === 1 && stored.profile === profile.id && decodeCredential(stored.ak, profile) === LOCAL_TOKEN) return stored.ak;
  const ak = encodeCredential(LOCAL_TOKEN, profile);
  if (decodeCredential(ak, profile) !== LOCAL_TOKEN) throw new Error('trae_credential_self_check_failed');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, profile: profile.id, ak }, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
  return ak;
}
