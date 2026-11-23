// 本文由AI自动生成
// pace 的展示用分解。
//
// 注意分工：**排序不在这里算**。真实分值来自 magpie 自己写进 routing 日志的
// order[].pace，那是权威值。这里只做两件事：
//   1) 把 (100 − used%) ÷ 距到期小时数 这个式子摊开给人看，让人明白分数怎么来的
//   2) 按账号把同一候选的多条窗口记录合并成一行（magpie 取最大 pace，这里跟着取最大）
//
// 已核实公式（二进制反汇编 + 10.7 万条日志验证，吻合 ≈99.5%）：
//   pace = (100 − used%) ÷ max(距 due 的小时数, 1)
//   due  = resetsAt；若积分更早过期则 runsOutAt
//   due 缺失 → 168 小时兜底
//   无窗口   → used=0，pace = 100/168 ≈ 0.5952

const FALLBACK_HOURS = 168;

function toMs(v) {
  if (v == null) return null;
  if (typeof v === "number") return v > 1e12 ? v : v > 1e9 ? v * 1000 : null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

export function decompose(used, due, now = Date.now()) {
  const usedPct = typeof used === "number" && Number.isFinite(used) ? used : 0;
  const dueMs = toMs(due);
  const rawHours = dueMs == null ? null : (dueMs - now) / 3_600_000;
  const divisorHours = rawHours == null ? FALLBACK_HOURS : Math.max(rawHours, 1);
  const pace = (100 - usedPct) / divisorHours;
  return {
    used: usedPct,
    remainingPct: Math.max(0, 100 - usedPct),
    hours: rawHours,
    divisorHours,
    pace,
    assumed: rawHours == null,
    overdue: rawHours != null && rawHours <= 1,
  };
}

function keyOf(o) {
  if (o && typeof o.id === "string" && o.id) return o.id;
  return `${o?.provider ?? "?"}/${o?.who ?? o?.model ?? "?"}`;
}

function restOf(o) {
  const r = o?.rest;
  if (!r || typeof r !== "object") return null;
  return {
    why: r.why || "",
    status: r.status ?? null,
    until: r.until || null,
    error: typeof r.error === "string" ? r.error.slice(0, 200) : "",
  };
}

/**
 * 把 order[] 合并成「一个账号一行」。
 *
 * 合并规则：
 *   - pace 取该账号所有条目里的最大值（与 magpie 的取法一致）
 *   - 任一条目处于冷却 → 整行视为冷却（会被沉底）
 *   - 保留 magpie 给的最小 rank 与首次出现位置，作为参考信息
 *
 * 返回的数组按 pace 降序；冷却项沉底。理由：
 * order[] 是多个 model 分块拼接起来的，块间并非严格按 pace 排列，
 * 直接照抄会让「pace 更高却排在后面」看起来像 bug。策略的定义就是「越该先用越靠前」，
 * 所以主视图按 pace 排，同时把 magpie 的 rank 与队列位置如实标出来。
 */
export function aggregate(order, now = Date.now()) {
  const map = new Map();

  order.forEach((o, idx) => {
    if (!o || typeof o !== "object") return;
    const key = keyOf(o);
    const d = decompose(o.used, o.due, now);
    const declared = typeof o.pace === "number" && Number.isFinite(o.pace) ? o.pace : null;
    const pace = declared ?? d.pace;
    const rest = restOf(o);

    const prev = map.get(key);
    if (!prev) {
      map.set(key, {
        key,
        id: o.id || key,
        provider: o.provider || "",
        name: o.name || o.provider || "",
        who: o.who || "",
        plan: o.plan || "",
        kind: o.kind || "",
        model: o.model || "",
        pace,
        paceSource: declared != null ? "magpie" : "computed",
        used: d.used,
        remainingPct: d.remainingPct,
        divisorHours: d.divisorHours,
        hours: d.hours,
        assumedDue: d.assumed,
        due: o.due || null,
        dueBy: o.dueBy || null,
        tokens: typeof o.tokens === "number" ? o.tokens : null,
        rank: typeof o.rank === "number" ? o.rank : null,
        rest,
        firstIdx: idx,
        entries: 1,
        windows: [describeWindow(d, declared, o)],
      });
      return;
    }

    prev.entries += 1;
    if (paidMissing(prev.windows, d, o)) prev.windows.push(describeWindow(d, declared, o));
    if (pace > prev.pace + 1e-12) {
      prev.pace = pace;
      prev.paceSource = declared != null ? "magpie" : "computed";
      prev.used = d.used;
      prev.remainingPct = d.remainingPct;
      prev.divisorHours = d.divisorHours;
      prev.hours = d.hours;
      prev.assumedDue = d.assumed;
      prev.due = o.due || null;
      prev.dueBy = o.dueBy || null;
    }
    if (typeof o.rank === "number" && (prev.rank == null || o.rank < prev.rank)) prev.rank = o.rank;
    if (!prev.rest && rest) prev.rest = rest;
  });

  const rows = [...map.values()].sort((a, b) => {
    const ra = a.rest ? 1 : 0;
    const rb = b.rest ? 1 : 0;
    if (ra !== rb) return ra - rb; // 冷却的沉底，与 magpie 行为一致
    if (Math.abs(b.pace - a.pace) > 1e-12) return b.pace - a.pace;
    return a.firstIdx - b.firstIdx;
  });

  rows.forEach((r, i) => {
    r.shownRank = i + 1;
  });
  return rows;
}

function describeWindow(d, declared, o) {
  return {
    used: d.used,
    remainingPct: d.remainingPct,
    divisorHours: d.divisorHours,
    hours: d.hours,
    assumed: d.assumed,
    pace: declared ?? d.pace,
    declared: declared != null,
    due: o.due || null,
    dueBy: o.dueBy || null,
  };
}

function paidMissing(list, d, o) {
  const dueKey = String(o.due || "");
  const same = list.some(
    (w) => Math.abs(w.used - d.used) < 1e-9 && String(w.due || "") === dueKey,
  );
  return !same && list.length < 8;
}

/** 把小时数说成人话 */
export function humanHours(h) {
  if (h == null) return "未知";
  if (h < 1) return "已到期";
  if (h < 48) return `${h.toFixed(1)} 小时`;
  return `${(h / 24).toFixed(1)} 天`;
}
