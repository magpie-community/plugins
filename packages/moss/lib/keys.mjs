// MOSS console API keys: naming, creation, reuse and the 50-key guard.
//
// The console's key list returns only the masked key; the plaintext shows
// once at creation, so there is no "reuse the plaintext from the list" path:
// either the user pastes an existing key, or the plugin creates one.
// The create dialog caps the name at 50 characters and the account caps at
// 50 keys (the create failure saying "maas tenant already exists" is the
// limit surfacing), so:
//   - name `moss-<host8>-<acct8>-<stamp>-<rand>`, well under the cap;
//   - the host segment keeps another machine's keys out of this machine's
//     prune (os.hostname() — a macOS GUI process has no COMPUTERNAME);
//   - the account tag is a hash, not the account name, so the console's key
//     list does not carry the user's identity;
//   - pruning touches only `moss-<host8>-<acct8>-*`; manual keys, keys of
//     other saved accounts, and keys whose creation time cannot be read are
//     never deleted.

import { randomBytes } from "node:crypto"
import { hostname } from "node:os"
import { createKey, deleteKey, fingerprint, listKeys, probeApiKey, KEY_LIMIT } from "./protocol.mjs"

/** 8 hex chars: enough that two machines do not collide. */
export const HOST_TAG = fingerprint(hostname() || "host").slice(0, 8)

// 8 hex chars: a 4-char tag collides for two accounts on one host with
// probability 1/65536, and a collision would let them reuse each other's keys.
const accountTag = (username) => fingerprint(username || "account").slice(0, 8)
const randomTag = () => randomBytes(2).toString("hex")
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")

/** A key name that carries no account name and no Math.random. */
export function keyNameFor(username) {
  return `${keyPrefixFor(username)}${stamp()}-${randomTag()}`
}

/** The name prefix this account's keys share: host tag plus account tag. */
export function keyPrefixFor(username) {
  return `moss-${HOST_TAG}-${accountTag(username)}-`
}

const at = (value) => {
  const s = String(value ?? "").trim()
  // "0"、空串、负数都不是时间：年龄未知的 Key 永远不删。
  if (!s || !/^\d{4,}/.test(s)) return 0
  const n = Date.parse(s)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** New-key validation: the gateway needs a few seconds before a new key answers. */
export async function probeWithRetry(apiKey, log, delays = [0, 1500, 3000, 4500, 6000]) {
  let last = null
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]))
    try {
      return await probeApiKey(apiKey)
    } catch (e) {
      last = e
      if (e?.status !== 401 && e?.status !== 403) throw e
      log?.("info", `moss: the new key is still taking effect (try ${i + 1}, HTTP ${e.status})`)
    }
  }
  throw last
}

/** The key list's items, normalized to {id,name,status,createdAt}. */
export function keyItems(listReply) {
  const items = Array.isArray(listReply?.items)
    ? listReply.items
    : Array.isArray(listReply?.data?.items)
      ? listReply.data.items
      : []
  return items
    .filter((k) => k && k.id !== undefined && k.id !== null)
    .map((k) => ({
      id: String(k.id),
      name: String(k.name ?? ""),
      status: String(k.status ?? ""),
      createdAt: k.created_at ?? "",
    }))
}

/** How many keys the account has, counting the array if total is absent. */
export async function keyCount(token) {
  const listed = await listKeys(token)
  const items = keyItems(listed)
  const total = Number(listed?.total ?? listed?.data?.total ?? 0)
  return Math.max(Number.isFinite(total) ? total : 0, items.length)
}

/** A key the console refused to hand a plaintext for is deleted by name. */
async function deleteKeyByName(token, name, log) {
  try {
    const listed = await listKeys(token)
    const match = keyItems(listed).find((k) => k.name === name)
    if (!match) return false
    await deleteKey(token, match.id)
    log?.("warn", "moss: deleted the refused key by name to retry with a fresh one")
    return true
  } catch (e) {
    // 列表读不到：孤儿留给下次 prune，重试继续
    log?.("warn", "moss: could not list the keys to delete the refused one (" + (e?.message ?? e) + ")")
    return false
  }
}

/**
 * Prune this account's old `moss-…` keys only.
 * freeSlots = 0: keep the newest two. freeSlots > 0: free that many slots
 * for a new key, oldest first. The key created this sign-in (protectName)
 * never goes; a key whose created_at cannot be parsed is never deleted
 * (its age is unknown). Manual keys are outside the prefix and out of reach.
 */
