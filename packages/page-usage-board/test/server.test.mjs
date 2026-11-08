import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 所有路径都从本测试文件定位（root bun test 从仓库根跑时 cwd 不同也能工作）；
// 子进程一律 -e + 绝对 URL 导入；端口一律临时申请，不用固定口。
// spawn 目标：本测试在 bun test 下也会被跑（社区根仓库 bun test 扫全部包），
// 子进程一律 spawn process.execPath（bun test 下就是 bun——magpie 宿主也正是用 bun 跑
// server.mjs 的；node --test 下就是 node）。绝不按名字 spawn "node"：根仓库 bun test
// 所有包共用一个进程，某些包的测试会清空 process.env.PATH（gcp-ai），按名字找可执行
// 文件会 "Executable not found"。内联脚本的 -e 子进程改为写临时 .mjs 文件——bun 的 -e
// 兼容性不承诺，文件形式两种运行时行为一致。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = process.execPath;
const SERVER_URL = pathToFileURL(path.join(root, 'server.mjs')).href;
const INDEX_URL = pathToFileURL(path.join(root, 'index.mjs')).href;
const TEST_KEY = 'test-page-key';
let tmp;
let child;
let port;
let publicChild;
let publicPort;

const baseEnv = (dir = os.tmpdir()) => ({
  ...process.env,
  PAGE_KEY: TEST_KEY,
  USAGE_JSONL: path.join(dir, 'usage.jsonl'),
  GATEWAY: 'http://127.0.0.1:9',
  ATTRIBUTION: 'local',
  MAGPIE_PROVIDERS: path.join(dir, 'no-providers.json'),
  MAGPIE_PROVIDERS_FILE: path.join(dir, 'no-plugin-providers.json'),
});

// 内联脚本子进程：代码写进临时 .mjs 文件再跑（跨 node/bun 一致），结束即清理。
// 返回 { code, out }；killMs 到点强杀防止挂死 runner。
function spawnChild(code, env, killMs = 25000) {
  return new Promise((resolve) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'usage-board-child-'));
    const file = path.join(dir, 'child.mjs');
    writeFileSync(file, code);
    const c = spawn(RUNTIME, [file], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => c.kill('SIGKILL'), killMs);
    c.once('close', (code2) => {
      clearTimeout(t);
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      resolve({ code: code2, out });
    });
  });
}

