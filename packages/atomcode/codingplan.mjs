/**
 * Client for the AtomGit CodingPlan REST API
 * (`https://api.gitcode.com/api/v5/coding-plan/*`).
 *
 * What the plugin needs from it:
 *
 *   - `status-v2`: the plan (name / type / expiry), the current window usage and
 *     the raw `rate_limit_windows` — the source for both the plan tier and the
 *     `auth.usage` windows.
 *   - `models-v2?plan_type=<Lite|Pro|Max>`: the account's model catalog, which
 *     varies by account and plan tier (Atom2Api's README lists models this
 *     account never receives), so it is always read live with a snapshot as
 *     the fallback.
 *
 * Plain bearer auth, `User-Agent: atomcode/<version>`, short timeouts — these
 * are metadata calls, not model traffic.
 *
 * @module magpie-atomcode/codingplan
 */

import {
  DEFAULT_CLIENT_VERSION,
  parseAtomInstant,
  readCappedResponseText,
  upstreamMessage,
} from "./internal.mjs";
import { classifyError, FAILURE } from "./errors.mjs";

const withBase = (base, path) => `${String(base).replace(/\/+$/, "")}/${path}`;

/**
 * The plan part of a status response. The real endpoint answers it under
 * `codingplan_free`; `plan` is a defensive fallback in case the upstream field
 * moves.
 */
export function planOf(status) {
  if (!status || typeof status !== "object") return null;
  const plan = status.codingplan_free ?? status.plan ?? null;
  return plan && typeof plan === "object" ? plan : null;
}

/**
 * Plan tier, spelled the way `models-v2?plan_type=` accepts it.
 *
 * Atom2Api's rule: the lowercase plan name containing "max" → Max, "pro" → Pro,
 * anything else → Lite ("CodingPlan Lite-体验版" and "Lite-beta" are Lite).
 */
export function planTier(planName) {
  const name = String(planName ?? "").toLowerCase();
  if (name.includes("max")) return "Max";
  if (name.includes("pro")) return "Pro";
  return "Lite";
}

const CLAIM_GRACE_MS = 24 * 3600_000;

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function blank(value) {
  return value === null || value === undefined || (typeof value === "string" && !value.trim());
}

function placeholderUsage(status) {
  const usage = status?.current_usage;
  return !!(usage && typeof usage === "object" && usage.placeholder === true);
}

/** A rate-limit row that carries a real window, not an empty object. */
function rateLimitRowHasSignal(raw) {
  if (!raw || typeof raw !== "object") return false;
  return [
    raw.window_hours,
    raw.window_size_seconds,
    raw.call_limit,
    raw.calls_used,
    raw.requests_limit,
    raw.requests_used,
    raw.request_count_limit,
    raw.request_count_used,
    raw.window_token_limit,
    raw.window_tokens_used,
    raw.token_limit,
    raw.tokens_used,
    raw.token_count_limit,
    raw.token_count_used,
    raw.tokens_limit,
    raw.limit_tokens,
    raw.usage_percent,
    raw.call_usage_percent,
    raw.requests_usage_percent,
    raw.token_usage_percent,
    raw.tokens_usage_percent,
  ].some((value) => finiteNumber(value) !== undefined);
}

function hasRealRateLimitWindows(status) {
  const rows = Array.isArray(status?.rate_limit_windows) ? status.rate_limit_windows : [];
  return rows.some(rateLimitRowHasSignal);
}

/**
 * `current_usage` describes a real window. `usage_percent` alone does not:
 * the placeholder payload reports `0` with no window at all.
 */
function hasRealCurrentUsage(status) {
  const usage = status?.current_usage;
  if (!usage || typeof usage !== "object" || usage.placeholder === true) return false;
  if (finiteNumber(usage.window_hours) !== undefined) return true;
  const limit = finiteNumber(usage.window_token_limit ?? usage.token_limit);
  if (limit !== undefined && limit > 0) return true;
  return typeof usage.reset_at === "string" && usage.reset_at.trim() !== "";
}

function hasRealQuotaWindow(status) {
  return hasRealRateLimitWindows(status) || hasRealCurrentUsage(status);
}

/** Remaining days or an expiry still inside the claim grace → the plan is live. */
function entitlementIsLive(plan, now) {
  if (!plan || typeof plan !== "object") return false;
  const remaining = finiteNumber(plan.remaining_days);
  if (remaining !== undefined && remaining > 0) return true;
  const expires = parseAtomInstant(plan.expires_at);
  return Number.isFinite(expires) && now <= expires + CLAIM_GRACE_MS;
}

