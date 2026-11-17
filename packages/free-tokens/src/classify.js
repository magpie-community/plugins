import { MAPPING } from "./mapping.js";
import { BRAND } from "./icons.js";
import { OFFICIAL_PROVIDERS } from "./allowlist.js";

const KINDS = new Set(["daily", "monthly", "once", "limited", "free"]);
function todayBJ() { return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }); }
const RANK = { claimed: 4, done: 3, inactive: 2, failed: 1 };

function checkinFor(checkin, pid) {
  if (checkin == null) return null; // 未知：文件读失败
  let best = "none";
  const today = todayBJ();
  for (const [k, v] of Object.entries(checkin)) {
    if (!(k === pid || k.startsWith(pid + "|"))) continue;
    if (!v) continue;
    if (v.day && v.day !== today) continue;
    const o = v.outcome;
    if (o && RANK[o] && RANK[o] > (RANK[best] || 0)) best = o;
  }
  return best;
}
function buildState(local) {
  const installed = {};
  if (local.providers != null) {
    for (const p of local.providers) {
      if (!p || !p.id) continue;
      installed[p.id] = { signedIn: !!p.signedIn, checkin: checkinFor(local.checkin, p.id), name: p.name || p.id };
    }
  }
  return { installed, configKnown: local.providers != null, checkinKnown: local.checkin != null };
}
function safeUrl(u) { try { const x = new URL(String(u || "")); return x.protocol === "https:" ? x.href : null; } catch { return null; } }
// 只保留规范字段并做脱敏：kind 限白名单、url 限 https
function pick(x) {
  return {
    id: typeof x.id === "string" ? x.id : String(x.id ?? ""),
    kind: KINDS.has(x.kind) ? x.kind : "other",
    title: String(x.title ?? ""),
    provider: String(x.provider ?? "").trim(),
    detail: String(x.detail ?? ""),
    url: safeUrl(x.url),
    tags: Array.isArray(x.tags) ? x.tags.filter((t) => typeof t === "string") : [],
    endsAt: typeof x.endsAt === "string" ? x.endsAt : null,
    validity: String(x.validity ?? ""),
    verifiedAt: typeof x.verifiedAt === "string" ? x.verifiedAt : null,
    yuan: typeof x.yuan === "number" ? x.yuan : null,
    label: String(x.label ?? ""),
    face: String(x.face ?? ""),
    counted: x.counted === true,
  };
}
function countKinds(ds) { const c = {}; for (const d of ds) c[d.kind] = (c[d.kind] || 0) + 1; return c; }

export function buildPayload(ftData, local) {
  // 只保留官方厂商（白名单），杜绝第三方中转站进入 magpie
  const raw = (ftData.deals || []).filter((x) => x && OFFICIAL_PROVIDERS.has(String(x.provider ?? "").trim()));
  const deals = raw.map(pick);
  const priced = deals.filter((d) => d.yuan != null);
  const today = Math.round(deals.filter((d) => d.counted && d.yuan != null).reduce((s, d) => s + d.yuan, 0));
  const meta = {
    generatedAt: new Date().toISOString(), source: "aihot.news/free-tokens",
    todayClaimable: today, faceTotal: +priced.reduce((s, d) => s + d.yuan, 0).toFixed(2),
    pricedCount: priced.length, monthlyClaimed: 0, totalDeals: deals.length, kindCounts: countKinds(deals), basis: ftData.basis || null,
  };
  const icons = {};
  for (const d of deals) { if (BRAND[d.provider] && !icons[d.provider]) icons[d.provider] = "brand/" + BRAND[d.provider]; }
  return { meta, deals, mapping: MAPPING, demoState: buildState(local), icons };
}
