// What the page says, in English and Chinese, with no DOM: the test loads
// it. The page's app.js draws with it.
(function (root) {
  const PERIODS = ["today", "7d", "30d", "all"];
  const SORTS = ["tokens", "cost", "calls", "name"];
  const I18N = globalThis.UsageI18n;

  let lang = "zh";
  function text(which) {
    return I18N.get(which);
  }

  let chineseUnits = false;
  function count(value, useChinese = chineseUnits) {
    const n = Number(value) || 0;
    if (Math.abs(n) < 1000) return String(Math.round(n));
    // Magpie shortens a count in 万 and 亿 only when it speaks Chinese.
    if (useChinese && lang !== "en") {
      if (n >= 1e8) return `${+(n / 1e8).toFixed(2)}亿`;
      if (n >= 1e4) return `${+(n / 1e4).toFixed(1)}万`;
    }
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e7) return `${Math.round(n / 1e6)}M`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e5) return `${Math.round(n / 1e3)}K`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return String(Math.round(n));
  }

  function percent(value) {
    const n = Math.max(0, Number(value) || 0) * 100;
    if (n >= 10) return `${n.toFixed(0)}%`;
    if (n >= 1) return `${n.toFixed(1)}%`;
    return `${n.toFixed(2)}%`;
  }

  // errorRate is errors of the calls that could have failed, so a row with
  // no calls reads as no rate rather than as 0%.
  function errorRate(errors, calls) {
    const bad = Math.max(0, Number(errors) || 0);
    const total = Math.max(0, Number(calls) || 0);
    if (!bad || !total) return "";
    return percent(bad / total);
  }

  // shareWord names what a share is of, so a percentage keeps its meaning
  // when the list is sorted by cost or calls.
  function shareWord(sort) {
    const share = text(lang).share;
    return share[sort] || share.tokens;
  }

  function money(usd, unpriced, calls, currency, usdCny) {
    const value = Number(usd) || 0;
    const words = text(lang);
    if (calls > 0 && unpriced >= calls) return words.unpricedOnly;
    const amount = currency === "usd" ? value : value * usdCny;
    const symbol = currency === "usd" ? "$" : "¥";
    const digits = amount >= 100 ? 0 : amount >= 1 ? 2 : 3;
    return `${symbol}${amount.toFixed(digits)}${unpriced ? "+" : ""}`;
  }

  function tiles(summary, lang, currency, usdCny) {
    const w = text(lang);
    return [
      {
        key: "accounts",
        label: w.accounts,
        value: count(summary.accounts),
        sub: `${count(summary.providers ?? 0)} ${w.providers} · ${count(summary.models)} ${w.models}`,
      },
      {
        key: "calls",
        label: w.calls,
        value: count(summary.calls),
        sub: summary.errors
          ? `${count(summary.errors)} ${w.failed} · ${errorRate(summary.errors, summary.calls)}`
          : w.allOk,
        bad: summary.errors > 0,
      },
      {
        key: "tokens",
        label: w.tokens,
        value: count(summary.tokens),
        sub: `${w.input} ${count(summary.input)} · ${w.output} ${count(summary.output)} · ${w.cache} ${count(summary.cache)}`,
      },
      {
        key: "cost",
        label: w.cost,
        value: money(summary.cost, summary.unpriced, summary.calls, currency, usdCny),
        sub: summary.unpriced ? `${count(summary.unpriced)} ${w.unpriced}` : "",
      },
    ];
  }

  function accounts(list, sort, lang, currency = "usd", usdCny = 0) {
    const w = text(lang);
    const rows = [...list];
    rows.sort((a, b) => {
      if (sort === "name") return a.account.localeCompare(b.account);
      if (sort === "cost") return b.cost - a.cost || b.tokens - a.tokens;
      if (sort === "calls") return b.calls - a.calls || b.tokens - a.tokens;
      return b.tokens - a.tokens || b.cost - a.cost;
    });
    return rows.map((account) => ({
      id: account.id,
      name: account.alias || account.account,
      account: account.account,
      provider: account.providerName,
      calls: count(account.calls),
      tokens: count(account.tokens),
      share: percent(account.share),
      bar: Math.max(0.015, account.bar),
      cost: money(account.cost, account.unpriced, account.calls, currency, usdCny),
      errors: account.errors ? `${count(account.errors)} ${w.failed}` : w.allOk,
      errorRate: errorRate(account.errors, account.calls),
      models: account.models.length,
    }));
  }

  function models(account, lang, currency, usdCny) {
    const w = text(lang);
    return account.models.map((model) => ({
      id: model.id,
      name: model.model,
      provider: model.providerName,
      calls: count(model.calls),
      tokens: count(model.tokens),
      share: percent(model.share),
      bar: Math.max(0.02, model.bar),
      cost: money(model.cost, model.unpriced, model.calls, currency, usdCny),
      errors: model.errors ? `${count(model.errors)} ${w.failed}` : "",
      errorRate: errorRate(model.errors, model.calls),
      unpriced: model.unpriced ? `${count(model.unpriced)} ${w.unpriced}` : "",
      hosts: (model.hostNotes || []).map((host) => `${host.account} ${count(host.calls)}`),
    }));
  }

  root.UsageView = {
    PERIODS,
    SORTS,
    text,
    count,
    percent,
    errorRate,
    shareWord,
    money,
    tiles,
    accounts,
    models,
    setChineseUnits(value) { chineseUnits = value === true; },
    setLang(value) { lang = value === "en" ? "en" : "zh"; },
  };
})(globalThis);
