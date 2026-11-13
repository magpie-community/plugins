import fs from "node:fs/promises";
import {constants} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {randomBytes, randomUUID} from "node:crypto";
import {secureDir, stateRoot, configRoot} from "./grant-store.mjs";
import {validKey} from "./crypto.js";

const fields = ["authKey", "receiptReadKey", "authorizationKey"];
const pluginRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

async function readPrivate(file, limit = 4096) {
  const fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > limit)
      throw new Error("company_guard_unsafe_configuration");
    return await fd.readFile("utf8");
  } finally { await fd.close(); }
}

async function writeTemporary(file, text) {
  const temp = file + "." + randomUUID() + ".tmp";
  const fd = await fs.open(temp, "wx", 0o600);
  try { await fd.writeFile(text); await fd.sync(); }
  catch (error) { await fs.rm(temp, {force:true}); throw error; }
  finally { await fd.close(); }
  return temp;
}

function owns(spec) {
  return spec === pluginRoot || /^@magpie-community\/middleware-company-guard(?:@[^/\s]+)?$/.test(spec || "") ||
    /^(?:github:cyanask\/magpie-company-guard|(?:git\+)?https:\/\/github\.com\/cyanask\/magpie-company-guard(?:\.git)?)(?:#.*)?$/.test(spec || "");
}

// The Bun hooks, page bridge and synchronous middleware must share the same
// keys. Publish only missing keys into this installation's existing options;
// never put credentials in process arguments or edit another plugin's entry.
async function publishKeys(keys, root) {
  const file = path.join(configRoot(), "plugins.json");
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await readPrivate(file, 2 * 1024 * 1024);
    let config;
    try { config = JSON.parse(before); } catch { throw new Error("company_guard_invalid_registry"); }
    const matches = (config.plugins || []).filter(entry => owns(entry.spec));
    if (matches.length !== 1) throw new Error("company_guard_installation_not_unique");
    const entry = matches[0], options = entry.options || {};
    if (stateRoot(options.stateDir) !== root) throw new Error("company_guard_configuration_changed");
    for (const field of fields) if (options[field] !== undefined && options[field] !== keys[field])
      throw new Error("company_guard_key_conflict");
    if (fields.every(field => options[field] === keys[field])) return;
    entry.options = {...options, ...keys};
    const temp = await writeTemporary(file, JSON.stringify(config, null, 2) + "\n");
    try {
      if (await readPrivate(file, 2 * 1024 * 1024) !== before) continue;
      await fs.rename(temp, file);
      return;
    } finally { await fs.rm(temp, {force:true}); }
  }
  throw new Error("company_guard_configuration_changed");
}

export async function initializeOptions(options = {}) {
  for (const field of fields) if (options[field] !== undefined && !validKey(options[field]))
    throw new Error("company_guard_invalid_existing_key");
  const root = stateRoot(options.stateDir);
  await secureDir(root, true);
  const file = path.join(root, "keys.json");
  let keys;
  try { keys = JSON.parse(await readPrivate(file)); }
  catch (error) {
    if (error.code !== "ENOENT") throw new Error("company_guard_invalid_key_file");
    const initial = Object.fromEntries(fields.map(field => [field, options[field] ?? randomBytes(32).toString("hex")]));
    const temp = await writeTemporary(file, JSON.stringify(initial) + "\n");
    try {
      // Linking a fully written file gives concurrent initializers one winner;
      // readers never see an empty or partially written key file.
      try { await fs.link(temp, file); } catch (error) { if (error.code !== "EEXIST") throw error; }
    } finally { await fs.rm(temp, {force:true}); }
    keys = JSON.parse(await readPrivate(file));
  }
  if (!keys || fields.some(field => !validKey(keys[field]))) throw new Error("company_guard_invalid_key_file");
  for (const field of fields) if (options[field] !== undefined && options[field] !== keys[field])
    throw new Error("company_guard_key_conflict");
  keys = Object.fromEntries(fields.map(field => [field, keys[field]]));
  await publishKeys(keys, root);
  Object.assign(options, keys);
  return options;
}
