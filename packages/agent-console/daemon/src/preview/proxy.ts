// Preview proxy (1.2): a local-only reverse proxy, one 127.0.0.1:<random port> listener per loopback target origin.
//
// Why: Magpie's page frame is sandbox="allow-scripts" and the sandbox is inherited by every child frame, so a plain
// <iframe src="http://localhost:5173"> runs as an opaque origin: module scripts and fetch() fail CORS (Origin: null),
// storage throws. The proxy makes a dev app work there: it answers CORS for "null", sends the dev server its own Host/Origin,
// drops X-Frame-Options / frame-ancestors, and adds a tiny script with in-memory storage and a navigation bridge.
//
// Limits (see README "Preview proxy"):
// - created only through preview.open on an authenticated WS connection; targets are loopback only (preview/url.ts);
//   the daemon's, the gate's and Magpie's ports (and the proxy's own) are refused;
// - each listener serves exactly one target; Host must be 127.0.0.1:<p> or localhost:<p> (DNS rebinding);
//   a request with a foreign Origin is refused (only "null", none, or the proxy's own origin);
// - cookies are not forwarded in either direction (127.0.0.1 cookies are shared across ports: Magpie's would leak to the
//   dev server, and the dev server could set cookies other local apps see);
// - a listener closes after 10 idle minutes, on preview.release, when the last page connection goes, and with the daemon;
//   at most 8 targets at once (the least recently used one is closed).
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse, type Server, type OutgoingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { checkHost } from "../security.js";
import { checkPreviewUrl, deniedPort, displayOrigin, type PreviewTarget } from "./url.js";
import { PREVIEW_SCRIPT, PREVIEW_SCRIPT_PATH, injectScriptTag } from "./inject.js";

export class PreviewError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type PreviewProxyOptions = {
  /** Ports never proxied (daemon, gate, Magpie); read on every open */
  deniedPorts: () => Iterable<number>;
  idleMs?: number;
  maxTargets?: number;
  maxHtmlBytes?: number;
  now?: () => number;
  /** For tests: a fixed listening port is never used, always 0 (random) */
  log?: (level: "info" | "warn", msg: string) => void;
};

type Listener = {
  target: PreviewTarget;
  server: Server;
  port: number;
  proxyOrigin: string;
  lastUsed: number;
  sockets: Set<Socket>;
  /** open WebSocket tunnels (HMR): a listener with one is never idle */
  tunnels: number;
  /** address that answered last time (localhost: 127.0.0.1 or ::1) */
  addr: string | null;
};

export type PreviewOpen = { proxyOrigin: string; target: string; url: string; path: string; proxyHref: string };

const HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate", "te", "trailer", "transfer-encoding", "upgrade"]);
const RETRY_CODES = new Set(["ECONNREFUSED", "EADDRNOTAVAIL", "EAFNOSUPPORT", "ENETUNREACH", "EHOSTUNREACH", "ECONNRESET", "ETIMEDOUT"]);

export class PreviewProxy {
  private byOrigin = new Map<string, Listener>();
  private opening = new Map<string, Promise<Listener>>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private idleMs: number;
  private maxTargets: number;
  private maxHtml: number;
  private now: () => number;

  constructor(private opts: PreviewProxyOptions) {
    this.idleMs = opts.idleMs ?? 10 * 60 * 1000;
    this.maxTargets = opts.maxTargets ?? 8;
    this.maxHtml = opts.maxHtmlBytes ?? 8 * 1024 * 1024;
    this.now = opts.now ?? Date.now;
  }

  /** Ports of the listeners themselves (a preview of a preview is refused) */
  ports(): number[] {
    return [...this.byOrigin.values()].map((l) => l.port);
  }

  get size(): number {
    return this.byOrigin.size;
  }

  async open(raw: string): Promise<PreviewOpen> {
    const c = checkPreviewUrl(raw);
    if (!c.ok) throw new PreviewError(c.reason, `preview url refused: ${c.reason}`);
    const t = c.target;
    if (deniedPort(t.port, [...this.opts.deniedPorts(), ...this.ports()])) {
      throw new PreviewError("denied_port", `port ${t.port} can't be previewed`);
    }
    let l = this.byOrigin.get(t.origin);
    if (!l) {
      let p = this.opening.get(t.origin);
      if (!p) {
        p = this.listen(t).finally(() => this.opening.delete(t.origin));
        this.opening.set(t.origin, p);
      }
      l = await p;
    }
    l.lastUsed = this.now();
    this.ensureSweep();
    return { proxyOrigin: l.proxyOrigin, target: t.origin, url: t.href, path: t.path, proxyHref: l.proxyOrigin + t.path };
  }

