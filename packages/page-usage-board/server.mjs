#!/usr/bin/env node
// magpie 用量看板 — 零依赖，Node 18+/Bun 均可运行
// 环境变量：HOST、PORT(不设则从 3455 起自动挑第一个空闲口；设了就严格用它)、
//          GATEWAY(上游网关)、MAGPIE_KEY(网关 key，本地不需要)、USAGE_JSONL、
//          PAGE_KEY(页面访问口令，不设则启动时生成随机 32 位 hex 并落盘；显式设为空串则开放)、
//          PAGE_KEY_FILE(口令落盘位置)、ALLOWED_HOSTS(反代域名白名单，逗号分隔)、
//          DATA_DIR(生成物目录)、LOGOS=0(跳过品牌图标扫描)
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { chmodSync, createReadStream, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '127.0.0.1';
// 插件模式 = 由 magpie 宿主拉起（容器/桌面都会设 MAGPIE_ADDR）：宿主重启插件时上一代
// 进程是「濒死」而非立即退出，base 口会短暂被占——见 tryBind 里的等待重试
const PLUGIN_MODE = !!process.env.MAGPIE_ADDR;
// 日志与带路页里对外展示的 host：监听 0.0.0.0/:: 这类地址时展示成 127.0.0.1，IPv6 补方括号
const URL_HOST = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : (HOST.includes(':') ? `[${HOST}]` : HOST);
// 只有回环绑定才允许匿名 GET / 直接拿到看板（口令注入返回的 HTML）；公网实例必须先带口令，
// 否则等于向任何访问者公开页面数据和口令。
const LOOPBACK_BIND = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
// 注意：'::' 与 0.0.0.0 同为通配监听（dual-stack），绝不能算回环——否则公网实例会匿名
// 交出注入了口令的页面（P0 复审项）；需要通配监听时请显式设 ALLOWED_HOSTS 并依赖口令。
const GATEWAY = (process.env.GATEWAY || 'http://127.0.0.1:3425').replace(/\/+$/, '');
const KEY = process.env.MAGPIE_KEY || '';
const USAGE_JSONL = process.env.USAGE_JSONL || [
  path.join(os.homedir(), '.config', 'magpie', 'usage.jsonl'),
  path.join(ROOT, '..', 'usage.jsonl'),
  path.join(ROOT, '..', 'magpie', 'usage.jsonl'),
].find((f) => existsSync(f)) || path.join(os.homedir(), '.config', 'magpie', 'usage.jsonl');
// 页面访问口令：未设 PAGE_KEY → 启动生成随机 32 位 hex 并落盘 KEY_FILE（复用已有实例的进程靠它拼完整地址）；
// 显式设为空串 → 页面开放（保留旧语义）。实际取值在底部 main() 里定稿（listen 之前）。
let PAGE_KEY = '';
// 未设 PORT：从 PORT_BASE 起向上找第一个空闲口；设了 PORT：严格用它（被占保留原有 error 日志行为）
const PORT_BASE = 3455;
const PORT_SPAN = 21;
// 生效口令落盘位置（与 usage.jsonl 同目录；测试可用 PAGE_KEY_FILE 覆盖）
const KEY_FILE = process.env.PAGE_KEY_FILE || path.join(os.homedir(), '.config', 'magpie', 'usage-page-key');
// 本机直连/远端的口径：usage.jsonl 里这些 provider 的流量记为「走远端」（其余为直连）
const REMOTE_PROVIDERS = (process.env.REMOTE_PROVIDERS || 'magpie-direct,magpie-cf,remote-magpie,magpie-2').split(',').map((x) => x.trim()).filter(Boolean);
// Host 校验：默认只认识回环名。反代或非回环部署时用 ALLOWED_HOSTS=域名1,域名2 显式放行。
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const STATIC_DIR = path.join(ROOT, 'static');
// 品牌 logo 自动生成：包内不带 logos，启动时扫用户已装的插件包（node_modules 递归 + EXTRA_DIRS），
// 生成 <data-dir>/logos/<substance>.<ext> + manifest.json。三层来源（详见 scanLogos）：
//   ① package.json 的 magpie.icon / icon（data URI 或 URL，url 下载失败则跳过）
//   ② 包内 assets/ 下的图片文件
//   ③ 包源码文本里的内联 data URI（OFFICEACE_ICON 这类声明常量）
// 页面 brandIcon() 的兜底匹配链不变。LOGOS_FORCE=1 强制重扫。
const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), '.config', 'magpie', 'usage-board');
const LOGOS_DIR = path.join(DATA_DIR, 'logos');
const EXTRA_DIRS = (process.env.EXTRA_DIRS || '').split(',').map(x => x.trim()).filter(Boolean);

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
    return { daily: [], heat, recent: [], error: '日志读取失败(' + ((e && e.code) || (e && e.message) || '?') + ')' };
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
    return { hours: [], error: '日志读取失败(' + ((e && e.code) || (e && e.message) || '?') + ')' };
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
const MAGPIE_PROVIDERS = process.env.MAGPIE_PROVIDERS || path.join(os.homedir(), '.config', 'magpie', 'providers.json');
const ATTRIBUTION_MODE = process.env.ATTRIBUTION || 'auto';