export async function pruneKeys(token, username, { freeSlots = 0, keep = 2, protectName = "", log } = {}) {
  let deleted = 0
  try {
    const listed = await listKeys(token)
    const prefix = keyPrefixFor(username)
    const ours = keyItems(listed)
      .filter((k) => k.name.startsWith(prefix))
      .sort((a, b) => at(b.createdAt) - at(a.createdAt))
    if (!ours.length) return 0
    const protectedIds = new Set(ours.slice(0, keep).map((k) => k.id))
    if (protectName) {
      const fresh = ours.find((k) => k.name === protectName)
      if (fresh?.id) protectedIds.add(fresh.id)
    }
    const candidates = ours
      .filter((k) => at(k.createdAt) > 0 && !protectedIds.has(k.id))
      .sort((a, b) => at(a.createdAt) - at(b.createdAt))
    for (const k of candidates) {
      if (freeSlots > 0 && deleted >= freeSlots) break
      try {
        await deleteKey(token, k.id)
        deleted += 1
      } catch (e) {
        log?.("warn", `moss: pruning a key failed (${e?.message ?? e})`)
      }
    }
  } catch (e) {
    log?.("warn", `moss: key pruning skipped (${e?.message ?? e})`)
  }
  return deleted
}

/**
 * 拿到一把能用的 Key：
 *   - 用户粘了 Key → 探活后直接用（401/403 才算被拒，网络错误不算）；
 *   - 没粘且允许创建 → 数一下，满了先清理（可选），再创建并探活。
 * 抛错时带 `code`：`key_limit`（满了且没开清理）、`no_plaintext`（建了但
 * 拿不到明文）。
 */
export async function ensureKey(token, username, { apiKey = "", create = true, prune = false, log, probeDelays } = {}) {
  const pasted = String(apiKey ?? "").trim()
  if (pasted) {
    await probeWithRetry(pasted, log, probeDelays)
    return pasted
  }
  if (!create) throw Object.assign(new Error("no MOSS API key was provided"), { code: "no_key" })

  let total = await keyCount(token)
  if (total >= KEY_LIMIT && prune) {
    const need = Math.max(1, total - (KEY_LIMIT - 1))
    const freed = await pruneKeys(token, username, { freeSlots: need, log })
    log?.("info", `moss: pre-prune removed ${freed}/${need} old key(s)`)
    total = await keyCount(token)
  }
  if (total >= KEY_LIMIT) {
    throw Object.assign(
      new Error(
        `this account already has ${total} API keys (the limit is ${KEY_LIMIT}). ` +
          `Delete one in the console, or enable "prune old MOSS API keys" and sign in again.`,
      ),
      { code: "key_limit" },
    )
  }

  let name = keyNameFor(username)
  let reply
  // 「建成了但明文没给」：HTTP 200 但 body 缺 api_key。按名字删掉孤儿、
  // 换新名重试，最多三次；耗尽后如实说，且只有真删掉了才说「已移除」。
  let removed = false
  const noPlaintextError = (wasRemoved) =>
    Object.assign(
      new Error(
        wasRemoved
          ? "the console created an API key but did not return its plaintext; the orphan key was removed — please try the sign-in again."
          : "the console created an API key but did not return its plaintext, and the orphan could not be deleted from here — please check the console's API key page.",
      ),
      { code: "no_plaintext" },
    )
  for (let attempt = 0; attempt < 3; attempt++) {
    reply = await createKey(token, name).catch((e) => {
      if (attempt === 2) throw e
      return null
    })
    if (reply) break
    removed = await deleteKeyByName(token, name, log)
    name = keyNameFor(username)
  }
  if (!reply) throw noPlaintextError(removed)

  const apiKeyOut = String(reply?.api_key ?? reply?.data?.api_key ?? "").trim()
  if (!apiKeyOut) {
    let lastRemoved = false
    for (let attempt = 0; attempt < 3; attempt++) {
      lastRemoved = await deleteKeyByName(token, name, log)
      if (attempt === 2) break
      name = keyNameFor(username)
      reply = await createKey(token, name).catch(() => null)
      if (reply && String(reply?.api_key ?? reply?.data?.api_key ?? "").trim()) {
        await probeWithRetry(String(reply.api_key ?? reply.data.api_key), log, probeDelays)
        return String(reply.api_key ?? reply.data.api_key)
      }
    }
    throw noPlaintextError(lastRemoved)
  }
  // 新 Key 生效前网关可能要几秒：给几次机会，别把"还没生效"当成"被拒绝"。
  await probeWithRetry(apiKeyOut, log, probeDelays)
  return apiKeyOut
}
