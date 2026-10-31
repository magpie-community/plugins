// Host / Origin / token checks (timingSafeEqual).
//
// Security model (after the PR #535 review):
// - Host is checked on every HTTP request and WS upgrade and must be 127.0.0.1:<actual port> or localhost:<actual port>,
//   to block DNS rebinding (requests from a rebound page carry no Origin, so only Host identifies them).
// - Origin: null (opaque origin) is not trusted. Any website can send Origin: null from a sandboxed iframe, a data: or a file: page,
//   so null by itself means nothing. The token is the only authorization:
//     * token routes (/api/*, /attachments/*, WS hello) let a null origin "present" the token,
//       because Magpie's plugin page is a sandbox="allow-scripts" iframe and can only request as null;
//     * static routes (/, app.js etc.) always 403 for null and send no CORS headers.
// - Any other website's Origin is refused, even with the correct token.
import { timingSafeEqual, createHash } from "node:crypto";

export type CheckResult = { ok: true } | { ok: false; code: number; message: string };

// none: no Origin (ordinary navigation, <script src>, non-browser local clients)
// self: this daemon's own origin (opened directly in a browser during development)
// opaque: Origin: null — untrusted, may only present the token on token routes
// foreign: any other origin — always refused
export type OriginClass = "none" | "self" | "opaque" | "foreign";

// Host must be 127.0.0.1:<port> or localhost:<port> (the IPv6 loopback form [::1] is not allowed, per the requirements).
// port must be the actual listening port (with --port 0, main.ts writes it back after listen).
export function checkHost(host: string | undefined, port: number): CheckResult {
  if (!host) return { ok: false, code: 421, message: "Host 不对" };
  const h = host.toLowerCase();
  if (h === `127.0.0.1:${port}` || h === `localhost:${port}`) return { ok: true };
  return { ok: false, code: 421, message: "Host 不对" };
}

export function classifyOrigin(origin: string | undefined, port: number): OriginClass {
  if (origin === undefined || origin === "") return "none";
  if (origin === "null") return "opaque";
  const o = origin.toLowerCase();
  if (o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`) return "self";
  return "foreign";
}

export function tokenEqual(a: string, b: string): boolean {
  // Constant-time compare against timing attacks; different lengths are hashed to the same length first.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
