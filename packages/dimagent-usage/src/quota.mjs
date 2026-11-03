function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function date(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("DimAgent 返回了无法识别的额度日期。");
  }
  return new Date(value).toISOString();
}

function counted(name, used, total, unit) {
  if (!count(used) || !count(total) || total <= 0 || !Number.isFinite(used / total * 100)) {
    throw new Error("DimAgent 返回的额度计数不完整或无效。");
  }
  return { name, used: used / total * 100, amount: used, limit: total, unit };
}

function list(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || !value.every(object)) throw new Error("DimAgent 返回了无效的额度列表。");
  return value;
}

function cycle(start, end) {
  const beginsAt = date(start), resetsAt = date(end);
  if (!beginsAt || !resetsAt) return { resetsAt };
  const span = (Date.parse(resetsAt) - Date.parse(beginsAt)) / 1000;
  if (span <= 0) throw new Error("DimAgent 返回了无效的额度周期。");
  return { resetsAt, span };
}

function tokenWindows(bucket, prefix, now) {
  return list(bucket.window_states).flatMap((w) => {
    if (!count(w.window_duration_hours) || w.window_duration_hours <= 0) {
      throw new Error("DimAgent 返回了无效的额度窗口长度。");
    }
    const resetsAt = date(w.window_expires_at);
    if (resetsAt && Date.parse(resetsAt) <= now) return [];
    return [{
      ...counted(`${prefix} · ${w.window_duration_hours}h`, w.window_token_used, w.window_token_cap, "tokens"),
      span: w.window_duration_hours * 3600, resetsAt,
    }];
  });
}

function bucketWindows(bucket, name, now, term) {
  if (bucket == null) return [];
  if (!object(bucket)) throw new Error("DimAgent 返回了无效的 Credits 数据。");
  if (!["active", "exhausted"].includes(bucket.status)) return [];
  const expires = date(bucket.expires_at);
  if (expires && Date.parse(expires) <= now) return [];
  if (bucket.unlimited === true) {
    return [{ name, display: "Unlimited" }, ...tokenWindows(bucket, name, now)];
  }
  const window = counted(name, bucket.used_units, bucket.total_units, "credits");
  if (bucket.remaining_units != null && !count(bucket.remaining_units)) {
    throw new Error("DimAgent 返回了无效的剩余额度。");
  }
  // The linked term supplies the deadline, not an allowance measurement start.
  if (Number.isSafeInteger(term?.credit_bucket_id) && term.credit_bucket_id > 0 &&
      term.credit_bucket_id === bucket.id && date(term.end_at) === expires && expires) {
    window.resetsAt = expires;
  }
  if (expires && count(bucket.remaining_units)) {
    window.runsOutAt = expires;
    window.runsOut = bucket.remaining_units;
  }
  return [window, ...tokenWindows(bucket, name, now)];
}

function featureWindows(meters, now) {
  return list(meters).flatMap((m) => {
    if (m.feature_key !== "web_search" || m.unlimited === true) return [];
    const resetsAt = date(m.period_end);
    if (resetsAt && Date.parse(resetsAt) <= now) return [];
    return [{ ...counted("Web Search", m.total_used, m.total_allowance, "calls"), ...cycle(m.period_start, resetsAt), aside: true }];
  });
}

export function quotaFrom(reply, now = Date.now()) {
  if (!object(reply) || !object(reply.credits)) throw new Error("DimAgent 没有返回可识别的额度数据。");
  if (!Number.isSafeInteger(reply.account_id) || reply.account_id <= 0) {
    throw new Error("DimAgent 没有返回有效的账户编号。");
  }
  const term = reply.subscription?.current_term;
  const windows = bucketWindows(reply.credits.subscription_bucket, "Credits", now, term);
  const seen = new Set();
  for (const bucket of list(reply.credits.addon_buckets)) {
    if (!Number.isSafeInteger(bucket.id) || bucket.id <= 0 || seen.has(bucket.id)) {
      throw new Error("DimAgent 返回了重复或无效的加购包编号。");
    }
    seen.add(bucket.id);
    windows.push(...bucketWindows(bucket, `Add-on ${bucket.id}`, now));
  }
  windows.push(...featureWindows(reply.feature_meters, now));
  if (!windows.length) throw new Error("DimAgent 没有返回当前可用的额度窗口。");
  const plan = reply.subscription?.product?.name;
  return {
    user: String(reply.account_id),
    plan: typeof plan === "string" ? plan : "DimAgent",
    until: date(reply.subscription?.current_term?.end_at),
    windows,
  };
}