  /** Close the listener for this target (any URL on it, or its origin) */
  release(raw: string): boolean {
    const c = checkPreviewUrl(raw);
    if (!c.ok) return false;
    const l = this.byOrigin.get(c.target.origin);
    if (!l) return false;
    this.close(l);
    return true;
  }

  closeAll(): void {
    for (const l of [...this.byOrigin.values()]) this.close(l);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** Close listeners idle for idleMs (no request and no open WebSocket); exposed for tests with a fake clock */
  sweep(): void {
    const now = this.now();
    for (const l of [...this.byOrigin.values()]) {
      if (l.tunnels === 0 && now - l.lastUsed > this.idleMs) {
        this.opts.log?.("info", `preview proxy for ${l.target.origin} idle, closing`);
        this.close(l);
      }
    }
    if (this.byOrigin.size === 0 && this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private ensureSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), 60 * 1000);
    this.sweepTimer.unref();
  }

  private close(l: Listener): void {
    if (this.byOrigin.get(l.target.origin) === l) this.byOrigin.delete(l.target.origin);
    try { l.server.close(); } catch {}
    for (const s of l.sockets) s.destroy();
    l.sockets.clear();
  }

  private async listen(t: PreviewTarget): Promise<Listener> {
    // Over the limit: close the least recently used target
    while (this.byOrigin.size >= this.maxTargets) {
      const oldest = [...this.byOrigin.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!oldest) break;
      this.close(oldest);
    }
    const server = createServer();
    const l: Listener = { target: t, server, port: 0, proxyOrigin: "", lastUsed: this.now(), sockets: new Set(), tunnels: 0, addr: null };
    server.on("connection", (s) => {
      l.sockets.add(s);
      s.on("close", () => l.sockets.delete(s));
    });
    server.on("request", (req, res) => this.onRequest(l, req, res));
    server.on("upgrade", (req, socket, head) => this.onUpgrade(l, req, socket as Socket, head));
    server.on("clientError", (_e, socket) => { try { socket.destroy(); } catch {} });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const a = server.address();
    l.port = a && typeof a === "object" ? a.port : 0;
    l.proxyOrigin = `http://127.0.0.1:${l.port}`;
    this.byOrigin.set(t.origin, l);
    this.opts.log?.("info", `preview proxy ${l.proxyOrigin} → ${t.origin}`);
    return l;
  }

  // ---- request gate shared by HTTP and WS ----
  private gate(l: Listener, req: IncomingMessage): { code: number; why: string } | null {
    const hc = checkHost(req.headers.host, l.port);
    if (!hc.ok) return { code: 421, why: "bad_host" };
    const o = req.headers.origin;
    if (o !== undefined && o !== "" && o !== "null") {
      const lo = o.toLowerCase();
      if (lo !== `http://127.0.0.1:${l.port}` && lo !== `http://localhost:${l.port}`) return { code: 403, why: "bad_origin" };
    }
    return null;
  }

