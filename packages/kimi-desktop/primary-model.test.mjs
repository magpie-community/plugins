import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { setPrimaryModel } from './primary-model.mjs';

const runFile = promisify(execFile);
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kimi primary cli '));
const environment = directory => ({ ...process.env, HOME: directory, USERPROFILE: directory,
  CFFIXED_USER_HOME: directory, XDG_CONFIG_HOME: path.join(directory, '.config') });
const fakeExecutable = (directory, name) => {
  const executable = path.join(directory, name);
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, '', { mode: 0o700 });
  return executable;
};

test('the official primary argv inherits the host environment and its nested plugin skips adapter startup', async () => {
  const directory = temporary();
  const observation = path.join(directory, 'observed.json');
  const calls = [];
  const env = { ...environment(directory), KIMI_PRIMARY_TEST_MARKER: 'same-profile',
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

test('mac parent discovery preserves directory spaces and a case-insensitive Magpie name before PATH', async () => {
  const directory = temporary();
  const executable = fakeExecutable(directory, 'Magpie directory with spaces/MaGpIe');
  const calls = [];
  try {
    await setPrimaryModel('example/main', { directory, env: environment(directory), platform: 'darwin', parentPID: 123,
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

test('a shell parent is unavailable and is never invoked as the primary setter', async () => {
  const directory = temporary();
  const calls = [];
  let error;
  try {
    try {
      await setPrimaryModel('example/main', { directory, env: environment(directory),
        platform: 'darwin', parentPID: 123, which: () => null,
        run: async (file, args, options) => {
          calls.push({ file, args, options });
          return { stdout: file === '/bin/ps' ? '/bin/sh\n' : '' };
        },
      });
    } catch (caught) { error = caught; }
    expect(calls.map(call => call.file)).toEqual(['/bin/ps']);
    expect(error?.code).toBe('primary_model_unavailable');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a shell returned by PATH discovery is unavailable and is never invoked', async () => {
  const directory = temporary();
  const calls = [], names = [];
  let error;
  try {
    try {
      await setPrimaryModel('example/main', { directory, env: environment(directory), platform: 'unsupported',
        which: name => { names.push(name); return '/bin/sh'; },
        run: async (file, args) => { calls.push({ file, args }); return { stdout: '' }; },
      });
    } catch (caught) { error = caught; }
    expect(names).toEqual(['magpie']);
    expect(calls).toEqual([]);
    expect(error?.code).toBe('primary_model_unavailable');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('automatic discovery refuses the Bun executor, including a magpie symlink to it', async () => {
  const directory = temporary();
  const runtime = fakeExecutable(directory, 'magpie-bun');
  const link = path.join(directory, 'magpie');
  fs.symlinkSync(runtime, link);
  const calls = [];
  try {
    for (const found of [runtime, link]) {
      let error;
      try {
        await setPrimaryModel('example/main', { directory, env: environment(directory), platform: 'unsupported',
          which: () => found,
          run: async (file, args) => { calls.push({ file, args }); return { stdout: '' }; },
        });
      } catch (caught) { error = caught; }
      expect(calls).toEqual([]);
      expect(error?.code).toBe('primary_model_unavailable');
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Windows discovers its Magpie parent through CIM before PATH and keeps its profile', async () => {
  const directory = temporary();
  const executable = fakeExecutable(directory, 'Magpie directory with spaces/mAgPiE.ExE');
  const env = { ...environment(directory), KIMI_PRIMARY_TEST_MARKER: 'windows-profile' };
  const calls = [];
  try {
    await setPrimaryModel('example/main', { directory, env, platform: 'win32', parentPID: 456,
      which: () => { throw Error('PATH should not be consulted'); },
      run: async (file, args, options) => {
        calls.push({ file, args, options });
        return { stdout: file.toLowerCase() === 'powershell.exe' ? '  ' + executable + '\r\n' : '' };
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].file.toLowerCase()).toBe('powershell.exe');
    expect(calls[0].args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
    expect(calls[0].args).toHaveLength(5);
    expect(calls[0].args[4]).toContain("Get-CimInstance Win32_Process -Filter 'ProcessId=456'");
    expect(calls[0].args[4]).toContain('.ExecutablePath');
    expect(calls[0].args[4]).toContain('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8');
    expect(calls[0].options).toMatchObject({ cwd: directory, env,
      timeout: 6000, encoding: 'utf8', windowsHide: true });
    expect(calls[1].file).toBe(fs.realpathSync(executable));
    expect(calls[1].args).toEqual(['kimi-desktop', 'model', 'magpie/example/main']);
    expect(calls[1].options).toMatchObject({ cwd: directory, timeout: 60000, windowsHide: true,
      env: { ...env, MAGPIE_KIMI_SKIP_ADAPTER: '1' } });
    expect(env.MAGPIE_KIMI_SKIP_ADAPTER).toBeUndefined();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('unavailable Windows parent discovery falls back to a Magpie PATH executable', async () => {
  const directory = temporary();
  const executable = fakeExecutable(directory, 'portable directory/Magpie.exe');
  const calls = [], names = [];
  try {
    await setPrimaryModel('example/main', { directory, env: environment(directory), platform: 'win32', parentPID: 456,
      which: name => { names.push(name); return executable; },
      run: async (file, args, options) => {
        calls.push({ file, args, options });
        if (file.toLowerCase() === 'powershell.exe') throw Error('synthetic PowerShell unavailable');
        return { stdout: '' };
      },
    });
    expect(names).toEqual(['magpie']);
    expect(calls.map(call => call.file)).toEqual(['powershell.exe', fs.realpathSync(executable)]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a nonnumeric parent PID is never placed in a discovery command', async () => {
  const directory = temporary();
  const executable = fakeExecutable(directory, 'magpie.exe');
  const calls = [];
  try {
    await setPrimaryModel('example/main', { directory, env: environment(directory), platform: 'win32',
      parentPID: "456'; Write-Output unsafe; '", which: () => executable,
      run: async (file, args, options) => { calls.push({ file, args, options }); return { stdout: '' }; },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe(fs.realpathSync(executable));
    expect(calls[0].args).toEqual(['kimi-desktop', 'model', 'magpie/example/main']);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('missing executables and failed CLI updates return only fixed error codes', async () => {
  const directory = temporary();
  const env = environment(directory);
  try {
    await expect(setPrimaryModel('example/main', { magpiePath: './relative-magpie', directory, env }))
      .rejects.toHaveProperty('code', 'primary_model_unavailable');
    await expect(setPrimaryModel('example/main', { platform: 'unsupported', which: () => null, directory, env }))
      .rejects.toHaveProperty('code', 'primary_model_unavailable');
    let error;
    try {
      await setPrimaryModel('example/main', { magpiePath: process.execPath, directory, env,
        run: async () => { throw Object.assign(Error('synthetic private stderr'), { stderr: 'synthetic private stderr' }); },
      });
    } catch (caught) { error = caught; }
    expect(error.code).toBe('primary_model_update_failed');
    expect(error.message).toBe('primary_model_update_failed');
    expect(error.cause).toBeUndefined();
    expect(error.stderr).toBeUndefined();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
