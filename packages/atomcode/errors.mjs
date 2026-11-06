/**
 * One failure vocabulary for provider, quota and diagnostic paths.
 *
 * A 401 means the credential is no longer usable. A 403 is deliberately split:
 * only an explicit token/session refusal may mark the account expired. Plan,
 * quota and permission refusals are upstream answers about the account's
 * entitlement and must not force a refresh or a re-login loop.
 *
 * @module magpie-atomcode/errors
 */

import { redactText } from "./internal.mjs";

export const FAILURE = Object.freeze({
  NETWORK: "network",
  TIMEOUT: "timeout",
  UNAUTHORIZED: "unauthorized",
  CREDENTIAL_FORBIDDEN: "credential_forbidden",
  ENTITLEMENT_FORBIDDEN: "entitlement_forbidden",
  FORBIDDEN: "forbidden",
  RATE_LIMIT: "rate_limit",
  SIGNING: "signing",
  VERSION: "version",
  SERVER: "upstream_server",
  CLI_ACCOUNT_CHANGED: "cli_account_changed",
  INELIGIBLE: "ineligible",
  UNKNOWN: "unknown",
});

const CREDENTIAL_WORDS =
  /(?:access|refresh|oauth|bearer|session)[\s_-]*token|token[\s_-]*(?:is[\s_-]*)?(?:expired|invalid|revoked)|(?:invalid|expired|revoked)[\s_-]*token|unauthori[sz]ed|unauthenticated|authentication|credential|sign[\s-]*in|log[\s-]*in|login|令牌|凭证|会话|登录|重新认证/i;

const ENTITLEMENT_WORDS =
  /quota|rate[\s_-]*limit|usage[\s_-]*limit|limit[\s_-]*reached|too many requests|balance|credit|billing|subscription|entitlement|coding[\s_-]*plan|plan[\s_-]*(?:expired|unavailable|required)|no tier|not eligible|ineligible|余额|额度|套餐|名额|限额|限流|订阅|权益|档位|领取/i;

const VERSION_WORDS =
  /(?:atomcode|client)[\s_-]*(?:version|ua)|user[\s_-]*agent|upgrade|update required|版本|客户端/i;

const SIGNING_WORDS =
  /sign(?:ature|ing)|x-atomcode|hmac|master[\s_-]*key|签名|密钥/i;

const TIMEOUT_WORDS = /timeout|timed out|abort(?:ed)?|超时/i;
const NETWORK_WORDS =
  /fetch failed|network|socket|econn(?:reset|refused|aborted)|enotfound|eai_again|dns|tls|certificate|网络|连接/i;

function messageOf(error) {
  return redactText(error?.message ?? error ?? "", 300);
}

function numericStatus(error) {
  const value = Number(error?.status ?? error?.statusCode);
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

function explicitCategory(error) {
  const value = error?.category ?? error?.kind ?? error?.code;
  return Object.values(FAILURE).includes(value) ? value : undefined;
}

function forbiddenCategory(message) {
  if (CREDENTIAL_WORDS.test(message)) return FAILURE.CREDENTIAL_FORBIDDEN;
  if (ENTITLEMENT_WORDS.test(message)) return FAILURE.ENTITLEMENT_FORBIDDEN;
  return FAILURE.FORBIDDEN;
}

/**
 * Classify an error without changing it.
 *
 * @param {unknown} error
 * @param {{stage?: string}} [context]
 * @returns {{category: string, status?: number, message: string, retryable: boolean,
 *   refresh: boolean, signInExpired: boolean}}
 */
export function classifyError(error, { stage } = {}) {
  const status = numericStatus(error);
  const message = messageOf(error);
  let category = explicitCategory(error);

  if (!category && error?.name === "TimeoutError") category = FAILURE.TIMEOUT;
  if (!category && (error?.name === "AbortError" || TIMEOUT_WORDS.test(message))) {
    category = FAILURE.TIMEOUT;
  }
  if (!category && stage === "signing") category = FAILURE.SIGNING;
  if (!category && (SIGNING_WORDS.test(message) || /request body type for signing/i.test(message))) {
    category = FAILURE.SIGNING;
  }
  if (!category && /changed accounts|账号已切换/i.test(message)) {
    category = FAILURE.CLI_ACCOUNT_CHANGED;
  }
  if (!category && /no coding plan tier|not eligible|ineligible|no tier|名额|档位/i.test(message)) {
    category = FAILURE.INELIGIBLE;
  }
  if (!category && status === 401) category = FAILURE.UNAUTHORIZED;
  if (!category && status === 403) category = forbiddenCategory(message);
  if (!category && status === 429) category = FAILURE.RATE_LIMIT;
  if (!category && status !== undefined && status >= 500) category = FAILURE.SERVER;
  if (!category && VERSION_WORDS.test(message)) category = FAILURE.VERSION;
  if (!category && NETWORK_WORDS.test(message)) category = FAILURE.NETWORK;
  category ??= FAILURE.UNKNOWN;

  const retryable = [
    FAILURE.NETWORK,
    FAILURE.TIMEOUT,
    FAILURE.RATE_LIMIT,
    FAILURE.SERVER,
  ].includes(category);
  const refresh =
    category === FAILURE.UNAUTHORIZED ||
    category === FAILURE.CREDENTIAL_FORBIDDEN ||
    category === FAILURE.CLI_ACCOUNT_CHANGED;

  return {
    category,
    ...(status === undefined ? {} : { status }),
    message,
    retryable,
    refresh,
    signInExpired:
      category === FAILURE.UNAUTHORIZED ||
      category === FAILURE.CREDENTIAL_FORBIDDEN ||
      category === FAILURE.CLI_ACCOUNT_CHANGED,
  };
}

/** True only for a credential/session refusal that may be renewed. */
export function isCredentialFailure(error, context) {
  return classifyError(error, context).refresh;
}

/** True for failures another attempt may recover from. */
export function isTransientFailure(error, context) {
  return classifyError(error, context).retryable;
}

/**
 * Attach the classification to an existing Error without copying its secrets
 * into a new message. Existing `signIn` is preserved unless it is wrong.
 */
export function annotateError(error, context) {
  if (!(error instanceof Error)) {
    const original = error;
    error = new Error(messageOf(original));
    if (original?.status !== undefined) error.status = original.status;
    if (original?.statusCode !== undefined) error.status = original.statusCode;
  }
  const result = classifyError(error, context);
  error.category ??= result.category;
  if (result.status !== undefined) error.status ??= result.status;
  if (result.signInExpired) error.signIn = "expired";
  else if (error.signIn === "expired") delete error.signIn;
  return error;
}

/** The Magpie header that keeps an account signed in without reporting an error. */
export function keptResponseHeaders(response, classification) {
  if (
    response?.status === 403 &&
    classification?.category !== FAILURE.CREDENTIAL_FORBIDDEN
  ) {
    const headers = new Headers(response.headers);
    headers.set("x-magpie-sign-in", "kept");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  return response;
}
