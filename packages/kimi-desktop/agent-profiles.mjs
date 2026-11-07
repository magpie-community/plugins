import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const conflict = () => Object.assign(Error('agent_profile_conflict'), { code: 'agent_profile_conflict' });

// Existing files are accepted only byte-for-byte. A profile edited by the user
// is never replaced, and old model profiles remain available for resumed work.
export function ensureAgentProfiles({ directory, router, models }) {
  const entries = [...new Set(models)].map(model => {
    const name = router.profileName(model);
    if (!/^local-agent-[a-f0-9]{24}$/.test(name)) throw conflict();
    return { name, file: path.join(directory, name + '.md'), text: router.profileText(model) };
  });
  const exists = entry => {
    let stat;
    try { stat = fs.lstatSync(entry.file); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (!stat.isFile() || fs.readFileSync(entry.file, 'utf8') !== entry.text) throw conflict();
    return true;
  };
  // Check every existing name before publishing any new profile.
  const missing = entries.filter(entry => !exists(entry));
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
  return { changed, names: entries.map(entry => entry.name) };
}
