// usage-summary → the magpie account card's balance and rows.
//
// The console sends the credit amounts as pre-formatted display strings
// (display_total_remaining_points, display_available_points,
// display_frozen_points) alongside numeric frozen_points and
// estimated_available_days. A spend rate is derived from the credit
// transactions when they read cleanly; a failed read is said, never guessed:
// a balance of 0 is "no credit", a failed read is "unknown", and the two
// must not be mixed.

import { transactions } from "./protocol.mjs"

/** 可缺的数：空串/undefined → undefined，供"字段缺失"与"0"区分。 */
export function optionalNum(value) {
  if (value === null || value === undefined) return undefined
  const s = String(value).trim()
  if (!s) return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

/** The display string the console itself shows, cleaned for our card. */
export function displayOf(value) {
  const s = String(value ?? "").trim()
  return s || ""
}

const dayOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`

/** 控制台的本地日历日：时刻按本机时区取日期，避免 UTC 偏移把日期退一天。 */
export function localDay(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return undefined
  return dayOf(d)
}

/**
 * The spend window from the credit transactions: how much moved out of the
 * balance recently, and when. direction=credit lists the movements; a
 * negative (spent) amount with a recent day makes the "recent spend" row.
 * Anything that does not parse is skipped — a broken list must not invent
 * spend numbers.
 */
export function spendRowOf(txReply, { nowMs = Date.now() } = {}) {
  const items = Array.isArray(txReply?.items) ? txReply.items : []
  let spent = 0
  let gained = 0
  let newest = 0
  // "近期" is the last 7 days: the row's name says recent, so older movements
  // must not inflate the sum (a 3-month-old top-up would read as 近期到账).
  const recentMs = 7 * 86_400_000
  for (const t of items) {
    if (!t || typeof t !== "object") continue
    const amount = optionalNum(t.credit_points ?? t.amount)
    if (amount === undefined || amount === 0) continue
    const day = t.created_at ? Date.parse(String(t.created_at)) : 0
    const when = Number.isFinite(day) && day > 0 ? day : 0
    if (when && when <= nowMs && when > newest) newest = when
    // an undated movement cannot be placed in the window; leave it out
    // rather than guess it recent
    if (!when || when > nowMs || nowMs - when > recentMs) continue
    if (amount < 0) spent += -amount
    else gained += amount
  }
  if (spent <= 0 && gained <= 0) return null
  const day = newest ? localDay(new Date(newest).toISOString()) : ""
  const parts = []
  if (spent > 0) parts.push(`${COPY.recentSpent} ${Number(spent.toFixed(2))}`)
  if (gained > 0) parts.push(`${COPY.recentGained} ${Number(gained.toFixed(2))}`)
  if (day) parts.push(day)
  return {
    name: COPY.recent,
    used: 0,
    display: parts.join(" · "),
    aside: true,
  }
}

/** Pull the recent transactions best-effort: a failed read returns null. */
export async function recentSpend(token, { log } = {}) {
  try {
    const reply = await transactions(token, { limit: 50, offset: 0 })
    return spendRowOf(reply)
  } catch (e) {
    log?.("info", `moss: transactions read skipped (${e?.message ?? e})`)
    return null
  }
}

// Card copy. The console itself is a Chinese UI and the balance strings it
// sends are pre-formatted for it, so the rows read in Chinese; the plan name
// and the amounts keep the numbers/labels readable regardless.
export const COPY = {
  plan: "MOSS 积分",
  points: "积分",
  frozen: "冻结",
  recent: "近期流水",
  recentSpent: "近期消耗",
  recentGained: "近期到账",
  daysLeft: "预估可用",
  daysUnit: "天",
  dailyGrant: "每日赠送",
  dailyGrantHint: "登录 MOSS Create（create.moss.cn）每日领 50 积分 · 当日有效",
}

/** usage-summary → the card. `summary` is the console's data field. */
export function cardOf({ summary, user, spendRow, errors = [] } = {}) {
  if (!summary || typeof summary !== "object") {
    return {
      plan: COPY.plan,
      ...(user ? { user } : {}),
      windows: [],
      ...(errors.length ? { error: errors.join("; ") } : {}),
      signIn: "kept",
    }
  }
  const available = displayOf(summary.display_available_points ?? summary.display_total_remaining_points)
  const frozen = optionalNum(summary.frozen_points)
  const frozenDisplay = displayOf(summary.display_frozen_points)
  const days = optionalNum(summary.estimated_available_days)

  const balanceParts = []
  if (available) balanceParts.push(`${available} ${COPY.points}`)
  if (frozen !== undefined && frozen > 0 && frozenDisplay) balanceParts.push(`${COPY.frozen} ${frozenDisplay}`)
  const windows = [...(spendRow ? [spendRow] : [])]
  if (days !== undefined && days > 0) {
    windows.push({ name: COPY.daysLeft, used: 0, display: `约 ${Math.floor(days)} ${COPY.daysUnit}`, aside: true })
  }
  // 每日 50 积分在 MOSS Create（create.moss.cn）发放，不在控制台 API 里：
  // 作为 aside 行提示去哪里领，不编造"已领/未领"状态。
  windows.push({
    name: COPY.dailyGrant,
    used: 0,
    display: COPY.dailyGrantHint,
    aside: true,
  })

  return {
    plan: COPY.plan,
    ...(user ? { user } : {}),
    ...(balanceParts.length ? { balance: balanceParts.join(" · ") } : {}),
    windows,
    ...(errors.length ? { error: errors.join("; ") } : {}),
    signIn: "kept",
  }
}
