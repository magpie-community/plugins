#!/usr/bin/env node
// magpie 用量看板 — 零依赖，Node 22+/Bun 均可运行
// 环境变量：HOST(默认回环)、PORT(默认 3455，0=系统挑；被同构建占用则复用，异种占用则报错)、
//          GATEWAY(上游网关)、MAGPIE_KEY(网关 key，本地不需要)、USAGE_JSONL、
//          PAGE_KEY(脚本调 API 用的口令，不设则每次启动生成随机 token；页面 HTML 由服务端注入，
//          浏览器里永远不需要手输)、ALLOWED_HOSTS(反代域名白名单，逗号分隔)、
//          ATTRIBUTION(local|remote，默认 local：远端归因会把 provider key 发给远端 magpie，必须显式开启)、
//          REMOTE_CALLERS/REMOTE_PROVIDERS/MAGPIE_PROVIDERS/MAGPIE_PROVIDERS_FILE
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '127.0.0.1';
// 日志里对外展示的 host：监听 0.0.0.0/:: 这类地址时展示成 127.0.0.1，IPv6 补方括号
const URL_HOST = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : (HOST.includes(':') ? `[${HOST}]` : HOST);
// 回环绑定：看板页面只对回环开放（口令注入返回的 HTML，本机用户即所有者——与社区
// page-usage-tree 同一模型）。注意：'::' 与 0.0.0.0 同为通配监听（dual-stack），绝不能算回环。
const LOOPBACK_BIND = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
// magpie 的配置目录：与 usage.jsonl、plugin-providers.json、providers.json 的所在。
// 顺序照 magpie 自己的 appdir.Config()：宿主数据目录（便携安装）→ XDG → ~/.config/magpie。
// 便携/宿主场景靠 cwd 探测：magpie 的插件宿主以 settings.Dir() 为 cwd 启动服务
// （internal/plugin/host.go 的 bunCommand），desktop 用户无法为宿主设环境变量，
// 所以任何 MAGPIE_CONFIG_DIR 之类的 env 都救不了便携安装——cwd 是唯一可靠信号。
// MAGPIE_CONFIG_DIR 仍保留为显式覆盖（测试/特殊布局用；magpie 本身没有这个变量）。
function magpieConfigDir() {
  if (process.env.MAGPIE_CONFIG_DIR) return process.env.MAGPIE_CONFIG_DIR;
  try {
    const cwd = process.cwd();
    if (cwd !== ROOT && (existsSync(path.join(cwd, 'usage.jsonl')) || existsSync(path.join(cwd, 'plugins.json')) || existsSync(path.join(cwd, 'providers.json')))) return cwd;
  } catch {}
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, 'magpie');
  return path.join(os.homedir(), '.config', 'magpie');
}
const CONFIG_DIR = magpieConfigDir();
// 网关解析链（与 page-usage-tree 一致）：manifest options.gateway → GATEWAY →
// MAGPIE_GATEWAY → MAGPIE_ADDR（magpie 宿主总会设置，端口可被用户改过，不能写死）→ 3425。
// MAGPIE_ADDR 是 host:port。只有**未指定地址**（0.0.0.0 / [::]）才换成回环——那是
// 「绑所有网卡」的意思，等价于本机；而 [::1] 是明确的 IPv6 回环，监听在 [::1] 的网关
// 通常**没有**在 127.0.0.1 上监听，改写会把请求打到空处（与 magpie 自己的 hostAddr
// 语义一致：它也只处理 unspecified 地址）。
function gatewayCandidates(optionsGateway) {
  const out = [];
  const push = (v) => {
    const text = String(v || '').trim().replace(/\/+$/, '');
    if (text && /^https?:\/\//i.test(text) && !out.includes(text)) out.push(text);
  };
  push(optionsGateway);
  push(process.env.GATEWAY);
  push(process.env.MAGPIE_GATEWAY);
  const addr = process.env.MAGPIE_ADDR;
  if (addr) {
    // $1=地址 $2=冒号：换掉地址、保住端口分隔
    const text = String(addr).trim().replace(/^(0\.0\.0\.0|\[::\])(:|$)/, '127.0.0.1$2');
    // host:port 或 [v6]:port；URL 里的 IPv6 字面量必须带方括号
    if (/^(\[[0-9a-f:.]+\]|[\w.-]+):\d+$/.test(text)) push('http://' + text);
  }
  push('http://127.0.0.1:3425');
  return out;
}
// 实际生效的网关在 main() 里定稿（listen 前）；upstream() 按请求时值取用
let GATEWAY = 'http://127.0.0.1:3425';
const KEY = process.env.MAGPIE_KEY || '';
const USAGE_JSONL = process.env.USAGE_JSONL || path.join(CONFIG_DIR, 'usage.jsonl');
// 页面访问口令：未设 PAGE_KEY → 每次启动生成随机 token（页面 HTML 服务端注入，URL/日志/磁盘
// 都不落）；显式设置 → 脚本调 API 用（x-dash-key 头；?key= 已废除，key 不进 URL）。
let PAGE_KEY = '';
const PORT_BASE = 3455;
// manifest options（index.mjs 传入）→ 环境变量 → 内置默认，三级回退；startServer() 时定稿
const CFG = { port: null, attribution: null, remoteCallers: null, remoteProviders: null, gateway: null };
// 远端归因（opt-in）：开启后会把本机 magpie 配好的 remote provider key 发给远端 magpie
// 换逐条请求记录——必须用户显式选择，绝不默认。
let ATTRIBUTION_MODE = 'local';
// 本机直连/远端的口径：usage.jsonl 里这些 provider 线路前缀的流量记为「走远端」（其余为直连）。
// 默认只含 magpie 自己的线路名（非个人配置）；个人化口径用 REMOTE_PROVIDERS 覆盖。
let REMOTE_PROVIDERS = ['magpie-direct', 'magpie-cf', 'remote-magpie'];
let REMOTE_CALLERS = [];
// Host 校验：默认只认识回环名。反代或非回环部署时用 ALLOWED_HOSTS=域名1,域名2 显式放行。
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const STATIC_DIR = path.join(ROOT, 'static');
// 品牌 logo：magpie 自己维护的 plugin-providers.json（插件注册时上报的 id→data URI 图标）
// 与本机 icons/ 缓存（quotas.json、远端 provider 名下的 file: 图标）。零下载、零落盘：
// https 图标一律不抓取（避免向第三方 CDN 发请求）；远端 provider 的 id→图标名只在
// remote 归因模式下向远端 magpie 的 usage/requests 问一次，图标本体仍读本机缓存。
// 页面对没有图标的品牌用首字色块兜底。
const PROVIDERS_FILE = process.env.MAGPIE_PROVIDERS_FILE || '';
const MAGPIE_PROVIDERS = process.env.MAGPIE_PROVIDERS || path.join(CONFIG_DIR, 'providers.json');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

async function upstream(p) {
  // 瞬时网关挂起重试一次（上限 12s×2）：失败已可见化（note/红条），这里只为削掉偶发抖动
  let last;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(GATEWAY + p, {
        headers: KEY ? { Authorization: `Bearer ${KEY}` } : {},
        signal: AbortSignal.timeout(12000),
      });
      const body = await r.text();
      try { return { code: r.status, json: JSON.parse(body) }; }
      catch { return { code: r.status, json: { error: body.slice(0, 200) } }; }
    } catch (e) { last = e; }
    await new Promise((r2) => setTimeout(r2, 500 * (i + 1)));
  }
  return { code: 0, json: { error: String(last && last.message || last).slice(0, 200) } };
}

