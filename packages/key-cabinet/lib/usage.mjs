import { magpieOk } from "./magpie-cli.mjs";

export function parseCSV(text) {
  const records = parseRecords(String(text || "").replace(/^﻿/, ""));
  const clean = records.filter((r) => {
    if (r.length !== 1) return true;
    if (r[0] === "") return false;
    // Magpie 的日志行可能混进 stdout；别让它把表头挤掉。
    return !(/^\d{4}\/\d{2}\/\d{2}/.test(r[0]) || r[0].includes("[page-project-keys]"));
  });
  if (!clean.length) return { header: [], rows: [] };
  const header = clean[0];
  const rows = clean.slice(1).map((cols) => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = cols[i] ?? ""; });
    return obj;
  });
  return { header, rows };
}

/** RFC4180-ish: 引号内允许逗号与换行（error_message 可能带换行）。 */
function parseRecords(text) {
  const records = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      records.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    records.push(row);
  }
  return records;
}

function periodArg(period) {
  if (period === "7d" || period === "30d" || period === "all" || period === "today") return period;
  return "today";
}

function emptyBucket() {
  return {
    callerKeyId: "",
    callerKeyName: "",
    calls: 0,
    errors: 0,
    tokens: 0,
    cost: 0,
    in: 0,
    out: 0,
    cacheRead: 0,
    cacheWrite: 0,
    sessions: new Set(),
  };
}

