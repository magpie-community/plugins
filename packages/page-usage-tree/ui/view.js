// What the page says, in English and Chinese, with no DOM: the test loads
// it. The page's app.js draws with it.
(function (root) {
  const PERIODS = ["today", "7d", "30d", "all"];
  const SORTS = ["tokens", "cost", "calls", "name"];
  const SHARE_WORDS = {
    tokens: "Token 占比",
    cost: "费用占比",
    calls: "调用占比",
    name: "Token 占比",
  };

  const WORDS = {
    en: {
      accounts: "Accounts",
      providers: "providers",
      calls: "Calls",
      tokens: "Input + output tokens",
      cost: "Estimated cost",
      models: "models",
      failed: "failed",
      allOk: "all succeeded",
      unpriced: "calls not priced",
      noCalls: "No calls in this period",
      noMatch: "No matching account",
      updated: "Updated at",
    },
    zh: {
      accounts: "账号",
      providers: "供应商",
      calls: "调用",
      tokens: "输入 + 输出 Token",
      cost: "估算费用",
      models: "个模型",
      failed: "失败",
      allOk: "全部成功",
      unpriced: "次调用未定价",
      noCalls: "这个周期还没有账号用量",
      noMatch: "没有匹配的账号",
      updated: "更新于",
    },
  };

  function text(lang) {
    return WORDS[lang === "en" ? "en" : "zh"];
  }

  function count(value) {
    const n = Number(value) || 0;
    if (Math.abs(n) < 1000) return String(Math.round(n));
    return new Intl.NumberFormat("zh-CN", {
      notation: "compact",
      maximumFractionDigits: n >= 100000 ? 1 : 2,
    }).format(n);
  }

  function percent(value) {
    const n = Math.max(0, Number(value) || 0) * 100;
    if (n >= 10) return `${n.toFixed(0)}%`;
    if (n >= 1) return `${n.toFixed(1)}%`;
    return `${n.toFixed(2)}%`;
  }

  // shareWord names what a share is of, so a percentage keeps its meaning
  // when the list is sorted by cost or calls.
  function shareWord(sort) {
    return SHARE_WORDS[sort] || SHARE_WORDS.tokens;
  }

  function money(usd, unpriced, calls, currency, usdCny) {
    const value = Number(usd) || 0;
    if (calls > 0 && unpriced >= calls) return "未定价";
    const amount = currency === "usd" ? value : value * usdCny;
    const symbol = currency === "usd" ? "$" : "¥";
    const digits = amount >= 100 ? 0 : amount >= 1 ? 2 : 3;
    return `≈${symbol}${amount.toFixed(digits)}`;
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
        sub: summary.errors ? `${count(summary.errors)} ${w.failed}` : w.allOk,
        bad: summary.errors > 0,
      },
      {
        key: "tokens",
        label: w.tokens,
        value: count(summary.tokens),
        sub: `输入 ${count(summary.input)} · 输出 ${count(summary.output)} · 缓存 ${count(summary.cache)}`,
      },
      {
        key: "cost",
        label: w.cost,
        value: money(summary.cost, summary.unpriced, summary.calls, currency, usdCny),
        sub: summary.unpriced ? `${count(summary.unpriced)} ${w.unpriced}` : "",
      },
    ];
  }

  function accounts(list, sort, lang) {
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
      cost: money(account.cost, account.unpriced, account.calls, "cny", 7.2),
      errors: account.errors ? `${count(account.errors)} ${w.failed}` : w.allOk,
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
    shareWord,
    money,
    tiles,
    accounts,
    models,
  };
})(globalThis);
