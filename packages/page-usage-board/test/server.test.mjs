import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_KEY = 'test-page-key';
let tmp;
let child;
let port;
let publicChild;
let publicPort;

function start(extra = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'usage-board-'));
  writeFileSync(path.join(dir, 'usage.jsonl'), '');
  const c = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    env: {
      ...process.env,
      PORT: '0',
      HOST: '127.0.0.1',
      PAGE_KEY: TEST_KEY,
      PAGE_KEY_FILE: path.join(dir, 'page-key'),
      USAGE_JSONL: path.join(dir, 'usage.jsonl'),
      DATA_DIR: path.join(dir, 'data'),
      GATEWAY: 'http://127.0.0.1:9',
      LOGOS: '0',
      ATTRIBUTION: 'local',
      MAGPIE_PROVIDERS: path.join(dir, 'no-providers.json'),
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const captured = { out: '' }; // 子进程完整 stdout+stderr，供启动日志断言
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
    c.stdout.on('data', (d) => {
      captured.out += d.toString();
      const m = captured.out.match(/listening on http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    c.stderr.on('data', (d) => { captured.out += d.toString(); });
    c.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${captured.out}`)); });
  });
  return { c, dir, ready, captured };
}

function request(atPort, pathname, { headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1',
      port: atPort,
      path: pathname,
      method,
      headers: { Host: `127.0.0.1:${atPort}`, ...headers },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

async function waitFor(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

let mainLog;
before(async () => {
  const s = start({ MAGPIE_ADDR: '0.0.0.0:3425' }); // 主测试服务器 = 插件模式（匿名注入页面是插件模式语义）
  child = s.c;
  tmp = s.dir;
  mainLog = s.captured;
  port = await s.ready;
});

after(() => {
  child?.kill();
  publicChild?.kill();
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('rejects a foreign Host header (DNS rebinding)', async () => {
  const r = await request(port, '/api/ping', { headers: { Host: 'evil.example' } });
  assert.equal(r.status, 403);
});

test('accepts a loopback Host with a mapped port (docker publish / tunnel)', async () => {
  // 回环名不看端口：Docker 发布口(3456)与容器监听口(3455)必然不同，rebinding 威胁在域名
  const r = await request(port, '/api/ping', { headers: { Host: `127.0.0.1:${port + 1}` } });
  assert.equal(r.status, 200);
});

test('rejects a non-loopback Host with the wrong port', async () => {
  const lan = Object.values(os.networkInterfaces()).flat()
    .find((a) => a && !a.internal && a.family === 'IPv4' && a.address);
  if (!lan) return; // 无局域网地址的环境（部分 CI 容器）跳过端口分支
  const r = await request(port, '/api/ping', { headers: { Host: `${lan}:${port + 1}` } });
  assert.equal(r.status, 403);
});

test('a malformed request target is answered 400 and the process survives', async () => {
  // GET // 让 new URL 抛 Invalid URL：必须拿到 4xx，且进程不退出（P0 回归测试）
  const r = await request(port, '//');
  assert.equal(r.status, 400);
  const h = await request(port, '/api/health');
  assert.equal(h.status, 200);
});

test('startup logs never contain the page key (loopback bind)', async () => {
  // 等 finish2 的 open 行写出后再断言（listening 行先到，open 行同 tick 跟随）
  await waitFor(() => mainLog.out.includes('[magpie-usage] open '));
  assert.doesNotMatch(mainLog.out, /\?key=/);
  assert.ok(!mainLog.out.includes(TEST_KEY), 'startup log leaked the page key');
});

test('instance fingerprint stays anonymous', async () => {
  const r = await request(port, '/api/ping');
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { service: 'magpie-usage', ok: true });
});

test('API needs the token', async () => {
  const r = await request(port, '/api/overview');
  assert.equal(r.status, 401);
});

test('API accepts the token from the query string', async () => {
  // Gateway is intentionally unreachable: passing auth yields 200 with local data + a
  // visible note (the gateway failure must not take the local aggregation down with it).
  // A rejected token would be 401 instead.
  const r = await request(port, `/api/overview?key=${TEST_KEY}`);
  assert.equal(r.status, 200);
  const d = JSON.parse(r.body);
  assert.equal(d.usage, null);
  assert.match(d.note, /用量接口/);
});

test('API accepts the token from the cookie', async () => {
  const r = await request(port, '/api/overview', { headers: { Cookie: `dk=${TEST_KEY}` } });
  assert.equal(r.status, 200);
  const d = JSON.parse(r.body);
  assert.equal(d.detail.error, undefined); // ENOENT（空日志）= 空态，不是读取失败
});

test('the loopback page serves without a URL token and injects one', async () => {
  const r = await request(port, '/');
  assert.equal(r.status, 200);
  assert.match(r.body, /window\.__KEY__=/);
  assert.match(r.body, new RegExp(`window\.__KEY__="${TEST_KEY}"`));
  assert.match(r.body, /window\.__DATA__=/);
  assert.equal(r.headers.location, undefined);
});

test('a cross-origin fetch of the page is refused', async () => {
  const r = await request(port, '/', { headers: { Origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

test('attribution falls back to the local log when no remote is configured', async () => {
  const r = await request(port, `/api/attribution?period=7d&key=${TEST_KEY}`);
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.source, 'local');
  assert.equal(j.totals.calls, 0);
});

test('the tokenized page serves inlined data and a CSP', async () => {
  const r = await request(port, `/?key=${TEST_KEY}`);
  assert.equal(r.status, 200);
  assert.match(r.body, /window\.__DATA__=/);
  assert.match(String(r.headers['content-security-policy']), /default-src 'self'/);
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
});

test('path traversal stays inside static/', async () => {
  for (const p of ['/static/../../server.mjs', '/..%2fserver.mjs', '/%2e%2e/server.mjs']) {
    const r = await request(port, p);
    assert.equal(r.status, 404, p);
    assert.notEqual(r.body, readFileSync(path.join(root, 'server.mjs'), 'utf8'));
  }
});

test('a public bind never serves the board without the token', async () => {
  const s = start({ HOST: '0.0.0.0', ALLOWED_HOSTS: 'dash.example' });
  publicChild = s.c;
  publicPort = await s.ready;
  // The proxy-style Host (with :443) is allowed by the explicit allowlist...
  const ping = await request(publicPort, '/api/ping', { headers: { Host: 'dash.example:443' } });
  assert.equal(ping.status, 200);
  // ...but an anonymous page request must not be 302'd to the key.
  const page = await request(publicPort, '/', { headers: { Host: 'dash.example:443' } });
  assert.equal(page.status, 401);
  assert.doesNotMatch(String(page.headers.location || ''), new RegExp(TEST_KEY));
});

test('HOST=:: is a wildcard bind, never treated as loopback (P0 regression)', async () => {
  // '::' listens on all interfaces (dual-stack); treating it as loopback handed the
  // key-injected page to anonymous visitors. It must behave like 0.0.0.0.
  const s = start({ HOST: '::', ALLOWED_HOSTS: 'dash.example' });
  try {
    const port = await s.ready;
    const page = await request(port, '/', { headers: { Host: 'dash.example:443' } });
    assert.equal(page.status, 401);
    assert.doesNotMatch(String(page.headers.location || ''), new RegExp(TEST_KEY));
    assert.equal(String(page.body || '').includes('__KEY__'), false);
  } finally {
    s.c.kill();
  }
});

test('loopback bind with a public ALLOWED_HOSTS still gates the page (P1 regression)', async () => {
  // A reverse proxy forwards the public Host name to a loopback-bound service; the
  // anonymous page gate must not open just because the BIND address is loopback.
  const s = start({ HOST: '127.0.0.1', ALLOWED_HOSTS: 'dash.example.com' });
  try {
    const port = await s.ready;
    const viaProxyHost = await request(port, '/', { headers: { Host: 'dash.example.com' } });
    assert.equal(viaProxyHost.status, 401);
    assert.equal(String(viaProxyHost.body || '').includes('__KEY__'), false);
  } finally {
    s.c.kill();
  }
});

test('index.mjs: importing has no side effects, server() starts and awaits listen', () => {
  // The community import-check imports this file for inspection; a module-level
  // startServer would grab a port and write config during that check.
  const code = `
    import('./index.mjs').then(async (m) => {
      await new Promise((r) => setTimeout(r, 1000));
      try { await fetch('http://127.0.0.1:3499/api/health'); console.error('FAIL: import started the service'); process.exit(1); } catch {}
      await m.default.server();
      const r = await fetch('http://127.0.0.1:3499/api/health');
      if (r.status !== 200) { console.error('FAIL: server() did not start the service'); process.exit(1); }
      console.log('LIFECYCLE-OK');
      process.exit(0);
    }).catch((e) => { console.error('FAIL', e && e.message); process.exit(1); });
  `;
  const r = spawnSync(process.execPath, ['-e', code], {
    env: {
      ...process.env,
      PORT: '3499',
      PAGE_KEY: TEST_KEY,
      PAGE_KEY_FILE: path.join(os.tmpdir(), 'usage-board-lifecycle-key'),
      USAGE_JSONL: path.join(os.tmpdir(), 'usage-board-lc.jsonl'),
      DATA_DIR: path.join(os.tmpdir(), 'usage-board-lc-data'),
      LOGOS: '0',
      ATTRIBUTION: 'local',
      MAGPIE_PROVIDERS: path.join(os.tmpdir(), 'usage-board-lc-np.json'),
    },
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(r.status, 0, `child exit ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /LIFECYCLE-OK/);
});

test('plugin mode waits for a dying previous instance on the base port', async () => {
  // When magpie restarts the plugin host, the previous generation lingers on the base
  // port briefly (answers probes, then exits). The child must wait for it to release
  // the port and bind it itself — not "reuse" the dying instance (which 502s the page).
  const occupier = net.createServer(() => {});
  const occupied = await new Promise((resolve) => {
    occupier.once('error', () => resolve(false)); // base port busy (e.g. the live board) — still a valid scenario
    occupier.listen(3455, '127.0.0.1', () => resolve(true));
  });
  const code = `
    import('./index.mjs').then(async (m) => {
      await m.default.server();
      const r = await fetch('http://127.0.0.1:3455/api/health');
      if (r.status !== 200) { console.error('FAIL: health ' + r.status); process.exit(1); }
      console.log('BOUND-AFTER-WAIT');
      process.exit(0);
    }).catch((e) => { console.error('FAIL', e && e.message); process.exit(1); });
  `;
  const child = spawn(process.execPath, [path.join(root, 'index.mjs')], {
    env: {
      ...process.env,
      MAGPIE_ADDR: '0.0.0.0:3425',
      PAGE_KEY: TEST_KEY,
      PAGE_KEY_FILE: path.join(os.tmpdir(), 'usage-board-zombie-key'),
      USAGE_JSONL: path.join(os.tmpdir(), 'usage-board-zombie.jsonl'),
      DATA_DIR: path.join(os.tmpdir(), 'usage-board-zombie-data'),
      LOGOS: '0',
      ATTRIBUTION: 'local',
      MAGPIE_PROVIDERS: path.join(os.tmpdir(), 'usage-board-zombie-np.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  if (occupied) setTimeout(() => occupier.close(() => {}), 1200); // 1.2s 后释放端口
  const exit = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ code: null }), 30000);
    child.once('close', (c) => { clearTimeout(t); resolve({ code: c }); }); // close = exit + stdio 刷完，避免漏捕最后的日志
  });
  if (occupied) occupier.close(() => {});
  assert.equal(exit.code, 0, `child exit ${exit.code}: ${out.slice(0, 400)}`);
  // 竞态窗口的正确结局：端口最终有服务——等到了就自己绑定，确认前代还活着就复用它
  assert.match(out, /listening on http|— reusing it/);
});