  private onRequest(l: Listener, req: IncomingMessage, res: ServerResponse): void {
    l.lastUsed = this.now();
    const bad = this.gate(l, req);
    if (bad) {
      res.writeHead(bad.code, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end(bad.why);
      req.resume();
      return;
    }
    const path = (req.url ?? "/").split("?")[0];
    if (path === PREVIEW_SCRIPT_PATH) {
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "null",
        "x-content-type-options": "nosniff",
      });
      res.end(req.method === "HEAD" ? undefined : PREVIEW_SCRIPT);
      return;
    }
    // CORS preflight from the opaque preview frame: answered here (the dev server would not allow "null")
    if (req.method === "OPTIONS" && req.headers["access-control-request-method"]) {
      const h: OutgoingHttpHeaders = {
        "access-control-allow-origin": "null",
        "access-control-allow-methods": String(req.headers["access-control-request-method"]).slice(0, 200) + ", GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD",
        "access-control-max-age": "600",
        vary: "origin",
      };
      const rh = req.headers["access-control-request-headers"];
      if (typeof rh === "string") h["access-control-allow-headers"] = rh.slice(0, 2000);
      res.writeHead(204, h);
      res.end();
      req.resume();
      return;
    }
    void this.forward(l, req, res);
  }

  private async resolveAddr(l: Listener): Promise<string | null> {
    if (l.addr) return l.addr;
    for (const host of l.target.connect) {
      const ok = await new Promise<boolean>((resolve) => {
        const s = netConnect({ host, port: l.target.port });
        const done = (v: boolean) => { s.removeAllListeners(); s.destroy(); resolve(v); };
        s.setTimeout(3000, () => done(false));
        s.once("connect", () => done(true));
        s.once("error", () => done(false));
      });
      if (ok) {
        l.addr = host;
        return host;
      }
    }
    return null;
  }

  private servername(l: Listener): string | undefined {
    return isIP(l.target.hostname) ? undefined : l.target.hostname;
  }

  private async forward(l: Listener, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const addr = await this.resolveAddr(l);
    if (!addr) {
      this.errorPage(l, req, res);
      return;
    }
    const headers = rewriteRequestHeaders(req.headers, l.target, l.proxyOrigin, false);
    const reqFn = l.target.secure ? httpsRequest : httpRequest;
    const up = reqFn({
      host: addr,
      port: l.target.port,
      method: req.method,
      path: req.url ?? "/",
      headers,
      ...(l.target.secure ? { rejectUnauthorized: false, servername: this.servername(l) } : {}),
    });
    up.on("response", (ur) => this.respond(l, req, res, ur));
    up.on("error", (e: NodeJS.ErrnoException) => {
      if (RETRY_CODES.has(e.code ?? "")) l.addr = null; // re-probe next time (the dev server may have moved between 127.0.0.1 and ::1)
      if (!res.headersSent) this.errorPage(l, req, res);
      else res.destroy();
    });
    req.on("aborted", () => up.destroy());
    res.on("close", () => { if (!res.writableFinished) up.destroy(); });
    req.pipe(up);
  }

  private respond(l: Listener, req: IncomingMessage, res: ServerResponse, ur: IncomingMessage): void {
    l.lastUsed = this.now();
    const h = rewriteResponseHeaders(ur.headers, l.target, l.proxyOrigin);
    const status = ur.statusCode ?? 502;
    const ctype = String(ur.headers["content-type"] ?? "").toLowerCase();
    const encoded = !!ur.headers["content-encoding"] && ur.headers["content-encoding"] !== "identity";
    const html = ctype.includes("text/html") && !encoded && req.method !== "HEAD" && status !== 204 && status !== 304;
    if (!html) {
      res.writeHead(status, h);
      ur.pipe(res);
      return;
    }
    // HTML: buffer (bounded) and add the script tag; a huge page passes through untouched
    const chunks: Buffer[] = [];
    let size = 0;
    let passthrough = false;
    ur.on("data", (c: Buffer) => {
      if (passthrough) return;
      size += c.length;
      chunks.push(c);
      if (size > this.maxHtml) {
        passthrough = true;
        res.writeHead(status, h);
        for (const x of chunks) res.write(x);
        ur.removeAllListeners("data");
        ur.removeAllListeners("end");
        ur.pipe(res);
      }
    });
    ur.on("end", () => {
      if (passthrough) return;
      // latin1 keeps every byte as it was, whatever the page's charset
      const out = Buffer.from(injectScriptTag(Buffer.concat(chunks).toString("latin1")), "latin1");
      h["content-length"] = String(out.length);
      res.writeHead(status, h);
      res.end(out);
    });
    ur.on("error", () => res.destroy());
  }

  private errorPage(l: Listener, req: IncomingMessage, res: ServerResponse): void {
    const where = displayOrigin(l.target.origin).replace(/^https?:\/\//, "");
    const body = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(where)}</title>
<style>body{font:13px/1.6 system-ui,sans-serif;color:#525252;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fff}
@media (prefers-color-scheme:dark){body{background:#1a1a1a;color:#a3a3a3}button{background:#262626;color:#e5e5e5;border-color:#3a3a3a}}
.b{text-align:center;max-width:420px;padding:20px}code{font-family:ui-monospace,monospace}button{margin-top:12px;padding:5px 14px;border:1px solid #d4d4d4;border-radius:6px;background:#fafafa;cursor:pointer;font:inherit}</style></head>
<body><div class="b"><div><code>${esc(where)}</code> 没有响应，dev server 启动了吗？</div><div><code>${esc(where)}</code> is not responding. Is the dev server running?</div>
<button onclick="location.reload()">重试 / Retry</button></div></body></html>`;
    res.writeHead(502, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "null" });
    res.end(req.method === "HEAD" ? undefined : body);
    req.resume();
  }

  // ---- WebSocket (HMR) ----
  private onUpgrade(l: Listener, req: IncomingMessage, socket: Socket, head: Buffer): void {
    l.lastUsed = this.now();
    const bad = this.gate(l, req);
    if (bad) {
      socket.end(`HTTP/1.1 ${bad.code} ${bad.code === 421 ? "Misdirected Request" : "Forbidden"}\r\nconnection: close\r\n\r\n`);
      return;
    }
    socket.on("error", () => {});
    void this.resolveAddr(l).then((addr) => {
      if (!addr || socket.destroyed) {
        socket.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n");
        return;
      }
      const up: Socket = l.target.secure
        ? tlsConnect({ host: addr, port: l.target.port, rejectUnauthorized: false, servername: this.servername(l) })
        : netConnect({ host: addr, port: l.target.port });
      const ready = l.target.secure ? "secureConnect" : "connect";
      l.tunnels++;
      let counted = true;
      const done = () => {
        if (counted) { counted = false; l.tunnels--; l.lastUsed = this.now(); }
        up.destroy();
        socket.destroy();
      };
      up.once(ready, () => {
        const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`];
        const hs = rewriteRequestHeaders(req.headers, l.target, l.proxyOrigin, true);
        for (const [k, v] of Object.entries(hs)) {
          if (v === undefined) continue;
          for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${String(one).replace(/[\r\n]/g, "")}`);
        }
        up.write(lines.join("\r\n") + "\r\n\r\n");
        if (head?.length) up.write(head);
        up.pipe(socket);
        socket.pipe(up);
      });
      up.on("data", () => { l.lastUsed = this.now(); });
      up.on("error", done);
      up.on("close", done);
      socket.on("close", done);
    });
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Headers sent upstream: the dev server sees its own Host / Origin, no cookies, no compression. */
export function rewriteRequestHeaders(
  inH: IncomingMessage["headers"],
  t: PreviewTarget,
  proxyOrigin: string,
  upgrade: boolean,
): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  const targetOrigin = displayOrigin(t.origin);
  for (const [k, v] of Object.entries(inH)) {
    if (v === undefined) continue;
    const key = k.toLowerCase();
    if (!upgrade && HOP.has(key)) continue;
    if (upgrade && (key === "proxy-connection" || key === "proxy-authorization" || key === "keep-alive" || key === "te" || key === "trailer" || key === "transfer-encoding")) continue;
    if (key === "cookie" || key === "host" || key === "origin" || key === "referer" || key === "forwarded" || key.startsWith("x-forwarded-")) continue;
    out[key] = v;
  }
  out.host = t.hostHeader.replace(/:(80|443)$/, (m) => ((m === ":80" && !t.secure) || (m === ":443" && t.secure) ? "" : m));
  if (inH.origin !== undefined) out.origin = targetOrigin;
  const ref = inH.referer;
  if (typeof ref === "string" && (ref === proxyOrigin || ref.startsWith(proxyOrigin + "/"))) out.referer = targetOrigin + ref.slice(proxyOrigin.length);
  if (inH["sec-fetch-site"] !== undefined) out["sec-fetch-site"] = "same-origin";
  if (!upgrade) out["accept-encoding"] = "identity";
  return out;
}

/** Headers sent back to the preview frame: readable by an opaque origin, frameable, no cookies, redirects stay on the proxy. */
export function rewriteResponseHeaders(inH: IncomingMessage["headers"], t: PreviewTarget, proxyOrigin: string): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(inH)) {
    if (v === undefined) continue;
    const key = k.toLowerCase();
    if (HOP.has(key)) continue;
    if (key === "x-frame-options" || key === "set-cookie" || key.startsWith("access-control-allow-")) continue;
    if (key === "content-security-policy" || key === "content-security-policy-report-only") {
      const kept = (Array.isArray(v) ? v : [v]).map(stripFrameAncestors).filter(Boolean);
      if (kept.length) out[key] = kept.join(", ");
      continue;
    }
    if (key === "location" && typeof v === "string") {
      out[key] = rewriteLocation(v, t, proxyOrigin);
      continue;
    }
    out[key] = v;
  }
  out["access-control-allow-origin"] = "null";
  const vary = typeof out.vary === "string" ? out.vary : "";
  out.vary = vary ? (/\borigin\b/i.test(vary) ? vary : `${vary}, Origin`) : "Origin";
  return out;
}

export function stripFrameAncestors(csp: string): string {
  return csp
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d && !/^frame-ancestors(\s|$)/i.test(d))
    .join("; ");
}

/** A redirect to the target itself goes to the proxy instead; anything else (another site) is left alone */
export function rewriteLocation(loc: string, t: PreviewTarget, proxyOrigin: string): string {
  let u: URL;
  try {
    u = new URL(loc, t.href);
  } catch {
    return loc;
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(loc) && !loc.startsWith("//")) return loc; // relative: already right
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (u.protocol === (t.secure ? "https:" : "http:") && host === t.hostname && port === t.port) {
    return proxyOrigin + u.pathname + u.search + u.hash;
  }
  return loc;
}