function start(extra = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'usage-board-'));
  writeFileSync(path.join(dir, 'usage.jsonl'), '');
  const c = spawn(RUNTIME, [path.join(root, 'server.mjs')], {
    env: { ...baseEnv(dir), HOST: '127.0.0.1', PORT: '0', ...extra },
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

// 申请一个当前空闲的端口：bind 0 → 记下端口 → 立刻关闭（测试进程间传递用）
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

let mainLog;
before(async () => {
  const s = start();
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

test('accepts a loopback Host with a mapped port (reverse proxy / tunnel)', async () => {
  // 回环名不看端口：反代/隧道发布口与服务监听口可以不同，rebinding 威胁在域名
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

test('startup logs never contain the page key and never offer ?key=', async () => {
  // 等 finish2 的 open 行写出后再断言（listening 行先到，open 行同 tick 跟随）
  await waitFor(() => mainLog.out.includes('[magpie-usage] open '));
  assert.doesNotMatch(mainLog.out, /\?key=/);
  assert.ok(!mainLog.out.includes(TEST_KEY), 'startup log leaked the page key');
});

test('instance fingerprint stays anonymous but carries the build id', async () => {
  const r = await request(port, '/api/ping');
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.service, 'magpie-usage-board');
  assert.equal(j.ok, true);
  assert.match(j.build, /^[0-9a-f]{16}$/);
  assert.ok(j.version);
});

test('API needs the token', async () => {
  const r = await request(port, '/api/overview');
  assert.equal(r.status, 401);
});

test('the key never works from a URL (?key= is gone)', async () => {
  // key 一旦进 URL 就会落进代理日志/浏览器历史——查询串鉴权必须彻底无效
  const r = await request(port, `/api/overview?key=${TEST_KEY}`);
  assert.equal(r.status, 401);
});

test('the key never works from a cookie', async () => {
  const r = await request(port, '/api/overview', { headers: { Cookie: `dk=${TEST_KEY}` } });
  assert.equal(r.status, 401);
});

test('API accepts the token from the x-dash-key header', async () => {
  // Gateway is intentionally unreachable: passing auth yields 200 with local data + a
  // visible note (the gateway failure must not take the local aggregation down with it).
  const r = await request(port, '/api/overview', { headers: { 'x-dash-key': TEST_KEY } });
  assert.equal(r.status, 200);
  const d = JSON.parse(r.body);
  assert.equal(d.usage, null);
  assert.match(d.note, /usage API/);
  assert.equal(d.detail.error, undefined); // ENOENT（空日志）= 空态，不是读取失败
});

test('the loopback page serves without a URL token and injects one', async () => {
  const r = await request(port, '/');
  assert.equal(r.status, 200);
  assert.match(r.body, /window\.__KEY__=/);
  assert.match(r.body, new RegExp(`window\\.__KEY__="${TEST_KEY}"`));
  assert.match(r.body, /window\.__DATA__=/);
  assert.equal(r.headers.location, undefined);
});

test('the page CSP lists the loopback explicitly and no third-party hosts', async () => {
  const r = await request(port, '/');
  assert.equal(r.status, 200);
  const csp = String(r.headers['content-security-policy']);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, new RegExp(`connect-src 'self' http://127\\.0\\.0\\.1:${port}`));
  // frame-ancestors 显式声明（* = 被宿主嵌入是设计意图；宿主 origin 桌面/web 不固定）
  assert.match(csp, /frame-ancestors/);
  assert.doesNotMatch(csp, /cloudflareinsights/);
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
});

test('a sandboxed frame (Origin: null) may fetch the page', async () => {
  const r = await request(port, '/', { headers: { Origin: 'null' } });
  assert.equal(r.status, 200);
});

test('a cross-origin fetch of the page is refused', async () => {
  const r = await request(port, '/', { headers: { Origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

test('CORS allows only the exact bound port, not any localhost port', async () => {
  const r = await request(port, '/api/attribution', { headers: { Origin: `http://127.0.0.1:${port + 1}` } });
  assert.equal(r.status, 403);
  const ok = await request(port, '/api/attribution', { headers: { Origin: `http://127.0.0.1:${port}` } });
  assert.equal(ok.status, 401); // CORS 放行、鉴权照拦——链路各管各的
});

test('attribution stays local unless the user opts in', { timeout: 30000 }, async () => {
  // 维护者复审点：护栏必须真的能拦住默认值被改坏——这里**不能**继承 baseEnv 的
  // ATTRIBUTION:'local'，否则有人把服务端默认改成 remote 时本测试仍绿。
  // extra 里显式设 undefined → Node spawn 会把它从子进程环境里省掉，服务端走默认值；
  // REMOTE_BASE/KEY 虽然没配，但默认值若是 remote，remoteSources() 就不再为空，source 会变。
  const s = start({ ATTRIBUTION: undefined, REMOTE_BASE: 'https://remote.example', REMOTE_KEY: 'k' });
  try {
    const p = await s.ready;
    const r = await request(p, '/api/attribution?period=7d', { headers: { 'x-dash-key': TEST_KEY } });
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body);
    assert.equal(j.source, 'local');
    assert.equal(j.totals.calls, 0);
  } finally {
    s.c.kill();
    try { rmSync(s.dir, { recursive: true, force: true }); } catch {}
  }
});

test('the gateway follows options, env and MAGPIE_ADDR, not a hard-coded port', { timeout: 30000 }, async () => {
  // 维护者实测：宿主把 MAGPIE_ADDR 指到（可能被改过端口的）真实网关——看板必须问它，
  // 而不是写死的 3425。解析链：options.gateway → GATEWAY → MAGPIE_GATEWAY →
  // MAGPIE_ADDR → 3425。fake 网关必须在整个测试的 finally 里关掉：断言一失败就
  // close，否则它的监听 socket 会把 node --test 的进程挂死。
  const fake = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ calls: 123, tokens: 456, cost: 7.89 }));
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const gwPort = fake.address().port;
  try {
    // 1) MAGPIE_ADDR 单独生效（宿主场景）
    const s1 = start({
      MAGPIE_ADDR: `0.0.0.0:${gwPort}`, // 宿主可能写成通配地址，服务端要归一化成回环
      GATEWAY: undefined,
      MAGPIE_GATEWAY: undefined,
    });
    try {
      const p1 = await s1.ready;
      assert.match(s1.captured.out, new RegExp(`gateway=http://127\\.0\\.0\\.1:${gwPort}\\b`));
      const r1 = await request(p1, '/api/overview', { headers: { 'x-dash-key': TEST_KEY } });
      assert.equal(r1.status, 200);
      const j1 = JSON.parse(r1.body);
      assert.equal(j1.usage.calls, 123); // 请求打到了 MAGPIE_ADDR 指向的网关
    } finally {
      s1.c.kill();
      try { rmSync(s1.dir, { recursive: true, force: true }); } catch {}
    }
    // 2) 显式 GATEWAY 优先于 MAGPIE_ADDR
    const s2 = start({ MAGPIE_ADDR: '127.0.0.1:1' });
    try {
      await s2.ready;
      assert.match(s2.captured.out, /gateway=http:\/\/127\.0\.0\.1:9\b/); // baseEnv 的 GATEWAY 赢了
      assert.doesNotMatch(s2.captured.out, /gateway=http:\/\/127\.0\.0\.1:1\b/);
    } finally {
      s2.c.kill();
      try { rmSync(s2.dir, { recursive: true, force: true }); } catch {}
    }
  } finally {
    fake.close(() => {});
  }
});

test('[::1] in MAGPIE_ADDR stays IPv6 loopback, never 127.0.0.1', { timeout: 30000 }, async () => {
  // 只有 unspecified（0.0.0.0/[::]）才映射回环；[::1] 是明确的 IPv6 回环，监听在 [::1]
  // 的网关通常没有监听 127.0.0.1——改写会把请求打到空处（维护者复审实测）。
  let hits = 0;
  const fake6 = http.createServer((req, res) => {
    hits++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ calls: 7, tokens: 8, cost: 9 }));
  });
  const listening = await new Promise((resolve) => {
    fake6.once('error', () => resolve(false)); // 无 IPv6 的环境（部分 CI 容器）跳过
    fake6.listen(0, '::1', () => resolve(true));
  });
  if (!listening) return;
  const gwPort = fake6.address().port;
  // 先探测本机的 IPv6 回环是否真的可连：某些平台（Windows 的 undici）监听 ::1 成功、
  // 但 fetch http://[::1] 会超时——那种环境只验证解析结果，不做端到端请求断言。
  let ipv6Reachable = true;
  try {
    await fetch(`http://[::1]:${gwPort}/probe`, { signal: AbortSignal.timeout(2000) });
  } catch {
    ipv6Reachable = false;
  }
  hits = 0; // 探测命中了不计入
  const s = start({ MAGPIE_ADDR: `[::1]:${gwPort}`, GATEWAY: undefined, MAGPIE_GATEWAY: undefined });
  try {
    const p = await s.ready;
    assert.match(s.captured.out, new RegExp(`gateway=http://\\[::1\\]:${gwPort}\\b`));
    assert.doesNotMatch(s.captured.out, new RegExp(`gateway=http://127\\.0\\.0\\.1:${gwPort}\\b`));
    if (ipv6Reachable) {
      const r = await request(p, '/api/overview', { headers: { 'x-dash-key': TEST_KEY } });
      assert.equal(r.status, 200);
      assert.equal(JSON.parse(r.body).usage.calls, 7); // 真的打到了 ::1 上的网关
      assert.ok(hits > 0, 'fake IPv6 gateway received no requests');
    }
  } finally {
    s.c.kill();
    try { rmSync(s.dir, { recursive: true, force: true }); } catch {}
    fake6.close(() => {});
  }
});

test('config dir: the host cwd carrying magpie markers wins (portable installs)', { timeout: 30000 }, async () => {
  // magpie 宿主以数据目录为 cwd 启动服务（bunCommand(..., settings.Dir(), ...)）——
  // 便携安装因此不需要任何环境变量。不设 USAGE_JSONL，服务应通过 cwd 探测找到它。
  // 路径比较必须用 realpathSync：macOS 的 os.tmpdir() 是 /var/folders/…，而 /var 是指向
  // /private/var 的符号链接——子进程的 process.cwd() 与日志里的路径都是解析后的真实
  // 路径，拿未解析的 dataDir 拼字符串比会假红（维护者复审在 macOS 实测）。
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'usage-board-cwd-'));
  writeFileSync(path.join(dataDir, 'usage.jsonl'), '');
  const realDir = realpathSync(dataDir);
  const c = spawn(RUNTIME, [path.join(root, 'server.mjs')], {
    cwd: realDir,
    env: {
      ...process.env,
      PAGE_KEY: TEST_KEY,
      GATEWAY: 'http://127.0.0.1:9',
      ATTRIBUTION: 'local',
      MAGPIE_PROVIDERS: path.join(realDir, 'no-providers.json'),
      MAGPIE_PROVIDERS_FILE: path.join(realDir, 'no-plugin-providers.json'),
      HOST: '127.0.0.1',
      PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { out += d; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 10000);
    c.stdout.on('data', (d) => { if (/listening/.test(d.toString())) { clearTimeout(t); resolve(); } });
    c.once('exit', (code) => { clearTimeout(t); reject(new Error('exited ' + code + ': ' + out)); });
  });
  try {
    assert.ok(
      out.includes('jsonl=' + path.join(realDir, 'usage.jsonl') + '(ok)'),
      'usage.jsonl resolved from cwd: ' + out.slice(0, 300),
    );
  } finally {
    c.kill();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
});

test('startServer({port: 0}) binds an ephemeral port, not the default', { timeout: 30000 }, async () => {
  const r = await spawnChild(`
    import(${JSON.stringify(SERVER_URL)}).then(async (m) => {
      try {
        const bound = await m.startServer({ port: 0 });
        if (bound === 3455 || bound === 0) throw new Error('expected an ephemeral port, got ' + bound);
        const r = await fetch('http://127.0.0.1:' + bound + '/api/health');
        if (r.status !== 200) throw new Error('health ' + r.status);
        console.log('EPHEMERAL-OK');
        process.exit(0);
      } catch (e) { console.error('FAIL ' + (e && e.message || e)); process.exit(1); }
    });
  `, { ...baseEnv(), HOST: '127.0.0.1' });
  assert.equal(r.code, 0, `child exit ${r.code}: ${r.out.slice(0, 300)}`);
  assert.match(r.out, /EPHEMERAL-OK/);
});

test('path traversal stays inside static/', async () => {
  for (const p of ['/static/../../server.mjs', '/..%2fserver.mjs', '/%2e%2e/server.mjs']) {
    const r = await request(port, p);
    assert.equal(r.status, 404, p);
    assert.notEqual(r.body, readFileSync(path.join(root, 'server.mjs'), 'utf8'));
  }
});

test('brand logos come from magpie, with zero network fetches', async () => {
  // plugin-providers.json 里的 data URI 注入页面；https 图标一律不抓取（隐私红线）
  const dir = mkdtempSync(path.join(os.tmpdir(), 'usage-board-logos-'));
  const icon = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64');
  writeFileSync(path.join(dir, 'plugin-providers.json'), JSON.stringify({
    0: { id: 'TestProv', icon },
    1: { id: 'remote-brand', icon: 'https://cdn.example.com/favicon.svg' },
  }));
  const s = start({ USAGE_JSONL: path.join(dir, 'usage.jsonl'), MAGPIE_PROVIDERS_FILE: path.join(dir, 'plugin-providers.json') });
  try {
    const p = await s.ready;
    const page = await request(p, '/');
    assert.equal(page.status, 200);
    assert.ok(page.body.includes(icon), 'data-URI logo injected');
    assert.doesNotMatch(page.body, /cdn\.example\.com/);
    assert.match(s.captured.out, /logos: 1 brands/);
  } finally {
    s.c.kill();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('a public bind never serves the board page at all', async () => {
  const s = start({ HOST: '0.0.0.0', ALLOWED_HOSTS: 'dash.example' });
  publicChild = s.c;
  publicPort = await s.ready;
  // The proxy-style Host (with :443) is allowed by the explicit allowlist for APIs...
  const ping = await request(publicPort, '/api/ping', { headers: { Host: 'dash.example:443' } });
  assert.equal(ping.status, 200);
  // ...but the page is loopback-only: a remote visitor has no auth channel (?key= is gone).
  const page = await request(publicPort, '/', { headers: { Host: 'dash.example:443' } });
  assert.equal(page.status, 403);
  assert.equal(String(page.body || '').includes('__KEY__'), false);
});

test('HOST=:: is a wildcard bind, never treated as loopback (P0 regression)', async () => {
  // '::' listens on all interfaces (dual-stack); treating it as loopback handed the
  // key-injected page to anonymous visitors. It must behave like 0.0.0.0.
  const s = start({ HOST: '::', ALLOWED_HOSTS: 'dash.example' });
  try {
    const p = await s.ready;
    const page = await request(p, '/', { headers: { Host: 'dash.example:443' } });
    assert.equal(page.status, 403);
    assert.equal(String(page.body || '').includes('__KEY__'), false);
  } finally {
    s.c.kill();
  }
});

test('loopback bind with a public ALLOWED_HOSTS still gates the page (P1 regression)', async () => {
  // A reverse proxy forwards the public Host name to a loopback-bound service; the
  // page must answer loopback hosts only, never the proxied public name.
  const s = start({ HOST: '127.0.0.1', ALLOWED_HOSTS: 'dash.example.com' });
  try {
    const p = await s.ready;
    const viaProxyHost = await request(p, '/', { headers: { Host: 'dash.example.com' } });
    assert.equal(viaProxyHost.status, 403);
    assert.equal(String(viaProxyHost.body || '').includes('__KEY__'), false);
  } finally {
    s.c.kill();
  }
});

test('waits for a dying occupier on the target port, then binds it', async () => {
  // 宿主重启竞态：上一代濒死实例短暂占着口——新实例必须等它退出后自己绑定，
  // 而不是复用一个马上要死的实例（复用会让页面 502）。
  const p = await freePort();
  const occupier = net.createServer(() => {});
  await new Promise((resolve, reject) => { occupier.once('error', reject); occupier.listen(p, '127.0.0.1', resolve); });
  const code = `
    import(${JSON.stringify(SERVER_URL)}).then(async (m) => {
      try {
        const bound = await m.startServer();
        const r = await fetch('http://127.0.0.1:' + bound + '/api/health');
        if (r.status !== 200) throw new Error('health ' + r.status);
        console.log('BOUND-AFTER-WAIT');
        process.exit(0);
      } catch (e) { console.error('FAIL ' + (e && e.message || e)); process.exit(1); }
    });
  `;
  setTimeout(() => occupier.close(() => {}), 1200); // 1.2s 后释放端口（模拟濒死实例退出）
  const r = await spawnChild(code, { ...baseEnv(), HOST: '127.0.0.1', PORT: String(p) }, 20000);
  assert.equal(r.code, 0, `child exit ${r.code}: ${r.out.slice(0, 400)}`);
  assert.match(r.out, /BOUND-AFTER-WAIT/);
});

test('reuses a live instance of the same build, never a different one', { timeout: 30000 }, async () => {
  // 同构建 → 复用（resolve 端口、不重复绑定）；异构建/异种 → 明确报错，绝不把看板
  // 交给一个未知进程。复用判定只认 /api/ping 的 BUILD_ID。子进程必须异步 spawn：
  // spawnSync 会阻塞本进程事件循环，同进程里的 fake server 就无法应答探测了。
  // timeout：异构建分支要等服务端 8s deadline 才报错——超过 bun test 默认 5s（维护者复审点）。
  const code = `
    import(${JSON.stringify(SERVER_URL)}).then(async (m) => {
      try {
        const bound = await m.startServer();
        console.log('RESOLVED-' + bound);
        process.exit(0);
      } catch (e) { console.error('FAIL ' + (e && e.message || e)); process.exit(1); }
    });
  `;
  const p = await freePort();
  const first = start({ PORT: String(p) });
  try {
    await first.ready;
    const r = await spawnChild(code, { ...baseEnv(), HOST: '127.0.0.1', PORT: String(p) }, 20000);
    assert.equal(r.code, 0, `child exit ${r.code}: ${r.out.slice(0, 400)}`);
    assert.match(r.out, new RegExp(`RESOLVED-${p}`));
    // 异构建：伪装成同款服务但 build 不同 → 必须拒绝启动
    const p2 = await freePort();
    const fake = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ service: 'magpie-usage-board', ok: true, build: 'deadbeefdeadbeef', version: '9.9.9' }));
    });
    await new Promise((resolve) => fake.listen(p2, '127.0.0.1', resolve));
    const r2 = await spawnChild(code, { ...baseEnv(), HOST: '127.0.0.1', PORT: String(p2) }, 20000);
    fake.close(() => {});
    assert.notEqual(r2.code, 0, 'a foreign build must not be accepted');
    assert.match(r2.out, /held by another build/);
  } finally {
    first.c.kill();
    try { rmSync(first.dir, { recursive: true, force: true }); } catch {}
  }
});

