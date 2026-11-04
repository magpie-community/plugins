/**
 * Token Plan API keys: naming, reuse, creation and the 20-key guard.
 *
 * Keys created here are named `magpie-<host>-<account>-<time>-<random>`:
 *   - the host tag keeps another machine's keys out of this machine's prune;
 *   - the account tag is a hash, not the account name, so the console's key
 *     list does not carry the user's identity;
 *   - the random part comes from crypto, not Math.random.
 */

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";

import {
  createApiKey,
  createdApiKey,
  deleteApiKey,
  keyFingerprint,
  listApiKeys,
  probeApiKey,
} from "./protocol.mjs";

export const KEY_LIMIT = 20;

/** 8 hex chars: enough that two machines do not collide, short enough for a key name. */
export const HOST_TAG = keyFingerprint(hostname() || "host").slice(0, 8);

// 8 hex chars: a 4-char tag collides for two accounts on one host with
// probability 1/65536, and a collision would let them reuse each other's keys.
const accountTag = (username) => keyFingerprint(username || "account").slice(0, 8);
const randomTag = () => randomBytes(2).toString("hex");
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");

/** A key name that carries no account name and no Math.random. */
export function keyNameFor(username) {
  return `${keyPrefix(username)}${stamp()}-${randomTag()}`.slice(0, 64);
}

/** The name prefix this account's keys share: host tag plus account tag. */
export function keyPrefix(username) {
  return `magpie-${HOST_TAG}-${accountTag(username)}-`;
}

const at = (value) => {
  const n = Date.parse(String(value ?? ""));
  return Number.isFinite(n) ? n : 0;
};

/** New-key validation: the gateway needs 3–10s before a new key answers. */
export async function probeWithRetry(apiKey, baseURL, log) {
  const delays = [0, 1500, 3000, 4500, 6000];
  let last = null;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
    try {
      return await probeApiKey(apiKey, baseURL);
    } catch (e) {
      last = e;
      if (e?.status !== 401 && e?.status !== 403) throw e;
      log?.("info", `sensenova: the new key is still taking effect (try ${i + 1}, HTTP ${e.status})`);
    }
  }
  throw last;
}

/** How many keys the account has, counting the array if total_count is absent. */
export async function keyCount(access) {
  const listed = await listApiKeys(access, { pageSize: 20 });
  const count = (listed?.api_keys ?? []).filter((k) => k && k.id).length;
  return Math.max(Number(listed?.total_count ?? listed?.total_size ?? 0) || 0, count);
}

/**
 * An existing key this machine can reuse: the newest key of this account
 * (`magpie-<host>-<account>-*`) whose plaintext the list returned and which
 * the vendor still accepts. Scoped by the account tag so a key that belongs
 * to another saved account is never borrowed.
 */
export async function findReusableKey(access, baseURL, { username = "" } = {}) {
  let listed;
  try {
    listed = await listApiKeys(access, { pageSize: 20 });
  } catch {
    return "";
  }
  const rows = (listed?.api_keys ?? []).filter((k) => k && k.id && typeof k.api_key === "string" && k.api_key);
  const ours = rows
    .filter((k) => String(k.displayname ?? "").startsWith(keyPrefix(username)))
    .sort((a, b) => at(b.create_time) - at(a.create_time));
  for (const k of ours) {
    try {
      if (await probeApiKey(k.api_key, baseURL)) return k.api_key;
    } catch (e) {
      if (e?.status !== 401 && e?.status !== 403) return "";
    }
  }
  return "";
}

/** Delete a key this sign-in created when it could not be validated. */
export async function cleanupKey(access, created, keyName, log) {
  try {
    if (created?.id) {
      await deleteApiKey(access, created.id);
      return;
    }
    const listed = await listApiKeys(access, { pageSize: 20 });
    const match = (listed?.api_keys ?? []).find((k) => k.displayname === keyName);
    if (match?.id) await deleteApiKey(access, match.id);
  } catch (e) {
    log?.("warn", `sensenova: could not clean up the failed key (${e?.message ?? e})`);
  }
}

