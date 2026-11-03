import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Read one key's limits (primary `limit` + `moreLimits`) from caller-keys.json.
 * Returns null when the file or the key is missing; an empty array when the key
 * exists with no limits. Pure read — no lock, so callers must treat it as a
 * best-effort view (the CLI remains the source of truth for enforcement).
 */
export async function readKeysFileLimits(path, id) {
  let keys;
  try {
    keys = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw e;
  }
  if (!Array.isArray(keys)) return null;
  const key = keys.find((k) => String(k?.id || "") === String(id));
  if (!key) return null;
  const out = [];
  if (key.limit && typeof key.limit === "object") out.push(normalizeLimit(key.limit));
  if (Array.isArray(key.moreLimits)) {
    for (const m of key.moreLimits) {
      if (m && typeof m === "object") out.push(normalizeLimit(m));
    }
  }
  return out;
}

function normalizeLimit(raw) {
  const out = { period: String(raw.period || "") };
  for (const field of ["days", "hours", "tokens", "cost"]) {
    // Magpie 可能把未设置的字段写成 null / ""；Number(null) === 0 会变成假上限。
    if (raw[field] == null || raw[field] === "") continue;
    const n = Number(raw[field]);
    if (Number.isFinite(n)) out[field] = n;
  }
  if (raw.cacheReads) out.cacheReads = true;
  if (raw.since) out.since = String(raw.since);
  return out;
}

/**
 * Read caller-keys.json, set/clear one key's `off` flag, write it back atomically.
 * Caller must already hold Magpie's flock on `<path>.lock` — this module only
 * owns the read-modify-write, so the Bun FFI path and the Bun subprocess helper
 * share one implementation.
 */
export async function mutateKeysFile(path, id, off) {
  let keys = [];
  try {
    keys = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e && e.code !== "ENOENT") throw e;
  }
  if (!Array.isArray(keys)) throw new Error("caller-keys.json 格式无效");
  const i = keys.findIndex((k) => String(k?.id || "") === id);
  if (i < 0) throw new Error("Magpie 中找不到这把网关 Key");
  if (off) keys[i].off = true;
  else delete keys[i].off;

  const tmp = join(dirname(path), `.caller-keys.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(keys, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
  try {
    await chmod(path, 0o600);
  } catch {
    /* ignore */
  }
  return { id, off: Boolean(off) };
}
