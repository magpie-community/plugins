// TokenPlan API keys：命名、创建、数量守卫与可选清理。
//
// 控制台的 Key 列表只给 masked_key，明文只在创建时返回一次，所以**没有
// "从列表复用明文"这条路**：要么用户把现有 Key 粘进来，要么插件新建一把。
// Key 名上限 20 字符、单账号上限 10 把，所以名字必须短、清理必须克制：
//   - 名字 `ink-<host4>-<acct4>-<rand4>`，18 字符（上限 20，留余量）；
//   - host 段隔离别的机器（os.hostname()，不是环境变量——macOS 的 GUI 进程
//     没有 COMPUTERNAME/HOSTNAME），acct 段 4 位隔离同机账号，随机段 4 位
//     防重名（1 位只有 256 个名字，同一账号连建两把就会撞）；
//   - 清理只碰 `ink-<host4>-<acct4>-*`，手动建的 Key 永远不动。

import { randomBytes, randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { fingerprint, listKeys, createKey, deleteKey, probeApiKey, KEY_LIMIT } from "./protocol.mjs"

/** 4 hex：机器不撞；macOS GUI 进程没有 COMPUTERNAME/HOSTNAME，必须用 os.hostname()。 */
export const HOST_TAG = fingerprint(hostname()).slice(0, 4)

const accountTag = (username) => fingerprint(username || "account").slice(0, 4)
/** 随机段 2 字节：4+4+1+4+1+4 = 18 ≤ 20，平台 Key 名上限留了余量。 */
const randomTag = () => randomBytes(2).toString("hex")

/** 本插件建的 Key 的名字前缀（含机器与账号段），清理按它圈范围。 */
export function keyPrefixFor(username) {
  return `ink-${HOST_TAG}-${accountTag(username)}-`
}

/** ≤20 字符的 Key 名：4 + 4 + 1 + 4 + 1 + 4 = 18。 */
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
  const listed = await listKeys(token)
  const items = keyItems(listed)
  const total = Number(listed?.data?.total ?? listed?.data?.total_count ?? 0)
  return Math.max(Number.isFinite(total) ? total : 0, items.length)
}

/**
 * 删掉本机本账号的旧 `ink-…` Key。
 * freeSlots = 0：保留最新两把；freeSlots > 0：为新 Key 腾出位置，最旧先删。
 * `protectName`（本轮刚创建的那把的名字）永远不删。正在使用的 Key 一定是
 * 最新一次登录创建的那把，所以落在"最新两把"的保护范围内。
 * 建不出来时间的 Key 永远不删（年龄未知）。
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
      if (freeSlots > 0 && deleted >= freeSlots) continue
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

  let name = keyNameFor(username)
  let reply
  try {
    reply = await createKey(token, name, randomUUID())
  } catch (e) {
    // 幂等冲突（-15109）：换一个 Idempotency-Key 和一个新名字再试（名字也
    // 可能撞），最多三次；-15108 是另一回事：创建成功但明文拿不到了。
    if (e?.code === -15109) {
      let last = e
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          name = keyNameFor(username)
          reply = await createKey(token, name, randomUUID())
          last = null
          break
        } catch (e2) {
          if (e2?.code !== -15109) throw e2
          last = e2
        }
      }
      if (last) throw last
    }
    // -15108：创建成功但明文拿不到了，这把 Key 已无法使用，直接说明。
    else if (e?.code === -15108) {
      throw new Error(
        "the console created an API key but did not return it (the plaintext is shown only once). " +
          "Create one in the console and paste it instead.",
      )
    }
    // 「API Key fetch failed, refresh page and retry」：登录窗口刚关、
    // headless 刚读完 cookie 就建 Key 时的软风控（真机实测，2026-11-07——
    // 同一枚 cookie 稍后重试就成功）。稍等重试两次，换名字换幂等键。
    else if (/fetch failed, refresh page/i.test(String(e?.message ?? ""))) {
      let last = e
      for (let attempt = 0; attempt < 2; attempt++) {
        await new Promise((r) => setTimeout(r, 2500))
        try {
          name = keyNameFor(username)
          reply = await createKey(token, name, randomUUID())
          last = null
          break
        } catch (e2) {
          last = e2
        }
      }
      if (last) throw last
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
        const listed = await listKeys(token)
        const match = keyItems(listed).find((k) => k.name === name)
        if (match) await deleteKey(token, match.id)
      } catch {}
      throw Object.assign(new Error(`the new API key was refused (HTTP ${e.status}); paste an existing key instead`), {
        status: e.status,
      })
    }
    log?.("warn", `inkstone: the new key's check did not finish (${e?.message ?? e})`)
  }
  if (prune) await pruneKeys(token, username, { protectName: name, log })
  return created
}
