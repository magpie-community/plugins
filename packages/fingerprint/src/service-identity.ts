import { createHmac, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { options, type Options } from './config';

export const VERSION = '0.2.2';

// The health endpoint is public, so the configuration digest must not be a
// plain hash of a low-entropy gateway key. Keep the salt beside the install's
// data, while retaining an in-process fallback for read-only or unavailable
// data directories.
const SALT_FILE = '.service-identity-salt';
const SALT_BYTES = 32;
const salts = new Map<string, Buffer>();

const readSalt = (path: string) => {
  try {
    const salt = readFileSync(path);
    return salt.length === SALT_BYTES ? salt : undefined;
  } catch {
    return undefined;
  }
};

const writeSalt = (path: string, salt: Buffer) => {
  let fd: number | undefined;
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    // Publish only after the complete salt is fsynced. A competing process
    // either sees no file or the complete 32-byte file, never an empty one.
    fd = openSync(temporary, 'wx', 0o600);
    let offset = 0;
    while (offset < salt.length) offset += writeSync(fd, salt, offset);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // linkSync is atomic and never replaces a salt another process published.
    linkSync(temporary, path);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
};

function identitySalt(dataDir: string) {
  const directory = resolve(dataDir);
  const cached = salts.get(directory);
  if (cached) return cached;

  const path = join(directory, SALT_FILE);
  let salt = readSalt(path);
  if (!salt) {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      salt = readSalt(path);
      if (!salt) {
        const candidate = randomBytes(SALT_BYTES);
        if (writeSalt(path, candidate)) salt = readSalt(path) || candidate;
        else salt = readSalt(path);
      }
      if (salt) chmodSync(path, 0o600);
    } catch {
      // A read-only or inaccessible data directory cannot persist a salt.
      // Keep one random value in memory so health and managed probes agree.
    }
  }
  salt ??= randomBytes(SALT_BYTES);
  salts.set(directory, salt);
  return salt;
}

export function serviceIdentity(input: Options = {}) {
  const opt = options(input);
  const configuration = {
    gateway: opt.gateway,
    apiKey: opt.apiKey,
    dataDir: resolve(opt.dataDir),
    bankSource: opt.bankSource || null,
    demo: opt.demo,
    uiDir: opt.uiDir ? resolve(opt.uiDir) : null,
  };
  return {
    app: 'magpie-fingerprint',
    protocol: 1,
    version: VERSION,
    // HMAC keeps the public digest from being an offline API-key oracle while
    // preserving exact matching when the key changes.
    configuration: createHmac('sha256', identitySalt(opt.dataDir))
      .update(JSON.stringify(configuration))
      .digest('hex'),
  };
}
