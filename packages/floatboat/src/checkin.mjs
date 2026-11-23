// src/checkin.mjs —— 新手积分：首日/次日领取 + **到点自动领取**
//
// 实测（2026-11-21，新账号）：
//   领取  POST /api/v1/users/me/newapi/signup-credits/claim（body {} 即可，无需 day 参数）
//   状态  GET  同路径 → {stepKey, status, claimable, amount, startsAt, endsAt, mode}
//   · 首日 200 自动到账（mode=automatic，status=granted）
//   · 次日 300 按**注册满 24 小时**开放（不是按自然日）：endsAt 之前 claimable=false
//
// 用户要求：到 endsAt **自动领取**，不要用户手动点。所以这里做两件事：
//   1. checkin 被调用时：可领就领（claimed），不可领就按 endsAt 调度自动领取（inactive）
//   2. 到点后：定时器自动刷新 token 并打领取接口，用户完全不用管

import { WEB_BASE } from "./config.mjs"
import { apiFetch, numberOrNull } from "./http.mjs"
import { getSignupCreditClaimStatus, refreshTokens, unwrap } from "./desktop-api.mjs"

const CLAIM_PATH = "/api/v1/users/me/newapi/signup-credits/claim"
const NO_DAILY = "Floatboat 没有每日签到（新手两笔已领完）"
const EXPIRED = "Floatboat 登录已过期，请重新登录"
const ALREADY = /already|claimed|已领取|重复/i

/** Node 的 setTimeout 上限约 24.8 天，超过会溢出成立即触发 */
const MAX_TIMEOUT_MS = 2 ** 31 - 1

/** uid → { timeoutId, endsAtMs }（避免同一账号重复调度） */
const scheduled = new Map()

/** 把领取/查询错误归一到契约六值（already / 401 / 404 各有明确落点） */
function failureOutcome(e, { notFoundInactive = false } = {}) {
  const msg = String(e?.message ?? e)
  if (ALREADY.test(msg)) return { outcome: "inactive", message: NO_DAILY }
  if (e?.status === 401) return { outcome: "failed", message: EXPIRED, signIn: "expired" }
  if (notFoundInactive && e?.status === 404) {
    return { outcome: "inactive", message: "该账号没有新手积分领取接口" }
  }
  return { outcome: "failed", message: msg }
}

/** 直接打领取接口 */
async function postClaim(accessToken, signal) {
  return apiFetch(`${WEB_BASE}${CLAIM_PATH}`, {
    method: "POST",
    token: accessToken,
    json: {},
    signal,
    retries: 0,
  })
}

/** 领取成功：余额取上游给的，拿不到就退回调用方给的 amount，不编 0 */
function claimedOutcome(raw, fallbackCredit) {
  const body = unwrap(raw)
  const credit =
    numberOrNull(body?.creditBalance?.remainingCredits) ??
    numberOrNull(body?.creditsAmount) ??
    numberOrNull(body?.amount) ??
    fallbackCredit
  return {
    outcome: "claimed",
    ...(credit !== null ? { credit } : {}),
    message: credit !== null ? `领取成功，当前余额 ${credit} 积分` : "领取成功",
  }
}

/**
 * 到点自动领取：调度一个定时器到 endsAt，刷新 token 后打领取接口。
 * 已调度过同账号同时间就不再重复。
 */
function scheduleAutoClaim({ accessToken, refreshToken, uid, endsAt, log }) {
  const endsAtMs = Date.parse(endsAt)
  if (!Number.isFinite(endsAtMs)) return false
  const key = String(uid || "default")
  const prev = scheduled.get(key)
  if (prev && prev.endsAtMs === endsAtMs) return true // 已经排上了

  const delay = Math.max(0, endsAtMs - Date.now()) + 2000 // 到点后 +2s 缓冲
  if (delay > MAX_TIMEOUT_MS) return false // 超出 setTimeout 范围：交给下次 checkin

  if (prev?.timeoutId) clearTimeout(prev.timeoutId)
  const timeoutId = setTimeout(async () => {
    scheduled.delete(key)
    try {
      let token = accessToken
      if (refreshToken) {
        // 复用 desktop-api 的 refreshTokens，不再内联一份 POST + 解析
        const fresh = await refreshTokens({ refreshToken }).catch(() => null)
        if (fresh?.accessToken) token = fresh.accessToken
      }
      const body = unwrap(await postClaim(token))
      log?.(`[floatboat] 次日奖励自动领取：${JSON.stringify(body).slice(0, 120)}`)
    } catch (e) {
      log?.(`[floatboat] 次日奖励自动领取失败：${String(e?.message ?? e)}`)
    }
  }, delay)
  // 不阻塞 magpie 退出
  timeoutId.unref?.()
  scheduled.set(key, { timeoutId, endsAtMs })
  return true
}

/**
 * 领取新手积分（可领就领；不可领就调度到点自动领）。
 * @param {string} accessToken
 * @param {{signal?: AbortSignal, refreshToken?: string, uid?: string, log?: (m:string)=>void}} [o]
 */
export async function claimSignupCredits(accessToken, { signal, refreshToken, uid, log } = {}) {
  if (!accessToken) return { outcome: "failed", message: "Floatboat 未登录" }

  // 先查状态：能拿 claimable 和 endsAt
  let status = null
  try {
    status = await getSignupCreditClaimStatus(accessToken, { signal })
  } catch (e) {
    // 「已经领过」和 401 都有明确结论；其它错误退化为直接打领取接口
    if (ALREADY.test(String(e?.message ?? e)) || e?.status === 401) return failureOutcome(e)
    status = null
  }

  // 可领 → 立即领取
  if (status?.claimable) {
    try {
      return claimedOutcome(await postClaim(accessToken, signal), status.amount)
    } catch (e) {
      return failureOutcome(e)
    }
  }

  // 不可领但有 endsAt（次日可领时间）→ 调度到点自动领取
  if (status?.endsAt && scheduleAutoClaim({ accessToken, refreshToken, uid, endsAt: status.endsAt, log })) {
    const when = new Date(status.endsAt).toLocaleString("zh-CN", { hour12: false })
    return {
      outcome: "inactive",
      message: `次日 300 积分将于 ${when} 自动领取（注册满 24 小时开放，无需手动操作）`,
    }
  }

  // 状态不可用或没有 endsAt：直接打一次领取接口兜底
  try {
    const raw = await postClaim(accessToken, signal)
    const body = unwrap(raw)
    if (body?.enqueued === true || body?.delivered === true || body?.claimed === true) {
      return claimedOutcome(raw)
    }
    if (body?.reason === "already_processed") return { outcome: "inactive", message: NO_DAILY }
    return { outcome: "inactive", message: String(body?.reason || "当前没有可领取的积分") }
  } catch (e) {
    return failureOutcome(e, { notFoundInactive: true })
  }
}
