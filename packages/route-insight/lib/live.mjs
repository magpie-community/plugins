import { readJson } from "./store.mjs";

// quotas.json 是「provider/key → 最近一次读到的额度」，这里按供应商去重取最新一条。
export function readQuotas() {
  const raw = readJson("quotas.json", {});
  const latest = new Map();
  for (const entry of Object.values(raw || {})) {
    const quota = entry && entry.quota;
    if (!quota || !quota.provider) continue;
    const at = Date.parse((entry && entry.at) || quota.readAt || "") || 0;
    const kept = latest.get(quota.provider);
    if (!kept || at > kept.at) latest.set(quota.provider, { at, quota });
  }
  return [...latest.values()]
    .map(({ at, quota }) => ({
      provider: quota.provider,
      name: quota.name || quota.provider,
      balance: quota.balance || "",
      at: at ? new Date(at).toISOString() : "",
      windows: (quota.windows || []).map((win) => ({
        name: win.name || "",
        used: typeof win.used === "number" ? win.used : null,
        remaining: typeof win.remaining === "number" ? win.remaining : null,
        resetsAt: win.resetsAt || null
      }))
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

// rests.json 里是「某席位正在休息到什么时候」，空对象就是没人休息。
export function readRests(now = Date.now()) {
  const raw = readJson("rests.json", {});
  const out = [];
  for (const [key, value] of Object.entries(raw || {})) {
    const until = typeof value === "number" ? value : Date.parse((value && (value.until || value.at)) || "") || 0;
    if (!until || until < now) continue;
    out.push({ key, until: new Date(until).toISOString(), seconds: Math.round((until - now) / 1000), reason: (value && value.reason) || "" });
  }
  return out.sort((a, b) => a.until.localeCompare(b.until));
}