test('standalone with PAGE_KEY: a Host-rewriting proxy cannot open the page anonymously', async () => {
  // nginx's default proxy_set_header Host $proxy_host rewrites Host to 127.0.0.1:<port> —
  // standalone deployments must still require the token (only plugin mode trusts the host).
  const s = start({ HOST: '127.0.0.1' });
  try {
    const port = await s.ready;
    const page = await request(port, '/', { headers: { Host: '127.0.0.1:' + port } });
    assert.equal(page.status, 401);
    assert.equal(String(page.body || '').includes('__KEY__'), false);
    const withKey = await request(port, '/?key=' + TEST_KEY, { headers: { Host: '127.0.0.1:' + port } });
    assert.equal(withKey.status, 200);
  } finally {
    s.c.kill();
  }
});

test('plugin mode keeps the anonymous injected page on loopback', async () => {
  const s = start({ HOST: '127.0.0.1', MAGPIE_ADDR: '0.0.0.0:3425' });
  try {
    const port = await s.ready;
    const page = await request(port, '/', { headers: { Host: `127.0.0.1:${port}` } });
    assert.equal(page.status, 200);
    assert.match(String(page.body), /__KEY__/);
  } finally {
    s.c.kill();
  }
});

test('the dashboard asks the local service for attribution', () => {
  const html = readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
  assert.match(html, /api\/attribution\?period=/);
  assert.doesNotMatch(html, /remote\.js/);
  assert.doesNotMatch(html, /MY_REMOTE/);
});

