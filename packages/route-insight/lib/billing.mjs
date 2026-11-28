import fs from "node:fs";
import { configFile } from "./store.mjs";

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function balanceOf(text) {
  if (typeof text !== "string") return null;
  const match = text.match(/-?[0-9]+(?:\.[0-9]+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

// providers.json 里有供应商自己起的名字，看板显示中文名而不是 id。
export function readProviders() {
  const doc = readJsonFile(configFile("providers.json"), {});
  const list = Array.isArray(doc) ? doc : Array.isArray(doc.providers) ? doc.providers : [];
  const map = new Map();
  for (const item of list) {
    if (!item || !item.id) continue;
    map.set(item.id, {
      id: item.id,
      name: item.name || item.id,
      icon: item.icon || "",
      keys: Array.isArray(item.keys) ? item.keys.length + 1 : 1,
      off: !!item.off
    });
  }
  return map;
}

// 计费方式不是一种：余额（中转站按 $ 扣）、额度（5 小时 / 7 天窗口）、积分（网关自己的 credits）。
export function readBilling(now = Date.now()) {
  const quotas = readJsonFile(configFile("quotas.json"), {});
  const providers = readProviders();
  const map = new Map();
  for (const [key, entry] of Object.entries(quotas || {})) {
    const quota = (entry && entry.quota) || {};
    const id = quota.provider || String(key).split("/")[0];
    if (!id) continue;
    const item = map.get(id) || {
      id,
      name: quota.name || (providers.get(id) || {}).name || id,
      balance: null,
      balanceText: "",
      keys: 0,
      windows: [],
      readAt: ""
    };
    item.keys += 1;
    const amount = balanceOf(quota.balance);
    if (amount !== null) {
      item.balance = (item.balance === null ? 0 : item.balance) + amount;
      item.balanceText = item.balance === null ? "" : "$" + item.balance.toFixed(2);
    }
    if (Array.isArray(quota.windows) && quota.windows.length) {
      item.windows = quota.windows
        .filter((w) => w && typeof w.name === "string")
        .map((w) => ({ name: w.name, used: Number(w.used) || 0, resetsAt: w.resetsAt || "" }));
    }
    const at = typeof entry.at === "string" ? entry.at : "";
    if (at > item.readAt) item.readAt = at;
    map.set(id, item);
  }
  const list = [...map.values()].map((item) => {
    const mode = item.windows.length ? "window" : item.balance !== null ? "balance" : "credit";
    return {
      id: item.id,
      name: item.name,
      mode,
      balance: item.balance,
      balanceText: item.balance === null ? "" : "$" + item.balance.toFixed(2),
      keys: item.keys,
      windows: item.windows,
      readAt: item.readAt,
      ageSec: item.readAt ? Math.max(0, Math.round((now - Date.parse(item.readAt)) / 1000)) : null
    };
  });
  list.sort((a, b) => (a.mode === b.mode ? a.name.localeCompare(b.name) : a.mode.localeCompare(b.mode)));
  const byId = {};
  for (const item of list) byId[item.id] = item;
  return { at: new Date(now).toISOString(), providers: byId, order: list.map((item) => item.id) };
}

export const MODE_LABELS = { balance: "余额", window: "额度", credit: "积分" };

// 没有配额记录的供应商（比如自建中转）按积分算。
export function modeOf(billing, providerId) {
  const item = billing && billing.providers ? billing.providers[providerId] : null;
  return item ? item.mode : "credit";
}
