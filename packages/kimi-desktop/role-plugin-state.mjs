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
  // MUTATION registry-file-type: remove this check; registry symlink test fails.
  if (!stat.isFile()) throw conflict();
  // MUTATION no-follow: remove O_NOFOLLOW; post-lstat symlink race test fails.
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { return fs.readFileSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function declarativeManifest(registryFile, id) {
  const managed = path.join(path.dirname(registryFile), 'managed');
  const root = path.join(managed, id);
  try {
    // MUTATION managed-directories: remove this check; managed-root symlink tests fail.
    if (!fs.lstatSync(managed).isDirectory() || !fs.lstatSync(root).isDirectory()) return false;
    const value = JSON.parse(readRegularBytes(path.join(root, 'kimi.plugin.json')).toString('utf8'));
    // MUTATION manifest-capabilities: remove the key count; extra-capability tests fail.
    return record(value) && Object.keys(value).length === 4
      && value.name === id && value.version === '1.0.0' && value.description === 'Local Work model roles'
      && Array.isArray(value.agents) && value.agents.length === 1 && value.agents[0] === './agents';
  } catch { return false; }
}

function snapshot({ registryFile, sourceDirectory }) {
  // MUTATION caller-paths: remove this check; malformed caller-path tests fail.
  if (typeof registryFile !== 'string' || !registryFile || typeof sourceDirectory !== 'string' || !sourceDirectory) {
    throw conflict();
  }
  const bytes = readRegularBytes(registryFile, true);
  // MUTATION missing-registry: remove this return; missing-registry test fails.
  if (bytes === null) return { bytes, document: null, entries: [], conflicts: [] };
  const document = JSON.parse(bytes.toString('utf8'));
  // MUTATION registry-schema: remove this check; unsupported-version/shape tests fail.
  if (!record(document) || document.version !== 1 || !Array.isArray(document.plugins)) throw conflict();
  // MUTATION candidate-id: replace ROLE_ID.test with true; exact-id-pattern test fails.
  const candidates = document.plugins.filter(entry => record(entry) && typeof entry.id === 'string' && ROLE_ID.test(entry.id));
  const counts = new Map();
  for (const entry of candidates) counts.set(entry.id, (counts.get(entry.id) || 0) + 1);
  const entries = [], conflicts = [];
  for (const entry of candidates) {
    // MUTATION duplicate-id: remove the count check; duplicate-id test fails.
    if (counts.get(entry.id) !== 1
        // MUTATION provenance: remove a condition; matching source/root conflict test fails.
        || entry.source !== 'local-path' || entry.originalSource !== sourceDirectory
        || entry.root !== path.join(path.dirname(registryFile), 'managed', entry.id)
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
  // MUTATION fixed-inspection-error: rethrow the original; raw read/JSON error tests fail.
  catch { throw conflict(); }
}

function publish(registryFile, bytes, expected) {
  const temp = registryFile + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  let created = false;
  try {
    // MUTATION exclusive-stage: replace wx with w; colliding-stage test fails.
    // MUTATION private-stage: replace 0600 with 0644; private-mode test fails.
    const descriptor = fs.openSync(temp, 'wx', 0o600);
    created = true;
    try { fs.writeFileSync(descriptor, bytes); }
    finally { fs.closeSync(descriptor); }
    const current = readRegularBytes(registryFile, true);
    // MUTATION byte-cas: remove this check; external-edit and deletion tests fail.
    if (current === null || !current.equals(expected)) throw conflict();
    fs.renameSync(temp, registryFile);
  } finally {
    // MUTATION stage-cleanup: remove unlink; failed-write/rename/CAS tests fail.
    // MUTATION owned-stage: remove created check; colliding-stage test fails.
    if (created) { try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
}

/** Disable only selected owned registrations. Disk state does not acknowledge
 * a loaded Kimi session: the caller retains its pending runtime-refresh work. */
export function disableRolePluginsSync(options) {
  try {
    const { registryFile, sourceDirectory, ids = [] } = options;
    // MUTATION selected-ids: remove this check; malformed selected-id list test fails.
    if (!Array.isArray(ids)) throw conflict();
    const saved = snapshot({ registryFile, sourceDirectory });
    const selected = new Set(ids), disabled = [];
    for (const entry of saved.entries) {
      // MUTATION selected-owned: remove selected.has; unrequested-owned test fails.
      if (selected.has(entry.id) && entry.enabled) {
        entry.enabled = false;
        disabled.push(entry.id);
      }
    }
    // MUTATION no-op-write: publish unconditionally; no-op byte-preservation test fails.
    if (disabled.length) publish(registryFile, Buffer.from(JSON.stringify(saved.document, null, 2) + '\n'), saved.bytes);
    return { changed: disabled.length > 0, disabled, ...inspection(saved) };
  // MUTATION fixed-write-error: rethrow the original; staging/rename and absent-options tests fail.
  } catch { throw conflict(); }
}
