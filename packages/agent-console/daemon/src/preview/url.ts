// Preview target URLs (1.2): normalize what the user typed or clicked, and decide whether the preview may load it.
// Pure (no node: imports) so the page uses the very same rules (web/src/preview imports this file).
//
// Only loopback targets are allowed: localhost, *.localhost, 127.0.0.0/8, 0.0.0.0, [::1], [::].
// http/https only, no user:pass@, port 1–65535, at most 2048 characters.
// Ports the daemon refuses (its own, the gate's, Magpie's) are checked by the caller with deniedPort().

export const MAX_PREVIEW_URL = 2048;

export type PreviewTarget = {
  /** Normalized target URL, e.g. http://localhost:5173/app?x=1 */
  href: string;
  /** scheme://host:port of the target (what one proxy listener serves) */
  origin: string;
  /** Path + query + hash on the target */
  path: string;
  secure: boolean;
  /** Host name as written (lowercase; IPv6 without brackets) */
  hostname: string;
  port: number;
  /** Addresses to connect to, in order (localhost tries IPv4 first, then ::1) */
  connect: string[];
  /** Host header to send upstream (host:port as the dev server expects to see it) */
  hostHeader: string;
};

export type PreviewCheck = { ok: true; target: PreviewTarget } | { ok: false; reason: "empty" | "too_long" | "bad_url" | "scheme" | "userinfo" | "not_local" | "port" };

/** Is this host name a loopback host the preview may load? (brackets of IPv6 allowed or not) */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return /^[a-z0-9.-]+$/.test(h) && !h.includes("..");
  if (h === "0.0.0.0" || h === "::1" || h === "::") return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return !!m && m.slice(1).every((x) => Number(x) <= 255);
}

function connectHosts(h: string): string[] {
  if (h === "localhost" || h.endsWith(".localhost")) return ["127.0.0.1", "::1"];
  if (h === "0.0.0.0") return ["127.0.0.1"];
  if (h === "::1") return ["::1"];
  if (h === "::") return ["::1", "127.0.0.1"];
  return [h];
}

/** "5173", ":5173", "localhost:5173", "127.0.0.1:5173/x", "http://[::1]:4000" → a URL string with a scheme */
export function withScheme(raw: string): string {
  const s = raw.trim();
  if (/^\d{1,5}$/.test(s)) return `http://localhost:${s}/`;
  if (/^:\d{1,5}(?:[/?#].*)?$/.test(s)) return `http://localhost${s}`;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  // "mailto:", "javascript:", "file:" etc. stay as they are (and are refused below); "localhost:5173" is host:port, not a scheme
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) return s;
  return `http://${s}`;
}

export function checkPreviewUrl(raw: string): PreviewCheck {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, reason: "empty" };
  if (raw.length > MAX_PREVIEW_URL) return { ok: false, reason: "too_long" };
  let u: URL;
  try {
    u = new URL(withScheme(raw));
  } catch {
    return { ok: false, reason: "bad_url" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: "scheme" };
  if (u.username || u.password) return { ok: false, reason: "userinfo" };
  const hostname = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!isLoopbackHost(hostname)) return { ok: false, reason: "not_local" };
  const secure = u.protocol === "https:";
  const port = u.port ? Number(u.port) : secure ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: "port" };
  const href = u.href;
  if (href.length > MAX_PREVIEW_URL) return { ok: false, reason: "too_long" };
  const hostForUrl = hostname.includes(":") ? `[${hostname}]` : hostname;
  return {
    ok: true,
    target: {
      href,
      origin: `${u.protocol}//${hostForUrl}:${port}`,
      path: `${u.pathname}${u.search}${u.hash}`,
      secure,
      hostname,
      port,
      connect: connectHosts(hostname),
      hostHeader: `${hostForUrl}:${port}`,
    },
  };
}

/** The preview never proxies these ports (the daemon, the gate, Magpie): rewriting Origin would bypass their own checks */
export function deniedPort(port: number, denied: Iterable<number>): boolean {
  for (const d of denied) if (d === port) return true;
  return false;
}

/** URL the user sees in the address bar for a proxied location: proxy origin swapped back to the target origin */
export function displayHref(proxiedHref: string, proxyOrigin: string, targetOrigin: string): string {
  if (proxiedHref.startsWith(proxyOrigin)) return displayOrigin(targetOrigin) + proxiedHref.slice(proxyOrigin.length);
  return proxiedHref;
}

/** http://localhost:80 → http://localhost (how a browser would print it) */
export function displayOrigin(origin: string): string {
  return origin.replace(/^http:\/\/(.+):80$/, "http://$1").replace(/^https:\/\/(.+):443$/, "https://$1");
}

/** Only http/https may go to the system browser (no file:, javascript:, custom schemes). Returns the re-serialized href. */
export function externalHref(raw: string): string | null {
  if (typeof raw !== "string" || !raw || raw.length > MAX_PREVIEW_URL) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  const href = u.href;
  // URL.href percent-encodes spaces/quotes/controls; refuse anything that still looks odd
  if (/[\s"'<>`\\^{|}]/.test(href) || href.length > MAX_PREVIEW_URL) return null;
  return href;
}
