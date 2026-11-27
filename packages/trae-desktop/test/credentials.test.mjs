import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeCredential, decodeCredential, localCredential, readNativeCredentialProfile } from '../trae-local-token.mjs';
import { LOCAL_TOKEN } from '../bridge.mjs';

// Synthetic profile; no vendor codec material or account credentials in tests.
const profile = { id: 'synthetic-v1', key: Buffer.alloc(32, 0x61), aad: Buffer.from('fixture-auth-data') };

test('credential envelope uses a 12-byte nonce and authenticated payload, with fresh nonces', () => {
  const a = encodeCredential(LOCAL_TOKEN, profile), b = encodeCredential(LOCAL_TOKEN, profile);
  assert.notEqual(a, b);
  assert.equal(Buffer.from(a, 'base64').length, 12 + Buffer.byteLength(LOCAL_TOKEN) + 16);
  assert.equal(decodeCredential(a, profile), LOCAL_TOKEN);
  for (const index of [0, 15, Buffer.from(a, 'base64').length - 1]) {
    const tampered = Buffer.from(a, 'base64'); tampered[index] ^= 1;
    assert.throws(() => decodeCredential(tampered.toString('base64'), profile), /trae_credential_invalid/);
  }
  assert.throws(() => decodeCredential(a, { ...profile, aad: Buffer.alloc(0) }), /trae_credential_invalid/);
  assert.throws(() => decodeCredential(a, { ...profile, key: Buffer.alloc(32) }), /trae_credential_invalid/);
});

test('malformed or plaintext credentials are rejected', () => {
  for (const value of ['', LOCAL_TOKEN, '!!!!', Buffer.alloc(28).toString('base64')]) {
    assert.throws(() => decodeCredential(value, profile), /trae_credential_invalid/);
  }
  assert.throws(() => encodeCredential(null, profile), /trae_credential_input_invalid/);
  assert.throws(() => encodeCredential('fixture', profile, Buffer.alloc(16)), /trae_credential_input_invalid/);
});

test('the unused empty SK still has an authenticated 28-byte native envelope', () => {
  const encoded = encodeCredential('', profile);
  assert.equal(encoded.length, 40);
  assert.equal(Buffer.from(encoded, 'base64').length, 28);
  assert.equal(decodeCredential(encoded, profile), '');
  const tampered = Buffer.from(encoded, 'base64'); tampered[27] ^= 1;
  assert.throws(() => decodeCredential(tampered.toString('base64'), profile), /trae_credential_invalid/);
});

test('credential cache stays stable across syncs and regenerates for a verified profile change', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-credential-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'credential.json');
  const a = localCredential(file, { profile });
  assert.equal(localCredential(file, { profile }), a);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['ak', 'profile', 'version']);
  assert.equal(decodeCredential(saved.ak, profile), LOCAL_TOKEN);
  const next = { ...profile, id: 'synthetic-v2', aad: Buffer.from('next-auth-data') };
  const b = localCredential(file, { profile: next });
  assert.notEqual(b, a); assert.equal(decodeCredential(b, next), LOCAL_TOKEN);
  fs.writeFileSync(file, '{bad');
  assert.throws(() => localCredential(file, { profile }), /trae_credential_cache_unreadable/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{bad');
});

test('unsupported client version is refused before reading native codec material', t => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-unknown-version-'));
  t.after(() => fs.rmSync(local, { recursive: true, force: true }));
  const file = path.join(local, 'Programs/Trae CN/resources/app/product.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"appVersion":"unverified-version"}');
  assert.throws(() => readNativeCredentialProfile({ local }), /trae_credential_version_unsupported/);
});
