// TokenPlan API keys：命名、创建、数量守卫与可选清理。
//
// 控制台的 Key 列表只给 masked_key，明文只在创建时返回一次，所以**没有
// "复用旧 Key"这条路**：要么用户把现有 Key 粘进来，要么插件新建一把。
// Key 名上限 20 字符、单账号上限 10 把，所以名字必须短、清理必须克制：
//   - 名字 `ink-<host6>-<acct4>-<rand4>`，正好 20 字符；
//   - host 段隔离别的机器，acct 段隔离同机的另一个账号，随机段防撞名；
//   - 清理只碰 `ink-<host6>-<acct4>-*`，手动建的 Key 永远不动。

import { randomBytes, randomUUID } from "node:crypto"
import { fingerprint, listKeys, createKey, deleteKey, probeApiKey, KEY_LIMIT } from "./protocol.mjs"

/** 6 hex：两台机器不撞、又给 4 位账号与 4 位随机留足 20 字符空间。 */
export const HOST_TAG = fingerprint(
  process.env.COMPUTERNAME || process.env.HOSTNAME || "host",
).slice(0, 6)

const accountTag = (username) => fingerprint(username || "account").slice(0, 4)
const randomTag = () => randomBytes(2).toString("hex")

/** 本插件建的 Key 的名字前缀（含机器与账号段），清理按它圈范围。 */
export function keyPrefixFor(username) {
  return `ink-${HOST_TAG}-${accountTag(username)}-`
}

/** ≤20 字符的 Key 名：4 + 6 + 1 + 4 + 1 + 4 = 20。 */
export function keyNameFor(username) {
  return `${keyPrefixFor(username)}${randomTag()}`
}

const at = (value) => {
  const s = String(value ?? "").trim()
  // "0"、空串、负数都不是时间：年龄未知的 Key 永远不删。
  if (!s || !/^\d{4,}/.test(s)) return 0
  const n = Date.parse(s)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 新 Key 生效前网关可能要几秒：给几次机会，别把"还没生效"当成"被拒绝"。 */
export async function probeWithRetry(apiKey, log) {
  const delays = [0, 1500, 3000, 4500, 6000]
  let last = null
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]))
    try {
      return await probeApiKey(apiKey)
    } catch (e) {
      last = e
      if (e?.status !== 401 && e?.status !== 403) throw e
      log?.("info", `inkstone: the new key is still taking effect (try ${i + 1}, HTTP ${e.status})`)
    }
  }
  throw last
}

/** Key 列表的 data.items，归一化成 {id,name,status,createdAt}。 */
export function keyItems(listReply) {
  const items = Array.isArray(listReply?.data?.items) ? listReply.data.items : []
  return items
    .filter((k) => k && k.id)
    .map((k) => ({
      id: String(k.id),
      name: String(k.name ?? ""),
      status: String(k.status ?? ""),
      createdAt: k.created_at ?? "",
    }))
}

/** 账号现在有几把 Key（total 缺失时按数组数）。 */
export async function keyCount(token) {
  const listed = await listKeys(token, { query: { page: 1, page_size: 50 } })
  const items = keyItems(listed)
  const total = Number(listed?.data?.total ?? listed?.data?.total_count ?? 0)
  return Math.max(Number.isFinite(total) ? total : 0, items.length)
}

/**
 * 删掉本机本账号的旧 `ink-…` Key。
 * freeSlots = 0：保留最新两把；freeSlots > 0：为新 Key 腾出位置，最旧先删。
 * 建不出来时间的 Key 永远不删（年龄未知）。
 */
