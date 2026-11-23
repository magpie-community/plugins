// 本文由AI自动生成
// 到期浪费预测。
//
// 这个策略的目的就一句话：额度在过期那一刻归零，用不完就是白扔。
// 所以面板要回答的不是「还剩多少」，而是「按当前烧法，到期会剩多少」。
//
// 两个口径，优先用官方：
//   1) 窗口自带 runsOut  → magpie 自己算好的「到期会失效多少」，直接用，标 official
//   2) 没有 runsOut      → 用最近 7 个完整自然日的日均消耗去推，标 estimated
// 推不出来（样本不足 3 天 / 没有到期日 / 没有绝对量）就明说推不出来，不给数字。

const DAY_MS = 86_400_000;

function toMs(v) {
  if (v == null) return null;
  if (typeof v === "number") return v > 1e12 ? v : v > 1e9 ? v * 1000 : null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

function dayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** 最近 7 个完整自然日（不含今天）的日均消耗。缺失的日子按 0 记，宁可低估消耗。 */
export function recentRate(dailyEntry, now = Date.now()) {
  const days = dailyEntry && typeof dailyEntry.days === "object" ? dailyEntry.days : null;
  if (!days) return { rate: null, samples: 0, spanDays: 7, sum: null, source: "none" };

  const today = new Date(now);
  let sum = 0;
  let samples = 0;
  for (let i = 1; i <= 7; i++) {
    const d = new Date(today.getTime() - i * DAY_MS);
    const v = days[dayKey(d)];
    if (typeof v === "number" && Number.isFinite(v)) {
      sum += v;
      samples += 1;
    }
  }
  if (samples < 3) return { rate: null, samples, spanDays: 7, sum, source: "thin" };
  return { rate: sum / 7, samples, spanDays: 7, sum, source: "daily" };
}

/** quota-history 兜底：用最后两个 left 点算斜率（要跨过至少 12 小时才算数） */
export function historyRate(points, now = Date.now()) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const clean = points
    .map((p) => ({ at: toMs(p.at), left: Number(p.left) }))
    .filter((p) => p.at != null && Number.isFinite(p.left))
    .sort((a, b) => a.at - b.at);
  if (clean.length < 2) return null;
  const last = clean[clean.length - 1];
  const first = clean.find((p) => last.at - p.at >= 12 * 3_600_000);
  if (!first) return null;
  const days = (last.at - first.at) / DAY_MS;
  if (days < 0.5) return null;
  const burned = first.left - last.left;
  if (burned <= 0) return { rate: 0, samples: clean.length, spanDays: days, source: "history", stale: now - last.at };
  return { rate: burned / days, samples: clean.length, spanDays: days, source: "history", stale: now - last.at };
}

function remainingAbs(w) {
  if (typeof w.runsOut === "number" && Number.isFinite(w.runsOut)) {
    // runsOut 是「到期将失效的量」，不是剩余总量；剩余总量另算
  }
  if (typeof w.balance === "number" && Number.isFinite(w.balance)) return w.balance;
  if (typeof w.limit === "number" && typeof w.amount === "number") {
    return Math.max(0, w.limit - w.amount);
  }
  if (typeof w.limit === "number" && typeof w.used === "number") {
    return Math.max(0, (w.limit * (100 - w.used)) / 100);
  }
  return null;
}

/**
 * 一个窗口的到期账。
 * @param w 网关 quotas 里的 window
 * @param dailyEntry credits-daily 里对应的 { days, last }
 * @param histPoints quota-history 里对应的 [{at,left}]
 */
export function projectWindow(w, dailyEntry, histPoints, now = Date.now()) {
  const dueMs = toMs(w.runsOutAt) ?? toMs(w.resetsAt);
  const dueBy = toMs(w.runsOutAt) != null ? "expiry" : toMs(w.resetsAt) != null ? "reset" : null;
  const daysLeft = dueMs == null ? null : (dueMs - now) / DAY_MS;
  const abs = remainingAbs(w);
  const pct = typeof w.remaining === "number" ? w.remaining : typeof w.used === "number" ? 100 - w.used : null;

  const official = typeof w.runsOut === "number" && Number.isFinite(w.runsOut) ? w.runsOut : null;
  const rate = recentRate(dailyEntry, now);
  const fb = rate.rate == null ? historyRate(histPoints, now) : null;
  const useRate = rate.rate != null ? rate : fb;

  // 两种「到期」必须分开说，否则会吓人：
  //   lapse —— 积分包过期，是真损失（runsOutAt / 官方 runsOut 对应这种）
  //   reset —— 本期额度重置，下期还有新的，只是这期没用完
  const kind = official != null || dueBy === "expiry" ? "lapse" : "reset";

  const base = {
    name: w.name || "",
    unit: w.unit || "",
    display: w.display || "",
    kind,
    due: dueMs == null ? null : new Date(dueMs).toISOString(),
    dueBy,
    daysLeft,
    remainingAbs: abs,
    remainingPct: pct,
    officialWaste: official,
    ratePerDay: useRate?.rate ?? null,
    rateSource: useRate?.source ?? "none",
    rateSamples: useRate?.samples ?? 0,
    projectedLeft: null,
    waste: null,
    verdict: "unknown",
    note: "",
  };

  if (official != null) {
    return {
      ...base,
      waste: official,
      projectedLeft: Math.max(0, official),
      verdict: official > 0.005 ? "waste" : "burnable",
      note: "magpie 直接给出的到期失效量",
      wasteSource: "official",
    };
  }

  if (dueMs == null) return { ...base, verdict: "no-due", note: "没有到期日，不会过期" };
  if (daysLeft <= 0) return { ...base, verdict: "expired", note: "已到期，等下一次重置" };
  if (abs == null) {
    return {
      ...base,
      verdict: "no-amount",
      note: pct != null ? `只有百分比（剩 ${pct.toFixed(1)}%），算不出绝对值` : "这个窗口没有可比的量",
    };
  }
  if (abs <= 0.005) {
    return { ...base, verdict: "spent", projectedLeft: 0, waste: 0, note: "这个窗口已经用尽，谈不上浪费" };
  }
  if (useRate?.rate == null) {
    return {
      ...base,
      verdict: "thin",
      note:
        useRate?.source === "thin"
          ? `近 7 天只有 ${useRate.samples} 天有消耗记录，样本不足`
          : "没有历史消耗记录，无从推算",
    };
  }

  const burn = useRate.rate * daysLeft;
  const left = abs - burn;
  const unit = base.unit || "";
  return {
    ...base,
    projectedLeft: left,
    waste: Math.max(0, left),
    burn,
    verdict: left > Math.max(abs * 0.1, 0.01) ? "waste" : "burnable",
    note: `按 ${useRate.rate.toFixed(2)} ${unit}/天 烧 ${daysLeft.toFixed(1)} 天`,
    wasteSource: "estimated",
  };
}

export { remainingAbs, toMs };
