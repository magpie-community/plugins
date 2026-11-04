/**
 * Loopback-only, read-only diagnostics for the Magpie host.
 *
 * Magpie settings pages cannot make network requests (`connect-src 'none'`),
 * so `page/index.html` is only a bridge that navigates to this service. The
 * service itself owns the real page and API, making every API request
 * same-origin. It never calls AtomGit and never exposes a token or full account
 * id.
 *
 * @module magpie-atomcode/diagnostics
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import { signAtomGitRequest } from "./sign.mjs";
import { accountDigest } from "./state.mjs";

export const DEFAULT_DIAGNOSTICS_PORT = 3478;
export const DIAGNOSTICS_TOKEN_HEADER = "x-atomcode-token";

const active = new Map();
const PAGE_DIR = new URL("./page/", import.meta.url);
const ASSET_TYPES = {
  "/app.css": "text/css; charset=utf-8",
  "/app.js": "text/javascript; charset=utf-8",
  "/icon.svg": "image/svg+xml; charset=utf-8",
};

const securityHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "cross-origin",
};

/** A valid diagnostics port, or the fallback. */
export function diagnosticsPort(value, fallback = DEFAULT_DIAGNOSTICS_PORT) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65_535
    ? port
    : fallback;
}

export function hostAllowed(host, port) {
  if (!port || typeof host !== "string") return false;
  const value = host.toLowerCase();
  return value === `127.0.0.1:${port}` || value === `localhost:${port}`;
}

export function originAllowed(origin, port, { required = false } = {}) {
  if (origin === undefined) return !required;
  if (origin === "null") return true;
  return (
    origin === `http://127.0.0.1:${port}` ||
    origin === `http://localhost:${port}`
  );
}

function corsHeaders(req, port, methods) {
  const origin = req.headers.origin;
  return {
    ...(origin !== undefined && originAllowed(origin, port)
      ? { "access-control-allow-origin": origin }
      : {}),
    "access-control-allow-methods": methods,
    "access-control-allow-headers": DIAGNOSTICS_TOKEN_HEADER,
    vary: "Origin",
  };
}

