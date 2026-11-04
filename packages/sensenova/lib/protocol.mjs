/**
 * The platform's endpoints, its OAuth flows, and the console's own APIs.
 *
 * ENDPOINTS is a mutable object on purpose: the tests point it at a local fake
 * (the same shape `fake.mjs` uses), so no test can reach the real platform.
 * Production code reads the values at call time, never at import time.
 */

import { createHash } from "node:crypto";

export const ENDPOINTS = {
  console: "https://platform.sensenova.cn",
  // The password sign-in's IAM and token hosts (the console's own OIDC walk).
  iam: "https://iam.sensecoreapi.cn",
  token: "https://signin.sensecore.cn/oauth2/token",
  jwks: "https://signin.sensecore.cn/.well-known/jwks.json",
  // The browser sign-in's token host, which is the console origin.
  platformToken: "https://platform.sensenova.cn/oauth2/token",
  api: "https://token.sensenova.cn/v1",
};

export const CLIENT_ID = "nova";
export const REDIRECT_URI = "https://platform.sensenova.cn";
export const SCOPE = "openid offline offline_access";
export const TOKEN_PLAN_KEY_TYPE = "API_KEY_TYPE_TOKEN_PLAN";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

/** The browser sign-in's authorize endpoint (the console's own OAuth). */
export const authorizeUrl = () => `${ENDPOINTS.console}/oauth2/auth`;
/** The browser sign-in's token endpoint. */
export const browserTokenUrl = () => `${ENDPOINTS.console}/oauth2/token`;
/** The password sign-in's token endpoint (IAM's Hydra). */
export const passwordTokenUrl = () => ENDPOINTS.token;
/** The console's credit-pool endpoint. */
export const poolUsageUrl = () => `${ENDPOINTS.console}/lite/console/v1/tokenplan/pool-usage`;
/** The Token Plan API-key endpoint. */
export const apiKeysUrl = () => `${ENDPOINTS.console}/lite/console/v1/metered/api-keys`;
/** The OpenAI-compatible base the API key speaks to. */
export const apiBase = () => ENDPOINTS.api;

/** Protocol errors carry the HTTP status and the vendor's OAuth error code. */
export class ProtocolError extends Error {
  constructor(message, { status = 0, code = "" } = {}) {
    super(message);
    this.name = "ProtocolError";
    this.status = status;
    this.code = code;
  }

  get invalidGrant() {
    return this.code === "invalid_grant";
  }
}

/**
 * Vendor text goes into logs and the account card, so it must not carry a
 * credential. Only token-shaped runs are masked; the diagnostic words stay.
 */
const SECRETISH =
  /(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}[A-Za-z0-9._-]*|Bearer\s+(?:eyJ[A-Za-z0-9._-]{10,}|sk-[A-Za-z0-9-]{8,})|(?:refresh|access|id)_token["'=:\s]*[A-Za-z0-9._-]{20,}|sk-[A-Za-z0-9-]{20,})/gi;

export function cleanDetail(value) {
  return String(value ?? "").replace(SECRETISH, "***");
}

function clientHints() {
  return {
    "user-agent": UA,
    "sec-ch-ua": '"Chromium";v="152", "Not;A=Brand";v="24", "Google Chrome";v="152"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
  };
}

/** The token endpoints' browser-shaped headers (the platform's WAF expects them). */
export function tokenHeaders() {
  return {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
    origin: ENDPOINTS.console,
    referer: `${ENDPOINTS.console}/`,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    ...clientHints(),
  };
}

/** The console APIs' browser-shaped headers. */
export function consoleHeaders(accessToken) {
  return {
    authorization: `Bearer ${accessToken}`,
    accept: "application/json",
    "content-type": "application/json",
    origin: ENDPOINTS.console,
    referer: `${ENDPOINTS.console}/console/keys`,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    ...clientHints(),
  };
}

/** The credit-pool endpoint's headers. */
export function quotaHeaders(accessToken) {
  return {
    authorization: `Bearer ${accessToken}`,
    accept: "application/json",
    referer: `${ENDPOINTS.console}/console`,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    ...clientHints(),
  };
}

/** The browser sign-in URL (PKCE, prompt=login so a stale console session can't answer). */
export function buildAuthorizeUrl({ challenge, state }) {
  const q = new URLSearchParams();
  q.set("client_id", CLIENT_ID);
  q.set("response_type", "code");
  q.set("code_challenge", challenge);
  q.set("code_challenge_method", "S256");
  q.set("redirect_uri", REDIRECT_URI);
  q.set("state", state);
  q.set("scope", SCOPE);
  q.set("prompt", "login");
  return `${authorizeUrl()}?${q.toString()}`;
}

export function exchangeForm(code, verifier) {
  const form = new URLSearchParams();
  form.set("grant_type", "authorization_code");
  form.set("client_id", CLIENT_ID);
  form.set("code", code);
  form.set("redirect_uri", REDIRECT_URI);
  form.set("code_verifier", verifier);
  return form;
}

export function refreshForm(refreshToken) {
  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("client_id", CLIENT_ID);
  form.set("refresh_token", refreshToken);
  return form;
}

async function postToken(url, form, { timeoutMs = 20_000 } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: tokenHeaders(),
      body: form,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new ProtocolError(`token endpoint: ${cleanDetail(e?.message ?? e)}`);
  }
  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* a non-JSON body is handled by its status */
  }
  if (!res.ok || json?.error) {
    const code = typeof json?.error === "string" ? json.error : "";
    const detail = cleanDetail(json?.error_description || text.slice(0, 200).trim() || `HTTP ${res.status}`);
    throw new ProtocolError(`token endpoint: ${detail}`, { status: res.status, code });
  }
  if (!json || typeof json !== "object") {
    throw new ProtocolError("token endpoint returned non-JSON", { status: res.status });
  }
  return json;
}