// usage.jsonl 聚合：按天×provider、7×24 热力、最近请求（60s 缓存）。
// 流式逐行读取：日志曾到 23MB，整读+全量解析把 RSS 放大 ~9 倍——现在峰值只保留聚合结果
async function* linesOf(path) {
  const stream = createReadStream(path, { encoding: 'utf8' });
  let buf = '';
  for await (const chunk of stream) {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line) yield line;
    }
  }
  if (buf) yield buf;
}
// echarts.min.js 的预压缩缓存（按 mtime 失效）：br ~172KB / gzip ~190KB，避免每次导航白拉 612KB
let echartsEnc = null;
function echartsEncoded(full) {
  const mtime = statSync(full).mtimeMs;
  if (!echartsEnc || echartsEnc.mtime !== mtime) {
    const raw = readFileSync(full);
    echartsEnc = { mtime, br: brotliCompressSync(raw), gz: gzipSync(raw, { level: 8 }) };
  }
  return echartsEnc;
}
let detailCache = null;
async function readDetail(days) {
  const cacheKey = days + ':' + Math.floor(Date.now() / 60000);
  if (detailCache && detailCache.key === cacheKey) return detailCache.data;
  const since = days > 0 ? Date.now() - days * 86400e3 : 0;
  const daily = new Map();
  const heat = new Array(7 * 24).fill(0);
  let recent = [];
  try {
    for await (const line of linesOf(USAGE_JSONL)) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    // magpie 自家探活行（kind:"model_list", source:"probe"）不是真实调用，过滤（2026-11-04，实测占 9.5%）
    if (r.kind === 'model_list' || r.source === 'probe') continue;
    const ts = r.t ? Date.parse(r.t) : NaN;
    if (!Number.isFinite(ts) || ts < since) continue;
    const day = typeof r.t === 'string' ? r.t.slice(0, 10) : '';
    if (!day) continue; // 脏行（t 非字符串）跳过本行，绝不静默清空整张图
    const prov = r.provider || 'unknown';
    let dp = daily.get(day); if (!dp) { dp = new Map(); daily.set(day, dp); }
    let a = dp.get(prov);
    if (!a) { a = { calls: 0, errors: 0, inp: 0, out: 0, cache: 0, reasoning: 0, ttft: 0, timed: 0 }; dp.set(prov, a); }
    a.calls++; if (r.status !== 200) a.errors++;
    a.inp += r.in || 0; a.out += r.out || 0; a.cache += r.cache_read || 0; a.reasoning += r.reasoning || 0;
    if (r.ttft_ms > 0) { a.ttft += r.ttft_ms; a.timed++; }
    if (ts >= Date.now() - 7 * 86400e3) heat[new Date(ts).getDay() * 24 + new Date(ts).getHours()]++;
    if (r.status != null) {
      recent.push({
        t: r.t, agent: r.agent, provider: prov, model: r.served || r.model,
        in: r.in || 0, out: r.out || 0, ttft: r.ttft_ms || null, ms: r.ms || null,
        status: r.status, tries: r.tries || 1,
      });
      // recent 有界：日志按时间追加，最后 40 条即最新；超限排序截断防止长日志撑爆
      if (recent.length > 80) { recent.sort((x, y) => (x.t < y.t ? 1 : -1)); recent.length = 40; }
    }
  }
  } catch (e) {
    // 读不到（ENOENT）= 全新安装的空态；其他读失败（权限/损坏）必须可见，不能伪装成零用量
    if (e && e.code === 'ENOENT') return { daily: [], heat, recent: [] };
    console.error('[magpie-usage] usage.jsonl read failed:', (e && e.message) || e);
    return { daily: [], heat, recent: [], error: 'usage log read failed (' + ((e && e.code) || (e && e.message) || '?') + ')' };
  }
  recent.sort((x, y) => (x.t < y.t ? 1 : -1));
  recent = recent.slice(0, 40);
  const data = {
    daily: [...daily.entries()].sort().map(([day, ps]) => ({
      day, providers: [...ps.entries()].map(([provider, a]) => ({ provider, ...a })),
    })),
    heat, recent,
  };
  detailCache = { key: cacheKey, data };
  return data;
}

// 远端归因：只有远端网关的 usage.jsonl 记着 providerAccount / callerKeyName，
// 本地那一侧一条 magpie-direct 看不出真实花在谁身上。这里按调用方把账算出来。
let attrCache = { key: '', data: null };
const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[i];
};
// 近 24h 按小时聚合；d=直连（本机自己的 provider），r=走远端（REMOTE_PROVIDERS）
let h24Cache = { key: '', data: null };
async function readHourly24() {
  const key = 'h24:' + Math.floor(Date.now() / 300000);
  if (h24Cache.data && h24Cache.key === key) return h24Cache.data;
  const since = Date.now() - 24 * 3600e3;
  const hours = new Map();
  try {
    for await (const line of linesOf(USAGE_JSONL)) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    // magpie 自家探活行（kind:"model_list", source:"probe"）不是真实调用，过滤（2026-11-04，实测占 9.5%）
    if (r.kind === 'model_list' || r.source === 'probe') continue;
    const ts = r.t ? Date.parse(r.t) : NaN;
    if (!Number.isFinite(ts) || ts < since) continue;
    const t = new Date(ts);
    const hk = String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0')
      + ' ' + String(t.getHours()).padStart(2, '0') + ':00';
    let h = hours.get(hk);
    if (!h) { h = { d: { calls: 0, input: 0, output: 0, cache_read: 0 }, r: { calls: 0, input: 0, output: 0, cache_read: 0 } }; hours.set(hk, h); }
    const side = REMOTE_PROVIDERS.includes(r.provider || '') ? 'r' : 'd';
    const b = h[side];
    b.calls++; b.input += r.in || 0; b.output += r.out || 0; b.cache_read += r.cache_read || 0;
  }
  } catch (e) {
    if (e && e.code === 'ENOENT') return { hours: [] }; // 全新安装：空态
    console.error('[magpie-usage] usage.jsonl read failed (hourly):', (e && e.message) || e);
    return { hours: [], error: 'usage log read failed (' + ((e && e.code) || (e && e.message) || '?') + ')' };
  }
  const data = { hours: [...hours.entries()].sort().map(([hour, v]) => ({ hour, ...v })) };
  h24Cache = { key, data };
  return data;
}

// 百分位采样：每 provider 最多 512 个样本（确定性跨步替换），长日志不会把样本数组撑爆
async function aggregateAttribution(rows, { period, days, callers, source }) {
  const sampN = new Map();
  const pushSample = (map, key, v, cap = 512) => {
    let s = map.get(key); if (!s) { s = []; map.set(key, s); }
    if (s.length < cap) { s.push(v); return; }
    const c = (sampN.get(key) || 0) + 1; sampN.set(key, c);
    s[c % cap] = v;
  };
  const since = days > 0 ? Date.now() - days * 86400e3 : 0;
  const prov = new Map(), acct = new Map(), byDay = new Map(), byCaller = new Map(), hourly = new Map();
  const ttftSamples = new Map(), msSamples = new Map();
  const totals = { calls: 0, errors: 0, input: 0, output: 0, cache_read: 0, ttft_ms: 0, timed: 0 };
  for await (const r of rows) {
    if (!r) continue;
    // magpie 自家探活行（kind:"model_list", source:"probe"）不是真实调用，过滤
    if (r.kind === 'model_list' || r.source === 'probe') continue;
    // 远端 API 的 t 带 9 位小数秒，Date.parse 只认毫秒，先截断
    const ts = Date.parse(String(r.t || '').replace(/(\.\d{3})\d+/, '$1'));
    if (!Number.isFinite(ts) || ts < since) continue;
    // 按调用方拆分：这一项不受 caller 过滤影响，前端要拿它画「本机 / remote / hermes」占比
    const cn = r.callerKeyName || '(无)';
    let cb = byCaller.get(cn);
    if (!cb) { cb = { name: cn, calls: 0, input: 0, output: 0 }; byCaller.set(cn, cb); }
    cb.calls++; cb.input += r.in || 0; cb.output += r.out || 0;
    if (callers.length && !callers.includes(r.callerKeyName || '')) continue;
    if (ts >= Date.now() - 24 * 3600e3) {
      const t = new Date(ts);
      const hk = String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0')
        + ' ' + String(t.getHours()).padStart(2, '0') + ':00';
      let hv = hourly.get(hk);
      if (!hv) { hv = { calls: 0, input: 0, output: 0, cache_read: 0 }; hourly.set(hk, hv); }
      hv.calls++; hv.input += r.in || 0; hv.output += r.out || 0; hv.cache_read += r.cache_read || 0;
    }
    const pn = r.provider || 'unknown';
    const inTok = r.in || 0, outTok = r.out || 0, cache = r.cache_read || 0;
    const err = r.status !== 200 ? 1 : 0;
    totals.calls++; totals.errors += err;
    totals.input += inTok; totals.output += outTok; totals.cache_read += cache;
    if (r.ttft_ms > 0) { totals.ttft_ms += r.ttft_ms; totals.timed++; }
    let a = prov.get(pn);
    if (!a) { a = { provider: pn, calls: 0, errors: 0, input: 0, output: 0, cache_read: 0 }; prov.set(pn, a); }
    a.calls++; a.errors += err; a.input += inTok; a.output += outTok; a.cache_read += cache;
    if (r.ttft_ms > 0) pushSample(ttftSamples, pn, r.ttft_ms);
    if (r.ms > 0) pushSample(msSamples, pn, r.ms);
    const an = r.providerAccount || '';
    if (an) {
      const k = pn + '\u0000' + an;
      let b = acct.get(k);
      if (!b) { b = { provider: pn, account: an, calls: 0, errors: 0, input: 0, output: 0 }; acct.set(k, b); }
      b.calls++; b.errors += err; b.input += inTok; b.output += outTok;
    }
    const day = String(r.t || '').slice(0, 10);
    if (day) {
      let d = byDay.get(day);
      if (!d) { d = new Map(); byDay.set(day, d); }
      let c = d.get(pn);
      if (!c) { c = { calls: 0, input: 0, output: 0, cache_read: 0 }; d.set(pn, c); }
      c.calls++; c.input += inTok; c.output += outTok; c.cache_read += cache;
    }
  }
  const providers = [...prov.values()].sort((x, y) => y.calls - x.calls).map((p) => {
    const ts = ttftSamples.get(p.provider) || [];
    const ms = msSamples.get(p.provider) || [];
    return {
      ...p,
      ttft_p50: pct(ts, 50), ttft_p90: pct(ts, 90),
      ttft_avg: ts.length ? ts.reduce((s, v) => s + v, 0) / ts.length : null,
      ms_p50: pct(ms, 50), ms_p90: pct(ms, 90), timed: ts.length,
    };
  });
  return {
    source,
    callers,
    period,
    since: since ? new Date(since).toISOString() : null,
    totals,
    providers,
    accounts: [...acct.values()].sort((x, y) => y.calls - x.calls).slice(0, 30),
    callerBreakdown: [...byCaller.values()].sort((x, y) => y.calls - x.calls),
    days: [...byDay.entries()].sort().map(([day, m]) => ({ day, providers: Object.fromEntries(m) })),
    // 远端归因的小时行按 {hour, r:{...}} 输出——页面 drawHourly 按 x.r 读取远端侧
    // （扁平结构会被当成空对象，全远端出口的部署 24h 图会全 0）
    hourly: [...hourly.entries()].sort().map(([hour, v]) => ({ hour, r: v })),
  };
}