/**
 * 套餐权益尚未确认。
 *
 * 明确信号是 `current_usage.placeholder === true`。另一条是未确认的免费套餐
 * 记录：`status === -1`，且没有领取时间、到期时间、剩余天数，也没有真实额度窗口。
 * 单独一个负数状态不够。仍在有效期内的套餐，或已经带真实额度窗口的套餐
 * （含已用 0%、额度耗尽、Pro/Max），都不是未确认。
 */
export function planIsUnconfirmed(status, now = Date.now()) {
  if (!status || typeof status !== "object") return false;
  const plan = planOf(status);
  if (entitlementIsLive(plan, now)) return false;
  if (hasRealQuotaWindow(status)) return false;
  if (placeholderUsage(status)) return true;
  if (!plan) return false;
  return (
    plan.status === -1 &&
    blank(plan.claimed_at) &&
    blank(plan.expires_at) &&
    blank(plan.remaining_days)
  );
}

/**
 * 额度数字不可用：未确认套餐，或占位用量旁边没有真实限流窗口。
 * 后者覆盖“套餐记录仍有效，但 current_usage 明确标了 placeholder”的情况，
 * 避免把 `usage_percent: 0` 画成剩余额度。
 */
export function planQuotaUnconfirmed(status, now = Date.now()) {
  if (!status || typeof status !== "object") return false;
  if (planIsUnconfirmed(status, now)) return true;
  return placeholderUsage(status) && !hasRealRateLimitWindows(status);
}

/**
 * 该账号是否需要（重新）领取 CodingPlan —— 插件"签到"语义的判定。
 *
 * 协议里没有独立的每日打卡端点：官方 `/login` 的申领就是唯一写入点
 * （`claim-v2`），"限量 1000 人/日""每日 10:00 放量"是平台侧的放量节奏。
 * 因此插件里的"签到" = 套餐缺失、到期，或权益仍是占位/未确认时的自动重领：
 *   - 没有 `codingplan_free`（从未领取或已彻底失效）→ 需要领取；
 *   - 占位或未确认套餐（见 {@link planIsUnconfirmed}）→ 需要领取；
 *   - `remaining_days` 明确为 0 → 需要重领；
 *   - `expires_at` 已过且超出 1 天宽限（到期日当天仍算有效）→ 需要重领。
 * 判定保持保守：真实有效套餐返回 false；拿不准时也不领取。
 */
export function planNeedsClaim(status, now = Date.now()) {
  const plan = planOf(status);
  if (!plan) return true;
  if (typeof plan.plan_name !== "string" || !plan.plan_name.trim()) return true;
  if (planIsUnconfirmed(status, now)) return true;
  const remaining = finiteNumber(plan.remaining_days);
  if (remaining !== undefined && remaining <= 0) return true;
  const expires = parseAtomInstant(plan.expires_at);
  if (Number.isFinite(expires) && now > expires + CLAIM_GRACE_MS) return true;
  return false;
}

