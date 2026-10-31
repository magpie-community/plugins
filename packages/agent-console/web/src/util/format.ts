// Small time/number formatting helpers.
import { getIntlLocale, getLocale, t, tf } from "../i18n/index.js";

export function relTime(ts: number, now = Date.now()): string {
  const d = Math.max(0, now - ts);
  const m = Math.floor(d / 60000);
  if (m < 1) return t("common.justNow");
  if (m < 60) return tf("common.minutesAgo", { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return tf("common.hoursAgo", { n: h });
  const day = Math.floor(h / 24);
  if (day < 7) return tf("common.daysAgo", { n: day });
  const dt = new Date(ts);
  const loc = getIntlLocale();
  if (getLocale() === "zh") return `${dt.getMonth() + 1}/${dt.getDate()}`;
  return dt.toLocaleDateString(loc, { month: "short", day: "numeric" });
}

export function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function fmtCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

export function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
}