test('index.mjs: importing has no side effects, server() starts and awaits listen', { timeout: 30000 }, async () => {
  // The community import-check imports this file for inspection; a module-level
  // startServer would grab a port and write config during that check. The child
  // picks its own free port, sets PORT, then verifies import ≠ start, server() = start.
  const code = `
    (async () => {
      const net = await import('node:net');
      const free = await new Promise((res) => {
        const s = new net.Server();
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
      });
      process.env.PORT = String(free);
      const m = await import(${JSON.stringify(INDEX_URL)});
      await new Promise((r) => setTimeout(r, 800));
      try { await fetch('http://127.0.0.1:' + free + '/api/health'); console.error('FAIL: import started the service'); process.exit(1); } catch {}
      const r0 = await m.default.server();
      if (!r0 || r0.port !== free) { console.error('FAIL: server() did not report the bound port: ' + JSON.stringify(r0)); process.exit(1); }
      const r = await fetch('http://127.0.0.1:' + free + '/api/health');
      if (r.status !== 200) { console.error('FAIL: server() did not start the service'); process.exit(1); }
      console.log('LIFECYCLE-OK');
      process.exit(0);
    })();
  `;
  const r = await spawnChild(code, baseEnv(), 20000);
  assert.equal(r.code, 0, `child exit ${r.code}: ${r.out.slice(0, 400)}`);
  assert.match(r.out, /LIFECYCLE-OK/);
});

