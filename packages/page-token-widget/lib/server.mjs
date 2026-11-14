import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Collector, REFRESH_STRATEGIES, refreshStrategy } from './collector.mjs';
import { displayOptions } from './normalize.mjs';
import { sweepTemporaries } from './atomic.mjs';
import {
  ensureState, notePairing, rotatePairing, writeState, pairingUsable,
  addDevice, verifyToken, noteAccess, revokeDevice, renameDevice, deleteDevice, deviceOfToken, deviceList, newToken, hashToken,
} from './state.mjs';
import { bindCandidates, detect, interfaces, lanCandidates, ping } from './tailnet.mjs';
import { checkExternalURL, checkGatewayURL } from './network.mjs';
import { applyForward, publishedFor, removeForward, serveState, forwardRecord } from './forward.mjs';
import { dataUri } from './qr.mjs';

const PLUGIN = '@magpie-community/page-token-widget';
// The name of the header the token travels in. The console of the computer
// and the phone both use it.
export const TOKEN_HEADER = 'x-token-widget-token';
// The name of the header this service puts on every answer that refuses a
// token. A phone that reads it knows the refusal came from here and not from
// something that stands in front of the service, so it does not throw away a
// token that is still good.
export const SERVICE_HEADER = 'x-token-widget-service';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
// Ten wrong codes from one computer, and then the door is shut for five
// minutes. The record of the attempts is short and is cleaned up.
const PAIR_ATTEMPTS = 10;
// The address the phone is told to use. The user may have a network of
// his own (a Headscale of his own, a server of his own, a tunnel of his own),
// and then this address is the one the phone goes to.
//
// The rules for such an address live in lib/network.mjs, and the installer
// of the phone keeps the same rules: over plain HTTP only a network of the
// user is accepted, over HTTPS any name is. The address is never resolved,
// so a name that points somewhere else later cannot sneak past the check.
const externalOf = (value) => {
  const checked = checkExternalURL(value);
  if (!checked.ok || checked.empty) return { name: '', port: 0, origin: '', secure: false };
  return { name: checked.name, port: checked.port, origin: checked.origin, secure: checked.secure };
};
// The address the phone side listens on. It has to be an address of this
// computer: the service does not listen just anywhere.
const normalizeListenAddress = (value, candidates) => {
  const text = String(value || '').trim();
  if (!text) return '';
  return candidates.some((entry) => entry.address === text) ? text : null;
};
// The page of the pairing code is opened more often than the door itself: a
// phone that scans a code that has gone stale comes back here. It may be
// tried more often before the door is shut.
const PAIR_PAGE_ATTEMPTS = 30;
const PAIR_LOCK_MS = 5 * 60 * 1000;
const ATTEMPT_IDLE_MS = 15 * 60 * 1000;
const SESSION_CAP = 200;
// The whole service shares one bag of wrong tries. Counting per code alone
// would let anybody walk through as many codes as they like, one guess each,
// and never be told to stop. This budget puts a ceiling on the number of
// wrong tries in a window, no matter which code they were aimed at.
//
// A hundred wrong tries in five minutes is far above what an honest pair
// needs: a person who scans a code that has gone stale makes one or two.
const PAIR_BUDGET = 100;
const PAIR_BUDGET_MS = 5 * 60 * 1000;
// The door a phone leaves by has a bag of its own. A phone that says goodbye
// is not guessing anything, so it must not be able to fill the bag of the
// pairing for everybody else.
const FORGET_BUDGET = 60;
const FORGET_BUDGET_MS = 5 * 60 * 1000;
// The state of the tailnet is looked at every five minutes, not every minute:
// the command of Tailscale is not free, and nobody waits for it.
const TAILNET_INTERVAL_MS = 5 * 60 * 1000;

// Another Magpie on this computer may already serve this plugin on the port.
// The health answer says which plugin it is, so two instances of the same
// plugin can share one service instead of fighting over the port.
const servedByUs = async (port) => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.service === PLUGIN;
  } catch {
    return false;
  }
};

