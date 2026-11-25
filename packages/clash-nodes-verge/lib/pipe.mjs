// HTTP over mihomo's external controller: Windows named pipe (Clash Party / mihomo-party)
// or plain TCP (Clash Verge / vanilla mihomo). No dependencies.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PIPE_ROOT = process.platform === 'win32' ? '\\\\.\\pipe\\' : null;
const TCP_CANDIDATES = [
  ['127.0.0.1', 9090], ['127.0.0.1', 9097], ['127.0.0.1', 9091],
  ['127.0.0.1', 61769], ['127.0.0.1', 20171],
];

const DEFAULT_TIMEOUT = 12000;

/** Byte-correct HTTP chunked decoder (Clash replies in chunks, with UTF-8 CJK node names). */
export function dechunk(buf) {
  const out = [];
  let rest = buf;
  for (let i = 0; i < 100000; i++) {
    const nl = rest.indexOf('\r\n');
    if (nl < 0) break;
    const size = parseInt(rest.subarray(0, nl).toString('utf8').split(';')[0], 16);
    if (!Number.isFinite(size) || size === 0) break;
    out.push(rest.subarray(nl + 2, nl + 2 + size));
    rest = rest.subarray(nl + 2 + size + 2);
  }
  return Buffer.concat(out);
}

/** Enumerate \.\pipe\ two levels deep looking for a mihomo controller pipe. */
export function listPipes() {
  if (!PIPE_ROOT) return [];
  const found = [];
  const walk = (prefix, depth) => {
    const base = PIPE_ROOT + (prefix ? `${prefix}\\` : '');
    let names;
    try { names = fs.readdirSync(base); } catch { return; }
    for (const n of names) {
      if (!/mihomo|clash|party|verge/i.test(n)) continue;
      const rel = prefix ? `${prefix}\\${n}` : n;
      // Mihomo Party names its controller pipe `mihomo-user-Console-<pid>`
      // normally and `mihomo-admin-<user>-<pid>` when it runs its core
      // elevated; Clash Verge Rev names it `verge-mihomo-<mode>-<hash>`
      // (its `clash-verge-service` pipe is IPC, not the controller, and the
      // probe simply rejects it). Both are external controllers.
      if (/mihomo-(user|admin)-|verge-mihomo-|external|controller/i.test(n)) found.push(rel);
      if (depth < 2) walk(rel, depth + 1);
    }
  };
  walk('', 0);
  return [...new Set(found)];
}

/** Read `secret:` and `external-controller:` from common mihomo config locations. */
export function readControllerHints() {
  const home = os.homedir();
  const candidates = [
    path.join(home, 'AppData', 'Roaming', 'io.github.clash-verge-rev.clash-verge-rev', 'config.yaml'),
    path.join(home, 'Library', 'Application Support', 'io.github.clash-verge-rev.clash-verge-rev', 'config.yaml'),
    path.join(home, '.config', 'clash-verge', 'config.yaml'),
    path.join(home, 'AppData', 'Roaming', 'mihomo-party', 'mihomo.yaml'),
    path.join(home, 'AppData', 'Roaming', 'mihomo-party', 'config.yaml'),
    path.join(home, '.config', 'mihomo', 'config.yaml'),
    path.join(home, '.config', 'clash', 'config.yaml'),
  ];
  const hints = { secret: '', tcp: [] };
  for (const f of candidates) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const sec = text.match(/^\s*secret:\s*["']?([^"'\r\n#]+)["']?\s*$/m);
    if (sec && !hints.secret) hints.secret = sec[1].trim();
    const ec = text.match(/^\s*external-controller:\s*["']?([^"'\r\n#]+)["']?\s*$/m);
    if (ec) {
      const v = ec[1].trim();
      const m = v.match(/^([\d.]+):(\d+)$/);
      if (m) hints.tcp.push([m[1], Number(m[2])]);
    }
  }
  return hints;
}

/**
 * One request to a controller endpoint.
 * @param {{kind:'pipe',path:string}|{kind:'tcp',host:string,port:number,secret?:string}} target
 */