function dayKey(iso) {
  const s = String(iso || "");
  // Prefer Magpie's own YYYY-MM-DD prefix; fall back to local calendar day.
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

function localDayKey(d = new Date()) {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

function localTodayKey() {
  return localDayKey();
}

function shiftDayKey(key, n) {
  const [y, mo, d] = key.split("-").map(Number);
  const date = new Date(y, mo - 1, d);
  date.setDate(date.getDate() + n);
  return localDayKey(date);
}

function rowKey(row) {
  return row.caller_key_id || row.caller_key_name || "_";
}

function rowTokens(row) {
  return (Number(row.input_tokens || 0) || 0) + (Number(row.output_tokens || 0) || 0);
}

/**
 * 当前窗口 vs 上一个等长窗口的 tokens 变化（按 caller key）。
 * days=1 即今天对比昨天；7d/30d 即本周期对比上个周期。没有上一期数据时为 null。
 */
export function periodTrend(rows, days, todayKey = localTodayKey()) {
  const curStart = shiftDayKey(todayKey, -(days - 1));
  const prevStart = shiftDayKey(todayKey, -(2 * days - 1));
  const prevEnd = shiftDayKey(todayKey, -days);
  const cur = new Map();
  const prev = new Map();
  for (const row of rows) {
    const day = dayKey(row.time);
    if (!day) continue;
    const k = rowKey(row);
    const t = rowTokens(row);
    if (day >= curStart && day <= todayKey) {
      cur.set(k, (cur.get(k) || 0) + t);
    } else if (day >= prevStart && day <= prevEnd) {
      prev.set(k, (prev.get(k) || 0) + t);
    }
  }
  const out = new Map();
  for (const [k, value] of cur) {
    const before = prev.get(k) || 0;
    if (before > 0) out.set(k, (value - before) / before);
    else if (value > 0) out.set(k, 1);
    else out.set(k, 0);
  }
  return out;
}

function finalizeBucket(u) {
  const cacheRead = u.cacheRead || 0;
  const cacheWrite = u.cacheWrite || 0;
  const cacheDenom = cacheRead + cacheWrite;
  const cacheHitRate = cacheDenom > 0 ? cacheRead / cacheDenom : null;
  return {
    callerKeyId: u.callerKeyId,
    callerKeyName: u.callerKeyName,
    calls: u.calls,
    errors: u.errors,
    tokens: u.tokens,
    cost: u.cost,
    in: u.in,
    out: u.out,
    cacheRead,
    cacheWrite,
    sessions: u.sessions.size,
    cacheHitRate,
    trend: null,
  };
}

function emptySummary(period, extra = {}) {
  return {
    period: periodArg(period),
    totals: {
      calls: 0,
      errors: 0,
      tokens: 0,
      cost: 0,
      in: 0,
      out: 0,
      cacheRead: 0,
      cacheWrite: 0,
      sessions: 0,
      cacheHitRate: null,
    },
    byKey: {},
    ...extra,
  };
}

export function aggregateRows(rows) {
  const byKey = new Map();
  const totalSessions = new Set();
  let totals = {
    calls: 0,
    errors: 0,
    tokens: 0,
    cost: 0,
    in: 0,
    out: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };

  for (const row of rows) {
    const keyId = row.caller_key_id || "";
    const keyName = row.caller_key_name || "";
    const status = Number(row.status || 0);
    const input = Number(row.input_tokens || 0) || 0;
    const output = Number(row.output_tokens || 0) || 0;
    const cacheRead = Number(row.cache_read_tokens || 0) || 0;
    const cacheWrite = Number(row.cache_write_tokens || 0) || 0;
    // Magpie 的 tokens 口径是 input + output；cache read/write 单列展示，
    // 不能加进来（否则同一个「今日」会比 Magpie 自己大一个数量级）。
    const tokens = input + output;
    const cost = Number(row.cost_usd || 0) || 0;
    const err = status >= 400 || String(row.error).toLowerCase() === "true";
    const session = String(row.session || "").trim();
    totals.calls += 1;
    if (err) totals.errors += 1;
    totals.tokens += tokens;
    totals.cost += cost;
    totals.in += input;
    totals.out += output;
    totals.cacheRead += cacheRead;
    totals.cacheWrite += cacheWrite;
    if (session) totalSessions.add(session);

    const k = keyId || keyName || "_";
    if (!byKey.has(k)) {
      const b = emptyBucket();
      b.callerKeyId = keyId;
      b.callerKeyName = keyName;
      byKey.set(k, b);
    }
    const u = byKey.get(k);
    u.calls += 1;
    if (err) u.errors += 1;
    u.tokens += tokens;
    u.cost += cost;
    u.in += input;
    u.out += output;
    u.cacheRead += cacheRead;
    u.cacheWrite += cacheWrite;
    if (session) u.sessions.add(session);
  }

  const cacheDenom = totals.cacheRead + totals.cacheWrite;
  const finalized = {};
  for (const [k, u] of byKey) finalized[k] = finalizeBucket(u);

  return {
    totals: {
      ...totals,
      sessions: totalSessions.size,
      cacheHitRate: cacheDenom > 0 ? totals.cacheRead / cacheDenom : null,
    },
    byKey: finalized,
  };
}

// magpie usage --csv 每次都会拖起 plugin host（约 4–6s）。短缓存避免反复开页卡死。
const CACHE_TTL_MS = 45_000;
const cache = new Map(); // period -> { at, value, inflight }

async function loadCSV(periodOrArgs) {
  const args = Array.isArray(periodOrArgs)
    ? ["usage", "--csv", ...periodOrArgs]
    : ["usage", "--csv", periodArg(periodOrArgs)];
  const r = await magpieOk(args, { timeoutMs: 60_000 });
  return parseCSV(r.stdout).rows;
}

const WINDOW_DAYS = { today: 1, "7d": 7, "30d": 30 };

export async function usageByCallerKey(period = "today") {
  const p = periodArg(period);
  const days = WINDOW_DAYS[p] || null;

  // all 没有「上一期」，趋势留空。
  if (!days) {
    const agg = aggregateRows(await loadCSV(p));
    return { period: p, totals: agg.totals, byKey: agg.byKey };
  }

  const today = localTodayKey();
  const curStart = shiftDayKey(today, -(days - 1));
  // 多拉一期数据，顺便算「本周期 vs 上周期」趋势，不额外再跑一次 CLI。
  const rows = await loadCSV(["--days", String(days * 2)]);
  const currentRows = rows.filter((row) => {
    const day = dayKey(row.time);
    return day && day >= curStart && day <= today;
  });
  const agg = aggregateRows(currentRows);
  const trends = periodTrend(rows, days, today);
  for (const [k, u] of Object.entries(agg.byKey)) {
    u.trend = trends.has(k) ? trends.get(k) : null;
  }
  return { period: p, totals: agg.totals, byKey: agg.byKey };
}

async function fetchAndCache(period) {
  const key = periodArg(period);
  let entry = cache.get(key);
  if (!entry) {
    entry = { at: 0, value: null, inflight: null };
    cache.set(key, entry);
  }
  if (entry.inflight) return entry.inflight;

  entry.inflight = usageByCallerKey(key)
    .then((value) => {
      entry.at = Date.now();
      entry.value = value;
      entry.inflight = null;
      return value;
    })
    .catch((e) => {
      entry.inflight = null;
      throw e;
    });
  return entry.inflight;
}

/**
 * Soft-open: 有缓存立刻返回；无缓存时最多等 softMs，超时先回空壳并后台继续拉，
 * 避免打开插件被 magpie CLI（≈4–6s）堵死。
 */
export async function usageSummaryFallback(period = "today", { softMs = 1200, fresh = false } = {}) {
  const key = periodArg(period);
  const entry = cache.get(key);

  if (!fresh && entry?.value && Date.now() - entry.at < CACHE_TTL_MS) {
    return { ...entry.value, cached: true };
  }

  // Stale-while-revalidate: 过期也先吐旧值，后台刷新。
  if (!fresh && entry?.value) {
    fetchAndCache(key).catch(() => {});
    return { ...entry.value, cached: true, stale: true };
  }

  try {
    const pending = fetchAndCache(key);
    if (softMs <= 0) return await pending;

    const raced = await Promise.race([
      pending.then((v) => ({ ok: true, v })),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false }), softMs)),
    ]);

    if (raced.ok) return raced.v;

    pending.catch(() => {});
    return emptySummary(key, {
      pending: true,
      note: "用量汇总加载中（Magpie CLI）",
    });
  } catch (e) {
    return emptySummary(key, { error: e.message });
  }
}