export async function pruneKeys(token, username, { freeSlots = 0, keep = 2, log } = {}) {
  let deleted = 0
  try {
    const listed = await listKeys(token, { query: { page: 1, page_size: 50 } })
    const prefix = keyPrefixFor(username)
    const ours = keyItems(listed)
      .filter((k) => k.name.startsWith(prefix))
      .sort((a, b) => at(b.createdAt) - at(a.createdAt))
    if (!ours.length) return 0
    const candidates = ours
      .filter((k) => at(k.createdAt) > 0)
      .sort((a, b) => at(a.createdAt) - at(b.createdAt))
    const keepIds = new Set(ours.slice(0, keep).map((k) => k.id))
    for (const k of candidates) {
      if (freeSlots > 0 ? deleted >= freeSlots : keepIds.has(k.id)) continue
      try {
        await deleteKey(token, k.id)
        deleted += 1
      } catch (e) {
        log?.("warn", `inkstone: pruning a key failed (${e?.message ?? e})`)
      }
    }
  } catch (e) {
    log?.("warn", `inkstone: key pruning skipped (${e?.message ?? e})`)
  }
  return deleted
}

/**
 * 拿到一把能用的 Key：
 *   - 用户粘了 Key → 探活后直接用（401/403 才算被拒，网络错误不算）；
 *   - 没粘且允许创建 → 数一下，满了先清理（可选），再创建并探活。
 * 抛错时带 `code`：`key_limit`（满了且没开清理）、`refused`（Key 被平台拒）。
 */
export async function ensureKey(token, username, { apiKey = "", create = true, prune = false, log } = {}) {
  const pasted = String(apiKey ?? "").trim()
  if (pasted) {
    await probeWithRetry(pasted, log)
    return pasted
  }
  if (!create) throw Object.assign(new Error("no TokenPlan API key was provided"), { code: "no_key" })

  let total = await keyCount(token)
  if (total >= KEY_LIMIT && prune) {
    const need = Math.max(1, total - (KEY_LIMIT - 1))
    const freed = await pruneKeys(token, username, { freeSlots: need, log })
    log?.("info", `inkstone: pre-prune removed ${freed}/${need} old key(s)`)
    total = await keyCount(token)
  }
  if (total >= KEY_LIMIT) {
    throw Object.assign(
      new Error(
        `this account already has ${total} API keys (the limit is ${KEY_LIMIT}). ` +
          `Delete one in the console, or enable "prune old inkstone API keys" and sign in again.`,
      ),
      { code: "key_limit" },
    )
  }

  const name = keyNameFor(username)
  let reply
  try {
    reply = await createKey(token, name, randomUUID())
  } catch (e) {
    // 幂等冲突（-15109）：换一个 Idempotency-Key 再试一次，返回值与首次相同。
    if (e?.code === -15109) reply = await createKey(token, name, randomUUID())
    // -15108：创建成功但明文拿不到了，这把 Key 已无法使用，直接说明。
    else if (e?.code === -15108) {
      throw new Error(
        "the console created an API key but did not return it (the plaintext is shown only once). " +
          "Create one in the console and paste it instead.",
      )
    } else throw e
  }
  const created = String(reply?.data?.key ?? "").trim()
  if (!created) {
    // -15108：创建成功但明文拿不到了，这把 Key 已无法使用，直接说明。
    throw new Error(
      "the console created an API key but did not return it (the plaintext is shown only once). " +
        "Create one in the console and paste it instead.",
    )
  }
  try {
    await probeWithRetry(created, log)
  } catch (e) {
    if (e?.status === 401 || e?.status === 403) {
      // 建出来却被拒：删掉这把，别给账号留垃圾。
      try {
        const listed = await listKeys(token, { query: { page: 1, page_size: 50 } })
        const match = keyItems(listed).find((k) => k.name === name)
        if (match) await deleteKey(token, match.id)
      } catch {}
      throw Object.assign(new Error(`the new API key was refused (HTTP ${e.status}); paste an existing key instead`), {
        status: e.status,
      })
    }
    log?.("warn", `inkstone: the new key's check did not finish (${e?.message ?? e})`)
  }
  if (prune) await pruneKeys(token, username, { log })
  return created
}
