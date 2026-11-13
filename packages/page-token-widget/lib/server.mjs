import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Collector } from './collector.mjs';
import { displayOptions } from './normalize.mjs';
import { ensureState, notePairing, rotatePairing, writeState } from './state.mjs';
import { detect } from './tailnet.mjs';
import { applyForward, removeForward, serveState } from './forward.mjs';
import { dataUri } from './qr.mjs';

const PLUGIN = '@magpie-community/page-token-widget';
const TOKEN_HEADER = 'x-token-widget-token';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

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
    return { name: raw.slice(1, end), port: Number(raw.slice(end + 2)) || 0 };
  }
  const index = raw.lastIndexOf(':');
  if (index === -1) return { name: raw, port: 0 };
  return { name: raw.slice(0, index), port: Number(raw.slice(index + 1)) || 0 };
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
  const upstream = options.gatewayURL || 'http://127.0.0.1:3425';
  const stateFile = path.join(dataDir, 'state.json');
  const snapshotFile = path.join(dataDir, 'snapshot.json');

  const { state } = await ensureState(stateFile);
  const pluginSettings = options.settings || {};
  const collector = new Collector({
    upstream,
    magpieDir,
    snapshotFile,
    display: displayOptions({ ...state.settings, ...pluginSettings }),
  });
  await collector.load();
  void collector.refresh();

  let tailnet = {
    installed: false,
    connected: false,
    backendState: '',
    tailnetIP: '',
    dnsName: '',
    ios: [],
    error: '正在检测 Tailscale…',
  };
  let forward = { ready: false, port, error: '正在准备尾网转发…' };
  const sessions = new Map();
  let closed = false;

  const serviceURL = () => (tailnet.tailnetIP ? `http://${tailnet.tailnetIP}:${port}` : '');
  const pairingURL = () => (serviceURL() ? `${serviceURL()}/p/${state.pairing.code}` : '');

  const allowedHosts = (host) => {
    if (host.port !== port) return false;
    if (LOCAL_HOSTS.has(host.name)) return true;
    if (tailnet.tailnetIP && host.name === tailnet.tailnetIP.toLowerCase()) return true;
    if (tailnet.dnsName && host.name === tailnet.dnsName.toLowerCase()) return true;
    return false;
  };

  const readToken = (request) => {
    const header = request.headers[TOKEN_HEADER];
    if (typeof header === 'string' && header) return header;
    const authorization = String(request.headers.authorization || '');
    if (authorization.startsWith('Bearer ')) return authorization.slice(7);
    return '';
  };

  const authorized = (request) => {
    const given = readToken(request);
    return Boolean(given) && same(given, state.token);
  };

  const consoleState = () => ({
    plugin: PLUGIN,
    port,
    upstream,
    serviceURL: serviceURL(),
    pairingURL: pairingURL(),
    pairingCode: state.pairing.code,
    token: state.token,
    qr: pairingURL() ? dataUri(pairingURL()) : '',
    tailnet: {
      installed: tailnet.installed,
      connected: tailnet.connected,
      backendState: tailnet.backendState,
      tailnetIP: tailnet.tailnetIP,
      dnsName: tailnet.dnsName,
      ios: tailnet.ios,
      error: tailnet.error,
    },
    paired: state.paired,
    forward: { ready: forward.ready, port: forward.port, error: forward.error },
    display: collector.display,
    subscriptions: collector.overviewWith({ ...collector.display, subscriptions: ['*'] }).subscriptions,
  });

  const syncForward = async () => {
    if (options.forward === false) {
      forward = { ready: false, port, error: '这次没有建尾网转发，手机直接连尾网地址。' };
      return;
    }
    const result = await applyForward(port);
    if (result?.ok) {
      forward = { ready: true, port, error: '' };
      return;
    }
    forward = { ready: false, port, error: result?.error || '转发没有建好。' };
  };

  const forwardOwned = async () => {
    const status = await serveState();
    const existing = status?.data?.state?.TCP?.[String(port)];
    return existing?.TCPForward === `127.0.0.1:${port}`;
  };

  const servePairPage = async (response, code) => {
    const usable = Boolean(code) && code === state.pairing.code;
    const content = usable
      ? `<h1>装好 iPhone 额度组件</h1>
<p class="lead">这个配对码只能用一次。它换来的是一台只读的令牌，手机用它去读用量。</p>
<p><a class="button" href="/scriptable/UsageWidget.js?code=${encodeURIComponent(code)}">下载组件脚本</a></p>
<p class="note">脚本里没有你的密钥：它只带一个一次性配对码，跑一次就换成只读令牌。</p>
<p class="note">下载完之后，在「文件」里找到它，用 Scriptable 打开，再按提示装到桌面。</p>`
      : `<h1>这个配对码已经失效</h1>
<p class="lead">它只能用一次，而且已经用掉了。</p>
<p class="note">回到电脑上的插件页面，重新生成一个配对码再扫一次。</p>`;
    response.writeHead(usable ? 200 : 410, {
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
    const paired = code && code === state.pairing.code;
    if (!paired && !authorized(request)) {
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

  const serveUi = async (response, name, type, port) => {
    try {
      const body = await readFile(path.join(root, 'ui', name), 'utf8');
      response.writeHead(200, {
        'Content-Type': type,
        'Content-Security-Policy': csp(port),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(body);
    } catch {
      text(response, 404, 'Not found');
    }
  };

  const handle = async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    // Magpie's service proxy strips its own prefix before it forwards. The
    // service answers the same paths either way.
    let pathname = url.pathname;
    const stripped = pathname.match(/^\/_magpie\/(?:plugin\/[^/]+\/)?service(\/.*)?$/);
    if (stripped) pathname = stripped[1] || '/';

    const host = hostOf(request);
    if (!allowedHosts(host)) return json(response, 403, { error: 'Invalid host.' });

    const origin = request.headers.origin;
    if (origin && origin !== 'null' && origin !== `http://${request.headers.host}`) {
      return json(response, 403, { error: 'Invalid origin.' });
    }

    const local = LOCAL_HOSTS.has(host.name);
    const method = request.method || 'GET';
    const allowOrigin = { 'Access-Control-Allow-Origin': origin || `http://${request.headers.host}`, Vary: 'Origin' };

    if (pathname === '/health') {
      return json(response, 200, {
        ok: true,
        service: PLUGIN,
        port,
        tailnetIP: tailnet.tailnetIP,
        connected: tailnet.connected,
      });
    }

    if (pathname.startsWith('/api/v1/console/')) {
      if (!local) {
        return json(response, 403, { error: 'This page is only opened on the computer of the service.' });
      }
      if (method === 'OPTIONS') {
        response.writeHead(204, {
          ...allowOrigin,
          'Access-Control-Allow-Headers': `Content-Type, ${TOKEN_HEADER}`,
          'Access-Control-Allow-Methods': 'GET, POST',
        });
        return response.end();
      }
      if (!authorized(request)) {
        return json(response, 403, { error: 'Reopen the page to reconnect.', code: 'reconnect' }, allowOrigin);
      }
      if (pathname === '/api/v1/console/state' && method === 'GET') {
        return json(response, 200, consoleState(), allowOrigin);
      }
      if (pathname === '/api/v1/console/pair' && method === 'POST') {
        rotatePairing(state);
        await writeState(stateFile, state);
        return json(response, 200, consoleState(), allowOrigin);
      }
      if (pathname === '/api/v1/console/options' && method === 'POST') {
        const body = await jsonBody(request);
        if (!body) return json(response, 400, { error: 'Bad request.' }, allowOrigin);
        const next = displayOptions({ ...state.settings, ...body });
        state.settings = { ...state.settings, ...next };
        await writeState(stateFile, state);
        collector.display = displayOptions({ ...state.settings, ...pluginSettings });
        return json(response, 200, { display: collector.display }, allowOrigin);
      }
      return json(response, 404, { error: 'Not found.' }, allowOrigin);
    }

    if (pathname === '/api/v1/overview' && method === 'GET') {
      if (!authorized(request)) return json(response, 401, { error: 'Unauthorized' });
      return json(response, 200, collector.overview());
    }

    if (pathname === '/api/v1/session' && method === 'POST') {
      const body = await jsonBody(request);
      if (!body || typeof body.code !== 'string') return json(response, 400, { error: 'Bad request.' });
      const key = `${request.socket?.remoteAddress || 'unknown'}|${body.code}`;
      const attempts = sessions.get(key) || { count: 0, until: 0 };
      if (attempts.until > Date.now()) {
        return json(response, 429, { error: 'Too many attempts. Try again later.' });
      }
      if (body.code !== state.pairing.code) {
        attempts.count += 1;
        if (attempts.count >= 10) {
          attempts.until = Date.now() + 5 * 60 * 1000;
          attempts.count = 0;
        }
        sessions.set(key, attempts);
        return json(response, 403, { error: 'That pairing code is not valid.' });
      }
      sessions.delete(key);
      rotatePairing(state);
      notePairing(state, request.socket?.remoteAddress || 'unknown');
      await writeState(stateFile, state);
      return json(response, 200, { token: state.token, baseURL: serviceURL() });
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
        return response.end(body.replace('const DEFAULT_PORT = 3498;', `const DEFAULT_PORT = ${port};`));
      } catch {
        return text(response, 404, 'Not found');
      }
    }

    if (pathname.startsWith('/p/') && method === 'GET') {
      return servePairPage(response, decodeURIComponent(pathname.slice('/p/'.length)));
    }

    if (!local) {
      return json(response, 403, { error: 'This page is only opened on the computer of the service.' });
    }

    if ((pathname === '/' || pathname === '/index.html') && method === 'GET') {
      // The page carries the read-only token. Only a navigation may read it,
      // so a page on another site cannot fetch it and take the token.
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
      body = body.replace('__SERVICE_TOKEN__', state.token);
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
      return serveUi(response, 'app.js', 'text/javascript; charset=utf-8', port);
    }
    if (pathname === '/style.css' && method === 'GET') {
      return serveUi(response, 'style.css', 'text/css; charset=utf-8', port);
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

  const makeServer = () =>
    createServer((request, response) => {
      handle(request, response).catch((error) => {
        if (!response.headersSent) json(response, 500, { error: error.message });
        else response.end();
      });
    });

  // The window opens the page as soon as the plugin is loaded, so the service
  // has to be listening before anything slow happens.
  const server = makeServer();
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
      shared: true,
      async close() {},
    };
  }

  const tailnetListener = makeServer();
  const timers = [];

  const background = async () => {
    if (closed) return;
    tailnet = await detect();
    if (closed) return;
    await syncForward();
    if (closed) return;
    if (options.listenTailnet !== false && tailnet.tailnetIP && !(await forwardOwned())) {
      await new Promise((resolve) => {
        tailnetListener.once('error', () => resolve());
        tailnetListener.listen(port, tailnet.tailnetIP, resolve);
      }).catch(() => {});
    }
  };
  void background();

  timers.push(
    setInterval(() => {
      void collector.refresh();
    }, 60_000),
  );

  timers.push(
    setInterval(() => {
      void (async () => {
        if (closed) return;
        tailnet = await detect();
        if (closed) return;
        await syncForward();
      })();
    }, 60_000),
  );

  return {
    port,
    async close() {
      closed = true;
      for (const timer of timers) clearInterval(timer);
      await removeForward(port);
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => tailnetListener.close(resolve));
    },
  };
}
