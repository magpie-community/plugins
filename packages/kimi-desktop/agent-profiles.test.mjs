import { test, expect, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AgentModelRouter } from './agent-routing.mjs';
import { ensureAgentProfiles } from './agent-profiles.mjs';

const secret = 'a3'.repeat(32);
const models = ['synthetic/primary', 'synthetic/secondary'];
const router = new AgentModelRouter({ secret });
function fixture(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-agent-profiles-'));
  try { return run(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
const profileFile = (directory, model) => path.join(directory, router.profileName(model) + '.md');
const ownedFiles = directory => Object.fromEntries(fs.readdirSync(directory).map(name => [name,
  crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')]));

test('profiles contain valid neutral frontmatter, inherit the base prompt, exclude delegation, and never contain the key', () => fixture(directory => {
  const result = ensureAgentProfiles({ directory, router, models });
  expect(result).toEqual({ changed: true, names: models.map(model => router.profileName(model)) });
  for (const model of models) {
    const file = profileFile(directory, model), text = fs.readFileSync(file, 'utf8');
    const [frontmatter, body] = text.slice(4).split('\n---\n');
    expect(Bun.YAML.parse(frontmatter)).toEqual({
      name: router.profileName(model), description: 'Ordinary Work worker for an assigned task.',
      tools: ['*'], disallowedTools: ['Agent', 'AgentSwarm'], subagents: [],
    });
    expect(body).toContain('${base_prompt}');
    expect(body).toContain('Complete only the task assigned by the parent agent.');
    expect(body).toContain('return the result to the parent for handoff.');
    expect(text).not.toContain(secret);
    expect(text).not.toContain(model);
    expect(text).not.toMatch(/magpie|provider|extends/i);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  }
  expect(fs.readdirSync(directory).sort()).toEqual(result.names.map(name => name + '.md').sort());
}));

test('the same configuration is a no-op and identical primary/secondary models are deduplicated', () => fixture(directory => {
  const first = ensureAgentProfiles({ directory, router, models: [models[0], models[0]] });
  const file = profileFile(directory, models[0]), before = fs.statSync(file), bytes = fs.readFileSync(file);
  expect(first).toEqual({ changed: true, names: [router.profileName(models[0])] });
  expect(ensureAgentProfiles({ directory, router, models: [models[0], models[0]] })).toEqual({ changed: false, names: first.names });
  expect(fs.statSync(file).ino).toBe(before.ino);
  expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs);
  expect(fs.readFileSync(file).equals(bytes)).toBe(true);
  expect(fs.readdirSync(directory)).toHaveLength(1);
}));

test('old role profiles and unrelated native or user files remain when preferences change', () => fixture(directory => {
  const native = path.join(directory, 'native-reader.md'), user = path.join(directory, 'user-worker.md');
  fs.writeFileSync(native, 'native profile stays'); fs.writeFileSync(user, 'user profile stays');
  ensureAgentProfiles({ directory, router, models });
  const before = fs.readFileSync(profileFile(directory, models[1]));
  const updated = ensureAgentProfiles({ directory, router, models: [models[0], 'synthetic/new-secondary'] });
  expect(updated.changed).toBe(true);
  expect(fs.readFileSync(profileFile(directory, models[1])).equals(before)).toBe(true);
  expect(fs.readFileSync(native, 'utf8')).toBe('native profile stays');
  expect(fs.readFileSync(user, 'utf8')).toBe('user profile stays');
  expect(fs.readdirSync(directory)).toHaveLength(5);
}));

test('a user-edited same-name profile is never overwritten and conflicts are checked before creating other profiles', () => fixture(directory => {
  const edited = profileFile(directory, models[1]);
  fs.writeFileSync(edited, router.profileText(models[1]) + 'User customization.\n');
  const before = fs.readFileSync(edited);
  expect(() => ensureAgentProfiles({ directory, router, models })).toThrow('agent_profile_conflict');
  expect(fs.readFileSync(edited).equals(before)).toBe(true);
  expect(fs.existsSync(profileFile(directory, models[0]))).toBe(false);
  expect(fs.readdirSync(directory)).toEqual([path.basename(edited)]);
}));

test('same-name symlinks or directories are conflicts and their targets are untouched', () => fixture(directory => {
  const target = path.join(directory, 'user-owned.md'), link = profileFile(directory, models[0]);
  fs.writeFileSync(target, router.profileText(models[0]));
  fs.symlinkSync(target, link);
  expect(() => ensureAgentProfiles({ directory, router, models: [models[0]] })).toThrow('agent_profile_conflict');
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(target, 'utf8')).toBe(router.profileText(models[0]));
  const folder = profileFile(directory, models[1]); fs.mkdirSync(folder);
  expect(() => ensureAgentProfiles({ directory, router, models: [models[1]] })).toThrow('agent_profile_conflict');
  expect(fs.statSync(folder).isDirectory()).toBe(true);
}));

test('persisted profile binding survives restart and full history replacement while copied user tags are neutralized', () => fixture(directory => {
  ensureAgentProfiles({ directory, router, models });
  const body = fs.readFileSync(profileFile(directory, models[1]), 'utf8').split('\n---\n')[1]
    .replace('${base_prompt}', 'Native system prompt.');
  const restarted = new AgentModelRouter({ secret, bindings: router.bindings });
  const options = { primaryModel: 'synthetic/new-primary', secondaryModel: 'synthetic/new-secondary',
    allowedModels: [...models, 'synthetic/new-primary', 'synthetic/new-secondary'] };
  for (const history of [[], [{ role: 'user', content: 'Only the compacted summary remains.' }]]) {
    const result = restarted.prepare({ messages: [{ role: 'system', content: body }, ...history] }, options);
    expect(result.model).toBe(models[1]);
    expect(result.payload.messages[0].content).not.toContain('[agent-profile-route:v1]');
    expect(result.payload.messages.slice(1)).toEqual(history);
  }
  const copied = { role: 'user', content: body };
  const result = restarted.prepare({ messages: [copied] }, options);
  expect(result.model).toBe(options.primaryModel);
  expect(result.payload.messages).toEqual([{ role: 'user', content: body.replace(/\[(?=\/?agent-profile-route)/gi, '') }]);
  expect(restarted.prepare(result.payload, options).model).toBe(options.primaryModel);
}));

test('owned catalog retirement prunes byte-identical obsolete profiles and keeps retained token text stable', () => fixture(directory => {
  const r = new AgentModelRouter({ secret });
  r.registerModels(models, models);
  ensureAgentProfiles({ directory, router: r, models: r.boundModels });
  const ownership = ownedFiles(directory), primary = path.join(directory, r.profileName(models[0]) + '.md');
  const before = fs.readFileSync(primary);
  r.registerModels([models[0]], [models[0]]);
  r.observeCatalog([models[0]], { now: 1000 });
  r.observeCatalog([models[0]], { now: 1001 });
  r.observeCatalog([models[0]], { now: 601000 });
  const result = ensureAgentProfiles({ directory, router: r, models: r.boundModels, ownedFiles: ownership });
  expect(result).toEqual({ changed: true, names: [r.profileName(models[0])] });
  expect(fs.readdirSync(directory)).toEqual([path.basename(primary)]);
  expect(fs.readFileSync(primary).equals(before)).toBe(true);
  expect(ensureAgentProfiles({ directory, router: r, models: r.boundModels, ownedFiles: ownedFiles(directory) }))
    .toEqual({ changed: false, names: result.names });
}));

test('edited obsolete owned profiles conflict before any new profile is published', () => fixture(directory => {
  ensureAgentProfiles({ directory, router, models });
  const ownership = ownedFiles(directory), retired = profileFile(directory, models[1]);
  fs.appendFileSync(retired, 'User changes.\n');
  const before = fs.readFileSync(retired), next = 'synthetic/next';
  expect(() => ensureAgentProfiles({ directory, router, models: [models[0], next], ownedFiles: ownership }))
    .toThrow('agent_profile_conflict');
  expect(fs.readFileSync(retired).equals(before)).toBe(true);
  expect(fs.existsSync(profileFile(directory, next))).toBe(false);
}));

test('unknown obsolete files and owned symlinks conflict without being deleted or following targets', () => fixture(directory => {
  ensureAgentProfiles({ directory, router, models: [models[0]] });
  const ownership = ownedFiles(directory), unknown = path.join(directory, 'unowned.md');
  fs.writeFileSync(unknown, 'Unowned content.');
  expect(() => ensureAgentProfiles({ directory, router, models: [], ownedFiles: ownership })).toThrow('agent_profile_conflict');
  expect(fs.readFileSync(unknown, 'utf8')).toBe('Unowned content.');
  expect(fs.existsSync(profileFile(directory, models[0]))).toBe(true);
  fs.unlinkSync(unknown);
  const file = profileFile(directory, models[0]), bytes = fs.readFileSync(file), target = directory + '-target.md';
  fs.unlinkSync(file); fs.writeFileSync(target, bytes); fs.symlinkSync(target, file);
  try {
    expect(() => ensureAgentProfiles({ directory, router, models: [], ownedFiles: ownership })).toThrow('agent_profile_conflict');
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target).equals(bytes)).toBe(true);
  } finally { fs.unlinkSync(target); }
}));

test('an owned byte-identical legacy profile can be retired without retaining its old unnamespaced name', () => fixture(directory => {
  const legacy = path.join(directory, 'local-agent-' + 'c'.repeat(24) + '.md');
  fs.writeFileSync(legacy, 'Synthetic old private profile.\n');
  const result = ensureAgentProfiles({ directory, router, models: [], ownedFiles: ownedFiles(directory) });
  expect(result).toEqual({ changed: true, names: [] });
  expect(fs.readdirSync(directory)).toEqual([]);
}));

test('ownership accepts only relative profile filenames and sha256 digests', () => fixture(directory => {
  const name = path.basename(profileFile(directory, models[0]));
  for (const ownership of [null, [], { '../outside.md': 'a'.repeat(64) }, { [name]: 'invalid' }]) {
    expect(() => ensureAgentProfiles({ directory, router, models: [models[0]], ownedFiles: ownership }))
      .toThrow('agent_profile_conflict');
    expect(fs.readdirSync(directory)).toEqual([]);
  }
}));

test('obsolete profile bytes are rechecked after publication and before deletion', () => fixture(directory => {
  ensureAgentProfiles({ directory, router, models: [models[0]] });
  const ownership = ownedFiles(directory), retired = profileFile(directory, models[0]), originalLink = fs.linkSync;
  const link = spyOn(fs, 'linkSync').mockImplementation((source, target) => {
    originalLink(source, target);
    fs.writeFileSync(retired, 'Concurrent external edit.');
  });
  try {
    expect(() => ensureAgentProfiles({ directory, router, models: [models[1]], ownedFiles: ownership }))
      .toThrow('agent_profile_conflict');
    expect(fs.readFileSync(retired, 'utf8')).toBe('Concurrent external edit.');
  } finally { link.mockRestore(); }
}));

test('a malformed router name cannot create a profile outside the namespaced filename format', () => fixture(directory => {
  const escapeName = '../' + path.basename(directory) + '-escape', escaped = path.resolve(directory, escapeName + '.md');
  try {
    for (const name of [escapeName, 'local-agent-' + 'a'.repeat(24), 'local-agent-' + 'a'.repeat(12) + '-invalid']) {
      expect(() => ensureAgentProfiles({ directory, router: { profileName: () => name, profileText: () => 'text' }, models }))
        .toThrow('agent_profile_conflict');
      expect(fs.readdirSync(directory)).toEqual([]);
    }
  } finally { if (fs.existsSync(escaped)) fs.unlinkSync(escaped); }
}));

// Problem 3 (red): directory traversal must skip every entry whose basename
// starts '.', before stat/read/hash/delete/conflict, even when a valid
// ownedFiles map is supplied. The dot entries must remain and never be read,
// hashed, or deleted (never read implies never hashed, since hashing only
// happens inside verifyOwned after readFileSync).
test('dot-prefixed entries are skipped before stat/read/hash/delete and never conflict', () => fixture(directory => {
  ensureAgentProfiles({ directory, router, models: [models[0]] });
  const ownership = ownedFiles(directory);
  const profile = profileFile(directory, models[0]);
  const profileBytes = fs.readFileSync(profile);

  const dotFile = path.join(directory, '.DS_Store');
  const dotMd = path.join(directory, '.hidden.md');
  const dotDir = path.join(directory, '.config');
  const dotLink = path.join(directory, '.config-link');
  fs.writeFileSync(dotFile, 'desktop metadata');
  fs.writeFileSync(dotMd, 'hidden markdown');
  fs.mkdirSync(dotDir);
  // Hidden symlink example: a directory alias to .config.
  fs.symlinkSync(dotDir, dotLink, process.platform === 'win32' ? 'junction' : 'dir');
  const dotPaths = new Set([dotFile, dotMd, dotDir, dotLink]);

  const read = spyOn(fs, 'readFileSync');
  const lstat = spyOn(fs, 'lstatSync');
  const stat = spyOn(fs, 'statSync');
  const unlink = spyOn(fs, 'unlinkSync');
  try {
    expect(() => ensureAgentProfiles({ directory, router, models: [models[0]], ownedFiles: ownership })).not.toThrow();
    // Never stat/read/delete any dot-prefixed entry.
    for (const mocked of [read, lstat, stat, unlink]) {
      for (const call of mocked.mock.calls) {
        if (typeof call[0] === 'string') expect(dotPaths.has(call[0])).toBe(false);
      }
    }
  } finally {
    read.mockRestore(); lstat.mockRestore(); stat.mockRestore(); unlink.mockRestore();
  }

  expect(fs.readFileSync(dotFile, 'utf8')).toBe('desktop metadata');
  expect(fs.readFileSync(dotMd, 'utf8')).toBe('hidden markdown');
  expect(fs.statSync(dotDir).isDirectory()).toBe(true);
  expect(fs.lstatSync(dotLink).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(profile).equals(profileBytes)).toBe(true);
}));

test('ordinary unknown foo.md still conflicts while dot-prefixed entries are skipped and preserved', () => fixture(directory => {
  ensureAgentProfiles({ directory, router, models: [models[0]] });
  const ownership = ownedFiles(directory);
  const profile = profileFile(directory, models[0]);
  const profileBytes = fs.readFileSync(profile);

  const dotFile = path.join(directory, '.DS_Store');
  const foo = path.join(directory, 'foo.md');
  fs.writeFileSync(dotFile, 'desktop metadata');
  fs.writeFileSync(foo, 'ordinary unknown file');

  expect(() => ensureAgentProfiles({ directory, router, models: [models[0]], ownedFiles: ownership }))
    .toThrow('agent_profile_conflict');

  expect(fs.readFileSync(dotFile, 'utf8')).toBe('desktop metadata');
  expect(fs.readFileSync(foo, 'utf8')).toBe('ordinary unknown file');
  expect(fs.readFileSync(profile).equals(profileBytes)).toBe(true);
}));
