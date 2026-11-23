// 本文由AI自动生成
// 数据源读取层。每个函数都自己兜住错误：某个源坏了，返回 null 而不是抛出去。
// 面板必须能「带伤显示」——宁可少一列，不能整页白屏。

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { configDir, gatewayBase, readJsonFile, routingDir } from "./paths.mjs";

const QUOTA_TIMEOUT_MS = 6000;

/** 网关的额度快照。回环免 key；返回结构 { data: [...], object } */
export async function fetchQuotas() {
  const gw = await gatewayBase();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), QUOTA_TIMEOUT_MS);
  try {
    const res = await fetch(`${gw.base}/v1/magpie/quotas`, {
      signal: ctl.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, gateway: gw };
    }
    const body = await res.json();
    const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
    return { ok: true, accounts: list, at: new Date().toISOString(), gateway: gw };
  } catch (err) {
    const msg = err?.name === "AbortError" ? "网关 6s 无响应" : err?.message || String(err);
    return { ok: false, error: msg, gateway: gw };
  } finally {
    clearTimeout(timer);
  }
}

/** 组配置。只取路由相关字段，绝不碰 providers 里的 keys。 */
export async function readGroups() {
  const p = await readJsonFile("providers.json");
  if (!p || !Array.isArray(p.groups)) return null;
  return p.groups
    .filter((g) => g && typeof g.id === "string")
    .map((g) => ({
      id: g.id,
      name: g.name || "",
      routing: g.routing || "",
      hidden: !!g.hidden,
      members: Array.isArray(g.members) ? g.members.length : 0,
      off: Array.isArray(g.off) ? g.off.length : 0,
      accounts: Array.isArray(g.accounts) ? g.accounts.length : 0,
    }));
}

const ROUTING_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/;

async function routingFiles() {
  try {
    const names = await readdir(routingDir());
    return names
      .map((n) => {
        const m = ROUTING_FILE_RE.exec(n);
        return m ? { name: n, date: m[1], gz: !!m[2] } : null;
      })
      .filter(Boolean)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.gz === b.gz ? 0 : a.gz ? 1 : -1));
  } catch {
    return [];
  }
}

/**
 * 最近一次「magpie 真算过的」路由快照。
 * order[] 里带着 pace / used / due / rank / rest —— 这是权威值，面板不复算它。
 * 从最新文件倒着扫，找到第一条 group.id 命中且有 order 的记录就收工。
 */
export async function readSnapshot(groupId, maxFiles = 3) {
  const files = await routingFiles();
  if (!files.length) return { ok: false, error: "routing/ 目录里没有日志" };

  const tried = [];
  for (const f of files.slice(0, maxFiles)) {
    const full = join(routingDir(), f.name);
    let text;
    try {
      const buf = await readFile(full);
      text = f.gz ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
    } catch (err) {
      tried.push({ file: f.name, error: err?.message || String(err) });
      continue;
    }
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || line.charCodeAt(0) !== 123 /* { */) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const g = rec?.group;
      if (!g || g.id !== groupId) continue;
      if (!Array.isArray(rec.order) || rec.order.length === 0) continue;
      const info = await stat(full).catch(() => null);
      return {
        ok: true,
        at: rec.time || null,
        model: rec.model || "",
        agent: rec.agent || "",
        routing: g.routing || "",
        groupName: g.name || "",
        affinity: rec.affinity || "",
        order: rec.order,
        file: f.name,
        bytes: info?.size ?? null,
      };
    }
    tried.push({ file: f.name, error: "该文件里没有这个组的 order" });
  }
  return { ok: false, error: "最近 3 个日志里都没有该组的路由快照", tried };
}

/** 每日消耗增量：{ "provider|account|window": { days: {date: used}, last } } */
export async function readCreditsDaily() {
  return readJsonFile("credits-daily.json");
}

/** 剩余量历史：{ "provider|account": { window: [{at, left}] } } */
export async function readQuotaHistory() {
  return readJsonFile("quota-history.json");
}

export { configDir };
