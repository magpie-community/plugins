// Native plugin registry tests use only synthetic files beneath temporary homes.
import { afterEach, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectRolePlugins, disableRolePluginsSync } from './role-plugin-state.mjs';

const id = 'local-work-model-roles-0123456789ab';
const oldID = 'local-work-model-roles-fedcba987654';
const foreignID = 'local-work-model-roles-abcdef012345';
const homes = [];
const restorers = [];
const writeJSON = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const manifest = name => ({ name, version: '1.0.0', description: 'Local Work model roles', agents: ['./agents'] });
const spy = (object, method) => {
  const mocked = spyOn(object, method);
  restorers.push(() => mocked.mockRestore());
  return mocked;
};

afterEach(() => {
  for (const restore of restorers.splice(0).reverse()) restore();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function fixture({ plugins = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-role-plugin-state-home-'));
  homes.push(home);
  const registryFile = path.join(home, 'native-home', 'plugins', 'installed.json');
  const sourceDirectory = path.join(home, 'adapter-state', 'native-model-roles');
  const options = { registryFile, sourceDirectory };
  const rootFor = name => path.join(path.dirname(registryFile), 'managed', name);
  const add = (name = id, fields = {}, content = manifest(name)) => {
    const root = rootFor(name);
    writeJSON(path.join(root, 'kimi.plugin.json'), content);
    return { id: name, root, source: 'local-path', enabled: true, originalSource: sourceDirectory, ...fields };
  };
  if (plugins) writeJSON(registryFile, { version: 1, plugins: [add()] });
  return { home, options, registryFile, sourceDirectory, rootFor, add,
    save: doc => writeJSON(registryFile, doc),
    bytes: () => fs.readFileSync(registryFile),
    staging: () => fs.readdirSync(path.dirname(registryFile)).filter(name => name.endsWith('.tmp')) };
}

function fixedConflict(action) {
  let error;
  try { action(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toBe('agent_profile_conflict');
  expect(error.code).toBe('agent_profile_conflict');
  expect(error.cause).toBeUndefined();
}

test('inspection owns enabled, disabled and orphaned-key records with exact native provenance', () => {
  const f = fixture();
  f.save({ version: 1, plugins: [f.add(), f.add(oldID, { enabled: false })] });
  expect(inspectRolePlugins(f.options)).toEqual({
    owned: [{ id, enabled: true }, { id: oldID, enabled: false }], conflicts: [],
  });
});

test('only the exact lowercase twelve-hex role-plugin id pattern is considered', () => {
  const f = fixture();
  const names = ['ordinary-plugin', 'local-work-model-roles-0123456789a',
    'local-work-model-roles-0123456789abc', 'local-work-model-roles-ABCDEF012345',
    'prefix-local-work-model-roles-0123456789ab', 'local-work-model-roles-0123456789ab-suffix'];
  f.save({ version: 1, plugins: names.map(name => ({ id: name, enabled: true })) });
  expect(inspectRolePlugins(f.options)).toEqual({ owned: [], conflicts: [] });
});

for (const [name, fields] of [
  ['non-local source', { source: 'marketplace' }],
  ['different original source', { originalSource: '/synthetic/another-adapter' }],
  ['different managed root', { root: '/synthetic/another-plugin' }],
  ['non-boolean enabled', { enabled: 'true' }],
]) {
  test(`a prefix-matching record with ${name} is a conflict and stays byte-for-byte unchanged`, () => {
    const f = fixture();
    f.save({ version: 1, plugins: [f.add(id, fields)] });
    const before = f.bytes();
    expect(inspectRolePlugins(f.options)).toEqual({ owned: [], conflicts: [id] });
    expect(disableRolePluginsSync({ ...f.options, ids: [id] })).toEqual({
      changed: false, disabled: [], owned: [], conflicts: [id],
    });
    expect(f.bytes()).toEqual(before);
  });
}

for (const [name, change] of [
  ['name', value => ({ ...value, name: oldID })],
  ['version', value => ({ ...value, version: '2.0.0' })],
  ['description', value => ({ ...value, description: 'Other roles' })],
  ['agent path', value => ({ ...value, agents: ['./different-agents'] })],
  ['non-array agent declaration', value => ({ ...value, agents: { 0: './agents', length: 1 } })],
  ['additional agent path', value => ({ ...value, agents: ['./agents', './more-agents'] })],
  ['extra hook capability', value => ({ ...value, hooks: ['./hook.mjs'] })],
  ['extra MCP capability', value => ({ ...value, mcpServers: {} })],
]) {
  test(`a managed manifest with changed ${name} is never claimed`, () => {
    const f = fixture();
    writeJSON(path.join(f.rootFor(id), 'kimi.plugin.json'), change(manifest(id)));
    expect(inspectRolePlugins(f.options)).toEqual({ owned: [], conflicts: [id] });
    const before = f.bytes();
    disableRolePluginsSync({ ...f.options, ids: [id] });
    expect(f.bytes()).toEqual(before);
  });
}

test('manifest key order and insignificant JSON whitespace do not change ownership', () => {
  const f = fixture();
  const value = manifest(id);
  writeJSON(path.join(f.rootFor(id), 'kimi.plugin.json'), {
    agents: value.agents, description: value.description, version: value.version, name: value.name,
  });
  expect(inspectRolePlugins(f.options)).toEqual({ owned: [{ id, enabled: true }], conflicts: [] });
});

test('orphaned registrations with missing managed manifests are conflicts', () => {
  const f = fixture();
  fs.rmSync(f.rootFor(id), { recursive: true });
  expect(inspectRolePlugins(f.options)).toEqual({ owned: [], conflicts: [id] });
});

test('malformed managed manifest contents are conflicts', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.rootFor(id), 'kimi.plugin.json'), '{synthetic invalid JSON');
  expect(inspectRolePlugins(f.options)).toEqual({ owned: [], conflicts: [id] });
});

for (const [name, value] of [
  ['invalid JSON', '{synthetic invalid JSON'],
  ['unsupported version', JSON.stringify({ version: 2, plugins: [] })],
  ['non-array plugins', JSON.stringify({ version: 1, plugins: {} })],
  ['non-object registry', JSON.stringify([])],
]) {
  test(`a registry with ${name} returns only the fixed conflict error`, () => {
    const f = fixture();
    fs.writeFileSync(f.registryFile, value);
    const before = f.bytes();
    fixedConflict(() => inspectRolePlugins(f.options));
    fixedConflict(() => disableRolePluginsSync({ ...f.options, ids: [id] }));
    expect(f.bytes()).toEqual(before);
    expect(f.staging()).toEqual([]);
  });
}

test('duplicate candidate ids cannot create ambiguous ownership', () => {
  const f = fixture();
  f.save({ version: 1, plugins: [f.add(), f.add(id, { source: 'foreign' })] });
  const before = f.bytes();
  expect(inspectRolePlugins(f.options)).toEqual({ owned: [], conflicts: [id] });
  disableRolePluginsSync({ ...f.options, ids: [id] });
  expect(f.bytes()).toEqual(before);
});

test('a registry symbolic link is rejected without following or replacing it', () => {
  const f = fixture();
  const outside = path.join(f.home, 'external-registry.json');
  fs.renameSync(f.registryFile, outside);
  fs.symlinkSync(outside, f.registryFile);
  const before = fs.readFileSync(outside);
  fixedConflict(() => inspectRolePlugins(f.options));
  fixedConflict(() => disableRolePluginsSync({ ...f.options, ids: [id] }));
  expect(fs.lstatSync(f.registryFile).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(outside)).toEqual(before);
});

test('nonregular registry metadata is rejected before any registry content is opened', () => {
  const f = fixture();
  const lstat = fs.lstatSync.bind(fs);
  spy(fs, 'lstatSync').mockImplementation((file, ...args) => file === f.registryFile
    ? { isFile: () => false } : lstat(file, ...args));
  const open = spy(fs, 'openSync');
  fixedConflict(() => inspectRolePlugins(f.options));
  expect(open).not.toHaveBeenCalled();
});

test('a registry changed to a symbolic link after lstat is not followed by open', () => {
  const f = fixture();
  const outside = path.join(f.home, 'external-registry.json');
  fs.copyFileSync(f.registryFile, outside);
  const open = fs.openSync.bind(fs);
  let changed = false;
  spy(fs, 'openSync').mockImplementation((file, flags, mode) => {
    if (file === f.registryFile && !changed) {
      changed = true;
      fs.unlinkSync(file);
      fs.symlinkSync(outside, file);
    }
    return open(file, flags, mode);
  });
  fixedConflict(() => inspectRolePlugins(f.options));
});

test('a managed manifest symbolic link is a conflict even when its target is valid', () => {
  const f = fixture();
  const file = path.join(f.rootFor(id), 'kimi.plugin.json');
  const outside = path.join(f.home, 'external-manifest.json');
  fs.renameSync(file, outside);
  fs.symlinkSync(outside, file);
  expect(inspectRolePlugins(f.options)).toEqual({ owned: [], conflicts: [id] });
});

for (const component of ['plugin root', 'managed directory']) {
  test(`a symbolic link at the ${component} cannot supply a trusted manifest`, () => {
    const f = fixture();
    const from = component === 'plugin root' ? f.rootFor(id) : path.dirname(f.rootFor(id));
    const outside = path.join(f.home, 'external-managed');
    fs.renameSync(from, outside);
    fs.symlinkSync(outside, from);
    expect(inspectRolePlugins(f.options)).toEqual({ owned: [], conflicts: [id] });
  });
}

test('filesystem read failures do not expose original paths or data', () => {
  const f = fixture();
  spy(fs, 'readFileSync').mockImplementation(() => {
    throw Object.assign(Error('synthetic-private-data at ' + f.registryFile), { code: 'EIO' });
  });
  fixedConflict(() => inspectRolePlugins(f.options));
});

test('disable changes only requested owned enabled fields and preserves all unrelated logical data', () => {
  const f = fixture();
  const foreign = { id: foreignID, root: '/synthetic/foreign', source: 'marketplace', enabled: true,
    originalSource: 'synthetic-foreign-source', arbitrary: { secret: 'synthetic-credential', values: [false, null, '斜线/\\'] } };
  const unselected = f.add(oldID, { arbitrary: ['keep', 42] });
  const owned = f.add(id, { installedAt: 'synthetic-date', capabilities: { agents: 1 }, unknown: ['original'] });
  const doc = { version: 1, plugins: [foreign, owned, unselected, null, { arbitrary: true }],
    futureRegistryField: { arbitrary: [1, 'two', true] } };
  f.save(doc);
  const agentFile = path.join(f.rootFor(id), 'agents', 'synthetic.md');
  fs.mkdirSync(path.dirname(agentFile));
  fs.writeFileSync(agentFile, 'synthetic native agent content\n');
  const agentBefore = fs.readFileSync(agentFile);
  const result = disableRolePluginsSync({ ...f.options, ids: [id, foreignID] });
  expect(result).toEqual({ changed: true, disabled: [id],
    owned: [{ id, enabled: false }, { id: oldID, enabled: true }], conflicts: [foreignID] });
  expect(readJSON(f.registryFile)).toEqual({ ...doc, plugins: [foreign, { ...owned, enabled: false }, unselected, null, { arbitrary: true }] });
  expect(fs.readFileSync(agentFile)).toEqual(agentBefore);
  expect(f.staging()).toEqual([]);
});

test('already disabled and unrequested owned records produce no write or byte normalization', () => {
  const f = fixture();
  f.save({ version: 1, plugins: [f.add(), f.add(oldID, { enabled: false })] });
  fs.appendFileSync(f.registryFile, '\n \t');
  const before = f.bytes();
  expect(disableRolePluginsSync({ ...f.options, ids: [oldID] })).toEqual({ changed: false, disabled: [],
    owned: [{ id, enabled: true }, { id: oldID, enabled: false }], conflicts: [] });
  expect(f.bytes()).toEqual(before);
  expect(f.staging()).toEqual([]);
});

test('a missing registry returns empty results and creates neither file nor directory', () => {
  const f = fixture({ plugins: false });
  let inspected, disabled;
  expect(() => { inspected = inspectRolePlugins(f.options); }).not.toThrow();
  expect(inspected).toEqual({ owned: [], conflicts: [] });
  expect(() => { disabled = disableRolePluginsSync({ ...f.options, ids: [id] }); }).not.toThrow();
  expect(disabled).toEqual({ changed: false, disabled: [], owned: [], conflicts: [] });
  expect(fs.existsSync(path.dirname(f.registryFile))).toBe(false);
});

test('required caller paths and selected-id lists reject malformed input with the fixed error', () => {
  const f = fixture();
  for (const options of [{ registryFile: f.registryFile }, { ...f.options, sourceDirectory: '' },
    { ...f.options, registryFile: null }]) fixedConflict(() => inspectRolePlugins(options));
  fixedConflict(() => disableRolePluginsSync({ ...f.options, ids: id }));
});

test('absent or null options never escape as a native destructuring error', () => {
  for (const options of [undefined, null]) {
    fixedConflict(() => inspectRolePlugins(options));
    fixedConflict(() => disableRolePluginsSync(options));
  }
});

for (const kind of ['logical edit', 'whitespace-only edit', 'deletion', 'symbolic link']) {
  test(`CAS preserves an external ${kind} made while the private staging file is written`, () => {
    const f = fixture();
    const original = f.bytes();
    const outside = path.join(f.home, 'external-registry.json');
    fs.writeFileSync(outside, original);
    const concurrent = kind === 'whitespace-only edit' ? Buffer.concat([original, Buffer.from('\n')])
      : Buffer.from(JSON.stringify({ ...readJSON(f.registryFile), concurrent: 'synthetic external edit' }));
    const write = fs.writeFileSync.bind(fs);
    let changed = false;
    spy(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      const result = write(file, ...args);
      if (typeof file === 'number' && !changed) {
        changed = true;
        if (kind === 'deletion' || kind === 'symbolic link') {
          fs.unlinkSync(f.registryFile);
          if (kind === 'symbolic link') fs.symlinkSync(outside, f.registryFile);
        } else write(f.registryFile, concurrent);
      }
      return result;
    });
    fixedConflict(() => disableRolePluginsSync({ ...f.options, ids: [id] }));
    expect(changed).toBe(true);
    if (kind === 'deletion') expect(fs.existsSync(f.registryFile)).toBe(false);
    else if (kind === 'symbolic link') {
      expect(fs.lstatSync(f.registryFile).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(outside)).toEqual(original);
    } else expect(f.bytes()).toEqual(concurrent);
    expect(f.staging()).toEqual([]);
  });
}

test('a failed staging write removes the partial private file and preserves the registry', () => {
  const f = fixture();
  const before = f.bytes();
  const write = fs.writeFileSync.bind(fs);
  spy(fs, 'writeFileSync').mockImplementation((file, ...args) => {
    if (typeof file === 'number') {
      write(file, 'partial synthetic content');
      throw Error('synthetic-private-data stage failure');
    }
    return write(file, ...args);
  });
  fixedConflict(() => disableRolePluginsSync({ ...f.options, ids: [id] }));
  expect(f.bytes()).toEqual(before);
  expect(f.staging()).toEqual([]);
});

test('a failed atomic rename removes staging without modifying the registry', () => {
  const f = fixture();
  const before = f.bytes();
  spy(fs, 'renameSync').mockImplementation(() => { throw Error('synthetic-private-data rename failure'); });
  fixedConflict(() => disableRolePluginsSync({ ...f.options, ids: [id] }));
  expect(f.bytes()).toEqual(before);
  expect(f.staging()).toEqual([]);
});

test('published registry bytes come from a private mode-0600 staging file', () => {
  const f = fixture();
  const open = fs.openSync.bind(fs);
  let mode;
  spy(fs, 'openSync').mockImplementation((file, flags, permissions) => {
    const descriptor = open(file, flags, permissions);
    if (typeof file === 'string' && file.endsWith('.tmp')) mode = fs.fstatSync(descriptor).mode & 0o777;
    return descriptor;
  });
  disableRolePluginsSync({ ...f.options, ids: [id] });
  expect(mode).toBe(0o600);
  expect(fs.statSync(f.registryFile).mode & 0o777).toBe(0o600);
});

test('exclusive staging creation preserves another writer\'s colliding temporary file', () => {
  const f = fixture();
  const before = f.bytes();
  const open = fs.openSync.bind(fs);
  let collision;
  spy(fs, 'openSync').mockImplementation((file, flags, mode) => {
    if (typeof file === 'string' && file.endsWith('.tmp')) {
      collision = file;
      fs.writeFileSync(file, 'synthetic other writer', { flag: 'wx' });
    }
    return open(file, flags, mode);
  });
  fixedConflict(() => disableRolePluginsSync({ ...f.options, ids: [id] }));
  expect(f.bytes()).toEqual(before);
  expect(fs.existsSync(collision)).toBe(true);
  expect(fs.readFileSync(collision, 'utf8')).toBe('synthetic other writer');
});
