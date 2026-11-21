import { mkdir, readFile } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { writeAtomic } from './atomic.mjs';

// The shape of the file does not change: it holds the token of the console of
// this computer, the devices of the phones, the pairing code and the settings.
// A file of the older version is cleaned up when it is read (see migrate).
const VERSION = 1;

// A pairing code is a door key that is opened once: it lives ten minutes at
// most, and the code that comes after it replaces it at once.
export const PAIRING_TTL_MS = 10 * 60 * 1000;

// The last access of a device is written to the file at most every five
// minutes, so a phone that reads every minute does not write the file every
// minute.
export const ACCESS_WRITE_MIN_MS = 5 * 60 * 1000;

// The name of a device is the user's own text for it. It is shown as plain
// text, so only a short plain label is kept.
const DEVICE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._*'-]{0,31}$/u;

// The token of the service and the code of one pairing are secrets of this
// computer. They are stored in Magpie's own directory and never leave it.
export function newToken() {
  return randomBytes(32).toString('base64url');
}

// Twelve bytes are ninety-six bits of randomness: a code that is guessed is
// not a code that can be guessed.
export function newPairingCode() {
  return randomBytes(12).toString('base64url');
}

// Only the hash of a device token is kept. The token itself is shown once, to
// the phone that asked for it, and never again.
export function hashToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

// Two secrets are compared without telling, by their length first and then
// byte by byte.
export const sameSecret = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
};

export async function readState(file) {
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (saved && saved.version === VERSION && typeof saved.consoleToken === 'string') return saved;
  } catch { /* A missing or damaged file must not stop the service. */ }
  return null;
}

// The writes of one file go one after another. Two writes that follow each
// other (the last visit of a phone and a new pairing code, for instance) would
// otherwise race: the older one could be written to the disk after the newer
// one and put an old pairing code back into the file.
const writeQueues = new Map();

export function writeState(file, state) {
  const previous = writeQueues.get(file) || Promise.resolve();
  const next = previous.then(async () => {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeAtomic(file, JSON.stringify(state, null, 2), { mode: 0o600 });
  });
  // The queue keeps going even when one write fails.
  writeQueues.set(file, next.catch(() => {}));
  return next;
}

export async function ensureState(file) {
  const saved = await readState(file);
  if (saved) {
    const changed = migrate(saved);
    if (changed) await writeState(file, saved);
    return { state: saved, created: false };
  }
  const state = {
    version: VERSION,
    // The token of the console of this computer. It never leaves the console.
    consoleToken: newToken(),
    pairing: { code: newPairingCode(), createdAt: new Date().toISOString() },
    settings: {},
    paired: [],
    devices: [],
  };
  migrate(state);
  await writeState(file, state);
  return { state, created: true };
}

// A file of the older version still carries the shared token of the phones and
// the device that held it. Nobody paired a phone with that version, so both are
// taken away here. The token of the console of this computer is kept, so that
// the console stays open across the update.
export function migrate(state, now = Date.now()) {
  let changed = false;
  if (typeof state.consoleToken !== 'string' || !state.consoleToken) {
    state.consoleToken = newToken();
    changed = true;
  }
  if (!Array.isArray(state.devices)) {
    state.devices = [];
    changed = true;
  }
  if (state.token) {
    delete state.token;
    changed = true;
  }
  if (state.devices.some(device => device?.legacy)) {
    state.devices = state.devices.filter(device => !device?.legacy);
    changed = true;
  }
  if (!state.pairing || typeof state.pairing.code !== 'string') {
    state.pairing = { code: newPairingCode(), createdAt: new Date(now).toISOString() };
    changed = true;
  }
  if (!state.pairing.expiresAt) {
    const born = Date.parse(state.pairing.createdAt || '') || now;
    state.pairing.expiresAt = new Date(born + PAIRING_TTL_MS).toISOString();
    changed = true;
  }
  if (!Array.isArray(state.paired)) {
    state.paired = [];
    changed = true;
  }
  if (!state.settings || typeof state.settings !== 'object') {
    state.settings = {};
    changed = true;
  }
  return changed;
}

// A pairing code is used by one phone only. A new one replaces it, and the
// phones that are already paired keep their token.
export function rotatePairing(state, now = Date.now()) {
  state.pairing = {
    code: newPairingCode(),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PAIRING_TTL_MS).toISOString(),
  };
  return state.pairing;
}

