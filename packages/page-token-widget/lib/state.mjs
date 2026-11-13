import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const VERSION = 1;

// The token of the service and the code of one pairing are secrets of this
// computer. They are stored in Magpie's own directory and never leave it.
export function newToken() {
  return randomBytes(32).toString('base64url');
}

export function newPairingCode() {
  return randomBytes(12).toString('base64url');
}

export async function readState(file) {
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (saved && saved.version === VERSION && typeof saved.token === 'string') return saved;
  } catch { /* A missing or damaged file must not stop the service. */ }
  return null;
}

export async function writeState(file, state) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.tmp';
  await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(temporary, file);
}

export async function ensureState(file) {
  const saved = await readState(file);
  if (saved) return { state: saved, created: false };
  const state = {
    version: VERSION,
    token: newToken(),
    pairing: { code: newPairingCode(), createdAt: new Date().toISOString() },
    settings: {},
    paired: [],
  };
  await writeState(file, state);
  return { state, created: true };
}

// A pairing code is used by one phone only. A new one replaces it, and the
// phones that are already paired keep their token.
export function rotatePairing(state) {
  state.pairing = { code: newPairingCode(), createdAt: new Date().toISOString() };
  return state.pairing;
}

export function notePairing(state, address) {
  const entry = { at: new Date().toISOString(), address: String(address || '') };
  state.paired = [entry, ...(state.paired || [])].slice(0, 10);
  return entry;
}
