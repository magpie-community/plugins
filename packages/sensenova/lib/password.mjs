/**
 * The console's password sign-in: the OIDC walk the console's own SPA uses,
 * with the password sealed into a JWE before it leaves this machine.
 *
 * This is the method the upstream package shipped. It is kept as the headless
 * fallback; the browser method does not send a password anywhere.
 */

import { createPkce } from "./pkce.mjs";
import { CLIENT_ID, ENDPOINTS, REDIRECT_URI, SCOPE, cleanDetail, tokenHeaders } from "./protocol.mjs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const TIMEOUT_MS = 20_000;
const MAX_HOPS = 8;
const ENC_KEY_ID = "public:hydra.openid.id-token";

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

/** The hosts the walk may visit; the endpoint origins are always allowed. */
const PLATFORM_HOSTS = [/(^|\.)sensenova\.cn$/, /(^|\.)sensecore\.cn$/, /(^|\.)sensecoreapi\.cn$/];

function allowedHost(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const sameOrigin = (e) => {
    try {
      const x = new URL(e);
      return x.host === u.host && x.protocol === u.protocol;
    } catch {
      return false;
    }
  };
  if (Object.values(ENDPOINTS).some(sameOrigin)) return true;
  if (u.protocol !== "https:") return false;
  return PLATFORM_HOSTS.some((re) => re.test(u.hostname));
}

/**
 * A cookie jar that honours Domain, Path and expiry. The console's Hydra
 * cookies can be domain-scoped, and a Max-Age=0 must delete one.
 */
function newJar() {
  return new Map(); // name -> { value, domain, path, expires }
}

function collectCookies(response, jar, url) {
  const host = hostOf(url);
  if (!host) return;
  const lines = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  for (const line of lines) {
    const parts = String(line).split(";");
    const pair = parts[0] ?? "";
    const attrs = parts.slice(1);
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    let domain = host;
    let path = "/";
    let expires = Infinity;
    for (const raw of attrs) {
      const [k, ...rest] = raw.trim().split("=");
      const v = rest.join("=").trim();
      const key = k.toLowerCase();
      if (key === "domain" && v) domain = v.replace(/^\./, "").toLowerCase();
      else if (key === "path" && v) path = v;
      else if (key === "max-age" && /^-?\d+$/.test(v)) {
        const s = Number(v);
        expires = s <= 0 ? 0 : Date.now() + s * 1000;
      } else if (key === "expires" && v) {
        const t = Date.parse(v);
        if (Number.isFinite(t)) expires = t;
      }
    }
    if (expires <= Date.now()) jar.delete(name);
    else jar.set(name, { value, domain, path, expires });
  }
}

function cookieHeader(jar, url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return "";
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname || "/";
  const now = Date.now();
  const out = [];
  for (const [name, c] of jar) {
    if (c.expires <= now) {
      jar.delete(name);
      continue;
    }
    const domainOk = host === c.domain || host.endsWith(`.${c.domain}`);
    const pathOk = path === c.path || path.startsWith(c.path.endsWith("/") ? c.path : `${c.path}/`);
    if (domainOk && pathOk) out.push(`${name}=${c.value}`);
  }
  return out.join("; ");
}