export function request(target, method, urlPath, body = null, opts = {}) {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
  const secret = opts.secret ?? target.secret ?? '';
  return new Promise((resolve, reject) => {
    const connectOpts = target.kind === 'pipe'
      ? { path: `${PIPE_ROOT}${target.path}` }
      : { host: target.host, port: target.port };
    const sock = net.createConnection(connectOpts);
    const chunks = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true; sock.destroy();
      reject(new Error(`controller request timed out: ${method} ${urlPath}`));
    }, timeout);

    sock.on('connect', () => {
      const payload = body == null ? '' : JSON.stringify(body);
      const auth = secret ? `Authorization: Bearer ${secret}\r\n` : '';
      const extra = body == null ? '' : `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n`;
      sock.write(
        `${method} ${urlPath} HTTP/1.1\r\n` +
        `Host: ${target.kind === 'tcp' ? target.host : '127.0.0.1'}\r\n` +
        auth + extra +
        'Accept: application/json\r\nConnection: close\r\n\r\n' + payload,
      );
    });
    sock.on('data', (d) => chunks.push(d));
    sock.on('error', (e) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      reject(new Error(`controller connection failed: ${e.message}`));
    });
    sock.on('close', () => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      const split = buf.indexOf('\r\n\r\n');
      if (split < 0) { reject(new Error('controller sent no HTTP header')); return; }
      const head = buf.subarray(0, split).toString('utf8');
      let payload = buf.subarray(split + 4);
      if (/transfer-encoding:\s*chunked/i.test(head)) payload = dechunk(payload);
      const headers = {};
      for (const line of head.split('\r\n').slice(1)) {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
      }
      const statusLine = head.split('\r\n')[0] || '';
      const status = Number(statusLine.split(' ')[1]) || 0;
      const text = payload.toString('utf8');
      let json = null;
      try { json = JSON.parse(text); } catch { /* plain text */ }
      resolve({ status, headers, json, text });
    });
  });
}

async function probe(target) {
  try {
    const r = await request(target, 'GET', '/version', null, { timeout: 2500 });
    if (r.status === 200 && r.json) return { ...target, version: r.json.version || '' };
  } catch { /* next */ }
  return null;
}

/** Find the live controller. Order: env override -> named pipes -> TCP hints -> common TCP ports. */
export async function discover(opts = {}) {
  if (opts.pipe) {
    const t = { kind: 'pipe', path: opts.pipe };
    const ok = await probe(t);
    if (ok) return ok;
  }
  if (opts.host && opts.port) {
    const t = { kind: 'tcp', host: opts.host, port: Number(opts.port), secret: opts.secret || '' };
    const ok = await probe(t);
    if (ok) return ok;
  }
  for (const p of listPipes()) {
    const ok = await probe({ kind: 'pipe', path: p });
    if (ok) return ok;
  }
  const hints = readControllerHints();
  const tcp = [...hints.tcp, ...TCP_CANDIDATES].filter(
    (v, i, a) => a.findIndex((x) => x[0] === v[0] && x[1] === v[1]) === i,
  );
  for (const [host, port] of tcp) {
    const t = { kind: 'tcp', host, port, secret: opts.secret || hints.secret };
    const ok = await probe(t);
    if (ok) return ok;
  }
  throw new Error('找不到 Clash/mihomo 外部控制器（命名管道与 9090/9097 都没有应答）');
}

/** A bound client: methods always go to this controller. */
export async function connect(opts = {}) {
  const target = await discover(opts);
  const call = (method, urlPath, body, o = {}) => request(target, method, urlPath, body, { ...o, secret: o.secret ?? target.secret });
  return {
    target,
    call,
    get: (p, o) => call('GET', p, null, o),
    put: (p, b, o) => call('PUT', p, b, o),
    patch: (p, b, o) => call('PATCH', p, b, o),
    del: (p, o) => call('DELETE', p, null, o),
  };
}