test('the dashboard asks the local service for attribution', () => {
  const html = readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
  assert.match(html, /api\/attribution\?period=/);
  assert.doesNotMatch(html, /remote\.js/);
  assert.doesNotMatch(html, /cloudflareinsights/);
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
  for (const tag of html.match(/<script[^>]*>/gi) || []) {
    assert.match(tag, /src=/i);
  }
  assert.doesNotMatch(html, /[?&]key=/i);
  assert.doesNotMatch(html, /fetch\(/i); // the sandboxed lead page fetches nothing
  assert.match(html, /_magpie\/bridge\.js/);
  assert.match(html, /boot\.js/);
});

test('boot prefers magpie.service, reads the port and theme from the bridge', () => {
  const js = readFileSync(path.join(root, 'page', 'boot.js'), 'utf8');
  assert.match(js, /magpie\?\.service/);
  assert.match(js, /options\?\.get\?\.\(\)/);
  assert.match(js, /current\.dark/); // magpie 自己的深浅色 → ?theme= 传给看板
  assert.match(js, /theme/);
  assert.match(js, /3455/); // manifest 声明的默认口（fallback，不再有写死的第二个来源）
});

test('the board page ships both languages', () => {
  const html = readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
  assert.match(html, /navigator\.language/);
  assert.match(html, /\?lang=/);
  assert.match(html, /T\s*=\s*\{\s*zh:/);
  assert.match(html, /en:/);
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
  assert.equal(pkg.magpie.page.service.option, 'port');
  assert.equal(pkg.magpie.options.attribution, 'local'); // 远端归因必须 opt-in
  assert.ok(pkg.magpie.summary.en && pkg.magpie.summary.zh);
  assert.ok(pkg.magpie.page.titles.en && pkg.magpie.page.titles.zh);
});
