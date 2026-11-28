const HOUR = 3600000;
export const WINDOWS = [{ name: "5 小时", ms: 5 * HOUR }, { name: "周", ms: 7 * 24 * HOUR }];
export const timestamp = value => typeof value === "string" ? Date.parse(value) : NaN;

export function windowSize(window) {
  const name = String(window.name || "").toLowerCase();
  if (/^(5 hours?|5h|5 小时)$/.test(name)) return WINDOWS[0].ms;
  if (/^(7 days?|7d|week|weekly|周|7 天)$/.test(name)) return WINDOWS[1].ms;
  return null;
}

export function pricesFrom(catalog) {
  const prices = new Map();
  for (const maker of ["openai", "anthropic"]) {
    for (const [id, model] of Object.entries(catalog[maker]?.models || {})) {
      if (model.cost) prices.set(id.toLowerCase(), { maker, ...model.cost });
    }
  }
  // Magpie's provider.pricedNames explicitly prices this internal model as gpt-5.6-luna.
  if (!prices.has("codex-auto-review") && prices.has("gpt-5.6-luna")) {
    prices.set("codex-auto-review", prices.get("gpt-5.6-luna"));
  }
  return prices;
}

export function priceRecord(record, prices) {
  if (record.unpriced) return null;
  const id = String(record.served || record.model || "").split("/").at(-1).toLowerCase();
  let price = prices.get(id);
  if (!price) return null;
  const input = record.in || 0, output = record.out || 0;
  const read = record.cache_read || 0, write = record.cache_write || 0;
  const hourWrite = record.cache_write_1h || 0;
  const prompt = input + read + write;
  for (const tier of [...(price.tiers || [])].sort((a, b) => a.tier?.size - b.tier?.size)) {
    if (tier.tier?.type === "context" && prompt > tier.tier.size) price = { ...price, ...tier };
  }
  const validPrice = x => Number.isFinite(x) && x >= 0;
  if (![price.input, price.output].every(validPrice)) return null;
  if (read && !validPrice(price.cache_read)) return null;
  if (write && !validPrice(price.cache_write)) return null;
  if (hourWrite && price.maker !== "anthropic") return null;
  const cost = (input * price.input + output * price.output + read * (price.cache_read || 0)
    + (write - hourWrite) * (price.cache_write || 0) + hourWrite * price.input * 2) / 1e6;
  return Number.isFinite(cost) ? cost : null;
}

function validRecord(record) {
  const fields = ["in", "out", "cache_read", "cache_write", "cache_write_1h"];
  return fields.every(k => record[k] === undefined || Number.isSafeInteger(record[k]) && record[k] >= 0)
    && (record.cache_write_1h || 0) <= (record.cache_write || 0)
    && Number.isFinite(timestamp(record.t));
}

function identity(record) {
  if (record.rid) return `${record.provider}|${record.providerAccount}|${record.rid}`;
  return JSON.stringify([record.t, record.provider, record.providerAccount, record.model,
    record.in, record.out, record.cache_read, record.cache_write, record.session]);
}

export function estimateAccount({ quota, rows, history = [], prices, now, title, firstRecordAt, partial = false }) {
  const readAt = timestamp(quota.readAt || quota.asOf);
  const own = [];
  const seen = new Set();
  let invalid = false;
  for (const row of rows) {
    if (row.provider !== quota.provider || !quota.user
      || String(row.providerAccount || "").toLowerCase() !== quota.user.toLowerCase()
      || row.source === "reported" || row.status >= 400) continue;
    if (!validRecord(row)) { invalid = true; continue; }
    if (timestamp(row.t) > readAt || !(row.in || row.out || row.cache_read || row.cache_write)) continue;
    const key = identity(row);
    if (!seen.has(key)) { seen.add(key); own.push(row); }
  }
  return WINDOWS.map(kind => {
    const window = (quota.windows || []).find(w => windowSize(w) === kind.ms);
    const card = { title, window: kind.name, readAt: Number.isFinite(readAt) ? readAt : null,
      state: "unavailable", reason: "供应商未上报此窗口", used: null, tokens: null, cost: null,
      calls: 0, observedTokens: 0, observedCost: 0, unpriced: 0, partial: true };
    if (!window) return card;
    const used = window.used;
    const end = timestamp(window.resetsAt);
    let start = end - kind.ms;
    const points = history.find(line => line.name === window.name)?.points || [];
    let resetBetweenReadings = false;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const at = timestamp(b.at);
      if (at > start && at <= readAt && b.left > a.left + 5
        && Math.abs(timestamp(b.resetsAt) - timestamp(a.resetsAt)) <= 5 * 60000) {
        start = at;
        resetBetweenReadings = true;
      }
    }
    Object.assign(card, { used: Number.isFinite(used) ? used : null,
      start: Number.isFinite(start) ? start : null, end: Number.isFinite(end) ? end : null });
    const fail = reason => ({ ...card, reason });
    if (quota.error) return fail("额度读取失败；保留供应商缓存，等待正常更新");
    if (!Number.isFinite(readAt) || readAt > now + 60000) return fail("额度采样时间缺失或异常");
    if (!Number.isFinite(start) || !Number.isFinite(end)) return fail("缺少窗口重置时间");
    if (end <= now) return fail("额度窗口已过期，等待 Magpie 正常更新");
    if (now - readAt > 30 * 60000) return fail("额度快照超过 30 分钟，暂不推算");
    if (start >= readAt) return fail("窗口尚未开始或时间异常");
    if (!Number.isFinite(used) || used < 0 || used > 100) return fail("官方已用比例无效");
    const calls = own.filter(row => timestamp(row.t) >= start);
    for (const row of calls) {
      card.observedTokens += (row.in || 0) + (row.out || 0) + (row.cache_read || 0) + (row.cache_write || 0);
      const cost = priceRecord(row, prices);
      if (cost === null) card.unpriced++;
      else card.observedCost += cost;
    }
    card.calls = calls.length;
    card.nativeCalls = calls.filter(row => row.source === "claude-native").length;
    card.partial = partial || invalid || resetBetweenReadings || !Number.isFinite(firstRecordAt) || firstRecordAt > start;
    if (used < 5) return fail("已用不足 5%，整数比例不适合放大估算");
    if (!calls.length) return fail("此窗口没有可归属该账号的调用记录");
    const paid = calls.some(row => row.credits > 0);
    const exhausted = history.some(line => line.points.some((point, i, all) => {
      const at = timestamp(point.at), next = timestamp(all.slice(i + 1).find(p => p.left > 0)?.at);
      return point.left <= 0 && at >= start && at <= readAt
        && calls.some(row => timestamp(row.t) >= at && (!Number.isFinite(next) || timestamp(row.t) < next));
    }));
    if (paid || exhausted) return fail("窗口内可能混入积分或额外付费，无法分离订阅容量");
    if (!Number.isSafeInteger(card.observedTokens)) return fail("Token 合计超出安全数值范围");
    const tokens = Math.round(card.observedTokens * 100 / used);
    if (!Number.isSafeInteger(tokens)) return fail("满额 Token 超出安全数值范围");
    return { ...card, state: "estimated", reason: card.partial ? "记录覆盖不完整，可能低估" : "仅根据可归属账号的记录推算，外部用量可能造成低估",
      tokens, cost: card.unpriced ? null : card.observedCost * 100 / used,
      confidence: used < 10 ? "早期估算" : used < 30 ? "粗略估算" : "参考估算" };
  });
}