/**
 * Prune this account's old keys only.
 *
 * The candidate set is `magpie-<host>-<account>-*`: a key another saved
 * account on this machine still uses is never in it, whatever prune is asked
 * to free.
 *
 * freeSlots = 0: keep the newest two.
 * freeSlots > 0: free that many slots for a new key, oldest first.
 * The key in use (by its last 4) and the key just created never go; a key
 * whose create_time cannot be parsed is never deleted (its age is unknown).
 */
export async function pruneKeys(access, { username = "", keyName = "", activeSuffix = "", freeSlots = 0, log } = {}) {
  let deleted = 0;
  try {
    const listed = await listApiKeys(access, { pageSize: 20 });
    const rows = (listed?.api_keys ?? []).filter((k) => k && k.id);
    const prefix = keyPrefix(username);
    const ours = rows
      .filter((k) => String(k.displayname ?? "").startsWith(prefix))
      .sort((a, b) => at(b.create_time) - at(a.create_time));
    if (!ours.length) return 0;

    const protectedIds = new Set();
    if (keyName) {
      const fresh = ours.find((k) => k.displayname === keyName);
      if (fresh?.id) protectedIds.add(fresh.id);
    }
    if (activeSuffix) {
      for (const k of rows) {
        if (String(k.api_key ?? "").endsWith(activeSuffix)) protectedIds.add(k.id);
      }
    }

    const keep = new Set([...ours.slice(0, 2).map((k) => k.id), ...protectedIds]);
    const candidates = ours
      .filter((k) => !protectedIds.has(k.id) && at(k.create_time) > 0)
      .sort((a, b) => at(a.create_time) - at(b.create_time));
    for (const k of candidates) {
      if (freeSlots > 0 ? deleted >= freeSlots : keep.has(k.id)) continue;
      await deleteApiKey(access, k.id)
        .then(() => {
          deleted += 1;
        })
        .catch((e) => log?.("warn", `sensenova: pruning a key failed (${e?.message ?? e})`));
    }
    const skipped = ours.filter((k) => !protectedIds.has(k.id) && at(k.create_time) <= 0);
    if (skipped.length) {
      log?.("warn", `sensenova: skipped ${skipped.length} key(s) whose create_time cannot be parsed`);
    }
  } catch (e) {
    log?.("warn", `sensenova: key pruning skipped (${e?.message ?? e})`);
  }
  return deleted;
}

/**
 * Reuse a valid key, or create one (with the 20-key guard and optional prune).
 * Throws {code:"key_limit"} when the account is full and pruning cannot help.
 */
export async function ensureKey(access, username, { baseURL, prune = false, log } = {}) {
  const reused = await findReusableKey(access, baseURL, { username });
  if (reused) return reused;

  const total = await keyCount(access);
  if (total >= KEY_LIMIT) {
    const err = new Error(
      `this account already has ${total} API keys (the limit is ${KEY_LIMIT}). ` +
        `Delete one in the console's API Keys page, then sign in again; ` +
        `the plugin never deletes a key before it knows which one is yours.`,
    );
    err.code = "key_limit";
    throw err;
  }

  const keyName = keyNameFor(username);
  const created = await createApiKey(access, keyName);
  const apiKey = createdApiKey(created);
  if (!apiKey) {
    await cleanupKey(access, created, keyName, log);
    throw new Error("the console created a key but did not return it; use an API key instead");
  }
  try {
    await probeWithRetry(apiKey, baseURL, log);
  } catch (e) {
    if (e?.status === 401 || e?.status === 403) {
      await cleanupKey(access, created, keyName, log);
      throw new Error(`the new API key was refused (HTTP ${e.status}); use an API key instead`);
    }
    log?.("warn", `sensenova: the new key's check did not finish (${e?.message ?? e})`);
  }
  if (prune) await pruneKeys(access, { username, keyName, activeSuffix: apiKey.slice(-4), log });
  return apiKey;
}
