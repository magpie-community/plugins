// HTTP routes: / → app/index.html (no token), static assets, /api/ping, /api/upload, /attachments/*
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { checkHost, classifyOrigin, tokenEqual } from "./security.js";
import type { Config } from "./config.js";
import type { AttachmentStore } from "./store/attachments.js";
import { log } from "./log.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".json": "application/json; charset=utf-8",
};

const MAX_UPLOAD = 50 * 1024 * 1024; // 50MB
const MAX_MSG = 200 * 1024; // Ordinary messages: 200KB

export type HttpHooks = {
  onUpgrade?: (req: IncomingMessage, socket: import("node:net").Socket, head: Buffer) => void;
};

// A malformed %xx must not become a 500
function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

function send(res: ServerResponse, code: number, body: string | Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(code, headers);
  res.end(body);
}

function sendJson(res: ServerResponse, code: number, obj: unknown, headers: Record<string, string> = {}): void {
  send(res, code, JSON.stringify(obj), { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
}

// Common headers for static responses: no caching (the page has no token, but don't let old versions linger), no sniffing, no Referer
const STATIC_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export function createHttpServer(cfg: Config, appDir: string, attachments: AttachmentStore, hooks: HttpHooks = {}): Server {
  const server = createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (e) {
      log("error", "HTTP 处理异常", { url: req.url, err: String(e) });
      if (!res.headersSent) sendJson(res, 500, { ok: false, e: { code: "internal", message: "服务内部错误" } });
      else res.end();
    }
  });

  // Origin policy per request (see classifyOrigin in security.ts):
  //   foreign (another site) → always 403, even with a token
  //   opaque (Origin: null) → may only "present" the token on token routes (/api/*, /attachments/*);
  //                          it confers no trust by itself. Static routes are always refused.
  //   none / self          → static routes allowed (static files contain no token); token routes still need the token.
  // The CORS header is only given (as null) on responses that carry a valid token + Origin: null; preflight only for /api/upload.
  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Host must be loopback + this process's actual port: blocks DNS rebinding (a rebound page's GET carries no Origin)
    const hostCheck = checkHost(req.headers.host, cfg.port);
    if (!hostCheck.ok) {
      sendJson(res, hostCheck.code, { ok: false, e: { code: "bad_host", message: hostCheck.message } });
      return;
    }
    const origin = classifyOrigin(req.headers.origin, cfg.port);
    if (origin === "foreign") {
      sendJson(res, 403, { ok: false, e: { code: "bad_origin", message: "来源不允许" } });
      return;
    }

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${cfg.port}`);
    const pathname = url.pathname;
    const isApi = pathname.startsWith("/api/");
    const isAttachment = pathname.startsWith("/attachments/");

    // OPTIONS preflight: browsers don't send custom headers on a preflight, so there is no token here.
    // Only allow /api/upload, the one cross-origin POST the frontend really makes, and only for null / our own origin;
    // the preflight itself returns no data, and the real request still has to pass the token check.
    if (req.method === "OPTIONS") {
      if (pathname !== "/api/upload" || origin === "none") {
        sendJson(res, 403, { ok: false, e: { code: "bad_preflight", message: "预检不允许" } });
        return;
      }
      send(res, 204, "", {
        "access-control-allow-origin": origin === "opaque" ? "null" : `http://127.0.0.1:${cfg.port}`,
        "access-control-allow-headers": "x-agent-console, content-type",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-max-age": "600",
        vary: "origin",
      });
      return;
    }

    // Token routes: the token is the only authorization
    if (isApi || isAttachment) {
      const headerToken = req.headers["x-agent-console"];
      // Attachments accept ?t= (<img src> can't send custom headers); the API only accepts the header
      const queryToken = isAttachment ? url.searchParams.get("t") : null;
      const validToken =
        (typeof headerToken === "string" && tokenEqual(headerToken, cfg.token)) ||
        (typeof queryToken === "string" && tokenEqual(queryToken, cfg.token));
      if (!validToken) {
        sendJson(res, 403, { ok: false, e: { code: "bad_token", message: "令牌无效" } });
        return;
      }
      // In a sandbox iframe (no allow-same-origin) the page's origin is null, so even a same-address fetch is cross-origin:
      // the response needs allow-origin: null to be readable. It's only sent after the token is verified,
      // so any Origin: null page without the token can read nothing.
      if (origin === "opaque") {
        res.setHeader("access-control-allow-origin", "null");
        res.setHeader("vary", "origin");
      }
      if (isApi) {
        await routeApi(req, res, pathname, url);
        return;
      }
      const id = safeDecode(pathname.slice("/attachments/".length));
      const a = id === null ? null : await attachments.get(id);
      if (!a) {
        sendJson(res, 404, { ok: false, e: { code: "not_found", message: "附件不存在" } });
        return;
      }
      const data = await attachments.read(a.id);
      send(res, 200, data ?? Buffer.alloc(0), { ...STATIC_HEADERS, "content-type": a.mime });
      return;
    }

    // Static assets: refuse Origin: null. Ordinary navigations and <script src>/<link> subresource requests carry no Origin;
    // one with null can only be someone else's sandboxed/data:/file: page doing a fetch — give it nothing, and no CORS headers.
    if (origin === "opaque") {
      sendJson(res, 403, { ok: false, e: { code: "bad_origin", message: "来源不允许" } });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { ok: false, e: { code: "method", message: "方法不允许" } });
      return;
    }
    if (pathname === "/" || pathname === "/index.html") {
      // The token is no longer injected into the page: the plugin gate hands it to the frontend in the #t= fragment (see lib/gate.mjs)
      try {
        const html = await readFile(join(appDir, "index.html"), "utf8");
        send(res, 200, html, { ...STATIC_HEADERS, "content-type": "text/html; charset=utf-8" });
      } catch {
        send(res, 503, "app 还没构建（缺 app/index.html）", { ...STATIC_HEADERS, "content-type": "text/plain; charset=utf-8" });
      }
      return;
    }
    // Other static files must be inside app/
    const decoded = safeDecode(pathname);
    if (decoded === null) {
      sendJson(res, 400, { ok: false, e: { code: "bad_path", message: "路径不合法" } });
      return;
    }
    const rel = normalize(decoded).replace(/^([\\/])+/, "");
    const full = normalize(join(appDir, rel));
    if (!full.startsWith(normalize(appDir)) || rel.includes("..")) {
      sendJson(res, 403, { ok: false, e: { code: "bad_path", message: "路径不允许" } });
      return;
    }
    if (!existsSync(full) || !(await stat(full)).isFile()) {
      sendJson(res, 404, { ok: false, e: { code: "not_found", message: "文件不存在" } });
      return;
    }
    const data = await readFile(full);
    send(res, 200, data, { ...STATIC_HEADERS, "content-type": MIME[extname(full).toLowerCase()] ?? "application/octet-stream" });
  }

  async function routeApi(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
    if (pathname === "/api/ping" && req.method === "GET") {
      sendJson(res, 200, { ok: true, version: cfg.version, port: cfg.port, pid: process.pid, dataDir: cfg.dataDir, buildStamp: cfg.buildStamp });
      return;
    }
    if (pathname === "/api/upload" && req.method === "POST") {
      const name = url.searchParams.get("name") ?? "";
      if (!attachments.allowedExt(name)) {
        sendJson(res, 400, { ok: false, e: { code: "bad_type", message: "不支持的文件类型" } });
        return;
      }
      // The declared size is already over the limit: reject without reading the body
      const declared = Number(req.headers["content-length"] ?? 0);
      if (declared > MAX_UPLOAD) {
        res.setHeader("connection", "close");
        sendJson(res, 413, { ok: false, e: { code: "too_large", message: "文件太大（上限 50MB）" } });
        req.resume();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        const b = c as Buffer;
        size += b.length;
        if (size > MAX_UPLOAD) {
          res.setHeader("connection", "close");
          sendJson(res, 413, { ok: false, e: { code: "too_large", message: "文件太大（上限 50MB）" } });
          return;
        }
        chunks.push(b);
      }
      const a = await attachments.save(name, Buffer.concat(chunks));
      sendJson(res, 200, { ok: true, id: a.id, name: a.name, mime: a.mime, size: a.size });
      return;
    }
    sendJson(res, 404, { ok: false, e: { code: "not_found", message: "接口不存在" } });
  }

  if (hooks.onUpgrade) {
    server.on("upgrade", hooks.onUpgrade);
  }
  return server;
}

export { sendJson, MAX_MSG };
