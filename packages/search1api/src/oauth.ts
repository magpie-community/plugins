import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { serviceURL, type StoredOAuth } from "./types.ts";

const SCOPES = "openid profile email offline_access";
const NETWORK_TIMEOUT = 15_000;
const LOGIN_TIMEOUT = 5 * 60_000;

interface Metadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  code_challenge_methods_supported?: string[];
}
interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

async function json<T>(url: string, init: RequestInit = {}): Promise<T> {
  const timeout = AbortSignal.timeout(NETWORK_TIMEOUT);
  const response = await fetch(serviceURL(url), {
    ...init,
    signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  });
  if (!response.ok) {
    // Never surface response bodies: token errors can contain private data.
    const expired = response.status === 400 || response.status === 401;
    throw Object.assign(
      new Error(
        `Search1API OAuth request failed (${response.status}). Sign in again if access was revoked.`,
      ),
      expired ? { signIn: "expired" } : {},
    );
  }
  return (await response.json()) as T;
}

export async function discover(baseUrl: string): Promise<Metadata> {
  const resource = await json<{ authorization_servers?: string[] }>(
    `${baseUrl}/.well-known/oauth-protected-resource`,
  );
  const issuer = resource.authorization_servers?.[0];
  if (!issuer)
    throw new Error(
      "Search1API did not advertise an OAuth authorization server.",
    );
  const issuerURL = serviceURL(issuer);
  const discoveryURL = new URL(issuerURL);
  discoveryURL.pathname = `/.well-known/oauth-authorization-server${issuerURL.pathname.replace(/\/$/, "")}`;
  const metadata = await json<Metadata>(discoveryURL.href);
  if (metadata.issuer?.replace(/\/$/, "") !== issuer.replace(/\/$/, ""))
    throw new Error("OAuth issuer mismatch.");
  for (const endpoint of [
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.registration_endpoint,
  ]) {
    if (!endpoint || serviceURL(endpoint).origin !== issuerURL.origin)
      throw new Error("Invalid Search1API OAuth endpoint.");
  }
  if (!metadata.code_challenge_methods_supported?.includes("S256"))
    throw new Error("Search1API OAuth requires PKCE S256.");
  return metadata;
}

function credential(
  tokens: Tokens,
  clientId: string,
  metadata: Pick<Metadata, "issuer" | "token_endpoint">,
  priorRefresh = "",
): StoredOAuth {
  if (
    typeof tokens.access_token !== "string" ||
    !tokens.access_token ||
    (tokens.token_type && tokens.token_type.toLowerCase() !== "bearer")
  ) {
    throw new Error("Search1API OAuth returned an invalid access token.");
  }
  if (
    tokens.expires_in !== undefined &&
    (!Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0)
  ) {
    throw new Error("Search1API OAuth returned an invalid token lifetime.");
  }
  return {
    type: "oauth",
    access: tokens.access_token,
    refresh: tokens.refresh_token ?? priorRefresh,
    expires: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : 0,
    clientId,
    tokenEndpoint: metadata.token_endpoint,
    issuer: metadata.issuer,
  };
}

export async function refreshToken(
  auth: StoredOAuth,
  signal?: AbortSignal,
): Promise<StoredOAuth> {
  if (!auth.refresh)
    throw Object.assign(
      new Error("Search1API session expired. Sign in again in Magpie."),
      { signIn: "expired" },
    );
  const issuer = serviceURL(auth.issuer);
  if (serviceURL(auth.tokenEndpoint).origin !== issuer.origin)
    throw new Error("OAuth token endpoint does not match its issuer.");
  const tokens = await json<Tokens>(auth.tokenEndpoint, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.refresh,
      client_id: auth.clientId,
    }),
  });
  return credential(
    tokens,
    auth.clientId,
    { issuer: auth.issuer, token_endpoint: auth.tokenEndpoint },
    auth.refresh,
  );
}

export async function startOAuth(baseUrl: string, timeoutMs = LOGIN_TIMEOUT) {
  const metadata = await discover(baseUrl);
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  let settle!: (value: { code?: string; error?: string }) => void;
  const result = new Promise<{ code?: string; error?: string }>((resolve) => {
    settle = resolve;
  });
  let accepted = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method !== "GET" || url.pathname !== "/callback") {
      res.writeHead(404).end("Not found.");
      return;
    }
    // A stray request must not cancel the legitimate browser login.
    if (url.searchParams.get("state") !== state) {
      res.writeHead(400).end("Authorization state mismatch.");
      return;
    }
    if (
      url.searchParams.has("iss") &&
      url.searchParams.get("iss") !== metadata.issuer
    ) {
      res.writeHead(400).end("OAuth issuer mismatch.");
      return;
    }
    if (accepted) {
      res.writeHead(409).end("Authorization was already received.");
      return;
    }
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (!code && !error) {
      res.writeHead(400).end("Missing authorization code.");
      return;
    }
    accepted = true;
    settle(
      error
        ? {
            error:
              "Search1API authorization was declined. Try signing in again.",
          }
        : { code: code! },
    );
    res.end(
      error
        ? "Authorization declined. Return to Magpie."
        : "Authorization received. Return to Magpie to finish signing in.",
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  server.unref();
  const close = () => {
    server.close();
    server.closeAllConnections();
  };
  const timer = setTimeout(() => {
    settle({ error: "Search1API sign-in timed out. Try again in Magpie." });
    close();
  }, timeoutMs);
  timer.unref();
  try {
    const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
    const registration = await json<{
      client_id: string;
      token_endpoint_auth_method?: string;
    }>(metadata.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Search1API for Magpie",
        application_type: "native",
        redirect_uris: [redirect],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: SCOPES,
      }),
    });
    if (
      !registration.client_id ||
      (registration.token_endpoint_auth_method &&
        registration.token_endpoint_auth_method !== "none")
    ) {
      throw new Error("Search1API OAuth did not register a public client.");
    }
    const url = new URL(metadata.authorization_endpoint);
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: redirect,
      scope: SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }))
      url.searchParams.set(key, value);
    let completed = false;
    return {
      url: url.href,
      instructions:
        "Sign in to Search1API in your browser, then return to Magpie. The browser must run on the same computer as Magpie.",
      method: "auto" as const,
      async callback() {
        if (completed)
          return {
            type: "failed" as const,
            error: "This sign-in was already completed. Start a new sign-in.",
          };
        completed = true;
        try {
          const response = await result;
          if (response.error)
            return { type: "failed" as const, error: response.error };
          const tokens = await json<Tokens>(metadata.token_endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code: response.code!,
              redirect_uri: redirect,
              client_id: registration.client_id,
              code_verifier: verifier,
            }),
          });
          const { type: _, ...auth } = credential(
            tokens,
            registration.client_id,
            metadata,
          );
          return { type: "success" as const, ...auth };
        } catch (error) {
          return {
            type: "failed" as const,
            error:
              error instanceof Error
                ? error.message
                : "Search1API OAuth failed.",
          };
        } finally {
          clearTimeout(timer);
          close();
        }
      },
    };
  } catch (error) {
    clearTimeout(timer);
    close();
    throw error;
  }
}
