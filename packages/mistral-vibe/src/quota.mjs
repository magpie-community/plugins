// The quota side: what is left of the plan's monthly Vibe Code allowance.
// The official CLI reads the same public billing API
// (vibe/app_server/_billing.py): /v1/billing/budget names the percentage of
// both budgets spent and when they reset, /v1/billing/subscription names the
// plan, and console.mistral.ai/api/vibe/whoami names the key's scope. The
// gateway only ever called whoami; the budgets are what magpie's usage card
// needs.
//
// The key's scope decides which budget stops the account: a Vibe key's
// requests spend the Vibe Code allowance first, a Studio/API key's spend the
// API budget first. The other budget is shown set aside (aside), never routed
// on, so a spent API budget can't rest an account whose Vibe allowance has
// room.

import { CONSOLE_ROOT, V1 } from "./constants.mjs"

const TIMEOUT_MS = 8_000

async function getJson(url, key) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) {
    const error = new Error(`${url} answered ${response.status}`)
    error.status = response.status
    throw error
  }
  return await response.json()
}

const settled = async (promise) => {
  try {
    return { value: await promise }
  } catch (error) {
    return { error }
  }
}

function resetOf(value) {
  if (typeof value !== "string" || !value.trim()) return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? new Date(at).toISOString() : null
}

function budgetWindow(name, detail) {
  const used = Math.max(0, Number(detail.usage_percentage) || 0)
  const limit = Number(detail.initial_budget) || 0
  const currency = typeof detail.currency === "string" ? detail.currency.trim() : ""
  const window = { name, used }
  if (limit > 0) {
    const spent = (limit * used) / 100
    Object.assign(window, {
      amount: spent,
      limit,
      unit: currency || "%",
      display: `${spent.toFixed(2)} / ${limit.toFixed(2)}${currency ? ` ${currency}` : ""}`,
    })
  } else {
    Object.assign(window, { amount: used, limit: 100, unit: "%", display: `${used.toFixed(1)}%` })
  }
  const resetsAt = resetOf(detail.reset_at)
  if (resetsAt) window.resetsAt = resetsAt
  return window
}

export async function readQuota(key) {
  const [who, subscription, budget] = await Promise.all([
    settled(getJson(`${CONSOLE_ROOT}/api/vibe/whoami`, key)),
    settled(getJson(`${V1}/billing/subscription`, key)),
    settled(getJson(`${V1}/billing/budget`, key)),
  ])

  const plan = subscription.value?.plan_name || who.value?.plan_name || "Mistral Vibe"

  // A 401 anywhere means Mistral refused the key itself: magpie tells the
  // account to sign in again, rather than showing an empty card.
  for (const result of [who, subscription, budget]) {
    if (result.error?.status === 401) {
      return { plan, windows: [], signIn: "expired", error: "Mistral refused this Vibe key (401); copy a fresh one from chat.mistral.ai/code/extensions" }
    }
  }

  if (budget.error) {
    const status = budget.error.status
    const why =
      status === 403
        ? "this key may not read the organization's usage (see_org_inference_usage)"
        : status === 404
          ? "this account has no billing endpoint"
          : budget.error.message
    return { plan, windows: [], signIn: "kept", error: `Vibe Code budget unreadable: ${why}` }
  }

  const vibe = budget.value?.vibe_budget
  const api = budget.value?.api_budget
  if (!vibe && !api) {
    const kind = who.value?.plan_type ? ` (key scope: ${who.value.plan_type})` : ""
    return { plan, windows: [], signIn: "kept", error: `no Vibe Code budget on this plan${kind}` }
  }

  // whoami's plan_type is the key's scope: "CHAT" is a Vibe key, "API" a
  // workspace one. Unknown reads as a Vibe key, the case this plugin is for.
  const scope = String(who.value?.plan_type ?? "").toLowerCase()
  const primary = scope === "api" || scope === "workspace" ? "api" : "vibe"
  const windows = []
  if (vibe) windows.push(budgetWindow("Vibe Code budget", vibe))
  if (api) windows.push(budgetWindow("API budget", api))
  for (const window of windows) {
    if (!window.name.toLowerCase().startsWith(primary === "api" ? "api" : "vibe")) window.aside = true
  }
  return { plan, windows, signIn: "kept" }
}
