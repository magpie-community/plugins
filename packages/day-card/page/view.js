// What the card says, worked out from usage:day without the DOM, so a test
// can check it. A classic script: it sets globalThis.DayView.
//
// The card is a receipt: a title, the day and when it was issued, the day's
// cost, streak, requests and how it compares with an average day, each
// agent with its models by cost, then the tokens.
(() => {
  const TEXT = {
    en: {
      title: "DAILY AI STATEMENT", tagline: "Routed through magpie.",
      date: "DATE", issued: "ISSUED", at: "AT",
      total: "TOTAL API COST", totalNote: "API-EQUIVALENT COST · NOT AN INVOICE",
      streak: "STREAK", days: (n) => (n === 1 ? "1 DAY" : `${n} DAYS`), requests: "REQUESTS", errors: "ERRORS", vsAverage: "VS AVERAGE DAY",
      agentModel: "AGENT / MODEL", cost: "COST",
      totalTokens: "TOTAL TOKENS", input: "INPUT", output: "OUTPUT", hit: "CACHE HIT RATE",
      footer: [["Get ", "magpie", " at usemagpie.ai"], ["Every agent's AI usage, on Mac, Windows and Linux"]],
      noCalls: "No calls on this day.", more: (n) => `+${n} MORE`, unpriced: (n) => (n === 1 ? "1 request without a price" : `${n} requests without a price`),
      noAgent: "NO AGENT NAMED",
      today: "Today", prev: "Previous day", next: "Next day", copy: "Copy image", copied: "Copied", save: "Save PNG", saved: "Saved to",
      failed: "Couldn't read usage", shareFailed: "Couldn't share the picture", update: "This card needs a newer magpie. Update magpie, then open it again.",
    },
    zh: {
      title: "每日 AI 账单", tagline: "经 magpie 路由",
      date: "日期", issued: "开具", at: "",
      total: "API 总费用", totalNote: "按 API 价格折算 · 非发票",
      streak: "连续使用", days: (n) => `${n} 天`, requests: "请求数", errors: "错误", vsAverage: "对比日均",
      agentModel: "AGENT / 模型", cost: "费用",
      totalTokens: "TOKEN 总量", input: "输入", output: "输出", hit: "缓存命中率",
      footer: [["在 usemagpie.ai 下载 ", "magpie", ""], ["在 Mac、Windows、Linux 上统计每个 Agent 的 AI 用量"]],
      noCalls: "这一天没有调用。", more: (n) => `还有 ${n} 个`, unpriced: (n) => `${n} 次请求没有价格`,
      noAgent: "未标明 AGENT",
      today: "今天", prev: "前一天", next: "后一天", copy: "复制图片", copied: "已复制", save: "保存 PNG", saved: "已保存到",
      failed: "读取用量失败", shareFailed: "分享图片失败", update: "这个卡片需要更新版本的 magpie。请更新 magpie 后再打开。",
    },
    "zh-TW": {
      title: "每日 AI 帳單", tagline: "經 magpie 路由",
      date: "日期", issued: "開立", at: "",
      total: "API 總費用", totalNote: "按 API 價格折算 · 非發票",
      streak: "連續使用", days: (n) => `${n} 天`, requests: "請求數", errors: "錯誤", vsAverage: "對比日均",
      agentModel: "AGENT / 模型", cost: "費用",
      totalTokens: "TOKEN 總量", input: "輸入", output: "輸出", hit: "快取命中率",
      footer: [["在 usemagpie.ai 下載 ", "magpie", ""], ["在 Mac、Windows、Linux 上統計每個 Agent 的 AI 用量"]],
      noCalls: "這一天沒有呼叫。", more: (n) => `還有 ${n} 個`, unpriced: (n) => `${n} 次請求沒有價格`,
      noAgent: "未標明 AGENT",
      today: "今天", prev: "前一天", next: "後一天", copy: "複製圖片", copied: "已複製", save: "儲存 PNG", saved: "已儲存到",
      failed: "讀取用量失敗", shareFailed: "分享圖片失敗", update: "這張卡片需要更新版本的 magpie。請更新 magpie 後再開啟。",
    },
    ja: {
      title: "1日の AI 明細", tagline: "magpie 経由",
      date: "日付", issued: "発行", at: "",
      total: "API 合計コスト", totalNote: "API 料金換算 · 請求書ではありません",
      streak: "連続日数", days: (n) => `${n} 日`, requests: "リクエスト", errors: "エラー", vsAverage: "平均日との比較",
      agentModel: "エージェント / モデル", cost: "コスト",
      totalTokens: "合計トークン", input: "入力", output: "出力", hit: "キャッシュヒット率",
      footer: [["usemagpie.ai で ", "magpie", " を入手"], ["Mac・Windows・Linux で全エージェントの AI 使用量を"]],
      noCalls: "この日の呼び出しはありません。", more: (n) => `ほか ${n} 件`, unpriced: (n) => `価格のないリクエスト ${n} 件`,
      noAgent: "エージェント名なし",
      today: "今日", prev: "前の日", next: "次の日", copy: "画像をコピー", copied: "コピーしました", save: "PNG を保存", saved: "保存先",
      failed: "使用量を読み込めませんでした", shareFailed: "画像を共有できませんでした", update: "このカードには新しい magpie が必要です。magpie を更新してから開き直してください。",
    },
    de: {
      title: "TÄGLICHE KI-ABRECHNUNG", tagline: "Geroutet über magpie.",
      date: "DATUM", issued: "AUSGESTELLT", at: "UM",
      total: "API-GESAMTKOSTEN", totalNote: "API-ÄQUIVALENT · KEINE RECHNUNG",
      streak: "SERIE", days: (n) => (n === 1 ? "1 TAG" : `${n} TAGE`), requests: "ANFRAGEN", errors: "FEHLER", vsAverage: "VS. DURCHSCHNITTSTAG",
      agentModel: "AGENT / MODELL", cost: "KOSTEN",
      totalTokens: "TOKENS GESAMT", input: "EINGABE", output: "AUSGABE", hit: "CACHE-TREFFERQUOTE",
      footer: [["Hol dir ", "magpie", " auf usemagpie.ai"], ["Die KI-Nutzung jedes Agents, auf Mac, Windows und Linux"]],
      noCalls: "An diesem Tag keine Aufrufe.", more: (n) => `+${n} WEITERE`, unpriced: (n) => (n === 1 ? "1 Anfrage ohne Preis" : `${n} Anfragen ohne Preis`),
      noAgent: "OHNE AGENT",
      today: "Heute", prev: "Vorheriger Tag", next: "Nächster Tag", copy: "Bild kopieren", copied: "Kopiert", save: "PNG sichern", saved: "Gesichert in",
      failed: "Nutzung nicht lesbar", shareFailed: "Bild nicht teilbar", update: "Diese Karte braucht ein neueres magpie. Aktualisiere magpie und öffne sie dann erneut.",
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

  // 1234 → "1,234"; 1234567 → "1.23M"; 172e6 → "172M"; 10.1e9 → "10.1B"
  function count(n) {
    n = Number(n) || 0;
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 1 : 2) + "B";
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2) + "M";
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
    if (n === 0) return sign + "0.00";
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

  // "Sun, Nov 9, 2026" in the reader's language, for the day picker
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

  // "NOV 9, 2026" (2026年11月9日 …): the receipt's date
  function receiptDate(date, lang) {
    const [y, m, d] = String(date).split("-").map(Number);
    if (!y || !m || !d) return String(date || "");
    try {
      return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(langOf(lang), { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).toLocaleUpperCase();
    } catch {
      return date;
    }
  }

  // when the card was drawn: "NOV 9, 2026 AT 23:04", by this computer's clock
  function issued(now, lang) {
    const p = (n) => String(n).padStart(2, "0");
    const day = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
    const at = text(lang).at;
    return [receiptDate(day, lang), at, `${p(now.getHours())}:${p(now.getMinutes())}`].filter(Boolean).join(" ");
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

  // the average of the days with calls before date: tokens and cost
  function average(days, date) {
    const list = (days || []).filter((d) => d.date < date && Number(d.calls) > 0);
    if (!list.length) return null;
    const sum = list.reduce((s, d) => ({ tokens: s.tokens + (Number(d.tokens) || 0), cost: s.cost + (Number(d.cost) || 0) }), { tokens: 0, cost: 0 });
    return { days: list.length, tokens: sum.tokens / list.length, cost: sum.cost / list.length };
  }

  // the day against the average day before it, by cost (by tokens when
  // nothing had a price): "10.5×"
  function versus(day, avg) {
    if (!avg) return "–";
    let r = 0;
    if (avg.cost > 0 && Number(day.cost) > 0) r = Number(day.cost) / avg.cost;
    else if (avg.tokens > 0) r = tokensOf(day) / avg.tokens;
    else return "–";
    return (r >= 100 ? Math.round(r).toLocaleString("en-US") : r.toFixed(1)) + "×";
  }

  const byCost = (a, b) => (Number(b.cost) || 0) - (Number(a.cost) || 0) || tokensOf(b) - tokensOf(a);
  const upper = (s) => String(s).toLocaleUpperCase();

  // The receipt, as the drawing lays it out:
  // { title, tagline, head[{label, value}], totalLabel, total, totalNote,
  //   stats[], agentHead[2], agents[{name, icon, value, models[{name, icon,
  //   value}], more}], moreAgents, tokens[], note, empty, footer[[a, b, c]] }
  // An agent shows its first `models` models by cost, and the card its
  // first `agents` agents.
  function card(day, lang, limits = {}, now = new Date()) {
    const t = text(lang);
    const maxAgents = limits.agents ?? 8;
    const maxModels = limits.models ?? 5;
    const cur = day.currency;
    const rate = day.rate;
    const calls = Number(day.calls) || 0;
    const errors = Number(day.errors) || 0;
    const agents = (Array.isArray(day.agents) ? day.agents : []).slice().sort(byCost);
    const shown = agents.slice(0, maxAgents).map((a) => {
      const models = (Array.isArray(a.models) ? a.models : []).slice().sort(byCost);
      const hidden = Math.max(0, models.length - maxModels) + (Number(a.moreModels) || 0);
      return {
        name: upper(a.id ? a.name || a.id : t.noAgent),
        icon: a.icon || "",
        value: money(a.cost, cur, rate),
        models: models.slice(0, maxModels).map((m) => ({ name: upper(m.model || "?"), icon: m.icon || "", value: money(m.cost, cur, rate) })),
        more: hidden ? t.more(hidden) : "",
      };
    });
    const hiddenAgents = Math.max(0, agents.length - maxAgents) + (Number(day.moreAgents) || 0);
    const stats = [
      { label: t.streak, value: t.days(streak(day.days, day.date, day.today)) },
      { label: t.requests, value: calls.toLocaleString("en-US") },
    ];
    if (errors) stats.push({ label: t.errors, value: errors.toLocaleString("en-US") });
    stats.push({ label: t.vsAverage, value: versus(day, average(day.days, day.date)) });
    return {
      title: t.title,
      tagline: t.tagline,
      head: [
        { label: t.date, value: receiptDate(day.date, lang) },
        { label: t.issued, value: issued(now, lang) },
      ],
      totalLabel: t.total,
      total: money(day.cost, cur, rate),
      totalNote: t.totalNote,
      stats,
      agentHead: [t.agentModel, t.cost],
      agents: shown,
      moreAgents: hiddenAgents ? t.more(hiddenAgents) : "",
      tokens: [
        { label: t.totalTokens, value: count(tokensOf(day)) },
        { label: t.input, value: count(day.input) },
        { label: t.output, value: count(day.output) },
        { label: t.hit, value: percent(hitRate(day)) },
      ],
      note: Number(day.unpriced) > 0 ? t.unpriced(Number(day.unpriced)) : "",
      empty: calls === 0 ? t.noCalls : "",
      footer: t.footer,
    };
  }

  // the file a saved card is named
  const fileName = (date) => `magpie ${date}`;

  globalThis.DayView = { TEXT, langOf, text, count, money, tokensOf, hitRate, percent, shift, dateLabel, receiptDate, issued, streak, average, versus, card, fileName };
})();