async function httpGet(url, jar) {
  if (!allowedHost(url)) throw new Error(`refusing to visit ${url}: outside the SenseNova hosts`);
  const headers = { "user-agent": UA, accept: "*/*" };
  const cookie = cookieHeader(jar, url);
  if (cookie) headers.cookie = cookie;
  return fetch(url, { redirect: "manual", headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

function resolveUrl(value, base) {
  try {
    return new URL(value, base).href;
  } catch {
    return value;
  }
}

/** Find the next hop in a client-rendered body, resolving relative URLs. */
function nextFromBody(body, wanted, base) {
  if (!body) return "";
  const found = [];
  for (const m of body.matchAll(/https?:\/\/[^"'\s<>]+[?&][^"'\s<>]*/g)) found.push(m[0]);
  const meta = /<meta[^>]+http-equiv=["']refresh["'][^>]+url=["']([^"']+)/i.exec(body);
  if (meta) found.push(meta[1]);
  for (const p of [
    /window\.location\.replace\(["']([^"']+)["']/,
    /window\.location\.href\s*=\s*["']([^"']+)["']/,
    /location\.href\s*=\s*["']([^"']+)["']/,
  ]) {
    const f = p.exec(body);
    if (f) found.push(f[1]);
  }
  for (const raw of found) {
    const u = resolveUrl(raw, base);
    if (allowedHost(u) && wanted.test(u)) return u;
  }
  return "";
}

async function followUntil(start, wanted, jar) {
  let location = start;
  for (let hop = 0; hop < MAX_HOPS && location; hop++) {
    if (!allowedHost(location)) throw new Error(`the sign-in walk left the SenseNova hosts for ${location}`);
    if (wanted.test(location)) return location;
    const res = await httpGet(location, jar);
    collectCookies(res, jar, location);
    const next = res.headers.get("location") ?? "";
    location = next !== "" ? resolveUrl(next, location) : nextFromBody(await res.text(), wanted, location);
  }
  if (location && wanted.test(location)) {
    if (!allowedHost(location)) throw new Error(`the sign-in walk left the SenseNova hosts for ${location}`);
    return location;
  }
  return "";
}

/** Seal the password into the 5-segment compact JWE the IAM endpoint wants. */
async function sealPassword(password) {
  const res = await fetch(ENDPOINTS.jwks, {
    headers: { accept: "application/json", "user-agent": UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`JWKS endpoint: HTTP ${res.status}`);
  const keys = (await res.json())?.keys ?? [];
  const key = keys.find((k) => k.kid === ENC_KEY_ID);
  if (!key) throw new Error(`JWKS has no key ${ENC_KEY_ID}`);

  const rsaKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: key.n, e: key.e, alg: "RSA-OAEP", ext: true },
    { name: "RSA-OAEP", hash: "SHA-1" },
    false,
    ["encrypt"],
  );
  const contentKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", contentKey));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const protectedHeader = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RSA-OAEP", enc: "A256GCM" })));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(protectedHeader), tagLength: 128 },
      contentKey,
      new TextEncoder().encode(password),
    ),
  );
  const ciphertext = sealed.subarray(0, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);
  const encryptedKey = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsaKey, rawKey);
  return [protectedHeader, b64url(encryptedKey), b64url(iv), b64url(ciphertext), b64url(tag)].join(".");
}

/** The walk's pure guards, exposed for the tests through index._internal. */
export const walkInternals = { allowedHost, newJar, cookieHeader, collectCookies, followUntil };

function iamHeaders() {
  return {
    "content-type": "application/json",
    "user-agent": UA,
    accept: "application/json",
    origin: ENDPOINTS.console,
    referer: `${ENDPOINTS.console}/`,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
  };
}

/**
 * Sign in with the console account and password. Returns access/refresh/expires
 * plus `tokenHost: "password"`, so refresh() knows which token endpoint answers.
 */
export async function passwordLogin(username, password) {
  const user = String(username ?? "").trim();
  const secret = String(password ?? "");
  if (!user || !secret.trim()) throw new Error("username and password are required");

  const jar = newJar();
  const { verifier, challenge } = createPkce();
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));

  const authUrl =
    `${ENDPOINTS.console}/oauth2/auth?` +
    new URLSearchParams({
      client_id: CLIENT_ID,
      code_challenge: challenge,
      code_challenge_method: "S256",
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: SCOPE,
      state: nonce,
    }).toString();
  const first = await httpGet(authUrl, jar);
  collectCookies(first, jar, authUrl);
  const challengeUrl = await followUntil(first.headers.get("location") ?? authUrl, /[?&]login_challenge=/, jar);
  const paramOf = (url, name) => {
    try {
      return new URL(url).searchParams.get(name) ?? "";
    } catch {
      return "";
    }
  };
  const loginChallenge = paramOf(challengeUrl, "login_challenge");
  if (!loginChallenge) throw new Error("could not obtain a login challenge from the authorization endpoint");

  const encrypted = await sealPassword(secret);
  const iamRes = await fetch(`${ENDPOINTS.iam}/iam/authn/v1/auth/nova/login`, {
    method: "POST",
    headers: { ...iamHeaders(), cookie: cookieHeader(jar, ENDPOINTS.iam) },
    body: JSON.stringify({ username: user, password: encrypted, challenge: loginChallenge, is_encrypt: true }),
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const iamBody = await iamRes.json().catch(() => ({}));
  const redirect = iamBody?.redirect ?? "";
  if (!iamRes.ok || !redirect) {
    const reason = iamBody?.details?.find?.((d) => d?.reason)?.reason ?? iamBody?.message ?? `HTTP ${iamRes.status}`;
    throw Object.assign(new Error(`login refused: ${cleanDetail(reason)}`), {
      kind: /locked|disabled|tooMany|rateLimit|tooManyRequests/i.test(String(reason)) ? "retryable" : "credential",
    });
  }

  const codeUrl = await followUntil(resolveUrl(redirect, ENDPOINTS.iam), /[?&]code=/, jar);
  const code = paramOf(codeUrl, "code");
  const state = paramOf(codeUrl, "state");
  if (!code) throw new Error("callback ended without an authorization code");
  if (state !== nonce) throw new Error("callback state did not match the issued nonce");

  const tokenRes = await fetch(ENDPOINTS.token, {
    method: "POST",
    headers: tokenHeaders(),
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
    }).toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !body.access_token) {
    throw new Error(
      `token exchange failed: ${cleanDetail(body.error_description ?? body.error ?? `HTTP ${tokenRes.status}`)}`,
    );
  }
  return {
    access: body.access_token,
    refresh: body.refresh_token ?? "",
    expires: Date.now() + (Number(body.expires_in) || 10800) * 1000,
    tokenHost: "password",
  };
}
