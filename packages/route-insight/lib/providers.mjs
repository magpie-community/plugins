import fs from "node:fs";
import path from "node:path";
import { configDir } from "./store.mjs";

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// providers.json 里有供应商自己起的名字、头像（file:<hash>.svg）和线路地址，
// 头像文件就在 magpie 的 icons 目录里，插件直接拿来用，不自己画。
export function providerMeta() {
  const doc = readJson(path.join(configDir(), "providers.json"), {});
  const list = Array.isArray(doc) ? doc : Array.isArray(doc.providers) ? doc.providers : [];
  const map = new Map();
  for (const item of list) {
    if (!item || !item.id) continue;
    map.set(item.id, {
      id: item.id,
      name: item.name || item.id,
      icon: String(item.icon || "").replace(/^file:/, ""),
      endpoint: String(item.chat || item.responses || item.anthropic || ""),
      models: Array.isArray(item.models) ? item.models : [],
      off: !!item.off
    });
  }
  return map;
}

function quantile(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
}

function hostOf(url) {
  const text = String(url || "");
  if (!text) return "";
  try {
    return new URL(text).host;
  } catch {
    return text.slice(0, 40);
  }
}

// 供应商卡片：名字/头像/线路来自 providers.json，可用率和首字来自最近 7 天的真实请求。
// 「近 60 次」直接取 usage.jsonl 里这个供应商最近 60 次尝试的状态，画成条形。
export function providerCards(rows, now = Date.now()) {
  const meta = providerMeta();
  const since = now - 7 * 86400000;
  const map = new Map();
  const ensure = (id) => {
    let bucket = map.get(id);
    if (!bucket) {
      bucket = { id, n: 0, ok: 0, fail: 0, ttft: [], speed: [], credits: 0, modes: {}, models: new Map(), last: [], lastOk: 0 };
      map.set(id, bucket);
    }
    return bucket;
  };
  for (const id of meta.keys()) ensure(id);
  for (const row of rows) {
    if (!row || row.e < since) continue;
    const bucket = ensure(row.provider);
    bucket.n += 1;
    if (row.status === 200) {
      bucket.ok += 1;
      if (row.e > bucket.lastOk) bucket.lastOk = row.e;
      if (row.ttft) bucket.ttft.push(row.ttft);
      // usage.jsonl 的原始行没有 speed，得自己按 out/ms 算（stats.mjs 的 decorate 才加这个字段）
      const sp = row.speed || (row.ms ? (Number(row.out) || 0) / (row.ms / 1000) : 0);
      if (sp > 0) bucket.speed.push(sp);
    } else {
      bucket.fail += 1;
    }
    bucket.credits += Number(row.credits) || 0;
    const mode = row.mode || "credit";
    bucket.modes[mode] = (bucket.modes[mode] || 0) + 1;
    const model = row.served || row.model;
    if (model) bucket.models.set(model, (bucket.models.get(model) || 0) + 1);
    bucket.last.push({ e: row.e, status: row.status, ttft: row.ttft || 0, model: model || "" });
  }
  const cards = [];
  for (const [id, bucket] of map) {
    const info = meta.get(id) || { id, name: id, icon: "", endpoint: "", models: [], off: false };
    bucket.last.sort((a, b) => a.e - b.e);
    const modes = Object.keys(bucket.modes).sort((a, b) => bucket.modes[b] - bucket.modes[a]);
    cards.push({
      id,
      name: info.name,
      icon: info.icon ? "/icons/" + info.icon : "",
      endpoint: hostOf(info.endpoint),
      declared: info.models.slice(0, 8),
      off: info.off,
      models: [...bucket.models.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map((pair) => pair[0]),
      n: bucket.n,
      ok: bucket.ok,
      fail: bucket.fail,
      availability: bucket.n ? bucket.ok / bucket.n : null,
      ttftP50: quantile(bucket.ttft, 0.5),
      ttftP90: quantile(bucket.ttft, 0.9),
      speed: bucket.speed.length ? Math.round(bucket.speed.reduce((sum, v) => sum + v, 0) / bucket.speed.length) : 0,
      credits: bucket.credits,
      mode: modes[0] || "",
      idleMs: bucket.lastOk ? now - bucket.lastOk : null,
      last60: bucket.last.slice(-60)
    });
  }
  return cards.sort((a, b) => b.n - a.n || String(a.name).localeCompare(String(b.name)));
}
