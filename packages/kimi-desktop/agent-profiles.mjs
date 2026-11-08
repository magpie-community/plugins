import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const conflict = () => Object.assign(Error('agent_profile_conflict'), { code: 'agent_profile_conflict' });
const profileFile = /^local-agent-(?:[a-f0-9]{12}-)?[a-f0-9]{24}\.md$/;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// Existing files are accepted only byte-for-byte. A profile edited by the user
// is never replaced. Optional ownership permits pruning retired private files.
export function ensureAgentProfiles({ directory, router, models, profiles, ownedFiles }) {
  const requested = profiles ?? (models === undefined ? router.boundProfiles
    : [...new Set(models)].map(model => ({ model })));
  const entries = [...new Map(requested.map(({ model, role }) => {
    const name = router.profileName(model, role);
    if (!/^local-agent-[a-f0-9]{12}-[a-f0-9]{24}$/.test(name)) throw conflict();
    return [name, { name, file: path.join(directory, name + '.md'), text: router.profileText(model, role) }];
  })).values()];
  const exists = entry => {
    let stat;
    try { stat = fs.lstatSync(entry.file); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (!stat.isFile() || fs.readFileSync(entry.file, 'utf8') !== entry.text) throw conflict();
    return true;
  };
  // Check every existing name before publishing any new profile.
  const missing = entries.filter(entry => !exists(entry));
  const obsolete = [];
  const verifyOwned = name => {
    const file = path.join(directory, name);
    if (!fs.lstatSync(file).isFile() || digest(fs.readFileSync(file)) !== ownedFiles[name]) throw conflict();
  };
  if (ownedFiles !== undefined) {
    if (!ownedFiles || typeof ownedFiles !== 'object' || Array.isArray(ownedFiles)
        || Object.entries(ownedFiles).some(([name, hash]) => !profileFile.test(name) || !/^[a-f0-9]{64}$/.test(hash))) {
      throw conflict();
    }
    const wanted = new Set(entries.map(entry => path.basename(entry.file)));
    for (const name of fs.existsSync(directory) ? fs.readdirSync(directory) : []) {
      // Hidden metadata entries are never stat'd, read, hashed, deleted, or treated as conflicts.
      if (name.startsWith('.')) continue;
      // MUTATION profiles-ownership: unknown or edited files never become deletion authority.
      if (Object.hasOwn(ownedFiles, name)) verifyOwned(name);
      else if (!wanted.has(name)) throw conflict();
      if (!wanted.has(name)) obsolete.push(name);
    }
  }
  let changed = false;
  if (missing.length) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const entry of missing) {
    const staged = entry.file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    let created = false;
    try {
      fs.writeFileSync(staged, entry.text, { mode: 0o600, flag: 'wx' });
      created = true;
      // An exclusive link publishes a complete file without replacing one
      // created or edited by another writer after the preflight check.
      try { fs.linkSync(staged, entry.file); changed = true; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!exists(entry)) throw conflict();
      }
    } finally { if (created) fs.unlinkSync(staged); }
  }
  for (const name of obsolete) {
    // Recheck bytes immediately before deleting an obsolete owned profile.
    verifyOwned(name);
    fs.unlinkSync(path.join(directory, name));
    changed = true;
  }
  return { changed, names: entries.map(entry => entry.name) };
}