async function readAttribution(period, days, callers) {
  // 归因数据变化很慢，5 分钟够用（看板自身也是 5 分钟自动刷新）
  const bucket = Math.floor(Date.now() / (5 * 60000));
  const cacheKey = 'local:' + period + ':' + callers.join(',') + ':' + bucket;
  if (attrCache.data && attrCache.key === cacheKey) return attrCache.data;
  async function* localRows() {
    for await (const line of linesOf(USAGE_JSONL)) {
      let r; try { r = JSON.parse(line); } catch { continue; }
      yield r;
    }
  }
  let data;
  try { data = await aggregateAttribution(localRows(), { period, days, callers, source: 'local' }); }
  catch { return null; }
  attrCache = { key: cacheKey, data };
  return data;
}

// 远端 magpie 的逐条请求记录：/v1/magpie/usage/requests 每行都带 callerKeyId/Name、
// provider/providerAccount、时间、TTFT。summary 端点不支持按 caller 过滤，但 rows 可以。
// 用本机 magpie 已经配好的 remote provider（providers.json）的 URL+key，不引入第二把 key。
const REMOTE_PAGE = 500, REMOTE_MAX = 40000, REMOTE_CONC = 4;

function remoteSources() {
  if (ATTRIBUTION_MODE !== 'remote') return [];
  const callers = REMOTE_CALLERS;
  const out = [];
  const push = (base, key, id, name) => {
    const b = String(base || '').replace(/\/+$/, '').replace(/\/v1$/, '');
    let u; try { u = new URL(b); } catch { return; }
    // Bearer key 只走 https；明文 http 仅限本机回环（本地测试用）
    if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost', '::1'].includes(u.hostname)) return;
    if (key && !out.some((x) => x.base === b && x.key === key)) {
      out.push({ base: b, key, callers, id: id || 'remote-magpie', name: name || id || 'Remote magpie' });
    }
  };
  if (process.env.REMOTE_BASE && process.env.REMOTE_KEY) {
    // 显式 override 独占：设置 REMOTE_BASE/KEY 时不再读 providers.json（文档承诺的语义）
    push(process.env.REMOTE_BASE, process.env.REMOTE_KEY, 'remote-magpie', 'Remote magpie');
    return out;
  }
  try {
    const j = JSON.parse(readFileSync(MAGPIE_PROVIDERS, 'utf8'));
    for (const p of j.providers || []) {
      if (!p || !p.key || !/^https?:\/\//.test(String(p.chat || p.responses || ''))) continue;
      if (p.preset !== 'remote-magpie' && p.id !== 'magpie-direct' && p.id !== 'magpie-cf') continue;
      push(p.chat || p.responses, p.key, p.id, p.name);
    }
  } catch {}
  return out;
}

let lastGoodRemote = null;
function orderedSources() {
  const list = remoteSources();
  if (lastGoodRemote) {
    const i = list.findIndex((x) => x.base === lastGoodRemote.base && x.key === lastGoodRemote.key);
    if (i > 0) list.unshift(list.splice(i, 1)[0]);
  }
  return list;
}

// 远端线路 id 全集：providers.json 里用户自己起名的 id（preset remote-magpie，如 office）
// + magpie 自带的四条。hasRemoteLineCards 与页面的线路前缀剥离都从这里取——写死四条时，
// 自定义 id 的线路会被兜底加成第二张卡、图标也剥不掉前缀（1056 复审）。
function remoteLineIds() {
  const ids = orderedSources().map((s) => s.id);
  for (const id of ['magpie-direct', 'magpie-cf', 'magpie-2', 'remote-magpie']) {
    if (!ids.some((x) => String(x).toLowerCase() === id)) ids.push(id);
  }
  return ids;
}

function stripLinePrefix(provider) {
  const p = String(provider || '');
  const low = p.toLowerCase();
  for (const id of remoteLineIds()) {
    const head = id.toLowerCase() + '/';
    if (low.startsWith(head)) return p.slice(head.length);
  }
  return p;
}

async function remotePage(src, period, offset) {
  const u = src.base + '/v1/magpie/usage/requests?period=' + encodeURIComponent(period)
    + '&limit=' + REMOTE_PAGE + '&offset=' + offset;
  let last;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(u, { headers: { Authorization: 'Bearer ' + src.key }, signal: AbortSignal.timeout(10000) });
      if (r.ok) return r.json();
      last = new Error('remote usage/requests ' + r.status);
      if (r.status < 500) break;
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 600 * (i + 1)));
  }
  throw last || new Error('remote usage/requests failed');
}

async function fetchRemoteRows(src, period, first) {
  const rows = [...((first && first.rows) || [])];
  const total = Number(first.total) || rows.length;
  let offset = rows.length;
  const t0 = Date.now();
  while (offset < total && rows.length < REMOTE_MAX) {
    // 远端分页总时限：provider key 是真实凭据，拉取不能无上限（前端 45s 会先行放弃）
    if (Date.now() - t0 > 40000) break;
    const offsets = [];
    for (let i = 0; i < REMOTE_CONC; i++) {
      const o = offset + i * REMOTE_PAGE;
      if (o >= total || rows.length + offsets.length * REMOTE_PAGE >= REMOTE_MAX) break;
      offsets.push(o);
    }
    if (!offsets.length) break;
    const pages = await Promise.all(offsets.map((o) => remotePage(src, period, o)));
    for (const page of pages) rows.push(...(page.rows || []));
    offset = offsets[offsets.length - 1] + REMOTE_PAGE;
  }
  return rows;
}