/** Exchange the browser's authorization code with our PKCE verifier. */
export function exchangeCode({ code, verifier, timeoutMs }) {
  return postToken(browserTokenUrl(), exchangeForm(code, verifier), { timeoutMs });
}

/** Renew a browser sign-in's token pair (Hydra rotates the refresh token). */
export function refreshTokens(refreshToken, { timeoutMs } = {}) {
  return postToken(browserTokenUrl(), refreshForm(refreshToken), { timeoutMs });
}

/** Renew a password sign-in's token pair (IAM's Hydra). */
export function refreshPasswordTokens(refreshToken, { timeoutMs } = {}) {
  return postToken(passwordTokenUrl(), refreshForm(refreshToken), { timeoutMs });
}

/** Read the console's credit pools. */
export async function fetchPoolUsage(accessToken, { timeoutMs = 20_000 } = {}) {
  let res;
  try {
    res = await fetch(poolUsageUrl(), {
      headers: quotaHeaders(accessToken),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new ProtocolError(`credit-pool endpoint: ${cleanDetail(e?.message ?? e)}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new ProtocolError(`credit-pool endpoint refused the session (HTTP ${res.status})`, { status: res.status });
  }
  if (!res.ok) throw new ProtocolError(`credit-pool endpoint: HTTP ${res.status}`, { status: res.status });
  try {
    return await res.json();
  } catch {
    throw new ProtocolError("credit-pool endpoint returned non-JSON", { status: res.status });
  }
}

/** Decode a JWT payload; the token came from the vendor, so no signature check. */
export function jwtPayload(token) {
  const parts = String(token ?? "").trim().split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/** The console account's name and stable uid. */
export function identityFromTokens(tokens) {
  const claims = jwtPayload(tokens?.access_token) ?? {};
  const id = jwtPayload(tokens?.id_token) ?? {};
  const nested = id?.id_token ?? {};
  const pick = (...values) => {
    for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
    return "";
  };
  return {
    username: pick(
      claims?.ext?.username,
      claims?.username,
      nested?.username,
      claims?.preferred_username,
      claims?.email,
    ),
    uid: pick(claims?.sub, claims?.user_id, nested?.sub, nested?.user_id),
  };
}

/** A stable short fingerprint for names and cache buckets. */
export function keyFingerprint(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 12);
}

/** Trim a pasted key: spaces, a stray `Bearer `, and wrapping quotes. */
export function normalizeApiKey(value) {
  let s = String(value ?? "").trim();
  if (/^bearer\s+/i.test(s)) s = s.replace(/^bearer\s+/i, "");
  return s.replace(/^["'`]|["'`]$/g, "").trim();
}

/** A best-effort key check: only 401/403 says the key is invalid. */
export async function probeApiKey(apiKey, baseURL = apiBase(), { timeoutMs = 10_000 } = {}) {
  const res = await fetch(`${String(baseURL).replace(/\/+$/, "")}/models`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401 || res.status === 403) {
    throw new ProtocolError(`API key refused (HTTP ${res.status})`, { status: res.status });
  }
  return res.ok;
}

/* ------------------------------------------------------- console API keys */

async function consoleJson(url, accessToken, init = {}, { timeoutMs = 20_000 } = {}) {
  let res;
  try {
    res = await fetch(url, {
      ...init,
      headers: consoleHeaders(accessToken),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new ProtocolError(`console request failed: ${cleanDetail(e?.message ?? e)}`);
  }
  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* status-only response */
  }
  if (!res.ok) {
    const detail = cleanDetail(
      json?.message || json?.error_description || json?.error || text.slice(0, 200).trim() || `HTTP ${res.status}`,
    );
    throw new ProtocolError(`console refused the request (HTTP ${res.status}): ${detail}`, { status: res.status });
  }
  if (!json || typeof json !== "object") {
    throw new ProtocolError("console returned non-JSON", { status: res.status });
  }
  return json;
}

export function listApiKeys(accessToken, { timeoutMs, pageSize = 1 } = {}) {
  const q = new URLSearchParams({ key_type: TOKEN_PLAN_KEY_TYPE, page_size: String(pageSize) });
  return consoleJson(`${apiKeysUrl()}?${q.toString()}`, accessToken, { method: "GET" }, { timeoutMs });
}

export function createApiKey(accessToken, displayname, { timeoutMs } = {}) {
  return consoleJson(
    apiKeysUrl(),
    accessToken,
    { method: "POST", body: JSON.stringify({ displayname, key_type: TOKEN_PLAN_KEY_TYPE }) },
    { timeoutMs },
  );
}

export async function deleteApiKey(accessToken, id, { timeoutMs = 20_000 } = {}) {
  let res;
  try {
    res = await fetch(`${apiKeysUrl()}/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: consoleHeaders(accessToken),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new ProtocolError(`delete API key failed: ${cleanDetail(e?.message ?? e)}`);
  }
  if (res.ok) return true;
  if (res.status === 404) return false;
  const text = await res.text().catch(() => "");
  throw new ProtocolError(
    `delete API key failed (HTTP ${res.status}): ${cleanDetail(text.slice(0, 200).trim())}`,
    { status: res.status },
  );
}

export function createdApiKey(payload) {
  return String(payload?.api_key_plain ?? payload?.api_key ?? "").trim();
}
