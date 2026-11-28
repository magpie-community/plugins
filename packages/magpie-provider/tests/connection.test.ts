import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConnection } from '../src/gateway.js';

const directories: string[] = [];
const baseURL = 'https://gateway.example.test/v1';
const fixture = async (value: unknown) => {
  const dir = await mkdtemp(join(tmpdir(), 'magpie-connection-'));
  directories.push(dir);
  const tokenFile = join(dir, 'connection.json');
  await writeFile(tokenFile, JSON.stringify(value));
  return { tokenFile, options: { agentID: 'yuri', remote: { baseURL, tokenFile } } };
};

afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

test('reads the assigned key at runtime, observes rotation and fails closed on disconnect', async () => {
  const { tokenFile, options } = await fixture({ baseURL, gatewayKey: 'fixture-first-key' });
  const connection = await resolveConnection(options);
  expect(connection.token).toBe('fixture-first-key');
  await writeFile(tokenFile, JSON.stringify({ baseURL, gatewayKey: 'fixture-next-key' }));
  await connection.ensure();
  expect(connection.token).toBe('fixture-next-key');
  await rm(tokenFile);
  await expect(connection.ensure()).rejects.toThrow('tokenFile');
});

for (const value of [null, {}, { baseURL, gatewayKey: 'bad\nkey' }, { baseURL: 'https://other.test/v1', gatewayKey: 'fixture-secret' }]) {
  test('rejects malformed or retargeted connection files without leaking credentials', async () => {
    const { options } = await fixture(value);
    const error = await resolveConnection(options).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('tokenFile');
    expect(error.message).not.toContain('fixture-secret');
  });
}

test('does not accept ambiguous inline and file credentials', async () => {
  const { options } = await fixture({ baseURL, gatewayKey: 'fixture-secret' });
  await expect(resolveConnection({ ...options, remote: { ...options.remote, token: 'other-secret' } })).rejects.toThrow('tokenFile');
});
