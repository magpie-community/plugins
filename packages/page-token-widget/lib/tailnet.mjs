import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const IS_WINDOWS = process.platform === 'win32';

// Windows asks the command through cmd.exe. Bun's own spawn of tailscale.exe
// takes ten seconds and holds the whole event loop while it waits, which is
// long enough for the page in the Magpie window to give up on the service.
// cmd.exe starts the same binary in about a tenth of a second.
function windowsCommand(binary, args) {
  const tail = args.join(' ');
  if (!tail) return binary;
  // cmd.exe drops the first and the last quote of the command it runs, so a
  // path with a space in it needs a second pair of quotes around the whole
  // command.
  return binary.includes(' ') ? `""${binary}" ${tail}"` : `${binary} ${tail}`;
}

function windowsRun(binary, args, timeout) {
  return run('cmd.exe', ['/d', '/s', '/c', windowsCommand(binary, args)], {
    timeout,
    windowsHide: true,
    windowsVerbatimArguments: true,
    encoding: 'utf8',
  });
}

// The tailscale command is not always on the PATH of a program that was
// started from a desktop shortcut, so the places it is installed in are tried
// as well. The paths are written with slashes: Bun's own process handling
// reads a backslash in a path as an escape and loses the file name.
export function candidates() {
  const list = [];
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const localAppData = process.env.LOCALAPPDATA || '';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || '';
  if (programFiles) list.push(`${programFiles.replace(/\\/g, '/')}/Tailscale/tailscale.exe`);
  if (programFilesX86) list.push(`${programFilesX86.replace(/\\/g, '/')}/Tailscale/tailscale.exe`);
  if (localAppData) list.push(`${localAppData.replace(/\\/g, '/')}/Tailscale/tailscale.exe`);
  return list;
}

// The command is looked for on the PATH and in the places it is installed in.
// A command that is not there is never started, so a computer without
// Tailscale does not wait for anything.
export function find() {
  const extensions = IS_WINDOWS ? ['.exe', '.cmd', '.bat'] : [''];
  const directories = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const extension of extensions) {
      const file = path.join(directory, `tailscale${extension}`);
      if (existsSync(file)) return IS_WINDOWS ? file.replace(/\\/g, '/') : file;
    }
  }
  for (const file of candidates()) {
    if (existsSync(file)) return file;
  }
  return null;
}

// The command is run. The runner may be given instead, so the tests can speak
// with a mock of the command instead of the real one.
export async function call(args, timeout = 15000, runner) {
  if (runner) return runner(args, timeout);
  const binary = find();
  if (!binary) return { ok: false, error: 'Tailscale is not installed on this computer.' };
  try {
    const { stdout } = IS_WINDOWS
      ? await windowsRun(binary, args, timeout)
      : await run(binary, args, { timeout, windowsHide: true, encoding: 'utf8' });
    return { ok: true, stdout };
  } catch (error) {
    const message = String(error.stderr || error.message || '').trim();
    return { ok: false, error: message || 'tailscale failed', binary };
  }
}

export async function status(runner) {
  const result = await call(['status', '--json'], 15000, runner);
  if (!result.ok) return { ok: false, error: result.error };
  try {
    return { ok: true, data: JSON.parse(result.stdout) };
  } catch {
    return { ok: false, error: 'tailscale status did not answer with JSON.' };
  }
}

// The same command, but without waiting: it is used at the end of a run,
// where there is no time left for a promise. The runner may be given as well,
// but then it has to answer at once.
export function callSync(args, timeout = 15000, runner) {
  if (runner) {
    const result = runner(args);
    if (result && typeof result.then === 'function') {
      return { ok: false, error: 'The runner has to answer at once.' };
    }
    return result;
  }
  const binary = find();
  if (!binary) return { ok: false, error: 'Tailscale is not installed on this computer.' };
  try {
    const result = IS_WINDOWS
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', windowsCommand(binary, args)], {
        timeout,
        windowsHide: true,
        windowsVerbatimArguments: true,
        encoding: 'utf8',
      })
      : spawnSync(binary, args, { timeout, windowsHide: true, encoding: 'utf8' });
    if (result.error) return { ok: false, error: String(result.error.message || result.error) };
    if (result.status !== 0) {
      return { ok: false, error: String(result.stderr || '').trim() || 'tailscale failed' };
    }
    return { ok: true, stdout: String(result.stdout || '') };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

// The address of this computer inside the tailnet: 100.64.0.0/10.
export function pickIP(data) {
  const self = data?.Self || {};
  const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [];
  return ips.find(ip => /^100\.(6[4-9]|[789]\d|1[01]\d|12[0-7])\./.test(String(ip))) || null;
}

