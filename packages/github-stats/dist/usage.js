import { calendarRange } from "./calendar.js";
function row(v) {
    if (!v || typeof v !== "object" || Array.isArray(v))
        throw new Error("Magpie Usage API 返回了不兼容的数据。");
    return v;
}
function count(v) {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
        throw new Error("Magpie 用量计数无效。");
    return v;
}
function tokens(r) {
    return count(r.input) + count(r.output);
}
function date(v) {
    if (typeof v !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T/.test(v) ||
        !Number.isFinite(Date.parse(v)))
        throw new Error("Magpie 日期无效。");
    return v.slice(0, 10);
}
export function normalizeUsage(raw, period) {
    const r = row(raw);
    if (r.period !== period ||
        r.bucket !== "day" ||
        !Array.isArray(r.series) ||
        !Array.isArray(r.models))
        throw new Error("Magpie 未返回完整的每日汇总；请升级 Magpie。");
    const dayMap = new Map();
    for (const value of r.series) {
        const d = row(value), key = date(d.time), old = dayMap.get(key) || { date: key, requests: 0, tokens: 0 };
        old.requests += count(d.calls);
        old.tokens += tokens(d);
        dayMap.set(key, old);
    }
    const models = new Map();
    for (const value of r.models) {
        const m = row(value);
        if (typeof m.model !== "string" || !m.model.trim())
            throw new Error("Magpie 模型名称缺失。");
        // Only model identifiers cross this boundary: never account, host, sub, providerKeyId, or session.
        const name = m.model.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 160);
        const old = models.get(name) || { name, requests: 0, tokens: 0 };
        old.requests += count(m.calls);
        old.tokens += tokens(m);
        models.set(name, old);
    }
    const cost = r.cost;
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)
        throw new Error("Magpie 费用汇总无效。");
    const days = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
    return {
        period,
        since: date(r.since),
        requests: count(r.calls),
        tokens: tokens(r),
        activeDays: days.filter((d) => d.requests > 0).length,
        estimatedCost: cost,
        unpriced: count(r.unpriced ?? 0),
        days,
        models: [...models.values()].sort((a, b) => b.tokens - a.tokens ||
            b.requests - a.requests ||
            a.name.localeCompare(b.name)),
    };
}
async function fetchSummary(config, period, fetcher) {
    let response;
    try {
        response = await fetcher(`http://127.0.0.1:${config.magpiePort}/v1/magpie/usage?period=${encodeURIComponent(period)}`, {
            redirect: "error",
            signal: AbortSignal.timeout(30_000),
            headers: { Accept: "application/json" },
        });
    }
    catch {
        throw new Error("无法连接本机 Magpie，请启动 Magpie 并检查端口。");
    }
    if (!response.ok)
        throw new Error(`Magpie 用量接口返回 HTTP ${response.status}。`);
    const reader = response.body?.getReader();
    if (!reader)
        throw new Error("Magpie 返回空响应。");
    const parts = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            size += value.length;
            if (size > 32 * 1024 * 1024)
                throw new Error("Magpie 汇总响应过大。");
            parts.push(value);
        }
    }
    finally {
        await reader.cancel();
    }
    let raw;
    try {
        raw = JSON.parse(Buffer.concat(parts).toString("utf8"));
    }
    catch {
        throw new Error("Magpie 未返回有效 JSON。");
    }
    return row(raw);
}
export async function readUsage(config, fetcher = fetch, now = new Date()) {
    const raw = await fetchSummary(config, config.period, fetcher);
    if (config.period === "all" && raw.bucket === "week") {
        // Older histories switch to weekly buckets. Request bounded day ranges from
        // the SAME summary API instead of mixing the Requests ledger's different scope.
        const start = new Date(date(raw.since) + "T00:00:00Z");
        const now = new Date(), today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        const end = new Date(today + "T00:00:00Z"), series = [];
        if ((end.getTime() - start.getTime()) / 86400000 > 36525)
            throw new Error("历史时间范围异常。");
        while (start <= end) {
            const until = new Date(Math.min(end.getTime(), start.getTime() + 29 * 86400000));
            const period = `${start.toISOString().slice(0, 10)}..${until.toISOString().slice(0, 10)}`;
            const part = await fetchSummary(config, period, fetcher);
            if (part.period !== period ||
                part.bucket !== "day" ||
                !Array.isArray(part.series))
                throw new Error("Magpie 不支持按日历史查询，请升级后再使用 All Time。");
            series.push(...part.series);
            start.setUTCDate(start.getUTCDate() + 30);
        }
        raw.series = series;
        raw.bucket = "day";
    }
    const stats = normalizeUsage(raw, config.period);
    if (config.showHeatmap) {
        const asOf = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        const { start } = calendarRange(config.heatmapView, asOf);
        // This range is independent of the headline period. Never paint days outside
        // a 7-day headline query as zero in a month calendar.
        const days = [];
        for (let from = new Date(start + "T00:00:00Z"), end = new Date(asOf + "T00:00:00Z"); from <= end; from.setUTCDate(from.getUTCDate() + 30)) {
            const until = new Date(Math.min(end.getTime(), from.getTime() + 29 * 86400000));
            const period = `${from.toISOString().slice(0, 10)}..${until.toISOString().slice(0, 10)}`;
            const part = await fetchSummary(config, period, fetcher);
            if (part.period !== period)
                throw new Error("Magpie 活跃图日期范围不匹配。");
            const normalized = normalizeUsage({ ...part, period: config.period }, config.period);
            days.push(...normalized.days.filter((d) => d.date >= period.slice(0, 10) && d.date <= period.slice(-10)));
        }
        stats.heatmap = { asOf, days };
    }
    return stats;
}