async function readRemoteAttribution(period, days, callers, sources) {
  const bucket = Math.floor(Date.now() / (5 * 60000));
  const suffix = ':' + period + ':' + callers.join(',') + ':' + bucket;
  if (attrCache.data && attrCache.key.startsWith('remote:') && attrCache.key.endsWith(suffix)) return attrCache.data;
  // 上次成功的源优先；首次或失败时并发要首页，谁先回用谁，剩下的页只走这个源。
  let picked = null;
  if (lastGoodRemote && sources.some((s) => s.base === lastGoodRemote.base && s.key === lastGoodRemote.key)) {
    try { picked = { src: lastGoodRemote, page: await remotePage(lastGoodRemote, period, 0) }; }
    catch { lastGoodRemote = null; }
  }
  if (!picked) {
    try {
      picked = await Promise.any(sources.map(async (src) => ({ src, page: await remotePage(src, period, 0) })));
    } catch (e) {
      const why = (e && e.errors ? e.errors.map((x) => x && x.message).filter(Boolean).join('; ') : String(e && e.message || e));
      throw new Error(why || 'all remote sources failed');
    }
  }
  lastGoodRemote = picked.src;
  // 远端 providers[] 顺带带上各自的 icon 名：归因每 5 分钟刷新一次，图标映射也就跟着保鲜
  harvestRemoteLogos(picked.page && picked.page.providers);
  const rows = await fetchRemoteRows(picked.src, period, picked.page);
  const data = await aggregateAttribution(rows, { period, days, callers, source: 'remote' });
  attrCache = { key: 'remote:' + picked.src.base + suffix, data };
  return data;
}
function sameKey(given) {
  // 先比字节长度：JS 字符串长度 ≠ 字节长（非 ASCII 自定义 key 曾让 timingSafeEqual 抛错→鉴权全 500）
  if (typeof given !== 'string' || Buffer.byteLength(given) !== Buffer.byteLength(PAGE_KEY)) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(PAGE_KEY));
}

function authed(req) {
  if (!PAGE_KEY) return true;
  // 口令只走 x-dash-key 头：?key= 已废除（key 一旦进 URL 就会落进代理/历史记录），
  // 浏览器端由服务端注入 HTML 的脚本带着头调 API，脚本调用方显式设 PAGE_KEY。
  return sameKey(String(req.headers['x-dash-key'] || ''));
}

// 防 DNS rebinding：只接受本机回环名 / 本机网卡地址 / ALLOWED_HOSTS 里的名字。
// 回环名不看端口（Docker 端口映射、ssh 隧道的外部端口与监听口必然不同，而
// rebinding 的威胁在域名不在端口）；非回环名的端口必须是本进程监听口，
// 除非名字进了 ALLOWED_HOSTS（反代常把 Host 写成 domain:443）。
function hostAllowed(req) {
  const raw = String(req.headers.host || '').toLowerCase();
  if (!raw) return false;
  const m = raw.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  if (!m) return false;
  const name = m[1];
  const port = Number(m[2] || 0);
  const bound = server.address()?.port || 0;
  // 显式白名单优先（反代常把 Host 写成 domain:443，端口与本机监听口不同）
  if (ALLOWED_HOSTS.includes(name) || ALLOWED_HOSTS.includes(raw)) return true;
  if (name === '127.0.0.1' || name === 'localhost' || name === '[::1]') return true;
  if (port && bound && port !== bound) return false;
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
    if (name === HOST.toLowerCase()) return true;
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) if (a.address.toLowerCase() === name) return true;
    }
  }
  return false;
}

function secHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

// 页面 HTML 的跨源读取：沙盒 frame 是 opaque origin（null），顶层导航没有 Origin；
// 其它网站发来的 Origin 一律拒绝，避免它们 fetch 到注入口令的页面。
// 本机 origin 只认「本进程实际监听口」——任意 localhost 端口不放行。
function originOk(req, boundPort) {
  const o = req.headers.origin;
  if (!o || o === 'null') return true;
  return loopbackOrigin(o, boundPort);
}

function loopbackOrigin(o, boundPort) {
  if (!boundPort) return false;
  return o === `http://127.0.0.1:${boundPort}`
    || o === `http://localhost:${boundPort}`
    || o === `http://[::1]:${boundPort}`;
}

// 沙盒 frame（插件页面导航过来，opaque origin）跨源 fetch：允许 Origin: null，
// key 走 x-dash-key 头（opaque origin 无 cookie）。其它 origin 一律不给 ACAO——
// 页面是这份服务的唯一客户端，本机其它端口的页面也不例外。
function cors(req, res) {
  const o = req.headers.origin;
  const allow = (v) => {
    res.setHeader('Access-Control-Allow-Origin', v);
    res.setHeader('Vary', 'Origin');
    return true;
  };
  if (o === undefined || o === 'null') return allow('null');
  if (loopbackOrigin(o, server.address()?.port || 0)) return allow(o);
  return false;
}