// The Magpie window runs a plugin page inside a sandboxed frame whose origin
// is opaque, so the service spells out the loopback origins and accepts the
// "null" origin those pages send.
const csp = (port) => {
  const self = `http://127.0.0.1:${port} http://localhost:${port}`;
  return [
    "default-src 'none'",
    `script-src 'self' ${self}`,
    `style-src 'self' ${self}`,
    `img-src 'self' data: ${self}`,
    `connect-src 'self' ${self}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
};

const PAIR_PAGE = `<!doctype html>
<html lang="zh">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>iPhone 额度组件</title>
    <style>
      :root { color-scheme: light dark; --bg:#f4f6f2; --card:#fff; --fg:#232523; --muted:#8a8f85; --line:#e4e8e1; --soft:#f0f3ee; --accent:#4c544a; }
      @media (prefers-color-scheme: dark) { :root { --bg:#1f221e; --card:#232722; --fg:#ebeee7; --muted:#92998d; --line:#2f342d; --soft:#262b24; --accent:#b9c8b0; } }
      * { box-sizing: border-box; }
      body { margin:0; padding:24px 18px 48px; background:var(--bg); color:var(--fg); font:15px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
      .card { max-width:460px; margin:0 auto; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:22px 20px; }
      h1 { font-size:19px; font-weight:600; margin:0 0 8px; }
      .lead { margin:0 0 16px; color:var(--muted); font-size:13px; }
      .button { display:block; text-align:center; padding:13px 16px; border-radius:11px; background:var(--accent); color:var(--card); text-decoration:none; font-weight:500; }
      .note { margin:14px 0 0; color:var(--muted); font-size:12px; }
    </style>
  </head>
  <body>
    <div class="card">
<!--CONTENT-->
    </div>
  </body>
</html>`;

const json = (response, status, value, extra = {}) => {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  response.end(JSON.stringify(value));
};

const text = (response, status, value, type = 'text/plain; charset=utf-8') => {
  response.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(value);
};

const same = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
};

const hostOf = (request) => {
  const raw = String(request.headers.host || '').trim().toLowerCase();
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return { raw, name: raw.slice(1, end), port: Number(raw.slice(end + 2)) || 0 };
  }
  const index = raw.lastIndexOf(':');
  if (index === -1) return { raw, name: raw, port: 0 };
  return { raw, name: raw.slice(0, index), port: Number(raw.slice(index + 1)) || 0 };
};

const jsonBody = async (request) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) return null;
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
};

export async function startServer({ root, dataDir, magpieDir, options = {} }) {
  const port = Number(options.port ?? 3498);
  // The phone gets a port of its own. The forwarding of Tailscale points the
  // published port at it, so a request that arrives through the tailnet lands
  // on a different socket than the console of this computer. The scope of a
  // request follows the socket it came in on, not the Host header it carries.
  const phonePort = Number(options.phonePort ?? port + 1);
  // The gateway of Magpie that this plugin reads. It is Magpie itself, on
  // this computer. An address that is not a loopback address is refused
  // with a clear reason, and nothing is asked of it: a wrong address would
  // only make the service send requests somewhere it should not.
  const gateway = checkGatewayURL(options.gatewayURL);
  const upstream = gateway.ok ? gateway.url : '';
  const gatewayError = gateway.ok ? '' : gateway.error;
  const stateFile = path.join(dataDir, 'state.json');
  const snapshotFile = path.join(dataDir, 'snapshot.json');

  const { state } = await ensureState(stateFile);
  // The address the phone is told to use, and the address the phone side
  // listens on when the user has a network of his own.
  let listenAddress = normalizeListenAddress(state.settings?.listenAddress, bindCandidates()) || '';
  let extraListener = null;
  let listenError = '';
  if (state.settings?.listenAddress && !listenAddress) {
    // The address of the last time is gone; the network of the office moved.
    // It is not kept in the file any more.
    delete state.settings.listenAddress;
    await writeState(stateFile, state).catch(() => {});
  }
  // The address the phone is told to use. An address that the rules of
  // lib/network.mjs refuse is not used: it is taken out of the file, and the
  // console says why. The tailnet is the way in until the user writes an
  // address that is good.
  const storedExternal = checkExternalURL(state.settings?.externalURL);
  let externalURL = storedExternal.ok && !storedExternal.empty ? storedExternal.url : '';
  let external = externalOf(externalURL);
  let externalError = '';
  if (!storedExternal.ok && state.settings?.externalURL) {
    externalError = `之前的地址「${state.settings.externalURL}」不能用了：${storedExternal.error}`;
    delete state.settings.externalURL;
    await writeState(stateFile, state).catch(() => {});
  }
  // The temporary files of a run that was killed stay behind; they are litter
  // and nothing ever reads them.
  await sweepTemporaries(stateFile);
  await sweepTemporaries(snapshotFile);
  const pluginSettings = options.settings || {};
  // The tests bring their own Tailscale, so the real command of the machine
  // is never touched while the tests run.
  const runner = options.tailscaleRunner || null;
  const collector = new Collector({
    // A gateway that was refused is never asked. The address below is one
    // that answers nobody: it is here so that the collector always has
    // something to work with, and it is never used for a reading.
    upstream: upstream || 'http://127.0.0.1:1',
    enabled: gateway.ok,
    magpieDir,
    snapshotFile,
    display: displayOptions({ ...state.settings, ...pluginSettings }),
    strategy: refreshStrategy(state.settings?.refreshStrategy),
  });
  await collector.load();
  // A gateway that was refused is never asked: nothing is sent to an address
  // the user did not mean.
  if (gateway.ok) void collector.refresh();

  let tailnet = {
    installed: false,
    connected: false,
    backendState: '',
    tailnetIP: '',
    dnsName: '',
    path: 'unknown',
    ios: [],
    error: '正在检测 Tailscale…',
  };
  let forward = { ready: false, port, phonePort, error: '正在准备尾网转发…' };
  const sessions = new Map();
  // The bag of wrong tries that the whole service shares.
  const budget = { count: 0, until: 0 };
  // The bag of wrong tries on the door a phone leaves by.
  const forgetBudget = { count: 0, until: 0 };
  let closed = false;
  // The console of this computer must not be reachable from the tailnet. It
  // stays shut until the forwarding is known to point at the phone side.
  let consoleOpen = false;
  let phoneBound = false;

  // The address the phone is told to use. When the user has an address of
  // his own, that one is used; otherwise the address of the tailnet.
  const serviceURL = () => externalURL || (tailnet.tailnetIP ? `http://${tailnet.tailnetIP}:${port}` : '');
  const pairingURL = () => (serviceURL() ? `${serviceURL()}/p/${state.pairing.code}` : '');
  // How long the pairing code is still good. The code is good for ten
  // minutes, and it is good only once.
  const pairingExpiresIn = () => {
    const until = Date.parse(state.pairing.expiresAt || '');
    if (!Number.isFinite(until)) return 0;
    return Math.max(0, Math.round((until - Date.now()) / 1000));
  };

  // The Host header is only a guard against a name that points at this
  // computer by accident. It says nothing about who is asking.
  // The phone side may be reached under the address the user gave, so that
  // name and that port belong to it. The console side keeps the port of the
  // plugin, and never the port of the phone.
  const allowedHosts = (host, scope) => {
    const name = host.name.toLowerCase();
    // The name the user gave: the phone may come under it, with the port of
    // the address or with the port it really arrives at (a proxy of his own
    // may sit in front). The console keeps to the port of the plugin.
    if (external.name && name === external.name) {
      return scope === 'phone' || host.port === port;
    }
    if (scope === 'console') {
      return host.port === port && LOCAL_HOSTS.has(name);
    }
    if (host.port !== port && host.port !== phonePort) return false;
    if (LOCAL_HOSTS.has(name)) return true;
    if (tailnet.tailnetIP && name === tailnet.tailnetIP.toLowerCase()) return true;
    if (tailnet.dnsName && name === tailnet.dnsName.toLowerCase()) return true;
    if (listenAddress && name === listenAddress.toLowerCase()) return true;
    return false;
  };

  // The origin of a request is the page it comes from. Only the origins that
  // belong to this service are let in.
  //
  // The address the user gave is one of them, exactly as it was given: an
  // https proxy in front is never taken for an http one, and a page that was
  // loaded over http may not read the answers of an https service. The
  // addresses of this computer are the others: the phone reaches the service
  // there directly, over plain http.
  //
  // The headers of a proxy are never believed: X-Forwarded-Proto and
  // X-Forwarded-Host are written by whoever sends the request.
  const originAllowed = (origin, host) => {
    // A request that carries no origin is not a request from a page of
    // another site.
    if (!origin) return true;
    // A page in a frame with no origin of its own (the window of Magpie).
    if (origin === 'null') return true;
    if (external.origin && origin === external.origin) return true;
    // Under the name of the user the service is only reached through the
    // address the user gave. Any other scheme there is refused.
    if (external.name && host.name === external.name) return false;
    return origin === `http://${host.raw}`;
  };

  const readToken = (request) => {
    const header = request.headers[TOKEN_HEADER];
    if (typeof header === 'string' && header) return header;
    const authorization = String(request.headers.authorization || '');
    if (authorization.startsWith('Bearer ')) return authorization.slice(7);
    return '';
  };

  // Two doors of their own. The console of this computer is opened by its own
  // token; the phone is opened by the token of its own device, and one phone
  // never opens the door of another.
  const phoneAuthorized = (request) => {
    const device = verifyToken(state, readToken(request));
    if (!device) return false;
    // The time of the last visit is written down at most once every five
    // minutes, so that a busy phone does not make the state file grow.
    if (noteAccess(device, Date.now())) {
      void writeState(stateFile, state).catch(() => {});
    }
    return true;
  };

  const consoleAuthorized = (request) => {
    const given = readToken(request);
    return Boolean(given) && same(given, state.consoleToken);
  };

  const consoleState = () => ({
    plugin: PLUGIN,
    port,
    phonePort,
    upstream: upstream,
    upstreamError: gatewayError,
    serviceURL: serviceURL(),
    pairingURL: pairingURL(),
    pairingCode: state.pairing.code,
    pairingExpiresAt: state.pairing.expiresAt || null,
    pairingExpiresIn: pairingExpiresIn(),
    // How long the door is still shut after too many wrong tries.
    pairingBlocked: budget.until > Date.now() ? Math.ceil((budget.until - Date.now()) / 1000) : 0,
    qr: pairingURL() ? dataUri(pairingURL()) : '',
    tailnet: {
      installed: tailnet.installed,
      connected: tailnet.connected,
      backendState: tailnet.backendState,
      tailnetIP: tailnet.tailnetIP,
      dnsName: tailnet.dnsName,
      path: tailnet.path || 'unknown',
      ios: tailnet.ios,
      error: tailnet.error,
      // The addresses of this computer are for the eyes of the person at the
      // keyboard. They never go to the phone.
      interfaces: interfaces(),
      lan: lanCandidates(),
    },
    // The network of the user, when Tailscale is not wanted.
    external: {
      url: externalURL,
      listenAddress,
      candidates: bindCandidates(),
      error: externalError || listenError,
      listenError,
      // How the phone is let in: through the tailnet, through an address of
      // the user, or through the address of this computer on the own
      // network.
      mode: externalURL
        ? (external.secure ? 'https' : 'own-address')
        : (listenAddress ? 'lan' : 'tailscale'),
    },
    paired: state.paired,
    devices: deviceList(state),
    forward: {
      ready: forward.ready,
      port: forward.port,
      phonePort: forward.phonePort,
      error: forward.error,
      owned: state.forward || null,
    },
    display: collector.display,
    refresh: {
      strategy: collector.strategy,
      label: REFRESH_STRATEGIES[collector.strategy]?.label || '',
      options: Object.values(REFRESH_STRATEGIES).map(entry => ({ id: entry.id, label: entry.label })),
    },
    subscriptions: collector.allSubscriptions(),
  });

  // The forwarding of the published port has to point at the phone side. A
  // forwarding of an older version of this plugin points at the console of
  // this computer, and it is moved to the phone side as well. A forwarding
  // that belongs to somebody else is left alone.
  const settleForwardOnce = async () => {
    if (options.forward === false || externalURL) {
      forward = {
        ready: false,
        port,
        phonePort,
        error: options.forward === false
          ? '这次没有建尾网转发，手机直接连尾网地址。'
          : '已经填了自己的地址，没有建尾网转发。',
      };
      // When the user has an address of his own, the forwarding of the
      // tailnet is taken away, if it is ours to take. Otherwise the tailnet
      // would keep a door open that the user has closed.
      if (externalURL && state.forward) {
        const removed = await removeForward(port, phonePort, runner, state.forward);
        if (removed?.ok) {
          state.forward = null;
          await writeState(stateFile, state).catch(() => {});
        }
      }
      // Even when no forwarding is wanted, the console of this computer must
      // not be reachable from the tailnet. A rule that an older version left
      // behind can still point the published port at the console, so the
      // console stays shut as long as that is the case.
      const status = await serveState(runner);
      const existing = publishedFor(status, port);
      const pointsAtConsole = existing && existing.TCPForward === `127.0.0.1:${port}`;
      consoleOpen = !pointsAtConsole;
      if (pointsAtConsole) {
        forward = {
          ...forward,
          error: '尾网上还留着一条指向这台电脑控制台的转发，控制台先关着。把它删掉，或者打开转发让插件自己接管。',
        };
      }
      return;
    }
    const status = await serveState(runner);
    const existing = publishedFor(status, port);
    consoleOpen = !existing || existing.TCPForward !== `127.0.0.1:${port}`;
    if (!phoneBound) {
      forward = { ready: false, port, phonePort, error: '手机那一侧的端口没有打开，手机暂时连不上。' };
      return;
    }
    const result = await applyForward(port, phonePort, runner, state.forward);
    if (result?.ok) {
      forward = { ready: true, port, phonePort, error: '' };
      consoleOpen = true;
      // The forwarding of this plugin is written down, so that the next start
      // knows that it may take it away again.
      const record = forwardRecord(port, phonePort, { legacy: Boolean(result.legacy) });
      if (!state.forward || state.forward.target !== record.target || state.forward.publishedPort !== record.publishedPort) {
        state.forward = record;
        await writeState(stateFile, state).catch(() => {});
      }
      return;
    }
    forward = { ready: false, port, phonePort, error: result?.error || '转发没有建好。' };
    // If the tailnet still points at the console of this computer, the console
    // stays shut.
    const after = await serveState(runner);
    const now = publishedFor(after, port);
    consoleOpen = !now || now.TCPForward !== `127.0.0.1:${port}`;
  };

  // Only one settling at a time.
  let settling = null;
  const settleForward = () => {
    if (settling) return settling;
    settling = settleForwardOnce().finally(() => { settling = null; });
    return settling;
  };

  // Is the published port already taken by a forwarding of Tailscale? Then
  // Tailscale itself holds the tailnet address of that port.
  const portPublished = async () => {
    const status = await serveState(runner);
    return Boolean(publishedFor(status, port));
  };

  const servePairPage = async (response, code, request) => {
    // The page of the pairing code is a door as well: it says whether a code
    // is good. It goes through the same limiter, only with more room, so that
    // a phone that scans a code which has gone stale is not shut out.
    const guard = pairingGuard(request, code, PAIR_PAGE_ATTEMPTS, 'page');
    const usable = guard.ok;
    const content = usable
      ? `<h1>装好 iPhone 额度组件</h1>
<p class="lead">这个配对码只能用一次，十分钟后也会作废。它换来的是一台只读的令牌，手机用它去读用量。</p>
<p><a class="button" href="/scriptable/UsageWidget.js?code=${encodeURIComponent(code)}">下载组件脚本</a></p>
<p class="note">脚本里没有你的密钥：它只带一个一次性配对码，跑一次就换成只读令牌。</p>
<p class="note">下载完之后，在「文件」里找到它，用 Scriptable 打开，再按提示装到桌面。</p>`
      : guard.locked
        ? `<h1>试得太多了</h1>
<p class="lead">这台电脑试了很多次配对码，先歇五分钟再来。</p>
<p class="note">回到电脑上的插件页面，重新生成一个配对码再扫一次。</p>`
        : `<h1>这个配对码已经失效</h1>
<p class="lead">它只能用一次，十分钟后也会作废。</p>
<p class="note">回到电脑上的插件页面，重新生成一个配对码再扫一次。</p>`;
    response.writeHead(usable ? 200 : (guard.locked ? 429 : 410), {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(PAIR_PAGE.replace('<!--CONTENT-->', content));
  };

  // The widget carries the pairing code when the phone downloads it from the
  // pairing page. A phone that installs it by hand already knows the token,
  // so the token alone is enough to get the same script.
  const serveWidget = async (response, code, request) => {
    // A code that comes with the request is a door as well: the answer says
    // whether it opens. It goes through the same limiter as the pairing
    // itself, so nobody can ask as often as they like.
    let paired = false;
    if (code) {
      const guard = pairingGuard(request, code, PAIR_ATTEMPTS, 'widget');
      if (guard.ok) {
        paired = true;
      } else if (!phoneAuthorized(request)) {
        return json(response, guard.status, { error: guard.error });
      }
    }
    if (!paired && !phoneAuthorized(request)) {
      return json(response, 403, { error: '这个配对码已经失效。' });
    }
    let source;
    try {
      source = await readFile(path.join(root, 'scriptable', 'UsageWidget.js'), 'utf8');
    } catch {
      return text(response, 404, 'Not found');
    }
    const body = paired
      ? source.replace(
        'let PAIRED = null;',
        `let PAIRED = { baseURL: ${JSON.stringify(serviceURL())}, code: ${JSON.stringify(code)} };`,
      )
      : source;
    response.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Content-Disposition': 'attachment; filename="UsageWidget.js"',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(body);
  };

  // The page of the phone. It carries no token: the phone brings its own in
  // the address, and the page drops it as soon as it has read it.
  const phoneCsp =
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'";

  const serveMobile = async (response, name, type) => {
    try {
      const body = await readFile(path.join(root, 'mobile', name), 'utf8');
      response.writeHead(200, {
        'Content-Type': type,
        'Content-Security-Policy': phoneCsp,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(body);
    } catch {
      text(response, 404, 'Not found');
    }
  };

  // The scripts and the styles of the console. The Magpie window shows this
  // page inside a sandboxed frame, and a sandboxed frame has no origin of
  // its own: the browser calls it "null". A module script is always fetched
  // in CORS mode, so without the header that lets it be read, the window
  // shows the page but nothing on it ever works.
  //
  // These files hold no secret. The page that carries the token is served
  // apart, and it does not get this header: a site on the internet must not
  // be able to read the console of this computer.
  const serveUi = async (response, name, type, port, cors) => {
    try {
      const body = await readFile(path.join(root, 'ui', name), 'utf8');
      response.writeHead(200, {
        'Content-Type': type,
        'Content-Security-Policy': csp(port),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...(cors || {}),
      });
      response.end(body);
    } catch {
      text(response, 404, 'Not found');
    }
  };

  // The records of the failed attempts are few: the old ones are cleaned up
  // and the list never grows past its cap.
  const cleanSessions = () => {
    const now = Date.now();
    // The bag of wrong tries empties itself when its window is over.
    if (budget.until && budget.until <= now) {
      budget.until = 0;
      budget.count = 0;
    }
    for (const [key, value] of sessions) {
      // A record that is not locked goes away on its own after a while, so
      // that a code nobody tries again does not stay in the memory.
      const idle = !value.until && value.last && now - value.last > ATTEMPT_IDLE_MS;
      if ((value.until && value.until <= now) || idle) sessions.delete(key);
    }
    while (sessions.size > SESSION_CAP) {
      const oldest = sessions.keys().next();
      if (oldest.done) break;
      sessions.delete(oldest.value);
    }
  };

  // Every way of trying a pairing code goes through this door.
  //
  // Two things keep the guessing small.
  //
  // The first is the bag of wrong tries that the whole service shares: a
  // hundred wrong tries in five minutes and the door is shut for everybody
  // until the bag is emptied. It is looked at before the code itself, so a
  // wrong code cannot be tested faster than the bag allows. The person at the
  // computer can empty the bag at once by asking for a new pairing code.
  //
  // The second is the record that follows the CODE and not the computer that
  // tries it. That matters behind the forwarding of Tailscale: tailscaled
  // itself dials the loopback, so every phone of the tailnet arrives as
  // 127.0.0.1. Counting per address there would let one peer shut the
  // pairing of everybody else.
  //
  // What actually makes a code hard to guess is neither of those: a code is
  // ninety-six bits of randomness, it lives ten minutes and it opens the door
  // once. The two doors above only keep the noise down and stop anybody from
  // leaning on the service.
  //
  // The address in the header of the request is not believed either, anybody
  // can write it.
  //
  // It answers with { ok: true } when the code opens the door, and with
  // { ok: false, status, error } when it does not.
  const pairingGuard = (request, code, limit = PAIR_ATTEMPTS, kind = 'session') => {
    const address = request.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    if (budget.until > now) {
      return { ok: false, status: 429, error: 'Too many attempts. Try again later.', locked: true };
    }
    // The code itself is a secret, so only its hash is written down.
    const key = `${kind}|${hashToken(String(code || ''))}`;
    const attempts = sessions.get(key) || { count: 0, until: 0, last: 0 };
    if (attempts.until > now) {
      return { ok: false, status: 429, error: 'Too many attempts. Try again later.', locked: true };
    }
    if (pairingUsable(state, code, now)) {
      sessions.delete(key);
      return { ok: true, address };
    }
    attempts.count += 1;
    attempts.last = now;
    if (attempts.count >= limit) {
      attempts.until = now + PAIR_LOCK_MS;
      attempts.count = 0;
    }
    sessions.set(key, attempts);
    // The wrong try also goes into the bag that the whole service shares.
    budget.count += 1;
    if (budget.count >= PAIR_BUDGET) {
      budget.count = 0;
      budget.until = now + PAIR_BUDGET_MS;
    }
    cleanSessions();
    return { ok: false, status: 403, error: 'That pairing code is not valid.' };
  };

  // The scope comes from the socket the request came in on. The console of
  // this computer listens on the loopback address of the published port, the
  // phone side listens on a port of its own.
  const handle = async (request, response, scope) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    // Magpie's service proxy strips its own prefix before it forwards. The
    // service answers the same paths either way.
    let pathname = url.pathname;
    const stripped = pathname.match(/^\/_magpie\/(?:plugin\/[^/]+\/)?service(\/.*)?$/);
    if (stripped) pathname = stripped[1] || '/';

    const host = hostOf(request);
    if (!allowedHosts(host, scope)) return json(response, 403, { error: 'Invalid host.' });

    // The origin of the request. Only the origins that belong to this
    // service are let in. The address the user gave is one of them, exactly
    // as it was given: an https proxy is never taken for an http one. The
    // addresses of this computer are the others: the phone reaches the
    // service there directly, over plain http.
    //
    // The headers of a proxy are never believed: X-Forwarded-Proto and
    // X-Forwarded-Host are written by whoever sends the request.
    const origin = request.headers.origin;
    if (!originAllowed(origin, host)) {
      return json(response, 403, { error: 'Invalid origin.' });
    }

    const consoleScope = scope === 'console';
    const method = request.method || 'GET';
    const allowOrigin = { 'Access-Control-Allow-Origin': origin || `http://${request.headers.host}`, Vary: 'Origin' };

    // The question a browser asks before it sends a request that carries a
    // token. It has no token of its own, so it is answered before the door
    // of the token is looked at.
    if (method === 'OPTIONS') {
      response.writeHead(204, {
        ...allowOrigin,
        'Access-Control-Allow-Headers': `Content-Type, ${TOKEN_HEADER}, Authorization`,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Max-Age': '600',
      });
      return response.end();
    }

    if (pathname === '/health') {
      return json(response, 200, {
        ok: true,
        service: PLUGIN,
        port,
        phonePort,
        tailnetIP: tailnet.tailnetIP,
        connected: tailnet.connected,
      }, allowOrigin);
    }

    if (pathname.startsWith('/api/v1/console/')) {
      if (!consoleScope) {
        return json(response, 403, { error: 'This page is only opened on the computer of the service.' });
      }
      if (!consoleOpen) {
        return json(response, 503, { error: '服务还在准备尾网转发，请稍后再打开。' });
      }
      if (method === 'OPTIONS') {
        response.writeHead(204, {
          ...allowOrigin,
          'Access-Control-Allow-Headers': `Content-Type, ${TOKEN_HEADER}`,
          'Access-Control-Allow-Methods': 'GET, POST',
        });
        return response.end();
      }
      if (!consoleAuthorized(request)) {
        return json(response, 403, { error: 'Reopen the page to reconnect.', code: 'reconnect' }, allowOrigin);
      }
      if (pathname === '/api/v1/console/state' && method === 'GET') {
        // Somebody is at the computer: the reading keeps its rhythm.
        collector.noteActivity();
        return json(response, 200, consoleState(), allowOrigin);
      }
      if (pathname === '/api/v1/console/pair' && method === 'POST') {
        rotatePairing(state);
        // A new code empties the bag of wrong tries as well, so the person at
        // the keyboard can open the door again at once.
        budget.count = 0;
        budget.until = 0;
        await writeState(stateFile, state);
        return json(response, 200, consoleState(), allowOrigin);
      }
      if (pathname === '/api/v1/console/options' && method === 'POST') {
        const body = await jsonBody(request);
        if (!body) return json(response, 400, { error: 'Bad request.' }, allowOrigin);
        // The address of the phone and the address the phone side listens
        // on are checked before anything is written. The address the phone
        // is told to use is checked here and in the installer of the phone,
        // and the two keep the same rules.
        let chosenExternal = null;
        if (body.externalURL !== undefined) {
          const checked = checkExternalURL(body.externalURL);
          if (!checked.ok) {
            return json(response, 400, { error: checked.error }, allowOrigin);
          }
          chosenExternal = checked.empty ? '' : checked.url;
        }
        let chosenListen = null;
        if (body.listenAddress !== undefined) {
          chosenListen = normalizeListenAddress(body.listenAddress, bindCandidates());
          if (chosenListen === null) {
            return json(response, 400, { error: 'That is not an address of this computer.' }, allowOrigin);
          }
        }
        const next = displayOptions({ ...state.settings, ...body });
        state.settings = { ...state.settings, ...next };
        if (body.refreshStrategy !== undefined) {
          state.settings.refreshStrategy = refreshStrategy(body.refreshStrategy);
        }
        if (chosenExternal !== null) {
          externalURL = chosenExternal;
          external = externalOf(chosenExternal);
          externalError = '';
          if (chosenExternal) state.settings.externalURL = chosenExternal;
          else delete state.settings.externalURL;
        }
        if (chosenListen !== null) {
          listenAddress = chosenListen;
          if (chosenListen) state.settings.listenAddress = chosenListen;
          else delete state.settings.listenAddress;
          await openExtraListener(listenAddress);
          if (listenError) {
            // The port did not open. Nothing is written down, so the file
            // does not remember an address that is not listening.
            delete state.settings.listenAddress;
            listenAddress = '';
            await writeState(stateFile, state).catch(() => {});
            return json(response, 400, { error: listenError, external: consoleState().external }, allowOrigin);
          }
        }
        await writeState(stateFile, state);
        // The forwarding of the tailnet follows the address the phone uses:
        // with an address of his own there is no forwarding to build.
        void settleForward();
        collector.setDisplay(displayOptions({ ...state.settings, ...pluginSettings }));
        // The rhythm of the reading changes at once. The service does not have
        // to be started again for that.
        collector.setStrategy(state.settings.refreshStrategy);
        return json(response, 200, {
          display: collector.display,
          refresh: consoleState().refresh,
          external: consoleState().external,
        }, allowOrigin);
      }
      if (pathname === '/api/v1/console/network/reset' && method === 'POST') {
        // The way back to the default: the tailnet. Everything the user set
        // for a network of his own is taken away, and the port that was
        // opened on the own network is closed for real.
        const result = await resetNetwork();
        if (!result.ok) {
          return json(response, 500, { error: result.error, external: consoleState().external }, allowOrigin);
        }
        return json(response, 200, {
          ...consoleState(),
          network: { restored: true, wasListening: result.wasListening, mode: consoleState().external.mode },
        }, allowOrigin);
      }
      if (pathname === '/api/v1/console/device' && method === 'POST') {
        const body = await jsonBody(request);
        if (!body) return json(response, 400, { error: 'Bad request.' }, allowOrigin);
        if (body.action === 'create') {
          // A token made by hand, for a phone that cannot read the QR code.
          // It is written out once, and only its hash is kept.
          const token = newToken();
          const device = addDevice(state, { name: body.name, token });
          await writeState(stateFile, state);
          return json(response, 200, { devices: deviceList(state), device: { id: device.id, name: device.name }, token }, allowOrigin);
        }
        if (typeof body.id !== 'string') return json(response, 400, { error: 'Bad request.' }, allowOrigin);
        if (!['rename', 'revoke', 'delete'].includes(body.action)) {
          return json(response, 400, { error: 'Bad request.' }, allowOrigin);
        }
        // A device is taken off the list only after it was revoked. Revoking
        // is the step that stops the phone; deleting is the step that cleans
        // the list up. Keeping them apart means a row never disappears
        // without the console having said so first.
        if (body.action === 'delete') {
          const device = (state.devices || []).find(entry => entry?.id === body.id);
          if (!device) return json(response, 404, { error: 'Not found.' }, allowOrigin);
          if (!device.revokedAt) {
            return json(response, 409, { error: 'Revoke it first.' }, allowOrigin);
          }
        }
        const changed = body.action === 'rename'
          ? renameDevice(state, body.id, body.name)
          : body.action === 'delete'
            ? deleteDevice(state, body.id)
            : revokeDevice(state, body.id);
        if (!changed) return json(response, 404, { error: 'Not found.' }, allowOrigin);
        await writeState(stateFile, state);
        return json(response, 200, { devices: deviceList(state) }, allowOrigin);
      }
      if (pathname === '/api/v1/console/diagnose' && method === 'POST') {
        const body = (await jsonBody(request)) || {};
        // The person at the keyboard asked for it, so Tailscale is asked now
        // and not once a minute for nothing.
        tailnet = await detect(runner);
        const target = typeof body.target === 'string' ? body.target : (tailnet.ios?.[0]?.ips?.[0] || '');
        // The target goes to the command of Tailscale. Only an address or a
        // plain name is allowed, so that nothing else can ride along.
        const safeTarget = /^[A-Za-z0-9.:_-]{1,64}$/.test(target) ? target : '';
        const result = safeTarget
          ? await ping(safeTarget, runner)
          : { ok: false, stdout: '', path: 'unknown', error: safeTarget ? '没有可诊断的地址。' : '这个地址不能用来诊断。' };
        return json(response, 200, {
          tailnet: consoleState().tailnet,
          ping: {
            target: safeTarget,
            ok: Boolean(result.ok),
            path: result.path || 'unknown',
            error: result.error || null,
            output: String(result.stdout || '').slice(0, 2000),
          },
        }, allowOrigin);
      }
      return json(response, 404, { error: 'Not found.' }, allowOrigin);
    }

    if (pathname === '/api/v1/overview' && method === 'GET') {
      if (!phoneAuthorized(request)) {
        // The header tells the phone that the refusal is ours. A proxy that
        // stands in front of the service has its own 401, and the phone must
        // not throw away a token that is still good.
        return json(response, 401, { error: 'Unauthorized' }, { [SERVICE_HEADER]: PLUGIN });
      }
      // A phone that asks while the reading is being refreshed waits for it a
      // little. When the wait is over the old numbers go out, marked stale.
      return json(response, 200, await collector.ensureFresh());
    }

    if (pathname === '/api/v1/device/forget' && method === 'POST') {
      // A phone that is going away takes its own row off the list of the
      // devices. Its own token is the only thing that is asked for, and a
      // token that has been revoked is enough: the row is dead anyway, and
      // the point of the row is to say that the phone is gone. A live token
      // may take its row too — that is the phone leaving on its own terms,
      // which is the same thing a revoke says, only said by the phone
      // itself. Nobody else's row can be touched from here: the row is
      // found by the token, and a token opens exactly one row.
      //
      // The tries are counted in a bag of their own, not in the one the
      // pairing shares. A made-up token guesses nothing, so it has no reason
      // to shut the door of the pairing for everybody else. A stranger leaning
      // on this door is still slowed down.
      const now = Date.now();
      if (forgetBudget.until > now) return json(response, 429, { error: 'Too many attempts. Try again later.' });
      forgetBudget.count += 1;
      if (forgetBudget.count >= FORGET_BUDGET) {
        forgetBudget.count = 0;
        forgetBudget.until = now + FORGET_BUDGET_MS;
      }
      const device = deviceOfToken(state, readToken(request));
      if (!device) return json(response, 200, { forgotten: false });
      deleteDevice(state, device.id);
      await writeState(stateFile, state);
      return json(response, 200, { forgotten: true });
    }

    if (pathname === '/api/v1/session' && method === 'POST') {
      const body = await jsonBody(request);
      if (!body || typeof body.code !== 'string') return json(response, 400, { error: 'Bad request.' });
      const guard = pairingGuard(request, body.code);
      if (!guard.ok) return json(response, guard.status, { error: guard.error });
      // The code is used once: it is changed at once, so it never opens the
      // door a second time.
      rotatePairing(state);
      // Every phone gets a token of its own. Only the hash of it is kept; the
      // token itself goes out once, with this answer.
      const token = newToken();
      const device = addDevice(state, { name: body.name, token });
      notePairing(state, guard.address, device.name);
      await writeState(stateFile, state);
      return json(response, 200, {
        token,
        device: { id: device.id, name: device.name },
        baseURL: serviceURL(),
      });
    }

    if (pathname === '/scriptable/UsageWidget.js' && method === 'GET') {
      return serveWidget(response, url.searchParams.get('code'), request);
    }

    if (pathname === '/scriptable/SetupUsageWidget.js' && method === 'GET') {
      try {
        const body = await readFile(path.join(root, 'scriptable', 'SetupUsageWidget.js'), 'utf8');
        response.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        // The port of this service is written into the script, so the phone
        // does not have to guess it.
        // The phone is told the port of the address it is given: in the mode
        // of an address of the user's own that is the port of the phone side.
        let servicePort = port;
        try {
          const address = serviceURL();
          if (address) {
            const parsed = new URL(address);
            servicePort = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
          }
        } catch {
          servicePort = port;
        }
        // The port the installer suggests is the port of this service, not a
        // number that was written down once in the file: a plugin that is
        // given another port has to say so.
        return response.end(body.replace(/const DEFAULT_PORT = \d+;/, `const DEFAULT_PORT = ${servicePort};`));
      } catch {
        return text(response, 404, 'Not found');
      }
    }

    if (pathname.startsWith('/p/') && method === 'GET') {
      let code = '';
      try {
        code = decodeURIComponent(pathname.slice('/p/'.length));
      } catch {
        return json(response, 400, { error: 'Bad request.' });
      }
      return servePairPage(response, code, request);
    }

    if (!consoleScope) {
      // The phone opens the page of the phone here. It carries no token: the
      // phone brings its own in the address and drops it as soon as it has
      // read it.
      if ((pathname === '/' || pathname === '/index.html') && method === 'GET') {
        return serveMobile(response, 'index.html', 'text/html; charset=utf-8');
      }
      if (pathname === '/app.js' && method === 'GET') {
        return serveMobile(response, 'app.js', 'text/javascript; charset=utf-8');
      }
      if (pathname === '/style.css' && method === 'GET') {
        return serveMobile(response, 'style.css', 'text/css; charset=utf-8');
      }
      return json(response, 403, { error: 'This page is only opened on the computer of the service.' });
    }
    if (!consoleOpen) {
      return json(response, 503, { error: '服务还在准备尾网转发，请稍后再打开。' });
    }

    if ((pathname === '/' || pathname === '/index.html') && method === 'GET') {
      // The page carries the token of the console. Only a navigation may read
      // it, so a page on another site cannot fetch it and take the token.
      const mode = request.headers['sec-fetch-mode'];
      if (mode && mode !== 'navigate') {
        return json(response, 403, { error: 'Open this page by hand, not from another page.' });
      }
      let body;
      try {
        body = await readFile(path.join(root, 'ui', 'index.html'), 'utf8');
      } catch {
        return text(response, 404, 'Not found');
      }
      body = body.replace('__SERVICE_TOKEN__', state.consoleToken);
      body = body.replace('__THEME__', url.searchParams.get('theme') === 'dark' ? 'dark' : 'light');
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': csp(port),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      return response.end(body);
    }

    if (pathname === '/app.js' && method === 'GET') {
      return serveUi(response, 'app.js', 'text/javascript; charset=utf-8', port, allowOrigin);
    }
    if (pathname === '/timing.mjs' && method === 'GET') {
      return serveUi(response, 'timing.mjs', 'text/javascript; charset=utf-8', port, allowOrigin);
    }
    if (pathname === '/style.css' && method === 'GET') {
      return serveUi(response, 'style.css', 'text/css; charset=utf-8', port, allowOrigin);
    }
    if (pathname === '/icon.svg' && method === 'GET') {
      try {
        const body = await readFile(path.join(root, 'page', 'icon.svg'), 'utf8');
        response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
        return response.end(body);
      } catch {
        return text(response, 404, 'Not found');
      }
    }

    return json(response, 404, { error: 'Not found.' });
  };

  const makeServer = (scope) =>
    createServer((request, response) => {
      handle(request, response, scope).catch((error) => {
        if (!response.headersSent) json(response, 500, { error: error.message });
        else response.end();
      });
    });

  // The window opens the page as soon as the plugin is loaded, so the service
  // has to be listening before anything slow happens.
  const server = makeServer('console');
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) {
    server.close(() => {});
    // A second Magpie on this computer finds the port taken by the first one.
    // That service already answers everything the page asks for, so this
    // instance shares it instead of failing to load.
    if (error?.code !== 'EADDRINUSE' || !(await servedByUs(port))) throw error;
    return {
      port,
      phonePort,
      shared: true,
      async close() {},
    };
  }

  // The phone side of the service. The forwarding of Tailscale points the
  // published port at this port, so a request from the tailnet lands here
  // and is answered as a request of the phone.
  const phoneServer = makeServer('phone');
  try {
    await new Promise((resolve, reject) => {
      phoneServer.once('error', reject);
      phoneServer.listen(phonePort, '127.0.0.1', resolve);
    });
    phoneBound = true;
  } catch (error) {
    phoneServer.close(() => {});
  }

  // The phone side may also listen on an address of the own network of the
  // user, so a phone that is not on the tailnet can reach it. Only the phone
  // side listens there; the console of this computer never does.
  async function openExtraListener(address) {
    if (extraListener) {
      const old = extraListener;
      extraListener = null;
      // The connections are closed right away; the socket does not have to
      // wait for them before the new one opens. A port that is closed for
      // good must not keep a phone hanging on it.
      if (typeof old.closeAllConnections === 'function') old.closeAllConnections();
      else if (typeof old.closeIdleConnections === 'function') old.closeIdleConnections();
      await new Promise((resolve) => old.close(resolve));
    }
    listenError = '';
    if (!address) return;
    const listener = makeServer('phone');
    try {
      await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(phonePort, address, resolve);
      });
      extraListener = listener;
    } catch (error) {
      listenError = `手机那一侧的端口没有在 ${address} 上打开：${error.message}`;
      listener.close(() => {});
    }
  }
  await openExtraListener(listenAddress);

  // The way back to the default connection, which is the tailnet.
  //
  // Everything the user set for a network of his own is taken away: the
  // address the phone was told to use, the address the phone side listened
  // on, and what is written down about it. The port that was opened on the
  // own network is closed for real, and only then is the forwarding of the
  // tailnet built again.
  //
  // The order matters. The forwarding follows the address of the phone: a
  // forwarding is only built when the phone does not have an address of his
  // own. And the port has to be shut before the console says that the
  // service is back on the tailnet, or the user would believe that the LAN
  // port is closed while it is still open.
  const resetNetwork = async () => {
    const wasListening = Boolean(extraListener);
    await openExtraListener('');
    if (extraListener) {
      // The socket did not go. The console says so instead of pretending
      // that everything is back the way it was.
      listenError = '手机那一侧的端口没有关上，关掉它之后再来试一次。';
      return { ok: false, error: listenError };
    }
    listenAddress = '';
    externalURL = '';
    external = externalOf('');
    externalError = '';
    delete state.settings.listenAddress;
    delete state.settings.externalURL;
    await writeState(stateFile, state).catch(() => {});
    // The forwarding of the tailnet comes back.
    await settleForward();
    return { ok: true, wasListening };
  };

  const tailnetListener = makeServer('phone');
  const timers = [];

  const background = async () => {
    if (closed) return;
    tailnet = await detect(runner);
    if (closed) return;
    await settleForward();
    if (closed) return;
    if (options.listenTailnet !== false && tailnet.tailnetIP && !(await portPublished())) {
      // The address the tailnet listener binds. The permission of a request
      // does not depend on it: the listener that took the connection says
      // what the request may do, not the address it came from.
      const address = options.tailnetAddress || tailnet.tailnetIP;
      await new Promise((resolve) => {
        tailnetListener.once('error', () => resolve());
        tailnetListener.listen(port, address, resolve);
      }).catch(() => {});
    }
  };
  void background();

  // The rhythm of the reading is kept by the collector itself: it knows when
  // somebody is looking and when nobody is. A gateway that was refused is
  // never asked, so there is nothing to keep up.
  if (gateway.ok) collector.start();

  // The state of the tailnet is looked at every five minutes, and not once a
  // minute for nothing: the command of Tailscale is not free. When it fails,
  // it is asked less often still.
  let tailnetFailures = 0;
  let tailnetPatience = 0;
  timers.push(
    setInterval(() => {
      void (async () => {
        if (closed) return;
        if (tailnetPatience > 0) {
          tailnetPatience -= 1;
          return;
        }
        const fresh = await detect(runner);
        if (closed) return;
        tailnet = fresh;
        if (fresh.error) {
          tailnetFailures += 1;
          if (tailnetFailures >= 3) tailnetPatience = 2;
          return;
        }
        tailnetFailures = 0;
        await settleForward();
      })();
    }, TAILNET_INTERVAL_MS),
  );

  return {
    port,
    phonePort,
    // The collector is handed out so that the tests may look at it. Nothing
    // outside this file uses it.
    collector,
    async close() {
      closed = true;
      for (const timer of timers) clearInterval(timer);
      // The timer of the reading stops at once, and the reading that is still
      // on its way is waited for, so that it does not write the snapshot
      // after the service has gone.
      const stopping = collector.stop();
      // Only the forwarding that belongs to this plugin is taken away.
      await removeForward(port, phonePort, runner, state.forward);
      await stopping;
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => phoneServer.close(resolve));
      if (extraListener) await new Promise((resolve) => extraListener.close(resolve));
      await new Promise((resolve) => tailnetListener.close(resolve));
    },
  };
}
