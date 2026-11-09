// What the card says, worked out from usage:day without the DOM, so a test
// can check it. A classic script: it sets globalThis.DayView.
(() => {
  const TEXT = {
    en: {
      tokens: "tokens", calls: (n) => (n === 1 ? "1 call" : `${n} calls`), errors: (n) => (n === 1 ? "1 error" : `${n} errors`),
      input: "Input", output: "Output", cacheRead: "Cache read", hit: "Cache hits", agents: "Agents",
      streak: "Streak", days: (n) => (n === 1 ? "1 day" : `${n} days`), average: "Average active day",
      noCalls: "No calls on this day.", more: (n) => `+${n} more`, unpriced: (n) => (n === 1 ? "1 call without a price" : `${n} calls without a price`),
      today: "Today", prev: "Previous day", next: "Next day", copy: "Copy image", copied: "Copied", save: "Save PNG", saved: "Saved to",
      failed: "Couldn't read usage", shareFailed: "Couldn't share the picture", update: "This card needs a newer magpie. Update magpie, then open it again.",
      noAgent: "No agent named",
    },
    zh: {
      tokens: "token", calls: (n) => `${n} 次调用`, errors: (n) => `${n} 次错误`,
      input: "输入", output: "输出", cacheRead: "缓存读取", hit: "缓存命中", agents: "Agent",
      streak: "连续使用", days: (n) => `${n} 天`, average: "活跃日均",
      noCalls: "这一天没有调用。", more: (n) => `还有 ${n} 个`, unpriced: (n) => `${n} 次调用没有价格`,
      today: "今天", prev: "前一天", next: "后一天", copy: "复制图片", copied: "已复制", save: "保存 PNG", saved: "已保存到",
      failed: "读取用量失败", shareFailed: "分享图片失败", update: "这个卡片需要更新版本的 magpie。请更新 magpie 后再打开。",
      noAgent: "未标明 Agent",
    },
    "zh-TW": {
      tokens: "token", calls: (n) => `${n} 次呼叫`, errors: (n) => `${n} 次錯誤`,
      input: "輸入", output: "輸出", cacheRead: "快取讀取", hit: "快取命中", agents: "Agent",
      streak: "連續使用", days: (n) => `${n} 天`, average: "活躍日均",
      noCalls: "這一天沒有呼叫。", more: (n) => `還有 ${n} 個`, unpriced: (n) => `${n} 次呼叫沒有價格`,
      today: "今天", prev: "前一天", next: "後一天", copy: "複製圖片", copied: "已複製", save: "儲存 PNG", saved: "已儲存到",
      failed: "讀取用量失敗", shareFailed: "分享圖片失敗", update: "這張卡片需要更新版本的 magpie。請更新 magpie 後再開啟。",
      noAgent: "未標明 Agent",
    },
    ja: {
      tokens: "トークン", calls: (n) => `${n} 回の呼び出し`, errors: (n) => `${n} 件のエラー`,
      input: "入力", output: "出力", cacheRead: "キャッシュ読み取り", hit: "キャッシュヒット", agents: "エージェント",
      streak: "連続日数", days: (n) => `${n} 日`, average: "稼働日の平均",
      noCalls: "この日の呼び出しはありません。", more: (n) => `ほか ${n} 件`, unpriced: (n) => `価格のない呼び出し ${n} 回`,
      today: "今日", prev: "前の日", next: "次の日", copy: "画像をコピー", copied: "コピーしました", save: "PNG を保存", saved: "保存先",
      failed: "使用量を読み込めませんでした", shareFailed: "画像を共有できませんでした", update: "このカードには新しい magpie が必要です。magpie を更新してから開き直してください。",
      noAgent: "エージェント名なし",
    },
    de: {
      tokens: "Tokens", calls: (n) => (n === 1 ? "1 Aufruf" : `${n} Aufrufe`), errors: (n) => (n === 1 ? "1 Fehler" : `${n} Fehler`),
      input: "Eingabe", output: "Ausgabe", cacheRead: "Cache gelesen", hit: "Cache-Treffer", agents: "Agents",
      streak: "Serie", days: (n) => (n === 1 ? "1 Tag" : `${n} Tage`), average: "Durchschnitt aktiver Tage",
      noCalls: "An diesem Tag keine Aufrufe.", more: (n) => `+${n} weitere`, unpriced: (n) => (n === 1 ? "1 Aufruf ohne Preis" : `${n} Aufrufe ohne Preis`),
      today: "Heute", prev: "Vorheriger Tag", next: "Nächster Tag", copy: "Bild kopieren", copied: "Kopiert", save: "PNG sichern", saved: "Gesichert in",
      failed: "Nutzung nicht lesbar", shareFailed: "Bild nicht teilbar", update: "Diese Karte braucht ein neueres magpie. Aktualisiere magpie und öffne sie dann erneut.",
      noAgent: "Ohne Agent",
    },
  };

  // magpie's languages; anything else reads English
  function langOf(lang) {
    const l = String(lang || "").toLowerCase();
    if (l.startsWith("zh")) return /^zh[-_](tw|hk|mo|hant)/.test(l) ? "zh-TW" : "zh";
    if (l.startsWith("ja")) return "ja";
    if (l.startsWith("de")) return "de";
    return "en";
  }
  const text = (lang) => TEXT[langOf(lang)];

  // 1234 → "1,234"; 1234567 → "1.23M"
  function count(n) {
    n = Number(n) || 0;
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 1 : 2) + "B";
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 1 : 2) + "M";
    if (a >= 1e5) return (n / 1e3).toFixed(0) + "K";
    return Math.round(n).toLocaleString("en-US");
  }

  // a cost in USD, shown as magpie's Settings has it: in CNY at its rate
  function money(usd, currency, rate) {
    let n = Number(usd) || 0;
    let sign = "$";
    if (currency === "cny" && Number(rate) > 0) {
      n *= Number(rate);
      sign = "¥";
    }
    if (n === 0) return sign + "0";
    if (n < 0.01) return "<" + sign + "0.01";
    return sign + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // every token the day moved: in, out, and through the cache (as
  // usage:day's days count them)
  const tokensOf = (t) => (Number(t?.input) || 0) + (Number(t?.output) || 0) + (Number(t?.cacheRead) || 0) + (Number(t?.cacheWrite) || 0);

  // the share of the prompt read from the cache, of the calls whose vendor
  // counts a cache; null when none did
  function hitRate(t) {
    const read = Number(t?.cacheRead) || 0;
    const prompt = (Number(t?.input) || 0) + read + (Number(t?.cacheWrite) || 0) - (Number(t?.cacheUnknown) || 0);
    if (prompt <= 0) return null;
    return Math.min(1, read / prompt);
  }

  function percent(r) {
    if (r == null) return "–";
    const p = r * 100;
    return (p > 0 && p < 1 ? p.toFixed(1) : Math.round(p)) + "%";
  }

  // YYYY-MM-DD arithmetic, by the calendar alone
  function shift(date, n) {
    const [y, m, d] = String(date).split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }

  // "Sun, Nov 9, 2026" in the reader's language
  function dateLabel(date, lang, short) {
    const [y, m, d] = String(date).split("-").map(Number);
    if (!y || !m || !d) return String(date || "");
    const at = new Date(Date.UTC(y, m - 1, d, 12));
    const o = short ? { month: "short", day: "numeric", timeZone: "UTC" } : { weekday: "short", year: "numeric", month: "short", day: "numeric", timeZone: "UTC" };
    try {
      return at.toLocaleDateString(langOf(lang), o);
    } catch {
      return date;
    }
  }

  // the days in a row with calls that end on date; a today with none yet
  // keeps yesterday's streak going
  function streak(days, date, today) {
    const had = new Set((days || []).filter((d) => Number(d.calls) > 0).map((d) => d.date));
    let at = date;
    if (!had.has(at) && at === today) at = shift(at, -1);
    let n = 0;
    while (had.has(at)) {
      n++;
      at = shift(at, -1);
    }
    return n;
  }

  // the average of the days with calls up to date: tokens and cost
  function average(days, date) {
    const list = (days || []).filter((d) => d.date <= date && Number(d.calls) > 0);
    if (!list.length) return null;
    const sum = list.reduce((s, d) => ({ tokens: s.tokens + (Number(d.tokens) || 0), cost: s.cost + (Number(d.cost) || 0) }), { tokens: 0, cost: 0 });
    return { days: list.length, tokens: sum.tokens / list.length, cost: sum.cost / list.length };
  }

  // the n days ending on date, each with its tokens (0 for none): the card's
  // small bars
  function recent(days, date, n = 14) {
    const by = new Map((days || []).map((d) => [d.date, Number(d.tokens) || 0]));
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = shift(date, -i);
      out.push({ date: d, tokens: by.get(d) || 0 });
    }
    return out;
  }

  // The card, as words and shares the drawing lays out:
  // { date, headline, sub, stats[], agents[{name, icon, value, share,
  //   models[{name, icon, value, share}], more}], moreAgents, streak,
  //   average, bars[], note, empty }
  // An agent shows its first `models` models, and the card its first
  // `agents` agents.
  function card(day, lang, limits = {}) {
    const t = text(lang);
    const maxAgents = limits.agents ?? 6;
    const maxModels = limits.models ?? 4;
    const cur = day.currency;
    const rate = day.rate;
    const total = tokensOf(day);
    const calls = Number(day.calls) || 0;
    const errors = Number(day.errors) || 0;
    const agents = (Array.isArray(day.agents) ? day.agents : []).slice();
    const top = agents.reduce((m, a) => Math.max(m, tokensOf(a)), 0);
    const shown = agents.slice(0, maxAgents).map((a) => {
      const models = Array.isArray(a.models) ? a.models : [];
      const mtop = models.reduce((m, x) => Math.max(m, tokensOf(x)), 0);
      const hidden = Math.max(0, models.length - maxModels) + (Number(a.moreModels) || 0);
      return {
        name: a.id ? String(a.name || a.id) : t.noAgent,
        icon: a.icon || "",
        value: `${count(tokensOf(a))} · ${money(a.cost, cur, rate)}`,
        share: top > 0 ? tokensOf(a) / top : 0,
        models: models.slice(0, maxModels).map((m) => ({
          name: String(m.model || "?"),
          icon: m.icon || "",
          value: count(tokensOf(m)),
          share: mtop > 0 ? tokensOf(m) / mtop : 0,
        })),
        more: hidden ? t.more(hidden) : "",
      };
    });
    const hiddenAgents = Math.max(0, agents.length - maxAgents) + (Number(day.moreAgents) || 0);
    const avg = average(day.days, day.date);
    const s = streak(day.days, day.date, day.today);
    const subs = [money(day.cost, cur, rate), t.calls(calls)];
    if (errors) subs.push(t.errors(errors));
    return {
      date: dateLabel(day.date, lang),
      headline: count(total),
      unit: t.tokens,
      sub: subs.join(" · "),
      stats: [
        { label: t.input, value: count(day.input) },
        { label: t.output, value: count(day.output) },
        { label: t.cacheRead, value: count(day.cacheRead) },
        { label: t.hit, value: percent(hitRate(day)) },
      ],
      agentsLabel: t.agents,
      agents: shown,
      moreAgents: hiddenAgents ? t.more(hiddenAgents) : "",
      streak: { label: t.streak, value: t.days(s) },
      average: { label: t.average, value: avg ? `${count(avg.tokens)} · ${money(avg.cost, cur, rate)}` : "–" },
      bars: recent(day.days, day.date),
      note: Number(day.unpriced) > 0 ? t.unpriced(Number(day.unpriced)) : "",
      empty: calls === 0 ? t.noCalls : "",
    };
  }

  // the file a saved card is named
  const fileName = (date) => `magpie ${date}`;

  globalThis.DayView = { TEXT, langOf, text, count, money, tokensOf, hitRate, percent, shift, dateLabel, streak, average, recent, card, fileName };
})();