// 请求处理主体（原 handler 体）：任何未捕获异常都由下方 createServer 的 .catch
// 兜底成 500，进程必须存活、继续服务下一个请求。
async function handleRequest(req, res, url) {
  const p = url.pathname;
  secHeaders(res);
  if (!hostAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('invalid host');
  }
  console.log(`[req] ${req.method} ${p} origin=${req.headers.origin || '-'} xdk=${req.headers['x-dash-key'] ? 'yes' : 'no'}`);

  if (p.startsWith('/api/')) {
    // 免鉴权实例指纹：同款服务复用判定用；只报身份，不泄露网关/口令
    if (p === '/api/ping') return json(res, 200, { service: 'magpie-usage-board', ok: true, build: BUILD_ID, version: VERSION });
    if (req.method === 'OPTIONS') {
      if (!cors(req, res)) { res.writeHead(403); return res.end(); }
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'x-dash-key',
        'Access-Control-Max-Age': '86400',
      });
      return res.end();
    }
    if (!cors(req, res)) { res.writeHead(403); return res.end('cross-origin reads not allowed'); }
    // health 免鉴权：探活与实例识别都依赖匿名访问（响应里无口令、无用量数据）
    if (p === '/api/health') return json(res, 200, { ok: true, jsonl: existsSync(USAGE_JSONL) });
    if (!authed(req)) return json(res, 401, { error: 'unauthorized: send the x-dash-key header' });
    try {
      if (p === '/api/quotas') {
        const [r, lim] = await Promise.all([
          upstream('/v1/magpie/quotas'),
          upstream('/v1/magpie/limit?format=json').catch(() => null),
        ]);
        const out = { ...r.json };
        // magpie 不再聚合远端账号卡时（0.1.3771 对 0.1.3729 远端实测只回本机卡），
        // remote 模式下看板自己补：向远端要 /v1/magpie/quotas/cards，按线路前缀合并。
        if (r.code === 200 && Array.isArray(out.data) && !hasRemoteLineCards(out.data)) {
          const extra = await ensureRemoteCards().catch(() => []);
          if (extra.length) out.data = out.data.concat(extra);
        }
        // icons：远端 provider 的 id→data URI（本地图标缓存），前端合并进 QLOGOS 后再画卡片
        out.icons = remoteLogos;
        // magpie 0.1.2981+ 的 /v1/magpie/limit：报告本 caller key 当前被什么 holds（limited/key）
        if (lim && lim.code === 200 && lim.json && typeof lim.json === 'object') out.limit = lim.json;
        // code 0 = 网关无响应（upstream 内部已重试）：writeHead(0) 会 RangeError 并吞掉真实原因
        const status = r.code >= 400 && r.code <= 599 ? r.code : r.code === 200 ? 200 : 502;
        return json(res, status, out);
      }
      if (p === '/api/overview') {
        const period = ['7d', '30d', 'all'].includes(url.searchParams.get('period')) ? url.searchParams.get('period') : '30d';
        const days = period === '7d' ? 7 : period === '30d' ? 30 : 0;
        // 网关挂起/失败不拖垮本地数据：usage/limit 失败 → null + note，本地日志聚合照常返回
        const [u, lim] = await Promise.all([
          upstream('/v1/magpie/usage?period=' + period).catch(() => ({ code: 0, json: null })),
          upstream('/v1/magpie/limit?format=json').catch(() => null),
        ]);
        const detail = await readDetail(days);
        const notes = [u.code === 200 ? undefined : 'usage API ' + (u.code || 'no response'), detail && detail.error].filter(Boolean);
        return json(res, 200, { period, usage: u.code === 200 ? u.json : null, detail,
          limit: (lim && lim.code === 200 && lim.json) || undefined,
          note: notes.length ? notes.join('；') : undefined });
      }
      // /api/icon/ 已退役（2026-11-04）：前端 logo 全走 QLOGOS manifest，仅 README 提及历史
      if (p === '/api/hourly') {
        const data = await readHourly24();
        return json(res, 200, data);
      }
      if (p === '/api/attribution') {
        const period = ['7d', '30d', 'all'].includes(url.searchParams.get('period')) ? url.searchParams.get('period') : '30d';
        const days = period === '7d' ? 7 : period === '30d' ? 30 : 0;
        // 本机 magpie 配了 remote provider 时，归因直接问远端 magpie 的 usage/requests，
        // 用已有的 provider key，按 caller 过滤；否则退回本机 usage.jsonl（VPS standalone）。
        const sources = orderedSources();
        if (sources.length) {
          try {
            const data = await readRemoteAttribution(period, days, sources[0].callers, sources);
            // icons：远端 provider 的 id→data URI（本地图标缓存），前端合并进 QLOGOS 后重画卡片
            return json(res, 200, Object.assign({}, data, { icons: remoteLogos }));
          } catch (e) {
            return json(res, 502, { error: 'remote attribution: ' + String(e && e.message || e) });
          }
        }
        const callers = (url.searchParams.get('caller') || '').split(',').map((x) => x.trim()).filter(Boolean);
        const data = await readAttribution(period, days, callers);
        if (!data) return json(res, 503, { error: 'usage.jsonl not readable' });
        return json(res, 200, data);
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      return json(res, 502, { error: String(e && e.message || e) });
    }
  }

  let file = p === '/' ? '/index.html' : p;
  if (file.startsWith('/static/')) file = file.slice('/static'.length);
  // 静态资源全部来自包内 static/；品牌 logo 不再有独立路由（data URI 注入 window.QLOGOS）
  const base = STATIC_DIR;
  const full = path.resolve(base, '.' + file);
  const rel = path.relative(base, full);
  let isFile = false;
  try { isFile = !rel.startsWith('..') && !path.isAbsolute(rel) && statSync(full).isFile(); } catch {}
  if (!isFile) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
  // 页面本身不要求口令（与社区 page-usage-tree 一致）：回环绑定直接返回看板，
  // 由服务端把口令注入 HTML；公网绑定仍要求口令，避免把数据和口令交给匿名访问者。
  // 这只拦跨源 fetch（Origin 非空且不是本机），顶层导航不带 Origin，不受影响。
  // 看板页面是这份服务的唯一客户端：回环绑定时一律注入口令返回（本机用户即所有者，
  // 顶层/沙盒 frame 导航都不带 Origin；与社区 page-usage-tree 同一模型，桌面宿主
  // 不需要任何环境变量）。非回环绑定不开放页面——?key= 已废除，远程访问者没有
  // 认证通道；脚本调用走 x-dash-key 头。
  if (file === '/index.html') {
    if (!originOk(req, server.address()?.port || 0)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('cross-origin page read not allowed');
    }
    if (!LOOPBACK_BIND) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('the board page is loopback-only; APIs accept the x-dash-key header');
    }
    // 页面还要求 Host 是回环名：反代把公共域名（ALLOWED_HOSTS 放行的 Host）转发进来时，
    // 页面不随之开放——公网访问者只能拿 403；API 走 x-dash-key 头仍可用（P1 回归）。
    const hostName = (String(req.headers.host || '').toLowerCase().match(/^(\[[^\]]+\]|[^:]+)/) || [])[1] || '';
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostName)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('the board page answers loopback hosts only');
    }
  }

  // 首页：服务端把数据直接内联进 HTML（window.__DATA__），页面加载即有数据，
  // 不发任何 fetch——沙盒 frame（opaque origin）里跨源 fetch 会被浏览器/
  // 中间层拦成 "Failed to fetch"，这是实测结论；同帧内联是唯一稳路。
  if (file === '/index.html') {
    let html = await readFile(full, 'utf8');
    let data = null, note = '';
    try {
      const period = ['7d', '30d', 'all'].includes(url.searchParams.get('period')) ? url.searchParams.get('period') : '30d';
      const days = period === '7d' ? 7 : period === '30d' ? 30 : 0;
      const [u, detail, q] = await Promise.all([
        upstream('/v1/magpie/usage?period=' + period),
        readDetail(days),
        upstream('/v1/magpie/quotas'),
      ]);
      data = { period, usage: u.json, quotas: q.json?.data || [], detail };
      if (u.code !== 200) note = 'usage API ' + u.code;
    } catch (e) { note = String(e && e.message || e); }
    const trap = '<script>window.__errs=[];window.addEventListener("error",function(e){var m=e.message||((e.target&&e.target.src||e.target&&e.target.href)?("resource: "+(e.target.src||e.target.href)):"");if(!m)return;window.__errs.push(m+" @ "+(e.filename||"")+":"+(e.lineno||0)+":"+(e.colno||0))},true);window.addEventListener("unhandledrejection",function(e){window.__errs.push("PROMISE: "+String(e.reason&&e.reason.message||e.reason))});<\/script>';
    // 品牌 logo 映射 = 本机 plugin-providers.json / quotas.json 的 data URI，
    // 再叠加远端 provider 的图标（远端 providers[] 给出 icon 名，本体读本机 icons/ 缓存）。
    // 远端只在 remote 归因模式下才问，且最多等 2.5s：宁可先出首字色块，也不拖住整页。
    await Promise.race([ensureRemoteLogos(), new Promise((r) => setTimeout(r, 2500))]);
    const logos = Object.assign({}, providerLogos, remoteLogos);
    // 额度卡上还缺图标的本机旧缓存品牌：只补当前卡片用得到的 id，且分两轮——
    // 先落精确同名（modelscope.ico 先就位），再走别名/去后缀（msmoli → modelscope、
    // qingyan-checkin → qingyan），避免同一张图被别名各存一份。
    const need = [];
    for (const q of (data.quotas || [])) {
      const id = stripLinePrefix(q && q.provider).replace(/#.*$/, '').toLowerCase();
      if (id && !need.includes(id)) need.push(id);
    }
    const legacy = loadLegacyLogos();
    for (const id of need) if (legacy[id] && !logoHit(id, logos)) logos[id] = legacy[id];
    for (const id of need) {
      if (logoHit(id, logos)) continue;
      const uri = legacyLogoFor(id);
      if (uri) logos[id] = uri;
    }
    // 同图别名去重：前端 brandIcon() 会去后缀再查，主 id 在就不必存变体
    for (const k of Object.keys(logos)) {
      const base = k.replace(/-(cn|intl|global|free|extra|checkin|pro|api)$/, '');
      if (base !== k && logos[base] === logos[k]) delete logos[k];
    }
    const inject = `<script>window.__DATA__=${JSON.stringify(data).replace(/</g, '\\u003c')};window.__NOTE__=${JSON.stringify(note)};window.QLOGOS=${JSON.stringify(logos).replace(/</g, '\\u003c')};window.__LINES__=${JSON.stringify(remoteLineIds())};window.__BUILD__=${JSON.stringify(`${VERSION}/${BUILD_ID}`)};</script>`;
    // 页面需要的口令只出现在这份 HTML 里；API 路由仍校验它，URL/书签里不出现
    const keyInject = PAGE_KEY ? `<script>window.__KEY__=${JSON.stringify(PAGE_KEY).replace(/</g, '\\u003c')};</script>` : '';
    html = html.replace('<head>', () => '<head>' + keyInject + trap + inject);
    const boundPort = server.address()?.port || 0;
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // 页面脚本全是同源文件 + 少量内联（数据注入）；数据获取全部同源 /api/*。
      // connect-src 除 'self' 外显式列出本机回环地址——WebKit 的沙盒 frame（opaque
      // origin）会把 'self' 解析成 opaque，同源 fetch 被拦，显式地址实测可行。
      // frame-ancestors：看板本来就是被 magpie 的框架嵌入的（桌面/webview/web 的宿主
      // origin 不固定，收不了紧）——显式写 * 表明「被宿主嵌入是设计意图」，而不是遗漏。
      'Content-Security-Policy': `default-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' http://127.0.0.1:${boundPort} http://localhost:${boundPort}; object-src 'none'; base-uri 'none'; frame-ancestors *`,
    });
    return res.end(html);
  }

  const heads = { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' };
  // echarts.min.js：URL 带 ?v= 构建戳（内容变更即换 URL）→ 长缓存；按 Accept-Encoding 供
  // 启动时预压缩的 br/gzip 版本（612KB → br ~172KB），避免每次导航白拉全量
  if (file === '/echarts.min.js') {
    heads['Cache-Control'] = 'public, max-age=31536000, immutable';
    const enc = echartsEncoded(full);
    const ae = String(req.headers['accept-encoding'] || '');
    if (/\bbr\b/.test(ae)) { heads['Content-Encoding'] = 'br'; heads['Content-Length'] = String(enc.br.length); heads['Vary'] = 'Accept-Encoding'; res.writeHead(200, heads); return res.end(enc.br); }
    if (/\bgzip\b/.test(ae)) { heads['Content-Encoding'] = 'gzip'; heads['Content-Length'] = String(enc.gz.length); heads['Vary'] = 'Accept-Encoding'; res.writeHead(200, heads); return res.end(enc.gz); }
  }
  if (file.endsWith('.svg')) heads['Content-Security-Policy'] = 'sandbox'; // SVG 可内嵌脚本：被直接打开时整页隔离
  res.writeHead(200, heads);
  res.end(await readFile(full));
}

