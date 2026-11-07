import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROLE_ID = /^local-work-model-roles-[a-f0-9]{12}$/;
const conflict = () => Object.assign(Error('agent_profile_conflict'), { code: 'agent_profile_conflict' });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function readRegularBytes(file, missing = false) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (missing && error.code === 'ENOENT') return null; throw error; }

  if (!stat.isFile()) throw conflict();

  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { return fs.readFileSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function declarativeManifest(registryFile, id) {
  const managed = path.join(path.dirname(registryFile), 'managed');
  const root = path.join(managed, id);
  try {

    if (!fs.lstatSync(managed).isDirectory() || !fs.lstatSync(root).isDirectory()) return false;
    const value = JSON.parse(readRegularBytes(path.join(root, 'kimi.plugin.json')).toString('utf8'));

    return record(value) && Object.keys(value).length === 4
      && value.name === id && value.version === '1.0.0' && value.description === 'Local Work model roles'
      && Array.isArray(value.agents) && value.agents.length === 1 && value.agents[0] === './agents';
  } catch { return false; }
}

// Exact string equality keeps deleted-source recovery: the caller's literal
// source path is trusted without any existence check. Only different paths
// require a proven existing-directory equivalence.
function canonicalDirectory(file) {
  try {
    const canonical = fs.realpathSync(file);
    // A file (or a symlink resolving to a file) is never directory equivalence.
    return fs.statSync(canonical).isDirectory() ? canonical : null;
  } catch { return null; }
}

function sourceMatches(sourceDirectory, originalSource) {
  if (originalSource === sourceDirectory) return true;
  const a = canonicalDirectory(sourceDirectory), b = canonicalDirectory(originalSource);
  return a !== null && b !== null && a === b;
}

function rootMatches(registryFile, id, entryRoot) {
  const expectedRoot = path.join(path.dirname(registryFile), 'managed', id);
  if (entryRoot === expectedRoot) return true;
  try {
    // Ancestor aliases are allowed, but a direct symlink at the persisted root
    // or at its immediate managed parent is never trusted.
    if (!fs.lstatSync(entryRoot).isDirectory()) return false;
    if (!fs.lstatSync(path.dirname(entryRoot)).isDirectory()) return false;
    // Canonical WHOLE-root equality: a sibling directory under the same managed
    // parent (or any other physical root) is never accepted.
    return fs.realpathSync(entryRoot) === fs.realpathSync(expectedRoot);
  } catch { return false; }
}

function snapshot({ registryFile, sourceDirectory }) {

  if (typeof registryFile !== 'string' || !registryFile || typeof sourceDirectory !== 'string' || !sourceDirectory) {
    throw conflict();
  }
  const bytes = readRegularBytes(registryFile, true);

  if (bytes === null) return { bytes, document: null, entries: [], conflicts: [] };
  const document = JSON.parse(bytes.toString('utf8'));

  if (!record(document) || document.version !== 1 || !Array.isArray(document.plugins)) throw conflict();

  const candidates = document.plugins.filter(entry => record(entry) && typeof entry.id === 'string' && ROLE_ID.test(entry.id));
  const counts = new Map();
  for (const entry of candidates) counts.set(entry.id, (counts.get(entry.id) || 0) + 1);
  const entries = [], conflicts = [];
  for (const entry of candidates) {

    if (counts.get(entry.id) !== 1

        || entry.source !== 'local-path' || !sourceMatches(sourceDirectory, entry.originalSource)
        || !rootMatches(registryFile, entry.id, entry.root)
        || typeof entry.enabled !== 'boolean' || !declarativeManifest(registryFile, entry.id)) {
      if (!conflicts.includes(entry.id)) conflicts.push(entry.id);
    } else entries.push(entry);
  }
  return { bytes, document, entries, conflicts };
}

const inspection = saved => ({
  owned: saved.entries.map(({ id, enabled }) => ({ id, enabled })), conflicts: saved.conflicts,
});

/** Discover role plugins from caller-supplied native paths; perform no RPC. */
export function inspectRolePlugins(options) {
  try { return inspection(snapshot(options)); }

  catch { throw conflict(); }
}

function publish(registryFile, bytes, expected) {
  const temp = registryFile + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  let created = false;
  try {


    const descriptor = fs.openSync(temp, 'wx', 0o600);
    created = true;
    try { fs.writeFileSync(descriptor, bytes); }
    finally { fs.closeSync(descriptor); }
    const current = readRegularBytes(registryFile, true);

    if (current === null || !current.equals(expected)) throw conflict();
    fs.renameSync(temp, registryFile);
  } finally {


    if (created) { try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
}

/** Disable only selected owned registrations. Disk state does not acknowledge
 * a loaded Kimi session: the caller retains its pending runtime-refresh work. */
export function disableRolePluginsSync(options) {
  try {
    const { registryFile, sourceDirectory, ids = [] } = options;

    if (!Array.isArray(ids)) throw conflict();
    const saved = snapshot({ registryFile, sourceDirectory });
    const selected = new Set(ids), disabled = [];
    for (const entry of saved.entries) {

      if (selected.has(entry.id) && entry.enabled) {
        entry.enabled = false;
        disabled.push(entry.id);
      }
    }

    if (disabled.length) publish(registryFile, Buffer.from(JSON.stringify(saved.document, null, 2) + '\n'), saved.bytes);
    return { changed: disabled.length > 0, disabled, ...inspection(saved) };

  } catch { throw conflict(); }
}