// A code is good while it is the current one and while it has not run out.
// A code that was replaced, used or left alone for too long never opens the
// door again.
export function pairingUsable(state, code, now = Date.now()) {
  const pairing = state.pairing || {};
  if (typeof code !== 'string' || !code) return false;
  if (!sameSecret(pairing.code || '', code)) return false;
  const expires = Date.parse(pairing.expiresAt || '');
  return Number.isFinite(expires) && expires > now;
}

export function notePairing(state, address, name = '') {
  // The address of the phone is written down as well, but behind the
  // forwarding of Tailscale every phone of the tailnet arrives as the
  // loopback, so the name of the device is what tells them apart.
  const entry = {
    at: new Date().toISOString(),
    address: String(address || ''),
    name: String(name || ''),
  };
  state.paired = [entry, ...(state.paired || [])].slice(0, 10);
  return entry;
}

// The name of a device is a short plain label of the user's own.
export const deviceName = (value, fallback = 'iPhone') => {
  if (typeof value !== 'string') return fallback;
  const name = value.trim();
  return DEVICE_NAME.test(name) ? name : fallback;
};

// Every phone that pairs gets a token of its own. Only its hash is kept.
export function addDevice(state, { name, token, now = Date.now() }) {
  const device = {
    id: randomBytes(6).toString('base64url'),
    name: deviceName(name),
    hash: hashToken(token),
    createdAt: new Date(now).toISOString(),
    lastAccessAt: null,
    revokedAt: null,
  };
  state.devices.push(device);
  return device;
}

// The token of a phone is checked against every device that was not revoked.
export function verifyToken(state, token, now = Date.now()) {
  if (typeof token !== 'string' || !token) return null;
  const devices = Array.isArray(state.devices) ? state.devices : [];
  const wanted = hashToken(token);
  for (const device of devices) {
    if (!device || device.revokedAt) continue;
    if (device.hash && sameSecret(device.hash, wanted)) return device;
  }
  return null;
}

// The time of the last use of a device is only written to the file when it
// moved far enough, so a phone that reads every minute does not write the
// file every minute.
export function noteAccess(device, now = Date.now()) {
  const last = Date.parse(device?.lastAccessAt || '');
  if (Number.isFinite(last) && now - last < ACCESS_WRITE_MIN_MS) return false;
  device.lastAccessAt = new Date(now).toISOString();
  return true;
}

// One device is taken away on its own. The phone that carries it stops at
// once; the other phones keep reading.
export function revokeDevice(state, id) {
  const device = (state.devices || []).find(entry => entry?.id === id);
  if (!device) return null;
  if (!device.revokedAt) device.revokedAt = new Date().toISOString();
  return device;
}

export function renameDevice(state, id, name) {
  const device = (state.devices || []).find(entry => entry?.id === id);
  if (!device) return null;
  device.name = deviceName(name, device.name);
  return device;
}

// The device of a token, even one that has been revoked. A phone that comes
// back with a token the service does not know any more has to be able to
// take its own row off the list, and it only has the token to prove which
// row is its own.
export function deviceOfToken(state, token) {
  if (typeof token !== 'string' || !token) return null;
  const devices = Array.isArray(state.devices) ? state.devices : [];
  const wanted = hashToken(token);
  for (const device of devices) {
    if (device && device.hash && sameSecret(device.hash, wanted)) return device;
  }
  return null;
}

// A device that has been revoked can be taken off the list for good. Its
// token stopped working when it was revoked, so removing the row does not
// open anything: it only cleans the list up. Only that one device is
// touched; the others keep their own tokens.
export function deleteDevice(state, id) {
  const devices = Array.isArray(state.devices) ? state.devices : [];
  const index = devices.findIndex(entry => entry?.id === id);
  if (index < 0) return null;
  const [removed] = devices.splice(index, 1);
  return removed || null;
}

// What the console shows about the devices: the names and the times, never
// the hashes and never the tokens.
export function deviceList(state) {
  return (state.devices || []).map(device => ({
    id: device.id,
    name: device.name,
    createdAt: device.createdAt || null,
    lastAccessAt: device.lastAccessAt || null,
    revokedAt: device.revokedAt || null,
  }));
}