function tokenAllowed(got, wanted) {
  const left = Buffer.from(String(got ?? ""));
  const right = Buffer.from(String(wanted ?? ""));
  return right.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

function headers(type, extra = {}) {
  return {
    ...securityHeaders,
    ...(type ? { "content-type": type } : {}),
    ...extra,
  };
}

/**
 * Magpie renders plugin pages inside a sandboxed frame, so the page must name
 * the desktop ancestors and list its own loopback origins instead of relying on
 * `'self'`, which a sandboxed frame does not always match in WebKit.
 */
function pagePolicy(port, nonce) {
  const loopback = [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ].join(" ");
  return [
    "default-src 'none'",
    `style-src 'self' ${loopback}`,
    `script-src 'self' ${loopback} 'nonce-${nonce}'`,
    `img-src 'self' ${loopback}`,
    `connect-src 'self' ${loopback}`,
    "base-uri 'none'",
    "frame-ancestors 'self' wails://localhost http://wails.localhost",
    "form-action 'none'",
  ].join("; ");
}

async function readBody(req, max = 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > max) {
      const error = new Error("request body is too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A deterministic, network-free signature check. */
export function runSelfCheck({
  clientVersion = "5.2.3",
  masterKeyHex = "",
  now = Date.now(),
} = {}) {
  const started = performance.now();
  let ok = false;
  try {
    const signed = signAtomGitRequest({
      method: "POST",
      path: "/v1/chat/completions",
      body: '{"model":"diagnostic"}',
      oauthToken: "diagnostic-access-token",
      userId: "diagnostic-user",
      clientVersion,
      masterKeyHex,
      timestamp: Math.floor(now / 1000),
      nonce: Buffer.alloc(16, 7),
    });
    ok =
      Object.keys(signed).length === 5 &&
      /^v1:[0-9a-f]{64}$/.test(signed["X-AtomCode-Sig"]) &&
      signed["X-AtomCode-Ver"] === clientVersion;
  } catch {
    ok = false;
  }
  return {
    ok,
    at: Date.now(),
    ms: Math.max(0, Math.round((performance.now() - started) * 10) / 10),
    checks: {
      signature: ok,
      version: /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(clientVersion),
      configuration: /^[0-9a-fA-F]{64}$/.test(masterKeyHex),
    },
  };
}

/** Build the stable, redacted data shape consumed by the page. */
export async function diagnosticsSnapshot({
  state,
  version,
  config = {},
  generatedAt = Date.now(),
} = {}) {
  const accounts = Object.values(state?.accounts ?? {});
  const account = accounts[0];
  return {
    product: "magpie-atomcode",
    schemaVersion: state?.version ?? 1,
    generatedAt: new Date(generatedAt).toISOString(),
    account: account
      ? {
          digest: account.digest,
          loginSource: account.loginSource ?? "unknown",
        }
      : undefined,
    models: account?.models?.length
      ? {
          source: account.modelSource ?? "cached",
          updatedAt: account.modelUpdatedAt,
          count: account.models.length,
          names: account.models.map((model) => model.id),
        }
      : { source: "built-in", count: 0, names: [] },
    quota: account?.quota
      ? {
          ...account.quota,
          capturedAt: account.quotaUpdatedAt,
          stale: true,
        }
      : undefined,
    version: version ?? state?.versionSource,
    lastError: account?.lastError,
    selfCheck: account?.selfCheck,
    config: {
      locale: config.locale,
      autoClaim: config.autoClaim,
      autoVersion: config.autoVersion,
      diagnosticsPort: config.diagnosticsPort,
      readOnly: true,
    },
    runtime: {
      node: process.version,
      platform: process.platform,
    },
  };
}

function pageLocale(value, fallback) {
  const language = String(value ?? "").toLowerCase();
  if (language.startsWith("zh")) return "zh";
  if (language.startsWith("en")) return "en";
  return fallback === "zh" ? "zh" : "en";
}

function htmlFor(template, token, locale, theme, nonce) {
  return template
    .replaceAll("{{TOKEN}}", token)
    .replaceAll("{{LOCALE}}", locale === "zh" ? "zh" : "en")
    .replaceAll("{{THEME}}", theme === "dark" || theme === "light" ? theme : "")
    .replaceAll("{{CSP_NONCE}}", nonce);
}

/**
 * Start one service per port. Re-initialization returns the existing service;
 * a foreign listener rejects `ready` with an actionable EADDRINUSE error.
 */
export function startDiagnosticsService({
  port = DEFAULT_DIAGNOSTICS_PORT,
  stateStore,
  versionSource,
  config = {},
  locale = "en",
  selfCheckConfig = {},
} = {}) {
  const wantedPort = diagnosticsPort(port);
  const existing = active.get(wantedPort);
  if (existing) return existing;

  const token = randomBytes(32).toString("hex");
  let htmlTemplate;

  async function template() {
    htmlTemplate ??= await readFile(new URL("diagnostics.html", PAGE_DIR), "utf8");
    return htmlTemplate;
  }

  async function stateSnapshot() {
    const state = stateStore ? await stateStore.read().catch(() => undefined) : undefined;
    const version = versionSource?.status?.();
    return diagnosticsSnapshot({
      state,
      version: version
        ? {
            ...version,
            checkedAt:
              version.checkedAt === undefined
                ? undefined
                : new Date(version.checkedAt).toISOString(),
            failedAt:
              version.failedAt === undefined
                ? undefined
                : new Date(version.failedAt).toISOString(),
          }
        : undefined,
      config: {
        ...config,
        autoClaim: typeof config.autoClaim === "function" ? config.autoClaim() : config.autoClaim,
        autoVersion: typeof config.autoVersion === "function" ? config.autoVersion() : config.autoVersion,
      },
    });
  }

  const server = createServer(async (req, res) => {
    const portNow = server.address()?.port ?? wantedPort;
    if (!hostAllowed(req.headers.host, portNow)) {
      res.writeHead(403, headers("text/plain; charset=utf-8")).end("Forbidden");
      return;
    }

    let url;
    try {
      url = new URL(req.url ?? "/", `http://127.0.0.1:${portNow}`);
    } catch {
      res.writeHead(400, headers("text/plain; charset=utf-8")).end("Bad request");
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const localeNow = pageLocale(url.searchParams.get("lang"), locale);
      const theme = url.searchParams.get("theme");
      const nonce = randomBytes(16).toString("base64");
      res
        .writeHead(
          200,
          headers(
            "text/html; charset=utf-8",
            {
              "content-security-policy": pagePolicy(portNow, nonce),
            },
          ),
        )
        .end(htmlFor(await template(), token, localeNow, theme, nonce));
      return;
    }

    if (req.method === "GET" && ASSET_TYPES[url.pathname]) {
      try {
        const asset = await readFile(new URL(url.pathname.slice(1), PAGE_DIR), "utf8");
        res.writeHead(200, headers(ASSET_TYPES[url.pathname])).end(asset);
      } catch {
        res.writeHead(404, headers("text/plain; charset=utf-8")).end("Not found");
      }
      return;
    }

    if (
      req.method === "OPTIONS" &&
      (url.pathname === "/api/state" || url.pathname === "/api/self-check")
    ) {
      if (!originAllowed(req.headers.origin, portNow, { required: true })) {
        res.writeHead(403, headers("text/plain; charset=utf-8")).end("Forbidden");
        return;
      }
      const methods =
        url.pathname === "/api/self-check" ? "POST, OPTIONS" : "GET, OPTIONS";
      res
        .writeHead(204, headers(undefined, corsHeaders(req, portNow, methods)))
        .end();
      return;
    }

    if (url.pathname === "/api/state" && req.method === "GET") {
      if (
        !tokenAllowed(req.headers[DIAGNOSTICS_TOKEN_HEADER], token) ||
        !originAllowed(req.headers.origin, portNow)
      ) {
        res.writeHead(403, headers("text/plain; charset=utf-8")).end("Forbidden");
        return;
      }
      const snapshot = await stateSnapshot();
      res
        .writeHead(
          200,
          headers(
            "application/json; charset=utf-8",
            corsHeaders(req, portNow, "GET, OPTIONS"),
          ),
        )
        .end(JSON.stringify(snapshot));
      return;
    }

    if (url.pathname === "/api/self-check" && req.method === "POST") {
      if (
        !tokenAllowed(req.headers[DIAGNOSTICS_TOKEN_HEADER], token) ||
        !originAllowed(req.headers.origin, portNow, { required: true })
      ) {
        res.writeHead(403, headers("text/plain; charset=utf-8")).end("Forbidden");
        return;
      }
      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        res.writeHead(error.status ?? 400, headers("text/plain; charset=utf-8")).end("Bad request");
        return;
      }
      if (url.search || body !== "") {
        res.writeHead(400, headers("text/plain; charset=utf-8")).end("Invalid request");
        return;
      }
      const result = runSelfCheck(selfCheckConfig);
      if (stateStore) {
        const state = await stateStore.read().catch(() => undefined);
        const digest = Object.keys(state?.accounts ?? {})[0] ?? accountDigest(undefined);
        await stateStore.recordSelfCheckForDigest(digest, result);
      }
      res
        .writeHead(
          200,
          headers(
            "application/json; charset=utf-8",
            corsHeaders(req, portNow, "POST, OPTIONS"),
          ),
        )
        .end(JSON.stringify(result));
      return;
    }

    res.writeHead(404, headers("text/plain; charset=utf-8")).end("Not found");
  });

  const entry = {
    server,
    port: wantedPort,
    token,
    ready: undefined,
    async stop() {
      if (active.get(wantedPort) === entry) active.delete(wantedPort);
      if (!server.listening) return;
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    },
  };
  entry.ready = new Promise((resolve, reject) => {
    const failed = (error) => {
      if (active.get(wantedPort) === entry) active.delete(wantedPort);
      const reason =
        error?.code === "EADDRINUSE"
          ? `AtomCode diagnostics cannot listen on 127.0.0.1:${wantedPort}: port is already in use`
          : "AtomCode diagnostics service could not start";
      const wrapped = new Error(reason);
      wrapped.code = error?.code;
      reject(wrapped);
    };
    server.once("error", failed);
    server.once("listening", () => {
      server.off("error", failed);
      server.unref?.();
      resolve(entry);
    });
  });
  active.set(wantedPort, entry);
  server.listen(wantedPort, "127.0.0.1");
  return entry;
}

export function stopDiagnosticsService(port) {
  const entries = port === undefined ? [...active.values()] : [active.get(Number(port))];
  return Promise.all(
    entries.filter(Boolean).map((entry) => entry.stop()),
  );
}

/** Replace the static placeholder once, before tests inspect the source. */
export const DIAGNOSTICS_PAGE_PATH = fileURLToPath(new URL("diagnostics.html", PAGE_DIR));
