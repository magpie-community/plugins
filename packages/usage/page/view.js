// What the page shows, worked out from usage:summary without the DOM, so
// a test can check it. A classic script: it sets globalThis.UsageView.
(() => {
  const TEXT = {
    en: {
      title: "Usage", today: "Today", "7d": "7 days", "30d": "30 days", models: "Models",
      tokens: "Tokens", calls: "Calls", cost: "Cost", errors: "Errors", input: "Input", output: "Output",
      cacheRead: "cache read", since: "Since", noCalls: "No calls in this period.", rate: "of calls",
      perCall: "per call", failed: "Couldn't read usage",
    },
    zh: {
      title: "用量", today: "今天", "7d": "7 天", "30d": "30 天", models: "模型",
      tokens: "Token", calls: "调用", cost: "费用", errors: "错误", input: "输入", output: "输出",
      cacheRead: "缓存读取", since: "起始于", noCalls: "这段时间没有调用。", rate: "的调用",
      perCall: "每次调用", failed: "读取用量失败",
    },
  };
  const PERIODS = ["today", "7d", "30d"];
  const SORTS = ["tokens", "calls", "cost"];

  function text(lang) {
    return String(lang || "").toLowerCase().startsWith("zh") ? TEXT.zh : TEXT.en;
  }

  // 1234 → "1,234"; 1234567 → "1.23M"
  function count(n) {
    n = Number(n) || 0;
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 1 : 2) + "B";
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 1 : 2) + "M";
    if (a >= 1e5) return (n / 1e3).toFixed(0) + "K";
    return Math.round(n).toLocaleString("en-US");
  }

  function money(n) {
    n = Number(n) || 0;
    if (n === 0) return "$0";
    if (n < 0.01) return "<$0.01";
    return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function percent(part, whole) {
    if (!whole) return "0%";
    const p = (part / whole) * 100;
    return (p < 1 && p > 0 ? p.toFixed(1) : Math.round(p)) + "%";
  }

  // tiles are the totals: [{ key, label, value, sub, bad }]
  function tiles(s, lang) {
    const t = text(lang);
    const calls = Number(s.calls) || 0;
    const errors = Number(s.errors) || 0;
    const input = Number(s.input) || 0;
    const output = Number(s.output) || 0;
    const cache = Number(s.cacheRead) || 0;
    const cost = Number(s.cost) || 0;
    return [
      { key: "calls", label: t.calls, value: count(calls), sub: "" },
      { key: "errors", label: t.errors, value: count(errors), sub: calls ? `${percent(errors, calls)} ${t.rate}` : "", bad: errors > 0 },
      { key: "tokens", label: t.tokens, value: count(input + output), sub: `${t.input} ${count(input)} · ${t.output} ${count(output)}` + (cache ? ` · ${t.cacheRead} ${count(cache)}` : "") },
      { key: "cost", label: t.cost, value: money(cost), sub: calls ? `${money(cost / calls)} ${t.perCall}` : "" },
    ];
  }

  // rows are the models, by sort: [{ name, value, detail, share }], share
  // being the bar's width, 0–1, of the first row's
  function rows(s, sort, lang) {
    if (!SORTS.includes(sort)) sort = "tokens";
    const of = (m) => (sort === "calls" ? Number(m.calls) || 0 : sort === "cost" ? Number(m.cost) || 0 : (Number(m.input) || 0) + (Number(m.output) || 0));
    const list = (Array.isArray(s.models) ? s.models : []).slice().sort((a, b) => of(b) - of(a) || String(a.model).localeCompare(String(b.model)));
    const top = list.length ? of(list[0]) : 0;
    return list.map((m) => ({
      name: String(m.model || "?"),
      value: sort === "cost" ? money(m.cost) : count(of(m)),
      detail: sort === "calls" ? money(m.cost) : `${count(m.calls)} ${text(lang).calls.toLowerCase()}`,
      share: top > 0 ? of(m) / top : 0,
    }));
  }

  // since is when the period starts, in the reader's own words
  function since(s, lang) {
    const t = text(lang);
    const d = new Date(s.since);
    if (!s.since || isNaN(d)) return "";
    const day = d.toLocaleDateString(lang || "en", { year: "numeric", month: "short", day: "numeric" });
    return `${t.since} ${day}`;
  }

  globalThis.UsageView = { PERIODS, SORTS, text, count, money, percent, tiles, rows, since };
})();