const server = createServer((req, res) => {
  // 畸形请求目标（如 GET // HTTP/1.1）会让 new URL 抛 Invalid URL：单独 try/catch
  // 拦下直接 400，不进入 Host 校验/鉴权/任何业务逻辑（P0 修复：原实现无容错，
  // 任意外部请求即可打死进程）。
  let url;
  try {
    url = new URL(req.url, 'http://x');
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('bad request');
  }
  handleRequest(req, res, url).catch((e) => {
    // 最外层兜底：任何未捕获异常 → 500，固定文案（不带堆栈与内部错误细节），进程继续服务
    console.log(`[magpie-usage] handler error: ${e && e.message || e}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('internal server error');
    } else { try { res.end(); } catch {} }
  });
});

// 最后防线：unhandledRejection 只记日志、不退出进程（Node/Bun 默认会终止进程），
// 兜住请求处理之外（定时器、fire-and-forget fetch 等）的意外拒绝。
process.on('unhandledRejection', (e) => {
  console.log(`[magpie-usage] unhandled rejection: ${e && e.message || e}`);
});

// ---- 启动 ----
// 构建指纹：版本号 + 运行时文件哈希。端口被占时用 /api/ping 互认——只有「同一份代码」
// 的实例才允许复用（旧版本/别的构建一律报错，绝不把看板交给一个未知进程）。
const VERSION = (() => {
  try { const v = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; return typeof v === 'string' ? v : '0'; } catch { return '0'; }
})();
const BUILD_FILES = ['server.mjs', 'index.mjs', 'package.json', 'static/index.html', 'static/echarts.min.js', 'page/index.html', 'page/boot.js'];
const BUILD_ID = (() => {
  try {
    const h = createHash('sha256');
    for (const f of BUILD_FILES) { h.update(f); h.update('\0'); h.update(readFileSync(path.join(ROOT, f))); }
    return h.digest('hex').slice(0, 16);
  } catch { return 'ver:' + VERSION; }
})();

// 占用端口的是不是本构建的实例：/api/ping 匿名报身份（无口令、无数据），同构建才复用。
async function probe(hp) {
  try {
    const j = await (await fetch(`http://${hp}/api/ping`, { signal: AbortSignal.timeout(1200) })).json();
    if (j && j.service === 'magpie-usage-board') return { build: String(j.build || ''), version: String(j.version || '') };
  } catch {}
  return null;
}

// 品牌 logo：读 magpie 自己维护的 plugin-providers.json（插件注册 provider 时上报的
// id→icon，data URI 为主）。只取 data URI（≤2MB）；https 图标一律不抓取——那会让本机
// 服务在启动时向第三方 CDN 发起用户不可见的请求。页面 brandIcon() 的别名/去后缀兜底链
// 在前端保持不变，未命中品牌走首字色块。
let providerLogos = {};
function loadProviderLogos() {
  const out = {};
  let total = 0;
  // 来源 ①：plugin-providers.json —— magpie 的 provider 注册表，插件自己上报的
  // data URI 图标（零下载：https 图标一律不抓，那会让本机服务在启动时向第三方
  // CDN 发起用户不可见的请求——维护者复审红线）。
  const f = PROVIDERS_FILE || path.join(CONFIG_DIR, 'plugin-providers.json');
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    for (const p of Object.values(j)) {
      const id = p && typeof p.id === 'string' ? p.id.toLowerCase() : '';
      const icon = p && typeof p.icon === 'string' ? p.icon : '';
      if (!id || !icon.startsWith('data:image/')) continue;
      const comma = icon.indexOf(',');
      if (comma <= 0 || icon.length - comma > 2 * 1024 * 1024) continue; // 解码前 2MB 上限
      if (out[id] === undefined) { out[id] = icon; total += icon.length; }
      if (total > 4 * 1024 * 1024) break; // 注入 HTML 的总体积上限
    }
    console.log(`[magpie-usage] logos: ${Object.keys(out).length} data-URI brands from ${f}`);
  } catch (e) {
    console.log(`[magpie-usage] logos: plugin-providers.json not readable (${(e && e.code) || (e && e.message) || e})`);
  }
  // 来源 ②：quotas.json —— magpie 给每个账号缓存的图标（quota.icon: file:xxx =
  // CONFIG_DIR/icons/xxx，magpie 自己已下载的；或内置色名 modelscope-color，
  // 没有实体文件，跳过）。同为本地读，零网络。
  try {
    const q = JSON.parse(readFileSync(path.join(CONFIG_DIR, 'quotas.json'), 'utf8'));
    let added = 0;
    for (const [key, v] of Object.entries(q)) {
      if (total > 4 * 1024 * 1024) break;
      const icon = v && v.quota && typeof v.quota.icon === 'string' ? v.quota.icon : '';
      if (!icon.startsWith('file:')) continue; // 内置色名（modelscope-color 等）无实体文件
      const prov = typeof key === 'string' ? key.split('/')[0].toLowerCase() : '';
      if (!prov || out[prov] !== undefined) continue;
      // file: 后取 basename 再拼回 icons/：防 icon 值里夹 ../ 之类穿越
      const base = path.basename(icon.slice(5));
      if (!/\.(png|svg|webp|jpg|jpeg|ico)$/i.test(base)) continue;
      try {
        const buf = readFileSync(path.join(CONFIG_DIR, 'icons', base));
        if (!buf.length || buf.length > 2 * 1024 * 1024) continue;
        const ext = path.extname(base).slice(1).toLowerCase();
        const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'ico' ? 'image/x-icon' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
        out[prov] = `data:${mime};base64,${buf.toString('base64')}`;
        total += buf.length;
        added++;
      } catch {}
    }
    if (added) console.log(`[magpie-usage] logos: +${added} from quotas.json icons (local cache)`);
  } catch {}
  providerLogos = out;
}

// 走远端线路的 provider（quota 卡上的 magpie-direct/duanyan 这类）在本机没有注册，
// plugin-providers.json / quotas.json 里都没有它们的 id→图标。远端 magpie 的
// /v1/magpie/usage/requests 会在 providers[] 里给出每条 provider 的 icon 名，
// 其中 file:<文件名> 指向的图标文件 magpie 客户端早就下载过、就缓存在
// CONFIG_DIR/icons/ —— 这里只读本地缓存拼 data URI，不碰任何第三方图源。
// 映射本身只能问远端（与远端归因同一把 provider key、同在 remote 模式下），
// 因此拿不到时退回页面原有的首字色块，不是错误。
let remoteLogos = {};
let remoteLogosAt = 0, remoteLogosPending = null, remoteLogosFailedAt = 0;
const REMOTE_LOGOS_TTL = 30 * 60 * 1000, REMOTE_LOGOS_RETRY = 5 * 60 * 1000;

function iconSpecToDataUri(spec) {
  if (typeof spec !== 'string' || !spec.startsWith('file:')) return '';
  // 只认 icons/ 下的 basename 与图片后缀：防 icon 值里夹 ../ 之类穿越
  return iconFileDataUri(path.basename(spec.slice(5)), path.join(CONFIG_DIR, 'icons'));
}

function iconFileDataUri(base, dir) {
  if (!/\.(png|svg|webp|jpg|jpeg|ico)$/i.test(base)) return '';
  try {
    const buf = readFileSync(path.join(dir, base));
    if (!buf.length || buf.length > 2 * 1024 * 1024) return '';
    const ext = path.extname(base).slice(1).toLowerCase();
    const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'ico' ? 'image/x-icon' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch { return ''; }
}

// 最后一级兜底：本插件旧版（≤0.1.0）把扫描来的品牌图标写在 CONFIG_DIR/usage-board/logos/
// （文件名 = 品牌 id）。新版不再写它，但老用户机器上的残留正好补上 magpie icons/ 缓存里
// 缺的品牌（kuku、qingyan-checkin…）。只读、只给当前额度卡用得到的 id 用，目录不存在＝空表。
let legacyLogos = null;
function loadLegacyLogos() {
  if (legacyLogos) return legacyLogos;
  const out = {};
  const dir = path.join(CONFIG_DIR, 'usage-board', 'logos');
  let names = [];
  try { names = readdirSync(dir); } catch {}
  for (const name of names) {
    const ext = path.extname(name);
    if (!/^\.(png|svg|webp|jpg|jpeg|ico)$/i.test(ext)) continue;
    const id = name.slice(0, -ext.length).toLowerCase();
    if (!id || out[id]) continue;
    const uri = iconFileDataUri(name, dir);
    if (uri) out[id] = uri;
  }
  return (legacyLogos = out);
}

// 与页面 brandIcon() 同一套别名链，判断「某 id 已经能命中现成图标」：
// 命中就不必再从旧缓存补一张（monkeycode-intl 与 monkeycode 是同一张图）。
const LOGO_ALIAS = { 'opencode-2-free': 'zen', 'opencode-zen-free': 'zen', 'msmoli': 'modelscope', 'msmoli-ai': 'modelscope', '~keys': 'magpie' };

function logoCands(id) {
  const base = id.replace(/^hub-/, '');
  // 精确 → 别名 → 去 hub- 前缀 → 去变体后缀（qingyan-checkin → qingyan）
  return [id, LOGO_ALIAS[id], base, base.replace(/-(cn|intl|global|free|extra|checkin|pro|api)$/, '')];
}

function legacyLogoFor(id) {
  const map = loadLegacyLogos();
  for (const c of logoCands(id)) if (c && map[c]) return map[c];
  return '';
}

function logoHit(id, logos) {
  for (const c of logoCands(id)) if (c && logos[c]) return c;
  return '';
}

function harvestRemoteLogos(list) {
  if (!Array.isArray(list) || !list.length) return false;
  const found = new Map();
  for (const p of list) {
    const id = p && typeof p.id === 'string' ? p.id.toLowerCase() : '';
    if (!id || found.has(id)) continue;
    const uri = iconSpecToDataUri(p.icon);
    if (uri) found.set(id, uri);
  }
  // 同图别名（monkeycode-intl / monkeycode、msmoli-ai / msmoli）只留主 id：
  // 前端 brandIcon() 本来就会去掉 -intl/-cn/-global… 后缀再查一次，
  // 不必把同一张图在 HTML 里存两遍（monkeycode 的图 base64 就有 180KB）。
  for (const id of [...found.keys()]) {
    const base = id.replace(/-(cn|intl|global|free|extra|checkin|pro|api)$/, '');
    if (base !== id && found.get(base) === found.get(id)) found.delete(id);
  }
  let changed = false, total = 0;
  for (const v of Object.values(remoteLogos)) total += v.length;
  for (const [id, uri] of found) {
    if (remoteLogos[id] === uri) continue;
    if (total + uri.length > 4 * 1024 * 1024) continue; // 注入 HTML 的总体积上限（同来源 ①）
    remoteLogos[id] = uri;
    total += uri.length;
    changed = true;
  }
  if (changed) console.log(`[magpie-usage] logos: ${Object.keys(remoteLogos).length} remote provider icons (local icon cache)`);
  return changed;
}

// 页面渲染不等远端：启动时预热一次，页面最多再等 2.5s；失败 5 分钟内不重试。
// 归因接口返回时会再合并一次并让前端重画卡片，所以即便这里超时也能补齐。
async function ensureRemoteLogos() {
  if (ATTRIBUTION_MODE !== 'remote') return remoteLogos;
  if (Date.now() - remoteLogosAt < REMOTE_LOGOS_TTL) return remoteLogos;
  if (remoteLogosPending) return remoteLogosPending;
  if (Date.now() - remoteLogosFailedAt < REMOTE_LOGOS_RETRY) return remoteLogos;
  remoteLogosPending = (async () => {
    for (const src of orderedSources()) {
      try {
        // 只要 providers[] 元数据：limit=1 让这次请求和归因拉全量页区分开
        const r = await fetch(src.base + '/v1/magpie/usage/requests?period=7d&limit=1', {
          headers: { Authorization: 'Bearer ' + src.key }, signal: AbortSignal.timeout(3000),
        });
        if (!r.ok) continue;
        const j = await r.json();
        harvestRemoteLogos(j.providers);
        remoteLogosAt = Date.now();
        return remoteLogos;
      } catch {}
    }
    remoteLogosFailedAt = Date.now();
    return remoteLogos;
  })().finally(() => { remoteLogosPending = null; });
  return remoteLogosPending;
}

// 远端额度卡：正常情况下 magpie 自己把远端 magpie 的账号卡并进 /v1/magpie/quotas；
// 它没并（新版本对旧远端/线路波动时实测只回本机卡）而看板又在 remote 归因模式下，
// 就用同一把 provider key 向同一远端要 /v1/magpie/quotas/cards，按线路前缀补进卡片
// 列表——卡片自带 icon 名，顺手喂给远端图标映射。magpie 恢复聚合后此兜底自动让位。
let remoteCards = [], remoteCardsAt = 0, remoteCardsPending = null, remoteCardsFailedAt = 0;
const REMOTE_CARDS_TTL = 5 * 60 * 1000, REMOTE_CARDS_RETRY = 2 * 60 * 1000;

function hasRemoteLineCards(list) {
  // 线路 id 从 remoteSources() 动态取（含用户自定义 id，如 office），不写死四条；
  // 线路名下的 ~keys 是本机 key 自己的预算卡，不算远端账号卡
  const ids = remoteLineIds();
  return (list || []).some((q) => {
    const p = String(q && q.provider || '').toLowerCase();
    return ids.some((id) => p.startsWith(id.toLowerCase() + '/')) && !p.endsWith('/~keys');
  });
}

async function ensureRemoteCards() {
  if (ATTRIBUTION_MODE !== 'remote') return remoteCards;
  if (Date.now() - remoteCardsAt < REMOTE_CARDS_TTL) return remoteCards;
  if (remoteCardsPending) return remoteCardsPending;
  if (Date.now() - remoteCardsFailedAt < REMOTE_CARDS_RETRY) return remoteCards;
  remoteCardsPending = (async () => {
    for (const src of orderedSources()) {
      try {
        const r = await fetch(src.base + '/v1/magpie/quotas/cards', {
          headers: { Authorization: 'Bearer ' + src.key }, signal: AbortSignal.timeout(6000),
        });
        if (!r.ok) continue;
        const j = await r.json();
        const out = [];
        const bare = [];
        for (const c of (Array.isArray(j) ? j : j.data) || []) {
          const prov = c && typeof c.provider === 'string' ? c.provider : '';
          if (!prov) continue;
          // 与 magpie 自己聚合时的口径一致：provider 加线路前缀，名字缀线路名
          out.push({ ...c, provider: src.id + '/' + prov, name: c.name ? `${c.name} · ${src.name}` : src.name, from: src.name });
          bare.push({ id: prov, icon: c.icon }); // 图标映射按裸 provider id 记
        }
        if (!out.length) continue;
        harvestRemoteLogos(bare);
        // 远端卡里还有图标没落地的品牌（icons/ 缓存缺、但旧版 logos/ 目录里有）：
        // 精确同名 → 别名/去后缀两轮补齐，与首屏注入同一套逻辑
        const legacy = loadLegacyLogos();
        for (const c of out) {
          const id = String(c.provider || '').replace(/^[^/]+\//, '').toLowerCase();
          if (!id || logoHit(id, remoteLogos)) continue;
          if (legacy[id] && !logoHit(id, remoteLogos)) { remoteLogos[id] = legacy[id]; continue; }
          const uri = legacyLogoFor(id);
          if (uri && !logoHit(id, remoteLogos)) remoteLogos[id] = uri;
        }
        // 同图别名去重（monkeycode-intl↔monkeycode…）
        for (const k of Object.keys(remoteLogos)) {
          const base = k.replace(/-(cn|intl|global|free|extra|checkin|pro|api)$/, '');
          if (base !== k && remoteLogos[base] === remoteLogos[k]) delete remoteLogos[k];
        }
        remoteCards = out;
        remoteCardsAt = Date.now();
        console.log(`[magpie-usage] quotas: +${out.length} remote provider cards from ${src.name}`);
        return remoteCards;
      } catch {}
    }
    remoteCardsFailedAt = Date.now();
    return remoteCards;
  })().finally(() => { remoteCardsPending = null; });
  return remoteCardsPending;
}

function main(resolve, reject) {
  // 口令定稿（listen 前）：显式 PAGE_KEY 环境变量优先（空串=API 开放；页面门禁只看回环
  // 绑定，不受它影响）；未设 → 每次启动生成随机 token——页面 HTML 由服务端注入，URL、
  // 日志、磁盘都不落。复用同构建实例时无需互通口令：页面由持有端口的实例自己服务。
  const envKey = process.env.PAGE_KEY;
  if (envKey !== undefined) PAGE_KEY = envKey;
  else PAGE_KEY = randomBytes(24).toString('base64url');

  // 配置定稿：manifest options（index.mjs 传入）→ 环境变量 → 内置默认
  const optStr = (o, env, dft) => { const v = o === undefined || o === null || o === '' ? env : o; return v === undefined || v === null || v === '' ? dft : String(v); };
  const attr = optStr(CFG.attribution, process.env.ATTRIBUTION, 'local').toLowerCase();
  // 远端归因 opt-in：只有显式 remote（auto 为兼容别名）才启用——它会拿本机配好的
  // remote provider key 去查远端 magpie 的请求明细。
  ATTRIBUTION_MODE = attr === 'remote' || attr === 'auto' ? 'remote' : 'local';
  REMOTE_CALLERS = optStr(CFG.remoteCallers, process.env.REMOTE_CALLERS, '').split(',').map((x) => x.trim()).filter(Boolean);
  REMOTE_PROVIDERS = optStr(CFG.remoteProviders, process.env.REMOTE_PROVIDERS, 'magpie-direct,magpie-cf,remote-magpie').split(',').map((x) => x.trim()).filter(Boolean);
  // 网关按链路解析（options → GATEWAY → MAGPIE_GATEWAY → MAGPIE_ADDR → 3425）：宿主把
  // MAGPIE_ADDR 指到哪，看板就问哪——端口改过/便携安装时写死 3425 会全盘落空。
  GATEWAY = gatewayCandidates(CFG.gateway)[0];

  loadProviderLogos();

  let startPort = null;
  const rawPort = CFG.port ?? process.env.PORT;
  if (rawPort !== undefined && rawPort !== null && rawPort !== '') {
    const n = Number(rawPort);
    if (!Number.isInteger(n) || n < 0 || n > 65535) {
      const err = new Error(`invalid PORT=${rawPort} — must be an integer 0-65535`);
      console.error(`[magpie-usage] ${err.message}`);
      reject(err);
      return;
    }
    startPort = n;
  }

  // 端口语义（与社区 page-usage-tree 一致）：目标口 = 显式 PORT / manifest options.port，
  // 否则 PORT_BASE。空闲 → 绑定；被占 → 短重试（宿主重启时上一代濒死，通常一秒内释放）；
  // 仍被占 → /api/ping 指纹互认：同一份代码（BUILD_ID 一致）→ 二次确认活着后复用；
  // 异构建或异种进程 → 明确报错。绝不向上扫描——带路页从 manifest options 读到的端口
  // 必须与绑定口一致，扫上去页面也连不上。
  const target = startPort === null ? PORT_BASE : startPort;
  const deadline = Date.now() + 8000;
  const attempt = async () => {
    const bound = await bindOnce(target);
    if (bound) return;
    const st = await probe(`${URL_HOST}:${target}`);
    if (st && st.build === BUILD_ID) {
      // 濒死实例也能应答单次探测：1.5s 后仍活着才复用；死了就继续等端口释放
      const confirm = await new Promise((r2) => setTimeout(() => probe(`${URL_HOST}:${target}`).then(r2, () => r2(null)), 1500));
      if (confirm && confirm.build === BUILD_ID) {
        console.log(`[magpie-usage] port ${target} in use by the same build (${BUILD_ID}) — reusing it`);
        resolve(target);
        return;
      }
    }
    if (Date.now() < deadline) { setTimeout(attempt, 150); return; }
    reject(new Error(st
      ? `port ${target} is held by another build of this board (build ${st.build || 'unknown'}) — free it or set PORT`
      : `port ${target} is in use and not by this board — free it or set PORT`));
  };
  attempt();

  function bindOnce(p) {
    return new Promise((res) => {
      const onListen = () => { cleanup(); finish2(server.address().port); res(true); };
      const onErr = (e) => {
        cleanup();
        if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') {
          console.log(`[magpie-usage] not started: ${e.code || e.message}`);
          reject(new Error(`not started: ${e.code || e.message}`));
          res(true); // 已 reject，外层不必重试
          return;
        }
        res(false);
      };
      const cleanup = () => { server.off('listening', onListen); server.off('error', onErr); };
      server.once('listening', onListen);
      server.once('error', onErr);
      server.listen(p, HOST);
    });
  }
  // open 日志：URL 永不带口令（?key= 已废除）——回环绑定页面免口令，非回环绑定
  // 页面不开放、API 用 x-dash-key 头。
  function openUrl(port) {
    const base = `http://${URL_HOST}:${port}/`;
    if (!LOOPBACK_BIND) return `${base}（页面仅本机可开；API 请求带 x-dash-key 头）`;
    return base;
  }
  function finish2(port) {
    console.log(`[magpie-usage] listening on http://${URL_HOST}:${port}/  gateway=${GATEWAY}  jsonl=${USAGE_JSONL}(${existsSync(USAGE_JSONL) ? 'ok' : 'missing'})  attribution=${ATTRIBUTION_MODE}  build=${BUILD_ID}`);
    console.log(`[magpie-usage] open ${openUrl(port)}`);
    server.on('error', (e) => console.log(`[magpie-usage] server error: ${e.message}`)); // 绑定后的常驻兜底
    // 预热远端 provider 图标（remote 模式下才发请求；失败不影响启动）
    ensureRemoteLogos().catch(() => {});
    resolve(port);
  }
}
let bootPromise = null;
// 返回 Promise：resolve 于首次成功监听（或确认复用同构建实例），reject 于终态启动失败。
// index.mjs 的 server() 会 await 它——magpie 在 server() 返回后立刻探测服务端口，
// 「发射后不管」会让那次探测吃 connection refused（社区生命周期契约）。
function startServer(options = {}) {
  if (bootPromise) return bootPromise;
  // manifest options 三级回退的第一级；startServer() 已启动过则忽略（bootPromise 复用）。
  // port 0 = 由系统挑随机口（测试与嵌入场景）；index.mjs 会把 options.port 的 0/非法值
  // 归成 undefined 落到默认口，页面从同一 options 读到的值与服务保持一致。
  CFG.port = options && Number.isFinite(Number(options.port)) ? Number(options.port) : null;
  CFG.attribution = options ? options.attribution : null;
  CFG.remoteCallers = options ? options.remoteCallers : null;
  CFG.remoteProviders = options ? options.remoteProviders : null;
  CFG.gateway = options ? options.gateway : null;
  bootPromise = new Promise((resolve, reject) => {
    try {
      main(resolve, reject);
    } catch (e) { reject(e); }
  });
  bootPromise.catch(() => { bootPromise = null; }); // 失败不缓存：下一次 server() 调用重试
  return bootPromise;
}

export { startServer, aggregateAttribution };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch((e) => { console.error(`[magpie-usage] not started: ${e.message}`); process.exit(1); });
}
