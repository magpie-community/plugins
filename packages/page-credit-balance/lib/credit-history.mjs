const DAY = 86_400_000;
const totalName = /^(?:total credits|总积分(?:\s*·.*)?|积分余额|可用积分)$/i;
const finite = value => Number.isFinite(value) && value >= 0;
export const creditUnit = /^(?:credits?|points?|积分)$/i;
const date = at => new Date(at + 8 * 3_600_000).toISOString().slice(0, 10);
export const creditDayStart = at => Date.parse(`${date(at)}T00:00:00+08:00`);

// Total windows already include their component packs. The same selection
// must be used for the live balance and for the absolute spend counters.
export function creditWindows(provider, windows) {
  const total = windows.find(item => totalName.test(item.name ?? ''));
  if (total) return [total];
  if (provider === 'raccoon') return windows.filter(item => item.name === 'Credits');
  return windows.filter(item => !/^daily pool$/i.test(item.name ?? ''));
}

export const accountKey = (provider, id) => JSON.stringify([provider, id.toLowerCase()]);

export function updateCreditReadings(previous, cards, now) {
  const recent = Object.fromEntries(Object.entries(previous ?? {}).map(([key, points]) => [
    key, Array.isArray(points) ? points.filter(point => Number.isFinite(point.at) && point.at >= now - 2 * DAY) : [],
  ]).filter(([, points]) => points.length));
  const seen = new Set();
  for (const card of cards) {
    const id = card.user || card.alias;
    const at = Date.parse(card.readAt ?? card.asOf);
    if (card.error || typeof id !== 'string' || !Number.isFinite(at) || at > now + 60_000 || at < now - 2 * DAY) continue;
    const key = accountKey(card.provider, id);
    if (seen.has(key)) continue;
    seen.add(key);
    const windows = creditWindows(card.provider, (card.windows ?? []).filter(item => creditUnit.test(item.unit ?? '')));
    if (!windows.length || !windows.every(item => item.name && finite(item.amount) && finite(item.limit) && !item.unlimited)) continue;
    const counters = Object.fromEntries(windows.map(item => [item.name, { used: item.amount, limit: item.limit,
      reset: item.resetsAt ?? null }]));
    const points = recent[key] ??= [];
    if ((points.at(-1)?.at ?? 0) >= at) continue;
    // Retain a point on each side of a counter change without writing
    // hundreds of identical samples while the gateway reports steady usage.
    if (points.length > 1 && JSON.stringify(points.at(-1).counters) === JSON.stringify(counters) &&
        JSON.stringify(points.at(-2).counters) === JSON.stringify(counters)) points.pop();
    points.push({ at, counters });
  }
  return recent;
}

export function readAccountSpend(provider, refs, dailyIndex, readings, now) {
  const key = refs[0] ? accountKey(provider, refs[0]) : null;
  const points = key ? readings[key] ?? [] : [];
  const after = now - DAY;
  let last24h = null;
  let snapshotThrough = null;
  // Read only intervals fully inside the rolling window. Crossing intervals
  // are not assigned to it without request-level evidence.
  for (let index = 1; index < points.length; index++) {
    const prev = points[index - 1];
    const next = points[index];
    if (next.at > now || prev.at < after) continue;
    const names = Object.keys(next.counters);
    if (names.length !== Object.keys(prev.counters).length) continue;
    const deltas = names.map(name => {
      const before = prev.counters[name];
      const afterCounter = next.counters[name];
      return before && before.reset === afterCounter.reset && !(Date.parse(before.reset) <= next.at) &&
        afterCounter.limit >= before.limit && afterCounter.used >= before.used
        ? afterCounter.used - before.used : null;
    });
    if (deltas.some(delta => delta === null)) continue;
    last24h = (last24h ?? 0) + deltas.reduce((sum, delta) => sum + delta, 0);
    snapshotThrough = next.at;
  }
  // Day-level readings can establish calendar totals but cannot recover
  // the portion of an old day inside a rolling 24-hour interval.
  const entries = refs.map(ref => dailyIndex.get(accountKey(provider, ref))).find(Boolean) ?? [];
  const windows = creditWindows(provider, entries);
  const days = new Map();
  for (const entry of windows) for (const [day, amount] of Object.entries(entry.days ?? {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !finite(amount)) continue;
    days.set(day, (days.get(day) ?? 0) + amount);
  }
  const since = windows.map(entry => entry.since).filter(Boolean).sort().at(-1);
  const timestamps = windows.map(entry => Date.parse(entry.last?.at));
  const through = timestamps.length && timestamps.every(Number.isFinite) ? Math.min(...timestamps) : null;
  const lastCounterAt = through === null ? null : Math.max(...timestamps);
  const totals = {};
  for (const count of [7, 30]) {
    const start = date(now - (count - 1) * DAY);
    const observed = [...days].filter(([day]) => day >= start && day <= date(now));
    // A readable account with no per-day entries simply spent 0; only a
    // provider/account with no counter at all is unknown (null).
    const relevant = windows.length && (lastCounterAt === null || date(lastCounterAt) >= start);
    totals[`${count}d`] = relevant ? observed.reduce((sum, [, amount]) => sum + amount, 0) : null;
  }
  return { totals, last24h, snapshotThrough, days, since, through, lastCounterAt };
}

export function indexDailyCredits(data) {
  const result = new Map();
  for (const [key, value] of Object.entries(data ?? {})) {
    const [provider, id, name = 'Credits'] = key.split('|');
    if (!provider || !id || !value || typeof value !== 'object') continue;
    const account = accountKey(provider, id);
    if (!result.has(account)) result.set(account, []);
    result.get(account).push({ ...value, name });
  }
  return result;
}