const isTailscaleIPv4 = ip => /^100\.(6[4-9]|[789]\d|1[01]\d|12[0-7])\./.test(String(ip));
// The private addresses of a home network: 10.0.0.0/8, 172.16.0.0/12 and
// 192.168.0.0/16.
export const isPrivateIPv4 = ip => /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(String(ip));
// The private addresses of IPv6: fc00::/7.
export const isUlaIPv6 = ip => /^f[cd][0-9a-f]{2}:/i.test(String(ip));
const isLinkLocal = ip => /^169\.254\./.test(String(ip)) || /^fe80:/i.test(String(ip));
const isMulticast = ip => /^224\./.test(String(ip)) || /^ff[0-9a-f]{2}:/i.test(String(ip));
const isLoopback = ip => ip === '127.0.0.1' || ip === '::1';

// The kind of an interface, told apart by its name and by its addresses.
export function interfaceKind(name, addresses = []) {
  const text = String(name || '').toLowerCase();
  const list = addresses || [];
  if (text.includes('tailscale') || list.some(entry => isTailscaleIPv4(entry?.address))) return 'tailscale';
  if (text.includes('loopback') || list.some(entry => entry?.internal === true)) return 'loopback';
  if (/wi-?fi|wlan|wireless|airport|无线/.test(text)) return 'wifi';
  // The virtual interfaces come before the physical ones: "vEthernet (WSL)"
  // holds the word ethernet but is not a wire.
  if (/docker|veth|vmware|virtualbox|vethernet|hyper-?v|wsl|tailscale|tun|tap|utun|bridge|virbr|hamachi|zerotier|npcap|vpn|virtual/.test(text)) return 'virtual';
  if (/ethernet|以太网|eth\d|local area|本地连接/.test(text)) return 'ethernet';
  return 'other';
}

// The length of the network part of an address, taken from the netmask of the
// interface: a dotted mask for IPv4 and a number for IPv6.
export function prefixLength(netmask, family) {
  if (typeof netmask !== 'string') return null;
  if (family === 'IPv6') return /^\d{1,3}$/.test(netmask) ? Number(netmask) : null;
  const parts = netmask.split('.').map(part => Number(part));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts.reduce((count, part) => count + part.toString(2).split('1').length - 1, 0);
}

// Every interface of the machine, with its addresses and its kind. The
// addresses of the loopback, of the link local and of the multicast are left
// out: they are of no use to anybody.
export function interfaces(list = os.networkInterfaces()) {
  const result = [];
  for (const [name, addresses] of Object.entries(list || {})) {
    const entries = addresses || [];
    const kind = interfaceKind(name, entries);
    const ipv4 = [];
    const ipv6 = [];
    let mac = null;
    for (const entry of entries) {
      const ip = String(entry?.address || '');
      const family = entry?.family === 4 || entry?.family === 'IPv4' ? 'IPv4'
        : entry?.family === 6 || entry?.family === 'IPv6' ? 'IPv6' : null;
      if (entry?.mac && entry.mac !== '00:00:00:00:00:00') mac = entry.mac;
      if (!family || !ip) continue;
      if (isLoopback(ip) || isLinkLocal(ip) || isMulticast(ip)) continue;
      const item = { address: ip, prefix: prefixLength(entry?.netmask, family) };
      (family === 'IPv4' ? ipv4 : ipv6).push(item);
    }
    result.push({
      name,
      kind,
      mac,
      tailscale: kind === 'tailscale',
      // A private address of the home network is what a phone on the same
      // network could reach, if the service ever listened there.
      lan: kind === 'wifi' || kind === 'ethernet'
        ? [...ipv4.filter(item => isPrivateIPv4(item.address)), ...ipv6.filter(item => isUlaIPv6(item.address))]
        : [],
      ipv4,
      ipv6,
    });
  }
  return result;
}

// The addresses of the home network, all of them: a machine with more than
// one network has more than one way out, and the first one is not always the
// right one.
export function lanCandidates(list = os.networkInterfaces()) {
  return interfaces(list)
    .filter(entry => entry.lan.length)
    .map(entry => ({
      name: entry.name,
      kind: entry.kind,
      addresses: entry.lan.map(item => item.address),
    }));
}

// The way the tailnet reaches a peer: straight through the addresses of the
// peer, through another device of the tailnet, or through a relay server.
// A path that is not known is called unknown, never guessed.
export function peerPath(peer) {
  if (!peer || typeof peer !== 'object') return 'unknown';
  if (peer.Online === false) return 'offline';
  if (peer.PeerRelay) return 'relay';
  if (peer.CurAddr) return 'direct';
  if (peer.Relay) return 'derp';
  return 'unknown';
}