function remoteSources() {
  if (ATTRIBUTION_MODE === 'local') return [];
  const callers = (process.env.REMOTE_CALLERS || 'cloud,Magpie').split(',').map((x) => x.trim()).filter(Boolean);
  const out = [];
  const push = (base, key) => {
    const b = String(base || '').replace(/\/+$/, '').replace(/\/v1$/, '');
    let u; try { u = new URL(b); } catch { return; }
    // Bearer key 只走 https；明文 http 仅限本机回环（本地测试用）
    if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost', '::1'].includes(u.hostname)) return;
    if (key && !out.some((x) => x.base === b && x.key === key)) out.push({ base: b, key, callers });
  };
  if (process.env.REMOTE_BASE && process.env.REMOTE_KEY) {
    // 显式 override 独占：设置 REMOTE_BASE/KEY 时不再读 providers.json（文档承诺的语义）
    push(process.env.REMOTE_BASE, process.env.REMOTE_KEY);
    return out;
  }
  try {
    const j = JSON.parse(readFileSync(MAGPIE_PROVIDERS, 'utf8'));
    for (const p of j.providers || []) {
      if (!p || !p.key || !/^https?:\/\//.test(String(p.chat || p.responses || ''))) continue;
      if (p.preset !== 'remote-magpie' && p.id !== 'magpie-direct' && p.id !== 'magpie-cf') continue;
      push(p.chat || p.responses, p.key);
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

function authed(req, url) {
  if (!PAGE_KEY) return true;
  if (sameKey(req.headers['x-dash-key'] || '')) return true;
  const cookie = req.headers.cookie || '';
  for (const c of cookie.split(/;\s*/)) {
    const eq = c.indexOf('=');
    if (eq > 0 && c.slice(0, eq) === 'dk') {
      let v = c.slice(eq + 1);
      try { v = decodeURIComponent(v); } catch {}
      if (sameKey(v)) return true;
    }
  }
  return sameKey(url.searchParams.get('key') || '');
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
function originOk(req) {
  const o = req.headers.origin;
  if (!o || o === 'null') return true;
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(o);
}

// 沙盒 frame（插件页面导航过来，opaque origin）跨源 fetch：允许 Origin: null，
// key 走 x-dash-key 头（opaque origin 无 cookie）。其它 origin 一律不给 ACAO。
function cors(req, res) {
  const o = req.headers.origin;
  const allow = (v) => {
    res.setHeader('Access-Control-Allow-Origin', v);
    res.setHeader('Vary', 'Origin');
    return true;
  };
  if (o === undefined || o === 'null') return allow('null');
  // 本机看板（127.0.0.1 / localhost 的任意端口）要跨源拉 /api/attribution；
  // 数据本身仍要 ?key=，这里只决定浏览器能不能读到响应。
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(o)) return allow(o);
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
    if (p === '/api/ping') return json(res, 200, { service: 'magpie-usage', ok: true });
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
    // health 免鉴权：vps-init.sh 探活与同款服务识别都依赖匿名访问（响应里无口令、无用量数据）
    if (p === '/api/health') return json(res, 200, { ok: true, jsonl: existsSync(USAGE_JSONL) });
    if (!authed(req, url)) return json(res, 401, { error: '需要访问口令：URL 后加 ?key=…' });
    try {
      if (p === '/api/quotas') {
        const [r, lim] = await Promise.all([
          upstream('/v1/magpie/quotas'),
          upstream('/v1/magpie/limit?format=json').catch(() => null),
        ]);
        const out = { ...r.json };
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
        const notes = [u.code === 200 ? undefined : '用量接口 ' + (u.code || '无响应'), detail && detail.error].filter(Boolean);
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
            return json(res, 200, data);
          } catch (e) {
            return json(res, 502, { error: 'remote attribution: ' + String(e && e.message || e) });
          }
        }
        const callers = (url.searchParams.get('caller') || '').split(',').map((x) => x.trim()).filter(Boolean);
        const data = await readAttribution(period, days, callers);
        if (!data) return json(res, 503, { error: 'usage.jsonl 读不到' });
        return json(res, 200, data);
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      return json(res, 502, { error: String(e && e.message || e) });
    }
  }

  // 页面访问口令：通过 ?key= 时种 cookie（key 含 cookie 非法字符时跳过——头/URL 鉴权仍可用，避免 setHeader 抛错）
  if (PAGE_KEY && /^[!-~]+$/.test(PAGE_KEY) && sameKey(url.searchParams.get('key') || '')) {
    // 值编码（自定义 key 可能含特殊字符）；声明了公共名（ALLOWED_HOSTS）≈ 有 https 反代 → 加 Secure
    res.setHeader('Set-Cookie', `dk=${encodeURIComponent(PAGE_KEY)}; Path=/; HttpOnly; Max-Age=31536000; SameSite=Lax${ALLOWED_HOSTS.length ? '; Secure' : ''}`);
  }

  let file = p === '/' ? '/index.html' : p;
  if (file.startsWith('/static/')) file = file.slice('/static'.length);
  // /logos/* 由 DATA_DIR 提供（运行时扫描产物）；其余静态资源来自包内 static/
  // （前缀必须剥掉：resolve(base, './logos/x.png') 会多套一层 logos/ → 404）
  let base = STATIC_DIR;
  if (file.startsWith('/logos/')) { base = LOGOS_DIR; file = file.slice('/logos'.length); }
  const full = path.resolve(base, '.' + file);
  // 穿越守卫按各自 base 计算（logos 在 DATA_DIR 下，对 STATIC_DIR 求相对路径恒为 .. → 全部 404）
  const rel = path.relative(base, full);
  let isFile = false;
  try { isFile = !rel.startsWith('..') && !path.isAbsolute(rel) && statSync(full).isFile(); } catch {}
  if (!isFile) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
  // 页面本身不要求口令（与社区 page-usage-tree 一致）：回环绑定直接返回看板，
  // 由服务端把口令注入 HTML；公网绑定仍要求口令，避免把数据和口令交给匿名访问者。
  // 这只拦跨源 fetch（Origin 非空且不是本机），顶层导航不带 Origin，不受影响。
  if (file === '/index.html' && !originOk(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('cross-origin page read not allowed');
  }
  // 口令门只拦看板页本身：它内联了全量数据和口令。static/ 下的 echarts、logo 等
  // 不含数据，匿名可取——沙盒 frame 不带 cookie，旧的"子资源 URL 带 key"做法会把
  // 口令泄进代理日志，已废弃。
  // 匿名页面门只在「插件模式 + 未声明公共名」时开放：magpie 宿主是外层门，本机用户
  // 即所有者。独立部署（node server.mjs/systemd/Docker）即使回环绑定，设置了 PAGE_KEY
  // 就必须带口令——同机反代把 Host 改写成 127.0.0.1 时（nginx 默认 $proxy_host 即是），
  // 匿名页面门会被经代理的匿名请求命中（P1 复审实测绕过）。
  const openPage = file === '/index.html' && LOOPBACK_BIND && ALLOWED_HOSTS.length === 0 && PLUGIN_MODE;
  if (file === '/index.html' && PAGE_KEY && !authed(req, url) && !openPage) { res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('需要访问口令：在 URL 后加 ?key=…'); }

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
      if (u.code !== 200) note = '用量接口 ' + u.code;
    } catch (e) { note = String(e && e.message || e); }
    const trap = '<script>window.__errs=[];window.addEventListener("error",function(e){var m=e.message||((e.target&&e.target.src||e.target&&e.target.href)?("resource: "+(e.target.src||e.target.href)):"");if(!m)return;if(e.target&&(e.target.dataset&&e.target.dataset.missing||/remote\.js|cloudflareinsights\.com/.test(e.target.src||e.target.href||"")))return;window.__errs.push(m+" @ "+(e.filename||"")+":"+(e.lineno||0)+":"+(e.colno||0))},true);window.addEventListener("unhandledrejection",function(e){window.__errs.push("PROMISE: "+String(e.reason&&e.reason.message||e.reason))});<\/script>';
    // 品牌 logo 映射：运行时扫描产出（DATA_DIR/logos/manifest.json），不再由部署期注入
    let qlogos = {};
    try { qlogos = JSON.parse(readFileSync(path.join(LOGOS_DIR, 'manifest.json'), 'utf8')); } catch {}
    const inject = `<script>window.__DATA__=${JSON.stringify(data).replace(/</g, '\\u003c')};window.__NOTE__=${JSON.stringify(note)};window.QLOGOS=${JSON.stringify(qlogos).replace(/</g, '\\u003c')};</script>`;
    // 页面需要的口令只出现在这份 HTML 里；API 路由仍校验它，URL/书签里不出现
    const keyInject = PAGE_KEY ? `<script>window.__KEY__=${JSON.stringify(PAGE_KEY).replace(/</g, '\\u003c')};</script>` : '';
    html = html.replace('<head>', () => '<head>' + keyInject + trap + inject);
    // 插件页（沙盒 frame）里 magpie 会等 bridge 的 hello，等不到就 10s 判死。iOS Safari
    // 下插件页自己的 <script> 会被 WebKit 的 CSP 来源匹配拦掉，所以由本页补发一次 hello。
    const hello = `<script>(function(){if(window.parent===window)return;function s(){try{parent.postMessage({magpie:1,id:1,method:"hello"},"*")}catch(e){}}s();setTimeout(s,3000);setTimeout(s,8000)})();<\/script>`;
    html = html.replace('</head>', () => hello + '</head>');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // 页面脚本全是同源文件 + 少量内联（数据注入 / bridge hello）；数据获取都是同源
      // /api/*，connect-src 只放行本源和 CF 统计信标（sendBeacon 也受 connect-src 管辖）
      'Content-Security-Policy': "default-src 'self' data:; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://static.cloudflareinsights.com; object-src 'none'; base-uri 'none'",
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
// 占用基准口的是不是本服务的旧实例：1=v2 同款（/api/ping 报身份）、0=v1 旧版（仅 health 指纹）、-1=异种。
// v1 对 ping 会回 401 JSON（fetch 不抛错），所以 ping 无指纹时必须降级再试 health，不能直接判异种。
// health 历来匿名可读、body 不含口令，可安全指纹。v1 没有口令机制，复用它时地址不带 key。
async function probe(hp) {
  try {
    const j = await (await fetch(`http://${hp}/api/ping`, { signal: AbortSignal.timeout(1200) })).json();
    if (j && j.service === 'magpie-usage') return 1;
  } catch {}
  try {
    const j = await (await fetch(`http://${hp}/api/health`, { signal: AbortSignal.timeout(1200) })).json();
    if (j && j.ok === true && 'gateway' in j) return 0;
  } catch {}
  return -1;
}
const persistKey = () => {
  try { mkdirSync(path.dirname(KEY_FILE), { recursive: true }); writeFileSync(KEY_FILE, PAGE_KEY, { mode: 0o600 }); try { chmodSync(KEY_FILE, 0o600); } catch {} } catch {}
};

// ---- 品牌 logo 自动生成 ----
const ICON_MIME = { 'image/png':'png', 'image/svg+xml':'svg', 'image/jpeg':'jpg', 'image/webp':'webp', 'image/x-icon':'ico', 'image/vnd.microsoft.icon':'ico' };
function subOf(pkgName, dirName) {
  let s = String(pkgName || dirName || '');
  s = s.replace(/^@[^/]+\//, '');
  s = s.replace(/^(opencode-|magpie-|my-|@roadkid\/opencode-)/, '');
  s = s.replace(/-(auth|plugin|page|free-auth)$/i, '');
  // 第三方包名不可信：白名单净化，防 writeLogo 路径穿越（../、/、空字节等一律丢弃）
  s = s.toLowerCase().replace(/[^a-z0-9_-]/g, '').replace(/^[.-]+/, '').slice(0, 40);
  return s;
}
function scanLogos() {
  const out = {};
  const roots = [];
  const nm = path.join(os.homedir(), '.config', 'magpie', 'plugins', 'node_modules');
  if (existsSync(nm)) roots.push(nm);
  // 本插件的同级目录（~/.config/magpie/my-* 或容器 /config/my-*）：宿主把插件都装在这层
  const siblings = path.dirname(ROOT);
  if (existsSync(siblings) && !roots.includes(siblings)) roots.push(siblings);
  for (const d of EXTRA_DIRS) if (existsSync(d)) roots.push(d);
  const dataUri = /data:(image\/[a-z+]+(?:\+xml)?);base64,([A-Za-z0-9+/=]{100,})/g;
  for (const root of roots) {
    for (const pj of walkFiles(root, 'package.json', 4)) {
      const dir = path.dirname(pj);
      let pkg = {};
      try { pkg = JSON.parse(readFileSync(pj, 'utf8')); } catch { continue; }
      const sub = subOf(pkg.name, path.basename(dir));
      if (!sub || out[sub]) continue;
      // ① 声明字段
      const declared = (pkg.magpie || {}).icon || pkg.icon;
      if (declared) {
        if (declared.startsWith('data:')) {
          const m = declared.match(/^data:([^;,]+)(;base64)?,/);
          const ext = m && (ICON_MIME[m[1]] || (m[1].includes('svg') ? 'svg' : null));
          if (ext) {
            // data URI 载荷 = 第一个逗号之后的全部内容（split(,,1) 的 [1] 是 undefined，
            // URL 编码型图标曾被写成 0 字节文件 → manifest 引用空文件 → 加载失败）
            try {
              const raw = declared.slice(declared.indexOf(',') + 1);
              const buf = m[2] ? Buffer.from(raw, 'base64') : Buffer.from(decodeURIComponent(raw), 'utf8');
              if (buf.length && buf.length <= 2 * 1024 * 1024) { writeLogo(sub, ext, buf); out[sub] = 'logos/' + sub + '.' + ext; } // 解码后 2MB 上限
            } catch {}
            continue;
          }
        } else if (/^https?:\/\//.test(declared)) { fetchOne(sub, declared, out); continue; }
      }
      // ② assets/ 下的图片
      const assets = path.join(dir, 'assets');
      if (existsSync(assets)) {
        const img = walkFiles(assets, null, 2).find(f => /\.(png|svg|webp|ico|jpg)$/i.test(f));
        if (img) { const ext = img.match(/\.(png|svg|webp|ico|jpg)$/i)[1].toLowerCase(); writeLogo(sub, ext, readFileSync(img)); out[sub] = 'logos/' + sub + '.' + ext; continue; }
      }
      // ③ 源码内联 data URI（跳过 node_modules 嵌套与 .test.）
      for (const f of walkFiles(dir, null, 2)) {
        if (!/\.(mjs|js|ts)$/.test(f) || /\.test\./.test(f)) continue;
        let text = ''; try { text = readFileSync(f, 'utf8'); } catch { continue; }
        dataUri.lastIndex = 0;
        const m = dataUri.exec(text);
        if (m) { const ext = ICON_MIME[m[1]] || (m[1].includes('svg') ? 'svg' : null); if (ext) { writeLogo(sub, ext, Buffer.from(m[2], 'base64')); out[sub] = 'logos/' + sub + '.' + ext; } break; }
      }
    }
  }
  // 兜底：DATA_DIR/logos 里已有的历史产出按文件名预置（避免每次启动重新下载 favicon）；扫描到的新品牌不覆盖
  try {
    for (const f of readdirSync(LOGOS_DIR)) {
      const dot = f.lastIndexOf('.');
      if (dot <= 0) continue;
      const sub = f.slice(0, dot), ext = f.slice(dot + 1);
      if (out[sub]) continue;
      // 0 字节文件（历史解析 bug 产物）不预置——让提取阶段重新生成
      try { if (!statSync(path.join(LOGOS_DIR, f)).size) continue; } catch { continue; }
      if (['png', 'svg', 'ico', 'jpg', 'webp'].includes(ext)) out[sub] = 'logos/' + f;
    }
  } catch {}
  try { mkdirSync(LOGOS_DIR, { recursive: true }); writeFileSync(path.join(LOGOS_DIR, 'manifest.json'), JSON.stringify(out)); } catch {}
  console.log(`[magpie-usage] logos: ${Object.keys(out).length} brands → ${LOGOS_DIR}`);
}
function walkFiles(dir, only, depth) {
  if (depth <= 0) return [];
  let out = [];
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walkFiles(full, only, depth - 1));
    else if (!only || e.name === only) out.push(full);
  }
  return out;
}
function writeLogo(sub, ext, buf) {
  try { mkdirSync(LOGOS_DIR, { recursive: true }); writeFileSync(path.join(LOGOS_DIR, sub + '.' + ext), buf); } catch {}
}
function fetchOne(sub, url, out) {
  if (!/^https:\/\//.test(url)) return; // 品牌图标只从 https 下载
  if (out[sub]) return; // 本轮已有（扫描阶段命中或已下载）——不重复下载
  fetch(url, { signal: AbortSignal.timeout(10000) })
    .then(r => (r.ok ? r.arrayBuffer() : null))
    .then(ab => { if (ab && ab.byteLength > 200 && ab.byteLength <= 2 * 1024 * 1024) { const ext = (/\.ico($|\?)/.test(url) ? 'ico' : /\.svg/.test(url) ? 'svg' : 'png'); writeLogo(sub, ext, Buffer.from(ab)); out[sub] = 'logos/' + sub + '.' + ext; try { writeFileSync(path.join(LOGOS_DIR, 'manifest.json'), JSON.stringify(out)); } catch {} } })
    .catch(() => {});
}
function ensureLogos() {
  if (process.env.LOGOS === '0') return; // 测试/无图标场景：不扫 node_modules
  try {
    // 每次启动都重扫：用户会新装/卸载插件，logo 集应跟随变化（fetchOne 有缓存跳过，不会反复下载）
    scanLogos();
  } catch (e) { console.log('[magpie-usage] logos scan failed:', e.message || e); }
}
function main(resolve, reject) {
  // 实际生效口令在此定稿（listen 前）：显式设了 PAGE_KEY 用设的（空串=开放）；
  // 未设 → 落盘口令，没有则生成随机 32 位 hex 并落盘（复用已有实例的下次启动靠落盘文件拼完整地址）
  ensureLogos();
  const envKey = process.env.PAGE_KEY;
  // 口令来源：'env'=显式设置 | 'new'=本轮新生成 | 'disk'=从落盘读回 | ''=开放。
  // 决定非回环绑定时 open 日志是否带 key：只有 env/new 才打（独立部署用户取口令的
  // 唯一渠道），disk 不重复刷屏（P1 修复：原实现每次启动都把口令明文打进日志）。
  let keySource = '';
  if (envKey !== undefined) { PAGE_KEY = envKey; if (PAGE_KEY) keySource = 'env'; }
  else {
    try { PAGE_KEY = readFileSync(KEY_FILE, 'utf8').trim(); } catch {}
    if (/^[0-9a-f]{32}$/.test(PAGE_KEY)) keySource = 'disk';
    else { PAGE_KEY = randomBytes(16).toString('hex'); keySource = 'new'; }
    persistKey();
  }
  let startPort = null;
  if (process.env.PORT !== undefined) {
    const n = Number(process.env.PORT);
    if (!Number.isInteger(n) || n < 0 || n > 65535) {
      const err = new Error(`invalid PORT=${process.env.PORT} — must be an integer 0-65535`);
      console.error(`[magpie-usage] ${err.message}`);
      reject(err);
      return;
    }
    startPort = n;
  }
  // 端口状态机：base 空闲→用它；base 被同款占用→复用（既定语义，不报错）；被异种占用→向上找空闲口；
  // 自动模式扫满仍无空口 → listen(0) 由系统挑。显式 PORT 只试一次，被占保留原 error 日志行为。
  // listening 回调只挂一次：listen(port, cb) 的 cb 是 once('listening')，失败尝试残留的 cb
  // 会在后续成功 listen 时重复触发（实测日志双打）。
  server.once('listening', () => finish2(server.address().port));
  let baseWait = 0;
  const tryBind = (p) => {
    server.listen(p, HOST);
    server.once('error', function onErr(e) {
      if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') { console.log(`[magpie-usage] not started: ${e.code || e.message}`); reject(new Error(`not started: ${e.code || e.message}`)); return; }
      // 宿主重启竞态：插件模式下 base 口被占，多半是上一代同款实例濒死（能应答 ping 却
      // 马上退出——复用它会让端口随后死掉，502）。先轮询等它退出再绑定，最多 ~8s；
      // 真有别的同款实例常驻时，超时后落入既有探测/复用逻辑。带路页与 manifest 都指向
      // base 口，不能向上扫描。
      if (PLUGIN_MODE && p === PORT_BASE && startPort === null && baseWait < 8000) {
        baseWait += 800;
        console.log(`[magpie-usage] port ${PORT_BASE} busy — waiting for the previous instance to exit (${baseWait / 800}/24)`);
        setTimeout(() => tryBind(p), 800);
        return;
      }
      if (p === PORT_BASE && startPort === null) {
        probe(`${URL_HOST}:${PORT_BASE}`).then(async (kind) => {
          if (kind >= 0) { // 同款（v2/v1 旧版）→ 静默复用，这是与 systemd/手动 node 并存的既定语义
            // 濒死实例也能应答单次探测：1.5s 后二次确认仍活着才复用；死了就继续等端口释放
            const confirm = await new Promise((r2) => setTimeout(() => probe(`${URL_HOST}:${PORT_BASE}`).then(r2, () => r2(-1)), 1500));
            if (confirm < 0 && baseWait < 60000) {
              baseWait += 1500;
              setTimeout(() => tryBind(PORT_BASE), 1000);
              return;
            }
            console.log(`[magpie-usage] port ${PORT_BASE} in use by another usage server${kind === 0 ? ' (v1, no key)' : ''} — reusing it`);
            console.log(`[magpie-usage] open ${openUrl(PORT_BASE, kind === 1)}`);
            if (envKey === undefined) persistKey(); // 这轮定稿的 key 落盘，给复用实例的下次启动用
            resolve(PORT_BASE);
          } else tryBind(p + 1); // 异种占用 → 向上找空闲口
        }).catch(() => tryBind(p + 1)); // 探测本身异常 → 视为异种占用继续扫描
      } else if (startPort === null && p < PORT_BASE + PORT_SPAN) {
        // 插件模式下向上扫描无意义：带路页与 manifest 都指向 base 口，扫上去页面也连不上
        if (PLUGIN_MODE && p === PORT_BASE) {
          const err = new Error(`port ${PORT_BASE} is busy and the lead page targets it — free the port or set PORT explicitly`);
          console.log(`[magpie-usage] not started: ${err.message}`);
          reject(err);
          return;
        }
        tryBind(p + 1); // 自动模式继续向上扫
      } else if (startPort === null) {
        server.listen(0, HOST); // 扫满仍无空口 → 系统挑
      } else {
        console.log(`[magpie-usage] not started: ${e.code || e.message} (PORT=${p} 被占用)`);
        reject(new Error(`not started: ${e.code || e.message} (PORT=${p} in use)`));
      }
    });
  };
  // open 日志的访问地址：回环绑定一律不带 key（页面由服务端注入口令，URL 无需传）；
  // 非回环仅在口令「显式设置或本轮新生成」时打一次带 key 的完整地址，从落盘读回的
  // 老口令不重复打印、只提示落盘位置；v1 复用（withKey=false）无口令机制，同样不带。
  function openUrl(port, withKey = true) {
    const base = `http://${URL_HOST}:${port}/`;
    if (!PAGE_KEY) return `${base}（无口令开放）`;
    if (LOOPBACK_BIND || !withKey) return base;
    // 环境变量设置的 key 不进日志（操作者本就知道它）；只有本轮新生成的 key 打一次完整地址
    if (keySource === 'new') return `${base}?key=${PAGE_KEY}`;
    return `${base}（口令见 PAGE_KEY 环境变量 / ${KEY_FILE}）`;
  }
  // 绑定成功：日志打印实际生效的访问地址（是否含 key 见 openUrl）；带路页只写固定端口，
  // 口令由服务端注入返回的 HTML，所以这里不再改写任何页面文件。
  function finish2(port) {
    console.log(`[magpie-usage] listening on http://${URL_HOST}:${port}/  gateway=${GATEWAY}  jsonl=${USAGE_JSONL}(${existsSync(USAGE_JSONL) ? 'ok' : 'missing'})  plugin=${PLUGIN_MODE}`);
    console.log(`[magpie-usage] open ${openUrl(port)}`);
    server.on('error', (e) => console.log(`[magpie-usage] server error: ${e.message}`)); // 绑定后的常驻兜底
    resolve(port);
  }
  if (startPort !== null) tryBind(startPort);
  else tryBind(PORT_BASE);
}
let bootPromise = null;
// 返回 Promise：resolve 于首次成功监听（或确认复用同款实例），reject 于终态启动失败。
// index.mjs 的 server() 会 await 它——magpie 在 server() 返回后立刻探测服务端口，
// 「发射后不管」会让那次探测吃 connection refused（社区生命周期契约）。
function startServer() {
  if (bootPromise) return bootPromise;
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
