/**
 * CodingPlan status → Magpie `auth.usage` mapping.
 *
 * The plan's own fields supply `plan` (套餐名) and `until` (到期时间); every
 * `rate_limit_windows` row is mapped so additional windows from upstream are
 * not silently discarded. `auth.usage` percentages may legitimately exceed 100
 * when the quota is exhausted — Magpie renders that natively.
 *
 * Mapping is a pure function so the shape contract can be tested offline
 * against the real response captured in the plan document (§5.4).
 *
 * @module magpie-atomcode/quota
 */

import { planOf } from "./codingplan.mjs";
import { fill } from "./i18n.mjs";
import { atomInstantISO } from "./internal.mjs";

/** Number if finite (0 included), else undefined. */
export function num(v) {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Used-percentage fallback when the API does not hand one over. */
function pctOf(used, limit) {
  const count = num(used);
  const total = num(limit);
  if (count === undefined || !total) return undefined;
  return (count / total) * 100;
}

function resetOf(raw, fallback) {
  const secs = num(raw?.seconds_until_reset);
  if (secs !== undefined) return { resetSecs: secs };
  const resetsAt = atomInstantISO(raw?.reset_at ?? fallback?.reset_at);
  return resetsAt ? { resetsAt } : {};
}

function tokenWindow(usage, hours, reset, t) {
  const amount = num(usage.window_tokens_used ?? usage.tokens_used);
  const limit = num(usage.window_token_limit ?? usage.token_limit);
  if (amount === undefined || !limit) return undefined;
  const used = num(usage.token_usage_percent) ?? pctOf(amount, limit);
  return {
    name: fill(t.windowTokens, { hours }),
    ...(used !== undefined ? { used } : {}),
    span: hours * 3600,
    amount,
    unit: "tokens",
    limit,
    display: fill(t.tokensOf, { used: amount, total: limit }),
    ...reset,
  };
}

function tokenValues(raw) {
  return {
    amount: num(
      raw?.window_tokens_used ??
        raw?.tokens_used ??
        raw?.token_count_used ??
        raw?.tokens ??
        raw?.used_tokens,
    ),
    limit: num(
      raw?.window_token_limit ??
        raw?.token_limit ??
        raw?.token_count_limit ??
        raw?.tokens_limit ??
        raw?.limit_tokens,
    ),
    used: num(raw?.token_usage_percent ?? raw?.tokens_usage_percent),
  };
}

function callValues(raw) {
  return {
    amount: num(raw?.calls_used ?? raw?.requests_used ?? raw?.request_count_used),
    limit: num(raw?.call_limit ?? raw?.requests_limit ?? raw?.request_count_limit),
    used: num(raw?.call_usage_percent ?? raw?.requests_usage_percent),
  };
}

function rawUnit(raw) {
  const value = String(raw?.unit ?? raw?.quota_unit ?? raw?.limit_type ?? raw?.resource ?? "")
    .toLowerCase();
  if (/token|词元/.test(value)) return "tokens";
  if (/call|request|次/.test(value)) return "calls";
  return undefined;
}

function spanOf(raw) {
  const span = num(raw?.window_size_seconds) ?? (num(raw?.window_hours) ?? 5) * 3600;
  const hours = num(raw?.window_hours) ?? Math.max(1, Math.round(span / 3600));
  return { span, hours };
}

function rawTokenWindow(raw, t, usage) {
  const { amount, limit, used: declaredUsed } = tokenValues(raw);
  if (amount === undefined && limit === undefined && declaredUsed === undefined) return undefined;
  const { span, hours } = spanOf(raw);
  const used = declaredUsed ?? pctOf(amount, limit);
  return {
    name: fill(t.windowTokens, { hours }),
    ...(used !== undefined ? { used } : {}),
    span,
    ...(amount !== undefined ? { amount } : {}),
    unit: "tokens",
    ...(limit ? { limit } : {}),
    ...(limit && amount !== undefined
      ? { display: fill(t.tokensOf, { used: amount, total: limit }) }
      : {}),
    ...resetOf(raw, usage),
  };
}

function rawCallWindow(raw, t, usage) {
  const { amount, limit, used: declaredUsed } = callValues(raw);
  const { span, hours } = spanOf(raw);
  const used = declaredUsed ?? num(raw?.usage_percent) ?? pctOf(amount, limit);
  return {
    name: fill(t.windowHours, { hours }),
    ...(used !== undefined ? { used } : {}),
    span,
    ...(amount !== undefined ? { amount } : {}),
    unit: "calls",
    ...(limit ? { limit } : {}),
    ...(limit && amount !== undefined
      ? { display: fill(t.callsOf, { used: amount, total: limit }) }
      : {}),
    ...resetOf(raw, usage),
  };
}

function hasAnyValue(...values) {
  return values.some((value) => value !== undefined);
}

/**
 * Build the `auth.usage` payload from a `status-v2` response.
 *
 * @param {object} status - parsed `status-v2`.
 * @param {object} t - the i18n table for labels.
 * @param {{user?: string}} [context] - the account's display name for the row.
 * @returns {{plan?: string, user?: string, until?: string, windows: object[]}}
 */
export function quotaFromStatus(status, t, { user } = {}) {
  const plan = planOf(status) ?? {};
  const usage = status?.current_usage ?? {};
  const windows = [];

  const rawWindows = Array.isArray(status?.rate_limit_windows)
    ? status.rate_limit_windows.filter((w) => w && typeof w === "object")
    : [];
  const seen = new Set();
  const addWindow = (window) => {
    seen.add(`${window.unit}:${window.span}`);
    windows.push(window);
  };
  for (const raw of rawWindows) {
    const unit = rawUnit(raw);
    const tokens = tokenValues(raw);
    const calls = callValues(raw);
    const hasCallFields = hasAnyValue(calls.amount, calls.limit, calls.used);
    const hasTokenFields = hasAnyValue(tokens.amount, tokens.limit, tokens.used);
    const hasToken =
      unit === "tokens" ||
      (unit === undefined && !hasCallFields && hasTokenFields);
    const hasCall = !hasToken;
    if (hasToken) {
      const window = rawTokenWindow(raw, t, usage);
      const { span, hours } = spanOf(raw);
      addWindow(window ?? {
        name: fill(t.windowTokens, { hours }),
        span,
        unit: "tokens",
        ...resetOf(raw, usage),
      });
    }
    if (hasCall) {
      addWindow(rawCallWindow(raw, t, usage));
    }
  }
  const currentHours = num(usage.window_hours) ?? 5;
  const currentSpan = currentHours * 3600;
  const currentUnit = rawUnit(usage);
  const currentToken =
    currentUnit === "tokens"
      ? tokenWindow(usage, currentHours, resetOf(usage), t) ?? {
          name: fill(t.windowTokens, { hours: currentHours }),
          span: currentSpan,
          unit: "tokens",
          ...resetOf(usage),
        }
      : undefined;
  if (
    currentUnit !== "tokens" &&
    !seen.has(`calls:${currentSpan}`) &&
    (num(usage.usage_percent) !== undefined ||
      num(usage.window_hours) !== undefined)
  ) {
    // No window row (older shape?): fall back to the current_usage block.
    const used = num(usage.usage_percent);
    addWindow({
      name: fill(t.windowHours, { hours: currentHours }),
      ...(used !== undefined ? { used } : {}),
      span: currentSpan,
      unit: "calls",
      ...resetOf(usage),
    });
  }
  if (currentToken && !seen.has(`tokens:${currentToken.span}`)) {
    addWindow(currentToken);
  }

  return {
    ...(plan.plan_name ? { plan: plan.plan_name } : { plan: t.planFallback }),
    ...(user ? { user } : {}),
    ...(plan.expires_at
      ? { until: atomInstantISO(plan.expires_at) ?? String(plan.expires_at) }
      : {}),
    windows,
  };
}
