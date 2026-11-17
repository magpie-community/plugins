import { calendarCells } from "./calendar.js";
export const escapeXml = (s) => String(s).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
})[ch]);
export function compact(n) {
    for (const [scale, suffix] of [
        [1e12, "T"],
        [1e9, "B"],
        [1e6, "M"],
        [1e3, "K"],
    ])
        if (n >= scale)
            return `${+(n / scale).toFixed(n / scale >= 100 ? 0 : 1)}${suffix}`;
    return String(n);
}
const shorten = (s, max) => Array.from(s).length > max
    ? Array.from(s)
        .slice(0, max - 1)
        .join("") + "…"
    : s;
export function renderCard(s, c, mode, updated) {
    const dark = mode === "dark", w = c.width, compactLayout = w < 420, pad = compactLayout ? 20 : 26;
    const p = dark
        ? {
            bg: "#0D1117",
            fg: "#F1F5F9",
            muted: "#9AAAC1",
            line: "#283347",
            purple: "#A855F7",
            cyan: "#22D3EE",
            pink: "#F472B6",
        }
        : {
            bg: "#F8FAFC",
            fg: "#0F172A",
            muted: "#53647B",
            line: "#DBE3ED",
            purple: "#7C3AED",
            cyan: "#0891B2",
            pink: "#DB2777",
        };
    if (c.theme === "minimal") {
        p.purple = dark ? "#C4B5FD" : "#5B21B6";
        p.cyan = p.purple;
    }
    if (c.theme === "cyberpunk") {
        p.purple = dark ? "#F472B6" : "#BE185D";
        p.cyan = dark ? "#A3E635" : "#4D7C0F";
    }
    const content = [];
    const text = (x, y, label, size = 11, color = p.muted, extra = "") => content.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${color}" ${extra}>${escapeXml(label)}</text>`);
    const rule = (y) => content.push(`<path d="M${pad} ${y}H${w - pad}" stroke="${p.line}"/>`);
    content.push(`<path d="M${pad} 29l7-9 7 9-7 9z" fill="url(#accent)"/>`);
    text(pad + 23, 33, "MAGPIE", 14, p.fg, 'font-weight="750" letter-spacing="2"');
    const periodLabel = c.period === "all"
        ? "ALL TIME"
        : c.period === "7d"
            ? "LAST 7 DAYS"
            : "LAST 30 DAYS";
    text(w - pad, 32, periodLabel, 9, p.muted, 'text-anchor="end" letter-spacing="1"');
    text(pad, 53, "AI usage, at a glance.", 10);
    rule(67);
    const col = (w - pad * 2) / 3;
    for (const [i, v, label] of [
        [0, compact(s.tokens), "TOKENS"],
        [1, compact(s.requests), "REQUESTS"],
        [2, String(s.activeDays), "ACTIVE DAYS"],
    ]) {
        text(pad + i * col, 102, v, compactLayout ? 24 : 30, i === 0 ? "url(#accent)" : p.fg, 'font-weight="700" letter-spacing="-1"');
        text(pad + i * col, 121, label, compactLayout ? 8 : 9, p.muted, 'letter-spacing="1"');
    }
    let y = 144;
    if (c.showTrend) {
        text(pad, y, "TOKEN ACTIVITY", 9, p.muted, 'letter-spacing="1.5"');
        const days = s.days.slice(c.period === "7d" ? -7 : -30), maximum = Math.max(1, ...days.map((d) => d.tokens));
        const chartY = y + 12, chartH = 34, chartW = w - pad * 2;
        const points = days.map((d, i) => `${(pad + (days.length < 2 ? chartW / 2 : (i * chartW) / (days.length - 1))).toFixed(2)},${(chartY + chartH - (d.tokens / maximum) * chartH).toFixed(2)}`);
        for (const lineY of [chartY + chartH / 2, chartY + chartH])
            content.push(`<path d="M${pad} ${lineY}H${w - pad}" stroke="${p.line}" stroke-dasharray="2 5"/>`);
        if (points.length > 1) {
            content.push(`<path d="M${pad},${chartY + chartH} L${points.join(" L")} L${w - pad},${chartY + chartH}Z" fill="url(#area)"/>`);
            content.push(`<polyline points="${points.join(" ")}" fill="none" stroke="url(#accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
        }
        else if (points[0]) {
            const [cx, cy] = points[0].split(",");
            content.push(`<circle cx="${cx}" cy="${cy}" r="3" fill="${p.cyan}"/>`);
        }
        if (!s.requests)
            text(w / 2, chartY + 22, "No activity in this period", 10, p.muted, 'text-anchor="middle"');
        y += 64;
    }
    if (c.showModels) {
        text(pad, y, "TOP MODELS", 9, p.muted, 'letter-spacing="1.5"');
        text(w - pad, y, "% OF TOKENS", 8, p.muted, 'text-anchor="end" letter-spacing="1"');
        y += 20;
        const models = s.models.slice(0, c.topModels), nameWidth = compactLayout ? 118 : Math.round((w - pad * 2) * 0.43), barX = pad + nameWidth, barW = w - pad - barX - 42;
        if (!models.length) {
            text(pad, y, "No model usage yet", 11);
            y += 24;
        }
        for (const model of models) {
            const share = s.tokens > 0 ? Math.min(1, model.tokens / s.tokens) : 0;
            text(pad, y, shorten(model.name, compactLayout ? 16 : Math.floor(nameWidth / 6.7)), 10, p.fg);
            content.push(`<rect x="${barX}" y="${y - 7}" width="${barW}" height="5" rx="2.5" fill="${p.line}"/><rect x="${barX}" y="${y - 7}" width="${(barW * share).toFixed(2)}" height="5" rx="2.5" fill="url(#accent)"/>`);
            text(w - pad, y, `${+(share * 100).toFixed(1)}%`, 10, p.muted, 'text-anchor="end"');
            y += 22;
        }
        y += 3;
    }
    if (c.showHeatmap) {
        const asOf = s.heatmap?.asOf || s.days.at(-1)?.date || s.since;
        const calendar = calendarCells(c.heatmapView, asOf, s.heatmap?.days || s.days);
        const metric = c.heatmapMetric;
        const max = Math.max(0, ...calendar.cells.map((d) => d[metric]));
        const label = {
            requests: "DAILY CALLS",
            tokens: "DAILY TOKENS",
            cost: "DAILY EST. COST",
        }[metric];
        text(pad, y, label, 8, p.muted, 'letter-spacing="1"');
        text(w - pad, y, c.heatmapView === "year"
            ? "LAST 53 WEEKS"
            : c.heatmapView === "month"
                ? `MONTH · ${asOf.slice(0, 7)}`
                : `WEEK · ${calendar.start.slice(5)} – ${calendar.end.slice(5)}`, 8, p.muted, 'text-anchor="end"');
        y += 19;
        const columns = Math.ceil((calendar.offset + calendar.cells.length) / 7);
        const gridX = pad + 26, pitch = Math.min(15, (w - pad - gridX) / columns);
        const gap = Math.min(3, Math.max(1, pitch * 0.2)), size = pitch - gap;
        const months = [
            "Jan",
            "Feb",
            "Mar",
            "Apr",
            "May",
            "Jun",
            "Jul",
            "Aug",
            "Sep",
            "Oct",
            "Nov",
            "Dec",
        ];
        let previousMonth = "", labelEnd = -Infinity;
        for (const d of calendar.cells) {
            if (d.future)
                continue;
            const month = d.date.slice(0, 7), x = gridX + Math.floor(d.index / 7) * pitch;
            if (month !== previousMonth) {
                if ((c.heatmapView !== "year" || d.date.endsWith("-01")) &&
                    x >= labelEnd && x + 19 <= w - pad) {
                    text(x, y, months[Number(d.date.slice(5, 7)) - 1], 8);
                    labelEnd = x + 25;
                }
                previousMonth = month;
            }
        }
        y += 9;
        for (const [row, name] of [
            [0, "Mon"],
            [2, "Wed"],
            [4, "Fri"],
            [6, "Sun"],
        ])
            text(pad, y + row * pitch + size / 2 + 2.5, name, Math.min(8, pitch + 1));
        const empty = dark ? "#202734" : "#EFF0F4";
        const color = (level) => {
            const rgb = (hex, i) => parseInt(hex.slice(i, i + 2), 16);
            return ("#" +
                [1, 3, 5]
                    .map((i) => Math.round(rgb(empty, i) + ((rgb(p.purple, i) - rgb(empty, i)) * level) / 4)
                    .toString(16)
                    .padStart(2, "0"))
                    .join(""));
        };
        for (const d of calendar.cells) {
            // Future dates are empty space, not recorded zero-usage days.
            if (d.future)
                continue;
            const col = Math.floor(d.index / 7), row = d.index % 7, value = d[metric];
            const level = value > 0 && max > 0 ? Math.max(1, Math.ceil((value / max) * 4)) : 0;
            const detail = metric === "cost"
                ? `$${value.toFixed(2)} estimated USD`
                : `${value} ${metric}`;
            content.push(`<rect data-date="${d.date}" data-col="${col}" data-row="${row}" data-level="${level}" x="${(gridX + col * pitch).toFixed(2)}" y="${(y + row * pitch).toFixed(2)}" width="${size.toFixed(2)}" height="${size.toFixed(2)}" rx="${Math.min(3, size * 0.28).toFixed(2)}" fill="${color(level)}"><title>${escapeXml(`${d.date}: ${detail}`)}</title></rect>`);
        }
        y += 7 * pitch + 9;
        text(pad, y + 7, `${calendar.start} → ${asOf}`, compactLayout ? 7 : 8);
        const legendX = w - pad - 77;
        text(legendX - 7, y + 7, "Less", 8, p.muted, 'text-anchor="end"');
        for (let level = 0; level < 5; level++)
            content.push(`<rect x="${legendX + level * 11}" y="${y}" width="8" height="8" rx="2" fill="${color(level)}"/>`);
        text(w - pad, y + 7, "More", 8, p.muted, 'text-anchor="end"');
        y += 24;
    }
    if (c.showCost) {
        text(pad, y, `EST. COST  $${s.estimatedCost.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${s.unpriced ? "  · excludes unpriced usage" : ""}`, compactLayout ? 8 : 9);
        y += 19;
    }
    rule(y);
    y += 19;
    text(pad, y, `UPDATED ${updated}`, 8, p.muted, 'letter-spacing="1"');
    text(w - pad, y, "LOCAL → GITHUB", 8, p.muted, 'text-anchor="end" letter-spacing="1"');
    const h = Math.ceil(y + 17);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="title desc">
<title id="title">Magpie AI Usage Statistics</title><desc id="desc">${escapeXml(`${periodLabel}: ${s.tokens} tokens, ${s.requests} requests, ${s.activeDays} active days. Tokens equal input plus output.`)}</desc>
<defs><linearGradient id="accent"><stop stop-color="${p.purple}"/><stop offset=".55" stop-color="${c.theme === "aurora" ? "#6388EE" : p.purple}"/><stop offset="1" stop-color="${p.cyan}"/></linearGradient><linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop stop-color="${p.purple}" stop-opacity=".25"/><stop offset="1" stop-color="${p.cyan}" stop-opacity=".015"/></linearGradient><radialGradient id="glow"><stop stop-color="${p.purple}" stop-opacity="${dark ? ".15" : ".09"}"/><stop offset="1" stop-color="${p.bg}" stop-opacity="0"/></radialGradient><clipPath id="card"><rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="16"/></clipPath></defs>
<g clip-path="url(#card)"><rect width="${w}" height="${h}" fill="${p.bg}"/>${c.theme === "minimal" ? "" : `<ellipse cx="${w * 0.8}" cy="0" rx="${w * 0.65}" ry="${h * 0.8}" fill="url(#glow)"/>`}<g font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif">${content.join("\n")}</g></g><rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="16" fill="none" stroke="${p.line}"/>
</svg>\n`;
}
export function readmeSnippet(c, branch = c.branch || "main") {
    const repo = c.repository || "USERNAME/USERNAME";
    const base = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/${c.folder ? c.folder + "/" : ""}`;
    return `<p align="center">\n  <a href="https://github.com/${repo.split("/")[0]}">\n    <picture>\n      <source media="(prefers-color-scheme: dark)" srcset="${base}magpie-dark.svg">\n      <img src="${base}magpie-light.svg" width="${c.width}" alt="Magpie AI Usage Statistics">\n    </picture>\n  </a>\n</p>`;
}