async function request(
  base,
  path,
  token,
  {
    fetchImpl = (...args) => fetch(...args),
    clientVersion = DEFAULT_CLIENT_VERSION,
    timeoutMs = 20_000,
  } = {},
) {
  const res = await fetchImpl(withBase(base, path), {
    method: "GET",
    redirect: "error",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "user-agent": `atomcode/${clientVersion}`,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await readCappedResponseText(res, { label: "CodingPlan response" });
  if (!res.ok) {
    const message = upstreamMessage(text);
    const error = new Error(
      `CodingPlan returned HTTP ${res.status}${message ? `: ${message}` : ""}`,
    );
    error.status = res.status;
    const failure = classifyError(error);
    error.category = failure.category;
    if (failure.signInExpired) error.signIn = "expired";
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("CodingPlan did not answer JSON");
  }
}

/** `GET /coding-plan/status-v2` — plan + current window + rate_limit_windows. */
export async function fetchStatus(base, token, opts = {}) {
  return request(base, "coding-plan/status-v2", token, opts);
}

/**
 * `GET /coding-plan/models-v2?plan_type=…` for the account's tier.
 *
 * Rows without a display name, rows not available to the plan and deprecated
 * rows are dropped; an out-of-shape payload throws so callers fall back.
 *
 * @returns {Promise<object[]>} raw model rows, normalization happens upstream.
 */
export async function fetchModels(base, token, tier, opts = {}) {
  const r = await request(base, `coding-plan/models-v2?plan_type=${encodeURIComponent(tier)}`, token, opts);
  if (!Array.isArray(r)) throw new Error("models-v2 did not return a list");
  return r.filter((m) => {
    if (!m || typeof m !== "object") return false;
    if (typeof m.display_model_name !== "string" || !m.display_model_name.trim()) return false;
    if (m.plan_available === false) return false;
    if (m.status === "deprecated") return false;
    return true;
  });
}

/**
 * 领取 CodingPlan —— 签到（登录）闭环的最后一步。
 *
 * Atom2Api 在 OAuth 换到 token 后立刻做同一件事：按官方客户端的
 * Max → Pro → Lite 顺序 POST `/coding-plan/claim-v2`，`success` 或
 * `duplicate`（已领取过）即停；错误响应体也按 JSON 解出 `message`
 * （Atom2Api 的 `claim()` 同款）。幂等且只做领取，不改账号状态。
 *
 * 这个函数绝不抛错：领不成就把原因作为结果返回，让登录先成功。
 *
 * @returns {Promise<{claimed: boolean, tier: string, planName: string, message: string, attempts: object[]}>}
 */
export async function claimCodingPlan(
  base,
  token,
  {
    fetchImpl = (...args) => fetch(...args),
    clientVersion = DEFAULT_CLIENT_VERSION,
    timeoutMs = 8_000,
    totalTimeoutMs = 24_000,
  } = {},
) {
  let lastMessage = "no Coding Plan tier is currently available";
  const attempts = [];
  const deadline = Date.now() + totalTimeoutMs;
  for (const tier of ["Max", "Pro", "Lite"]) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      lastMessage = "CodingPlan claim timed out";
      break;
    }
    let status = 0;
    let response = null;
    let raw = "";
    try {
      const res = await fetchImpl(withBase(base, "coding-plan/claim-v2"), {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": `atomcode/${clientVersion}`,
        },
        body: JSON.stringify({ plan_type: tier }),
        signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, remaining))),
      });
      status = res.status;
      raw = await readCappedResponseText(res, { label: "CodingPlan claim response" });
      try {
        response = JSON.parse(raw);
      } catch {
        /* 非 JSON 响应体 → message 退回原文 */
      }
    } catch (error) {
      const failure = classifyError(error);
      attempts.push({ tier, httpStatus: 0, success: false, duplicate: false, message: error.message });
      lastMessage = error.message;
      return {
        claimed: false,
        duplicate: false,
        tier: "",
        planName: "",
        message: lastMessage,
        category: failure.category,
        attempts,
      };
    }
    const success = status >= 200 && status < 300 && response?.success === true;
    const duplicate = status >= 200 && status < 300 && response?.duplicate === true;
    const message =
      typeof response?.message === "string" && response.message
        ? response.message
        : response
          ? ""
          : upstreamMessage(raw) || `HTTP ${status}`;
    attempts.push({ tier, httpStatus: status, success, duplicate, message });
    if (success || duplicate) {
      return {
        claimed: true,
        // fresh（这次才领到）与 duplicate（本来就持有）在 checkin 语义里要分开：
        // 前者 = claimed，后者 = done。
        duplicate,
        tier: typeof response?.plan_type === "string" && response.plan_type ? response.plan_type : tier,
        planName: typeof response?.plan_name === "string" ? response.plan_name : "",
        message,
        attempts,
      };
    }
    // A transport/auth/rate-limit failure affects every tier. Only an
    // entitlement-shaped rejection is worth cascading to the next tier.
    if (![400, 404, 409, 422].includes(status)) {
      const failure = classifyError({ status: status || undefined, message });
      return {
        claimed: false,
        duplicate: false,
        tier: "",
        planName: "",
        message,
        category: failure.category,
        attempts,
      };
    }
    if (message) lastMessage = message;
  }
  const failure = classifyError({ message: lastMessage });
  return {
    claimed: false,
    duplicate: false,
    tier: "",
    planName: "",
    message: lastMessage,
    category:
      failure.category === FAILURE.UNKNOWN
        ? FAILURE.INELIGIBLE
        : failure.category,
    attempts,
  };
}
