const WINDOWS = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  today: null,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000
};

export const WINDOW_KEYS = Object.keys(WINDOWS);

export function sinceFor(key, now = Date.now()) {
  if (key === "today") {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }
  const span = WINDOWS[key] === undefined || WINDOWS[key] === null ? WINDOWS.today : WINDOWS[key];
  return now - (span || 0);
}

export function pct(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[index];
}

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const round = (value, digits = 0) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

// 每个筛选项都可以多选，前端用逗号连起来传。
export function splitValues(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

// 派生强度：网关没写 effort 时，用思考 token 在当前窗口里的分位给个相对档位（低/中/高/极高）。
// 标签写成「思考·低」这种形式，好跟真实 effort 值挤在同一列、同一张分组表里还能分得清。
export function deriveEfforts(rows) {
  const values = rows
    .map((row) => Number(row.re || row.reasoning) || 0)
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  if (!values.length) {
    return () => "";
  }
  const at = (p) => values[Math.min(values.length - 1, Math.max(0, Math.round(p * (values.length - 1))))];
  const p50 = at(0.5);
  const p75 = at(0.75);
  const p90 = at(0.9);
  return (think) => {
    if (!think) return "";
    if (values.length <= 3) return "思考·中";
    if (think > p90) return "思考·极高";
    if (think > p75) return "思考·高";
    if (think > p50) return "思考·中";
    return "思考·低";
  };
}

export function filterRows(rows, filter) {
  const opts = filter || {};
  const since = opts.since || 0;
  const until = opts.until === undefined ? Number.MAX_SAFE_INTEGER : opts.until;
  const providers = splitValues(opts.provider);
  const models = splitValues(opts.model);
  const agents = splitValues(opts.agent);
  const efforts = splitValues(opts.effort);
  const status = String(opts.status || "");
  const needle = String(opts.text || "").trim().toLowerCase();
  const effortNone = efforts.includes("(无)");
  return rows.filter((row) => {
    if (row.e < since || row.e > until) return false;
    if (providers.length && !providers.includes(row.provider)) return false;
    if (models.length && !models.includes(row.served) && !models.includes(row.model)) return false;
    if (agents.length && !agents.includes(row.agent)) return false;
    if (efforts.length) {
      const own = String(row.effortShow || row.effort || "");
      const hitReal = own && efforts.includes(own);
      const hitNone = !own && effortNone;
      if (!hitReal && !hitNone) return false;
    }
    if (status === "ok" && row.status !== 200) return false;
    if (status === "fail" && row.status === 200) return false;
    if (needle) {
      const hay = (
        row.provider +
        " " +
        row.model +
        " " +
        row.served +
        " " +
        row.agent +
        " " +
        row.req +
        " " +
        row.stop +
        " " +
        (row.effort || "") +
        " " +
        (row.asked || "")
      ).toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

function bucket(list, keyOf) {
  const map = new Map();
  for (const row of list) {
    const key = keyOf(row) || "(未标注)";
    let item = map.get(key);
    if (!item) {
      item = { key, n: 0, ok: 0, ms: [], msSum: 0, ttft: [], inp: 0, cr: 0, cw: 0, out: 0, re: 0, credits: 0, mode: row.mode || "credit" };
      map.set(key, item);
    }
    item.n += 1;
    if (row.status === 200) item.ok += 1;
    if (row.ms > 0) {
      item.ms.push(row.ms);
      item.msSum += row.ms;
    }
    if (row.ttft > 0) item.ttft.push(row.ttft);
    item.inp += row.inp;
    item.cr += row.cr;
    item.cw += row.cw;
    item.out += row.out;
    item.re += row.re;
    item.credits += row.credits;
  }
  return [...map.values()]
    .map((item) => {
      const inAll = item.inp + item.cr;
      return {
        key: item.key,
        n: item.n,
        ok: item.ok,
        fail: item.n - item.ok,
        failRate: round((item.n - item.ok) / item.n, 3),
        ttftP50: pct(item.ttft, 50),
        ttftP90: pct(item.ttft, 90),
        msAvg: Math.round(mean(item.ms)),
        inp: item.inp,
        cacheRead: item.cr,
        cacheWrite: item.cw,
        hitRate: inAll ? round(item.cr / inAll, 3) : 0,
        out: item.out,
        reasoning: item.re,
        // 汇总速度要拿总输出除以总耗时，不能除以单次均值。
        speed: item.msSum ? round(item.out / (item.msSum / 1000), 1) : 0,
        credits: round(item.credits, 4),
        mode: item.mode
      };
    })
    .sort((a, b) => b.n - a.n);
}

function series(list, since, until, width) {
  const span = Math.max(1, until - since);
  const buckets = width;
  const step = span / buckets;
  const out = Array.from({ length: buckets }, (_, i) => ({
    t: Math.round(since + i * step),
    n: 0,
    fail: 0,
    cacheRead: 0,
    out: 0,
    ttftSum: 0,
    ttftN: 0
  }));
  for (const row of list) {
    const index = Math.min(buckets - 1, Math.max(0, Math.floor((row.e - since) / step)));
    const slot = out[index];
    slot.n += 1;
    if (row.status !== 200) slot.fail += 1;
    slot.cacheRead += row.cr;
    slot.out += row.out;
    if (row.ttft > 0) {
      slot.ttftSum += row.ttft;
      slot.ttftN += 1;
    }
  }
  return out.map((slot) => ({
    t: slot.t,
    n: slot.n,
    fail: slot.fail,
    cacheRead: slot.cacheRead,
    out: slot.out,
    ttft: slot.ttftN ? Math.round(slot.ttftSum / slot.ttftN) : 0
  }));
}

export function summarize(rows, { since, until, window, limit = 300 } = {}) {
  const list = rows;
  const ok = list.filter((row) => row.status === 200);
  const ttfts = ok.map((row) => row.ttft).filter((v) => v > 0);
  const reasonings = ok.map((row) => row.ttftr).filter((v) => v > 0);
  const durations = list.map((row) => row.ms).filter((v) => v > 0);
  const sum = (key) => list.reduce((acc, row) => acc + row[key], 0);
  const inp = sum("inp");
  const cr = sum("cr");
  const inAll = inp + cr;
  const out = sum("out");
  const totalMs = durations.reduce((a, b) => a + b, 0);

  const routes = new Map();
  for (const row of list) {
    const key = row.rid === null || row.rid === undefined ? "t:" + row.t + ":" + row.provider : String(row.rid);
    routes.set(key, (routes.get(key) || 0) + 1);
  }
  let retried = 0;
  for (const count of routes.values()) if (count > 1) retried += 1;

  const codes = {};
  for (const row of list) if (row.status !== 200) codes[row.status || "无"] = (codes[row.status || "无"] || 0) + 1;

  // 积分、余额、额度三种账要分开算，混在一起没意义。
  const modes = {
    credit: { rows: 0, credits: 0 },
    balance: { rows: 0, credits: 0 },
    window: { rows: 0, credits: 0 }
  };
  for (const row of list) {
    const slot = modes[row.mode] || modes.credit;
    slot.rows += 1;
    slot.credits += row.credits;
  }
  for (const key of Object.keys(modes)) modes[key].credits = round(modes[key].credits, 4);

  const span = until - since;
  const width =
    span <= 6 * 60 * 60 * 1000
      ? Math.min(72, Math.max(12, Math.round(span / (5 * 60 * 1000))))
      : Math.min(96, Math.max(12, Math.round(span / (60 * 60 * 1000))));

  const sorted = [...list].sort((a, b) => b.e - a.e);

  return {
    window,
    since,
    until,
    kpi: {
      attempts: list.length,
      requests: routes.size,
      ok: ok.length,
      fail: list.length - ok.length,
      failRate: list.length ? round((list.length - ok.length) / list.length, 3) : 0,
      retried,
      retryRate: routes.size ? round(retried / routes.size, 3) : 0,
      ttftAvg: Math.round(mean(ttfts)),
      ttftP50: pct(ttfts, 50),
      ttftP90: pct(ttfts, 90),
      ttftMax: ttfts.length ? Math.max(...ttfts) : 0,
      thinkP50: pct(reasonings, 50),
      msAvg: Math.round(mean(durations)),
      msP90: pct(durations, 90),
      inp,
      cacheRead: cr,
      cacheWrite: sum("cw"),
      out,
      reasoning: sum("re"),
      hitRate: inAll ? round(cr / inAll, 3) : 0,
      speed: totalMs ? round(out / (totalMs / 1000), 1) : 0,
      credits: round(sum("credits"), 4),
      modes,
      waitAvg: Math.round(mean(list.map((row) => row.sent).filter((v) => v > 0))),
      maskAvg: Math.round(mean(list.map((row) => row.mask).filter((v) => v > 0))),
      flowAvg: Math.round(mean(list.map((row) => row.flow).filter((v) => v > 0)))
    },
    codes,
    byProvider: bucket(list, (row) => row.provider),
    byModel: bucket(list, (row) => row.provider + "/" + (row.served || row.model)),
    byEffort: bucket(list, (row) => row.effortShow || row.effort || "(未标注)"),
    byAgent: bucket(list, (row) => row.agent),
    byReq: bucket(list, (row) => row.req),
    byStop: bucket(list, (row) => row.stop || "—"),
    series: series(list, since, until, width),
    rows: sorted.slice(0, limit).map((row) => ({
      t: row.t,
      agent: row.agent,
      provider: row.provider,
      model: row.served || row.model,
      asked: row.asked || "",
      effort: row.effort || "",
      rule: row.rule || "",
      req: row.req,
      mode: row.mode || "credit",
      status: row.status,
      ttft: row.ttft,
      think: row.ttftr,
      ms: row.ms,
      inp: row.inp,
      cacheRead: row.cr,
      hitRate: row.inp + row.cr ? round(row.cr / (row.inp + row.cr), 3) : 0,
      out: row.out,
      reasoning: row.re,
      credits: round(row.credits, 4),
      speed: row.ms ? round(row.out / (row.ms / 1000), 1) : 0,
      stop: row.stop,
      rid: row.rid
    }))
  };
}

export function facets(rows) {
  const providers = new Map();
  const models = new Map();
  const agents = new Map();
  const efforts = new Map();
  for (const row of rows) {
    providers.set(row.provider, (providers.get(row.provider) || 0) + 1);
    const model = row.served || row.model;
    models.set(row.provider + "/" + model, (models.get(row.provider + "/" + model) || 0) + 1);
    agents.set(row.agent, (agents.get(row.agent) || 0) + 1);
    const effort = row.effortShow || row.effort || "(无)";
    efforts.set(effort, (efforts.get(effort) || 0) + 1);
  }
  const toList = (map) =>
    [...map.entries()].sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, n }));
  return { providers: toList(providers), models: toList(models), agents: toList(agents), efforts: toList(efforts) };
}
