// The addresses this service is willing to talk to.
//
// Two different questions live here.
//
// The first one is the address the phone is told to use (the "external
// address" of the user). A public address over plain HTTP would carry the
// token of the phone in the clear to anybody who listens on the way, so only
// a name or an address of a trusted network is accepted over HTTP. Over
// HTTPS the transport itself is the answer, and any name is accepted.
//
// The second one is the gateway of Magpie that this plugin reads. The
// plugin lives inside Magpie, so the gateway is Magpie itself, on this
// computer. A gateway somewhere else would be a door this plugin opens
// without the user asking for it.
//
// Everything here is decided from the text of the address itself. The name
// is never resolved: a name that resolves to a private address now may
// resolve to a public one later (that is the rebinding trick), and the
// decision has to hold for the whole life of the address.
import { isIP } from 'node:net';

// The names that are kept for the networks of the user. They are either
// reserved for private use (RFC 6762, RFC 8375, ICANN 2024) or the domain
// of the tailnet of Tailscale.
const INTERNAL_SUFFIXES = [
  '.localhost',
  '.local',
  '.lan',
  '.home.arpa',
  '.internal',
  '.ts.net',
];

// 127.0.0.0/8: the whole range belongs to this computer.
export const isLoopbackIPv4 = (ip) => /^127\./.test(String(ip));
// 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16: the private addresses of a
// house or an office.
export const isPrivateIPv4 = (ip) =>
  /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(String(ip));
// 100.64.0.0/10: the range a tailnet hands out. A Headscale of the user
// hands out the same range.
export const isTailnetIPv4 = (ip) =>
  /^100\.(?:6[4-9]|[789]\d|1[01]\d|12[0-7])\./.test(String(ip));
// 169.254.0.0/16: the link of this network only, never routed away.
export const isLinkLocalIPv4 = (ip) => /^169\.254\./.test(String(ip));
// fc00::/7: the private addresses of IPv6.
export const isUlaIPv6 = (ip) => /^f[cd][0-9a-f]{2}:/i.test(String(ip));
// fe80::/10: the link of this network only.
export const isLinkLocalIPv6 = (ip) => /^fe[89ab][0-9a-f]:/i.test(String(ip));

// An address of a network that is trusted to carry the token in the clear:
// the loopback of this computer, a private network, the tailnet, or the
// link of this very network.
export const isTrustedIPv4 = (ip) =>
  isLoopbackIPv4(ip) || isPrivateIPv4(ip) || isTailnetIPv4(ip) || isLinkLocalIPv4(ip);

export const isTrustedIPv6 = (ip) =>
  ip === '::1' || isUlaIPv6(ip) || isLinkLocalIPv6(ip);

// A name of a network that does not belong to the public internet:
// a single word (the local resolver finds it), or one of the names that
// are kept for private use.
export const isInternalName = (host) => {
  const name = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!name) return false;
  // A name without a dot cannot be a name of the public internet.
  if (!name.includes('.')) return true;
  return INTERNAL_SUFFIXES.some((suffix) => name.endsWith(suffix));
};

// The host of an address, as the plain text of it: the brackets of an IPv6
// address are taken away, so that an address is read as an address and not as
// a name.
export const plainHost = (host) =>
  String(host || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');

// Is this address of a trusted network? An address that is written as a
// number is read as a number; a name is a name and is never resolved.
export const isTrustedAddress = (host) => {
  const name = plainHost(host);
  const kind = isIP(name);
  if (kind === 4) return isTrustedIPv4(name);
  if (kind === 6) return isTrustedIPv6(name);
  return isInternalName(name);
};

// The port of an address. A URL without a port means the default port of
// its scheme.
export const defaultPort = (scheme) => (scheme === 'https:' ? 443 : 80);

const PLAIN_TEXT_REFUSAL =
  '公网的明文 HTTP 地址不接受：令牌会在路上被看见。请用 HTTPS，或者换成内网地址（Tailscale、RFC1918、ULA）。';

// The address the phone is told to use. It is checked here and in the
// installer of the phone, and the two must agree.
export function checkExternalURL(value) {
  const text = String(value || '').trim();
  if (!text) return { ok: true, empty: true, url: '' };
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, error: '这个地址不是一个网址。' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: '只支持 http 和 https。' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: '地址里不能带用户名或密码。' };
  }
  if (parsed.search) {
    return { ok: false, error: '地址里不能带问号后面的参数。' };
  }
  if (parsed.hash) {
    return { ok: false, error: '地址里不能带 # 后面的内容。' };
  }
  if (parsed.pathname && parsed.pathname !== '/') {
    // A path is not carried through the routes of the service: the phone
    // asks for /api/v1/overview and the assets live at the root. A proxy in
    // front has to map the root of its own name to this service.
    return { ok: false, error: '这个版本不支持带路径的地址。反向代理请用一个独立域名，把它的根路径转到插件服务。' };
  }
  const host = plainHost(parsed.hostname);
  if (!host) return { ok: false, error: '地址里没有主机名。' };
  const port = parsed.port ? Number(parsed.port) : defaultPort(parsed.protocol);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: '端口不对。' };
  }
  if (parsed.protocol === 'http:' && !isTrustedAddress(host)) {
    return { ok: false, error: PLAIN_TEXT_REFUSAL };
  }
  // The address as it is written, without a trailing slash and without the
  // default port of its scheme.
  const url = `${parsed.protocol}//${parsed.host}`;
  return {
    ok: true,
    url,
    // The origin of the address: the scheme, the name and the port. It is
    // what a browser sends in the Origin header.
    origin: `${parsed.protocol}//${parsed.host}`,
    name: host,
    port,
    scheme: parsed.protocol,
    secure: parsed.protocol === 'https:',
  };
}

// The gateway of Magpie that this plugin reads. It is Magpie itself, on
// this computer: a gateway somewhere else would be a request this plugin
// sends without being asked.
export function checkGatewayURL(value) {
  const text = String(value || '').trim();
  if (!text) return { ok: true, url: 'http://127.0.0.1:3425' };
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, error: '网关地址不是一个网址。' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: '网关只支持 http 和 https。' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: '网关地址里不能带用户名或密码。' };
  }
  if (parsed.pathname && parsed.pathname !== '/') {
    return { ok: false, error: '网关地址里不能带路径。' };
  }
  const host = plainHost(parsed.hostname);
  const loopback = isIP(host) === 4
    ? isLoopbackIPv4(host)
    : isIP(host) === 6
      ? host === '::1' || host === '::ffff:127.0.0.1'
      : host === 'localhost' || host.endsWith('.localhost');
  if (!loopback) {
    return { ok: false, error: '网关必须是本机的 Magpie（127.0.0.1 或 ::1），别的地址这个插件不去读。' };
  }
  return { ok: true, url: text.replace(/\/+$/, '') };
}
