// Convert the QianWen CLI's Token Plan responses into Magpie's usage card.
// Missing measurements are unknown, never zero; the plan has no 5-hour quota.
export class QuotaError extends Error {}

function integer(value, name) {
  if (!Number.isFinite(value)) throw new QuotaError(`${name} is missing or invalid`)
  return Math.round(value)
}

export function readAllowance(subscription, quotaConfig, usage, now = Date.now()) {
  if (!subscription || subscription.status !== "VALID" || typeof subscription.specCode !== "string") {
    throw new QuotaError("no active Token Plan subscription")
  }
  if (!Number.isFinite(subscription.startTime) || !Number.isFinite(subscription.endTime)
    || subscription.endTime <= subscription.startTime || now < subscription.startTime
    || now >= subscription.endTime) {
    throw new QuotaError("Token Plan subscription is not active")
  }

  const plan = quotaConfig?.[subscription.specCode]
  if (!plan || typeof plan !== "object") throw new QuotaError("Token Plan quota is not configured")
  const total = integer(plan.weekly ?? plan.monthly, "allowance")
  if (total <= 0) throw new QuotaError("allowance is missing or invalid")

  let used, reset
  if (typeof usage?.per1MonthPercentage === "number") {
    used = usage.per1MonthPercentage
    reset = usage.per1MonthResetTime
  } else if (typeof usage?.per1WeekPercentage === "number") {
    used = usage.per1WeekPercentage
    reset = usage.per1WeekResetTime
  } else {
    throw new QuotaError("monthly usage is not reported")
  }
  if (!Number.isFinite(used) || used < 0 || used > 1) throw new QuotaError("monthly usage is invalid")
  const resetMs = typeof reset === "number" ? reset : Date.parse(reset)
  if (!Number.isFinite(resetMs) || resetMs <= 0) throw new QuotaError("reset time is missing or invalid")

  const spent = Math.round(total * used * 100) / 100
  const remaining = Math.max(0, Math.round((total - spent) * 100) / 100)
  return {
    plan: `Token Plan (${subscription.specCode})`,
    until: new Date(subscription.endTime).toISOString(),
    renew: subscription.autoRenewFlag === true ? "auto" : "off",
    windows: [{
      name: "Month",
      used: Math.round(used * 10000) / 100,
      amount: spent,
      limit: total,
      unit: "credits",
      display: `${spent} / ${total} credits`,
      startsAt: new Date(subscription.startTime).toISOString(),
      span: (resetMs - subscription.startTime) / 1000,
      resetsAt: new Date(resetMs).toISOString(),
    }],
    balance: `${remaining} credits`,
  }
}
