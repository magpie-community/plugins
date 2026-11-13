import { execFile } from 'node:child_process';
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

export async function call(args, timeout = 15000) {
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

export async function status() {
  const result = await call(['status', '--json']);
  if (!result.ok) return { ok: false, error: result.error };
  try {
    return { ok: true, data: JSON.parse(result.stdout) };
  } catch {
    return { ok: false, error: 'tailscale status did not answer with JSON.' };
  }
}

// The address of this computer inside the tailnet: 100.64.0.0/10.
export function pickIP(data) {
  const self = data?.Self || {};
  const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [];
  return ips.find(ip => /^100\.(6[4-9]|[789]\d|1[01]\d|12[0-7])\./.test(String(ip))) || null;
}

// The address of this computer inside the tailnet, read from the network
// interfaces of the machine. It is there even when the tailscale command is
// slow to answer, so the phone can be pointed at the right place at once.
export function localIP() {
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses || []) {
      const ip = String(address?.address || '');
      if (address?.family !== 'IPv4' && address?.family !== 4) continue;
      if (/^100\.(6[4-9]|[789]\d|1[01]\d|12[0-7])\./.test(ip)) return ip;
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

export async function detect() {
  const result = await status();
  if (!result.ok) {
    const ip = localIP();
    return {
      installed: false,
      connected: Boolean(ip),
      backendState: null,
      tailnetIP: ip,
      dnsName: null,
      ios: [],
      error: result.error,
    };
  }
  const data = result.data;
  return {
    installed: true,
    connected: !data?.BackendState || data.BackendState === 'Running',
    backendState: data?.BackendState || null,
    tailnetIP: pickIP(data) || localIP(),
    dnsName: dnsName(data),
    ios: iosPeers(data),
    error: null,
  };
}
