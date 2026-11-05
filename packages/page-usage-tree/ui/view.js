// What the page says, in English and Chinese, with no DOM: the test loads
// it. The page's app.js draws with it.
(function (root) {
  const PERIODS = ["today", "7d", "30d", "all"];
  const SORTS = ["tokens", "cost", "calls", "name"];
  const I18N = globalThis.UsageI18n;

  let lang = "en";
  function text(which) {
    return I18N.get(which);
  }

  let chineseUnits = false;
  const short = (value) => {
    const text = value.toFixed(2).replace(/\.?0+$/, "");
    return text || "0";
  };
  function count(value, useChinese = chineseUnits) {
    const n = Number(value) || 0;
    if (Math.abs(n) < 1000) return String(Math.round(n));
    // Magpie shortens a count in 万 and 亿 only when it speaks Chinese.
    if (useChinese && lang === "zh") {
      if (n >= 1e8) return `${+(n / 1e8).toFixed(2)}亿`;
      if (n >= 1e4) return `${+(n / 1e4).toFixed(1)}万`;
    }
    if (n >= 1e9) return `${short(n / 1e9)}B`;
    if (n >= 1e6) return `${short(n / 1e6)}M`;
    if (n >= 1e3) return `${short(n / 1e3)}K`;
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

  function has(value, query) {
    return String(value || "").toLowerCase().includes(query);
  }

  function accountSelfMatches(account, query) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return true;
    return (
      has(account?.alias, q) ||
      has(account?.account, q) ||
      has(account?.providerName, q) ||
      has(account?.provider, q)
    );
  }

  function modelMatches(model, query) {
    const q = String(query || "").trim().toLowerCase();
    return !q || has(model?.model, q) || has(model?.name, q);
  }

  function accountMatches(account, query) {
    if (accountSelfMatches(account, query)) return true;
    return Array.isArray(account?.models) && account.models.some((model) => modelMatches(model, query));
  }

  function providerMatches(provider, query) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return true;
    return (
      has(provider?.providerName, q) ||
      has(provider?.provider, q) ||
      has(provider?.id, q)
    );
  }

  function visibleAccounts(provider, query) {
    const list = Array.isArray(provider?.accounts) ? provider.accounts : [];
    if (providerMatches(provider, query)) return [...list];
    return list.filter((account) => accountMatches(account, query));
  }

  // Magpie reports fresh input/output and cache as separate totals. Some
  // providers bill cache beside the request, so the page can choose whether
  // cache belongs in the token measure. allTokens is the gateway's direct
  // answer when present; the sum fallback keeps older cached reads working.
  function tokenTotal(item, includeCache = true) {
    const tokens = Number(item?.tokens) || 0;
    if (!includeCache) return tokens;
    const allTokens = Number(item?.allTokens);
    return Number.isFinite(allTokens) && allTokens >= tokens ? allTokens : tokens + (Number(item?.cache) || 0);
  }

  // Sorting lives here so an empty answer, a missing field or a stale cached
  // row can never make the page throw while it redraws.
  function sortProviders(list, sort, includeCache = true) {
    const rows = Array.isArray(list) ? [...list] : [];
    const tokenOf = (item) => tokenTotal(item, includeCache);
    const costOf = (item) => Number(item?.cost) || 0;
    const callsOf = (item) => Number(item?.calls) || 0;
    const nameOf = (item) => String(item?.providerName || item?.provider || item?.id || "");
    return rows.sort((a, b) => {
      if (sort === "name") return nameOf(a).localeCompare(nameOf(b));
      if (sort === "cost") return costOf(b) - costOf(a) || tokenOf(b) - tokenOf(a);
      if (sort === "calls") return callsOf(b) - callsOf(a) || tokenOf(b) - tokenOf(a);
      return tokenOf(b) - tokenOf(a) || costOf(b) - costOf(a);
    });
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
    const rate = Number(usdCny) > 0 ? Number(usdCny) : 0;
    const cny = currency === "cny" && rate > 0;
    const amount = cny ? value * rate : value;
    const symbol = cny ? "¥" : "$";
    const digits = amount >= 100 ? 0 : amount >= 1 ? 2 : 3;
    return `${symbol}${amount.toFixed(digits)}${unpriced ? "+" : ""}`;
  }

  function tiles(summary, lang, currency, usdCny, includeCache = true) {
    const w = text(lang);
    const accounts = Number(summary.accounts) || 0;
    const tokenLabel = includeCache ? w.tokensWithCache : w.tokensWithoutCache;
    const providers = Number(summary.providers ?? 0) || 0;
    const models = Number(summary.models) || 0;
    const accountSub = w.providerModels
      ? w.providerModels(providers, models)
      : `${count(providers)} ${w.providers} · ${count(models)} ${w.models}`;
    return [
      {
        key: "accounts",
        label: w.accounts,
        value: count(accounts),
        sub: accountSub,
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
        label: tokenLabel,
        value: count(tokenTotal(summary, includeCache)),
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

  function accounts(list, sort, lang, currency = "usd", usdCny = 0, includeCache = true) {
    const w = text(lang);
    const rows = [...list];
    const tokenOf = (item) => tokenTotal(item, includeCache);
    const totalTokens = rows.reduce((sum, item) => sum + tokenOf(item), 0);
    const maxTokens = Math.max(1, ...rows.map(tokenOf));
    rows.sort((a, b) => {
      if (sort === "name") return a.account.localeCompare(b.account);
      if (sort === "cost") return b.cost - a.cost || tokenOf(b) - tokenOf(a);
      if (sort === "calls") return b.calls - a.calls || tokenOf(b) - tokenOf(a);
      return tokenOf(b) - tokenOf(a) || b.cost - a.cost;
    });
    return rows.map((account) => ({
      id: account.id,
      name: account.alias || account.account,
      account: account.account,
      provider: account.providerName,
      calls: count(account.calls),
      tokens: count(tokenOf(account)),
      share: percent(totalTokens > 0 ? tokenOf(account) / totalTokens : account.share),
      bar: Math.max(0.015, tokenOf(account) / maxTokens),
      cost: money(account.cost, account.unpriced, account.calls, currency, usdCny),
      errors: account.errors ? `${count(account.errors)} ${w.failed}` : w.allOk,
      errorRate: errorRate(account.errors, account.calls),
      models: account.models.length,
    }));
  }

  function models(account, lang, currency, usdCny, includeCache = true) {
    const w = text(lang);
    const tokenOf = (model) => tokenTotal(model, includeCache);
    const totalTokens = account.models.reduce((sum, model) => sum + tokenOf(model), 0);
    const maxTokens = Math.max(1, ...account.models.map(tokenOf));
    return account.models.map((model) => ({
      id: model.id,
      name: model.model,
      provider: model.providerName,
      calls: count(model.calls),
      tokens: count(tokenOf(model)),
      share: percent(totalTokens > 0 ? tokenOf(model) / totalTokens : model.share),
      bar: Math.max(0.02, tokenOf(model) / maxTokens),
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
    accountSelfMatches,
    modelMatches,
    accountMatches,
    providerMatches,
    visibleAccounts,
    tokenTotal,
    sortProviders,
    shareWord,
    money,
    tiles,
    accounts,
    models,
    setChineseUnits(value) { chineseUnits = value === true; },
    setLang(value) {
      lang = String(value || "").toLowerCase().startsWith("zh") ? "zh" : "en";
      chineseUnits = chineseUnits && lang === "zh";
    },
  };
})(globalThis);
