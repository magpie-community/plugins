/**
 * pool-usage → the windows magpie's account card draws.
 *
 * The console sends every number as a string and reset_at as epoch seconds.
 * A window's `used` is the spent share; when the console leaves `used` out,
 * limit - remaining is the fallback, and a window with neither is skipped
 * rather than shown as 0% (which would read as "nothing spent").
 *
 * The general pool covers Flash-Lite too, but Flash-Lite is spent from its
 * own pool first. The general window therefore carries `notModels` for the
 * dedicated pool's ids, so a full general pool does not gate Flash-Lite
 * while the dedicated pool still has room.
 *
 * Grants (grant_balance) are a balance that expires, not a spent window.
 * Several granted pools add up; the earliest expiry is the one told.
 */

/** Tolerant number: "600000" / 591300.256 / null; negatives to 0. */
export function flexNum(value) {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim() || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function optionalNum(value) {
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

export function flexInt(value) {
  const n = Math.trunc(flexNum(value));
  return n > 0 ? n : 0;
}

/** Up to two decimals, no thousands separators (the card adds its own). */
export function compact(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "0";
  const s = v.toFixed(2).replace(/\.?0+$/, "");
  return s === "" ? "0" : s;
}

const isoOf = (seconds) => (seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined);

function isDedicated(pool) {
  const t = String(pool?.pool_type ?? "").toLowerCase();
  const name = String(pool?.name ?? "").toLowerCase();
  return t === "dedicated" || t === "flash" || name.includes("flash") || name.includes("专属");
}

/** The ids a dedicated pool serves when the console does not list them. */
const FLASH_LITE_IDS = ["sensenova-6.7-flash-lite", "sensenova-6.8-flash-lite"];

function scopeOf(pool, dedicated, dedicatedIds) {
  const ids = Array.isArray(pool?.model_ids) ? pool.model_ids.filter((x) => typeof x === "string" && x) : [];
  if (dedicated) return ids.length ? { models: ids } : { model: "flash-lite" };
  // The general window keeps its own `models` (the GUI groups by them) and
  // adds `notModels` for the dedicated ids, so a full general pool does not
  // gate Flash-Lite while its own pool still has room.
  return { ...(ids.length ? { models: ids } : {}), ...(dedicatedIds.length ? { notModels: [...dedicatedIds] } : {}) };
}

/** Pools from either `{data:{pools}}` or top-level `{pools}`. */
export function poolsOf(raw) {
  if (Array.isArray(raw?.data?.pools)) return raw.data.pools;
  if (Array.isArray(raw?.pools)) return raw.pools;
  return [];
}

export function toUsage(raw, { username = "", planFallback = "Token Plan" } = {}) {
  const pools = poolsOf(raw);
  if (!Array.isArray(raw?.data?.pools) && !Array.isArray(raw?.pools)) {
    // not the console's shape at all: a failed read, not an empty plan
    const detail = raw?.error?.message ?? raw?.message ?? raw?.error;
    throw new Error(
      typeof detail === "string" && detail ? `pool-usage: ${detail}` : "pool-usage returned no credit pools",
    );
  }

  // The GUI draws the first two windows as meters; the default pool goes first.
  const ordered = [...pools].sort((a, b) => (isDedicated(a) ? 1 : 0) - (isDedicated(b) ? 1 : 0));
  const dedicatedIds = [
    ...new Set(
      ordered
        .filter(isDedicated)
        .flatMap((p) => {
          const ids = Array.isArray(p?.model_ids) ? p.model_ids.filter((x) => typeof x === "string" && x) : [];
          return ids.length ? ids : FLASH_LITE_IDS;
        }),
    ),
  ];

  const windows = [];
  let grantsTotal = 0;
  let expiryAt = 0;

  for (const pool of ordered) {
    const dedicated = isDedicated(pool);
    const scope = scopeOf(pool, dedicated, dedicatedIds);
    const label =
      typeof pool?.name === "string" && pool.name.trim() ? pool.name.trim() : dedicated ? "Dedicated pool" : "General pool";

    for (const [w, tag, span] of [
      [pool?.window_5h, "5 hours", 5 * 3600],
      [pool?.window_7d, "7 days", 7 * 24 * 3600],
    ]) {
      const limit = flexNum(w?.limit);
      if (limit <= 0) continue;
      const usedAmount = optionalNum(w?.used);
      const remaining = optionalNum(w?.remaining);
      const amount =
        usedAmount !== undefined
          ? Math.max(0, usedAmount)
          : remaining !== undefined
            ? Math.max(0, limit - remaining)
            : undefined;
      if (amount === undefined) continue;
      const resetsAt = isoOf(flexInt(w?.reset_at));
      const round = (n) => Math.round(n * 100) / 100;
      windows.push({
        name: `${label} · ${tag}`,
        used: (amount / limit) * 100,
        ...(resetsAt ? { resetsAt } : {}),
        display: `${compact(amount)} / ${compact(limit)}`,
        amount: round(amount),
        limit: round(limit),
        unit: "credits",
        span,
        ...scope,
      });
    }

    // Grants are a balance that expires, not a spent window. Several granted
    // pools add up (the dedicated pool carries its own grant too, as 0.1.3
    // read it); the earliest expiry is the one told.
    const grant = flexNum(pool?.grant_balance);
    if (grant > 0) {
      grantsTotal += grant;
      const expiry = flexInt(pool?.nearest_grant_expiry);
      if (expiry > 0 && (!expiryAt || expiry < expiryAt)) expiryAt = expiry;
    }
  }

  const plan = raw?.data?.plan?.name ?? raw?.plan?.name;
  const planName = typeof plan === "string" && plan.trim() ? plan.trim() : planFallback;
  if (!(grantsTotal > 0)) return {
    plan: planName,
    ...(username ? { user: username } : {}),
    windows,
  };
  const count = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
  const day = expiryAt > 0
    ? (() => {
        const d = new Date(expiryAt * 1000), now = new Date();
        const md = `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
        return d.getUTCFullYear() === now.getUTCFullYear() ? md : `${d.getUTCFullYear()}-${md}`;
      })()
    : "";
  return {
    plan: planName,
    ...(username ? { user: username } : {}),
    windows,
    balance: `${count.format(grantsTotal)} 积分${day ? ` · ${day} 到期` : ""}`,
  };
}

/** The pools-array entry point (the card read routes through toUsage). */
export function usageOf(pools) {
  return toUsage({ pools });
}