// The path a ping answered with: "via 192.168.1.5" and "from 100.64.0.1" are
// the wire of the network, "via hkg" is a relay server, "via peer relay" is
// another device of the tailnet.
export function pingPath(stdout) {
  const text = String(stdout || '');
  if (/peer relay/i.test(text)) return 'relay';
  const hop = text.match(/via\s+([^\s(]+)/i) || text.match(/from\s+([^\s(]+)/i);
  if (!hop) return 'unknown';
  const place = hop[1];
  if (isPrivateIPv4(place) || isTailscaleIPv4(place)) return 'direct';
  if (/^[a-z]{2,3}$/i.test(place)) return 'derp';
  if (/^\[?fd[0-9a-f]{2}:/i.test(place)) return 'direct';
  return 'relay';
}

// A ping of one peer, asked for by the user and not by the clock.
export async function ping(target, runner) {
  const result = await call(['ping', '--c', '3', '--timeout', '3s', String(target)], 20000, runner);
  if (!result.ok) return { ok: false, error: result.error, path: 'unknown' };
  const stdout = String(result.stdout || '');
  return { ok: true, stdout, path: pingPath(stdout) };
}

// The address of this computer inside the tailnet, read from the network
// interfaces of the machine. It is there even when the tailscale command is
// slow to answer, so the phone can be pointed at the right place at once.
export function localIP(list = os.networkInterfaces()) {
  for (const addresses of Object.values(list || {})) {
    for (const address of addresses || []) {
      const ip = String(address?.address || '');
      if (address?.family !== 'IPv4' && address?.family !== 4) continue;
      if (isTailscaleIPv4(ip)) return ip;
    }
  }
  return null;
}

export function iosPeers(data) {
  const peers = Object.values(data?.Peer || {});
  return peers
    .filter(peer => peer?.OS === 'iOS')
    .map(peer => {
      const dns = trimDot(peer.DNSName);
      const label = dns.endsWith('.ts.net') ? dns.slice(0, -'.ts.net'.length).split('.')[0] : '';
      const host = trimDot(peer.HostName);
      // A phone that shares its name with a generic one is known better by
      // the name of its address in the tailnet.
      const generic = !host || /^(localhost|device-of-shared-to-user)$/i.test(host);
      const name = label && generic ? label : host || label || 'iPhone';
      return {
        name,
        ips: (peer.TailscaleIPs || []).filter(ip => /^100\./.test(String(ip))),
        path: peerPath(peer),
        online: peer?.Online !== false,
      };
    });
}

// The names of the tailnet end with a dot.
function trimDot(value) {
  return typeof value === 'string' ? value.replace(/\.$/, '') : '';
}

export function dnsName(data) {
  const name = trimDot(data?.Self?.DNSName);
  return name.endsWith('.ts.net') ? name : null;
}

// The addresses of this computer that a phone of the own network of the user
// could use: the cards of a cable, of a wi-fi, and the tunnels of a network
// of one's own. The loopback is never a way in from outside. The 100.64/10
// range IS in: a Headscale of the user's own hands out the same range
// Tailscale uses, on an adapter that is not Tailscale's.
export const isCgnatIPv4 = (ip) => /^100\.(6[4-9]|[789]\d|1[01]\d|12[0-7])\./.test(ip);

export function bindCandidates(list = os.networkInterfaces()) {
  const found = [];
  for (const [name, addresses] of Object.entries(list || {})) {
    if (!Array.isArray(addresses) || !addresses.length) continue;
    const kind = interfaceKind(name, addresses);
    // The loopback is never a way in from outside. The adapter of a tailnet
    // is: it may be a Tailscale of this computer or a Headscale of the
    // user's own, and the phone reaches the service on that address.
    if (kind === 'loopback') continue;
    for (const entry of addresses) {
      if (!entry || entry.internal) continue;
      const family = entry.family === 'IPv4' || entry.family === 4 ? 'IPv4' : 'IPv6';
      if (family === 'IPv4') {
        // The private addresses of a house or an office, and the range a
        // Headscale of the user's own hands out (the same range Tailscale
        // uses, on an adapter that is not Tailscale's).
        if (!isPrivateIPv4(entry.address) && !isCgnatIPv4(entry.address)) continue;
      } else if (!isUlaIPv6(entry.address)) continue;
      found.push({ name, kind, address: entry.address });
    }
  }
  return found;
}

export async function detect(runner) {
  const result = await status(runner);
  if (!result.ok) {
    const ip = localIP();
    // The command answered with nothing. The program may still be there: a
    // mock stands in for a program that is there.
    const installed = runner ? true : Boolean(find());
    return {
      installed,
      connected: Boolean(ip),
      backendState: null,
      tailnetIP: ip,
      dnsName: null,
      ios: [],
      path: 'unknown',
      error: result.error,
    };
  }
  const data = result.data;
  return {
    installed: true,
    connected: data?.BackendState === 'Running',
    backendState: data?.BackendState || null,
    tailnetIP: pickIP(data) || localIP(),
    dnsName: dnsName(data),
    ios: iosPeers(data),
    path: peerPath(data?.Self),
    error: null,
  };
}