test('registry draft summary matches package.json verbatim (three-text rule)', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const doc = readFileSync(path.join(root, 'docs', 'community-submission.md'), 'utf8');
  const block = doc.match(/```json\n([\s\S]*?)```/);
  assert.ok(block, 'registry json block present in community-submission.md');
  const reg = JSON.parse(block[1]);
  assert.equal(reg.package, pkg.name);
  assert.equal(reg.name, 'Usage Board');
  assert.equal(reg.summary.en, pkg.magpie.summary.en);
  assert.equal(reg.summary.zh, pkg.magpie.summary.zh);
});

test('the lead page has no inline scripts and no key', () => {
  const html = readFileSync(path.join(root, 'page', 'index.html'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of html.match(/<script[^>]*>/gi) || []) {
    assert.match(tag, /src=/i);
  }
  assert.doesNotMatch(html, /[?&]key=/i);
  assert.doesNotMatch(html, /https?:\/\/(?!127\.0\.0\.1:3455)/i);
  assert.doesNotMatch(html, /fetch\(/i); // the sandboxed lead page fetches nothing
  assert.match(html, /_magpie\/bridge\.js/);
  assert.match(html, /boot\.js/);
});

test('boot uses magpie.service when present and falls back to loopback', () => {
  const js = readFileSync(path.join(root, 'page', 'boot.js'), 'utf8');
  assert.match(js, /magpie\?\.service/);
  assert.match(js, /127\.0\.0\.1:3455/);
});

test('package metadata matches the community page spec', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@magpie-community/page-usage-board');
  assert.equal(pkg.license, 'MIT');
  assert.ok(pkg.files.includes('LICENSE'));
  assert.ok(pkg.scripts.test);
  assert.deepEqual(pkg.magpie.permissions, []);
  assert.equal(pkg.magpie.page.file, 'page/index.html');
  assert.equal(pkg.magpie.page.service.port, 3455);
  assert.ok(pkg.magpie.summary.en && pkg.magpie.summary.zh);
  assert.ok(pkg.magpie.page.titles.en && pkg.magpie.page.titles.zh);
});