import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { setPrimaryModel } from './primary-model.mjs';

const runFile = promisify(execFile);
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kimi primary cli '));

test('the official primary argv inherits the host environment and its nested plugin skips adapter startup', async () => {
  const directory = temporary();
  const observation = path.join(directory, 'observed.json');
  const calls = [];
  const env = { ...process.env, HOME: directory, USERPROFILE: directory, CFFIXED_USER_HOME: directory,
    XDG_CONFIG_HOME: path.join(directory, '.config'), KIMI_PRIMARY_TEST_MARKER: 'same-profile',
    KIMI_PRIMARY_TEST_OBSERVATION: observation };
  delete env.MAGPIE_KIMI_SKIP_ADAPTER;
  const before = process.env.MAGPIE_KIMI_SKIP_ADAPTER;
  // Bun acts as the fake CLI executable and runs its fixed first argument as
  // this temporary script. No real Magpie executable or profile is invoked.
  fs.writeFileSync(path.join(directory, 'kimi-desktop'), `
    import fs from 'node:fs';
    const { default: plugin } = await import(${JSON.stringify(new URL('./index.mjs', import.meta.url).href)});
    await plugin({ directory: process.cwd() });
    fs.writeFileSync(process.env.KIMI_PRIMARY_TEST_OBSERVATION, JSON.stringify({
      args: process.argv.slice(2), cwd: process.cwd(), home: process.env.HOME,
      marker: process.env.KIMI_PRIMARY_TEST_MARKER, skip: process.env.MAGPIE_KIMI_SKIP_ADAPTER,
      adapterStarted: Boolean(globalThis[Symbol.for('magpie.kimi-desktop.adapter.v1')]),
    }));
  `);
  try {
    await setPrimaryModel('example/main', { magpiePath: process.execPath, directory, env,
      run: (file, args, options) => { calls.push({ file, args, timeout: options.timeout }); return runFile(file, args, options); },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['kimi-desktop', 'model', 'magpie/example/main']);
    expect(calls[0].timeout).toBe(60000);
    expect(JSON.parse(fs.readFileSync(observation, 'utf8'))).toEqual({
      args: ['model', 'magpie/example/main'], cwd: fs.realpathSync(directory), home: directory,
      marker: 'same-profile', skip: '1', adapterStarted: false,
    });
    expect(env.MAGPIE_KIMI_SKIP_ADAPTER).toBeUndefined();
    expect(process.env.MAGPIE_KIMI_SKIP_ADAPTER).toBe(before);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('mac parent discovery preserves executable path spaces before using PATH', async () => {
  const directory = temporary();
  const executable = path.join(directory, 'Magpie with spaces');
  fs.writeFileSync(executable, '', { mode: 0o700 });
  const calls = [];
  try {
    await setPrimaryModel('example/main', { directory, platform: 'darwin', parentPID: 123,
      which: () => { throw Error('PATH should not be consulted'); },
      run: async (file, args, options) => {
        calls.push({ file, args, options });
        return file === '/bin/ps' ? { stdout: '  ' + executable + '\n' } : { stdout: 'ignored' };
      },
    });
    expect(calls[0].args).toEqual(['-ww', '-p', '123', '-o', 'comm=']);
    expect(calls[1].file).toBe(fs.realpathSync(executable));
    expect(calls[1].options.cwd).toBe(directory);
    expect(calls[1].options.env.MAGPIE_KIMI_SKIP_ADAPTER).toBe('1');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('missing executables and failed CLI updates return only fixed error codes', async () => {
  await expect(setPrimaryModel('example/main', { magpiePath: './relative-magpie' }))
    .rejects.toHaveProperty('code', 'primary_model_unavailable');
  await expect(setPrimaryModel('example/main', { platform: 'unsupported', which: () => null }))
    .rejects.toHaveProperty('code', 'primary_model_unavailable');
  let error;
  try {
    await setPrimaryModel('example/main', { magpiePath: process.execPath,
      run: async () => { throw Object.assign(Error('synthetic private stderr'), { stderr: 'synthetic private stderr' }); },
    });
  } catch (caught) { error = caught; }
  expect(error.code).toBe('primary_model_update_failed');
  expect(error.message).toBe('primary_model_update_failed');
  expect(error.cause).toBeUndefined();
  expect(error.stderr).toBeUndefined();
});
