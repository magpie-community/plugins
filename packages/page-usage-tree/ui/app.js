(() => {
  const V = globalThis.UsageView;
  let W = globalThis.UsageI18n.get(metaLang());
  // A plugin page runs in a sandboxed frame, whose origin is opaque: even
  // reading localStorage throws there. Fall back to memory so the page
  // still works, only without remembering the last filters.
  const store = (() => {
    const memory = new Map();
    return {
      get(key) {
        try {
          return localStorage.getItem(key);
        } catch {
          return memory.has(key) ? memory.get(key) : null;
        }
      },
      set(key, value) {
        try {
          localStorage.setItem(key, value);
        } catch {
          memory.set(key, String(value));
        }
      },
    };
  })();

  const meta = (name) =>
    document.querySelector(`meta[name="usage-tree-${name}"]`)?.getAttribute("content") || "";
  const token = meta("token");
  const theme = meta("theme") || "light";
  let lang = metaLang();
  let currency = meta("currency") === "cny" ? "cny" : "usd";
  let usdCny = Number(meta("usd-cny")) || 0;
  let chineseUnits = meta("chinese-units") === "true";
  V.setLang(lang);
  V.setChineseUnits(chineseUnits && lang === "zh");
  const saved = {
    period: store.get("usage-tree.period") || "today",
    sort: store.get("usage-tree.sort") || "tokens",
    includeCache: store.get("usage-tree.include-cache") !== "0",
    expanded: readSet("usage-tree.expanded"),
  };
  const validPeriods = new Set(["today", "7d", "30d", "all"]);
  const validSorts = new Set(["tokens", "cost", "calls", "name"]);

  const state = {
    period: validPeriods.has(saved.period) ? saved.period : "today",
    sort: validSorts.has(saved.sort) ? saved.sort : "tokens",
    includeCache: saved.includeCache,
    expanded: saved.expanded,
    openProviders: readSet("usage-tree.providers"),
    query: "",
    data: null,
    loading: false,
    error: "",
    loadedAt: 0,
    requestId: 0,
    controller: null,
    previewFirst: new URLSearchParams(location.search).get("preview") === "first",
  };

  const $ = (id) => document.getElementById(id);
  const summary = $("summary");
  const accounts = $("accounts");
  const stateCard = $("state-card");
  const warning = $("warning");
  const refresh = $("refresh");
  const progress = $("progress");
  const expandAll = $("expand-all");

  function metaLang() {
    return document.querySelector('meta[name="usage-tree-lang"]')?.getAttribute("content") || "en";
  }

  function applyI18n() {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    document.title = W.title;
    for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = W[node.dataset.i18n];
    for (const node of document.querySelectorAll("[data-i18n-period]")) node.textContent = W.periods[node.dataset.i18nPeriod];
    for (const node of document.querySelectorAll("[data-i18n-sort]")) node.textContent = W.sortBy[node.dataset.i18nSort];
    for (const node of document.querySelectorAll("[data-i18n-column]")) node.textContent = W.columns[node.dataset.i18nColumn];
    $("search").placeholder = W.search;
    $("period").setAttribute("aria-label", W.period);
    $("token-cache").title = W.includeCacheHint;
    $("token-cache").setAttribute("aria-checked", String(state.includeCache));
    $("sort").setAttribute("aria-label", W.sort);
    $("refresh").setAttribute("aria-label", W.refresh);
    $("refresh").title = W.refresh;
    updateExpandLabel();
    $("source-note").textContent = W.source;
  }

  // Magpie tells every open plugin page when its language, theme or
  // colours change. The page takes the words of the new language at
  // once, without a reload.
  function applyThemeEvent(data) {
    if (!data) return;
    if (data.tokens && typeof data.tokens === "object") {
      for (const [key, value] of Object.entries(data.tokens)) {
        if (typeof value === "string") {
          document.documentElement.style.setProperty(`--magpie-${key}`, value);
        }
      }
    }
    if (typeof data.dark === "boolean") {
      document.documentElement.dataset.theme = data.dark ? "dark" : "light";
    }
    if (typeof data.lang === "string") applyDisplay({ lang: data.lang });
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || message.magpie !== 1 || message.event !== "theme") return;
    // Only the window that frames this page may change its language.
    if (event.source !== window.parent || event.source === window) return;
    applyThemeEvent(message.data);
    // The theme message carries the language and the window colours. This
    // page's own presentation options are read once from the launcher URL;
    // nothing is polled.
  });

  // What the window sends lands here: the page redraws in place, without a
  // reload.
  function applyDisplay(display) {
    if (!display) return false;
    let changed = false;

    const wanted = String(display.lang || "").toLowerCase();
    // "system" means the window follows the OS: the window's own message
    // says which language that is, and this keeps the last one.
    if (wanted && wanted !== "system") {
      const nextLang = wanted.startsWith("zh") ? "zh" : "en";
      if (nextLang !== lang) {
        lang = nextLang;
        W = globalThis.UsageI18n.get(lang);
        V.setLang(lang);
        V.setChineseUnits(chineseUnits && lang === "zh");
        changed = true;
      }
    }
    if (typeof display.currency === "string") {
      const nextCurrency = display.currency === "cny" ? "cny" : "usd";
      if (nextCurrency !== currency) {
        currency = nextCurrency;
        changed = true;
      }
    }
    if (Number.isFinite(Number(display.usdCny))) {
      const nextRate = Number(display.usdCny);
      if (nextRate !== usdCny) {
        usdCny = nextRate;
        changed = true;
      }
    }
    if (typeof display.chineseUnits === "boolean") {
      const nextUnits = display.chineseUnits === true;
      if (nextUnits !== chineseUnits) {
        chineseUnits = nextUnits;
        V.setChineseUnits(chineseUnits && lang === "zh");
        changed = true;
      }
    }
    const nextTheme = display.theme === "dark" || display.theme === "light" ? display.theme : "";
    if (nextTheme && nextTheme !== document.documentElement.dataset.theme) {
      document.documentElement.dataset.theme = nextTheme;
      changed = true;
    }

    if (changed) {
      applyI18n();
      if (state.data) render();
      else applyTheme();
    }
    return changed;
  }

  applyI18n();
  applyTheme();
  buildSummarySkeleton();
  bind();
  load();

  function readSet(key) {
    try {
      const value = JSON.parse(store.get(key) || "[]");
      return new Set(Array.isArray(value) ? value.map(String) : []);
    } catch {
      return new Set();
    }
  }

  function saveSet() {
    store.set("usage-tree.expanded", JSON.stringify([...state.expanded]));
    store.set("usage-tree.providers", JSON.stringify([...state.openProviders]));
  }

  function applyTheme() {
    document.documentElement.dataset.theme = theme;
    try {
      const tokens = JSON.parse(meta("tokens") || "{}");
      for (const [key, value] of Object.entries(tokens)) {
        if (typeof value === "string") {
          document.documentElement.style.setProperty(`--magpie-${key}`, value);
        }
      }
    } catch {
      // Theme tokens are optional.
    }
  }

  function bind() {
    $("period").addEventListener("click", (event) => {
      const value = event.target.closest("button")?.dataset.period;
      if (!value || value === state.period) return;
      state.period = value;
      state.stalePolls = 0;
      store.set("usage-tree.period", value);
      renderPeriod();
      load({ force: true });
    });

    $("sort").addEventListener("click", (event) => {
      const value = event.target.closest("[data-sort]")?.dataset.sort;
      if (!value) return;
      state.sort = validSorts.has(value) ? value : "tokens";
      store.set("usage-tree.sort", state.sort);
      renderPeriod();
      renderAccounts();
    });

    $("token-cache").addEventListener("click", () => {
      state.includeCache = !state.includeCache;
      store.set("usage-tree.include-cache", state.includeCache ? "1" : "0");
      if (state.data) render();
      else buildSummarySkeleton();
    });

    $("search").addEventListener("input", (event) => {
      state.query = event.target.value.trim().toLowerCase();
      renderAccounts();
    });

    expandAll.addEventListener("click", () => {
      const providers = visibleProviders();
      const accounts = providers.flatMap((provider) => V.visibleAccounts(provider, state.query));
      const allOpen =
        providers.length > 0 &&
        providers.every((provider) => state.openProviders.has(provider.id)) &&
        accounts.every((account) => state.expanded.has(account.id));
      for (const provider of providers) {
        if (allOpen) state.openProviders.delete(provider.id);
        else state.openProviders.add(provider.id);
      }
      for (const account of accounts) {
        if (allOpen) state.expanded.delete(account.id);
        else state.expanded.add(account.id);
      }
      saveSet();
      renderAccounts();
    });

    refresh.addEventListener("click", () => {
      state.stalePolls = 0;
      load({ force: true });
    });

    window.addEventListener("focus", () => {
      if (Date.now() - state.loadedAt > 60_000) load();
    });
  }

  function renderPeriod() {
    for (const button of $("period").querySelectorAll("button")) {
      button.setAttribute("aria-selected", String(button.dataset.period === state.period));
    }
    for (const button of $("sort").querySelectorAll("[data-sort]")) {
      button.setAttribute("aria-selected", String(button.dataset.sort === state.sort));
    }
    $("token-cache").setAttribute("aria-checked", String(state.includeCache));
    expandAll.textContent = allExpanded() ? W.collapse : W.expand;
  }

  async function load(options = {}) {
    const requestedPeriod = state.period;
    const requestId = ++state.requestId;
    if (state.controller) state.controller.abort();
    clearTimeout(state.spinTimer);
    clearTimeout(state.staleTimer);
    state.controller = new AbortController();
    state.loading = true;
    state.error = "";
    const spinStarted = Date.now();
    if (!options.quiet) {
      refresh.classList.add("busy");
      refresh.disabled = true;
      progress.hidden = false;
      progress.setAttribute("aria-hidden", "false");
    }
    warning.hidden = true;
    if (!state.data) {
      stateCard.hidden = true;
      accounts.hidden = true;
      buildSummarySkeleton();
    }

    try {
      const fresh = options.force ? "&fresh=1" : "";
      const endpoint = new URL(`api/tree?period=${encodeURIComponent(requestedPeriod)}${fresh}`, location.href);
      const res = await fetch(endpoint.href, {
        headers: { "x-usage-tree-token": token },
        cache: "no-store",
        signal: AbortSignal.any([
          state.controller.signal,
          AbortSignal.timeout(10000),
        ]),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      if (requestId !== state.requestId || requestedPeriod !== state.period) return;
      const next = fingerprint(body);
      const changed = next !== state.fingerprint || !state.rendered;
      state.data = body;
      state.fingerprint = next;
      state.loadedAt = Date.now();
      // The service answers with the numbers it had and reads again behind
      // the page; ask for them again in a moment, so the page catches up
      // without the reader asking.
      if (body.stale) {
        const attempt = state.stalePolls = (state.stalePolls || 0) + 1;
        if (attempt <= 3) {
          clearTimeout(state.staleTimer);
          const delay = attempt === 1 ? 1200 : attempt === 2 ? 2500 : 5000;
          state.staleTimer = setTimeout(() => {
            if (!document.hidden && requestedPeriod === state.period) load({ quiet: true });
          }, delay);
        }
      } else {
        state.stalePolls = 0;
      }
      if (state.previewFirst && state.data.accounts?.length && !store.get("usage-tree.expanded")) {
        state.expanded.add(state.data.accounts[0].id);
      }
      if (changed) {
        state.rendered = true;
        render();
      } else {
        renderFoot();
      }
    } catch (error) {
      if (requestId !== state.requestId || error?.name === "AbortError") return;
      state.error = `${error?.name || "Error"}: ${error?.message || W.readFailed}`;
      if (state.data?.period === requestedPeriod) {
        warning.hidden = false;
        warning.textContent = W.refreshFailed;
        renderFoot();
        return;
      }
      renderError();
    } finally {
      if (requestId !== state.requestId) return;
      // A cached answer is over in tens of ms: hold the spin for a beat so
      // a press reads as a refresh. A slow read keeps it until it is done.
      const elapsed = Date.now() - spinStarted;
      const settle = () => {
        if (requestId !== state.requestId) return;
        state.loading = false;
        state.controller = null;
        refresh.classList.remove("busy");
        refresh.disabled = false;
        progress.hidden = true;
        progress.setAttribute("aria-hidden", "true");
      };
      if (options.quiet) {
        settle();
      } else if (elapsed >= 450) {
        settle();
      } else {
        state.spinTimer = setTimeout(settle, 450 - elapsed);
      }
    }
  }

  setTimeout(() => {
    if (!state.data && state.loading) {
      clearTimeout(state.spinTimer);
      state.error = W.serviceTimeout;
      renderError();
      state.loading = false;
      refresh.classList.remove("busy");
      refresh.disabled = false;
      progress.hidden = true;
      progress.setAttribute("aria-hidden", "true");
    }
  }, 10500);

  // What the page reads: if a read came back the same, nothing is redrawn.
  function fingerprint(data) {
    const summary = data?.summary || {};
    const cost = (value) => Number(value || 0).toFixed(6);
    const parts = [
      data?.period,
      summary.accounts,
      summary.providers,
      summary.models,
      summary.calls,
      summary.errors,
      summary.unpriced,
      summary.input,
      summary.output,
      summary.tokens,
      summary.cache,
      summary.allTokens,
      cost(summary.cost),
    ];
    for (const provider of data?.providers || []) {
      parts.push(
        provider.id,
        provider.providerName,
        provider.calls,
        provider.errors,
        provider.unpriced,
        provider.input,
        provider.output,
        provider.tokens,
        provider.cache,
        provider.allTokens,
        cost(provider.cost),
      );
      for (const account of provider.accounts || []) {
        parts.push(
          account.id,
          account.account,
          account.alias,
          account.providerName,
          account.calls,
          account.errors,
          account.unpriced,
          account.input,
          account.output,
          account.tokens,
          account.cache,
          account.allTokens,
          cost(account.cost),
          account.lastAt,
        );
        for (const model of account.models || []) {
          parts.push(
            model.id,
            model.model,
            model.provider,
            model.providerName,
            model.calls,
            model.errors,
            model.unpriced,
            model.input,
            model.output,
            model.tokens,
            model.cache,
            model.allTokens,
            cost(model.cost),
            JSON.stringify(model.hostNotes || []),
          );
        }
      }
    }
    return parts.join("|");
  }

  // The foot names when the numbers are from; the rows stay as they are.
  function renderFoot() {
    const data = state.data;
    if (!data) return;
    const source = data.source || "Magpie gateway usage";
    $("source-note").textContent = `${W.source} · ${source}`;
    $("updated").textContent = data.generatedAt
      ? `${W.updated} ${new Date(data.generatedAt).toLocaleTimeString(lang === "en" ? "en-US" : "zh-CN", { hour: "2-digit", minute: "2-digit" })}`
      : "";
  }

  function buildSummarySkeleton() {
    summary.replaceChildren(
      ...[W.accounts, W.calls, state.includeCache ? W.tokensWithCache : W.tokensWithoutCache, W.cost].map((label) => {
        const card = el("article", "summary-card loading");
        const head = el("div", "summary-label");
        head.append(icon("dot"), document.createTextNode(label));
        card.append(
          head,
          el("div", "summary-value", "—"),
          el("span", "summary-sub", W.firstRead),
        );
        return card;
      }),
    );
  }

  function render() {
    const data = state.data;
    if (!data) return;
    renderPeriod();
    renderSummary(data.summary || {});
    renderWarnings(data.warnings || []);
    renderAccounts();
    renderFoot();
  }

  function renderSummary(data) {
    // A read from before the three-level shape has no provider count; the
    // rows still know their providers, so count those.
    const summaryData = { ...data, providers: data.providers ?? providersOf(state.data).length };
    const items = V.tiles(summaryData, lang, currency, usdCny, state.includeCache).map((tile, index) => ({
      ...tile,
      icon: ["accounts", "calls", "tokens", "cost"][index],
    }));

    summary.replaceChildren(
      ...items.map((item) => {
        const card = el("article", "summary-card");
        const head = el("div", "summary-label");
        head.append(icon(item.icon), document.createTextNode(item.label));
        const value = el("div", "summary-value", item.value);
        if (item.bad) value.style.color = "var(--magpie-red)";
        card.append(head, value, el("span", "summary-sub", item.sub));
        return card;
      }),
    );
  }

  function renderWarnings(warnings) {
    if (!warnings.length) {
      warning.hidden = true;
      return;
    }
    warning.hidden = false;
    warning.textContent = warnings
      .map((item) => {
        if (typeof item === "string") return item;
        if (item.code === "no-usage") return W.noUsage;
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }

  function renderError() {
    state.rendered = false;
    summary.replaceChildren();
    accounts.replaceChildren();
    accounts.hidden = true;
    stateCard.hidden = false;
    stateCard.replaceChildren();
    const strong = el("strong", "", W.noData);
    const button = el("button", "", W.reload);
    button.type = "button";
    button.addEventListener("click", () => load({ force: true }));
    stateCard.append(strong, document.createTextNode(state.error), button);
  }

  function visibleAccounts() {
    return visibleProviders()
      .flatMap((provider) => V.visibleAccounts(provider, state.query));
  }

  function visibleProviders() {
    const list = [...providersOf(state.data)];
    const query = state.query;
    if (query) {
      list.splice(0, list.length, ...list.filter(
        (provider) => V.visibleAccounts(provider, query).length > 0,
      ));
    }
    return V.sortProviders(list, state.sort, state.includeCache);
  }

  // What the list draws: the providers the service sent. A read written
  // before the three-level shape existed has none, so its accounts are
  // grouped here rather than shown as "no usage".
  function providersOf(data) {
    if (Array.isArray(data?.providers) && data.providers.length) return data.providers;
    const accounts = data?.accounts || [];
    if (!accounts.length) return [];
    const byProvider = new Map();
    for (const account of accounts) {
      let provider = byProvider.get(account.provider);
      if (!provider) {
        provider = {
          id: account.provider,
          provider: account.provider,
          providerName: account.providerName,
          accounts: [],
          calls: 0,
          tokens: 0,
          cache: 0,
          allTokens: 0,
          cost: 0,
          errors: 0,
          unpriced: 0,
        };
        byProvider.set(account.provider, provider);
      }
      provider.accounts.push(account);
      provider.calls += account.calls || 0;
      provider.tokens += account.tokens || 0;
      provider.cache += account.cache || 0;
      provider.allTokens +=
        Number(account.allTokens) || (Number(account.tokens) || 0) + (Number(account.cache) || 0);
      provider.cost += account.cost || 0;
      provider.errors += account.errors || 0;
      provider.unpriced += account.unpriced || 0;
    }
    return [...byProvider.values()];
  }

  function renderAccounts() {
    if (!state.data) return;
    const list = visibleProviders();
    accounts.hidden = false;
    stateCard.hidden = true;

    if (!list.length) {
      accounts.hidden = true;
      stateCard.hidden = false;
      stateCard.replaceChildren(
        el("strong", "", state.query ? W.noMatch : W.noCalls),
        document.createTextNode(
          state.query
            ? W.noMatchHint
            : W.noCallsHint,
        ),
      );
      updateExpandLabel();
      return;
    }

    accounts.replaceChildren(...list.map((provider, index) => providerCard(provider, index)));
    updateExpandLabel();
  }

  function providerCard(provider, index) {
    const shownAccounts = V.visibleAccounts(provider, state.query);
    const article = el("section", "provider" + (state.openProviders.has(provider.id) ? " open" : ""));
    article.dataset.id = provider.id;
    article.style.animationDelay = `${Math.min(index, 8) * 30}ms`;

    const main = el("button", "provider-main");
    main.type = "button";
    main.setAttribute("aria-expanded", String(state.openProviders.has(provider.id)));

    const identity = el("div", "identity");
    const badge = el("span", "provider-badge", shortProvider(provider.provider));
    const identityText = el("div", "identity-text");
    const name = el("div", "level-name", provider.providerName);
    identityText.append(
      name,
      el("div", "level-sub", W.accountsAndModels(
        shownAccounts.filter((account) => account.kind !== "api-key").length,
        countModels(shownAccounts),
      )),
    );
    identity.append(badge, identityText);

    const calls = metric("", compact(provider.calls), "", "calls-cell");
    const all = providersOf(state.data);
    const total = totalForSort(all);
    const share = shareCell(provider, total, all);

    const cost = metric(
      "",
      money(provider.cost, provider.unpriced, provider.calls),
      "",
      "cost-cell" + (provider.unpriced ? " unpriced" : ""),
    );
    const errors = metric(
      "",
      provider.errors ? `${provider.errors} ${W.failed}` : W.allOk,
      V.errorRate(provider.errors, provider.calls),
      "errors-cell" + (provider.errors ? " bad" : ""),
    );
    const chevron = el("span", "chevron");
    chevron.append(icon("chevron"));

    main.append(identity, calls, ...share, cost, errors, chevron);
    main.addEventListener("click", () => {
      if (state.openProviders.has(provider.id)) state.openProviders.delete(provider.id);
      else state.openProviders.add(provider.id);
      saveSet();
      article.classList.toggle("open", state.openProviders.has(provider.id));
      main.setAttribute("aria-expanded", String(state.openProviders.has(provider.id)));
      updateExpandLabel();
    });

    const accountBox = el("div", "provider-accounts");
    const accounts = [...shownAccounts].sort(compareItems);
    for (const account of accounts) {
      accountBox.append(accountCard(account, provider.accounts));
    }
    article.append(main, accountBox);
    return article;
  }

  function compareItems(a, b) {
    if (state.sort === "name") {
      return (a.alias || a.account || a.model).localeCompare(b.alias || b.account || b.model);
    }
    return sortMetric(b) - sortMetric(a) || (a.alias || a.account || a.model).localeCompare(b.alias || b.account || b.model);
  }

  function countModels(accounts) {
    return accounts.reduce((sum, account) => sum + account.models.length, 0);
  }

  function accountCard(account, siblings) {
    const article = el("article", "account" + (state.expanded.has(account.id) ? " open" : ""));
    article.dataset.id = account.id;

    const main = el("button", "account-main");
    main.type = "button";
    main.setAttribute("aria-expanded", String(state.expanded.has(account.id)));

    const identity = el("div", "identity");
    const badge = el("span", "provider-badge", shortProvider(account.provider));
    const identityText = el("div", "identity-text");
      const name = el("div", "level-name", account.alias || account.account);
    name.title = account.account;
    const sub = el("div", "level-sub");
    // The provider is the row above, so the account says what is its own:
    // the raw sign-in when the reader named it, how many models, when last.
    const subParts = [
      account.alias ? account.account : "",
      account.kind === "api-key" ? W.apiKeyNote : "",
      W.modelsOnly(account.models.length),
      account.lastAt ? lastSeen(account.lastAt) : "",
    ].filter(Boolean);
    subParts.forEach((part, index) => {
      if (index) sub.append(el("i"));
      sub.append(document.createTextNode(part));
    });
    identityText.append(name, sub);
    identity.append(badge, identityText);

    const calls = metric("", compact(account.calls), "", "calls-cell");
    const share = shareCell(account, totalForSort(siblings), siblings);

    const cost = metric(
      "",
      money(account.cost, account.unpriced, account.calls),
      account.unpriced ? W.unpricedCalls(compact(account.unpriced)) : "",
      "cost-cell" + (account.unpriced ? " unpriced" : ""),
    );
    const errors = metric(
      "",
      account.errors ? `${account.errors} ${W.failed}` : W.allOk,
      V.errorRate(account.errors, account.calls),
      "errors-cell" + (account.errors ? " bad" : ""),
    );
    const chevron = el("span", "chevron");
    chevron.append(icon("chevron"));

    main.append(identity, calls, ...share, cost, errors, chevron);
    main.addEventListener("click", () => {
      if (state.expanded.has(account.id)) state.expanded.delete(account.id);
      else state.expanded.add(account.id);
      saveSet();
      article.classList.toggle("open", state.expanded.has(account.id));
      main.setAttribute("aria-expanded", String(state.expanded.has(account.id)));
      updateExpandLabel();
    });

    article.append(main, modelList(account));
    return article;
  }

  function modelList(account) {
    const box = el("div", "model-list");
    const head = el("div", "model-head");
    // The row has seven columns: model, calls, tokens, bar, share, cost and
    // the chevron-aligned end. Keep the header on the same grid.
    head.append(
      el("span", "", W.model),
      el("span", "", W.calls),
      el("span", "", state.includeCache ? W.modelTokensWithCache : W.modelTokensWithoutCache),
      el("span", "", ""),
      el("span", "", W.columns.share),
      el("span", "", W.cost),
      el("span", "", ""),
    );
    box.append(head);

    const query = state.query;
    const models = account.models.filter(
      (model) =>
        !query ||
        V.accountSelfMatches(account, query) ||
        V.modelMatches(model, query),
    );

    models.sort((a, b) => {
      if (state.sort === "name") return a.model.localeCompare(b.model);
      return sortMetric(b) - sortMetric(a) || a.model.localeCompare(b.model);
    });

    for (const model of models) {
      const row = el("div", "model-row");
      const who = el("div");
      const name = el("div", "model-name", model.model);
      name.title = model.model;
      who.append(name, el("div", "model-provider", model.providerName));
      if (model.hostNotes?.length) {
        who.append(
          el(
            "div",
            "model-host",
            W.hostNotes(model.hostNotes.map((h) => `${h.account} ${compact(h.calls)} ${W.calls.toLowerCase()}`).join(" · ")),
          ),
        );
      }

      const calls = metric(
        "",
        compact(model.calls),
        model.errors
          ? `${model.errors} ${W.failed} · ${V.errorRate(model.errors, model.calls)}`
          : "",
        (model.errors ? "bad " : "") + "calls-cell",
      );
      const share = shareCell(model, totalForSort(account.models), account.models);
      const split = el("div", "model-split",
        `${W.input} ${compact(model.input)} · ${W.output} ${compact(model.output)} · ${W.cache} ${compact(model.cache)}`);
      who.append(split);

      const cost = metric(
        "",
        money(model.cost, model.unpriced, model.calls),
        "",
        "cost-cell" + (model.unpriced ? " unpriced" : ""),
      );
      row.append(who, calls, ...share, cost, el("span", "chevron-spacer"));
      box.append(row);
    }
    return box;
  }

  function updateExpandLabel() {
    expandAll.textContent = allExpanded() ? W.collapse : W.expand;
  }

  function allExpanded() {
    const providers = visibleProviders();
    const accounts = providers.flatMap((provider) => V.visibleAccounts(provider, state.query));
    return providers.length > 0 &&
      providers.every((provider) => state.openProviders.has(provider.id)) &&
      accounts.every((account) => state.expanded.has(account.id));
  }

  function metric(label, value, detail = "", className = "") {
    const box = el("div", `metric ${className}`.trim());
    if (label) box.append(el("div", "metric-label", label));
    box.append(el("div", "metric-value", value));
    if (detail) box.append(el("div", "metric-detail", detail));
    return box;
  }

  // A row's share: the number of tokens, the bar of the share and the
  // percentage of it, in three columns of their own so the numbers line
  // up down the page.
  function shareCell(item, total, list) {
    const share = sharePercent(item, total);
    const tokens = el("div", "metric tokens-cell");
    tokens.append(el("div", "metric-value", compact(V.tokenTotal(item, state.includeCache))));

    const barCell = el("div", "share-cell");
    const bar = el("div", "bar");
    bar.setAttribute("aria-label", `${V.shareWord(state.sort)} ${percent(share)}`);
    const fill = el("i");
    fill.style.setProperty(
      "--bar",
      `${(Math.max(0.015, barShare(item, list)) * 100).toFixed(1)}%`,
    );
    bar.append(fill);
    barCell.append(bar);
    const labelCell = el("div", "share-label-cell", percent(share));
    labelCell.title = V.shareWord(state.sort);
    return [tokens, barCell, labelCell];
  }

  // A percentage and a bar follow the sort picked: tokens, cost or calls.
  // A name sort keeps tokens, as the list's own order is the name's.
  function sortMetric(item) {
    if (state.sort === "cost") return Number(item.cost) || 0;
    if (state.sort === "calls") return Number(item.calls) || 0;
    return V.tokenTotal(item, state.includeCache);
  }

  function totalForSort(list) {
    return list.reduce((sum, item) => sum + sortMetric(item), 0);
  }

  function barShare(item, list) {
    const max = Math.max(0, ...list.map(sortMetric));
    return max > 0 ? sortMetric(item) / max : 0;
  }

  function sharePercent(item, total) {
    return total > 0 ? sortMetric(item) / total : 0;
  }

  function compact(value) {
    return V.count(value);
  }

  function money(usd, unpriced, calls) {
    return V.money(usd, unpriced, calls, currency, usdCny);
  }

  function percent(value) {
    return V.percent(value);
  }

  function lastSeen(value) {
    if (!value) return W.noTime;
    const diff = Date.now() - Date.parse(value);
    if (!Number.isFinite(diff)) return W.usedRecently;
    if (diff < 60_000) return W.justUsed;
    if (diff < 3_600_000) return W.minutesAgo(Math.max(1, Math.round(diff / 60_000)));
    if (diff < 86_400_000) return W.hoursAgo(Math.max(1, Math.round(diff / 3_600_000)));
    return new Date(value).toLocaleDateString(lang === "en" ? "en-US" : "zh-CN", { month: "numeric", day: "numeric" });
  }

  function shortProvider(id) {
    const words = String(id || "??")
      .replaceAll("_", "-")
      .split("-")
      .filter(Boolean);
    if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
    return String(id || "??").slice(0, 2).toUpperCase();
  }

  function el(tag, className = "", value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value != null) node.textContent = String(value);
    return node;
  }

  function icon(name) {
    const box = document.createElement("span");
    box.setAttribute("aria-hidden", "true");
    box.style.display = "contents";
    const paths = {
      dot: '<circle cx="12" cy="12" r="7"/>',
      accounts: '<circle cx="9" cy="8" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 5.5M17 14a5 5 0 0 1 3.5 5"/>',
      calls: '<path d="M4 18V9M10 18V5M16 18v-7M22 18V3"/>',
      tokens: '<path d="M4 7h16M4 12h10M4 17h7"/><circle cx="18" cy="12" r="2"/><circle cx="15" cy="17" r="2"/>',
      cost: '<path d="M12 3v18M17 7.5c0-2-2.24-3.5-5-3.5S7 5.5 7 7.5s2.24 3.5 5 3.5 5 1.5 5 3.5-2.24 3.5-5 3.5-5-1.5-5-3.5"/>',
      chevron: '<path d="m7 10 5 5 5-5"/>',
    };
    box.innerHTML = `<svg viewBox="0 0 24 24">${paths[name] || paths.dot}</svg>`;
    return box;
  }
})();
