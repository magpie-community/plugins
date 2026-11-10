// Reading the `pc/agent-explore` campaign: what is still claimable, what is
// still to do, and what actually landed between two server reads.
//
// Pure functions only — no network, no CDP, no filesystem. Both the check-in
// path (index.mjs) and the first-run sweep (lib/sweep.mjs) need these exact
// answers, and having one implementation is what keeps "已签到" and "还有待领"
// from disagreeing between the two.

// Observed on a live account (2026-11-02):
//   0 未开放（需企业认证，如团队版）  1 未完成（去完成）
//   2 已完成待领取                    3 已领取
export const TASK_STATUS = { 0: "未开放", 1: "未完成", 2: "待领取", 3: "已领取" }

/** A status label that never renders as a bare number in a message. */
export function statusLabel(n) {
  return TASK_STATUS[Number(n)] ?? String(n ?? "")
}

/**
 * Credit already earned but not yet collected. Deliberately NOT the sum of
 * every reward on the page: tasks sitting at status 1 need real product usage
 * (generating a document / PPT / sheet) and spend quota to produce, so they
 * are not "claimable" in any honest sense.
 */
export function claimableCredit(st) {
  if (!st || st.unexpected || st.cooling || st.loginInvalid) return 0
  let sum = 0
  if (st.checkin && !st.checkin.checkedIn) sum += st.checkin.rewardAmount || 0
  for (const m of st.milestones ?? []) if (m.status === 2) sum += m.reward || 0
  // A +100 task that just registered lands at status 2 and stays there until
  // collected. Leaving it out here is how "已完成" would sit unclaimed forever.
  for (const t of st.tasks ?? []) {
    if (t.status === 2 && t.kind !== "daily_signin") sum += t.reward || 0
  }
  return sum
}

/**
 * The exact cards to click, in one pass. `code` values are byte-identical to
 * the page's `data-reward-code`, so each click targets that card's own button.
 */
export function claimTargets(st) {
  const out = []
  if (st?.checkin && !st.checkin.checkedIn) {
    out.push({ code: "daily_signin", label: "每日签到", credit: st.checkin.rewardAmount || 0 })
  }
  for (const m of st?.milestones ?? []) {
    if (m.status !== 2 || !m.code) continue
    out.push({ code: m.code, label: m.title || `累计 ${m.threshold} 点额度`, credit: m.reward || 0 })
  }
  // Tasks the plugin just drove to completion. Their CTA becomes 立即领取 and
  // the card carries the same campaign_code as data-reward-code.
  for (const t of st?.tasks ?? []) {
    if (t.status !== 2 || t.kind === "daily_signin" || !t.code) continue
    out.push({ code: t.code, label: t.title || t.code, credit: t.reward || 0 })
  }
  return out
}

/** Tasks the campaign says are not done yet (the ones that cost quota). */
export function todoTasks(st) {
  return (st?.tasks ?? []).filter((t) => t.status === 1 && t.kind !== "daily_signin")
}

/** Tasks that finished and are waiting to be collected. */
export function claimableTasks(st) {
  return (st?.tasks ?? []).filter((t) => t.status === 2 && t.kind !== "daily_signin")
}

/**
 * What actually changed between two server reads — the authoritative proof
 * that clicks inside the client converted into granted credit.
 */
export function diffClaims(before, after) {
  const got = []
  if (before?.checkin && after?.checkin && !before.checkin.checkedIn && after.checkin.checkedIn) {
    got.push({ label: "每日签到", credit: after.checkin.rewardAmount || before.checkin.rewardAmount || 0 })
  }
  const prev = new Map((before?.milestones ?? []).map((m) => [m.threshold, m.status]))
  for (const m of after?.milestones ?? []) {
    if (prev.get(m.threshold) === 2 && m.status === 3) {
      got.push({ label: m.title || `累计 ${m.threshold} 点额度`, credit: m.reward || 0 })
    }
  }
  // A task claimed in the same pass (daily sign-in also arrives as a task row
  // on some accounts, hence the kind filter upstream).
  const prevTasks = new Map((before?.tasks ?? []).map((t) => [t.code, t.status]))
  for (const t of after?.tasks ?? []) {
    if (t.kind === "daily_signin") continue
    if (prevTasks.get(t.code) === 2 && t.status === 3) {
      got.push({ label: t.title || t.code, credit: t.reward || 0 })
    }
  }
  return got
}

/** One line describing the page state, used by every caller's message. */
export function describeState(st) {
  const bits = []
  if (st?.checkin) bits.push(st.checkin.checkedIn ? "今日已签" : "今日未签")
  bits.push(`累计 ${Number(st?.totalAmount) || 0} 点`)
  const claimable = claimableCredit(st)
  if (claimable > 0) bits.push(`待领 ${claimable} 点`)
  const todo = todoTasks(st).length
  if (todo > 0) bits.push(`${todo} 个任务待完成`)
  return bits.join(" · ")
}
