import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { serviceURL, type StoredOAuth } from "./types.ts";

const SCOPES = "mcp:invoke";
const NETWORK_TIMEOUT = 15_000;
const LOGIN_TIMEOUT = 5 * 60_000;
// Lets GoAnyAPI attribute sign-ups to Magpie; authorization ignores it.
const SOURCE = "magpie";
const CALLBACK = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/callback$/;

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
        `GoAnyAPI OAuth request failed (${response.status}). Sign in again if access was revoked.`,
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
      "GoAnyAPI did not advertise an OAuth authorization server.",
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
      throw new Error("Invalid GoAnyAPI OAuth endpoint.");
  }
  if (!metadata.code_challenge_methods_supported?.includes("S256"))
    throw new Error("GoAnyAPI OAuth requires PKCE S256.");
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
    throw new Error("GoAnyAPI OAuth returned an invalid access token.");
  }
  if (
    tokens.expires_in !== undefined &&
    (!Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0)
  ) {
    throw new Error("GoAnyAPI OAuth returned an invalid token lifetime.");
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
      new Error("GoAnyAPI session expired. Sign in again in Magpie."),
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

interface SavedClient {
  issuer: string;
  clientId: string;
  redirectUri: string;
}

// The registered public client and its loopback callback are reused, so each
// sign-in does not register another OAuth application at GoAnyAPI.
async function savedClient(
  file: string | undefined,
  issuer: string,
): Promise<SavedClient | undefined> {
  if (!file) return undefined;
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as SavedClient;
    if (
      value?.issuer === issuer &&
      typeof value.clientId === "string" &&
      value.clientId &&
      typeof value.redirectUri === "string" &&
      CALLBACK.test(value.redirectUri)
    )
      return value;
  } catch {}
  return undefined;
}

function listen(server: Server, port: number) {
  return new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", failed);
      resolve();
    });
  });
}

export async function startOAuth(
  baseUrl: string,
  timeoutMs = LOGIN_TIMEOUT,
  clientFile?: string,
) {
  const metadata = await discover(baseUrl);
  let saved = await savedClient(clientFile, metadata.issuer);
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
              "GoAnyAPI authorization was declined. Try signing in again.",
          }
        : { code: code! },
    );
    res.end(
      error
        ? "Authorization declined. Return to Magpie."
        : "Authorization received. Return to Magpie to finish signing in.",
    );
  });
  try {
    await listen(server, saved ? Number(CALLBACK.exec(saved.redirectUri)![1]) : 0);
  } catch (error) {
    // Its port is taken: sign in through a new client instead.
    if (!saved) throw error;
    saved = undefined;
    await listen(server, 0);
  }
  server.unref();
  const close = () => {
    server.close();
    server.closeAllConnections();
  };
  const timer = setTimeout(() => {
    settle({ error: "GoAnyAPI sign-in timed out. Try again in Magpie." });
    close();
  }, timeoutMs);
  timer.unref();
  try {
    const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
    let clientId = saved?.clientId;
    if (!clientId) {
      const registration = await json<{
        client_id: string;
        token_endpoint_auth_method?: string;
      }>(metadata.registration_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "GoAnyAPI for Magpie",
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
        throw new Error("GoAnyAPI OAuth did not register a public client.");
      }
      clientId = registration.client_id;
      if (clientFile) {
        const record: SavedClient = {
          issuer: metadata.issuer,
          clientId,
          redirectUri: redirect,
        };
        // The client is public: losing this file costs one registration.
        await mkdir(dirname(clientFile), { recursive: true })
          .then(() =>
            writeFile(clientFile, JSON.stringify(record), { mode: 0o600 }),
          )
          .catch(() => {});
      }
    }
    const url = new URL(metadata.authorization_endpoint);
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirect,
      scope: SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      utm_source: SOURCE,
    }))
      url.searchParams.set(key, value);
    let completed = false;
    // A reused client the server no longer knows fails in the browser, so a
    // sign-in that does not finish registers afresh next time.
    const forget = async () => {
      if (saved && clientFile) await unlink(clientFile).catch(() => {});
    };
    return {
      url: url.href,
      instructions:
        "Sign in to GoAnyAPI in your browser, then return to Magpie. The browser must run on the same computer as Magpie.",
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
          if (response.error) {
            await forget();
            return { type: "failed" as const, error: response.error };
          }
          const tokens = await json<Tokens>(metadata.token_endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code: response.code!,
              redirect_uri: redirect,
              client_id: clientId,
              code_verifier: verifier,
            }),
          });
          const { type: _, ...auth } = credential(tokens, clientId, metadata);
          return { type: "success" as const, ...auth };
        } catch (error) {
          await forget();
          return {
            type: "failed" as const,
            error:
              error instanceof Error
                ? error.message
                : "GoAnyAPI OAuth failed.",
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
